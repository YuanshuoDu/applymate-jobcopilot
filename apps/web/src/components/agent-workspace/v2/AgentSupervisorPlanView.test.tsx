import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; enabled: boolean }>,
  responses: new Map<string, unknown>(),
}))

vi.mock('@/lib/hooks', () => ({
  useApi: (url: string, options: { enabled?: boolean } = {}) => {
    api.calls.push({ url, enabled: options.enabled !== false })
    return api.responses.get(url) ?? { data: null, loading: options.enabled !== false, error: null, refetch: () => undefined }
  },
}))

import { AgentSupervisorPlanView, shouldRefetchSelectedPlan, supervisorPlanSelectionControls } from './AgentSupervisorPlanView'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTaskSummary, SupervisorTurnSummary } from './task-tree-projection'
import type { TaskTreeNode } from './types'
import { TaskTreePanel } from './TaskTreePanel'
import { buildTaskGraphTaskLookupUrl, selectedTaskGraphIdentity } from './task-graph-plan-query'

function graph(turnId: string, rootTaskId: string, childTaskId: string, graphItemId: string, revision: number): TimelineItem {
  const now = '2026-10-01T12:00:00.000Z'
  return {
    schemaVersion: 'agent-harness.v2', id: graphItemId, sessionId: 'session-1', turnId, stepId: null, taskId: rootTaskId,
    type: 'task_graph', status: 'streaming', phase: 'commentary', revision,
    content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
      { key: 'scout', templateId: 'scout', goal: `Find ${turnId}`, successCriteria: ['Find candidates'], dependsOn: [], depth: 1, taskId: childTaskId },
    ] }, startedAt: null, completedAt: null, createdAt: now, updatedAt: now, source: 'replay', sequence: null,
  }
}

function turn(id: string): SupervisorTurnSummary {
  return { id, sessionId: 'session-1', source: 'message', goal: `Goal ${id}`, status: 'failed', revision: 3, activeStepId: null,
    finalItemId: null, createdAt: '2026-10-01T12:00:00.000Z', updatedAt: '2026-10-01T12:00:00.000Z', completedAt: null }
}

function task(id: string, turnId: string, rootTaskId: string, status: string, goal: string): SupervisorTaskSummary {
  return { id, sessionId: 'session-1', turnId, rootTaskId, role: id === rootTaskId ? 'orchestrator' : 'scout',
    taskType: id === rootTaskId ? 'root' : 'scout', status, goal, hasResult: status === 'completed' || status === 'failed' }
}

function ledger(turnId: string, graphItemId: string, rootTaskId: string, revision: number, goal: string, status: 'completed' | 'failed') {
  const graphIdentity = { sessionId: 'session-1', graphItemId, turnId, rootTaskId, revision }
  return {
    identity: graphIdentity,
    projection: {
      schemaVersion: 'agent-harness.v2.plan-ledger', sessionId: 'session-1', revision, goal,
      nodes: [{ key: 'scout', goal: `Find ${turnId}`, status, resultAvailable: true, evidencePreview: null,
        readiness: 'terminal', dependencies: [] }],
    },
    verificationSummary: { schemaVersion: 1, nodes: [{ status, checks: [{ kind: 'candidate_count_gte', minimum: 1, status }],
      totalCount: 1, passedCount: status === 'completed' ? 1 : 0, failedCount: status === 'failed' ? 1 : 0, unverifiedCount: 0 }] },
  }
}

const oldGraph = graph('turn-old', 'root-old', 'scout-old', 'graph-old', 4)
const currentGraph = graph('turn-current', 'root-current', 'scout-current', 'graph-current', 2)
const items = [oldGraph, currentGraph]
const turns = [turn('turn-old'), turn('turn-current')]
const tasks = [task('scout-old', 'turn-old', 'root-old', 'failed', 'Old failure'), task('scout-current', 'turn-current', 'root-current', 'completed', 'Current result')]
const oldLedger = ledger('turn-old', 'graph-old', 'root-old', 4, 'HISTORICAL_PLAN_MARKER', 'failed')
const currentLedger = ledger('turn-current', 'graph-current', 'root-current', 2, 'CURRENT_PLAN_MARKER', 'completed')
const oldTurnNode: TaskTreeNode = { id: 'turn:turn-old', kind: 'turn', label: 'Goal turn-old', status: 'failed' }

function view(selectedNodeId?: string, selectedNode?: TaskTreeNode) {
  return <AgentSupervisorPlanView sessionId="session-1" items={items} turns={turns} tasks={tasks} selectedNodeId={selectedNodeId}
    selectedNode={selectedNode} currentGraphTasks={tasks.filter(row => row.turnId === 'turn-current')} currentLedger={currentLedger}
    currentPreparationTurnId="turn-current" lifecycleRevision={7} onReturnToCurrent={() => undefined} />
}

