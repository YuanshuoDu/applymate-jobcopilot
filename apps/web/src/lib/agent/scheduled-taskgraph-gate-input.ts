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
import { projectScheduledTaskGraphCanonicalPrefix, sameScheduledTaskGraphJson, scheduledTaskGraphVerificationReportMatches, sameScheduledTaskGraphOwnerScope, sameScheduledTaskGraphIdSet, scheduledTaskGraphAuditNodeMatches, uniqueScheduledTaskGraphRows } from './scheduled-taskgraph-canonical-prefix'
import { parseScheduledTaskGraphPipelineOwner, sameScheduledTaskGraphLineageOwner, scheduledTaskGraphPrepareProofMatchesAttestation, scheduledTaskGraphPrepareReceiptKey } from './scheduled-taskgraph-prepare-proof'
import { lockScheduledTaskGraphAuditChildFence, lockScheduledTaskGraphAuditCompletedReportChildFence, lockScheduledTaskGraphPostGateChildFence, scheduledTaskGraphAuditTaskMatches, type ScheduledTaskGraphAuditActor, type ScheduledTaskGraphPostGateActor } from './scheduled-taskgraph-audit-child-fence'
import { parseScheduledPostGateHandoff, scheduledTaskGraphPostGateProofIsCurrent } from './scheduled-taskgraph-post-gate-proof'
import { scheduledGateRootWaitWitnessMatches, type ScheduledGateRootWait } from './scheduled-taskgraph-gate-root-wait'
type AuditChildFenceLock = typeof lockScheduledTaskGraphAuditChildFence
const CONTINUATION_SCHEMA = 'agent-harness.v2.scheduled-pipeline-continuation.v1'
const COMPLETION_SCHEMA = 'agent-harness.v2.scheduled-taskgraph-prepare-completion.v1'
const AUDIT_GOAL = 'Return the exact report from the authenticated scheduled Audit continuation after Gate completion.'
const AUDIT_CRITERIA = ['Continue the exact scheduled execution only after its canonical Gate proof is verified.', 'Return only the fixed seven-field report without adding actions or interpreting historical counts.', 'Never submit applications or invoke model or tool runtimes.']
const ID = /^[^\u0000-\u001f\u007f]{1,256}$/
export type ScheduledTaskGraphGateInputRequest = Readonly<{ owner: ScheduledTaskGraphPipelineOwner; snapshot: unknown; analyzeCheckpoint: unknown;
  analyzeAttestation: unknown; prepareProof: unknown; gate?: Readonly<{ taskId: string; attemptCount: number; phase: 'running' | 'completed'; completionProof?: unknown }>; gateRootWait?: ScheduledGateRootWait }>
export type ScheduledTaskGraphAuditChildGateInputRequest = ScheduledTaskGraphGateInputRequest & Readonly<{ auditActor: ScheduledTaskGraphAuditActor }>
export type ScheduledTaskGraphPostGateGateInputRequest = Omit<ScheduledTaskGraphGateInputRequest, 'gate'> & Readonly<{
  gate: Readonly<{ taskId: string; attemptCount: number; phase: 'completed'; completionProof: unknown }>
  postGate: Readonly<{ actor: ScheduledTaskGraphPostGateActor; handoff: unknown; packageRefs?: readonly string[] }>
}>
export type ScheduledTaskGraphGateInput = Readonly<{ packages: readonly ScheduledTaskGraphPreparedPackageRow[];
  materials: readonly ScheduledTaskGraphPreparedMaterialRow[]; gateResult?: ScheduledTaskGraphGateResult }>
