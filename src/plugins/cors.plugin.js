// CORS plugin.
//
// What this does:
//   Allows browser-based clients (the Vite-served kiosk/admin UI) to call
//   this API from a different origin during development AND in production
//   LAN deployments where the web client and the API may be served by
//   different processes / hosts.
//
// Why we need it:
//   The browser blocks any cross-origin fetch that doesn't carry the right
//   Access-Control-Allow-* headers. Without this plugin every login from
//   http://localhost:5173 → http://localhost:8000 fails at the preflight.
//
// Configuration model:
//   - `CORS_ORIGINS` env var: comma-separated list of allowed origins.
//     e.g. `CORS_ORIGINS=http://localhost:5173,http://192.168.1.7:5173`
//   - If unset, falls back to dev defaults (localhost + 127.0.0.1 on the
//     Vite port). In non-production, also allows RFC1918 LAN IPs on those
//     Vite port(s) so `vite --host` + phone on Wi-Fi works. In production
//     with unset CORS_ORIGINS, only localhost defaults apply — set
//     `CORS_ALLOW_LAN_VITE=true` to allow LAN+Vite as well.
//   - `CORS_VITE_DEV_PORTS` — comma ports to treat as Vite for that LAN rule
//     (default `5173`). Example: `5173,5174`
//   - When `CORS_ORIGINS` IS set, LAN+Vite matching is off unless you also set
//     `CORS_ALLOW_LAN_VITE=true` (then explicit origins still apply, plus LAN).
//   - The special value `*` is rejected — credentials are enabled and the
//     spec forbids `Access-Control-Allow-Origin: *` when credentials are
//     in play. If you genuinely want to allow any origin, list them.
//
// Credentials note:
//   We enable `credentials: true` so the browser will accept cookie-based
//   responses if we ever switch off bearer tokens. Today we use JWTs in
//   the Authorization header (which is not a CORS-credentials concern by
//   itself) but the flag costs us nothing and pre-empts a footgun.

import fp from 'fastify-plugin'
import cors from '@fastify/cors'

// Local-network development default. Production deployments override via
// the CORS_ORIGINS env var.
const DEV_DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173'
]

function parseOriginList(raw) {
  return raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}

function parseViteDevPorts() {
  const raw =
    process.env.CORS_VITE_DEV_PORTS ?? process.env.CORS_VITE_DEV_PORT ?? '5173'
  return new Set(
    raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)
  )
}

/** True if hostname looks like RFC1918 private IPv4 (no DNS resolution). */
function isPrivateLanIpv4(hostname) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return false
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return false
  const parts = hostname.split('.').map((n) => Number(n))
  if (parts.some((n) => n > 255 || Number.isNaN(n))) return false
  const [a, b] = parts
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/**
 * Vite dev server on LAN: e.g. http://192.168.1.10:5173 — same host the
 * browser used to load the SPA, different port than API (:8000).
 */
function isLanViteDevOrigin(origin, vitePorts) {
  try {
    const u = new URL(origin)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (!isPrivateLanIpv4(u.hostname)) return false
    const port = u.port || (u.protocol === 'https:' ? '443' : '80')
    return vitePorts.has(port)
  } catch {
    return false
  }
}

async function corsPlugin(app) {
  const corsOriginsRaw = process.env.CORS_ORIGINS?.trim()
  const explicitList = corsOriginsRaw ? parseOriginList(corsOriginsRaw) : null

  if (explicitList?.includes('*')) {
    throw new Error(
      'CORS_ORIGINS=* is not allowed when credentials are enabled. ' +
      'Enumerate every origin explicitly.'
    )
  }

  const allowSet = new Set(explicitList ?? DEV_DEFAULT_ORIGINS)
  const vitePorts = parseViteDevPorts()
  const relaxLanVite =
    process.env.CORS_ALLOW_LAN_VITE === '1' ||
    process.env.CORS_ALLOW_LAN_VITE === 'true' ||
    (explicitList === null && process.env.NODE_ENV !== 'production')

  // Permit any origin that exactly matches the configured list. We use a
  // function rather than the static array form so we can log unexpected
  // origins at debug level — handy when a teller machine's IP changes
  // and a request silently fails CORS in production.
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    // The frontend SDK sends Authorization (bearer) and Content-Type
    // (application/json). Anything beyond that is a code smell.
    allowedHeaders: ['Authorization', 'Content-Type'],
    // Browsers send `origin` for cross-origin requests only. Same-origin
    // calls (e.g. a future scenario where the API serves the SPA itself)
    // arrive with no origin — let those through unconditionally.
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      if (allowSet.has(origin)) return cb(null, true)
      if (relaxLanVite && isLanViteDevOrigin(origin, vitePorts)) {
        return cb(null, true)
      }
      app.log.debug(
        { origin, allowed: [...allowSet], relaxLanVite, vitePorts: [...vitePorts] },
        'CORS: origin not in allowlist'
      )
      return cb(null, false)
    }
  })

  app.log.info(
    {
      allowedOrigins: [...allowSet],
      relaxLanVite,
      viteDevPorts: [...vitePorts]
    },
    'CORS configured'
  )
}

export default fp(corsPlugin, { name: 'cors' })
