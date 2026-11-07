import { describe, expect, it, vi } from 'vitest'
import { recoveryResumeUrl, replaceWithRecoveryResume } from './application-recovery-navigation'

describe('recovered resume navigation', () => {
  it('uses the original resume and removes previous account and job context', () => {
    expect(recoveryResumeUrl('https://example.test/?page=search&resumeId=other&returnJobId=other-job&sessionId=other-session#private', 'resume / one'))
      .toBe('/?page=resume&resumeId=resume+%2F+one')
  })
  it('restores only the application context captured with the original draft', () => {
    const url = recoveryResumeUrl('https://example.test/?page=search&returnJobId=other&jobsSearch=other&sessionId=other#private', 'resume-a', {
      jobId: 'job-a', attention: true, list: { search: 'original', status: 'saved', page: 3, pageSize: 50, sortBy: 'score', sortDir: 'asc', view: 'list' },
    })
    const restored = new URL(url!, 'https://example.test')
    expect(restored.searchParams.get('resumeId')).toBe('resume-a')
    expect(restored.searchParams.get('returnJobId')).toBe('job-a')
    expect(restored.searchParams.get('returnToJobs')).toBe('1')
    expect(restored.searchParams.get('jobsSearch')).toBe('original')
    expect(restored.searchParams.get('jobsPage')).toBe('3')
    expect(restored.searchParams.get('jobsAttention')).toBe('1')
    expect(restored.searchParams.has('sessionId')).toBe(false)
    expect(restored.hash).toBe('')
  })
  it('keeps the recovery available if the target is invalid or history rejects the update', () => {
    const replaceState = vi.fn(() => { throw new Error('history unavailable') })
    const win = { location: { href: 'https://example.test/' }, history: { state: null, replaceState } } as unknown as Window
    expect(replaceWithRecoveryResume(win, '')).toBe(false)
    expect(replaceState).not.toHaveBeenCalled()
    expect(replaceWithRecoveryResume(win, 'resume-1')).toBe(false)
  })
  it('reports success only after updating the URL', () => {
    const replaceState = vi.fn()
    const state = { example: true }
    const win = { location: { href: 'https://example.test/?page=jobs&highlight=old' }, history: { state, replaceState } } as unknown as Window
    expect(replaceWithRecoveryResume(win, 'resume-1')).toBe(true)
    expect(replaceState).toHaveBeenCalledWith(state, '', '/?page=resume&resumeId=resume-1')
  })
})
