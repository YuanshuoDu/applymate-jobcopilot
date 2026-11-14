import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveDiscoveredApplication } from './application-search-save'

const mocks = vi.hoisted(() => ({ mutate: vi.fn() }))
vi.mock('@/lib/hooks', () => ({ apiMutate: mocks.mutate }))

const result = { id: 'provider-7', company: 'Acme', title: 'Engineer', location: 'Dublin', url: 'https://jobs.example/7', description: 'TypeScript engineer', source: 'lever' }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function operation() {
  const controller = new AbortController()
  return { controller, userId: 'candidate-a', signal: controller.signal, isCurrent: () => true, onSaved: vi.fn(), onScored: vi.fn(), onError: vi.fn() }
}

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks() })

describe('Discover save scoring lifecycle', () => {
  it('does not fetch a later account resume after a delayed save resolves on an invalidated operation', async () => {
    const saving = deferred<{ data: { id: string; userId: string }; error: null }>()
    mocks.mutate.mockReturnValue(saving.promise)
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const input = operation()
    const work = saveDiscoveredApplication(result, input)
    input.controller.abort()
    saving.resolve({ data: { id: 'job-a', userId: 'candidate-a' }, error: null })
    await work
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(input.onSaved).not.toHaveBeenCalled()
    expect(input.onScored).not.toHaveBeenCalled()
  })

  it('rejects a saved response belonging to a different authenticated identity', async () => {
    mocks.mutate.mockResolvedValue({ data: { id: 'job-b', userId: 'candidate-b' }, error: null })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const input = operation()
    await saveDiscoveredApplication(result, input)
    expect(input.onSaved).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('stops before scoring when identity changes during the resume response', async () => {
    mocks.mutate.mockResolvedValue({ data: { id: 'job-a', userId: 'candidate-a' }, error: null })
    const resume = deferred<unknown>()
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: () => resume.promise })
    vi.stubGlobal('fetch', fetch)
    const input = operation()
    const work = saveDiscoveredApplication(result, input)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce())
    input.controller.abort()
    resume.resolve({ content: { summary: 'Private resume' } })
    await work
    expect(input.onSaved).toHaveBeenCalledWith('provider-7', 'job-a')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(input.onScored).not.toHaveBeenCalled()
  })

  it('does not persist a delayed score after the component is unmounted', async () => {
    mocks.mutate.mockResolvedValue({ data: { id: 'job-a', userId: 'candidate-a' }, error: null })
    const scoring = deferred<Response>()
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: { summary: 'Private resume' } }) })
      .mockReturnValueOnce(scoring.promise)
    vi.stubGlobal('fetch', fetch)
    const input = operation()
    const work = saveDiscoveredApplication(result, input)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    input.controller.abort()
    scoring.resolve(new Response(JSON.stringify({ score: 81 }), { status: 200 }))
    await work
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    expect(input.onScored).not.toHaveBeenCalled()
    expect(fetch.mock.calls[1][1].signal).toBe(input.signal)
  })

  it('saves and persists the score once while the same operation remains valid', async () => {
    mocks.mutate.mockResolvedValueOnce({ data: { id: 'job-a', userId: 'candidate-a' }, error: null }).mockResolvedValueOnce({ data: {}, error: null })
    const fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ content: { summary: 'Resume' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ score: 81, matchedKeywords: ['TypeScript'] }) })
    vi.stubGlobal('fetch', fetch)
    const input = operation()
    await saveDiscoveredApplication(result, input)
    expect(mocks.mutate).toHaveBeenCalledTimes(2)
    expect(mocks.mutate.mock.calls[1][0]).toBe('/api/jobs/job-a')
    expect(input.onSaved).toHaveBeenCalledOnce()
    expect(input.onScored).toHaveBeenCalledWith('provider-7', 81)
    expect(input.onError).not.toHaveBeenCalled()
  })
})
