import { createHash } from "node:crypto"
import type pg from "pg"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"
import type { ToolExecutionContext } from "../tools/types.js"
import { loadSelectedJobArtifactContext } from "./selected-job-artifact-context.js"
import { revalidateScheduledPipelineGraphAttestation } from "./scheduled-pipeline-current-attestation.js"
import { projectScheduledPipelineGraph } from "./scheduled-pipeline-graph-shape.js"
import { scheduledPrepareCheckpointDigest, scheduledPrepareCohortJobIds, scheduledPrepareLiveCheckpointBinding } from "./scheduled-prepare-runtime-context.js"
import { scheduledAnalyzeGraphMatches, scheduledSnapshotMatches, scheduledTaskGraphClaimMatches, scheduledTaskGraphStableContinuationKey,
  scheduledTaskGraphContinuationKeyVersion, SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT,
  parseScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import type { ScheduledTaskGraphContinuationBinding } from "./scheduled-taskgraph-continuation-receipt.js"
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
import { readScheduledPrepareOwnerAdmission, scheduledPrepareDependencyWaitMatchesGraph,
  scheduledPrepareTurnOwnerFromAdmission } from "./scheduled-prepare-owner-admission.js"
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
    const persisted = await readScheduledPrepareOwnerAdmission(client, lease, owner, options.now?.() ?? new Date())
    const scope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId }
    const loaded = await loadTaskGraph(client, scope, false), snapshot = loaded.snapshot
    if (!snapshot || !loaded.state) throw new Error("scheduled_prepare_graph_invalid")
    const current = currentTaskGraph(loaded)
    if (current.nodes.length !== snapshot.nodes.length) throw new Error("scheduled_prepare_graph_invalid")
    const receipt = await readPrivateReceipt(client, scope)
    const version = receipt && scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
    if (!receipt || !version || scheduledTaskGraphStableContinuationKey(receipt) !== receipt.continuationKey) throw new Error("scheduled_prepare_receipt_invalid")
    const shape = projectScheduledPipelineGraph(snapshot.nodes, version, "prepare")
    if (!shape || shape.prepare.taskId !== lease.id) throw new Error("scheduled_prepare_graph_invalid")
    const taskRow = loaded.tasks.get(lease.id), node = shape.prepare
    if (!taskRow || !prepareTaskMatches(taskRow, node, lease) || current.nodes.find(value => value.key === "prepare")?.status !== "running") throw new Error("scheduled_prepare_task_invalid")
    if (!scheduledPrepareDependencyWaitMatchesGraph(persisted, snapshot, current.nodes, lease.id)) throw new Error("scheduled_prepare_owner_stale")
    const prepareOwner = scheduledPrepareTurnOwnerFromAdmission(persisted, receipt.owner)
    const automation = parseScheduledAutomationSnapshot(record(persisted.turn.input)?.scheduledAutomationSnapshot)
    if (!automation) throw new Error("scheduled_prepare_snapshot_invalid")
    const bridged = await revalidateScheduledPipelineGraphAttestation({ scope: prepareOwner, schedule: automation,
      snapshot, current, tasks: loaded.tasks, receipt,
      verifyCompletedNode: input => verifyCompletedTaskGraphNodeEvidence(client, input) })
    if (bridged.status !== "ready" || bridged.attestation.evidenceDigest !== receipt.evidenceDigest
      || bridged.attestation.snapshotDigest !== receipt.snapshotDigest) throw new Error("scheduled_prepare_analyze_unverified")
    const liveBinding = scheduledPrepareLiveCheckpointBinding(receipt, prepareOwner, bridged.attestation)
    if (!liveBinding) throw new Error("scheduled_prepare_receipt_invalid")
    const handoffKey = liveBinding.continuationKey
    const prepareCohort = scheduledPrepareCohortJobIds(bridged.attestation)
    const checkpoint = await readExecutionCheckpoint(client, receipt, persisted.turn, prepareOwner, handoffKey,
      [...prepareCohort], options.now?.() ?? new Date())
    const proposal = { expectedRevision: receipt.analyzeGraphRevision, nodes: [{ key: node.key, templateId: node.templateId,
      goal: node.goal, successCriteria: node.successCriteria, dependsOn: node.dependsOn }] }
    const handoff = { status: "analyze_checkpointed" as const, continuationKey: handoffKey,
      checkpointDigest: receipt.checkpointDigest, claimTokenDigest: checkpoint.claimTokenDigest,
      executionId: receipt.owner.executionId, executionAttemptCount: receipt.owner.executionAttemptCount }
    const executionScope = { userId: prepareOwner.userId, sessionId: prepareOwner.sessionId, turnId: prepareOwner.turnId,
      rootTaskId: prepareOwner.rootTaskId, parentTaskId: prepareOwner.rootTaskId, stepId: "scheduled-prepare",
      turnLeaseOwner: prepareOwner.turnLeaseOwnerId, turnLeaseVersion: prepareOwner.turnLeaseVersion,
      parentLeaseOwner: prepareOwner.turnLeaseOwnerId, parentAttemptCount: prepareOwner.rootAttemptCount }
    const graphInput = { scope: executionScope, executionOwner: { executionId: receipt.owner.executionId, executionAttemptCount: receipt.owner.executionAttemptCount },
      handoff, attestation: bridged.attestation, proposal }
    if (!scheduledAnalyzeGraphMatches(graphInput, snapshot, current, loaded.tasks, true)) throw new Error("scheduled_prepare_graph_binding_invalid")
    const analystEnvelope = record(loaded.tasks.get(shape.analyst.taskId)?.result)
    if (!analystEnvelope) throw new Error("scheduled_prepare_checkpoint_invalid")
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

