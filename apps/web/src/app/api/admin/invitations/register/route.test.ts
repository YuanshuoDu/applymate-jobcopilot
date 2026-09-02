import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  invitationFindUnique: vi.fn(),
  userFindMany: vi.fn(),
  userCreate: vi.fn(),
  auditCreate: vi.fn(),
  transaction: vi.fn(),
  hash: vi.fn(),
  rate: vi.fn(),
  auditData: vi.fn(),
  requestId: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  db: {
    adminInvitation: { findUnique: mocks.invitationFindUnique },
    user: { findMany: mocks.userFindMany },
    $transaction: mocks.transaction,
  },
}))
vi.mock('bcryptjs', () => ({ default: { hash: mocks.hash } }))
vi.mock('@/lib/auth-rate-limit', () => ({ checkAuthRateLimit: mocks.rate }))
vi.mock('@/lib/admin/audit', () => ({ createAdminAuditData: mocks.auditData, requestIdFor: mocks.requestId }))

function request(body: unknown, host = 'localhost') {
  return new NextRequest(`http://${host}/api/admin/invitations/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/invitations/register', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.rate.mockResolvedValue({ ok: true })
    mocks.requestId.mockReturnValue('req-1')
    mocks.auditData.mockImplementation((value: unknown) => value)
    mocks.invitationFindUnique.mockResolvedValue({ id: 'inv-1', email: 'new@example.com', status: 'pending', expiresAt: new Date(Date.now() + 60_000) })
    mocks.userFindMany.mockResolvedValue([])
    mocks.hash.mockResolvedValue('password-hash')
    mocks.userCreate.mockResolvedValue({ id: 'user-1', email: 'new@example.com', name: 'New Admin' })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({ user: { create: mocks.userCreate }, adminAuditLog: { create: mocks.auditCreate } }))
  })

  it('creates an ordinary account from a valid invitation without requiring an existing user', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ token: 'a'.repeat(32), email: ' NEW@EXAMPLE.COM ', name: 'New Admin', password: 'password-123' }))

    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toMatchObject({ created: true, user: { id: 'user-1' } })
    expect(mocks.userCreate).toHaveBeenCalledWith({ data: { email: 'new@example.com', name: 'New Admin', password: 'password-hash' }, select: { id: true, email: true, name: true } })
    expect(mocks.auditCreate).toHaveBeenCalled()
  })

  it('rejects a token when the submitted email does not match the invitation', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ token: 'a'.repeat(32), email: 'other@example.com', name: 'Other', password: 'password-123' }))

    expect(response.status).toBe(400)
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it('keeps the existing-account path explicit so the invitee can sign in instead', async () => {
    mocks.userFindMany.mockResolvedValue([{ id: 'existing-user' }])
    const { POST } = await import('./route')
    const response = await POST(request({ token: 'a'.repeat(32), email: 'new@example.com', name: 'Existing', password: 'password-123' }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'An account already exists for this invitation email', code: 'ACCOUNT_EXISTS' })
    expect(mocks.userCreate).not.toHaveBeenCalled()
  })

  it('does not expose the registration endpoint on the public application host', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ token: 'a'.repeat(32), email: 'new@example.com', name: 'New Admin', password: 'password-123' }, 'applymate.site'))

    expect(response.status).toBe(404)
    expect(mocks.invitationFindUnique).not.toHaveBeenCalled()
  })
})
