// Shared user serializers. Use these whenever a user needs to leave the
// service layer toward the wire. Never return raw `User` records to
// clients — password, internal timestamps, and other DB-only fields
// must not be exposed.
//
// `initials` is NOT a stored column — it is derived here from the username
// so the wire response is consistent regardless of where the User object
// came from (Prisma, JWT payload, hand-built).
//
// Two views are intentional:
//
//  - publicUser  : minimal — for /auth/login and /auth/me. The caller is
//                  the user themselves; isActive is implicitly true (they
//                  just authenticated successfully).
//
//  - adminUser   : richer  — for /users admin endpoints. Includes
//                  isActive, createdAt, updatedAt, etc. for management UIs.

import { deriveInitials } from './initials.js'

export function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    initials: deriveInitials(user.username),
    role: user.role
  }
}

export function adminUser(user) {
  return {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    initials: deriveInitials(user.username),
    role: user.role,
    isActive: user.isActive,
    createdAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : user.createdAt,
    updatedAt: user.updatedAt instanceof Date ? user.updatedAt.toISOString() : user.updatedAt
  }
}
