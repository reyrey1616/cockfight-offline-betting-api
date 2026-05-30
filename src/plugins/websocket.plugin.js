// WebSocket plugin.
//
// Connection contract:
//   ws://<host>:<port>/ws?token=<jwt>
//
// JWT auth happens BEFORE any frame is exchanged — connections without a
// valid, active-user token are closed with code 4401 (or 4403 for
// deactivated users). The system is LAN-only, but unauthenticated WS would
// still let any device on the network silently observe live odds.
//
// On successful auth the server sends a single `WELCOME` frame containing
// the current fight snapshot, so a kiosk starts in sync without a separate
// REST round-trip. After that, the connection is push-only from the
// server's perspective.
//
// Keepalive: the server sends a `PING` frame every PING_INTERVAL_MS. The
// client should reply with `{"type":"PONG"}`. If no PONG arrives within
// PING_TIMEOUT_MS of a PING, the socket is closed and the client is
// expected to reconnect automatically.
//
// Decorations exposed to the rest of the app:
//   app.wsClients        Set<WebSocket>            — owner of connection state
//   app.broadcast(frame) (frame) => deliveredCount — generic fan-out
//
// Frame builders are NOT defined here. They live with the module that owns
// the resource each event describes — e.g. fight/odds/side frames live in
// `src/modules/fights/fights.events.js`. Only the two connection-protocol
// frames (`WELCOME`, `PING`) live in `src/lib/websocket.js` next to the
// transport, because they describe the socket itself, not a business
// resource.

import fp from 'fastify-plugin'
import websocketPlugin from '@fastify/websocket'
import {
  broadcast as broadcastLib,
  buildPingPayload,
  buildWelcomePayload
} from '../lib/websocket.js'
import { computeLiveOdds } from '../lib/odds.js'
import { publicUser } from '../lib/user-mapper.js'

// Custom close codes (4000-4999 is the application-defined range per RFC6455).
const CLOSE_UNAUTHORIZED = 4401
const CLOSE_INACTIVE = 4403
const CLOSE_KEEPALIVE_TIMEOUT = 4408

// Keepalive timing. 30 s ping + 30 s response window matches the safest
// NAT/idle timeouts we expect on cheap LAN routers without being noisy.
const PING_INTERVAL_MS = 30_000
const PING_TIMEOUT_MS = 30_000

