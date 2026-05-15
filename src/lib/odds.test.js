import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { computeLiveOdds } from './odds.js'

describe('computeLiveOdds', () => {
  it('computes pari-mutuel odds with commission', () => {
    const { meronOdds, walaOdds } = computeLiveOdds({
      meronPool: '1000',
      walaPool: '800',
      commissionRate: '0.10'
    })
    assert.equal(meronOdds, 1.72)
    assert.equal(walaOdds, 2.13)
  })

  it('returns null for a side with zero pool', () => {
    const { meronOdds, walaOdds } = computeLiveOdds({
      meronPool: '0',
      walaPool: '500',
      commissionRate: '0.10'
    })
    assert.equal(meronOdds, null)
    // No opposing money → winners on Wala only get stake back (1.00×).
    assert.equal(walaOdds, 1)
  })
})
