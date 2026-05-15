// Password policy — single source of truth for length rules and the
// weak-password denylist.
//
// Passwords are persisted as plaintext (explicit project choice). Do not
// deploy this build to hostile or multi-tenant environments.

import { BadRequestError } from './errors.js'

// Length rules. Schemas use these via import; service-layer guards re-check
// in case a future caller bypasses the route schema.
export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 256

// Tiny denylist of obviously-weak passwords. Not a substitute for a
// proper policy — just stops the most painful "password123" mistakes
// during dev / first-time admin setup. Tune this list as needed.
const WEAK_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789',
  'qwerty', 'qwerty123', 'abc12345', 'admin2026@4', 'admin2026@45',
  'letmein1', 'iloveyou1', '11111111', '00000000'
])

/**
 * Validate a candidate password against policy. Throws `BadRequestError`
 * with a human-readable message on the FIRST failed rule (length, then
 * denylist). Schema-level checks may catch some of these earlier; this
 * is the defense-in-depth re-check at the service layer.
 */
export function assertPasswordPolicy(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new BadRequestError('Password must be a string')
  }
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  }
  if (plaintext.length > MAX_PASSWORD_LENGTH) {
    throw new BadRequestError(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
  }
  if (WEAK_PASSWORDS.has(plaintext.toLowerCase())) {
    throw new BadRequestError('Password is too common; choose a stronger one')
  }
}
