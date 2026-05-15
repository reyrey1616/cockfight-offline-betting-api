// WebSocket frame builders for session-domain events.
//
// SESSION_RESET fires once per successful `POST /session/reset`. Every
// connected kiosk should treat it as a hard signal to clear local state
// (current fight, balance, ticket history, ...) — there is no scoping;
// the whole transactional surface is gone for everyone.
//
// We do NOT forcibly close WS connections. Clients keep their socket and
// continue receiving subsequent frames against the now-empty state. The
// frame itself is the trigger to refresh; the transport is fine.

const isoNow = () => new Date().toISOString()

/**
 * Frame emitted after a session reset commits.
 *
 * Carries enough metadata for kiosks to render an informative banner
 * ("Session reset by Juan Dela Cruz at 11:42 PM — 12 fights, 145 bets,
 * 230 ledger entries cleared") without a follow-up REST call.
 *
 * @param {object}  args
 * @param {string}  args.sessionResetId       The audit row id (so kiosks
 *                                            can dedupe if they reconnect
 *                                            and see the same frame).
 * @param {string}  args.performedAt          ISO timestamp.
 * @param {string}  args.performedByUserId
 * @param {string}  args.performedByUsername  Display name; admins on the
 *                                            dashboard usually want this
 *                                            without a join.
 * @param {object}  args.deletedCounts        { fights, bets, ledger }
 * @param {boolean} args.forced               True if invariants were bypassed.
 */
export function buildSessionResetPayload({
  sessionResetId,
  performedAt,
  performedByUserId,
  performedByUsername,
  deletedCounts,
  forced
}) {
  return {
    type: 'SESSION_RESET',
    data: {
      sessionResetId,
      performedAt,
      performedByUserId,
      performedByUsername,
      deletedCounts,
      forced
    },
    ts: isoNow()
  }
}
