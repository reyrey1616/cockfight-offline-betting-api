// Routes for the fights module.
//
// Surface
//   POST   /fights                              admin    create → directly OPEN
//   GET    /fights                              bearer   list
//   GET    /fights/{id}                         bearer   detail
//   POST   /fights/{id}/close                   admin    OPEN|LAST_CALL → CLOSED
//   POST   /fights/{id}/last-call               admin    OPEN      → LAST_CALL
//   POST   /fights/{id}/resume-open             admin    LAST_CALL → OPEN
//   POST   /fights/{id}/reopen                  admin    CLOSED    → OPEN
//   POST   /fights/{id}/settle                  admin    CLOSED    → SETTLED
//   POST   /fights/{id}/unsettle                admin    SETTLED   → CLOSED
//                                                           (closes any live fight first)
//   POST   /fights/{id}/cancel                  admin    OPEN|LAST_CALL|CLOSED → CANCELLED
//   POST   /fights/{id}/correct                 admin    SETTLED   → SETTLED'
//   POST   /fights/{id}/sides/{side}/hold       admin    side → not accepting
//   POST   /fights/{id}/sides/{side}/unhold     admin    side → accepting
//
// Lifecycle note: there is no separate "schedule then open" step. A
// freshly-created fight is immediately OPEN and accepting bets. The
// FightStatus.SCHEDULED enum value still exists for legacy data only.
//
// Every mutating handler emits its WS frame AFTER the service transaction
// commits — same pattern as `placeBet` / `voidBet`. A broadcast failure
// cannot roll back a real state change.

import {
  cancelFight,
  closeFight,
  correctFight,
  createFight,
  resumeFightOpen,
  reopenFight,
  setFightLastCall,
  getFight,
  holdSide,
  listFights,
  settleFight,
  unholdSide,
  unsettleFight
} from './fights.service.js'
import {
  cancelFightRequestSchema,
  correctFightRequestSchema,
  createFightRequestSchema,
  createFightResponseSchema,
  fightActionResponses,
  fightDetailResponseSchema,
  fightIdParamsSchema,
  listFightsQuerySchema,
  listFightsResponseSchema,
  settleFightRequestSchema,
  sideParamsSchema,
  unsettleFightResponseSchema
} from './fights.schemas.js'
import {
  buildFightCancelledPayload,
  buildFightClosedPayload,
  buildFightCorrectedPayload,
  buildFightOpenedPayload,
  buildFightSettledPayload,
  buildFightUnsettledPayload,
  buildSideHeldPayload,
  buildSideUnheldPayload
} from './fights.events.js'
// The Reports module owns the TELLER_COMMISSIONS_UPDATED event because
// the resource it describes (per-teller commission attribution) is a
// reports-module concept. We cross-import the builder here so the
// settle / cancel / correct handlers can signal "realized commission
// changed, dashboards please refetch" alongside their existing
// `FIGHT_*` broadcasts. This mirrors the bets-module pattern of
// importing `buildTellerBalanceUpdatedPayload` from the cash module.
import { buildTellerCommissionsUpdatedPayload } from '../reports/reports.events.js'
import { errorResponses } from '../../lib/api-schemas.js'

const tags = ['Fights']
const security = [{ bearerAuth: [] }]

