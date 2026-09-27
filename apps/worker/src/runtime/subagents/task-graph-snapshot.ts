import { createHash } from "node:crypto"
import { TASK_GRAPH_LIMITS, type TaskGraphEvent, type TaskGraphNodeProposal, type TaskGraphState } from "../planning/task-graph.js"
import type { SubagentTaskStatus } from "./types.js"

export const TASK_GRAPH_ITEM_TYPE = "task_graph"
export const TASK_GRAPH_SNAPSHOT_VERSION = "agent-harness.v2.task-graph"

export type StoredTaskGraphNode = TaskGraphNodeProposal & Readonly<{ depth: number; taskId: string }>
export type TaskGraphSnapshot = Readonly<{
  schemaVersion: typeof TASK_GRAPH_SNAPSHOT_VERSION
  nodes: readonly StoredTaskGraphNode[]
}>

const MAX_NODES = TASK_GRAPH_LIMITS.maxNodes
const MAX_SNAPSHOT_BYTES = TASK_GRAPH_LIMITS.maxSnapshotBytes
const MAX_DEPTH = TASK_GRAPH_LIMITS.maxDepth
const MAX_KEY_LENGTH = TASK_GRAPH_LIMITS.maxKeyLength
const MAX_TEMPLATE_ID_LENGTH = TASK_GRAPH_LIMITS.maxTemplateIdLength
const MAX_GOAL_LENGTH = TASK_GRAPH_LIMITS.maxGoalLength
const MAX_CRITERIA = TASK_GRAPH_LIMITS.maxSuccessCriteria
const MAX_CRITERION_LENGTH = TASK_GRAPH_LIMITS.maxCriterionLength
const MAX_DEPENDENCIES = TASK_GRAPH_LIMITS.maxDependencies
const MAX_TASK_ID_LENGTH = TASK_GRAPH_LIMITS.maxKeyLength

const TASK_STATUSES = new Set<SubagentTaskStatus>([
  "queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed",
])

function object(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0
    ? parsed as Record<string, unknown>
    : null
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}

function text(value: unknown, maxLength = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
}
function stringList(value: unknown, maxItems: number, maxLength: number, allowEmpty: boolean): value is string[] {
  if (!Array.isArray(value) || value.length > maxItems || (!allowEmpty && value.length === 0)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1) return false
  for (const key of keys) {
    if (key === "length") continue
    if (typeof key !== "string") return false
    const index = Number(key)
    if (!Number.isSafeInteger(index) || index < 0 || index >= value.length || String(index) !== key || !text(value[index], maxLength)) return false
  }
  return true
}

export function parseTaskGraphSnapshot(value: unknown): TaskGraphSnapshot {
  const row = object(value)
  if (!row || !exactKeys(row, "nodes,schemaVersion") || row.schemaVersion !== TASK_GRAPH_SNAPSHOT_VERSION
    || !Array.isArray(row.nodes) || row.nodes.length > MAX_NODES) throw new Error("task_graph_snapshot_invalid")
  const keys = new Set<string>()
  const ids = new Set<string>()
  const nodes: StoredTaskGraphNode[] = []
  for (const value of row.nodes) {
    const node = object(value)
    if (!node || !exactKeys(node, "dependsOn,depth,goal,key,successCriteria,taskId,templateId")
      || !text(node.key, MAX_KEY_LENGTH) || !text(node.templateId, MAX_TEMPLATE_ID_LENGTH)
      || !text(node.goal, MAX_GOAL_LENGTH) || !text(node.taskId, MAX_TASK_ID_LENGTH)
      || !stringList(node.successCriteria, MAX_CRITERIA, MAX_CRITERION_LENGTH, false)
      || !stringList(node.dependsOn, MAX_DEPENDENCIES, MAX_KEY_LENGTH, true)
      || !Number.isSafeInteger(node.depth) || Number(node.depth) < 1 || Number(node.depth) > MAX_DEPTH) throw new Error("task_graph_snapshot_invalid")
    if (keys.has(node.key) || ids.has(node.taskId)) throw new Error("task_graph_snapshot_duplicate")
    keys.add(node.key); ids.add(node.taskId)
    nodes.push({
      key: node.key, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
      dependsOn: node.dependsOn, depth: Number(node.depth), taskId: node.taskId,
    })
  }
  const indegree = new Map<string, number>(nodes.map(node => [node.key, 0] as const))
  const children = new Map(nodes.map(node => [node.key, [] as string[]] as const))
  for (const node of nodes) {
    const dependencies = new Set<string>()
    for (const dependency of node.dependsOn) {
      if (!keys.has(dependency) || dependencies.has(dependency)) throw new Error("task_graph_snapshot_dependency_invalid")
      dependencies.add(dependency)
      indegree.set(node.key, indegree.get(node.key)! + 1)
      children.get(dependency)!.push(node.key)
    }
  }
  const ready = nodes.filter(node => indegree.get(node.key) === 0).map(node => node.key)
  let visited = 0
  for (let cursor = 0; cursor < ready.length; cursor++) {
    const key = ready[cursor]!
    visited++
    for (const child of children.get(key)!) {
      indegree.set(child, indegree.get(child)! - 1)
      if (indegree.get(child) === 0) ready.push(child)
    }
  }
  if (visited !== nodes.length) throw new Error("task_graph_snapshot_cycle_invalid")
  const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
  assertTaskGraphSnapshotSize(snapshot)
  return snapshot
}

