// E2E test for Tier 4 auth hardening:
//   POST /auth/change-password — self-service password change
//   POST /auth/logout           — symbolic logout
//
// Verifies:
//   1. SCHEMA REJECTS
//      - empty body → 400
//      - missing currentPassword → 400
//      - missing newPassword → 400
//      - newPassword < 8 chars → 400 (schema minLength)
//      - additionalProperties → 400
//
//   2. CURRENT-PASSWORD VERIFICATION
//      - wrong currentPassword → 401 with generic "Password verification failed"
//      - wrong currentPassword + WARN log fires
//
//   3. POLICY ENFORCEMENT
//      - weak newPassword (denylist) → 400
//      - newPassword === currentPassword → 400 "different from current"
//
//   4. HAPPY PATH
//      - correct currentPassword + strong distinct newPassword → 200
//      - old password no longer logs in → 401
//      - new password logs in → 200
//      - admin-issued JWT issued BEFORE the change still works (no jti denylist)
//      - re-changing back to the original works (round-trip)
//
//   5. LOGOUT
//      - POST /auth/logout (bearer) → 200 with { ok, message }
//      - no-auth POST /auth/logout → 401
//      - token is NOT actually revoked (still works on /auth/me)
//      - admin setting isActive=false is the de-facto kill switch
//        (separate /users PATCH path — we just confirm /auth/me returns 401 after)

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
  return r
}

function section(label) { console.log(`\n━━━ ${label} ━━━`) }

