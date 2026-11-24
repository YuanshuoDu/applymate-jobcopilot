import { describe, expect, it } from 'vitest'

import { canonicalTaskGraphItemId, canonicalTaskGraphSourceKey, projectFinalAnswerTaskGraphSourceContent, projectFinalTaskGraphSourceDetail } from './final-task-graph-source-detail'
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION, TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2 } from './final-task-graph-source-manifest'

const sessionId = 'session_1', userId = 'user_1', finalItemId = 'final_1', turnId = 'turn_1', rootTaskId = 'root_1'
const sourceKey = canonicalTaskGraphSourceKey(finalItemId, 4, 0)
const graph = { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
  { key: 'scout', templateId: 'scout', goal: 'Find software roles', successCriteria: ['Collect evidence'], dependsOn: [], depth: 1, taskId: 'child_1' },
] }
const content = { taskGraphSources: { schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION, graphRevision: 4, sources: [
  { sourceKey, nodeIndex: 0, role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' },
] } }
const updatedAt = new Date('2026-10-01T00:00:00.000Z')
const finalOutcomes = { schemaVersion: 'agent-harness.v2.objective-tailor-final-outcomes.v1', slots: [{ ordinal: 1, status: 'ready' }] }

it('projects only a valid Objective Tailor sidecar on completed final answers', () => {
  expect(projectFinalAnswerTaskGraphSourceContent(finalItemId, 'final_answer', 'completed', 'Answer', undefined, null,
    { text: 'Answer', final: { response: 'Answer' }, objectiveTailorFinalOutcomes: finalOutcomes }))
    .toEqual({ text: 'Answer', objectiveTailorFinalOutcomes: finalOutcomes })
  expect(projectFinalAnswerTaskGraphSourceContent(finalItemId, 'commentary', 'completed', 'Answer', undefined, null,
    { objectiveTailorFinalOutcomes: finalOutcomes })).toEqual({ text: 'Answer' })
  expect(projectFinalAnswerTaskGraphSourceContent(finalItemId, 'final_answer', 'completed', 'Answer', undefined, null,
    { text: 'Answer', final: { response: 'Answer' }, objectiveTailorFinalOutcomes: { ...finalOutcomes, privateId: 'PRIVATE' } }))
    .toEqual({ text: 'Answer' })
  expect(projectFinalAnswerTaskGraphSourceContent(finalItemId, 'final_answer', 'completed', 'Fallback', undefined, null,
    { text: 'Answer', final: { response: 'Different' }, objectiveTailorFinalOutcomes: finalOutcomes })).toEqual({ text: 'Fallback' })
})

function input(overrides: Record<string, unknown> = {}) {
  const childResult = { status: 'completed', stepCount: 1, toolCallCount: 1, finalItemId: 'PRIVATE_FINAL_ID',
    finalText: 'PRIVATE_MODEL_TEXT', structuredResult: { role: 'scout', status: 'completed', summary: 'PRIVATE_SUMMARY' } }
  return {
    userId, sessionId, finalItemId, sourceKey,
    session: { id: sessionId, userId },
    finalItem: { id: finalItemId, sessionId, turnId, taskId: rootTaskId, type: 'agent_message', status: 'completed', phase: 'final_answer', content },
    turn: { id: turnId, sessionId, userId, status: 'completed', rootTaskId },
    graphRows: [{ id: canonicalTaskGraphItemId(rootTaskId), sessionId, turnId, taskId: rootTaskId, type: 'task_graph', revision: 4, content: graph }],
    taskRows: [
      { id: rootTaskId, sessionId, turnId, rootTaskId, parentTaskId: null, role: 'orchestrator', taskType: 'root', status: 'completed',
        goal: 'Research roles', result: null, hasResult: false, updatedAt },
      { id: 'child_1', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'scout', taskType: 'scout', status: 'completed',
        goal: 'Find roles at https://private.example for alex@example.test +353 87 123 4567', result: childResult, hasResult: true, updatedAt },
    ],
    ...overrides,
  }
}

describe('projectFinalTaskGraphSourceDetail', () => {
  it('returns only the same-session bounded plan goal and verification state', () => {
    const projected = projectFinalTaskGraphSourceDetail(input() as never)
    expect(projected).toMatchObject({ role: 'scout', taskStatus: 'completed', resultState: 'valid', roleResultStatus: 'completed' })
    expect(projected?.goal).toContain('[redacted]')
    expect(projected?.verification).toEqual({ status: 'unavailable' })
    const serialized = JSON.stringify(projected)
    for (const privateValue of [rootTaskId, 'child_1', 'graph_1', sessionId, userId, 'PRIVATE_FINAL_ID', 'PRIVATE_MODEL_TEXT', 'PRIVATE_SUMMARY', 'private.example', 'alex@example.test', '353 87 123 4567']) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('fails closed when owner, turn, final item, revision, or graph membership differs', () => {
    const base = input()
    const badCases = [
      { ...base, session: { id: sessionId, userId: 'other_user' } },
      { ...base, turn: { ...base.turn as object, userId: 'other_user' } },
      { ...base, finalItem: { ...base.finalItem as object, status: 'running' } },
      { ...base, graphRows: [{ ...(base.graphRows as object[])[0], revision: 5 }] },
      { ...base, graphRows: [{ ...(base.graphRows as object[])[0], id: 'graph_noncanonical' }] },
      { ...base, graphRows: [...base.graphRows as object[], ...(base.graphRows as object[])] },
      { ...base, taskRows: (base.taskRows as object[]).slice(0, 1) },
      { ...base, taskRows: [...base.taskRows as object[], { ...(base.taskRows as object[])[1], id: 'extra_task' }] },
      { ...base, sourceKey: `src_${'A'.repeat(43)}` },
    ]
    for (const candidate of badCases) expect(projectFinalTaskGraphSourceDetail(candidate as never)).toBeNull()
  })

  it('uses the worker canonical graph item identity derived from the root task', () => {
    expect(canonicalTaskGraphItemId(rootTaskId)).toMatch(/^task-graph-[a-f0-9]{64}$/)
    const base = input()
    expect(projectFinalTaskGraphSourceDetail(base as never)).not.toBeNull()
    expect(projectFinalTaskGraphSourceDetail({ ...base,
      graphRows: [{ ...(base.graphRows as object[])[0], id: `task-graph-${'0'.repeat(64)}` }],
    } as never)).toBeNull()
  })

  it('rejects stale status and role-result receipts instead of describing the wrong graph member', () => {
    const base = input()
    const child = (base.taskRows as Record<string, unknown>[])[1]!
    const wrongStatus = { ...base, taskRows: [(base.taskRows as object[])[0], { ...child, status: 'failed' }] }
    const wrongRole = { ...base, taskRows: [(base.taskRows as object[])[0], { ...child, role: 'analyst' }] }
    const wrongResult = { ...base, taskRows: [(base.taskRows as object[])[0], { ...child, result: { structuredResult: { role: 'scout', status: 'partial' } } }] }
    for (const candidate of [wrongStatus, wrongRole, wrongResult]) expect(projectFinalTaskGraphSourceDetail(candidate as never)).toBeNull()
  })

  it('rejects sidecars containing raw identifiers or extra fields', () => {
    const base = input()
    const finalItem = base.finalItem as Record<string, unknown>
    const privateManifest = { taskGraphSources: { ...content.taskGraphSources, taskId: 'PRIVATE' } }
    expect(projectFinalTaskGraphSourceDetail({ ...base, finalItem: { ...finalItem, content: privateManifest } } as never)).toBeNull()
  })

  it('requires exact ordered coverage of every business node and excludes native verification controls', () => {
    const base = input()
    const nodes = [
      graph.nodes[0],
      { key: 'analyst', templateId: 'analyst', goal: 'Assess roles', successCriteria: ['Score evidence'], dependsOn: ['scout'], depth: 2, taskId: 'child_2' },
      { key: 'native-control', templateId: 'native_verification', goal: 'Verify answer', successCriteria: ['Check evidence'], dependsOn: ['analyst'], depth: 3, taskId: 'control_1' },
    ]
    const sources = [
      content.taskGraphSources.sources[0]!,
      { sourceKey: canonicalTaskGraphSourceKey(finalItemId, 4, 1), nodeIndex: 1, role: 'analyst' as const,
        taskStatus: 'completed' as const, resultState: 'valid' as const, roleResultStatus: 'completed' as const },
    ]
    const forgedControlSource = { sourceKey: canonicalTaskGraphSourceKey(finalItemId, 4, 2), nodeIndex: 2, role: 'unsupported' as const,
      taskStatus: 'completed' as const, resultState: 'unsupported_role' as const }
    const taskRows = [
      ...(base.taskRows as Record<string, unknown>[]),
      { id: 'child_2', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'analyst', taskType: 'analyst', status: 'completed',
        goal: 'Assess roles', result: { structuredResult: { role: 'analyst', status: 'completed' } }, hasResult: true, updatedAt },
      { id: 'control_1', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'auditor', taskType: 'native_verification', status: 'completed',
        goal: 'Verify answer', result: null, hasResult: false, updatedAt },
    ]
    const sourceContent = (manifestSources: readonly unknown[]) => ({ taskGraphSources: {
      schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION, graphRevision: 4, sources: manifestSources,
    } })
    const query = (manifestSources: readonly unknown[], selectedKey = sourceKey, scopedTaskRows: readonly unknown[] = taskRows) => projectFinalTaskGraphSourceDetail({
      ...base,
      sourceKey: selectedKey,
      finalItem: { ...(base.finalItem as object), content: sourceContent(manifestSources) },
      graphRows: [{ ...(base.graphRows as object[])[0], content: { ...graph, nodes } }],
      taskRows: scopedTaskRows,
    } as never)

    expect(query(sources, sources[1]!.sourceKey)).toMatchObject({ role: 'analyst', resultState: 'valid' })
    expect(query(sources)).not.toBeNull()
    const childOne = taskRows.find(row => row.id === 'child_1')!
    const childTwo = taskRows.find(row => row.id === 'child_2')!
    expect(query(sources, sourceKey, taskRows.map(row => row.id === 'child_2' ? { ...row, parentTaskId: 'child_1' } : row))).toBeNull()
    expect(query(sources, sourceKey, taskRows.map(row => row.id === 'child_1' ? { ...row, parentTaskId: 'child_2' }
      : row.id === 'child_2' ? { ...row, parentTaskId: 'child_1' } : row))).toBeNull()
    expect(childOne.parentTaskId).toBe(rootTaskId)
    expect(childTwo.parentTaskId).toBe(rootTaskId)
    expect(query([sources[0]!])).toBeNull()
    expect(query([sources[0]!, forgedControlSource])).toBeNull()
    expect(query([...sources, forgedControlSource])).toBeNull()
  })

  it('validates v2 historical omissions against completed owned scout or analyst nodes only', () => {
    const base = input()
    const nodes = [
      graph.nodes[0],
      { key: 'analyst', templateId: 'analyst', goal: 'Assess roles', successCriteria: ['Score evidence'], dependsOn: ['scout'], depth: 2, taskId: 'child_2' },
      { key: 'native-control', templateId: 'native_verification', goal: 'Verify answer', successCriteria: ['Check evidence'], dependsOn: ['analyst'], depth: 3, taskId: 'control_1' },
    ]
    const analystTask = { id: 'child_2', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'analyst', taskType: 'analyst', status: 'completed',
      goal: 'Assess roles', result: { structuredResult: { role: 'analyst', status: 'completed' } }, hasResult: true, updatedAt }
    const writerTask = { id: 'child_3', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'writer', taskType: 'writer', status: 'completed',
      goal: 'Write result', result: null, hasResult: true, updatedAt }
    const controlTask = { id: 'control_1', sessionId, turnId, rootTaskId, parentTaskId: rootTaskId, role: 'auditor', taskType: 'native_verification', status: 'completed',
      goal: 'Verify answer', result: null, hasResult: false, updatedAt }
    const taskRows = [...base.taskRows as Record<string, unknown>[], analystTask, controlTask]
    const scoutSource = content.taskGraphSources.sources[0]!
    const controlSource = { sourceKey: canonicalTaskGraphSourceKey(finalItemId, 4, 2), nodeIndex: 2, role: 'unsupported' as const,
      taskStatus: 'completed' as const, resultState: 'unsupported_role' as const }
    const extendedNodes = [nodes[0]!, nodes[1]!,
      { key: 'writer', templateId: 'writer', goal: 'Write result', successCriteria: ['Write result'], dependsOn: ['analyst'], depth: 3, taskId: 'child_3' },
      { ...nodes[2]!, dependsOn: ['writer'], depth: 4 }]
    const v2Content = (sources: readonly unknown[], historicalNodeIndices: readonly number[]) => ({ taskGraphSources: {
      schemaVersion: TASK_GRAPH_SOURCES_SCHEMA_VERSION_V2, graphRevision: 4, sources, historicalNodeIndices,
    } })
    const query = (sources: readonly unknown[], historicalNodeIndices: readonly number[], selectedKey = sourceKey,
      scopedTaskRows: readonly unknown[] = taskRows, scopedNodes = nodes) => projectFinalTaskGraphSourceDetail({
      ...base,
      sourceKey: selectedKey,
      finalItem: { ...(base.finalItem as object), content: v2Content(sources, historicalNodeIndices) },
      graphRows: [{ ...(base.graphRows as object[])[0], content: { ...graph, nodes: scopedNodes } }],
      taskRows: scopedTaskRows,
    } as never)

    const projected = query([scoutSource], [1])
    expect(projected).toMatchObject({ role: 'scout', resultState: 'valid' })
    expect(JSON.stringify(projected)).not.toContain('child_2')
    expect(query([scoutSource], [1], canonicalTaskGraphSourceKey(finalItemId, 4, 1))).toBeNull()
    expect(query([scoutSource], [1], sourceKey, taskRows.map(row => row.id === 'child_2' ? { ...row, role: 'writer' } : row))).toBeNull()
    expect(query([scoutSource], [1], sourceKey, taskRows.map(row => row.id === 'child_2' ? { ...row, status: 'failed' } : row))).toBeNull()
    expect(query([scoutSource], [1], sourceKey, taskRows, nodes.map((node, index) => index === 1 ? { ...node!, templateId: 'scout' } : node!))).toBeNull()
    expect(query([scoutSource], [2])).toBeNull()
    expect(query([scoutSource, controlSource], [1])).toBeNull()
    expect(query([scoutSource], [0, 1])).toBeNull()
    expect(query([scoutSource], [1], sourceKey, [...taskRows, writerTask], extendedNodes)).toBeNull()
  })
})
