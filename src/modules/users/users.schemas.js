// JSON Schemas for users routes.
//
// Validation philosophy:
//   - Username's first 3 characters MUST be alphabetic — they become the
//     teller's initials suffix on every Bet.code (see src/lib/initials.js).
//     Characters 4+ may be alphanumeric or underscore. Total length 3..32.
//     Avoids whitespace, dots, weird unicode that could collide visually.
//   - Initials are NOT accepted on the wire — they are derived from username.
//     The `initials` field that appears in RESPONSE schemas is computed by
//     the mapper, not stored separately.
//   - Passwords minLength 8 (paired with the weak-password denylist in
//     the service). Tune up if/when an adversary model demands it.

const usernamePattern = '^[A-Za-z]{3}[A-Za-z0-9_]{0,29}$' // 3..32 chars, first 3 alphabetic

const adminUserSchema = {
  type: 'object',
  required: ['id', 'username', 'fullName', 'initials', 'role', 'isActive', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    username: { type: 'string' },
    fullName: { type: 'string' },
    // Derived from username — always 3 uppercase letters, never null.
    initials: { type: 'string', pattern: '^[A-Z]{3}$' },
    role: { type: 'string', enum: ['TELLER', 'ADMIN'] },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' }
  }
}

export const createUserRequestSchema = {
  type: 'object',
  required: ['username', 'password', 'fullName', 'role'],
  additionalProperties: false,
  properties: {
    username: { type: 'string', pattern: usernamePattern },
    password: { type: 'string', minLength: 8, maxLength: 256 },
    fullName: { type: 'string', minLength: 1, maxLength: 100 },
    role: { type: 'string', enum: ['TELLER', 'ADMIN'] }
  }
}

export const createUserResponseSchema = {
  type: 'object',
  required: ['user'],
  properties: { user: adminUserSchema }
}

export const listUsersQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    role: { type: 'string', enum: ['TELLER', 'ADMIN'] },
    isActive: { type: 'boolean' }
  }
}

export const listUsersResponseSchema = {
  type: 'object',
  required: ['users'],
  properties: {
    users: { type: 'array', items: adminUserSchema }
  }
}

export const userIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1 } }
}

export const updateUserRequestSchema = {
  type: 'object',
  additionalProperties: false,
  // username and role are intentionally NOT updateable here (immutable
  // post-creation; see service comments). Initials are not editable either
  // — they are derived from username and follow it automatically.
  properties: {
    fullName: { type: 'string', minLength: 1, maxLength: 100 },
    isActive: { type: 'boolean' }
  },
  // require at least one field so empty PATCH bodies are explicit errors
  minProperties: 1
}

export const userResponseSchema = {
  type: 'object',
  required: ['user'],
  properties: { user: adminUserSchema }
}

export const resetPasswordRequestSchema = {
  type: 'object',
  required: ['newPassword'],
  additionalProperties: false,
  properties: {
    newPassword: { type: 'string', minLength: 8, maxLength: 256 }
  }
}

export const okResponseSchema = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean' } }
}
