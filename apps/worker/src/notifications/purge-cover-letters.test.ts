import { describe, expect, it, vi } from 'vitest'
import { purgeTemporaryGeneratedCoverLetters } from './purge-cover-letters.js'

describe('purgeTemporaryGeneratedCoverLetters', () => {
  it('removes non-final generated letters when consent is disabled', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ preferences: { privacyPreferences: { storeCoverLetters: false } }, finalCoverLetterId: 'final_1' }] })
      .mockResolvedValueOnce({ rowCount: 2 })
    const pool = { query } as never
    await expect(purgeTemporaryGeneratedCoverLetters('user_1', 'job_1', pool)).resolves.toBe(2)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1][1]).toEqual(['user_1', 'job_1', 'final_1'])
  })

  it('does not query a delete when consent is enabled', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ preferences: {}, finalCoverLetterId: null }] })
    const pool = { query } as never
    await expect(purgeTemporaryGeneratedCoverLetters('user_1', 'job_1', pool)).resolves.toBe(0)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
