import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  audit: vi.fn(),
  idempotency: vi.fn(),
  mutation: vi.fn(),
  csrf: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/db', () => ({ db: { adminRole: { findMany: mocks.findMany, create: mocks.create } } }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))

function request(body: unknown) {
  return new Request('http://localhost/api/admin/v1/access/roles', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', 'Idempotency-Key': 'role-create-1' },
    body: JSON.stringify(body),
  })
}

describe('access roles API', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'security_admin', permissions: ['admin_roles.manage'] })
    mocks.csrf.mockReturnValue({ ok: true })
    mocks.mutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown>; audit: unknown }) => {
      const value = await input.mutate({ adminRole: { create: mocks.create } })
      mocks.audit(input.audit)
      return { duplicate: false, value }
    })
    mocks.create.mockResolvedValue({ id: 'role_1', key: 'custom_ops', name: 'Custom Ops', permissions: ['users.read'], system: false, version: 1 })
  })

  it('creates a custom role with a reason and audited response', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ key: 'custom_ops', name: 'Custom Ops', permissions: ['users.read'], reason: 'Operational access needed' }) as never)

    expect(response.status).toBe(201)
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ key: 'custom_ops', permissions: ['users.read'], system: false }) }))
    expect(mocks.audit).toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
