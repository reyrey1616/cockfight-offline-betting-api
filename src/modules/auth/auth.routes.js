import { changePassword, publicUser, verifyCredentials } from './auth.service.js'
import {
  changePasswordRequestSchema,
  changePasswordResponseSchema,
  loginRequestSchema,
  loginResponseSchema,
  logoutResponseSchema,
  meResponseSchema
} from './auth.schemas.js'
import { errorResponses } from '../../lib/api-schemas.js'

// Auth routes plugin. Registered under the /auth prefix in server.js.
//
// Routes:
//   POST /auth/login            — exchange username + password for a signed JWT
//   GET  /auth/me               — currently-authenticated user (protected)
//   POST /auth/change-password  — self-service password change (protected)
//   POST /auth/logout           — symbolic logout (protected; see route description)

export default async function authRoutes(app) {
  app.post(
    '/login',
    {
      schema: {
        tags: ['Auth'],
        summary: 'Exchange credentials for a JWT',
        description:
          'Public endpoint. Returns a signed JWT and the public user record on ' +
          'success. The token is required as `Authorization: Bearer <token>` on ' +
          'all protected endpoints. Failures (wrong password, unknown username, ' +
          'inactive account) return the same generic 401 to avoid leaking which ' +
          'usernames exist.',
        operationId: 'authLogin',
        body: loginRequestSchema,
        response: {
          200: loginResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      const { username, password } = request.body
      const user = await verifyCredentials(request.server.prisma, {
        username,
        password
      })

      const token = await app.jwt.sign({
        sub: user.id,
        username: user.username,
        role: user.role
      })

      return { token, user: publicUser(user) }
    }
  )

  app.get(
    '/me',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Auth'],
        summary: 'Return the currently authenticated user',
        description:
          'Returns the public profile of the user whose JWT was supplied. The ' +
          'user record is re-fetched from the database on every call, so a ' +
          'deactivation by an admin takes effect immediately.',
        operationId: 'authMe',
        security: [{ bearerAuth: [] }],
        response: {
          200: meResponseSchema,
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => ({ user: publicUser(request.user) })
  )

  // -------------------------------------------------------------------------
  // POST /auth/change-password — self-service password change
  // -------------------------------------------------------------------------
  app.post(
    '/change-password',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Auth'],
        summary: 'Change the authenticated user\'s own password',
        description:
          'Self-service path. The bearer-authenticated user submits their ' +
          'current password plus a new one. The current password is ' +
          're-verified against the stored password; the new password is checked against the ' +
          'shared password policy (length + weak-password denylist).\n\n' +
          'Distinct from the admin reset path `POST /users/{id}/password`: ' +
          'admin reset does NOT require the current password (admins reset ' +
          'for users who forgot), this endpoint does.\n\n' +
          '### Failure modes\n' +
          '- Missing fields / wrong types → 400 (schema reject)\n' +
          '- `newPassword` too short / weak → 400 (policy violation)\n' +
          '- `newPassword` === `currentPassword` → 400 (no-op rejection)\n' +
          '- `currentPassword` wrong / user deactivated → 401 (generic ' +
          'message). Logged at WARN.\n\n' +
          '### Side effect on JWTs\n' +
          'Existing bearer tokens for this user remain valid until their ' +
          'natural `exp` claim. There is intentionally no `jti` denylist ' +
          '(see threat model in route module header). New logins use the ' +
          'new password immediately.',
        operationId: 'authChangePassword',
        security: [{ bearerAuth: [] }],
        body: changePasswordRequestSchema,
        response: {
          ...changePasswordResponseSchema,
          400: errorResponses[400],
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      try {
        await changePassword(request.server.prisma, request.user.id, request.body)
      } catch (err) {
        // Failed current-password verification surfaces in the audit
        // feed. Bearer identity is included so a reviewer can spot a
        // pattern (e.g. one userId getting many 401s = compromised
        // token holder fishing for the password).
        if (err?.statusCode === 401) {
          request.log.warn(
            {
              userId: request.user?.id,
              username: request.user?.username,
              path: '/auth/change-password'
            },
            'Self-service password change: current-password verification FAILED'
          )
        }
        throw err
      }

      // INFO log on success — gives the security feed a positive
      // record of "X changed their password at Y" without exposing
      // either old or new plaintext.
      request.log.info(
        {
          userId: request.user.id,
          username: request.user.username,
          path: '/auth/change-password'
        },
        'Self-service password changed'
      )

      return { ok: true, message: 'Password updated' }
    }
  )

  // -------------------------------------------------------------------------
  // POST /auth/logout — symbolic logout
  // -------------------------------------------------------------------------
  app.post(
    '/logout',
    {
      preHandler: [app.authenticate],
      schema: {
        tags: ['Auth'],
        summary: 'Symbolic logout (no server-side token revocation)',
        description:
          '**Symbolic.** Without a server-side `jti` denylist there is no ' +
          'way for the API to invalidate an already-issued JWT — it remains ' +
          'cryptographically valid until its `exp` claim. This endpoint ' +
          'exists so clients have a canonical place to call when the user ' +
          'clicks "log out" (and so the act of logging out lands in the ' +
          'audit log).\n\n' +
          '### What the CLIENT must do\n' +
          'Drop the bearer token locally (delete the cookie / clear ' +
          'localStorage / forget the in-memory variable). Future requests ' +
          'without `Authorization: Bearer ...` will get 401 as expected.\n\n' +
          '### Threat model — why no denylist\n' +
          'Deployment is single-shop, LAN-only, with admin-managed accounts ' +
          'and trusted kiosks. The cost of a `jti` denylist (Redis or ' +
          'database table + cleanup job + token-lifetime tuning) exceeds ' +
          'the marginal security benefit for this footprint. If we ever ' +
          'ship multi-tenant or remote access we will add a `tokenVersion` ' +
          'column on `User` and bump it on every password change / logout ' +
          '— that revokes ALL outstanding tokens for the user with one ' +
          'integer update.\n\n' +
          'If you need to forcibly evict a user RIGHT NOW (e.g. compromise ' +
          'response), an admin can set `isActive: false` on their User row ' +
          'via `PATCH /users/{id}` — every subsequent request with that ' +
          'token returns 401 because `app.authenticate` re-fetches the ' +
          'user on every call. That is the de-facto kill switch today.',
        operationId: 'authLogout',
        security: [{ bearerAuth: [] }],
        response: {
          ...logoutResponseSchema,
          401: errorResponses[401],
          500: errorResponses[500]
        }
      }
    },
    async (request) => {
      // Log at INFO. Not WARN — logout is a normal user action, not a
      // security event. The audit value is "we know the user intended
      // to end this session," not "something suspicious happened."
      request.log.info(
        {
          userId: request.user.id,
          username: request.user.username,
          path: '/auth/logout'
        },
        'Symbolic logout'
      )

      return {
        ok: true,
        message: 'Logged out. Drop the bearer token client-side; it remains valid server-side until its natural expiry.'
      }
    }
  )
}
