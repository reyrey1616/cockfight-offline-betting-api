// E2E test for the collector and cash-ledger barcode features.
//
// Verifies:
//   1. Backfill: pre-existing collectors and cash-ledger rows have codes.
//   2. Generation: NEW collectors get a "COL…" code; NEW advances get
//      "ADV…"; NEW remits get "REM…". All codes match the alphabet
//      regex and are unique.
//   3. Lookup endpoints:
//      - GET /collectors/code/:code returns the collector (including
//        retired ones — UI uses isActive to decide what to do)
//      - GET /cash/ledger/code/:code returns the ledger row, scoped:
//        * teller can fetch their own → 200
//        * teller fetching another teller's code → 404 (not 403, no
//          enumeration leak)
//        * admin can fetch any → 200
//   4. Format guards:
//      - bad code shape (lowercase, wrong length) → 400 schema reject
//      - well-formed but unknown code → 404
//   5. Bet ticket codes still work (refactored ticket-code.js).
//   6. Bet-derived ledger rows have code: null (BET_PLACED etc.).

const BASE = 'http://127.0.0.1:8000'

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

const COLLECTOR_CODE_RE = /^COL[A-Z0-9]{5}$/
const ADVANCE_CODE_RE = /^ADV[A-Z0-9]{5}$/
const REMIT_CODE_RE = /^REM[A-Z0-9]{5}$/
// Reduced alphabet: no I/L/O/S/Z/0/1/2/5
const FORBIDDEN_CHARS_RE = /[ILOSZ0125]/

function section(label) { console.log(`\n━━━ ${label} ━━━`) }

