import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { parseScheduledTaskGraphPrepareProof, scheduledTaskGraphAnalyzeCheckpointDigest, type ParsedScheduledTaskGraphPrepareProof, type ScheduledTaskGraphArtifactReference, type ScheduledTaskGraphPreparedMaterialRow, type ScheduledTaskGraphPreparedPackageRow } from './scheduled-taskgraph-gate-checkpoint'
import { loadScheduledTaskGraphGateMaterials } from './scheduled-taskgraph-gate-materials'
import { scheduledTaskGraphGateBindingIsCurrent, scheduledTaskGraphGateHistoryIsCurrent } from './scheduled-taskgraph-gate-history'
import { parseScheduledTaskGraphGateResult, type ScheduledTaskGraphGateResult } from './scheduled-taskgraph-gate-service'
import { lockScheduledTaskGraphAuditChildFence, type ScheduledTaskGraphAuditActor } from './scheduled-taskgraph-audit-child-fence'
const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const COMPLETION_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1'
const AUDIT_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const AUDIT_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.',
  'Return only the fixed seven-field report without adding actions or interpreting historical counts.',
  'Never submit applications or invoke model or tool runtimes.']
const AUDIT_OUTPUT_SCHEMA = { schemaVersion: 'agent-harness.v2.subagent.result', role: 'auditor', taskType: 'scheduled_taskgraph_audit' }
const DIGEST = /^sha256:[a-f0-9]{64}$/
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/
export type ScheduledTaskGraphGateInputRequest = Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  snapshot: unknown
  analyzeCheckpoint: unknown
  analyzeAttestation: unknown
  prepareProof: unknown
  gate?: Readonly<{ taskId: string; attemptCount: number; phase: 'running' | 'completed'; completionProof?: unknown }>
}>
export type ScheduledTaskGraphAuditChildGateInputRequest = ScheduledTaskGraphGateInputRequest & Readonly<{ auditActor: ScheduledTaskGraphAuditActor }>
export type ScheduledTaskGraphGateInput = Readonly<{
  packages: readonly ScheduledTaskGraphPreparedPackageRow[]
  materials: readonly ScheduledTaskGraphPreparedMaterialRow[]
  gateResult?: ScheduledTaskGraphGateResult
}>
/** Reconstructs immutable Analyze facts from an allowed persisted Gate-family stage. */
export function scheduledTaskGraphAnalyzeCheckpointForGate(value: unknown): Record<string, unknown> | null {
  const checkpoint = record(value)
  const stage = checkpoint?.nextStage
  if (!checkpoint || stage !== 'prepare' && stage !== 'gate' && stage !== 'execute' && stage !== 'audit') return null
  return checkpoint.nextStage === 'prepare' ? checkpoint : { ...checkpoint, nextStage: 'prepare' }
}
/** Rechecks the exact Worker proof while the caller's Gate checkpoint transaction holds proof-row locks. */
export function isScheduledTaskGraphGateProofCurrent(input: ScheduledTaskGraphGateInputRequest, tx: Prisma.TransactionClient): Promise<boolean> {
  return gateProofCurrent(input, tx)
}
export function isScheduledTaskGraphAuditChildGateProofCurrent(input: ScheduledTaskGraphAuditChildGateInputRequest,
  tx: Prisma.TransactionClient): Promise<boolean> { return gateProofCurrent(input, tx, input.auditActor) }
