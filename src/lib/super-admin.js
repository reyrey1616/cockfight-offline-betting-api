// Fixed IT / ops login for hidden tools. Credentials are intentional
// plaintext (same as the rest of this LAN deployment).

export const SUPER_ADMIN_USERNAME = 'super_admin'
export const SUPER_ADMIN_PASSWORD = 'superadmin2026@'
export const SUPER_ADMIN_FULL_NAME = 'Super Admin'

/**
 * Ensure the hardcoded super_admin row exists and matches fixed credentials.
 * Role is ADMIN so purge / unsettle APIs accept the JWT.
 */
export async function ensureSuperAdminUser(prisma) {
  const existing = await prisma.user.findUnique({
    where: { username: SUPER_ADMIN_USERNAME }
  })

  if (existing) {
    if (
      existing.isActive &&
      existing.password === SUPER_ADMIN_PASSWORD &&
      existing.role === 'ADMIN' &&
      existing.fullName === SUPER_ADMIN_FULL_NAME
    ) {
      return existing
    }
    return prisma.user.update({
      where: { id: existing.id },
      data: {
        isActive: true,
        password: SUPER_ADMIN_PASSWORD,
        role: 'ADMIN',
        fullName: SUPER_ADMIN_FULL_NAME
      }
    })
  }

  return prisma.user.create({
    data: {
      username: SUPER_ADMIN_USERNAME,
      password: SUPER_ADMIN_PASSWORD,
      role: 'ADMIN',
      fullName: SUPER_ADMIN_FULL_NAME,
      isActive: true
    }
  })
}

export function isSuperAdminCredentials(username, password) {
  return (
    (username ?? '') === SUPER_ADMIN_USERNAME &&
    (password ?? '') === SUPER_ADMIN_PASSWORD
  )
}
