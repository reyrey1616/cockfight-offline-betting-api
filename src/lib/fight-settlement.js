// Settlement math — pure functions, no I/O.
//
// Isolating the math from the database has two benefits:
//   1. It's auditable. The pari-mutuel formula and the result-correction
//      state-flip table both live in one small file you can read top to
//      bottom and reason about.
//   2. It's testable in isolation without a Postgres instance.
//
// Decimal handling: pool amounts arrive as strings (Prisma + pg driver
// adapter). Magnitudes are bounded (max 1,000,000 per pool), so JS Number
// precision is safe for the arithmetic here. Final money values are rounded
// to 2 decimals before they hit the wire / DB.

import { BadRequestError } from './errors.js'
import { computePoolDistributable, floorPayoutMultiplier } from './odds.js'

const SETTLED_TERMINAL_OUTCOMES = ['MERON', 'WALA', 'DRAW']

function toNumber(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  return Number(value.toString())
}

function round2(n) {
  return Math.round(n * 100) / 100
}

// Format a Number as a fixed-point decimal STRING with 2 decimals. The DB
// columns are Decimal so we feed them strings to avoid Prisma coercing
// JS floats with surprising precision tails.
function toMoneyString(n) {
  return round2(n).toFixed(2)
}

// Payout ratios: same floor rule as live board (scale ×100, floor 2 dp, ÷100).
function toRatioString(n) {
  const m = floorPayoutMultiplier(n)
  if (m == null) return null
  const s = m.toFixed(4)
  return s.replace(/\.?0+$/, '') || '0'
}

// ---------------------------------------------------------------------------
// Outcome / ratio computation
// ---------------------------------------------------------------------------

/**
 * Validate an outcome value supplied by the admin at settle/correct time.
 * Throws BadRequestError for unknown values.
 */
export function assertValidOutcome(outcome) {
  if (!SETTLED_TERMINAL_OUTCOMES.includes(outcome)) {
    throw new BadRequestError(
      `Invalid outcome "${outcome}". Expected one of: ${SETTLED_TERMINAL_OUTCOMES.join(', ')}.`
    )
  }
}

/**
 * Compute the frozen payout ratios for a settlement given the final pools
 * and the snapshotted commission rate. The ratios are payout-per-stake:
 * a 100-peso winning bet at ratio 1.85 pays out 185.00 (stake included).
 *
 * Pari-mutuel formula:
 *   total           = meronPool + walaPool
 *   commission_take = total * (commissionRate / 2)
 *   distributable   = total - commission_take
 *   ratio_winner    = distributable / winning_pool   (floored to 2 decimals)
 *   ratio_loser     = 0                              (no payout)
 *
 * Edge cases:
 *   - Outcome DRAW → both ratios null (refund, not payout).
 *   - Winning pool is zero (no one bet that side) → ratio null. The house
 *     keeps the losing pool; there are no winners to pay.
 *   - Both pools are zero → both ratios null. Nothing to do at settlement.
 *
 * @returns { payoutRatioMeron: string|null, payoutRatioWala: string|null }
 */
export function computePayoutRatios({ meronPool, walaPool, commissionRate, outcome }) {
  assertValidOutcome(outcome)

  if (outcome === 'DRAW') {
    return { payoutRatioMeron: null, payoutRatioWala: null }
  }

  const meron = toNumber(meronPool)
  const wala = toNumber(walaPool)
  const distributable = computePoolDistributable(meron, wala, commissionRate)

  if (outcome === 'MERON') {
    return {
      payoutRatioMeron: meron > 0 ? toRatioString(distributable / meron) : null,
      payoutRatioWala: null
    }
  }
  // outcome === 'WALA'
  return {
    payoutRatioMeron: null,
    payoutRatioWala: wala > 0 ? toRatioString(distributable / wala) : null
  }
}

// ---------------------------------------------------------------------------
// Bet status / payoutAmount resolution
//
// Given an outcome (+ payout ratios) and one bet, decide what its row
// should look like after settlement. PAID bets are special-cased — see
// determineBetTargetState() for the policy.
// ---------------------------------------------------------------------------

