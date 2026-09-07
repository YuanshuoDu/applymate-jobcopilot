import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  writeAdminAudit: vi.fn(),
  verifyAdminAuditChain: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.writeAdminAudit }))
vi.mock('@/lib/admin/audit-integrity', () => ({ verifyAdminAuditChain: mocks.verifyAdminAuditChain }))

describe('GET /api/admin/v1/audit/integrity', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.resetModules()
    mocks.requireAdmin.mockReset()
    mocks.writeAdminAudit.mockReset()
    mocks.verifyAdminAuditChain.mockReset()
    mocks.requireAdmin.mockResolvedValue({ requestId: 'req-1', userId: 'admin-1', roleKey: 'super_admin' })
    mocks.writeAdminAudit.mockResolvedValue(undefined)
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => errorSpy.mockRestore())

  it('returns 503 without appending to a broken chain', async () => {
    mocks.verifyAdminAuditChain.mockResolvedValue({
      verified: false,
      recordCount: 2,
      firstRecordHash: 'hash-a',
      lastRecordHash: 'hash-b',
      brokenAt: 'audit-b',
    })

    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/audit/integrity') as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ verified: false, brokenAt: 'audit-b' })
    expect(mocks.writeAdminAudit).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('ADMIN_AUDIT_INTEGRITY_FAILED', expect.objectContaining({ brokenAt: 'audit-b' }))
  })

  it('records a successful integrity check when the chain verifies', async () => {
    mocks.verifyAdminAuditChain.mockResolvedValue({
      verified: true,
      recordCount: 2,
      firstRecordHash: 'hash-a',
      lastRecordHash: 'hash-b',
      brokenAt: null,
    })

    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/audit/integrity') as never)

    expect(response.status).toBe(200)
    expect(mocks.writeAdminAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'audit.integrity_checked',
      outcome: 'success',
      after: { verified: true, recordCount: 2, brokenAt: null },
    }))
  })

  it('returns 503 without an audit write when the verifier or helper migration is unavailable', async () => {
    mocks.verifyAdminAuditChain.mockRejectedValue(new Error('function admin_audit_record_hash does not exist'))

    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/audit/integrity') as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ verified: false, errorCode: 'integrity_unavailable' })
    expect(mocks.writeAdminAudit).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith('ADMIN_AUDIT_INTEGRITY_UNAVAILABLE', { requestId: 'req-1', errorCode: 'integrity_unavailable' })
  })
})
