// JSON Schemas for the bets module. Fastify validates the request shape
// against these BEFORE any handler runs, so the service layer can assume
// well-formed input.
//
// `clientRequestId` is required, not optional. Teller machines must mint a
// fresh UUID per logical bet attempt and reuse the same UUID on every
// network retry. That's how we keep duplicate bets out under flaky LAN.

const cuidPattern = '^[a-z0-9]{20,32}$'
const uuidPattern =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
const ticketCodePattern = '^[A-Z0-9]{8}$'

// ---------------------------------------------------------------------------
// Shared object shapes
// ---------------------------------------------------------------------------

// Full Bet projection — every column we surface to clients. Decimal columns
// come out of Prisma as strings under the pg driver adapter; we keep them
// as strings on the wire to avoid float precision loss.
const betSchema = {
  type: 'object',
  required: ['id', 'code', 'clientRequestId', 'fightId', 'tellerId', 'amount', 'side', 'status', 'createdAt'],
  properties: {
    id: { type: 'string' },
    code: { type: 'string', pattern: ticketCodePattern, description: 'Public ticket code printed for the customer (5 random + 3 teller initials).' },
    clientRequestId: { type: 'string' },
    fightId: { type: 'string' },
    tellerId: { type: 'string' },
    tellerNameSnapshot: { type: 'string' },
    tellerInitialsSnapshot: { type: 'string' },
    amount: { type: 'string', description: 'Decimal as string (e.g. "500.00").' },
    side: { type: 'string', enum: ['MERON', 'WALA'] },
    status: { type: 'string', enum: ['PENDING', 'WON', 'LOST', 'PAID', 'VOIDED', 'REFUNDED'] },
    payoutAmount: { type: ['string', 'null'], description: 'Frozen at settlement. Null for losing / voided / refunded / still-pending bets.' },
    paidAt: { type: ['string', 'null'], format: 'date-time' },
    paidByUserId: { type: ['string', 'null'] },
    voidedAt: { type: ['string', 'null'], format: 'date-time' },
    voidedByUserId: { type: ['string', 'null'] },
    voidReason: { type: ['string', 'null'] },
    previousStatus: { type: ['string', 'null'], enum: ['PENDING', 'WON', 'LOST', 'PAID', 'VOIDED', 'REFUNDED', null] },
    previousPayoutAmount: { type: ['string', 'null'] },
    correctedAt: { type: ['string', 'null'], format: 'date-time' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' }
  }
}

const fightSummarySchema = {
  type: 'object',
  required: ['id', 'fightNumber', 'status', 'meronPool', 'walaPool'],
  properties: {
    id: { type: 'string' },
    fightNumber: { type: 'integer' },
    status: { type: 'string', enum: ['SCHEDULED', 'OPEN', 'CLOSED', 'SETTLED', 'CANCELLED'] },
    outcome: {
      anyOf: [
        { type: 'string', enum: ['MERON', 'WALA', 'DRAW', 'CANCELLED', 'NO_CONTEST'] },
        { type: 'null' }
      ],
      description: 'Fight result — set when status is SETTLED.'
    },
    meronPool: { type: 'string' },
    walaPool: { type: 'string' },
    meronOdds: { type: ['number', 'null'] },
    walaOdds: { type: ['number', 'null'] },
    payoutRatioMeron: {
      type: ['string', 'null'],
      description: 'Settled payout multiplier for Meron (null until fight is settled).'
    },
    payoutRatioWala: {
      type: ['string', 'null'],
      description: 'Settled payout multiplier for Wala (null until fight is settled).'
    }
  }
}

// ---------------------------------------------------------------------------
// POST /bets — placeBet (existing)
// ---------------------------------------------------------------------------

export const placeBetRequestSchema = {
  type: 'object',
  required: ['clientRequestId', 'fightId', 'side', 'amount'],
  additionalProperties: false,
  properties: {
    clientRequestId: {
      type: 'string',
      pattern: uuidPattern,
      description: 'Idempotency key (UUID v4 from teller machine).'
    },
    fightId: { type: 'string', pattern: cuidPattern },
    side: { type: 'string', enum: ['MERON', 'WALA'] },
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 1_000_000,
      multipleOf: 0.01
    }
  }
}

