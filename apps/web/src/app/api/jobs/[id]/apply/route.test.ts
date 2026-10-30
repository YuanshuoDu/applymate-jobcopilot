import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn(),
  activityCreate: vi.fn(), checkEntitlementLimit: vi.fn(), purge: vi.fn(),
}))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { job: { findFirst: mocks.findFirst, count: mocks.count, update: mocks.update }, activity: { create: mocks.activityCreate } } }))
vi.mock('@/lib/entitlements', () => ({ checkEntitlementLimit: mocks.checkEntitlementLimit }))
vi.mock('@/lib/cover-letter-retention', () => ({ purgeTemporaryGeneratedCoverLetters: mocks.purge }))

import { POST } from './route'

const requestId = '6bce695c-3c62-4b6b-88b2-8b364629fb78'
const context = { params: Promise.resolve({ id: 'job-1' }) }
function request(id: string | null = requestId) {
  return new NextRequest('http://localhost/api/jobs/job-1/apply', {
    method: 'POST', headers: id === null ? {} : { 'X-Manual-Record-Request-Id': id },
  })
}

describe('POST manual application record', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.findFirst.mockResolvedValue({ id: 'job-1', company: 'Example', role: 'Engineer' })
    mocks.count.mockResolvedValue(0)
    mocks.checkEntitlementLimit.mockResolvedValue({ allowed: true, reason: 'available' })
    mocks.update.mockResolvedValue({})
    mocks.activityCreate.mockResolvedValue({})
    mocks.purge.mockResolvedValue(undefined)
  })

  it.each([
    ['limit_reached', 'MANUAL_APPLICATION_LIMIT_REACHED', 'Your monthly application limit has been reached.'],
    ['missing', 'MANUAL_APPLICATION_PLAN_RESTRICTED', 'Your current plan does not include manual applications.'],
    ['expired', 'MANUAL_APPLICATION_PLAN_RESTRICTED', 'Your current plan does not include manual applications.'],
  ])('returns a correlated pre-write rejection for %s', async (reason, code, error) => {
    mocks.checkEntitlementLimit.mockResolvedValue({ allowed: false, reason })
    const response = await POST(request(), context)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error, code, requestId })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it.each([null, '', 'not-a-uuid', '6bce695c-3c62-4b6b-08b2-8b364629fb78'])('keeps a plain rejection for missing or invalid request ID %j', async id => {
    mocks.checkEntitlementLimit.mockResolvedValue({ allowed: false, reason: 'limit_reached' })
    const response = await POST(request(id), context)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Your monthly application limit has been reached.' })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('keeps a plain plan rejection for an older client without a request ID', async () => {
    mocks.checkEntitlementLimit.mockResolvedValue({ allowed: false, reason: 'missing' })
    const response = await POST(request(null), context)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Your current plan does not include manual applications.' })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('does not label an unknown rejection as a confirmed pre-write plan or limit refusal', async () => {
    mocks.checkEntitlementLimit.mockResolvedValue({ allowed: false, reason: 'unexpected' })
    const response = await POST(request(), context)
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'Your current plan does not include manual applications.' })
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('keeps the successful update and manual provenance', async () => {
    const response = await POST(request(), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ applied: true })
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'applied', workflowState: 'submitted', appliedAt: expect.any(Date) } })
    expect(mocks.activityCreate).toHaveBeenCalledWith({ data: { userId: 'user-1', jobId: 'job-1', type: 'applied', text: 'You applied manually Example · Engineer', color: '#059669' } })
    expect(mocks.purge).toHaveBeenCalledWith('user-1', 'job-1')
  })

  it('returns the original authentication failure without querying or writing', async () => {
    mocks.requireAuth.mockResolvedValue(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    const response = await POST(request(), context)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Unauthorized' })
    expect(mocks.findFirst).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('does not disguise an error after the job write as a pre-write rejection', async () => {
    mocks.activityCreate.mockRejectedValue(new Error('activity storage unavailable'))
    await expect(POST(request(), context)).rejects.toThrow('activity storage unavailable')
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
    expect(mocks.purge).not.toHaveBeenCalled()
  })
})
