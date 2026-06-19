import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assertValidOutcome,
  computePayoutRatios,
  determineBetTargetState,
  planCancellationForBet,
  planSettlementForBet
} from './fight-settlement.js'

describe('computePayoutRatios', () => {
  it('returns null ratios for draw', () => {
    const ratios = computePayoutRatios({
      meronPool: '1000',
      walaPool: '800',
      commissionRate: '0.10',
      outcome: 'DRAW'
    })
    assert.equal(ratios.payoutRatioMeron, null)
    assert.equal(ratios.payoutRatioWala, null)
  })

  it('computes meron winner ratio', () => {
    const ratios = computePayoutRatios({
      meronPool: '1000',
      walaPool: '800',
      commissionRate: '0.10',
      outcome: 'MERON'
    })
    assert.equal(ratios.payoutRatioMeron, '1.71')
    assert.equal(ratios.payoutRatioWala, null)
  })

  it('rejects invalid outcomes', () => {
    assert.throws(() => assertValidOutcome('INVALID'))
  })
})

describe('determineBetTargetState', () => {
  const ratios = {
    outcome: 'MERON',
    payoutRatioMeron: '1.71',
    payoutRatioWala: null
  }

  it('marks winning meron bet as WON with payout', () => {
    const result = determineBetTargetState(ratios, {
      side: 'MERON',
      amount: '100.00'
    })
    assert.equal(result.targetStatus, 'WON')
    assert.equal(result.targetPayoutAmount, '171.00')
  })

  it('marks losing wala bet as LOST', () => {
    const result = determineBetTargetState(ratios, {
      side: 'WALA',
      amount: '50.00'
    })
    assert.equal(result.targetStatus, 'LOST')
    assert.equal(result.targetPayoutAmount, null)
  })

  it('refunds all bets on draw', () => {
    const result = determineBetTargetState(
      { outcome: 'DRAW', payoutRatioMeron: null, payoutRatioWala: null },
      { side: 'WALA', amount: '75.00' }
    )
    assert.equal(result.targetStatus, 'PENDING_REFUND')
    assert.equal(result.targetPayoutAmount, '75.00')
  })
})

describe('planSettlementForBet', () => {
  it('skips voided bets', () => {
    const plan = planSettlementForBet(
      { outcome: 'MERON', payoutRatioMeron: '1.5', payoutRatioWala: null },
      { id: 'b1', status: 'VOIDED', amount: '10', side: 'MERON', tellerId: 't1' }
    )
    assert.equal(plan.skip, true)
  })

  it('plans pending refund on draw without ledger', () => {
    const plan = planSettlementForBet(
      { outcome: 'DRAW', payoutRatioMeron: null, payoutRatioWala: null },
      { id: 'b2', status: 'PENDING', amount: '100.00', side: 'MERON', tellerId: 't1' }
    )
    assert.equal(plan.update.data.status, 'PENDING_REFUND')
    assert.equal(plan.ledger, null)
  })
})

describe('planCancellationForBet', () => {
  it('marks pending refund on fight cancel without ledger', () => {
    const plan = planCancellationForBet(
      { id: 'b3', status: 'PENDING', amount: '200.00', tellerId: 't1' },
      { reason: 'weather' }
    )
    assert.equal(plan.update.data.status, 'PENDING_REFUND')
    assert.equal(plan.ledger, null)
  })
})
