// Authentication plugin. Two responsibilities:
//
// 1. Registers @fastify/jwt so we can sign and verify tokens.
//    Use `app.jwt.sign(payload)` to issue a token.
//
// 2. Decorates the app with `authenticate` — a preHandler that:
//      a) verifies the JWT in the Authorization: Bearer <token> header
//      b) re-fetches the user from the DB (so deactivation takes immediate
//         effect — JWTs alone can't be revoked, but DB checks can)
//      c) replaces the JWT-payload `request.user` with the fresh DB record
//
// Use on protected routes:
//   app.get('/something', { preHandler: [app.authenticate] }, handler)
//
// And to require a specific role, compose with `requireRole(...)`:
//   preHandler: [app.authenticate, app.requireRole('ADMIN')]

import fp from 'fastify-plugin'
import jwt from '@fastify/jwt'
import { ForbiddenError, UnauthorizedError } from '../lib/errors.js'

async function authPlugin(app) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set; cannot register auth plugin')
  }

  await app.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: {
      expiresIn: process.env.JWT_EXPIRES_IN ?? '12h'
    }
  })

  app.decorate('authenticate', async function authenticate(request) {
    try {
      await request.jwtVerify()
    } catch {
      throw new UnauthorizedError('Authentication required')
    }

    // Re-load the user fresh from the DB so an admin deactivating a teller
    // mid-shift takes effect on the very next request, even if the teller
    // still holds a valid token.
    const sub = request.user?.sub
    if (!sub) throw new UnauthorizedError('Malformed token')

    const user = await request.server.prisma.user.findUnique({
      where: { id: sub },
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        isActive: true
      }
    })

    if (!user || !user.isActive) {
      throw new UnauthorizedError('Account is no longer active')
    }

    request.user = user
  })

  // Role-gate factory. Returns a preHandler that checks request.user.role.
  // Always compose AFTER `authenticate` so request.user is already loaded.
  app.decorate('requireRole', function requireRole(...allowedRoles) {
    return async function checkRole(request) {
      if (!request.user) throw new UnauthorizedError('Authentication required')
      if (!allowedRoles.includes(request.user.role)) {
        throw new ForbiddenError(
          `Requires one of: ${allowedRoles.join(', ')}`
        )
      }
    }
  })
}

export default fp(authPlugin, { name: 'auth' })
