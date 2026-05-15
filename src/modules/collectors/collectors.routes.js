// Routes for the collectors module.
//
// Surface
//   POST   /collectors            admin   create (auto-issues a barcode)
//   GET    /collectors            bearer  list (optional ?isActive filter)
//   GET    /collectors/code/{code} bearer scan-by-barcode lookup
//   GET    /collectors/{id}       bearer  detail
//   PATCH  /collectors/{id}       admin   rename + soft-delete + reactivate
//
// There is no DELETE endpoint by design. A Collector with any
// TellerLedger reference (CASH_ADVANCE / REMIT) is FK-pinned and could
// not be hard-deleted anyway; retire via PATCH `{ isActive: false }`.

import {
  createCollector,
  getCollector,
  getCollectorByCode,
  listCollectors,
  updateCollector
} from './collectors.service.js'
import {
  collectorCodeParamsSchema,
  collectorIdParamsSchema,
  createCollectorRequestSchema,
  createCollectorResponseSchema,
  getCollectorByCodeResponseSchema,
  getCollectorResponseSchema,
  listCollectorsQuerySchema,
  listCollectorsResponseSchema,
  updateCollectorRequestSchema,
  updateCollectorResponseSchema
} from './collectors.schemas.js'
import { errorResponses } from '../../lib/api-schemas.js'

const tags = ['Collectors']
const security = [{ bearerAuth: [] }]

export default async function collectorsRoutes(app) {
  const adminOnly = [app.authenticate, app.requireRole('ADMIN')]
  const anyAuth = [app.authenticate]

  // -------------------------------------------------------------------------
  // POST /collectors
  // -------------------------------------------------------------------------
  app.post(
    '',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Create a collector (auto-issues a scannable barcode)',
        description:
          'Admin-only. Creates a managed collector label used on cash ' +
          'advance / remit slips. Names are normalized server-side ' +
          '(trim + collapse internal whitespace) and unique ' +
          '(case-sensitive). Duplicates return 409.\n\n' +
          'Each new collector is issued a public 8-char barcode (`code`, ' +
          'format `"COL" + 5 reduced-alphabet chars`) printed on their ' +
          'badge / wristband. Scan it via `GET /collectors/code/{code}` ' +
          'to autofill `collectorId` on cash workflow forms. Codes are ' +
          'never re-issued.',
        operationId: 'collectorsCreate',
        security,
        body: createCollectorRequestSchema,
        response: {
          ...createCollectorResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request, reply) => {
      const collector = await createCollector(
        request.server.prisma,
        { name: request.body.name }
      )
      reply.code(201)
      return { collector }
    }
  )

  // -------------------------------------------------------------------------
  // GET /collectors
  // -------------------------------------------------------------------------
  app.get(
    '',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'List collectors',
        description:
          'Returns all collectors. Optional `isActive` query filters to the ' +
          'active set (use this for teller remit dropdowns). Active ' +
          'collectors are listed first, then retired ones, both sorted ' +
          'alphabetically.',
        operationId: 'collectorsList',
        security,
        querystring: listCollectorsQuerySchema,
        response: {
          ...listCollectorsResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => ({
      collectors: await listCollectors(request.server.prisma, request.query)
    })
  )

  // -------------------------------------------------------------------------
  // GET /collectors/code/:code  — scan-by-barcode lookup
  //
  // Declared BEFORE /collectors/:id so the static "code" segment is
  // matched first. Fastify's router would actually disambiguate either
  // way, but explicit ordering is friendlier to readers.
  // -------------------------------------------------------------------------
  app.get(
    '/code/:code',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Look up a collector by their scannable barcode',
        description:
          'Resolves the 8-char "COL…" barcode printed on a collector\'s ' +
          'badge / wristband. Used by the cash-advance and remit forms ' +
          'to autofill `collectorId` from a single scan.\n\n' +
          'Returns the collector even when retired (`isActive=false`) so ' +
          'the UI can explain *why* a scan won\'t be accepted instead of ' +
          'pretending the badge doesn\'t exist. The downstream ' +
          'advance/remit endpoints still reject inactive collectors.',
        operationId: 'collectorsGetByCode',
        security,
        params: collectorCodeParamsSchema,
        response: {
          ...getCollectorByCodeResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => ({
      collector: await getCollectorByCode(request.server.prisma, request.params.code)
    })
  )

  // -------------------------------------------------------------------------
  // GET /collectors/:id
  // -------------------------------------------------------------------------
  app.get(
    '/:id',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Get a collector by id',
        operationId: 'collectorsGet',
        security,
        params: collectorIdParamsSchema,
        response: {
          ...getCollectorResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => ({
      collector: await getCollector(request.server.prisma, request.params.id)
    })
  )

  // -------------------------------------------------------------------------
  // PATCH /collectors/:id
  // -------------------------------------------------------------------------
  app.patch(
    '/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Rename or retire/reactivate a collector',
        description:
          'Admin-only. Pass `name` to rename (with the same uniqueness rule ' +
          'as create), `isActive` to retire (`false`) or reactivate (`true`), ' +
          'or both. Empty body is a legal no-op and returns the current ' +
          'row unchanged.\n\n' +
          'There is intentionally no DELETE — retired collectors keep their ' +
          'history intact and can be reactivated later.',
        operationId: 'collectorsUpdate',
        security,
        params: collectorIdParamsSchema,
        body: updateCollectorRequestSchema,
        response: {
          ...updateCollectorResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request) => ({
      collector: await updateCollector(
        request.server.prisma,
        request.params.id,
        request.body ?? {}
      )
    })
  )
}
