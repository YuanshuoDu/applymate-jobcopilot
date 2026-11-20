import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fence: vi.fn(),
  events: [] as string[],
  queryRaw: vi.fn(),
  jobFindFirst: vi.fn(),
  jobUpdateMany: vi.fn(),
  resumeFindFirst: vi.fn(),
}))

vi.mock('@/lib/agent/source-material-fence', () => ({ acquireSourceMaterialFence: mocks.fence }))

import { confirmTailoredResumeSourceWrite } from './confirm-tailored-resume'

const payload = { jobId: 'job-1', resumeId: 'resume-1' }
const job = { id: 'job-1', company: 'Acme', role: 'Engineer', url: 'https://jobs.example/apply', status: 'saved' }
const resume = { id: 'resume-1', name: 'Tailored Resume' }
const tx = {
  $queryRaw: mocks.queryRaw,
  job: { findFirst: mocks.jobFindFirst, updateMany: mocks.jobUpdateMany },
  resume: { findFirst: mocks.resumeFindFirst },
}

describe('confirmTailoredResumeSourceWrite', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.events.length = 0
    mocks.fence.mockImplementation(async () => { mocks.events.push('fence') })
    mocks.queryRaw.mockImplementation(async () => { mocks.events.push('job.lock'); return [{ id: 'job-1' }] })
    mocks.jobFindFirst.mockImplementation(async () => { mocks.events.push('job.read'); return job })
    mocks.resumeFindFirst.mockImplementation(async () => { mocks.events.push('resume.read'); return resume })
    mocks.jobUpdateMany.mockImplementation(async () => { mocks.events.push('job.write'); return { count: 1 } })
  })

  it('fences first, locks and rereads the owner Job, then updates only that user-owned Job', async () => {
    await expect(confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)).resolves.toEqual({ kind: 'saved', job, resume })

    expect(mocks.events).toEqual(['fence', 'job.lock', 'job.read', 'resume.read', 'job.write'])
    expect(mocks.fence).toHaveBeenCalledWith(tx, ['user-1'])
    expect(mocks.queryRaw.mock.calls[0]?.[0]?.join(' ')).toContain('FOR UPDATE')
    expect(mocks.queryRaw.mock.calls[0]?.slice(1)).toEqual(['job-1', 'user-1'])
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1' },
      select: { id: true, company: true, role: true, url: true, status: true },
    })
    expect(mocks.resumeFindFirst).toHaveBeenCalledWith({
      where: { id: 'resume-1', userId: 'user-1', targetJobId: 'job-1' },
      select: { id: true, name: true },
    })
    expect(mocks.jobUpdateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', userId: 'user-1' },
      data: {
        finalResumeId: 'resume-1', status: 'saved', workflowState: 'ready_to_apply',
        analysisNote: '[Application ready] Open the employer form, use the ApplyMate extension to fill it, then review and submit it yourself.',
      },
    })
  })

  it('preserves the no-URL analysis note', async () => {
    mocks.jobFindFirst.mockResolvedValueOnce({ ...job, url: null })

    await confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)

    expect(mocks.jobUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ analysisNote: '[Application ready] Missing application URL.' }),
    }))
  })

  it('returns missing without writing when the Job lock is not owned by the user', async () => {
    mocks.queryRaw.mockResolvedValueOnce([])

    await expect(confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)).resolves.toEqual({ kind: 'missing' })

    expect(mocks.jobFindFirst).not.toHaveBeenCalled()
    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
  })

  it('returns missing when the scoped Resume no longer targets this Job', async () => {
    mocks.resumeFindFirst.mockResolvedValueOnce(null)

    await expect(confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)).resolves.toEqual({ kind: 'missing' })

    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
  })

  it('does not overwrite a submitted Job', async () => {
    mocks.jobFindFirst.mockResolvedValueOnce({ ...job, status: 'applied' })

    await expect(confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)).resolves.toEqual({ kind: 'already_submitted' })

    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
  })

  it('fails closed before any row lock or write when fence acquisition fails', async () => {
    mocks.fence.mockRejectedValueOnce(new Error('fence unavailable'))

    await expect(confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)).rejects.toThrow('fence unavailable')

    expect(mocks.queryRaw).not.toHaveBeenCalled()
    expect(mocks.jobFindFirst).not.toHaveBeenCalled()
    expect(mocks.resumeFindFirst).not.toHaveBeenCalled()
    expect(mocks.jobUpdateMany).not.toHaveBeenCalled()
  })

  it('propagates a failed update so the enclosing transaction rolls back', async () => {
    mocks.jobUpdateMany.mockImplementationOnce(async () => {
      mocks.events.push('job.write')
      throw new Error('write failed')
    })

    await expect(confirmTailoredResumeSourceWrite(tx as never, 'user-1', payload)).rejects.toThrow('write failed')

    expect(mocks.events).toEqual(['fence', 'job.lock', 'job.read', 'resume.read', 'job.write'])
  })
})
