import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), read: vi.fn(), tenant: vi.fn() }))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
}))
vi.mock('@/lib/db', () => ({ db: {} }))
vi.mock('@/lib/db/tenant-store', () => ({ runWithTenantContext: mocks.tenant }))
vi.mock('@/lib/agent/session/selected-job-batch-workbench-read-model', () => ({
  readSelectedJobBatchWorkbenchModel: mocks.read,
}))

const params = { params: Promise.resolve({ id: 'session_1', turnId: 'batch_turn_1' }) }
const request = new Request('http://localhost/api/agent/sessions/session_1/selected-job-batches/batch_turn_1')

describe('selected Job batch Workbench route', () => {
  beforeEach(() => {
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'user_1' })
    mocks.read.mockReset().mockResolvedValue({ sessionId: 'session_1', turnId: 'batch_turn_1', status: 'pending', jobs: [] })
    mocks.tenant.mockReset().mockImplementation(async (_userId: string, run: () => Promise<Response>) => run())
  })

  it('authenticates first and returns private no-store owner-scoped evidence', async () => {
    const { GET } = await import('./route')
    const response = await GET(request as never, params)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    await expect(response.json()).resolves.toMatchObject({ turnId: 'batch_turn_1', status: 'pending' })
    expect(mocks.tenant).toHaveBeenCalledWith('user_1', expect.any(Function))
    expect(mocks.read).toHaveBeenCalledWith({}, { userId: 'user_1', sessionId: 'session_1', turnId: 'batch_turn_1' })
  })

  it('does not query the model for unauthorized or unavailable identities', async () => {
    const { GET } = await import('./route')
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const unauthorized = await GET(request as never, params)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(mocks.read).not.toHaveBeenCalled()

    mocks.read.mockResolvedValueOnce(null)
    const missing = await GET(request as never, params)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    await expect(missing.json()).resolves.toMatchObject({ error: { code: 'selected_job_batch_not_found' } })
  })

  it('returns a generic private error without exposing database failures', async () => {
    const { GET } = await import('./route')
    mocks.read.mockRejectedValueOnce(new Error('PRIVATE_DATABASE_DETAIL'))
    const response = await GET(request as never, params)
    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    await expect(response.text()).resolves.not.toContain('PRIVATE_DATABASE_DETAIL')
  })
})
