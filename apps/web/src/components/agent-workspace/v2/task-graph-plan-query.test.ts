import { describe, expect, it } from 'vitest'

import type { TimelineItem } from './timeline-reducer'
import { buildTaskGraphTaskLookupUrl, selectCurrentTaskGraphTaskIds } from './task-graph-plan-query'

const schemaVersion = 'agent-harness.v2.task-graph'

function graphNode(key: string, taskId: string) {
  return { key, templateId: 'scout', goal: `Snapshot ${key}`, successCriteria: [`Evidence for ${key}`], dependsOn: [], depth: 1, taskId }
}

function graphItem(nodes: unknown[], updatedAt: string, sessionId: string, id: string, taskId: string | null = 'root-task', turnId = 'turn-1'): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id, sessionId, turnId, stepId: null, taskId,
    type: 'task_graph', status: 'streaming', phase: 'commentary', revision: 1,
    content: { schemaVersion, nodes },
    startedAt: null, completedAt: null, createdAt: updatedAt, updatedAt, source: 'replay', sequence: null,
  }
}

describe('TaskGraph query projection', () => {
  it('builds a URL from only the latest valid graph in the target session', () => {
    const older = graphItem([graphNode('old', 'old-task')], '2026-09-23T11:00:00.000Z', 'session/1', 'graph-old', 'old-root')
    const latest = graphItem([graphNode('a', 'task-a'), graphNode('b', 'task-b')], '2026-09-23T12:00:00.000Z', 'session/1', 'graph-latest')
    const foreign = graphItem([graphNode('private', 'private-task')], '2026-09-23T13:00:00.000Z', 'session-2', 'graph-foreign')

    expect(selectCurrentTaskGraphTaskIds([older, latest, foreign], 'session/1')).toEqual(['root-task', 'task-a', 'task-b'])
    expect(buildTaskGraphTaskLookupUrl('session/1', [older, latest, foreign])).toBe(
      '/api/agent/sessions/session%2F1/tasks?taskId=root-task&taskId=task-a&taskId=task-b&graphItemId=graph-latest&graphTurnId=turn-1&rootTaskId=root-task&graphRevision=1',
    )
  })

  it('refreshes the task lookup key when the graph revision changes but task IDs stay the same', () => {
    const revisionOne = graphItem([graphNode('a', 'task-a')], '2026-09-23T12:00:00.000Z', 'session-1', 'graph-latest')
    const revisionTwo = { ...revisionOne, revision: 2 }

    const firstUrl = buildTaskGraphTaskLookupUrl('session-1', [revisionOne])
    const nextUrl = buildTaskGraphTaskLookupUrl('session-1', [revisionTwo])

    expect(firstUrl).toBe('/api/agent/sessions/session-1/tasks?taskId=root-task&taskId=task-a&graphItemId=graph-latest&graphTurnId=turn-1&rootTaskId=root-task&graphRevision=1')
    expect(nextUrl).toBe('/api/agent/sessions/session-1/tasks?taskId=root-task&taskId=task-a&graphItemId=graph-latest&graphTurnId=turn-1&rootTaskId=root-task&graphRevision=2')
    expect(nextUrl).not.toBe(firstUrl)
  })

  it('keeps equal-revision roots distinct so an old query cannot be mistaken for the selected graph', () => {
    const oldRoot = graphItem([graphNode('old', 'old-child')], '2026-09-23T11:00:00.000Z', 'session-1', 'graph-old', 'old-root', 'turn-old')
    const newRoot = graphItem([graphNode('new', 'new-child')], '2026-09-23T12:00:00.000Z', 'session-1', 'graph-new', 'new-root', 'turn-new')
    const staleUrl = buildTaskGraphTaskLookupUrl('session-1', [oldRoot])!
    const currentUrl = buildTaskGraphTaskLookupUrl('session-1', [oldRoot, newRoot])!

    expect(new URLSearchParams(staleUrl.split('?')[1]).get('graphItemId')).toBe('graph-old')
    expect(new URLSearchParams(staleUrl.split('?')[1]).get('graphTurnId')).toBe('turn-old')
    expect(new URLSearchParams(staleUrl.split('?')[1]).get('rootTaskId')).toBe('old-root')
    expect(new URLSearchParams(staleUrl.split('?')[1]).get('graphRevision')).toBe('1')
    expect(new URLSearchParams(currentUrl.split('?')[1]).get('graphItemId')).toBe('graph-new')
    expect(new URLSearchParams(currentUrl.split('?')[1]).get('turnId')).toBeNull()
    expect(new URLSearchParams(currentUrl.split('?')[1]).get('rootTaskId')).toBe('new-root')
    expect(new URLSearchParams(currentUrl.split('?')[1]).get('graphRevision')).toBe('1')
  })

  it('does not query a stale graph when the latest snapshot is malformed', () => {
    const valid = graphItem([graphNode('valid', 'valid-task')], '2026-09-23T11:00:00.000Z', 'session-1', 'graph-valid')
    const invalid = {
      ...graphItem([graphNode('bad', 'bad-task')], '2026-09-23T12:00:00.000Z', 'session-1', 'graph-invalid'),
      content: { schemaVersion: 'future', nodes: [graphNode('bad', 'bad-task')] },
    } as unknown as TimelineItem

    expect(selectCurrentTaskGraphTaskIds([valid, invalid], 'session-1')).toEqual([])
    expect(buildTaskGraphTaskLookupUrl('session-1', [valid, invalid])).toBeNull()
    expect(buildTaskGraphTaskLookupUrl(null, [valid])).toBeNull()
  })
})
