import {
  ConflictError,
  ForbiddenError,
  NotFoundError
} from '../../lib/errors.js'
import { assertPasswordPolicy } from '../../lib/password-policy.js'

export async function createUser(prisma, { username, password, fullName, role }) {
  assertPasswordPolicy(password)

  return prisma.user.create({
    data: {
      username,
      password,
      fullName,
      role,
      isActive: true
    }
  })
}

export async function listUsers(prisma, { role, isActive } = {}) {
  return prisma.user.findMany({
    where: {
      ...(role !== undefined ? { role } : {}),
      ...(isActive !== undefined ? { isActive } : {})
    },
    orderBy: [{ role: 'asc' }, { username: 'asc' }]
  })
}

export async function getUser(prisma, id) {
  const user = await prisma.user.findUnique({ where: { id } })
  if (!user) throw new NotFoundError('User not found')
  return user
}

export async function updateUser(prisma, id, { fullName, isActive }, actorUserId) {
  await getUser(prisma, id)

  if (isActive === false && id === actorUserId) {
    throw new ForbiddenError('You cannot deactivate your own account')
  }

  return prisma.user.update({
    where: { id },
    data: {
      ...(fullName !== undefined ? { fullName } : {}),
      ...(isActive !== undefined ? { isActive } : {})
    }
  })
}

export async function resetPassword(prisma, id, newPassword) {
  await getUser(prisma, id)
  assertPasswordPolicy(newPassword)
  return prisma.user.update({ where: { id }, data: { password: newPassword } })
}

export { ConflictError }
