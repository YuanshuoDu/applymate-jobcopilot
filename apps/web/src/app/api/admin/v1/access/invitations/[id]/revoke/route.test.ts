import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => {
  class TestMutationConflict extends Error {}
  return {
    TestMutationConflict,
    requireAdmin: vi.fn(),
    validate: vi.fn(),
    run: vi.fn(),
    invitationFindUnique: vi.fn(),
    invitationUpdateMany: vi.fn(),
  }
})

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ AdminMutationConflict: mocks.TestMutationConflict, runAdminMutation: mocks.run }))
vi.mock('@/lib/db', () => ({ db: {} }))

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/admin/v1/access/invitations/inv-1/revoke', {
    method: 'POST',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Content-Type': 'application/json', 'Idempotency-Key': 'revoke-1', ...headers },
    body: JSON.stringify(body),
  })
}

describe('POST /api/admin/v1/access/invitations/:id/revoke', () => {
  beforeEach(() => {
    vi.resetModules()
    for (const mock of [mocks.requireAdmin, mocks.validate, mocks.run, mocks.invitationFindUnique, mocks.invitationUpdateMany]) mock.mockReset()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'super_admin', requestId: 'req-1' })
    mocks.validate.mockReturnValue(null)
    mocks.invitationFindUnique.mockResolvedValue({ email: 'invited@example.com', status: 'pending' })
    mocks.invitationUpdateMany.mockResolvedValue({ count: 1 })
    mocks.run.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({
      duplicate: false,
      value: await input.mutate({ adminInvitation: { findUnique: mocks.invitationFindUnique, updateMany: mocks.invitationUpdateMany } }),
    }))
  })

  it('revokes a pending invitation atomically and records the requested mutation', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ reason: 'The previous invitation link was superseded' }), { params: Promise.resolve({ id: 'inv-1' }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ revoked: true, invitation: { id: 'inv-1', email: 'invited@example.com' } })
    expect(mocks.invitationUpdateMany).toHaveBeenCalledWith({ where: { id: 'inv-1', status: 'pending' }, data: { status: 'revoked' } })
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_invitation.revoked', targetId: 'inv-1', idempotencyKey: 'revoke-1' }))
  })

  it('requires an auditable reason and idempotency key', async () => {
    const { POST } = await import('./route')
    const response = await POST(request({ reason: 'short' }, { 'Idempotency-Key': '' }), { params: Promise.resolve({ id: 'inv-1' }) })

    expect(response.status).toBe(400)
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('returns a conflict when the invitation is no longer pending', async () => {
    mocks.invitationFindUnique.mockResolvedValue({ email: 'invited@example.com', status: 'revoked' })
    const { POST } = await import('./route')
    const response = await POST(request({ reason: 'Revoke the superseded invitation' }), { params: Promise.resolve({ id: 'inv-1' }) })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Invitation is no longer pending', code: 'INVITATION_STATE_CONFLICT' })
    expect(mocks.invitationUpdateMany).not.toHaveBeenCalled()
  })

  it('rolls back when a concurrent request changes the invitation first', async () => {
    mocks.invitationUpdateMany.mockResolvedValue({ count: 0 })
    const { POST } = await import('./route')
    const response = await POST(request({ reason: 'Revoke the invitation after a concurrent change' }), { params: Promise.resolve({ id: 'inv-1' }) })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'Invitation changed before it could be revoked', code: 'INVITATION_STATE_CONFLICT' })
  })
})
