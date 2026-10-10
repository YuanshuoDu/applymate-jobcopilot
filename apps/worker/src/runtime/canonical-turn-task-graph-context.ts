import { Buffer } from "node:buffer"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import {
  type TaskGraphCommandPort, type TaskGraphCurrentNode, type TaskGraphCurrentState, type TaskGraphReadScope,
} from "./subagents/task-graph-command-port.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import { retireStaleTaskGraphRepair } from "./turns/completion-recovery-context.js"
import { projectTaskGraphPlanningCounts, withTaskGraphPlanningCounts } from "./task-graph-planning-facts-context.js"
import { copyTaskGraphSourceCheckpointMetadata, projectTaskGraphObservationNode, projectTaskGraphResultProjection, TASK_GRAPH_CONTEXT_MAX_NODES, TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT } from "./subagents/task-graph-source-intent-context.js"
const SELECTED_JOB_ROOT_TOOLS = new Set(["agent.plan", "agent.wait", "agent.list", "list_subagents", "agent.ask_user", "agent.reconcile"])

export function isSelectedJobRootTool(definition: unknown): boolean {
  const name = record(definition)?.name
  return typeof name === "string" && SELECTED_JOB_ROOT_TOOLS.has(name)
}
export function selectedJobToolAllowed(name: string): boolean {
  return SELECTED_JOB_ROOT_TOOLS.has(name)
}
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
const MAX_TEXT = TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT
const MAX_RESULT_PROJECTION_TOTAL_BYTES = 16 * 1024
const MAX_RESULT_PROJECTION_TOTAL_ITEMS = 24
const MAX_VERIFICATION_CONTEXT_BYTES = 32 * 1024
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
/** Replace an old read with the server-fenced current graph, as untrusted model evidence. */
export function mergeTaskGraphCurrentObservation(snapshot: StepContextSnapshot, value: TaskGraphCurrentState): StepContextSnapshot {
  const state = record(value)
  if (!state || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0 || !Array.isArray(state.nodes) || state.nodes.length > TASK_GRAPH_CONTEXT_MAX_NODES) throw new Error("task_graph_current_state_invalid")
  let projectedBytes = 0
  let projectedItems = 0
  let verificationBytes = 0
  const nodes = state.nodes.map(value => {
    const item = projectTaskGraphObservationNode(value)
    const usage = taskGraphProjectionUsage(item.resultProjection!)
    const bytes = usage.bytes
    const count = usage.items
    verificationBytes += Buffer.byteLength(JSON.stringify({ verificationCriterionIds: item.verificationCriterionIds, verificationReport: item.verificationReport, repairOf: item.repairOf, repairReceipt: item.repairReceipt }), "utf8")
    if (verificationBytes > MAX_VERIFICATION_CONTEXT_BYTES) throw new Error("task_graph_current_verification_too_large")
    if (projectedBytes + bytes > MAX_RESULT_PROJECTION_TOTAL_BYTES
      || projectedItems + count > MAX_RESULT_PROJECTION_TOTAL_ITEMS) {
      return { ...item, resultProjection: projectTaskGraphResultProjection(null) }
    }
    projectedBytes += bytes
    projectedItems += count
    return item
  })
  const keys = new Set(nodes.map(item => item.key))
  if (keys.size !== nodes.length || nodes.some(item => item.dependsOn.some(key => !keys.has(key)))) throw new Error("task_graph_current_state_invalid:dependencies")
  let planningFacts: unknown
  try { planningFacts = Object.getOwnPropertyDescriptor(state, "planningFacts")?.value } catch { planningFacts = undefined }
  const taskReportedCounts = projectTaskGraphPlanningCounts(planningFacts, Number(state.revision))
  const baseContent = { kind: "task_graph_current", revision: Number(state.revision), nodes }
  const withoutRelations = { ...baseContent, nodes: nodes.map(withoutTaskGraphInputRelation) }
  const content = fitCurrentObservationContent(
    withTaskGraphPlanningCounts(baseContent, taskReportedCounts, MAX_TEXT),
    withTaskGraphPlanningCounts(withoutRelations, taskReportedCounts, MAX_TEXT),
  )
  copyTaskGraphSourceCheckpointMetadata(value, content)
  if (JSON.stringify(content).length > MAX_TEXT) throw new Error("task_graph_current_state_too_large")
  return retireStaleTaskGraphRepair({ ...snapshot, taskGraphRevision: value.revision,
    toolObservations: [...snapshot.toolObservations.filter(observation => observation.id !== OBSERVATION_ID), { id: OBSERVATION_ID, content }] }, value.revision)
}

function withoutTaskGraphInputRelation(node: TaskGraphCurrentNode): TaskGraphCurrentNode {
  const projected: Record<string, unknown> = { ...node }
  delete projected.inputRelation
  return projected as unknown as TaskGraphCurrentNode
}

function fitCurrentObservationContent<T extends Record<string, unknown>>(withRelations: T, withoutRelations: T): T {
  const withLength = JSON.stringify(withRelations).length
  const withoutLength = JSON.stringify(withoutRelations).length
  if (withLength <= MAX_TEXT
    && (Object.hasOwn(withRelations, "taskReportedCounts") || !Object.hasOwn(withoutRelations, "taskReportedCounts"))) return withRelations
  return withoutLength <= MAX_TEXT ? withoutRelations : withRelations
}

function taskGraphProjectionUsage(value: NonNullable<TaskGraphCurrentNode["resultProjection"]>): { bytes: number; items: number } {
  const items = value.availability !== "available" ? 0
    : value.role === "scout" ? value.candidates.length
      : value.role === "analyst" ? value.findings.length : 1
  return { bytes: Buffer.byteLength(JSON.stringify(value), "utf8"), items }
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
  const state = commandPort.readCurrentForPlanning
    ? await commandPort.readCurrentForPlanning(scope)
    : await commandPort.readCurrent(scope)
  return mergeTaskGraphCurrentObservation(snapshot, state)
}
