// WebSocket transport + connection-protocol frames.
//
// This file is deliberately domain-agnostic. It owns:
//   - The fan-out primitive (`broadcast`) — iterates the client Set,
//     swallows per-socket failures, drops dead sockets so one stuck kiosk
//     never blocks updates to the others.
//   - The two connection-protocol frames (`WELCOME`, `PING`) — these are
//     about the socket itself, not any business resource.
//
// Domain-specific frame builders live in their owning module:
//   - Fight lifecycle + odds + side holds → src/modules/fights/fights.events.js
//   - (future) Teller balance → src/modules/cash/cash.events.js
//
// Adding a new event type: build it in the owning module's `*.events.js`,
// import it in the route that emits it, and call `app.broadcast(frame)`.
// Do not add domain builders here.

// `ws` socket readyState values, mirrored locally so we don't need to import
// the package just for the constants.
const WS_OPEN = 1

/**
 * Generic fan-out — send an already-built frame to every currently-
 * connected client. The single transport-layer entry point used by every
 * route that emits a real-time event.
 *
 * Failures on individual sockets are swallowed and the offending socket is
 * dropped from the set; one dead teller machine must never block updates
 * to the others.
 *
 * @param {Set<WebSocket>} clients  Active socket set tracked by the plugin.
 * @param {object}         frame    Will be JSON.stringify'd before send.
 * @returns {number}                Count of clients the frame reached.
 */
export function broadcast(clients, frame) {
  if (!(clients instanceof Set) || clients.size === 0) return 0

  const serialized = JSON.stringify(frame)
  let delivered = 0

  for (const socket of clients) {
    if (!socket || socket.readyState !== WS_OPEN) {
      clients.delete(socket)
      continue
    }
    try {
      socket.send(serialized)
      delivered += 1
    } catch {
      // Best-effort fan-out: a single bad socket never blocks the rest.
      clients.delete(socket)
    }
  }

  return delivered
}

// ---------------------------------------------------------------------------
// Connection-protocol frames (transport-owned, not a business event)
// ---------------------------------------------------------------------------

const isoNow = () => new Date().toISOString()

/**
 * Initial state snapshot sent once, immediately after auth, so a kiosk can
 * render its UI without a parallel REST call.
 */
export function buildWelcomePayload({ user, currentFight }) {
  return {
    type: 'WELCOME',
    data: { user, currentFight },
    ts: isoNow()
  }
}

/**
 * Keepalive PING. The client must respond with `{"type":"PONG"}` within
 * the configured deadline (see websocket.plugin.js) or the server closes
 * the socket with code 4408.
 */
export function buildPingPayload() {
  return { type: 'PING', ts: isoNow() }
}
