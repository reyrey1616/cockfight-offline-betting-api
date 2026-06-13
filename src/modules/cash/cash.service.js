// Cash service — TellerLedger surface for advances and remits, plus the
// read-only balance and ledger queries.
//
// Sign convention (mirrors the schema comment on TellerLedger):
//   POSITIVE amount = cash flowing INTO the teller's hand
//   NEGATIVE amount = cash flowing OUT of the teller's hand
//
// The single hard invariant enforced here:
//   - A REMIT cannot push a teller's balance below zero. Implemented as
//     a post-write SUM check inside the transaction (see `cashRemit`):
//     if the balance after the insert would be negative, we throw and
//     the transaction rolls back. No row-level lock needed — the
//     post-write SUM inherits Postgres MVCC and includes any concurrent
//     writes that committed first.
//
// Decimal handling: amounts arrive as JS numbers from the request layer
// and are immediately serialized to 2-decimal strings before they touch
// the DB. SUM aggregations come back as `decimal.js` Decimal instances
// and are rendered with `.toFixed(2)` (see src/lib/teller-balance.js).

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RequestTimeoutError
} from '../../lib/errors.js'
import { computeTellerBalance } from '../../lib/teller-balance.js'
import { generateUniqueCode } from '../../lib/code-generator.js'
import { rethrowPrismaTransactionError } from '../../lib/prisma-tx.js'
import { getCollectorByCode } from '../collectors/collectors.service.js'
import { negate, resolveAdvanceRecipientId, toMoneyString } from './cash.helpers.js'

// Prefix → ledger-row barcode mapping. Only CASH_ADVANCE and REMIT rows
// get standalone codes; bet-related rows already have a printable code
// via bet.code (joined through betId), and ADJUSTMENT rows don't exist
// (no manual adjustments policy).
const LEDGER_CODE_PREFIX = {
  CASH_ADVANCE: 'ADV',
  REMIT: 'REM'
}

// Generate a unique barcode for a CASH_ADVANCE or REMIT ledger row.
// Same alphabet as bet codes; pre-flight check uses the supplied
// `prismaOrTx` so generation inside an interactive transaction sees
// the same snapshot as the surrounding writes.
async function generateLedgerCode(prismaOrTx, type) {
  const prefix = LEDGER_CODE_PREFIX[type]
  if (!prefix) {
    throw new BadRequestError(`No barcode prefix defined for ledger type ${type}`)
  }
  return generateUniqueCode({
    prefix,
    label: `${type.toLowerCase()} code`,
    isUsed: async (candidate) => {
      const row = await prismaOrTx.tellerLedger.findUnique({
        where: { code: candidate },
        select: { id: true }
      })
      return row !== null
    }
  })
}

const TX_TIMEOUT_MS = 10_000
const TX_MAX_WAIT_MS = 2_000

// ===========================================================================
// Shared helpers (private)
// ===========================================================================

// Map Prisma transaction-timeout to our 408. Same pattern used by every
// other mutating service in the codebase.
async function findActiveTeller(prismaOrTx, tellerId) {
  const user = await prismaOrTx.user.findUnique({
    where: { id: tellerId },
    select: { id: true, username: true, fullName: true, role: true, isActive: true }
  })
  if (!user) throw new NotFoundError('Teller not found')
  if (user.role !== 'TELLER') {
    throw new BadRequestError('Recipient must be a TELLER', { recipientRole: user.role })
  }
  if (!user.isActive) {
    throw new BadRequestError('Recipient teller is not active')
  }
  return user
}

async function findActiveCollectorByCode(prismaOrTx, collectorCode) {
  const collector = await getCollectorByCode(prismaOrTx, collectorCode.toUpperCase())
  if (!collector.isActive) {
    throw new BadRequestError('Collector is not active')
  }
  return collector
}

// ===========================================================================
// POST /cash/advances — admin-only.
//
// Records a CASH_ADVANCE ledger row on the receiving teller. Amount is
// positive (cash IN). Recipient must be an active TELLER; collector must
// be active. Returns the created row + the recipient's NEW balance.
// ===========================================================================

