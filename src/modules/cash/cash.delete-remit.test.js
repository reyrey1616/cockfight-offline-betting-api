import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import Fastify from 'fastify'

import errorHandlerPlugin from '../../plugins/error-handler.plugin.js'
import authPlugin from '../../plugins/auth.plugin.js'
import cashRoutes from './cash.routes.js'
import { SUPER_ADMIN_USERNAME } from '../../lib/super-admin.js'
import { errorResponseSchema } from '../../lib/api-schemas.js'

// In-memory stand-in for the Prisma surface the cash routes + auth touch.
// Amounts are stored as strings and wrapped so `.toFixed(2)` behaves like
// Prisma's Decimal.

const money = (value) => ({
  toFixed: (digits) => Number(value).toFixed(digits),
  toString: () => String(value)
})

function createFakePrisma({ users, ledger, collectors }) {
  let state = { ledger: ledger.map((r) => ({ ...r })) }
  let nextId = 1

  const hydrate = (row, include) => {
    if (!row) return null
    const out = { ...row, amount: money(row.amount) }
    if (include?.collector) {
      const c = collectors.find((x) => x.id === row.collectorId)
      out.collector = c ? { name: c.name } : null
    }
    if (include?.bet) out.bet = null
    return out
  }

  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => row[k] === v)

  const client = {
    user: {
      findUnique: async ({ where }) =>
        users.find((u) => (where.id ? u.id === where.id : u.username === where.username)) ?? null
    },
    tellerLedger: {
      findUnique: async ({ where, include }) =>
        hydrate(
          state.ledger.find((r) => (where.id ? r.id === where.id : r.code === where.code)),
          include
        ),
      findMany: async ({ where, include }) =>
        state.ledger
          .filter((r) => matches(r, where))
          .map((r) => hydrate(r, include)),
      delete: async ({ where }) => {
        const idx = state.ledger.findIndex((r) => r.id === where.id)
        if (idx === -1) throw Object.assign(new Error('not found'), { code: 'P2025' })
        const [removed] = state.ledger.splice(idx, 1)
        return hydrate(removed)
      },
      create: async ({ data }) => {
        const row = {
          id: `adj${String(nextId++).padStart(22, '0')}`,
          code: null,
          betId: null,
          collectorId: null,
          adjustedByUserId: null,
          notes: null,
          createdAt: new Date(),
          ...data,
          amount: String(data.amount)
        }
        state.ledger.push(row)
        return hydrate(row)
      },
      aggregate: async ({ where }) => {
        const rows = state.ledger.filter((r) => matches(r, where))
        if (rows.length === 0) return { _sum: { amount: null } }
        const sum = rows.reduce((acc, r) => acc + Number(r.amount), 0)
        return { _sum: { amount: money(sum) } }
      }
    },
    $transaction: async (fn) => {
      const snapshot = state.ledger.map((r) => ({ ...r }))
      try {
        return await fn(client)
      } catch (err) {
        state = { ledger: snapshot }
        throw err
      }
    },
    get ledgerRows () {
      return state.ledger
    }
  }
  return client
}

const ids = {
  superAdmin: 'superadmin00000000000001',
  admin: 'regularadmin000000000001',
  teller: 'teller000000000000000001',
  collector: 'collector000000000000001',
  remit: 'remit0000000000000000001',
  advance: 'advance00000000000000001',
  unknown: 'unknown00000000000000001'
}

const users = [
  { id: ids.superAdmin, username: SUPER_ADMIN_USERNAME, fullName: 'Super Admin', role: 'ADMIN', isActive: true },
  { id: ids.admin, username: 'admin', fullName: 'Admin', role: 'ADMIN', isActive: true },
  { id: ids.teller, username: 'teller1', fullName: 'Juan Dela Cruz', role: 'TELLER', isActive: true }
]

const collectors = [{ id: ids.collector, name: 'Collector A' }]

const seedLedger = () => [
  {
    id: ids.advance,
    tellerId: ids.teller,
    type: 'CASH_ADVANCE',
    amount: '1000.00',
    code: 'ADVAAAAA',
    betId: null,
    collectorId: ids.collector,
    adjustedByUserId: null,
    notes: null,
    createdAt: new Date('2026-10-15T01:00:00Z')
  },
  {
    id: ids.remit,
    tellerId: ids.teller,
    type: 'REMIT',
    amount: '-400.00',
    code: 'REMBBBBB',
    betId: null,
    collectorId: ids.collector,
    adjustedByUserId: null,
    notes: null,
    createdAt: new Date('2026-10-15T02:00:00Z')
  }
]

