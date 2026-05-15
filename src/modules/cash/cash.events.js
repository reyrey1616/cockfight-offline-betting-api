// WebSocket frame builders for cash-domain events.
//
// Why this lives in the cash module: TELLER_BALANCE_UPDATED describes a
// teller's running cash balance, which is derived from `TellerLedger`
// SUMs — and the cash module owns that ledger surface. The bets module
// emits the frame too (after place / void / pay), but it imports the
// builder from here.
//
// See `docs/realtime-events.md` for the full catalog and wiring table.

const isoNow = () => new Date().toISOString()

/**
 * Frame emitted whenever a teller's running cash balance changes.
 *
 * Consumed by the admin dashboard (real-time view of every teller's
 * drawer) and by the *receiving* teller's kiosk in cases where the
 * change wasn't triggered by the kiosk itself (e.g. an admin recorded a
 * cash advance to that teller).
 *
 * Kiosks that DID trigger the change can short-circuit by reading
 * `actorBalance` from the HTTP response body instead — same value, no
 * round-trip through the WS layer needed.
 *
 * @param {object}  args
 * @param {string}  args.tellerId    Whose balance moved.
 * @param {string}  args.tellerName  Full name (so admin dashboard doesn't
 *                                   have to join against User on every frame).
 * @param {string}  args.balance     New balance as a 2-decimal string.
 * @param {object}  args.delta       What caused the change.
 * @param {string}  args.delta.type  TellerLedger entry type (CASH_ADVANCE,
 *                                   BET_PLACED, BET_VOIDED, BET_REFUNDED,
 *                                   PAYOUT, REMIT, ADJUSTMENT).
 * @param {string}  args.delta.amount  Signed amount as a 2-decimal string
 *                                     (positive = in, negative = out).
 */
export function buildTellerBalanceUpdatedPayload({ tellerId, tellerName, balance, delta }) {
  return {
    type: 'TELLER_BALANCE_UPDATED',
    data: { tellerId, tellerName, balance, delta },
    ts: isoNow()
  }
}
