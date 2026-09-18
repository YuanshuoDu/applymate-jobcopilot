import { describe, expect, it } from 'vitest'

import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { parsePlanLedgerEvent } from './plan-ledger-parser'

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

  it('fails closed for foreign, malformed, stale-shaped, and oversized events', () => {
    expect(parsePlanLedgerEvent(revision({ sessionId: 'other' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ actor: 'tool' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ itemId: 'item-1' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ sequence: '01' }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(revision({ payload: { planCallId: 'plan-1', goalRevision: 1, planRevision: 2, basedOnPlanRevision: null } }), 'session-1')).toBeNull()
    expect(parsePlanLedgerEvent(command({ payload: { planCallId: 'plan-1', planRevision: 1, observationId: 'observation-1', content: {
      kind: 'plan_command', localId: 'search', commandKind: 'tool_call', dependsOn: [], status: 'failed', errorCode: 'x', output: { blob: 'x'.repeat(9_000) },
    } } }), 'session-1')).toBeNull()
  })
})
