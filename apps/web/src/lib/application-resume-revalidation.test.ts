import { describe, expect, it } from 'vitest'
import { mayApplyResumeRevalidation } from './application-resume-revalidation'

describe('resume revalidation', () => {
  it('rejects an old GET after an edit, a save, a resume switch or an identity change', () => {
    const pending = { resumeId: 'a', currentResumeId: 'a', userId: 'user-a', currentUserId: 'user-a', editRevision: 1, currentEditRevision: 1, saveGeneration: 0, currentSaveGeneration: 0, aborted: false }
    expect(mayApplyResumeRevalidation(pending)).toBe(true)
    expect(mayApplyResumeRevalidation({ ...pending, currentEditRevision: 2 })).toBe(false)
    expect(mayApplyResumeRevalidation({ ...pending, currentSaveGeneration: 1 })).toBe(false)
    expect(mayApplyResumeRevalidation({ ...pending, currentResumeId: 'b' })).toBe(false)
    expect(mayApplyResumeRevalidation({ ...pending, currentUserId: 'user-b' })).toBe(false)
    expect(mayApplyResumeRevalidation({ ...pending, userId: null, currentUserId: null })).toBe(false)
    expect(mayApplyResumeRevalidation({ ...pending, aborted: true })).toBe(false)
  })
})
