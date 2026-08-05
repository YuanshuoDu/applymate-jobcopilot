import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), findMany: vi.fn(), audit: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/audit', () => ({ writeAdminAudit: mocks.audit }))
vi.mock('@/lib/db', () => ({ db: { aiBudget: { findMany: mocks.findMany } } }))

describe('GET /api/admin/v1/ai/budgets', () => {
  beforeEach(() => { vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.findMany.mockReset(); mocks.audit.mockReset() })
  it('returns accounting metadata and clamps negative remaining credits', async () => {
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'analyst', requestId: 'req-1' })
    mocks.findMany.mockResolvedValue([{ id: 'budget-1', userId: 'user-1', month: '2026-08', used: 12, limit: 10, updatedAt: new Date() }])
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/admin/v1/ai/budgets') as never)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ items: [expect.objectContaining({ remaining: 0 })] }))
  })
})
