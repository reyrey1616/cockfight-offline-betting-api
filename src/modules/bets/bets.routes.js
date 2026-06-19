// Routes for the bets module.
//
// Surface:
//   POST   /bets              place a bet (teller)
//   GET    /bets              list bets, paginated (any auth — scope enforced)
//   GET    /bets/{id}         single bet by id (any auth — scope enforced)
//   GET    /bets/code/{code}  single bet by public ticket code (any auth)
//   POST   /bets/{id}/void    void a PENDING bet while its fight is OPEN
//   POST   /bets/{id}/pay     pay out WON or pending-refund bet (any auth — cashier window)
//
// Errors are mapped by the global error-handler plugin:
//   NotFound → 404, Forbidden → 403, Conflict → 409,
//   RequestTimeout → 408, others → 500.

import {
  getBet,
  getBetByCode,
  listBets,
  payBet,
  placeBet,
  voidBet
} from './bets.service.js'
import {
  betCodeParamsSchema,
  betDetailResponseSchema,
  betIdParamsSchema,
  listBetsQuerySchema,
  listBetsResponseSchema,
  payBetResponseSchema,
  placeBetRequestSchema,
  placeBetResponseSchema,
  voidBetRequestSchema,
  voidBetResponseSchema
} from './bets.schemas.js'
// `ODDS_UPDATE` is a fight-owned event (it describes a Fight's pool state),
// so its builder lives in the fights module. `TELLER_BALANCE_UPDATED` is
// a cash-owned event (a teller's running balance is a cash concept), so
// its builder lives in the cash module. The bets module just imports
// both to fan out after a placement / void / payout.
import { buildOddsUpdatePayload } from '../fights/fights.events.js'
import { buildTellerBalanceUpdatedPayload } from '../cash/cash.events.js'
import { errorResponses } from '../../lib/api-schemas.js'

const tags = ['Bets']
const security = [{ bearerAuth: [] }]

