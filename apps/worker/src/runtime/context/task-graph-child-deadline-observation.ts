import { Buffer } from "node:buffer"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import type { TaskGraphCurrentNode } from "../subagents/task-graph-command-port.js"

export const TASK_GRAPH_CHILD_DEADLINES_OBSERVATION_ID = "task-graph-child-deadlines"
const SCHEMA_VERSION = "agent-harness.v2.task-graph-child-deadlines.v1"
const MAX_GRAPH_NODES = 16
const MAX_ENTRIES = TASK_GRAPH_LIMITS.maxPersistedNodes
const MAX_NODE_KEY_LENGTH = 128
const MAX_OBSERVATION_BYTES = 4_096
const ACTIVE_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user"])
const AUTHORITY_NOTICE = "Current child task times are advisory only. The server task graph, scheduler, and existing planning, budget, approval, and action rules remain authoritative."

type DeadlineEntry = Readonly<{ nodeKey: string; deadlineAt: string }>
type DeadlineObservation = Readonly<{
  schemaVersion: typeof SCHEMA_VERSION
  kind: "task_graph_child_deadlines"
  revision: number
  observedAt: string
  authorityNotice: typeof AUTHORITY_NOTICE
  entries: readonly DeadlineEntry[]
}>

export type TaskGraphChildDeadlineNode = Pick<TaskGraphCurrentNode, "key" | "status">

function dataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}

function dataArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return null
    const length = value.length
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ENTRIES) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== length + 1 || ownKeys[ownKeys.length - 1] !== "length"
      || ownKeys.slice(0, -1).some((key, index) => key !== String(index))) return null
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
    if (!lengthDescriptor || lengthDescriptor.enumerable || lengthDescriptor.value !== length) return null
    const result: unknown[] = []
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
      result.push(descriptor.value)
    }
    return result
  } catch { return null }
}

function strictUtcMilliseconds(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null
  const timestamp = Date.parse(value)
  try { return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value ? timestamp : null }
  catch { return null }
}

function project(input: {
  revision: number
  nodes: readonly TaskGraphChildDeadlineNode[]
  packet: unknown
}): DeadlineObservation | null {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0 || input.nodes.length > MAX_GRAPH_NODES) return null
  const packet = dataObject(input.packet, ["revision", "observedAt", "entries"])
  if (!packet || packet.revision !== input.revision) return null
  const observedAt = packet.observedAt
  const observedAtMs = strictUtcMilliseconds(observedAt)
  const entries = dataArray(packet.entries)
  if (observedAtMs === null || !entries || entries.length === 0) return null

  const activeIndexes = new Map<string, number>()
  for (const [index, node] of input.nodes.entries()) {
    if (ACTIVE_STATUSES.has(node.status)) {
      if (activeIndexes.has(node.key)) return null
      activeIndexes.set(node.key, index)
    }
  }
  const projected: DeadlineEntry[] = []
  let previousIndex = -1
  const seen = new Set<string>()
  for (const entryValue of entries) {
    const entry = dataObject(entryValue, ["nodeKey", "deadlineAt"])
    if (!entry || typeof entry.nodeKey !== "string" || entry.nodeKey.length < 1
      || entry.nodeKey.length > MAX_NODE_KEY_LENGTH || entry.nodeKey.trim() !== entry.nodeKey
      || seen.has(entry.nodeKey)) return null
    const nodeIndex = activeIndexes.get(entry.nodeKey)
    const deadlineAtMs = strictUtcMilliseconds(entry.deadlineAt)
    if (nodeIndex === undefined || nodeIndex <= previousIndex || deadlineAtMs === null
      || deadlineAtMs <= observedAtMs) return null
    previousIndex = nodeIndex
    seen.add(entry.nodeKey)
    projected.push({ nodeKey: entry.nodeKey, deadlineAt: entry.deadlineAt as string })
  }

  const observation: DeadlineObservation = {
    schemaVersion: SCHEMA_VERSION,
    kind: "task_graph_child_deadlines",
    revision: input.revision,
    observedAt: observedAt as string,
    authorityNotice: AUTHORITY_NOTICE,
    entries: projected,
  }
  return Buffer.byteLength(JSON.stringify(observation), "utf8") <= MAX_OBSERVATION_BYTES ? observation : null
}

/** Rebuilds the timing block from the latest owned graph read, removing stale content first. */
export function replaceTaskGraphChildDeadlineObservation(
  snapshot: StepContextSnapshot,
  input: { revision: number; nodes: readonly TaskGraphChildDeadlineNode[]; packet: unknown },
): StepContextSnapshot {
  const toolObservations = snapshot.toolObservations.filter(item => item.id !== TASK_GRAPH_CHILD_DEADLINES_OBSERVATION_ID)
  const observation = project(input)
  return {
    ...snapshot,
    toolObservations: observation
      ? [...toolObservations, { id: TASK_GRAPH_CHILD_DEADLINES_OBSERVATION_ID, content: observation }]
      : toolObservations,
  }
}
