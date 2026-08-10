import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ requireAuth: vi.fn(), findUnique: vi.fn() }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { user: { findUnique: mocks.findUnique } } }))

describe('GET /api/me/persona/export', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.requireAuth.mockReset()
    mocks.findUnique.mockReset()
    mocks.requireAuth.mockResolvedValue({ userId: 'user_1' })
    mocks.findUnique.mockResolvedValue({
      id: 'user_1', email: 'candidate@example.com', name: 'Candidate', image: null,
      preferences: { aiSettings: { keys: { openai: 'raw-secret' } } },
      personaFields: [], personaFacts: [], personaEvidenceChunks: [],
      resumes: [], resumeVersions: [], jobs: [{ id: 'job_1', company: 'Acme' }],
      coverLetters: [], activities: [], notifications: [], accounts: [{ provider: 'github', access_token: 'must-not-export' }],
      apiKeys: { adzunaAppId: 'id', adzunaAppKey: 'key', rapidapiKey: 'rapid' },
    })
  })

  it('exports user records without password, OAuth tokens, or discovery secrets', async () => {
    const { GET } = await import('./route')
    const response = await GET(new Request('http://localhost/api/me/persona/export') as never)
    const payload = await response.json()
    const serialized = JSON.stringify(payload)
    expect(response.status).toBe(200)
    expect(payload.profile.jobs).toEqual([{ id: 'job_1', company: 'Acme' }])
    expect(payload.apiKeys).toEqual({ hasAdzuna: true, hasRapidapi: true })
    expect(serialized).not.toContain('raw-secret')
    expect(serialized).not.toContain('must-not-export')
    expect(serialized).not.toContain('adzunaAppKey')
  })
})
