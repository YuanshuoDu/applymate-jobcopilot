import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), tenant: vi.fn(), transaction: vi.fn(), read: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown) => Response.json(value),
}))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.tenant }))
vi.mock('@/lib/agent/session/objective-source-tool-receipts', () => ({ readObjectiveSourceToolReceipts: mocks.read }))

const sessionId = 'session-1', itemId = 'final-1', sourceKey = `src_${'a'.repeat(43)}`
const params = { params: Promise.resolve({ id: sessionId, itemId, sourceKey }) }
const evidence = {
  schemaVersion: 'agent-harness.v2.objective-tool-receipt-evidence.v1', graphRevision: 7, sourceKey, role: 'scout',
  receipts: [{ ordinal: 1, receiptKey: `rcp_${'b'.repeat(43)}`, toolName: 'jobs.search', delivery: 'fresh' }],
}
const request = (url = `http://localhost/api/agent/sessions/${sessionId}/final-items/${itemId}/task-graph-sources/${sourceKey}/tool-receipts?graphRevision=7`) => new Request(url)

describe('Objective source tool receipt route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.tenant.mockImplementation(async (_userId: string, run: () => Promise<unknown>) => run())
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run({ tx: true }))
    mocks.read.mockResolvedValue(evidence)
  })

  it('returns only the closed evidence inside an owner RepeatableRead transaction', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never, params)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(await response.json()).toEqual({ toolReceiptEvidence: evidence })
    expect(mocks.tenant).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: expect.anything() }))
    expect(mocks.read).toHaveBeenCalledWith({ tx: true }, { userId: 'user-1', sessionId, finalItemId: itemId, sourceKey, graphRevision: 7 })
  })

  it('conceals malformed, stale, unsupported, and missing selections', async () => {
    const { GET } = await import('./route')
    const missing = await GET(request(`http://localhost/tool-receipts`) as never, params)
    const extra = await GET(request(`${request().url}&other=1`) as never, params)
    const stale = await GET(request(request().url.replace('graphRevision=7', 'graphRevision=1000001')) as never, params)
    const badSource = await GET(request() as never, { params: Promise.resolve({ id: sessionId, itemId, sourceKey: 'src_foreign' }) })
    mocks.read.mockResolvedValueOnce(undefined)
    const unavailable = await GET(request() as never, params)
    expect([missing, extra, stale, badSource, unavailable].every(response => response.status === 404)).toBe(true)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('does not query protected data when authentication fails', async () => {
    const { GET } = await import('./route')
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await GET(request() as never, params)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(mocks.tenant).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
