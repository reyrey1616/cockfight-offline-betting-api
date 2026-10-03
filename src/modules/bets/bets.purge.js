// Pure helpers for admin bet purge (commission / cash impact preview).

/**
 * Commission attributed in teller reports: stake × fight.commissionRate.
 * Dashboard UI displays half of that (house share of both sides).
 */
export function computeCommissionDrop(stake, commissionRate) {
  const amount = Number(stake)
  const rate = Number(commissionRate)
  if (!Number.isFinite(amount) || !Number.isFinite(rate)) {
    return {
      reportCommissionDrop: '0.00',
      dashboardCommissionDrop: '0.00'
    }
  }
  const report = amount * rate
  return {
    reportCommissionDrop: report.toFixed(2),
    dashboardCommissionDrop: (report / 2).toFixed(2)
  }
}

/**
 * After removing bet ledger rows, cash would change by −ledgerSum per teller.
 * Purge must leave every teller's cash on hand unchanged, so each affected
 * teller gets a compensating ADJUSTMENT equal to the ledger sum removed.
 *
 * adjustment = desiredDelta − deltaFromDeletingLedger
 *            = 0 − (−ledgerSum)
 *            = ledgerSum
 *
 * @param {object} args
 * @param {string} args.betTellerId  Teller who took the bet.
 * @param {Array<{ tellerId: string, amount: string|number }>} args.ledgerRows
 * @returns {Array<{
 *   tellerId: string,
 *   ledgerSumRemoved: string,
 *   deltaFromLedgerDelete: string,
 *   desiredCashDelta: string,
 *   adjustmentAmount: string,
 *   cashOnHandDelta: string
 * }>}
 */
export function planPurgeCashAdjustments({ betTellerId, ledgerRows }) {
  const sums = new Map()
  for (const row of ledgerRows) {
    const prev = sums.get(row.tellerId) ?? 0
    sums.set(row.tellerId, prev + Number(row.amount))
  }
  if (!sums.has(betTellerId)) sums.set(betTellerId, 0)

  return [...sums.entries()]
    .map(([tellerId, ledgerSum]) => {
      const deltaFromLedgerDelete = -ledgerSum
      const desiredCashDelta = 0
      const adjustmentAmount = desiredCashDelta - deltaFromLedgerDelete
      return {
        tellerId,
        ledgerSumRemoved: ledgerSum.toFixed(2),
        deltaFromLedgerDelete: deltaFromLedgerDelete.toFixed(2),
        desiredCashDelta: desiredCashDelta.toFixed(2),
        adjustmentAmount: adjustmentAmount.toFixed(2),
        // Final cash effect after ledger delete + compensating ADJUSTMENT.
        cashOnHandDelta: desiredCashDelta.toFixed(2)
      }
    })
    .sort((a, b) => a.tellerId.localeCompare(b.tellerId))
}

/** Purge is only for fully paid winners on settled fights. */
export const PURGEABLE_BET_STATUSES = Object.freeze(['PAID'])

export function isPurgeableBetStatus(status) {
  return PURGEABLE_BET_STATUSES.includes(status)
}
