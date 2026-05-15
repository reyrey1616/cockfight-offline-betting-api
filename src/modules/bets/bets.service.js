// Bet placement service.
//
// All cash-affecting work happens inside a single Postgres transaction so
// that, on any failure, the bet, the ledger entry and the pool increment
// either all land or none land. This is the rule for a money system: there
// is no acceptable middle state.

import { evaluateBetVoidEligibility } from './bets.helpers.js'
import { generateTicketCode } from '../../lib/ticket-code.js'
import { computeLiveOdds } from '../../lib/odds.js'
import { deriveInitials } from '../../lib/initials.js'
import { computeTellerBalance } from '../../lib/teller-balance.js'
import {
  ConflictError,
  ForbiddenError,
  InvariantError,
  NotFoundError,
  RequestTimeoutError
} from '../../lib/errors.js'

// Transaction tunables. timeout is the wall-clock budget for the whole
// interactive block; maxWait is how long Prisma will queue waiting for a
// connection from the pool before giving up. Sum of the two is the worst
// case before the caller sees a 408.
const TX_TIMEOUT_MS = 5000
const TX_MAX_WAIT_MS = 1500

/**
 * Place a bet on a Fight, atomically updating the running pool and writing
 * the corresponding teller-ledger entry.
 *
 * Concurrency model:
 *   - The fight row is locked with `SELECT ... FOR UPDATE` at the top of the
 *     transaction. Concurrent placements on the same fight serialize on
 *     this lock; placements on different fights run in parallel.
 *   - `clientRequestId` is unique. A retried network request with the same
 *     id returns the original bet (200 with `replay: true`) instead of
 *     placing a duplicate.
 *
 * Failure surface (all wrapped as AppError subclasses for the route layer):
 *   - NotFoundError       → 404, fight does not exist
 *   - ConflictError       → 409, fight not OPEN or side held
 *   - RequestTimeoutError → 408, transaction couldn't acquire the lock /
 *                           finish in TX_TIMEOUT_MS — caller should retry
 *                           with the SAME clientRequestId
 *   - InvariantError      → 500, internal contract violation (e.g. fight
 *                           visible to the lock query but not to findUnique)
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {object}  args
 * @param {string}  args.clientRequestId  UUID minted by the teller machine.
 * @param {string}  args.fightId          Fight cuid.
 * @param {'MERON' | 'WALA'} args.side
 * @param {number}  args.amount           Pesos, positive, max 2 decimals.
 * @param {object}  args.teller           Authenticated teller user record.
 * @param {string}  args.teller.id
 * @param {string}  args.teller.username  Source of the derived initials.
 * @param {string}  args.teller.fullName
 * @returns {Promise<{ bet, fight, replay: boolean }>}
 */
