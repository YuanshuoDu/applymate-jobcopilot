import { afterEach, describe, expect, it, vi } from 'vitest'

import type { AgentTaskWaitResponse } from '@/app/api/agent/sessions/[id]/tasks/[taskId]/waits/wait-projection'
import { createAgentTaskWaitRefreshController, parseAgentTaskWaitResponse, type AgentTaskWaitEnvironment, type AgentTaskWaitState } from './use-agent-task-wait'

const deadline = '2026-10-27T12:00:00.000Z'
const waiting: AgentTaskWaitResponse = { wait: {
  mode: 'all', status: 'waiting', deadlineAt: deadline, parentDeadlineAt: '2026-10-27T12:30:00.000Z',
  targets: [{ taskId: 'child-1', label: 'Scout', status: 'completed', matched: true }],
} }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

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
  const controller = createAgentTaskWaitRefreshController({
    sessionId: 'session/a', parentTaskId: 'parent b', lifecycleRevision: 0, fetcher, environment,
    onState: state => states.push(state),
  })
  return {
    controller, states, emit,
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
    expect(parseAgentTaskWaitResponse({ wait: { ...waiting.wait, parentDeadlineAt: null } })?.wait?.parentDeadlineAt).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waiting.wait, waitId: 'secret' } })).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waiting.wait, targets: [...waiting.wait.targets, ...waiting.wait.targets] } })).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waiting.wait, deadlineAt: 'tomorrow' } })).toBeNull()
    expect(parseAgentTaskWaitResponse({ wait: { ...waiting.wait, parentDeadlineAt: 'tomorrow' } })).toBeNull()
  })

  it('uses the authenticated same-origin, uncached endpoint and polls no faster than 30 seconds', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const fetcher = vi.fn<typeof fetch>(async () => response(waiting))
    const test = harness(fetcher)
    test.controller.start(); await flush()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith('/api/agent/sessions/session%2Fa/tasks/parent%20b/waits', expect.objectContaining({
      method: 'GET', credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
    }))
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it('coalesces lifecycle refreshes during a request and never overlaps them', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    let resolveFirst: ((value: Response) => void) | undefined
    const first = new Promise<Response>(resolve => { resolveFirst = resolve })
    let active = 0
    let maxActive = 0
    const fetcher = vi.fn<typeof fetch>(async () => {
      active += 1; maxActive = Math.max(maxActive, active)
      if (fetcher.mock.calls.length === 1) return first.finally(() => { active -= 1 })
      active -= 1
      return response(waiting)
    })
    const test = harness(fetcher)
    test.controller.start()
    test.controller.updateLifecycle(1)
    test.controller.updateLifecycle(2)
    test.focus()
    expect(fetcher).toHaveBeenCalledTimes(1)
    resolveFirst?.(response({ wait: null }))
    await flush(); await vi.advanceTimersByTimeAsync(0); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(maxActive).toBe(1)
    test.controller.stop()
  })

  it('discards a response from an older lifecycle before publishing it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    let resolveFirst: ((value: Response) => void) | undefined
    const first = new Promise<Response>(resolve => { resolveFirst = resolve })
    const stale: AgentTaskWaitResponse = { wait: { ...waiting.wait!, targets: [{ ...waiting.wait!.targets[0]!, label: 'Stale' }] } }
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => first).mockResolvedValueOnce(response(waiting))
    const test = harness(fetcher)
    test.controller.start()
    test.controller.updateLifecycle(1)
    resolveFirst?.(response(stale)); await flush(); await vi.advanceTimersByTimeAsync(0); await flush()
    expect(test.states.some(state => state.wait?.targets[0]?.label === 'Stale')).toBe(false)
    expect(test.states.at(-1)?.wait?.targets[0]?.label).toBe('Scout')
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
    test.controller.start(); await flush()
    expect(test.listenerCount()).toBe(2)
    test.hide()
    expect(signals[0]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetcher).toHaveBeenCalledTimes(1)
    test.show(); await vi.advanceTimersByTimeAsync(0); await flush()
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
    test.controller.start(); await flush()
    test.controller.updateLifecycle(1); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(399)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); await flush()
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
    test.controller.start(); await flush()
    test.hide()
    test.controller.updateLifecycle(1)
    test.show(); await vi.advanceTimersByTimeAsync(0); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(400); await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(test.states.at(-1)?.phase).toBe('available')
    test.controller.stop()
  })

  it('marks an overdue deadline locally and revalidates that deadline once', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:59:59.000Z'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(waiting))
    const test = harness(fetcher)
    test.controller.start(); await flush()
    expect(test.states.at(-1)).toMatchObject({ phase: 'available', due: null })
    await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(test.states.at(-1)).toMatchObject({ phase: 'available', due: 'wait' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(2)
    test.controller.stop()
  })

  it('revalidates once at the earlier parent deadline while displaying both dates', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-27T11:00:00.000Z'))
    const earlierParent = { wait: { ...waiting.wait!, deadlineAt: '2026-10-27T11:00:10.000Z', parentDeadlineAt: '2026-10-27T11:00:01.000Z' } }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(earlierParent))
    const test = harness(fetcher)
    test.controller.start(); await flush()
    expect(test.states.at(-1)?.due).toBeNull()
    await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(test.states.at(-1)?.due).toBe('parent')
    expect(test.states.at(-1)?.wait?.deadlineAt).toBe('2026-10-27T11:00:10.000Z')
    expect(test.states.at(-1)?.wait?.parentDeadlineAt).toBe('2026-10-27T11:00:01.000Z')
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(fetcher).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1); await flush()
    expect(fetcher).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fetcher).toHaveBeenCalledTimes(3)
    test.controller.stop()
  })
})
