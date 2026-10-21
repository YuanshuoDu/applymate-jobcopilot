import { createHash } from "node:crypto"
import type pg from "pg"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"
import type { ToolExecutionContext } from "../tools/types.js"
import { loadSelectedJobArtifactContext } from "./selected-job-artifact-context.js"
import { createScheduledAutomationPipelineBridge, type ScheduledAutomationPipelineAttestation, type ScheduledAutomationPersistedTask } from "./scheduled-automation-pipeline-bridge.js"
import { scheduledAnalyzeGraphMatches, scheduledSnapshotMatches, scheduledTaskGraphClaimMatches, scheduledTaskGraphStableContinuationKey,
  SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT,
  parseScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledTaskGraphContinuationBinding } from "./scheduled-taskgraph-continuation-receipt.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import { loadTaskGraph, currentTaskGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { canonicalTaskGraphJson, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { validateRoleResult, type AnalystResult } from "./role-results.js"
import type { ScheduledApplicationPrepareDependencies, ScheduledPrepareOwner, VerifiedScheduledPrepareInvocation } from "../tools/scheduled-application-prepare.js"
import { eligibleScheduledPrepareScore, prepareScheduledJobMaterials, resolveScheduledPrepareChoice,
  scheduledPrepareCitedRefs, scheduledPrepareContainsRefs } from "./scheduled-application-prepare-materials.js"
import type { ScheduledPrepareMaterialDetail, ScheduledPrepareMaterialOptions } from "./scheduled-application-prepare-materials.js"
export { persistScheduledPrepareMaterial, scheduledPrepareArtifactIdentity } from "./scheduled-application-prepare-materials.js"

type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
type Detail = ScheduledPrepareMaterialDetail
type Options = ScheduledPrepareMaterialOptions & Readonly<{ task: SubagentTaskRecord; lease: SubagentLease; now?: () => Date }>

/** Build the production dependencies for one persisted scheduled Prepare child. */
export function createScheduledApplicationPrepareRuntime(options: Options): ScheduledApplicationPrepareDependencies {
  let details = new Map<string, Detail>()
  return {
    loadVerifiedInvocation: async context => {
      const loaded = await loadInvocation(options, context)
      details = loaded.details
      return loaded.invocation
    },
    resolveResumeTailoringChoice: input => resolveScheduledPrepareChoice(options.pool, input.invocation, options.now?.() ?? new Date()),
    prepareJob: (input, signal) => prepareScheduledJobMaterials(options, input, details.get(input.job.jobId), signal),
  }
}

