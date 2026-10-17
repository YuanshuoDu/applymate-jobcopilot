import { describe, expect, it, vi } from 'vitest'

import { createQuestionHydrationPump, filterQuestionHydrationValues, type FinalItemHydrationTarget } from './question-hydration'

function questionStub(questionId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'agent-harness.v2', id: `event-${questionId}`, sessionId: 'session-1', turnId: 'turn-1',
    itemId: `item-${questionId}`, taskId: null, type: 'item.started', actor: 'orchestrator', sequence: '1',
    payload: { itemId: `item-${questionId}`, waitKind: 'question', questionId, toolCallId: null }, ...overrides,
  }
}

function finalStub(overrides: Record<string, unknown> = {}) {
  const itemId = 'turn:turn-1:item:final:step-1'
  return {
    schemaVersion: 'agent-harness.v2', id: 'turn:turn-1:event:turn-completed', sessionId: 'session-1', turnId: 'turn-1',
    itemId, taskId: 'task-1', type: 'turn.completed', actor: 'orchestrator', sequence: '2',
    payload: { turnId: 'turn-1', taskId: 'task-1', finalItemId: itemId, usage: {} }, ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail })
  return { promise, resolve, reject }
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
    const hydrateFinalItem = vi.fn<(target: FinalItemHydrationTarget) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', signal: controller.signal, hydrate, hydrateFinalItem })

    controller.abort()
    pump.request(questionStub('one'))
    pump.request(finalStub())
    pump.pump()
    await Promise.resolve()

    expect(hydrate).not.toHaveBeenCalled()
    expect(hydrateFinalItem).not.toHaveBeenCalled()
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

  it('schedules a colon-bearing final item once across a batch and later redelivery', async () => {
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>().mockResolvedValue(undefined)
    const hydrateFinalItem = vi.fn<(target: FinalItemHydrationTarget) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', hydrate, hydrateFinalItem })
    const target = { itemId: 'turn:turn-1:item:final:step-1', turnId: 'turn-1' }

    pump.request(finalStub())
    pump.request(finalStub())
    await Promise.resolve()
    const current = pump.current()
    if (current) await current
    pump.request(finalStub({ sequence: '3' }))
    await Promise.resolve()

    expect(hydrateFinalItem).toHaveBeenCalledTimes(1)
    expect(hydrateFinalItem).toHaveBeenCalledWith(target)
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('ignores foreign, mismatched, malformed, and non-orchestrator completions', async () => {
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>().mockResolvedValue(undefined)
    const hydrateFinalItem = vi.fn<(target: FinalItemHydrationTarget) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', hydrate, hydrateFinalItem })

    pump.request(finalStub({ sessionId: 'session-2' }))
    pump.request(finalStub({ itemId: 'turn:turn-1:item:final:other' }))
    pump.request(finalStub({ payload: { turnId: 'turn-2', taskId: 'task-1', finalItemId: 'turn:turn-1:item:final:step-1' } }))
    pump.request(finalStub({ payload: { turnId: 'turn-1', taskId: 'task-2', finalItemId: 'turn:turn-1:item:final:step-1' } }))
    pump.request(finalStub({ actor: 'user' }))
    pump.request(finalStub({ sequence: null }))
    pump.request(finalStub({ turnId: 'turn-\u0001' }))
    await Promise.resolve()

    expect(hydrateFinalItem).not.toHaveBeenCalled()
    expect(hydrate).not.toHaveBeenCalled()
  })

  it('drains a completion queued during a failed question batch without retrying that batch', async () => {
    const question = deferred<void>()
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>()
      .mockReturnValueOnce(question.promise)
      .mockResolvedValue(undefined)
    const hydrateFinalItem = vi.fn<(target: FinalItemHydrationTarget) => Promise<void>>().mockResolvedValue(undefined)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', hydrate, hydrateFinalItem })

    pump.request(questionStub('one'))
    await Promise.resolve()
    const questionRun = pump.current()
    expect(hydrate).toHaveBeenCalledTimes(1)

    pump.request(finalStub())
    question.reject(new Error('temporary page failure'))
    if (questionRun) await questionRun
    await Promise.resolve()
    const finalRun = pump.current()
    if (finalRun) await finalRun

    expect(hydrate).toHaveBeenCalledTimes(1)
    expect(hydrateFinalItem).toHaveBeenCalledTimes(1)
    expect(hydrateFinalItem).toHaveBeenCalledWith({ itemId: 'turn:turn-1:item:final:step-1', turnId: 'turn-1' })
  })

  it('resumes question batching after a new question arrives during a final-only drain', async () => {
    const question = deferred<void>()
    const final = deferred<void>()
    const hydrate = vi.fn<(itemIds: readonly string[]) => Promise<void>>()
      .mockReturnValueOnce(question.promise)
      .mockResolvedValue(undefined)
    const hydrateFinalItem = vi.fn<(target: FinalItemHydrationTarget) => Promise<void>>().mockReturnValueOnce(final.promise)
    const pump = createQuestionHydrationPump({ sessionId: 'session-1', hydrate, hydrateFinalItem })

    pump.request(questionStub('one'))
    await Promise.resolve()
    const questionRun = pump.current()
    pump.request(finalStub())
    question.reject(new Error('temporary page failure'))
    if (questionRun) await questionRun
    await Promise.resolve()
    const finalRun = pump.current()
    expect(hydrateFinalItem).toHaveBeenCalledTimes(1)

    pump.request(questionStub('two'))
    final.resolve()
    if (finalRun) await finalRun
    await Promise.resolve()
    const retryRun = pump.current()
    if (retryRun) await retryRun

    expect(hydrate).toHaveBeenCalledTimes(2)
    expect(hydrate.mock.calls[0]?.[0]).toEqual(['item-one'])
    expect(hydrate.mock.calls[1]?.[0]).toEqual(['item-one', 'item-two'])
  })
})
