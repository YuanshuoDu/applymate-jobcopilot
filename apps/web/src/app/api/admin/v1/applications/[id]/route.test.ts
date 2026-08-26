import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), task: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { applicationTask: { findUnique: mocks.task } } }))

describe('GET /api/admin/v1/applications/[id]', () => {
  beforeEach(() => { mocks.requireAdmin.mockReset(); mocks.task.mockReset(); mocks.audit.mockReset(); mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'operations', requestId: 'req-1' }) })

  it('returns a task-centric detail with allow-listed result and event metadata', async () => {
    mocks.task.mockResolvedValue({ id: 'task-1', userId: 'user-1', jobId: 'job-1', status: 'failed', checkpoint: 'form', error: 'Timeout while processing candidate phone +353 00 000 0000', startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(), job: { company: 'Acme', role: 'Engineer', source: 'lever', applyResults: [{ id: 12, userId: 'user-1', jobId: 'job-1', status: 'failed', mode: 'unattended', atsType: 'lever', flowUsed: 'lever', error: 'Timeout while filling', durationMs: 2000, createdAt: new Date('2026-08-09T00:00:00Z') }] }, events: [{ id: 'event-1', type: 'failed', actor: 'worker', body: 'Candidate uploaded resume: private resume text', createdAt: new Date() }] })
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/applications/task-1') as never, { params: Promise.resolve({ id: 'task-1' }) })
    const payload = await response.json()
    expect(response.status).toBe(200)
    expect(payload.application).toMatchObject({ id: 'task-1', resultId: 12, resultErrorClass: 'timeout' })
    expect(payload.task.events[0].body).toBe('The worker recorded an execution failure.')
    expect(JSON.stringify(payload)).not.toContain('candidate phone')
    expect(JSON.stringify(payload)).not.toContain('private resume text')
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'application.detail_viewed', targetId: 'task-1', tenantUserId: 'user-1' }))
  })

  it('returns task-only records before a worker result exists', async () => {
    mocks.task.mockResolvedValue({ id: 'task-2', userId: 'user-2', jobId: 'job-2', status: 'waiting_for_user', checkpoint: 'materials_ready', error: null, startedAt: null, completedAt: null, createdAt: new Date(), updatedAt: new Date(), job: { company: 'Beta', role: 'Designer', source: 'agent', applyResults: [] }, events: [] })
    const { GET } = await import('./route')
    const payload = await (await GET(new Request('http://localhost/api/admin/v1/applications/task-2') as never, { params: Promise.resolve({ id: 'task-2' }) })).json()
    expect(payload.application).toMatchObject({ id: 'task-2', resultId: null, status: 'waiting_for_user' })
    expect(payload.task.events).toEqual([])
  })
})
