import { Buffer } from "node:buffer"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import { type TaskGraphCurrentNode, type TaskGraphCommandPort, type TaskGraphCurrentState, type TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { parseTaskGraphResultProjection, taskGraphResultProjectionBytes, taskGraphResultProjectionItems, UNAVAILABLE_PROJECTION } from "./canonical-turn-task-graph-node-projection.js"
import { parseTaskGraphCurrentVerificationMetadata, taskGraphCurrentVerificationMetadataBytes, validateTaskGraphCurrentVerificationGraph } from "./canonical-turn-task-graph-verification-context.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import { readRootPlanCriteriaObservation } from "./subagents/root-plan-criteria.js"
import { nativeGraphNodeFields } from "./canonical-turn-native-graph-context.js"
import { retireStaleTaskGraphRepair } from "./turns/completion-recovery-context.js"
import { withTaskGraphCurrentPlanningObservation } from "./canonical-turn-task-graph-capacity.js"
import { classifyCurrentTaskGraphExecutionFailure } from "./subagents/task-graph-failure-category.js"
import { TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON } from "./subagents/task-graph-child-deadline.js"
import { hasTaskGraphVerificationUnverifiedFailureReason, projectTaskGraphStructuredFailureCategory, taskGraphStructuredFailureCategoryBytes } from "./subagents/task-graph-structured-failure-category.js"
import { parseTaskGraphCurrentDiscoveryAttemptHealth } from "./subagents/task-graph-discovery-attempt-health.js"
import { withTaskGraphRootSourceIntent } from "./subagents/task-graph-source-intent-context.js"
import { taskGraphReviewConflictObservation } from "./context/task-graph-review-conflicts.js"
const SELECTED_JOB_ROOT_TOOLS = new Set(["agent.plan", "agent.wait", "agent.list", "list_subagents", "agent.ask_user", "agent.reconcile"])

export function isSelectedJobRootTool(definition: unknown): boolean {
  const name = record(definition)?.name
  return typeof name === "string" && SELECTED_JOB_ROOT_TOOLS.has(name)
}
export function selectedJobToolAllowed(name: string): boolean { return SELECTED_JOB_ROOT_TOOLS.has(name) }
/** Restrict selected-job root context to coordination tools and the current graph observation. */
export function selectedJobSnapshot(snapshot: StepContextSnapshot): StepContextSnapshot {
  return {
    ...snapshot,
    toolObservations: snapshot.toolObservations.filter(observation => {
      const content = record(observation.content)
      const toolName = content?.toolName
      return (typeof toolName === "string" && SELECTED_JOB_ROOT_TOOLS.has(toolName))
        || (observation.id === "task-graph-current" && content?.kind === "task_graph_current")
    }),
  }
}

const OBSERVATION_ID = "task-graph-current"
const MAX_NODES = 16
const MAX_TEXT = 160_000
const MAX_RESULT_PROJECTION_TOTAL_BYTES = 16 * 1024
const MAX_RESULT_PROJECTION_TOTAL_ITEMS = 24
const MAX_VERIFICATION_CONTEXT_BYTES = 32 * 1024
const STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function ownEnumerableDataValue(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch { return undefined }
}
function text(value: unknown, maxLength: number, path: string, clip = false): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("task_graph_current_state_invalid")
  if (value.length > maxLength && !clip) throw new Error(`task_graph_current_state_invalid:${path}`)
  return value.slice(0, maxLength)
}
function stringList(value: unknown, maxItems: number, maxLength: number, path: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`task_graph_current_state_invalid:${path}`)
  return value.map((item, index) => text(item, maxLength, `${path}[${index}]`))
}
function node(value: unknown): TaskGraphCurrentNode {
  const row = record(value)
  if (!row || typeof row.status !== "string" || !STATUSES.has(row.status) || typeof row.readiness !== "string" || !READINESS.has(row.readiness)) throw new Error("task_graph_current_state_invalid:node")
  const key = text(row.key, 128, "key"), taskId = text(row.taskId, 128, "taskId")
  const templateId = text(row.templateId, 128, "templateId")
  const verification = parseTaskGraphCurrentVerificationMetadata(row, templateId, key, taskId)
  if (!verification) throw new Error("task_graph_current_state_invalid:verification")
  const native = nativeGraphNodeFields(row)
  const discoveryAttemptHealth = parseTaskGraphCurrentDiscoveryAttemptHealth(row, { templateId, status: row.status, verification: verification.verification, repairOf: verification.repairOf, repairReceipt: verification.repairReceipt, native: Boolean(native.native), nativeResult: Boolean(native.nativeResult) })
  const failureReason = ownEnumerableDataValue(row, "failureReason")
  const resumeFailureReason = failureReason === "child_resume_unavailable" || failureReason === "child_resume_evidence_unavailable"
  const report = verification.verificationReport
  const contract = verification.verification
  const reportCriteria = report?.criteria
  const unverifiedResumeFailure = resumeFailureReason && contract !== undefined && report?.status === "unverified"
    && report.reasonCode === "result_invalid" && report.evidenceDigest === null && report.resultDigest === null
    && reportCriteria !== undefined && reportCriteria.length === contract.criteria.length
    && reportCriteria.every(item => item.status === "unverified" && item.reasonCode === "result_invalid")
    && (templateId === "scout" && contract.role === "scout" || templateId === "analyst" && contract.role === "analyst")
  const unverifiedDeadlineFailure = failureReason === TASK_GRAPH_CHILD_DEADLINE_FAILURE_REASON && report?.status === "unverified"
  const executionFailureCategory = resumeFailureReason && !unverifiedResumeFailure ? undefined
    : classifyCurrentTaskGraphExecutionFailure(row, {
      hasVerifiedReport: Boolean(report) && !unverifiedResumeFailure && !unverifiedDeadlineFailure,
      isNative: Boolean(native.native || native.nativeResult),
    })
  const structuredOutputFailureCategory = verification.repairOf || verification.repairReceipt || native.native || native.nativeResult || !hasTaskGraphVerificationUnverifiedFailureReason(row) ? undefined
    : projectTaskGraphStructuredFailureCategory(row, { status: row.status, templateId, verification: verification.verification, verificationReport: verification.verificationReport })
  return {
    key, templateId,
    goal: text(row.goal, 1200, "goal", true), successCriteria: stringList(row.successCriteria, 8, 320, "successCriteria"),
    dependsOn: stringList(row.dependsOn, MAX_NODES, 128, "dependsOn"), taskId,
    status: row.status as TaskGraphCurrentNode["status"], readiness: row.readiness as TaskGraphCurrentNode["readiness"],
    resultSummary: null,
    resultProjection: parseTaskGraphResultProjection(row.resultProjection), ...(discoveryAttemptHealth ? { discoveryAttemptHealth } : {}),
    ...verification, ...native, ...(executionFailureCategory ? { executionFailureCategory } : {}), ...(structuredOutputFailureCategory ? { structuredOutputFailureCategory } : {}),
    failureReason: null,
  }
}

