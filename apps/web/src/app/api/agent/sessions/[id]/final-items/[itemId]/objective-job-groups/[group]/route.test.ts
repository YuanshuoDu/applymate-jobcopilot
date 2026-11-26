import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), read: vi.fn(), tenant: vi.fn(), transaction: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({ requireAuth: mocks.requireAuth, isErrorResponse: (value: unknown) => value instanceof Response, ok: (value: unknown) => Response.json(value) }))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.tenant }))
vi.mock('@/lib/agent/session/objective-job-evidence', () => ({ readObjectiveJobEvidence: mocks.read }))

const sessionId = 'session-1', itemId = 'final-1'
const evidence = { schemaVersion: 'agent-harness.v2.objective-job-evidence.v1', graphRevision: 7, group: 'discoveredJobs', coverage: 'partial', count: 1,
  jobs: [{ ordinal: 1, role: 'Engineer', company: 'Acme', location: null, postingUrl: 'https://jobs.example/1', sourceKeys: [`src_${'a'.repeat(43)}`] }] }
const context = { params: Promise.resolve({ id: sessionId, itemId, group: 'discoveredJobs' }) }
const request = (url = `http://localhost/api/agent/sessions/${sessionId}/final-items/${itemId}/objective-job-groups/discoveredJobs?graphRevision=7`) => new Request(url)

describe('Objective saved Job evidence route', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.tenant.mockImplementation(async (_userId: string, run: () => Promise<unknown>) => run())
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run({}))
    mocks.read.mockResolvedValue(evidence)
  })

  it('returns the bounded evidence only inside the authenticated repeatable tenant transaction', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(await response.json()).toEqual({ jobEvidence: evidence })
    expect(mocks.tenant).toHaveBeenCalledWith('user-1', expect.any(Function))
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: expect.anything() }))
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), { userId: 'user-1', sessionId, finalItemId: itemId, graphRevision: 7, group: 'discoveredJobs' })
  })

  it('conceals missing, malformed, stale, and unsupported selections', async () => {
    const { GET } = await import('./route')
    const missing = await GET(request('http://localhost/objective-job-groups/discoveredJobs') as never, context)
    const extra = await GET(request(`${request().url}&other=1`) as never, context)
    const badRevision = await GET(request(request().url.replace('graphRevision=7', 'graphRevision=0')) as never, context)
    const badGroup = await GET(request() as never, { params: Promise.resolve({ id: sessionId, itemId, group: 'prepare' }) })
    mocks.read.mockResolvedValueOnce(undefined)
    const stale = await GET(request() as never, context)
    expect([missing, extra, badRevision, badGroup, stale].every(response => response.status === 404)).toBe(true)
    expect(mocks.read).toHaveBeenCalledTimes(1)
  })

  it('does not query protected data when authentication fails', async () => {
    const { GET } = await import('./route')
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await GET(request() as never, context)
    expect(response.status).toBe(401)
    expect(mocks.tenant).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })
})
