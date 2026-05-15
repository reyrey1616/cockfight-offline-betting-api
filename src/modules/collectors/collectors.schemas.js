// JSON schemas for the collectors module.

const cuidPattern = '^[a-z0-9]{20,32}$'

// 8-char public collector barcode: "COL" + 5 reduced-alphabet chars.
// Generator + alphabet live in src/lib/code-generator.js.
const collectorCodePattern = '^COL[A-Z0-9]{5}$'

// Name policy:
//   - 2 to 80 characters after trim (single-letter "names" are almost
//     certainly typos; 80 fits any realistic Filipino full name).
//   - No format regex. Filipino names freely mix letters, accents,
//     spaces, hyphens, apostrophes, periods (Jr., Sr., II) — encoding
//     that as a regex is more pain than it's worth. We enforce length
//     here and let the service layer reject pure-whitespace input after
//     trim.
const NAME_MIN = 2
const NAME_MAX = 80

const collectorSchema = {
  type: 'object',
  required: ['id', 'code', 'name', 'isActive', 'createdAt', 'updatedAt'],
  properties: {
    id: { type: 'string' },
    code: {
      type: 'string',
      pattern: collectorCodePattern,
      description: 'Public scannable barcode (8 chars, "COL" + 5 reduced-alphabet). Issued at creation; never re-issued.'
    },
    name: { type: 'string' },
    isActive: { type: 'boolean' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' }
  }
}

// ---------------------------------------------------------------------------
// POST /collectors
// ---------------------------------------------------------------------------

export const createCollectorRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: {
      type: 'string',
      minLength: NAME_MIN,
      maxLength: NAME_MAX,
      description: `Display name. ${NAME_MIN}–${NAME_MAX} chars after trim. Must be unique (case-sensitive).`
    }
  }
}

export const createCollectorResponseSchema = {
  201: {
    type: 'object',
    required: ['collector'],
    properties: { collector: collectorSchema }
  }
}

// ---------------------------------------------------------------------------
// GET /collectors
// ---------------------------------------------------------------------------

export const listCollectorsQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isActive: { type: 'boolean', description: 'Filter by active flag. Omit for all.' }
  }
}

export const listCollectorsResponseSchema = {
  200: {
    type: 'object',
    required: ['collectors'],
    properties: {
      collectors: { type: 'array', items: collectorSchema }
    }
  }
}

// ---------------------------------------------------------------------------
// GET /collectors/:id
// ---------------------------------------------------------------------------

export const collectorIdParamsSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', pattern: cuidPattern } }
}

export const getCollectorResponseSchema = {
  200: {
    type: 'object',
    required: ['collector'],
    properties: { collector: collectorSchema }
  }
}

// ---------------------------------------------------------------------------
// GET /collectors/code/:code  — scan-by-barcode lookup
// ---------------------------------------------------------------------------

export const collectorCodeParamsSchema = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: {
    code: {
      type: 'string',
      pattern: collectorCodePattern,
      description: '8-char collector barcode ("COL" + 5 reduced-alphabet).'
    }
  }
}

export const getCollectorByCodeResponseSchema = {
  200: {
    type: 'object',
    required: ['collector'],
    properties: { collector: collectorSchema }
  }
}

// ---------------------------------------------------------------------------
// PATCH /collectors/:id
//
// Both fields optional — admin may rename, soft-delete, reactivate, or
// any combination. Empty body is allowed (idempotent no-op), matching
// the convention used by PATCH /users/:id.
// ---------------------------------------------------------------------------

export const updateCollectorRequestSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: NAME_MIN, maxLength: NAME_MAX },
    isActive: { type: 'boolean' }
  }
}

export const updateCollectorResponseSchema = {
  200: {
    type: 'object',
    required: ['collector'],
    properties: { collector: collectorSchema }
  }
}
