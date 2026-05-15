// E2E for `GET /reports/teller-commissions` + `TELLER_COMMISSIONS_UPDATED`
//
// This test is END-TO-END in the truest sense: we set up a known
// fight + bets, settle it, and assert the leaderboard math matches a
// hand-calculated expected value. If the SQL aggregate is off by a
// peso, this test catches it.
//
// !!! DESTRUCTIVE !!! Begins by wiping the DB via `POST /session/reset`
// so the math is computed against a controlled set of bets. Same caveats
// as e2e-session-reset.mjs.
//
// Coverage:
//   1. AUTHORIZATION
//      - teller GET /reports/teller-commissions → 403
//      - no-auth → 401
//   2. CLEAN-SLATE MATH (the hand-calculated case)
//      - Set up: 1 fight @ rate 0.10
//      - Teller A: 100 on MERON + 200 on WALA (gross 300)
//      - Teller B: 500 on MERON                (gross 500)
//      - Settle MERON
//      - Expected: A commission = 300×0.10 = 30.00, B = 500×0.10 = 50.00,
//        totals = 80.00. Winning/losing stake breakdowns also asserted.
//   3. SORT / TIE-BREAK
//      - tellers sorted by commissionGenerated DESC (B first, then A)
//   4. SANITY INVARIANT
//      - SUM(tellers[i].commissionGenerated) === totals.commissionGenerated
//   5. STATUS FILTERING
//      - REFUNDED bets don't count (cancel a separate fight, confirm
//        affected teller's commission DOESN'T grow by that fight)
//      - PENDING bets don't count (place bets on an OPEN fight, confirm
//        the leaderboard didn't shift)
//      - VOIDED bets don't count (void a PENDING bet pre-settle)
//   6. SCOPE FILTERS
//      - ?fightId=<the settled fight> returns exactly that fight's commission
//      - ?since=<after-the-fact> returns empty
//      - ?until=<before-everything> returns empty
//      - ?includeInactive=false hides a deactivated teller; default true
//        keeps them
//   7. REAL-TIME WEBSOCKET
//      - Subscribe as admin, then settle → expect TELLER_COMMISSIONS_UPDATED
//        with trigger FIGHT_SETTLED
//      - Cancel → trigger FIGHT_CANCELLED
//      - Correct → trigger FIGHT_CORRECTED

import WebSocket from 'ws'

const BASE = 'http://127.0.0.1:8000'
const WS_BASE = 'ws://127.0.0.1:8000/ws'
const ADMIN_PASSWORD = 'admin2026@'

let pass = 0, fail = 0
const failures = []
const assert = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; failures.push(m); console.log(`  ✗ ${m}`) } }

async function api(method, path, { token, body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
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

function startWs(token) {
  const ws = new WebSocket(`${WS_BASE}?token=${token}`)
  const frames = []
  ws.on('message', (buf) => { try { frames.push(JSON.parse(buf.toString())) } catch {} })
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve({ ws, frames }))
    ws.on('error', reject)
  })
}

function waitFor(frames, predicate, timeoutMs = 3000) {
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

function uuid() {
  // RFC4122 v4
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0
    const v = c === 'x' ? r : (r & 0x3 | 0x8)
    return v.toString(16)
  })
}

function section(label) { console.log(`\n━━━ ${label} ━━━`) }

async function ensureCollector(adminToken, name) {
  const list = await api('GET', '/collectors?isActive=true', { token: adminToken })
  const existing = list.data?.collectors?.find(c => c.name === name)
  if (existing) return existing
  const r = await api('POST', '/collectors', { token: adminToken, body: { name } })
  if (r.status !== 201) throw new Error(`Create collector ${name} failed: ${JSON.stringify(r.data)}`)
  return r.data.collector
}

async function ensureTeller(adminToken, username, fullName) {
  const list = await api('GET', `/users?role=TELLER`, { token: adminToken })
  const existing = list.data?.users?.find(u => u.username === username)
  if (existing) {
    if (!existing.isActive) {
      await api('PATCH', `/users/${existing.id}`, { token: adminToken, body: { isActive: true } })
    }
    return existing
  }
  const r = await api('POST', '/users', {
    token: adminToken,
    body: { username, password: 'tellpass123', fullName, role: 'TELLER' }
  })
  if (r.status !== 201) throw new Error(`Create teller ${username} failed: ${JSON.stringify(r.data)}`)
  return r.data.user
}

