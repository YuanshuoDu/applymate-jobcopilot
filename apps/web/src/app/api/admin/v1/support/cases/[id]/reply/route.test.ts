import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  class AdminMutationConflict extends Error {}
  return {
    requireAdmin: vi.fn(), validate: vi.fn(), findUnique: vi.fn(), findScopedCase: vi.fn(), runMutation: vi.fn(),
    txFindScopedCase: vi.fn(), claimCase: vi.fn(), createMessage: vi.fn(), updateCase: vi.fn(), createNotification: vi.fn(), AdminMutationConflict,
  }
})
const pinnedFetch = vi.hoisted(() => vi.fn())

vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin, isAdminResponse: (value: unknown) => value instanceof Response }))
vi.mock('@/lib/admin/csrf', () => ({ validateAdminWrite: mocks.validate }))
vi.mock('@/lib/admin/write-transaction', () => ({ AdminMutationConflict: mocks.AdminMutationConflict, runAdminMutation: mocks.runMutation }))
vi.mock('@jobcopilot/shared', () => ({ pinnedFetch }))
vi.mock('@/lib/contact-us', () => ({ parseReply: () => ({ body: 'Reply body', redacted: false }) }))
vi.mock('@/lib/db', () => ({ db: { supportCase: { findUnique: mocks.findUnique, findFirst: mocks.findScopedCase } } }))

describe('POST /api/admin/v1/support/cases/:id/reply', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAdmin.mockResolvedValue({ userId: 'support-user', roleKey: 'support', permissions: ['support_cases.reply'], requestId: 'request' })
    mocks.validate.mockReturnValue(null)
    mocks.findUnique.mockResolvedValue({ requesterUserId: 'candidate-user' })
    mocks.findScopedCase.mockResolvedValue({ requesterUserId: 'candidate-user' })
    mocks.txFindScopedCase.mockResolvedValue({ requesterUserId: 'candidate-user' })
    mocks.claimCase.mockResolvedValue({ count: 1 })
    mocks.createMessage.mockResolvedValue({ id: 'message-1' })
    mocks.updateCase.mockResolvedValue({ id: 'case-1' })
    mocks.createNotification.mockResolvedValue({ id: 'notification-1' })
    mocks.runMutation.mockResolvedValue({ duplicate: false, value: { id: 'message-1' } })
  })

  it('does not let a support member reply to a case assigned to someone else', async () => {
    mocks.findScopedCase.mockResolvedValueOnce(null)
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/support/cases/case-2/reply', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'reply-key' }, body: JSON.stringify({ body: 'Reply body', reason: 'Replying after reviewing the reported issue' }) })

    const response = await POST(request as never, { params: Promise.resolve({ id: 'case-2' }) })

    expect(response.status).toBe(404)
    expect(mocks.runMutation).not.toHaveBeenCalled()
  })

  it('rejects a reply when assignment changes after the scoped preflight', async () => {
    mocks.claimCase.mockResolvedValueOnce({ count: 0 })
    mocks.runMutation.mockImplementation(async ({ mutate }: { mutate: (tx: unknown) => Promise<unknown> }) => ({
      duplicate: false,
      value: await mutate({
        supportCase: { findFirst: mocks.txFindScopedCase, update: mocks.updateCase, updateMany: mocks.claimCase },
        supportCaseMessage: { create: mocks.createMessage },
        notification: { create: mocks.createNotification },
      }),
    }))
    const { POST } = await import('./route')
    const request = new Request('http://localhost/api/admin/v1/support/cases/case-1/reply', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost', host: 'localhost', 'idempotency-key': 'reply-race-key' }, body: JSON.stringify({ body: 'Reply body', reason: 'Replying after reviewing the reported issue' }) })

    const response = await POST(request as never, { params: Promise.resolve({ id: 'case-1' }) })

    expect(response.status).toBe(409)
    expect(mocks.createMessage).not.toHaveBeenCalled()
  })
})