export async function cashAdvance(prisma, actor, { tellerId, collectorCode, amount, notes }) {
  const recipientId = resolveAdvanceRecipientId(actor, tellerId)
  const amountString = toMoneyString(amount)

  // Pre-validate outside the transaction so we don't waste a tx slot on
  // doomed requests. Re-checking inside the tx isn't worth it for the
  // role/active flags — flipping a teller inactive between this check
  // and the insert is a vanishingly rare race; if it happens, the
  // CASH_ADVANCE for an in-the-process-of-being-deactivated teller is
  // not a meaningful inconsistency.
  const teller = await findActiveTeller(prisma, recipientId)
  const collector = await findActiveCollectorByCode(prisma, collectorCode)

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // Generate the barcode INSIDE the transaction so the uniqueness
      // pre-flight sees the same snapshot as the about-to-happen INSERT
      // — and so a P2002 collision (vanishingly rare) rolls back the
      // whole operation cleanly instead of orphaning a code.
      const code = await generateLedgerCode(tx, 'CASH_ADVANCE')
      const ledgerEntry = await tx.tellerLedger.create({
        data: {
          tellerId: recipientId,
          type: 'CASH_ADVANCE',
          amount: amountString,
          collectorId: collector.id,
          code,
          notes: notes ?? null
        }
      })
      const balance = await computeTellerBalance(tx, recipientId)
      return { ledgerEntry, balance }
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }

  return {
    ledgerEntry: result.ledgerEntry,
    balance: result.balance,
    teller
  }
}

// ===========================================================================
// POST /cash/remits — bearer (typically teller).
//
// Records a REMIT ledger row on the requesting user (whoever's drawer
// is being emptied). Amount is stored negative. ENFORCES non-negative
// balance after the write — see header note on the post-write SUM check.
// ===========================================================================

export async function cashRemit(prisma, actor, { collectorCode, amount, notes }) {
  const amountString = toMoneyString(amount)
  const collector = await findActiveCollectorByCode(prisma, collectorCode)

  // Resolve the actor's User row for the response payload (display name,
  // role check). We allow any authenticated user to remit because the
  // schema's `tellerId` simply means "whose drawer this affects" — that's
  // always the caller. A non-teller calling this is unusual but not
  // illegal (e.g. an admin with a stray PAYOUT entry on themselves
  // squaring up).
  const actorRow = await prisma.user.findUnique({
    where: { id: actor.id },
    select: { id: true, username: true, fullName: true, role: true, isActive: true }
  })
  if (!actorRow || !actorRow.isActive) {
    throw new ForbiddenError('Account is not active')
  }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const code = await generateLedgerCode(tx, 'REMIT')
      const ledgerEntry = await tx.tellerLedger.create({
        data: {
          tellerId: actor.id,
          type: 'REMIT',
          amount: negate(amountString),
          collectorId: collector.id,
          code,
          notes: notes ?? null
        }
      })

      // The hard invariant. Computed AFTER the write so the result
      // reflects this transaction's snapshot — including the row we
      // just inserted plus anything else committed in parallel. If we'd
      // go negative, throw to roll back the whole transaction.
      const balance = await computeTellerBalance(tx, actor.id)
      if (Number(balance) < 0) {
        throw new ConflictError('Remit amount exceeds your current balance', {
          currentBalanceBeforeRemit: (Number(balance) + Number(amountString)).toFixed(2),
          requestedAmount: amountString,
          shortfall: (-Number(balance)).toFixed(2)
        })
      }

      return { ledgerEntry, balance }
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }

  return {
    ledgerEntry: result.ledgerEntry,
    balance: result.balance,
    teller: actorRow
  }
}

// ===========================================================================
// GET /cash/balance — bearer.
//
// Default: caller's own balance. Admin can pass `?tellerId=` to inspect
// any user. Tellers passing a different `tellerId` get 403 (not 200 with
// stale data — strict scoping prevents accidental information leaks).
// ===========================================================================

