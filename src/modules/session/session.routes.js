// Routes for the session module.
//
// Surface
//   GET   /session/preview        admin   read-only "what would be wiped now?"
//   POST  /session/reset          admin   wipe Fight + Bet + TellerLedger
//   GET   /session/resets         admin   audit log (paginated)
//   GET   /session/sync-status    admin   Supabase backup mirror status
//   POST  /session/sync-supabase  admin   push local DB snapshot to Supabase
//
// All three are admin-only — there is no scenario where a teller should
// touch any of these endpoints. The preview is admin-only too because
// it surfaces system-wide counts a teller has no business seeing.

import {
  listResets,
  performReset,
  previewReset
} from './session.service.js'
import {
  listSessionResetsQuerySchema,
  listSessionResetsResponseSchema,
  resetSessionRequestSchema,
  resetSessionResponseSchema,
  sessionPreviewResponseSchema,
  supabaseSyncResponseSchema,
  supabaseSyncStatusResponseSchema
} from './session.schemas.js'
import { buildSessionResetPayload } from './session.events.js'
import { errorResponses } from '../../lib/api-schemas.js'
import {
  getSupabaseSyncStatus,
  syncLocalToSupabase
} from '../../lib/supabase-sync.js'

const tags = ['Session']
const security = [{ bearerAuth: [] }]

