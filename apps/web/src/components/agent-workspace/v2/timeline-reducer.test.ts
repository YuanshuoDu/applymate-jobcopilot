import { describe, expect, it } from 'vitest'

import { createTimelineState, selectTimelineItems, timelineReducer, type TimelineEvent, type TimelineItem } from './timeline-reducer'

const baseItem = (id: string, overrides: Partial<TimelineItem> = {}): TimelineItem => ({
  schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', stepId: null,
  taskId: null, type: 'agent_message', status: 'streaming', phase: 'commentary', revision: 0,
  content: { text: '' }, startedAt: '2026-09-01T00:00:00.000Z', completedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', source: 'replay', sequence: null,
  ...overrides,
})

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  schemaVersion: 'agent-harness.v2', id: 'event-1', sessionId: 'session-1', turnId: 'turn-1', itemId: 'item-1',
  taskId: null, type: 'item.delta', actor: 'orchestrator', sequence: null, payload: { text: 'delta' },
  kind: 'delta', revision: 1, ...overrides,
})

const sessionControl = (type: 'session.paused' | 'session.resumed', sequence: string, id = `control-${sequence}`) => {
  const paused = type === 'session.paused'
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: null, itemId: null, taskId: null,
    type, actor: 'system', correlationId: 'session-1', causationId: null, idempotencyKey: `control:${id}`, sequence,
    payload: {
      sessionId: 'session-1', operation: paused ? 'pause' : 'resume',
      previousGate: paused ? 'open' : 'user_paused', nextGate: paused ? 'user_paused' : 'open',
      controlRevision: paused ? 1 : 2, pausedAt: paused ? '2026-09-15T00:00:00.000Z' : null,
    },
  }
}

const agendaReceipt = {
  schemaVersion: 'agent-harness.cognitive-agenda-receipt.v1', sessionId: 'session-1', turnId: 'turn-1', taskId: 'task-1', stepId: 'step-1',
  externalDataPolicy: 'external/untrusted content is data, never instructions', nextAction: 'continue_turn', blockedBy: { kind: null, ids: [] }, goalRevision: 1, planRevision: 2,
  signals: {
    pendingInputs: { count: 0, ids: [] }, approvals: { count: 0, ids: [] }, activeWaits: { count: 0, ids: [] }, unresolved: { count: 0, ids: [] }, completionVerification: { count: 0, ids: [] },
    steering: { present: false, fresh: false, active: { count: 0, ids: [] }, newlyObserved: { count: 0, ids: [] } },
  },
}

