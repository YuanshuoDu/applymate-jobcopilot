import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findUnique: vi.fn(),
  update: vi.fn(),
  getDiscoveryApiAccess: vi.fn(),
  getRuntimeAtsPolicy: vi.fn(),
  enrichJob: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { job: { findUnique: mocks.findUnique, update: mocks.update } } }))
vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiAccess: mocks.getDiscoveryApiAccess }))
vi.mock('@/lib/runtime-ats-policy', () => ({ getRuntimeAtsPolicy: mocks.getRuntimeAtsPolicy }))
vi.mock('@/lib/agent/enrich', () => ({ enrichJob: mocks.enrichJob }))

describe('POST /api/jobs/:id/enrich', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.findUnique.mockResolvedValue({
      id: 'job-1', userId: 'user-1', company: 'Acme', role: 'Engineer', location: 'Dublin',
      url: 'https://boards.greenhouse.io/acme/jobs/123', description: null, salary: null, logo: null,
    })
    mocks.getDiscoveryApiAccess.mockResolvedValue({ rapidapiKey: '', rapidapiSource: 'none' })
    mocks.getRuntimeAtsPolicy.mockResolvedValue({ allowed: false, rps: 1 })
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => vi.unstubAllGlobals())

  it('does not fetch a paused ATS job page before enrichment', async () => {
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/jobs/job-1/enrich', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.getRuntimeAtsPolicy).toHaveBeenCalledWith('greenhouse', 'user-1')
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mocks.enrichJob).not.toHaveBeenCalled()
  })
})
