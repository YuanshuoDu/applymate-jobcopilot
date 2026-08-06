import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), members: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findMany: mocks.findMany }, adminMembership: { findMany: mocks.members } } }))

describe('GET /api/admin/v1/support/cases', () => {
  beforeEach(() => {
    vi.resetModules(); mocks.requireAdmin.mockReset().mockResolvedValue({ userId: 'admin-a', roleKey: 'support' }); mocks.findMany.mockReset().mockResolvedValue([{ id: 'case-1', subject: 'Question', category: 'account', status: 'open', priority: 'normal', assignedAdminId: null, slaDueAt: null, firstRespondedAt: null, resolvedAt: null, safeContext: { plan: 'pro' }, createdAt: new Date('2026-08-06T00:00:00Z'), updatedAt: new Date('2026-08-06T00:00:00Z'), requester: { id: 'user-a', email: 'member@example.com', name: 'Member User', plan: 'pro', accountStatus: 'active', location: 'Berlin, Germany', _count: { jobs: 2, applicationTasks: 1, resumes: 1 } }, messages: [{ id: 'm-1', authorType: 'customer_reply', authorUserId: 'user-a', body: 'secret body', redacted: false, createdAt: new Date('2026-08-06T00:00:00Z') }], password: 'hash', apiKey: 'secret' }]); mocks.members.mockReset().mockResolvedValue([])
  })

  it('returns masked support context and assignment metadata only', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/support/cases'))
    const body = await response.json()
    expect(response.status).toBe(200)
    expect(body.actorUserId).toBe('admin-a')
    expect(body.items[0].requester.email).toBe('m***@example.com')
    expect(body.items[0].requester.name).toBe('M*** U***')
    expect(JSON.stringify(body)).not.toContain('hash')
    expect(JSON.stringify(body)).not.toContain('apiKey')
  })
})
