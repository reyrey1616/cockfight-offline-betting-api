// WebSocket frame builders for fight-domain events.
//
// Why this lives in the fights module (and not in `src/lib/websocket.js`):
// the file owns the wire contract for every event that describes a Fight
// resource. The bets module emits `ODDS_UPDATE` after a placement / void,
// but the event is semantically *about* a fight's pool — so the builder
// lives here and the bets module just imports it.
//
// Every builder returns the canonical frame envelope:
//   { type: <EVENT_TYPE>, data: { ... }, ts: <ISO timestamp> }
//
// See `docs/realtime-events.md` for the full event catalog and the
// endpoint → broadcast wiring table.

import { computeLiveOdds } from '../../lib/odds.js'

const isoNow = () => new Date().toISOString()

// Shared "data" projection for any frame that talks about a fight. Keeping
// it in one place prevents OPENED / CLOSED / SETTLED / CANCELLED / CREATED
// shapes from drifting over time.
function fightProjection(fight, extra = {}) {
  const { meronOdds, walaOdds } = computeLiveOdds(fight)
  return {
    fightId: fight.id,
    fightNumber: fight.fightNumber,
    status: fight.status,
    meronPool: fight.meronPool,
    walaPool: fight.walaPool,
    meronOdds,
    walaOdds,
    meronAcceptingBets: fight.meronAcceptingBets,
    walaAcceptingBets: fight.walaAcceptingBets,
    ...extra
  }
}

// ---------------------------------------------------------------------------
// ODDS_UPDATE
//
// Emitted by the bets module on every placement / void. Lives in the fights
// module because the data it carries is fight-owned (pool totals + derived
// odds), not bet-owned.
// ---------------------------------------------------------------------------
export function buildOddsUpdatePayload({ fightId, meronPool, walaPool, meronOdds, walaOdds }) {
  return {
    type: 'ODDS_UPDATE',
    data: { fightId, meronPool, walaPool, meronOdds, walaOdds },
    ts: isoNow()
  }
}

// ---------------------------------------------------------------------------
// Fight lifecycle frames
//
// Note: there is no FIGHT_CREATED event — fights come into existence
// already in OPEN state (see POST /fights), so FIGHT_OPENED is the single
// "a new fight is live" signal. CREATED + OPENED would be redundant.
// ---------------------------------------------------------------------------

export function buildFightOpenedPayload(fight) {
  return { type: 'FIGHT_OPENED', data: fightProjection(fight), ts: isoNow() }
}

export function buildFightClosedPayload(fight) {
  return { type: 'FIGHT_CLOSED', data: fightProjection(fight), ts: isoNow() }
}

export function buildFightSettledPayload(fight) {
  return {
    type: 'FIGHT_SETTLED',
    data: fightProjection(fight, {
      outcome: fight.outcome,
      payoutRatioMeron: fight.payoutRatioMeron,
      payoutRatioWala: fight.payoutRatioWala
    }),
    ts: isoNow()
  }
}

export function buildFightCancelledPayload(fight) {
  return { type: 'FIGHT_CANCELLED', data: fightProjection(fight), ts: isoNow() }
}

export function buildFightCorrectedPayload(fight) {
  return {
    type: 'FIGHT_CORRECTED',
    data: fightProjection(fight, {
      outcome: fight.outcome,
      payoutRatioMeron: fight.payoutRatioMeron,
      payoutRatioWala: fight.payoutRatioWala,
      previousOutcome: fight.previousOutcome,
      previousPayoutRatioMeron: fight.previousPayoutRatioMeron,
      previousPayoutRatioWala: fight.previousPayoutRatioWala,
      correctionReason: fight.correctionReason,
      correctedAt: fight.correctedAt
    }),
    ts: isoNow()
  }
}

// ---------------------------------------------------------------------------
// Per-side bet-acceptance frames
// ---------------------------------------------------------------------------

export function buildSideHeldPayload(fight, side) {
  return {
    type: 'SIDE_HELD',
    data: {
      fightId: fight.id,
      side,
      accepting: { meron: fight.meronAcceptingBets, wala: fight.walaAcceptingBets }
    },
    ts: isoNow()
  }
}

export function buildSideUnheldPayload(fight, side) {
  return {
    type: 'SIDE_UNHELD',
    data: {
      fightId: fight.id,
      side,
      accepting: { meron: fight.meronAcceptingBets, wala: fight.walaAcceptingBets }
    },
    ts: isoNow()
  }
}
