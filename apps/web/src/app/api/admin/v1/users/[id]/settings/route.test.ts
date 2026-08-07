import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  writeAudit: vi.fn(),
  validateWrite: vi.fn(),
  runMutation: vi.fn(),
  dto: vi.fn(),
  snapshot: vi.fn(),
  canTransition: vi.fn(),
}))

vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof Response,
}))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.writeAudit }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateWrite }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.runMutation }))
vi.mock('@/lib/admin/settings-access', () => ({
  toAdminSettingsDto: mocks.dto,
  adminSettingsAuditSnapshot: mocks.snapshot,
  canTransitionDeletionRequest: mocks.canTransition,
  parseAdminSettingsPatch: (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Invalid settings body' }
    const body = value as Record<string, unknown>
    if (Object.keys(body).some(key => !['notificationPreferences', 'privacyPreferences', 'dataDeletionRequestStatus'].includes(key))) return { error: 'Unsupported settings field' }
    return body
  },
}))
vi.mock('@/lib/settings-preferences', () => ({
  mergeUserPreferences: (existing: unknown, patch: unknown) => ({ ...(existing as Record<string, unknown>), ...(patch as Record<string, unknown>) }),
}))
vi.mock('@/lib/api-helpers', () => ({
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique, update: mocks.update } } }))

const params = Promise.resolve({ id: 'user_1' })

describe('/api/admin/v1/users/:id/settings', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'support', requestId: 'request_1' })
    mocks.findUnique.mockResolvedValue({ id: 'user_1', email: 'candidate@example.com', preferences: { aiSettings: { keys: { openai: 'secret' } } } })
    mocks.update.mockResolvedValue({ id: 'user_1', preferences: {} })
    mocks.dto.mockReturnValue({ id: 'user_1', preferences: {} })
    mocks.snapshot.mockReturnValue({ notificationPreferences: {}, privacyPreferences: {} })
    mocks.canTransition.mockReturnValue(true)
    mocks.validateWrite.mockReturnValue(null)
    mocks.runMutation.mockImplementation(async (input: { mutate: (tx: unknown) => unknown }) => ({
      duplicate: false,
      value: await input.mutate({ user: { update: mocks.update } }),
    }))
  })

  it('reads one candidate with the upstream users.read permission', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin') as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.requireAdmin).toHaveBeenCalledWith('users.read', expect.any(Request))
    expect(mocks.dto).toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('updates settings with users.update_preferences and writes an append-only audit event', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'settings-key-1' },
      body: JSON.stringify({ notificationPreferences: { weekly: true }, reason: 'Updating notification preferences' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.requireAdmin).toHaveBeenCalledWith('users.update_preferences', expect.any(Request))
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user_1' } }))
    expect(mocks.runMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'users.preferences_updated',
      targetId: 'user_1',
    }))
    const mutation = mocks.runMutation.mock.calls[0][0] as { audit: (value: unknown) => unknown }
    const audit = mutation.audit({ preferences: {} })
    expect(audit).toEqual(expect.objectContaining({
      targetId: 'user_1',
      tenantUserId: 'user_1',
      before: expect.any(Object),
      after: expect.any(Object),
    }))
    expect(JSON.stringify(audit)).not.toContain('secret')
    expect(mocks.writeAudit).not.toHaveBeenCalled()
  })

  it('requires an audit reason before changing candidate settings', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'settings-key-no-reason' },
      body: JSON.stringify({ notificationPreferences: { weekly: true } }),
    }) as never, { params })

    expect(response.status).toBe(400)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })

  it('denies a caller without the write permission before reading the candidate', async () => {
    mocks.requireAdmin.mockResolvedValue(Response.json({ error: 'Forbidden' }, { status: 403 }))
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'settings-key-2' }, body: '{}' }) as never, { params })

    expect(response.status).toBe(403)
    expect(mocks.findUnique).not.toHaveBeenCalled()
  })

  it('rejects a write without the admin origin and idempotency checks', async () => {
    mocks.validateWrite.mockReturnValue(Response.json({ error: 'Invalid request origin' }, { status: 403 }))
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', { method: 'PATCH', body: '{}' }) as never, { params })

    expect(response.status).toBe(403)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })

  it('writes the change through the idempotent audit transaction', async () => {
    const { PATCH } = await import('./route')
    await PATCH(new Request('http://localhost/admin', { method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'settings-key-3' }, body: JSON.stringify({ notificationPreferences: { weekly: true }, reason: 'Updating notification preferences' }) }) as never, { params })

    expect(mocks.runMutation).toHaveBeenCalledWith(expect.objectContaining({
      action: 'users.preferences_updated',
      idempotencyKey: 'settings-key-3',
      targetId: 'user_1',
    }))
    expect(mocks.runMutation.mock.calls[0][0]).not.toHaveProperty('targetType')
  })

  it('rejects a plan mutation without changing the user record', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH', headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'settings-key-4' }, body: JSON.stringify({ plan: 'pro' }),
    }) as never, { params })

    expect(response.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.writeAudit).not.toHaveBeenCalled()
  })
})
