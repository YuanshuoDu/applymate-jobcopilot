import type pg from "pg"
import { parseSelectedJobBatchGraph, SELECTED_JOB_BATCH_TEMPLATE_CATALOG, type SelectedJobBatchGraphSlot } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TaskGraphWriterReviewFeedbackError } from "./task-graph-writer-review-frame.js"
import { hasPersistedTaskGraphMembership, loadTaskGraph, type LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import { parseArtifactReference, type ArtifactVersionReference } from "./role-results.js"
import { readObjectiveTailorCorrectionChildBinding } from "./objective-tailor-correction-child-source.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

export {
  createTaskGraphWriterReviewFeedbackFrame, TASK_GRAPH_WRITER_REVIEW_FEEDBACK_BYTE_LIMIT, TaskGraphWriterReviewFeedbackError,
} from "./task-graph-writer-review-frame.js"
export type { TaskGraphWriterReviewFeedbackFrame } from "./task-graph-writer-review-frame.js"

const DEPENDENCY_CONTEXT_KEY = "taskGraphDependencyResults"
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SAFE_DIGEST = /^sha256:[a-f0-9]{64}$/

export type TaskGraphWriterReviewDependency = Readonly<{
  dependencyKey: string
  dependencyTaskId: string
  artifactRef: ArtifactVersionReference
  reviewHash: string
}>

/** Bind optional context evidence to persisted Reviewer edges and reject omitted edges. */
export async function assertPersistedWriterReviewDependency(
  pool: pg.Pool, task: SubagentTaskRecord, lease: SubagentLease, dependency: TaskGraphWriterReviewDependency | null,
): Promise<void> {
  const turnId = typeof lease.turnId === "string" ? lease.turnId : ""
  const parentTaskId = typeof lease.parentTaskId === "string" ? lease.parentTaskId : ""
  if (task.id !== lease.id || task.userId !== lease.userId || task.sessionId !== lease.sessionId || task.turnId !== lease.turnId
    || task.rootTaskId !== lease.rootTaskId || task.parentTaskId !== lease.parentTaskId || task.role !== "writer" || lease.role !== "writer"
    || !turnId.trim() || !parentTaskId.trim()) {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
  }
  const client = await pool.connect()
  let transactionStarted = false
  let committed = false
  let releaseError: Error | undefined
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    transactionStarted = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const scope = {
      userId: lease.userId, sessionId: lease.sessionId, turnId,
      rootTaskId: lease.rootTaskId, parentTaskId,
    }
    const graph = await loadTaskGraph(client, scope, false)
    const context = plainRecord(lease.context), hasTaskGraphDependencyContext = context !== null && Object.hasOwn(context, DEPENDENCY_CONTEXT_KEY), hasCorrection = context !== null && Object.hasOwn(context, "objectiveTailorCorrectionProof")
    if (!graph.snapshot) {
      if (hasTaskGraphDependencyContext || await hasPersistedTaskGraphMembership(client, scope, lease.id)
        || dependency || task.status !== "running" || lease.status !== "running") {
        throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
      }
      await client.query("COMMIT"); committed = true; return
    }
    const writerNode = graph.snapshot?.nodes.find(node => node.taskId === lease.id)
    const writer = graph.tasks.get(lease.id)
    const registeredWriter = writerNode?.templateId === "cover_letter_writer"
    const selectedBatchWriter = SELECTED_JOB_BATCH_TEMPLATE_CATALOG.some(entry => entry.writerTemplateId === writerNode?.templateId)
    const nativeWriter = writerNode?.templateId === TASK_GRAPH_NATIVE_TEMPLATE_ID
      && writerNode.nativeDelegation?.callerTaskId === lease.parentTaskId
      && writerNode.nativeDelegation.role === "writer"
      && writerNode.nativeDelegation.taskType === task.taskType
    if (graph.rootTaskId !== lease.rootTaskId || !writerNode || (!registeredWriter && !selectedBatchWriter && !nativeWriter)
      || !writer || writer.role !== "writer") {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    }
    if (hasCorrection && !await readObjectiveTailorCorrectionChildBinding({ client, scope, loaded: graph,
      taskId: lease.id, role: "writer", context: lease.context, dependency })) throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    const batchSlot = selectedBatchWriter ? selectedBatchWriterSlot(graph, writerNode, task, lease) : null
    if (selectedBatchWriter && !batchSlot) throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    if (selectedBatchWriter && !dependency && (hasTaskGraphDependencyContext || batchSlot?.correction
      || writerNode.dependsOn.length || batchSlot?.initial.writer.taskId !== lease.id)) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    }
    if (selectedBatchWriter && dependency && (!batchSlot?.correction
      || batchSlot.correction.writer.taskId !== lease.id || batchSlot.initial.reviewer.key !== dependency.dependencyKey
      || batchSlot.initial.reviewer.taskId !== dependency.dependencyTaskId || !batchReviewerOnly(lease.context))) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    }
    const directReviewers = selectedBatchWriter && batchSlot ? [batchSlot.initial.reviewer]
      : graph.snapshot!.nodes.filter(node => node.templateId === "cover_letter_reviewer" && writerNode.dependsOn.includes(node.key))
    if (!selectedBatchWriter && (directReviewers.length > 1 || (dependency
      ? directReviewers.length !== 1 || directReviewers[0]?.taskId !== dependency.dependencyTaskId
      : directReviewers.length !== 0))) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    }
    if (!dependency) {
      if (writer.status !== "running" || task.status !== "running" || lease.status !== "running") {
        throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
      }
      await client.query("COMMIT")
      committed = true
      return
    }
    const reviewerNode = directReviewers[0]!
    const reviewer = graph.tasks.get(reviewerNode.taskId)
    if (!reviewer || reviewer.role !== "reviewer") throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    const dependentWriters = graph.snapshot!.nodes.filter(node => node.dependsOn.includes(reviewerNode.key)
      && graph.tasks.get(node.taskId)?.role === "writer")
    if (dependentWriters.length !== 1 || dependentWriters[0]?.taskId !== lease.id) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
    }
    if (writer.status !== "running" || reviewer.status !== "completed" || reviewer.failureReason !== null) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
    }
    if (lease.status !== "running" || task.status !== "running" || task.leaseOwner !== lease.ownerId || task.attemptCount !== lease.attemptCount
      || lease.leaseOwner !== lease.ownerId || !lease.turnId?.trim() || !lease.parentTaskId?.trim() || !lease.ownerId.trim()
      || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1 || lease.interruptRequestedAt !== null
      || !(lease.leaseExpiresAt instanceof Date) || lease.leaseExpiresAt.getTime() <= Date.now()) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
    }
    const current = await client.query(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        session."userId" AS "userId", task."status", task."role", task."leaseOwner", task."attemptCount", task."interruptRequestedAt", task."context", task."taskType"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $5 AND session."userId" = $6 AND task."role" = 'writer' AND task."status" = 'running'
        AND task."leaseOwner" = $7 AND task."attemptCount" = $8 AND task."interruptRequestedAt" IS NULL
        AND task."leaseExpiresAt" > clock_timestamp()`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.parentTaskId, lease.userId, lease.ownerId, lease.attemptCount])
    const row = safeRecord(current.rows[0])
    if (current.rows.length !== 1 || row.id !== lease.id || row.userId !== lease.userId || row.sessionId !== lease.sessionId
      || row.turnId !== lease.turnId || row.rootTaskId !== lease.rootTaskId || row.parentTaskId !== lease.parentTaskId
      || row.status !== "running" || row.role !== "writer" || row.leaseOwner !== lease.ownerId
      || row.attemptCount !== lease.attemptCount || row.interruptRequestedAt !== null) {
      throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
    }
    if (hasCorrection && canonicalTaskGraphJson(row.context) !== canonicalTaskGraphJson(lease.context)) throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
    if (selectedBatchWriter) {
      const jobId = selectedJobFromContext(row.context)
      if (row.taskType !== "cover_letter_draft" || !jobId || jobId !== selectedJobFromContext(lease.context) || !batchReviewerOnly(row.context)
        || !sameDependency(writerReviewDependencyFromTaskContext(row.context, jobId), dependency)) {
        throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
      }
      const persisted = await client.query(`SELECT task."id", task."context", task."role", task."taskType", task."status", task."failureReason"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
        WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
          AND task."parentTaskId" = $5 AND session."userId" = $6 AND turn."userId" = $6`,
      [reviewerNode.taskId, lease.sessionId, lease.turnId, lease.rootTaskId, lease.parentTaskId, lease.userId])
      const reviewRow = safeRecord(persisted.rows[0])
      if (persisted.rows.length !== 1 || reviewRow.id !== reviewerNode.taskId || reviewRow.role !== "reviewer"
        || reviewRow.taskType !== "cover_letter_review" || reviewRow.status !== "completed" || reviewRow.failureReason !== null
        || selectedJobFromContext(reviewRow.context) !== jobId) {
        throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
      }
    }
    await client.query("COMMIT")
    committed = true
  } catch (error: unknown) {
    if (transactionStarted && !committed) {
      try {
        await client.query("ROLLBACK")
      } catch (rollbackError: unknown) {
        releaseError = rollbackError instanceof Error ? rollbackError : new Error("writer_review_rollback_failed")
      }
    }
    if (error instanceof TaskGraphWriterReviewFeedbackError) throw error
    throw new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
  } finally {
    client.release(releaseError)
  }
}
/** Resolve only one direct, completed Reviewer receipt from server-materialized task context. */
export function writerReviewDependencyFromTaskContext(value: unknown, expectedJobId: string): TaskGraphWriterReviewDependency | null {
  const context = plainRecord(value)
  if (!context) throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  const selected = plainRecord(context.selectedJobPreparation)
  if (!selected || Object.keys(selected).sort().join(",") !== "jobId" || selected.jobId !== expectedJobId) {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  }
  if (!Object.prototype.hasOwnProperty.call(context, DEPENDENCY_CONTEXT_KEY)) return null
  const dependencyContext = plainRecord(context[DEPENDENCY_CONTEXT_KEY])
  if (!dependencyContext || Object.keys(dependencyContext).sort().join(",") !== "items,schemaVersion"
    || dependencyContext.schemaVersion !== "agent-harness.v2.task-graph.dependency-evidence"
    || !Array.isArray(dependencyContext.items) || dependencyContext.items.length > 8) {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  }
  const reviewers = dependencyContext.items.filter(item => plainRecord(item)?.role === "reviewer")
  if (reviewers.length === 0) return null
  if (reviewers.length !== 1) throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  const item = plainRecord(reviewers[0])
  if (!item || Object.keys(item).sort().join(",") !== "dependencyKey,dependencyTaskId,result,role,taskStatus"
    || item.role !== "reviewer" || item.taskStatus !== "completed"
    || typeof item.dependencyKey !== "string" || !SAFE_ID.test(item.dependencyKey)
    || typeof item.dependencyTaskId !== "string" || !SAFE_ID.test(item.dependencyTaskId)) {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  }
  const result = plainRecord(item.result)
  if (!result || Object.keys(result).sort().join(",") !== "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust"
    || result.schemaVersion !== "agent-harness.v2.task-graph.result-projection" || result.trust !== "untrusted"
    || result.availability !== "available" || result.role !== "reviewer" || result.status !== "completed"
    || typeof result.reviewHash !== "string" || !SAFE_DIGEST.test(result.reviewHash)) {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  }
  if (result.reviewStatus !== "needs_revision") throw new TaskGraphWriterReviewFeedbackError("writer_review_status_invalid")
  try {
    return { dependencyKey: item.dependencyKey, dependencyTaskId: item.dependencyTaskId, artifactRef: parseArtifactReference(result.artifactRef), reviewHash: result.reviewHash }
  } catch {
    throw new TaskGraphWriterReviewFeedbackError("writer_review_dependency_invalid")
  }
}
type BatchNode = TaskGraphSnapshot["nodes"][number]
type BatchSlot = SelectedJobBatchGraphSlot<BatchNode>
function selectedBatchWriterSlot(
  graph: LoadedGraph, writerNode: BatchNode, task: SubagentTaskRecord, lease: SubagentLease,
): BatchSlot | null {
  const snapshot = graph.snapshot, jobId = selectedJobFromContext(lease.context)
  if (!snapshot || graph.discoveryTurnEligibility !== "ordinary" || !jobId || task.taskType !== "cover_letter_draft"
    || snapshot.nodes.some(node => node.verificationDisposition !== "specialized" || node.verification || node.repairOf
      || node.packageRefs || node.nativeDelegation || node.registeredScoutEnvelope)) return null
  const slotIds = SELECTED_JOB_BATCH_TEMPLATE_CATALOG.filter(entry => snapshot.nodes.some(node =>
    node.templateId === entry.writerTemplateId || node.templateId === entry.reviewerTemplateId)).map(entry => entry.slotId)
  if (slotIds.length * 2 + 2 > TASK_GRAPH_LIMITS.maxNodes) return null
  const slots = parseSelectedJobBatchGraph(snapshot.nodes, slotIds)
  const slot = slots?.find(candidate => candidate.effective.writer.taskId === lease.id)
  return slot && slot.effective.writer.key === writerNode.key && slot.effective.writer.templateId === writerNode.templateId ? slot : null
}
function selectedJobFromContext(value: unknown): string | null {
  const selected = plainRecord(plainRecord(value)?.selectedJobPreparation)
  return selected && Object.keys(selected).sort().join(",") === "jobId"
    && typeof selected.jobId === "string" && SAFE_JOB_ID.test(selected.jobId) ? selected.jobId : null
}
function batchReviewerOnly(value: unknown): boolean {
  const evidence = plainRecord(plainRecord(value)?.[DEPENDENCY_CONTEXT_KEY]), items = evidence?.items
  return Array.isArray(items) && items.length === 1 && plainRecord(items[0])?.role === "reviewer"
}
function sameDependency(left: TaskGraphWriterReviewDependency | null, right: TaskGraphWriterReviewDependency | null): boolean {
  return Boolean(left && right && left.dependencyKey === right.dependencyKey && left.dependencyTaskId === right.dependencyTaskId
    && left.reviewHash === right.reviewHash && left.artifactRef.artifactId === right.artifactRef.artifactId
    && left.artifactRef.version === right.artifactRef.version && left.artifactRef.contentHash === right.artifactRef.contentHash
    && left.artifactRef.sourceDigest === right.artifactRef.sourceDigest)
}
function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.getOwnPropertySymbols(value).length === 0 ? value as Record<string, unknown> : null
  } catch { return null }
}
function safeRecord(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {}
}