export function scheduledTaskGraphAnalyzeCheckpointForGate(value: unknown): Record<string, unknown> | null {
  const checkpoint = record(value)
  const stage = checkpoint?.nextStage
  if (!checkpoint || stage !== 'prepare' && stage !== 'gate' && stage !== 'execute' && stage !== 'audit') return null
  return checkpoint.nextStage === 'prepare' ? checkpoint : { ...checkpoint, nextStage: 'prepare' }
}
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
      && await verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, tx, input.gate, true, auditActor, auditFence, undefined, undefined, input.gateRootWait))
  } catch { return false }
}
export function loadScheduledTaskGraphGateInput(input: ScheduledTaskGraphGateInputRequest,
  reader?: Prisma.TransactionClient): Promise<ScheduledTaskGraphGateInput | null> {
  return loadGateInput(input, undefined, undefined, reader)
}
export function loadScheduledTaskGraphAuditChildGateInput(input: ScheduledTaskGraphAuditChildGateInputRequest): Promise<ScheduledTaskGraphGateInput | null> {
  return loadGateInput(input, input.auditActor)
}
export function loadScheduledTaskGraphPostGateGateInput(input: ScheduledTaskGraphPostGateGateInputRequest): Promise<ScheduledTaskGraphGateInput | null> {
  if (!input?.gate || input.gate.phase !== 'completed') return Promise.resolve(null)
  return loadGateInput(input, undefined, input.postGate)
}
async function loadGateInput(input: ScheduledTaskGraphGateInputRequest, auditActor?: ScheduledTaskGraphAuditActor, postGate?: ScheduledTaskGraphPostGateGateInputRequest['postGate'], reader?: Prisma.TransactionClient): Promise<ScheduledTaskGraphGateInput | null> {
  try {
    const currentReader = reader ?? db
    const owner = parseScheduledTaskGraphPipelineOwner(input.owner), snapshot = parseScheduledAutomationSnapshot(input.snapshot)
    const checkpoint = scheduledTaskGraphAnalyzeCheckpointForGate(input.analyzeCheckpoint), marker = exactRecord(checkpoint?.scheduledTaskGraphContinuation,
      ['schemaVersion', 'key', 'owner', 'snapshotDigest', 'graphRevision', 'evidenceDigest'])
    const checkpointDigest = checkpoint ? scheduledTaskGraphAnalyzeCheckpointDigest(checkpoint) : null
    if (!owner || !snapshot || !checkpoint || !marker
      || marker.schemaVersion !== CONTINUATION_SCHEMA || !sameScheduledTaskGraphLineageOwner(parseScheduledTaskGraphPipelineOwner(marker.owner), owner)
      || marker.snapshotDigest !== scheduledAutomationSnapshotDigest(snapshot) || !checkpointDigest) return null
    const proof = parseScheduledTaskGraphPrepareProof(input.prepareProof)
    if (!proof || proof.result.snapshotDigest !== marker.snapshotDigest || proof.result.checkpointDigest !== checkpointDigest
      || !await (auditActor || postGate ? reader
        ? verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, reader, input.gate,
          true, auditActor, lockScheduledTaskGraphAuditChildFence, postGate, input.prepareProof, input.gateRootWait)
        : db.$transaction(tx => verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation,
          proof, tx, input.gate, true, auditActor, lockScheduledTaskGraphAuditChildFence, postGate, input.prepareProof, input.gateRootWait))
        : verifyCurrentTaskGraph(owner, marker, checkpointDigest, input.analyzeAttestation, proof, currentReader, input.gate, false, undefined, lockScheduledTaskGraphAuditChildFence, undefined, undefined, input.gateRootWait))) return null
    const loaded = await loadScheduledTaskGraphGateMaterials({ owner, scoredJobs: checkpoint.scoredJobs,
      minScore: snapshot.minScore, dailyCap: snapshot.dailyCap, taskId: proof.result.taskId,
      jobs: proof.result.jobs, materials: proof.result.materials, reader: currentReader })
    if (!loaded || input.gate?.phase !== 'completed') return loaded
    const task = await currentReader.subAgentTask.findFirst({ where: { id: input.gate.taskId, sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.rootTaskId, status: 'completed' }, select: { result: true } })
    const envelope = record(task?.result), gateResult = parseScheduledTaskGraphGateResult(envelope?.structuredResult,
      loaded.packages.map(pkg => pkg.jobId))
    return gateResult?.status === 'completed' ? { ...loaded, gateResult } : null
  } catch { return null }
}
async function verifyCurrentTaskGraph(owner: ScheduledTaskGraphPipelineOwner, marker: Record<string, unknown>, checkpointDigest: string, attestationValue: unknown, proof: ParsedScheduledTaskGraphPrepareProof, reader: Prisma.TransactionClient,
  gate?: ScheduledTaskGraphGateInputRequest['gate'], lockRows = false, auditActor?: ScheduledTaskGraphAuditActor,
  auditFence: AuditChildFenceLock = lockScheduledTaskGraphAuditChildFence, postGate?: ScheduledTaskGraphPostGateGateInputRequest['postGate'],
  prepareProofValue?: unknown, gateRootWait?: ScheduledGateRootWait): Promise<boolean> {
  if (auditActor && !await auditFence(reader, { owner, auditActor })) return false
  if (postGate && !await lockScheduledTaskGraphPostGateChildFence(reader, { owner, actor: postGate.actor })) return false
  const { receipt, nodes } = proof, attestation = parseScheduledPipelineAttestation(attestationValue)
  if (!attestation || attestation.snapshotDigest !== marker.snapshotDigest
    || attestation.graphRevision !== marker.graphRevision || attestation.evidenceDigest !== marker.evidenceDigest
    || !sameScheduledTaskGraphOwnerScope(record(attestation.owner), owner)
    || !sameScheduledTaskGraphLineageOwner(parseScheduledTaskGraphPipelineOwner(receipt.owner), owner)
    || !scheduledTaskGraphPrepareProofMatchesAttestation(proof, attestation)
    || receipt.snapshotDigest !== marker.snapshotDigest || receipt.evidenceDigest !== marker.evidenceDigest
    || receipt.checkpointDigest !== checkpointDigest || receipt.analyzeGraphRevision !== marker.graphRevision
    || receipt.prepareScheduleRevision !== Number(marker.graphRevision) + 1 || receipt.continuationKey !== scheduledTaskGraphPrepareReceiptKey(owner, receipt)) return false
  const handoff = postGate ? parseScheduledPostGateHandoff(postGate.handoff) : null
  if (postGate && (!handoff || !gate || gate.phase !== 'completed' || !sameScheduledTaskGraphJson(gate.completionProof, handoff.gateProof))) return false
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
    const expectedTasks = postGate && handoff ? nodes.length + handoff.executeNodes.length + 3
      : gate ? undefined : nodes.length + 1
    if (graphLocks.length !== 1 || (expectedTasks !== undefined ? taskLocks.length !== expectedTasks
      : taskLocks.length < nodes.length + 2 || taskLocks.length > nodes.length + 3)
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
  const projected = postGate && handoff && content && graphNodes ? { ...content, nodes: graphNodes.slice(0, nodes.length + 1) } : graph.content
  const projection = projectScheduledTaskGraphCanonicalPrefix(projected, attestation, gate ? 'gate' : 'prepare')
  const extra = postGate ? handoff ? handoff.executeNodes.length + 2 : -1 : gate ? 2 : 0
  if (content?.schemaVersion !== 'agent-harness.v2.task-graph' || !graphNodes || !projection
    || graphNodes.length < nodes.length || graphNodes.length > nodes.length + extra
    || tasks.length !== graphNodes.length + 1 || lockedTaskCount !== null && lockedTaskCount !== tasks.length) return false
  const byTask = uniqueScheduledTaskGraphRows(tasks, task => task.id)
  const root = byTask?.get(owner.rootTaskId)
  const gateRootWaitCurrent = !!gateRootWait && gate?.phase === 'running' && !!root
    && scheduledGateRootWaitWitnessMatches({ owner, gateTaskId: gate.taskId, root, witness: gateRootWait })
  if (gateRootWait && (!gateRootWaitCurrent || root?.status !== 'waiting' || auditActor || postGate)) return false
  if (!byTask || !root || root.attemptCount !== owner.rootAttemptCount || root.parentTaskId !== null
    || root.status !== 'running' && !(auditActor && root.status === 'waiting') && !(postGate && root.status === 'waiting') && !gateRootWaitCurrent
    || root.failureReason !== null) return false
  const sourceCount = nodes.length - 2
  const attestedScouts = attestation.schemaVersion === 'agent-harness.v2.scheduled-pipeline-attestation.v1'
    ? [attestation.scout] : attestation.scouts
  const scoutByKey = new Map(projection.scouts.map(node => [node.key, attestedScouts.find(source => source.taskId === node.taskId)]))
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
    const auditNode = !postGate && projection.audit ? graphNodes[nodes.length + 1] ?? null : null, hasAudit = auditNode !== null
    const auditTask = auditNode && typeof auditNode.taskId === 'string' ? record(byTask.get(auditNode.taskId)) : null
    const auditTaskInfo = auditTask && typeof auditTask.id === 'string' && typeof auditTask.status === 'string'
      && typeof auditTask.attemptCount === 'number' ? { id: auditTask.id, status: auditTask.status, attemptCount: auditTask.attemptCount } : undefined
    if (hasAudit && (gate.phase !== 'completed' || !auditNode || !auditTask || !auditTaskInfo
      || !scheduledTaskGraphAuditNodeMatches(auditNode, auditTaskInfo.id, AUDIT_GOAL, AUDIT_CRITERIA)
      || !scheduledTaskGraphAuditTaskMatches(auditTask, owner))) return false
    if (auditActor && (auditNode?.taskId !== auditActor.taskId || auditTask?.status !== 'running'
      || auditTask.attemptCount !== auditActor.attemptCount)) return false
    if (postGate) {
      if (!handoff || !prepareProofValue || !gate || !await scheduledTaskGraphPostGateProofIsCurrent(reader, {
        owner, actor: postGate.actor, handoff, packageRefs: postGate.packageRefs, prepareProof: prepareProofValue,
        gate: { ...gate, phase: 'completed', completionProof: handoff.gateProof }, graph, tasks, actorFenceLocked: true })) return false
    } else if (!await scheduledTaskGraphGateHistoryIsCurrent({ reader, owner, prepareGraphRevision: proof.graphRevision,
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
  return own.length === keys.length && !own.some(key => typeof key !== 'string' || !keys.includes(key)) ? value as Record<string, unknown> : null
}
function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function record(value: unknown): Record<string, unknown> | null { return plain(value) ? value : null }
function denseArray(value: unknown): unknown[] | null {
  return Array.isArray(value) && Reflect.ownKeys(value).length === value.length + 1 ? value : null
}
function validId(value: unknown): value is string { return typeof value === 'string' && ID.test(value) && value.trim() === value }
