import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), transaction: vi.fn(), sourceFence: vi.fn(), events: [] as string[],
  tx: {
    job: { findFirst: vi.fn(), update: vi.fn() },
    resume: { findFirst: vi.fn() },
    coverLetter: { findFirst: vi.fn(), updateMany: vi.fn() },
  },
}))
vi.mock('@/lib/db', () => ({ db: { $transaction: mocks.transaction } }))
vi.mock('@/lib/agent/source-material-fence', () => ({ acquireSourceMaterialFence: mocks.sourceFence }))
vi.mock('@/lib/api-helpers', () => ({
  requireAuth: mocks.auth, isErrorResponse: (value: unknown) => value instanceof Response,
  ok: (data: unknown, status = 200) => Response.json(data, { status }),
  err: (error: string, status = 400) => Response.json({ error }, { status }),
}))
import { PATCH } from './route'

const updatedAt = new Date('2026-11-02T09:00:00.000Z')
function invoke(body: unknown = { finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' }) {
  return PATCH(new Request('https://applymate.site/api/jobs/job_1/assign', { method: 'PATCH', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: 'job_1' }) })
}
function invokeRaw(body: string) {
  return PATCH(new Request('https://applymate.site/api/jobs/job_1/assign', { method: 'PATCH', body }) as never, { params: Promise.resolve({ id: 'job_1' }) })
}

describe('job material assignment source fence', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.events.length = 0
    mocks.auth.mockResolvedValue({ userId: 'user_1' })
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
    mocks.tx.job.findFirst.mockImplementation(async () => { mocks.events.push('job.findFirst'); return { id: 'job_1', userId: 'user_1' } })
    mocks.tx.resume.findFirst.mockImplementation(async () => { mocks.events.push('resume.findFirst'); return { id: 'resume_1' } })
    mocks.tx.coverLetter.findFirst.mockImplementation(async () => { mocks.events.push('coverLetter.findFirst'); return { id: 'letter_1', isFinal: false, updatedAt } })
    mocks.tx.coverLetter.updateMany.mockImplementation(async () => { mocks.events.push('coverLetter.updateMany'); return { count: 1 } })
    mocks.tx.job.update.mockImplementation(async () => { mocks.events.push('job.update'); return { id: 'job_1', finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' } })
  })

  it('takes the fence before owner-scoped reads and preserves the cover-letter revision guard', async () => {
    expect((await invoke()).status).toBe(200)
    expect(mocks.sourceFence).toHaveBeenCalledWith(mocks.tx, ['user_1'])
    expect(mocks.tx.job.findFirst).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' } })
    expect(mocks.tx.resume.findFirst).toHaveBeenCalledWith({
      where: { id: 'resume_1', userId: 'user_1', OR: [{ isDefault: true }, { targetJobId: 'job_1' }] }, select: { id: true },
    })
    expect(mocks.tx.coverLetter.findFirst).toHaveBeenCalledWith({ where: { id: 'letter_1', jobId: 'job_1', userId: 'user_1' } })
    expect(mocks.tx.coverLetter.updateMany).toHaveBeenCalledWith({
      where: { id: 'letter_1', jobId: 'job_1', userId: 'user_1', updatedAt },
      data: { isFinal: true, updatedAt },
    })
    expect(mocks.tx.coverLetter.updateMany).toHaveBeenCalledWith({
      where: { jobId: 'job_1', userId: 'user_1', id: { not: 'letter_1' }, isFinal: true }, data: { isFinal: false },
    })
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'resume.findFirst', 'coverLetter.findFirst',
      'coverLetter.updateMany', 'coverLetter.updateMany', 'job.update', 'committed',
    ])
    expect(mocks.tx.job.update).toHaveBeenCalledWith({
      where: { id: 'job_1', userId: 'user_1' }, data: { finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' },
    })
  })

  it('keeps resume-only assignment inside the fence without touching cover letters', async () => {
    expect((await invoke({ finalResumeId: 'resume_1' })).status).toBe(200)
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'resume.findFirst', 'job.update', 'committed'])
    expect(mocks.tx.coverLetter.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.coverLetter.updateMany).not.toHaveBeenCalled()
    expect(mocks.tx.job.update).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' }, data: { finalResumeId: 'resume_1' } })
  })

  it('keeps cover-letter-only assignment semantics without a Resume read', async () => {
    expect((await invoke({ finalCoverLetterId: 'letter_1' })).status).toBe(200)
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.job.update).toHaveBeenCalledWith({ where: { id: 'job_1', userId: 'user_1' }, data: { finalCoverLetterId: 'letter_1' } })
    expect(mocks.events.slice(0, 3)).toEqual(['transaction', 'fence', 'job.findFirst'])
  })

  it('does not mutate when the owner-scoped Job or Resume is unavailable', async () => {
    mocks.tx.job.findFirst.mockResolvedValueOnce(null)
    expect((await invoke()).status).toBe(404)
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()
    expect(mocks.tx.job.update).not.toHaveBeenCalled()

    mocks.tx.job.findFirst.mockResolvedValueOnce({ id: 'job_1', userId: 'user_1' })
    mocks.tx.resume.findFirst.mockResolvedValueOnce(null)
    expect((await invoke({ finalResumeId: 'resume_1' })).status).toBe(400)
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
  })

  it('does not assign a cover letter if its reviewed revision changed', async () => {
    mocks.tx.coverLetter.updateMany.mockImplementationOnce(async () => { mocks.events.push('coverLetter.updateMany'); return { count: 0 } })
    expect((await invoke()).status).toBe(409)
    expect(mocks.tx.job.update).not.toHaveBeenCalled()
    expect(mocks.events).toEqual([
      'transaction', 'fence', 'job.findFirst', 'resume.findFirst', 'coverLetter.findFirst', 'coverLetter.updateMany', 'rolled-back',
    ])
  })

  it('authenticates before parsing and preserves missing-Job response precedence', async () => {
    mocks.auth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await invoke()).status).toBe(401)
    expect(mocks.transaction).not.toHaveBeenCalled()

    const invalid = await invokeRaw('{')
    expect(invalid.status).toBe(400)
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'committed'])
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()

    mocks.events.length = 0
    mocks.tx.job.findFirst.mockImplementationOnce(async () => { mocks.events.push('job.findFirst'); return null })
    expect((await invokeRaw('{')).status).toBe(404)
    expect(mocks.events).toEqual(['transaction', 'fence', 'job.findFirst', 'committed'])
    expect(mocks.tx.resume.findFirst).not.toHaveBeenCalled()
  })
})