async function readPrivateReceipt(client: Queryable, scope: GraphIdentityScope) {
  const sql = "SELECT event.\"type\",event.\"itemId\",event.\"taskId\",event.\"actor\",event.\"payload\",event.\"idempotencyKey\",EXISTS(SELECT 1 FROM \"agent_outbox\" outbox WHERE outbox.\"idempotencyKey\"='agent-event:'||event.\"id\" OR outbox.\"payload\"->>'eventId'=event.\"id\") AS \"hasOutbox\" FROM \"agent_events\" event JOIN \"agent_sessions\" session ON session.\"id\"=event.\"sessionId\" JOIN \"agent_turns\" turn ON turn.\"id\"=event.\"turnId\" AND turn.\"sessionId\"=event.\"sessionId\" WHERE event.\"sessionId\"=$1 AND event.\"turnId\"=$2 AND session.\"userId\"=$3 AND turn.\"userId\"=$3 AND event.\"type\"=$4"
  const rows = await client.query<Row>(sql, [scope.sessionId, scope.turnId, scope.userId, SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT])
  if (rows.rows.length !== 1) return null
  const row = record(rows.rows[0]), receipt = parseScheduledTaskGraphContinuationReceipt(row?.payload)
  if (!row || row.itemId !== null || row.taskId !== null || row.actor !== "system" || row.hasOutbox !== false
    || typeof row.idempotencyKey !== "string" || !row.idempotencyKey.startsWith("scheduled-prepare:") || !receipt) return null
  return receipt
}

export { scheduledPrepareAnalyzeSnapshot, scheduledPrepareLiveCheckpointBinding } from "./scheduled-prepare-runtime-context.js"

async function readExecutionCheckpoint(client: Queryable, receipt: NonNullable<ReturnType<typeof parseScheduledTaskGraphContinuationReceipt>>, turn: Row,
  currentOwner: ScheduledPrepareOwner, handoffKey: string, expectedJobIds: readonly string[], now: Date) {
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
    const digest = scheduledPrepareCheckpointDigest(state, receipt, handoffKey, expectedJobIds)
  if (!digest || digest !== receipt.checkpointDigest) throw new Error("scheduled_prepare_checkpoint_invalid")
  return { state, claimTokenDigest }
}

function record(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }

function prepareTaskMatches(task: GraphTaskRow, node: TaskGraphSnapshot["nodes"][number], lease: SubagentLease): boolean {
  const template = TASK_GRAPH_TEMPLATES.prepare
  return node.templateId === "prepare" && task.id === node.taskId && task.status === "running" && task.attemptCount === lease.attemptCount
    && task.role === template.role && task.taskType === template.taskType && same(task.expectedOutputSchema, template.expectedOutputSchema)
    && same(task.allowedActions, template.allowedActions)
}
function same(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
