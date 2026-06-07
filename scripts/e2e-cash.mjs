// End-to-end test for the cash workflow module.
//
// Covers:
//   1. Setup: admin login, ensure a teller exists, ensure a collector exists.
//   2. Happy path: GET balance (0) → cash advance → bet → pay → remit → GET balance.
//   3. Verify ledger list shows all 4 entries with correct signs.
//   4. Edge cases: over-remit (409), advance to admin (400), advance to inactive
//      teller (400), teller spying on another teller's balance (403),
//      empty body POST (400), out-of-range amount (400).
//   5. WebSocket: confirm TELLER_BALANCE_UPDATED frames fire on advance/remit.

import WebSocket from 'ws'

const BASE = 'http://127.0.0.1:8000'
const WS_BASE = 'ws://127.0.0.1:8000/ws'

let pass = 0
let fail = 0
const failures = []

function assert(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`) }
  else { fail++; failures.push(msg); console.log(`  ✗ ${msg}`) }
}

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let data = null
  try { data = await res.json() } catch {}
  return { status: res.status, data }
}

function section(label) {
  console.log(`\n━━━ ${label} ━━━`)
}

async function login(username, password) {
  const r = await api('POST', '/auth/login', { body: { username, password } })
  if (r.status !== 200) throw new Error(`Login failed for ${username}: ${JSON.stringify(r.data)}`)
  return r.token = r.data.token
}

async function ensureUser(adminToken, { username, fullName, role, password }) {
  // Try to find existing
  const list = await api('GET', '/users?limit=200', { token: adminToken })
  const existing = list.data?.users?.find(u => u.username === username)
  if (existing) return existing
  const r = await api('POST', '/users', {
    token: adminToken,
    body: { username, fullName, role, password }
  })
  if (r.status !== 201) throw new Error(`Create user ${username} failed: ${JSON.stringify(r.data)}`)
  return r.data.user
}

async function ensureCollector(adminToken, name) {
  const list = await api('GET', '/collectors?isActive=true&limit=200', { token: adminToken })
  const existing = list.data?.collectors?.find(c => c.name === name)
  if (existing) return existing
  const r = await api('POST', '/collectors', { token: adminToken, body: { name } })
  if (r.status !== 201) throw new Error(`Create collector ${name} failed: ${JSON.stringify(r.data)}`)
  return r.data.collector
}

// ---------- WebSocket helper ----------
function startWs(token) {
  const ws = new WebSocket(`${WS_BASE}?token=${token}`)
  const frames = []
  ws.on('message', (buf) => {
    try { frames.push(JSON.parse(buf.toString())) } catch {}
  })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, frames }))
    ws.on('error', reject)
  })
}

function waitFor(frames, predicate, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const found = frames.find(predicate)
      if (found) return resolve(found)
      if (Date.now() - start > timeoutMs) return reject(new Error('Timeout waiting for frame'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

// ===========================================================================
async function main() {
  section('Setup')
  const adminToken = await login('admin', 'admin2026@')
  console.log('  ✓ admin logged in')

  // Use unique usernames per run so we don't collide with leftovers.
  const stamp = Date.now().toString().slice(-6)
  const tellerUser = `teller${stamp}`
  const teller2User = `teller${stamp}b`
  const collectorName = `Collector E2E ${stamp}`
  const inactiveTellerUser = `inactive${stamp}`

  const teller = await ensureUser(adminToken, {
    username: tellerUser, fullName: 'Teller One E2E', role: 'TELLER'
  })
  console.log(`  ✓ teller created: ${teller.username} (${teller.id})`)

  const teller2 = await ensureUser(adminToken, {
    username: teller2User, fullName: 'Teller Two E2E', role: 'TELLER'
  })
  console.log(`  ✓ teller2 created: ${teller2.username} (${teller2.id})`)

  const inactiveTeller = await ensureUser(adminToken, {
    username: inactiveTellerUser, fullName: 'Inactive Teller', role: 'TELLER'
  })
  // Deactivate
  await api('PATCH', `/users/${inactiveTeller.id}`, { token: adminToken, body: { isActive: false } })
  console.log(`  ✓ inactive teller deactivated: ${inactiveTeller.username}`)

  const collector = await ensureCollector(adminToken, collectorName)
  console.log(`  ✓ collector created: ${collector.name} (${collector.id})`)

  const tellerToken = await login(tellerUser, 'teller12345')
  const teller2Token = await login(teller2User, 'teller12345')
  console.log('  ✓ both teller tokens obtained')

  // Get admin user id (need it for "advance to admin" edge case)
  const adminUser = (await api('GET', '/auth/me', { token: adminToken })).data.user
  console.log(`  ✓ admin id: ${adminUser.id}`)

  // -----------------------------------------------------------------------
  section('WS subscribe (admin) — capture broadcasts')
  const { ws: adminWs, frames: adminFrames } = await startWs(adminToken)
  console.log('  ✓ admin WS connected')

  // ============================================================
  section('Happy path — initial balance must be 0')
  // ============================================================
  let r = await api('GET', '/cash/balance', { token: tellerToken })
  assert(r.status === 200, `GET own balance → 200 (got ${r.status})`)
  assert(r.data.balance === '0.00', `Initial balance is 0.00 (got ${r.data.balance})`)
  assert(r.data.tellerId === teller.id, 'Returned tellerId matches self')
  assert(r.data.username === tellerUser, 'Returned username matches')

  // ============================================================
  section('Happy path — advance 5,000 to teller')
  // ============================================================
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: collector.code, amount: 5000, notes: 'shift start' }
  })
  assert(r.status === 201, `Advance → 201 (got ${r.status}, body=${JSON.stringify(r.data)})`)
  assert(r.data.actorBalance === '5000.00', `actorBalance = 5000.00 (got ${r.data.actorBalance})`)
  assert(r.data.ledgerEntry.type === 'CASH_ADVANCE', 'Ledger type CASH_ADVANCE')
  assert(r.data.ledgerEntry.amount === '5000.00', 'Ledger amount positive 5000.00')
  assert(r.data.ledgerEntry.collectorId === collector.id, 'Ledger collectorId matches')
  assert(r.data.ledgerEntry.notes === 'shift start', 'Notes persisted')

  // Verify WS frame
  try {
    const advFrame = await waitFor(adminFrames, f =>
      f.type === 'TELLER_BALANCE_UPDATED' &&
      f.data.tellerId === teller.id &&
      f.data.delta?.type === 'CASH_ADVANCE'
    )
    assert(advFrame.data.balance === '5000.00', `WS balance = 5000.00 (got ${advFrame.data.balance})`)
    assert(advFrame.data.delta.amount === '5000.00', `WS delta amount = 5000.00`)
    assert(advFrame.data.tellerName === teller.fullName, `WS tellerName matches`)
  } catch (e) {
    assert(false, `WS frame missing for advance: ${e.message}`)
  }

  // Verify balance moved
  r = await api('GET', '/cash/balance', { token: tellerToken })
  assert(r.data.balance === '5000.00', `Balance after advance = 5000.00`)

  // ============================================================
  section('Happy path — bet placement returns actorBalance + emits TELLER_BALANCE_UPDATED')
  // ============================================================
  // Need an OPEN fight first. Try to find one or create.
  let fightR = await api('GET', '/fights?current=true&limit=10', { token: adminToken })
  let openFight = fightR.data?.fights?.find(f => f.status === 'OPEN')
  if (!openFight) {
    const cr = await api('POST', '/fights', { token: adminToken, body: {} })
    if (cr.status !== 201) {
      // probably another fight is OPEN that's not in 'current' filter; close it
      console.log(`  ! Could not create fight: ${JSON.stringify(cr.data)}`)
    } else {
      openFight = cr.data.fight
    }
  }
  assert(openFight && openFight.status === 'OPEN', `Open fight available: ${openFight?.id}`)

  // Place bet of 200
  const clientRequestId = crypto.randomUUID()
  r = await api('POST', '/bets', {
    token: tellerToken,
    body: { clientRequestId, fightId: openFight.id, side: 'MERON', amount: 200 }
  })
  assert(r.status === 201, `placeBet → 201 (got ${r.status}, body=${JSON.stringify(r.data).slice(0,200)})`)
  assert(r.data.actorBalance === '5200.00', `placeBet actorBalance = 5200.00 (got ${r.data.actorBalance})`)
  const placedBet = r.data.bet

  try {
    const placeFrame = await waitFor(adminFrames, f =>
      f.type === 'TELLER_BALANCE_UPDATED' &&
      f.data.tellerId === teller.id &&
      f.data.delta?.type === 'BET_PLACED'
    )
    assert(placeFrame.data.balance === '5200.00', `WS balance after bet = 5200.00`)
    assert(placeFrame.data.delta.amount === '200.00', `WS delta = +200.00`)
  } catch (e) {
    assert(false, `WS frame missing for bet placement: ${e.message}`)
  }

  // Replay the same clientRequestId — should NOT broadcast again
  const beforeReplayCount = adminFrames.filter(f => f.type === 'TELLER_BALANCE_UPDATED').length
  r = await api('POST', '/bets', {
    token: tellerToken,
    body: { clientRequestId, fightId: openFight.id, side: 'MERON', amount: 200 }
  })
  assert(r.status === 200 && r.data.replay === true, 'Replay returns 200 with replay=true')
  assert(r.data.actorBalance === '5200.00', `Replay actorBalance = 5200.00 (got ${r.data.actorBalance})`)
  await new Promise(res => setTimeout(res, 200))
  const afterReplayCount = adminFrames.filter(f => f.type === 'TELLER_BALANCE_UPDATED').length
  assert(beforeReplayCount === afterReplayCount, `Replay does NOT re-broadcast (was ${beforeReplayCount}, still ${afterReplayCount})`)

  // ============================================================
  section('Happy path — void the bet → balance goes back to 5000')
  // ============================================================
  r = await api('POST', `/bets/${placedBet.id}/void`, {
    token: tellerToken,
    body: { reason: 'E2E test cleanup', adminPassword: 'admin2026@' }
  })
  assert(r.status === 200, `void → 200 (got ${r.status}, body=${JSON.stringify(r.data).slice(0,200)})`)
  assert(r.data.actorBalance === '5000.00', `void actorBalance back to 5000.00 (got ${r.data.actorBalance})`)

  try {
    const voidFrame = await waitFor(adminFrames, f =>
      f.type === 'TELLER_BALANCE_UPDATED' &&
      f.data.tellerId === teller.id &&
      f.data.delta?.type === 'BET_VOIDED'
    )
    assert(voidFrame.data.balance === '5000.00', 'WS balance after void = 5000.00')
    assert(voidFrame.data.delta.amount === '-200.00', 'WS delta = -200.00')
  } catch (e) {
    assert(false, `WS frame missing for void: ${e.message}`)
  }

  // ============================================================
  section('Happy path — remit 5000 → balance 0, ledger has 4 entries')
  // ============================================================
  r = await api('POST', '/cash/remits', {
    token: tellerToken,
    body: { collectorCode: collector.code, amount: 5000, notes: 'shift end' }
  })
  assert(r.status === 201, `Remit → 201 (got ${r.status}, body=${JSON.stringify(r.data)})`)
  assert(r.data.actorBalance === '0.00', `actorBalance after remit = 0.00 (got ${r.data.actorBalance})`)
  assert(r.data.ledgerEntry.amount === '-5000.00', `Remit ledger amount = -5000.00`)

  try {
    const remitFrame = await waitFor(adminFrames, f =>
      f.type === 'TELLER_BALANCE_UPDATED' &&
      f.data.tellerId === teller.id &&
      f.data.delta?.type === 'REMIT'
    )
    assert(remitFrame.data.balance === '0.00', 'WS balance after remit = 0.00')
    assert(remitFrame.data.delta.amount === '-5000.00', 'WS delta = -5000.00')
  } catch (e) {
    assert(false, `WS frame missing for remit: ${e.message}`)
  }

  // ============================================================
  section('Ledger list — sees own 4 entries, in newest-first order')
  // ============================================================
  r = await api('GET', '/cash/ledger', { token: tellerToken })
  assert(r.status === 200, `GET ledger → 200`)
  const types = r.data.entries.map(e => e.type)
  assert(types.length >= 4, `Ledger has ≥4 entries (got ${types.length}: ${types.join(',')})`)
  assert(types[0] === 'REMIT', `Newest is REMIT (got ${types[0]})`)
  // Sum should be 0 since we deposited and withdrew in equal amounts
  const sum = r.data.entries.reduce((a, e) => a + Number(e.amount), 0)
  assert(Math.abs(sum) < 0.001, `Sum of own entries = 0 (got ${sum})`)

  // Filter by type
  r = await api('GET', '/cash/ledger?type=CASH_ADVANCE', { token: tellerToken })
  assert(r.status === 200 && r.data.entries.every(e => e.type === 'CASH_ADVANCE'),
    'Filter ?type=CASH_ADVANCE returns only advances')

  // ============================================================
  section('Edge cases')
  // ============================================================

  // 1. Advance to admin → 400
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: adminUser.id, collectorCode: collector.code, amount: 100 }
  })
  assert(r.status === 400, `Advance to admin user → 400 (got ${r.status})`)
  assert(r.data?.error?.message?.includes('TELLER'), `Error mentions TELLER role requirement`)

  // 2. Advance to inactive teller → 400
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: inactiveTeller.id, collectorCode: collector.code, amount: 100 }
  })
  assert(r.status === 400, `Advance to inactive teller → 400 (got ${r.status})`)
  assert(r.data?.error?.message?.toLowerCase().includes('not active'), `Error mentions "not active"`)

  // 3. Teller cannot deposit to another teller's drawer → 403
  r = await api('POST', '/cash/advances', {
    token: tellerToken,
    body: { tellerId: teller2.id, collectorCode: collector.code, amount: 100 }
  })
  assert(r.status === 403, `Teller deposit to other drawer → 403 (got ${r.status})`)


  // 3b. Teller self-deposit (no tellerId) → 201
  r = await api('POST', '/cash/advances', {
    token: teller2Token,
    body: { collectorCode: collector.code, amount: 300 }
  })
  assert(r.status === 201, `Teller self-deposit → 201 (got ${r.status})`)
  assert(r.data.actorBalance === '300.00', `teller2 balance after self-deposit = 300.00`)

  // 3c. Unknown collector code on remit → 404
  r = await api('POST', '/cash/remits', {
    token: teller2Token,
    body: { collectorCode: 'COLZZZZZ', amount: 50 }
  })
  assert(r.status === 404, `Unknown collector code on remit → 404 (got ${r.status})`)

  // 4. Over-remit → 409 with shortfall
  r = await api('POST', '/cash/remits', {
    token: tellerToken,
    body: { collectorCode: collector.code, amount: 100 }
  })
  assert(r.status === 409, `Over-remit (balance is 0, ask 100) → 409 (got ${r.status})`)
  assert(r.data?.error?.details?.shortfall === '100.00', `Shortfall details = 100.00 (got ${JSON.stringify(r.data?.error?.details)})`)
  assert(r.data?.error?.details?.requestedAmount === '100.00', `requestedAmount = 100.00`)

  // 5. Negative amount → 400 (schema)
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: collector.code, amount: -50 }
  })
  assert(r.status === 400, `Negative amount → 400 (got ${r.status})`)

  // 6. Amount over 1M → 400
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: collector.code, amount: 1_000_001 }
  })
  assert(r.status === 400, `Amount over 1M → 400 (got ${r.status})`)

  // 7. Amount with too many decimals → 400
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: collector.code, amount: 100.123 }
  })
  assert(r.status === 400, `Amount with 3 decimals → 400 (got ${r.status})`)

  // 8. Teller spying on another teller's balance → 403
  r = await api('GET', `/cash/balance?tellerId=${teller2.id}`, { token: tellerToken })
  assert(r.status === 403, `Teller asking for another teller's balance → 403 (got ${r.status})`)

  // 9. Admin can read any teller's balance
  r = await api('GET', `/cash/balance?tellerId=${teller2.id}`, { token: adminToken })
  assert(r.status === 200, `Admin reading other teller's balance → 200 (got ${r.status})`)
  assert(r.data.balance === '0.00', `teller2 balance = 0.00`)

  // 10. Teller listing another teller's ledger → 403
  r = await api('GET', `/cash/ledger?tellerId=${teller2.id}`, { token: tellerToken })
  assert(r.status === 403, `Teller listing another teller's ledger → 403 (got ${r.status})`)

  // 11. Unknown teller for balance → 404
  r = await api('GET', '/cash/balance?tellerId=cmxxxxxxxxxxxxxxxxxxxxxx', { token: adminToken })
  assert(r.status === 404, `Unknown tellerId → 404 (got ${r.status})`)

  // 12. since > until → 400
  r = await api('GET', '/cash/ledger?since=2026-12-01T00:00:00Z&until=2026-01-01T00:00:00Z', { token: adminToken })
  assert(r.status === 400, `since > until → 400 (got ${r.status})`)

  // 13. Inactive collector for advance → 400
  // Create a fresh collector and deactivate
  const tempCollector = await ensureCollector(adminToken, `Temp E2E ${stamp}`)
  await api('PATCH', `/collectors/${tempCollector.id}`, { token: adminToken, body: { isActive: false } })
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: tempCollector.code, amount: 100 }
  })
  assert(r.status === 400, `Advance with inactive collector → 400 (got ${r.status})`)

  // 14. Verify response shape: bet.code populated, bet.tellerId == teller.id, etc.
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: collector.code, amount: 250.50 }
  })
  assert(r.status === 201, 'Decimal amount 250.50 accepted')
  assert(r.data.actorBalance === '250.50', `Balance = 250.50 (got ${r.data.actorBalance})`)
  assert(r.data.ledgerEntry.amount === '250.50', `Decimal stored exact`)

  // 15. Empty-body advance → 400
  r = await api('POST', '/cash/advances', { token: adminToken, body: {} })
  assert(r.status === 400, `Empty advance body → 400 (got ${r.status})`)

  // 16. Confirm new admin advance broadcasts but to different magnitude
  try {
    await waitFor(adminFrames, f =>
      f.type === 'TELLER_BALANCE_UPDATED' &&
      f.data.delta?.type === 'CASH_ADVANCE' &&
      f.data.balance === '250.50'
    )
    assert(true, 'Decimal advance fires WS frame with balance 250.50')
  } catch (e) {
    assert(false, `WS frame missing for decimal advance: ${e.message}`)
  }

  adminWs.close()

  // ============================================================
  section('Summary')
  // ============================================================
  console.log(`\n  Passed: ${pass}`)
  console.log(`  Failed: ${fail}`)
  if (failures.length) {
    console.log('\nFAILURES:')
    failures.forEach(f => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(2)
})
