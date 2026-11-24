import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import { parseObjectiveTailorCandidateWitness } from "./objective-tailor-witness.js"
import { loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { loadObjectiveTailorChildSource } from "./objective-tailor-writer-source.js"
import { loadSelectedJobArtifactContextForChild, type SelectedJobArtifactContextForChild } from "./scheduled-draft-writer-source.js"
import { TaskGraphWriterReviewFeedbackError } from "./task-graph-writer-review-frame.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"

const PRIVATE_FIELDS = new Set([
  "scheduledDraftCandidateWitness", "scheduledDraftCandidateMode",
  "objectiveTailorCandidateMode", "objectiveTailorCandidateWitness",
])

export type ChildTaskContextProjection = Readonly<{
  context: RepositoryJsonValue
  selectedJobId?: string
  scheduledDraft: boolean
}>

export function normalizeChildJson(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(normalizeChildJson)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([, child]) => child !== undefined).map(([key, child]) => [key, normalizeChildJson(child)]))
  return null
}

export function projectChildModelContext(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(projectChildModelContext)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key, child]) => !PRIVATE_FIELDS.has(key) && child !== undefined)
      .map(([key, child]) => [key, projectChildModelContext(child)]))
  }
  return null
}

export function projectChildTaskContext(task: SubagentTaskRecord): ChildTaskContextProjection {
  const source = plainRecord(task.context)
  const scheduledJobId = scheduledDraftJobId(source)
  const hasObjectiveMode = source !== undefined && Object.hasOwn(source, "objectiveTailorCandidateMode")
  const hasObjectiveWitness = source !== undefined && Object.hasOwn(source, "objectiveTailorCandidateWitness")
  let selectedJobId = scheduledJobId
  if (hasObjectiveMode || hasObjectiveWitness) {
    const selection = source && plainRecord(source.selectedJobPreparation)
    const witness = parseObjectiveTailorCandidateWitness(source?.objectiveTailorCandidateWitness)
    if (scheduledJobId || !source || source.objectiveTailorCandidateMode !== true || !hasObjectiveWitness
      || (task.role !== "writer" && task.role !== "reviewer")
      || task.taskType !== (task.role === "writer" ? "cover_letter_draft" : "cover_letter_review")
      || !selection || Object.keys(selection).join(",") !== "jobId"
      || typeof selection.jobId !== "string" || !selection.jobId.trim() || selection.jobId.length > 256
      || witness?.candidate.jobId !== selection.jobId) throw new Error("objective_tailor_child_context_invalid")
    selectedJobId = selection.jobId
  }
  const scheduledDraft = scheduledJobId !== undefined && (task.role === "writer" || task.role === "reviewer")
  return {
    context: childTaskContextJson(task, selectedJobId, scheduledDraft),
    ...(selectedJobId ? { selectedJobId } : {}),
    scheduledDraft,
  }
}

export async function loadChildSelectedJobSource(
  pool: pg.Pool, lease: SubagentLease, selectedJobId: string | undefined,
): Promise<SelectedJobArtifactContextForChild | undefined> {
  if (hasObjectiveTailorPrivateFields(lease.context)) {
    let projection: ChildTaskContextProjection
    try { projection = projectChildTaskContext(lease) } catch { throw objectiveSourceUnavailable() }
    if (!selectedJobId || projection.selectedJobId !== selectedJobId) throw objectiveSourceUnavailable()
    try {
      const source = await loadObjectiveTailorSource(pool, lease)
      if (!source) throw objectiveSourceUnavailable()
      return source
    } catch { throw objectiveSourceUnavailable() }
  }
  if (!selectedJobId) return undefined
  return loadSelectedJobArtifactContextForChild(pool, lease.userId, selectedJobId,
    lease.role === "writer" ? lease.context : undefined)
}

async function loadObjectiveTailorSource(pool: pg.Pool, lease: SubagentLease): Promise<SelectedJobArtifactContextForChild | undefined> {
  if (!lease.turnId) return undefined
  const client = await pool.connect()
  let transactionStarted = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    transactionStarted = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const scope: GraphIdentityScope = {
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
      rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId,
    }
    const loaded = await loadTaskGraph(client, scope, false)
    const source = await loadObjectiveTailorChildSource(client, scope, loaded, lease)
    await client.query(source ? "COMMIT" : "ROLLBACK")
    transactionStarted = false
    return source
  } catch {
    if (transactionStarted) {
      try { await client.query("ROLLBACK") } catch { /* Preserve the fail-closed source result. */ }
    }
    return undefined
  } finally {
    client.release()
  }
}

function scheduledDraftJobId(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) return undefined
  if (source.scheduledDraftCandidateMode !== true) {
    if (Object.hasOwn(source, "scheduledDraftCandidateWitness")) throw new Error("scheduled_draft_child_context_invalid")
    return undefined
  }
  const selection = plainRecord(source.selectedJobPreparation)
  const witness = source.scheduledDraftCandidateWitness
  if (typeof selection?.jobId !== "string" || !selection.jobId || !witness || typeof witness !== "object" || Array.isArray(witness)) {
    throw new Error("scheduled_draft_child_context_invalid")
  }
  return selection.jobId
}

export function hasObjectiveTailorPrivateFields(value: unknown): boolean {
  const source = plainRecord(value)
  return source !== undefined && (Object.hasOwn(source, "objectiveTailorCandidateMode")
    || Object.hasOwn(source, "objectiveTailorCandidateWitness"))
}

function objectiveSourceUnavailable(): TaskGraphWriterReviewFeedbackError {
  return new TaskGraphWriterReviewFeedbackError("writer_review_receipt_unavailable")
}

function childTaskContextJson(task: SubagentTaskRecord, selectedJobId: string | undefined, scheduledDraft: boolean): RepositoryJsonValue {
  const context = projectChildModelContext(task.context)
  if (!selectedJobId || (task.role !== "writer" && task.role !== "reviewer")) return context
  const errorCode = scheduledDraft ? "scheduled_draft_child_context_invalid" : "objective_tailor_child_context_invalid"
  if (!isJsonRecord(context)) throw new Error(errorCode)
  const dependencies = context.taskGraphDependencyResults
  if (!isJsonRecord(dependencies) || dependencies.schemaVersion !== "agent-harness.v2.task-graph.dependency-evidence" || !Array.isArray(dependencies.items)) {
    throw new Error(errorCode)
  }
  const items = dependencies.items.flatMap(item => {
    if (!isJsonRecord(item)) return []
    const result = isJsonRecord(item.result) ? item.result : undefined
    if (item.role === "scout" || result?.role === "scout") {
      if (item.role !== "scout" || result?.role !== "scout" || !Array.isArray(result.candidates)) return []
      const candidates = result.candidates.filter(candidate => isJsonRecord(candidate) && candidate.jobId === selectedJobId)
      return candidates.length ? [{ ...item, result: { ...result, candidates, candidateCount: candidates.length } }] : []
    }
    if (item.role === "analyst" || result?.role === "analyst") {
      if (item.role !== "analyst" || result?.role !== "analyst" || !Array.isArray(result.findings)) return []
      const findings = result.findings.filter(finding => isJsonRecord(finding) && finding.jobId === selectedJobId)
      return findings.length ? [{ ...item, result: { ...result, findings, findingCount: findings.length } }] : []
    }
    return [item]
  })
  return { ...context, taskGraphDependencyResults: { ...dependencies, items } }
}

function isJsonRecord(value: RepositoryJsonValue | undefined): value is { [key: string]: RepositoryJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
        && "value" in Object.getOwnPropertyDescriptor(value, key)!) ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}
