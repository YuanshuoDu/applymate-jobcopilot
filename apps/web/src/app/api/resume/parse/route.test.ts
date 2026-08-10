import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
  modelChat: vi.fn(),
  parseAiJson: vi.fn(),
  loadUserAiConfig: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
}))
vi.mock('@/lib/entitlements', () => ({ isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }))
vi.mock('@/lib/rate-limit', () => ({ checkRateLimit: mocks.checkRateLimit }))
vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  parseAiJson: mocks.parseAiJson,
  loadUserAiConfig: mocks.loadUserAiConfig,
  withMiniMaxThinking: (value: unknown) => value,
}))

describe('POST /api/resume/parse plan access', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset().mockResolvedValue({ userId: 'user-1' })
    mocks.isFeatureAllowed.mockReset().mockResolvedValue(false)
    mocks.resolveAiAccess.mockReset().mockResolvedValue('disabled')
    mocks.checkRateLimit.mockReset().mockReturnValue({ ok: true })
  })

  it('rejects resume parsing when AI credits are disabled', async () => {
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/resume/parse', { method: 'POST' }) as never)

    expect(response.status).toBe(403)
    expect(mocks.checkRateLimit).not.toHaveBeenCalled()
  })

  it('rejects resume parsing when monthly credits are exhausted', async () => {
    mocks.isFeatureAllowed.mockResolvedValueOnce(true)
    mocks.resolveAiAccess.mockResolvedValueOnce('exhausted')
    const { POST } = await import('./route')
    const response = await POST(new Request('http://localhost/api/resume/parse', { method: 'POST' }) as never)

    expect(response.status).toBe(429)
  })
})
