import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  jwtVerify: vi.fn(),
  safeAuth: vi.fn(),
  userFindUnique: vi.fn(),
  checkRateLimit: vi.fn(),
  loadUserAiConfig: vi.fn(),
  resolveConfig: vi.fn(),
  isFeatureAllowed: vi.fn(),
  isAiBudgetAvailable: vi.fn(),
  resolveAiAccess: vi.fn(),
}))

vi.mock('next/headers', () => ({ headers: mocks.headers }))
vi.mock('jose', () => ({ jwtVerify: mocks.jwtVerify }))
vi.mock('@/lib/safe-auth', () => ({ safeAuth: mocks.safeAuth }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }))
vi.mock('@/lib/model-router', () => ({ loadUserAiConfig: mocks.loadUserAiConfig, resolveConfig: mocks.resolveConfig, resolveFeatureConfig: vi.fn() }))
vi.mock('@/lib/entitlements', () => ({ isFeatureAllowed: mocks.isFeatureAllowed, isAiBudgetAvailable: mocks.isAiBudgetAvailable, resolveAiAccess: mocks.resolveAiAccess }))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.userFindUnique } } }))

describe('requireAuth', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.headers.mockReset()
    mocks.jwtVerify.mockReset()
    mocks.safeAuth.mockReset()
    mocks.userFindUnique.mockReset()
    mocks.checkRateLimit.mockReset().mockReturnValue({ ok: true })
    mocks.loadUserAiConfig.mockReset().mockResolvedValue({ provider: 'minimax', model: 'MiniMax-M3', resolvedKey: 'platform-key' })
    mocks.resolveConfig.mockReset().mockReturnValue({ provider: 'minimax', model: 'MiniMax-M3', resolvedKey: 'platform-key' })
    mocks.isFeatureAllowed.mockReset().mockResolvedValue(true)
    mocks.isAiBudgetAvailable.mockReset().mockResolvedValue(true)
    mocks.resolveAiAccess.mockReset().mockResolvedValue('allowed')
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'active' })
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'extension-user' } })
    mocks.safeAuth.mockResolvedValue(null)
  })

  it('accepts a verified Bearer token passed explicitly by a route', async () => {
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', {
      headers: { Authorization: 'Bearer extension-token' },
    }) as never)

    expect(result).toEqual({ userId: 'extension-user' })
  })

  it('reads the real request header for GET routes without a request parameter', async () => {
    mocks.headers.mockResolvedValue(new Headers({ Authorization: 'Bearer extension-token' }))
    const { requireAuth } = await import('./api-helpers')

    await expect(requireAuth()).resolves.toEqual({ userId: 'extension-user' })
  })

  it('does not trust a client-provided x-user-id header', async () => {
    mocks.headers.mockResolvedValue(new Headers({ 'x-user-id': 'forged-user' }))
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth()

    expect(result).toBeInstanceOf(Response)
    await expect((result as Response).json()).resolves.toEqual({ error: 'Unauthorized' })
  })

  it('rejects a suspended user even when the session or extension token is valid', async () => {
    mocks.userFindUnique.mockResolvedValue({ accountStatus: 'suspended' })
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/jobs', { headers: { Authorization: 'Bearer extension-token' } }) as never)
    expect(result).toBeInstanceOf(Response)
    await expect((result as Response).json()).resolves.toEqual({ error: 'Account suspended' })
    expect((result as Response).status).toBe(403)
  })

  it('blocks an AI route when the current plan disables its feature', async () => {
    mocks.isFeatureAllowed.mockResolvedValue(false)
    const { prepareAiRoute } = await import('./api-helpers')
    const result = await prepareAiRoute(new Request('http://localhost/api/ai/score', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'autoApply')
    expect(result.error).toBeInstanceOf(Response)
    expect((result.error as Response).status).toBe(403)
  })

  it('blocks cover-letter generation when the cover-letter entitlement is disabled', async () => {
    mocks.isFeatureAllowed.mockResolvedValue(false)
    const { prepareAiRoute } = await import('./api-helpers')
    const result = await prepareAiRoute(new Request('http://localhost/api/ai/cover-letter', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'coverLetter')
    expect(result.error).toBeInstanceOf(Response)
    expect((result.error as Response).status).toBe(403)
    expect(mocks.isFeatureAllowed).toHaveBeenCalledWith('extension-user', 'cover_letter')
  })

  it('supports a route-specific entitlement for tailored resumes', async () => {
    mocks.isFeatureAllowed.mockResolvedValue(false)
    const { prepareAiRoute } = await import('./api-helpers')
    const result = await prepareAiRoute(new Request('http://localhost/api/jobs/job-1/tailor-resume', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'suggest', 'tailored_resume')
    expect(result.error).toBeInstanceOf(Response)
    expect((result.error as Response).status).toBe(403)
    expect(mocks.isFeatureAllowed).toHaveBeenCalledWith('extension-user', 'tailored_resume')
  })

  it('requires every entitlement for a compound AI route', async () => {
    mocks.isFeatureAllowed.mockResolvedValue(true)
    const { prepareAiRoute } = await import('./api-helpers')
    await expect(prepareAiRoute(new Request('http://localhost/api/gmail/ai-reply', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'coverLetter', ['cover_letter', 'gmail_tracking'])).resolves.toMatchObject({ userId: 'extension-user' })
    expect(mocks.isFeatureAllowed).toHaveBeenNthCalledWith(1, 'extension-user', 'cover_letter')
    expect(mocks.isFeatureAllowed).toHaveBeenNthCalledWith(2, 'extension-user', 'gmail_tracking')
  })

  it('loads the platform-routed configuration for an allowed AI route', async () => {
    const { prepareAiRoute } = await import('./api-helpers')
    await expect(prepareAiRoute(new Request('http://localhost/api/ai/score', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'jobScoring')).resolves.toMatchObject({ userId: 'extension-user', cfg: { model: 'MiniMax-M3' } })
    expect(mocks.loadUserAiConfig).toHaveBeenCalledWith('extension-user', 'jobScoring')
  })

  it('blocks an AI route when the monthly credit limit is exhausted', async () => {
    mocks.resolveAiAccess.mockResolvedValue('exhausted')
    const { prepareAiRoute } = await import('./api-helpers')
    const result = await prepareAiRoute(new Request('http://localhost/api/ai/score', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'jobScoring')

    expect(result.error).toBeInstanceOf(Response)
    expect((result.error as Response).status).toBe(429)
  })

  it('blocks a protected route when its plan feature is disabled', async () => {
    mocks.isFeatureAllowed.mockResolvedValue(false)
    const { requireAuth } = await import('./api-helpers')
    const result = await requireAuth(new Request('http://localhost/api/search/unified', { headers: { Authorization: 'Bearer extension-token' } }) as never, 'job_discovery')

    expect(result).toBeInstanceOf(Response)
    expect((result as Response).status).toBe(403)
  })
})
