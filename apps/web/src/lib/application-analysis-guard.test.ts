import { describe, expect, it } from 'vitest'
import { mayApplyApplicationAnalysis } from './application-analysis-guard'

describe('applying an asynchronous analysis', () => {
  it('accepts only the original mounted account, target and actual content revision', () => {
    const pending = { mounted: true, userId: 'u', currentUserId: 'u', resumeId: 'r', currentResumeId: 'r', jobId: 'j', currentJobId: 'j', revision: 'v1', currentRevision: 'v1', editRevision: 1, currentEditRevision: 1, epoch: 1, currentEpoch: 1 }
    expect(mayApplyApplicationAnalysis(pending)).toBe(true)
    expect(mayApplyApplicationAnalysis({ ...pending, mounted: false })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, currentUserId: 'other' })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, currentResumeId: 'other' })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, currentJobId: 'other' })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, currentRevision: 'v2' })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, currentEditRevision: 2 })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, currentEpoch: 2 })).toBe(false)
    expect(mayApplyApplicationAnalysis({ ...pending, userId: null, currentUserId: null })).toBe(false)
  })
})
