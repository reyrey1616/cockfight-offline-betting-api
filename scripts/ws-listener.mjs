// Tiny dev-time WS smoke-test client. Connects to ws://localhost:8000/ws
// with the JWT supplied as argv[2], prints each frame, and exits after
// argv[3] seconds (default 8).

import WebSocket from 'ws'

const token = process.argv[2]
const ttlSec = Number(process.argv[3] ?? 8)

if (!token) {
  console.error('Usage: node scripts/ws-listener.mjs <jwt> [ttlSec]')
  process.exit(2)
}

const ws = new WebSocket(`ws://127.0.0.1:8000/ws?token=${token}`)

ws.on('open', () => console.log('WS_OPEN'))
ws.on('message', (data) => console.log('WS_MSG', data.toString()))
ws.on('close', (code, reason) => console.log('WS_CLOSE', code, reason.toString()))
ws.on('error', (err) => console.log('WS_ERR', err.message))

setTimeout(() => { ws.close(); process.exit(0) }, ttlSec * 1000)
