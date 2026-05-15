// Collectors service.
//
// A Collector is a managed *label* — not a User. They never authenticate.
// Their identity exists only as a name string referenced from
// TellerLedger rows (CASH_ADVANCE / REMIT), so historical ledger entries
// stay human-readable.
//
// Retirement is soft (isActive=false) — never DELETE. The schema has
// `onDelete: Restrict` on the back-relation from TellerLedger, so a hard
// delete on any row with history would fail anyway; soft-delete is the
// only sane path.
//
// Concurrency is not a concern at this scale: a tiny set of admins editing
// a tiny set of rows. The unique constraint on `name` is the only race
// to worry about, and Prisma's P2002 → ConflictError pipeline handles it.

import { BadRequestError, ConflictError, NotFoundError } from '../../lib/errors.js'
import { generateUniqueCode } from '../../lib/code-generator.js'

/**
 * Normalize a name string the same way for every write path. We trim and
 * collapse internal whitespace so "  Pedro   Santos  " and "Pedro Santos"
 * land on the same canonical form. Validation against the empty string
 * lives here so a service-layer caller cannot bypass the route schema.
 */
function normalizeName(rawName) {
  if (typeof rawName !== 'string') {
    throw new BadRequestError('name must be a string')
  }
  const trimmed = rawName.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) {
    throw new BadRequestError('name cannot be empty or whitespace-only')
  }
  return trimmed
}

// Map Prisma's unique-violation error code to our domain-specific 409.
// Used by every write path so the surface is consistent.
function rethrowUniqueViolation(err, message) {
  if (err?.code === 'P2002') {
    throw new ConflictError(message, { field: 'name' })
  }
  throw err
}

export async function createCollector(prisma, { name }) {
  const normalized = normalizeName(name)

  // Pre-flight a unique scannable barcode. Done outside any transaction
  // because there's nothing else to coordinate with — a collision on
  // the unique index would just trigger a P2002 we'd handle the same
  // way as a name collision.
  const code = await generateUniqueCode({
    prefix: 'COL',
    label: 'collector code',
    isUsed: async (candidate) => {
      const row = await prisma.collector.findUnique({
        where: { code: candidate },
        select: { id: true }
      })
      return row !== null
    }
  })

  try {
    return await prisma.collector.create({
      data: { name: normalized, code, isActive: true }
    })
  } catch (err) {
    if (err?.code === 'P2002') {
      // P2002 carries `meta.target` listing the conflicting columns.
      // Disambiguate so the API surfaces the actual cause: name vs
      // code (the latter is a vanishingly rare race with a concurrent
      // creation that grabbed our generated code between check and
      // insert; surfacing it as a 500-flavored conflict tells the
      // caller to just retry).
      const target = Array.isArray(err.meta?.target) ? err.meta.target : []
      if (target.includes('code')) {
        throw new ConflictError(
          'Generated collector code collided with an existing row — please retry',
          { field: 'code' }
        )
      }
      throw new ConflictError('A collector with this name already exists', { field: 'name' })
    }
    throw err
  }
}

export async function listCollectors(prisma, { isActive } = {}) {
  return prisma.collector.findMany({
    where: { ...(isActive !== undefined ? { isActive } : {}) },
    orderBy: [
      // Active collectors first (false sorts before true with desc), then
      // alphabetical. Admins see the working set up top; retired entries
      // sit at the bottom of the list.
      { isActive: 'desc' },
      { name: 'asc' }
    ]
  })
}

export async function getCollector(prisma, id) {
  const collector = await prisma.collector.findUnique({ where: { id } })
  if (!collector) throw new NotFoundError('Collector not found')
  return collector
}

// Scan-by-barcode lookup. Returns the collector regardless of isActive
// — the caller (e.g. the cash-advance/remit form) is responsible for
// checking activeness before submitting; surfacing inactive collectors
// here lets the UI explain *why* a scan isn't accepted instead of
// pretending the code doesn't exist.
export async function getCollectorByCode(prisma, code) {
  const collector = await prisma.collector.findUnique({ where: { code } })
  if (!collector) throw new NotFoundError('No collector matches that code')
  return collector
}

export async function updateCollector(prisma, id, { name, isActive }) {
  // Ensure the row exists first so we return a clean 404 instead of
  // Prisma's `P2025 record not found` from the update call.
  await getCollector(prisma, id)

  const data = {}
  if (name !== undefined) data.name = normalizeName(name)
  if (isActive !== undefined) data.isActive = isActive

  // Empty-patch is a legal no-op. Returning the current row keeps the
  // endpoint idempotent without forcing the client to pre-check.
  if (Object.keys(data).length === 0) {
    return getCollector(prisma, id)
  }

  try {
    return await prisma.collector.update({ where: { id }, data })
  } catch (err) {
    rethrowUniqueViolation(err, 'Another collector already has this name')
  }
}
