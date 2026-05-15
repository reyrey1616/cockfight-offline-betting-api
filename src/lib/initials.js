// Derive the 3-character initials stamped onto every Bet.code from the
// teller's username. Single source of truth: there is no separate `initials`
// column on User — the username IS the source.
//
// The username schema (see users.schemas.js) enforces that the first 3
// characters are alphabetic, so this derivation is always safe at runtime.
// The defensive guard here is for callers that bypass the request schema
// (e.g. service-layer code with a hand-built user object).

import { InvariantError } from './errors.js'

/**
 * @param {string} username  Validated by the username schema (first 3 chars
 *                           guaranteed alphabetic, total length >= 3).
 * @returns {string}         Three uppercase characters, e.g. "JUA" for "juan".
 */
export function deriveInitials(username) {
  if (typeof username !== 'string' || username.length < 3) {
    throw new InvariantError(
      'Cannot derive initials: username must be at least 3 characters'
    )
  }
  return username.slice(0, 3).toUpperCase()
}