export async function placeBet(prisma, { clientRequestId, fightId, side, amount, teller }) {
  if (!teller?.username) {
    throw new InvariantError('Teller is missing a username — cannot derive ticket initials')
  }
  // Initials are derived from username (first 3 chars uppercased). The
  // username schema guarantees the first 3 characters are alphabetic, so
  // this is always a clean letter triple like "JUA" / "ADM".
  const initials = deriveInitials(teller.username)

  // -------------------------------------------------------------------------
  // 1. Idempotent replay fast-path. Cheap point-lookup; if the same
  //    clientRequestId has already produced a bet, return it as-is. This is
  //    the path a teller's network-retry takes 99% of the time.
  // -------------------------------------------------------------------------
  const replayBet = await prisma.bet.findUnique({
    where: { clientRequestId },
    include: { fight: true }
  })
  if (replayBet) {
    const balance = await computeTellerBalance(prisma, replayBet.tellerId)
    // Replay → no broadcast (the original placement already broadcast).
    return {
      bet: replayBet,
      fight: projectFight(replayBet.fight),
      replay: true,
      actorBalance: balance,
      balanceBroadcast: null
    }
  }

  // -------------------------------------------------------------------------
  // 2. Pre-flight unique ticket code. Done outside the transaction so we
  //    don't hold the fight lock while spinning on collisions.
  // -------------------------------------------------------------------------
  const code = await generateTicketCode(prisma, initials)

  // -------------------------------------------------------------------------
  // 3. Atomic placement transaction.
  // -------------------------------------------------------------------------
  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // 3a. Acquire row-level lock. Concurrent bets on this same fight will
      //     block here until our COMMIT, then resume in serial. Bets on
      //     other fights are unaffected.
      const lockedRows = await tx.$queryRaw`
        SELECT id FROM "Fight" WHERE id = ${fightId} FOR UPDATE
      `
      if (!Array.isArray(lockedRows) || lockedRows.length === 0) {
        throw new NotFoundError('Fight not found')
      }

      // 3b. Re-read the locked fight via the typed client. After the lock,
      //     this read sees the absolutely current row state.
      const fight = await tx.fight.findUnique({ where: { id: fightId } })
      if (!fight) {
        // Should be unreachable — the FOR UPDATE just succeeded. If we get
        // here it's a real bug, not a user error.
        throw new InvariantError('Fight disappeared after FOR UPDATE')
      }

      // 3c. Re-validate state INSIDE the lock (admin may have closed the
      //     fight or held the side between the client request and now).
      if (fight.status !== 'OPEN') {
        throw new ConflictError('Fight is not accepting bets', {
          fightStatus: fight.status
        })
      }
      const sideAccepting = side === 'MERON'
        ? fight.meronAcceptingBets
        : fight.walaAcceptingBets
      if (!sideAccepting) {
        throw new ConflictError(`${side} is currently on hold`, { side })
      }

      // 3d. Insert the bet.
      const bet = await tx.bet.create({
        data: {
          code,
          clientRequestId,
          fightId,
          tellerId: teller.id,
          tellerNameSnapshot: teller.fullName,
          tellerInitialsSnapshot: initials,
          amount,
          side,
          status: 'PENDING'
        }
      })

      // 3e. Append the ledger entry. Same transaction → bet and ledger
      //     either both exist or neither does.
      await tx.tellerLedger.create({
        data: {
          tellerId: teller.id,
          type: 'BET_PLACED',
          amount,
          betId: bet.id
        }
      })

      // 3f. Atomic pool increment. NEVER read-then-write — that would race
      //     even under the row lock if we ever swapped to a different
      //     locking strategy.
      const updatedFight = await tx.fight.update({
        where: { id: fightId },
        data: side === 'MERON'
          ? { meronPool: { increment: amount } }
          : { walaPool: { increment: amount } }
      })

      return { bet, fight: updatedFight }
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    // Concurrent duplicate clientRequestId race: two retries arrived nearly
    // simultaneously, both passed step 1, and the second one's INSERT hit
    // the unique index. Treat that exactly as a replay.
    const isClientRequestIdConflict =
      err.code === 'P2002' &&
      Array.isArray(err.meta?.target) &&
      err.meta.target.includes('clientRequestId')

    if (isClientRequestIdConflict) {
      const winner = await prisma.bet.findUnique({
        where: { clientRequestId },
        include: { fight: true }
      })
      if (winner) {
        const balance = await computeTellerBalance(prisma, winner.tellerId)
        return {
          bet: winner,
          fight: projectFight(winner.fight),
          replay: true,
          actorBalance: balance,
          balanceBroadcast: null
        }
      }
    }

    // Prisma transaction API error — most commonly the 5s timeout.
    if (err.code === 'P2028') {
      throw new RequestTimeoutError('System busy, please retry')
    }

    throw err
  }

  // Post-commit balance read. Computed AFTER the transaction commits so
  // it reflects all writes visible at this moment (including any
  // concurrent commits that landed just before ours) — this is the
  // "current truth" the calling kiosk and the WS broadcast both want.
  const balance = await computeTellerBalance(prisma, teller.id)

  return {
    bet: result.bet,
    fight: projectFight(result.fight),
    replay: false,
    actorBalance: balance,
    balanceBroadcast: {
      tellerId: teller.id,
      tellerName: teller.fullName,
      delta: { type: 'BET_PLACED', amount: result.bet.amount.toFixed(2) }
    }
  }
}

// Shape the fight row into the response projection (adds live odds).
function projectFight(fight) {
  const { meronOdds, walaOdds } = computeLiveOdds(fight)
  return {
    id: fight.id,
    fightNumber: fight.fightNumber,
    status: fight.status,
    outcome: fight.outcome ?? null,
    meronPool: fight.meronPool,
    walaPool: fight.walaPool,
    meronOdds,
    walaOdds,
    payoutRatioMeron:
      fight.payoutRatioMeron != null ? String(fight.payoutRatioMeron) : null,
    payoutRatioWala:
      fight.payoutRatioWala != null ? String(fight.payoutRatioWala) : null
  }
}

