import Fastify from 'fastify'
import dotenv from 'dotenv'

import prismaPlugin from './plugins/prisma.plugin.js'
import errorHandlerPlugin from './plugins/error-handler.plugin.js'
import corsPlugin from './plugins/cors.plugin.js'
import authPlugin from './plugins/auth.plugin.js'
import websocketPlugin from './plugins/websocket.plugin.js'
import swaggerPlugin from './plugins/swagger.plugin.js'
import authRoutes from './modules/auth/auth.routes.js'
import usersRoutes from './modules/users/users.routes.js'
import betsRoutes from './modules/bets/bets.routes.js'
import fightsRoutes from './modules/fights/fights.routes.js'
import settingsRoutes from './modules/settings/settings.routes.js'
import collectorsRoutes from './modules/collectors/collectors.routes.js'
import cashRoutes from './modules/cash/cash.routes.js'
import sessionRoutes from './modules/session/session.routes.js'
import { checkSessionResetSchemaIntegrity } from './modules/session/session.service.js'
import reportsRoutes from './modules/reports/reports.routes.js'

dotenv.config()

// Build and configure the server. Kept as a separate function from start()
// so tests (later) can spin up an instance without binding a port.
export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
    },
    // Treat /users and /users/ as the same route. Routes are declared
    // without a trailing slash so the OpenAPI docs render clean paths;
    // this option keeps legacy clients sending the trailing form working.
    // Note: Fastify 5 moved router options under `routerOptions`.
    routerOptions: { ignoreTrailingSlash: true },
    // Strict request-body validation: unknown properties cause a 400 instead
    // of being silently dropped. This is intentional — accepting unknown
    // fields hides client bugs and lets stale clients send obsolete data
    // (e.g. a kiosk still sending the removed `initials` field).
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: 'array',
        useDefaults: true,
        allErrors: false
      }
    }
  })

  await app.register(errorHandlerPlugin)
  // CORS must register BEFORE any route plugins so the @fastify/cors
  // global hooks intercept the preflight OPTIONS for every route — and
  // before authPlugin so unauthenticated preflights aren't 401'd.
  await app.register(corsPlugin)
  await app.register(prismaPlugin)
  await app.register(authPlugin)
  // Swagger MUST be registered before route plugins so it can collect
  // every route's schema as they are added.
  await app.register(swaggerPlugin)
  await app.register(websocketPlugin)

  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(usersRoutes, { prefix: '/users' })
  await app.register(betsRoutes, { prefix: '/bets' })
  await app.register(fightsRoutes, { prefix: '/fights' })
  await app.register(settingsRoutes, { prefix: '/settings' })
  await app.register(collectorsRoutes, { prefix: '/collectors' })
  await app.register(cashRoutes, { prefix: '/cash' })
  await app.register(sessionRoutes, { prefix: '/session' })
  await app.register(reportsRoutes, { prefix: '/reports' })

  // Schema-drift guard for /session/reset. Fires once at boot and logs a
  // WARN (not a fatal) if any FK now points into the wipe set from
  // outside it — that would make the next TRUNCATE fail. See
  // `checkSessionResetSchemaIntegrity` for the rationale. The check is
  // ~1 ms; if it itself errors (e.g. DB down at boot) we log a debug-
  // level note and proceed — the system is otherwise fully functional
  // and /health will already be reporting `database: down`.
  app.ready(async () => {
    try {
      const violations = await checkSessionResetSchemaIntegrity(app.prisma)
      if (violations.length > 0) {
        app.log.warn(
          { violations },
          'Session-reset schema drift: one or more tables outside the wipe set ' +
          '({Fight, Bet, TellerLedger}) now FK-reference a wipe-set table. ' +
          'POST /session/reset will fail until each offending table is either ' +
          'added to the wipe set in session.service.js or its FK removed.'
        )
      } else {
        app.log.info('Session-reset schema integrity check passed.')
      }
    } catch (err) {
      app.log.debug({ err }, 'Session-reset schema integrity check could not run')
    }
  })

  const healthResponseSchema = {
    type: 'object',
    required: ['status', 'service', 'database', 'timestamp'],
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded'] },
      service: { type: 'string' },
      database: { type: 'string', enum: ['up', 'down'] },
      timestamp: { type: 'string', format: 'date-time' }
    }
  }

  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Liveness + DB connectivity probe',
        description:
          'Returns `status: ok` when both the HTTP server is up and the database ' +
          'is reachable. Returns `status: degraded` (still 200) if the DB ping ' +
          'fails — load balancers should route traffic away on `degraded`. The ' +
          'response is intentionally a 200 in both cases so a monitor can read ' +
          'the body rather than relying on status alone.',
        operationId: 'systemHealth',
        response: { 200: healthResponseSchema }
      }
    },
    async (request) => {
      const dbOk = await request.server.prisma.$queryRaw`SELECT 1 AS ok`
        .then(() => true)
        .catch(() => false)

      return {
        status: dbOk ? 'ok' : 'degraded',
        service: 'cockfight-offline-betting',
        database: dbOk ? 'up' : 'down',
        timestamp: new Date().toISOString()
      }
    }
  )

  app.get(
    '/',
    {
      schema: {
        tags: ['System'],
        summary: 'Root banner',
        description: 'Cheap "the server is running" probe with no DB hit.',
        operationId: 'systemRoot',
        response: {
          200: {
            type: 'object',
            required: ['status', 'message'],
            properties: {
              status: { type: 'string' },
              message: { type: 'string' }
            }
          }
        }
      }
    },
    async () => ({
      status: 'ok',
      message: 'Betting server is running'
    })
  )

  return app
}

async function start() {
  const app = await buildServer()
  try {
    await app.listen({
      port: Number(process.env.PORT) || 3000,
      host: '0.0.0.0' // allows LAN access from teller machines
    })
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
