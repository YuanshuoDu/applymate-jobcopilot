import { afterEach, describe, expect, it, vi } from 'vitest'
import { applicationListUrl, loadLinkedApplication, readApplicationListState } from './application-list-state'

afterEach(() => vi.unstubAllGlobals())
describe('application list context', () => {
  it('retains filters, page, sorting and unrelated navigation parameters', () => {
    const state = readApplicationListState('/?jobsPage=3&jobsStatus=saved&jobsSearch=Acme&jobsSize=50&jobsSort=score&jobsDirection=asc&jobsView=kanban')
    expect(state).toEqual({ search: 'Acme', status: 'saved', page: 3, pageSize: 50, sortBy: 'score', sortDir: 'asc', view: 'kanban' })
    const url = applicationListUrl('/?page=resume&returnJobId=j1#materials', state)
    expect(readApplicationListState(url)).toEqual(state)
    expect(url).toContain('returnJobId=j1')
    expect(url).toContain('#materials')
  })
  it('normalizes untrusted query values', () => {
    expect(readApplicationListState('/?jobsPage=NaN&jobsSize=999&jobsStatus=admin&jobsSort=nope').page).toBe(1)
    expect(readApplicationListState('/?jobsPage=-1').page).toBe(1)
    expect(readApplicationListState('/?jobsStatus=admin').status).toBe('all')
  })
  it('loads the exact job independently of the current list page', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'outside-page' }) })
    vi.stubGlobal('fetch', fetcher)
    await expect(loadLinkedApplication('outside-page', new AbortController().signal)).resolves.toEqual({ id: 'outside-page' })
    expect(fetcher.mock.calls[0][0]).toBe('/api/jobs/outside-page')
  })
  it('does not open a missing or mismatched application', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }))
    await expect(loadLinkedApplication('missing', new AbortController().signal)).rejects.toThrow('unavailable')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'other' }) }))
    await expect(loadLinkedApplication('expected', new AbortController().signal)).rejects.toThrow('unavailable')
  })
})
