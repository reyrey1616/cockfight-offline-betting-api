// Reports service — per-teller commission attribution.
//
// ================================================================
// THE MATH (why this works cleanly)
// ================================================================
//
// Cockfight commission in this system is parimutuel: the house takes
// a flat `commissionRate` of the ENTIRE pool before distributing the
// remainder to the winning side. So for any settled fight:
//
//     houseCommission(fight) = totalPool × commissionRate
//
// Because commission comes off the gross pool PROPORTIONALLY, every
// peso of stake — regardless of which side it was on or whether it
// won — contributed `commissionRate` pesos of commission. Therefore:
//
//     tellerCommission(fight, teller)
//       = (teller's stake on fight) × commissionRate
//
// And summing across fights:
//
//     tellerCommission(teller, scope)
//       = SUM_over_bets( bet.stake × bet.fight.commissionRate )
//
// The commission rate is SNAPSHOTTED onto each Fight row at create
// time. So this math is correct even if the admin changed
// `Setting.commissionRate` mid-session — each bet uses ITS fight's
// rate.
//
// ================================================================
// WHICH BETS COUNT
// ================================================================
//
//   WON  | LOST | PAID    → ✅ count toward commission
//   REFUNDED                → ❌ DRAW / CANCELLED / NO_CONTEST → no commission was taken
//   VOIDED                  → ❌ pulled pre-settle, pool decremented, no commission
//   PENDING                 → ❌ fight not yet settled; commission not yet realized
//
// Filter: `b.status IN ('WON', 'LOST', 'PAID')`.
//
// ================================================================
// CONCURRENCY
// ================================================================
//
// No locks. This is a read-only aggregation. Postgres MVCC gives us
// a consistent snapshot at the BEGIN of the query — even if a fight
// is being settled concurrently, we either see the pre-settle state
// (some bets PENDING) or the post-settle state (those bets now
// WON/LOST). We never see a half-state. Re-running the query a
// moment later picks up the new state.

import { Prisma } from '@prisma/client'

// ===========================================================================
// Build a Prisma SQL fragment for the time-range / fight filter.
//
// Using `Prisma.sql` keeps the parameters parameterized (no SQL injection)
// while letting us conditionally include or omit clauses. `Prisma.empty`
// is the no-op placeholder when a filter is absent.
// ===========================================================================

function buildFilters({ since, until, fightId, includeInactive }) {
  const sinceClause = since ? Prisma.sql` AND b."createdAt" >= ${new Date(since)}` : Prisma.empty
  const untilClause = until ? Prisma.sql` AND b."createdAt" <= ${new Date(until)}` : Prisma.empty
  const fightClause = fightId ? Prisma.sql` AND b."fightId" = ${fightId}` : Prisma.empty
  const activeClause = includeInactive
    ? Prisma.empty
    : Prisma.sql` AND u."isActive" = TRUE`
  return { sinceClause, untilClause, fightClause, activeClause }
}

// ===========================================================================
// GET /reports/teller-commissions
// ===========================================================================

const DEFAULT_INCLUDE_INACTIVE = true