export default async function betsRoutes(app) {
  // -------------------------------------------------------------------------
  // POST /bets — place a new bet (teller-only)
  // -------------------------------------------------------------------------
  app.post(
    '',
    {
      preHandler: [app.authenticate, app.requireRole('TELLER')],
      schema: {
        tags,
        summary: 'Place a bet on an OPEN fight',
        description:
          'Teller-only. Atomic transaction: creates the Bet, appends a ' +
          '`BET_PLACED` TellerLedger entry, and increments the relevant pool ' +
          '(meronPool or walaPool) on the Fight — all or nothing.\n\n' +
          '### Idempotency\n' +
          '`clientRequestId` is a unique key per logical placement. Retry the ' +
          'same request with the same id to get the original result back as a ' +
          '`200` with `replay: true`. A fresh placement returns `201`.\n\n' +
          '### Validation flow\n' +
          '1. Schema validates the body (400 on bad shape).\n' +
          '2. Auth middleware verifies the JWT and TELLER role (401 / 403).\n' +
          '3. Inside the row-locked transaction, fight must exist (404), be ' +
          'OPEN (409), and the chosen side must be accepting bets (409).\n' +
          '4. Transaction has a 5 s timeout; exceeding it returns 408 ' +
          '"System busy, please retry" — caller should retry with the SAME ' +
          'clientRequestId.\n\n' +
          '### Side effects\n' +
          'After commit, an `ODDS_UPDATE` frame is broadcast on `GET /ws` to ' +
          'every connected client. The broadcast happens out-of-transaction; ' +
          'a WS failure cannot roll back a committed bet.',
        operationId: 'betsPlace',
        security,
        body: placeBetRequestSchema,
        response: {
          ...placeBetResponseSchema,
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
    async (request, reply) => {
      const { clientRequestId, fightId, side, amount } = request.body

      const result = await placeBet(request.server.prisma, {
        clientRequestId,
        fightId,
        side,
        amount,
        teller: request.user
      })

      // Broadcasts only fire on a fresh placement. On replay, the
      // original placement already broadcast everything; re-firing would
      // just create duplicate frames (and a duplicate "balance moved"
      // animation on the admin dashboard).
      if (!result.replay) {
        app.broadcast(buildOddsUpdatePayload({
          fightId: result.fight.id,
          meronPool: result.fight.meronPool,
          walaPool: result.fight.walaPool,
          meronOdds: result.fight.meronOdds,
          walaOdds: result.fight.walaOdds
        }))
        if (result.balanceBroadcast) {
          app.broadcast(buildTellerBalanceUpdatedPayload({
            ...result.balanceBroadcast,
            balance: result.actorBalance
          }))
        }
        request.log.info(
          { fightId: result.fight.id, betId: result.bet.id },
          'placeBet → ODDS_UPDATE + TELLER_BALANCE_UPDATED'
        )
      }

      reply.code(result.replay ? 200 : 201)
      return result.replay
        ? { bet: result.bet, fight: result.fight, replay: true, actorBalance: result.actorBalance }
        : { bet: result.bet, fight: result.fight, actorBalance: result.actorBalance }
    }
  )

  // -------------------------------------------------------------------------
  // GET /bets — paginated list with filters
  // -------------------------------------------------------------------------
  app.get(
    '',
    {
      preHandler: [app.authenticate],
      schema: {
        tags,
        summary: 'List bets',
        description:
          'Returns bets in newest-first order. Tellers see only their own ' +
          'bets — if a teller specifies a `tellerId` query parameter that ' +
          'is not their own, the request is rejected with 403. Admins may ' +
          'filter by any teller.\n\n' +
          '### Pagination\n' +
          'Cursor-based: pass the `nextCursor` from the previous response ' +
          'as `cursor` to fetch the next page. `nextCursor` is `null` when ' +
          'the result is exhausted.',
        operationId: 'betsList',
        security,
        querystring: listBetsQuerySchema,
        response: {
          ...listBetsResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      return listBets(request.server.prisma, request.user, request.query)
    }
  )

  // -------------------------------------------------------------------------
  // GET /bets/code/:code — lookup by public ticket code (cashier path)
  //
  // Declared BEFORE /bets/:id so the static "code" segment is visible
  // first. Fastify's router would actually disambiguate either way, but
  // the explicit order is friendlier to readers.
  // -------------------------------------------------------------------------
  app.get(
    '/code/:code',
    {
      preHandler: [app.authenticate],
      schema: {
        tags,
        summary: 'Look up a bet by its public ticket code',
        description:
          'Redemption-counter lookup. Any authenticated user can resolve any ' +
          'ticket code — the cashier scenario assumes the customer brings ' +
          'their slip to whoever is available. Use the returned `status` and ' +
          '`payoutAmount` to decide what action follows: `WON` or `PENDING_REFUND` → ' +
          'eligible for `POST /bets/{id}/pay`, `LOST` → no action, `REFUNDED` / `PAID` → ' +
          'already settled at payout desk.',
        operationId: 'betsGetByCode',
        security,
        params: betCodeParamsSchema,
        response: {
          ...betDetailResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      return getBetByCode(request.server.prisma, request.params.code)
    }
  )

  // -------------------------------------------------------------------------
  // GET /bets/:id — single bet detail
  // -------------------------------------------------------------------------
  app.get(
    '/:id',
    {
      preHandler: [app.authenticate],
      schema: {
        tags,
        summary: 'Get a bet by id',
        description:
          'Returns the bet (with its fight summary). Tellers may only read ' +
          'their own bets; admins may read any. For ticket-code lookup at ' +
          'the redemption window, use `GET /bets/code/{code}` instead — ' +
          'that path is intentionally permissive across users.',
        operationId: 'betsGet',
        security,
        params: betIdParamsSchema,
        response: {
          ...betDetailResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      return getBet(request.server.prisma, request.user, request.params.id)
    }
  )

  // -------------------------------------------------------------------------
  // POST /bets/:id/void — void a PENDING bet (fight must still be OPEN)
  // -------------------------------------------------------------------------
  app.post(
    '/:id/void',
    {
      preHandler: [app.authenticate],
      schema: {
        tags,
        summary: 'Void a PENDING bet',
        description:
          'Voids a bet, atomically: status → `VOIDED`, pool is decremented, ' +
          'and a negative `BET_VOIDED` TellerLedger entry is appended on ' +
          'the **original** teller (cash returns from the same drawer it ' +
          'entered).\n\n' +
          '### Hard rule\n' +
          '**A bet can only be voided while its parent fight is `OPEN` or ' +
          '`LAST_CALL`.** Once betting closes (`CLOSED`), and for every ' +
          'state after (`SETTLED`, `CANCELLED`), this endpoint returns ' +
          '**409**. This check is re-validated *inside* the row-locked ' +
          'transaction.\n\n' +
          '### Step-up authorization\n' +
          'Body must include `adminPassword` — the fixed void authorization secret ' +
          'scanned from the admin void barcode. Wrong value returns **403** ' +
          '(does not invalidate the teller JWT).\n\n' +
          '### Authorization\n' +
          'The original teller who took the bet, or any admin. A different ' +
          'teller trying to void someone else\'s ticket gets a 403.\n\n' +
          '### Idempotency\n' +
          'Voiding an already-`VOIDED` bet returns the existing record with ' +
          '`replay: true` (200), not a 409. Safe to retry blindly.\n\n' +
          '### Side effects\n' +
          'On a fresh void, an `ODDS_UPDATE` frame is broadcast on `/ws` ' +
          'because the pool changed.',
        operationId: 'betsVoid',
        security,
        params: betIdParamsSchema,
        body: voidBetRequestSchema,
        response: {
          ...voidBetResponseSchema,
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
      const result = await voidBet(
        request.server.prisma,
        request.user,
        request.params.id,
        request.body ?? {}
      )

      if (!result.replay) {
        app.broadcast(buildOddsUpdatePayload({
          fightId: result.fight.id,
          meronPool: result.fight.meronPool,
          walaPool: result.fight.walaPool,
          meronOdds: result.fight.meronOdds,
          walaOdds: result.fight.walaOdds
        }))
        if (result.balanceBroadcast) {
          app.broadcast(buildTellerBalanceUpdatedPayload({
            ...result.balanceBroadcast,
            balance: result.actorBalance
          }))
        }
        request.log.info(
          { fightId: result.fight.id, betId: result.bet.id },
          'voidBet → ODDS_UPDATE + TELLER_BALANCE_UPDATED'
        )
      }

      return {
        bet: result.bet,
        fight: result.fight,
        replay: result.replay,
        actorBalance: result.actorBalance
      }
    }
  )

  // -------------------------------------------------------------------------
  // POST /bets/:id/pay — redeem a WON bet or pay a draw/cancel refund
  // -------------------------------------------------------------------------
  app.post(
    '/:id/pay',
    {
      preHandler: [app.authenticate],
      schema: {
        tags,
        summary: 'Pay out a winning bet or refund',
        description:
          'Cashier action. Marks a `WON` bet as `PAID` or a `PENDING_REFUND` bet as ' +
          '`REFUNDED`, stamps `paidAt` and `paidByUserId`, and appends a negative ' +
          '`PAYOUT` or `BET_REFUNDED` TellerLedger entry on the paying teller.\n\n' +
          '### Authorization\n' +
          'Only the teller who originally took the ticket can pay it out. ' +
          'If scanned by another teller, this endpoint returns 403 with ' +
          '"This ticket is not bet on this teller.".\n\n' +
          '### Idempotency\n' +
          'Paying an already-`PAID` or already-`REFUNDED` bet returns the existing record with ' +
          '`replay: true` (200). Concurrent pay calls are race-safe via a ' +
          'row-level lock on the bet.',
        operationId: 'betsPay',
        security,
        params: betIdParamsSchema,
        response: {
          ...payBetResponseSchema,
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
      const result = await payBet(request.server.prisma, request.user, request.params.id)

      if (!result.replay && result.balanceBroadcast) {
        app.broadcast(buildTellerBalanceUpdatedPayload({
          ...result.balanceBroadcast,
          balance: result.actorBalance
        }))
        request.log.info(
          { betId: result.bet.id, paidByUserId: request.user.id },
          'payBet → TELLER_BALANCE_UPDATED'
        )
      }

      return {
        bet: result.bet,
        fight: result.fight,
        replay: result.replay,
        actorBalance: result.actorBalance
      }
    }
  )
}
