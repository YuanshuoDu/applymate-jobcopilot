import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  recommendationFindFirst: vi.fn(),
  recommendationUpdate: vi.fn(),
  jobCreate: vi.fn(),
  activityCreate: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({
  db: {
    gmailRecommendation: { findFirst: mocks.recommendationFindFirst, update: mocks.recommendationUpdate },
    job: { create: mocks.jobCreate },
    activity: { create: mocks.activityCreate },
  },
}))

const params = { params: Promise.resolve({ id: 'recommendation-1' }) }

function patchRequest(action: string) {
  return new Request('http://localhost/api/gmail/recommendations/recommendation-1', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
}

describe('PATCH /api/gmail/recommendations/[id]', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
  })

  it('returns an auth error before looking up a recommendation', async () => {
    mocks.requireAuth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const { PATCH } = await import('./route')

    const response = await PATCH(patchRequest('save') as never, params)

    expect(response.status).toBe(401)
    expect(mocks.recommendationFindFirst).not.toHaveBeenCalled()
  })

  it('saves a reviewed recommendation into My Jobs and records the decision', async () => {
    mocks.recommendationFindFirst.mockResolvedValue({
      id: 'recommendation-1',
      status: 'pending',
      savedJobId: null,
      company: 'Acme',
      role: 'Senior Engineer',
      location: 'Berlin',
      salary: '€80k',
      url: 'https://jobs.acme.example/1',
      description: 'Build reliable products.',
    })
    mocks.jobCreate.mockResolvedValue({ id: 'job-1', company: 'Acme', role: 'Senior Engineer' })
    mocks.recommendationUpdate.mockResolvedValue({ id: 'recommendation-1', status: 'saved', savedJobId: 'job-1' })
    mocks.activityCreate.mockResolvedValue({ id: 'activity-1' })
    const { PATCH } = await import('./route')

    const response = await PATCH(patchRequest('save') as never, params)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      job: { id: 'job-1', company: 'Acme', role: 'Senior Engineer' },
      recommendation: { id: 'recommendation-1', status: 'saved', savedJobId: 'job-1' },
    })
    expect(mocks.jobCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', source: 'gmail', status: 'saved', company: 'Acme', role: 'Senior Engineer' }),
    })
    expect(mocks.recommendationUpdate).toHaveBeenCalledWith({
      where: { id: 'recommendation-1' },
      data: { status: 'saved', savedJobId: 'job-1' },
    })
    expect(mocks.activityCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: 'user-1', jobId: 'job-1' }) }))
  })
})
