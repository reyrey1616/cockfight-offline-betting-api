// Pure bet-void eligibility rules — shared by service pre-checks and tests.
// A teller may void (cancel) only their own PENDING ticket while the fight is OPEN or LAST_CALL.

const VOIDABLE_FIGHT_STATUSES = new Set(['OPEN', 'LAST_CALL'])
const VOIDABLE_BET_STATUS = 'PENDING'

const FIGHT_STATUS_MESSAGES = {
  SCHEDULED: 'This fight is not open for betting yet.',
  CLOSED: 'Betting is closed for this fight. Tickets can only be cancelled while betting is still open.',
  SETTLED: 'This fight has been settled. Tickets can no longer be cancelled.',
  CANCELLED: 'This fight was cancelled. Use the refund status on your ticket — individual void is not available.'
}

const BET_STATUS_MESSAGES = {
  WON: 'This ticket won and cannot be voided.',
  LOST: 'This ticket lost and cannot be voided.',
  PAID: 'This ticket has already been paid out and cannot be voided.',
  REFUNDED: 'This ticket was refunded and cannot be voided.',
  PENDING_REFUND: 'This ticket is awaiting refund at the payout desk and cannot be voided.',
  VOIDED: 'This ticket is already voided.'
}

/**
 * @param {{ betStatus: string, fightStatus: string }} input
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function evaluateBetVoidEligibility({ betStatus, fightStatus }) {
  if (betStatus === 'VOIDED') {
    return { allowed: false, reason: BET_STATUS_MESSAGES.VOIDED }
  }

  if (!VOIDABLE_FIGHT_STATUSES.has(fightStatus)) {
    const reason =
      FIGHT_STATUS_MESSAGES[fightStatus] ??
      'Tickets can only be cancelled while the fight is open for betting.'
    return { allowed: false, reason }
  }

  if (betStatus !== VOIDABLE_BET_STATUS) {
    const reason =
      BET_STATUS_MESSAGES[betStatus] ??
      'Only pending tickets can be cancelled.'
    return { allowed: false, reason }
  }

  return { allowed: true }
}
