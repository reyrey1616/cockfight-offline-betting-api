// Settings service.
//
// Concurrency: the singleton row is updated by a single UPDATE statement,
// which is atomic at the row level. Two simultaneous admin PATCHes become
// a last-write-wins sequence; `updatedAt` records which write actually
// landed. There are no related-row updates so no transaction is needed.
//
// Audit trail: every successful change is logged at the request layer
// (see settings.routes.js) with the actor's user id and the before/after
// values. A dedicated SettingHistory table is overkill for one field;
// promote to one only if multi-field audit is ever required.

import { InvariantError } from '../../lib/errors.js'

const SINGLETON_ID = 'singleton'

/**
 * Read the singleton Setting row. Throws InvariantError if missing —
 * `seed.js` is supposed to create it on first deploy, so a missing row
 * is a setup bug we surface loudly rather than silently fabricating
 * defaults.
 */
export async function getSetting(prisma) {
  const setting = await prisma.setting.findUnique({ where: { id: SINGLETON_ID } })
  if (!setting) {
    throw new InvariantError('Setting singleton is missing — run prisma db seed')
  }
  return setting
}

/**
 * Update the singleton Setting. Returns BOTH the before and after rows
 * so the route layer can emit a structured audit log line. The caller
 * passes a `commissionRate` number; we serialize it as a 4-decimal string
 * to match the DB column precision (Decimal(5,4)).
 */
export async function updateSetting(prisma, { commissionRate }) {
  const before = await getSetting(prisma)

  // Skip the write if nothing actually changes — keeps the audit signal
  // clean (no spurious "rate changed from 0.10 to 0.10" log lines).
  const newRateString = toRateString(commissionRate)
  if (sameRate(before.commissionRate, newRateString)) {
    return { before, after: before, changed: false }
  }

  const after = await prisma.setting.update({
    where: { id: SINGLETON_ID },
    data: { commissionRate: newRateString }
  })
  return { before, after, changed: true }
}

// Serialize a JS number as a 4-decimal string so Prisma's Decimal column
// receives an exact representation. JS Math: 0.15 → "0.1500".
function toRateString(n) {
  return (Math.round(n * 10000) / 10000).toFixed(4)
}

function sameRate(a, b) {
  if (a === b) return true
  if (a == null || b == null) return false
  return Number(a.toString()) === Number(b.toString())
}
