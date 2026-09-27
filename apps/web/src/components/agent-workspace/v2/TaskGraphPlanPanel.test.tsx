import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TaskGraphPlanPanel } from './TaskGraphPlanPanel'
import { projectCurrentTaskGraph } from './task-graph-plan'
import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTaskSummary } from './task-tree-projection'

function item(content: unknown, updatedAt = '2026-09-23T12:00:00.000Z', revision = 3, taskId = 'root-task', id = 'task-graph-1'): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId,
    type: 'task_graph', status: 'streaming', phase: 'commentary', revision, content,
    startedAt: null, completedAt: null, createdAt: updatedAt, updatedAt, source: 'replay', sequence: null,
  }
}

const tasks: SupervisorTaskSummary[] = [{
  id: 'root-task', sessionId: 'session-1', role: 'orchestrator', taskType: 'root', status: 'running', goal: 'Root plan goal from task record', hasResult: false,
}, {
  // Model an untrusted runtime row; the safe DTO intentionally omits raw results.
  ...({
    id: 'task-a', sessionId: 'session-1', role: 'researcher', taskType: 'scout', status: 'queued', goal: 'Scoped goal from task record', hasResult: true,
    result: 'PRIVATE_RAW_RESULT_PAYLOAD',
  } as unknown as SupervisorTaskSummary & { readonly result: unknown }),
}]

