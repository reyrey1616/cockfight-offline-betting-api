#!/usr/bin/env node
// Push local PostgreSQL snapshot to Supabase when internet is available.
//
// Usage:
//   npm run sync:supabase
//   npm run sync:supabase -- --dry-run
//   npm run sync:supabase -- --status

import dotenv from 'dotenv'

import {
  getSupabaseSyncStatus,
  syncLocalToSupabase
} from '../src/lib/supabase-sync.js'

dotenv.config()

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const statusOnly = args.has('--status')

async function main() {
  if (statusOnly) {
    const status = await getSupabaseSyncStatus()
    console.log(JSON.stringify(status, null, 2))
    process.exit(0)
  }

  if (!process.env.SUPABASE_DATABASE_URL) {
    console.error('SUPABASE_DATABASE_URL is not set in .env — sync skipped.')
    process.exit(1)
  }

  try {
    const result = await syncLocalToSupabase({ dryRun })
    console.log(JSON.stringify(result, null, 2))
    process.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }
}

main()
