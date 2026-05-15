// JSON Schema definitions for the auth routes. Fastify validates incoming
// requests against these BEFORE the handler runs — bad input never reaches
// our service layer or Prisma.

import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '../../lib/password-policy.js'

export const loginRequestSchema = {
  type: 'object',
  required: ['username', 'password'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', minLength: 1, maxLength: 64 },
    // Login intentionally accepts any non-empty length on the wire — we
    // don't want to leak that the policy minimum is 8 by 400-ing on a
    // 7-char attempt; let the server compare run and 401 generically.
    password: { type: 'string', minLength: 1, maxLength: 256 }
  }
}

const userPublicSchema = {
  type: 'object',
  required: ['id', 'username', 'fullName', 'initials', 'role'],
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    fullName: { type: 'string' },
    // Derived from username (first 3 chars uppercased) — never null.
    initials: { type: 'string', pattern: '^[A-Z]{3}$' },
    role: { type: 'string', enum: ['TELLER', 'ADMIN'] }
  }
}

export const loginResponseSchema = {
  type: 'object',
  required: ['token', 'user'],
  properties: {
    token: { type: 'string' },
    user: userPublicSchema
  }
}

export const meResponseSchema = {
  type: 'object',
  required: ['user'],
  properties: {
    user: userPublicSchema
  }
}

// ---------------------------------------------------------------------------
// POST /auth/change-password — self-service password change.
//
// Wire contract:
//   - Both `currentPassword` and `newPassword` REQUIRED.
//   - `currentPassword` accepts wire-min 1 (don't leak the policy minimum
//     to attackers via wire-rejection — let the server verify and 401 it).
//   - `newPassword` enforces the FULL policy length on the wire — this
//     is the user's own input, not credential probing, so a fast 400
//     gives them better feedback than a late policy rejection.
// ---------------------------------------------------------------------------

export const changePasswordRequestSchema = {
  type: 'object',
  required: ['currentPassword', 'newPassword'],
  additionalProperties: false,
  properties: {
    currentPassword: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description:
        'The bearer-authenticated user\'s CURRENT password. Re-verified ' +
        'server-side against `User.password` (plaintext storage). Wrong / ' +
        'deactivated → 401 with the generic "Password verification failed" ' +
        'message. Failed attempts are logged at WARN level for the security feed.'
    },
    newPassword: {
      type: 'string',
      minLength: MIN_PASSWORD_LENGTH,
      maxLength: MAX_PASSWORD_LENGTH,
      description:
        `The replacement password. Must be ${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} ` +
        'characters and not on the weak-password denylist. MUST NOT equal ' +
        '`currentPassword` — same-as-current returns 400.'
    }
  }
}

export const changePasswordResponseSchema = {
  200: {
    description: 'Password updated. The bearer JWT remains valid until its natural expiry.',
    type: 'object',
    required: ['ok', 'message'],
    properties: {
      ok: { type: 'boolean', const: true },
      message: { type: 'string' }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /auth/logout — symbolic logout.
//
// Without a server-side jti denylist the JWT remains valid until natural
// expiry; this endpoint exists so clients have a canonical place to call
// (and so we can audit-log the intent). See route description for the
// full reasoning + threat model.
// ---------------------------------------------------------------------------

export const logoutResponseSchema = {
  200: {
    description:
      'Logout intent recorded. Client MUST drop the bearer token locally. ' +
      'The token itself is NOT server-revoked (no jti denylist) — it remains ' +
      'cryptographically valid until its `exp` claim. See route description ' +
      'for the threat-model rationale.',
    type: 'object',
    required: ['ok', 'message'],
    properties: {
      ok: { type: 'boolean', const: true },
      message: { type: 'string' }
    }
  }
}