/**
 * Map { outcome, payoutRatios, bet } → the bet's settled state.
 *
 * Returns { targetStatus, targetPayoutAmount }.
 *
 *   targetStatus       one of WON | LOST | PENDING_REFUND
 *   targetPayoutAmount string ("123.45") | null
 *
 * Caller is responsible for stamping previousStatus / previousPayoutAmount
 * and for the "leave PAID as PAID even on correction" rule (operator-loss
 * tracking). See applyCorrectionToBet() for the correction-specific wrapper.
 */
export function determineBetTargetState({ outcome, payoutRatioMeron, payoutRatioWala }, bet) {
  if (outcome === 'DRAW') {
    return {
      targetStatus: 'PENDING_REFUND',
      targetPayoutAmount: toMoneyString(toNumber(bet.amount))
    }
  }

  if (bet.side === outcome) {
    const ratio = bet.side === 'MERON' ? payoutRatioMeron : payoutRatioWala
    if (ratio === null || ratio === undefined) {
      // Winning side with no ratio means the winning pool was zero — but
      // this bet is on that pool, so by definition the pool can't be zero.
      // This is a logic error if we ever reach it.
      throw new Error('Inconsistent settlement: winning side has no payout ratio')
    }
    return {
      targetStatus: 'WON',
      targetPayoutAmount: toMoneyString(toNumber(bet.amount) * toNumber(ratio))
    }
  }

  return { targetStatus: 'LOST', targetPayoutAmount: null }
}

// ---------------------------------------------------------------------------
// Per-bet update plan for SETTLEMENT (fresh settle, never corrected before)
// ---------------------------------------------------------------------------

/**
 * Build the Prisma update payload for a bet during a fresh fight settlement.
 *
 * Inputs:
 *   ratios = { outcome, payoutRatioMeron, payoutRatioWala }
 *   bet    = the current bet row (only need .id, .amount, .side, .status,
 *            .tellerId)
 *
 * Returns one of:
 *   { skip: true }                                   ← bet is VOIDED, leave it
 *   { update: { where, data }, ledger?: { ... } }    ← apply this
 *
 * Ledger entries for draw/cancel refunds happen at payout-desk redemption,
 * not here. Winning bets get PAYOUT at redemption; losing bets have no cash
 * movement.
 */
export function planSettlementForBet(ratios, bet) {
  if (bet.status === 'VOIDED') return { skip: true }
  if (bet.status !== 'PENDING') {
    // A SETTLED fight should only have PENDING + VOIDED bets going into
    // settle. Anything else is a state-machine bug upstream.
    throw new Error(`Cannot settle bet ${bet.id}: unexpected status "${bet.status}"`)
  }

  const { targetStatus, targetPayoutAmount } = determineBetTargetState(ratios, bet)

  return {
    update: {
      where: { id: bet.id },
      data: {
        status: targetStatus,
        payoutAmount: targetPayoutAmount
      }
    },
    ledger: null
  }
}

// ---------------------------------------------------------------------------
// Per-bet update plan for CANCELLATION
//
// Every PENDING bet becomes PENDING_REFUND with payoutAmount = stake.
// Cash on hand is debited when the ticket is paid out at the payout desk.
// VOIDED bets were already returned to the customer pre-settlement; do not touch them.
// ---------------------------------------------------------------------------

export function planCancellationForBet(bet, { reason } = {}) {
  if (bet.status === 'VOIDED') return { skip: true }
  if (bet.status !== 'PENDING') {
    throw new Error(`Cannot cancel bet ${bet.id}: unexpected status "${bet.status}"`)
  }
  const amount = toMoneyString(toNumber(bet.amount))
  return {
    update: {
      where: { id: bet.id },
      data: { status: 'PENDING_REFUND', payoutAmount: amount }
    },
    ledger: null
  }
}

// ---------------------------------------------------------------------------
// Per-bet update plan for CORRECTION (already-settled fight, outcome changes)
//
// Rules:
//   - VOIDED is sticky → no change.
//   - PAID is sticky on status (cash is already out) but we still record
//     previousPayoutAmount and stamp correctedAt. The "operator loss"
//     report later filters on (status PAID AND correctedAt IS NOT NULL).
//   - All other previous statuses (WON/LOST/REFUNDED/PENDING-edge) flip
//     to the new target derived from the new outcome.
//
// No ledger entries are emitted from corrections automatically. Refunds
// that result from a correction (e.g. WON→PENDING_REFUND) are paid at the
// payout desk. WON→LOST flips do NOT need ledger entries (no cash moved).
// LOST→WON also does not move cash until the cashier redeems the now-winning ticket.
// ---------------------------------------------------------------------------