describe('AgentSupervisorPlanView', () => {
  beforeEach(() => { api.calls = []; api.responses.clear() })

  it('renders the exact historical failed plan and verification under a selected-Turn context', () => {
    const url = buildTaskGraphTaskLookupUrl('session-1', items, 'turn-old')!
    api.responses.set(url, { data: { tasks: tasks.filter(row => row.turnId === 'turn-old'), planLedger: oldLedger }, loading: false, error: null, refetch: () => undefined })

    const html = renderToStaticMarkup(view(oldTurnNode.id, oldTurnNode))
    expect(url).toContain('graphItemId=graph-old')
    expect(url).toContain('graphTurnId=turn-old')
    expect(html).toContain('Plan for selected turn')
    expect(html).toContain('Goal turn-old')
    expect(html).toContain('HISTORICAL_PLAN_MARKER')
    expect(html).toContain('Verification: Failed')
    expect(html).toContain('Return to current plan')
    expect(html).not.toContain('CURRENT_PLAN_MARKER')
    expect(api.calls).toContainEqual({ url, enabled: true })
  })

  it('suppresses stale session, Turn, graph, or revision responses instead of showing another plan', () => {
    const url = buildTaskGraphTaskLookupUrl('session-1', items, 'turn-old')!
    const identity = selectedTaskGraphIdentity(items, 'session-1', 'turn-old')!
    const mismatches = [
      { ...oldLedger, identity: { ...identity, sessionId: 'session-other' } },
      { ...oldLedger, identity: { ...identity, turnId: 'turn-current' } },
      { ...oldLedger, identity: { ...identity, graphItemId: 'graph-current' } },
      { ...oldLedger, identity: { ...identity, revision: 3 } },
    ]
    for (const planLedger of mismatches) {
      api.responses.clear()
      api.responses.set(url, { data: { tasks: tasks.filter(row => row.turnId === 'turn-old'), planLedger }, loading: false, error: null, refetch: () => undefined })
      const html = renderToStaticMarkup(view(oldTurnNode.id, oldTurnNode))
      expect(html).toContain('This selected plan is unavailable.')
      expect(html).not.toContain('HISTORICAL_PLAN_MARKER')
      expect(html).not.toContain('CURRENT_PLAN_MARKER')
      expect(html).not.toContain('data-agent-task-graph-verification=')
    }
  })

  it('keeps a dangling explicit selection unavailable and preserves default-current rendering only with no selection', () => {
    const invalid = renderToStaticMarkup(view('task:missing', undefined))
    expect(invalid).toContain('data-plan-inspection-state="unavailable"')
    expect(invalid).toContain('This selected plan is unavailable.')
    expect(invalid).not.toContain('CURRENT_PLAN_MARKER')
    expect(api.calls.at(-1)).toMatchObject({ url: '', enabled: false })

    api.calls = []
    const current = renderToStaticMarkup(view())
    expect(current).toContain('CURRENT_PLAN_MARKER')
    expect(current).not.toContain('data-agent-plan-inspection=')
    expect(api.calls).toContainEqual({ url: '', enabled: false })
  })

  it('does not render a cached response until its exact graph identity is current', () => {
    const url = buildTaskGraphTaskLookupUrl('session-1', items, 'turn-old')!
    api.responses.set(url, { data: { tasks: [], planLedger: currentLedger }, loading: true, error: null, refetch: () => undefined })
    const html = renderToStaticMarkup(view(oldTurnNode.id, oldTurnNode))
    expect(html).toContain('Loading selected plan…')
    expect(html).not.toContain('CURRENT_PLAN_MARKER')
    expect(html).not.toContain('HISTORICAL_PLAN_MARKER')
  })

  it('refreshes the same historical query identity when lifecycle changes', () => {
    const url = buildTaskGraphTaskLookupUrl('session-1', items, 'turn-old')!
    const identity = selectedTaskGraphIdentity(items, 'session-1', 'turn-old')!
    expect(selectedTaskGraphIdentity(items, 'session-1', 'turn-old')).toEqual(identity)
    expect(shouldRefetchSelectedPlan(7, 8, 'selected', url)).toBe(true)
    expect(shouldRefetchSelectedPlan(7, 7, 'selected', url)).toBe(false)
    expect(shouldRefetchSelectedPlan(7, 8, 'current', url)).toBe(false)
    expect(shouldRefetchSelectedPlan(7, 8, 'selected', null)).toBe(false)
    expect(shouldRefetchSelectedPlan(-1, 8, 'selected', url)).toBe(false)
  })

  it('wires return-to-current through the controlled tree selection', () => {
    const updates: Array<{ sessionId: string; id: string } | null> = []
    const selected = supervisorPlanSelectionControls({ sessionId: 'session-1', id: oldTurnNode.id }, 'session-1', value => updates.push(value))
    expect(selected.selectedId).toBe(oldTurnNode.id)
    selected.onReturnToCurrent()
    expect(updates).toEqual([null])
    const cleared = supervisorPlanSelectionControls(updates[0] ?? null, 'session-1', value => updates.push(value))
    const node: TaskTreeNode = { id: oldTurnNode.id, kind: 'turn', label: oldTurnNode.label, status: oldTurnNode.status }
    const html = renderToStaticMarkup(<TaskTreePanel nodes={[node]} selectedId={cleared.selectedId} showHeading={false} onSelect={cleared.onSelect} />)
    expect(cleared.selectedId).toBeUndefined()
    expect(html).not.toContain('aria-current="true"')
  })
})
