import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), audit: vi.fn(), validate: vi.fn(), claim: vi.fn(), findPolicy: vi.fn(), updatePolicy: vi.fn(), createPolicy: vi.fn(), worker: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/idempotency', () => ({ claimAdminIdempotencyKey: mocks.claim }))
vi.mock('@/lib/admin/worker-client', () => ({ sendWorkerCommand: mocks.worker }))
vi.mock('@/lib/db', () => ({ db: { atsSourcePolicy: { findUnique: mocks.findPolicy, updateMany: mocks.updatePolicy, create: mocks.createPolicy, update: vi.fn() } } }))

describe('PATCH /api/admin/v1/ats/:sourceKey/policy', () => {
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin', roleKey: 'platform_admin', requestId: 'request' })
    mocks.validate.mockReturnValue(null); mocks.claim.mockResolvedValue(true)
  })
  it('rejects a requested RPS value above the hard Workday ceiling', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/api/admin/v1/ats/workday/policy', { method: 'PATCH', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'key' }, body: JSON.stringify({ rolloutPercent: 100, globalRpsLimit: 2, perTenantRpsLimit: 1, maxRetries: 3, backoffBaseMs: 1000, allowAutoApply: false, version: 1, reason: 'Maintaining a compliant discovery pacing policy' }) }) as never, { params: Promise.resolve({ sourceKey: 'workday' }) })
    expect(response.status).toBe(400)
    expect(mocks.createPolicy).not.toHaveBeenCalled()
    expect(mocks.updatePolicy).not.toHaveBeenCalled()
  })
})