async function loadInvocation(options: Options, context: ToolExecutionContext): Promise<{ invocation: VerifiedScheduledPrepareInvocation; details: Map<string, Detail> }> {
  const { lease, task, owner } = options
  if (owner.kind !== "task" || task.role !== "prepare" || task.taskType !== "scheduled_application_prepare"
    || lease.role !== task.role || lease.taskType !== task.taskType || context.taskId !== lease.id
    || context.scope.userId !== lease.userId || context.sessionId !== lease.sessionId || context.turnId !== lease.turnId
    || context.rootTaskId !== lease.rootTaskId || lease.parentTaskId !== lease.rootTaskId) throw new Error("scheduled_prepare_owner_invalid")
  const client = await options.pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const persisted = await readPersistedOwner(client, lease, owner)
    const scope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId }
    const loaded = await loadTaskGraph(client, scope, false), snapshot = loaded.snapshot
    if (!snapshot || !loaded.state || snapshot.nodes.length !== 3 || snapshot.nodes[2]?.taskId !== lease.id) throw new Error("scheduled_prepare_graph_invalid")
    const current = currentTaskGraph(loaded), taskRow = loaded.tasks.get(lease.id), node = snapshot.nodes[2]!
    if (!taskRow || !prepareTaskMatches(taskRow, node, lease) || current.nodes.find(value => value.key === "prepare")?.status !== "running") throw new Error("scheduled_prepare_task_invalid")
    const receipt = await readPrivateReceipt(client, scope, persisted.owner)
    if (!receipt) throw new Error("scheduled_prepare_receipt_invalid")
    const bridge = createScheduledAutomationPipelineBridge({
      load: async () => ({ turn: persisted.turn, root: persisted.root,
        snapshot: scheduledPrepareAnalyzeSnapshot(snapshot),
        current: { revision: receipt.analyzeGraphRevision, nodes: current.nodes.slice(0, 2) },
        tasks: snapshot.nodes.slice(0, 2).map(value => loaded.tasks.get(value.taskId)!).filter(Boolean).map(value => persistedTask(value, lease)) }),
      verifyCompletedNode: input => verifyCompletedTaskGraphNodeEvidence(client, input),
    })
    const bridged = await bridge(persisted.owner)
    if (bridged.status !== "ready" || bridged.attestation.evidenceDigest !== receipt.evidenceDigest
      || bridged.attestation.snapshotDigest !== receipt.snapshotDigest) throw new Error("scheduled_prepare_analyze_unverified")
    const liveBinding = scheduledPrepareLiveCheckpointBinding(receipt, persisted.owner, bridged.attestation)
    if (!liveBinding) throw new Error("scheduled_prepare_receipt_invalid")
    const handoffKey = liveBinding.continuationKey
    const checkpoint = await readExecutionCheckpoint(client, receipt, persisted.turn, persisted.owner, handoffKey, options.now?.() ?? new Date())
    const proposal = { expectedRevision: receipt.analyzeGraphRevision, nodes: [{ key: node.key, templateId: node.templateId,
      goal: node.goal, successCriteria: node.successCriteria, dependsOn: node.dependsOn }] }
    const handoff = { status: "analyze_checkpointed" as const, continuationKey: handoffKey,
      checkpointDigest: receipt.checkpointDigest, claimTokenDigest: checkpoint.claimTokenDigest,
      executionId: receipt.owner.executionId, executionAttemptCount: receipt.owner.executionAttemptCount }
    const graphInput = { scope: persisted.executionScope, executionOwner: { executionId: receipt.owner.executionId, executionAttemptCount: receipt.owner.executionAttemptCount },
      handoff, attestation: bridged.attestation, proposal }
    if (!scheduledAnalyzeGraphMatches(graphInput, snapshot, current, loaded.tasks, true)) throw new Error("scheduled_prepare_graph_binding_invalid")
    const automation = parseScheduledAutomationSnapshot(record(persisted.turn.input)?.scheduledAutomationSnapshot)
    const analystEnvelope = record(loaded.tasks.get(snapshot.nodes[1]!.taskId)?.result)
    if (!automation || !analystEnvelope) throw new Error("scheduled_prepare_checkpoint_invalid")
    const analyst = validateRoleResult(analystEnvelope.structuredResult, "analyst") as AnalystResult
    const scored = record(checkpoint.state)?.scoredJobs
    if (!Array.isArray(scored) || scored.length > 500) throw new Error("scheduled_prepare_checkpoint_invalid")
    const eligible = scored.map(eligibleScheduledPrepareScore).filter((value): value is NonNullable<typeof value> => Boolean(value))
      .filter(value => value.score >= automation.minScore).slice(0, automation.dailyCap)
    const details = new Map<string, Detail>(), checkpointJobs = []
    for (const score of eligible) {
      const sources = await loadSelectedJobArtifactContext(options.pool, lease.userId, score.jobId)
      const finding = analyst.findings.find(value => value.jobId === score.jobId)
      const refs = finding && scheduledPrepareCitedRefs(analyst, score.jobId, finding.evidenceIds, sources.baseResumeId)
      if (!refs) throw new Error("scheduled_prepare_evidence_missing")
      if (!scheduledPrepareContainsRefs(sources, refs)) throw new Error("scheduled_prepare_evidence_scope_invalid")
      details.set(score.jobId, { sources, matched: score.matched, missing: score.missing })
      checkpointJobs.push({ jobId: score.jobId, score: score.score, sourceDigest: sources.preparation.sourceDigest, evidenceRefs: refs })
    }
    await client.query("COMMIT")
    return { invocation: { source: "automation", runMode: "scheduled", templateId: "prepare", role: "prepare",
      taskType: "scheduled_application_prepare", owner: liveBinding.owner, taskFence: persisted.taskFence,
      snapshot: automation, receipt, checkpointJobs }, details }
  } catch (error: unknown) { await client.query("ROLLBACK").catch(() => undefined); throw error }
  finally { client.release() }
}

export function scheduledPrepareAnalyzeSnapshot(snapshot: TaskGraphSnapshot): TaskGraphSnapshot {
  return { schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, 2),
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) }
}

