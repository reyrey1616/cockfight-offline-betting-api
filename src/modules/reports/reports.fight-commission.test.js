import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeFightCommission } from './reports.fight-commission.js'

describe('computeFightCommission', () => {
  it('returns half-rate commission on settled winner fights', () => {
    assert.equal(computeFightCommission(1800, 0.1, 'SETTLED', 'MERON'), 90)
  })

  it('returns zero for cancelled or draw outcomes', () => {
    assert.equal(computeFightCommission(1800, 0.1, 'SETTLED', 'DRAW'), 0)
    assert.equal(computeFightCommission(1800, 0.1, 'CANCELLED', 'CANCELLED'), 0)
  })

  it('returns zero while fight is still open', () => {
    assert.equal(computeFightCommission(500, 0.1, 'OPEN', null), 0)
  })
})
