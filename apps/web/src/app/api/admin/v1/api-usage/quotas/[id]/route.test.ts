import { NextRequest, NextResponse } from 'next/server'
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdminAny: vi.fn(), findUnique: vi.fn(), mutation: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdminAny: mocks.requireAdminAny, isAdminResponse: (value: unknown) => value instanceof NextResponse }))
vi.mock('@/lib/admin/write-transaction', () => ({ runAdminMutation: mocks.mutation }))
vi.mock('@/lib/db', () => ({ db: { apiQuota: { findUnique: mocks.findUnique } } }))
import { PATCH } from './route'

describe('PATCH /api/admin/v1/api-usage/quotas/:id', () => {
  it('prevents an AI-only operator from changing a job supplier quota', async () => {
    mocks.requireAdminAny.mockResolvedValue({ userId: 'admin-1', roleKey: 'ops', requestId: 'req-1', permissions: ['ai_budget.update'] })
    mocks.findUnique.mockResolvedValue({ id: 'quota-1', category: 'job' })
    const request = new NextRequest('http://localhost/api/admin/v1/api-usage/quotas/quota-1', { method: 'PATCH', body: '{}' })
    const response = await PATCH(request, { params: Promise.resolve({ id: 'quota-1' }) })
    expect(response.status).toBe(403)
    expect(mocks.mutation).not.toHaveBeenCalled()
  })
})