async function main() {
  section('Setup')
  const adminToken = await login('admin', 'admin2026@')
  console.log('  ✓ admin logged in')

  // ============================================================
  section('Backfill verification — pre-existing data has codes')
  // ============================================================
  let r = await api('GET', '/collectors', { token: adminToken })
  assert(r.status === 200, `GET /collectors → 200`)
  const allCollectors = r.data.collectors
  assert(allCollectors.length > 0, `Have at least 1 collector to inspect (got ${allCollectors.length})`)
  for (const c of allCollectors) {
    assert(typeof c.code === 'string' && COLLECTOR_CODE_RE.test(c.code),
      `Collector "${c.name}" has valid code "${c.code}"`)
    // Reduced-alphabet check on the random portion
    const random = c.code.slice(3)
    assert(!FORBIDDEN_CHARS_RE.test(random),
      `Collector code random portion "${random}" uses reduced alphabet only`)
  }
  // Codes are unique
  const codeSet = new Set(allCollectors.map(c => c.code))
  assert(codeSet.size === allCollectors.length,
    `All collector codes unique (${codeSet.size}/${allCollectors.length})`)

  // ============================================================
  section('NEW collector creation issues a code')
  // ============================================================
  const stamp = Date.now().toString().slice(-6)
  r = await api('POST', '/collectors', {
    token: adminToken,
    body: { name: `Codes E2E ${stamp}` }
  })
  assert(r.status === 201, `POST /collectors → 201 (got ${r.status})`)
  const newCollector = r.data.collector
  assert(COLLECTOR_CODE_RE.test(newCollector.code),
    `New collector code "${newCollector.code}" matches COL[A-Z0-9]{5}`)
  assert(!FORBIDDEN_CHARS_RE.test(newCollector.code.slice(3)),
    `New collector random portion uses reduced alphabet`)

  // ============================================================
  section('GET /collectors/code/:code lookup')
  // ============================================================
  r = await api('GET', `/collectors/code/${newCollector.code}`, { token: adminToken })
  assert(r.status === 200, `Scan known code → 200 (got ${r.status})`)
  assert(r.data.collector.id === newCollector.id, `Scan returns same collector`)
  assert(r.data.collector.code === newCollector.code, `Returned code matches`)

  // Retired collector is still resolvable (UI decides what to do)
  await api('PATCH', `/collectors/${newCollector.id}`, {
    token: adminToken, body: { isActive: false }
  })
  r = await api('GET', `/collectors/code/${newCollector.code}`, { token: adminToken })
  assert(r.status === 200, `Retired collector still resolvable by code`)
  assert(r.data.collector.isActive === false, `isActive=false surfaces honestly`)
  // Reactivate so downstream cash tests can use it
  await api('PATCH', `/collectors/${newCollector.id}`, {
    token: adminToken, body: { isActive: true }
  })

  // Bad shape → 400
  r = await api('GET', '/collectors/code/colabcde', { token: adminToken })
  assert(r.status === 400, `Lowercase code → 400 schema reject (got ${r.status})`)
  r = await api('GET', '/collectors/code/COLABC', { token: adminToken })
  assert(r.status === 400, `Too-short code → 400 schema reject (got ${r.status})`)
  r = await api('GET', '/collectors/code/XYZABCDE', { token: adminToken })
  assert(r.status === 400, `Wrong prefix → 400 schema reject (got ${r.status})`)

  // Well-formed but unknown code → 404
  r = await api('GET', '/collectors/code/COLZZZZZ', { token: adminToken })
  assert(r.status === 404, `Well-formed but unknown code → 404 (got ${r.status})`)

  // Tellers can also use it (anyAuth)
  // Need a teller token — find one or create one
  const usersR = await api('GET', '/users?role=TELLER', { token: adminToken })
  const teller = usersR.data.users.find(u => u.isActive)
  // Ensure teller has the known password (try login; if fail, reset)
  let tellerToken
  try {
    tellerToken = await login(teller.username, 'teller12345')
  } catch {
    await api('POST', `/users/${teller.id}/password`, {
      token: adminToken, body: { newPassword: 'teller12345' }
    })
    tellerToken = await login(teller.username, 'teller12345')
  }
  r = await api('GET', `/collectors/code/${newCollector.code}`, { token: tellerToken })
  assert(r.status === 200, `Teller can scan a collector code → 200`)

  // ============================================================
  section('Cash advance and remit each generate a barcode')
  // ============================================================
  // Advance some cash
  r = await api('POST', '/cash/advances', {
    token: adminToken,
    body: { tellerId: teller.id, collectorId: newCollector.id, amount: 1000, password: 'admin2026@' }
  })
  assert(r.status === 201, `Advance → 201 (got ${r.status})`)
  const advCode = r.data.ledgerEntry.code
  assert(typeof advCode === 'string' && ADVANCE_CODE_RE.test(advCode),
    `Advance code "${advCode}" matches ADV[A-Z0-9]{5}`)
  assert(!FORBIDDEN_CHARS_RE.test(advCode.slice(3)),
    `Advance code random portion uses reduced alphabet`)

  // Remit it back
  r = await api('POST', '/cash/remits', {
    token: tellerToken,
    body: { collectorId: newCollector.id, amount: 1000, password: 'teller12345' }
  })
  assert(r.status === 201, `Remit → 201 (got ${r.status})`)
  const remCode = r.data.ledgerEntry.code
  assert(typeof remCode === 'string' && REMIT_CODE_RE.test(remCode),
    `Remit code "${remCode}" matches REM[A-Z0-9]{5}`)
  assert(advCode !== remCode, 'Advance and remit codes differ')

  // ============================================================
  section('GET /cash/ledger/code/:code lookup + scoping')
  // ============================================================
  // Admin can fetch the ADVANCE
  r = await api('GET', `/cash/ledger/code/${advCode}`, { token: adminToken })
  assert(r.status === 200, `Admin scans ADV code → 200`)
  assert(r.data.ledgerEntry.code === advCode, 'Returned ledger entry matches code')
  assert(r.data.ledgerEntry.type === 'CASH_ADVANCE', 'Type is CASH_ADVANCE')
  assert(r.data.ledgerEntry.tellerId === teller.id, 'tellerId matches recipient')

  // Teller can fetch their own REMIT
  r = await api('GET', `/cash/ledger/code/${remCode}`, { token: tellerToken })
  assert(r.status === 200, `Teller scans own REMIT → 200`)
  assert(r.data.ledgerEntry.tellerId === teller.id, 'Their own row')

  // Find a different teller's ledger row to test cross-teller scoping
  const allUsers = (await api('GET', '/users?role=TELLER', { token: adminToken })).data.users
  const otherTeller = allUsers.find(u => u.isActive && u.id !== teller.id)
  if (otherTeller) {
    // Make an advance to the OTHER teller, capture its code
    const advForOther = await api('POST', '/cash/advances', {
      token: adminToken,
      body: { tellerId: otherTeller.id, collectorId: newCollector.id, amount: 50, password: 'admin2026@' }
    })
    if (advForOther.status === 201) {
      const otherCode = advForOther.data.ledgerEntry.code
      // First teller tries to scan it → 404 (no enumeration leak)
      r = await api('GET', `/cash/ledger/code/${otherCode}`, { token: tellerToken })
      assert(r.status === 404, `Teller scanning ANOTHER teller's code → 404 (got ${r.status})`)
      // Admin can still fetch it
      r = await api('GET', `/cash/ledger/code/${otherCode}`, { token: adminToken })
      assert(r.status === 200, `Admin can fetch the other teller's row`)
    } else {
      console.log(`  · skipped cross-teller test (other teller advance failed: ${JSON.stringify(advForOther.data).slice(0, 100)})`)
    }
  } else {
    console.log('  · skipped cross-teller test (no second active teller)')
  }

  // Bad shape → 400
  r = await api('GET', '/cash/ledger/code/advabcde', { token: adminToken })
  assert(r.status === 400, `Lowercase ledger code → 400`)
  r = await api('GET', '/cash/ledger/code/XXXXXXXX', { token: adminToken })
  assert(r.status === 400, `Wrong prefix → 400`)

  // Unknown code → 404
  r = await api('GET', '/cash/ledger/code/ADVZZZZZ', { token: adminToken })
  assert(r.status === 404, `Well-formed unknown advance code → 404`)

  // ============================================================
  section('Bet-related ledger rows have code: null')
  // ============================================================
  // List the teller's full ledger and check that bet-derived entries
  // have code: null while CASH_ADVANCE/REMIT have codes.
  r = await api('GET', `/cash/ledger?tellerId=${teller.id}`, { token: adminToken })
  assert(r.status === 200, `GET teller ledger → 200`)
  const cashRows = r.data.entries.filter(e => ['CASH_ADVANCE', 'REMIT'].includes(e.type))
  const betRows = r.data.entries.filter(e => ['BET_PLACED', 'BET_VOIDED', 'BET_REFUNDED', 'PAYOUT'].includes(e.type))
  for (const row of cashRows) {
    assert(typeof row.code === 'string' && row.code.length === 8,
      `${row.type} row has 8-char code "${row.code}"`)
  }
  for (const row of betRows) {
    assert(row.code === null,
      `${row.type} row has code: null (got ${JSON.stringify(row.code)})`)
  }
  if (betRows.length === 0) console.log('  · no bet-derived rows in this teller\'s ledger to inspect')

  // ============================================================
  section('Bet ticket codes still work (refactored ticket-code.js)')
  // ============================================================
  // Create a new fight + place a bet → ticket code should still match
  // the original bet code pattern (5 random + 3 teller initials = 8 chars).
  // Skip if there's no OPEN fight slot — this is a refactor regression
  // test, not a placement workflow test.
  const fr = await api('GET', '/fights?current=true', { token: adminToken })
  let openFight = fr.data?.fights?.find(f => f.status === 'OPEN')
  if (!openFight) {
    const cf = await api('POST', '/fights', { token: adminToken, body: {} })
    if (cf.status === 201) openFight = cf.data.fight
  }
  if (openFight) {
    // Top up teller so the bet is allowed
    await api('POST', '/cash/advances', {
      token: adminToken,
      body: { tellerId: teller.id, collectorId: newCollector.id, amount: 100, password: 'admin2026@' }
    })
    const placeR = await api('POST', '/bets', {
      token: tellerToken,
      body: { clientRequestId: crypto.randomUUID(), fightId: openFight.id, side: 'MERON', amount: 50 }
    })
    if (placeR.status === 201) {
      const ticket = placeR.data.bet.code
      assert(/^[A-Z0-9]{8}$/.test(ticket),
        `Ticket code "${ticket}" still matches [A-Z0-9]{8}`)
      // Last 3 chars are teller initials (first 3 of username uppercased)
      const initialsExpected = teller.username.slice(0, 3).toUpperCase()
      assert(ticket.endsWith(initialsExpected),
        `Ticket code ends with teller initials "${initialsExpected}" (got "${ticket.slice(-3)}")`)
    } else {
      console.log(`  · skipped ticket-code test (place bet failed: ${JSON.stringify(placeR.data).slice(0, 120)})`)
    }
  } else {
    console.log('  · skipped ticket-code test (no fight available)')
  }

  console.log(`\n  Passed: ${pass}\n  Failed: ${fail}`)
  if (fail) {
    failures.forEach(f => console.log(`  - ${f}`))
    process.exit(1)
  }
  process.exit(0)
}

main().catch(e => { console.error('FATAL:', e); process.exit(2) })
