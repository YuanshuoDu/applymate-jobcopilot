import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentTaskWaitDto, AgentTaskWaitResponse } from '@/app/api/agent/sessions/[id]/tasks/[taskId]/waits/wait-projection'
import { createAgentTaskWaitRefreshController, parseAgentTaskWaitResponse, type AgentTaskWaitEnvironment, type AgentTaskWaitState } from './use-agent-task-wait'

const deadline = '2026-10-27T12:00:00.000Z'
const waitingWait: AgentTaskWaitDto = {
  mode: 'all', status: 'waiting', deadlineAt: deadline, parentDeadlineAt: '2026-10-27T12:30:00.000Z',
  targets: [{ taskId: 'child-1', label: 'scout', status: 'completed', matched: true }],
}
const waiting: AgentTaskWaitResponse = { wait: waitingWait }
const nativeSetTimeout = globalThis.setTimeout.bind(globalThis)
const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis)
const WAIT_FOR_STATE_TIMEOUT_MS = 2_000
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = nativeSetTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), WAIT_FOR_STATE_TIMEOUT_MS)
    promise.then(value => { nativeClearTimeout(timeout); resolve(value) }, error => { nativeClearTimeout(timeout); reject(error) })
  })
}
const response = (value: unknown, onJsonRead?: () => void): Response => {
  const result = new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  if (!onJsonRead) return result
  const nativeJson = result.json.bind(result)
  Object.defineProperty(result, 'json', { value: () => nativeJson().then(parsed => { onJsonRead(); return parsed }) })
  return result
}
function streamedResponse(value: unknown) {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let signalJsonStarted!: () => void
  let resolveParsed!: (parsed: unknown) => void
  const jsonStarted = new Promise<void>(resolve => { signalJsonStarted = resolve })
  const jsonRead = new Promise<unknown>(resolve => { resolveParsed = resolve })
  const stream = new ReadableStream<Uint8Array>({ start: controller => { streamController = controller } })
  const result = new Response(stream, { headers: { 'content-type': 'application/json' } })
  const nativeJson = result.json.bind(result)
  Object.defineProperty(result, 'json', { value: () => {
    signalJsonStarted()
    const parsed = nativeJson()
    void parsed.then(resolveParsed)
    return parsed
  } })
  return {
    response: result, jsonStarted, jsonRead,
    release: () => { streamController?.enqueue(new TextEncoder().encode(JSON.stringify(value))); streamController?.close() },
  }
}

function harness(fetcher: typeof fetch, initiallyVisible = true) {
  let visible = initiallyVisible
  const listeners = new Map<string, Set<() => void>>()
  const environment: AgentTaskWaitEnvironment = {
    now: () => Date.now(), isVisible: () => visible,
    subscribe: (event, callback) => {
      const entries = listeners.get(event) ?? new Set<() => void>()
      entries.add(callback); listeners.set(event, entries)
      return () => entries.delete(callback)
    },
  }
  const emit = (event: string) => listeners.get(event)?.forEach(callback => callback())
  const states: AgentTaskWaitState[] = []
  const stateListeners = new Set<(state: AgentTaskWaitState) => void>()
  const controller = createAgentTaskWaitRefreshController({
    sessionId: 'session/a', parentTaskId: 'parent b', lifecycleRevision: 0, fetcher, environment,
    onState: state => { states.push(state); stateListeners.forEach(listener => listener(state)) },
  })
  const waitForState = (predicate: (state: AgentTaskWaitState) => boolean, afterIndex = 0) => {
    const existing = states.slice(afterIndex).find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise<AgentTaskWaitState>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>
      const listener = (state: AgentTaskWaitState) => {
        if (!predicate(state)) return
        stateListeners.delete(listener)
        nativeClearTimeout(timeout)
        resolve(state)
      }
      timeout = nativeSetTimeout(() => {
        stateListeners.delete(listener)
        reject(new Error('Timed out waiting for agent task wait state'))
      }, WAIT_FOR_STATE_TIMEOUT_MS)
      stateListeners.add(listener)
    })
  }
  const waitForRefreshCompletion = (afterIndex: number) => {
    let sawLoading = false
    return waitForState(state => {
      if (state.loading) sawLoading = true
      return sawLoading && !state.loading
    }, afterIndex)
  }
  return {
    controller, states, emit, waitForState, waitForRefreshCompletion,
    hide: () => { visible = false; emit('visibilitychange') },
    show: () => { visible = true; emit('visibilitychange') },
    focus: () => emit('focus'),
    listenerCount: () => [...listeners.values()].reduce((sum, items) => sum + items.size, 0),
  }
}

