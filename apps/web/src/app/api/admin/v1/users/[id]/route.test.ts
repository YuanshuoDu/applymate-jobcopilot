import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), count: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique }, applyResult: { count: mocks.count, findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/users/:id', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })
  it('returns safe user metadata and application metadata only', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'support', requestId: 'req-1' })
    mocks.findUnique.mockResolvedValue({ id: 'candidate-1', name: 'Candidate', email: 'candidate@example.com', plan: 'pro', location: 'Dublin', createdAt: new Date(), _count: { jobs: 2, resumes: 1, notifications: 1 }, gmailSyncState: null })
    mocks.count.mockResolvedValue(1)
    mocks.findMany.mockResolvedValue([{ id: 1, status: 'submitted', mode: 'unattended', atsType: 'lever', flowUsed: 'programmatic', durationMs: 1000, createdAt: new Date() }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/users/candidate-1') as never, { params: Promise.resolve({ id: 'candidate-1' }) })
    const body = await response.json()
    expect(body.user).toEqual(expect.objectContaining({ email: 'ca***@example.com', location: 'D***' }))
    expect(JSON.stringify(body)).not.toContain('password')
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ select: expect.not.objectContaining({ error: true, job: true }) }))
  })
})
