import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import { finalTaskGraphArtifactProofInput, SELECTED_JOB_BATCH_TEMPLATE_CATALOG } from '@jobcopilot/agent-protocol'

import { canonicalTaskGraphSourceKey } from './final-task-graph-source-detail'
import { TASK_GRAPH_SOURCES_SCHEMA_VERSION_V3, type FinalTaskGraphSource } from './final-task-graph-source-manifest'
import { finalTaskGraphSourceArtifactCandidate, verifiedFinalTaskGraphSourceArtifactRef } from './final-task-graph-source-artifact'

const sessionId = 'session_1', turnId = 'turn_1', rootTaskId = 'root_1', finalItemId = 'final_1', jobId = 'job_1'
const graphRevision = 4
const artifactRef = { artifactId: 'artifact_1', version: 3, contentHash: `sha256:${'a'.repeat(64)}`, sourceDigest: `sha256:${'b'.repeat(64)}` }
const graph = (reviewerTemplate = 'cover_letter_reviewer') => ({ revision: graphRevision, content: {
  schemaVersion: 'agent-harness.v2.task-graph', nodes: [
    { key: 'writer', templateId: 'cover_letter_writer', goal: 'Write', successCriteria: ['Write'], dependsOn: [], depth: 1, taskId: 'writer_1' },
    { key: 'reviewer', templateId: reviewerTemplate, goal: 'Review', successCriteria: ['Review'], dependsOn: ['writer'], depth: 2, taskId: 'reviewer_1' },
  ],
} })
const taskScope = (id: string) => ({ id, sessionId, turnId, rootTaskId })
function structuredResult(role: 'writer' | 'reviewer', ref = artifactRef, extra: Record<string, unknown> = {}) {
  return { status: 'completed', structuredResult: role === 'writer'
    ? { schemaVersion: 'agent-harness.v2.subagent.result', role, status: 'completed', artifactRef: ref, ...extra }
    : { schemaVersion: 'agent-harness.v2.subagent.result', role, status: 'completed', artifactRef: ref,
      reviewStatus: 'passed', reviewHash: `sha256:${'c'.repeat(64)}`, ...extra } }
}
function writerTask(overrides: Record<string, unknown> = {}) {
  return { ...taskScope('writer_1'), parentTaskId: rootTaskId, role: 'writer', taskType: 'cover_letter_draft', status: 'completed',
    context: { selectedJobPreparation: { jobId } }, result: structuredResult('writer'), ...overrides }
}
function reviewerTask(overrides: Record<string, unknown> = {}) {
  return { ...taskScope('reviewer_1'), parentTaskId: rootTaskId, role: 'reviewer', taskType: 'cover_letter_review', status: 'completed',
    context: { selectedJobPreparation: { jobId } }, result: structuredResult('reviewer'), ...overrides }
}
function proof(sourceKey: string, ref = artifactRef): string {
  const preimage = finalTaskGraphArtifactProofInput(sourceKey, ref)
  if (!preimage) throw new Error('invalid proof input')
  return `avp_${createHash('sha256').update(preimage).digest('hex')}`
}
function source(role: 'writer' | 'reviewer', nodeIndex: number, sourceTaskStatus: string = 'completed'): FinalTaskGraphSource {
  const sourceKey = canonicalTaskGraphSourceKey(finalItemId, graphRevision, nodeIndex)
  return { sourceKey, nodeIndex, role, taskStatus: sourceTaskStatus as FinalTaskGraphSource['taskStatus'], resultState: 'valid',
    roleResultStatus: 'completed', artifactVersionProof: proof(sourceKey) }
}
function candidate(role: 'writer' | 'reviewer' = 'writer', taskOverrides: Record<string, unknown> = {}, graphOverride = graph()) {
  const selected = source(role, role === 'writer' ? 0 : 1)
  return finalTaskGraphSourceArtifactCandidate({ source: selected, sourceKey: selected.sourceKey,
    graphRevision, graph: graphOverride, sessionId, turnId, rootTaskId,
    taskRows: [{ ...taskScope(rootTaskId), parentTaskId: null }, writerTask(), ...(role === 'reviewer' ? [reviewerTask(taskOverrides)] : [])] })
}
function versionRow(candidateValue: NonNullable<ReturnType<typeof candidate>>, overrides: Record<string, unknown> = {}) {
  return { ...candidateValue.artifactRef, userId: 'user_1', sessionId, jobId, taskId: candidateValue.artifactTaskId,
    artifactType: 'cover_letter', ...overrides }
}

