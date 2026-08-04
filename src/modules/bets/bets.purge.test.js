import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  computeCommissionDrop,
  isPurgeableBetStatus,
  planPurgeCashAdjustments
} from './bets.purge.js'

describe('bets.purge helpers', () => {
  it('computes report and dashboard commission drop from stake × rate', () => {
    assert.deepEqual(computeCommissionDrop('200.00', '0.15'), {
      reportCommissionDrop: '30.00',
      dashboardCommissionDrop: '15.00'
    })
  })

  it('only PAID bets are purgeable', () => {
    assert.equal(isPurgeableBetStatus('PAID'), true)
    assert.equal(isPurgeableBetStatus('LOST'), false)
    assert.equal(isPurgeableBetStatus('WON'), false)
    assert.equal(isPurgeableBetStatus('PENDING'), false)
  })

  it('nets cash to −dashboard commission for the bet-taker (PAID same teller)', () => {
    // BET_PLACED +200, PAYOUT −370 → ledger sum −170; delete alone would +170 cash.
    // Want −15 commission → ADJUSTMENT −185.
    const plan = planPurgeCashAdjustments({
      betTellerId: 't1',
      dashboardCommissionDrop: '15.00',
      ledgerRows: [
        { tellerId: 't1', amount: '200.00' },
        { tellerId: 't1', amount: '-370.00' }
      ]
    })
    assert.deepEqual(plan, [
      {
        tellerId: 't1',
        ledgerSumRemoved: '-170.00',
        deltaFromLedgerDelete: '170.00',
        desiredCashDelta: '-15.00',
        adjustmentAmount: '-185.00',
        cashOnHandDelta: '-15.00'
      }
    ])
  })

  it('restores paying teller to zero net change when payout was on another drawer', () => {
    const plan = planPurgeCashAdjustments({
      betTellerId: 'placer',
      dashboardCommissionDrop: '15.00',
      ledgerRows: [
        { tellerId: 'placer', amount: '200.00' },
        { tellerId: 'payer', amount: '-370.00' }
      ]
    })
    assert.deepEqual(plan, [
      {
        tellerId: 'payer',
        ledgerSumRemoved: '-370.00',
        deltaFromLedgerDelete: '370.00',
        desiredCashDelta: '0.00',
        adjustmentAmount: '-370.00',
        cashOnHandDelta: '0.00'
      },
      {
        tellerId: 'placer',
        ledgerSumRemoved: '200.00',
        deltaFromLedgerDelete: '-200.00',
        desiredCashDelta: '-15.00',
        adjustmentAmount: '185.00',
        cashOnHandDelta: '-15.00'
      }
    ])
  })
})
