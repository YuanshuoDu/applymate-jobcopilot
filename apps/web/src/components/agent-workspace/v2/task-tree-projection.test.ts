import { describe, expect, it } from 'vitest'

import { projectSupervisorTree, type SupervisorTaskSummary, type SupervisorTurnSummary } from './task-tree-projection'
import type { TimelineItem } from './timeline-reducer'
import type { TaskTreeNode } from './types'

const turn = (overrides: Partial<SupervisorTurnSummary> = {}): SupervisorTurnSummary => ({
  id: 'turn-1', sessionId: 'session-1', source: 'message', goal: 'Find roles', status: 'completed', revision: 1,
  activeStepId: null, finalItemId: null, createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:01:00.000Z', completedAt: '2026-09-07T10:01:00.000Z', ...overrides,
})

const item = (overrides: Partial<TimelineItem> = {}): TimelineItem => ({
  schemaVersion: 'agent.v2', id: 'item-1', sessionId: 'session-1', turnId: 'turn-1', stepId: null, taskId: null,
  type: 'agent_message', status: 'completed', phase: 'final_answer', revision: 1, content: { text: 'done' },
  startedAt: '2026-09-07T10:00:00.000Z', completedAt: '2026-09-07T10:01:00.000Z', createdAt: '2026-09-07T10:00:00.000Z', updatedAt: '2026-09-07T10:01:00.000Z', source: 'replay', sequence: null, ...overrides,
})

const task = (id: string, overrides: Partial<SupervisorTaskSummary> = {}): SupervisorTaskSummary => ({
  id, sessionId: 'session-1', turnId: 'turn-1', role: '', taskType: '', status: 'queued', goal: '', hasResult: false, ...overrides,
})

describe('projectSupervisorTree', () => {
  it('uses the authoritative active step status and localizes fallback labels', () => {
    const nodes = projectSupervisorTree({
      turns: [turn({ status: 'waiting_for_user', activeStepId: 'step-1', goal: '' })],
      items: [item({ id: 'item-step', stepId: 'step-1', type: 'plan', status: 'completed', content: { steps: [] } })],
      labels: { task: '任务', step: '计划', tool: '工具' },
    })

    expect(nodes[0]).toMatchObject({ label: '任务', status: 'waiting_for_user' })
    expect(nodes[0]?.children?.[0]).toMatchObject({ label: '计划', status: 'waiting_for_user' })
  })

  it('keeps orphan timeline evidence visible under a safe synthetic turn', () => {
    const nodes = projectSupervisorTree({ turns: [], items: [item({ turnId: 'missing-turn' })], labels: { task: '任务', step: '计划', tool: '工具' } })
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'turn', label: '任务', status: 'unknown' })
    expect(nodes[0]?.itemId).toBe('item-1')
  })

  it('marks a tool result available from the redacted output summary shape', () => {
    const nodes = projectSupervisorTree({
      turns: [turn()],
      items: [
        item({ id: 'tool-call', type: 'tool_call', phase: 'commentary', content: { toolCallId: 'call-1', toolName: 'jobs.search' } }),
        item({ id: 'tool-result', type: 'tool_result', phase: 'commentary', content: { toolCallId: 'call-1', outputAvailable: true } }),
      ],
    })
    const tool = nodes[0]?.children?.[0]
    expect(tool).toMatchObject({ kind: 'tool', label: 'jobs.search', resultAvailable: true, itemId: 'tool-result' })
  })

  it('links task selection to its latest task-owned evidence', () => {
    const nodes = projectSupervisorTree({
      turns: [turn()],
      items: [item({ id: 'task-evidence', taskId: 'task-a', type: 'agent_message', content: { text: 'Task evidence' } })],
      tasks: [task('task-a', { goal: 'Read saved roles', hasResult: true })],
    })

    expect(nodes[0]?.children?.[0]).toMatchObject({ kind: 'task', itemId: 'task-evidence', resultAvailable: true })
  })

  it('bounds malformed cyclic task parents without dropping their records', () => {
    const nodes = projectSupervisorTree({ turns: [], items: [], tasks: [
      task('a', { turnId: null, parentTaskId: 'b', goal: 'A' }),
      task('b', { turnId: null, parentTaskId: 'a', goal: 'B' }),
    ] })
    const ids: string[] = []
    const visit = (entries: readonly TaskTreeNode[]) => entries.forEach(node => { ids.push(node.id); visit(node.children ?? []) })
    visit(nodes)
    expect(new Set(ids)).toEqual(new Set(['task:a', 'task:b']))
    expect(ids).toHaveLength(2)
  })
})
