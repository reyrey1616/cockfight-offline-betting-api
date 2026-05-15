// Teller running-balance helper.
//
// A teller's cash balance is always derived: `SUM(amount) FROM
// TellerLedger WHERE tellerId = ?`. There is no denormalized cashBalance
// column on User by design — the ledger is the source of truth, and a
// cached field would just be a drift hazard.
//
// Lives in `src/lib/` because it's used by both the cash module (for
// every advance / remit / balance query) and the bets module (for
// returning `actorBalance` on placeBet / voidBet / payBet responses).

/**
 * Compute a teller's current cash balance from their ledger entries.
 *
 * Accepts either a `PrismaClient` or a transaction client (`tx`) — pass
 * `tx` when computing inside an open transaction so the result reflects
 * the same snapshot as the surrounding writes (e.g. immediately after
 * inserting a new ledger row).
 *
 * @param {import('@prisma/client').PrismaClient | any} prismaOrTx
 * @param {string} tellerId
 * @returns {Promise<string>} Balance as a 2-decimal string ("0.00", "1234.56").
 *                            Always returns a string so callers can hand it
 *                            straight to a JSON response or the WS frame
 *                            without further coercion.
 */
export async function computeTellerBalance(prismaOrTx, tellerId) {
  const { _sum } = await prismaOrTx.tellerLedger.aggregate({
    where: { tellerId },
    _sum: { amount: true }
  })

  // Prisma returns Decimal | null. Null means "no rows for this teller"
  // — a fresh user with no advances or activity yet. Surface that as
  // "0.00" rather than null so callers don't have to special-case it.
  if (_sum.amount === null || _sum.amount === undefined) return '0.00'

  // _sum.amount is a `decimal.js` Decimal instance. `.toFixed(2)` is the
  // exact, lossless way to render it as a 2-decimal string for both the
  // wire and the DB representation.
  return _sum.amount.toFixed(2)
}
