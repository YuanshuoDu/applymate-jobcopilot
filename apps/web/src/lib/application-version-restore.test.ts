import { describe, expect, it } from 'vitest'
import { versionRestoreDisposition } from './application-version-restore'

const pending = { mounted: true, requestUserId: 'a', currentUserId: 'a', requestResumeId: 'r1', currentResumeId: 'r1', requestEditRevision: 3, currentEditRevision: 3, validResponse: true }

describe('version restore response', () => {
  it('keeps a new local edit and treats a missing or invalid response as unknown', () => {
    expect(versionRestoreDisposition(pending)).toBe('apply')
    expect(versionRestoreDisposition({ ...pending, currentEditRevision: 4 })).toBe('conflict')
    expect(versionRestoreDisposition({ ...pending, validResponse: false })).toBe('unknown')
    expect(versionRestoreDisposition({ ...pending, validResponse: false, currentEditRevision: 4 })).toBe('unknown')
  })
  it('never applies an old account or resume response to the current editor', () => {
    expect(versionRestoreDisposition({ ...pending, mounted: false })).toBe('ignore')
    expect(versionRestoreDisposition({ ...pending, currentUserId: 'b' })).toBe('ignore')
    expect(versionRestoreDisposition({ ...pending, currentResumeId: 'r2' })).toBe('ignore')
  })
})
