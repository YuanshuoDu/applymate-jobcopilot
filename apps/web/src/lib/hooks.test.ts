import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiMutate, fetchWithTimeout, useApi } from './hooks'
import { clearCachedApiResponses, getCachedApiResponse, setCachedApiResponse } from './api-cache'

const lifecycle = vi.hoisted(() => ({
  userId: 'account-a' as string | null,
  state: [] as unknown[],
  cursor: 0,
  effect: undefined as (() => void | (() => void)) | undefined,
}))

vi.mock('next-auth/react', () => ({
  useSession: () => ({
    status: lifecycle.userId ? 'authenticated' : 'loading',
    data: lifecycle.userId ? { user: { id: lifecycle.userId } } : null,
  }),
}))
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = lifecycle.cursor++
    if (!(index in lifecycle.state)) lifecycle.state[index] = typeof initial === 'function' ? initial() : initial
    return [lifecycle.state[index], (value: unknown) => { lifecycle.state[index] = typeof value === 'function' ? value(lifecycle.state[index]) : value }]
  },
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void | (() => void)) => { lifecycle.effect = effect },
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, resolve, reject }
}

function readApi<T>(url: string, options: Parameters<typeof useApi>[1] = {}) {
  lifecycle.cursor = 0
  return useApi<T>(url, options)
}

// The node suite controls effect setup/cleanup explicitly; fetch and body decoding
// execute the real hook implementation, with no timer-based race assumptions.
function mountApi<T>(url: string, options: Parameters<typeof useApi>[1] = {}) {
  const api = readApi<T>(url, options)
  const cleanup = lifecycle.effect?.()
  return { api, read: () => readApi<T>(url, options), cleanup: () => { if (cleanup) cleanup() } }
}