export function planCorrectionForBet(ratios, bet, { reason } = {}) {
  if (bet.status === 'VOIDED') return { skip: true }
  if (bet.status === 'REFUNDED') return { skip: true }

  const { targetStatus, targetPayoutAmount } = determineBetTargetState(ratios, bet)

  const noChange = targetStatus === bet.status &&
    sameMoney(targetPayoutAmount, bet.payoutAmount)

  if (noChange) return { skip: true }

  const correctedAt = new Date()

  // PAID is sticky on status — preserve the physical payment record.
  if (bet.status === 'PAID') {
    return {
      update: {
        where: { id: bet.id },
        data: {
          // status stays PAID, but flag the correction
          previousStatus: bet.status,
          previousPayoutAmount: bet.payoutAmount,
          payoutAmount: targetPayoutAmount,
          correctedAt
        }
      },
      ledger: null
    }
  }

  // Non-paid path: flip status + payoutAmount, snapshot the previous values.
  const data = {
    status: targetStatus,
    payoutAmount: targetPayoutAmount,
    previousStatus: bet.status,
    previousPayoutAmount: bet.payoutAmount,
    correctedAt
  }

  return {
    update: { where: { id: bet.id }, data },
    ledger: null
  }
}

function sameMoney(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  return toNumber(a) === toNumber(b)
}

// ---------------------------------------------------------------------------
// Per-bet update plan for UNSETTLE (SETTLED → CLOSED)
//
// Rules:
//   - VOIDED is sticky → no change.
//   - PAID / REFUNDED block the whole fight unsettle (cash already moved).
//   - WON / LOST / PENDING_REFUND → PENDING; clear payout + correction fields.
//   - PENDING (unexpected on a settled fight) → no-op skip.
// ---------------------------------------------------------------------------

const UNSETTLE_BLOCKING_STATUSES = new Set(['PAID', 'REFUNDED'])
const UNSETTLE_RESETTABLE_STATUSES = new Set(['WON', 'LOST', 'PENDING_REFUND'])

/**
 * Aggregate gate before unsettle. Returns counts; caller throws ConflictError
 * when paidCount or refundedCount > 0.
 *
 * @param {Array<{ status: string }>} bets
 */
export function assertFightCanUnsettle(bets) {
  const counts = {
    paidCount: 0,
    refundedCount: 0,
    resettableCount: 0,
    voidedCount: 0,
    otherCount: 0
  }
  for (const bet of bets) {
    if (bet.status === 'PAID') counts.paidCount += 1
    else if (bet.status === 'REFUNDED') counts.refundedCount += 1
    else if (bet.status === 'VOIDED') counts.voidedCount += 1
    else if (UNSETTLE_RESETTABLE_STATUSES.has(bet.status)) counts.resettableCount += 1
    else counts.otherCount += 1
  }
  return {
    ...counts,
    blocked: counts.paidCount > 0 || counts.refundedCount > 0
  }
}

/**
 * Build the Prisma update payload for a bet during fight unsettle.
 *
 * Returns one of:
 *   { skip: true, reason: 'VOIDED'|'PENDING'|'OTHER' }
 *   { block: true, reason: 'PAID'|'REFUNDED' }
 *   { update: { where, data } }
 */
export function planUnsettleForBet(bet) {
  if (bet.status === 'VOIDED') return { skip: true, reason: 'VOIDED' }
  if (bet.status === 'PENDING') return { skip: true, reason: 'PENDING' }
  if (UNSETTLE_BLOCKING_STATUSES.has(bet.status)) {
    return { block: true, reason: bet.status }
  }
  if (!UNSETTLE_RESETTABLE_STATUSES.has(bet.status)) {
    return { skip: true, reason: 'OTHER' }
  }

  return {
    update: {
      where: { id: bet.id },
      data: {
        status: 'PENDING',
        payoutAmount: null,
        previousStatus: null,
        previousPayoutAmount: null,
        correctedAt: null
      }
    }
  }
}
