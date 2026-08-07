import { AdminMfaLevel, AdminMembershipStatus, PrismaClient } from '@prisma/client'
import { SYSTEM_ROLES } from '../src/lib/admin/permissions'

const db = new PrismaClient()

async function main() {
  const email = process.env.INITIAL_SUPER_ADMIN_EMAIL?.trim().toLowerCase()
  if (!email) throw new Error('INITIAL_SUPER_ADMIN_EMAIL is required')

  const existingSuperAdmins = await db.adminMembership.count({ where: { status: AdminMembershipStatus.active, role: { key: 'super_admin' } } })
  if (process.env.NODE_ENV === 'production' && existingSuperAdmins > 0) {
    throw new Error('Refusing to modify production roles after a super admin exists')
  }

  const user = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) throw new Error('The initial super-admin user must already exist')

  for (const role of SYSTEM_ROLES) {
    await db.adminRole.upsert({
      where: { key: role.key },
      update: { name: role.name, permissions: [...role.permissions] },
      create: { key: role.key, name: role.name, permissions: [...role.permissions] },
    })
  }
  const superAdmin = await db.adminRole.findUniqueOrThrow({ where: { key: 'super_admin' }, select: { id: true } })
  await db.adminMembership.upsert({
    where: { userId: user.id },
    update: { roleId: superAdmin.id, status: AdminMembershipStatus.active, mfaLevel: AdminMfaLevel.webauthn, revokedAt: null },
    create: { userId: user.id, roleId: superAdmin.id, status: AdminMembershipStatus.active, mfaLevel: AdminMfaLevel.webauthn },
  })
  console.log(`Seeded ${SYSTEM_ROLES.length} roles and assigned super_admin to ${email}`)
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 }).finally(() => db.$disconnect())
