import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { parseScheduledPipelineAttestation } from '@jobcopilot/agent-protocol'
import { db } from '@/lib/db'
import { parseScheduledAutomationSnapshot } from './scheduled-automation-snapshot'
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'
import { parseScheduledTaskGraphPrepareProof, scheduledTaskGraphAnalyzeCheckpointDigest, type ParsedScheduledTaskGraphPrepareProof, type ScheduledTaskGraphPreparedMaterialRow, type ScheduledTaskGraphPreparedPackageRow } from './scheduled-taskgraph-gate-checkpoint'
import { loadScheduledTaskGraphGateMaterials } from './scheduled-taskgraph-gate-materials'
import { scheduledTaskGraphGateBindingIsCurrent, scheduledTaskGraphGateHistoryIsCurrent } from './scheduled-taskgraph-gate-history'
import { parseScheduledTaskGraphGateResult, type ScheduledTaskGraphGateResult } from './scheduled-taskgraph-gate-service'
import { projectScheduledTaskGraphCanonicalPrefix, sameScheduledTaskGraphJson,
  scheduledTaskGraphVerificationReportMatches, sameScheduledTaskGraphOwnerScope, sameScheduledTaskGraphIdSet,
  scheduledTaskGraphAuditNodeMatches, uniqueScheduledTaskGraphRows } from './scheduled-taskgraph-canonical-prefix'
import { parseScheduledTaskGraphPipelineOwner, sameScheduledTaskGraphLineageOwner,
  scheduledTaskGraphPrepareProofMatchesAttestation, scheduledTaskGraphPrepareReceiptKey } from './scheduled-taskgraph-prepare-proof'
import { lockScheduledTaskGraphAuditChildFence, lockScheduledTaskGraphAuditCompletedReportChildFence,
  scheduledTaskGraphAuditTaskMatches, type ScheduledTaskGraphAuditActor } from './scheduled-taskgraph-audit-child-fence'
type AuditChildFenceLock = typeof lockScheduledTaskGraphAuditChildFence
const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const COMPLETION_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1'
const AUDIT_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const AUDIT_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.',
  'Return only the fixed seven-field report without adding actions or interpreting historical counts.',
  'Never submit applications or invoke model or tool runtimes.']
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
export function isScheduledTaskGraphAuditCompletedReportGateProofCurrent(input: ScheduledTaskGraphAuditChildGateInputRequest,
  tx: Prisma.TransactionClient): Promise<boolean> { return gateProofCurrent(input, tx, input.auditActor, lockScheduledTaskGraphAuditCompletedReportChildFence) }
