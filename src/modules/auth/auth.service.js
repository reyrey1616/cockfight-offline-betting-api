import { BadRequestError, UnauthorizedError } from '../../lib/errors.js'
import { assertPasswordPolicy } from '../../lib/password-policy.js'

// Re-exported here so existing imports from `auth.service` keep working.
// The canonical implementation lives in `lib/user-mapper.js` and is shared
// with the users module.
export { publicUser } from '../../lib/user-mapper.js'

// Verify credentials and return the User record on success.
// IMPORTANT: do NOT distinguish "user not found" from "wrong password" in
// the error message — that lets attackers enumerate valid usernames.
export async function verifyCredentials(prisma, { username, password }) {
  const user = await prisma.user.findUnique({ where: { username } })
  const submitted = password ?? ''
  const ok =
    user &&
    user.isActive &&
    submitted === user.password

  if (!ok) {
    throw new UnauthorizedError('Invalid username or password')
  }

  return user
}

/**
 * Self-service password change.
 *
 * Bearer-authenticated user changes their own password by submitting
 * their current password (proof they're at the keyboard, not just
 * holding a stale JWT) plus a new one. The admin-driven reset path
 * lives in `users.service.resetPassword` and intentionally skips the
 * current-password check (admins reset for users who FORGOT).
 */
export async function changePassword(prisma, userId, { currentPassword, newPassword }) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true, password: true }
  })

  const currentOk =
    user &&
    user.isActive &&
    (currentPassword ?? '') === user.password
  if (!currentOk) {
    throw new UnauthorizedError('Password verification failed')
  }

  assertPasswordPolicy(newPassword)

  if (newPassword === currentPassword) {
    throw new BadRequestError('New password must be different from current password')
  }

  return prisma.user.update({
    where: { id: user.id },
    data: { password: newPassword },
    select: { id: true, username: true }
  })
}

/**
 * Step-up password verification.
 *
 * Used by sensitive endpoints (e.g. `POST /session/reset`) that want
 * the *currently-bearer-authenticated* user to re-prove they're at the
 * keyboard, separate from holding a valid token.
 */
export async function verifyUserPassword(prisma, userId, plaintextPassword) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true, password: true }
  })
  const ok =
    user &&
    user.isActive &&
    (plaintextPassword ?? '') === user.password
  if (!ok) {
    throw new UnauthorizedError('Password verification failed')
  }
  return true
}
