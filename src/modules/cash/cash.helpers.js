// Pure cash helpers — no I/O (testable in isolation).

import { BadRequestError, ForbiddenError } from '../../lib/errors.js'

export function toMoneyString(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new BadRequestError('amount must be a finite number')
  }
  const cents = Math.round(amount * 100)
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    throw new BadRequestError('amount must have at most 2 decimal places')
  }
  return (cents / 100).toFixed(2)
}

export function negate(amountString) {
  return amountString.startsWith('-')
    ? amountString.slice(1)
    : `-${amountString}`
}

export function resolveAdvanceRecipientId(actor, tellerId) {
  if (actor.role === 'TELLER') {
    if (tellerId && tellerId !== actor.id) {
      throw new ForbiddenError('Tellers can only record deposits to their own drawer')
    }
    return actor.id
  }
  if (actor.role === 'ADMIN') {
    if (!tellerId) {
      throw new BadRequestError('tellerId is required when recording a deposit as admin')
    }
    return tellerId
  }
  throw new ForbiddenError('Only ADMIN or TELLER may record a cash deposit')
}
