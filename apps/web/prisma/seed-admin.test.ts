import { describe, expect, it, vi } from 'vitest'
import { seedAdminRoles } from './seed-admin'

function fakeDatabase(overrides: Record<string, unknown> = {}) {
  return {
    adminRole: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    adminMembership: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      ...overrides,
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'admin_1' }),
    },
  }
}

describe('seedAdminRoles', () => {
  it('requires an initial email outside development', async () => {
    await expect(seedAdminRoles(fakeDatabase(), { environment: 'production' })).rejects.toThrow('INITIAL_SUPER_ADMIN_EMAIL is required')
  })

  it('refuses to create a second production super admin', async () => {
    const database = fakeDatabase({ findFirst: vi.fn().mockResolvedValue({ id: 'existing_membership' }) })
    await expect(seedAdminRoles(database, { environment: 'production', initialEmail: 'new@example.com' }))
      .rejects.toThrow('A production super admin already exists')
  })

  it('is idempotent for the configured initial member', async () => {
    const database = fakeDatabase({ findUnique: vi.fn().mockResolvedValue({ id: 'existing_membership' }) })
    await expect(seedAdminRoles(database, { environment: 'development', initialEmail: 'Admin@Example.com' }))
      .resolves.toMatchObject({ memberCreated: false })
    expect(database.adminMembership.create).not.toHaveBeenCalled()
  })

  it('creates the configured initial member with the super admin role', async () => {
    const database = fakeDatabase()
    await expect(seedAdminRoles(database, { environment: 'development', initialEmail: 'Admin@Example.com' }))
      .resolves.toMatchObject({ memberCreated: true })
    expect(database.user.findUnique).toHaveBeenCalledWith({ where: { email: 'admin@example.com' }, select: { id: true } })
    expect(database.adminMembership.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'admin_1' }),
    }))
  })
})
