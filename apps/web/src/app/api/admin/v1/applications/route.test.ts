import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { applyResult: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/applications', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset(); mocks.audit.mockReset() })
  it('redacts raw application errors from the response', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([{ id: 1, userId: 'candidate', jobId: 'job', status: 'failed', mode: 'unattended', atsType: null, flowUsed: null, error: 'candidate entered personal answer', durationMs: 1, createdAt: new Date() }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/applications') as never)
    const body = await response.json()
    expect(JSON.stringify(body)).not.toContain('personal answer')
    expect(body.items[0].errorClass).toBe('unknown')
  })
})
