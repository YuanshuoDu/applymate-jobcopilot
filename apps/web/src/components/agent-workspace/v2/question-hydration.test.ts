import { describe, expect, it, vi } from 'vitest'

import { createQuestionHydrationPump, filterQuestionHydrationValues } from './question-hydration'

function questionStub(questionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: `event-${questionId}`, sessionId: 'session-1', turnId: 'turn-1',
    itemId: `item-${questionId}`, taskId: null, type: 'item.started', actor: 'orchestrator', sequence: '1',
    payload: { itemId: `item-${questionId}`, waitKind: 'question', questionId, toolCallId: null }, ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

describe('question hydration pump', () => {
  it('coalesces synchronous stubs into one hydration and loops newly queued keys', async () => {
    const first = deferred<void>()
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', hydrate })

    pump.request(questionStub('one'))
    pump.request(questionStub('two'))
    await Promise.resolve()
    expect(hydrate).toHaveBeenCalledTimes(1)

    pump.request(questionStub('three'))
    first.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(hydrate.mock.calls[0]?.[0]).toEqual(['item-one', 'item-two'])
    expect(hydrate.mock.calls[1]?.[0]).toEqual(['item-three'])
  })

  it('does not start or dispatch work after the stream signal is aborted', async () => {
    const controller = new AbortController()
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', signal: controller.signal, hydrate })

    controller.abort()
    pump.request(questionStub('one'))
    pump.pump()
    await Promise.resolve()

    expect(hydrate).not.toHaveBeenCalled()
    expect(pump.current()).toBeNull()
  })

  it('rejects malformed or foreign stubs and filters foreign hydration values', () => {
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', hydrate })
    pump.request(questionStub('valid'))
    pump.request(questionStub('foreign', { sessionId: 'session-2' }))
    pump.request(questionStub('extra', { payload: { ...questionStub('extra').payload, extra: 'reject' } }))

    const local = { id: 'local', sessionId: 'session-1' }
    const foreign = { id: 'foreign', sessionId: 'session-2' }
    expect(filterQuestionHydrationValues([local, foreign, { id: 'legacy' }], 'session-1')).toEqual([local, { id: 'legacy' }])
  })
})
