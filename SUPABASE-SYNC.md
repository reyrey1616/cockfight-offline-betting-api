# Supabase backup sync (single site)

Live betting always uses **local PostgreSQL** (`DATABASE_URL`). Supabase is an optional **cloud backup mirror** when internet is available.

## Architecture

```
[Kiosks] → [Local API] → [Local PostgreSQL]   ← always (offline OK)
                ↓ when online
           [Sync job]
                ↓
           [Supabase PostgreSQL]              ← backup / remote view
```

If internet is down: **ignore Supabase**, continue locally. Sync later when online.

## One-time Supabase setup

1. Create a Supabase project.
2. Copy the **direct** Postgres connection string (port `5432`, not pooler).
3. Apply the same schema to Supabase **once**:

```bash
cd cockfigh-offline-betting-api

# Temporarily point at Supabase, migrate, then switch back to local
export DATABASE_URL="postgresql://postgres.[ref]:[password]@db.[ref].supabase.co:5432/postgres"
npm run db:migrate

# Restore local DATABASE_URL in .env
```

If prod local DB already has data but Supabase is new, only the migrate step above is needed on Supabase.

If prod local DB was never migrated via Prisma, baseline first (see prior P3005 steps), then migrate Supabase.

## Configure the server `.env`

```env
DATABASE_URL="postgresql://...@localhost:5432/cockfight_betting"

SUPABASE_DATABASE_URL="postgresql://postgres.[ref]:[password]@db.[ref].supabase.co:5432/postgres"
SUPABASE_AUTO_SYNC_MINUTES=15
SUPABASE_SYNC_ENABLED=true
```

- `SUPABASE_AUTO_SYNC_MINUTES=0` — disable background sync (manual/CLI only)
- `SUPABASE_SYNC_ENABLED=false` — disable all sync

## Sync methods

### 1. Automatic (recommended on prod PC)

With `SUPABASE_AUTO_SYNC_MINUTES=15`, the API tries to sync every 15 minutes. Failures are logged only — betting is never blocked.

### 2. Manual CLI

```bash
npm run sync:supabase
npm run sync:supabase:status
npm run sync:supabase -- --dry-run
```

### 3. Admin API (when logged in as admin)

- `GET /session/sync-status`
- `POST /session/sync-supabase`

## What sync does

1. Checks Supabase is reachable (skips if offline)
2. Truncates **operational** tables on Supabase: `TellerLedger`, `Bet`, `Fight`
3. Upserts all tables from local in FK order:
   - `Setting`, `Collector`, `User`, `Fight`, `Bet`, `TellerLedger`, `SessionReset`
4. Writes result to `.supabase-sync-state.json`

This keeps Supabase aligned after **session reset** (local wipe → remote ops tables cleared too).

## Windows Task Scheduler (optional extra)

If you prefer OS-level scheduling instead of `SUPABASE_AUTO_SYNC_MINUTES`:

- Program: `npm`
- Arguments: `run sync:supabase`
- Start in: `C:\path\to\cockfigh-offline-betting-api`
- Trigger: every 15 minutes

## Security

- Never put `SUPABASE_DATABASE_URL` on kiosk machines — **server PC only**
- Use a strong Supabase DB password
- Restrict Supabase dashboard access to owners/admins
