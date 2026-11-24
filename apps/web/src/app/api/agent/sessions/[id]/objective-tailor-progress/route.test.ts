import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  userId: null as string | null,
  requireAuth: vi.fn(),
  runWithTenantContext: vi.fn(async (userId: string, callback: () => Promise<unknown>) => {
    mocks.userId = userId
    try { return await callback() } finally { mocks.userId = null }
  }),
  readProgress: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({ requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }) }))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.runWithTenantContext }))
vi.mock('@/lib/agent/session/objective-tailor-progress', () => ({ readObjectiveTailorProgress: mocks.readProgress }))

const context = { params: Promise.resolve({ id: 'session_1' }) }
const selectors = '?graphItemId=graph_1&turnId=turn_1&rootTaskId=root_1&revision=4'
function request(query = selectors) { return new Request(`http://localhost/api/agent/sessions/session_1/objective-tailor-progress${query}`) }

describe('objective-tailor-progress route', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.userId = null
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'user_1' })
    mocks.runWithTenantContext.mockClear()
    mocks.readProgress.mockReset().mockResolvedValue({ schemaVersion: 'agent-harness.v2.objective-tailor-progress.v1' })
  })

  it('requires each exact current identity selector once and reads inside tenant context', async () => {
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await response.json()).toEqual({ progress: { schemaVersion: 'agent-harness.v2.objective-tailor-progress.v1' } })
    expect(mocks.runWithTenantContext).toHaveBeenCalledWith('user_1', expect.any(Function))
    expect(mocks.readProgress).toHaveBeenCalledWith({}, { userId: 'user_1', sessionId: 'session_1', graphItemId: 'graph_1',
      turnId: 'turn_1', rootTaskId: 'root_1', revision: 4 })
  })

  it.each([
    ['missing selector', '?graphItemId=graph_1&turnId=turn_1&rootTaskId=root_1'],
    ['duplicate selector', `${selectors}&revision=5`],
    ['unknown selector', `${selectors}&taskId=child_1`],
    ['noncanonical revision', selectors.replace('revision=4', 'revision=04')],
  ])('rejects %s before the database projection', async (_label, query) => {
    const { GET } = await import('./route')
    const response = await GET(request(query) as never, context)
    expect(response.status).toBe(400)
    expect(mocks.readProgress).not.toHaveBeenCalled()
  })

  it('returns auth failures without entering tenant or read-model work', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { GET } = await import('./route')
    const response = await GET(request() as never, context)
    expect(response.status).toBe(401)
    expect(mocks.runWithTenantContext).not.toHaveBeenCalled()
    expect(mocks.readProgress).not.toHaveBeenCalled()
  })
})
