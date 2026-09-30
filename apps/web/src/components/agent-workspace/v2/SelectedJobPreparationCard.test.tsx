import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }) }))

import { fetchRestoredSavedJob, restoredJobScopeKey, scopedValueForKey, SelectedJobPreparationCard, shouldLoadRestoredJob } from './SelectedJobPreparationCard'

describe('SelectedJobPreparationCard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('restores an older saved job omitted from page one and scopes the result to its session', async () => {
    const pageOne = [{ id: 'recent-job', company: 'Recent Systems', role: 'Engineer', eligibleForPreparation: true }]
    expect(shouldLoadRestoredJob(pageOne, 'older-job')).toBe(true)
    expect(shouldLoadRestoredJob([...pageOne, { id: 'older-job', company: 'Older Systems', role: 'Engineer', eligibleForPreparation: true }], 'older-job')).toBe(false)

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      id: 'older-job', company: 'Older Systems', role: 'Staff Engineer', status: 'saved',
      description: 'private job details', notes: 'private notes', userId: 'private-user',
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const job = await fetchRestoredSavedJob('older-job', new AbortController().signal)
    expect(fetchMock).toHaveBeenCalledWith('/api/jobs/older-job', expect.objectContaining({ cache: 'no-store' }))
    expect(job).toEqual({ id: 'older-job', company: 'Older Systems', role: 'Staff Engineer', eligibleForPreparation: true })

    const scopeA = restoredJobScopeKey('user-1', 'session-a', 'older-job')
    const scopeB = restoredJobScopeKey('user-1', 'session-b', 'older-job')
    const scopedState = { scope: scopeA!, value: { job, loading: false } }
    expect(scopedValueForKey(scopedState, scopeA)?.job).toEqual(job)
    expect(scopedValueForKey(scopedState, scopeB)).toBeNull()
  })

  it('keeps unavailable job details out of the restored options after a 404', async () => {
    expect(shouldLoadRestoredJob([], '  invalid-id  ')).toBe(false)
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: 'Not found' }), { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchRestoredSavedJob('missing-job', new AbortController().signal)).resolves.toBeNull()
  })
  it('clearly limits the action to one saved job and draft preparation', () => {
    const html = renderToStaticMarkup(<SelectedJobPreparationCard sessionId="session-1" onAccepted={vi.fn()} />)
    expect(html).toContain('data-selected-job-preparation="true"')
    expect(html).toContain('Prepare a draft for one job')
    expect(html).toContain('will not submit an application or contact the employer')
    expect(html).toContain('disabled=""')
  })
})