// `actorBalance` (string) is the placing teller's CURRENT cash balance,
// returned alongside the bet so the kiosk can update its balance display
// without round-tripping through the WS broadcast.
export const placeBetResponseSchema = {
  201: {
    description: 'Fresh placement — bet created.',
    type: 'object',
    required: ['bet', 'fight', 'actorBalance'],
    properties: {
      bet: betSchema,
      fight: fightSummarySchema,
      actorBalance: { type: 'string', description: 'Placing teller\'s NEW running cash balance.' }
    }
  },
  // 200 returned when the same clientRequestId hits us again — idempotent
  // replay path returns the originally-created bet without modifying state.
  200: {
    description: 'Idempotent replay — original bet returned as-is.',
    type: 'object',
    required: ['bet', 'fight', 'replay', 'actorBalance'],
    properties: {
      bet: betSchema,
      fight: fightSummarySchema,
      replay: { type: 'boolean', const: true },
      actorBalance: { type: 'string', description: 'Placing teller\'s CURRENT cash balance (refreshed live, not snapshot).' }
    }
  }
}

// ---------------------------------------------------------------------------
// GET /bets — list
// ---------------------------------------------------------------------------

export const listBetsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fightId: { type: 'string', pattern: cuidPattern },
    // Tellers are forced to their own id server-side; the param is here for admins.
    tellerId: { type: 'string', pattern: cuidPattern },
    status: { type: 'string', enum: ['PENDING', 'WON', 'LOST', 'PAID', 'VOIDED', 'REFUNDED'] },
    side: { type: 'string', enum: ['MERON', 'WALA'] },
    since: { type: 'string', format: 'date-time', description: 'Only bets created at or after this timestamp.' },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    cursor: { type: 'string', description: 'Opaque cursor — pass the `nextCursor` from the previous response.' }
  }
}

export const listBetsResponseSchema = {
  200: {
    type: 'object',
    required: ['bets', 'nextCursor'],
    properties: {
      bets: { type: 'array', items: betSchema },
      nextCursor: {
        type: ['string', 'null'],
        description: 'Cursor for the next page, or null when the result is exhausted.'
      }
    }
  }
}

// ---------------------------------------------------------------------------
// GET /bets/:id — detail by id
// ---------------------------------------------------------------------------

export const betIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: cuidPattern } }
}

export const betDetailResponseSchema = {
  200: {
    type: 'object',
    required: ['bet', 'fight'],
    properties: { bet: betSchema, fight: fightSummarySchema }
  }
}

// ---------------------------------------------------------------------------
// GET /bets/code/:code — detail by public ticket code
// ---------------------------------------------------------------------------

export const betCodeParamsSchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      pattern: ticketCodePattern,
      description: '8-char public ticket code (5 reduced-alphabet + 3 teller initials).'
    }
  }
}

// ---------------------------------------------------------------------------
// POST /bets/:id/void
// ---------------------------------------------------------------------------

export const voidBetRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description: 'Optional free-text reason. Required by policy if the actor is an admin voiding another teller\'s bet.'
    }
  }
}

export const voidBetResponseSchema = {
  200: {
    type: 'object',
    required: ['bet', 'fight', 'replay', 'actorBalance'],
    properties: {
      bet: betSchema,
      fight: fightSummarySchema,
      replay: {
        type: 'boolean',
        description: 'true if the bet was already VOIDED before this call (idempotent retry).'
      },
      actorBalance: {
        type: 'string',
        description:
          'CURRENT cash balance of the **original** teller (whose drawer the cash returns to), ' +
          'not necessarily the user calling this endpoint. Admins voiding someone else\'s bet ' +
          'will see the affected teller\'s balance here.'
      }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /bets/:id/pay
// ---------------------------------------------------------------------------

export const payBetResponseSchema = {
  200: {
    type: 'object',
    required: ['bet', 'fight', 'replay', 'actorBalance'],
    properties: {
      bet: betSchema,
      fight: fightSummarySchema,
      replay: {
        type: 'boolean',
        description: 'true if the bet was already PAID before this call (idempotent retry).'
      },
      actorBalance: {
        type: 'string',
        description:
          'CURRENT cash balance of the **paying** teller (the actor) — NOT the original ' +
          'bet-taker. Their drawer is what the payout came from.'
      }
    }
  }
}
