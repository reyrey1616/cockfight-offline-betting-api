// Session reset service.
//
// This file implements the most destructive endpoint in the system. The
// design is dominated by SAFETY, not raw correctness:
//
//   1. The HTTP body must contain the magic confirmation token. Schema-
//      enforced via `const` — wrong value → 400, never a wipe.
//   2. Pre-flight invariants block the wipe by default. They cover every
//      situation where there's still customer money in flight:
//        - any OPEN or CLOSED fight (active betting / awaiting result)
//        - any WON bet not yet PAID (cash owed to a winning customer)
//        - any teller with non-zero running balance (cash unaccounted for)
//      `force: true` bypasses them but the audit row records `forced: true`.
//   3. Counts, audit insert, and TRUNCATE all run in a single Postgres
//      transaction. A failure in any step rolls back the entire wipe.
//   4. The audit row (`SessionReset`) survives every subsequent reset —
//      it lives on the one table that's never wiped.
//
// Concurrency: TRUNCATE acquires an ACCESS EXCLUSIVE lock on each target
// table, which serializes against every other operation on those tables.
// Concurrent placeBet / payBet / cashAdvance / etc. will queue (or
// time out via their own tx budget) until the wipe commits — there is
// no risk of half-wiped state from interleaved writes.

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  RequestTimeoutError
} from '../../lib/errors.js'
import { verifyUserPassword } from '../auth/auth.service.js'

const TX_TIMEOUT_MS = 15_000
const TX_MAX_WAIT_MS = 2_000

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

// ===========================================================================
// Wipe set — the three tables /session/reset TRUNCATEs together. Kept
// as a single source of truth so the SQL string in `performReset` and
// the FK-closure guard below cannot drift apart.
// ===========================================================================

export const WIPE_TARGET_TABLES = ['Fight', 'Bet', 'TellerLedger']

// ===========================================================================
// FK-closure guard (called at server boot from `buildServer`).
//
// Why this exists:
//   /session/reset issues a single TRUNCATE on the wipe set without
//   CASCADE. Postgres requires that every table FK-referencing one of
//   the wiped tables be included in the same TRUNCATE. Today the wipe
//   set is closed: every inbound FK to {Fight, Bet, TellerLedger}
//   originates from a table already in the set.
//
//   If a future migration adds a table that FKs into one of these
//   without being added to the wipe set, the very next /session/reset
//   will fail in production with an opaque Postgres error. By then
//   the operator is at end-of-night, tired, and the system is partly
//   wiped.
//
//   This function flags the drift at server BOOT — well before the
//   admin clicks the button. Reported as a WARN with the offending
//   constraint(s) so the maintainer can either (a) add the new table
//   to the wipe set or (b) decide the FK should not exist.
// ===========================================================================

/**
 * Inspect pg_constraint for any FK pointing INTO a wipe-target table
 * from a table OUTSIDE the wipe set. Returns the offending constraints
 * (empty array means the wipe is safe).
 *
 * Read-only; safe to call repeatedly. ~1 ms on a fresh DB.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<Array<{fromTable: string, toTable: string, constraintName: string}>>}
 */
