// Targeted E2E for the payBet → TELLER_BALANCE_UPDATED retrofit.
//
// Flow:
//   1. Admin creates fight + advance to teller (so they have working capital).
//   2. Teller places a bet on MERON.
//   3. Admin closes + settles the fight with MERON winning.
//   4. Teller pays out their own winning ticket.
//   5. Verify response includes actorBalance and a TELLER_BALANCE_UPDATED
//      frame fired with delta.type === 'PAYOUT'.

import WebSocket from 'ws'

const BASE = 'http://127.0.0.1:8000'
const WS_BASE = 'ws://127.0.0.1:8000/ws'
let pass = 0, fail = 0
const failures = []
const assert = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; failures.push(m); console.log(`  ✗ ${m}`) } }

async function api(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })
  let data = null; try { data = await res.json() } catch {}
  return { status: res.status, data }
}

async function login(u, p) {
  const r = await api('POST', '/auth/login', { body: { username: u, password: p } })
  if (r.status !== 200) throw new Error(`login ${u}: ${JSON.stringify(r.data)}`)
  return r.data.token
}

async function startWs(token) {
  const ws = new WebSocket(`${WS_BASE}?token=${token}`)
  const frames = []
  ws.on('message', (b) => { try { frames.push(JSON.parse(b.toString())) } catch {} })
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  return { ws, frames }
}

function waitFor(frames, pred, t = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      const f = frames.find(pred); if (f) return resolve(f)
      if (Date.now() - start > t) return reject(new Error('timeout'))
      setTimeout(tick, 50)
    }; tick()
  })
}

