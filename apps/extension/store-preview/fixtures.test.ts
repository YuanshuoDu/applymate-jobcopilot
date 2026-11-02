import { describe, expect, it } from 'vitest'
import { previewMessage, sampleFields, sampleJob, sampleJobs, sampleSettings } from './fixtures'

describe('store preview data boundary', () => {
  it('uses reserved, fictional identities and destinations', () => {
    expect(sampleSettings.userEmail).toMatch(/@example\.invalid$/)
    expect(new URL(sampleJob.url).hostname).toBe('example.invalid')
    for (const job of sampleJobs) expect(new URL(job.url!).hostname).toBe('example.invalid')
    expect(sampleSettings.apiToken).toBe('preview-only-invalid-token')
    expect(sampleSettings.autoSave).toBe(false)
    expect(sampleFields.find(field => field.key === 'email')?.value).toBe('alex@example.invalid')
  })

  it('allows illustrative reads but never pretends mutations, auth or AI succeeded', () => {
    expect(previewMessage('GET_RECENT_JOBS')).toEqual({ jobs: sampleJobs })
    for (const type of ['SAVE_JOB', 'MATCH_JOB', 'REFRESH_DASHBOARD_TOKEN', 'FILL_FORM', 'UNKNOWN']) {
      expect(previewMessage(type)).toMatchObject({ success: false })
    }
  })
})