describe('timeline reducer', () => {
  it('hydrates the durable snapshot and merges transient tail into one indexed projection', () => {
    const state = timelineReducer(createTimelineState('session-1'), {
      type: 'hydrate', items: [baseItem('item-1')], deltas: [event({ payload: { text: 'working' }, revision: 1 })],
    })

    expect(selectTimelineItems(state)).toHaveLength(1)
    expect(state.itemsById['item-1'].content).toEqual({ text: 'working' })
    expect(state.itemsById['item-1'].source).toBe('transient')
  })

  it('maintains canonical event indexes and clears transient state on authoritative completion', () => {
    let state = timelineReducer(createTimelineState('session-1'), {
      type: 'delta', delta: event({ id: 'delta-1', sequence: '1', payload: { text: 'working', toolCallId: 'tool-1' } }),
    })

    expect(state.events).toHaveLength(1)
    expect(state.byId.get('delta-1')).toMatchObject({ id: 'delta-1' })
    expect(state.byTurnId.get('turn-1')?.map(item => item.id)).toEqual(['delta-1'])
    expect(state.byToolCallId.get('tool-1')?.map(item => item.id)).toEqual(['delta-1'])
    expect(state.lastEventId).toBe('delta-1')
    expect(state.transientItems.has('item-1')).toBe(true)

    state = timelineReducer(state, {
      type: 'event', event: event({
        id: 'completed-1', type: 'item.completed', kind: undefined, sequence: '2',
        payload: baseItem('item-1', { status: 'completed', revision: 2, content: { text: 'done' }, source: 'durable' }),
      }),
    })

    expect(state.events.map(item => item.id)).toEqual(['delta-1', 'completed-1'])
    expect(state.transientItems.has('item-1')).toBe(false)
  })

  it('applies a durable item.delta event delivered through the event path', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [baseItem('item-1')] })
    state = timelineReducer(state, { type: 'event', event: event({ kind: undefined, revision: undefined, payload: { itemId: 'item-1', status: 'streaming', content: { text: 'durable delta' } } }) })
    expect(state.itemsById['item-1']).toMatchObject({ revision: 1, content: { text: 'durable delta' } })
    expect(state.processedEventIds['event-1']).toBe(true)
  })

  it('restores session control without adding a null-turn event or item', () => {
    let state = timelineReducer(createTimelineState('session-1'), {
      type: 'event', event: sessionControl('session.paused', '5'),
    })
    expect(state.sessionControl).toMatchObject({ controlGate: 'user_paused', controlRevision: 1, pausedAt: '2026-09-15T00:00:00.000Z' })
    expect(state.lastEventId).toBe('control-5')
    expect(state.lastSequence).toBe('5')
    expect(state.events).toEqual([])
    expect(state.byTurnId.size).toBe(0)
    expect(state.itemIds).toEqual([])

    state = timelineReducer(state, { type: 'event', event: sessionControl('session.resumed', '6') })
    expect(state.sessionControl).toEqual({ controlGate: 'open', controlRevision: 2, pausedAt: null })
    const afterResume = state
    expect(timelineReducer(state, { type: 'event', event: sessionControl('session.paused', '5') })).toBe(afterResume)
    expect(timelineReducer(state, { type: 'event', event: sessionControl('session.paused', '4', 'old-control') })).toBe(afterResume)
    expect(timelineReducer(state, { type: 'event', event: {
      ...sessionControl('session.paused', '7', 'ordinary-null-turn'), type: 'item.completed',
    } })).toBe(afterResume)
  })

  it('replaces transient content with a completed authoritative item and ignores duplicates/out-of-order regressions', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [baseItem('item-1', { revision: 2 })] })
    state = timelineReducer(state, { type: 'delta', delta: event({ id: 'delta-1', revision: 3, payload: { text: 'partial' } }) })
    const completed = baseItem('item-1', { status: 'completed', revision: 4, content: { text: 'authoritative' }, source: 'durable', sequence: '8', completedAt: '2026-09-01T00:00:01.000Z', updatedAt: '2026-09-01T00:00:01.000Z' })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'event-completed', type: 'item.completed', kind: undefined, revision: undefined, sequence: '8', payload: completed }) })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'event-started-late', type: 'item.started', kind: undefined, sequence: '7', payload: { text: 'old' } }) })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'event-completed', type: 'item.completed', kind: undefined, sequence: '8', payload: completed }) })

    expect(selectTimelineItems(state)).toHaveLength(1)
    expect(state.itemsById['item-1']).toMatchObject({ status: 'completed', content: { text: 'authoritative' }, revision: 4 })
    expect(state.lastSequence).toBe('8')
  })

  it('keeps reconnect non-terminal and safely materializes unknown items', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'connected' })
    state = timelineReducer(state, { type: 'disconnected' })
    state = timelineReducer(state, { type: 'event', event: event({ id: 'future-1', itemId: 'future-item', type: 'future.item.v3', sequence: '12', kind: undefined, payload: { value: 1 } }) })

    expect(state.connection).toBe('reconnecting')
    expect(state.itemsById['future-item']).toMatchObject({ type: 'unknown', status: 'started', source: 'unknown' })
    expect(state.itemsById['future-item'].content).toMatchObject({ eventType: 'future.item.v3', opaque: true })
    expect(state.fallbackItems.map(item => item.id)).toEqual(['future-1'])
  })

  it('treats a valid cognitive agenda as a known no-item event without lifecycle refresh', () => {
    const state = timelineReducer(createTimelineState('session-1'), {
      type: 'event', event: event({ id: 'agenda-1', type: 'cognitive.agenda', itemId: null, taskId: 'task-1', sequence: '9', kind: undefined, payload: agendaReceipt }),
    })

    expect(state.cognitiveAgenda.latest?.nextAction).toBe('continue_turn')
    expect(state.events.map(item => item.id)).toEqual(['agenda-1'])
    expect(state.fallbackItems).toEqual([])
    expect(selectTimelineItems(state)).toEqual([])
    expect(state.lifecycleRevision).toBe(0)
  })

  it('folds valid durable plan receipts without creating timeline items or exposing their output', () => {
    const revision = {
      schemaVersion: 'agent-harness.v2', id: 'plan-revision-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
      type: 'plan.revision', actor: 'orchestrator', sequence: '11', payload: { planCallId: 'plan-1', goalRevision: 1, planRevision: 1, basedOnPlanRevision: null },
    }
    const command = {
      schemaVersion: 'agent-harness.v2', id: 'plan-command-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
      type: 'plan.command', actor: 'orchestrator', sequence: '12', payload: { planCallId: 'plan-1', planRevision: 1, observationId: 'observation-1', content: {
        kind: 'plan_command', localId: 'search', commandKind: 'tool_call', dependsOn: [], status: 'completed', errorCode: null, output: { secret: 'do not render' },
      } },
    }
    let state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: revision })
    state = timelineReducer(state, { type: 'event', event: command })
    expect(state.planLedger.currentPlan?.steps).toEqual([{ localId: 'search', actionKind: 'tool_call', status: 'completed', dependencyCount: 0 }])
    expect(state.itemIds).toEqual([])
    expect(JSON.stringify(state.planLedger)).not.toContain('do not render')
    expect(timelineReducer(state, { type: 'event', event: { ...command, id: 'duplicate', sequence: '13' } })).toBe(state)
  })

  it('folds approval facts as lifecycle events without exposing receipt payloads', () => {
    const requested = {
      schemaVersion: 'agent-harness.v2', id: 'approval-requested', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
      type: 'approval.requested', actor: 'orchestrator', sequence: '14', payload: { approvalId: 'approval-1', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 },
    }
    const resolved = {
      schemaVersion: 'agent-harness.v2', id: 'approval-resolved', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
      type: 'approval.resolved', actor: 'user', sequence: '15', payload: { approvalId: 'approval-1', action: 'submit_application', scopeHash: `sha256:${'a'.repeat(64)}`, revision: 2 },
    }
    let state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: requested })
    state = timelineReducer(state, { type: 'event', event: resolved })

    expect(state.approvalLedger.projection.approvals).toEqual([{ status: 'resolved', action: 'submit_application', revision: 2 }])
    expect(state.lifecycleRevision).toBe(2)
    expect(state.itemIds).toEqual([])
    expect(JSON.stringify(state.approvalLedger)).not.toContain('scopeHash')
    expect(timelineReducer(state, { type: 'event', event: { ...requested, id: 'approval-duplicate', sequence: '16' } })).toBe(state)
    expect(timelineReducer(state, { type: 'event', event: { ...requested, id: 'approval-malformed', sequence: '17', payload: { ...requested.payload, body: 'raw secret' } } })).toBe(state)
  })

  it('keeps interrupt cancellation as a distinct approval lifecycle status', () => {
    const requested = {
      schemaVersion: 'agent-harness.v2', id: 'cancel-requested', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: null,
      type: 'approval.requested', actor: 'orchestrator', sequence: '18', payload: { approvalId: 'approval-cancelled', action: 'submit_application', scopeHash: `sha256:${'b'.repeat(64)}`, revision: 3 },
    }
    const cancelled = {
      schemaVersion: 'agent-harness.v2', id: 'cancel-resolved', sessionId: 'session-1', turnId: 'turn-1', itemId: 'wait-item-cancelled', taskId: null,
      type: 'approval.resolved', actor: 'system', sequence: '19', payload: {
        waitKind: 'approval', waitId: 'approval-cancelled', itemId: 'wait-item-cancelled', turnId: 'turn-1', toolCallId: 'call-cancelled', outcome: 'cancelled', reason: 'interrupt',
      },
    }
    let state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: requested })
    state = timelineReducer(state, { type: 'event', event: cancelled })

    expect(state.approvalLedger.projection.approvals).toEqual([{ status: 'cancelled', action: 'submit_application', revision: 3 }])
    expect(state.lifecycleRevision).toBe(2)
    expect(state.itemIds).toEqual([])
  })

  it('maps authoritative question answers to completed without allowing terminal regression', () => {
    const question = {
      schemaVersion: 'agent-harness.v2', id: 'question-item', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
      type: 'question', status: 'started', phase: 'commentary', revision: 0, content: {
        waitKind: 'question', questionId: 'question-1', stage: 'profile', question: 'Choose?', options: [{ value: 'yes', label: 'Yes' }], answerAvailable: false, pending: true,
      }, startedAt: null, completedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    }
    const answered = {
      schemaVersion: 'agent-harness.v2', id: 'question-answered', sessionId: 'session-1', turnId: 'turn-1', itemId: 'question-item', taskId: null,
      type: 'question.answered', actor: 'user', sequence: '2', correlationId: 'question-1', causationId: 'question-item', idempotencyKey: 'answer-1',
      payload: { waitKind: 'question', waitId: 'question-1', itemId: 'question-item', turnId: 'turn-1', toolCallId: null, status: 'answered', nextTurnRevision: 3, answerAvailable: true },
    }
    let state = timelineReducer(createTimelineState('session-1'), { type: 'hydrate', items: [question] })
    state = timelineReducer(state, { type: 'event', event: answered })
    expect(state.itemsById['question-item']).toMatchObject({ status: 'completed', content: { answerAvailable: true, pending: false } })
    expect(state.itemsById['question-item']?.content).not.toHaveProperty('answer')
    expect(state.lifecycleRevision).toBe(1)
    const regressed = { ...answered, id: 'question-cancelled-late', type: 'question.cancelled', actor: 'system', sequence: '3', payload: { waitKind: 'question', waitId: 'question-1', itemId: 'question-item', toolCallId: null, outcome: 'cancelled', reason: 'interrupt' } }
    expect(timelineReducer(state, { type: 'event', event: regressed })).toBe(state)
  })

  it('maps interrupt question cancellation to interrupted and rejects a later answer', () => {
    const question = {
      schemaVersion: 'agent-harness.v2', id: 'question-item-2', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
      type: 'question', status: 'started', phase: 'commentary', revision: 0, content: { waitKind: 'question', questionId: 'question-2', stage: 'profile', question: 'Choose?', options: [], answerAvailable: false, pending: true },
      startedAt: null, completedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    }
    const cancelled = {
      schemaVersion: 'agent-harness.v2', id: 'question-cancelled', sessionId: 'session-1', turnId: 'turn-1', itemId: 'question-item-2', taskId: null,
      type: 'question.cancelled', actor: 'system', sequence: '4', payload: { waitKind: 'question', waitId: 'question-2', itemId: 'question-item-2', toolCallId: null, outcome: 'cancelled', reason: 'interrupt' },
    }
    let state = timelineReducer(createTimelineState('session-1'), { type: 'hydrate', items: [question] })
    state = timelineReducer(state, { type: 'event', event: cancelled })
    expect(state.itemsById['question-item-2']).toMatchObject({ status: 'interrupted', content: { cancelled: true, cancellationReason: 'interrupt', pending: false } })
    const lateAnswer = {
      schemaVersion: 'agent-harness.v2', id: 'question-answered-late', sessionId: 'session-1', turnId: 'turn-1', itemId: 'question-item-2', taskId: null,
      type: 'question.answered', actor: 'user', sequence: '5', payload: { waitKind: 'question', waitId: 'question-2', itemId: 'question-item-2', turnId: 'turn-1', toolCallId: null, status: 'answered', nextTurnRevision: 4, answerAvailable: true },
    }
    expect(timelineReducer(state, { type: 'event', event: lateAnswer })).toBe(state)
  })

  it('records an ID-only question start without materializing an unknown item', () => {
    const stub = {
      schemaVersion: 'agent-harness.v2', id: 'question-started', sessionId: 'session-1', turnId: 'turn-1',
      itemId: 'question-item', taskId: null, type: 'item.started', actor: 'orchestrator', sequence: '20',
      payload: { itemId: 'question-item', waitKind: 'question', questionId: 'question-1', toolCallId: null },
    }

    const state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: stub })

    expect(state.events.map(entry => entry.id)).toEqual(['question-started'])
    expect(state.itemIds).toEqual([])
    expect(state.fallbackItems).toEqual([])
  })

  it('does not apply a terminal fact to a newer canonical question snapshot', () => {
    const terminal = {
      schemaVersion: 'agent-harness.v2', id: 'question-answered', sessionId: 'session-1', turnId: 'turn-1',
      itemId: 'question-item', taskId: null, type: 'question.answered', actor: 'user', sequence: '19',
      payload: {
        waitKind: 'question', waitId: 'question-1', itemId: 'question-item', turnId: 'turn-1', toolCallId: null,
        status: 'answered', nextTurnRevision: 1, answerAvailable: true,
      },
    }
    const question = {
      schemaVersion: 'agent-harness.v2', id: 'question-item', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
      type: 'question', status: 'started', phase: 'commentary', revision: 0, sequence: '20', content: {
        waitKind: 'question', questionId: 'question-1', stage: 'profile', question: 'Choose?', options: [{ value: 'yes', label: 'Yes' }],
        answerAvailable: false, pending: true,
      }, startedAt: null, completedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z',
    }

    let state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: terminal })
    state = timelineReducer(state, { type: 'hydrate', items: [question] })

    expect(state.itemsById['question-item']).toMatchObject({ status: 'started', content: { pending: true, answerAvailable: false } })
  })

  it('keeps canonical root and child agenda projections isolated', () => {
    const childReceipt = { ...agendaReceipt, taskId: 'task-child', nextAction: 'await_children' }
    let state = timelineReducer(createTimelineState('session-1'), {
      type: 'event', event: event({ id: 'agenda-root', type: 'cognitive.agenda', itemId: null, taskId: 'task-1', sequence: '9', kind: undefined, payload: agendaReceipt }),
    })
    state = timelineReducer(state, {
      type: 'event', event: event({ id: 'agenda-child', type: 'cognitive.agenda', itemId: null, taskId: 'task-child', sequence: '10', kind: undefined, payload: childReceipt }),
    })

    expect(state.cognitiveAgenda.latest?.taskId).toBe('task-child')
    expect(state.cognitiveAgenda.scoped.map(entry => entry.taskId)).toEqual(['task-child', 'task-1'])
    expect(state.lifecycleRevision).toBe(0)
    expect(selectTimelineItems(state)).toEqual([])
  })

  it('folds durable steering markers as known non-lifecycle events without rendering items', () => {
    const markerPayload = (kind: 'observed' | 'applied') => ({
      schemaVersion: 'agent-harness.steering-marker.v1', kind, status: kind, sessionId: 'session-1', turnId: 'turn-1',
      taskId: 'task-1', stepId: 'step-1', inputId: 'input-1', idempotencyKey: 'steering-marker:session-1:turn-1:input-1',
      obligationId: 'obligation-1', goalRevision: 1, planRevision: 1, acceptedSequence: '1',
    })
    const marker = (id: string, sequence: string, kind: 'observed' | 'applied') => ({
      schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
      type: 'agent.steering.marker', actor: 'system', sequence, payload: markerPayload(kind),
    })

    let state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: marker('marker-observed', '1', 'observed') })
    state = timelineReducer(state, { type: 'event', event: marker('marker-applied', '2', 'applied') })

    expect(state.steeringMarkers).toMatchObject({ observedCount: 1, appliedCount: 1, activeCount: 0 })
    expect(state.events.map(item => item.id)).toEqual(['marker-observed', 'marker-applied'])
    expect(state.fallbackItems).toEqual([])
    expect(selectTimelineItems(state)).toEqual([])
    expect(state.lifecycleRevision).toBe(0)
  })

  it('does not change state when a marker conflicts or arrives from another session', () => {
    const observed = {
      schemaVersion: 'agent-harness.v2', id: 'marker-observed', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1',
      type: 'agent.steering.marker', actor: 'system', sequence: '1', payload: {
        schemaVersion: 'agent-harness.steering-marker.v1', kind: 'observed', status: 'observed', sessionId: 'session-1', turnId: 'turn-1',
        taskId: 'task-1', stepId: 'step-1', inputId: 'input-1', idempotencyKey: 'steering-marker:session-1:turn-1:input-1', obligationId: null,
        goalRevision: 1, planRevision: null, acceptedSequence: '1',
      },
    }
    const state = timelineReducer(createTimelineState('session-1'), { type: 'event', event: observed })
    const conflict = timelineReducer(state, { type: 'event', event: { ...observed, id: 'marker-conflict', sequence: '2', payload: { ...observed.payload, goalRevision: 2 } } })
    const foreign = timelineReducer(state, { type: 'event', event: { ...observed, id: 'marker-foreign', sessionId: 'session-2', payload: { ...observed.payload, sessionId: 'session-2', idempotencyKey: 'steering-marker:session-2:turn-1:input-1' } } })
    expect(conflict).toBe(state)
    expect(foreign).toBe(state)
  })

  it('produces the same state for replay and live delivery across deterministic event logs', () => {
    const items = [baseItem('item-1')]
    const logs: TimelineEvent[][] = [
      [],
      [event({ id: 'started-1', type: 'item.started', kind: undefined, sequence: '1', payload: { item: baseItem('item-1', { status: 'started' }) } })],
      [
        event({ id: 'delta-1', revision: 1, sequence: '3', payload: { text: 'hello' } }),
        event({ id: 'completed-1', type: 'item.completed', kind: undefined, sequence: '4', payload: baseItem('item-1', { status: 'completed', revision: 1, content: { text: 'hello' }, source: 'durable' }) }),
      ],
      [event({ id: 'unknown-1', type: 'future.item.v3', itemId: null, sequence: '5', kind: undefined, payload: { value: 1 } })],
    ]

    for (const events of logs) {
      const replay = timelineReducer(createTimelineState('session-1'), { type: 'hydrate', items, tail: events })
      let live = timelineReducer(createTimelineState('session-1'), { type: 'replay', items })
      for (const current of events) {
        live = timelineReducer(live, current.kind ? { type: 'delta', delta: current } : { type: 'event', event: current })
      }
      expect(live).toEqual(replay)
    }
  })

  it('replaces a snapshot and requests recovery when a delta has a revision gap', () => {
    let state = timelineReducer(createTimelineState('session-1'), { type: 'replay', items: [baseItem('item-1', { revision: 1, content: { text: 'old', stale: true } })] })
    state = timelineReducer(state, { type: 'delta', delta: event({ id: 'delta-gap', revision: 3, baseRevision: 2, payload: { content: { text: 'gap' } } }) })
    expect(state.snapshotRequired).toBe(true)
    expect(state.itemsById['item-1'].content).toEqual({ text: 'old', stale: true })

    state = timelineReducer(state, { type: 'delta', delta: event({ id: 'snapshot-2', kind: 'snapshot', revision: 2, baseRevision: 0, payload: { content: { text: 'fresh' } } }) })
    expect(state.snapshotRequired).toBe(false)
    expect(state.itemsById['item-1'].content).toEqual({ text: 'fresh' })
  })
})
