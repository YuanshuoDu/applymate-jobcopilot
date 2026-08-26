import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PATCH } from './route'

const mocks = vi.hoisted(() => {
  class TestMutationConflict extends Error {}
  return {
    requireAdmin: vi.fn(),
    validate: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    run: vi.fn(),
    TestMutationConflict,
  }
})

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ AdminMutationConflict: mocks.TestMutationConflict, runAdminMutation: mocks.run }))
vi.mock('@/lib/db', () => ({ db: { atsEmployer: { findUnique: mocks.findUnique } } }))

function request(body: Record<string, unknown>) {
  return new Request('http://localhost/api/admin/v1/ats/registry/7', {
    method: 'PATCH',
    headers: { Origin: 'http://localhost', Host: 'localhost', 'Idempotency-Key': 'ats-update-1', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('PATCH /api/admin/v1/ats/registry/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'admin-1', roleKey: 'platform_admin', requestId: 'req-1' })
    mocks.validate.mockReturnValue(null)
    mocks.findUnique.mockResolvedValue({ id: 7, atsType: 'lever', slug: 'tradeRepublic', name: 'Trade Republic', country: 'de', enabled: true, version: 3 })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    mocks.findUniqueOrThrow.mockResolvedValue({ id: 7, atsType: 'lever', slug: 'tradeRepublic', name: 'Trade Republic', country: 'de', enabled: false, version: 4 })
    mocks.run.mockImplementation(async (input: { mutate: (tx: unknown) => Promise<unknown> }) => ({ duplicate: false, value: await input.mutate({ atsEmployer: { updateMany: mocks.updateMany, findUniqueOrThrow: mocks.findUniqueOrThrow } }) }))
  })

  it('updates the registry entry with an optimistic version check', async () => {
    const response = await PATCH(request({ name: 'Trade Republic GmbH', country: 'DE', enabled: false, version: 3, reason: 'Disable while the ATS board is under maintenance' }) as never, { params: Promise.resolve({ id: '7' }) })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ employer: expect.objectContaining({ enabled: false, version: 4 }) }))
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 7, version: 3 }, data: expect.objectContaining({ enabled: false, version: { increment: 1 } }) }))
  })

  it('rejects a stale version before writing', async () => {
    mocks.findUnique.mockResolvedValueOnce({ id: 7, atsType: 'lever', slug: 'tradeRepublic', name: 'Trade Republic', country: 'de', enabled: true, version: 4 })
    const response = await PATCH(request({ name: 'Trade Republic', country: 'DE', enabled: false, version: 3, reason: 'Disable while the ATS board is under maintenance' }) as never, { params: Promise.resolve({ id: '7' }) })

    expect(response.status).toBe(409)
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
