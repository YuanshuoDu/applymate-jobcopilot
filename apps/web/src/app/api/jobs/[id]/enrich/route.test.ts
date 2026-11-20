import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  findFirst: vi.fn(),
  transaction: vi.fn(),
  getDiscoveryApiAccess: vi.fn(),
  getRuntimeAtsPolicy: vi.fn(),
  enrichJob: vi.fn(),
  fetchExternalText: vi.fn(),
  trackedJobApiFetch: vi.fn(),
  reportJobApiJobs: vi.fn(),
  writeEnrichmentSourceMaterial: vi.fn(),
  events: [] as string[],
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({
  db: { job: { findFirst: mocks.findFirst }, $transaction: mocks.transaction },
}))
vi.mock('@/lib/discovery-api-keys', () => ({ getDiscoveryApiAccess: mocks.getDiscoveryApiAccess }))
vi.mock('@/lib/runtime-ats-policy', () => ({ getRuntimeAtsPolicy: mocks.getRuntimeAtsPolicy }))
vi.mock('@/lib/agent/enrich', () => ({ enrichJob: mocks.enrichJob }))
vi.mock('@/lib/safe-outbound-url', () => ({ fetchExternalText: mocks.fetchExternalText }))
vi.mock('@/lib/api-usage/job-api-usage', () => ({
  reportJobApiJobs: mocks.reportJobApiJobs,
  trackedJobApiFetch: mocks.trackedJobApiFetch,
}))
vi.mock('@/lib/agent/enrichment-source-write', () => ({
  writeEnrichmentSourceMaterial: mocks.writeEnrichmentSourceMaterial,
}))

const makeJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'job-1', userId: 'user-1', company: 'Acme', role: 'Engineer', location: 'Dublin',
  url: 'https://boards.greenhouse.io/acme/jobs/123', description: null, salary: null, logo: null,
  analysisNote: null, ...overrides,
})

describe('POST /api/jobs/:id/enrich', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    mocks.events.length = 0
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.findFirst.mockResolvedValue(makeJob())
    mocks.getDiscoveryApiAccess.mockResolvedValue({ rapidapiKey: '', rapidapiSource: 'none' })
    mocks.getRuntimeAtsPolicy.mockResolvedValue({ allowed: true, rps: 1 })
    mocks.fetchExternalText.mockImplementation(async () => { mocks.events.push('network'); return '<html />' })
    mocks.enrichJob.mockImplementation(async () => { mocks.events.push('parse'); return { description: 'Fresh description', method: 't1' } })
    mocks.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => {
      mocks.events.push('transaction')
      return callback({})
    })
    mocks.writeEnrichmentSourceMaterial.mockImplementation(async () => {
      mocks.events.push('write')
      return makeJob({ description: 'Fresh description' })
    })
    vi.stubEnv('MANTIKS_API_KEY', '')
  })

  afterEach(() => vi.unstubAllEnvs())

  it('scopes the initial Job lookup to the authenticated user and fetches before opening the transaction', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/jobs/job-1/enrich', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.events).toEqual(['network', 'parse', 'transaction', 'write'])
    expect(mocks.writeEnrichmentSourceMaterial).toHaveBeenCalledWith({}, makeJob(), expect.objectContaining({
      description: 'Fresh description',
    }))
  })

  it('does not fetch or write when the authenticated user does not own the Job', async () => {
    mocks.findFirst.mockResolvedValue(null)
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/jobs/job-1/enrich', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(response.status).toBe(404)
    expect(mocks.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.fetchExternalText).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
  })

  it('does not fetch a paused ATS job page before enrichment', async () => {
    mocks.getRuntimeAtsPolicy.mockResolvedValue({ allowed: false, rps: 1 })
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/jobs/job-1/enrich', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(response.status).toBe(200)
    expect(mocks.getRuntimeAtsPolicy).toHaveBeenCalledWith('greenhouse', 'user-1')
    expect(mocks.fetchExternalText).not.toHaveBeenCalled()
    expect(mocks.enrichJob).not.toHaveBeenCalled()
  })

  it('returns the existing 404 response if ownership is lost before the fenced read', async () => {
    mocks.writeEnrichmentSourceMaterial.mockResolvedValue(null)
    const { POST } = await import('./route')

    const response = await POST(new Request('http://localhost/api/jobs/job-1/enrich', { method: 'POST' }) as never, {
      params: Promise.resolve({ id: 'job-1' }),
    })

    expect(response.status).toBe(404)
    expect(mocks.events).toEqual(['network', 'parse', 'transaction'])
  })
})
