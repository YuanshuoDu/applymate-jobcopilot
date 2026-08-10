import { PrismaClient } from '@prisma/client'
import { ROLE_SEEDS } from '../src/lib/admin/permissions'

interface SeedOptions {
  environment: string
  initialEmail?: string
}

interface SeedDatabase {
  adminRole: {
    upsert(args: {
      where: { key: string }
      create: { key: string; name: string; description: string; system: boolean; permissions: string[] }
      update: Record<string, never>
    }): Promise<{ id: string; key?: string }>
  }
  adminMembership: {
    findUnique(args: { where: { userId: string }; select: { id: true } }): Promise<{ id: string } | null>
    findFirst(args: { where: { status: 'active'; role: { key: 'super_admin' } }; select: { id: true } }): Promise<{ id: string } | null>
    create(args: { data: { userId: string; roleId: string; grantedById: string } }): Promise<unknown>
  }
  user: {
    findUnique(args: { where: { email: string }; select: { id: true } }): Promise<{ id: string } | null>
  }
}

export async function seedAdminRoles(database: SeedDatabase, options: SeedOptions): Promise<{
  roleCount: number
  memberCreated: boolean
}> {
  const email = options.initialEmail?.trim().toLowerCase()
  if (options.environment !== 'development' && !email) {
    throw new Error('INITIAL_SUPER_ADMIN_EMAIL is required')
  }

  const roleEntries = Object.entries(ROLE_SEEDS)
  const roles = await Promise.all(roleEntries.map(async ([key, role]) => ({
    key,
    role: await database.adminRole.upsert({
      where: { key },
      create: {
        key,
        name: role.name,
        description: role.description,
        system: role.system,
        permissions: [...role.permissions],
      },
      update: {},
    }),
  })))

  if (!email) return { roleCount: roles.length, memberCreated: false }

  const user = await database.user.findUnique({ where: { email }, select: { id: true } })
  if (!user) throw new Error('Configured initial super admin user does not exist')

  const existingMembership = await database.adminMembership.findUnique({
    where: { userId: user.id },
    select: { id: true },
  })
  if (existingMembership) return { roleCount: roles.length, memberCreated: false }

  if (options.environment === 'production') {
    const existingSuperAdmin = await database.adminMembership.findFirst({
      where: { status: 'active', role: { key: 'super_admin' } },
      select: { id: true },
    })
    if (existingSuperAdmin) throw new Error('A production super admin already exists')
  }

  const superAdmin = roles.find(entry => entry.key === 'super_admin')
  if (!superAdmin) throw new Error('Super admin role seed is missing')
  await database.adminMembership.create({
    data: { userId: user.id, roleId: superAdmin.role.id, grantedById: user.id },
  })
  return { roleCount: roles.length, memberCreated: true }
}

async function main() {
  const database = new PrismaClient()
  try {
    const result = await seedAdminRoles(database, {
      environment: process.env.NODE_ENV ?? 'development',
      initialEmail: process.env.INITIAL_SUPER_ADMIN_EMAIL,
    })
    console.log(`Seeded ${result.roleCount} admin roles; initial member created: ${result.memberCreated}`)
  } finally {
    await database.$disconnect()
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
