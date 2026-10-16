import { describe, expect, it, vi } from 'vitest'

import { createFinalItemHydrationPump, createQuestionHydrationPump, filterQuestionHydrationValues } from './question-hydration'

function questionStub(questionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: `event-${questionId}`, sessionId: 'session-1', turnId: 'turn-1',
    itemId: `item-${questionId}`, taskId: null, type: 'item.started', actor: 'orchestrator', sequence: '1',
    payload: { itemId: `item-${questionId}`, waitKind: 'question', questionId, toolCallId: null }, ...overrides,
  }
}

function completedTurn(itemId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: `completion-${itemId ?? 'unowned'}`, sessionId: 'session-1', turnId: 'turn-1',
    itemId, taskId: null, type: 'turn.completed', actor: 'orchestrator', sequence: '2',
    payload: { turnId: 'turn-1', taskId: 'root-task', finalItemId: itemId }, ...overrides,
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

describe('final item hydration pump', () => {
  it('hydrates only a matching owned completion and coalesces duplicate delivery', async () => {
    const hydrate = vi.fn<(itemId: string) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createFinalItemHydrationPump({ sessionId: 'session-1', hydrate })

    pump.request(completedTurn('final-item'))
    pump.request(completedTurn('final-item', { id: 'completion-duplicate', sequence: '3' }))
    pump.request(completedTurn('other-item', { payload: { finalItemId: 'final-item' } }))
    pump.request(completedTurn('foreign-item', { sessionId: 'session-2' }))
    pump.request(completedTurn(null, { payload: { finalItemId: 'final-item' } }))
    pump.request(completedTurn('untrusted-item', { actor: 'subagent' }))
    await Promise.resolve()
    await pump.current()

    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(hydrate).toHaveBeenCalledWith('final-item')

    pump.request(completedTurn('final-item', { id: 'completion-redelivered', sequence: '4' }))
    await Promise.resolve()
    await pump.current()
    expect(hydrate).toHaveBeenCalledTimes(1)
  })
})
