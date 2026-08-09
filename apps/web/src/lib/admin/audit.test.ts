import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createAudit: vi.fn(), createAlert: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { adminAuditLog: { create: mocks.createAudit }, adminAlertEvent: { create: mocks.createAlert } } }))

describe('writeAdminAudit', () => {
  beforeEach(() => { mocks.createAudit.mockReset(); mocks.createAlert.mockReset(); mocks.createAlert.mockResolvedValue({}); vi.spyOn(console, 'error').mockImplementation(() => undefined) })

  it('persists the audit record', async () => {
    const { writeAdminAudit } = await import('./audit')
    await writeAdminAudit({ requestId: 'req-1', action: 'test', outcome: 'success' })
    expect(mocks.createAudit).toHaveBeenCalledWith({ data: expect.objectContaining({ requestId: 'req-1', action: 'test' }) })
  })

  it('raises a durable critical alert when audit persistence fails', async () => {
    const failure = new Error('database unavailable')
    mocks.createAudit.mockRejectedValue(failure)
    const { writeAdminAudit } = await import('./audit')
    await expect(writeAdminAudit({ requestId: 'req-2', action: 'dangerous', outcome: 'failed' })).rejects.toThrow('database unavailable')
    expect(mocks.createAlert).toHaveBeenCalledWith({ data: expect.objectContaining({ ruleKey: 'audit.write_failure', severity: 'critical' }) })
  })
})
