import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class AdminMutationConflict extends Error {}
  return {
    requireAdmin: vi.fn(), validate: vi.fn(), findUnique: vi.fn(), findScopedCase: vi.fn(), runMutation: vi.fn(),
    txFindScopedCase: vi.fn(), claimCase: vi.fn(), createMessage: vi.fn(), AdminMutationConflict,
  }
})

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ AdminMutationConflict: mocks.AdminMutationConflict, runAdminMutation: mocks.runMutation }))
vi.mock('@/lib/contact-us', () => ({ parseReply: () => ({ body: 'Internal note', redacted: false }) }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findUnique: mocks.findUnique, findFirst: mocks.findScopedCase } } }))

describe('POST /api/admin/v1/support/cases/:id/notes', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'support-user', roleKey: 'support', permissions: ['support_cases.note'], requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.findUnique.mockResolvedValue({ requesterUserId: 'candidate-user' })
    mocks.findScopedCase.mockResolvedValue({ requesterUserId: 'candidate-user' })
    mocks.txFindScopedCase.mockResolvedValue({ id: 'case-1' })
    mocks.claimCase.mockResolvedValue({ count: 1 })
    mocks.createMessage.mockResolvedValue({ id: 'message-1' })
    mocks.runMutation.mockResolvedValue({ duplicate: false, value: { id: 'message-1' } })
  })

  it('does not let a support member add a note to a case assigned to someone else', async () => {
    mocks.findScopedCase.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/support/cases/case-2/notes', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'note-key' }, body: JSON.stringify({ body: 'Internal note', reason: 'Documenting the investigation for the assigned agent' }) })

    const response = await POST(request as never, { params: Promise.resolve({ id: 'case-2' }) })

    expect(response.status).toBe(404)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })

  it('rejects a note when assignment changes after the scoped preflight', async () => {
    mocks.claimCase.mockResolvedValueOnce({ count: 0 })
    mocks.runMutation.mockImplementation(async ({ mutate }: { mutate: (tx: unknown) => Promise<unknown> }) => ({
      duplicate: false,
      value: await mutate({
        supportCase: { findFirst: mocks.txFindScopedCase, updateMany: mocks.claimCase },
        supportCaseMessage: { create: mocks.createMessage },
      }),
    }))
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/support/cases/case-1/notes', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'note-race-key' }, body: JSON.stringify({ body: 'Internal note', reason: 'Documenting the investigation for the assigned agent' }) })

    const response = await POST(request as never, { params: Promise.resolve({ id: 'case-1' }) })

    expect(response.status).toBe(409)
    expect(mocks.createMessage).not.toHaveBeenCalled()
  })
})