// ===========================================================================
// Authorization helpers — keep policy in one place so route handlers stay
// thin. Both roles authenticate via the bearer middleware; these check
// resource-level access.
// ===========================================================================

function isAdmin(actor) {
  return actor?.role === 'ADMIN'
}

function isOwnerTeller(actor, bet) {
  return actor?.role === 'TELLER' && bet.tellerId === actor.id
}

// Read access: admin sees everything, teller sees only own bets.
function assertCanReadBet(actor, bet) {
  if (isAdmin(actor) || isOwnerTeller(actor, bet)) return
  throw new ForbiddenError('You do not have access to this bet')
}

// Void access: admin or the original teller who took the bet.
// A different teller cannot void someone else's ticket.
function assertCanVoidBet(actor, bet) {
  if (isAdmin(actor) || isOwnerTeller(actor, bet)) return
  throw new ForbiddenError('Only the original teller or an admin may void this bet')
}

// Convert a numeric / string / Decimal value to a negative Decimal string
// suitable for ledger entries. Magnitudes here are bounded (max 1,000,000),
// so Number precision is safe.
function negateAmount(amount) {
  return -Number(amount)
}

// ===========================================================================
// GET /bets — list with filters + cursor pagination
// ===========================================================================

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

export async function listBets(prisma, actor, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  // Tellers may only filter their own bets. If they ask for someone else's
  // explicitly, refuse — silently rewriting would mask client bugs.
  if (!isAdmin(actor)) {
    if (query.tellerId && query.tellerId !== actor.id) {
      throw new ForbiddenError('Tellers may only list their own bets')
    }
  }

  const where = {
    ...(query.fightId ? { fightId: query.fightId } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.side ? { side: query.side } : {}),
    ...(query.since ? { createdAt: { gte: new Date(query.since) } } : {}),
    // Force the teller scope for non-admins.
    tellerId: isAdmin(actor) ? query.tellerId ?? undefined : actor.id
  }

  const bets = await prisma.bet.findMany({
    where,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {})
  })

  const nextCursor = bets.length === limit ? bets[bets.length - 1].id : null
  return { bets, nextCursor }
}

// ===========================================================================
// GET /bets/:id — single bet detail, with authorization
// ===========================================================================

export async function getBet(prisma, actor, id) {
  const bet = await prisma.bet.findUnique({
    where: { id },
    include: { fight: true }
  })
  if (!bet) throw new NotFoundError('Bet not found')
  assertCanReadBet(actor, bet)
  return { bet, fight: projectFight(bet.fight) }
}

// ===========================================================================
// GET /bets/code/:code — public ticket-code lookup
//
// Used at the redemption counter. Any authenticated user can look up any
// ticket (a customer brings their slip to whoever is at the window). The
// route layer enforces authentication; no resource-level check here.
// ===========================================================================

export async function getBetByCode(prisma, code) {
  const bet = await prisma.bet.findUnique({
    where: { code },
    include: { fight: true }
  })
  if (!bet) throw new NotFoundError('Bet not found for that ticket code')
  return { bet, fight: projectFight(bet.fight) }
}

// ===========================================================================
// POST /bets/:id/void — void a PENDING bet
//
// HARD RULE (enforced inside the row-locked transaction, not just at the
// route): a bet may only be voided while the parent fight is OPEN. Once
// betting closes (`CLOSED`), and for every state after (`SETTLED`,
// `CANCELLED`), void is rejected. Admin overrides do not bypass this.
//
// Transaction:
//   1. Lock the fight row.
//   2. Re-validate fight.status === 'OPEN' (admin may have just closed it).
//   3. Re-read bet; if already VOIDED, return as idempotent replay (200).
//      If anything other than PENDING / VOIDED, conflict.
//   4. Update bet: status=VOIDED, voidedAt/voidedByUserId/voidReason.
//   5. Atomic pool decrement.
//   6. Append BET_VOIDED ledger entry (negative amount, on the *original*
//      teller — that's whose physical drawer the cash returns from).
//
// Failure surface:
//   - 404 NotFoundError       — bet does not exist
//   - 403 ForbiddenError      — actor is a different teller (admins are OK)
//   - 409 ConflictError       — fight not OPEN, or bet in a non-voidable state
//   - 408 RequestTimeoutError — transaction timed out
// ===========================================================================