async function readPersistedOwner(client: Queryable, lease: SubagentLease, owner: ExecutionOwnerFence) {
  const sql = "SELECT task.\"role\",task.\"taskType\",task.\"status\" AS \"taskStatus\",task.\"leaseOwner\" AS \"taskLeaseOwner\",task.\"leaseExpiresAt\" AS \"taskLeaseExpiresAt\",task.\"attemptCount\" AS \"taskAttemptCount\",task.\"interruptRequestedAt\",task.\"context\",turn.\"id\" AS \"turnId\",turn.\"source\",turn.\"executionMode\",turn.\"input\",turn.\"status\" AS \"turnStatus\",turn.\"leaseOwnerId\",turn.\"leaseVersion\",turn.\"leaseExpiresAt\",turn.\"rootTaskId\" AS \"turnRootTaskId\",root.\"status\" AS \"rootStatus\",root.\"attemptCount\" AS \"rootAttemptCount\",root.\"leaseOwner\" AS \"rootLeaseOwner\",session.\"userId\" AS \"userId\" FROM \"sub_agent_tasks\" task JOIN \"agent_turns\" turn ON turn.\"id\"=task.\"turnId\" AND turn.\"sessionId\"=task.\"sessionId\" JOIN \"sub_agent_tasks\" root ON root.\"id\"=task.\"rootTaskId\" AND root.\"sessionId\"=task.\"sessionId\" JOIN \"agent_sessions\" session ON session.\"id\"=task.\"sessionId\" WHERE task.\"id\"=$1 AND task.\"sessionId\"=$2 AND task.\"turnId\"=$3 AND task.\"rootTaskId\"=$4 AND task.\"parentTaskId\"=$4 AND turn.\"userId\"=$5 AND session.\"userId\"=$5 AND task.\"status\"=$6 AND root.\"status\"=$6"
  const result = await client.query<Row>(sql, [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId, "running"])
  const row = record(result.rows[0]), now = Date.now()
  if (result.rows.length !== 1 || !row || row.userId !== lease.userId || row.role !== "prepare" || row.taskType !== "scheduled_application_prepare"
    || row.taskStatus !== "running" || row.taskLeaseOwner !== lease.ownerId || lease.leaseOwner !== lease.ownerId
    || Number(row.taskAttemptCount) !== lease.attemptCount || row.interruptRequestedAt !== null || !future(row.taskLeaseExpiresAt, now)
    || row.turnId !== lease.turnId || row.turnRootTaskId !== lease.rootTaskId || row.turnStatus !== "in_progress"
    || typeof row.leaseOwnerId !== "string" || !Number.isSafeInteger(Number(row.leaseVersion)) || Number(row.leaseVersion) < 1
        || !future(row.leaseExpiresAt, now) || Number(row.rootAttemptCount) < 1 || row.rootLeaseOwner !== row.leaseOwnerId
    || !scheduledSnapshotMatches({ source: row.source, executionMode: row.executionMode, input: row.input }, snapshotDigest(row.input))) {
    throw new Error("scheduled_prepare_owner_stale")
  }
  const turnOwner: ScheduledPrepareOwner = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!,
    rootTaskId: lease.rootTaskId, rootAttemptCount: Number(row.rootAttemptCount), turnLeaseOwnerId: row.leaseOwnerId as string,
    turnLeaseVersion: Number(row.leaseVersion), executionId: "", executionAttemptCount: 0 }
  const taskFence: AgentArtifactTaskFence = { taskId: lease.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!,
    rootTaskId: lease.rootTaskId, parentTaskId: lease.parentTaskId, leaseOwner: lease.ownerId, attemptCount: lease.attemptCount }
  const executionScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId,
    parentTaskId: lease.rootTaskId, stepId: "scheduled-prepare", turnLeaseOwner: turnOwner.turnLeaseOwnerId,
    turnLeaseVersion: turnOwner.turnLeaseVersion, parentLeaseOwner: turnOwner.turnLeaseOwnerId, parentAttemptCount: turnOwner.rootAttemptCount }
  if (owner.userId !== lease.userId || owner.sessionId !== lease.sessionId || owner.turnId !== lease.turnId
    || owner.rootTaskId !== lease.rootTaskId || owner.taskId !== lease.id || owner.ownerId !== lease.ownerId || owner.attemptCount !== lease.attemptCount) {
    throw new Error("scheduled_prepare_owner_stale")
  }
  return { owner: turnOwner, taskFence, executionScope,
    turn: { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId,
      source: row.source, executionMode: row.executionMode, input: row.input, status: row.turnStatus,
      leaseOwnerId: row.leaseOwnerId, leaseVersion: Number(row.leaseVersion), leaseExpiresAt: row.leaseExpiresAt as Date | string },
    root: { id: lease.rootTaskId, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!,
      status: row.rootStatus as string, attemptCount: Number(row.rootAttemptCount) } }
}

