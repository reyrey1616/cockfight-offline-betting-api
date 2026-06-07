import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeFightCommission } from './reports.fight-commission.js'

describe('computeFightCommission', () => {
  it('returns full-rate commission on settled winner fights', () => {
    assert.equal(computeFightCommission(1800, 0.1, 'SETTLED', 'MERON'), 180)
  })

  it('returns projected commission while fight is still open', () => {
    assert.equal(computeFightCommission(420, 0.075, 'OPEN', null), 31.5)
  })

  it('returns zero for cancelled or draw outcomes', () => {
    assert.equal(computeFightCommission(1800, 0.1, 'SETTLED', 'DRAW'), 0)
    assert.equal(computeFightCommission(1800, 0.1, 'CANCELLED', 'CANCELLED'), 0)
  })
})
