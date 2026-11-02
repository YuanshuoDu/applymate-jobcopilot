import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), job: vi.fn(), resume: vi.fn(), letter: vi.fn(), updateLetters: vi.fn(), updateJob: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  job: { findFirst: mocks.job }, resume: { findFirst: mocks.resume },
  $transaction: async (run: (tx: unknown) => unknown) => run({ coverLetter: { findFirst: mocks.letter, updateMany: mocks.updateLetters }, job: { update: mocks.updateJob } }),
} }))
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

describe('final selection preserves the audited cover-letter revision', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.auth.mockResolvedValue({ userId: 'user_1' })
    mocks.job.mockResolvedValue({ id: 'job_1' })
    mocks.resume.mockResolvedValue({ id: 'resume_1' })
    mocks.letter.mockResolvedValue({ id: 'letter_1', isFinal: false, updatedAt })
    mocks.updateLetters.mockResolvedValue({ count: 1 })
    mocks.updateJob.mockResolvedValue({ id: 'job_1', finalResumeId: 'resume_1', finalCoverLetterId: 'letter_1' })
  })

  it('selects metadata without changing the reviewed timestamp and uses optimistic revision matching', async () => {
    expect((await invoke()).status).toBe(200)
    expect(mocks.letter).toHaveBeenCalledWith({ where: { id: 'letter_1', jobId: 'job_1', userId: 'user_1' } })
    expect(mocks.updateLetters).toHaveBeenCalledWith({
      where: { id: 'letter_1', jobId: 'job_1', userId: 'user_1', updatedAt },
      data: { isFinal: true, updatedAt },
    })
    expect(mocks.updateLetters).toHaveBeenCalledWith({
      where: { jobId: 'job_1', userId: 'user_1', id: { not: 'letter_1' }, isFinal: true }, data: { isFinal: false },
    })
  })

  it('does not rewrite an already final letter during confirmation or a retry', async () => {
    mocks.letter.mockResolvedValue({ id: 'letter_1', isFinal: true, updatedAt })
    expect((await invoke()).status).toBe(200)
    expect(mocks.updateLetters).toHaveBeenCalledTimes(1)
    expect(mocks.updateLetters.mock.calls[0][0].data).toEqual({ isFinal: false })
  })

  it('does not confirm if a concurrent edit replaced the reviewed revision', async () => {
    mocks.updateLetters.mockResolvedValueOnce({ count: 0 })
    expect((await invoke()).status).toBe(409)
    expect(mocks.updateJob).not.toHaveBeenCalled()
  })

  it('does not alter cover letters during a resume-only confirmation', async () => {
    expect((await invoke({ finalResumeId: 'resume_1' })).status).toBe(200)
    expect(mocks.letter).not.toHaveBeenCalled()
    expect(mocks.updateLetters).not.toHaveBeenCalled()
  })

  it('does not select a cover letter outside the owner and job scope', async () => {
    mocks.letter.mockResolvedValue(null)
    expect((await invoke()).status).toBe(404)
    expect(mocks.updateJob).not.toHaveBeenCalled()
  })

  it('keeps authentication and owner isolation', async () => {
    mocks.auth.mockResolvedValueOnce(Response.json({ error: 'Unauthorized' }, { status: 401 }))
    expect((await invoke()).status).toBe(401)
    mocks.job.mockResolvedValue(null)
    expect((await invoke()).status).toBe(404)
    expect(mocks.updateJob).not.toHaveBeenCalled()
  })
})
