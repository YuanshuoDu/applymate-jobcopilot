import { describe, expect, it } from 'vitest'

import type { TimelineItem } from './timeline-reducer'
import type { SupervisorTaskSummary } from './task-tree-projection'
import { projectCurrentTaskGraph } from './task-graph-plan'

const sessionId = 'session-1'
const schemaVersion = 'agent-harness.v2.task-graph'

function graphNode(key: string, taskId: string, dependsOn: string[] = [], depth = dependsOn.length + 1, goal = `Snapshot ${key}`) {
  return { key, templateId: 'scout', goal, successCriteria: [`Evidence for ${key}`], dependsOn, depth, taskId }
}

function graphItem(content: unknown, updatedAt = '2026-09-23T12:00:00.000Z', itemSessionId = sessionId, id = `graph-${updatedAt}`, revision = 1, taskId = 'root-task'): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId: itemSessionId, turnId: 'turn-1', stepId: null, taskId,
    type: 'task_graph', status: 'streaming', phase: 'commentary', revision, content,
    startedAt: null, completedAt: null, createdAt: updatedAt, updatedAt, source: 'replay', sequence: null,
  }
}

function task(overrides: Partial<SupervisorTaskSummary> = {}): SupervisorTaskSummary {
  return {
    id: 'task-a', sessionId, role: 'researcher', taskType: 'scout', status: 'queued', goal: 'Current task goal', hasResult: false,
    updatedAt: '2026-09-23T12:00:00.000Z', ...overrides,
  }
}

