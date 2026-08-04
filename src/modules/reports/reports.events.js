// WebSocket frame builders for the reports module.
//
// TELLER_COMMISSIONS_UPDATED — the "thin signal" pattern.
//
// We intentionally DO NOT carry the full per-teller leaderboard inline
// for two reasons:
//   1. The leaderboard depends on the admin's current filter scope
//      (since/until/fightId). The broadcast can't know what filter
//      the dashboard is using, so any inline payload would be either
//      wrong (use the wrong scope) or wasteful (send unfiltered data
//      to a filtered view).
//   2. The leaderboard is a derived view. Pushing the trigger metadata
//      keeps the WS contract decoupled from the report's projection
//      shape — we can extend the report response in the future without
//      changing the broadcast frame.
//
// So: kiosks receive this frame, then refetch `/reports/teller-commissions`
// with whatever scope they're currently rendering. On a LAN the
// round-trip is ~5-15ms so the UX is effectively real-time.
//
// Mirrors the `SESSION_RESET` frame's design (also metadata-only).

const isoNow = () => new Date().toISOString()

/**
 * @param {object} args
 * @param {'FIGHT_SETTLED'|'FIGHT_CANCELLED'|'FIGHT_CORRECTED'|'FIGHT_UNSETTLED'|'BET_PURGED'} args.trigger
 *   Which fight-lifecycle event mutated realized commission.
 * @param {string} args.fightId
 * @param {number} args.fightNumber  Human-friendly identifier for UI banners.
 */
export function buildTellerCommissionsUpdatedPayload({ trigger, fightId, fightNumber }) {
  return {
    type: 'TELLER_COMMISSIONS_UPDATED',
    data: {
      trigger,
      fightId,
      fightNumber
    },
    ts: isoNow()
  }
}
