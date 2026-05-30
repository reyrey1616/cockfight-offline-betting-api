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
    assert.equal(meronOdds, 1.71)
    assert.equal(walaOdds, 2.13)
  })

  it('matches pool distributable formula (commission/2 of total handle)', () => {
    const { meronOdds, walaOdds } = computeLiveOdds({
      meronPool: '13280',
      walaPool: '10310',
      commissionRate: '0.15'
    })
    assert.equal(meronOdds, 1.64)
    assert.equal(walaOdds, 2.11)
  })

  it('returns null for a side with zero pool', () => {
    const { meronOdds, walaOdds } = computeLiveOdds({
      meronPool: '0',
      walaPool: '500',
      commissionRate: '0.10'
    })
    assert.equal(meronOdds, null)
    // No meron pool → wala pays distributable / wala (= 1 - commission/2).
    assert.equal(walaOdds, 0.95)
  })
})
