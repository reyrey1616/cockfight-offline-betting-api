// OpenAPI documentation plugin.
//
// Strategy: every route in this API already declares a Fastify JSON Schema
// (body / params / querystring / response). `@fastify/swagger` reads those
// at boot and emits an OpenAPI 3.1 document — meaning the docs are produced
// from the EXACT SAME schemas runtime uses to validate. There is no second
// source of truth that can drift.
//
// What this plugin does:
//   1. Registers shared schemas (cobs://error-response) so error responses
//      render as one $ref in the final spec.
//   2. Registers @fastify/swagger with global metadata: title, version,
//      contact, license, server URLs, tag descriptions, and the bearer-JWT
//      security scheme.
//   3. Registers @fastify/swagger-ui at /docs (with the raw spec at /docs/json).
//
// Production gating:
//   - The plugin only activates when ENABLE_API_DOCS !== 'false'. In a
//     LAN-only sabong shop the docs are an operational asset (anyone with
//     LAN access can play with the API surface), so default-on is fine.
//     Flip the env var to disable for a hardened build.
//
// Registration order:
//   This plugin MUST be registered BEFORE the route plugins so @fastify/swagger
//   can collect their schemas as they are added. See server.js for the
//   canonical order.

import fp from 'fastify-plugin'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { errorResponseSchema } from '../lib/api-schemas.js'

// process.env.npm_package_version is set by npm when the server is started
// via `npm run dev` / `npm start`. Falls back to a sentinel when executed
// directly (e.g. node src/server.js).
const API_VERSION = process.env.npm_package_version ?? '0.0.0'

// @fastify/websocket routes are registered with `{ websocket: true }` and
// @fastify/swagger does NOT include them in the emitted spec (the upgrade
// handshake is not a normal HTTP operation). We inject a documentation-only
// entry for /ws so consumers can discover it from the docs. The runtime
// route itself lives in src/plugins/websocket.plugin.js.
const WS_DOC_PATH = {
  get: {
    tags: ['Realtime'],
    summary: 'Subscribe to live odds (WebSocket upgrade)',
    description:
      'Upgrades the connection to a WebSocket. **OpenAPI does not natively ' +
      'describe WebSocket protocols** — this HTTP entry exists so the endpoint ' +
      'is discoverable, but the wire contract below is the authoritative spec.\n\n' +
      '### Connection\n' +
      '```\n' +
      'ws://<host>:<port>/ws?token=<jwt>\n' +
      '```\n' +
      'The JWT is the same one issued by `POST /auth/login`. Missing or invalid ' +
      'tokens close the socket with code **4401**. Inactive accounts close with ' +
      '**4403**.\n\n' +
      '### Server-to-client frames\n' +
      '```json\n' +
      '{\n' +
      '  "type": "ODDS_UPDATE",\n' +
      '  "data": {\n' +
      '    "fightId":  "clxxxxxxxxxxxxxxxxxxxx",\n' +
      '    "meronPool": "1500.00",\n' +
      '    "walaPool":  "800.00",\n' +
      '    "meronOdds": 1.48,\n' +
      '    "walaOdds":  2.69\n' +
      '  }\n' +
      '}\n' +
      '```\n' +
      'Pool values are decimal strings (avoid float precision loss). Odds are ' +
      'numbers rounded to 2 decimals; either can be `null` if the corresponding ' +
      'side has zero pool.\n\n' +
      '### Client-to-server frames\n' +
      'Currently none. Inbound frames are ignored.\n\n' +
      '### Lifecycle\n' +
      'Server appends the socket to a shared `Set` on open, removes it on close ' +
      '/ error, and closes all sockets cleanly with code **1001** on shutdown.',
    operationId: 'realtimeOdds',
    parameters: [
      {
        in: 'query',
        name: 'token',
        required: true,
        schema: { type: 'string' },
        description: 'JWT issued by `POST /auth/login`. Required to upgrade.'
      }
    ],
    responses: {
      101: {
        description: 'Switching Protocols — the connection has been upgraded to WebSocket.'
      },
      4401: {
        description: 'Closed: missing or invalid token. Sent as a WebSocket close code, not an HTTP status.'
      },
      4403: {
        description: 'Closed: account is no longer active. Sent as a WebSocket close code.'
      }
    }
  }
}

