import { describe, expect, it } from 'vitest'

import type { TimelineItem } from './timeline-reducer'
import { latestWriterArtifact } from './draft-artifact-projection'
import { projectCurrentTaskGraph } from './task-graph-plan'
import { buildTaskGraphTaskLookupUrl, latestSelectedJobPreparationTurnId, selectCurrentTaskGraphTaskIds, selectedJobIdForTurn, selectedJobPreparationTurnId, selectedTaskGraphIdentity } from './task-graph-plan-query'
import { SELECTED_JOB_PREPARATION_MESSAGE_TEXT } from './selected-job-preparation-action'

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

function selectedPreparationItem(turnId: string, sequence: string | null = null): TimelineItem {
  return {
    schemaVersion: 'agent-harness.v2', id: `message-${turnId}`, sessionId: 'session-1', turnId, stepId: null, taskId: null,
    type: 'user_message', status: 'completed', phase: 'commentary', revision: 1,
    content: { parts: [{ type: 'text', text: SELECTED_JOB_PREPARATION_MESSAGE_TEXT }] },
    startedAt: null, completedAt: null, createdAt: '2026-09-23T12:00:00.000Z', updatedAt: '2026-09-23T12:00:00.000Z', source: 'replay', sequence,
  }
}

function writerTask(turnId: string, rootTaskId: string, artifactId: string) {
  return {
    id: `writer-${turnId}`, sessionId: 'session-1', turnId, rootTaskId, role: 'writer', taskType: 'cover_letter_draft',
    status: 'completed', goal: 'Prepare draft', hasResult: true, updatedAt: '2026-09-23T12:00:00.000Z',
    artifactRef: { artifactId, version: 1, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` },
  }
}

describe('TaskGraph query projection', () => {
  it('selects the latest persisted native item.delta graph and includes its real child task IDs', () => {
    const metadata = {
      schemaVersion: 'agent-harness.v2.task-graph.native-delegation.v1', operationKind: 'spawn',
      operationId: 'native-operation-1', requestFingerprint: 'a'.repeat(64), callerTaskId: 'root-task',
      role: 'auditor', taskType: 'audit', contextDigest: 'b'.repeat(64), contextBytes: 12,
    }
    const spawn = {
      key: 'native-spawn', templateId: 'native', goal: 'Inspect the application', successCriteria: [], dependsOn: [],
      depth: 1, taskId: 'native-child-1', verificationDisposition: 'legacy_unverified', nativeDelegation: metadata,
    }
    const source = {
      taskId: 'native-child-1', rootTaskId: 'root-task', parentTaskId: 'root-task', turnId: 'turn-1',
      role: 'auditor', taskType: 'audit', status: 'failed', attemptCount: 1,
      resultDigest: 'd'.repeat(64), graphNodeKey: 'native-spawn', origin: 'task_graph',
    }
    const followup = {
      key: 'native-followup', templateId: 'native', goal: 'Retry the inspection', successCriteria: [], dependsOn: [],
      depth: 1, taskId: 'native-child-2', verificationDisposition: 'legacy_unverified',
      nativeDelegation: { ...metadata, operationKind: 'followup', operationId: 'native-operation-2', source },
    }
    const started = graphItem([spawn], '2026-09-23T12:00:00.000Z', 'session-1', 'native-graph')
    const delta = { ...graphItem([spawn, followup], '2026-09-23T12:01:00.000Z', 'session-1', 'native-graph'), revision: 2 }
    const events = [started, delta]

    expect(selectedTaskGraphIdentity(events, 'session-1')).toEqual({
      sessionId: 'session-1', graphItemId: 'native-graph', turnId: 'turn-1', rootTaskId: 'root-task', revision: 2,
    })
    expect(selectCurrentTaskGraphTaskIds(events, 'session-1')).toEqual(['root-task', 'native-child-1', 'native-child-2'])
    expect(buildTaskGraphTaskLookupUrl('session-1', events)).toBe(
      '/api/agent/sessions/session-1/tasks?taskId=root-task&taskId=native-child-1&taskId=native-child-2&graphItemId=native-graph&graphTurnId=turn-1&rootTaskId=root-task&graphRevision=2',
    )
  })

  it('restores only the selected job on the matching preparation Turn and session', () => {
    const turns = [
      { id: 'prepare-a', sessionId: 'session-a', selectedJobId: 'job-a' },
      { id: 'prepare-b', sessionId: 'session-b', selectedJobId: 'job-b' },
      { id: 'chat-a', sessionId: 'session-a', selectedJobId: 'job-chat' },
      { id: 'invalid', sessionId: 'session-a', selectedJobId: ' job-invalid ' },
    ]
    expect(selectedJobIdForTurn(turns, 'session-a', 'prepare-a')).toBe('job-a')
    expect(selectedJobIdForTurn(turns, 'session-a', 'prepare-b')).toBeNull()
    expect(selectedJobIdForTurn(turns, 'session-b', 'prepare-a')).toBeNull()
    expect(selectedJobIdForTurn(turns, 'session-a', null)).toBeNull()
    expect(selectedJobIdForTurn(turns, 'session-a', 'invalid')).toBeNull()
  })
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

  it('hides the prior selected-job plan and draft until the newer request Turn graph arrives, including after replay', () => {
    const firstGraph = graphItem([graphNode('first', 'writer-turn-1')], '2026-09-23T11:00:00.000Z', 'session-1', 'graph-first', 'root-first', 'turn-1')
    const firstRequest = selectedPreparationItem('turn-1', '10')
    const nextRequest = selectedPreparationItem('turn-2', '20')
    const firstWriter = writerTask('turn-1', 'root-first', 'draft-first')
    const secondWriter = writerTask('turn-2', 'root-second', 'draft-second')
    const ordinaryTurn = { ...selectedPreparationItem('turn-chat', '15'), id: 'message-chat', content: { parts: [{ type: 'text', text: 'A normal chat message' }] } }
    const firstTurnItems = [firstGraph, firstRequest, ordinaryTurn]
    const firstTurnId = latestSelectedJobPreparationTurnId(firstTurnItems, 'session-1')
    const firstIdentity = selectedTaskGraphIdentity(firstTurnItems, 'session-1')

    expect(firstTurnId).toBe('turn-1')
    expect(projectCurrentTaskGraph(firstTurnItems, [firstWriter], 'session-1')?.nodes.map(node => node.key)).toEqual(['first'])
    expect(latestWriterArtifact('session-1', [firstWriter], firstIdentity)?.artifactId).toBe('draft-first')

    const acceptedIntent = { turnId: 'turn-2', sequence: '20' }
    const selectedTurnId = selectedJobPreparationTurnId(firstTurnItems, 'session-1', acceptedIntent)
    const startedItems = firstTurnItems
    const pendingIdentity = selectedTaskGraphIdentity(startedItems, 'session-1', selectedTurnId)

    expect(selectedTurnId).toBe('turn-2')
    expect(pendingIdentity).toBeNull()
    expect(buildTaskGraphTaskLookupUrl('session-1', startedItems, selectedTurnId)).toBeNull()
    expect(pendingIdentity ? projectCurrentTaskGraph(startedItems.filter(item => item.id === pendingIdentity.graphItemId), [firstWriter], 'session-1') : null).toBeNull()
    expect(latestWriterArtifact('session-1', [firstWriter, secondWriter], pendingIdentity)).toBeNull()

    const replayedItems = [...firstTurnItems, nextRequest]
    expect(latestSelectedJobPreparationTurnId(replayedItems, 'session-1')).toBe('turn-2')
    expect(selectedJobPreparationTurnId(replayedItems, 'session-1', acceptedIntent)).toBe('turn-2')
    const newerPersistedIntent = selectedPreparationItem('turn-3', '21')
    expect(selectedJobPreparationTurnId([...replayedItems, newerPersistedIntent], 'session-1', acceptedIntent)).toBe('turn-3')

    const secondGraph = graphItem([graphNode('second', 'writer-turn-2')], '2026-09-23T12:01:00.000Z', 'session-1', 'graph-second', 'root-second', 'turn-2')
    const completedItems = [...replayedItems, secondGraph]
    const currentIdentity = selectedTaskGraphIdentity(completedItems, 'session-1')
    expect(buildTaskGraphTaskLookupUrl('session-1', completedItems)).toContain('graphItemId=graph-second')
    expect(projectCurrentTaskGraph(completedItems, [firstWriter, secondWriter], 'session-1')?.nodes.map(node => node.key)).toEqual(['second'])
    expect(latestWriterArtifact('session-1', [firstWriter, secondWriter], currentIdentity)?.artifactId).toBe('draft-second')
  })
})
