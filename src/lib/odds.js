// Live (projected) pari-mutuel odds for the broadcast payload.
//
// THESE ARE NOT THE FINAL PAYOUT RATIOS. Final ratios are frozen onto
// Fight.payoutRatioMeron / payoutRatioWala at SETTLEMENT time. The numbers
// here are a real-time projection so tellers see the pool drift while bets
// pour in. They will keep moving until the fight is closed.
//
// Formula (sabong / pari-mutuel, includes stake):
//
//   payoutRatioForSide = 1 + ((opposingPool * (1 - commission)) / sideOwnPool)
//
// Example: meronPool = 1000, walaPool = 800, commission = 0.10
//   meronOdds = 1 + (800 * 0.90 / 1000) = 1 + 0.72 = 1.72
//   walaOdds  = 1 + (1000 * 0.90 / 800) = 1 + 1.125 = 2.125
//
// Edge cases:
//   - If a side's pool is 0, its odds are returned as null (no bets exist on
//     that side yet, so "what does 1 peso pay" is undefined).
//   - If the opposing pool is 0, the side's odds are 1.00 — winners get only
//     their stake back because no opposing money exists to pay them with.
//
// Rounding: live multipliers are rounded to 2 decimal places for display and
// wire payloads — typical for retail betting UIs (stakes/payouts in currency
// minor units; odds quoted to hundredths).

const ZERO = 0

function toNumber(decimalLike) {
  // Prisma's Decimal columns may come back as strings (driver adapter) or as
  // Decimal.js instances depending on the path. Normalize once here so the
  // arithmetic below is plain JS — safe for the magnitudes a single fight
  // produces (max realistically a few million pesos).
  if (decimalLike == null) return ZERO
  if (typeof decimalLike === 'number') return decimalLike
  if (typeof decimalLike === 'string') return Number(decimalLike)
  if (typeof decimalLike.toNumber === 'function') return decimalLike.toNumber()
  return Number(decimalLike)
}

function round2(n) {
  return Math.round(n * 100) / 100
}

/**
 * @param {{ meronPool, walaPool, commissionRate }} fight
 * @returns {{ meronOdds: number | null, walaOdds: number | null }}
 */
export function computeLiveOdds(fight) {
  const meron = toNumber(fight.meronPool)
  const wala = toNumber(fight.walaPool)
  const commission = toNumber(fight.commissionRate)
  const keepRate = 1 - commission

  const meronOdds = meron > 0
    ? round2(1 + (wala * keepRate) / meron)
    : null
  const walaOdds = wala > 0
    ? round2(1 + (meron * keepRate) / wala)
    : null

  return { meronOdds, walaOdds }
}