export async function getBalance(prisma, actor, { tellerId } = {}) {
  const targetId = tellerId ?? actor.id

  if (targetId !== actor.id && actor.role !== 'ADMIN') {
    throw new ForbiddenError('You can only view your own balance')
  }

  const teller = await prisma.user.findUnique({
    where: { id: targetId },
    select: { id: true, username: true, fullName: true }
  })
  if (!teller) throw new NotFoundError('Teller not found')

  const balance = await computeTellerBalance(prisma, targetId)

  return {
    tellerId: teller.id,
    username: teller.username,
    fullName: teller.fullName,
    balance
  }
}

// ===========================================================================
// GET /cash/ledger — bearer.
//
// Cursor-paginated. Filters: tellerId, type, since, until.
// Tellers are HARD-SCOPED to their own entries: an explicit tellerId in
// the query that doesn't match → 403. Omitting it defaults to own.
// Admins can pass any tellerId or omit for system-wide view.
// ===========================================================================

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function listLedger(prisma, actor, query = {}) {
  const requestedTellerId = query.tellerId

  let effectiveTellerFilter
  if (actor.role === 'ADMIN') {
    effectiveTellerFilter = requestedTellerId ?? null // null = system-wide
  } else {
    if (requestedTellerId && requestedTellerId !== actor.id) {
      throw new ForbiddenError('You can only view your own ledger')
    }
    effectiveTellerFilter = actor.id
  }

  if (query.since && query.until && new Date(query.since) > new Date(query.until)) {
    throw new BadRequestError('`since` must be on or before `until`')
  }

  const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  const where = {
    ...(effectiveTellerFilter ? { tellerId: effectiveTellerFilter } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.since || query.until
      ? {
          createdAt: {
            ...(query.since ? { gte: new Date(query.since) } : {}),
            ...(query.until ? { lt: new Date(query.until) } : {})
          }
        }
      : {})
  }

  const rows = await prisma.tellerLedger.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    include: {
      bet: { include: { fight: true } },
      collector: { select: { name: true } }
    }
  })

  return {
    entries: rows.map(projectLedgerEntry),
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null
  }
}

// ===========================================================================
// GET /cash/ledger/code/:code — scan-by-barcode lookup for a ledger row.
//
// Used to pull up an advance / remit by scanning its printed receipt.
// Honors the same teller-scope rule as the rest of the cash surface:
// a teller may only fetch their own row; admins may fetch any.
// ===========================================================================

export async function getLedgerEntryByCode(prisma, actor, code) {
  const row = await prisma.tellerLedger.findUnique({ where: { code } })
  if (!row) throw new NotFoundError('No ledger entry matches that code')

  if (actor.role !== 'ADMIN' && row.tellerId !== actor.id) {
    // Don't leak that a code exists — return the same NotFound shape an
    // unknown code would produce. Tellers can't enumerate other tellers'
    // codes by guessing.
    throw new NotFoundError('No ledger entry matches that code')
  }

  return row
}

// Project a ledger row into the wire shape — Decimal → string, dates
// stringify automatically via JSON, but we explicitly toString the
// amount to avoid the receiver getting the Decimal class wrapper.
export function projectLedgerEntry(row) {
  const entry = {
    id: row.id,
    code: row.code ?? null,
    tellerId: row.tellerId,
    type: row.type,
    amount: row.amount.toFixed(2),
    betId: row.betId ?? null,
    collectorId: row.collectorId ?? null,
    collectorName: row.collector?.name ?? null,
    adjustedByUserId: row.adjustedByUserId ?? null,
    notes: row.notes ?? null,
    createdAt: row.createdAt
  }

  const bet = row.bet
  if (!bet) return entry

  const fight = bet.fight
  return {
    ...entry,
    betAmount: bet.amount.toFixed(2),
    betSide: bet.side,
    betPayoutAmount:
      bet.payoutAmount != null ? bet.payoutAmount.toFixed(2) : null,
    payoutRatioMeron:
      fight?.payoutRatioMeron != null ? String(fight.payoutRatioMeron) : null,
    payoutRatioWala:
      fight?.payoutRatioWala != null ? String(fight.payoutRatioWala) : null
  }
}
