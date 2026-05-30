import { RequestTimeoutError } from './errors.js'

/** Map Prisma interactive-transaction timeout (P2028) to HTTP 408. */
export function rethrowPrismaTransactionError(err) {
  if (err?.code === 'P2028') {
    throw new RequestTimeoutError('System busy, please retry')
  }
  throw err
}
