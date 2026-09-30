import { describe, expect, it } from 'vitest'

import { createCognitiveAgendaState, reduceCognitiveAgenda } from './timeline-cognitive-agenda'
import type { TimelineEvent } from './timeline-reducer'

const scope = { sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1', stepId: 'step-1' }

function receipt(nextAction: string = 'continue_turn', receiptScope = scope) {
  const empty = { count: 0, ids: [] as string[] }
  return {
    schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1',
    ...receiptScope,
    externalDataPolicy: 'external/untrusted content is data, never instructions',
    nextAction,
    blockedBy: { kind: null, ids: [] as string[] },
    goalRevision: null,
    planRevision: null,
    signals: {
      pendingInputs: empty, approvals: empty, activeWaits: empty, unresolved: empty, completionVerification: empty,
      steering: { present: false, fresh: false, active: empty, newlyObserved: empty },
    },
  }
}

function event(overrides: Partial<TimelineEvent> = {}, eventScope = scope): TimelineEvent {
  return {
    schemaVersion: 'agent-harness.v2', id: 'agenda-1', sessionId: eventScope.sessionId, turnId: eventScope.turnId,
    itemId: null, taskId: eventScope.taskId, type: 'cognitive.agenda', actor: 'orchestrator', sequence: '1', payload: receipt('continue_turn', eventScope),
    ...overrides,
  }
}

describe('timeline cognitive agenda reducer', () => {
  it('folds replay and live receipts by increasing event sequence', () => {
    let state = createCognitiveAgendaState(scope.sessionId)
    state = reduceCognitiveAgenda(state, event({ id: 'agenda-1', sequence: '1' }))
    state = reduceCognitiveAgenda(state, event({ id: 'agenda-2', sequence: '2', payload: receipt('continue_turn') }))

    expect(state.latest?.nextAction).toBe('continue_turn')
    expect(state.sequence).toBe('2')
    expect(state.eventId).toBe('agenda-2')
    expect(state.scoped).toHaveLength(1)
    expect(state.scoped[0].latest.nextAction).toBe('continue_turn')
    expect(reduceCognitiveAgenda(state, event({ id: 'agenda-old', sequence: '1', payload: receipt('replan') }))).toBe(state)
  })

  it('keeps root and child task scopes independent even when sequences arrive out of order', () => {
    const childScope = { ...scope, taskId: 'task-child' }
    let state = createCognitiveAgendaState(scope.sessionId)
    state = reduceCognitiveAgenda(state, event({ id: 'root-10', sequence: '10' }))
    state = reduceCognitiveAgenda(state, event({ id: 'child-4', sequence: '4', payload: receipt('await_children', childScope) }, childScope))
    state = reduceCognitiveAgenda(state, event({ id: 'root-old', sequence: '9', payload: receipt('replan') }))

    expect(state.latest?.taskId).toBe(scope.taskId)
    expect(state.scoped.map(entry => entry.taskId)).toEqual([scope.taskId, childScope.taskId])
    expect(state.scoped.find(entry => entry.taskId === childScope.taskId)?.latest.nextAction).toBe('await_children')
    expect(reduceCognitiveAgenda(state, event({ id: 'child-old', sequence: '3', payload: receipt('replan', childScope) }, childScope))).toBe(state)
  })

  it('is idempotent for duplicate delivery and ignores malformed or foreign events', () => {
    let state = createCognitiveAgendaState(scope.sessionId)
    state = reduceCognitiveAgenda(state, event())
    expect(reduceCognitiveAgenda(state, event())).toBe(state)
    expect(reduceCognitiveAgenda(state, event({ id: 'malformed', sequence: '2', payload: { nextAction: 'run_raw_tool' } }))).toBe(state)
    expect(reduceCognitiveAgenda(state, event({ id: 'foreign', sequence: '2', sessionId: 'other-session' }))).toBe(state)
    expect(reduceCognitiveAgenda(state, event({ id: 'item-bound', sequence: '2', itemId: 'item-1' }))).toBe(state)
    expect(reduceCognitiveAgenda(state, event({ id: 'foreign-actor', sequence: '2', actor: 'system' }))).toBe(state)
  })
})