async function main() {
  const adminToken = await login('admin', 'admin2026@')
  console.log('  ✓ admin logged in')

  const list = await api('GET', '/users?role=TELLER', { token: adminToken })
  const teller = list.data.users
    .filter(u => u.username.startsWith('teller') && u.username.length > 6 && u.isActive)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  if (!teller) throw new Error('No teller found — run e2e-cash.mjs first')
  console.log(`  ✓ using teller: ${teller.username} (${teller.id})`)

  const tellerToken = await login(teller.username, 'teller12345')

  const cl = await api('GET', '/collectors?isActive=true', { token: adminToken })
  const collector = cl.data.collectors[0]
  console.log(`  ✓ using collector: ${collector.name}`)

  // Top up teller
  let r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorCode: collector.code, amount: 1000 }
  })
  if (r.status !== 201) throw new Error(`advance failed: ${JSON.stringify(r.data)}`)
  const balanceBeforeBet = Number(r.data.actorBalance)
  console.log(`  ✓ advance OK, balance now ${balanceBeforeBet.toFixed(2)}`)

  // Make sure no other fight is open before creating one
  let openR = await api('GET', '/fights?current=true&limit=10', { token: adminToken })
  let openFight = openR.data.fights.find(f => f.status === 'OPEN')
  if (openFight) {
    // close + cancel to reset state
    console.log(`  · existing OPEN fight ${openFight.fightNumber} — closing+cancelling`)
    await api('POST', `/fights/${openFight.id}/close`, { token: adminToken })
    const cancR = await api('POST', `/fights/${openFight.id}/cancel`, { token: adminToken, body: { reason: 'e2e cleanup' } })
    if (cancR.status >= 300) console.log(`  ! cancel returned ${cancR.status}: ${JSON.stringify(cancR.data)}`)
  }

  r = await api('POST', '/fights', { token: adminToken, body: {} })
  if (r.status !== 201) throw new Error(`create fight failed: ${JSON.stringify(r.data)}`)
  const fight = r.data.fight
  console.log(`  ✓ created fight #${fight.fightNumber} (${fight.id})`)

  // Place 100 on MERON. Capture balance immediately after placement so the
  // post-pay assertion has a deterministic baseline (avoids drift from any
  // prior ledger entries on this teller from previous test runs).
  r = await api('POST', '/bets', {
    token: tellerToken,
    body: { clientRequestId: crypto.randomUUID(), fightId: fight.id, side: 'MERON', amount: 100 }
  })
  if (r.status !== 201) throw new Error(`place bet failed: ${JSON.stringify(r.data)}`)
  const bet = r.data.bet
  const balanceAfterBet = Number(r.data.actorBalance)
  console.log(`  ✓ placed bet ${bet.code} for 100 MERON (balance now ${balanceAfterBet})`)

  // Place an opposing wager so MERON has a payout > 0 after commission
  // Need a second teller for the opposing bet — create one quick
  const stamp2 = Date.now().toString().slice(-5)
  const otherUsername = `teller${stamp2}o`
  await api('POST', '/users', { token: adminToken, body: { username: otherUsername, fullName: 'Opposing Teller', role: 'TELLER' } })
  const otherToken = await login(otherUsername, 'teller12345')
  // Advance + bet on WALA
  await api('POST', '/cash/advances', {
    token: adminToken,
    body: {
      tellerId: (await api('GET', '/auth/me', { token: otherToken })).data.user.id,
      collectorCode: collector.code,
      amount: 500
    }
  })
  r = await api('POST', '/bets', {
    token: otherToken,
    body: { clientRequestId: crypto.randomUUID(), fightId: fight.id, side: 'WALA', amount: 200 }
  })
  if (r.status !== 201) throw new Error(`opposing bet failed: ${JSON.stringify(r.data)}`)
  console.log(`  ✓ opposing teller placed 200 on WALA`)

  // Close + settle MERON wins
  r = await api('POST', `/fights/${fight.id}/close`, { token: adminToken })
  if (r.status >= 300) throw new Error(`close failed: ${JSON.stringify(r.data)}`)
  r = await api('POST', `/fights/${fight.id}/settle`, { token: adminToken, body: { outcome: 'MERON' } })
  if (r.status >= 300) throw new Error(`settle failed: ${JSON.stringify(r.data)}`)
  console.log(`  ✓ fight settled MERON`)

  // Refresh bet to get payoutAmount
  r = await api('GET', `/bets/${bet.id}`, { token: tellerToken })
  console.log(`  ✓ bet now status=${r.data.bet.status} payoutAmount=${r.data.bet.payoutAmount}`)
  if (r.data.bet.status !== 'WON') throw new Error('bet did not win')

  // ── start WS subscribe just before pay ─────────────────────
  const { ws, frames } = await startWs(adminToken)
  console.log('  ✓ admin WS connected for pay broadcast capture')

  r = await api('POST', `/bets/${bet.id}/pay`, { token: tellerToken })
  assert(r.status === 200, `payBet → 200 (got ${r.status})`)
  assert(typeof r.data.actorBalance === 'string', `payBet response includes actorBalance string`)
  assert(r.data.replay === false, 'replay=false on first pay')
  // Pay debits the paying teller by exactly payoutAmount; assert that
  // delta against the post-bet baseline (not the post-advance one — the
  // bet placement itself adds the customer's stake to the drawer).
  const expectedBalance = balanceAfterBet - Number(r.data.bet.payoutAmount)
  assert(Math.abs(Number(r.data.actorBalance) - expectedBalance) < 0.01,
    `Balance after pay = ${expectedBalance.toFixed(2)} (got ${r.data.actorBalance})`)

  // Verify WS broadcast
  try {
    const f = await waitFor(frames, ff =>
      ff.type === 'TELLER_BALANCE_UPDATED' &&
      ff.data.tellerId === teller.id &&
      ff.data.delta?.type === 'PAYOUT'
    )
    assert(f.data.delta.amount.startsWith('-'), `Payout delta is negative (got ${f.data.delta.amount})`)
    assert(f.data.balance === r.data.actorBalance, `WS balance matches HTTP actorBalance`)
  } catch (e) {
    assert(false, `pay TELLER_BALANCE_UPDATED missing: ${e.message}`)
  }

  // Replay pay → 200, replay=true, NO new broadcast
  const beforeReplay = frames.filter(f => f.type === 'TELLER_BALANCE_UPDATED').length
  r = await api('POST', `/bets/${bet.id}/pay`, { token: tellerToken })
  assert(r.status === 200 && r.data.replay === true, 'pay replay → 200 + replay=true')
  await new Promise(res => setTimeout(res, 300))
  const afterReplay = frames.filter(f => f.type === 'TELLER_BALANCE_UPDATED').length
  assert(beforeReplay === afterReplay, `pay replay does NOT re-broadcast (${beforeReplay} → ${afterReplay})`)

  ws.close()

  // Cleanup: deactivate the opposing teller so reruns don't bloat lists
  // (left intentionally — test isolation isn't critical for a dev box)

  console.log(`\n  Passed: ${pass}\n  Failed: ${fail}`)
  if (fail) { failures.forEach(f => console.log(`  - ${f}`)); process.exit(1) }
  process.exit(0)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
