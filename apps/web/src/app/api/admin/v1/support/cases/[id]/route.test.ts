import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), audit: vi.fn(), validate: vi.fn(), claim: vi.fn(), findCase: vi.fn(), updateCase: vi.fn(), findMember: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/idempotency', () => ({ claimAdminIdempotencyKey: mocks.claim }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findUnique: mocks.findCase, updateMany: mocks.updateCase }, adminMembership: { findUnique: mocks.findMember } } }))

describe('PATCH /api/admin/v1/support/cases/:id', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'support-user', roleKey: 'support', permissions: ['support_cases.assign', 'support_cases.resolve'], requestId: 'request' })
    mocks.validate.mockReturnValue(null); mocks.claim.mockResolvedValue(true)
    mocks.findCase.mockResolvedValue({ requesterUserId: 'candidate-user' }); mocks.updateCase.mockResolvedValue({ count: 1 })
  })

  it('uses the supplied case version when updating an assigned support case', async () => {
    const { PATCH } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/support/cases/case-1', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'request-key' }, body: JSON.stringify({ status: 'in_progress', version: 3, reason: 'Starting investigation of the customer report' }) })
    const response = await PATCH(request as never, { params: Promise.resolve({ id: 'case-1' }) })
    expect(response.status).toBe(200)
    expect(mocks.updateCase).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'case-1', version: 3 }, data: expect.objectContaining({ status: 'in_progress', version: { increment: 1 } }) }))
  })

  it('requires the resolution permission before resolving a case', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'support-user', roleKey: 'support', permissions: ['support_cases.assign'], requestId: 'request' })
    const { PATCH } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/support/cases/case-1', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'request-key' }, body: JSON.stringify({ status: 'resolved', version: 3, reason: 'Resolution requires an explicitly granted permission' }) })
    const response = await PATCH(request as never, { params: Promise.resolve({ id: 'case-1' }) })
    expect(response.status).toBe(403)
    expect(mocks.updateCase).not.toHaveBeenCalled()
  })
})