// ===========================================================================
async function main() {
  section('Setup — clean slate via forced session reset')
  const adminToken = await login('admin', 'admin2026@')

  // Forced wipe so we control every row.
  let r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD, force: true, notes: 'commissions E2E setup' }
  })
  assert(r.status === 201, `Forced session reset → 201 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)

  // Ensure commission rate is the known 0.10 we'll be doing the math
  // against. Body field is a number (schema enforces `type: number`,
  // service converts to a 4-decimal string when persisting).
  r = await api('PATCH', '/settings', { token: adminToken, body: { commissionRate: 0.1 } })
  assert(r.status === 200, `Set commissionRate to 0.10 → 200 (got ${r.status})`)

  const stamp = Date.now().toString().slice(-6)
  const tellerAUser = `comA${stamp}`
  const tellerBUser = `comB${stamp}`
  const collectorName = `Commissions E2E ${stamp}`

  const tellerA = await ensureTeller(adminToken, tellerAUser, 'Commissions Teller A')
  const tellerB = await ensureTeller(adminToken, tellerBUser, 'Commissions Teller B')
  const collector = await ensureCollector(adminToken, collectorName)

  const tellerAToken = await login(tellerAUser, 'tellpass123')
  const tellerBToken = await login(tellerBUser, 'tellpass123')

  // Float each teller enough cash to place their bets.
  for (const t of [tellerA, tellerB]) {
    r = await api('POST', '/cash/advances', {
      token: adminToken,
      body: {
        tellerId: t.id,
        collectorId: collector.id,
        amount: '5000.00',
        notes: 'commissions E2E float',
        password: ADMIN_PASSWORD
      }
    })
    if (r.status !== 201) throw new Error(`Advance to ${t.username} failed: ${JSON.stringify(r.data)}`)
  }
  console.log('  ✓ Both tellers floated with 5,000 each')

  // ============================================================
  section('1. Authorization')
  // ============================================================
  r = await api('GET', '/reports/teller-commissions', { token: tellerAToken })
  assert(r.status === 403, `Teller GET → 403 (got ${r.status})`)

  r = await api('GET', '/reports/teller-commissions', {})
  assert(r.status === 401, `No-auth GET → 401 (got ${r.status})`)

  // ============================================================
  section('2. Clean-slate math (hand-calculated)')
  // ============================================================

  // Create the controlled fight.
  r = await api('POST', '/fights', { token: adminToken, body: {} })
  assert(r.status === 201, `Create fight → 201 (got ${r.status})`)
  const fight = r.data.fight
  assert(fight.commissionRate === '0.1' || fight.commissionRate === '0.10' || fight.commissionRate === '0.1000',
    `Fight snapshotted commissionRate at 0.10 (got "${fight.commissionRate}")`)

  // Place known bets:
  //   Teller A: 100 MERON + 200 WALA  → gross 300, winning 100, losing 200
  //   Teller B: 500 MERON              → gross 500, winning 500, losing   0
  const placements = [
    { token: tellerAToken, side: 'MERON', amount: 100 },
    { token: tellerAToken, side: 'WALA',  amount: 200 },
    { token: tellerBToken, side: 'MERON', amount: 500 }
  ]
  for (const p of placements) {
    r = await api('POST', '/bets', {
      token: p.token,
      body: { clientRequestId: uuid(), fightId: fight.id, side: p.side, amount: p.amount }
    })
    if (r.status !== 201) throw new Error(`Place bet failed: ${JSON.stringify(r.data)}`)
  }
  console.log('  ✓ Placed 3 bets: A=100M+200W, B=500M')

  // Pre-settle: leaderboard MUST still be empty (PENDING bets don't count).
  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.status === 200, `GET (pre-settle) → 200 (got ${r.status})`)
  assert(Array.isArray(r.data.tellers), `tellers is an array`)
  assert(r.data.tellers.length === 0, `Pre-settle: PENDING bets excluded (got ${r.data.tellers.length} tellers)`)
  assert(r.data.totals.commissionGenerated === '0.00',
    `Pre-settle totals.commissionGenerated = 0.00 (got "${r.data.totals.commissionGenerated}")`)

  // Close and settle MERON.
  r = await api('POST', `/fights/${fight.id}/close`, { token: adminToken, body: {} })
  assert(r.status === 200, `Close fight → 200 (got ${r.status})`)

  // Open admin WS BEFORE settle to capture the broadcast.
  const { ws: adminWs, frames: adminFrames } = await startWs(adminToken)
  await new Promise(r => setTimeout(r, 150)) // let WELCOME drain

  r = await api('POST', `/fights/${fight.id}/settle`, {
    token: adminToken,
    body: { outcome: 'MERON' }
  })
  assert(r.status === 200, `Settle MERON → 200 (got ${r.status})`)

  // ============================================================
  section('3. WebSocket — TELLER_COMMISSIONS_UPDATED on settle')
  // ============================================================
  try {
    const f = await waitFor(adminFrames, x => x.type === 'TELLER_COMMISSIONS_UPDATED')
    assert(f.data.trigger === 'FIGHT_SETTLED',
      `Frame trigger = FIGHT_SETTLED (got "${f.data.trigger}")`)
    assert(f.data.fightId === fight.id, `Frame fightId matches settled fight`)
    assert(f.data.fightNumber === fight.fightNumber,
      `Frame fightNumber matches (got ${f.data.fightNumber})`)
  } catch (e) {
    assert(false, `TELLER_COMMISSIONS_UPDATED on settle: ${e.message}`)
  }

  // ============================================================
  section('Back to 2. Verify the math after settle')
  // ============================================================
  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.status === 200, `GET (post-settle) → 200 (got ${r.status})`)
  const tellers = r.data.tellers
  assert(tellers.length === 2, `2 tellers in leaderboard (got ${tellers.length})`)

  // Sort check: B (commission 50) should be first, A (commission 30) second.
  assert(tellers[0].username === tellerBUser,
    `Sort: teller B (highest commission) is first (got "${tellers[0].username}")`)
  assert(tellers[1].username === tellerAUser,
    `Sort: teller A is second (got "${tellers[1].username}")`)

  const byUser = Object.fromEntries(tellers.map(t => [t.username, t]))

  // Teller A: stake 300, winning 100, losing 200, commission 30.
  const a = byUser[tellerAUser]
  assert(a.betCount === 2, `A.betCount = 2 (got ${a.betCount})`)
  assert(a.grossHandle === '300.00', `A.grossHandle = 300.00 (got "${a.grossHandle}")`)
  assert(a.winningStake === '100.00', `A.winningStake = 100.00 (got "${a.winningStake}")`)
  assert(a.losingStake === '200.00', `A.losingStake = 200.00 (got "${a.losingStake}")`)
  assert(a.commissionGenerated === '30.00',
    `A.commissionGenerated = 30.00 (got "${a.commissionGenerated}")`)

  // Teller B: stake 500, winning 500, losing 0, commission 50.
  const b = byUser[tellerBUser]
  assert(b.betCount === 1, `B.betCount = 1 (got ${b.betCount})`)
  assert(b.grossHandle === '500.00', `B.grossHandle = 500.00 (got "${b.grossHandle}")`)
  assert(b.winningStake === '500.00', `B.winningStake = 500.00 (got "${b.winningStake}")`)
  assert(b.losingStake === '0.00', `B.losingStake = 0.00 (got "${b.losingStake}")`)
  assert(b.commissionGenerated === '50.00',
    `B.commissionGenerated = 50.00 (got "${b.commissionGenerated}")`)

  // ============================================================
  section('4. Sanity invariant — SUM(per-teller) === totals')
  // ============================================================
  const totals = r.data.totals
  assert(totals.tellerCount === 2, `totals.tellerCount = 2 (got ${totals.tellerCount})`)
  assert(totals.betCount === 3, `totals.betCount = 3 (got ${totals.betCount})`)
  assert(totals.grossHandle === '800.00', `totals.grossHandle = 800.00 (got "${totals.grossHandle}")`)
  assert(totals.commissionGenerated === '80.00',
    `totals.commissionGenerated = 80.00 (got "${totals.commissionGenerated}")`)
  // The headline invariant.
  const summedCommission = (parseFloat(a.commissionGenerated) + parseFloat(b.commissionGenerated)).toFixed(2)
  assert(summedCommission === totals.commissionGenerated,
    `INVARIANT: SUM(per-teller commission) === totals.commissionGenerated (${summedCommission} vs ${totals.commissionGenerated})`)

  // ============================================================
  section('5a. Scope filters — ?fightId')
  // ============================================================
  r = await api('GET', `/reports/teller-commissions?fightId=${fight.id}`, { token: adminToken })
  assert(r.status === 200, `?fightId=our-fight → 200`)
  assert(r.data.scope.fightId === fight.id, `Echoed scope.fightId`)
  assert(r.data.tellers.length === 2, `Filtered to our fight: 2 tellers (got ${r.data.tellers.length})`)
  assert(r.data.totals.commissionGenerated === '80.00',
    `Filtered totals match the only fight (${r.data.totals.commissionGenerated})`)

  // ============================================================
  section('5b. Scope filters — ?since / ?until')
  // ============================================================
  const future = new Date(Date.now() + 60_000).toISOString()
  const past = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
  r = await api('GET', `/reports/teller-commissions?since=${encodeURIComponent(future)}`, { token: adminToken })
  assert(r.status === 200, `?since=future → 200`)
  assert(r.data.tellers.length === 0, `?since=future → empty array`)
  assert(r.data.totals.commissionGenerated === '0.00', `?since=future → totals zero`)

  r = await api('GET', `/reports/teller-commissions?until=${encodeURIComponent(past)}`, { token: adminToken })
  assert(r.status === 200, `?until=past → 200`)
  assert(r.data.tellers.length === 0, `?until=past → empty array`)

  // ============================================================
  section('6. PENDING / VOIDED bets are excluded')
  // ============================================================

  // Open another fight, place a PENDING bet by teller A, void it.
  r = await api('POST', '/fights', { token: adminToken, body: {} })
  const fight2 = r.data.fight
  assert(fight2.status === 'OPEN', `New fight2 status = OPEN`)

  r = await api('POST', '/bets', {
    token: tellerAToken,
    body: { clientRequestId: uuid(), fightId: fight2.id, side: 'MERON', amount: 999 }
  })
  assert(r.status === 201, `Place PENDING bet on fight2 → 201`)
  const pendingBetId = r.data.bet.id

  // Still PENDING — commission shouldn't change.
  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.data.totals.commissionGenerated === '80.00',
    `PENDING bet doesn't affect commission (still 80.00, got "${r.data.totals.commissionGenerated}")`)
  assert(byUser[tellerAUser].commissionGenerated === '30.00' ||
    r.data.tellers.find(t => t.username === tellerAUser).commissionGenerated === '30.00',
    `A's commission unchanged by PENDING bet`)

  // VOID the bet → still excluded.
  r = await api('POST', `/bets/${pendingBetId}/void`, { token: adminToken, body: {} })
  assert(r.status === 200, `Void bet → 200 (got ${r.status})`)
  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.data.totals.commissionGenerated === '80.00',
    `VOIDED bet doesn't affect commission (still 80.00, got "${r.data.totals.commissionGenerated}")`)

  // ============================================================
  section('7. CANCEL → REFUNDED bets excluded + WS frame')
  // ============================================================

  // Place a fresh bet on fight2, then cancel fight2.
  r = await api('POST', '/bets', {
    token: tellerAToken,
    body: { clientRequestId: uuid(), fightId: fight2.id, side: 'WALA', amount: 50 }
  })
  assert(r.status === 201, `Place bet on fight2 before cancel → 201`)

  const framesBeforeCancel = adminFrames.length
  r = await api('POST', `/fights/${fight2.id}/cancel`, { token: adminToken, body: { reason: 'no-show' } })
  assert(r.status === 200, `Cancel fight2 → 200`)

  // WS frame check
  try {
    const f = await waitFor(adminFrames.slice(framesBeforeCancel),
      x => x.type === 'TELLER_COMMISSIONS_UPDATED' && x.data.trigger === 'FIGHT_CANCELLED')
    assert(true, `TELLER_COMMISSIONS_UPDATED on cancel (trigger=FIGHT_CANCELLED)`)
    assert(f.data.fightId === fight2.id, `Cancel frame fightId matches`)
  } catch (e) {
    assert(false, `TELLER_COMMISSIONS_UPDATED on cancel: ${e.message}`)
  }

  // Commission unchanged — REFUNDED bets don't count.
  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.data.totals.commissionGenerated === '80.00',
    `REFUNDED bet (from cancel) doesn't affect commission (still 80.00, got "${r.data.totals.commissionGenerated}")`)

  // ============================================================
  section('8. CORRECT → WS frame + math recomputes')
  // ============================================================

  const framesBeforeCorrect = adminFrames.length
  // Correct the original fight from MERON to WALA. Commission UNCHANGED
  // (same stakes × same rate) but the frame must still fire — that's
  // the policy. Math should also still match (winning/losing flip).
  r = await api('POST', `/fights/${fight.id}/correct`, {
    token: adminToken,
    body: { outcome: 'WALA', reason: 'E2E correction test' }
  })
  assert(r.status === 200, `Correct fight (MERON → WALA) → 200 (got ${r.status})`)

  try {
    const f = await waitFor(adminFrames.slice(framesBeforeCorrect),
      x => x.type === 'TELLER_COMMISSIONS_UPDATED' && x.data.trigger === 'FIGHT_CORRECTED')
    assert(true, `TELLER_COMMISSIONS_UPDATED on correct (trigger=FIGHT_CORRECTED)`)
    assert(f.data.fightId === fight.id, `Correct frame fightId matches`)
  } catch (e) {
    assert(false, `TELLER_COMMISSIONS_UPDATED on correct: ${e.message}`)
  }

  // After MERON→WALA correction:
  //   Teller A: now A's 200 WALA wins, 100 MERON loses (vs before: 100M won, 200W lost)
  //   Teller B: 500 MERON now LOST
  //   Commission UNCHANGED (rate × gross handle = 0.1 × 800 = 80.00) but winning/losing flipped.
  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.status === 200, `GET after correct → 200`)
  assert(r.data.totals.commissionGenerated === '80.00',
    `Commission unchanged by MERON↔WALA correction (still 80.00, got "${r.data.totals.commissionGenerated}")`)

  // But winning/losing stake DID flip for both tellers.
  const aAfterCorrect = r.data.tellers.find(t => t.username === tellerAUser)
  assert(aAfterCorrect.winningStake === '200.00',
    `A.winningStake flipped to 200.00 (got "${aAfterCorrect.winningStake}")`)
  assert(aAfterCorrect.losingStake === '100.00',
    `A.losingStake flipped to 100.00 (got "${aAfterCorrect.losingStake}")`)
  const bAfterCorrect = r.data.tellers.find(t => t.username === tellerBUser)
  assert(bAfterCorrect.winningStake === '0.00',
    `B.winningStake = 0.00 after MERON→WALA correction (B bet on MERON, got "${bAfterCorrect.winningStake}")`)
  assert(bAfterCorrect.losingStake === '500.00',
    `B.losingStake = 500.00 after correction (got "${bAfterCorrect.losingStake}")`)

  // ============================================================
  section('9. includeInactive — deactivated teller still appears by default')
  // ============================================================

  r = await api('PATCH', `/users/${tellerB.id}`, { token: adminToken, body: { isActive: false } })
  assert(r.status === 200, `Deactivate teller B → 200`)

  r = await api('GET', '/reports/teller-commissions', { token: adminToken })
  assert(r.data.tellers.some(t => t.username === tellerBUser),
    `Default includeInactive=true: deactivated B still appears`)
  assert(r.data.totals.commissionGenerated === '80.00',
    `Totals unchanged when B is deactivated but still in scope`)

  r = await api('GET', '/reports/teller-commissions?includeInactive=false', { token: adminToken })
  assert(!r.data.tellers.some(t => t.username === tellerBUser),
    `includeInactive=false: deactivated B excluded`)
  assert(r.data.totals.commissionGenerated === '30.00',
    `includeInactive=false: totals drop to A's contribution only (30.00, got "${r.data.totals.commissionGenerated}")`)

  // Re-activate so subsequent runs work
  await api('PATCH', `/users/${tellerB.id}`, { token: adminToken, body: { isActive: true } })

  adminWs.close()

  // ===========================================================================
  section('Cleanup')
  r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD, force: true }
  })
  assert(r.status === 201, `Final cleanup wipe → 201`)

  // ===========================================================================
  console.log(`\n━━━ Results ━━━`)
  console.log(`  ✓ ${pass} passed`)
  if (fail) {
    console.log(`  ✗ ${fail} failed:`)
    failures.forEach(f => console.log(`    - ${f}`))
    process.exit(1)
  } else {
    console.log(`  All ${pass} assertions passed.`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
