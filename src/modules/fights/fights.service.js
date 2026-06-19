// Fights service.
//
// Each exported function is one route's worth of business logic. The route
// layer (fights.routes.js) is thin glue: validate → call → broadcast.
//
// Concurrency model
//   - Every mutating operation runs inside `prisma.$transaction`.
//   - Row-level locks via `SELECT ... FOR UPDATE` serialize writers to the
//     same Fight row. Re-validation under the lock prevents the
//     "checked-then-acted" race entirely.
//   - The "only one OPEN fight at a time" invariant is protected by a
//     Postgres advisory lock (`pg_advisory_xact_lock`) on a constant key
//     so that two admins clicking "Open" on different fights simultaneously
//     cannot both succeed.
//
// Sign / decimal handling
//   - All amount columns are Decimal; values cross the wire as STRINGS.
//   - The settlement library (`src/lib/fight-settlement.js`) is the single
//     source of truth for math; this file only orchestrates DB writes.
//
// Broadcasting
//   - Service functions return the updated fight (and ancillary info). The
//     route layer is responsible for fan-out AFTER the transaction commits.
//     Never broadcast from inside a transaction.

import {
  ConflictError,
  InvariantError,
  NotFoundError,
  RequestTimeoutError
} from '../../lib/errors.js'
import { rethrowPrismaTransactionError } from '../../lib/prisma-tx.js'
import { computeLiveOdds } from '../../lib/odds.js'
import {
  computePayoutRatios,
  planCancellationForBet,
  planCorrectionForBet,
  planSettlementForBet
} from '../../lib/fight-settlement.js'

// Transaction budget. `settle` may update hundreds of bets in one
// transaction — keep the timeout generous enough for ~500 bets without
// being so generous that a stuck transaction blocks new placements.
const TX_TIMEOUT_MS = 15_000
const TX_MAX_WAIT_MS = 2_000

// Arbitrary 64-bit integer key for the "only-one-OPEN-fight" advisory
// lock. Value doesn't matter; what matters is every caller uses the same
// constant. Chosen to be human-recognizable in pg_locks dumps.
const ADVISORY_LOCK_FIGHT_OPEN = 902_026_001n

// ===========================================================================
// Shared helpers (private)
// ===========================================================================

/**
 * Acquire row-level lock on a fight and re-read its current state.
 * Throws NotFoundError if the row does not exist.
 */
async function lockFightById(tx, id) {
  const locked = await tx.$queryRaw`
    SELECT id FROM "Fight" WHERE id = ${id} FOR UPDATE
  `
  if (!Array.isArray(locked) || locked.length === 0) {
    throw new NotFoundError('Fight not found')
  }
  const fight = await tx.fight.findUnique({ where: { id } })
  if (!fight) throw new InvariantError('Fight disappeared after FOR UPDATE')
  return fight
}

/**
 * Shape a fight row for the response. Adds derived live odds.
 */
export function projectFight(fight) {
  const { meronOdds, walaOdds } = computeLiveOdds(fight)
  return { ...fight, meronOdds, walaOdds }
}

/**
 * Map the Prisma transaction-timeout code to our 408. Every mutating op
 * funnels its error through this so the surface is consistent.
 */
// ===========================================================================
// POST /fights — create a new fight directly in OPEN state.
//
// There is intentionally no separate "schedule then open" step — a fight
// comes into existence already accepting bets. SCHEDULED still exists in
// the FightStatus enum for legacy data, but no new fight will ever be
// written in that state.
//
// Invariants enforced inside one transaction:
//   1. fightNumber is globally unique and monotonically increasing
//      (MAX + 1 under an advisory lock).
//   2. No OTHER fight is currently OPEN. Two admins clicking "Create" at
//      the same time cannot both succeed — the advisory lock serializes
//      the check.
// ===========================================================================

