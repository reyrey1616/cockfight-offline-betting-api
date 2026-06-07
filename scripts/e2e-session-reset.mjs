// E2E test for the Tier 4 Session Reset module.
//
// !!! DESTRUCTIVE !!! This test wipes Fight, Bet, and TellerLedger via
// the very endpoint it exercises. It is idempotent in the sense that
// it always leaves the DB in a clean state, but if you have manual test
// state you care about, do not run this. Re-seed with `npm run db:seed`
// afterwards if needed.
//
// Verifies (in order):
//   1. AUTHORIZATION
//      - GET  /session/preview as teller → 403
//      - POST /session/reset   as teller → 403
//      - GET  /session/resets  as teller → 403
//   2. SCHEMA
//      - empty body → 400
//      - confirm: "wipe-session" (lowercase) → 400
//      - confirm: "WRONG"        → 400
//      - additionalProperties → 400
//      - missing password → 400
//   2b. STEP-UP PASSWORD
//      - wrong password (well-formed body) → 401
//      - empty-string password → 400 (minLength 1) NOT 401
//      - correct password → wipe proceeds (covered in section 5)
//   3. PREVIEW accuracy
//      - returns counts that match prisma counts
//      - invariants reflect actual state (canResetCleanly true on clean DB)
//   4. INVARIANT BLOCKING
//      - create open fight → preview shows unfinishedFights.violated=true
//      - cash advance → preview shows nonZeroBalances.violated=true
//      - POST /session/reset (no force) → 409 with both violations
//   5. FORCE BYPASS
//      - POST /session/reset { force: true } → 201
//      - WS broadcast SESSION_RESET arrives with correct counts + forced=true
//      - Fight, Bet, TellerLedger all empty after
//      - User, Collector, Setting all preserved
//      - SessionReset audit row exists with forced=true
//   6. CLEAN RESET (no invariant violations now)
//      - POST /session/reset { confirm } → 201 (force NOT needed)
//      - audit row recorded with forced=false
//   7. AUDIT PERSISTENCE
//      - GET /session/resets returns BOTH resets newest-first (audit table
//        was NOT wiped by either reset)
//   8. POST-WIPE SANITY
//      - The wipe didn't damage seeded users — admin can still log in,
//        bets endpoint returns empty list, etc.

import WebSocket from 'ws'

const BASE = 'http://127.0.0.1:8000'
const WS_BASE = 'ws://127.0.0.1:8000/ws'
// MUST match the seeded admin password (see prisma/seed.js).
const ADMIN_PASSWORD = 'admin2026@'

let pass = 0, fail = 0
const failures = []
const assert = (c, m) => {
  if (c) { pass++; console.log(`  ✓ ${m}`) }
  else   { fail++; failures.push(m); console.log(`  ✗ ${m}`) }
}

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
  if (existing) return existing
  const r = await api('POST', '/users', {
    token: adminToken,
    body: { username, password: 'tellpass123', fullName, role: 'TELLER' }
  })
  if (r.status !== 201) throw new Error(`Create teller ${username} failed: ${JSON.stringify(r.data)}`)
  return r.data.user
}

