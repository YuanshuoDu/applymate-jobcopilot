import { describe, expect, it } from 'vitest'

import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { parsePlanLedgerEvent, projectPlanTaskGraphPayload } from './plan-ledger-parser'

const base = {
  schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: 'event-1', sessionId: 'session-1', turnId: 'turn-1', itemId: null,
  taskId: 'task-1', type: 'plan.revision', actor: 'orchestrator', sequence: '1',
}

function revision(overrides: Record<string, unknown> = {}) {
  return { ...base, payload: { planCallId: 'plan-1', goalRevision: 1, planRevision: 1, basedOnPlanRevision: null }, ...overrides }
}

function command(overrides: Record<string, unknown> = {}) {
  return {
    ...base, type: 'plan.command', sequence: '2', payload: {
      planCallId: 'plan-1', planRevision: 1, observationId: 'observation-1',
      content: { kind: 'plan_command', localId: 'search', commandKind: 'tool_call', dependsOn: [], status: 'completed', errorCode: null, output: { secret: 'never display' } },
    }, ...overrides,
  }
}

function taskGraph(overrides: Record<string, unknown> = {}) {
  const runKey = 'task-1:plan-1:1'
  const event = { type: 'start', nodeId: 'search', eventId: `${runKey}:search:start` }
  return {
    ...base, type: 'plan.task_graph', sequence: '3', payload: {
      runKey, event, state: {
        nodes: [{ id: 'search', dependsOn: [] }, { id: 'review', dependsOn: ['search'] }],
        statuses: { search: 'running', review: 'pending' }, readyNodeIds: [], blockedReasons: { review: 'waiting_on_dependencies' }, appliedEvents: [event],
      },
    }, ...overrides,
  }
}

describe('plan ledger event parser', () => {
  it('returns bounded revision metadata and a redacted command step', () => {
    const revisionResult = parsePlanLedgerEvent(revision(), 'session-1')
    const commandResult = parsePlanLedgerEvent(command(), 'session-1')

    expect(revisionResult?.receipt).toMatchObject({ kind: 'revision', planRevision: 1, basedOnPlanRevision: null })
    expect(commandResult?.receipt).toMatchObject({ kind: 'step', planRevision: 1, observationId: 'observation-1', step: {
      localId: 'search', actionKind: 'tool_call', status: 'completed', dependencyCount: 0,
    } })
    expect(JSON.stringify(commandResult)).not.toContain('never display')
  })

  it('accepts control receipts while retaining only safe step metadata', () => {
    const event = command({
      type: 'plan.observation', payload: {
        planCallId: 'plan-1', planRevision: 1, observationId: 'control-1',
        content: { kind: 'plan_control', localId: 'ask', status: 'waiting_for_user', question: 'private question' },
      },
    })
    expect(parsePlanLedgerEvent(event, 'session-1')?.receipt).toMatchObject({ kind: 'step', step: {
      localId: 'ask', actionKind: 'request_input', status: 'waiting_for_user', dependencyCount: 0,
    } })
  })

  it('projects durable task graph lifecycle into bounded display fields only', () => {
    const raw = taskGraph({ payload: {
      ...(taskGraph().payload as Record<string, unknown>),
      providerPrompt: 'private provider data',
    } })
    // Unknown persisted fields are rejected instead of being forwarded to the client.
    expect(parsePlanLedgerEvent(raw, 'session-1')).toBeNull()

    const valid = taskGraph()
    const parsed = parsePlanLedgerEvent(valid, 'session-1')
    const projected = projectPlanTaskGraphPayload((valid as { payload: unknown }).payload, 'task-1')
    expect(parsed?.receipt).toMatchObject({
      kind: 'graph', runKey: 'task-1:plan-1:1', planCallId: 'plan-1', planRevision: 1,
      eventId: 'task-1:plan-1:1:search:start', nodeId: 'search', phase: 'start', attempt: 1,
      nodes: [
        { nodeId: 'search', phase: 'start', attempt: 1, status: 'running', dependencyIds: [] },
        { nodeId: 'review', status: 'pending', dependencyIds: ['search'] },
      ],
    })
    expect(projected).toEqual({
      runKey: 'task-1:plan-1:1', eventId: 'task-1:plan-1:1:search:start', nodeId: 'search',
      phase: 'start', attempt: 1, nodes: [
        { nodeId: 'search', phase: 'start', attempt: 1, status: 'running', dependencyIds: [] },
        { nodeId: 'review', status: 'pending', dependencyIds: ['search'] },
      ],
    })
    expect(parsePlanLedgerEvent({ ...valid, payload: projected }, 'session-1')?.receipt).toMatchObject({ kind: 'graph', nodes: [{ status: 'running' }, { status: 'pending' }] })
    expect(JSON.stringify(parsed)).not.toContain('readyNodeIds')
    expect(JSON.stringify(parsed)).not.toContain('blockedReasons')
    expect(JSON.stringify(parsed)).not.toContain('appliedEvents')
  })

  it('accepts worker-bounded graph event IDs longer than the generic ID limit', () => {
    const nodeId = 'n'.repeat(128)
    const runKey = `task-1:${'p'.repeat(230)}:1`
    const event = { type: 'start', nodeId, eventId: `${runKey}:${nodeId}:start` }
    const valid = taskGraph({ payload: {
      runKey, event, state: {
        nodes: [{ id: nodeId, dependsOn: [] }], statuses: { [nodeId]: 'running' }, readyNodeIds: [],
        blockedReasons: {}, appliedEvents: [event],
      },
    } })

    expect(event.eventId.length).toBeGreaterThan(256)
    expect(event.eventId.length).toBeLessThanOrEqual(512)
    expect(parsePlanLedgerEvent(valid, 'session-1')?.receipt).toMatchObject({
      kind: 'graph', runKey, eventId: event.eventId, nodeId, phase: 'start', attempt: 1,
    })
  })

  it('fails closed for foreign, malformed, stale-shaped, and oversized events', () => {
    expect(parsePlanLedgerEvent(revision({ sessionId: 'other' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent({ ...taskGraph(), payload: { ...(taskGraph().payload as Record<string, unknown>), runKey: 'task-2:plan-1:1' } }, 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ actor: 'tool' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ itemId: 'item-1' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ sequence: '01' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ payload: { planCallId: 'plan-1', goalRevision: 1, planRevision: 2, basedOnPlanRevision: null } }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(command({ payload: { planCallId: 'plan-1', planRevision: 1, observationId: 'observation-1', content: {
      kind: 'plan_command', localId: 'search', commandKind: 'tool_call', dependsOn: [], status: 'failed', errorCode: 'x', output: { blob: 'x'.repeat(9_000) },
    } } }), 'session-1')).toBeNull()
  })
})
