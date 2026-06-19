import { adminUser } from '../../lib/user-mapper.js'
import {
  createUser,
  getUser,
  getTellerLoginBarcode,
  listUsers,
  resetPassword,
  updateUser
} from './users.service.js'
import {
  createUserRequestSchema,
  createUserResponseSchema,
  listUsersQuerySchema,
  listUsersResponseSchema,
  okResponseSchema,
  resetPasswordRequestSchema,
  tellerLoginBarcodeResponseSchema,
  updateUserRequestSchema,
  userIdParamsSchema,
  userResponseSchema
} from './users.schemas.js'
import { errorResponses } from '../../lib/api-schemas.js'

// User management routes. Mounted under /users in server.js.
//
// All endpoints require ADMIN role. Tellers manage their own profile
// (read-only) via the /auth/me endpoint, not here.
//
// Senior-level rules enforced here:
//   - username and role are immutable post-creation (changing them breaks
//     audit references on Bets and historical TellerLedger entries).
//   - Soft-delete only (set isActive: false). Hard DELETE is intentionally
//     absent because financial relations use onDelete: Restrict.
//   - Admin cannot deactivate themselves (would lock the system).

const tags = ['Users']
const security = [{ bearerAuth: [] }]

export default async function usersRoutes(app) {
  const adminOnly = [app.authenticate, app.requireRole('ADMIN')]

  app.post(
    '',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Create a new user',
        description:
          'Admin-only. Creates a TELLER or ADMIN account. The first three ' +
          'characters of `username` (uppercased) become the bet-ticket initials ' +
          'stamp for this user, so the username must start with three letters. ' +
          'Initials are NEVER accepted on the wire — the request will 400 if ' +
          'an `initials` field is present.',
        operationId: 'usersCreate',
        security,
        body: createUserRequestSchema,
        response: {
          201: createUserResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          409: errorResponses[409],
          500: errorResponses[500]
        }
      }
    },
    async (request, reply) => {
      const created = await createUser(request.server.prisma, request.body)
      reply.code(201)
      return { user: adminUser(created) }
    }
  )

  app.get(
    '',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'List users',
        description:
          'Admin-only. Returns all users, optionally filtered by role and / or ' +
          'isActive. Sorted by role, then username.',
        operationId: 'usersList',
        security,
        querystring: listUsersQuerySchema,
        response: {
          200: listUsersResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const users = await listUsers(request.server.prisma, request.query)
      return { users: users.map(adminUser) }
    }
  )

  app.get(
    '/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Get a user by id',
        description: 'Admin-only. Returns a single user record by id.',
        operationId: 'usersGet',
        security,
        params: userIdParamsSchema,
        response: {
          200: userResponseSchema,
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const user = await getUser(request.server.prisma, request.params.id)
      return { user: adminUser(user) }
    }
  )

  app.get(
    '/:id/barcode',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Teller login barcode payload',
        description:
          'Admin-only. Returns the teller\'s plaintext login password so the admin UI ' +
          'can render a CODE128 badge for kiosk sign-in. Passwords are stored plaintext ' +
          'in this deployment. Only active TELLER accounts are supported.',
        operationId: 'usersTellerLoginBarcode',
        security,
        params: userIdParamsSchema,
        response: {
          ...tellerLoginBarcodeResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => getTellerLoginBarcode(request.server.prisma, request.params.id)
  )

  app.patch(
    '/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: 'Update mutable fields of a user',
        description:
          'Admin-only. Updates `fullName` and / or `isActive`. `username`, ' +
          '`role`, and `initials` are intentionally immutable post-creation ' +
          '(see module comments). Admins cannot deactivate themselves.',
        operationId: 'usersUpdate',
        security,
        params: userIdParamsSchema,
        body: updateUserRequestSchema,
        response: {
          200: userResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const updated = await updateUser(
        request.server.prisma,
        request.params.id,
        request.body,
        request.user.id // for the self-deactivation guard
      )
      return { user: adminUser(updated) }
    }
  )

  app.post(
    '/:id/password',
    {
      preHandler: adminOnly,
      schema: {
        tags,
        summary: "Reset a user's password",
        description:
          'Admin-only. Sets a new password for the target user without ' +
          'requiring the current password. Rejects weak / common passwords ' +
          'via a denylist in the service layer.',
        operationId: 'usersResetPassword',
        security,
        params: userIdParamsSchema,
        body: resetPasswordRequestSchema,
        response: {
          200: okResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          403: errorResponses[403],
          404: errorResponses[404],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      await resetPassword(
        request.server.prisma,
        request.params.id,
        request.body.newPassword
      )
      return { ok: true }
    }
  )
}
