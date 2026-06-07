// Per-fight commission projection helpers (pure — testable without DB).

/**
 * House commission for a fight row in the dashboard.
 * Reported as total handle (both sides) × snapshotted commission rate.
 * Zero for cancelled fights and settled draw/refund outcomes.
 */
export function computeFightCommission(grossHandle, commissionRate, status, outcome) {
  if (status === 'CANCELLED') return 0
  if (status === 'SETTLED' && outcome !== 'MERON' && outcome !== 'WALA') return 0

  const gross = Number(grossHandle)
  const rate = Number(commissionRate)
  if (!Number.isFinite(gross) || gross <= 0) return 0
  if (!Number.isFinite(rate)) return 0
  return gross * rate
}

export function toMoney(v) {
  if (v === null || v === undefined) return '0.00'
  if (typeof v?.toFixed === 'function') return v.toFixed(2)
  return Number(v).toFixed(2)
}

export function addMoney(a, b) {
  const totalCent = Math.round(Number(a) * 100) + Math.round(Number(b) * 100)
  return (totalCent / 100).toFixed(2)
}