describe('TaskGraph plan projection', () => {
  it('normalizes a legacy passed dependency to completed before deriving dependent readiness', () => {
    const projection = projectCurrentTaskGraph([graphItem({
      schemaVersion,
      nodes: [
        graphNode('passed-dependency', 'passed-task'),
        graphNode('dependent', 'dependent-task', ['passed-dependency'], 2),
      ],
    })], [
      task({ id: 'passed-task', status: 'passed', goal: 'Finished legacy task', hasResult: true }),
      task({ id: 'dependent-task', status: 'queued' }),
    ], sessionId)

    expect(projection?.nodes.map(node => [node.key, node.status, node.readiness])).toEqual([
      ['passed-dependency', 'completed', 'terminal'],
      ['dependent', 'queued', 'ready'],
    ])
    expect(projection?.nodes.find(node => node.key === 'dependent')?.dependencies).toEqual([
      { key: 'passed-dependency', label: 'Finished legacy task', status: 'completed' },
    ])
  })

  it('uses the latest same-session snapshot and scoped task DTOs for goals, statuses, and readiness', () => {
    const older = { schemaVersion, nodes: [graphNode('old', 'old-task')] }
    const latest = {
      schemaVersion,
      nodes: [
        graphNode('done', 'done-task', [], 1, 'Untrusted snapshot title'),
        graphNode('ready', 'ready-task', ['done'], 2),
        graphNode('active', 'active-task'),
        graphNode('waiting', 'waiting-task', ['active'], 2),
        graphNode('waiting-after-dependencies', 'waiting-after-dependencies-task', ['done'], 2),
        graphNode('failed', 'failed-task'),
        graphNode('blocked', 'blocked-task', ['failed'], 2),
        graphNode('foreign', 'foreign-task'),
      ],
    }
    const projection = projectCurrentTaskGraph([
      graphItem(older, '2026-09-23T11:00:00.000Z'),
      graphItem(latest, '2026-09-23T12:00:00.000Z', sessionId, 'graph-latest', 2),
      graphItem({ schemaVersion, nodes: [graphNode('other-session', 'private-task')] }, '2026-09-23T13:00:00.000Z', 'session-2'),
    ], [
      task({ id: 'root-task', role: 'orchestrator', goal: 'Plan goal from the root task' }),
      task({ id: 'done-task', status: 'completed', goal: 'Completed dependency', hasResult: true }),
      task({ id: 'ready-task', status: 'queued', goal: 'Ready current goal' }),
      task({ id: 'active-task', status: 'running', goal: 'Active dependency' }),
      task({ id: 'waiting-task', status: 'queued', goal: 'Waiting current goal' }),
      task({ id: 'waiting-after-dependencies-task', status: 'waiting', goal: 'Waiting on runtime input' }),
      task({ id: 'failed-task', status: 'failed', goal: 'Failed dependency' }),
      task({ id: 'blocked-task', status: 'queued', goal: 'Blocked current goal' }),
      task({ id: 'foreign-task', sessionId: 'session-2', status: 'completed', goal: 'CROSS_SESSION_SECRET' }),
    ], sessionId)

    expect(projection).toMatchObject({ revision: 2, goal: 'Plan goal from the root task' })
    expect(projection?.nodes.map(node => [node.key, node.status, node.readiness])).toEqual([
      ['done', 'completed', 'terminal'],
      ['ready', 'queued', 'ready'],
      ['active', 'running', 'active'],
      ['waiting', 'queued', 'waiting_for_dependencies'],
      ['waiting-after-dependencies', 'waiting', 'active'],
      ['failed', 'failed', 'terminal'],
      ['blocked', 'queued', 'blocked_dependency'],
      ['foreign', null, 'unavailable'],
    ])
    expect(projection?.nodes.find(node => node.key === 'done')).toMatchObject({ goal: 'Completed dependency', resultAvailable: true })
    expect(projection?.nodes.find(node => node.key === 'ready')?.dependencies).toEqual([{ key: 'done', label: 'Completed dependency', status: 'completed' }])
    expect(projection?.nodes.find(node => node.key === 'foreign')?.goal).toBe('Snapshot foreign')
    expect(projectCurrentTaskGraph([graphItem({ schemaVersion, nodes: [] }, '2026-09-23T14:00:00.000Z')], [], sessionId)).toBeNull()
  })

  it('fails closed when the latest TaskGraph item is malformed instead of showing an older plan', () => {
    const valid = graphItem({ schemaVersion, nodes: [graphNode('a', 'task-a')] }, '2026-09-23T11:00:00.000Z')
    const invalid = graphItem({ schemaVersion: 'wrong', nodes: [graphNode('b', 'task-b')] }, '2026-09-23T12:00:00.000Z')
    expect(projectCurrentTaskGraph([valid, invalid], [task()], sessionId)).toBeNull()
  })

  it('uses timeline order for equal or missing graph timestamps', () => {
    const older = graphItem({ schemaVersion, nodes: [graphNode('older', 'older-task')] }, '2026-09-23T12:00:00.000Z', sessionId, 'graph-older')
    const later = graphItem({ schemaVersion, nodes: [graphNode('later', 'later-task')] }, '2026-09-23T12:00:00.000Z', sessionId, 'graph-later')
    expect(projectCurrentTaskGraph([older, later], [], sessionId)?.nodes.map(node => node.key)).toEqual(['later'])
    expect(projectCurrentTaskGraph([later, older], [], sessionId)?.nodes.map(node => node.key)).toEqual(['older'])

    const missingTimeOlder = { ...older, id: 'missing-older', createdAt: undefined, updatedAt: undefined } as unknown as TimelineItem
    const missingTimeLater = { ...later, id: 'missing-later', createdAt: undefined, updatedAt: undefined } as unknown as TimelineItem
    expect(projectCurrentTaskGraph([missingTimeOlder, missingTimeLater], [], sessionId)?.nodes.map(node => node.key)).toEqual(['later'])
  })

  it('keeps the first duplicate task DTO on tied or missing timestamps and accepts only a clearly newer DTO', () => {
    const item = graphItem({ schemaVersion, nodes: [graphNode('a', 'task-a')] })
    const tied = projectCurrentTaskGraph([item], [
      task({ status: 'running', goal: 'Selected current row', updatedAt: '2026-09-23T12:00:00.000Z' }),
      task({ status: 'failed', goal: 'Late stale row', updatedAt: '2026-09-23T12:00:00.000Z' }),
    ], sessionId)
    expect(tied?.nodes[0]).toMatchObject({ status: 'running', goal: 'Selected current row' })

    const missing = projectCurrentTaskGraph([item], [
      task({ status: 'waiting', goal: 'Selected row without time', updatedAt: undefined }),
      task({ status: 'failed', goal: 'Late row with no comparable time', updatedAt: '2026-09-23T13:00:00.000Z' }),
    ], sessionId)
    expect(missing?.nodes[0]).toMatchObject({ status: 'waiting', goal: 'Selected row without time' })

    const newer = projectCurrentTaskGraph([item], [
      task({ status: 'running', goal: 'Older row', updatedAt: '2026-09-23T11:00:00.000Z' }),
      task({ status: 'completed', goal: 'Newer row', updatedAt: '2026-09-23T12:00:00.000Z' }),
      task({ status: 'failed', goal: 'Late old row', updatedAt: '2026-09-23T10:00:00.000Z' }),
    ], sessionId)
    expect(newer?.nodes[0]).toMatchObject({ status: 'completed', goal: 'Newer row' })
  })

  it('uses a same-session root goal and a strict result-availability bit without exposing result payloads', () => {
    const item = graphItem({ schemaVersion, nodes: [graphNode('a', 'task-a')] })
    const resultTask = { ...task({ id: 'task-a', hasResult: true }), result: 'PRIVATE_RAW_RESULT' }
    const projection = projectCurrentTaskGraph([item], [
      task({ id: 'root-task', goal: 'CROSS_SESSION_SECRET', sessionId: 'session-2' }),
      resultTask,
    ], sessionId)

    expect(projection).toMatchObject({ revision: 1, goal: null })
    expect(projection?.nodes[0]?.resultAvailable).toBe(true)
    expect(JSON.stringify(projection)).not.toContain('PRIVATE_RAW_RESULT')
    expect(JSON.stringify(projection)).not.toContain('CROSS_SESSION_SECRET')
  })

  it('falls back to redacted snapshot goals when task records are unavailable without displaying internal node keys', () => {
    const snapshotGoal = `Research European roles for alex@example.com ${'x'.repeat(260)}`
    const projection = projectCurrentTaskGraph([graphItem({ schemaVersion, nodes: [
      graphNode('internal-parent-key', 'missing-parent-task', [], 1, snapshotGoal),
      graphNode('internal-child-key', 'missing-child-task', ['internal-parent-key'], 2, 'Compare the matching roles'),
    ] })], [], sessionId)

    expect(projection?.nodes[0]).toMatchObject({
      goal: 'Research European roles for [redacted] ' + 'x'.repeat(201),
      status: null,
      readiness: 'unavailable',
    })
    expect(projection?.nodes[0]?.goal).toHaveLength(240)
    expect(projection?.nodes[0]?.goal).not.toContain('internal-parent-key')
    expect(projection?.nodes[1]).toMatchObject({ goal: 'Compare the matching roles', status: null, readiness: 'unavailable' })
    expect(projection?.nodes[1]?.goal).not.toContain('internal-child-key')
    expect(projection?.nodes[1]?.dependencies).toEqual([{
      key: 'internal-parent-key',
      label: 'Research European roles for [redacted] ' + 'x'.repeat(201),
      status: null,
    }])
    expect(projection?.nodes[1]?.dependencies[0]?.label).not.toContain('internal-parent-key')
  })

  it('redacts unsafe substrings in root, node, and dependency goals while preserving surrounding text', () => {
    const item = graphItem({ schemaVersion, nodes: [
      graphNode('dependency', 'dependency-task'),
      graphNode('child', 'child-task', ['dependency'], 2),
    ] })
    const projection = projectCurrentTaskGraph([item], [
      task({ id: 'root-task', goal: 'Research roles with hiring team alex@example.com, then summarize.' }),
      task({ id: 'dependency-task', goal: 'Check https://boards.example/jobs?role=engineer, then call +353 87 123 4567 after lunch.' }),
      task({ id: 'child-task', goal: 'Compare http://docs.example/guide?step=1; then summarize.' }),
    ], sessionId)

    expect(projection?.goal).toBe('Research roles with hiring team [redacted], then summarize.')
    expect(projection?.nodes[0]?.goal).toBe('Check [redacted], then call [redacted] after lunch.')
    expect(projection?.nodes[1]?.goal).toBe('Compare [redacted]; then summarize.')
    expect(projection?.nodes[1]?.dependencies).toEqual([{
      key: 'dependency', label: 'Check [redacted], then call [redacted] after lunch.', status: 'queued',
    }])
    expect(JSON.stringify(projection)).not.toMatch(/alex@example\.com|https?:\/\/|\+353 87 123 4567/)
  })

  it('projects only a completed same-session DTO evidence preview and ignores raw result fields', () => {
    const item = graphItem({ schemaVersion, nodes: [graphNode('a', 'task-a')] })
    const completed = {
      ...task({ id: 'task-a', role: 'scout', status: 'completed', hasResult: true }),
      structuredEvidencePreview: {
        role: 'scout', summary: 'Scout completed: 1 candidate; 1 linked evidence item.', itemCount: 1,
        evidence: [{ kind: 'job', source: 'greenhouse', reference: null }],
      },
      result: { finalText: 'RAW_PRIVATE_RESULT', structuredResult: { url: 'PRIVATE_URL' } },
    } as unknown as SupervisorTaskSummary
    const foreign = {
      ...completed, sessionId: 'session-2',
      structuredEvidencePreview: { role: 'scout', summary: 'CROSS_SESSION_SECRET', itemCount: 1, evidence: [] },
    }

    const projection = projectCurrentTaskGraph([item], [completed, foreign], sessionId)
    expect(projection?.nodes[0]?.evidencePreview).toEqual({
      role: 'scout', summary: 'Scout completed: 1 candidate; 1 linked evidence item.', itemCount: 1,
      evidence: [{ kind: 'job', source: 'greenhouse', reference: null }],
    })
    expect(JSON.stringify(projection)).not.toContain('RAW_PRIVATE_RESULT')
    expect(JSON.stringify(projection)).not.toContain('PRIVATE_URL')
    expect(JSON.stringify(projection)).not.toContain('CROSS_SESSION_SECRET')
    expect(projectCurrentTaskGraph([item], [{ ...completed, status: 'running' }], sessionId)?.nodes[0]?.evidencePreview).toBeNull()
  })

  it('fails closed for missing or unsafe durable plan revisions', () => {
    const snapshot = { schemaVersion, nodes: [graphNode('a', 'task-a')] }
    expect(projectCurrentTaskGraph([graphItem(snapshot, '2026-09-23T12:00:00.000Z', sessionId, 'bad-zero', 0)], [task()], sessionId)).toBeNull()
    expect(projectCurrentTaskGraph([graphItem(snapshot, '2026-09-23T12:00:00.000Z', sessionId, 'bad-large', Number.MAX_SAFE_INTEGER + 1)], [task()], sessionId)).toBeNull()
  })
})