export function taskGraphSnapshot(state: TaskGraphState, taskIds: ReadonlyMap<string, string>): TaskGraphSnapshot {
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: state.nodes.map(node => {
      const taskId = taskIds.get(node.key)
      if (!taskId) throw new Error("task_graph_task_id_missing")
      const { status: _status, failureReason: _failureReason, ...stored } = node
      return { ...stored, taskId }
    }),
  }
  return parseTaskGraphSnapshot(snapshot)
}

function assertTaskGraphSnapshotSize(snapshot: TaskGraphSnapshot): void {
  const bytes = Buffer.byteLength(canonicalTaskGraphJson(snapshot), "utf8")
  if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("task_graph_snapshot_too_large")
}

export function taskGraphItemId(parentTaskId: string): string {
  const hash = createHash("sha256").update(parentTaskId).digest("hex")
  return `task-graph-${hash}`
}

export function taskGraphProposalKey(parentTaskId: string, expectedRevision: number): string {
  return `${taskGraphItemId(parentTaskId)}:proposal:${expectedRevision}`
}

export function taskGraphLifecycleKey(parentTaskId: string, nodeKey: string, attempt: number, type: string): string {
  const node = createHash("sha256").update(nodeKey).digest("hex").slice(0, 20)
  return `${taskGraphItemId(parentTaskId)}:node:${node}:${attempt}:${type}`
}

export function taskGraphState(
  snapshot: TaskGraphSnapshot,
  revision: number,
  statuses: ReadonlyMap<string, { status: SubagentTaskStatus; failureReason: string | null }>,
  events: readonly TaskGraphEvent[],
): TaskGraphState {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("task_graph_revision_invalid")
  return {
    revision,
    nodes: snapshot.nodes.map(({ taskId, ...node }) => {
      const current = statuses.get(taskId)
      if (!current || !TASK_STATUSES.has(current.status)) throw new Error("task_graph_task_missing")
      return { ...node, status: current.status, ...(current.failureReason ? { failureReason: current.failureReason } : {}) }
    }),
    appliedEvents: events,
  }
}

export function canonicalTaskGraphJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskGraphJson).join(",")}]`
  const row = object(value)
  if (row) return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonicalTaskGraphJson(row[key])}`).join(",")}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new TypeError("task_graph_json_invalid")
  return encoded
}

export function taskGraphFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex")
}

export function parseTaskGraphEvent(value: unknown): TaskGraphEvent | null {
  const row = object(value)
  if (!row || !text(row.type) || !text(row.idempotencyKey) || !text(row.nodeKey)
    || !Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0) return null
  const allowed = new Set(["task.started", "task.queued", "task.waiting", "task.waiting_for_user", "task.retrying", "task.completed", "task.failed", "task.interrupted", "task.cancelled", "task.closed"])
  if (!allowed.has(row.type)) return null
  const keys = row.type === "task.failed" ? "expectedRevision,failureReason,idempotencyKey,nodeKey,type" : "expectedRevision,idempotencyKey,nodeKey,type"
  if (Object.keys(row).sort().join(",") !== keys) return null
  if (row.type === "task.failed") return text(row.failureReason) ? row as unknown as TaskGraphEvent : null
  return row as unknown as TaskGraphEvent
}