const TAG_GROUPS = [
  {
    name: 'Auth',
    description:
      'Authentication endpoints. Tellers and admins exchange username + password ' +
      'for a signed JWT and inspect their own profile here. The self-service ' +
      'password-change path validates the current password (plaintext compare) ' +
      'before accepting a new one that meets the shared password policy ' +
      '(8+ characters, weak-password denylist). Logout is symbolic — see the ' +
      'route description for the threat-model rationale (no jti denylist by ' +
      'design for single-shop LAN deployments).'
  },
  {
    name: 'Users',
    description:
      'Admin-only user management. Create tellers, list / inspect / soft-deactivate ' +
      'accounts, reset passwords. Usernames and roles are immutable post-creation. ' +
      'Initials are derived from the first three characters of the username.'
  },
  {
    name: 'Bets',
    description:
      'Bet placement, voiding, payout, lookup. Tellers place pari-mutuel bets ' +
      'on OPEN fights with an idempotency key; cashiers redeem winning ' +
      'tickets at the counter. Every mutation is transactional — ' +
      'Bet + TellerLedger + Fight pool move together or not at all. After a ' +
      'pool-changing mutation an ODDS_UPDATE frame is broadcast on /ws.'
  },
  {
    name: 'Fights',
    description:
      'Admin-only fight lifecycle. A new fight is created already in OPEN ' +
      'state and ready for bets — there is no separate schedule-then-open ' +
      'step. From OPEN the fight moves to CLOSED, then SETTLED (with an ' +
      'outcome) or CANCELLED. Admins can also hold/unhold individual sides ' +
      'while OPEN, and correct a previously-declared winner after SETTLED. ' +
      'Settlement runs in a single transaction that resolves every bet on ' +
      'the fight (WON / LOST / REFUNDED) and appends BET_REFUNDED ledger ' +
      'entries for draws and no-contests. Every state change broadcasts ' +
      'the corresponding event on /ws.'
  },
  {
    name: 'Settings',
    description:
      'System configuration. A single-row `Setting` table holds the ' +
      'commission rate ("tong") used by new fights. Changes are not ' +
      'retroactive — each fight snapshots the rate it was created with.'
  },
  {
    name: 'Collectors',
    description:
      'Cash collector labels — the named individuals who hand cash ' +
      'advances to tellers and receive remittances back. Collectors do ' +
      'NOT authenticate; they exist only as references on `TellerLedger` ' +
      'CASH_ADVANCE / REMIT rows. Retire via PATCH with `isActive=false`; ' +
      'there is no DELETE.\n\n' +
      'Each collector is issued a public 8-char barcode (`code`, format ' +
      '`"COL" + 5 reduced-alphabet`) at creation. Scan it via ' +
      '`GET /collectors/code/{code}` to autofill `collectorId` on cash ' +
      'forms — the typical workflow for the admin desk recording an ' +
      'advance from a wristband-scanned collector.'
  },
  {
    name: 'Cash',
    description:
      'Append-only cash ledger surface. Advances (collector → teller) ' +
      'and remits (teller → collector) move physical cash and write a ' +
      'matching `TellerLedger` row in one transaction. Balances are ' +
      'computed on read as `SUM(amount) WHERE tellerId = ?` — there is ' +
      'no denormalized cashBalance column. The hard invariant: a remit ' +
      'cannot push a teller\'s balance negative (post-write SUM check ' +
      'in the transaction). There is intentionally no manual-adjustment ' +
      'endpoint — corrections happen as new business events.\n\n' +
      'Every CASH_ADVANCE and REMIT row gets an 8-char public barcode ' +
      '("ADV…" / "REM…") printed on the receipt; `GET /cash/ledger/code/' +
      '{code}` resolves it back to the original transaction. Bet-related ' +
      'ledger rows have `code: null` because their printable code ' +
      'already lives on the related Bet (via `betId`).'
  },
  {
    name: 'Reports',
    description:
      'Admin-only analytics and reporting. The cornerstone endpoint — ' +
      '`GET /reports/teller-commissions` — returns the per-teller ' +
      'commission attribution leaderboard (productivity ranking). ' +
      'Commission is parimutuel-attributed: every peso of stake ' +
      'contributes `commissionRate` pesos of commission, regardless of ' +
      'win/loss, so a teller\'s contribution is `SUM(bet.stake × ' +
      'fight.commissionRate)`. Rates are snapshotted per fight, so the ' +
      'math is correct even if `Setting.commissionRate` changes mid-' +
      'session. Real-time: `TELLER_COMMISSIONS_UPDATED` is broadcast on ' +
      '`/ws` after every fight settle / cancel / correct.'
  },
  {
    name: 'Session',
    description:
      'Session lifecycle controls. The single endpoint that matters here ' +
      '— `POST /session/reset` — TRUNCATEs the transactional tables ' +
      '(`Fight`, `Bet`, `TellerLedger`) so the shop can start a fresh ' +
      'night with empty state. Three guardrails: bearer admin JWT, the ' +
      'magic confirmation string `"WIPE-SESSION"`, AND step-up password ' +
      're-entry (verified against the bearer admin\'s `User.password`). ' +
      'By default a wipe is blocked while there\'s ' +
      'any in-flight money (open fights, unpaid winners, non-zero teller ' +
      'balances) — `force: true` bypasses these checks. Every reset writes ' +
      'a permanent `SessionReset` audit row and broadcasts `SESSION_RESET` ' +
      'on `/ws`. Audit rows survive subsequent resets.'
  },
  {
    name: 'Realtime',
    description:
      'WebSocket channels. Documented here for completeness; OpenAPI is not the ' +
      'native protocol for WS so consult the description on /ws for the wire ' +
      'contract.'
  },
  {
    name: 'System',
    description: 'Service health and liveness checks.'
  }
]