export async function voidBet(prisma, actor, betId, { reason } = {}) {
  // 1. Cheap fast-path: find the bet and short-circuit if it's already
  //    voided (idempotent retry).
  const existing = await prisma.bet.findUnique({
    where: { id: betId },
    include: { fight: true }
  })
  if (!existing) throw new NotFoundError('Bet not found')
  assertCanVoidBet(actor, existing)

  if (existing.status === 'VOIDED') {
    const balance = await computeTellerBalance(prisma, existing.tellerId)
    return {
      bet: existing,
      fight: projectFight(existing.fight),
      replay: true,
      actorBalance: balance,
      balanceBroadcast: null
    }
  }

  // Cheap pre-check so we return a clean 409 without spending a transaction
  // budget on a doomed call. The transaction re-checks both anyway.
  const eligibility = evaluateBetVoidEligibility({
    betStatus: existing.status,
    fightStatus: existing.fight.status
  })
  if (!eligibility.allowed) {
    throw new ConflictError(eligibility.reason, {
      fightStatus: existing.fight.status,
      betStatus: existing.status
    })
  }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // 2. Lock the fight row.
      const lockedRows = await tx.$queryRaw`
        SELECT id FROM "Fight" WHERE id = ${existing.fightId} FOR UPDATE
      `
      if (!Array.isArray(lockedRows) || lockedRows.length === 0) {
        throw new InvariantError('Fight disappeared after FOR UPDATE')
      }

      // 3. Re-read with current state under the lock.
      const fight = await tx.fight.findUnique({ where: { id: existing.fightId } })
      const bet = await tx.bet.findUnique({ where: { id: betId } })
      if (!fight || !bet) {
        throw new InvariantError('Fight or bet vanished after lock')
      }

      // 4. Re-validate fight status under the lock — the only correctness
      //    barrier that matters. If an admin called /fights/:id/close
      //    between the fast-path check and now, we MUST reject.
      const lockedEligibility = evaluateBetVoidEligibility({
        betStatus: bet.status,
        fightStatus: fight.status
      })
      if (!lockedEligibility.allowed) {
        throw new ConflictError(lockedEligibility.reason, {
          fightStatus: fight.status,
          betStatus: bet.status
        })
      }

      // 5. Re-validate bet status. Handles concurrent voids cleanly.
      if (bet.status === 'VOIDED') {
        // Another caller beat us to it. Bail with replay-shaped flag.
        return { bet, fight, replay: true }
      }
      if (bet.status !== 'PENDING') {
        throw new ConflictError(
          'Only PENDING bets can be voided',
          { betStatus: bet.status }
        )
      }

      // 6. Mutate.
      const updatedBet = await tx.bet.update({
        where: { id: betId },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedByUserId: actor.id,
          voidReason: reason ?? null
        }
      })

      // 7. Atomic pool decrement.
      const updatedFight = await tx.fight.update({
        where: { id: existing.fightId },
        data: bet.side === 'MERON'
          ? { meronPool: { decrement: bet.amount } }
          : { walaPool: { decrement: bet.amount } }
      })

      // 8. Append the ledger entry. The cash returns from the ORIGINAL
      //    teller's drawer (see schema comment on tellerId semantics).
      //    Reason is mirrored into ledger.notes for traceability.
      await tx.tellerLedger.create({
        data: {
          tellerId: bet.tellerId,
          type: 'BET_VOIDED',
          amount: negateAmount(bet.amount),
          betId: bet.id,
          notes: reason ?? null
        }
      })

      return { bet: updatedBet, fight: updatedFight, replay: false }
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    if (err.code === 'P2028') {
      throw new RequestTimeoutError('System busy, please retry')
    }
    throw err
  }

  // Affected teller for void = the ORIGINAL bet-taker (whose drawer the
  // cash returns from), NOT the actor doing the void. So even an admin
  // void surfaces the original teller's new balance for the WS frame.
  const affectedTellerId = result.bet.tellerId
  const balance = await computeTellerBalance(prisma, affectedTellerId)

  return {
    bet: result.bet,
    fight: projectFight(result.fight),
    replay: result.replay,
    actorBalance: balance,
    balanceBroadcast: result.replay
      ? null
      : {
          tellerId: affectedTellerId,
          tellerName: result.bet.tellerNameSnapshot,
          delta: { type: 'BET_VOIDED', amount: (-Number(result.bet.amount)).toFixed(2) }
        }
  }
}

