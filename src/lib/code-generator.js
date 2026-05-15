// Generic public-facing code generator.
//
// One source of truth for the reduced alphabet, the random-portion length,
// and the collision-retry strategy used by every printable / scannable
// code in the system: bet ticket codes, collector codes, and cash-ledger
// (advance / remit) codes.
//
// The reduced alphabet excludes look-alike characters (0/O, 1/I/L, 5/S,
// 2/Z and a few others) so handwritten and thermal-printed receipts stay
// unambiguous when scanned or typed back at a counter.
//
// Codes are 8 chars total — 3-char fixed affix + 5-char random — to give
// every printer / scanner one consistent format to handle:
//
//   Bet ticket    : XXXXX + 3 teller initials  →  K8H3QJDR
//   Collector     : COL   + XXXXX               →  COLA7B2C
//   Cash advance  : ADV   + XXXXX               →  ADVH3K9P
//   Remit         : REM   + XXXXX               →  REMQ4M7T
//
// 28^5 ≈ 17M codes per affix — collisions are vanishingly rare for any
// realistic session volume, but they're still possible, so we do a
// pre-flight uniqueness check via the caller-supplied `isUsed` predicate
// and retry up to MAX_ATTEMPTS times. The DB-level unique constraint is
// the authoritative backstop — if a concurrent insert grabs our code
// between the check and our own insert, it surfaces as a P2002 the
// caller can react to.

import crypto from 'node:crypto'
import { InvariantError } from './errors.js'

// 28 unambiguous characters. Adding / removing a char here changes the
// codespace for every entity in the system — be deliberate.
export const ALPHABET = 'ABCDEFGHJKMNPQRTUVWXY346789'
const RANDOM_LEN = 5
const MAX_ATTEMPTS = 8

function randomPortion(len = RANDOM_LEN) {
  // crypto.randomInt is unbiased — preferred over Math.random for any
  // code a customer or auditor might rely on.
  let out = ''
  for (let i = 0; i < len; i += 1) {
    out += ALPHABET[crypto.randomInt(0, ALPHABET.length)]
  }
  return out
}

/**
 * Generate a unique 8-char code with a fixed prefix and/or suffix.
 *
 * @param {object} args
 * @param {string} [args.prefix='']  Fixed leading chars (e.g. "COL", "ADV").
 * @param {string} [args.suffix='']  Fixed trailing chars (e.g. teller initials).
 * @param {(code: string) => Promise<boolean>} args.isUsed
 *   Async predicate the generator calls per attempt to check whether the
 *   candidate code already exists in the relevant table. The caller owns
 *   the lookup so this util stays decoupled from any specific Prisma model.
 * @param {string} [args.label='code']
 *   Used in the error thrown after MAX_ATTEMPTS — purely cosmetic,
 *   helps distinguish "ticket code" vs "collector code" in logs.
 * @returns {Promise<string>}
 */
export async function generateUniqueCode({ prefix = '', suffix = '', isUsed, label = 'code' }) {
  if (typeof isUsed !== 'function') {
    throw new InvariantError('generateUniqueCode requires an isUsed predicate')
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const code = `${prefix}${randomPortion()}${suffix}`.toUpperCase()
    // eslint-disable-next-line no-await-in-loop
    const taken = await isUsed(code)
    if (!taken) return code
  }

  // Hitting this means either bad luck on a colossal scale or a real bug
  // (e.g. a stale prisma client returning the same row repeatedly).
  // Either way, surface it as a 500 — the caller cannot meaningfully
  // recover by retrying with the same input.
  throw new InvariantError(
    `Could not generate a unique ${label} after ${MAX_ATTEMPTS} attempts`
  )
}
