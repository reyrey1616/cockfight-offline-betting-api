import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildUpsertQuery,
  resolveSyncConfig,
  SYNC_TABLES
} from './supabase-sync.js'

describe('resolveSyncConfig', () => {
  it('requires SUPABASE_DATABASE_URL to be configured', () => {
    const config = resolveSyncConfig({
      DATABASE_URL: 'postgresql://local/db',
      SUPABASE_SYNC_ENABLED: undefined,
      SUPABASE_DATABASE_URL: undefined,
      SUPABASE_AUTO_SYNC_MINUTES: undefined
    })
    assert.equal(config.enabled, false)
    assert.equal(config.supabaseDatabaseUrl, null)
  })

  it('enables sync when Supabase URL is present', () => {
    const config = resolveSyncConfig({
      DATABASE_URL: 'postgresql://local/db',
      SUPABASE_DATABASE_URL: 'postgresql://supabase/db',
      SUPABASE_AUTO_SYNC_MINUTES: '15'
    })
    assert.equal(config.enabled, true)
    assert.equal(config.autoSyncMinutes, 15)
  })
})

describe('buildUpsertQuery', () => {
  it('builds ON CONFLICT upsert for Setting', () => {
    const setting = SYNC_TABLES.find((t) => t.name === 'Setting')
    assert.ok(setting)
    const q = buildUpsertQuery(setting.name, setting.columns)
    assert.match(q.text, /INSERT INTO "Setting"/)
    assert.match(q.text, /ON CONFLICT \("id"\) DO UPDATE SET/)
    assert.match(q.text, /"commissionRate" = EXCLUDED\."commissionRate"/)
  })
})
