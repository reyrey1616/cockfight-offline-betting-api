// Routes for the settings module.
//
// Surface
//   GET    /settings                  bearer   read the singleton
//   PATCH  /settings                  admin    update commission rate (audit-logged)
//   GET    /settings/admin-void-barcode admin  admin password for void barcode
//
// No WebSocket broadcast on PATCH. Settings changes do NOT take effect on
// any currently-OPEN fight — each fight snapshotted its rate at creation,
// so there's nothing time-critical for kiosks to react to. The admin UI
// can fetch on demand.

import { getAdminVoidBarcode, getSetting, updateSetting } from './settings.service.js'
import {
  adminVoidBarcodeResponseSchema,
  getSettingsResponseSchema,
  updateSettingsRequestSchema,
  updateSettingsResponseSchema
} from './settings.schemas.js'
import { errorResponses } from '../../lib/api-schemas.js'

const tags = ['Settings']
const security = [{ bearerAuth: [] }]

export default async function settingsRoutes(app) {
  const adminOnly = [app.authenticate, app.requireRole('ADMIN')]
  const anyAuth = [app.authenticate]

  // -------------------------------------------------------------------------
  // GET /settings
  // -------------------------------------------------------------------------
  app.get(
    '',
    {
      preHandler: anyAuth,
      schema: {
        tags,
        summary: 'Read the current system settings',
        description:
          'Returns the singleton `Setting` row. The only field today is ' +
          '`commissionRate`. Available to any authenticated user — tellers ' +
          'need to display the current rate, admins need it to set up ' +
          'the next adjustment.',
        operationId: 'settingsGet',
        security,
        response: {
          ...getSettingsResponseSchema,
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => ({ setting: await getSetting(request.server.prisma) })
  )

  // -------------------------------------------------------------------------
  // PATCH /settings
  // -------------------------------------------------------------------------
  app.patch(
    '',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Update the commission rate',
        description:
          'Admin-only. Updates `commissionRate` (range 0.0000–0.3000). The ' +
          'new rate is snapshotted onto **future** fights at creation time. ' +
          'Existing fights keep the rate they were created with — there is ' +
          'no retroactive change to in-flight or already-settled payouts.\n\n' +
          'A successful change is recorded in the server log with the ' +
          'admin\'s user id and the before/after values for audit. There is ' +
          'no dedicated audit table; the request log is the source of ' +
          'truth.\n\n' +
          'No WebSocket frame is emitted — settings changes are not ' +
          'time-critical for kiosks (each fight uses its own snapshot).',
        operationId: 'settingsUpdate',
        security,
        body: updateSettingsRequestSchema,
        response: {
          ...updateSettingsResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { before, after, changed } = await updateSetting(
        request.server.prisma,
        { commissionRate: request.body.commissionRate }
      )

      if (changed) {
        request.log.info(
          {
            actor: request.user.id,
            actorUsername: request.user.username,
            field: 'commissionRate',
            before: before.commissionRate,
            after: after.commissionRate
          },
          'settings.commissionRate changed'
        )
      }

      return { setting: after }
    }
  )

  // -------------------------------------------------------------------------
  // GET /settings/admin-void-barcode
  // -------------------------------------------------------------------------
  app.get(
    '/admin-void-barcode',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Admin void authorization barcode payload',
        description:
          'Admin-only. Returns the logged-in admin\'s plaintext login password ' +
          'so the settings UI can render a CODE128 barcode for teller void ' +
          'authorization. Passwords are stored plaintext in this deployment.',
        operationId: 'settingsAdminVoidBarcode',
        security,
        response: {
          ...adminVoidBarcodeResponseSchema,
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => getAdminVoidBarcode(request.server.prisma, request.user.id)
  )
}
