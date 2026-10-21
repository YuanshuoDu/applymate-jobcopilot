import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import type { ArtifactKind } from './artifacts/types'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { scheduledTaskGraphAnalyzeCheckpointDigest, type ScheduledTaskGraphArtifactReference, type ScheduledTaskGraphPreparedMaterialRow, type ScheduledTaskGraphPreparedPackageRow } from './scheduled-taskgraph-gate-checkpoint'
import { loadScheduledTaskGraphGateMaterials } from './scheduled-taskgraph-gate-materials'

const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const COMPLETION_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1'
const RECEIPT_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-continuation-receipt.v1'
const PREPARE_RESULT_SCHEMA = 'agent-harness.v2.subagent.result'
const DIGEST = /^sha256:[a-f0-9]{64}$/
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/
export type ScheduledTaskGraphGateInputRequest = Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  snapshot: unknown
  analyzeCheckpoint: unknown
  analyzeAttestation: unknown
  prepareProof: unknown
}>
export type ScheduledTaskGraphGateInput = Readonly<{
  packages: readonly ScheduledTaskGraphPreparedPackageRow[]
  materials: readonly ScheduledTaskGraphPreparedMaterialRow[]
}>

/** Rechecks the exact Worker proof while the caller's Gate checkpoint transaction holds proof-row locks. */
export async function isScheduledTaskGraphGateProofCurrent(
  input: ScheduledTaskGraphGateInputRequest,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  try {
    const owner = parseOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = record(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = scheduledTaskGraphAnalyzeCheckpointDigest(input.analyzeCheckpoint)
    if (!owner || !snapshot || !checkpoint || checkpoint.nextStage !== 'prepare' || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameLineageOwner(parseOwner(marker.owner), owner)
      || marker.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot) || !checkpointDigest) return false
    const proof = parsePrepareProof(input.prepareProof)
    return Boolean(proof && proof.result.snapshotDigest === marker.snapshotDigest
      && proof.result.checkpointDigest === checkpointDigest
      && await verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, tx, true))
  } catch { return false }
}

/** Revalidates the live TaskGraph before reloading proof-named materials for Gate. */
export async function loadScheduledTaskGraphGateInput(input: ScheduledTaskGraphGateInputRequest): Promise<ScheduledTaskGraphGateInput | null> {
  try {
    const owner = parseOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = record(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = scheduledTaskGraphAnalyzeCheckpointDigest(input.analyzeCheckpoint)
    if (!owner || !snapshot || !checkpoint || checkpoint.nextStage !== 'prepare' || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameLineageOwner(parseOwner(marker.owner), owner)
      || marker.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot) || !checkpointDigest) return null

    const proof = parsePrepareProof(input.prepareProof)
    if (!proof || proof.result.snapshotDigest !== marker.snapshotDigest || proof.result.checkpointDigest !== checkpointDigest
      || !await verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, db)) return null
    return await loadScheduledTaskGraphGateMaterials({ owner, scoredJobs: checkpoint.scoredJobs,
      minScore: snapshot.minScore, dailyCap: snapshot.dailyCap, taskId: proof.result.taskId,
      jobs: proof.result.jobs, materials: proof.result.materials })
  } catch { return null }
}

type ParsedResult = { taskId: string; attemptCount: number; snapshotDigest: string; checkpointDigest: string; jobs: Array<{ jobId: string; status: string }>; materials: Array<{ jobId: string; kind: ArtifactKind; artifactRef: ScheduledTaskGraphArtifactReference }>; raw: Record<string, unknown> }
type ProofNode = { taskId: string; attemptCount: number; role: 'scout' | 'analyst' | 'prepare'; taskType: string; status: 'completed'; verification: 'passed'; dependsOnTaskIds: string[]; resultDigest?: string }
type ParsedPrepareProof = { receipt: Record<string, unknown>; graphRevision: number; nodes: [ProofNode, ProofNode, ProofNode]; result: ParsedResult }

