import { describe, expect, it } from 'vitest'

import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { createPlanLedgerState, reducePlanLedger } from './plan-ledger-view'

function event(scope: { turnId?: string; taskId?: string } = {}, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: `revision-${scope.taskId ?? 'task-1'}`, sessionId: 'session-1', turnId: scope.turnId ?? 'turn-1', itemId: null,
    taskId: scope.taskId ?? 'task-1', type: 'plan.revision', actor: 'orchestrator', sequence: '1',
    payload: { planCallId: 'plan-1', goalRevision: 1, planRevision: 1, basedOnPlanRevision: null }, ...overrides,
  }
}

function command(sequence: string, id: string, localId: string, status = 'completed', overrides: Record<string, unknown> = {}) {
  return event({}, { id, type: 'plan.command', sequence, payload: {
    planCallId: 'plan-1', planRevision: 1, observationId: id, content: {
      kind: 'plan_command', localId, commandKind: 'tool_call', dependsOn: localId === 'review' ? ['search'] : [], status, errorCode: status === 'completed' ? null : 'private',
    },
  }, ...overrides })
}

describe('plan ledger projection', () => {
  it('folds revision and command/observation duplicates into one safe latest plan', () => {
    let state = createPlanLedgerState('session-1')
    state = reducePlanLedger(state, event())
    state = reducePlanLedger(state, command('2', 'command-1', 'search'))
    const duplicate = command('3', 'observation-1', 'search')
    state = reducePlanLedger(state, { ...duplicate, payload: { ...(duplicate.payload as Record<string, unknown>), observationId: 'command-1' } })
    state = reducePlanLedger(state, command('4', 'command-2', 'review'))

    expect(state.currentPlan).toEqual({ turnId: 'turn-1', taskId: 'task-1', planRevision: 1, goalRevision: 1, steps: [
      { localId: 'search', actionKind: 'tool_call', status: 'completed', dependencyCount: 0 },
      { localId: 'review', actionKind: 'tool_call', status: 'completed', dependencyCount: 1 },
    ] })
  })

  it('requires contiguous revisions and ignores foreign, stale, and orphan receipts', () => {
    let state = createPlanLedgerState('session-1')
    state = reducePlanLedger(state, event({ turnId: 'turn-1' }))
    const before = state
    expect(reducePlanLedger(state, { ...event(), id: 'gap', sequence: '2', payload: { planCallId: 'plan-2', goalRevision: 1, planRevision: 3, basedOnPlanRevision: 2 } })).toBe(before)
    expect(reducePlanLedger(state, { ...command('3', 'orphan', 'orphan'), taskId: 'task-2' })).toBe(before)
    expect(reducePlanLedger(state, command('0', 'stale', 'stale'))).toBe(before)
    expect(reducePlanLedger(state, { ...event(), id: 'foreign', sessionId: 'other' })).toBe(before)
  })

  it('starts a new goal epoch at revision one and keeps late old epoch events out of current', () => {
    let state = createPlanLedgerState('session-1')
    state = reducePlanLedger(state, event())
    state = reducePlanLedger(state, command('2', 'old-command', 'old-step'))
    state = reducePlanLedger(state, { ...event({}, { id: 'revision-goal-2', sequence: '3', payload: { planCallId: 'plan-2', goalRevision: 2, planRevision: 1, basedOnPlanRevision: null } }) })
    const newCommand = command('4', 'new-command', 'new-step', 'completed', { payload: undefined })
    state = reducePlanLedger(state, { ...newCommand, payload: { planCallId: 'plan-2', planRevision: 1, observationId: 'new-command', content: { kind: 'plan_command', localId: 'new-step', commandKind: 'tool_call', dependsOn: [], status: 'completed', errorCode: null } } })
    state = reducePlanLedger(state, command('5', 'late-old-command', 'old-late'))

    expect(state.currentPlan).toMatchObject({ goalRevision: 2, planRevision: 1, steps: [{ localId: 'new-step' }] })
    expect(state.plans.some(plan => plan.goalRevision === 1 && plan.steps.some(step => step.localId === 'old-step'))).toBe(true)
    expect(state.currentPlan?.steps.some(step => step.localId === 'old-late')).toBe(false)
  })

  it('keeps at most sixteen plans and eight visible rows per plan', () => {
    let state = createPlanLedgerState('session-1')
    for (let index = 0; index < 17; index += 1) {
      const taskId = `task-${String(index).padStart(2, '0')}`
      state = reducePlanLedger(state, event({ taskId }, { id: `revision-${index}`, sequence: String(index + 1), payload: { planCallId: `plan-${index}`, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } }))
      for (let row = 0; row < 9; row += 1) {
        const next = command(String(index + 18 + row), `command-${index}-${row}`, `step-${row}`, 'completed', { taskId })
        state = reducePlanLedger(state, { ...next, payload: { ...(next.payload as Record<string, unknown>), planCallId: `plan-${index}` } })
      }
    }
    expect(state.plans).toHaveLength(16)
    expect(state.plans[0]?.steps).toHaveLength(8)
  })
})
