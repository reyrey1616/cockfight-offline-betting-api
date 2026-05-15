import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { BadRequestError, ForbiddenError } from '../../lib/errors.js'
import { negate, resolveAdvanceRecipientId, toMoneyString } from './cash.helpers.js'

describe('toMoneyString', () => {
  it('formats to two decimals', () => {
    assert.equal(toMoneyString(250.5), '250.50')
    assert.equal(toMoneyString(100), '100.00')
  })

  it('rejects more than two decimal places', () => {
    assert.throws(() => toMoneyString(10.123), BadRequestError)
  })
})

describe('negate', () => {
  it('prefixes minus for positive amounts', () => {
    assert.equal(negate('500.00'), '-500.00')
  })
})

describe('resolveAdvanceRecipientId', () => {
  const teller = { id: 'teller-1', role: 'TELLER' }
  const admin = { id: 'admin-1', role: 'ADMIN' }

  it('teller deposits to own drawer when tellerId omitted', () => {
    assert.equal(resolveAdvanceRecipientId(teller, undefined), 'teller-1')
  })

  it('teller cannot deposit to another drawer', () => {
    assert.throws(
      () => resolveAdvanceRecipientId(teller, 'other-teller'),
      ForbiddenError
    )
  })

  it('admin must supply tellerId', () => {
    assert.throws(() => resolveAdvanceRecipientId(admin, undefined), BadRequestError)
    assert.equal(resolveAdvanceRecipientId(admin, 'teller-2'), 'teller-2')
  })
})
