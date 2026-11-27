import { createHash } from "node:crypto"
import {
  finalTaskGraphArtifactProofInput, isFinalTaskGraphArtifactVersionProof, parseFinalTaskGraphArtifactRef,
  SELECTED_JOB_BATCH_TEMPLATE_CATALOG, TASK_GRAPH_FINAL_ARTIFACT_MANIFEST_SCHEMA,
} from "@jobcopilot/agent-protocol"
import type { FinalTaskGraphArtifactRef } from "@jobcopilot/agent-protocol"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import { readBoundSelectedJobBatchFinalOutcome } from "./selected-job-batch-final-outcome.js"
import type { SubagentTaskStatus } from "./types.js"

export const TASK_GRAPH_FINAL_SOURCE_MANIFEST_SCHEMA = "agent-harness.v2.task-graph-sources.v1" as const
export const TASK_GRAPH_FINAL_SOURCE_MANIFEST_HISTORY_SCHEMA = "agent-harness.v2.task-graph-sources.v2" as const
export const TASK_GRAPH_FINAL_SOURCE_MANIFEST_RETIREMENT_SCHEMA = "agent-harness.v2.task-graph-sources.v3" as const
const ROLES = new Set(["scout", "analyst", "writer", "reviewer", "prepare", "unsupported"])
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const RESULT_STATES = new Set(["valid", "missing", "invalid", "unsupported_role", "not_terminal"])
const RESULT_STATUSES = new Set(["completed", "partial"])
const MAX_SOURCES = 8

export type TaskGraphFinalSource = Readonly<{
  sourceKey: string
  nodeIndex: number
  role: "scout" | "analyst" | "writer" | "reviewer" | "prepare" | "unsupported"
  taskStatus: SubagentTaskStatus
  resultState: "valid" | "missing" | "invalid" | "unsupported_role" | "not_terminal"
  roleResultStatus?: "completed" | "partial"
}>
export type TaskGraphFinalSourceWithArtifactProof = TaskGraphFinalSource & Readonly<{ artifactVersionProof?: string }>
export type TaskGraphFinalSourceManifest = Readonly<{
  schemaVersion: typeof TASK_GRAPH_FINAL_SOURCE_MANIFEST_SCHEMA
  graphRevision: number
  sources: readonly TaskGraphFinalSource[]
}> | Readonly<{
  schemaVersion: typeof TASK_GRAPH_FINAL_SOURCE_MANIFEST_HISTORY_SCHEMA
  graphRevision: number
  sources: readonly TaskGraphFinalSource[]
  historicalNodeIndices: readonly number[]
}> | Readonly<{
  schemaVersion: typeof TASK_GRAPH_FINAL_SOURCE_MANIFEST_RETIREMENT_SCHEMA
  graphRevision: number
  sources: readonly TaskGraphFinalSource[]
  historicalNodeIndices: readonly number[]
  retiredNodeIndices: readonly number[]
}> | Readonly<{
  schemaVersion: typeof TASK_GRAPH_FINAL_ARTIFACT_MANIFEST_SCHEMA
  graphRevision: number
  sources: readonly TaskGraphFinalSourceWithArtifactProof[]
  historicalNodeIndices: readonly number[]
  retiredNodeIndices: readonly number[]
}>