async function wsPlugin(app) {
  await app.register(websocketPlugin, {
    options: {
      // 1 MB max payload — these are tiny JSON frames, anything larger is
      // almost certainly a misuse or attack on a LAN-exposed socket.
      maxPayload: 1 * 1024 * 1024
    }
  })

  const wsClients = new Set()
  app.decorate('wsClients', wsClients)

  // Single, canonical fan-out entry point. Every route that emits a real-
  // time event calls `app.broadcast(<frame>)`; the frame itself is built by
  // the owning module's `*.events.js` file.
  app.decorate('broadcast', (frame) => broadcastLib(wsClients, frame))

  const wsRouteSchema = {
    tags: ['Realtime'],
    summary: 'Subscribe to real-time events (WebSocket upgrade)',
    description:
      'Upgrades the connection to a WebSocket. **OpenAPI does not natively ' +
      'describe WebSocket protocols** — the HTTP-style entry here exists so ' +
      'this endpoint is discoverable, but the wire contract below is the ' +
      'authoritative spec. See `docs/realtime-events.md` in the repo for ' +
      'the full event catalog.\n\n' +
      '### Connection\n' +
      '```\n' +
      'ws://<host>:<port>/ws?token=<jwt>\n' +
      '```\n' +
      'The JWT is the one issued by `POST /auth/login`. Missing/invalid ' +
      'tokens close the socket with **4401**, deactivated accounts with ' +
      '**4403**, idle keepalive timeouts with **4408**.\n\n' +
      '### Frame envelope\n' +
      'Every server-to-client frame has the shape:\n' +
      '```json\n' +
      '{ "type": "<EVENT_TYPE>", "data": { ... }, "ts": "<ISO-8601>" }\n' +
      '```\n\n' +
      '### Event types\n' +
      '- `WELCOME` — sent once, immediately after auth, with the current ' +
      'fight snapshot.\n' +
      '- `ODDS_UPDATE` — pool / odds changed (bet placed or voided).\n' +
      '- `FIGHT_OPENED`, `FIGHT_CLOSED`, `FIGHT_SETTLED`, ' +
      '`FIGHT_CANCELLED`, `FIGHT_CORRECTED` — fight lifecycle. ' +
      'There is no `FIGHT_CREATED`; new fights are created already in ' +
      '`OPEN` state, so `FIGHT_OPENED` is the single create-time frame.\n' +
      '- `SIDE_HELD`, `SIDE_UNHELD` — per-side bet acceptance toggle.\n' +
      '- `TELLER_BALANCE_UPDATED` — every `TellerLedger` append (bet ' +
      'placed / voided / paid, cash advance / remit). Lets the admin ' +
      'dashboard show live per-teller balances; teller kiosks drop frames ' +
      'whose `tellerId` is not their own.\n' +
      '- `TELLER_COMMISSIONS_UPDATED` — thin signal that the per-teller ' +
      'commission leaderboard is out of date (refetch ' +
      '`/reports/teller-commissions`). Fires after every fight settle / ' +
      'cancel / correct.\n' +
      '- `SESSION_RESET` — fires once after `POST /session/reset` commits. ' +
      'Carries the audit row id and destroyed-row counts; tells every ' +
      'connected kiosk to clear local state and re-fetch.\n' +
      '- `PING` — keepalive; client must respond with `{"type":"PONG"}`.\n\n' +
      'The canonical, frame-by-frame wire contract for every event above ' +
      'lives in `docs/realtime-events.md`. Update that file alongside any ' +
      'change to the catalog.',
    operationId: 'realtimeStream',
    querystring: {
      type: 'object',
      required: ['token'],
      properties: {
        token: {
          type: 'string',
          description: 'JWT issued by `POST /auth/login`. Required to upgrade.'
        }
      }
    },
    response: {
      101: {
        description: 'Switching Protocols — the connection has been upgraded to WebSocket.',
        type: 'null'
      }
    }
  }

  app.get('/ws', { websocket: true, schema: wsRouteSchema }, async (socket, request) => {
    const token = request.query?.token
    if (!token) {
      socket.close(CLOSE_UNAUTHORIZED, 'Missing token')
      return
    }

    let payload
    try {
      payload = await app.jwt.verify(token)
    } catch {
      socket.close(CLOSE_UNAUTHORIZED, 'Invalid token')
      return
    }

    const user = await app.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true, role: true, isActive: true, username: true, fullName: true
      }
    })

    if (!user || !user.isActive) {
      socket.close(CLOSE_INACTIVE, 'Account is no longer active')
      return
    }

    wsClients.add(socket)
    request.log.info(
      { userId: user.id, username: user.username, role: user.role, total: wsClients.size },
      'WebSocket connected'
    )

    // ---------------------------------------------------------------------
    // WELCOME — initial state snapshot. Sent ONCE per connection so the
    // kiosk can render its UI without a parallel REST call.
    // ---------------------------------------------------------------------
    try {
      const currentFight = await loadCurrentFightSnapshot(app.prisma)
      socket.send(JSON.stringify(buildWelcomePayload({
        user: publicUser(user),
        currentFight
      })))
    } catch (err) {
      request.log.warn({ err, userId: user.id }, 'Failed to send WELCOME frame')
      // Non-fatal — client can still receive future broadcasts.
    }

    // ---------------------------------------------------------------------
    // Keepalive — server PINGs every PING_INTERVAL_MS, expects PONG within
    // PING_TIMEOUT_MS. Both timers are cleared on socket close.
    // ---------------------------------------------------------------------
    let pongDeadline = null
    let pingTimer = null

    const sendPing = () => {
      if (socket.readyState !== 1) return
      try {
        socket.send(JSON.stringify(buildPingPayload()))
      } catch {
        // socket already gone — let the close handler clean up.
        return
      }
      pongDeadline = setTimeout(() => {
        request.log.info({ userId: user.id }, 'WebSocket keepalive timeout — closing')
        try { socket.close(CLOSE_KEEPALIVE_TIMEOUT, 'PONG timeout') } catch { /* */ }
      }, PING_TIMEOUT_MS)
    }
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS)

    // ---------------------------------------------------------------------
    // Inbound frames. Only PONG is acknowledged; everything else is logged
    // at debug and ignored. We never let bad client input crash the loop.
    // ---------------------------------------------------------------------
    socket.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg?.type === 'PONG') {
        if (pongDeadline) {
          clearTimeout(pongDeadline)
          pongDeadline = null
        }
      }
    })

    const cleanup = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null }
      if (pongDeadline) { clearTimeout(pongDeadline); pongDeadline = null }
      wsClients.delete(socket)
    }

    socket.on('close', () => {
      cleanup()
      request.log.info({ userId: user.id, total: wsClients.size }, 'WebSocket closed')
    })

    socket.on('error', (err) => {
      cleanup()
      request.log.warn({ err, userId: user.id }, 'WebSocket error')
    })
  })

  app.addHook('onClose', async () => {
    for (const socket of wsClients) {
      try { socket.close(1001, 'Server shutting down') } catch { /* best effort */ }
    }
    wsClients.clear()
  })
}

// Project the "what's the current fight?" snapshot for WELCOME frames.
// Picks OPEN/LAST_CALL first, else the most recent fight by createdAt.
// Returns null when the table is empty (fresh install / post-reset).
async function loadCurrentFightSnapshot(prisma) {
  const fight =
    (await prisma.fight.findFirst({
      where: { status: { in: ['OPEN', 'LAST_CALL'] } },
      orderBy: { fightNumber: 'desc' }
    })) ||
    (await prisma.fight.findFirst({
      orderBy: { fightNumber: 'desc' }
    }))

  if (!fight) return null

  const { meronOdds, walaOdds } = computeLiveOdds(fight)
  return {
    id: fight.id,
    fightNumber: fight.fightNumber,
    status: fight.status,
    commissionRate: fight.commissionRate,
    meronPool: fight.meronPool,
    walaPool: fight.walaPool,
    meronOdds,
    walaOdds,
    meronAcceptingBets: fight.meronAcceptingBets,
    walaAcceptingBets: fight.walaAcceptingBets,
    outcome: fight.outcome ?? null,
    payoutRatioMeron: fight.payoutRatioMeron ?? null,
    payoutRatioWala: fight.payoutRatioWala ?? null
  }
}

// Depends on `auth` (for app.jwt) and `prisma` (for the user lookup), so it
// must be registered AFTER both.
export default fp(wsPlugin, { name: 'websocket', dependencies: ['auth', 'prisma'] })