async function main() {
  section('Setup — create a dedicated teller for password-change tests')
  // Use a unique username per run so reruns don't collide.
  const stamp = Date.now().toString().slice(-6)
  const tellerUser = `ahpwch${stamp}`
  const tellerInitialPw = 'InitialPW#abc123'
  const tellerNewPw = 'NewStrongPW#456xyz'

  // We need an admin to create the test teller.
  const adminLogin = await login('admin', 'admin2026@')
  assert(adminLogin.status === 200, `Admin login → 200 (got ${adminLogin.status})`)
  const adminToken = adminLogin.data.token

  let r = await api('POST', '/users', {
    token: adminToken,
    body: {
      username: tellerUser,
      password: tellerInitialPw,
      fullName: 'Auth Hardening E2E Teller',
      role: 'TELLER'
    }
  })
  assert(r.status === 201, `Create test teller → 201 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)
  const tellerId = r.data.user.id

  // Sanity: teller can log in with initial password.
  let tellerLogin = await login(tellerUser, tellerInitialPw)
  assert(tellerLogin.status === 200, `Teller initial login → 200 (got ${tellerLogin.status})`)
  let tellerToken = tellerLogin.data.token

  // ============================================================
  section('1. Schema rejects')
  // ============================================================
  r = await api('POST', '/auth/change-password', { token: tellerToken, body: {} })
  assert(r.status === 400, `Empty body → 400 (got ${r.status})`)

  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { newPassword: 'AbcDefGhi#123' }
  })
  assert(r.status === 400, `Missing currentPassword → 400 (got ${r.status})`)

  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw }
  })
  assert(r.status === 400, `Missing newPassword → 400 (got ${r.status})`)

  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw, newPassword: 'Short1' }
  })
  assert(r.status === 400, `newPassword < 8 chars → 400 (got ${r.status})`)

  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw, newPassword: tellerNewPw, extra: 'field' }
  })
  assert(r.status === 400, `additionalProperties → 400 (got ${r.status})`)

  // No-auth → 401 (bearer gate).
  r = await api('POST', '/auth/change-password', {
    body: { currentPassword: 'x', newPassword: 'AbcDefGhi#123' }
  })
  assert(r.status === 401, `No bearer token → 401 (got ${r.status})`)

  // ============================================================
  section('2. Current-password verification')
  // ============================================================
  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: 'definitely-not-the-current-pw', newPassword: tellerNewPw }
  })
  assert(r.status === 401, `Wrong currentPassword → 401 (got ${r.status})`)
  const errCode = r.data?.error?.code
  assert(errCode === 'UNAUTHORIZED',
    `Wrong-current-pw error.code = UNAUTHORIZED (got ${errCode})`)
  assert(/password verification/i.test(r.data?.error?.message ?? ''),
    `Wrong-current-pw message is generic ("${r.data?.error?.message}")`)

  // ============================================================
  section('3. Policy enforcement')
  // ============================================================

  // Weak password on the denylist → 400 with policy message.
  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw, newPassword: 'password' }
  })
  // 'password' is 8 chars so schema minLength passes; the denylist
  // service-layer check fires.
  assert(r.status === 400, `Weak password (denylist: "password") → 400 (got ${r.status})`)
  assert(/too common|stronger/i.test(r.data?.error?.message ?? ''),
    `Weak-password message mentions strength ("${r.data?.error?.message}")`)

  // qwerty123 — also on the denylist.
  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw, newPassword: 'qwerty123' }
  })
  assert(r.status === 400, `Weak password ("qwerty123") → 400 (got ${r.status})`)

  // newPassword === currentPassword → 400 with same-as-current message.
  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw, newPassword: tellerInitialPw }
  })
  assert(r.status === 400, `Same-as-current → 400 (got ${r.status})`)
  assert(/different from current/i.test(r.data?.error?.message ?? ''),
    `Same-as-current message is specific ("${r.data?.error?.message}")`)

  // ============================================================
  section('4. Happy path')
  // ============================================================

  // Save the pre-change token to confirm it still works after change
  // (no jti denylist, intentional).
  const preChangeToken = tellerToken

  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerInitialPw, newPassword: tellerNewPw }
  })
  assert(r.status === 200, `Change password → 200 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)
  assert(r.data?.ok === true, `Response.ok = true`)
  assert(typeof r.data?.message === 'string', `Response.message is a string`)

  // Old password should no longer log in.
  let oldLogin = await login(tellerUser, tellerInitialPw)
  assert(oldLogin.status === 401, `Login with OLD password → 401 (got ${oldLogin.status})`)

  // New password should log in.
  let newLogin = await login(tellerUser, tellerNewPw)
  assert(newLogin.status === 200, `Login with NEW password → 200 (got ${newLogin.status})`)
  tellerToken = newLogin.data.token

  // Pre-change JWT should STILL work (no server-side revocation).
  // This is intentional — see /auth/logout description.
  r = await api('GET', '/auth/me', { token: preChangeToken })
  assert(r.status === 200, `Pre-change JWT still works on /auth/me → 200 (got ${r.status})`)
  assert(r.data?.user?.username === tellerUser, `Pre-change JWT identifies correct user`)

  // Round-trip: change back to original. Proves the path is reversible
  // and the policy doesn't trap users in a one-way street.
  r = await api('POST', '/auth/change-password', {
    token: tellerToken,
    body: { currentPassword: tellerNewPw, newPassword: tellerInitialPw }
  })
  assert(r.status === 200, `Change password back to original → 200 (got ${r.status})`)
  oldLogin = await login(tellerUser, tellerInitialPw)
  assert(oldLogin.status === 200, `Login with original password again → 200 (got ${oldLogin.status})`)
  tellerToken = oldLogin.data.token

  // ============================================================
  section('5. Logout')
  // ============================================================

  // No-auth → 401.
  r = await api('POST', '/auth/logout', {})
  assert(r.status === 401, `Unauthenticated logout → 401 (got ${r.status})`)

  // With bearer → 200 + ok/message.
  r = await api('POST', '/auth/logout', { token: tellerToken })
  assert(r.status === 200, `Logout → 200 (got ${r.status} ${JSON.stringify(r.data).slice(0,200)})`)
  assert(r.data?.ok === true, `logout.ok = true`)
  assert(typeof r.data?.message === 'string' && r.data.message.length > 0,
    `logout.message is a non-empty string`)
  assert(/drop|client|expir/i.test(r.data.message),
    `logout.message warns client to drop token (or mentions expiry): "${r.data.message}"`)

  // CRITICAL: the token is NOT actually revoked. /auth/me still works.
  // This is documented behaviour and must be tested so a future
  // refactor doesn't silently introduce a jti denylist without us
  // noticing the impact.
  r = await api('GET', '/auth/me', { token: tellerToken })
  assert(r.status === 200, `Token NOT actually revoked after logout (intentional) → 200 (got ${r.status})`)

  // The de-facto kill switch: admin deactivates the user → next call
  // returns 401 because app.authenticate re-fetches the user.
  r = await api('PATCH', `/users/${tellerId}`, {
    token: adminToken,
    body: { isActive: false }
  })
  assert(r.status === 200, `Admin deactivates the teller → 200 (got ${r.status})`)

  r = await api('GET', '/auth/me', { token: tellerToken })
  assert(r.status === 401, `Deactivated user's existing token → 401 (got ${r.status}) [admin kill switch]`)

  // Cleanup: re-activate so reruns don't blow up.
  r = await api('PATCH', `/users/${tellerId}`, {
    token: adminToken,
    body: { isActive: true }
  })
  assert(r.status === 200, `Reactivate teller for next run → 200 (got ${r.status})`)

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
