import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  sourceFence: vi.fn(),
  events: [] as string[],
  tx: {
    job: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
  },
}))

vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('./source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))

import { repairLinkedInDismissRoles, saveCanonicalJob } from './jobs-source-write'

const sourceJob = {
  id: 'job-1', userId: 'user-1', url: 'https://jobs.example.com/1', company: 'Acme',
  role: 'Dismiss Senior Engineer Job', source: 'linkedin', description: 'Description',
  location: 'Dublin', salary: null, score: null,
} as Job

describe('source-material-fenced Job writes', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.events.length = 0
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
      return null
    })
    mocks.tx.job.updateMany.mockImplementation(async () => {
      mocks.events.push('job.updateMany')
      return { count: 1 }
    })
    mocks.tx.job.create.mockImplementation(async () => {
      mocks.events.push('job.create')
      return { ...sourceJob, role: 'New Role' }
    })
  })

  it('returns the database reread after role repair, including its updatedAt', async () => {
    const updatedAt = new Date('2026-11-16T12:00:00Z')
    const updated = { ...sourceJob, role: 'Senior Engineer', updatedAt } as Job
    mocks.tx.job.findFirst
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return sourceJob })
      .mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return updated })

    await expect(repairLinkedInDismissRoles('user-1', [sourceJob])).resolves.toEqual([updated])
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user-1'])
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'job.updateMany', 'job.findFirst', 'committed',
    ])
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1', role: sourceJob.role, source: 'linkedin' },
      data: { role: 'Senior Engineer' },
    })
  })

  it('creates an absent canonical URL Job under the same tenant fence', async () => {
    const created = { ...sourceJob, role: 'New Role' } as Job
    mocks.tx.job.create.mockImplementationOnce(async () => {
      mocks.events.push('job.create')
      return created
    })

    await expect(saveCanonicalJob(
      'user-1', 'https://jobs.example.com/1',
      { userId: 'user-1', company: 'Acme', role: 'New Role' } as Prisma.JobUncheckedCreateInput,
      () => ({}),
    )).resolves.toEqual({ job: created, created: true })
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.create', 'committed'])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1', url: 'https://jobs.example.com/1' },
    })
  })

  it('rolls back a failed existing-row CAS and never falls through to create', async () => {
    mocks.tx.job.findFirst.mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return sourceJob })
    mocks.tx.job.updateMany.mockImplementationOnce(async () => {
      mocks.events.push('job.updateMany')
      return { count: 0 }
    })

    await expect(saveCanonicalJob(
      'user-1', 'https://jobs.example.com/1',
      { userId: 'user-1', company: 'Acme', role: 'New Role' } as Prisma.JobUncheckedCreateInput,
      () => ({ description: 'new description' }),
    )).rejects.toThrow('Existing job changed during save')
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'job.updateMany', 'rolled-back'])
    expect(mocks.tx.job.create).not.toHaveBeenCalled()
    expect(mocks.tx.job.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'job-1', userId: 'user-1', role: sourceJob.role }),
      data: { description: 'new description' },
    })
  })
})
