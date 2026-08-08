import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ userFindUnique: vi.fn(), jobFindFirst: vi.fn(), deleteMany: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {
  user: { findUnique: mocks.userFindUnique },
  job: { findFirst: mocks.jobFindFirst },
  coverLetter: { deleteMany: mocks.deleteMany },
} }))

describe('purgeTemporaryGeneratedCoverLetters', () => {
  beforeEach(() => {
    vi.resetModules()
    Object.values(mocks).forEach(mock => mock.mockReset())
    mocks.userFindUnique.mockResolvedValue({ preferences: { privacyPreferences: { storeCoverLetters: false } } })
    mocks.jobFindFirst.mockResolvedValue({ finalCoverLetterId: 'final_1' })
    mocks.deleteMany.mockResolvedValue({ count: 2 })
  })

  it('deletes only non-final generated artifacts when retention is disabled', async () => {
    const { purgeTemporaryGeneratedCoverLetters } = await import('./cover-letter-retention')
    await expect(purgeTemporaryGeneratedCoverLetters('user_1', 'job_1')).resolves.toBe(2)
    expect(mocks.deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ origin: { in: ['agent', 'ai-generated'] }, isFinal: false, id: { not: 'final_1' } }),
    }))
  })

  it('does not delete when retention remains enabled', async () => {
    mocks.userFindUnique.mockResolvedValue({ preferences: { privacyPreferences: { storeCoverLetters: true } } })
    const { purgeTemporaryGeneratedCoverLetters } = await import('./cover-letter-retention')
    await expect(purgeTemporaryGeneratedCoverLetters('user_1', 'job_1')).resolves.toBe(0)
    expect(mocks.deleteMany).not.toHaveBeenCalled()
  })
})
