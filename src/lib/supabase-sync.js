// Local PostgreSQL → Supabase mirror sync (single-site, offline-first).
//
// Live operations always use DATABASE_URL (local). When internet is available,
// push a snapshot to SUPABASE_DATABASE_URL for backup / remote reporting.
//
// Strategy:
//   1. TRUNCATE operational tables on Supabase (Fight, Bet, TellerLedger)
//   2. Upsert all tables from local in FK order
//
// This keeps Supabase aligned after session resets (local wipe → empty remote ops).

import fs from 'fs/promises'
import path from 'path'
import pg from 'pg'

const DEFAULT_STATE_FILE = '.supabase-sync-state.json'
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

/** @type {{ name: string, columns: string[], primaryKey?: string }[]} */
export const SYNC_TABLES = [
  {
    name: 'Setting',
    columns: ['id', 'commissionRate', 'updatedAt']
  },
  {
    name: 'Collector',
    columns: ['id', 'code', 'name', 'isActive', 'createdAt', 'updatedAt']
  },
  {
    name: 'User',
    columns: [
      'id',
      'username',
      'password',
      'fullName',
      'role',
      'isActive',
      'createdAt',
      'updatedAt'
    ]
  },
  {
    name: 'Fight',
    columns: [
      'id',
      'fightNumber',
      'status',
      'commissionRate',
      'meronPool',
      'walaPool',
      'meronAcceptingBets',
      'meronHeldAt',
      'meronHeldByUserId',
      'walaAcceptingBets',
      'walaHeldAt',
      'walaHeldByUserId',
      'outcome',
      'payoutRatioMeron',
      'payoutRatioWala',
      'openedAt',
      'closedAt',
      'settledAt',
      'cancelledAt',
      'previousOutcome',
      'previousPayoutRatioMeron',
      'previousPayoutRatioWala',
      'correctedAt',
      'correctedByUserId',
      'correctionReason',
      'createdAt',
      'updatedAt'
    ]
  },
  {
    name: 'Bet',
    columns: [
      'id',
      'code',
      'clientRequestId',
      'fightId',
      'tellerId',
      'tellerNameSnapshot',
      'tellerInitialsSnapshot',
      'amount',
      'side',
      'status',
      'payoutAmount',
      'paidAt',
      'paidByUserId',
      'voidedAt',
      'voidedByUserId',
      'voidReason',
      'previousStatus',
      'previousPayoutAmount',
      'correctedAt',
      'createdAt',
      'updatedAt'
    ]
  },
  {
    name: 'TellerLedger',
    columns: [
      'id',
      'tellerId',
      'type',
      'amount',
      'code',
      'betId',
      'collectorId',
      'adjustedByUserId',
      'notes',
      'createdAt'
    ]
  },
  {
    name: 'SessionReset',
    columns: [
      'id',
      'performedAt',
      'performedByUserId',
      'fightCount',
      'betCount',
      'ledgerCount',
      'collectorCashCount',
      'notes',
      'forced'
    ]
  }
]

export function resolveSyncConfig(env = process.env) {
  const localDatabaseUrl = env.DATABASE_URL ?? null
  const supabaseDatabaseUrl = env.SUPABASE_DATABASE_URL ?? null
  const autoSyncMinutes = Number(env.SUPABASE_AUTO_SYNC_MINUTES ?? 0)
  const enabled =
    env.SUPABASE_SYNC_ENABLED !== 'false' && Boolean(supabaseDatabaseUrl)

  return {
    localDatabaseUrl,
    supabaseDatabaseUrl,
    enabled,
    autoSyncMinutes: Number.isFinite(autoSyncMinutes) && autoSyncMinutes > 0
      ? autoSyncMinutes
      : 0
  }
}

export function defaultStateFilePath(cwd = process.cwd()) {
  return path.join(cwd, DEFAULT_STATE_FILE)
}

export function buildUpsertQuery(tableName, columns, primaryKey = 'id') {
  const quotedCols = columns.map((c) => `"${c}"`)
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
  const updates = columns
    .filter((c) => c !== primaryKey)
    .map((c) => `"${c}" = EXCLUDED."${c}"`)
    .join(', ')

  return {
    text:
      `INSERT INTO "${tableName}" (${quotedCols.join(', ')}) ` +
      `VALUES (${placeholders}) ` +
      `ON CONFLICT ("${primaryKey}") DO UPDATE SET ${updates}`
  }
}

export function inferPgSsl(connectionString) {
  if (!connectionString) return undefined
  if (connectionString.includes('supabase.co')) {
    return { rejectUnauthorized: false }
  }
  return undefined
}

