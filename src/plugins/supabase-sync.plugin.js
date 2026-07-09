// Optional background sync: when SUPABASE_AUTO_SYNC_MINUTES is set, try to
// mirror local Postgres to Supabase on an interval. Failures are logged only —
// local operations are never blocked.

import fp from 'fastify-plugin'

import { resolveSyncConfig, syncLocalToSupabase } from '../lib/supabase-sync.js'

async function supabaseSyncPlugin(app) {
  const config = resolveSyncConfig()
  if (!config.enabled || config.autoSyncMinutes <= 0) {
    app.log.info('Supabase auto-sync disabled')
    return
  }

  const intervalMs = config.autoSyncMinutes * 60_000
  let running = false

  async function runSync(reason) {
    if (running) return
    running = true
    try {
      const result = await syncLocalToSupabase()
      app.log.info(
        { reason, counts: result.counts, syncedAt: result.syncedAt },
        'Supabase auto-sync completed'
      )
    } catch (err) {
      app.log.warn(
        { reason, err: err instanceof Error ? err.message : String(err) },
        'Supabase auto-sync skipped'
      )
    } finally {
      running = false
    }
  }

  const timer = setInterval(() => {
    void runSync('interval')
  }, intervalMs)
  timer.unref()

  // First attempt shortly after startup (internet may have just returned).
  setTimeout(() => {
    void runSync('startup')
  }, 15_000).unref()

  app.log.info(
    { everyMinutes: config.autoSyncMinutes },
    'Supabase auto-sync enabled'
  )

  app.addHook('onClose', async () => {
    clearInterval(timer)
  })
}

export default fp(supabaseSyncPlugin, { name: 'supabase-sync' })
