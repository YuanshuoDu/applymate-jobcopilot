import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), findFirst: vi.fn(), count: vi.fn(), update: vi.fn(), transaction: vi.fn(),
  activityCreate: vi.fn(), checkEntitlementLimit: vi.fn(), purge: vi.fn(),
}))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { job: { findFirst: mocks.findFirst, count: mocks.count }, $transaction: mocks.transaction } }))
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
    mocks.update.mockResolvedValue({ count: 1 })
    mocks.activityCreate.mockResolvedValue({})
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn({ job: { updateMany: mocks.update }, activity: { create: mocks.activityCreate } }))
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
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1', status: 'saved', workflowState: { in: ['draft', 'ready_to_apply'] }, appliedAt: null }, data: { status: 'applied', workflowState: 'submitted', appliedAt: expect.any(Date) } })
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

  it('propagates a provenance failure from the transaction rather than reporting success', async () => {
    mocks.activityCreate.mockRejectedValue(new Error('activity storage unavailable'))
    await expect(POST(request(), context)).rejects.toThrow('activity storage unavailable')
    expect(mocks.update).toHaveBeenCalledOnce()
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it('rejects a competing request without a second activity or successful response', async () => {
    let bothRead = 0
    let release: () => void = () => {}
    const bothAtRead = new Promise<void>(resolve => { release = resolve })
    mocks.findFirst.mockImplementation(async () => {
      bothRead += 1
      if (bothRead === 2) release()
      await bothAtRead
      return { id: 'job-1', company: 'Example', role: 'Engineer' }
    })
    let appliedAt: Date | null = null
    mocks.update.mockImplementation(async (args: { data: { appliedAt: Date } }) => {
      if (appliedAt !== null) return { count: 0 }
      appliedAt = args.data.appliedAt
      return { count: 1 }
    })
    const responses = await Promise.all([POST(request(), context), POST(request('1c38be92-f7a4-4f62-9455-23de63576fb5'), context)])
    expect(responses.map(response => response.status).sort()).toEqual([200, 409])
    const loser = responses.find(response => response.status === 409)
    expect(await loser?.json()).toEqual({ error: 'Application state changed. Refresh the application before recording.' })
    expect(appliedAt).toBeInstanceOf(Date)
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
    expect(mocks.purge).toHaveBeenCalledOnce()
  })

  it('does not write provenance if the conditional update loses', async () => {
    mocks.update.mockResolvedValue({ count: 0 })
    const response = await POST(request(null), context)
    expect(response.status).toBe(409)
    expect(mocks.activityCreate).not.toHaveBeenCalled()
    expect(mocks.purge).not.toHaveBeenCalled()
  })

  it('preserves the successful response for the Agent caller without a request ID', async () => {
    const response = await POST(request(null), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ applied: true })
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })

  it.each([
    ['saved', 'draft', null, 200], ['saved', 'ready_to_apply', null, 200],
    ['saved', 'queued', null, 409], ['saved', 'submitting', null, 409],
    ['saved', 'submitted', null, 409], ['saved', 'draft', new Date('2024-01-01'), 409],
    ['applied', 'submitted', new Date('2024-01-01'), 409], ['interview', 'submitted', null, 409],
    ['offer', 'submitted', null, 409], ['rejected', 'submitted', null, 409],
  ])('guards actual state %s / %s / %s for the legacy caller', async (status, workflowState, appliedAt, expected) => {
    const state = { status, workflowState, appliedAt }
    mocks.update.mockImplementation(async ({ where, data }: {
      where: { status: string; workflowState: { in: string[] }; appliedAt: null }
      data: { status: string; workflowState: string; appliedAt: Date }
    }) => {
      if (state.status !== where.status || !where.workflowState.in.includes(state.workflowState) || state.appliedAt !== where.appliedAt) return { count: 0 }
      Object.assign(state, data)
      return { count: 1 }
    })
    const before = { ...state }
    const response = await POST(request(null), context)
    expect(response.status).toBe(expected)
    expect(mocks.activityCreate).toHaveBeenCalledTimes(expected === 200 ? 1 : 0)
    if (expected === 409) expect(state).toEqual(before)
  })
})
