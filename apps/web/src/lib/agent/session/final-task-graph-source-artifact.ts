import { createHash } from 'node:crypto'
import {
  finalTaskGraphArtifactProofInput,
  parseTaskGraphSnapshot,
  parseFinalTaskGraphArtifactRef,
  SELECTED_JOB_BATCH_TEMPLATE_CATALOG,
  type FinalTaskGraphArtifactRef,
} from '@jobcopilot/agent-protocol'

import type { FinalTaskGraphSource } from './final-task-graph-source-manifest'

const ROLE_RESULT_SCHEMA = 'agent-harness.v2.subagent.result'
const REVIEW_STATUSES = ['passed', 'needs_revision', 'rejected', 'stale'] as const

export type FinalTaskGraphSourceArtifactCandidate = Readonly<{
  artifactRef: FinalTaskGraphArtifactRef
  jobId: string
  artifactTaskId: string
}>

/** Resolves only a completed, selected-job Writer/Reviewer reference committed by the final manifest. */
export function finalTaskGraphSourceArtifactCandidate(input: {
  readonly source: FinalTaskGraphSource
  readonly sourceKey: string
  readonly graphRevision: number
  readonly graph: unknown
  readonly snapshot?: NonNullable<ReturnType<typeof parseTaskGraphSnapshot>>
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly taskRows: readonly unknown[]
}): FinalTaskGraphSourceArtifactCandidate | null {
  const source = input.source
  if (!source.artifactVersionProof || source.role !== 'writer' && source.role !== 'reviewer'
    || source.taskStatus !== 'completed' || source.resultState !== 'valid' || source.roleResultStatus !== 'completed') return null
  const parsedGraph = input.snapshot
    ? { revision: input.graphRevision, nodes: input.snapshot.nodes }
    : parseGraph(input.graph)
  if (!parsedGraph || parsedGraph.revision !== input.graphRevision || !Number.isSafeInteger(source.nodeIndex)
    || source.nodeIndex < 0 || source.nodeIndex >= parsedGraph.nodes.length) return null
  const node = parsedGraph.nodes[source.nodeIndex]
  if (!node || source.sourceKey !== input.sourceKey) return null
  const tasks = taskMap(input.taskRows, input.sessionId, input.turnId, input.rootTaskId)
  if (!tasks) return null
  const task = tasks.get(node.taskId)
  const taskId = task?.id
  const expectedType = source.role === 'writer' ? 'cover_letter_draft' : 'cover_letter_review'
  if (!task || !boundedText(taskId, 256) || task.status !== 'completed' || task.role !== source.role || task.taskType !== expectedType
    || !supportedTemplate(node.templateId, source.role)) return null
  const jobId = selectedJobId(task.context)
  const artifactRef = roleArtifactRef(task.result, source.role)
  if (!jobId || !artifactRef || !matchesCommitment(source.artifactVersionProof, input.sourceKey, artifactRef)) return null

  let artifactTaskId = taskId
  if (source.role === 'reviewer') {
    if (node.dependsOn.length !== 1) return null
    const writerNode = parsedGraph.nodes.find(candidate => candidate.key === node.dependsOn[0])
    const writer = writerNode && tasks.get(writerNode.taskId)
    const writerTaskId = writer?.id
    if (!writerNode || !writer || writer.status !== 'completed' || writer.role !== 'writer'
      || writer.taskType !== 'cover_letter_draft' || !supportedTemplate(writerNode.templateId, 'writer')
      || !boundedText(writerTaskId, 256) || selectedJobId(writer.context) !== jobId
      || !sameArtifactRef(roleArtifactRef(writer.result, 'writer'), artifactRef)) return null
    artifactTaskId = writerTaskId
  }
  return { artifactRef, jobId, artifactTaskId }
}