function serializeValue(value) {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value
  if (typeof value === 'object' && typeof value.toString === 'function') {
    return value.toString()
  }
  return value
}

export async function readSyncState(stateFilePath) {
  try {
    const raw = await fs.readFile(stateFilePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function writeSyncState(stateFilePath, payload) {
  await fs.writeFile(stateFilePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export async function checkDatabaseReachable(connectionString, timeoutMs = 5000) {
  if (!connectionString) return false

  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: timeoutMs,
    ssl: inferPgSsl(connectionString)
  })

  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

async function assertRemoteSchema(remoteClient) {
  const { rows } = await remoteClient.query(`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'Setting'
    ) AS ok
  `)
  if (!rows[0]?.ok) {
    throw new Error(
      'Supabase database is missing schema. Run migrations against SUPABASE_DATABASE_URL first ' +
      '(set DATABASE_URL to Supabase temporarily, then npm run db:migrate).'
    )
  }
}

async function syncTable(localClient, remoteClient, tableDef) {
  const { name, columns, primaryKey = 'id' } = tableDef
  const quotedCols = columns.map((c) => `"${c}"`).join(', ')
  const { rows } = await localClient.query(
    `SELECT ${quotedCols} FROM "${name}" ORDER BY "${primaryKey}"`
  )
  const upsert = buildUpsertQuery(name, columns, primaryKey)

  for (const row of rows) {
    const values = columns.map((c) => serializeValue(row[c]))
    await remoteClient.query(upsert.text, values)
  }

  return rows.length
}

/**
 * Mirror local Postgres into Supabase.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stateFilePath?: string,
 *   timeoutMs?: number,
 *   dryRun?: boolean
 * }} [options]
 */
export async function syncLocalToSupabase(options = {}) {
  const env = options.env ?? process.env
  const config = resolveSyncConfig(env)

  if (!config.localDatabaseUrl) {
    throw new Error('DATABASE_URL is not set')
  }
  if (!config.supabaseDatabaseUrl) {
    throw new Error('SUPABASE_DATABASE_URL is not set')
  }

  const reachable = await checkDatabaseReachable(
    config.supabaseDatabaseUrl,
    options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  )
  if (!reachable) {
    throw new Error('Supabase is unreachable — sync skipped (local operations continue normally)')
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      message: 'Supabase reachable; sync would run'
    }
  }

  const localClient = new pg.Client({ connectionString: config.localDatabaseUrl })
  const remoteClient = new pg.Client({
    connectionString: config.supabaseDatabaseUrl,
    connectionTimeoutMillis: options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    ssl: inferPgSsl(config.supabaseDatabaseUrl)
  })

  const startedAt = new Date().toISOString()
  /** @type {Record<string, number>} */
  const counts = {}

  try {
    await localClient.connect()
    await remoteClient.connect()
    await assertRemoteSchema(remoteClient)

    await remoteClient.query('BEGIN')
    await remoteClient.query(
      'TRUNCATE TABLE "TellerLedger", "Bet", "Fight" RESTART IDENTITY'
    )

    for (const table of SYNC_TABLES) {
      counts[table.name] = await syncTable(localClient, remoteClient, table)
    }

    await remoteClient.query('COMMIT')

    const result = {
      ok: true,
      syncedAt: startedAt,
      finishedAt: new Date().toISOString(),
      counts,
      message: 'Local database synced to Supabase'
    }

    const stateFilePath = options.stateFilePath ?? defaultStateFilePath()
    await writeSyncState(stateFilePath, result)
    return result
  } catch (err) {
    await remoteClient.query('ROLLBACK').catch(() => {})

    const failure = {
      ok: false,
      attemptedAt: startedAt,
      finishedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err)
    }

    const stateFilePath = options.stateFilePath ?? defaultStateFilePath()
    await writeSyncState(stateFilePath, failure).catch(() => {})
    throw err
  } finally {
    await localClient.end().catch(() => {})
    await remoteClient.end().catch(() => {})
  }
}

export async function getSupabaseSyncStatus(options = {}) {
  const config = resolveSyncConfig(options.env ?? process.env)
  const stateFilePath = options.stateFilePath ?? defaultStateFilePath()
  const state = await readSyncState(stateFilePath)

  let supabaseReachable = null
  if (config.supabaseDatabaseUrl) {
    supabaseReachable = await checkDatabaseReachable(config.supabaseDatabaseUrl)
  }

  return {
    configured: Boolean(config.supabaseDatabaseUrl),
    enabled: config.enabled,
    autoSyncMinutes: config.autoSyncMinutes,
    supabaseReachable,
    lastSync: state
  }
}