/** Replace an old read with the server-fenced current graph, as untrusted model evidence. */
export function mergeTaskGraphCurrentObservation(snapshot: StepContextSnapshot, value: TaskGraphCurrentState & { sourceIntent?: unknown }): StepContextSnapshot {
  const state = record(value)
  if (!state || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0 || !Array.isArray(state.nodes) || state.nodes.length > MAX_NODES) throw new Error("task_graph_current_state_invalid")
  const rootSuccessCriteria = readRootPlanCriteriaObservation(state)
  let projectedBytes = 0
  let projectedItems = 0
  let verificationBytes = 0
  const nodes = state.nodes.map(value => {
    const item = node(value)
    const bytes = taskGraphResultProjectionBytes(item.resultProjection!)
    const count = taskGraphResultProjectionItems(item.resultProjection!)
    verificationBytes += taskGraphCurrentVerificationMetadataBytes(item) + Math.max(0, taskGraphStructuredFailureCategoryBytes(item.structuredOutputFailureCategory) - 1) + (item.discoveryAttemptHealth ? Buffer.byteLength(JSON.stringify(item.discoveryAttemptHealth), "utf8") : 0)
    if (verificationBytes > MAX_VERIFICATION_CONTEXT_BYTES) throw new Error("task_graph_current_verification_too_large")
    if (projectedBytes + bytes > MAX_RESULT_PROJECTION_TOTAL_BYTES
      || projectedItems + count > MAX_RESULT_PROJECTION_TOTAL_ITEMS) {
      return { ...item, resultProjection: UNAVAILABLE_PROJECTION }
    }
    projectedBytes += bytes
    projectedItems += count
    return item
  })
  const keys = new Set(nodes.map(item => item.key))
  if (keys.size !== nodes.length || !validateTaskGraphCurrentVerificationGraph(nodes)) throw new Error("task_graph_current_state_invalid:dependencies")
  let planningFacts: unknown
  try { planningFacts = Object.getOwnPropertyDescriptor(state, "planningFacts")?.value } catch { planningFacts = undefined }
  const baseContent = withTaskGraphCurrentPlanningObservation({
    kind: "task_graph_current", revision: Number(state.revision),
    ...(rootSuccessCriteria?.length ? { rootSuccessCriteria } : {}), ...taskGraphReviewConflictObservation(nodes), nodes,
  }, planningFacts, Number(state.revision), nodes, MAX_TEXT)
  let sourceIntent: unknown
  try { sourceIntent = Object.getOwnPropertyDescriptor(state, "sourceIntent")?.value } catch { sourceIntent = undefined }
  const content = withTaskGraphRootSourceIntent(baseContent, sourceIntent, MAX_TEXT)
  if (JSON.stringify(content).length > MAX_TEXT) throw new Error("task_graph_current_state_too_large")
  return retireStaleTaskGraphRepair({ ...snapshot, taskGraphRevision: value.revision,
    toolObservations: [...snapshot.toolObservations.filter(observation => observation.id !== OBSERVATION_ID), { id: OBSERVATION_ID, content }] }, value.revision)
}

export async function loadTaskGraphCurrentObservation(
  snapshot: StepContextSnapshot,
  commandPort: TaskGraphCommandPort | undefined,
  lease: TurnLease,
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">,
): Promise<StepContextSnapshot> {
  if (!commandPort) throw new Error("task_graph_runtime_dependencies_unavailable")
  const scope: TaskGraphReadScope = {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: root.id, parentTaskId: root.id,
    turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
  }
  return mergeTaskGraphCurrentObservation(snapshot, await commandPort.readCurrent(scope))
}