async function readPrivateReceipt(client: Queryable, scope: GraphIdentityScope, owner: ScheduledPrepareOwner) {
  const sql = "SELECT event.\"type\",event.\"itemId\",event.\"taskId\",event.\"actor\",event.\"payload\",event.\"idempotencyKey\",EXISTS(SELECT 1 FROM \"agent_outbox\" outbox WHERE outbox.\"idempotencyKey\"='agent-event:'||event.\"id\" OR outbox.\"payload\"->>'eventId'=event.\"id\") AS \"hasOutbox\" FROM \"agent_events\" event JOIN \"agent_sessions\" session ON session.\"id\"=event.\"sessionId\" JOIN \"agent_turns\" turn ON turn.\"id\"=event.\"turnId\" AND turn.\"sessionId\"=event.\"sessionId\" WHERE event.\"sessionId\"=$1 AND event.\"turnId\"=$2 AND session.\"userId\"=$3 AND turn.\"userId\"=$3 AND event.\"type\"=$4"
  const rows = await client.query<Row>(sql, [scope.sessionId, scope.turnId, scope.userId, SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT])
  if (rows.rows.length !== 1) return null
  const row = record(rows.rows[0]), receipt = parseScheduledTaskGraphContinuationReceipt(row?.payload)
  if (!row || row.itemId !== null || row.taskId !== null || row.actor !== "system" || row.hasOutbox !== false
    || typeof row.idempotencyKey !== "string" || !row.idempotencyKey.startsWith("scheduled-prepare:") || !receipt) return null
  const a = receipt.owner
  return sameTurnLineage(a, owner)
    ? receipt : null
}

export function scheduledPrepareLiveCheckpointBinding(
  receipt: NonNullable<ReturnType<typeof parseScheduledTaskGraphContinuationReceipt>>,
  currentOwner: ScheduledPrepareOwner,
  attestation: ScheduledAutomationPipelineAttestation,
): ScheduledTaskGraphContinuationBinding | null {
  const stableKey = scheduledTaskGraphStableContinuationKey(receipt)
  if (receipt.continuationKey !== stableKey || !sameTurnLineage(receipt.owner, currentOwner)
    || !sameTurnLineage(receipt.owner, attestation.owner) || receipt.snapshotDigest !== attestation.snapshotDigest
    || receipt.evidenceDigest !== attestation.evidenceDigest || receipt.analyzeGraphRevision !== attestation.graphRevision) return null
  const continuationKey = scheduledTaskGraphContinuationKey(currentOwner, attestation, receipt.owner.executionId, receipt.owner.executionAttemptCount)
  return { ...receipt, continuationKey, owner: { ...receipt.owner, turnLeaseOwnerId: currentOwner.turnLeaseOwnerId, turnLeaseVersion: currentOwner.turnLeaseVersion } }
}

async function readExecutionCheckpoint(client: Queryable, receipt: NonNullable<ReturnType<typeof parseScheduledTaskGraphContinuationReceipt>>, turn: Row,
  currentOwner: ScheduledPrepareOwner, handoffKey: string, now: Date) {
  const rows = await client.query<Row>("SELECT \"status\",\"attemptCount\",\"checkpoint\",\"state\" FROM \"agent_executions\" WHERE \"id\"=$1 AND \"userId\"=$2 AND \"sessionId\"=$3",
    [receipt.owner.executionId, receipt.owner.userId, receipt.owner.sessionId])
  const execution = record(rows.rows[0]), state = record(execution?.state), marker = record(state?.scheduledTaskGraphContinuation), claim = record(state?.scheduledTaskGraphClaim)
  const liveBinding: ScheduledTaskGraphContinuationBinding = { ...receipt, continuationKey: handoffKey,
    owner: { ...receipt.owner, turnLeaseOwnerId: currentOwner.turnLeaseOwnerId, turnLeaseVersion: currentOwner.turnLeaseVersion } }
  if (rows.rows.length !== 1 || !execution || execution.status !== "running" || Number(execution.attemptCount) !== receipt.owner.executionAttemptCount
    || execution.checkpoint !== "prepare" || state?.nextStage !== "prepare" || marker?.key !== handoffKey || !same(marker.owner, liveBinding.owner)
    || marker.snapshotDigest !== receipt.snapshotDigest || marker.graphRevision !== receipt.analyzeGraphRevision || marker.evidenceDigest !== receipt.evidenceDigest
    || !scheduledSnapshotMatches(turn, receipt.snapshotDigest) || !claim || typeof claim.claimToken !== "string" || !claim.claimToken) {
    throw new Error("scheduled_prepare_checkpoint_invalid")
  }
  const claimTokenDigest = "sha256:" + createHash("sha256").update(claim.claimToken, "utf8").digest("hex")
  if (!scheduledTaskGraphClaimMatches(state, liveBinding, claimTokenDigest, now)) throw new Error("scheduled_prepare_claim_invalid")
  const digest = analyzeCheckpointDigest(state, receipt, handoffKey)
  if (!digest || digest !== receipt.checkpointDigest) throw new Error("scheduled_prepare_checkpoint_invalid")
  return { state, claimTokenDigest }
}

