import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  activityCreate: vi.fn(),
  transaction: vi.fn(),
  dto: vi.fn(),
  canTransition: vi.fn(),
}))
  vi.mock('@/lib/admin/settings-access', () => ({
    requireSettingsAdmin: mocks.admin,
    toAdminSettingsDto: mocks.dto,
  canTransitionDeletionRequest: mocks.canTransition,
  parseAdminSettingsPatch: (value: unknown) => {
    const body = value as Record<string, unknown>
    if (!body || typeof body !== 'object') return { error: 'invalid patch' }
    const unsupported = Object.keys(body).some(key => !['notificationPreferences', 'privacyPreferences', 'dataDeletionRequestStatus'].includes(key))
    return unsupported ? { error: 'unsupported admin settings field' } : body
  },
}))
vi.mock('@/lib/db', () => ({ db: {
  user: { findUnique: mocks.findUnique, update: mocks.update },
  activity: { create: mocks.activityCreate },
  $transaction: mocks.transaction,
} }))
vi.mock('@/lib/api-helpers', () => ({
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

const params = Promise.resolve({ id: 'user_1' })

describe('/api/admin/v1/users/:id/settings', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.admin.mockResolvedValue({ userId: 'admin_1', email: 'admin@example.com' })
    mocks.canTransition.mockReturnValue(true)
    mocks.findUnique.mockResolvedValue({ id: 'user_1', email: 'candidate@example.com', preferences: { aiSettings: { keys: { openai: 'secret' } } } })
    mocks.update.mockResolvedValue({ id: 'user_1', preferences: {} })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => callback({
      user: { update: mocks.update },
      activity: { create: mocks.activityCreate },
    }))
    mocks.dto.mockReturnValue({ id: 'user_1', preferences: {} })
  })

  it('reads one candidate through the shared safe DTO', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/admin') as never, { params })
    expect(response.status).toBe(200)
    expect(mocks.dto).toHaveBeenCalled()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('updates only allowed settings and records a safe activity event', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notificationPreferences: { weekly: true } }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'user_1' } }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'user_1', type: 'note_added' }),
    }))
    expect(JSON.stringify(mocks.activityCreate.mock.calls[0])).not.toContain('secret')
  })

  it('rejects plan changes instead of mutating the user record', async () => {
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: 'pro' }),
    }) as never, { params })

    expect(response.status).toBe(400)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('advances a valid GDPR request through the audited admin workflow', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'user_1', email: 'candidate@example.com', preferences: {
        dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
        dataDeletionRequestStatus: 'requested',
        aiSettings: { keys: { openai: 'secret' } },
      },
    })
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDeletionRequestStatus: 'processing' }),
    }) as never, { params })

    expect(response.status).toBe(200)
    expect(mocks.canTransition).toHaveBeenCalledWith(expect.anything(), 'processing')
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        preferences: expect.objectContaining({
          dataDeletionRequestedAt: '2026-08-05T10:00:00.000Z',
          dataDeletionRequestStatus: 'processing',
        }),
      }),
    }))
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ text: expect.stringContaining('GDPR deletion request') }),
    }))
  })

  it('rejects an invalid GDPR request transition without writing', async () => {
    mocks.canTransition.mockReturnValue(false)
    const { PATCH } = await import('./route')
    const response = await PATCH(new Request('http://localhost/admin', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataDeletionRequestStatus: 'completed' }),
    }) as never, { params })

    expect(response.status).toBe(409)
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })
})