describe('useApi response decoding', () => {
  const cleanups: (() => void)[] = []
  beforeEach(() => {
    lifecycle.userId = 'account-a'
    lifecycle.state = []
    lifecycle.cursor = 0
    lifecycle.effect = undefined
    clearCachedApiResponses()
  })
  afterEach(() => {
    cleanups.splice(0).forEach(cleanup => cleanup())
    vi.unstubAllGlobals()
    vi.useRealTimers()
    clearCachedApiResponses()
  })

  it.each([
    [0, 'reject'], [0, 'resolve'], [30_000, 'reject'], [30_000, 'resolve'],
  ] as const)('ignores the cancelled old account body with timeout %i and late %s', async (timeoutMs, completion) => {
    const oldBody = deferred<{ plans: string[] }>()
    const newBody = deferred<{ plans: string[] }>()
    const oldJson = vi.fn(() => oldBody.promise)
    const newJson = vi.fn(() => newBody.promise)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: oldJson })
      .mockResolvedValueOnce({ ok: true, json: newJson })
    vi.stubGlobal('fetch', fetchMock)
    lifecycle.userId = null
    const old = mountApi<{ plans: string[] }>('/api/plans', { timeoutMs })
    cleanups.push(old.cleanup)
    await vi.waitFor(() => expect(oldJson).toHaveBeenCalledOnce())
    const oldSignal = (fetchMock.mock.calls[0][1] as RequestInit).signal

    lifecycle.userId = 'account-b'
    old.cleanup()
    expect(oldSignal?.aborted).toBe(true)
    const current = mountApi<{ plans: string[] }>('/api/plans', { timeoutMs })
    cleanups.push(current.cleanup)
    await vi.waitFor(() => expect(newJson).toHaveBeenCalledOnce())
    newBody.resolve({ plans: ['current'] })
    await vi.waitFor(() => expect(current.read()).toMatchObject({ data: { plans: ['current'] }, loading: false, error: null }))

    if (completion === 'reject') oldBody.reject(new DOMException('Aborted during body decoding', 'AbortError'))
    else oldBody.resolve({ plans: ['stale'] })
    // Flush the awaited body, its fallback, and the load continuation before asserting.
    await oldBody.promise.catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    expect(current.read()).toMatchObject({ data: { plans: ['current'] }, loading: false, error: null })
    expect(getCachedApiResponse('/api/plans', null)).toBeNull()
    expect(getCachedApiResponse('/api/plans', 'account-b')).toEqual({ plans: ['current'] })
  })

  it.each(['reject', 'resolve'] as const)('reports a timeout during body decoding even when the body later %ss', async completion => {
    vi.useFakeTimers()
    const body = deferred<{ count: number }>()
    const json = vi.fn(() => body.promise)
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json })
    vi.stubGlobal('fetch', fetchMock)
    const current = mountApi('/api/slow', { timeoutMs: 1000 })
    cleanups.push(current.cleanup)
    await Promise.resolve()
    expect(json).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1000)
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true)
    if (completion === 'reject') body.reject(new DOMException('Aborted', 'AbortError'))
    else body.resolve({ count: 3 })
    await vi.advanceTimersByTimeAsync(0)
    expect(current.read()).toMatchObject({ data: null, loading: false, error: 'Request timed out after 1 seconds. Try refreshing.' })
    expect(getCachedApiResponse('/api/slow', 'account-a')).toBeNull()
  })

  it('ignores an old decode timeout after its owner is cancelled without clearing the new loading state', async () => {
    vi.useFakeTimers()
    const oldBody = deferred<unknown>()
    const newBody = deferred<{ count: number }>()
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => oldBody.promise })
      .mockResolvedValueOnce({ ok: true, json: () => newBody.promise }))
    const old = mountApi('/api/old', { timeoutMs: 1000 })
    cleanups.push(old.cleanup)
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(1000)
    old.cleanup()
    const current = mountApi('/api/current', { timeoutMs: 1000 })
    cleanups.push(current.cleanup)
    oldBody.reject(new DOMException('Aborted', 'AbortError'))
    await vi.advanceTimersByTimeAsync(0)
    expect(current.read()).toMatchObject({ data: null, loading: true, error: null })
    newBody.resolve({ count: 4 })
    await vi.advanceTimersByTimeAsync(0)
    expect(current.read()).toMatchObject({ data: { count: 4 }, loading: false, error: null })
    expect(getCachedApiResponse('/api/old', 'account-a')).toBeNull()
  })

  it('preserves manual refresh loading, HTTP errors and retry recovery', async () => {
    const refreshedBody = deferred<{ count: number }>()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1 }) })
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Try later' }) })
      .mockResolvedValueOnce({ ok: true, json: () => refreshedBody.promise })
    vi.stubGlobal('fetch', fetchMock)
    const current = mountApi('/api/usage', { cache: false })
    cleanups.push(current.cleanup)
    await vi.waitFor(() => expect(current.read().data).toEqual({ count: 1 }))
    await current.api.refetch()
    expect(current.read()).toMatchObject({ data: { count: 1 }, loading: false, error: 'Try later' })
    const retry = current.api.refetch()
    expect(current.read()).toMatchObject({ data: { count: 1 }, loading: true, error: null })
    refreshedBody.resolve({ count: 2 })
    await retry
    expect(current.read()).toMatchObject({ data: { count: 2 }, loading: false, error: null })
    expect(getCachedApiResponse('/api/usage', 'account-a')).toBeNull()
  })

  it('keeps usable cached data when a background refresh fails', async () => {
    setCachedApiResponse('/api/plans', { plans: ['saved'] }, 'account-a')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')))
    const current = mountApi('/api/plans')
    cleanups.push(current.cleanup)
    await Promise.resolve()
    expect(current.read()).toMatchObject({ data: { plans: ['saved'] }, loading: false, error: null })
    expect(getCachedApiResponse('/api/plans', 'account-a')).toEqual({ plans: ['saved'] })
  })
})

describe('apiMutate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('adds a unique idempotency key to admin mutation requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', { location: { origin: 'https://admin.applymate.site' } })

    await apiMutate('/api/admin/v1/plans', 'PATCH', { plans: [] })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers.Origin).toBe('https://admin.applymate.site')
    expect(headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('turns a slow request into a visible timeout error', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const request = fetchWithTimeout('/api/admin/v1/applications', {}, 1_000)
    const rejection = expect(request).rejects.toThrow('Request timed out after 1 seconds')
    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
  })
})
