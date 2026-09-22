import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { I18nProvider, translate } from '@/lib/i18n'
import { AGENT_STREAM_SCHEMA_VERSION } from '@jobcopilot/agent-protocol'

import { AgentPlanLedgerCard } from './AgentPlanLedgerCard'
import { createPlanLedgerState, reducePlanLedger, selectPlanLedgerProjection } from './plan-ledger-view'

function ledger() {
  const revision = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: 'revision', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1', type: 'plan.revision', actor: 'orchestrator', sequence: '1', payload: { planCallId: 'opaque-plan', goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } }
  const command = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: 'command', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1', type: 'plan.command', actor: 'orchestrator', sequence: '2', payload: { planCallId: 'opaque-plan', planRevision: 1, observationId: 'opaque-observation', content: { kind: 'plan_command', localId: 'search', commandKind: 'tool_call', dependsOn: ['previous'], status: 'completed', errorCode: null, output: { secret: 'raw output' } } } }
  const graph = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: 'graph-event', sessionId: 'session-1', turnId: 'turn-1', itemId: null, taskId: 'task-1', type: 'plan.task_graph', actor: 'orchestrator', sequence: '3', payload: {
    runKey: 'task-1:opaque-plan:1', eventId: 'task-1:opaque-plan:1:graph-search:start', nodeId: 'graph-search', phase: 'start', attempt: 1,
    nodes: [
      { nodeId: 'graph-search', dependencyIds: [], phase: 'start', attempt: 1, status: 'running' },
      { nodeId: 'graph-review', dependencyIds: ['graph-search'], status: 'pending' },
    ],
  } }
  return selectPlanLedgerProjection(reducePlanLedger(reducePlanLedger(reducePlanLedger(createPlanLedgerState('session-1'), revision), command), graph))
}

describe('AgentPlanLedgerCard', () => {
  it('renders only the current revision and translated bounded step state', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentPlanLedgerCard ledger={ledger()} /></I18nProvider>)
    expect(html).toContain('data-agent-plan-ledger="true"')
    expect(html).toContain(translate('en', 'agent.planLedger.title'))
    expect(html).toContain('Plan revision')
    expect(html).toContain('search')
    expect(html).toContain(translate('en', 'agent.planLedger.kind.toolCall'))
    expect(html).toContain(translate('en', 'agent.planLedger.status.completed'))
    expect(html).toContain('Dependencies: 1')
    expect(html).toContain('data-agent-plan-task-graph="true"')
    expect(html).toContain(translate('en', 'agent.planLedger.kind.planStep'))
    expect(html).toContain('graph-search')
    expect(html).toContain('graph-review')
    expect(html).toContain(translate('en', 'agent.planLedger.graphStatus.running'))
    expect(html).toContain('Dependencies: graph-search')
    expect(html).toContain(translate('en', 'agent.planLedger.graphPhase.notStarted'))
    expect(html).not.toContain('Not started · Attempt: 1')
    expect(html).not.toContain('opaque-plan:1:graph-search:start')
    expect(html).not.toContain('graph-event')
    expect(html).not.toContain('opaque-plan')
    expect(html).not.toContain('opaque-observation')
    expect(html).not.toContain('raw output')
    expect(html).not.toContain('<button')
  })

  it('stays hidden when there is no valid plan', () => {
    const html = renderToStaticMarkup(<I18nProvider><AgentPlanLedgerCard ledger={selectPlanLedgerProjection(createPlanLedgerState('session-1'))} /></I18nProvider>)
    expect(html).toBe('')
  })
})