async function gateProofCurrent(input: ScheduledTaskGraphGateInputRequest, tx: Prisma.TransactionClient,
  auditActor?: ScheduledTaskGraphAuditActor, auditFence: AuditChildFenceLock = lockScheduledTaskGraphAuditChildFence): Promise<boolean> {
  try {
    const owner = parseScheduledTaskGraphPipelineOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = checkpoint ? scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint) : null
    if (!owner || !snapshot || !checkpoint || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameScheduledTaskGraphLineageOwner(parseScheduledTaskGraphPipelineOwner(marker.owner), owner)
      || marker.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot) || !checkpointDigest) return false
    const proof = parseScheduledTaskGraphPrepareProof(input.prepareProof)
    return Boolean(proof && proof.result.snapshotDigest === marker.snapshotDigest
      && proof.result.checkpointDigest === checkpointDigest
      && await verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, tx, input.gate, true, auditActor, auditFence))
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
    const owner = parseScheduledTaskGraphPipelineOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = checkpoint ? scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint) : null
    if (!owner || !snapshot || !checkpoint || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameScheduledTaskGraphLineageOwner(parseScheduledTaskGraphPipelineOwner(marker.owner), owner)
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
  gate?: ScheduledTaskGraphGateInputRequest['gate'], lockRows = false, auditActor?: ScheduledTaskGraphAuditActor,
  auditFence: AuditChildFenceLock = lockScheduledTaskGraphAuditChildFence): Promise<boolean> {
  if (auditActor && !await auditFence(reader, { owner, auditActor })) return false
  const { receipt, nodes } = proof, attestation = parseScheduledPipelineAttestation(attestationValue)
  if (!attestation || attestation.snapshotDigest !== marker.snapshotDigest
    || attestation.graphRevision !== marker.graphRevision || attestation.evidenceDigest !== marker.evidenceDigest
    || !sameScheduledTaskGraphOwnerScope(record(attestation.owner), owner)
    || !sameScheduledTaskGraphLineageOwner(parseScheduledTaskGraphPipelineOwner(receipt.owner), owner)
    || !scheduledTaskGraphPrepareProofMatchesAttestation(proof, attestation)
    || receipt.snapshotDigest !== marker.snapshotDigest || receipt.evidenceDigest !== marker.evidenceDigest
    || receipt.checkpointDigest !== checkpointDigest || receipt.analyzeGraphRevision !== marker.graphRevision
    || receipt.prepareScheduleRevision !== Number(marker.graphRevision) + 1 || receipt.continuationKey !== scheduledTaskGraphPrepareReceiptKey(owner, receipt)) return false
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
    if (graphLocks.length !== 1 || (gate ? taskLocks.length < nodes.length + 2 || taskLocks.length > nodes.length + 3 : taskLocks.length !== nodes.length + 1)
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
    || !sameScheduledTaskGraphJson(receipts[0]?.payload, receipt)) return false
  const content = record(graph.content), graphNodes = denseArray(content?.nodes)?.map(record)
  const projection = projectScheduledTaskGraphCanonicalPrefix(graph.content, attestation, gate ? 'gate' : 'prepare')
  if (content?.schemaVersion !== 'agent-harness.v2.task-graph' || !graphNodes || !projection
    || graphNodes.length < nodes.length || graphNodes.length > nodes.length + (gate ? 2 : 0)
    || tasks.length !== graphNodes.length + 1 || lockedTaskCount !== null && lockedTaskCount !== tasks.length) return false
  const byTask = uniqueScheduledTaskGraphRows(tasks, task => task.id)
  const root = byTask?.get(owner.rootTaskId)
  if (!byTask || !root || root.attemptCount !== owner.rootAttemptCount || root.parentTaskId !== null
    || root.status !== 'running' && !(auditActor && root.status === 'waiting') || root.failureReason !== null) return false
  const sourceCount = nodes.length - 2
  const attestedScouts = attestation.schemaVersion === 'agent-harness.v2.scheduled-pipeline-attestation.v1'
    ? [{ nodeKey: 'scout', ...attestation.scout }] : attestation.scouts
  const scoutByKey = new Map(attestedScouts.map(source => [source.nodeKey, source]))
  for (let i = 0; i < nodes.length; i += 1) {
    const proofNode = nodes[i]!, graphNode = graphNodes[i], role = i < sourceCount ? 'scout' : i === sourceCount ? 'analyst' : 'prepare'
    const task = byTask.get(proofNode.taskId), expected = role === 'scout' ? record(scoutByKey.get(String(graphNode?.key)))
      : role === 'analyst' ? record(attestation.analyst) : null
    const dependencies = role === 'scout' ? [] : role === 'analyst' ? projection.scouts.map(node => node.key) : [projection.analyst.key]
    const dependencyTaskIds = role === 'scout' ? [] : role === 'analyst' ? attestedScouts.map(source => source.taskId)
      : [nodes[sourceCount]!.taskId]
    const depth = role === 'scout' ? 1 : role === 'analyst' ? 2 : 3
    const taskType = role === 'scout' ? 'job_discovery' : role === 'analyst' ? 'job_analysis' : 'scheduled_application_prepare'
    if (!graphNode || !task || graphNode.templateId !== role || graphNode.taskId !== proofNode.taskId || graphNode.depth !== depth
      || !sameScheduledTaskGraphIdSet(graphNode.dependsOn, dependencies) || graphNode.verificationDisposition !== (role === 'prepare' ? 'specialized' : 'typed')
      || !sameScheduledTaskGraphIdSet(proofNode.dependsOnTaskIds, dependencyTaskIds)
      || task.sessionId !== owner.sessionId || task.turnId !== owner.turnId || task.rootTaskId !== owner.rootTaskId
      || task.parentTaskId !== owner.rootTaskId || task.status !== 'completed' || task.failureReason !== null
      || task.attemptCount !== proofNode.attemptCount || task.role !== role
      || proofNode.taskType !== taskType || task.taskType !== proofNode.taskType) return false
    const envelope = record(task.result)
    if (!envelope || envelope.status !== 'completed') return false
    if (role !== 'prepare') {
      if (!expected || !scheduledTaskGraphVerificationReportMatches(record(envelope.taskGraphVerificationReport), graphNode, expected)) return false
    } else if (!sameScheduledTaskGraphJson(envelope.structuredResult, proof.result.raw) || !sameScheduledTaskGraphJson(envelope.taskGraphScheduledPrepareProofFacts,
      { schemaVersion: 'agent-harness.v2.scheduled-taskgraph-prepare-proof-facts.v1', receipt,
        completion: { schemaVersion: COMPLETION_SCHEMA, graphRevision: proof.graphRevision, nodes }, result: proof.result.raw })) return false
  }
  if (gate) {
    const gateTask = byTask.get(gate.taskId), gateNode = projection.gate
    if (!gateTask || !gateNode || gateTask.id !== gate.taskId || gateTask.parentTaskId !== owner.rootTaskId
      || gateTask.depth !== 1 || gateTask.role !== 'prepare' || gateTask.taskType !== 'scheduled_taskgraph_gate'
      || gateTask.attemptCount !== gate.attemptCount || gateTask.status !== gate.phase
      || !Number.isSafeInteger(gateTask.maxAttempts) || gateTask.maxAttempts < 1 || gateTask.failureReason !== null
      || !Array.isArray(gateTask.allowedActions) || gateTask.allowedActions.length !== 0
      || !sameScheduledTaskGraphJson(gateTask.expectedOutputSchema, { schemaVersion: 'agent-harness.v2.subagent.result', role: 'prepare', taskType: 'scheduled_taskgraph_gate' })
      ) return false
    const auditNode = projection.audit ? graphNodes[nodes.length + 1] ?? null : null, hasAudit = auditNode !== null
    const auditTask = auditNode && typeof auditNode.taskId === 'string' ? record(byTask.get(auditNode.taskId)) : null
    const auditTaskInfo = auditTask && typeof auditTask.id === 'string' && typeof auditTask.status === 'string'
      && typeof auditTask.attemptCount === 'number' ? { id: auditTask.id, status: auditTask.status, attemptCount: auditTask.attemptCount } : undefined
    if (hasAudit && (gate.phase !== 'completed' || !auditNode || !auditTask || !auditTaskInfo
      || !scheduledTaskGraphAuditNodeMatches(auditNode, auditTaskInfo.id, AUDIT_GOAL, AUDIT_CRITERIA)
      || !scheduledTaskGraphAuditTaskMatches(auditTask, owner))) return false
    if (auditActor && (auditNode?.taskId !== auditActor.taskId || auditTask?.status !== 'running'
      || auditTask.attemptCount !== auditActor.attemptCount)) return false
    if (!await scheduledTaskGraphGateHistoryIsCurrent({ reader, owner, prepareGraphRevision: proof.graphRevision,
        prepareTaskId: nodes[nodes.length - 1]!.taskId, prepareAttemptCount: nodes[nodes.length - 1]!.attemptCount,
        graphRevision: graph.revision, graphContent: graph.content,
        gateTask: { id: gateTask.id, status: gateTask.status, attemptCount: gateTask.attemptCount, maxAttempts: gateTask.maxAttempts, result: gateTask.result },
        gate, expectedJobIds: proof.result.jobs.filter(job => job.status === 'prepared').map(job => job.jobId),
        ...(auditTaskInfo ? { auditTask: auditTaskInfo } : {}) })) return false
  }
  return true
}

function taskGraphItemId(rootTaskId: string): string { return `task-graph-${createHash('sha256').update(rootTaskId).digest('hex')}` }
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
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