function analyzeCheckpointDigest(state: Row, receipt: NonNullable<ReturnType<typeof parseScheduledTaskGraphContinuationReceipt>>, handoffKey: string): string | null {
  const marker = record(state.scheduledTaskGraphContinuation), markerOwner = record(marker?.owner), scouted = state.scoutedJobs, scored = state.scoredJobs, owner = receipt.owner
  if (state.nextStage !== "prepare" || !marker || !Array.isArray(scouted) || !Array.isArray(scored) || !Number.isSafeInteger(state.analysisFailed)
    || Number(state.analysisFailed) < 0 || marker.key !== handoffKey || marker.snapshotDigest !== receipt.snapshotDigest
    || marker.graphRevision !== receipt.analyzeGraphRevision || marker.evidenceDigest !== receipt.evidenceDigest || !markerOwner || !sameOwnerLineage(markerOwner, owner)) return null
  const ids = new Set<string>()
  for (const value of scouted) { const job = record(value); if (!job || !validId(job.id) || job.userId !== owner.userId || ids.has(job.id)) return null; ids.add(job.id) }
  if (Number(state.analysisFailed) + scored.length !== ids.size) return null
  const rows: Row[] = [], seen = new Set<string>()
  for (const value of scored) {
    const row = record(value), job = record(row?.job)
    if (!row || !job || !validId(job.id) || job.userId !== owner.userId || !ids.has(job.id) || seen.has(job.id)
      || !Number.isSafeInteger(row.score) || Number(row.score) < 0 || Number(row.score) > 100 || !stringArray(row.matchedKeywords)
      || !stringArray(row.missingKeywords) || typeof row.recommendation !== "string" || row.recommendation.length > 8192) return null
    const required = ["job", "score", "matchedKeywords", "missingKeywords", "recommendation"], allowed = [...required, "analysisFenceAt"]
    if (Object.keys(row).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(row, key))
      || Object.hasOwn(row, "analysisFenceAt") && (typeof row.analysisFenceAt !== "string" || !Number.isFinite(Date.parse(row.analysisFenceAt)))) return null
    seen.add(job.id); rows.push({ jobId: job.id, score: row.score, matchedKeywords: [...row.matchedKeywords], missingKeywords: [...row.missingKeywords],
      recommendation: row.recommendation, ...(Object.hasOwn(row, "analysisFenceAt") ? { analysisFenceAt: row.analysisFenceAt } : {}) })
  }
  const projection = { owner: [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId, owner.executionAttemptCount],
    snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest, analyzeGraphRevision: receipt.analyzeGraphRevision,
    analysisFailed: state.analysisFailed, scoredJobs: rows }
  return createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")
}

function sameOwnerLineage(left: Row | ScheduledPrepareOwner, right: Row | ScheduledPrepareOwner): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function sameTurnLineage(left: ScheduledPrepareOwner | ScheduledAutomationPipelineAttestation["owner"], right: ScheduledPrepareOwner | ScheduledAutomationPipelineAttestation["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
}

function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }

function prepareTaskMatches(task: GraphTaskRow, node: TaskGraphSnapshot["nodes"][number], lease: SubagentLease): boolean {
  const template = TASK_GRAPH_TEMPLATES.prepare
  return node.templateId === "prepare" && task.id === node.taskId && task.status === "running" && task.attemptCount === lease.attemptCount
    && task.role === template.role && task.taskType === template.taskType && same(task.expectedOutputSchema, template.expectedOutputSchema)
    && same(task.allowedActions, template.allowedActions)
}
function persistedTask(task: GraphTaskRow, lease: SubagentLease): ScheduledAutomationPersistedTask {
  return { id: task.id, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId,
    parentTaskId: lease.rootTaskId, role: task.role, taskType: task.taskType ?? "", status: task.status,
    attemptCount: task.attemptCount ?? 0, failureReason: task.failureReason, expectedOutputSchema: task.expectedOutputSchema,
    allowedActions: task.allowedActions, result: task.result }
}
function future(value: unknown, now: number): boolean {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp) && timestamp > now
}
function snapshotDigest(value: unknown): string {
  const snapshot = parseScheduledAutomationSnapshot(record(record(value)?.scheduledAutomationSnapshot))
  if (!snapshot) return ""
  const projection = [snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations, snapshot.minScore,
    snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]
  return `sha256:${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)
}
function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === "string" && item.length <= 256)
}
