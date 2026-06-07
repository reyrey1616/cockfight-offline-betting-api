// JSON schemas for the settings module.
//
// Wire convention reused from the rest of the codebase:
//   - decimal columns surface as STRINGS in responses (avoid float
//     precision loss on the receiver).
//   - request bodies accept numbers for ergonomic admin UX; the service
//     layer coerces to a decimal string before write.
//   - request schemas set `additionalProperties: false` so unknown fields
//     fail validation rather than being silently dropped.

const settingSchema = {
  type: 'object',
  required: ['id', 'commissionRate', 'updatedAt'],
  properties: {
    id: { type: 'string', enum: ['singleton'], description: 'Always the literal "singleton" — this is a single-row table.' },
    commissionRate: {
      type: 'string',
      description:
        'House commission ("tong") as a decimal fraction (e.g. "0.1000" = 10%). ' +
        'Snapshotted onto each Fight at creation time; changes here only affect ' +
        'fights created AFTER the change.'
    },
    updatedAt: { type: 'string', format: 'date-time' }
  }
}

export const getSettingsResponseSchema = {
  200: {
    type: 'object',
    required: ['setting'],
    properties: { setting: settingSchema }
  }
}

// PATCH /settings — only commissionRate is mutable today. We mark it
// required (rather than leaving the body fully optional) because the
// endpoint's sole purpose right now is changing that one value; an empty
// body would almost always be a UI bug. When a second mutable field is
// added, relax this to `required: []` and require "at least one field" at
// the service layer.
export const updateSettingsRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['commissionRate'],
  properties: {
    commissionRate: {
      type: 'number',
      minimum: 0,
      // 0.3 == 30%. Empirically the highest sane sabong rate; anything
      // beyond is almost certainly a fat-finger. Easier to relax later
      // than to walk back an "admin set commission to 99%" incident.
      maximum: 0.3,
      description:
        'New commission rate as a decimal fraction (e.g. 0.15 = 15%). ' +
        'Range 0.0000–0.3000.'
    }
  }
}

export const updateSettingsResponseSchema = {
  200: {
    type: 'object',
    required: ['setting'],
    properties: { setting: settingSchema }
  }
}

export const adminVoidBarcodeResponseSchema = {
  200: {
    type: 'object',
    required: ['username', 'barcodeValue'],
    properties: {
      username: {
        type: 'string',
        description: 'Admin username (for slip label only; barcode encodes the password).'
      },
      barcodeValue: {
        type: 'string',
        description:
          'Plaintext admin login password — encoded as CODE128 for teller void authorization.'
      }
    }
  }
}
