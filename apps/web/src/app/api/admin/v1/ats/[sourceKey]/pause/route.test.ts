import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), audit: vi.fn(), validate: vi.fn(), claim: vi.fn(), findPolicy: vi.fn(), createPolicy: vi.fn(), updatePolicy: vi.fn(), worker: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/idempotency', () => ({ claimAdminIdempotencyKey: mocks.claim }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: mocks.worker }))
vi.mock('@/lib/db', () => ({ db: { atsSourcePolicy: { findUnique: mocks.findPolicy, create: mocks.createPolicy, update: mocks.updatePolicy } } }))

describe('POST /api/admin/v1/ats/:sourceKey/pause', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'approver', roleKey: 'operations', requestId: 'request' })
    mocks.validate.mockReturnValue(null); mocks.claim.mockResolvedValue(true)
    mocks.findPolicy.mockResolvedValue({ state: 'pending_pause', pauseRequestedById: 'requester' })
    mocks.updatePolicy.mockResolvedValue({ version: 4 })
  })
  it('allows a different authorized administrator to complete a pending pause', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/ats/lever/pause', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ reason: 'Pausing discovery while provider errors are investigated' }) }) as never, { params: Promise.resolve({ sourceKey: 'lever' }) })
    expect(response.status).toBe(200)
    expect(mocks.updatePolicy).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ state: 'paused', enabled: false }) }))
  })
})