function parsePrepareProof(value: unknown): ParsedPrepareProof | null {
  const proof = exactRecord(value, ['receipt', 'completion', 'result'])
  const receipt = exactRecord(proof?.receipt, ['schemaVersion', 'owner', 'continuationKey', 'snapshotDigest', 'evidenceDigest', 'checkpointDigest', 'analyzeGraphRevision', 'prepareScheduleRevision'])
  const completion = exactRecord(proof?.completion, ['schemaVersion', 'graphRevision', 'nodes', 'wait'])
  const result = parsePrepareResult(proof?.result), nodes = denseArray(completion?.nodes)?.map(parseCompletionNode)
  const wait = exactRecord(completion?.wait, ['waitId', 'status', 'mode', 'targetTaskIds', 'matchedTaskIds'])
  if (!receipt || !completion || !result || !nodes || nodes.length !== 3 || nodes.some(node => !node) || !wait
    || receipt.schemaVersion !== RECEIPT_SCHEMA || completion.schemaVersion !== COMPLETION_SCHEMA
    || !positive(completion.graphRevision) || !positive(receipt.prepareScheduleRevision) || completion.graphRevision <= Number(receipt.prepareScheduleRevision)
    || !validId(wait.waitId) || nodes[2]?.role !== 'prepare' || result.taskId !== nodes[2].taskId
    || result.attemptCount !== nodes[2].attemptCount || nodes[2].resultDigest !== workerPrepareResultDigest(result.raw)
    || wait.status !== 'ready' || wait.mode !== 'all' || !sameIds(wait.targetTaskIds as string[], [result.taskId])
    || !sameIds(wait.matchedTaskIds as string[], [result.taskId])) return null
  return { receipt, graphRevision: Number(completion.graphRevision), nodes: nodes as [ProofNode, ProofNode, ProofNode], result }
}

function parseCompletionNode(value: unknown): ProofNode | null {
  const role = record(value)?.role, base = ['taskId', 'attemptCount', 'role', 'taskType', 'status', 'verification', 'dependsOnTaskIds']
  const row = exactRecord(value, [...base, ...(role === 'prepare' ? ['tool', 'resultDigest'] : [])])
  if (!row || !validId(row.taskId) || !positive(row.attemptCount) || !['scout', 'analyst', 'prepare'].includes(String(row.role))
    || typeof row.taskType !== 'string' || row.status !== 'completed' || row.verification !== 'passed' || !stringArray(row.dependsOnTaskIds)
    || row.role === 'prepare' && (row.tool !== 'scheduled.application.prepare@1' || !isHex(row.resultDigest))
    || row.role !== 'prepare' && (row.tool !== undefined || row.resultDigest !== undefined)) return null
  return row as unknown as ProofNode
}