async function gateProofCurrent(input: ScheduledTaskGraphGateInputRequest, tx: Prisma.TransactionClient,
  auditActor?: ScheduledTaskGraphAuditActor): Promise<boolean> {
  try {
    const owner = parseOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = checkpoint ? scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint) : null
    if (!owner || !snapshot || !checkpoint || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameLineageOwner(parseOwner(marker.owner), owner)
      || marker.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot) || !checkpointDigest) return false
    const proof = parseScheduledTaskGraphPrepareProof(input.prepareProof)
    return Boolean(proof && proof.result.snapshotDigest === marker.snapshotDigest
      && proof.result.checkpointDigest === checkpointDigest
      && await verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, tx, input.gate, true, auditActor))
  } catch { return false }
}
/** Revalidates the live TaskGraph before reloading proof-named materials for Gate. */
export function loadScheduledTaskGraphGateInput(input: ScheduledTaskGraphGateInputRequest): Promise<ScheduledTaskGraphGateInput | null> {
  return loadGateInput(input)
}
export function loadScheduledTaskGraphAuditChildGateInput(input: ScheduledTaskGraphAuditChildGateInputRequest): Promise<ScheduledTaskGraphGateInput | null> {
  return loadGateInput(input, input.auditActor)
}
async function loadGateInput(input: ScheduledTaskGraphGateInputRequest, auditActor?: ScheduledTaskGraphAuditActor): Promise<ScheduledTaskGraphGateInput | null> {
  try {
    const owner = parseOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = checkpoint ? scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint) : null
    if (!owner || !snapshot || !checkpoint || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameLineageOwner(parseOwner(marker.owner), owner)
      || marker.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot) || !checkpointDigest) return null
    const proof = parseScheduledTaskGraphPrepareProof(input.prepareProof)
    if (!proof || proof.result.snapshotDigest !== marker.snapshotDigest || proof.result.checkpointDigest !== checkpointDigest
      || !await (auditActor ? db.$transaction(tx => verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation,
        proof, tx, input.gate, true, auditActor)) : verifyCurrentTaskGraph(owner, marker, checkpointDigest,
        input.analyzeAttestation, proof, db, input.gate))) return null
    const loaded = await loadScheduledTaskGraphGateMaterials({ owner, scoredJobs: checkpoint.scoredJobs,
      minScore: snapshot.minScore, dailyCap: snapshot.dailyCap, taskId: proof.result.taskId,
      jobs: proof.result.jobs, materials: proof.result.materials })
    if (!loaded || input.gate?.phase !== 'completed') return loaded
    const task = await db.subAgentTask.findFirst({ where: { id: input.gate.taskId, sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.rootTaskId, status: 'completed' }, select: { result: true } })
    const envelope = record(task?.result), gateResult = parseScheduledTaskGraphGateResult(envelope?.structuredResult,
      loaded.packages.map(pkg => pkg.jobId))
    return gateResult?.status === 'completed' ? { ...loaded, gateResult } : null
  } catch { return null }
}
async function verifyCurrentTaskGraph(owner: ScheduledTaskGraphPipelineOwner, marker: Record<string, unknown>, checkpointDigest: string,
  attestationValue: unknown, proof: ParsedScheduledTaskGraphPrepareProof, reader: Prisma.TransactionClient,
  gate?: ScheduledTaskGraphGateInputRequest['gate'], lockRows = false, auditActor?: ScheduledTaskGraphAuditActor): Promise<boolean> {
  if (auditActor && !await lockScheduledTaskGraphAuditChildFence(reader, { owner, auditActor })) return false
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
  if (gate && !await scheduledTaskGraphGateBindingIsCurrent({ reader, owner, marker, checkpointDigest, proof, gate })) return false
  let lockedTaskCount: number | null = null
  if (lockRows) {
    const graphLocks = await reader.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_items"
      WHERE "id" = ${taskGraphItemId(owner.rootTaskId)} AND "sessionId" = ${owner.sessionId}
        AND "turnId" = ${owner.turnId} AND "taskId" = ${owner.rootTaskId} AND "type" = 'task_graph'
      FOR UPDATE
    `)
    const taskLocks = await reader.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "sub_agent_tasks"
      WHERE "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId} AND "rootTaskId" = ${owner.rootTaskId}
      ORDER BY "id" FOR UPDATE
    `)
    const receiptLocks = await reader.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_events"
      WHERE "sessionId" = ${owner.sessionId} AND "turnId" = ${owner.turnId}
        AND "type" = 'agent.plan.scheduled_prepare_binding' AND "itemId" IS NULL AND "taskId" IS NULL AND "actor" = 'system'
      ORDER BY "id" FOR UPDATE
    `)
    if (graphLocks.length !== 1 || (gate ? taskLocks.length < 5 || taskLocks.length > 6 : taskLocks.length !== 4)
      || receiptLocks.length !== 1) return false
    lockedTaskCount = taskLocks.length
  }
  const [graph, tasks, receipts] = await Promise.all([
    reader.agentItem.findFirst({ where: { id: taskGraphItemId(owner.rootTaskId), sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: owner.rootTaskId, type: 'task_graph', session: { is: { userId: owner.userId } }, turn: { is: { userId: owner.userId, rootTaskId: owner.rootTaskId } } },
    select: { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true } }),
    reader.subAgentTask.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, session: { is: { userId: owner.userId } } },
    select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true, status: true, role: true,
      taskType: true, attemptCount: true, maxAttempts: true, failureReason: true, result: true, depth: true,
      expectedOutputSchema: true, allowedActions: true, context: true } }),
    reader.agentEvent.findMany({ where: { sessionId: owner.sessionId, turnId: owner.turnId, type: 'agent.plan.scheduled_prepare_binding',
      itemId: null, taskId: null, actor: 'system', session: { is: { userId: owner.userId } }, turn: { is: { userId: owner.userId, rootTaskId: owner.rootTaskId } } },
    select: { payload: true }, take: 2 }),
  ])
  if (!graph || graph.id !== taskGraphItemId(owner.rootTaskId) || graph.sessionId !== owner.sessionId || graph.turnId !== owner.turnId
    || graph.taskId !== owner.rootTaskId || graph.type !== 'task_graph'
    || (!gate && graph.revision !== proof.graphRevision) || receipts.length !== 1
    || !sameJson(receipts[0]?.payload, receipt)) return false
  const content = record(graph.content), graphNodes = denseArray(content?.nodes)?.map(record), roles = ['scout', 'analyst', 'prepare']
  if (content?.schemaVersion !== 'agent-harness.v2.task-graph' || !graphNodes
    || (!gate && graphNodes.length !== 3) || (gate && graphNodes.length !== 4 && graphNodes.length !== 5)
    || tasks.length !== graphNodes.length + 1 || lockedTaskCount !== null && lockedTaskCount !== tasks.length
    || new Set(nodes.map(node => node.taskId)).size !== 3) return false
  const byTask = uniqueMap(tasks, task => task.id)
  const root = byTask?.get(owner.rootTaskId)
  if (!byTask || !root || root.attemptCount !== owner.rootAttemptCount || root.parentTaskId !== null
    || root.status !== 'running' && !(auditActor && root.status === 'waiting') || root.failureReason !== null) return false
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
  if (gate) {
    const gateTask = byTask.get(gate.taskId), gateNode = graphNodes[3]
    if (!gateTask || !gateNode || gateTask.id !== gate.taskId || gateTask.parentTaskId !== owner.rootTaskId
      || gateTask.depth !== 1 || gateTask.role !== 'prepare' || gateTask.taskType !== 'scheduled_taskgraph_gate'
      || gateTask.attemptCount !== gate.attemptCount || gateTask.status !== gate.phase
      || !Number.isSafeInteger(gateTask.maxAttempts) || gateTask.maxAttempts < 1 || gateTask.failureReason !== null
      || !Array.isArray(gateTask.allowedActions) || gateTask.allowedActions.length !== 0
      || !sameJson(gateTask.expectedOutputSchema, { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', taskType: 'scheduled_taskgraph_gate' })
      ) return false
    const hasAudit = graphNodes.length === 5, auditNode = hasAudit ? graphNodes[4] : null
    const auditTask = auditNode && typeof auditNode.taskId === 'string' ? record(byTask.get(auditNode.taskId)) : null
    const auditTaskInfo = auditTask && typeof auditTask.id === 'string' && typeof auditTask.status === 'string'
      && typeof auditTask.attemptCount === 'number' ? { id: auditTask.id, status: auditTask.status, attemptCount: auditTask.attemptCount } : undefined
    if (hasAudit && (gate.phase !== 'completed' || !auditNode || !auditTask || !auditTaskInfo
      || !validScheduledAuditNode(auditNode, auditTaskInfo.id) || !validScheduledAuditTask(auditTask, owner))) return false
    if (auditActor && (auditNode?.taskId !== auditActor.taskId || auditTask?.status !== 'running'
      || auditTask.attemptCount !== auditActor.attemptCount)) return false
    if (!await scheduledTaskGraphGateHistoryIsCurrent({ reader, owner, prepareGraphRevision: proof.graphRevision,
        prepareTaskId: proof.nodes[2].taskId, prepareAttemptCount: proof.nodes[2].attemptCount,
        graphRevision: graph.revision, graphContent: graph.content,
        gateTask: { id: gateTask.id, status: gateTask.status, attemptCount: gateTask.attemptCount, maxAttempts: gateTask.maxAttempts, result: gateTask.result },
        gate, expectedJobIds: proof.result.jobs.filter(job => job.status === 'prepared').map(job => job.jobId),
        ...(auditTaskInfo ? { auditTask: auditTaskInfo } : {}) })) return false
  }
  return true
}

function validScheduledAuditNode(node: Record<string, unknown>, taskId: string): boolean {
  return Boolean(exactRecord(node, ['key', 'templateId', 'goal', 'successCriteria', 'dependsOn', 'depth', 'taskId', 'verificationDisposition'])
    && node.key === 'scheduled_audit' && node.templateId === 'scheduled_audit' && node.taskId === taskId && node.depth === 5
    && sameStrings(node.dependsOn, ['gate']) && node.verificationDisposition === 'specialized'
    && node.goal === AUDIT_GOAL && sameJson(node.successCriteria, AUDIT_CRITERIA))
}

function validScheduledAuditTask(task: Record<string, unknown>, owner: ScheduledTaskGraphPipelineOwner): boolean {
  const status = task.status, attempt = task.attemptCount
  return task.sessionId === owner.sessionId && task.turnId === owner.turnId && task.rootTaskId === owner.rootTaskId
    && task.parentTaskId === owner.rootTaskId && task.depth === 1 && task.role === 'auditor' && task.taskType === 'scheduled_taskgraph_audit'
    && (status === 'queued' || status === 'running' || status === 'retrying' || status === 'completed')
    && (status === 'queued' ? nonNegative(attempt) : positive(attempt)) && positive(task.maxAttempts) && task.failureReason === null
    && Array.isArray(task.allowedActions) && task.allowedActions.length === 0 && sameJson(task.expectedOutputSchema, AUDIT_OUTPUT_SCHEMA)
    && sameJson(task.context, {})
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
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const row = record(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('scheduled_prepare_proof_invalid')
  return encoded
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
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isDigest(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value) }
function isHex(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
