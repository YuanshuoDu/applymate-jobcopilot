import { createHash } from "node:crypto"
import { taskGraphItemId } from "./task-graph-snapshot.js"
import type { TaskGraphFinalSummaryBinding, TaskGraphFinalSummaryMember } from "./task-graph-final-summary-binding.js"
import type { SubagentTaskStatus } from "./types.js"

export const TASK_GRAPH_FINAL_SOURCE_MANIFEST_SCHEMA = "agent-harness.v2.task-graph-sources.v1" as const
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
export type TaskGraphFinalSourceManifest = Readonly<{
  schemaVersion: typeof TASK_GRAPH_FINAL_SOURCE_MANIFEST_SCHEMA
  graphRevision: number
  sources: readonly TaskGraphFinalSource[]
}>

/** Emits only opaque selectors and bounded outcome facts; all graph identities stay private. */
export function buildTaskGraphFinalSourceManifest(binding: TaskGraphFinalSummaryBinding, finalItemId: string): TaskGraphFinalSourceManifest | null {
  const members = binding.members
  if (!validPrivateBinding(binding) || !validItemId(finalItemId) || !members) throw new Error("task_graph_final_source_binding_invalid")
  const business = members.filter(member => member.kind === "business")
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
    return { sourceKey, nodeIndex: member.nodeIndex, role: publicRole(member.role), taskStatus: member.taskStatus,
      resultState: outcome.resultState, ...(outcome.roleResultStatus ? { roleResultStatus: outcome.roleResultStatus } : {}) }
  })
  if (sources.length !== outcomes.length || new Set(sources.map(source => source.sourceKey)).size !== sources.length) {
    throw new Error("task_graph_final_source_outcomes_incomplete")
  }
  return sources.length ? { schemaVersion: TASK_GRAPH_FINAL_SOURCE_MANIFEST_SCHEMA, graphRevision: binding.graphRevision, sources } : null
}

function validPrivateBinding(binding: TaskGraphFinalSummaryBinding): boolean {
  if (!binding || !Number.isSafeInteger(binding.graphRevision) || binding.graphRevision < 1
    || !safeText(binding.rootTaskId) || binding.graphItemId !== taskGraphItemId(binding.rootTaskId)
    || binding.summary?.graphRevision !== binding.graphRevision || !Array.isArray(binding.members)
    || !Array.isArray(binding.summary.taskOutcomes) || binding.members.length > MAX_SOURCES) return false
  const taskIds = new Set<string>(), nodeKeys = new Set<string>()
  for (const [nodeIndex, member] of binding.members.entries()) {
    if (!validMember(member, nodeIndex) || taskIds.has(member.taskId) || nodeKeys.has(member.nodeKey)) return false
    taskIds.add(member.taskId)
    nodeKeys.add(member.nodeKey)
  }
  return binding.summary.taskOutcomes.every(outcome => !!outcome && typeof outcome === "object"
      && Object.keys(outcome).every(key => ["taskId", "role", "taskStatus", "resultState", "roleResultStatus"].includes(key))
      && safeText(outcome.taskId) && ROLES.has(outcome.role) && TASK_STATUSES.has(outcome.taskStatus)
      && RESULT_STATES.has(outcome.resultState) && (outcome.resultState === "valid"
        ? RESULT_STATUSES.has(outcome.roleResultStatus ?? "") : !Object.hasOwn(outcome, "roleResultStatus")))
}

function validMember(value: TaskGraphFinalSummaryMember, nodeIndex: number): boolean {
  if (!value || typeof value !== "object") return false
  const keys = Object.keys(value).sort().join(",")
  return keys === "kind,nodeIndex,nodeKey,role,taskId,taskStatus,taskType,templateId"
    && value.nodeIndex === nodeIndex && safeText(value.nodeKey) && safeText(value.templateId) && safeText(value.taskId)
    && safeText(value.role) && safeText(value.taskType) && TASK_STATUSES.has(value.taskStatus)
    && (value.kind === "business" || value.kind === "internal_control")
}
function validItemId(value: string): boolean { return safeText(value) && value.length <= 512 && !value.includes("\0") }
function safeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value && value.length <= 512 }
function publicRole(role: string): TaskGraphFinalSource["role"] { return ROLES.has(role) && role !== "unsupported" ? role as TaskGraphFinalSource["role"] : "unsupported" }
