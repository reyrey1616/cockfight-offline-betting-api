// Decorates the Fastify instance with a single shared PrismaClient.
// Use `request.server.prisma` (or `app.prisma` at composition time) anywhere
// you need DB access. Never `new PrismaClient()` per-request — it leaks
// connections and exhausts the pool.

import fp from 'fastify-plugin'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'

// Prisma 7 ships a client engine that requires a driver adapter (or
// Accelerate). We use the official pg adapter, fed the same DATABASE_URL
// our migrations already use. Connection pooling is handled by node-pg
// under the hood (default pool size = 10).

async function prismaPlugin(app) {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set; cannot initialise Prisma adapter')
  }

  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({
    adapter,
    log: app.log.level === 'debug'
      ? ['query', 'error', 'warn']
      : ['error', 'warn']
  })

  await prisma.$connect()
  app.log.info('Prisma connected to PostgreSQL')

  app.decorate('prisma', prisma)

  app.addHook('onClose', async (instance) => {
    await instance.prisma.$disconnect()
    instance.log.info('Prisma disconnected')
  })
}

// fastify-plugin lets the decoration escape the encapsulation context, so
// `app.prisma` is available at the top-level scope for routes registered
// later.
export default fp(prismaPlugin, { name: 'prisma' })
