import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findUnique: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: () => null }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: { platformFeatureFlag: { findUnique: mocks.findUnique } } }))

describe('POST /api/admin/v1/platform/flags/:id/reject', () => {
  beforeEach(() => { vi.resetModules(); Object.values(mocks).forEach((mock) => mock.mockReset()) })

  it('requires a different administrator from the creator', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'creator-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue({ createdById: 'creator-1', status: 'pending_approval' })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/platform/flags/f1/reject', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ version: 2, reason: 'Return the flag for rollout correction' }) }) as never, { params: Promise.resolve({ id: 'f1' }) })
    expect(response.status).toBe(403)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })

  it('returns a pending flag to draft with an audited mutation', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'reviewer-1', roleKey: 'platform_admin', requestId: 'request-1' })
    mocks.findUnique.mockResolvedValue({ createdById: 'creator-1', status: 'pending_approval' })
    mocks.mutation.mockResolvedValue({ duplicate: false, value: { count: 1 } })
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/admin/v1/platform/flags/f1/reject', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'key-1' }, body: JSON.stringify({ version: 2, reason: 'Return the flag for rollout correction' }) }) as never, { params: Promise.resolve({ id: 'f1' }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ flag: { id: 'f1', status: 'draft', version: 3 } })
    expect(mocks.mutation).toHaveBeenCalled()
  })
})
