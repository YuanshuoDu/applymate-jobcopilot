import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applicationUrl, isApplicationNavigationEvent, openApplication, openApplicationAttention, openApplicationSession, openApplicationWhenSaved } from './application-navigation'

let href: string
const replaceState = vi.fn((_state: unknown, _title: string, next: string) => { href = next })
const navigate = vi.fn()
const dispatchEvent = vi.fn()

beforeEach(() => {
  href = 'https://applymate.test/?page=resume&jobsPage=3&jobsStatus=saved&jobsQuery=backend&resumeId=resume-1&returnToJobs=1&returnJobId=job-1#details'
  vi.stubGlobal('window', {
    location: { get href() { return href } },
    history: { state: { saved: true }, replaceState },
    dispatchEvent,
  })
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('application navigation', () => {
  it('retains list context and hash while opening the exact job and clearing resume context', async () => {
    await openApplication('job / 42', navigate)

    const url = new URL(href)
    expect(url.searchParams.get('highlight')).toBe('job / 42')
    expect(url.searchParams.get('jobsPage')).toBe('3')
    expect(url.searchParams.get('jobsStatus')).toBe('saved')
    expect(url.searchParams.get('jobsQuery')).toBe('backend')
    expect(url.hash).toBe('#details')
    for (const key of ['resumeId', 'returnToJobs', 'returnJobId']) expect(url.searchParams.has(key)).toBe(false)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('jobs')
    expect(navigate.mock.invocationCallOrder[0]).toBeLessThan(replaceState.mock.invocationCallOrder[0])
    expect(dispatchEvent.mock.calls[0][0].type).toBe('popstate')
    expect(isApplicationNavigationEvent(dispatchEvent.mock.calls[0][0])).toBe(true)
    expect(isApplicationNavigationEvent(new Event('popstate'))).toBe(false)
  })

  it('replaces an older selection without losing unrelated URL parameters', () => {
    const url = new URL(applicationUrl('https://applymate.test/path?page=jobs&highlight=old&custom=keep', 'new'))
    expect(url.pathname).toBe('/path')
    expect(url.searchParams.getAll('highlight')).toEqual(['new'])
    expect(url.searchParams.get('custom')).toBe('keep')
  })

  it('opens an existing session without creating an application or keeping a stale job selection', async () => {
    href += '&unused' // the hash is preserved verbatim too
    const current = new URL(href)
    current.searchParams.set('highlight', 'old-job')
    href = current.toString()
    await openApplicationSession('session-42', navigate)

    const url = new URL(href)
    expect(url.searchParams.get('sessionId')).toBe('session-42')
    expect(url.searchParams.has('highlight')).toBe(false)
    expect(url.searchParams.get('jobsPage')).toBe('3')
    expect(url.searchParams.has('resumeId')).toBe(false)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('agent')
  })

  it('does not navigate without a real target', async () => {
    await openApplication('', navigate)
    await openApplicationSession(' ', navigate)
    expect(navigate).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('leaves the previous history entry intact when navigating between pages', async () => {
    const original = href
    const entries = [href]
    replaceState.mockImplementationOnce((_state, _title, next) => { href = next; entries[entries.length - 1] = next })
    const pushPage = (page: string) => {
      const url = new URL(href)
      url.searchParams.set('page', page)
      href = url.toString()
      entries.push(href)
    }
    await openApplication('job-42', pushPage)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toBe(original)
    expect(new URL(entries[1]).searchParams.get('page')).toBe('jobs')
    expect(new URL(entries[1]).searchParams.get('highlight')).toBe('job-42')
  })

  it('opens recent attention without stale selection while retaining list context', async () => {
    const url = new URL(href)
    url.searchParams.set('highlight', 'old-job')
    href = url.toString()
    expect(await openApplicationAttention(navigate)).toBe(true)
    const next = new URL(href)
    expect(next.searchParams.get('jobsAttention')).toBe('1')
    expect(next.searchParams.has('highlight')).toBe(false)
    expect(next.searchParams.get('jobsPage')).toBe('3')
    expect(next.searchParams.get('jobsStatus')).toBe('saved')
    expect(next.searchParams.get('jobsQuery')).toBe('backend')
    expect(next.hash).toBe('#details')
    expect(next.searchParams.has('resumeId')).toBe(false)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('jobs')
    expect(isApplicationNavigationEvent(dispatchEvent.mock.calls[0][0])).toBe(true)
  })

  it('does not modify the URL for a pending or rejected attention navigation', async () => {
    const original = href
    let finish!: (allowed: boolean) => void
    const result = openApplicationAttention(() => new Promise<boolean>(resolve => { finish = resolve }))
    expect(replaceState).not.toHaveBeenCalled()
    finish(false)
    expect(await result).toBe(false)
    expect(href).toBe(original)
    expect(replaceState).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('notifies the mounted job list when opening another job on the same page', async () => {
    href = 'https://applymate.test/?page=jobs&highlight=first&jobsPage=3'
    await openApplication('second', navigate)
    expect(new URL(href).searchParams.get('highlight')).toBe('second')
    expect(dispatchEvent).toHaveBeenCalledOnce()
    expect(dispatchEvent.mock.calls[0][0].type).toBe('popstate')
  })

  it.each(['job', 'session'])('does not touch history while the %s navigation guard is pending or fails', async kind => {
    const original = href
    let finish!: (allowed: boolean) => void
    const guardedNavigate = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const result = kind === 'job' ? openApplication('job-1', guardedNavigate) : openApplicationSession('session-1', guardedNavigate)
    expect(href).toBe(original)
    expect(replaceState).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
    finish(false)
    expect(await result).toBe(false)
    expect(href).toBe(original)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('waits for the navigation guard before updating the selected job', async () => {
    let finish!: (allowed: boolean) => void
    const result = openApplication('job-1', () => new Promise<boolean>(resolve => { finish = resolve }))
    expect(replaceState).not.toHaveBeenCalled()
    finish(true)
    expect(await result).toBe(true)
    expect(new URL(href).searchParams.get('highlight')).toBe('job-1')
  })
})

describe('returning from a resume editor', () => {
  it('opens clean materials without saving them again', async () => {
    const save = vi.fn()
    expect(await openApplicationWhenSaved('job-1', navigate, {
      isSaving: () => false, hasChanges: () => false, save,
    })).toBe(true)
    expect(save).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('jobs')
  })

  it('waits for a successful save before leaving', async () => {
    let dirty = true
    let finish!: (value: boolean) => void
    const save = vi.fn(() => new Promise<boolean>(resolve => { finish = resolve }))
    const result = openApplicationWhenSaved('job-1', navigate, {
      isSaving: () => false, hasChanges: () => dirty, save,
    })
    expect(navigate).not.toHaveBeenCalled()
    dirty = false
    finish(true)
    expect(await result).toBe(true)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('jobs')
  })

  it('stays in the editor when saving fails', async () => {
    expect(await openApplicationWhenSaved('job-1', navigate, {
      isSaving: () => false, hasChanges: () => true, save: async () => false,
    })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('waits for an in-flight save and any later edits before navigating', async () => {
    let saving = true
    let dirty = true
    let finish!: (value: boolean) => void
    const ongoingSave = new Promise<boolean>(resolve => { finish = resolve })
    const save = vi.fn(() => ongoingSave)
    const result = openApplicationWhenSaved('job-1', navigate, {
      isSaving: () => saving, hasChanges: () => dirty, save,
    })
    expect(navigate).not.toHaveBeenCalled()
    saving = false
    dirty = false
    finish(true)
    expect(await result).toBe(true)
    expect(save).toHaveBeenCalledOnce()
    expect(navigate).toHaveBeenCalledOnce()
  })

  it('stays if edits remain or another save started while awaiting a save', async () => {
    let saving = false
    expect(await openApplicationWhenSaved('job-1', navigate, {
      isSaving: () => saving,
      hasChanges: () => true,
      save: async () => { saving = true; return true },
    })).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })
})