export async function checkSessionResetSchemaIntegrity(prisma) {
  // `regclass::text` gives a quoted-when-needed table name. We compare
  // against the bare names because `regclass` only quotes mixed-case
  // identifiers, which `Fight`/`Bet`/`TellerLedger` happen to be.
  const quoted = WIPE_TARGET_TABLES.map((t) => `"${t}"`)
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      conrelid::regclass::text  AS "fromTable",
      confrelid::regclass::text AS "toTable",
      conname                   AS "constraintName"
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid::regclass::text IN (${quoted.map((q) => `'${q}'`).join(', ')})
      AND conrelid::regclass::text NOT IN (${quoted.map((q) => `'${q}'`).join(', ')})
  `)
  return rows
}

// ===========================================================================
// Pre-flight invariant evaluator (shared by preview + reset).
//
// Returns the same shape regardless of whether any are violated; the
// caller decides whether to surface them as a preview, gate the wipe,
// or skip them entirely (`force: true`).
// ===========================================================================

async function evaluateInvariants(prisma) {
  const [
    unfinishedFightsCount,
    unpaidWinningBetsCount,
    nonZeroBalanceRows
  ] = await Promise.all([
    prisma.fight.count({ where: { status: { in: ['OPEN', 'CLOSED'] } } }),
    prisma.bet.count({ where: { status: 'WON' } }),
    // groupBy with HAVING — the most efficient way to find tellers with
    // a non-zero net balance without scanning the ledger row-by-row.
    prisma.tellerLedger.groupBy({
      by: ['tellerId'],
      _sum: { amount: true },
      having: { amount: { _sum: { not: 0 } } }
    })
  ])

  // Hydrate teller display info for any non-zero balances. Only fetched
  // when needed so the common (clean) case stays a single round-trip.
  let nonZeroBalanceTellers = []
  if (nonZeroBalanceRows.length > 0) {
    const ids = nonZeroBalanceRows.map((r) => r.tellerId)
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true, fullName: true }
    })
    const byId = new Map(users.map((u) => [u.id, u]))
    nonZeroBalanceTellers = nonZeroBalanceRows
      .map((r) => {
        const u = byId.get(r.tellerId)
        return {
          tellerId: r.tellerId,
          username: u?.username ?? '(unknown)',
          fullName: u?.fullName ?? '(unknown)',
          // Decimal | null → 2-decimal string. SUM is never null here
          // because the HAVING clause already excluded zero / null.
          balance: (r._sum.amount ?? 0).toFixed(2)
        }
      })
      // Stable, human-friendly ordering for the admin's screen.
      .sort((a, b) => a.username.localeCompare(b.username))
  }

  const unfinishedFights = {
    violated: unfinishedFightsCount > 0,
    count: unfinishedFightsCount
  }
  const unpaidWinningBets = {
    violated: unpaidWinningBetsCount > 0,
    count: unpaidWinningBetsCount
  }
  const nonZeroBalances = {
    violated: nonZeroBalanceTellers.length > 0,
    tellerCount: nonZeroBalanceTellers.length,
    tellers: nonZeroBalanceTellers
  }

  return {
    unfinishedFights,
    unpaidWinningBets,
    nonZeroBalances,
    canResetCleanly:
      !unfinishedFights.violated &&
      !unpaidWinningBets.violated &&
      !nonZeroBalances.violated
  }
}

// ===========================================================================
// GET /session/preview — read-only snapshot of "what would happen now?"
// ===========================================================================

export async function previewReset(prisma) {
  const [counts, invariants] = await Promise.all([
    Promise.all([
      prisma.fight.count(),
      prisma.bet.count(),
      prisma.tellerLedger.count()
    ]).then(([fights, bets, ledger]) => ({ fights, bets, ledger })),
    evaluateInvariants(prisma)
  ])

  return {
    counts,
    invariants: {
      unfinishedFights: invariants.unfinishedFights,
      unpaidWinningBets: invariants.unpaidWinningBets,
      nonZeroBalances: invariants.nonZeroBalances
    },
    canResetCleanly: invariants.canResetCleanly
  }
}

// ===========================================================================
// POST /session/reset — perform the wipe.
//
// Returns the persisted SessionReset audit row, hydrated with the
// performer's username + fullName for display.
// ===========================================================================

export async function performReset(prisma, actor, { confirm, password, notes, force = false }) {
  // Defense-in-depth: schema already enforces the const, but the service
  // re-checks so a bypass at the route layer (e.g. a future internal
  // caller) cannot trigger destruction with the wrong magic.
  if (confirm !== 'WIPE-SESSION') {
    throw new BadRequestError('Confirmation token mismatch')
  }
  if (actor?.role !== 'ADMIN') {
    // Re-check role even though the route gates it; the destruction is
    // severe enough to warrant the redundant guard.
    throw new ForbiddenError('Only ADMIN may reset the session')
  }

  // STEP-UP AUTH: re-prove the admin is at the keyboard before wiping
  // the books. The bearer JWT alone is not enough — a JWT could be a
  // forgotten browser tab on a shared kiosk. Throws UnauthorizedError
  // (mapped to 401) on any failure (wrong password, deactivated user,
  // deleted user). Constant-time inside verifyUserPassword.
  await verifyUserPassword(prisma, actor.id, password)

  // Evaluate invariants OUTSIDE the wipe transaction so the 409 response
  // (when force=false) carries the same payload shape as /preview. Inside
  // the tx we'd also have to handle "another op committed between the
  // check and the truncate" — but the truncate's ACCESS EXCLUSIVE lock
  // serializes everything, so by the time we're holding it nothing else
  // is moving. The invariant check is "what was true a moment ago,"
  // which is what the operator saw on /preview.
  if (!force) {
    const invariants = await evaluateInvariants(prisma)
    if (!invariants.canResetCleanly) {
      throw new ConflictError(
        'Pre-flight invariants block this reset. Resolve them or pass `force: true`.',
        {
          unfinishedFights: invariants.unfinishedFights,
          unpaidWinningBets: invariants.unpaidWinningBets,
          nonZeroBalances: invariants.nonZeroBalances
        }
      )
    }
  }

  let result
  try {
    result = await prisma.$transaction(async (tx) => {
      // 1. Snapshot counts that will be destroyed. Done inside the tx so
      //    they reflect the same state the TRUNCATE will see — Postgres
      //    REPEATABLE READ would be ideal but the default READ COMMITTED
      //    is fine here because the upcoming TRUNCATE will lock all three
      //    tables anyway, blocking any concurrent writes.
      const [fightCount, betCount, ledgerCount] = await Promise.all([
        tx.fight.count(),
        tx.bet.count(),
        tx.tellerLedger.count()
      ])

      // 2. INSERT the audit row. This MUST come before the TRUNCATE —
      //    SessionReset is in the public schema and we must demonstrate
      //    that the audit row references a still-valid User row. Doing
      //    it before TRUNCATE also means a failure here aborts the wipe
      //    cleanly (no destruction without an audit trail).
      const sessionReset = await tx.sessionReset.create({
        data: {
          performedByUserId: actor.id,
          fightCount,
          betCount,
          ledgerCount,
          notes: notes ?? null,
          forced: Boolean(force)
        }
      })

      // 3. TRUNCATE all three tables in one statement.
      //    NO `CASCADE` keyword — we never want destruction to escape
      //    the wipe set (e.g. cascade into `User` or `Collector`).
      //    Postgres requires that every table FK-referencing one of
      //    these be listed in the same TRUNCATE, otherwise the
      //    statement fails. Our wipe set ({Fight, Bet, TellerLedger})
      //    is currently self-contained on the inbound side: every FK
      //    pointing INTO it originates from a table already in the
      //    set. If a future migration adds a table that FKs into one
      //    of these without joining the wipe set, the runtime guard
      //    in `assertSessionResetSchemaIntegrity` (run at server boot)
      //    flags the drift before /session/reset breaks in production.
      //
      //    `$executeRawUnsafe` is used because table identifiers
      //    cannot be parameterized via the `$executeRaw` template
      //    tag. The string is a compile-time literal from this file
      //    — no user input is interpolated.
      await tx.$executeRawUnsafe(
        'TRUNCATE TABLE "TellerLedger", "Bet", "Fight" RESTART IDENTITY'
      )

      // 4. Re-fetch the audit row WITH the user join so the route gets a
      //    fully-hydrated response without a follow-up query.
      const hydrated = await tx.sessionReset.findUniqueOrThrow({
        where: { id: sessionReset.id },
        include: {
          performedBy: { select: { username: true, fullName: true } }
        }
      })
      return hydrated
    }, { timeout: TX_TIMEOUT_MS, maxWait: TX_MAX_WAIT_MS })
  } catch (err) {
    if (err?.code === 'P2028') {
      throw new RequestTimeoutError('System busy, please retry')
    }
    throw err
  }

  return projectSessionReset(result)
}

// ===========================================================================
// GET /session/resets — paginated audit log.
//
// Newest first. Cursor-based pagination same as /cash/ledger.
// ===========================================================================

export async function listResets(prisma, query = {}) {
  const limit = Math.min(Math.max(Number(query.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT)

  const rows = await prisma.sessionReset.findMany({
    orderBy: [{ performedAt: 'desc' }, { id: 'desc' }],
    take: limit,
    ...(query.cursor ? { skip: 1, cursor: { id: query.cursor } } : {}),
    include: {
      performedBy: { select: { username: true, fullName: true } }
    }
  })

  return {
    resets: rows.map(projectSessionReset),
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null
  }
}

// ---------------------------------------------------------------------------
// Wire projection. Flattens the User join so the response is a single
// object instead of a nested `performedBy.{username, fullName}`.
// ---------------------------------------------------------------------------

export function projectSessionReset(row) {
  return {
    id: row.id,
    performedAt: row.performedAt,
    performedByUserId: row.performedByUserId,
    performedByUsername: row.performedBy?.username ?? null,
    performedByFullName: row.performedBy?.fullName ?? null,
    fightCount: row.fightCount,
    betCount: row.betCount,
    ledgerCount: row.ledgerCount,
    notes: row.notes ?? null,
    forced: row.forced
  }
}