async function swaggerPlugin(app) {
  if (process.env.ENABLE_API_DOCS === 'false') {
    app.log.info('API docs disabled (ENABLE_API_DOCS=false)')
    return
  }

  // Pre-register every shared schema BEFORE any route loads so `$ref`
  // lookups resolve. Fastify keeps these in a per-instance schema store.
  app.addSchema(errorResponseSchema)

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Cockfight Offline Betting API',
        description:
          'LAN-only kiosk API for sabong (cockfighting) bet handling.\n\n' +
          '## Auth\n' +
          'Stateful sessions are not used. Authenticated endpoints require an ' +
          '`Authorization: Bearer <jwt>` header. Obtain a JWT via `POST /auth/login`. ' +
          'Tokens expire (configurable via `JWT_EXPIRES_IN`, default 12h).\n\n' +
          '## Error shape\n' +
          'Every non-2xx response is `{ "error": { "code", "message", "details?" } }` ' +
          '(see the **ErrorResponse** component). The HTTP status code is the ' +
          'primary signal; `error.code` is the stable machine-readable string.\n\n' +
          '## Idempotency\n' +
          'Write endpoints that move money (currently `POST /bets`) require a ' +
          '`clientRequestId` UUID. Retries with the same id return the original ' +
          'result instead of duplicating the write — essential for flaky LAN.\n\n' +
          '## Realtime\n' +
          'Live odds updates fan out on `GET /ws` (WebSocket). See the **Realtime** ' +
          'section for the upgrade contract and the ODDS_UPDATE payload.',
        version: API_VERSION,
        contact: { name: 'Internal Ops' },
        license: { name: 'Proprietary — internal use only' }
      },
      servers: [
        { url: 'http://localhost:8000', description: 'Local dev (loopback)' },
        { url: 'http://{lanHost}:8000', description: 'LAN (teller machine pointing at admin laptop)',
          variables: { lanHost: { default: '192.168.1.10', description: 'IP of the admin laptop on the shop LAN' } } }
      ],
      tags: TAG_GROUPS,
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'JWT issued by `POST /auth/login`. Include as `Authorization: Bearer <token>`. ' +
              'The token is re-validated against the DB on every request so deactivated ' +
              'accounts lose access immediately.'
          }
        }
      }
    },
    // Suppress noise from auto-generated route schemas that lack metadata.
    hideUntagged: false,
    // Name shared components after the last segment of their $id instead of
    // the default sequential 'def-0', 'def-1'. So 'cobs://error-response'
    // becomes 'ErrorResponse' in components.schemas.
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        const id = typeof json?.$id === 'string' ? json.$id : ''
        const tail = id.split(/[/:]/).filter(Boolean).pop() || ''
        if (!tail) return `def-${i}`
        // 'error-response' → 'ErrorResponse'
        return tail
          .split('-')
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join('')
      }
    },
    // Inject the documentation-only /ws entry into the generated spec.
    // @fastify/swagger does not pick up routes registered with the
    // `websocket: true` flag, so we splice the path in here.
    transformObject: ({ openapiObject }) => {
      openapiObject.paths = openapiObject.paths ?? {}
      openapiObject.paths['/ws'] = WS_DOC_PATH
      return openapiObject
    }
  })

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true, // remembers the Bearer token across page reloads
      tryItOutEnabled: true,
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 2
    },
    staticCSP: true,
    transformStaticCSP: (header) => header
  })

  app.log.info('API docs available at /docs (JSON spec at /docs/json)')
}

// Depends on `error-handler` (so 404s on /docs render in our error shape).
// Must be registered BEFORE route plugins so swagger can collect schemas.
export default fp(swaggerPlugin, { name: 'swagger', dependencies: ['error-handler'] })
