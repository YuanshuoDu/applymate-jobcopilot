import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  pinnedFetch: vi.fn(),
  resumeFindFirst: vi.fn(),
  jobFindMany: vi.fn(),
  jobCount: vi.fn(),
  inTransaction: false,
  events: [] as string[],
  tx: {
    resume: { findFirst: vi.fn() },
    job: { findFirst: vi.fn(), updateMany: vi.fn() },
  },
}))

vi.mock('@jobcopilot/shared', () => ({ pinnedFetch: mocks.pinnedFetch }))
vi.mock('@/lib/db', () => ({
  db: {
    $transaction: mocks.transaction,
    resume: { findFirst: mocks.resumeFindFirst },
    job: { findMany: mocks.jobFindMany, count: mocks.jobCount },
  },
}))
vi.mock('@/lib/agent/source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.requireAuth,
  isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (value: unknown, status = 200) => Response.json(value, { status }),
  err: (message: string, status = 400) => Response.json({ error: message }, { status }),
}))

import { POST } from './route'

const userId = 'user-1'
const resume = { content: { summary: 'Experienced engineer' } }
const job = {
  id: 'job-1',
  role: 'Software Engineer',
  company: 'Fixture Co',
  description: 'Build reliable software',
  keywords: 'TypeScript, PostgreSQL',
}

function request() {
  return new NextRequest('http://localhost:3000/api/jobs/score-all', { method: 'POST' })
}

describe('score-all source fence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.events.length = 0
    mocks.inTransaction = false
    mocks.requireAuth.mockImplementation(async () => {
      mocks.events.push('auth')
      return { userId }
    })
    mocks.resumeFindFirst.mockImplementation(async () => {
      mocks.events.push('resume.read.outside')
      return resume
    })
    mocks.jobFindMany.mockImplementation(async () => {
      mocks.events.push('jobs.read.outside')
      return [job]
    })
    mocks.jobCount.mockImplementation(async () => {
      mocks.events.push('remaining.read')
      return 0
    })
    mocks.transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => {
      mocks.events.push('transaction.start')
      mocks.inTransaction = true
      try {
        const result = await run(mocks.tx)
        mocks.events.push('transaction.commit')
        return result
      } catch (error) {
        mocks.events.push('transaction.rollback')
        throw error
      } finally {
        mocks.inTransaction = false
      }
    })
    mocks.sourceFence.mockImplementation(async () => { mocks.events.push('fence') })
    mocks.tx.job.findFirst.mockImplementation(async () => {
      mocks.events.push('job.read.inside')
      return { ...job, userId, score: null }
    })
    mocks.tx.resume.findFirst.mockImplementation(async () => {
      mocks.events.push('resume.read.inside')
      return resume
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.update.inside')
      return { count: 1 }
    })
    mocks.pinnedFetch.mockImplementation(async () => {
      expect(mocks.inTransaction).toBe(false)
      mocks.events.push('model.request.outside')
      return {
        ok: true,
        json: async () => {
          expect(mocks.inTransaction).toBe(false)
          mocks.events.push('model.response.outside')
          return { score: 82, keywords: 'TypeScript, PostgreSQL' }
        },
      }
    })
  })

  it('authenticates first and keeps model work outside a transaction before the first-lock fence', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ scored: 1, failed: 0, remaining: 0 })
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, [userId])
    expect(mocks.events).toEqual([
      'auth', 'resume.read.outside', 'jobs.read.outside',
      'model.request.outside', 'model.response.outside',
      'transaction.start', 'fence', 'job.read.inside', 'resume.read.inside',
      'job.update.inside', 'transaction.commit', 'remaining.read',
    ])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({
      where: { id: job.id, userId },
      select: { userId: true, role: true, company: true, description: true, keywords: true, score: true },
    })
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: job.id, userId, role: job.role, company: job.company,
        description: job.description, keywords: job.keywords, score: null,
      },
      data: { score: 82, keywords: 'TypeScript, PostgreSQL' },
    })
  })

  it('returns the auth response without reading or writing scoring data', async () => {
    mocks.requireAuth.mockResolvedValue(new Response('unauthorized', { status: 401 }))

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
    expect(mocks.jobFindMany).not.toHaveBeenCalled()
    expect(mocks.pinnedFetch).not.toHaveBeenCalled()
    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.sourceFence).not.toHaveBeenCalled()
  })

  it('skips a score when the tenant-owned Job source changed during model work', async () => {
    mocks.tx.job.findFirst.mockResolvedValue({ ...job, description: 'Changed description', userId, score: null })
    mocks.jobCount.mockResolvedValue(1)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ scored: 0, failed: 1, remaining: 1 })
    expect(mocks.events).toContain('fence')
    expect(mocks.events).not.toContain('resume.read.inside')
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
  })

  it('skips a score when the selected resume source changed during model work', async () => {
    mocks.tx.resume.findFirst.mockResolvedValue({ content: { summary: 'Updated resume' } })
    mocks.jobCount.mockResolvedValue(1)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ scored: 0, failed: 1, remaining: 1 })
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({
      where: { userId }, orderBy: { isDefault: 'desc' }, select: { content: true },
    })
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
  })

  it('does not write a row returned for another tenant', async () => {
    mocks.tx.job.findFirst.mockResolvedValue({ ...job, userId: 'user-2', score: null })
    mocks.jobCount.mockResolvedValue(1)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ scored: 0, failed: 1, remaining: 1 })
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: job.id, userId } }))
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
  })

  it('counts a fence failure as failed and rolls back before source reads or writes', async () => {
    mocks.sourceFence.mockRejectedValueOnce(new Error('source fence failed'))
    mocks.jobCount.mockResolvedValue(1)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ scored: 0, failed: 1, remaining: 1 })
    expect(mocks.events).toContain('transaction.rollback')
    expect(mocks.tx.job.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.job.updateMany).not.toHaveBeenCalled()
  })

  it('counts a Job write failure as failed and does not report a committed score', async () => {
    mocks.tx.job.updateMany.mockRejectedValueOnce(new Error('Job update failed'))
    mocks.jobCount.mockResolvedValue(1)

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ scored: 0, failed: 1, remaining: 1 })
    expect(mocks.events).toContain('transaction.rollback')
    expect(mocks.events).not.toContain('transaction.commit')
    expect(mocks.tx.job.updateMany).toHaveBeenCalledOnce()
  })
})