/** Emits only opaque selectors and bounded outcome facts; all graph identities stay private. */
export function buildTaskGraphFinalSourceManifest(binding: TaskGraphFinalSummaryBinding, finalItemId: string): TaskGraphFinalSourceManifest | null {
  const members = binding.members
  if (!validPrivateBinding(binding) || !validItemId(finalItemId) || !members) throw new Error("task_graph_final_source_binding_invalid")
  const business = members.filter(member => member.kind === "business")
  const historicalNodeIndices = members.filter(member => member.kind === "historical").map(member => member.nodeIndex)
  const retiredNodeIndices = members.filter(member => member.kind === "retired").map(member => member.nodeIndex)
  if (business.length > MAX_SOURCES) throw new Error("task_graph_final_source_limit_exceeded")
  const outcomes = binding.summary.taskOutcomes
  if (outcomes.length !== business.length) throw new Error("task_graph_final_source_outcomes_incomplete")
  const byTask = new Map(outcomes.map(outcome => [outcome.taskId, outcome]))
  if (byTask.size !== outcomes.length) throw new Error("task_graph_final_source_outcomes_ambiguous")
  const sources = business.map(member => {
    const outcome = byTask.get(member.taskId)
    if (!outcome || outcome.role !== publicRole(member.role) || outcome.taskStatus !== member.taskStatus
      || !RESULT_STATES.has(outcome.resultState) || (outcome.resultState === "valid"
        ? !RESULT_STATUSES.has(outcome.roleResultStatus ?? "") : Object.hasOwn(outcome, "roleResultStatus"))) {
      throw new Error("task_graph_final_source_outcome_conflict")
    }
    const sourceKey = `src_${createHash("sha256").update(`taskGraphSource:v1\0${finalItemId}\0${binding.graphRevision}\0${member.nodeIndex}`).digest("base64url")}`
    const artifactVersionProof = outcome.resultState === "valid" && outcome.roleResultStatus === "completed"
      ? artifactVersionProofFor(binding, member, sourceKey) : null
    return { sourceKey, nodeIndex: member.nodeIndex, role: publicRole(member.role), taskStatus: member.taskStatus,
      resultState: outcome.resultState, ...(outcome.roleResultStatus ? { roleResultStatus: outcome.roleResultStatus } : {}),
      ...(artifactVersionProof ? { artifactVersionProof } : {}) }
  })
  if (sources.length !== outcomes.length || new Set(sources.map(source => source.sourceKey)).size !== sources.length) {
    throw new Error("task_graph_final_source_outcomes_incomplete")
  }
  if (!retiredNodeIndices.length && !sources.length) return null
  if (!sources.length) throw new Error("task_graph_final_source_retirement_without_current_source")
  if (sources.some(source => Object.hasOwn(source, "artifactVersionProof"))) {
    return { schemaVersion: TASK_GRAPH_FINAL_ARTIFACT_MANIFEST_SCHEMA, graphRevision: binding.graphRevision,
      sources, historicalNodeIndices, retiredNodeIndices }
  }
  if (retiredNodeIndices.length) {
    return { schemaVersion: TASK_GRAPH_FINAL_SOURCE_MANIFEST_RETIREMENT_SCHEMA,
      graphRevision: binding.graphRevision, sources, historicalNodeIndices, retiredNodeIndices }
  }
  return historicalNodeIndices.length
    ? { schemaVersion: TASK_GRAPH_FINAL_SOURCE_MANIFEST_HISTORY_SCHEMA, graphRevision: binding.graphRevision, sources, historicalNodeIndices }
    : { schemaVersion: TASK_GRAPH_FINAL_SOURCE_MANIFEST_SCHEMA, graphRevision: binding.graphRevision, sources }
}

function artifactVersionProofFor(binding: TaskGraphFinalSummaryBinding, member: TaskGraphFinalSummaryMember, sourceKey: string): string | null {
  if (member.kind !== "business" || member.taskStatus !== "completed") return null
  const artifactRef = summaryArtifactRefForTask(binding, member.taskId)
  if (!artifactRef) return null
  const baseTemplate = member.templateId === "cover_letter_writer" && member.role === "writer" && member.taskType === "cover_letter_draft"
    || member.templateId === "cover_letter_reviewer" && member.role === "reviewer" && member.taskType === "cover_letter_review"
  if (baseTemplate) return artifactProof(sourceKey, artifactRef)
  const batchTemplate = SELECTED_JOB_BATCH_TEMPLATE_CATALOG.find(entry => entry.writerTemplateId === member.templateId
    || entry.reviewerTemplateId === member.templateId)
  if (!batchTemplate) return null
  const outcome = readBoundSelectedJobBatchFinalOutcome(binding)
  if (!outcome) return null
  const slot = outcome.slots.find(candidate => candidate.slotId === batchTemplate.slotId && candidate.status === "completed")
  if (!slot) return null
  const slotMember = member.role === "writer" ? slot.writer : member.role === "reviewer" ? slot.reviewer : null
  const expectedTemplate = member.role === "writer" ? batchTemplate.writerTemplateId
    : member.role === "reviewer" ? batchTemplate.reviewerTemplateId : null
  return slotMember && expectedTemplate && member.taskType === (member.role === "writer" ? "cover_letter_draft" : "cover_letter_review")
    && slotMember.nodeIndex === member.nodeIndex && slotMember.taskId === member.taskId && slotMember.templateId === member.templateId
    && slotMember.role === member.role && slotMember.taskType === member.taskType && slotMember.status === "completed"
    && member.templateId === expectedTemplate && sameArtifactRef(slot.artifactRef, artifactRef)
    ? artifactProof(sourceKey, artifactRef) : null
}

function summaryArtifactRefForTask(binding: TaskGraphFinalSummaryBinding, taskId: string): FinalTaskGraphArtifactRef | null {
  const rows = binding.summary.artifactReferences
  if (!Array.isArray(rows)) return null
  let selected: FinalTaskGraphArtifactRef | null = null
  for (const value of rows) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(",") !== "artifactRef,taskIds" || !Array.isArray(row.taskIds)
      || row.taskIds.some(id => typeof id !== "string") || new Set(row.taskIds).size !== row.taskIds.length) return null
    if (!row.taskIds.includes(taskId)) continue
    if (selected) return null
    selected = parseFinalTaskGraphArtifactRef(row.artifactRef)
    if (!selected) return null
  }
  return selected
}

