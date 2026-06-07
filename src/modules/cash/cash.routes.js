// Routes for the cash module.
//
// Surface
//   POST   /cash/advances           admin    record collector → teller cash handoff
//   POST   /cash/remits             bearer   record teller → collector handback
//   GET    /cash/balance            bearer   running balance (own, or any if admin)
//   GET    /cash/ledger             bearer   filterable ledger list (own, or any if admin)
//   GET    /cash/ledger/code/{code} bearer   scan-by-barcode (own, or any if admin)
//
// Every mutating handler emits TELLER_BALANCE_UPDATED on commit so admin
// dashboards stay live without polling. The HTTP response carries
// `actorBalance` for the kiosk that triggered the change to self-update
// without a WS round-trip.

import {
  cashAdvance,
  cashRemit,
  getBalance,
  getLedgerEntryByCode,
  listLedger,
  projectLedgerEntry
} from './cash.service.js'
import {
  cashAdvanceRequestSchema,
  cashAdvanceResponseSchema,
  cashBalanceQuerySchema,
  cashBalanceResponseSchema,
  cashLedgerCodeParamsSchema,
  cashLedgerQuerySchema,
  cashLedgerResponseSchema,
  cashRemitRequestSchema,
  cashRemitResponseSchema,
  getLedgerEntryByCodeResponseSchema
} from './cash.schemas.js'
import { buildTellerBalanceUpdatedPayload } from './cash.events.js'
import { errorResponses } from '../../lib/api-schemas.js'

const tags = ['Cash']
const security = [{ bearerAuth: [] }]

export default async function cashRoutes(app) {
  const anyAuth = [app.authenticate]

  // -------------------------------------------------------------------------
  // POST /cash/advances
  // -------------------------------------------------------------------------
  app.post(
    '/advances',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Record a cash deposit from a collector to a teller drawer',
        description:
          'Inserts a `CASH_ADVANCE` (positive) ledger row on the recipient teller. ' +
          'ADMIN may pass `tellerId` for any active teller; TELLER records on their own drawer only. ' +
          'Identifies the collector via scanned `collectorCode` (badge barcode). Validates that the recipient is an ' +
          'active TELLER (admins cannot receive advances) and that the ' +
          'collector is active.\n\n' +
          'Returns the new ledger row plus `actorBalance` — the ' +
          'recipient teller\'s NEW balance (not the admin\'s, since the ' +
          'admin is just the recorder).\n\n' +
          'Broadcasts `TELLER_BALANCE_UPDATED` after commit so the ' +
          'recipient\'s kiosk and the admin dashboard both update live.',
        operationId: 'cashAdvance',
        security,
        body: cashAdvanceRequestSchema,
        response: {
          ...cashAdvanceResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          408: errorResponses[408],
          500: errorResponses[500]
        }
      }
    },
    async (request, reply) => {
      const { ledgerEntry, balance, teller } = await cashAdvance(
        request.server.prisma,
        request.user,
        request.body
      )
      app.broadcast(buildTellerBalanceUpdatedPayload({
        tellerId: teller.id,
        tellerName: teller.fullName,
        balance,
        delta: { type: 'CASH_ADVANCE', amount: ledgerEntry.amount.toFixed(2) }
      }))
      reply.code(201)
      return {
        ledgerEntry: projectLedgerEntry(ledgerEntry),
        actorBalance: balance
      }
    }
  )

  // -------------------------------------------------------------------------
  // POST /cash/remits
  // -------------------------------------------------------------------------
  app.post(
    '/remits',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Record a cash remit to a collector',
        description:
          'Records a `REMIT` (negative) ledger row on the requesting ' +
          'user. Identifies the collector via scanned `collectorCode`. Typically called by tellers at end of shift; admins can ' +
          'call it too if they have ledger entries on themselves to ' +
          'square up.\n\n' +
          '### Hard invariant: balance cannot go negative\n' +
          'Enforced via a post-write SUM check inside the transaction. ' +
          'If the requested amount exceeds the current balance, returns ' +
          '409 with `currentBalanceBeforeRemit`, `requestedAmount`, and ' +
          '`shortfall` in `details`. Admin should investigate any cash ' +
          'discrepancy out-of-band rather than the system papering over ' +
          'it.\n\n' +
          'Broadcasts `TELLER_BALANCE_UPDATED` after commit.',
        operationId: 'cashRemit',
        security,
        body: cashRemitRequestSchema,
        response: {
          ...cashRemitResponseSchema,
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
      const { ledgerEntry, balance, teller } = await cashRemit(
        request.server.prisma,
        request.user,
        request.body
      )
      app.broadcast(buildTellerBalanceUpdatedPayload({
        tellerId: teller.id,
        tellerName: teller.fullName,
        balance,
        delta: { type: 'REMIT', amount: ledgerEntry.amount.toFixed(2) }
      }))
      reply.code(201)
      return {
        ledgerEntry: projectLedgerEntry(ledgerEntry),
        actorBalance: balance
      }
    }
  )

  // -------------------------------------------------------------------------
  // GET /cash/balance
  // -------------------------------------------------------------------------
  app.get(
    '/balance',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Read a teller\'s running cash balance',
        description:
          'Defaults to the requesting user\'s own balance. Admins can ' +
          'pass `?tellerId=` to inspect any user; tellers passing a ' +
          'different id get 403.',
        operationId: 'cashBalance',
        security,
        querystring: cashBalanceQuerySchema,
        response: {
          ...cashBalanceResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => getBalance(request.server.prisma, request.user, request.query)
  )

  // -------------------------------------------------------------------------
  // GET /cash/ledger/code/:code  — scan-by-barcode lookup
  //
  // Declared BEFORE /cash/ledger (the list endpoint) so the static
  // "code" segment is matched first.
  // -------------------------------------------------------------------------
  app.get(
    '/ledger/code/:code',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Look up a ledger entry by its scannable barcode',
        description:
          'Resolves the 8-char "ADV…" / "REM…" code printed on a cash ' +
          'advance or remit receipt. Used to pull the original transaction ' +
          'when an admin needs to verify a slip or reprint it.\n\n' +
          'Same scoping as the rest of the cash surface: tellers can only ' +
          'fetch a row whose `tellerId` matches their own — cross-teller ' +
          'lookups return 404 (not 403) so a teller can\'t enumerate ' +
          'other tellers\' codes by guessing.',
        operationId: 'cashGetLedgerEntryByCode',
        security,
        params: cashLedgerCodeParamsSchema,
        response: {
          ...getLedgerEntryByCodeResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const row = await getLedgerEntryByCode(
        request.server.prisma,
        request.user,
        request.params.code
      )
      return { ledgerEntry: projectLedgerEntry(row) }
    }
  )

  // -------------------------------------------------------------------------
  // GET /cash/ledger
  // -------------------------------------------------------------------------
  app.get(
    '/ledger',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'List ledger entries with filters',
        description:
          'Cursor-paginated, descending by `createdAt`. Filters: ' +
          '`tellerId`, `type`, `since`, `until`. Tellers are hard-scoped ' +
          'to their own entries — passing another teller\'s id returns ' +
          '403. Admins can pass any tellerId or omit for system-wide ' +
          'view.',
        operationId: 'cashLedger',
        security,
        querystring: cashLedgerQuerySchema,
        response: {
          ...cashLedgerResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => listLedger(request.server.prisma, request.user, request.query)
  )
}
