// Live (projected) pari-mutuel odds for the broadcast payload.
//
// THESE ARE NOT THE FINAL PAYOUT RATIOS. Final ratios are frozen onto
// Fight.payoutRatioMeron / payoutRatioWala at SETTLEMENT time. The numbers
// here are a real-time projection so tellers see the pool drift while bets
// pour in. They will keep moving until the fight is closed.
//
// Formula (pari-mutuel, includes stake in the multiplier):
//
//   houseTake       = (meronPool + walaPool) * (commissionRate / 2)
//   distributable   = totalPool - houseTake
//   payoutForSide   = distributable / sideOwnPool
//
// Example: meronPool = 1000, walaPool = 800, commissionRate = 0.10
//   total = 1800, houseTake = 1800 * 0.05 = 90, distributable = 1710
//   meronOdds = 1710 / 1000 = 1.71
//   walaOdds  = 1710 / 800  = 2.1375 → floored to 2.13
//
// Edge cases:
//   - If a side's pool is 0, its odds are returned as null (no bets exist on
//     that side yet, so "what does 1 peso pay" is undefined).
//   - If the opposing pool is 0, the lone side's odds are (1 - commission/2)
//     because house take is still commission/2 of that side's pool.
//
// Rounding: floored to 2 decimal places so displayed odds never exceed payout
// math (same rule as frozen settlement ratios).

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

function floor2(n) {
  return Math.floor(n * 100) / 100
}

/** Pool left for winners after house take (commissionRate / 2 of total handle). */
export function computePoolDistributable(meronPool, walaPool, commissionRate) {
  const meron = toNumber(meronPool)
  const wala = toNumber(walaPool)
  const commission = toNumber(commissionRate)
  const total = meron + wala
  return total * (1 - commission / 2)
}

/**
 * @param {{ meronPool, walaPool, commissionRate }} fight
 * @returns {{ meronOdds: number | null, walaOdds: number | null }}
 */
export function computeLiveOdds(fight) {
  const meron = toNumber(fight.meronPool)
  const wala = toNumber(fight.walaPool)
  const commission = toNumber(fight.commissionRate)
  const distributable = computePoolDistributable(meron, wala, commission)

  const meronOdds = meron > 0 ? floor2(distributable / meron) : null
  const walaOdds = wala > 0 ? floor2(distributable / wala) : null

  return { meronOdds, walaOdds }
}
