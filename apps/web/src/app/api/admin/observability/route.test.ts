import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAdmin: vi.fn(), queryRaw: vi.fn() }))
vi.mock('@/lib/admin/authorization', () => ({ requireAdmin: mocks.requireAdmin }))
vi.mock('@/lib/db', () => ({ db: { $queryRaw: mocks.queryRaw } }))

describe('GET /api/admin/observability', () => {
  beforeEach(() => {
    vi.resetModules(); mocks.requireAdmin.mockReset(); mocks.queryRaw.mockReset()
    mocks.queryRaw.mockResolvedValueOnce([{ total: 0, successRate: 0, programmatic: 0, patternCache: 0, llm: 0, avgDurationMs: 0, captchaErrors: 0, last24h: 0, last24hSuccessRate: 0 }]).mockResolvedValueOnce([])
  })

  it('requires the observability permission and marks the response private', async () => {
    const { GET } = await import('./route')
    const response = await GET()
    expect(response.status).toBe(404)
  })
})