// ===========================================================================
// POST /bets/:id/pay — redeem a winning ticket
//
// Transaction:
//   1. Lock the bet row (we don't change the pool, just the bet).
//   2. If already PAID, return as idempotent replay.
//   3. If status !== 'WON' or payoutAmount is null, conflict.
//   4. Update bet: status=PAID, paidAt/paidByUserId.
//   5. Append PAYOUT ledger entry (negative, on the PAYING teller's
//      balance per schema comment — could be a different teller from the
//      original bet-taker).
//
// Failure surface:
//   - 404 NotFoundError       — bet does not exist
//   - 409 ConflictError       — bet not in WON state
//   - 408 RequestTimeoutError — transaction timed out
//   - 500 InvariantError      — WON bet has no payoutAmount (data corruption)
// ===========================================================================

export async function payBet(prisma, actor, betId) {
  // 1. Fast-path replay check.
  const existing = await prisma.bet.findUnique({
    where: { id: betId },
    include: { fight: true }
  })
  if (!existing) throw new NotFoundError('Bet not found')

  if (existing.status === 'PAID') {
    // For replay we already know who got the original PAYOUT ledger row
    // (paidByUserId on the bet). Return their CURRENT balance — which
    // may have moved since the original payment. No broadcast on replay.
    const balance = await computeTellerBalance(prisma, existing.paidByUserId ?? actor.id)
    return {
      bet: existing,
      fight: projectFight(existing.fight),
      replay: true,
      actorBalance: balance,
      balanceBroadcast: null
    }
  }
  if (existing.status !== 'WON') {
    throw new ConflictError(
      'Only WON bets can be paid out',
      { betStatus: existing.status }
    )
  }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // 2. Lock the bet row.
      const locked = await tx.$queryRaw`
        SELECT id FROM "Bet" WHERE id = ${betId} FOR UPDATE
      `
      if (!Array.isArray(locked) || locked.length === 0) {
        throw new InvariantError('Bet vanished after FOR UPDATE')
      }

      // 3. Re-read under the lock.
      const bet = await tx.bet.findUnique({
        where: { id: betId },
        include: { fight: true }
      })
      if (!bet) throw new InvariantError('Bet vanished after lock')

      // 4. Handle concurrent pay-out — second caller becomes a replay.
      if (bet.status === 'PAID') {
        return { bet, fight: bet.fight, replay: true }
      }
      if (bet.status !== 'WON') {
        throw new ConflictError(
          'Only WON bets can be paid out',
          { betStatus: bet.status }
        )
      }
      if (bet.payoutAmount == null) {
        throw new InvariantError('WON bet is missing a payoutAmount — settlement bug')
      }

      // 5. Mutate.
      const updatedBet = await tx.bet.update({
        where: { id: betId },
        data: {
          status: 'PAID',
          paidAt: new Date(),
          paidByUserId: actor.id
        },
        include: { fight: true }
      })

      // 6. Ledger entry: PAYOUT debits whoever is at the redemption
      //    counter (actor.id) — NOT necessarily the original bet-taker.
      await tx.tellerLedger.create({
        data: {
          tellerId: actor.id,
          type: 'PAYOUT',
          amount: negateAmount(bet.payoutAmount),
          betId: bet.id
        }
      })

      return { bet: updatedBet, fight: updatedBet.fight, replay: false }
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    if (err.code === 'P2028') {
      throw new RequestTimeoutError('System busy, please retry')
    }
    throw err
  }

  // Affected teller for pay = the actor (whoever physically handed over
  // the payout cash from their drawer), not the original bet-taker.
  const balance = await computeTellerBalance(prisma, actor.id)

  return {
    bet: result.bet,
    fight: projectFight(result.fight),
    replay: result.replay,
    actorBalance: balance,
    balanceBroadcast: result.replay
      ? null
      : {
          tellerId: actor.id,
          tellerName: actor.fullName,
          delta: {
            type: 'PAYOUT',
            amount: (-Number(result.bet.payoutAmount)).toFixed(2)
          }
        }
  }
}
