// JSON schemas for the reports module.
//
// Convention: monetary values are returned as fixed-2 strings (e.g.
// "1250.00") to match the rest of the API and avoid any FP rounding
// surprises on the wire. The DB Decimal columns preserve full precision
// internally; we format at the projection boundary.

const cuidPattern = '^[a-z0-9]{20,32}$'

// ---------------------------------------------------------------------------
// GET /reports/teller-commissions  — querystring
// ---------------------------------------------------------------------------

export const tellerCommissionsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since: {
      type: 'string',
      format: 'date-time',
      description:
        'Lower bound (inclusive) on `bet.createdAt`. Use this to scope ' +
        'the leaderboard to a single shift / session. Omit for "all time".'
    },
    until: {
      type: 'string',
      format: 'date-time',
      description: 'Upper bound (inclusive) on `bet.createdAt`. Omit for "now".'
    },
    fightId: {
      type: 'string',
      pattern: cuidPattern,
      description:
        'Restrict to a single fight. Useful for per-fight commission ' +
        'attribution (e.g. "who generated commission on fight #1042?").'
    },
    includeInactive: {
      type: 'boolean',
      default: true,
      description:
        'Whether to include tellers whose `User.isActive = false`. Default ' +
        'true — a teller who took bets earlier in the night then got ' +
        'deactivated MUST still appear in the leaderboard or the totals ' +
        'won\'t reconcile.'
    }
  }
}

// ---------------------------------------------------------------------------
// Response — per-teller row.
// ---------------------------------------------------------------------------

const tellerCommissionRowSchema = {
  type: 'object',
  required: [
    'tellerId', 'username', 'fullName', 'isActive',
    'betCount', 'grossHandle', 'winningStake', 'losingStake',
    'commissionGenerated'
  ],
  properties: {
    tellerId: { type: 'string' },
    username: { type: 'string' },
    fullName: { type: 'string' },
    isActive: { type: 'boolean' },
    // Count of bets that contributed to commission — i.e. bets whose
    // status is WON / LOST / PAID. PENDING / VOIDED / REFUNDED bets
    // are excluded because they did not generate house commission.
    betCount: { type: 'integer', minimum: 0 },
    // Sum of stakes on those contributing bets.
    grossHandle: { type: 'string' },
    // Subset of grossHandle on bets that ended WON or PAID.
    winningStake: { type: 'string' },
    // Subset of grossHandle on bets that ended LOST.
    losingStake: { type: 'string' },
    // The headline metric: SUM(bet.stake × (fight.commissionRate / 2)). Because
    // the rate is snapshotted per fight, this is correct even if the
    // commission rate has been changed mid-session.
    commissionGenerated: { type: 'string' }
  }
}

// ---------------------------------------------------------------------------
// Response — full shape.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// GET /reports/fight-commissions  — querystring
// ---------------------------------------------------------------------------

export const fightCommissionsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    since: {
      type: 'string',
      format: 'date-time',
      description:
        'Lower bound on fight activity (`settledAt`, or `createdAt` if not settled).'
    },
    until: {
      type: 'string',
      format: 'date-time',
      description: 'Upper bound on fight activity.'
    }
  }
}

const fightCommissionRowSchema = {
  type: 'object',
  required: [
    'fightId', 'fightNumber', 'status', 'outcome', 'commissionRate',
    'grossHandle', 'commission', 'betCount', 'pendingBetCount', 'wasCorrected',
    'settledAt'
  ],
  properties: {
    fightId: { type: 'string' },
    fightNumber: { type: 'integer' },
    status: { type: 'string' },
    outcome: { type: ['string', 'null'] },
    commissionRate: { type: 'string' },
    grossHandle: { type: 'string', description: 'meronPool + walaPool at report time.' },
    commission: {
      type: 'string',
      description: 'House commission (SETTLED MERON/WALA: grossHandle × commissionRate / 2).'
    },
    betCount: { type: 'integer', minimum: 0 },
    pendingBetCount: { type: 'integer', minimum: 0 },
    wasCorrected: { type: 'boolean' },
    settledAt: { type: ['string', 'null'], format: 'date-time' }
  }
}

export const fightCommissionsResponseSchema = {
  200: {
    type: 'object',
    required: ['scope', 'fights', 'totals'],
    properties: {
      scope: {
        type: 'object',
        required: ['since', 'until'],
        properties: {
          since: { type: ['string', 'null'], format: 'date-time' },
          until: { type: ['string', 'null'], format: 'date-time' }
        }
      },
      fights: {
        type: 'array',
        description: 'One row per fight, newest fight number first.',
        items: fightCommissionRowSchema
      },
      totals: {
        type: 'object',
        required: ['fightCount', 'betCount', 'grossHandle', 'commission'],
        properties: {
          fightCount: { type: 'integer', minimum: 0 },
          betCount: { type: 'integer', minimum: 0 },
          grossHandle: { type: 'string' },
          commission: { type: 'string' }
        }
      }
    }
  }
}

export const tellerCommissionsResponseSchema = {
  200: {
    type: 'object',
    required: ['scope', 'tellers', 'totals'],
    properties: {
      scope: {
        description:
          'Echo of the applied filters so the client can confirm what the ' +
          'numbers represent. `null` for any filter that wasn\'t supplied.',
        type: 'object',
        required: ['since', 'until', 'fightId', 'includeInactive'],
        properties: {
          since: { type: ['string', 'null'], format: 'date-time' },
          until: { type: ['string', 'null'], format: 'date-time' },
          fightId: { type: ['string', 'null'] },
          includeInactive: { type: 'boolean' }
        }
      },
      tellers: {
        type: 'array',
        description:
          'One row per teller who has at least one commission-generating ' +
          'bet in scope. Sorted by commissionGenerated DESC (productivity ' +
          'ranking), with username ASC as a stable tiebreaker.',
        items: tellerCommissionRowSchema
      },
      totals: {
        description:
          'House-side aggregates. SANITY CHECK: SUM(tellers[i].commissionGenerated) ' +
          'MUST equal totals.commissionGenerated. If those drift, there is a bug.',
        type: 'object',
        required: ['tellerCount', 'betCount', 'grossHandle', 'commissionGenerated'],
        properties: {
          tellerCount: { type: 'integer', minimum: 0 },
          betCount: { type: 'integer', minimum: 0 },
          grossHandle: { type: 'string' },
          commissionGenerated: { type: 'string' }
        }
      }
    }
  }
}
