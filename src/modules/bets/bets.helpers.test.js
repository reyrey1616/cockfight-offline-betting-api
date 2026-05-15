import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { evaluateBetVoidEligibility } from './bets.helpers.js'

describe('evaluateBetVoidEligibility', () => {
  it('allows void for PENDING bet on OPEN fight', () => {
    const result = evaluateBetVoidEligibility({
      betStatus: 'PENDING',
      fightStatus: 'OPEN'
    })
    assert.equal(result.allowed, true)
  })

  it('blocks when fight is closed for betting', () => {
    const result = evaluateBetVoidEligibility({
      betStatus: 'PENDING',
      fightStatus: 'CLOSED'
    })
    assert.equal(result.allowed, false)
    assert.match(result.reason, /closed/i)
  })

  it('blocks when fight is settled', () => {
    const result = evaluateBetVoidEligibility({
      betStatus: 'PENDING',
      fightStatus: 'SETTLED'
    })
    assert.equal(result.allowed, false)
    assert.match(result.reason, /settled/i)
  })

  it('blocks when fight is cancelled', () => {
    const result = evaluateBetVoidEligibility({
      betStatus: 'PENDING',
      fightStatus: 'CANCELLED'
    })
    assert.equal(result.allowed, false)
    assert.match(result.reason, /cancelled/i)
  })

  it('blocks non-pending bet statuses', () => {
    for (const betStatus of ['WON', 'LOST', 'PAID', 'REFUNDED']) {
      const result = evaluateBetVoidEligibility({ betStatus, fightStatus: 'OPEN' })
      assert.equal(result.allowed, false, betStatus)
    }
  })

  it('blocks already voided tickets', () => {
    const result = evaluateBetVoidEligibility({
      betStatus: 'VOIDED',
      fightStatus: 'OPEN'
    })
    assert.equal(result.allowed, false)
    assert.match(result.reason, /voided/i)
  })
})
