import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  validateAdminWrite: vi.fn(),
  requireAdmin: vi.fn(),
  runAdminMutation: vi.fn(),
  userFindMany: vi.fn(),
  userUpdateMany: vi.fn(),
  adminMembershipUpdateMany: vi.fn(),
  agentAutomationUpdateMany: vi.fn(),
  taskUpdateMany: vi.fn(),
  applyResultFindMany: vi.fn(),
  taskFindMany: vi.fn(),
}))

vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validateAdminWrite }))
vi.mock('@/lib/admin/authorization', () => ({
  requireAdmin: mocks.requireAdmin,
  isAdminResponse: (value: unknown) => value instanceof NextResponse,
}))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.runAdminMutation }))
vi.mock('@/lib/db', () => ({ db: {
  user: { findMany: mocks.userFindMany },
  applyResult: { findMany: mocks.applyResultFindMany },
  applicationTask: { findMany: mocks.taskFindMany },
} }))

describe('POST /api/admin/v1/bulk', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.validateAdminWrite.mockReturnValue(null)
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin_1', roleKey: 'ops', requestId: 'req_1' })
    mocks.runAdminMutation.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({ duplicate: false, value: await input.mutate({
      user: { updateMany: mocks.userUpdateMany },
      adminMembership: { updateMany: mocks.adminMembershipUpdateMany },
      agentAutomation: { updateMany: mocks.agentAutomationUpdateMany },
      applicationTask: { updateMany: mocks.taskUpdateMany },
      applicationTaskEvent: { create: vi.fn().mockResolvedValue({}) },
    }) }))
  })

  it('suspends only selected users and records the requested reason', async () => {
    mocks.userFindMany.mockResolvedValue([{ id: 'user_1', accountStatus: 'active' }, { id: 'user_2', accountStatus: 'suspended' }])
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.adminMembershipUpdateMany.mockResolvedValue({ count: 1 })
    mocks.agentAutomationUpdateMany.mockResolvedValue({ count: 1 })
    mocks.taskUpdateMany.mockResolvedValue({ count: 1 })
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/admin/v1/bulk', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Idempotency-Key': 'bulk-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: 'users', action: 'suspend', ids: ['user_1', 'user_2'], reason: 'Security review requires temporary suspension' }),
    }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ resource: 'users', action: 'suspend', affected: 1 })
    expect(mocks.requireAdmin).toHaveBeenCalledWith('users.suspend', expect.any(NextRequest))
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['user_1'] } }, data: expect.objectContaining({ accountStatus: 'suspended', suspendedById: 'admin_1', authVersion: { increment: 1 } }) }))
    expect(mocks.adminMembershipUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: { in: ['user_1'] } },
      data: expect.objectContaining({ sessionVersion: { increment: 1 }, status: 'suspended', revokedAt: expect.any(Date) }),
    }))
    expect(mocks.agentAutomationUpdateMany).toHaveBeenCalledWith({ where: { userId: { in: ['user_1'] } }, data: { enabled: false } })
    expect(mocks.taskUpdateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['user_1'] }, status: { in: ['filling', 'waiting_for_authorization'] } },
      data: { status: 'waiting_for_user', checkpoint: 'account_suspended', error: 'Account suspended; external processing was stopped.' },
    })
  })

  it('restores the account without automatically restoring a revoked administrator membership', async () => {
    mocks.userFindMany.mockResolvedValue([{ id: 'user_1', accountStatus: 'suspended' }])
    mocks.userUpdateMany.mockResolvedValue({ count: 1 })
    mocks.adminMembershipUpdateMany.mockResolvedValue({ count: 1 })
    const { POST } = await import('./route')

    const response = await POST(new NextRequest('http://localhost/api/admin/v1/bulk', {
      method: 'POST',
      headers: { Origin: 'http://localhost', 'Idempotency-Key': 'bulk-restore-1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ resource: 'users', action: 'restore', ids: ['user_1'], reason: 'Security review confirmed the account can be restored' }),
    }))

    expect(response.status).toBe(200)
    expect(mocks.userUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accountStatus: 'active', authVersion: { increment: 1 } }),
    }))
    expect(mocks.adminMembershipUpdateMany).toHaveBeenCalledWith({
      where: { userId: { in: ['user_1'] } },
      data: { sessionVersion: { increment: 1 } },
    })
    expect(mocks.agentAutomationUpdateMany).not.toHaveBeenCalled()
    expect(mocks.taskUpdateMany).not.toHaveBeenCalled()
  })

  it('rejects a failed CSRF/origin check before authentication', async () => {
    mocks.validateAdminWrite.mockReturnValue(NextResponse.json({ error: 'Invalid request origin' }, { status: 403 }))
    const { POST } = await import('./route')
    const response = await POST(new NextRequest('http://localhost/api/admin/v1/bulk', { method: 'POST', body: '{}' }))

    expect(response.status).toBe(403)
    expect(mocks.requireAdmin).not.toHaveBeenCalled()
  })
})