export async function getTellerCommissions(prisma, rawQuery = {}) {
  const since = rawQuery.since ?? null
  const until = rawQuery.until ?? null
  const fightId = rawQuery.fightId ?? null
  const includeInactive = rawQuery.includeInactive ?? DEFAULT_INCLUDE_INACTIVE

  const { sinceClause, untilClause, fightClause, activeClause } =
    buildFilters({ since, until, fightId, includeInactive })

  // Single GROUP BY against Bet ⋈ Fight ⋈ User. The
  // SUM(b.amount * f."commissionRate") aggregate is impossible to
  // express with Prisma's typed `groupBy` API (it only does
  // single-column SUMs), so we drop to $queryRaw. Identifiers are
  // literals; values are parameterized through Prisma.sql template
  // tags.
  //
  // Schema reminder: the bet's wager amount lives in `Bet.amount`
  // (Decimal(12, 2)). The term "stake" is the conceptual / wire-side
  // name; the DB column is `amount`.
  //
  // Decimal precision:
  //   - b.amount:         Decimal(12, 2)
  //   - f.commissionRate: Decimal(5, 4)
  //   - product:          Decimal(17, 6) — Postgres preserves full precision
  // We round to 2 dp at the projection boundary (toFixed below).
  const rows = await prisma.$queryRaw`
    SELECT
      u.id           AS "tellerId",
      u.username     AS "username",
      u."fullName"   AS "fullName",
      u."isActive"   AS "isActive",
      COUNT(b.id)::int                                                                      AS "betCount",
      COALESCE(SUM(b.amount),                                                          0)   AS "grossHandle",
      COALESCE(SUM(CASE WHEN b.status IN ('WON', 'PAID') THEN b.amount ELSE 0 END),    0)   AS "winningStake",
      COALESCE(SUM(CASE WHEN b.status = 'LOST'           THEN b.amount ELSE 0 END),    0)   AS "losingStake",
      COALESCE(SUM(b.amount * f."commissionRate"),                                     0)   AS "commissionGenerated"
    FROM "User" u
    JOIN "Bet"   b ON b."tellerId" = u.id
    JOIN "Fight" f ON f.id         = b."fightId"
    WHERE b.status IN ('WON', 'LOST', 'PAID')
      ${sinceClause}
      ${untilClause}
      ${fightClause}
      ${activeClause}
    GROUP BY u.id, u.username, u."fullName", u."isActive"
    ORDER BY "commissionGenerated" DESC, u.username ASC
  `

  // Project Decimal → fixed-2 strings for the wire. Decimal arithmetic
  // happens in PG; this is purely formatting.
  const tellers = rows.map((r) => ({
    tellerId: r.tellerId,
    username: r.username,
    fullName: r.fullName,
    isActive: r.isActive,
    betCount: r.betCount,
    grossHandle: toMoney(r.grossHandle),
    winningStake: toMoney(r.winningStake),
    losingStake: toMoney(r.losingStake),
    commissionGenerated: toMoney(r.commissionGenerated)
  }))

  // Totals: a single follow-up aggregate so the sanity invariant
  // (SUM of per-teller commission === houseCommission for the scope)
  // can be verified by the client without re-summing the array.
  // We compute it in JS rather than a separate SQL query — the JS
  // sum is the canonical client-side sanity check, and re-doing the
  // SQL would be a different aggregate (no GROUP BY) that might drift
  // from what we just returned.
  const totals = tellers.reduce((acc, t) => ({
    tellerCount: acc.tellerCount + 1,
    betCount: acc.betCount + t.betCount,
    grossHandle: addMoney(acc.grossHandle, t.grossHandle),
    commissionGenerated: addMoney(acc.commissionGenerated, t.commissionGenerated)
  }), {
    tellerCount: 0,
    betCount: 0,
    grossHandle: '0.00',
    commissionGenerated: '0.00'
  })

  return {
    scope: {
      since: since ?? null,
      until: until ?? null,
      fightId: fightId ?? null,
      includeInactive
    },
    tellers,
    totals
  }
}

// ---------------------------------------------------------------------------
// Money projection helpers.
// ---------------------------------------------------------------------------

/**
 * Format any incoming numeric type (Prisma Decimal, bigint, number,
 * string) to a fixed-2 string. Goes through Number for portability —
 * we never deal with more than ~12 significant digits of pesos here
 * so we don't approach JS Number's 2^53 precision ceiling.
 */
function toMoney(v) {
  if (v === null || v === undefined) return '0.00'
  // Prisma Decimal exposes toFixed(); bigint doesn't.
  if (typeof v?.toFixed === 'function') return v.toFixed(2)
  return Number(v).toFixed(2)
}

/** Add two fixed-2 strings, return fixed-2. */
function addMoney(a, b) {
  // Multiply by 100 to work in integer "centavos" — avoids the
  // classic 0.1 + 0.2 = 0.30000000000000004 float surprise.
  const totalCent = Math.round(Number(a) * 100) + Math.round(Number(b) * 100)
  return (totalCent / 100).toFixed(2)
}