describe('TaskGraphPlanPanel', () => {
  it('rejects a valid but stale Plan Ledger from another session', () => {
    const foreignItems = [item({ schemaVersion: 'agent-harness.v2.task-graph', nodes: [
      { key: 'foreign', templateId: 'scout', goal: 'CROSS_SESSION_LEDGER_SECRET', successCriteria: ['criterion'], dependsOn: [], depth: 1, taskId: 'foreign-task' },
    ] }, '2026-09-23T12:00:00.000Z', 9, 'foreign-root', 'foreign-graph'),].map(value => ({ ...value, sessionId: 'session-2' }))
    const foreignTasks: SupervisorTaskSummary[] = [
      { ...tasks[0]!, id: 'foreign-root', sessionId: 'session-2', goal: 'FOREIGN_ROOT_SECRET' },
      { ...tasks[1]!, id: 'foreign-task', sessionId: 'session-2', goal: 'CROSS_SESSION_LEDGER_SECRET' },
    ]
    const foreignLedger = projectCurrentTaskGraph(foreignItems, foreignTasks, 'session-2')
    expect(foreignLedger?.sessionId).toBe('session-2')

    const currentItems = [item({ schemaVersion: 'agent-harness.v2.task-graph', nodes: [
      { key: 'current', templateId: 'scout', goal: 'Current session snapshot goal', successCriteria: ['criterion'], dependsOn: [], depth: 1, taskId: 'task-a' },
    ] })]
    const html = renderToStaticMarkup(<TaskGraphPlanPanel
      sessionId="session-1"
      items={currentItems}
      tasks={tasks}
      ledger={foreignLedger}
    />)

    expect(html).toContain('Root plan goal from task record')
    expect(html).toContain('data-agent-task-graph-revision="3"')
    expect(html).toContain('Scoped goal from task record')
    expect(html).not.toContain('CROSS_SESSION_LEDGER_SECRET')
    expect(html).not.toContain('FOREIGN_ROOT_SECRET')
  })

  it('renders an accessible plan with a selected-session snapshot fallback and no cross-session task data', () => {
    const items = [item({
      schemaVersion: 'agent-harness.v2.task-graph',
      nodes: [
        { key: 'a', templateId: 'scout', goal: 'Snapshot goal should not render', successCriteria: ['CRITERIA_SECRET'], dependsOn: [], depth: 1, taskId: 'task-a' },
        { key: 'unavailable', templateId: 'scout', goal: 'Selected-session snapshot fallback goal', successCriteria: ['Private criterion'], dependsOn: [], depth: 1, taskId: 'task-from-session-2' },
      ],
    })]
    const ledger = projectCurrentTaskGraph(items, [...tasks, { ...tasks[0]!, id: 'task-from-session-2', sessionId: 'session-2', goal: 'CROSS_SESSION_SECRET', status: 'completed' }], 'session-1')
    const html = renderToStaticMarkup(<TaskGraphPlanPanel
      sessionId="session-1"
      items={items}
      tasks={[...tasks, { ...tasks[0]!, id: 'task-from-session-2', sessionId: 'session-2', goal: 'CROSS_SESSION_SECRET', status: 'completed' }]}
      ledger={JSON.stringify(ledger)}
    />)

    expect(html).toContain('aria-label="Current plan"')
    expect(html).toContain('data-agent-task-graph-session="session-1"')
    expect(html).toContain('data-agent-task-graph-revision="3"')
    expect(html).toContain('Root plan goal from task record')
    expect(html).toContain('Tool result')
    expect(html).toContain('Status: Queued')
    expect(html).toContain('Scoped goal from task record')
    expect(html).toContain('Queued')
    expect(html).toContain('No dependencies')
    expect(html).toContain('Ready to start')
    expect(html).toContain('Selected-session snapshot fallback goal')
    expect(html).toContain('Unavailable')
    expect(html).not.toContain('Snapshot goal should not render')
    expect(html).not.toContain('CRITERIA_SECRET')
    expect(html).not.toContain('Private criterion')
    expect(html).not.toContain('CROSS_SESSION_SECRET')
    expect(html).not.toContain('PRIVATE_RAW_RESULT_PAYLOAD')
  })

  it('renders a safe evidence preview as escaped plain text and never renders raw result fields', () => {
    const completedTask = {
      id: 'task-a', sessionId: 'session-1', role: 'scout', taskType: 'scout', status: 'completed',
      goal: 'Search public jobs', hasResult: true,
      structuredEvidencePreview: {
        role: 'scout', summary: 'Scout completed: 1 candidate; 1 linked evidence item.', itemCount: 1,
        evidence: [{ kind: 'job', source: 'greenhouse', reference: null }],
      },
      result: { finalText: 'RAW_FINAL_TEXT', structuredResult: { url: 'PRIVATE_URL' } },
    } as unknown as SupervisorTaskSummary
    const html = renderToStaticMarkup(<TaskGraphPlanPanel
      sessionId="session-1"
      items={[item({ schemaVersion: 'agent-harness.v2.task-graph', nodes: [
        { key: 'a', templateId: 'scout', goal: 'snapshot', successCriteria: ['criterion'], dependsOn: [], depth: 1, taskId: 'task-a' },
      ] })]}
      tasks={[tasks[0]!, completedTask]}
    />)

    expect(html).toContain('Evidence summary')
    expect(html).toContain('Scout completed: 1 candidate; 1 linked evidence item.')
    expect(html).toContain('greenhouse')
    expect(html).not.toContain('job-42')
    expect(html).not.toContain('RAW_FINAL_TEXT')
    expect(html).not.toContain('PRIVATE_URL')
    expect(html).not.toContain('Tool result')
  })

  it('renders current status and evidence for a referenced task outside the first 100 task rows', () => {
    const olderGraph = item({ schemaVersion: 'agent-harness.v2.task-graph', nodes: [
      { key: 'old', templateId: 'scout', goal: 'old snapshot', successCriteria: ['old criterion'], dependsOn: [], depth: 1, taskId: 'old-task' },
    ] }, '2026-09-23T11:00:00.000Z', 2, 'old-root', 'graph-old')
    const latestGraph = item({ schemaVersion: 'agent-harness.v2.task-graph', nodes: [
      { key: 'latest', templateId: 'scout', goal: 'snapshot goal', successCriteria: ['private criterion'], dependsOn: [], depth: 1, taskId: 'task-outside-first-page' },
    ] }, '2026-09-23T12:00:00.000Z', 4, 'root-task', 'graph-latest')
    const firstHundred: SupervisorTaskSummary[] = [tasks[0]!, ...Array.from({ length: 99 }, (_, index) => ({
      id: `older-task-${index}`, sessionId: 'session-1', role: 'researcher', taskType: 'scout', status: 'queued', goal: `Older task ${index}`, hasResult: false,
    }))]
    const outsideTask = {
      id: 'task-outside-first-page', sessionId: 'session-1', role: 'scout', taskType: 'scout', status: 'completed',
      goal: 'Latest task returned by referenced ID lookup', hasResult: true,
      structuredEvidencePreview: {
        role: 'scout', summary: 'Scout completed: 1 candidate; 1 linked evidence item.', itemCount: 1,
        evidence: [{ kind: 'job', source: 'greenhouse', reference: null }],
      },
    } as unknown as SupervisorTaskSummary
    const graphItems = [olderGraph, latestGraph]

    expect(firstHundred).toHaveLength(100)
    expect(projectCurrentTaskGraph(graphItems, firstHundred, 'session-1')?.nodes[0]).toMatchObject({ status: null, readiness: 'unavailable' })

    const html = renderToStaticMarkup(<TaskGraphPlanPanel
      sessionId="session-1"
      items={graphItems}
      tasks={[outsideTask, ...firstHundred]}
    />)

    expect(html).toContain('data-agent-task-graph-revision="4"')
    expect(html).toContain('Root plan goal from task record')
    expect(html).toContain('Latest task returned by referenced ID lookup')
    expect(html).toContain('Completed')
    expect(html).toContain('Scout completed: 1 candidate; 1 linked evidence item.')
    expect(html).toContain('greenhouse')
    expect(html).not.toContain('task-outside-first-page')
    expect(html).not.toContain('old snapshot')
    expect(html).not.toContain('private criterion')
  })
})