export default async function fightsRoutes(app) {
  const adminOnly = [app.authenticate, app.requireRole('ADMIN')]
  const anyAuth = [app.authenticate]

  // -------------------------------------------------------------------------
  // POST /fights — create and immediately open
  // -------------------------------------------------------------------------
  app.post(
    '',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Create a new fight (immediately OPEN for betting)',
        description:
          'Admin-only. Creates a new fight already in `OPEN` state, ready ' +
          'to accept bets — there is no separate "schedule then open" step.\n\n' +
          'Inside one transaction:\n' +
          '1. Acquires an advisory lock so two simultaneous creates can\'t ' +
          'race.\n' +
          '2. **Asserts no other fight is currently `OPEN`** — at most one ' +
          'live fight at a time. If another is open, returns 409 with the ' +
          'conflicting fight\'s id and number.\n' +
          '3. Allocates the next sequential `fightNumber` (MAX + 1).\n' +
          '4. Snapshots the current `Setting.commissionRate` onto the fight. ' +
          'Subsequent admin changes to the commission rate do NOT ' +
          'retroactively affect this fight.\n' +
          '5. Stamps `openedAt`.\n\n' +
          'No request body is required.\n\n' +
          'Broadcasts `FIGHT_OPENED` after commit — kiosks treat this as ' +
          '"a new fight is now live, render its placement form".',
        operationId: 'fightsCreate',
        security,
        body: createFightRequestSchema,
        response: {
          ...createFightResponseSchema,
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
      const { fight } = await createFight(request.server.prisma)
      app.broadcast(buildFightOpenedPayload(fight))
      reply.code(201)
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // GET /fights — list
  // -------------------------------------------------------------------------
  app.get(
    '',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'List fights',
        description:
          'Returns fights in descending `fightNumber` order. Filters: ' +
          '`status` (exact), `current=true` (`OPEN`, `LAST_CALL`, `CLOSED`, and `SETTLED` — newest first for kiosk display). ' +
          'Cursor-based pagination — pass `nextCursor` from the ' +
          'previous response as `cursor`.',
        operationId: 'fightsList',
        security,
        querystring: listFightsQuerySchema,
        response: {
          ...listFightsResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => listFights(request.server.prisma, request.query)
  )

  // -------------------------------------------------------------------------
  // GET /fights/:id — detail
  // -------------------------------------------------------------------------
  app.get(
    '/:id',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Get a fight by id',
        description: 'Returns the fight including its derived live odds.',
        operationId: 'fightsGet',
        security,
        params: fightIdParamsSchema,
        response: {
          ...fightDetailResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => getFight(request.server.prisma, request.params.id)
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/close — OPEN → CLOSED
  // -------------------------------------------------------------------------
  app.post(
    '/:id/close',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Close betting on an OPEN fight',
        description:
          'Admin-only. Transitions a fight from `OPEN` to `CLOSED`. Stamps ' +
          '`closedAt`. After this, no new bets are accepted and existing ' +
          'bets can no longer be voided — see the hard rule documented on ' +
          '`POST /bets/{id}/void`.\n\n' +
          'Broadcasts `FIGHT_CLOSED` after commit — this is the single ' +
          'most important frame in the system; every kiosk must lock the ' +
          'placement form on receipt.',
        operationId: 'fightsClose',
        security,
        params: fightIdParamsSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight } = await closeFight(request.server.prisma, request.params.id)
      app.broadcast(buildFightClosedPayload(fight))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/last-call — OPEN → LAST_CALL
  // -------------------------------------------------------------------------
  app.post(
    '/:id/last-call',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Mark an OPEN fight as LAST_CALL',
        operationId: 'fightsLastCall',
        security,
        params: fightIdParamsSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight } = await setFightLastCall(request.server.prisma, request.params.id)
      app.broadcast(buildFightOpenedPayload(fight))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/resume-open — LAST_CALL → OPEN
  // -------------------------------------------------------------------------
  app.post(
    '/:id/resume-open',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Return a LAST_CALL fight to OPEN',
        operationId: 'fightsResumeOpen',
        security,
        params: fightIdParamsSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight } = await resumeFightOpen(request.server.prisma, request.params.id)
      app.broadcast(buildFightOpenedPayload(fight))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/reopen — CLOSED → OPEN
  // -------------------------------------------------------------------------
  app.post(
    '/:id/reopen',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Re-open betting on a CLOSED fight (before settlement)',
        description:
          'Admin-only. Transitions a fight from `CLOSED` back to `OPEN` and ' +
          'clears `closedAt`. Use when betting was closed by mistake before ' +
          'a result was declared.\n\n' +
          'Broadcasts `FIGHT_OPENED` after commit — kiosks unlock the placement ' +
          'form the same way as for a new fight (same `fightId`).',
        operationId: 'fightsReopen',
        security,
        params: fightIdParamsSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight } = await reopenFight(request.server.prisma, request.params.id)
      app.broadcast(buildFightOpenedPayload(fight))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/settle — CLOSED → SETTLED
  // -------------------------------------------------------------------------
  app.post(
    '/:id/settle',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Declare the winner of a CLOSED fight',
        description:
          'Admin-only. Transitions a fight from `CLOSED` to `SETTLED`. ' +
          'In a single transaction:\n\n' +
          '1. Computes the pari-mutuel payout ratios from the frozen pools ' +
          'and the snapshotted commission rate.\n' +
          '2. Walks every bet on the fight:\n' +
          '   - `MERON` / `WALA` outcome → bets on the winning side become ' +
          '`WON` with `payoutAmount = stake × ratio`; the others become ' +
          '`LOST`.\n' +
          '   - `DRAW` outcome → every PENDING bet becomes ' +
          '`REFUNDED` with `payoutAmount = stake`, and a `BET_REFUNDED` ' +
          'ledger entry is appended on each original teller.\n' +
          '   - `VOIDED` bets are untouched.\n' +
          '3. Stamps `settledAt`, `outcome`, and the frozen ratios on the ' +
          'fight.\n\n' +
          'Broadcasts `FIGHT_SETTLED` and `TELLER_COMMISSIONS_UPDATED` ' +
          'after commit. The second frame is a thin signal — admin ' +
          'dashboards refetch `/reports/teller-commissions` with their ' +
          'current filter scope when they see it.',
        operationId: 'fightsSettle',
        security,
        params: fightIdParamsSchema,
        body: settleFightRequestSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight } = await settleFight(
        request.server.prisma,
        request.params.id,
        { outcome: request.body.outcome }
      )
      app.broadcast(buildFightSettledPayload(fight))
      // Realized commission has just changed: every bet on this fight
      // transitioned from PENDING → WON/LOST/PAID (MERON/WALA outcomes)
      // or PENDING → REFUNDED (DRAW). Either way the
      // per-teller commission leaderboard now differs — signal admin
      // dashboards to refetch /reports/teller-commissions.
      app.broadcast(buildTellerCommissionsUpdatedPayload({
        trigger: 'FIGHT_SETTLED',
        fightId: fight.id,
        fightNumber: fight.fightNumber
      }))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/unsettle — SETTLED → CLOSED (revert wrong declaration)
  // -------------------------------------------------------------------------
  app.post(
    '/:id/unsettle',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Unsettle a fight (revert result to CLOSED)',
        description:
          'Admin-only. Transitions a fight from `SETTLED` back to `CLOSED` ' +
          '(betting stays locked) so a new winner can be declared. ' +
          'Any other `OPEN` / `LAST_CALL` fight is closed first. Clears outcome, ' +
          'payout ratios, and `settledAt`. Resets `WON` / `LOST` / `PENDING_REFUND` ' +
          'bets to `PENDING` with cleared payout amounts. `VOIDED` bets are untouched.\n\n' +
          '**Blocked** if any bet on the fight is `PAID` or `REFUNDED` ' +
          '(cash has already left the drawer).\n\n' +
          'Broadcasts `FIGHT_CLOSED` (for any live fight that was closed), ' +
          '`FIGHT_UNSETTLED`, and `TELLER_COMMISSIONS_UPDATED` after commit.',
        operationId: 'fightsUnsettle',
        security,
        params: fightIdParamsSchema,
        response: {
          ...unsettleFightResponseSchema,
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight, closedFights, summary } = await unsettleFight(
        request.server.prisma,
        request.params.id
      )
      for (const closed of closedFights) {
        app.broadcast(buildFightClosedPayload(closed))
      }
      app.broadcast(buildFightUnsettledPayload(fight))
      app.broadcast(
        buildTellerCommissionsUpdatedPayload({
          trigger: 'FIGHT_UNSETTLED',
          fightId: fight.id,
          fightNumber: fight.fightNumber
        })
      )
      return { fight, summary }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/cancel — any non-terminal → CANCELLED
  // -------------------------------------------------------------------------
  app.post(
    '/:id/cancel',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Cancel a fight and refund all bets',
        description:
          'Admin-only. Transitions a fight in `SCHEDULED`, `OPEN` or ' +
          '`CLOSED` to `CANCELLED`. Every PENDING bet becomes `REFUNDED` ' +
          'with `payoutAmount = stake` and a `BET_REFUNDED` ledger entry ' +
          'is appended on the original teller. `VOIDED` bets are untouched.\n\n' +
          'The optional `reason` is logged at request level and included ' +
          'in the ledger entry `notes` for audit traceability.\n\n' +
          'Broadcasts `FIGHT_CANCELLED` and `TELLER_COMMISSIONS_UPDATED` ' +
          'after commit. The second frame is a thin signal — admin ' +
          'dashboards refetch `/reports/teller-commissions` with their ' +
          'current filter scope when they see it (refunded bets stop ' +
          'counting toward commission).',
        operationId: 'fightsCancel',
        security,
        params: fightIdParamsSchema,
        body: cancelFightRequestSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const reason = request.body?.reason ?? null
      request.log.info(
        { fightId: request.params.id, actor: request.user.id, reason },
        'fight.cancel requested'
      )
      const { fight } = await cancelFight(
        request.server.prisma,
        request.params.id,
        { reason }
      )
      app.broadcast(buildFightCancelledPayload(fight))
      // Cancelling a fight refunds every PENDING bet (status →
      // REFUNDED), which means those bets stop counting toward
      // commission. If the fight was previously settled (which
      // /cancel does NOT allow today, but defensive coding) the
      // recompute would still reflect the actual current state.
      app.broadcast(buildTellerCommissionsUpdatedPayload({
        trigger: 'FIGHT_CANCELLED',
        fightId: fight.id,
        fightNumber: fight.fightNumber
      }))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/correct — SETTLED → SETTLED'
  // -------------------------------------------------------------------------
  app.post(
    '/:id/correct',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Correct a previously-declared winner',
        description:
          'Admin-only. The fight stays in `SETTLED` — correction is the ' +
          'audit, not a separate state. The new outcome MUST differ from ' +
          'the current outcome.\n\n' +
          '### What changes inside the transaction\n' +
          '- New payout ratios are computed from the (still-frozen) pools.\n' +
          '- Every bet is re-evaluated against the new outcome:\n' +
          '  - `VOIDED` bets are sticky → no change.\n' +
          '  - `PAID` bets keep `status = PAID` (physical cash is already ' +
          'out) but record `previousPayoutAmount`, set the new "should-' +
          'have-been" `payoutAmount`, and stamp `correctedAt`. Operator ' +
          'absorbs the over/underpay — the operator-loss report is ' +
          'derived from these snapshots.\n' +
          '  - All other bets flip to the new target status, snapshotting ' +
          '`previousStatus` and `previousPayoutAmount`.\n' +
          '- Bets that newly become `REFUNDED` get a `BET_REFUNDED` ledger ' +
          'entry. Status flips that do not move cash (e.g. `WON → LOST`) ' +
          'do not.\n' +
          '- Fight stamps `correctedAt`, `correctedByUserId`, ' +
          '`correctionReason`, plus the previous-outcome / ratio audit.\n\n' +
          'Broadcasts `FIGHT_CORRECTED` and `TELLER_COMMISSIONS_UPDATED` ' +
          'after commit. The second frame is a thin signal — admin ' +
          'dashboards refetch `/reports/teller-commissions` with their ' +
          'current filter scope when they see it. MERON↔WALA corrections ' +
          'do NOT change commission totals (same stakes × same rate) but ' +
          'the frame still fires so per-teller winning/losing breakdowns ' +
          'refresh; MERON↔DRAW corrections DO change totals.',
        operationId: 'fightsCorrect',
        security,
        params: fightIdParamsSchema,
        body: correctFightRequestSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight } = await correctFight(
        request.server.prisma,
        request.user,
        request.params.id,
        { outcome: request.body.outcome, reason: request.body.reason }
      )
      app.broadcast(buildFightCorrectedPayload(fight))
      // Correcting a fight can swing bets between WON / LOST / REFUNDED,
      // and a MERON↔WALA correction does NOT change commission (same
      // stakes × same rate) but a MERON↔DRAW correction DOES (some
      // bets stop counting). Cheaper to always emit the signal than
      // to compute the delta — the dashboard's refetch is idempotent.
      app.broadcast(buildTellerCommissionsUpdatedPayload({
        trigger: 'FIGHT_CORRECTED',
        fightId: fight.id,
        fightNumber: fight.fightNumber
      }))
      return { fight }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/sides/:side/hold
  // -------------------------------------------------------------------------
  app.post(
    '/:id/sides/:side/hold',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Hold (stop accepting bets on) one side of a fight',
        description:
          'Admin-only. Sets `<side>AcceptingBets=false`, stamps the held-at ' +
          'timestamp and the acting user. Valid only while the fight is ' +
          '`OPEN`.\n\n' +
          'Idempotent — calling on an already-held side returns ' +
          '`replay: true` and does not write to the database.\n\n' +
          'Broadcasts `SIDE_HELD` after a fresh commit (no broadcast on ' +
          'replay — nothing changed).',
        operationId: 'fightsHoldSide',
        security,
        params: sideParamsSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight, replay } = await holdSide(
        request.server.prisma,
        request.user,
        request.params.id,
        request.params.side
      )
      if (!replay) app.broadcast(buildSideHeldPayload(fight, request.params.side))
      return { fight, replay }
    }
  )

  // -------------------------------------------------------------------------
  // POST /fights/:id/sides/:side/unhold
  // -------------------------------------------------------------------------
  app.post(
    '/:id/sides/:side/unhold',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Resume accepting bets on a previously-held side',
        description:
          'Admin-only. Sets `<side>AcceptingBets=true` and clears the ' +
          'held-at / held-by audit fields. Valid only while the fight is ' +
          '`OPEN`.\n\n' +
          'Idempotent — calling on an already-accepting side returns ' +
          '`replay: true` and does not write to the database.\n\n' +
          'Broadcasts `SIDE_UNHELD` after a fresh commit.',
        operationId: 'fightsUnholdSide',
        security,
        params: sideParamsSchema,
        response: {
          ...fightActionResponses,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { fight, replay } = await unholdSide(
        request.server.prisma,
        request.user,
        request.params.id,
        request.params.side
      )
      if (!replay) app.broadcast(buildSideUnheldPayload(fight, request.params.side))
      return { fight, replay }
    }
  )
}
