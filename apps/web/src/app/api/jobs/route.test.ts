import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  groupBy: vi.fn(),
  create: vi.fn(),
  activityCreate: vi.fn(),
  events: [] as string[],
  tx: {
    job: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    job: {
      findMany: mocks.findMany,
      count: mocks.count,
      groupBy: mocks.groupBy,
      create: mocks.create,
    },
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

import { DELETE, GET, POST } from './route'

function request(method: string, body?: string, url = 'http://localhost/api/jobs') {
  return new NextRequest(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body }),
  })
}

const linkedInJob = {
  id: 'job-1', userId: 'user-1', company: 'Acme', role: 'Dismiss Senior Engineer Job',
  source: 'linkedin', url: 'https://jobs.example.com/1', description: 'Description',
  location: 'Dublin', salary: null, score: null,
}

describe('jobs root route source fence', () => {
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
    mocks.findMany.mockResolvedValue([])
    mocks.count.mockResolvedValue(0)
    mocks.groupBy.mockResolvedValue([])
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return null
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 1 }
    })
    mocks.tx.job.deleteMany.mockImplementation(async () => {
      mocks.events.push('job.deleteMany')
      return { count: 2 }
    })
    mocks.tx.job.create.mockImplementation(async () => {
      mocks.events.push('tx.job.create')
      return { id: 'new-job', userId: 'user-1' }
    })
    mocks.create.mockImplementation(async () => {
      mocks.events.push('job.create')
      return { id: 'new-job', userId: 'user-1' }
    })
    mocks.activityCreate.mockImplementation(async () => { mocks.events.push('activity.create') })
  })

  it('fences and rechecks a LinkedIn role repair with tenant and CAS predicates', async () => {
    const otherJob = { id: 'job-2', userId: 'user-1', role: 'Engineer', source: 'greenhouse' }
    mocks.findMany.mockResolvedValue([linkedInJob, otherJob])
    mocks.count.mockResolvedValue(2)
    mocks.groupBy.mockResolvedValue([{ status: 'saved', _count: { _all: 2 } }])
    const updatedLinkedInJob = { ...linkedInJob, role: 'Senior Engineer', updatedAt: 'updated-after-write' }
    mocks.tx.job.findFirst
      .mockImplementationOnce(async () => {
        mocks.events.push('job.findFirst')
        return linkedInJob
      })
      .mockImplementationOnce(async () => {
      mocks.events.push('job.findFirst')
        return updatedLinkedInJob
      })

    const response = await GET(request('GET'))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      jobs: [updatedLinkedInJob, otherJob],
      total: 2, page: 1, pageSize: 50,
      statusCounts: { saved: 2, applied: 0, interview: 0, offer: 0, rejected: 0 },
    })
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'job.updateMany', 'job.findFirst', 'committed',
    ])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job-1', userId: 'user-1' } })
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1', role: linkedInJob.role, source: 'linkedin' },
      data: { role: 'Senior Engineer' },
    })
  })

  it('keeps GET response fields and avoids a transaction when no role needs repair', async () => {
    const job = { id: 'job-2', userId: 'user-1', role: 'Engineer', source: 'greenhouse' }
    mocks.findMany.mockResolvedValue([job])
    mocks.count.mockResolvedValue(1)

    const response = await GET(request('GET', undefined, 'http://localhost/api/jobs?page=2&pageSize=7'))

    await expect(response.json()).resolves.toMatchObject({ jobs: [job], total: 1, page: 2, pageSize: 7 })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })

  it('returns the current owner-scoped row when the role repair CAS loses a race', async () => {
    const changedJob = { ...linkedInJob, role: 'Staff Engineer' }
    mocks.findMany.mockResolvedValue([linkedInJob])
    mocks.tx.job.findFirst
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return linkedInJob })
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return changedJob })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 0 }
    })

    const response = await GET(request('GET'))

    await expect(response.json()).resolves.toMatchObject({ jobs: [changedJob] })
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'job.updateMany', 'job.findFirst', 'committed',
    ])
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: 'user-1', role: linkedInJob.role, source: 'linkedin' }),
    }))
  })

  it('rolls back the repair batch when a later Job write fails', async () => {
    mocks.findMany.mockResolvedValue([linkedInJob, { ...linkedInJob, id: 'job-2' }])
    mocks.tx.job.findFirst
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return linkedInJob })
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return { ...linkedInJob, role: 'Senior Engineer' } })
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return { ...linkedInJob, id: 'job-2' } })
    mocks.tx.job.findFirst.mockImplementationOnce(async () => {
      mocks.events.push('job.findFirst')
      return { ...linkedInJob, id: 'job-2', role: 'Senior Engineer' }
    })
    mocks.tx.job.updateMany
      .mockImplementationOnce(async () => { mocks.events.push('job.updateMany'); return { count: 1 } })
      .mockImplementationOnce(async () => { mocks.events.push('job.updateMany'); throw new Error('write failed') })

    await expect(GET(request('GET'))).rejects.toThrow('write failed')
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'job.updateMany', 'job.findFirst',
      'job.findFirst', 'job.updateMany', 'rolled-back',
    ])
  })

  it('fences an existing URL update before its tenant-scoped lookup and CAS update', async () => {
    const existing = {
      id: 'job-1', userId: 'user-1', url: 'https://jobs.example.com/1', company: 'Acme',
      role: 'Engineer', description: 'Old description', location: null, salary: null, score: null,
    }
    const updated = { ...existing, description: 'New description', location: 'Dublin', score: 8 }
    mocks.tx.job.findFirst
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return existing })
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return updated })

    const response = await POST(request('POST', JSON.stringify({
      company: 'Acme', role: 'Engineer', url: 'https://jobs.example.com/1?utm_source=extension',
      description: 'New description', location: 'Dublin', score: 8,
    })))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(updated)
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'job.updateMany', 'job.findFirst', 'committed',
    ])
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.tx.job.findFirst).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user-1', url: 'https://jobs.example.com/1' },
    })
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1', userId: 'user-1', url: 'https://jobs.example.com/1',
        company: 'Acme', role: 'Engineer', description: 'Old description', location: null, salary: null, score: null,
      },
      data: { description: 'New description', location: 'Dublin', score: 8 },
    })
  })

  it('propagates an existing Job update failure so the transaction rolls back', async () => {
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.findFirst')
      return { ...linkedInJob, url: 'https://jobs.example.com/1' }
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      throw new Error('write failed')
    })

    await expect(POST(request('POST', JSON.stringify({
      company: 'Acme', role: 'Engineer', url: 'https://jobs.example.com/1', description: 'new',
    })))).rejects.toThrow('write failed')
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.updateMany', 'rolled-back'])
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('does not create a replacement Job when the existing-row CAS fails', async () => {
    mocks.tx.job.findFirst.mockImplementationOnce(async () => {
      mocks.events.push('job.findFirst')
      return { ...linkedInJob, url: 'https://jobs.example.com/1' }
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 0 }
    })

    await expect(POST(request('POST', JSON.stringify({
      company: 'Acme', role: 'Engineer', url: 'https://jobs.example.com/1', description: 'new',
    })))).rejects.toThrow('Existing job changed during save')
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.updateMany', 'rolled-back'])
    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.tx.job.create).not.toHaveBeenCalled()
    expect(mocks.activityCreate).not.toHaveBeenCalled()
  })

  it('creates a canonical URL Job in the fenced transaction and logs Activity after commit', async () => {
    mocks.tx.job.findFirst.mockImplementationOnce(async () => {
      mocks.events.push('job.findFirst')
      return null
    })

    const response = await POST(request('POST', JSON.stringify({
      company: 'Acme', role: 'Engineer', url: 'https://jobs.example.com/1',
    })))

    expect(response.status).toBe(201)
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'tx.job.create', 'committed', 'activity.create',
    ])
    expect(mocks.tx.job.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', url: 'https://jobs.example.com/1' }),
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('keeps unrelated new Job inserts outside the fence and preserves the Activity boundary', async () => {
    const response = await POST(request('POST', JSON.stringify({ company: 'Acme', role: 'Engineer' })))

    expect(response.status).toBe(201)
    expect(mocks.sourceFence).not.toHaveBeenCalled()
    expect(mocks.events).toEqual(['job.create', 'activity.create'])
  })

  it('fences bulk deletion and retains the authenticated tenant and deduplicated ID selection', async () => {
    const response = await DELETE(request('DELETE', JSON.stringify({ ids: ['job-1', 'job-2', 'job-1', 1] })))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ deleted: 2 })
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.deleteMany', 'committed'])
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.tx.job.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', id: { in: ['job-1', 'job-2'] } },
    })
  })

  it('preserves the bulk deletion limit before acquiring the fence', async () => {
    const response = await DELETE(request('DELETE', JSON.stringify({ ids: Array.from({ length: 101 }, (_, i) => `job-${i}`) })))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'A maximum of 100 jobs can be deleted at once' })
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })

  it('does not convert a delete failure into a success response', async () => {
    mocks.tx.job.deleteMany.mockImplementation(async () => {
      mocks.events.push('job.deleteMany')
      throw new Error('delete failed')
    })

    await expect(DELETE(request('DELETE', JSON.stringify({ ids: ['job-1'] })))).rejects.toThrow('delete failed')
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.deleteMany', 'rolled-back'])
  })
})
