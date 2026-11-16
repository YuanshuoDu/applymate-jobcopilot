import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  outsideFindUnique: vi.fn(),
  activityCreate: vi.fn(),
  events: [] as string[],
  tx: {
    job: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    job: { findUnique: mocks.outsideFindUnique },
    activity: { create: mocks.activityCreate },
  },
}))

vi.mock('@/lib/agent/source-material-fence', () => ({
  acquireSourceMaterialFence: mocks.sourceFence,
}))

vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

import { DELETE, GET, PATCH } from './route'

const context = { params: Promise.resolve({ id: 'job-1' }) }

function request(method: string, body?: string) {
  return new NextRequest('http://localhost/api/jobs/job-1', {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
  })
}

describe('job detail mutation source fence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.events.length = 0
    mocks.requireAuth.mockResolvedValue({ userId: 'user-1' })
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      mocks.events.push('transaction')
      try {
        const result = await run(mocks.tx)
        mocks.events.push('committed')
        return result
      } catch (error) {
        mocks.events.push('rolled-back')
        throw error
      }
    })
    mocks.sourceFence.mockImplementation(async () => { mocks.events.push('fence') })
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return { id: 'job-1', userId: 'user-1', company: 'Fixture', description: null, status: 'saved', appliedAt: null }
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 1 }
    })
    mocks.tx.job.update.mockImplementation(async () => {
      mocks.events.push('job.update')
      return { id: 'job-1', userId: 'user-1', status: 'saved' }
    })
    mocks.tx.job.delete.mockImplementation(async () => { mocks.events.push('job.delete') })
    mocks.activityCreate.mockImplementation(async () => { mocks.events.push('activity.create') })
  })

  it.each([null, '', ' \t\n '])('fences before owner read and exact-empty conditional update %j', async expected => {
    const response = await PATCH(request('PATCH', JSON.stringify({
      description: 'New role description', expectedEmptyDescription: expected,
    })), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'job-1', userId: 'user-1', description: 'New role description' })
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.updateMany', 'committed'])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1', description: expected },
      data: { description: 'New role description' },
    })
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('returns the existing conditional-update conflict without a second write', async () => {
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 0 }
    })

    const response = await PATCH(request('PATCH', JSON.stringify({
      description: 'New role description', expectedEmptyDescription: null,
    })), context)

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: 'The job description changed. Refresh and review it before trying again.',
    })
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.updateMany', 'committed'])
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
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
  ])('retains conditional-update validation %#', async body => {
    const response = await PATCH(request('PATCH', JSON.stringify(body)), context)

    expect(response.status).toBe(400)
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'committed'])
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
  })

  it('keeps the owned-job 404 ahead of body parsing and validation', async () => {
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return null
    })

    const response = await PATCH(request('PATCH', '{'), context)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'committed'])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
  })

  it('keeps ordinary status updates and writes Activity after the Job transaction commits', async () => {
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return { id: 'job-1', userId: 'user-1', company: 'Fixture', status: 'saved', appliedAt: null }
    })
    mocks.tx.job.update.mockImplementation(async () => {
      mocks.events.push('job.update')
      return { id: 'job-1', status: 'applied', appliedAt: null, workflowState: 'draft' }
    })

    const response = await PATCH(request('PATCH', JSON.stringify({ status: 'applied', notes: 'Sent manually' })), context)

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'applied', appliedAt: null, workflowState: 'draft' })
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.tx.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1' },
      data: { status: 'applied', notes: 'Sent manually' },
    })
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'job.update', 'committed', 'activity.create',
    ])
    expect(mocks.activityCreate).toHaveBeenCalledWith({
      data: {
        userId: 'user-1', jobId: 'job-1', type: 'status_changed',
        text: 'Fixture moved to Applied', color: '#854F0B',
      },
    })
  })

  it('retains workflow mapping for other valid status transitions', async () => {
    mocks.tx.job.update.mockResolvedValue({ id: 'job-1', status: 'rejected', workflowState: 'submitted' })

    const response = await PATCH(request('PATCH', JSON.stringify({ status: 'rejected' })), context)

    expect(response.status).toBe(200)
    expect(mocks.tx.job.update).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1' },
      data: { status: 'rejected', workflowState: 'submitted' },
    })
    expect(mocks.activityCreate).toHaveBeenCalledOnce()
  })

  it('rejects an invalid status without a Job or Activity write', async () => {
    const response = await PATCH(request('PATCH', JSON.stringify({ status: 'unknown' })), context)

    expect(response.status).toBe(400)
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'committed'])
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('propagates fence and Job write failures so the transaction rolls back', async () => {
    mocks.sourceFence.mockRejectedValueOnce(new Error('fence failed'))
    await expect(PATCH(request('PATCH', JSON.stringify({ status: 'interview' })), context)).rejects.toThrow('fence failed')
    expect(mocks.events).toEqual(['transaction', 'rolled-back'])
    expect(mocks.tx.job.findFirst).not.toHaveBeenCalled()

    mocks.events.length = 0
    mocks.sourceFence.mockImplementation(async () => { mocks.events.push('fence') })
    mocks.tx.job.update.mockRejectedValueOnce(new Error('write failed'))
    await expect(PATCH(request('PATCH', JSON.stringify({ status: 'interview' })), context)).rejects.toThrow('write failed')
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'rolled-back'])
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('fences before the owner read and tenant-scoped delete', async () => {
    const response = await DELETE(request('DELETE'), context)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ deleted: true })
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.delete', 'committed'])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.tx.job.delete).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
  })

  it('does not disclose or delete a job owned by another tenant', async () => {
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return null
    })

    const response = await DELETE(request('DELETE'), context)

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'Not found' })
    expect(mocks.tx.job.delete).not.toHaveBeenCalled()
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'committed'])
  })

  it('propagates delete failures and does not turn them into a successful response', async () => {
    mocks.tx.job.delete.mockRejectedValueOnce(new Error('delete failed'))

    await expect(DELETE(request('DELETE'), context)).rejects.toThrow('delete failed')

    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'rolled-back'])
  })

  it('authenticates before starting a mutation transaction', async () => {
    mocks.requireAuth.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    expect((await DELETE(request('DELETE'), context)).status).toBe(401)
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })

  it('leaves GET outside the mutation transaction and source fence', async () => {
    mocks.outsideFindUnique.mockResolvedValue({ id: 'job-1', userId: 'user-1' })

    const response = await GET(request('GET'), context)

    expect(response.status).toBe(200)
    expect(mocks.outsideFindUnique).toHaveBeenCalledWith({ where: { id: 'job-1' } })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })
})
