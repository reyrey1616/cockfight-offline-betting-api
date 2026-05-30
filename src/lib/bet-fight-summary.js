import { computeLiveOdds } from './odds.js'

/**
 * Slim fight projection returned with bet payloads (place, lookup, pay, void).
 * Keeps pool/odds/ratios without the full Fight row shape from list/detail routes.
 */
export function projectBetFightSummary(fight) {
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