/** Requires one exact immutable version row; historical versions remain valid viewer targets. */
export function verifiedFinalTaskGraphSourceArtifactRef(
  candidate: FinalTaskGraphSourceArtifactCandidate,
  rows: readonly unknown[],
  owner: Readonly<{ userId: string; sessionId: string }>,
): FinalTaskGraphArtifactRef | null {
  if (rows.length !== 1) return null
  const row = record(rows[0]), ref = candidate.artifactRef
  if (!row || row.userId !== owner.userId || row.sessionId !== owner.sessionId || row.jobId !== candidate.jobId
    || row.taskId !== candidate.artifactTaskId || row.artifactType !== 'cover_letter'
    || row.artifactId !== ref.artifactId || row.version !== ref.version
    || row.contentHash !== ref.contentHash || row.sourceDigest !== ref.sourceDigest) return null
  return ref
}

function roleArtifactRef(value: unknown, role: 'writer' | 'reviewer'): FinalTaskGraphArtifactRef | null {
  const envelope = parseRecord(value), result = envelope && record(envelope.structuredResult)
  if (!envelope || envelope.status !== 'completed' || !result || result.schemaVersion !== ROLE_RESULT_SCHEMA
    || result.role !== role || result.status !== 'completed') return null
  const keys = role === 'writer' ? 'artifactRef,role,schemaVersion,status'
    : 'artifactRef,reviewHash,reviewStatus,role,schemaVersion,status'
  if (Object.keys(result).sort().join(',') !== keys) return null
  if (role === 'reviewer' && (!REVIEW_STATUSES.includes(result.reviewStatus as typeof REVIEW_STATUSES[number])
    || typeof result.reviewHash !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(result.reviewHash))) return null
  try { return parseFinalTaskGraphArtifactRef(result.artifactRef) } catch { return null }
}

function matchesCommitment(proof: string, sourceKey: string, ref: FinalTaskGraphArtifactRef): boolean {
  try {
    const preimage = finalTaskGraphArtifactProofInput(sourceKey, ref)
    return !!preimage && proof === `avp_${createHash('sha256').update(preimage, 'utf8').digest('hex')}`
  } catch { return false }
}

function supportedTemplate(templateId: string, role: 'writer' | 'reviewer'): boolean {
  if (role === 'writer' && templateId === 'cover_letter_writer') return true
  if (role === 'reviewer' && templateId === 'cover_letter_reviewer') return true
  return SELECTED_JOB_BATCH_TEMPLATE_CATALOG.some(template =>
    templateId === (role === 'writer' ? template.writerTemplateId : template.reviewerTemplateId))
}

function selectedJobId(value: unknown): string | null {
  const context = record(value), selected = context && record(context.selectedJobPreparation)
  if (!selected || Object.keys(selected).sort().join(',') !== 'jobId' || !boundedText(selected.jobId, 256)) return null
  return selected.jobId
}

function taskMap(value: readonly unknown[], sessionId: string, turnId: string, rootTaskId: string): Map<string, Record<string, unknown>> | null {
  const tasks = new Map<string, Record<string, unknown>>()
  for (const candidate of value) {
    const task = record(candidate)
    if (!task || !boundedText(task.id, 256) || task.sessionId !== sessionId || task.turnId !== turnId
      || task.rootTaskId !== rootTaskId || tasks.has(task.id)) return null
    tasks.set(task.id, task)
  }
  return tasks
}

function parseGraph(value: unknown): { revision: number; nodes: readonly { key: string; taskId: string; templateId: string; dependsOn: readonly string[] }[] } | null {
  const graph = record(value), content = graph && record(graph.content)
  const snapshot = content && parseTaskGraphSnapshot(content)
  if (!graph || !Number.isSafeInteger(graph.revision) || !snapshot || snapshot.nodes.length < 1 || snapshot.nodes.length > 11) return null
  return { revision: Number(graph.revision), nodes: snapshot.nodes }
}

function sameArtifactRef(left: FinalTaskGraphArtifactRef | null, right: FinalTaskGraphArtifactRef): boolean {
  return !!left && left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function parseRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return record(value)
  try { return record(JSON.parse(value) as unknown) } catch { return null }
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null
    const keys = Reflect.ownKeys(value)
    if (keys.some(key => {
      if (typeof key !== 'string') return true
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')
    })) return null
    return value as Record<string, unknown>
  } catch { return null }
}
function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && value.trim() === value
}