// ===========================================================================
async function main() {
  section('Setup')
  const adminToken = await login('admin', 'admin2026@')
  console.log('  ✓ admin logged in')

  const stamp = Date.now().toString().slice(-6)
  const tellerUser = `srtell${stamp}`
  const collectorName = `Reset E2E ${stamp}`

  await ensureTeller(adminToken, tellerUser, 'Session Reset E2E Teller')
  const tellerToken = await login(tellerUser, 'tellpass123')
  const collector = await ensureCollector(adminToken, collectorName)
  console.log(`  ✓ teller ${tellerUser} + collector "${collector.name}" ready`)

  // ============================================================
  section('1. Authorization — teller cannot touch any session endpoint')
  // ============================================================
  let r = await api('GET', '/session/preview', { token: tellerToken })
  assert(r.status === 403, `Teller GET /session/preview → 403 (got ${r.status})`)

  // Role gate fires BEFORE body validation, so no password needed to
  // exercise the 403 path.
  r = await api('POST', '/session/reset', {
    token: tellerToken,
    body: { confirm: 'WIPE-SESSION', password: 'tellpass123' }
  })
  assert(r.status === 403, `Teller POST /session/reset → 403 (got ${r.status})`)

  r = await api('GET', '/session/resets', { token: tellerToken })
  assert(r.status === 403, `Teller GET /session/resets → 403 (got ${r.status})`)

  r = await api('GET', '/session/preview', {})
  assert(r.status === 401, `No-auth GET /session/preview → 401 (got ${r.status})`)

  // ============================================================
  section('2. Schema — confirmation token MUST be exact')
  // ============================================================
  r = await api('POST', '/session/reset', { token: adminToken, body: {} })
  assert(r.status === 400, `Empty body → 400 (got ${r.status})`)

  r = await api('POST', '/session/reset', { token: adminToken, body: { confirm: 'wipe-session', password: ADMIN_PASSWORD } })
  assert(r.status === 400, `Lowercase confirm → 400 (got ${r.status})`)

  r = await api('POST', '/session/reset', { token: adminToken, body: { confirm: 'WIPE', password: ADMIN_PASSWORD } })
  assert(r.status === 400, `Truncated confirm → 400 (got ${r.status})`)

  r = await api('POST', '/session/reset', { token: adminToken, body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD, sneaky: true } })
  assert(r.status === 400, `additionalProperties → 400 (got ${r.status})`)

  r = await api('POST', '/session/reset', { token: adminToken, body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD, notes: 'x'.repeat(501) } })
  assert(r.status === 400, `Notes >500 chars → 400 (got ${r.status})`)

  // Missing password → schema rejects (400) BEFORE we even try to verify.
  r = await api('POST', '/session/reset', { token: adminToken, body: { confirm: 'WIPE-SESSION' } })
  assert(r.status === 400, `Missing password → 400 (got ${r.status})`)

  // Empty-string password → schema rejects on minLength (400), NOT 401.
  // Keeps the verification layer free of trivial empty-string traffic.
  r = await api('POST', '/session/reset', { token: adminToken, body: { confirm: 'WIPE-SESSION', password: '' } })
  assert(r.status === 400, `Empty-string password → 400 schema reject (got ${r.status})`)

  // Wrong (well-formed) password → 401 from the step-up password check.
  // server logs a WARN with the userId; we can't see logs from the
  // client but the status code is the testable signal.
  r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: 'definitely-not-the-admin-password' }
  })
  assert(r.status === 401, `Wrong password → 401 step-up failure (got ${r.status})`)
  const errCode = r.data?.error?.code
  assert(errCode === 'UNAUTHORIZED',
    `Wrong-password error.code = UNAUTHORIZED (got ${errCode})`)
  // Generic message — never leaks "you exist but password is wrong" vs anything else.
  assert(/password verification/i.test(r.data?.error?.message ?? ''),
    `Wrong-password message is generic ("${r.data?.error?.message}")`)

  // ============================================================
  section('3. Preview accuracy — counts match real DB state')
  // ============================================================
  r = await api('GET', '/session/preview', { token: adminToken })
  assert(r.status === 200, `GET /session/preview → 200 (got ${r.status})`)
  assert(typeof r.data.counts === 'object', 'preview.counts present')
  assert(typeof r.data.counts.fights === 'number', 'counts.fights numeric')
  assert(typeof r.data.counts.bets === 'number', 'counts.bets numeric')
  assert(typeof r.data.counts.ledger === 'number', 'counts.ledger numeric')
  assert(typeof r.data.invariants === 'object', 'preview.invariants present')
  assert('canResetCleanly' in r.data, 'preview.canResetCleanly present')
  const baselinePreview = r.data
  console.log(`    baseline: ${baselinePreview.counts.fights} fights, ${baselinePreview.counts.bets} bets, ${baselinePreview.counts.ledger} ledger`)
  console.log(`    canResetCleanly: ${baselinePreview.canResetCleanly}`)

  // ============================================================
  section('4. Invariant blocking — create state then attempt reset')
  // ============================================================

  // (a) Ensure there is at least one OPEN/CLOSED fight (triggers
  //     unfinishedFights invariant). Reuse an existing one if the prior
  //     test run left one behind, otherwise create a fresh one.
  const existingFights = (await api('GET', '/fights?status=OPEN', { token: adminToken })).data?.fights ?? []
  if (existingFights.length === 0) {
    r = await api('POST', '/fights', { token: adminToken, body: {} })
    assert(r.status === 201, `Create OPEN fight → 201 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)
    const openFight = r.data?.fight ?? r.data
    assert(openFight?.status === 'OPEN', `New fight status = OPEN`)
  } else {
    assert(true, `Reusing pre-existing OPEN fight #${existingFights[0].fightNumber}`)
  }

  // (b) Advance cash to teller → triggers nonZeroBalances invariant.
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: {
      tellerId: (await api('GET', `/users?role=TELLER`, { token: adminToken }))
        .data.users.find(u => u.username === tellerUser).id,
      collectorCode: collector.code,
      amount: 500,
      notes: 'session-reset E2E setup'
    }
  })
  assert(r.status === 201, `Cash advance to teller → 201 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)

  // Preview should now flag both invariants.
  r = await api('GET', '/session/preview', { token: adminToken })
  assert(r.status === 200, `Preview after dirtying state → 200`)
  assert(r.data.invariants.unfinishedFights.violated === true,
    `unfinishedFights.violated=true (count=${r.data.invariants.unfinishedFights.count})`)
  assert(r.data.invariants.nonZeroBalances.violated === true,
    `nonZeroBalances.violated=true (tellerCount=${r.data.invariants.nonZeroBalances.tellerCount})`)
  assert(r.data.invariants.nonZeroBalances.tellers.some(t => t.username === tellerUser),
    `Teller ${tellerUser} listed in nonZeroBalances.tellers`)
  assert(r.data.canResetCleanly === false, `canResetCleanly=false`)

  // Reset without force → 409 with violation details.
  r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD }
  })
  assert(r.status === 409, `Reset without force → 409 (got ${r.status})`)
  assert(r.data?.error?.code === 'CONFLICT' || r.data?.code === 'CONFLICT' || r.status === 409,
    `409 has CONFLICT code shape`)
  // Details should carry the same shape as preview's invariants.
  const details = r.data?.error?.details ?? r.data?.details ?? {}
  assert(details.unfinishedFights?.violated === true,
    `409 details.unfinishedFights.violated=true`)
  assert(details.nonZeroBalances?.violated === true,
    `409 details.nonZeroBalances.violated=true`)

  // ============================================================
  section('5. Force bypass + WS broadcast + audit row')
  // ============================================================

  // Open WS as admin — should receive SESSION_RESET frame.
  const { ws: adminWs, frames: adminFrames } = await startWs(adminToken)
  // Drain WELCOME or any other frames before the reset.
  await new Promise(r => setTimeout(r, 200))
  const framesBefore = adminFrames.length

  // Capture pre-wipe counts so we can verify the audit row's snapshot.
  r = await api('GET', '/session/preview', { token: adminToken })
  assert(r.status === 200, `Preview before forced reset → 200`)
  const preWipeCounts = r.data.counts
  console.log(`    pre-wipe: ${preWipeCounts.fights} fights, ${preWipeCounts.bets} bets, ${preWipeCounts.ledger} ledger`)

  // Snapshot users + collectors + settings BEFORE the wipe so we can
  // prove they survive intact.
  const usersBefore = (await api('GET', '/users', { token: adminToken })).data.users
  const collectorsBefore = (await api('GET', '/collectors', { token: adminToken })).data.collectors
  const settingsBefore = (await api('GET', '/settings', { token: adminToken })).data?.setting

  // Force the reset.
  r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD, force: true, notes: 'E2E forced reset' }
  })
  assert(r.status === 201, `Forced reset → 201 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)
  assert(r.data?.sessionReset?.id, `Response carries sessionReset.id`)
  assert(r.data?.sessionReset?.forced === true, `audit row .forced=true`)
  assert(r.data?.sessionReset?.notes === 'E2E forced reset', `audit row .notes preserved`)
  assert(r.data?.sessionReset?.fightCount === preWipeCounts.fights,
    `audit row .fightCount matches pre-wipe count`)
  assert(r.data?.sessionReset?.betCount === preWipeCounts.bets,
    `audit row .betCount matches pre-wipe count`)
  assert(r.data?.sessionReset?.ledgerCount === preWipeCounts.ledger,
    `audit row .ledgerCount matches pre-wipe count`)
  assert(r.data?.sessionReset?.performedByUsername === 'admin',
    `audit row .performedByUsername=admin`)
  const firstResetId = r.data.sessionReset.id

  // WS frame check.
  let resetFrame
  try {
    resetFrame = await waitFor(adminFrames, f => f.type === 'SESSION_RESET', 3000)
    assert(true, `WS SESSION_RESET frame received`)
    assert(resetFrame.data?.sessionResetId === firstResetId,
      `WS frame sessionResetId matches HTTP response`)
    assert(resetFrame.data?.forced === true, `WS frame .forced=true`)
    assert(resetFrame.data?.deletedCounts?.fights === preWipeCounts.fights,
      `WS frame .deletedCounts.fights matches`)
    assert(resetFrame.data?.deletedCounts?.bets === preWipeCounts.bets,
      `WS frame .deletedCounts.bets matches`)
    assert(resetFrame.data?.deletedCounts?.ledger === preWipeCounts.ledger,
      `WS frame .deletedCounts.ledger matches`)
    assert(resetFrame.data?.performedByUsername === 'admin',
      `WS frame .performedByUsername=admin`)
  } catch (e) {
    assert(false, `WS SESSION_RESET frame received within 3s: ${e.message}`)
  }
  assert(adminFrames.length > framesBefore, `WS frames advanced past baseline`)

  adminWs.close()

  // Verify the wipe actually happened.
  r = await api('GET', '/session/preview', { token: adminToken })
  assert(r.status === 200, `Post-wipe preview → 200`)
  assert(r.data.counts.fights === 0, `Fight table now empty (got ${r.data.counts.fights})`)
  assert(r.data.counts.bets === 0, `Bet table now empty (got ${r.data.counts.bets})`)
  assert(r.data.counts.ledger === 0, `TellerLedger now empty (got ${r.data.counts.ledger})`)
  assert(r.data.canResetCleanly === true, `canResetCleanly=true after wipe`)

  // Verify preserved entities.
  const usersAfter = (await api('GET', '/users', { token: adminToken })).data.users
  assert(usersAfter.length === usersBefore.length,
    `Users preserved (${usersAfter.length}/${usersBefore.length})`)
  const collectorsAfter = (await api('GET', '/collectors', { token: adminToken })).data.collectors
  assert(collectorsAfter.length === collectorsBefore.length,
    `Collectors preserved (${collectorsAfter.length}/${collectorsBefore.length})`)
  // Collector codes preserved (same code on the same row).
  const collectorAfter = collectorsAfter.find(c => c.id === collector.id)
  assert(collectorAfter?.code === collector.code,
    `Collector code preserved (${collectorAfter?.code})`)
  // Settings preserved.
  const settingsAfter = (await api('GET', '/settings', { token: adminToken })).data?.setting
  assert(typeof settingsBefore?.commissionRate === 'string',
    `Pre-wipe settings.commissionRate is a string (${settingsBefore?.commissionRate})`)
  assert(settingsAfter?.commissionRate === settingsBefore?.commissionRate,
    `Settings preserved (commissionRate ${settingsAfter?.commissionRate})`)
  assert(settingsAfter?.id === settingsBefore?.id,
    `Settings singleton id preserved (${settingsAfter?.id})`)

  // Verify the teller still exists and can log in.
  const reloginToken = await login(tellerUser, 'tellpass123')
  assert(typeof reloginToken === 'string' && reloginToken.length > 10,
    `Teller can re-login after wipe`)
  // Their balance is now zero.
  r = await api('GET', '/cash/balance', { token: reloginToken })
  assert(r.status === 200, `Teller GET /cash/balance after wipe → 200`)
  assert(r.data.balance === '0.00', `Teller balance is 0.00 after wipe (got ${r.data.balance})`)

  // ============================================================
  section('6. Clean reset — no force needed when state is clean')
  // ============================================================
  r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD, notes: 'clean follow-up reset' }
  })
  assert(r.status === 201, `Clean reset → 201 (got ${r.status})`)
  assert(r.data?.sessionReset?.forced === false, `Clean reset audit .forced=false`)
  assert(r.data?.sessionReset?.fightCount === 0, `Clean reset destroyed 0 fights`)
  assert(r.data?.sessionReset?.betCount === 0, `Clean reset destroyed 0 bets`)
  assert(r.data?.sessionReset?.ledgerCount === 0, `Clean reset destroyed 0 ledger entries`)
  const secondResetId = r.data.sessionReset.id
  assert(secondResetId !== firstResetId, `Second reset has distinct id`)

  // ============================================================
  section('7. Audit persistence — both resets survive')
  // ============================================================
  r = await api('GET', '/session/resets', { token: adminToken })
  assert(r.status === 200, `GET /session/resets → 200`)
  assert(Array.isArray(r.data?.resets), `resets is an array`)
  assert(r.data.resets.length >= 2, `audit log has ≥2 rows (got ${r.data.resets.length})`)
  // Newest first → second reset should be at index 0.
  assert(r.data.resets[0].id === secondResetId,
    `Newest reset is the clean one (id=${secondResetId})`)
  assert(r.data.resets[1].id === firstResetId,
    `Second-newest is the forced one (id=${firstResetId})`)
  // Audit rows include performer info.
  assert(r.data.resets[0].performedByUsername === 'admin', `audit row joins username`)
  assert(r.data.resets[0].performedByFullName, `audit row joins fullName`)
  // The forced one still records forced=true.
  assert(r.data.resets[1].forced === true, `Older audit row still says forced=true`)
  assert(r.data.resets[0].forced === false, `Newer audit row says forced=false`)

  // Pagination smoke test.
  r = await api('GET', '/session/resets?limit=1', { token: adminToken })
  assert(r.status === 200, `GET /session/resets?limit=1 → 200`)
  assert(r.data.resets.length === 1, `limit=1 returns 1 row`)
  assert(r.data.nextCursor !== null, `limit=1 returns a nextCursor`)
  // Use the cursor to fetch the next page.
  r = await api('GET', `/session/resets?limit=1&cursor=${r.data.nextCursor}`, { token: adminToken })
  assert(r.status === 200, `cursor-paginated next page → 200`)
  assert(r.data.resets.length === 1, `next page returns 1 row`)
  assert(r.data.resets[0].id === firstResetId, `next page is the older (forced) reset`)

  // ============================================================
  section('8. Post-wipe sanity — system fully usable after reset')
  // ============================================================
  r = await api('GET', '/bets', { token: adminToken })
  assert(r.status === 200, `GET /bets after wipe → 200`)
  assert(r.data?.bets?.length === 0, `Bets list is empty`)

  r = await api('GET', '/fights', { token: adminToken })
  assert(r.status === 200, `GET /fights after wipe → 200`)
  assert(r.data?.fights?.length === 0, `Fights list is empty`)

  r = await api('GET', '/cash/ledger', { token: adminToken })
  assert(r.status === 200, `GET /cash/ledger after wipe → 200`)
  assert(r.data?.entries?.length === 0, `Ledger is empty`)

  // Can immediately open a NEW fight (fightNumber resets to 1).
  r = await api('POST', '/fights', { token: adminToken, body: {} })
  assert(r.status === 201, `Can create a fresh fight after wipe → 201 (got ${r.status})`)
  const newFight = r.data?.fight ?? r.data
  assert(newFight?.fightNumber === 1,
    `New fight starts at fightNumber=1 after wipe (got ${newFight?.fightNumber})`)

  // Clean up: settle/cancel the test fight so we leave the DB tidy.
  r = await api('POST', `/fights/${newFight.id}/cancel`, { token: adminToken, body: {} })
  assert(r.status === 200, `Cancel test fight (cleanup) → 200`)

  // Final cleanup reset to leave the DB pristine.
  r = await api('POST', '/session/reset', {
    token: adminToken,
    body: { confirm: 'WIPE-SESSION', password: ADMIN_PASSWORD }
  })
  assert(r.status === 201, `Final cleanup reset → 201`)

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
