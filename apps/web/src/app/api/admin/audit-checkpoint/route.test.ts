import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  upsert: vi.fn(),
}))

vi.mock('@/lib/admin/audit-integrity', () => ({ verifyAdminAuditChain: mocks.verify }))
vi.mock('@/lib/db', () => ({ db: { adminAuditCheckpoint: { upsert: mocks.upsert } } }))

describe('POST /api/admin/audit-checkpoint', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    Object.values(mocks).forEach((mock) => mock.mockReset())
    vi.stubEnv('WEB_MAINTENANCE_CRON_SECRET', 'maintenance-secret')
    mocks.verify.mockResolvedValue({ verified: true, recordCount: 3, firstRecordHash: 'first', lastRecordHash: 'last' })
    mocks.upsert.mockResolvedValue({ id: 'checkpoint-1' })
  })

  it('accepts the worker maintenance secret and stores the verified checkpoint', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/audit-checkpoint', { method: 'POST', headers: { authorization: 'Bearer maintenance-secret' } }) as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ verified: true, checkpointId: 'checkpoint-1', recordCount: 3 })
    expect(mocks.upsert).toHaveBeenCalledTimes(1)
  })

  it('returns 503 when the hash chain is broken', async () => {
    mocks.verify.mockResolvedValue({ verified: false, recordCount: 3, firstRecordHash: 'first', lastRecordHash: 'bad', brokenAt: 'audit-2' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/audit-checkpoint', { method: 'POST', headers: { authorization: 'Bearer maintenance-secret' } }) as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ verified: false, checkpointId: 'checkpoint-1', recordCount: 3 })
  })

  it('rejects requests without a configured secret', async () => {
    vi.stubEnv('WEB_MAINTENANCE_CRON_SECRET', '')
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/audit-checkpoint', { method: 'POST', headers: { authorization: 'Bearer maintenance-secret' } }) as never)

    expect(response.status).toBe(401)
    expect(mocks.verify).not.toHaveBeenCalled()
  })
})
