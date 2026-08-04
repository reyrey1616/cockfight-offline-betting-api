// JSON schemas for the fights module — used by Fastify for runtime
// validation AND by `@fastify/swagger` for the auto-generated OpenAPI spec.
//
// Convention reused from the bets module:
//   - request schemas have `additionalProperties: false` so unknown fields
//     produce a 400 instead of being silently dropped.
//   - decimal columns appear as strings on the wire (Prisma + pg driver
//     adapter pattern). Numbers are reserved for derived/dimensionless
//     quantities like odds.

const cuidPattern = '^[a-z0-9]{20,32}$'

const FIGHT_STATUS = ['SCHEDULED', 'OPEN', 'LAST_CALL', 'CLOSED', 'SETTLED', 'CANCELLED']
const FIGHT_OUTCOME = ['MERON', 'WALA', 'DRAW']
const SIDE = ['MERON', 'WALA']

// ---------------------------------------------------------------------------
// Shared projections
// ---------------------------------------------------------------------------

// Full Fight projection — every column we surface to clients, plus the
// derived live odds. Used by detail, list and every action response.
const fightSchema = {
  type: 'object',
  required: [
    'id', 'fightNumber', 'status', 'commissionRate',
    'meronPool', 'walaPool',
    'meronAcceptingBets', 'walaAcceptingBets',
    'createdAt', 'updatedAt'
  ],
  properties: {
    id: { type: 'string' },
    fightNumber: { type: 'integer' },
    status: { type: 'string', enum: FIGHT_STATUS },
    commissionRate: { type: 'string', description: 'Decimal fraction (e.g. "0.1000" = 10%).' },

    meronPool: { type: 'string' },
    walaPool: { type: 'string' },
    meronOdds: { type: ['number', 'null'] },
    walaOdds: { type: ['number', 'null'] },

    meronAcceptingBets: { type: 'boolean' },
    meronHeldAt: { type: ['string', 'null'], format: 'date-time' },
    meronHeldByUserId: { type: ['string', 'null'] },
    walaAcceptingBets: { type: 'boolean' },
    walaHeldAt: { type: ['string', 'null'], format: 'date-time' },
    walaHeldByUserId: { type: ['string', 'null'] },

    outcome: { type: ['string', 'null'], enum: [...FIGHT_OUTCOME, null] },
    payoutRatioMeron: { type: ['string', 'null'] },
    payoutRatioWala: { type: ['string', 'null'] },

    openedAt: { type: ['string', 'null'], format: 'date-time' },
    closedAt: { type: ['string', 'null'], format: 'date-time' },
    settledAt: { type: ['string', 'null'], format: 'date-time' },
    cancelledAt: { type: ['string', 'null'], format: 'date-time' },

    // Correction snapshot — only populated if outcome was overridden
    previousOutcome: { type: ['string', 'null'], enum: [...FIGHT_OUTCOME, null] },
    previousPayoutRatioMeron: { type: ['string', 'null'] },
    previousPayoutRatioWala: { type: ['string', 'null'] },
    correctedAt: { type: ['string', 'null'], format: 'date-time' },
    correctedByUserId: { type: ['string', 'null'] },
    correctionReason: { type: ['string', 'null'] },

    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' }
  }
}

// Every action endpoint returns this exact shape so clients can treat them
// uniformly. `replay` is only set on idempotent operations (hold/unhold).
const fightActionResponseSchema = {
  type: 'object',
  required: ['fight'],
  properties: {
    fight: fightSchema,
    replay: { type: 'boolean' }
  }
}

// ---------------------------------------------------------------------------
// POST /fights — create
// ---------------------------------------------------------------------------

export const createFightRequestSchema = {
  type: 'object',
  additionalProperties: false,
  // Empty by design. fightNumber and commissionRate are server-assigned.
  properties: {}
}

export const createFightResponseSchema = {
  201: {
    type: 'object',
    required: ['fight'],
    properties: { fight: fightSchema }
  }
}

// ---------------------------------------------------------------------------
// GET /fights — list with filters
// ---------------------------------------------------------------------------

export const listFightsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: FIGHT_STATUS },
    current: {
      type: 'boolean',
      description:
        'true → only fights in OPEN, LAST_CALL, or CLOSED (i.e. live or awaiting ' +
        'settlement). SETTLED / CANCELLED are historical; legacy SCHEDULED ' +
        'rows are also excluded.'
    },
    limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    cursor: { type: 'string', description: 'Opaque cursor — pass the previous response\'s nextCursor.' }
  }
}

export const listFightsResponseSchema = {
  200: {
    type: 'object',
    required: ['fights', 'nextCursor'],
    properties: {
      fights: { type: 'array', items: fightSchema },
      nextCursor: { type: ['string', 'null'] }
    }
  }
}

// ---------------------------------------------------------------------------
// Path params shared by every /fights/:id route
// ---------------------------------------------------------------------------

export const fightIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: cuidPattern } }
}

// ---------------------------------------------------------------------------
// GET /fights/:id — detail
// ---------------------------------------------------------------------------

export const fightDetailResponseSchema = {
  200: {
    type: 'object',
    required: ['fight'],
    properties: { fight: fightSchema }
  }
}

// ---------------------------------------------------------------------------
// POST /fights/:id/open|close — no body, generic action response
// ---------------------------------------------------------------------------

export const fightActionResponses = { 200: fightActionResponseSchema }

// ---------------------------------------------------------------------------
// POST /fights/:id/settle — outcome required
// ---------------------------------------------------------------------------

export const settleFightRequestSchema = {
  type: 'object',
  required: ['outcome'],
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: FIGHT_OUTCOME }
  }
}

// ---------------------------------------------------------------------------
// POST /fights/:id/cancel — reason recommended (logged, not persisted on
// Fight today — see docs/missing-endpoints.md note).
// ---------------------------------------------------------------------------

export const cancelFightRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 200 }
  }
}

// ---------------------------------------------------------------------------
// POST /fights/:id/correct — outcome + reason required (audit-grade action)
// ---------------------------------------------------------------------------

export const correctFightRequestSchema = {
  type: 'object',
  required: ['outcome', 'reason'],
  additionalProperties: false,
  properties: {
    outcome: { type: 'string', enum: FIGHT_OUTCOME },
    reason: { type: 'string', minLength: 1, maxLength: 200 }
  }
}

// ---------------------------------------------------------------------------
// POST /fights/:id/unsettle — SETTLED → CLOSED (no body)
// ---------------------------------------------------------------------------

export const unsettleFightResponseSchema = {
  200: {
    type: 'object',
    required: ['fight', 'summary'],
    properties: {
      fight: fightSchema,
      summary: {
        type: 'object',
        required: ['betsReset', 'voidedSkipped', 'resettableCount', 'closedFights'],
        properties: {
          betsReset: { type: 'integer' },
          voidedSkipped: { type: 'integer' },
          resettableCount: { type: 'integer' },
          closedFights: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'fightNumber', 'betCount'],
              properties: {
                id: { type: 'string' },
                fightNumber: { type: 'integer' },
                betCount: { type: 'integer' }
              }
            }
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// POST /fights/:id/sides/:side/hold|unhold — :side path param
// ---------------------------------------------------------------------------

export const sideParamsSchema = {
  type: 'object',
  required: ['id', 'side'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', pattern: cuidPattern },
    side: { type: 'string', enum: SIDE }
  }
}