describe('final TaskGraph source artifact evidence', () => {
  it('binds a Writer version to its exact completed selected-job task and final source key', () => {
    const selected = source('writer', 0)
    const resolved = finalTaskGraphSourceArtifactCandidate({ source: selected, sourceKey: selected.sourceKey,
      graphRevision, graph: graph(), sessionId, turnId, rootTaskId, taskRows: [
        { ...taskScope(rootTaskId), parentTaskId: null }, writerTask(), reviewerTask(),
      ] })
    expect(resolved).toMatchObject({ artifactRef, jobId, artifactTaskId: 'writer_1' })
    expect(verifiedFinalTaskGraphSourceArtifactRef(resolved!, [versionRow(resolved!)], { userId: 'user_1', sessionId })).toEqual(artifactRef)
  })

  it('binds a Reviewer version through exactly one same-job Writer dependency', () => {
    const resolved = candidate('reviewer')
    expect(resolved).toMatchObject({ artifactRef, jobId, artifactTaskId: 'writer_1' })
    expect(verifiedFinalTaskGraphSourceArtifactRef(resolved!, [versionRow(resolved!)], { userId: 'user_1', sessionId })).toEqual(artifactRef)
  })

  it('accepts only exact registered selected-job batch templates', () => {
    const template = SELECTED_JOB_BATCH_TEMPLATE_CATALOG[0]!
    const sourceKey = canonicalTaskGraphSourceKey(finalItemId, graphRevision, 0)
    const batchGraph = { ...graph(), content: { schemaVersion: 'agent-harness.v2.task-graph', nodes: [
      { key: 'writer', templateId: template.writerTemplateId, goal: 'Write', successCriteria: ['Write'], dependsOn: [], depth: 1, taskId: 'writer_1' },
      { key: 'reviewer', templateId: template.reviewerTemplateId, goal: 'Review', successCriteria: ['Review'], dependsOn: ['writer'], depth: 2, taskId: 'reviewer_1' },
    ] } }
    const resolved = finalTaskGraphSourceArtifactCandidate({ source: { ...source('writer', 0), sourceKey, artifactVersionProof: proof(sourceKey) },
      sourceKey, graphRevision, graph: batchGraph, sessionId, turnId, rootTaskId,
      taskRows: [{ ...taskScope(rootTaskId), parentTaskId: null }, writerTask(), reviewerTask()] })
    expect(resolved?.artifactTaskId).toBe('writer_1')
    const sourceGraph = graph()
    const wrongWriterTemplate = { ...sourceGraph, content: { ...sourceGraph.content, nodes: sourceGraph.content.nodes.map((node, index) =>
      index === 0 ? { ...node, templateId: 'cover_letter_writer_slot_1_shadow' } : node) } }
    expect(candidate('writer', {}, wrongWriterTemplate)).toBeNull()
  })

  it('fails closed for proof, role, task, result, context and graph drift', () => {
    const base = source('writer', 0)
    const baseInput = { source: base, sourceKey: base.sourceKey, graphRevision, graph: graph(), sessionId, turnId, rootTaskId }
    const cases = [
      { ...baseInput, source: { ...base, artifactVersionProof: `avp_${'f'.repeat(64)}` } },
      { ...baseInput, source: { ...base, taskStatus: 'failed' as const } },
      { ...baseInput, source: { ...base, resultState: 'missing' as const } },
      { ...baseInput, sourceKey: canonicalTaskGraphSourceKey('other_final', graphRevision, 0) },
      { ...baseInput, graphRevision: 5 },
    ]
    for (const input of cases) expect(finalTaskGraphSourceArtifactCandidate({ ...input, taskRows: [writerTask()] })).toBeNull()
    expect(finalTaskGraphSourceArtifactCandidate({ ...baseInput, taskRows: [writerTask({ context: { selectedJobPreparation: { jobId, extra: true } } })] })).toBeNull()
    expect(finalTaskGraphSourceArtifactCandidate({ ...baseInput, taskRows: [writerTask({ result: structuredResult('writer', artifactRef, { forged: true }) })] })).toBeNull()
    expect(candidate('reviewer', { context: { selectedJobPreparation: { jobId: 'job_other' } } })).toBeNull()
    expect(candidate('reviewer', {}, { ...graph(), content: { ...graph().content, nodes: graph().content.nodes.map((node, index) => index === 1 ? { ...node, dependsOn: [] } : node) } })).toBeNull()
  })

  it('requires one immutable version row with exact owner, session, job, type, task, version and hashes', () => {
    const resolved = candidate()!
    const invalid = [
      versionRow(resolved, { userId: 'user_other' }), versionRow(resolved, { sessionId: 'session_other' }),
      versionRow(resolved, { jobId: 'job_other' }), versionRow(resolved, { artifactType: 'resume' }),
      versionRow(resolved, { taskId: 'writer_other' }), versionRow(resolved, { version: 2 }),
      versionRow(resolved, { contentHash: `sha256:${'d'.repeat(64)}` }), versionRow(resolved, { sourceDigest: `sha256:${'e'.repeat(64)}` }),
    ]
    for (const row of invalid) expect(verifiedFinalTaskGraphSourceArtifactRef(resolved, [row], { userId: 'user_1', sessionId })).toBeNull()
    expect(verifiedFinalTaskGraphSourceArtifactRef(resolved, [], { userId: 'user_1', sessionId })).toBeNull()
    expect(verifiedFinalTaskGraphSourceArtifactRef(resolved, [versionRow(resolved), versionRow(resolved)], { userId: 'user_1', sessionId })).toBeNull()
  })
})
