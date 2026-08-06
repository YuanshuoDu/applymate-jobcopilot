import { describe, expect, it, vi } from 'vitest'
import { safeAuditSnapshot, writeAdminAudit } from './audit'

describe('admin audit safety', () => {
  it('keeps only allow-listed operational fields', () => {
    expect(safeAuditSnapshot({ status: 'active', version: 2, password: 'hash', body: 'private' })).toEqual({
      status: 'active',
      version: 2,
    })
  })

  it('writes hashed request metadata and no sensitive snapshot values', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'audit_1' })
    await writeAdminAudit({ adminAuditLog: { create } }, {
      requestId: 'req_1',
      actorUserId: 'admin_1',
      actorRoleKey: 'support',
      action: 'admin.member.viewed',
      outcome: 'success',
      reason: 'Review access status',
      ip: '203.0.113.10',
      userAgent: 'browser',
      before: { status: 'active', password: 'hash' },
      after: { status: 'active', apiKey: 'secret' },
    })

    const data = create.mock.calls[0][0].data
    expect(data.ipHash).not.toBe('203.0.113.10')
    expect(data.userAgentHash).not.toBe('browser')
    expect(data.before).toEqual({ status: 'active' })
    expect(data.after).toEqual({ status: 'active' })
    expect(JSON.stringify(data)).not.toContain('secret')
    expect(JSON.stringify(data)).not.toContain('password')
  })
})
