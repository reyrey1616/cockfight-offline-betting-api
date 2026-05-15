// JSON schemas for the session module.
//
// Wire conventions (consistent with the rest of the codebase):
//   - `additionalProperties: false` on every body schema.
//   - The reset confirmation token is enforced via `const`; AJV rejects
//     anything but an exact string match. A typo → 400, NOT a wipe.

const cuidPattern = '^[a-z0-9]{20,32}$'

// The exact phrase a caller must send to authorize a wipe. Kept short
// enough to type but distinctive enough that nobody types it by accident.
// MUST stay in sync with the `const` value in `resetSessionRequestSchema`.
export const RESET_CONFIRMATION_TOKEN = 'WIPE-SESSION'

// ---------------------------------------------------------------------------
// Shared projection: SessionReset row → wire shape.
// ---------------------------------------------------------------------------

const sessionResetSchema = {
  type: 'object',
  required: [
    'id', 'performedAt', 'performedByUserId',
    'fightCount', 'betCount', 'ledgerCount', 'forced'
  ],
  properties: {
    id: { type: 'string' },
    performedAt: { type: 'string', format: 'date-time' },
    performedByUserId: { type: 'string' },
    // Joined-in for convenience so admin reports don't need a second call.
    performedByUsername: { type: ['string', 'null'] },
    performedByFullName: { type: ['string', 'null'] },
    fightCount: { type: 'integer', minimum: 0 },
    betCount: { type: 'integer', minimum: 0 },
    ledgerCount: { type: 'integer', minimum: 0 },
    collectorCashCount: {
      type: ['integer', 'null'],
      minimum: 0,
      description: 'CASH_ADVANCE + REMIT rows wiped. Null on audit rows before this field existed.'
    },
    notes: { type: ['string', 'null'] },
    forced: { type: 'boolean' }
  }
}

// ---------------------------------------------------------------------------
// GET /session/preview  — read-only "what would happen if I wiped now?"
// ---------------------------------------------------------------------------

export const sessionPreviewResponseSchema = {
  200: {
    type: 'object',
    required: ['counts', 'invariants', 'canResetCleanly'],
    properties: {
      counts: {
        type: 'object',
        required: ['fights', 'bets', 'ledger', 'collectorCash'],
        properties: {
          fights: { type: 'integer', minimum: 0 },
          bets: { type: 'integer', minimum: 0 },
          ledger: {
            type: 'integer',
            minimum: 0,
            description: 'All teller ledger rows (includes bet-linked rows).'
          },
          collectorCash: {
            type: 'integer',
            minimum: 0,
            description: 'CASH_ADVANCE + REMIT rows only (collector deposits and remits).'
          }
        }
      },
      invariants: {
        type: 'object',
        required: ['unfinishedFights', 'unpaidWinningBets', 'nonZeroBalances'],
        properties: {
          // OPEN or CLOSED fights still represent in-flight money.
          unfinishedFights: {
            type: 'object',
            required: ['violated', 'count'],
            properties: {
              violated: { type: 'boolean' },
              count: { type: 'integer', minimum: 0 }
            }
          },
          // WON bets that haven't been PAID yet are owed cash.
          unpaidWinningBets: {
            type: 'object',
            required: ['violated', 'count'],
            properties: {
              violated: { type: 'boolean' },
              count: { type: 'integer', minimum: 0 }
            }
          },
          // Tellers with non-zero running cash balance.
          nonZeroBalances: {
            type: 'object',
            required: ['violated', 'tellerCount'],
            properties: {
              violated: { type: 'boolean' },
              tellerCount: { type: 'integer', minimum: 0 },
              // Per-teller breakdown (helps admin decide what to do).
              tellers: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['tellerId', 'username', 'balance'],
                  properties: {
                    tellerId: { type: 'string' },
                    username: { type: 'string' },
                    fullName: { type: 'string' },
                    balance: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      canResetCleanly: {
        type: 'boolean',
        description: 'True iff every invariant passes — no `force: true` needed.'
      }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /session/reset
// ---------------------------------------------------------------------------

export const resetSessionRequestSchema = {
  type: 'object',
  required: ['confirm', 'password'],
  additionalProperties: false,
  properties: {
    confirm: {
      type: 'string',
      const: RESET_CONFIRMATION_TOKEN,
      description:
        'Must be exactly the string "WIPE-SESSION". Anything else (typo, ' +
        'lowercase, missing) → 400. First of three guardrails before ' +
        'destruction (the others: bearer JWT + step-up password).'
    },
    // SECOND guardrail: re-prove the admin is at the keyboard. Holding
    // a stolen / forgotten-on-screen JWT is not enough — they must
    // re-enter their password right now. Same "sudo mode" pattern
    // GitHub uses for destructive ops.
    password: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description:
        'The CURRENT bearer-authenticated admin\'s password. Re-verified ' +
        'server-side against `User.password` (plaintext storage). Wrong / ' +
        'missing → 401 with the same generic "Password verification ' +
        'failed" message regardless of the actual cause (no enumeration). ' +
        'A failed step-up is logged at WARN level for the security feed.'
    },
    notes: {
      type: 'string',
      maxLength: 500,
      description: 'Optional free-text reason recorded on the audit row.'
    },
    force: {
      type: 'boolean',
      default: false,
      description:
        'Bypass pre-flight invariants (open fights, unpaid winning bets, ' +
        'non-zero teller balances). Default false — strict mode. The audit ' +
        'row records `forced: true` whenever this flag is set, regardless ' +
        'of whether any invariant was actually violated.'
    }
  }
}

export const resetSessionResponseSchema = {
  201: {
    description: 'Wipe completed. The session-reset audit row is returned.',
    type: 'object',
    required: ['sessionReset'],
    properties: { sessionReset: sessionResetSchema }
  }
}

// ---------------------------------------------------------------------------
// GET /session/resets  — audit log
// ---------------------------------------------------------------------------

export const listSessionResetsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    cursor: {
      type: 'string',
      // Cursor values are SessionReset ids — cuid-shaped. Rejecting
      // anything else at the schema layer turns "client passed
      // garbage" into a clean 400 instead of a 500 from Prisma's
      // `cursor: { id: <invalid> }` lookup.
      pattern: cuidPattern,
      description: 'Opaque cursor (cuid) — pass the previous response\'s nextCursor.'
    }
  }
}

export const listSessionResetsResponseSchema = {
  200: {
    type: 'object',
    required: ['resets', 'nextCursor'],
    properties: {
      resets: { type: 'array', items: sessionResetSchema },
      nextCursor: { type: ['string', 'null'] }
    }
  }
}
