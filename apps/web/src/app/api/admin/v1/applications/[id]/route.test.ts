import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), result: vi.fn(), task: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { applyResult: { findUnique: mocks.result }, applicationTask: { findUnique: mocks.task } } }))

describe('GET /api/admin/v1/applications/[id]', () => {
  beforeEach(() => { mocks.requireAdmin.mockReset(); mocks.result.mockReset(); mocks.task.mockReset(); mocks.audit.mockReset(); mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' }) })

  it('returns safe result and task events without job or document content', async () => {
    mocks.result.mockResolvedValue({ id: 12, userId: 'user-1', jobId: 'job-1', status: 'failed', mode: 'unattended', atsType: 'lever', flowUsed: 'lever', error: 'Timeout while filling', durationMs: 2000, createdAt: new Date('2026-08-09T00:00:00Z') })
    mocks.task.mockResolvedValue({ id: 'task-1', status: 'failed', checkpoint: 'form', error: 'Timeout', startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(), events: [{ id: 'event-1', type: 'failed', actor: 'worker', body: 'safe operational note', createdAt: new Date() }] })
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/applications/12') as never, { params: Promise.resolve({ id: '12' }) })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.application.errorClass).toBe('timeout')
    expect(payload.task.events[0].body).toBe('safe operational note')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'application.detail_viewed', tenantUserId: 'user-1' }))
  })
})
