import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), groupBy: vi.fn(), queryRaw: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { applicationTask: { findMany: mocks.findMany, groupBy: mocks.groupBy }, $queryRaw: mocks.queryRaw } }))

describe('GET /api/admin/v1/applications', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset(); mocks.groupBy.mockReset(); mocks.queryRaw.mockReset(); mocks.audit.mockReset() })

  it('lists task-only applications and redacts raw task/result errors', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([{ id: 'task-1', userId: 'candidate', jobId: 'job', status: 'failed', checkpoint: 'form', error: 'candidate entered personal answer', startedAt: null, completedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), job: { company: 'Acme', role: 'Engineer', source: 'agent', applyResults: [{ id: 1, userId: 'candidate', jobId: 'job', status: 'failed', mode: 'unattended', atsType: null, flowUsed: null, error: 'private worker response', durationMs: 1, createdAt: new Date() }] } }])
    mocks.groupBy.mockResolvedValue([{ status: 'failed', _count: { _all: 1 } }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/applications') as never)
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.items[0]).toMatchObject({ id: 'task-1', status: 'failed', resultStatus: 'failed', company: 'Acme' })
    expect(body.summary).toMatchObject({ total: 1, failed: 1 })
    expect(JSON.stringify(body)).not.toContain('personal answer')
    expect(JSON.stringify(body)).not.toContain('private worker response')
  })

  it('passes lifecycle filters to the task query and keeps task IDs as cursors', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([])
    mocks.groupBy.mockResolvedValue([])
    const { GET } = await import('./route')
    await GET(new Request('http://localhost/api/admin/v1/applications?status=waiting_for_user&cursor=task-previous') as never)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ status: 'waiting_for_user' }), cursor: { id: 'task-previous' } }))
  })

  it('filters outcome and mode against the latest worker result', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' })
    mocks.queryRaw.mockResolvedValue([{ id: 'task-latest' }])
    mocks.findMany.mockResolvedValue([])
    mocks.groupBy.mockResolvedValue([])
    const { GET } = await import('./route')
    await GET(new Request('http://localhost/api/admin/v1/applications?outcome=submitted&mode=unattended') as never)
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1)
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['task-latest'] } }) }))
  })
})
