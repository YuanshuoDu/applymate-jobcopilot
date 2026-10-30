import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn(), activityCreate: vi.fn(),
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))
vi.mock('@/lib/db', () => ({ db: { job: { findUnique: mocks.findUnique, updateMany: mocks.updateMany, update: mocks.update }, activity: { create: mocks.activityCreate } } }))

import { PATCH } from './route'

const context = { params: Promise.resolve({ id: 'job-1' }) }
function request(body: unknown) {
  return new NextRequest('http://localhost/api/jobs/job-1', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

describe('PATCH job description when originally empty', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.findUnique.mockResolvedValue({ id: 'job-1', userId: 'user-1', company: 'Fixture', description: null, status: 'saved', appliedAt: null })
    mocks.updateMany.mockResolvedValue({ count: 1 })
  })

  it.each([null, '', ' \t\n '])('atomically matches the exact original empty value %j', async expected => {
    const response = await PATCH(request({ description: 'New role description', expectedEmptyDescription: expected }), context)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'job-1', userId: 'user-1', description: 'New role description' })
    expect(mocks.updateMany).toHaveBeenCalledOnce()
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1', description: expected }, data: { description: 'New role description' } })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('returns a conflict if another writer changes the description after the ownership read', async () => {
    let storedDescription: string | null = null
    mocks.findUnique.mockImplementation(async () => {
      const previous = storedDescription
      storedDescription = 'A concurrent writer won'
      return { id: 'job-1', userId: 'user-1', description: previous }
    })
    mocks.updateMany.mockImplementation(async ({ where, data }: { where: { description: string | null }; data: { description: string } }) => {
      if (where.description !== storedDescription) return { count: 0 }
      storedDescription = data.description
      return { count: 1 }
    })
    const response = await PATCH(request({ description: 'My description', expectedEmptyDescription: null }), context)
    expect(response.status).toBe(409)
    expect(storedDescription).toBe('A concurrent writer won')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('does not write a job belonging to another user', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'job-1', userId: 'other-user' })
    const response = await PATCH(request({ description: 'New role description', expectedEmptyDescription: null }), context)
    expect(response.status).toBe(404)
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it.each([
    { expectedEmptyDescription: 'existing', description: 'New' },
    { expectedEmptyDescription: 0, description: 'New' },
    { expectedEmptyDescription: null, description: '' },
    { expectedEmptyDescription: null, description: '   ' },
    { expectedEmptyDescription: null, description: null },
    { expectedEmptyDescription: null },
    { expectedEmptyDescription: null, description: 'New', status: 'applied' },
    { expectedEmptyDescription: null, description: 'New', extra: true },
  ])('rejects invalid or mixed conditional updates %#', async body => {
    const response = await PATCH(request(body), context)
    expect(response.status).toBe(400)
    expect(mocks.updateMany).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('preserves the original non-conditional description update', async () => {
    mocks.update.mockResolvedValue({ id: 'job-1', userId: 'user-1', description: 'Existing behavior' })
    const response = await PATCH(request({ description: 'Existing behavior' }), context)
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { description: 'Existing behavior' } })
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })

  it('keeps the existing status transition and activity for ordinary PATCH requests', async () => {
    mocks.update.mockResolvedValue({ id: 'job-1', status: 'applied' })
    const response = await PATCH(request({ status: 'applied', notes: 'Sent manually' }), context)
    expect(response.status).toBe(200)
    expect(mocks.update).toHaveBeenCalledWith({ where: { id: 'job-1' }, data: { status: 'applied', notes: 'Sent manually', appliedAt: expect.any(Date), workflowState: 'submitted' } })
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
    expect(mocks.updateMany).not.toHaveBeenCalled()
  })
})