async function verifyCurrentTaskGraph(owner: ScheduledTaskGraphPipelineOwner, marker: Record<string, unknown>, checkpointDigest: string,
  attestationValue: unknown, proof: ParsedPrepareProof, reader: Prisma.TransactionClient, lockRows = false): Promise<boolean> {
  const { receipt, nodes } = proof, attestation = record(attestationValue), attestedOwner = record(attestation?.owner)
  const scoutProof = record(attestation?.scout), analystProof = record(attestation?.analyst)
  if (!attestation || !attestedOwner || !scoutProof || !analystProof || attestation.snapshotDigest !== marker.snapshotDigest
    || attestation.graphRevision !== marker.graphRevision || attestation.evidenceDigest !== marker.evidenceDigest
    || !sameStableOwner(attestedOwner, owner) || !sameLineageOwner(parseOwner(receipt.owner), owner)
    || scoutProof.taskId !== nodes[0].taskId || scoutProof.attemptCount !== nodes[0].attemptCount || scoutProof.status !== 'completed' || scoutProof.verification !== 'passed'
    || analystProof.taskId !== nodes[1].taskId || analystProof.attemptCount !== nodes[1].attemptCount || analystProof.status !== 'completed' || analystProof.verification !== 'passed'
    || !sameIds(analystProof.dependsOnTaskIds as string[], [nodes[0].taskId])
    || receipt.snapshotDigest !== marker.snapshotDigest || receipt.evidenceDigest !== marker.evidenceDigest
    || receipt.checkpointDigest !== checkpointDigest || receipt.analyzeGraphRevision !== marker.graphRevision
    || receipt.prepareScheduleRevision !== Number(marker.graphRevision) + 1 || receipt.continuationKey !== stableReceiptKey(owner, receipt)) return false
  if (lockRows) {
    const taskIds = [owner.rootTaskId, ...nodes.map(node => node.taskId)]
    const graphLocks = await reader.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_items"
      WHERE "id" = ${taskGraphItemId(owner.rootTaskId)} AND "sessionId" = ${owner.sessionId}
        AND "turnId" = ${owner.turnId} AND "taskId" = ${owner.rootTaskId} AND "type" = 'task_graph'
      FOR UPDATE
    `)
    const taskLocks = await reader.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "sub_agent_tasks"
      WHERE "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId} AND "rootTaskId" = ${owner.rootTaskId}
        AND "id" IN (${Prisma.join(taskIds)})
      ORDER BY "id" FOR UPDATE
    `)
    const receiptLocks = await reader.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_events"
      WHERE "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId}
        AND "type" = 'agent.plan.scheduled_prepare_binding' AND "itemId" IS NULL AND "taskId" IS NULL AND "actor" = 'system'
      ORDER BY "id" FOR UPDATE
    `)
    if (graphLocks.length !== 1 || taskLocks.length !== 4 || receiptLocks.length !== 1) return false
  }
  const [graph, tasks, receipts] = await Promise.all([
    reader.agentItem.findFirst({ where: { id: taskGraphItemId(owner.rootTaskId), sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: owner.rootTaskId, type: 'task_graph', session: { is: { userId: owner.userId } }, turn: { is: { userId: owner.userId, rootTaskId: owner.rootTaskId } } },
    select: { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true } }),
    reader.subAgentTask.findMany({ where: { id: { in: [owner.rootTaskId, ...nodes.map(node => node.taskId)] }, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, session: { is: { userId: owner.userId } } },
    select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, status: true, role: true,
      taskType: true, attemptCount: true, failureReason: true, result: true } }),
    reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, type: 'agent.plan.scheduled_prepare_binding',
      itemId: null, taskId: null, actor: 'system', session: { is: { userId: owner.userId } }, turn: { is: { userId: owner.userId, rootTaskId: owner.rootTaskId } } },
    select: { payload: true }, take: 2 }),
  ])
  if (!graph || graph.id !== taskGraphItemId(owner.rootTaskId) || graph.sessionId !== owner.sessionId || graph.turnId !== owner.turnId
    || graph.taskId !== owner.rootTaskId || graph.type !== 'task_graph' || graph.revision !== proof.graphRevision
    || tasks.length !== 4 || receipts.length !== 1
    || !sameJson(receipts[0]?.payload, receipt)) return false
  const content = record(graph.content), graphNodes = denseArray(content?.nodes)?.map(record), roles = ['scout', 'analyst', 'prepare']
  if (content?.schemaVersion !== 'agent-harness.v2.task-graph' || !graphNodes || graphNodes.length !== 3
    || new Set(nodes.map(node => node.taskId)).size !== 3) return false
  const byTask = uniqueMap(tasks, task => task.id)
  const root = byTask?.get(owner.rootTaskId)
  if (!byTask || !root || root.attemptCount !== owner.rootAttemptCount || root.parentTaskId !== null
    || root.status !== 'running' || root.failureReason !== null) return false
  for (let i = 0; i < 3; i += 1) {
    const proofNode = nodes[i]!, graphNode = graphNodes[i], role = roles[i]!, task = byTask.get(proofNode.taskId)
    const dependencies = i === 0 ? [] : [String(graphNodes[i - 1]?.key)]
    if (!graphNode || !task || graphNode.templateId !== role || graphNode.taskId !== proofNode.taskId || graphNode.depth !== i + 1
      || !sameStrings(graphNode.dependsOn, dependencies) || graphNode.verificationDisposition !== (role === 'prepare' ? 'specialized' : 'typed')
      || !sameIds(proofNode.dependsOnTaskIds, i === 0 ? [] : [nodes[i - 1]!.taskId])
      || task.sessionId !== owner.sessionId || task.turnId !== owner.turnId || task.rootTaskId !== owner.rootTaskId
      || task.parentTaskId !== owner.rootTaskId || task.status !== 'completed' || task.failureReason !== null
      || task.attemptCount !== proofNode.attemptCount || task.role !== role
      || proofNode.taskType !== ['job_discovery', 'job_analysis', 'scheduled_application_prepare'][i] || task.taskType !== proofNode.taskType) return false
    const envelope = record(task.result)
    if (!envelope || envelope.status !== 'completed') return false
    if (role !== 'prepare') {
      const report = record(envelope.taskGraphVerificationReport), expected = role === 'scout' ? scoutProof : analystProof
      if (!verifiedReport(report, graphNode, expected)) return false
    } else if (!sameJson(envelope.structuredResult, proof.result.raw) || !sameJson(envelope.taskGraphScheduledPrepareProofFacts,
      { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-prepare-proof-facts.v1', receipt,
        completion: { schemaVersion: COMPLETION_SCHEMA, graphRevision: proof.graphRevision, nodes }, result: proof.result.raw })) return false
  }
  return true
}

function verifiedReport(report: Record<string, unknown> | null, node: Record<string, unknown>, attestation: Record<string, unknown>): boolean {
  const criteria = denseArray(record(node.verification)?.criteria)?.map(record), rows = denseArray(report?.criteria)?.map(record)
  return report?.verifierVersion === 'agent-harness.v2.task-graph-verifier.v1' && report.status === 'passed'
    && record(node.verification)?.role === node.templateId && report.reasonCode === 'criteria_met'
    && report.resultDigest === attestation.resultDigest && isHex(report.evidenceDigest)
    && Boolean(criteria?.length && rows?.length === criteria.length && rows.every((row, index) => row !== null && row.criterionId === criteria[index]?.id
      && row.status === 'passed' && row.reasonCode === 'criteria_met'))
}

function sameStableOwner(value: Record<string, unknown>, owner: ScheduledTaskGraphPipelineOwner): boolean {
  return ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount'].every(key => value[key] === owner[key as keyof ScheduledTaskGraphPipelineOwner])
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}
function taskGraphItemId(rootTaskId: string): string { return `task-graph-${createHash('sha256').update(rootTaskId).digest('hex')}` }
function stableReceiptKey(owner: ScheduledTaskGraphPipelineOwner, receipt: Record<string, unknown>): string {
  const values = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount, receipt.snapshotDigest, receipt.evidenceDigest, receipt.checkpointDigest, receipt.analyzeGraphRevision, receipt.prepareScheduleRevision]
  return `scheduled-taskgraph:sha256:${createHash('sha256').update(JSON.stringify(values), 'utf8').digest('hex')}`
}
function workerPrepareResultDigest(result: Record<string, unknown>): string {
  const projection = { schemaVersion: result.schemaVersion, role: result.role, status: result.status, taskId: result.taskId,
    attemptCount: result.attemptCount, snapshotDigest: result.snapshotDigest, checkpointDigest: result.checkpointDigest, jobs: result.jobs, materials: result.materials }
  return createHash('sha256').update(canonicalJson(projection), 'utf8').digest('hex')
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('scheduled_prepare_proof_invalid')
  return encoded
}

function parsePrepareResult(value: unknown): ParsedResult | null {
  const row = exactRecord(value, ['schemaVersion', 'role', 'status', 'taskId', 'attemptCount', 'snapshotDigest', 'checkpointDigest', 'jobs', 'materials'])
  const jobs = denseArray(row?.jobs)?.map(item => exactRecord(item, ['jobId', 'status']))
  const materials = denseArray(row?.materials)?.map(item => {
    const material = exactRecord(item, ['jobId', 'kind', 'artifactRef']), ref = parseArtifactRef(material?.artifactRef)
    return material && validId(material.jobId) && (material.kind === 'resume' || material.kind === 'cover_letter') && ref
      ? { jobId: material.jobId as string, kind: material.kind, artifactRef: ref } : null
  })
  if (!row || row.schemaVersion !== PREPARE_RESULT_SCHEMA || row.role !== 'prepare' || row.status !== 'completed'
    || !validId(row.taskId) || !positive(row.attemptCount) || !isDigest(row.snapshotDigest) || !isHex(row.checkpointDigest)
    || !jobs || !materials || jobs.some(item => !item || !validId(item.jobId) || (item.status !== 'prepared' && item.status !== 'skipped'))
    || materials.some(item => !item) || new Set(jobs.map(item => item?.jobId)).size !== jobs.length
    || new Set(materials.map(item => `${item?.jobId}\0${item?.kind}`)).size !== materials.length) return null
  return { taskId: row.taskId, attemptCount: row.attemptCount, snapshotDigest: row.snapshotDigest, checkpointDigest: row.checkpointDigest,
    jobs: jobs as Array<{ jobId: string; status: string }>, materials: materials as ParsedResult['materials'], raw: row }
}

function parseArtifactRef(value: unknown): ScheduledTaskGraphArtifactReference | null {
  const ref = exactRecord(value, ['artifactId', 'version', 'contentHash', 'sourceDigest'])
  return ref && validId(ref.artifactId) && positive(ref.version) && isDigest(ref.contentHash) && isDigest(ref.sourceDigest)
    ? { artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash, sourceDigest: ref.sourceDigest } : null
}
function parseOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = exactRecord(value, ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'])
  return row && [row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    && positive(row.rootAttemptCount) && positive(row.turnLeaseVersion) && nonNegative(row.executionAttemptCount)
    ? row as unknown as ScheduledTaskGraphPipelineOwner : null
}
function sameLineageOwner(a: ScheduledTaskGraphPipelineOwner | null, b: ScheduledTaskGraphPipelineOwner): boolean {
  return Boolean(a && ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'executionId', 'executionAttemptCount']
    .every(key => a[key as keyof ScheduledTaskGraphPipelineOwner] === b[key as keyof ScheduledTaskGraphPipelineOwner]))
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!plain(value)) return null
  const own = Reflect.ownKeys(value)
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) return null
  return value as Record<string, unknown>
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function record(value: unknown): Record<string, unknown> | null { return plain(value) ? value : null }
function denseArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return null
  return value
}
function uniqueMap<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> | null {
  const map = new Map<string, T>()
  for (const row of rows) { const id = key(row); if (map.has(id)) return null; map.set(id, row) }
  return map
}
function versionKey(jobId: string, id: string, version: number, kind: string): string { return `${jobId}\0${id}\0${version}\0${kind}` }
function headKey(jobId: string, id: string, kind: string): string { return `${jobId}\0${id}\0${kind}` }
function sameIds(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && new Set(a).size === a.length && b.every(id => a.includes(id)) }
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.every(item => typeof item === 'string') && new Set(value).size === value.length
    && value.length === expected.length && expected.every(item => value.includes(item))
}
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value) }
function isHex(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