function artifactProof(sourceKey: string, artifactRef: FinalTaskGraphArtifactRef): string {
  const proof = `avp_${createHash("sha256").update(finalTaskGraphArtifactProofInput(sourceKey, artifactRef)).digest("hex")}`
  if (!isFinalTaskGraphArtifactVersionProof(proof)) throw new Error("task_graph_final_artifact_proof_invalid")
  return proof
}

function sameArtifactRef(left: unknown, right: FinalTaskGraphArtifactRef): boolean {
  const parsed = parseFinalTaskGraphArtifactRef(left)
  return !!parsed && parsed.artifactId === right.artifactId && parsed.version === right.version
    && parsed.contentHash === right.contentHash && parsed.sourceDigest === right.sourceDigest
}

function validPrivateBinding(binding: TaskGraphFinalSummaryBinding): boolean {
  if (!binding || !Number.isSafeInteger(binding.graphRevision) || binding.graphRevision < 1
    || !safeText(binding.rootTaskId) || binding.graphItemId !== taskGraphItemId(binding.rootTaskId)
    || binding.summary?.graphRevision !== binding.graphRevision || !Array.isArray(binding.members)
    || !Array.isArray(binding.summary.taskOutcomes) || binding.members.length > MAX_SOURCES) return false
  const taskIds = new Set<string>(), nodeKeys = new Set<string>()
  let hasHistorical = false, hasBusiness = false
  for (const [nodeIndex, member] of binding.members.entries()) {
    if (!validMember(member, nodeIndex) || taskIds.has(member.taskId) || nodeKeys.has(member.nodeKey)) return false
    taskIds.add(member.taskId)
    nodeKeys.add(member.nodeKey)
    hasHistorical ||= member.kind === "historical"
    hasBusiness ||= member.kind === "business"
  }
  if (hasHistorical && !hasBusiness) return false
  return binding.summary.taskOutcomes.every(outcome => !!outcome && typeof outcome === "object"
      && Object.keys(outcome).every(key => ["taskId", "role", "taskStatus", "resultState", "roleResultStatus"].includes(key))
      && safeText(outcome.taskId) && ROLES.has(outcome.role) && TASK_STATUSES.has(outcome.taskStatus)
      && RESULT_STATES.has(outcome.resultState) && (outcome.resultState === "valid"
        ? RESULT_STATUSES.has(outcome.roleResultStatus ?? "") : !Object.hasOwn(outcome, "roleResultStatus")))
}

function validMember(value: TaskGraphFinalSummaryMember, nodeIndex: number): boolean {
  if (!value || typeof value !== "object") return false
  const keys = Object.keys(value).sort().join(",")
  if (keys === "kind,nodeIndex,nodeKey,role,taskId,taskStatus,taskType,templateId") return value.nodeIndex === nodeIndex
    && safeText(value.nodeKey) && safeText(value.templateId) && safeText(value.taskId)
    && safeText(value.role) && safeText(value.taskType) && TASK_STATUSES.has(value.taskStatus)
    && (value.kind === "business" || value.kind === "internal_control"
      || value.kind === "historical" && (value.role === "scout" || value.role === "analyst") && value.templateId === value.role && value.taskStatus === "completed")
  return retiredMember(value, keys, nodeIndex)
}
function retiredMember(value: unknown, keys: string, nodeIndex: number): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const member = value as Record<string, unknown>, proof = member.retirement
  if (keys !== "kind,nodeIndex,nodeKey,retirement,role,taskId,taskStatus,taskType,templateId"
    || member.nodeIndex !== nodeIndex || member.kind !== "retired" || member.role !== "scout" || member.templateId !== "scout"
    || member.taskType !== "job_discovery" || member.taskStatus !== "interrupted" || !TASK_STATUSES.has(String(member.taskStatus))
    || !safeText(member.nodeKey) || !safeText(member.taskId) || !proof || typeof proof !== "object" || Array.isArray(proof)) return false
  const receipt = proof as Record<string, unknown>, at = receipt.interruptRequestedAt
  return Object.keys(receipt).sort().join(",") === "attempt,interruptRequestedAt,lifecycleEventId,receiptEventId"
    && Number.isSafeInteger(receipt.attempt) && Number(receipt.attempt) > 0 && safeText(at)
    && Number.isFinite(Date.parse(at)) && new Date(at).toISOString() === at
    && safeText(receipt.receiptEventId) && safeText(receipt.lifecycleEventId)
}
function validItemId(value: string): boolean { return safeText(value) && value.length <= 512 && !value.includes("\0") }
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= 512 }
function publicRole(role: string): TaskGraphFinalSource["role"] { return ROLES.has(role) && role !== "unsupported" ? role as TaskGraphFinalSource["role"] : "unsupported" }
