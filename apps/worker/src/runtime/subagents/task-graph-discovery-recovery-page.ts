import { types as nodeTypes } from "node:util"
import { parseDiscoveryRecovery } from "./task-graph-discovery-recovery-contract.js"
import { parseRegisteredScoutEnvelope, type RegisteredScoutEnvelope } from "./task-graph-command-port.js"
import type { TaskGraphNode } from "../planning/task-graph.js"
import type { LoadedGraph, GraphTaskRow } from "./task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import {
  TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE,
  TASK_GRAPH_DISCOVERY_RECOVERY_MAX_ATTEMPT_COUNT, type TaskGraphDiscoveryRecoveryPage,
  type TaskGraphDiscoveryRecoveryPageRequest,
} from "./task-graph-discovery-recovery-page-contract.js"

const MAX_REVISION = 2_147_483_646

/** Projects only the server-owned failed-Scout recovery sidecar from the already owner-fenced graph. */
export function projectTaskGraphDiscoveryRecoveryPage(
  loaded: LoadedGraph,
  request: TaskGraphDiscoveryRecoveryPageRequest,
): TaskGraphDiscoveryRecoveryPage {
  if (!loaded.item) return unavailable(0, "no_graph")
  const revision = loaded.item.revision
  if (!validRevision(revision) || !loaded.snapshot || !loaded.state || loaded.state.revision !== revision) {
    return unavailable(validRevision(revision) ? revision : 0, "node_unavailable")
  }
  if (request.expectedRevision !== revision) return unavailable(revision, "revision_mismatch")

  const node = loaded.snapshot.nodes.find(candidate => candidate.key === request.nodeKey)
  const current = loaded.state.nodes.find(candidate => candidate.key === request.nodeKey)
  const task = node ? loaded.tasks.get(node.taskId) : undefined
  if (!node || !current || !task || !matchesCurrentNode(node, current, task) || !ordinaryGenericScout(node, task)) {
    return unavailable(revision, "node_unavailable")
  }
  if (task.status !== "failed") return unavailable(revision, "node_unavailable")
  const result = persistedFailureEnvelope(task.result)
  const recovery = result ? parseDiscoveryRecovery(result.discoveryRecovery) : undefined
  if (!recovery || result?.status !== "failed" || Object.hasOwn(result, "structuredResult") || Object.hasOwn(result, "finalText")
    || Object.hasOwn(result, "taskGraphRepairReceipt")
    || !validAttempt(task.attemptCount) || recovery.attemptCount !== task.attemptCount) {
    return unavailable(revision, "recovery_unavailable")
  }
  if (request.expectedAttemptCount !== undefined && request.expectedAttemptCount !== recovery.attemptCount) {
    return unavailable(revision, "attempt_mismatch")
  }
  if (request.offset > recovery.jobIds.length) return unavailable(revision, "offset_out_of_range")
  const end = Math.min(recovery.jobIds.length, request.offset + TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SIZE)
  return {
    schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
    observation: "partial_discovery", verificationStatus: "unverified", graphRevision: revision,
    attemptCount: recovery.attemptCount, taskStatus: "failed", totalCount: recovery.jobIds.length,
    offset: request.offset, nextOffset: end < recovery.jobIds.length ? end : null, truncated: recovery.truncated,
    items: recovery.jobIds.slice(request.offset, end).map(jobId => ({ jobId })),
  }
}

function ordinaryGenericScout(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  if (node.templateId !== "scout" || node.verificationDisposition !== "typed" || node.repairOf || "nativeDelegation" in node
    || task.role !== "scout" || task.taskType !== "job_discovery") return false
  const registered = parseRegisteredScoutEnvelope(node.registeredScoutEnvelope)
  const template = TASK_GRAPH_TEMPLATES.scout
  const expected = parseRegisteredScoutEnvelope({ role: template.role, taskType: template.taskType,
    expectedOutputSchema: template.expectedOutputSchema, allowedActions: template.allowedActions })
  const actualTaskSchema = plainRecord(task.expectedOutputSchema)
  return Boolean(registered && expected && sameEnvelope(registered, expected) && actualTaskSchema
    && exactKeys(actualTaskSchema, "role,schemaVersion") && actualTaskSchema.role === "scout"
    && actualTaskSchema.schemaVersion === ROLE_RESULT_SCHEMA
    && sameActions(task.allowedActions, expected.allowedActions)
    && task.contextIsObject === true && task.hasPrivateSelectionContext === false)
}

function sameActions(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) return false
  try {
    const keys = Reflect.ownKeys(value)
    if (value.length !== expected.length || keys.length !== value.length + 1 || !keys.includes("length")) return false
    return expected.every((action, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      return Boolean(descriptor?.enumerable && "value" in descriptor && descriptor.value === action)
    })
  } catch { return false }
}

function sameEnvelope(left: RegisteredScoutEnvelope, right: RegisteredScoutEnvelope): boolean {
  return left.role === right.role && left.taskType === right.taskType
    && left.expectedOutputSchema.role === right.expectedOutputSchema.role
    && left.expectedOutputSchema.schemaVersion === right.expectedOutputSchema.schemaVersion
    && left.allowedActions.length === right.allowedActions.length
    && left.allowedActions.every((action, index) => action === right.allowedActions[index])
}

function matchesCurrentNode(node: StoredTaskGraphNode, current: TaskGraphNode, task: GraphTaskRow): boolean {
  return current.taskId === node.taskId && current.templateId === node.templateId && current.status === task.status && task.id === node.taskId
}

function persistedFailureEnvelope(value: unknown): Record<string, unknown> | undefined {
  let parsed = value
  if (typeof value === "string") {
    try { parsed = JSON.parse(value) as unknown } catch { return undefined }
  }
  return plainRecord(parsed) ?? undefined
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeTypes.isProxy(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || !keys.every((key): key is string => typeof key === "string")) return null
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  return Object.keys(value).sort().join(",") === keys
}
function validRevision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVISION }
function validAttempt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= TASK_GRAPH_DISCOVERY_RECOVERY_MAX_ATTEMPT_COUNT
}
function unavailable(graphRevision: number, reason: Extract<TaskGraphDiscoveryRecoveryPage, { availability: "unavailable" }>['reason']): TaskGraphDiscoveryRecoveryPage {
  return { schemaVersion: TASK_GRAPH_DISCOVERY_RECOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable", graphRevision, reason }
}