describe('Agent task wait refresh controller', () => {
  afterEach(() => { vi.useRealTimers() })

  it('accepts only the bounded public DTO shape', () => {
    expect(parseAgentTaskWaitResponse(waiting)).toEqual(waiting)
    expect(parseAgentTaskWaitResponse({ wait: null })).toEqual({ wait: null })
    expect(parseAgentTaskWaitResponse({ wait: { ...waitingWait, parentDeadlineAt: null } })?.wait?.parentDeadlineAt).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waitingWait, waitId: 'secret' } })).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waitingWait, targets: [...waitingWait.targets, ...waitingWait.targets] } })).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waitingWait, deadlineAt: 'tomorrow' } })).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waitingWait, parentDeadlineAt: 'tomorrow' } })).toBeNull()
  })

  it('uses the authenticated same-origin, uncached endpoint and polls no faster than 30 seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const fetcher = vi.fn<typeof fetch>(async () => response(waiting))
    const test = harness(fetcher)
    test.controller.start()
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session%2Fa/tasks/parent%20b/waits', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
    }))
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    const beforePoll = test.states.length
    const poll = test.waitForRefreshCompletion(beforePoll)
    await vi.advanceTimersByTimeAsync(1)
    await poll
    expect(fetcher).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it('coalesces lifecycle refreshes during real Response.json parsing and never overlaps them', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const first = streamedResponse({ wait: null })
    let active = 0
    let maxActive = 0
    let firstBodyParsed = false
    const fetcher = vi.fn<typeof fetch>(async () => {
      active += 1; maxActive = Math.max(maxActive, active)
      if (fetcher.mock.calls.length === 1) {
        void first.jsonRead.then(() => { active -= 1; firstBodyParsed = true })
        return first.response
      }
      return response(waiting, () => { active -= 1 })
    })
    const test = harness(fetcher)
    test.controller.start()
    await withTimeout(first.jsonStarted, 'first response parsing start')
    test.controller.updateLifecycle(1)
    test.controller.updateLifecycle(2)
    test.focus()
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(active).toBe(1)
    expect(firstBodyParsed).toBe(false)
    first.release()
    await withTimeout(first.jsonRead, 'first response body parse')
    expect(firstBodyParsed).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    test.controller.stop()
  })

  it('discards a response from an older lifecycle before publishing it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const stale: AgentTaskWaitResponse = { wait: { ...waitingWait, targets: [{ ...waitingWait.targets[0]!, label: 'analyst' }] } }
    const first = streamedResponse(stale)
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => first.response).mockResolvedValueOnce(response(waiting))
    const test = harness(fetcher)
    test.controller.start()
    await withTimeout(first.jsonStarted, 'first response parsing start')
    test.controller.updateLifecycle(1)
    first.release()
    await withTimeout(first.jsonRead, 'first response body parse')

    await vi.advanceTimersByTimeAsync(0)
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(test.states.some(state => state.wait?.targets[0]?.label === 'analyst')).toBe(false)
    expect(test.states.at(-1)?.wait?.targets[0]?.label).toBe('scout')
    expect(fetcher).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it('aborts and stops polling while hidden, refreshes on return, and cleans listeners on unmount', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const signals: AbortSignal[] = []
    let calls = 0
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      signals.push(init?.signal as AbortSignal)
      calls += 1
      if (calls === 1) return new Promise<Response>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      return Promise.resolve(response(waiting))
    })
    const test = harness(fetcher)
    test.controller.start()
    expect(test.listenerCount()).toBe(2)
    test.hide()
    expect(signals[0]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    test.show(); await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
    test.controller.stop()
    expect(test.listenerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('retries one delayed registration after a lifecycle refresh returns no wait', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ wait: null }))
      .mockResolvedValueOnce(response({ wait: null }))
      .mockResolvedValueOnce(response(waiting))
    const test = harness(fetcher)
    test.controller.start()
    await test.waitForState(state => state.phase === 'empty' && !state.loading)
    const beforeLifecycle = test.states.length
    test.controller.updateLifecycle(1)
    await test.waitForState(state => state.phase === 'empty' && !state.loading, beforeLifecycle)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(399)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(test.states.at(-1)).toMatchObject({ phase: 'available', due: null })
    test.controller.updateLifecycle(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    test.controller.stop()
  })

  it('preserves a lifecycle refresh received while hidden when the page becomes visible', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ wait: null }))
      .mockResolvedValueOnce(response({ wait: null }))
      .mockResolvedValueOnce(response(waiting))
    const test = harness(fetcher)
    test.controller.start()
    await test.waitForState(state => state.phase === 'empty' && !state.loading)
    test.hide()
    test.controller.updateLifecycle(1)
    const beforeShow = test.states.length
    test.show()
    await vi.advanceTimersByTimeAsync(0)
    await test.waitForState(state => state.phase === 'empty' && !state.loading, beforeShow)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(400)
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(test.states.at(-1)?.phase).toBe('available')
    test.controller.stop()
  })

  it('marks an overdue deadline locally and revalidates that deadline once', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:59:59.000Z'))
    const fetcher = vi.fn<typeof fetch>(async () => response(waiting))
    const test = harness(fetcher)
    test.controller.start()
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(test.states.at(-1)).toMatchObject({ phase: 'available', due: null })
    const beforeDeadline = test.states.length
    const revalidation = test.waitForRefreshCompletion(beforeDeadline)
    await vi.advanceTimersByTimeAsync(1_000)
    await revalidation
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(test.states.at(-1)).toMatchObject({ phase: 'available', due: 'wait' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it('revalidates once at the earlier parent deadline while displaying both dates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const earlierParent = { wait: { ...waitingWait, deadlineAt: '2026-10-27T11:00:10.000Z', parentDeadlineAt: '2026-10-27T11:00:01.000Z' } }
    const fetcher = vi.fn<typeof fetch>(async () => response(earlierParent))
    const test = harness(fetcher)
    test.controller.start()
    await test.waitForState(state => state.phase === 'available' && state.wait !== null)
    expect(test.states.at(-1)?.due).toBeNull()
    const beforeParentDeadline = test.states.length
    const revalidation = test.waitForRefreshCompletion(beforeParentDeadline)
    await vi.advanceTimersByTimeAsync(1_000)
    await revalidation
    expect(test.states.at(-1)?.due).toBe('parent')
    expect(test.states.at(-1)?.wait?.deadlineAt).toBe('2026-10-27T11:00:10.000Z')
    expect(test.states.at(-1)?.wait?.parentDeadlineAt).toBe('2026-10-27T11:00:01.000Z')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const beforePoll = test.states.length
    const poll = test.waitForRefreshCompletion(beforePoll)
    await vi.advanceTimersByTimeAsync(1)
    await poll
    expect(fetcher).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    test.controller.stop()
  })
})