describe('DELETE /cash/remits/:id', () => {
  let app
  let prisma
  let frames
  const tokens = {}

  before(async () => {
    process.env.JWT_SECRET ??= 'test-secret'
    app = Fastify({ logger: false })
    app.addSchema(errorResponseSchema)
    await app.register(errorHandlerPlugin)
    app.decorate('prisma', null)
    app.decorate('broadcast', (frame) => frames.push(frame))
    await app.register(authPlugin)
    await app.register(cashRoutes, { prefix: '/cash' })
    await app.ready()

    tokens.superAdmin = app.jwt.sign({ sub: ids.superAdmin })
    tokens.admin = app.jwt.sign({ sub: ids.admin })
    tokens.teller = app.jwt.sign({ sub: ids.teller })
  })

  after(async () => {
    await app.close()
  })

  beforeEach(() => {
    prisma = createFakePrisma({ users, ledger: seedLedger(), collectors })
    app.prisma = prisma
    frames = []
  })

  const del = (id, token) =>
    app.inject({
      method: 'DELETE',
      url: `/cash/remits/${id}`,
      headers: { authorization: `Bearer ${token}` }
    })

  const balanceOf = (tellerId) =>
    prisma.ledgerRows
      .filter((r) => r.tellerId === tellerId)
      .reduce((acc, r) => acc + Number(r.amount), 0)
      .toFixed(2)

  it('deletes the remit, writes an offsetting adjustment, keeps balance unchanged', async () => {
    const before = balanceOf(ids.teller)
    assert.equal(before, '600.00')

    const res = await del(ids.remit, tokens.superAdmin)
    assert.equal(res.statusCode, 200)

    const { deleted } = res.json()
    assert.equal(deleted.id, ids.remit)
    assert.equal(deleted.type, 'REMIT')
    assert.equal(deleted.amount, '-400.00')
    assert.equal(deleted.code, 'REMBBBBB')
    assert.equal(deleted.collectorName, 'Collector A')

    assert.equal(prisma.ledgerRows.some((r) => r.id === ids.remit), false)

    const adjustments = prisma.ledgerRows.filter((r) => r.type === 'ADJUSTMENT')
    assert.equal(adjustments.length, 1)
    assert.equal(adjustments[0].tellerId, ids.teller)
    assert.equal(adjustments[0].amount, '-400.00')
    assert.equal(adjustments[0].adjustedByUserId, ids.superAdmin)
    assert.equal(adjustments[0].notes, 'Remit REMBBBBB deleted by super_admin')

    assert.equal(balanceOf(ids.teller), before)

    assert.equal(frames.length, 1)
    assert.equal(frames[0].type, 'TELLER_BALANCE_UPDATED')
    assert.equal(frames[0].data.tellerId, ids.teller)
    assert.equal(frames[0].data.balance, '600.00')

    const list = await app.inject({
      method: 'GET',
      url: '/cash/ledger?type=REMIT',
      headers: { authorization: `Bearer ${tokens.superAdmin}` }
    })
    assert.equal(list.statusCode, 200)
    assert.equal(list.json().entries.some((e) => e.id === ids.remit), false)
  })

  it('returns 404 for an unknown id', async () => {
    const res = await del(ids.unknown, tokens.superAdmin)
    assert.equal(res.statusCode, 404)
    assert.equal(prisma.ledgerRows.length, 2)
    assert.equal(frames.length, 0)
  })

  it('rejects a non-REMIT ledger row with 400 and leaves it in place', async () => {
    const res = await del(ids.advance, tokens.superAdmin)
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().error.details.ledgerType, 'CASH_ADVANCE')
    assert.equal(prisma.ledgerRows.some((r) => r.id === ids.advance), true)
    assert.equal(prisma.ledgerRows.some((r) => r.type === 'ADJUSTMENT'), false)
    assert.equal(frames.length, 0)
  })

  it('returns 403 for a regular ADMIN', async () => {
    const res = await del(ids.remit, tokens.admin)
    assert.equal(res.statusCode, 403)
    assert.equal(prisma.ledgerRows.some((r) => r.id === ids.remit), true)
  })

  it('returns 403 for a TELLER', async () => {
    const res = await del(ids.remit, tokens.teller)
    assert.equal(res.statusCode, 403)
    assert.equal(prisma.ledgerRows.some((r) => r.id === ids.remit), true)
  })
})
