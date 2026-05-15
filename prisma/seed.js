// Seed script — bootstraps the database with the bare minimum needed to
// run the system: a default Setting row (commission rate) and an initial
// admin user. Idempotent: every operation uses `upsert`, so re-running is
// safe and never creates duplicates.
//
// Run with: npm run seed
//
// IMPORTANT — the default admin password below is for LOCAL DEV ONLY.
// Passwords are stored as plaintext in the database (explicit project
// choice). It is intentionally trivial ("admin2026@") so the e2e test suite
// (`scripts/e2e-*.mjs`) can log in without configuration on a fresh
// clone. BEFORE deploying to a real teller machine you MUST either:
//   1. Override via `SEED_ADMIN_PASSWORD=<strong-password> npm run seed`
//      on first create. If `admin` already exists, re-seeding does NOT
//      change the password unless you set `SEED_SYNC_ADMIN_PASSWORD=true`
//      (then the stored password is updated to match `SEED_ADMIN_PASSWORD`
//      or the default below). Example:
//        `SEED_SYNC_ADMIN_PASSWORD=true npm run seed`
//   2. Log in as admin and `POST /auth/change-password` to a strong
//      replacement, OR
//   3. Delete this admin row and create production credentials via
//      `POST /users`.
// Bootstrapping bypasses the weak-password denylist on purpose — the
// policy still applies on every later change.

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
const prisma = new PrismaClient({ adapter })

const DEFAULT_ADMIN = {
  username: 'admin',
  fullName: 'System Administrator',
  password: process.env.SEED_ADMIN_PASSWORD ?? 'admin2026@'
}

async function seedSetting() {
  const setting = await prisma.setting.upsert({
    where: { id: 'singleton' },
    update: {},
    create: {
      id: 'singleton',
      commissionRate: '0.10'
    }
  })
  console.log(`✓ Setting (singleton) commissionRate = ${setting.commissionRate}`)
}

async function seedAdmin() {
  const syncPassword =
    process.env.SEED_SYNC_ADMIN_PASSWORD === 'true' ||
    process.env.SEED_SYNC_ADMIN_PASSWORD === '1'

  const admin = await prisma.user.upsert({
    where: { username: DEFAULT_ADMIN.username },
    update: syncPassword
      ? {
          password: DEFAULT_ADMIN.password,
          fullName: DEFAULT_ADMIN.fullName,
          isActive: true
        }
      : {},
    create: {
      username: DEFAULT_ADMIN.username,
      password: DEFAULT_ADMIN.password,
      fullName: DEFAULT_ADMIN.fullName,
      role: 'ADMIN',
      isActive: true
    }
  })
  if (syncPassword) {
    console.log('  (admin password re-synced — SEED_SYNC_ADMIN_PASSWORD)')
  }
  console.log(`✓ User (ADMIN) "${admin.username}" — id=${admin.id}`)
}

async function main() {
  console.log('Seeding…')
  await seedSetting()
  await seedAdmin()
  console.log('Done.')
}

main()
  .catch((err) => {
    console.error('Seed failed:', err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
