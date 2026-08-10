import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), run: vi.fn(), validate: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.run }))
vi.mock('@/lib/db', () => ({ db: { atsEmployer: { create: vi.fn() } } }))

describe('POST /api/admin/v1/ats/registry', () => {
  beforeEach(() => { mocks.requireAdmin.mockReset(); mocks.run.mockReset(); mocks.validate.mockReset(); mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'req-1' }); mocks.validate.mockReturnValue(null); mocks.run.mockResolvedValue({ duplicate: false, value: { id: 1, atsType: 'lever', slug: 'newco', name: 'NewCo' } }) })

  it('validates and creates an employer registry entry', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/registry', { method: 'POST', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'ats-1', 'Content-Type': 'application/json' }, body: JSON.stringify({ atsType: 'lever', slug: 'newco', name: 'NewCo', reason: 'Add a verified European employer ATS registry entry' }) }) as never)
    expect(response.status).toBe(201)
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'ats.registry_entry_created', targetId: 'lever:newco' }))
  })
})