export async function createFight(prisma) {
  // We snapshot the current commissionRate AT CREATION TIME. Settling
  // reads this snapshot — admin's later tuning of Setting only affects
  // fights created after the change.
  let createdFight
  try {
    createdFight = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK_FIGHT_OPEN})`

      // Cross-fight invariant: only one fight may be OPEN at a time.
      // (Legacy SCHEDULED rows are irrelevant — they never reach OPEN
      // unless cancelled and re-created.)
      const otherOpen = await tx.fight.findFirst({
        where: { status: { in: ['OPEN', 'LAST_CALL'] } },
        select: { id: true, fightNumber: true }
      })
      if (otherOpen) {
        throw new ConflictError('Another fight is already OPEN', {
          openFightId: otherOpen.id,
          openFightNumber: otherOpen.fightNumber
        })
      }

      const setting = await tx.setting.findUnique({ where: { id: 'singleton' } })
      if (!setting) {
        // Defensive — seed.js creates this. If missing, we don't fabricate
        // a default; that's a deploy bug we want to surface loudly.
        throw new InvariantError('Setting singleton is missing — run prisma db seed')
      }

      const last = await tx.fight.findFirst({
        orderBy: { fightNumber: 'desc' },
        select: { fightNumber: true }
      })
      // Empty table (e.g. after session reset) → fight #1. Otherwise MAX + 1.
      const nextNumber = (last?.fightNumber ?? 0) + 1

      return tx.fight.create({
        data: {
          fightNumber: nextNumber,
          status: 'OPEN',
          openedAt: new Date(),
          commissionRate: setting.commissionRate
          // pool defaults (0), acceptingBets defaults (true) — schema-level
        }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }

  return { fight: projectFight(createdFight) }
}

// ===========================================================================
// GET /fights — paginated list with optional status / current filter
// ===========================================================================

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function listFights(prisma, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  const where = {
    ...(query.status ? { status: query.status } : {}),
    // `current=true` is the kiosk's "what fight should I show?" filter.
    // Legacy SCHEDULED rows are intentionally excluded — new fights are
    // never written in SCHEDULED and kiosks shouldn't pick up dead rows
    // from before that change.
    // Include SETTLED so kiosks keep showing the fight just declared until a
    // newer one opens — otherwise a stale CLOSED row (lower fightNumber) wins.
    ...(query.current
      ? { status: { in: ['OPEN', 'LAST_CALL', 'CLOSED', 'SETTLED'] } }
      : {})
  }

  const rows = await prisma.fight.findMany({
    where,
    orderBy: [{ fightNumber: 'desc' }],
    take: limit,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {})
  })

  return {
    fights: rows.map(projectFight),
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null
  }
}

// ===========================================================================
// GET /fights/:id — single fight detail
// ===========================================================================

export async function getFight(prisma, id) {
  const fight = await prisma.fight.findUnique({ where: { id } })
  if (!fight) throw new NotFoundError('Fight not found')
  return { fight: projectFight(fight) }
}

// ===========================================================================
// POST /fights/:id/close — OPEN → CLOSED
// ===========================================================================

export async function closeFight(prisma, id) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (fight.status !== 'OPEN' && fight.status !== 'LAST_CALL') {
        throw new ConflictError('Only OPEN or LAST_CALL fights can be closed', {
          fightStatus: fight.status
        })
      }
      return tx.fight.update({
        where: { id },
        data: { status: 'CLOSED', closedAt: new Date() }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/reopen — CLOSED → OPEN (undo mistaken close before settle)
//
// Clears `closedAt` so the fight is indistinguishable from a continuously
// OPEN fight for audit timelines that key off closedAt. Kiosks treat the
// broadcast like a fresh FIGHT_OPENED on the same fightId — placement
// unlocks again.
// ===========================================================================

export async function reopenFight(prisma, id) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (fight.status !== 'CLOSED') {
        throw new ConflictError('Only CLOSED fights can be re-opened for betting', {
          fightStatus: fight.status
        })
      }
      return tx.fight.update({
        where: { id },
        data: { status: 'OPEN', closedAt: null }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/last-call — OPEN → LAST_CALL
// ===========================================================================
export async function setFightLastCall(prisma, id) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (fight.status !== 'OPEN') {
        throw new ConflictError('Only OPEN fights can enter LAST_CALL', {
          fightStatus: fight.status
        })
      }
      return tx.fight.update({
        where: { id },
        data: { status: 'LAST_CALL' }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/resume-open — LAST_CALL → OPEN
// ===========================================================================
export async function resumeFightOpen(prisma, id) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (fight.status !== 'LAST_CALL') {
        throw new ConflictError('Only LAST_CALL fights can return to OPEN', {
          fightStatus: fight.status
        })
      }
      return tx.fight.update({
        where: { id },
        data: { status: 'OPEN' }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/settle — CLOSED → SETTLED
//
// Inside one transaction:
//   1. Lock the fight; require status=CLOSED.
//   2. Compute payout ratios from frozen pools + snapshotted commission.
//   3. Update each PENDING bet → WON/LOST/PENDING_REFUND (VOIDED bets untouched).
//      Draw/cancel refunds stay PENDING_REFUND until paid at payout desk.
//   4. Stamp settledAt + outcome + payoutRatios on the fight.
//
// This is the largest transaction in the system. Bet count is bounded by
// what fits in a session (~hundreds), well within TX_TIMEOUT_MS for an
// indexed updateMany pattern.
// ===========================================================================

export async function settleFight(prisma, id, { outcome }) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (fight.status !== 'CLOSED') {
        throw new ConflictError('Only CLOSED fights can be settled', {
          fightStatus: fight.status
        })
      }

      const ratios = computePayoutRatios({
        meronPool: fight.meronPool,
        walaPool: fight.walaPool,
        commissionRate: fight.commissionRate,
        outcome
      })

      const bets = await tx.bet.findMany({
        where: { fightId: id },
        select: { id: true, amount: true, side: true, status: true, tellerId: true }
      })

      // One bet at a time — Prisma's updateMany can't apply per-row
      // derived values like payoutAmount = amount * ratio. The bet count
      // is bounded so this loop is fine; we serialize on the fight lock.
      for (const bet of bets) {
        const plan = planSettlementForBet({ ...ratios, outcome }, bet)
        if (plan.skip) continue
        await tx.bet.update(plan.update)
        if (plan.ledger) await tx.tellerLedger.create({ data: plan.ledger })
      }

      return tx.fight.update({
        where: { id },
        data: {
          status: 'SETTLED',
          outcome,
          payoutRatioMeron: ratios.payoutRatioMeron,
          payoutRatioWala: ratios.payoutRatioWala,
          settledAt: new Date()
        }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/cancel — SCHEDULED|OPEN|CLOSED → CANCELLED
//
// All PENDING bets become PENDING_REFUND with payoutAmount = stake.
// Cash is deducted when each refund is paid at the payout desk. VOIDED bets
// are untouched.
// ===========================================================================

const CANCEL_FROM_STATES = ['SCHEDULED', 'OPEN', 'LAST_CALL', 'CLOSED']

export async function cancelFight(prisma, id, { reason } = {}) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (!CANCEL_FROM_STATES.includes(fight.status)) {
        throw new ConflictError('Only SCHEDULED, OPEN, LAST_CALL or CLOSED fights can be cancelled', {
          fightStatus: fight.status
        })
      }

      const bets = await tx.bet.findMany({
        where: { fightId: id },
        select: { id: true, amount: true, status: true, tellerId: true }
      })
      for (const bet of bets) {
        const plan = planCancellationForBet(bet, { reason })
        if (plan.skip) continue
        await tx.bet.update(plan.update)
        if (plan.ledger) await tx.tellerLedger.create({ data: plan.ledger })
      }

      return tx.fight.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date()
          // cancelReason isn't on the schema; logged at route layer.
        }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/correct — SETTLED → SETTLED with new outcome
//
// Recomputes payout ratios from the (still-frozen) pools, then walks every
// bet:
//   - VOIDED bets are sticky → no change.
//   - PAID bets keep status=PAID, but record previousPayoutAmount + the
//     "should have been" payoutAmount + correctedAt. Operator absorbs the
//     overpay/underpay — the "corrections cost" report later reconstructs
//     it from these snapshots.
//   - Other bets flip to the new target, snapshotting previousStatus /
//     previousPayoutAmount.
//
// Newly-becoming-REFUNDED bets get a BET_REFUNDED ledger entry. WON→LOST,
// LOST→WON, etc. do not move physical cash and therefore have no ledger
// entries.
// ===========================================================================

export async function correctFight(prisma, actor, id, { outcome, reason }) {
  let updated
  try {
    updated = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)
      if (fight.status !== 'SETTLED') {
        throw new ConflictError('Only SETTLED fights can be corrected', {
          fightStatus: fight.status
        })
      }
      if (fight.outcome === outcome) {
        throw new ConflictError('Corrected outcome must differ from current outcome', {
          currentOutcome: fight.outcome
        })
      }

      const ratios = computePayoutRatios({
        meronPool: fight.meronPool,
        walaPool: fight.walaPool,
        commissionRate: fight.commissionRate,
        outcome
      })

      const bets = await tx.bet.findMany({
        where: { fightId: id },
        select: {
          id: true, amount: true, side: true, status: true,
          payoutAmount: true, tellerId: true
        }
      })
      for (const bet of bets) {
        const plan = planCorrectionForBet({ ...ratios, outcome }, bet, { reason })
        if (plan.skip) continue
        await tx.bet.update(plan.update)
        if (plan.ledger) await tx.tellerLedger.create({ data: plan.ledger })
      }

      return tx.fight.update({
        where: { id },
        data: {
          // status stays SETTLED — corrections are the audit trail, not a
          // separate state. See schema comment.
          previousOutcome: fight.outcome,
          previousPayoutRatioMeron: fight.payoutRatioMeron,
          previousPayoutRatioWala: fight.payoutRatioWala,
          outcome,
          payoutRatioMeron: ratios.payoutRatioMeron,
          payoutRatioWala: ratios.payoutRatioWala,
          correctedAt: new Date(),
          correctedByUserId: actor.id,
          correctionReason: reason
        }
      })
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(updated) }
}

// ===========================================================================
// POST /fights/:id/sides/:side/hold|unhold
//
// Valid only while fight.status === 'OPEN'. Idempotent:
//   - hold called on an already-held side returns replay=true.
//   - unhold called on a not-held side returns replay=true.
// ===========================================================================

export async function holdSide(prisma, actor, id, side) {
  return toggleSide(prisma, actor, id, side, { accepting: false })
}

export async function unholdSide(prisma, actor, id, side) {
  return toggleSide(prisma, actor, id, side, { accepting: true })
}

async function toggleSide(prisma, actor, id, side, { accepting }) {
  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      const fight = await lockFightById(tx, id)

      if (fight.status !== 'OPEN' && fight.status !== 'LAST_CALL') {
        throw new ConflictError('Side hold/unhold is only valid while the fight is OPEN or LAST_CALL', {
          fightStatus: fight.status
        })
      }

      const currentAccepting = side === 'MERON' ? fight.meronAcceptingBets : fight.walaAcceptingBets
      if (currentAccepting === accepting) {
        // Already in target state — return as replay without writing.
        return { fight, replay: true }
      }

      const data = accepting
        ? side === 'MERON'
          ? { meronAcceptingBets: true, meronHeldAt: null, meronHeldByUserId: null }
          : { walaAcceptingBets: true, walaHeldAt: null, walaHeldByUserId: null }
        : side === 'MERON'
          ? { meronAcceptingBets: false, meronHeldAt: new Date(), meronHeldByUserId: actor.id }
          : { walaAcceptingBets: false, walaHeldAt: new Date(), walaHeldByUserId: actor.id }

      const updated = await tx.fight.update({ where: { id }, data })
      return { fight: updated, replay: false }
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    rethrowPrismaTransactionError(err)
  }
  return { fight: projectFight(result.fight), replay: result.replay }
}