export default async function sessionRoutes(app) {
  const adminOnly = [app.authenticate, app.requireRole('ADMIN')]

  // -------------------------------------------------------------------------
  // GET /session/preview
  // -------------------------------------------------------------------------
  app.get(
    '/preview',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Preview what a session reset would destroy',
        description:
          'Read-only. Returns the row counts that a wipe would remove ' +
          'and the result of every pre-flight invariant. Use this to ' +
          'render a confirmation screen BEFORE calling `POST /session/reset`.\n\n' +
          'Pre-flight invariants:\n' +
          '- `unfinishedFights` — any OPEN/CLOSED fight (in-flight money)\n' +
          '- `unpaidWinningBets` — any WON bet not yet PAID (cash owed)\n' +
          '- `nonZeroBalances` — any teller with a non-zero running balance\n\n' +
          '`canResetCleanly` is true iff every invariant passes — no ' +
          '`force: true` would be needed.',
        operationId: 'sessionPreviewReset',
        security,
        response: {
          ...sessionPreviewResponseSchema,
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => previewReset(request.server.prisma)
  )

  // -------------------------------------------------------------------------
  // POST /session/reset
  // -------------------------------------------------------------------------
  app.post(
    '/reset',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Wipe the transactional tables and start a fresh session',
        description:
          '**Destructive.** TRUNCATEs `Fight`, `Bet`, and `TellerLedger` ' +
          'in a single transaction. Preserves `User`, `Collector`, ' +
          '`Setting`, and the `SessionReset` audit log itself.\n\n' +
          '### Required body\n' +
          '```\n' +
          '{\n' +
          '  "confirm":  "WIPE-SESSION",\n' +
          '  "password": "<the bearer admin\'s current password>",\n' +
          '  "notes"?:   "...",\n' +
          '  "force"?:   false\n' +
          '}\n' +
          '```\n\n' +
          '### Three guardrails (must all pass)\n' +
          '1. **Bearer JWT** with role=ADMIN (route + service double-check).\n' +
          '2. **Magic confirmation token** — `confirm` must be exactly ' +
          '`"WIPE-SESSION"`. Schema-enforced via `const`; typos / lowercase ' +
          '/ missing → 400.\n' +
          '3. **Step-up password re-entry** — the bearer-authenticated ' +
          'admin must re-submit their password. Re-verified server-side ' +
          'against `User.password` (plaintext storage). Wrong / missing / deactivated ' +
          '→ 401 with the generic "Password verification failed" message. Failed attempts are logged ' +
          'at WARN level for security audit.\n\n' +
          '### Pre-flight invariants (return 409 unless `force: true`)\n' +
          '- An OPEN/CLOSED fight exists (active betting)\n' +
          '- A WON bet has not yet been PAID (cash owed)\n' +
          '- A teller has a non-zero running balance (cash unaccounted for)\n\n' +
          'When the wipe is forced, the `forced: true` flag is recorded ' +
          'on the audit row.\n\n' +
          '### Audit\n' +
          'A `SessionReset` row is INSERTed in the same transaction as ' +
          'the TRUNCATE. Counts, performer, timestamp, notes, and the ' +
          '`forced` flag are all preserved permanently — the audit ' +
          'table itself is never wiped.\n\n' +
          '### Side effects\n' +
          'Broadcasts `SESSION_RESET` so every connected kiosk knows to ' +
          'clear local state.',
        operationId: 'sessionPerformReset',
        security,
        body: resetSessionRequestSchema,
        response: {
          ...resetSessionResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request, reply) => {
      let sessionReset
      try {
        sessionReset = await performReset(
          request.server.prisma,
          request.user,
          request.body
        )
      } catch (err) {
        // Surface failed step-up attempts to the security feed. Bearer
        // identity is logged so an admin reviewing logs can see WHO
        // failed the re-auth, not just that some failure occurred.
        if (err?.statusCode === 401) {
          request.log.warn(
            {
              userId: request.user?.id,
              username: request.user?.username,
              path: '/session/reset'
            },
            'Session-reset step-up password verification FAILED'
          )
        }
        throw err
      }

      app.broadcast(buildSessionResetPayload({
        sessionResetId: sessionReset.id,
        performedAt: sessionReset.performedAt,
        performedByUserId: sessionReset.performedByUserId,
        performedByUsername: sessionReset.performedByUsername,
        deletedCounts: {
          fights: sessionReset.fightCount,
          bets: sessionReset.betCount,
          ledger: sessionReset.ledgerCount
        },
        forced: sessionReset.forced
      }))

      request.log.warn(
        {
          sessionResetId: sessionReset.id,
          performedByUserId: sessionReset.performedByUserId,
          fightCount: sessionReset.fightCount,
          betCount: sessionReset.betCount,
          ledgerCount: sessionReset.ledgerCount,
          forced: sessionReset.forced
        },
        'SESSION RESET COMPLETED'
      )

      reply.code(201)
      return { sessionReset }
    }
  )

  // -------------------------------------------------------------------------
  // GET /session/resets — audit log
  // -------------------------------------------------------------------------
  app.get(
    '/resets',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'List past session resets (audit log)',
        description:
          'Cursor-paginated, newest first. Each row carries the counts ' +
          'destroyed by that reset, the performer (with username and full ' +
          'name joined in), notes, and whether it was forced. Survives ' +
          'subsequent resets.',
        operationId: 'sessionListResets',
        security,
        querystring: listSessionResetsQuerySchema,
        response: {
          ...listSessionResetsResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => listResets(request.server.prisma, request.query)
  )

  // -------------------------------------------------------------------------
  // GET /session/sync-status — Supabase backup mirror status
  // -------------------------------------------------------------------------
  app.get(
    '/sync-status',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Supabase sync status (admin)',
        description:
          'Read-only. Shows whether Supabase backup sync is configured, whether ' +
          'Supabase is reachable right now, and the last sync attempt result. ' +
          'Local operations do not depend on Supabase.',
        operationId: 'sessionSupabaseSyncStatus',
        security,
        response: {
          ...supabaseSyncStatusResponseSchema,
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async () => getSupabaseSyncStatus()
  )

  // -------------------------------------------------------------------------
  // POST /session/sync-supabase — push local snapshot to Supabase
  // -------------------------------------------------------------------------
  app.post(
    '/sync-supabase',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Sync local database to Supabase (admin)',
        description:
          'Mirrors the local PostgreSQL database to Supabase when internet is ' +
          'available. Live betting always uses local `DATABASE_URL` — this endpoint ' +
          'is for backup / remote reporting only.\n\n' +
          'Operational tables (`Fight`, `Bet`, `TellerLedger`) are truncated on ' +
          'Supabase first, then repopulated from local so session resets stay aligned.',
        operationId: 'sessionSupabaseSync',
        security,
        response: {
          ...supabaseSyncResponseSchema,
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      try {
        const result = await syncLocalToSupabase()
        request.log.info({ counts: result.counts }, 'Manual Supabase sync completed')
        return result
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        request.log.warn({ err: msg }, 'Manual Supabase sync skipped')
        return { ok: false, message: msg }
      }
    }
  )
}
