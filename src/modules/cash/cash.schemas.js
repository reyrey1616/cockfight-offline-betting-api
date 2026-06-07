// JSON schemas for the cash module.
//
// Wire conventions (consistent with the rest of the codebase):
//   - amounts on the wire as STRINGS in responses (avoid float drift),
//     NUMBERS in request bodies (ergonomic for admin UX).
//   - `additionalProperties: false` on every request body — unknown
//     fields fail fast instead of being silently dropped.
//   - `multipleOf: 0.01` enforces 2-decimal precision at the schema layer.

const cuidPattern = '^[a-z0-9]{20,32}$'

// 8-char public collector barcode: "COL" + 5 reduced-alphabet chars.
const collectorCodePattern = '^COL[A-Z0-9]{5}$'

// 8-char ledger barcode: "ADV…" (cash advance) or "REM…" (remit).
// Bet-related ledger rows have `code: null` — their printable code is
// on the related Bet via `betId → bet.code`.
const ledgerCodePattern = '^(ADV|REM)[A-Z0-9]{5}$'

// Practical bounds:
//   - 0 < amount: cash movements are always positive in magnitude. Sign
//     is decided by the entry type, not by the user.
//   - 1,000,000 PHP per single op: way above any realistic single
//     advance / remit. Catches obvious fat-finger errors before they
//     hit the ledger.
const AMOUNT_MIN_EXCLUSIVE = 0
const AMOUNT_MAX = 1_000_000

const LEDGER_TYPES = [
  'CASH_ADVANCE', 'BET_PLACED', 'BET_VOIDED',
  'BET_REFUNDED', 'PAYOUT', 'REMIT', 'ADJUSTMENT'
]

// Single canonical projection of a TellerLedger row to the wire.
// Reused by every cash response that surfaces a ledger entry.
const ledgerEntrySchema = {
  type: 'object',
  required: ['id', 'code', 'tellerId', 'type', 'amount', 'createdAt'],
  properties: {
    id: { type: 'string' },
    code: {
      type: ['string', 'null'],
      description:
        'Public scannable barcode. Set for CASH_ADVANCE ("ADV…") and ' +
        'REMIT ("REM…") rows; null for bet-related rows (whose printable ' +
        'code lives on the related Bet via `betId`).'
    },
    tellerId: { type: 'string' },
    type: { type: 'string', enum: LEDGER_TYPES },
    amount: { type: 'string', description: 'Signed 2-decimal amount. Positive = cash IN, negative = cash OUT.' },
    betId: { type: ['string', 'null'] },
    collectorId: { type: ['string', 'null'] },
    adjustedByUserId: { type: ['string', 'null'] },
    notes: { type: ['string', 'null'] },
    createdAt: { type: 'string', format: 'date-time' }
  }
}

// ---------------------------------------------------------------------------
// POST /cash/advances
// ---------------------------------------------------------------------------

export const cashAdvanceRequestSchema = {
  type: 'object',
  required: ['collectorCode', 'amount'],
  additionalProperties: false,
  properties: {
    tellerId: {
      type: 'string',
      pattern: cuidPattern,
      description:
        'Receiving teller (ADMIN only). Tellers omit this — the deposit is always recorded on their own drawer.'
    },
    collectorCode: {
      type: 'string',
      pattern: collectorCodePattern,
      description: 'Scanned collector badge barcode ("COL…") — must be active.'
    },
    amount: {
      type: 'number',
      exclusiveMinimum: AMOUNT_MIN_EXCLUSIVE,
      maximum: AMOUNT_MAX,
      multipleOf: 0.01,
      description: 'Positive amount (max 1,000,000) with at most 2 decimals.'
    },
    notes: { type: 'string', maxLength: 200 }
  }
}

export const cashAdvanceResponseSchema = {
  201: {
    type: 'object',
    required: ['ledgerEntry', 'actorBalance'],
    properties: {
      ledgerEntry: ledgerEntrySchema,
      actorBalance: { type: 'string', description: 'Receiving teller\'s NEW balance after this advance.' }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /cash/remits
// ---------------------------------------------------------------------------

export const cashRemitRequestSchema = {
  type: 'object',
  required: ['collectorCode', 'amount'],
  additionalProperties: false,
  properties: {
    collectorCode: {
      type: 'string',
      pattern: collectorCodePattern,
      description: 'Scanned collector badge barcode ("COL…") — must be active.'
    },
    amount: {
      type: 'number',
      exclusiveMinimum: AMOUNT_MIN_EXCLUSIVE,
      maximum: AMOUNT_MAX,
      multipleOf: 0.01,
      description: 'Positive amount being remitted (recorded as a negative on the ledger).'
    },
    notes: { type: 'string', maxLength: 200 }
  }
}

export const cashRemitResponseSchema = {
  201: {
    type: 'object',
    required: ['ledgerEntry', 'actorBalance'],
    properties: {
      ledgerEntry: ledgerEntrySchema,
      actorBalance: { type: 'string', description: 'Remitting teller\'s NEW balance (typically lower).' }
    }
  }
}

// ---------------------------------------------------------------------------
// GET /cash/balance
// ---------------------------------------------------------------------------

export const cashBalanceQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tellerId: {
      type: 'string',
      pattern: cuidPattern,
      description: 'Which teller to inspect. Tellers may only pass their own id; admins can pass any. Defaults to the requesting user.'
    }
  }
}

export const cashBalanceResponseSchema = {
  200: {
    type: 'object',
    required: ['tellerId', 'username', 'fullName', 'balance'],
    properties: {
      tellerId: { type: 'string' },
      username: { type: 'string' },
      fullName: { type: 'string' },
      balance: { type: 'string' }
    }
  }
}

// ---------------------------------------------------------------------------
// GET /cash/ledger
// ---------------------------------------------------------------------------

export const cashLedgerQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tellerId: { type: 'string', pattern: cuidPattern, description: 'Filter by teller. Tellers can only pass their own id.' },
    type: { type: 'string', enum: LEDGER_TYPES, description: 'Filter by entry type.' },
    since: { type: 'string', format: 'date-time', description: 'Inclusive lower bound on createdAt.' },
    until: { type: 'string', format: 'date-time', description: 'Exclusive upper bound on createdAt.' },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    cursor: { type: 'string', description: 'Pass the previous response\'s nextCursor.' }
  }
}

export const cashLedgerResponseSchema = {
  200: {
    type: 'object',
    required: ['entries', 'nextCursor'],
    properties: {
      entries: { type: 'array', items: ledgerEntrySchema },
      nextCursor: { type: ['string', 'null'] }
    }
  }
}

// ---------------------------------------------------------------------------
// GET /cash/ledger/code/:code  — scan-by-barcode lookup
// ---------------------------------------------------------------------------

export const cashLedgerCodeParamsSchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      pattern: ledgerCodePattern,
      description: '8-char ledger barcode, "ADV…" (advance) or "REM…" (remit).'
    }
  }
}

export const getLedgerEntryByCodeResponseSchema = {
  200: {
    type: 'object',
    required: ['ledgerEntry'],
    properties: { ledgerEntry: ledgerEntrySchema }
  }
}
