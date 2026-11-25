import { describe, expect, it } from 'vitest'

import { projectSelectedTaskInterrupt, projectSupervisorTree, taskInterruptStatus, taskIsInterruptible, type SupervisorTaskSummary, type SupervisorTurnSummary } from './task-tree-projection'
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
  it('enables interruption only for active non-root children and projects durable outcomes', () => {
    const selected = task('child-1', { rootTaskId: 'root-1', parentTaskId: 'root-1', status: 'running' })
    const activeTurn = turn({ status: 'in_progress' })
    const accepted = item({ id: 'interrupt-accepted', taskId: selected.id, type: 'unknown', content: {
      eventType: 'task.interrupt.accepted', payload: { taskId: selected.id, intentId: 'intent-1' },
    }, sequence: '11', createdAt: '2026-09-07T10:02:00.000Z' })
    const second = task('child-2', { rootTaskId: 'root-1', parentTaskId: 'root-1', status: 'running' })
    const secondAccepted = item({ id: 'interrupt-accepted-2', taskId: second.id, type: 'unknown', content: {
      eventType: 'task.interrupt.accepted', payload: { taskId: second.id, intentId: 'internal-2' },
    }, sequence: '12', createdAt: '2026-09-07T10:02:01.000Z' })
    expect(taskIsInterruptible(selected, activeTurn, null)).toBe(true)
    expect(taskInterruptStatus(selected, [accepted])).toBe('accepted')
    expect(taskIsInterruptible(selected, activeTurn, 'accepted')).toBe(false)
    expect(taskInterruptStatus(second, [accepted, secondAccepted])).toBe('accepted')
    expect(projectSelectedTaskInterrupt([selected, second], [activeTurn], { id: `task:${second.id}`, kind: 'task', label: 'second', status: 'running' }, [accepted, secondAccepted]))
      .toMatchObject({ status: 'accepted', eligible: false })
    expect(taskInterruptStatus(task(selected.id, { ...selected, status: 'interrupted' }), [])).toBe('interrupted')

    const failed = item({ id: 'interrupt-failed', taskId: selected.id, type: 'unknown', content: {
      eventType: 'task.interrupt.failed', payload: { taskId: selected.id, code: 'target_unavailable' },
    }, sequence: '12', createdAt: '2026-09-07T10:01:00.000Z' })
    expect(taskInterruptStatus(selected, [failed])).toBe('failed')
    expect(taskInterruptStatus(selected, [accepted, failed])).toBe('failed')
    expect(taskIsInterruptible(task('root-1', { rootTaskId: 'root-1', status: 'running' }), activeTurn, null)).toBe(false)
    expect(taskIsInterruptible(selected, turn({ status: 'completed' }), null)).toBe(false)
  })

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

  it('classifies only same-session failed paginated children without their Turn', () => {
    const paginated = task('paged-child', { turnId: 'older-turn', rootTaskId: 'root-1', parentTaskId: 'root-1',
      role: 'scout', taskType: 'scout', status: 'failed', failureReason: 'task_graph_child_deadline_exceeded' })
    const foreign = task('foreign-paged', { sessionId: 'session-2', turnId: 'older-turn', rootTaskId: 'root-1', parentTaskId: 'root-1',
      role: 'scout', taskType: 'scout', status: 'failed', failureReason: 'task_graph_child_deadline_exceeded' })
    const unknown = task('unknown-paged', { turnId: 'older-turn', rootTaskId: 'root-1', parentTaskId: 'root-1',
      role: 'scout', taskType: 'scout', status: 'failed', failureReason: 'private provider failure' })
    const active = task('active-paged', { turnId: 'older-turn', rootTaskId: 'root-1', parentTaskId: 'root-1',
      role: 'scout', taskType: 'scout', status: 'running', failureReason: 'task_graph_child_deadline_exceeded' })
    const find = (nodes: TaskTreeNode[], id: string) => nodes.find(node => node.id === `task:${id}`)

    const nodes = projectSupervisorTree({ turns: [], items: [], tasks: [paginated, foreign, unknown, active], expectedSessionId: 'session-1' })
    expect(find(nodes, paginated.id)).toMatchObject({ childFailure: 'deadline_exceeded' })
    for (const id of [foreign.id, unknown.id, active.id]) {
      expect(find(nodes, id)).not.toHaveProperty('childFailure')
      expect(find(nodes, id)).not.toHaveProperty('detail')
    }
    expect(JSON.stringify(nodes)).not.toContain('private provider failure')
    expect(find(projectSupervisorTree({ turns: [], items: [], tasks: [paginated] }), paginated.id)).not.toHaveProperty('childFailure')
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

  it('projects fixed failure categories for children while preserving root detail and hiding unknown child text', () => {
    const nodes = projectSupervisorTree({ turns: [turn()], items: [], tasks: [
      task('root-1', { rootTaskId: 'root-1', role: 'orchestrator', taskType: 'root', status: 'failed', failureReason: 'legacy root detail' }),
      task('mislabelled-root', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'orchestrator', taskType: 'root',
        status: 'failed', failureReason: 'private parent-bearing root reason' }),
      task('deadline-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'task_graph_child_deadline_exceeded' }),
      task('verification-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'task_graph_verification_unverified' }),
      task('verification-failed-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'task_graph_verification_failed' }),
      task('dependency-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'task_graph_dependency_scope_mismatch' }),
      task('recovery-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'child_resume_evidence_unavailable' }),
      task('unknown-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'private provider failure' }),
      task('foreign-child', { sessionId: 'session-2', rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'task_graph_child_deadline_exceeded' }),
      task('malformed-child', { rootTaskId: 'root-1', parentTaskId: 'malformed-child', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'private malformed reason' }),
      task('root-alias-child', { rootTaskId: 'root-alias-child', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'private root alias reason' }),
      task('missing-root-child', { rootTaskId: null, parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'failed', failureReason: 'private missing root reason' }),
      task('not-failed-child', { rootTaskId: 'root-1', parentTaskId: 'root-1', role: 'scout', taskType: 'scout',
        status: 'running', failureReason: 'task_graph_child_deadline_exceeded' }),
      task('legacy-task', { turnId: null, role: 'scout', taskType: 'scout', status: 'failed', failureReason: 'legacy task detail' }),
    ] })
    const findNode = (id: string, entries: readonly TaskTreeNode[] = nodes): TaskTreeNode | undefined => {
      for (const node of entries) {
        if (node.id === id) return node
        const nested = findNode(id, node.children ?? [])
        if (nested) return nested
      }
      return undefined
    }
    const root = findNode('task:root-1')
    const mislabelledRoot = findNode('task:mislabelled-root')
    const deadline = findNode('task:deadline-child')
    const verification = findNode('task:verification-child')
    const verificationFailed = findNode('task:verification-failed-child')
    const dependency = findNode('task:dependency-child')
    const recovery = findNode('task:recovery-child')
    const unknown = findNode('task:unknown-child')
    const foreign = findNode('task:foreign-child')
    const malformed = findNode('task:malformed-child')
    const rootAlias = findNode('task:root-alias-child')
    const missingRoot = findNode('task:missing-root-child')
    const notFailed = findNode('task:not-failed-child')
    const legacy = findNode('task:legacy-task')

    expect(root).toMatchObject({ detail: 'legacy root detail' })
    expect(root).not.toHaveProperty('childFailure')
    expect(mislabelledRoot).not.toHaveProperty('childFailure')
    expect(mislabelledRoot).not.toHaveProperty('detail')
    expect(deadline).toMatchObject({ childFailure: 'deadline_exceeded' })
    expect(deadline).not.toHaveProperty('detail')
    expect(verification).toMatchObject({ childFailure: 'verification_unverified' })
    expect(verificationFailed).toMatchObject({ childFailure: 'verification_failed' })
    expect(dependency).toMatchObject({ childFailure: 'dependency_unavailable_or_incompatible' })
    expect(recovery).toMatchObject({ childFailure: 'recovery_unavailable' })
    expect(unknown).not.toHaveProperty('childFailure')
    expect(unknown).not.toHaveProperty('detail')
    expect(foreign).not.toHaveProperty('childFailure')
    expect(foreign).not.toHaveProperty('detail')
    expect(malformed).not.toHaveProperty('childFailure')
    expect(malformed).not.toHaveProperty('detail')
    expect(rootAlias).not.toHaveProperty('childFailure')
    expect(rootAlias).not.toHaveProperty('detail')
    expect(missingRoot).not.toHaveProperty('childFailure')
    expect(missingRoot).not.toHaveProperty('detail')
    expect(notFailed).not.toHaveProperty('childFailure')
    expect(notFailed).not.toHaveProperty('detail')
    expect(legacy).toMatchObject({ detail: 'legacy task detail' })
    expect(JSON.stringify(nodes)).not.toContain('private provider failure')
    expect(JSON.stringify(nodes)).not.toContain('private parent-bearing root reason')
    expect(JSON.stringify(nodes)).not.toContain('private malformed reason')
    expect(JSON.stringify(nodes)).not.toContain('private root alias reason')
    expect(JSON.stringify(nodes)).not.toContain('private missing root reason')
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
