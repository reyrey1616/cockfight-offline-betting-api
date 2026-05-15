// Public-facing bet ticket code generator.
//
// Format: {5 chars from reduced alphabet}{3 teller initials} = 8 chars total.
// e.g. "K8H3QJDR" — first 5 random, last 3 are the teller's initials so a
// customer at the redemption window has a small visual sanity check on
// who issued the ticket.
//
// All the alphabet / retry plumbing lives in `code-generator.js` so the
// rules are consistent across every printable code in the system (bets,
// collectors, advances, remits). This file is the bet-specific wrapper.

import { generateUniqueCode } from './code-generator.js'
import { InvariantError } from './errors.js'

/**
 * Generate a unique 8-char ticket code for a bet.
 *
 * @param {import('@prisma/client').PrismaClient | object} prismaOrTx
 *   Prisma client or a transaction client. Both expose `.bet.findUnique`.
 * @param {string} initials  Exactly 3 chars (already validated by the
 *                           username schema upstream).
 * @returns {Promise<string>} An unused ticket code, e.g. "K8H3Q" + "JDR".
 */
export async function generateTicketCode(prismaOrTx, initials) {
  if (!initials || initials.length !== 3) {
    throw new InvariantError('Teller initials must be exactly 3 chars')
  }

  return generateUniqueCode({
    suffix: initials.toUpperCase(),
    label: 'ticket code',
    isUsed: async (code) => {
      const row = await prismaOrTx.bet.findUnique({
        where: { code },
        select: { id: true }
      })
      return row !== null
    }
  })
}
