import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { types as nodeTypes } from "node:util"
import type { RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import type { LoadedGraph, GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import { parseRegisteredScoutEnvelope, type RegisteredScoutEnvelope, type TaskGraphReadScope } from "../subagents/task-graph-command-port.js"
import { taskGraphLifecycleKey, type StoredTaskGraphNode } from "../subagents/task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type ScoutResult } from "../subagents/role-results.js"
import { isCanonicalTaskGraphJobId, TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "../subagents/task-graph-result-page-contract.js"
import {
  TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS, TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA,
  TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE, parseTaskGraphHistoricalDiscoveryPageRequest,
  type TaskGraphHistoricalDiscoveryPage, type TaskGraphHistoricalDiscoveryPageRequest,
} from "../subagents/task-graph-historical-discovery-page-contract.js"

export type HistoricalScoutGraph = Readonly<{
  source: RootTaskHistoryCandidate
  loaded: LoadedGraph
  attemptCounts: ReadonlyMap<string, number>
}>

export type SelectedHistoricalScout = Readonly<{
  source: RootTaskHistoryCandidate
  graphRevision: number
  nodeKey: string
  taskId: string
  taskAttemptCount: number
  resultStatus: "completed" | "partial"
  jobIds: readonly string[]
  truncated: boolean
  resultIdsDigest: string
}>

export type HistoricalDiscoveryBinding = Pick<TaskGraphReadScope,
  "userId" | "sessionId" | "turnId" | "rootTaskId" | "turnLeaseOwner" | "turnLeaseVersion" | "parentLeaseOwner" | "parentAttemptCount">
  & Readonly<{ objectiveDigest: string }>

export function historicalScoutTaskIds(loaded: LoadedGraph): string[] {
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.item.revision !== loaded.state.revision) return []
  return orderedNodes(loaded).filter(node => {
    const task = loaded.tasks.get(node.taskId)
    return task !== undefined && ordinaryScoutBinding(node, task)
  }).map(node => node.taskId)
}

export function selectHistoricalScoutSource(input: HistoricalScoutGraph): SelectedHistoricalScout | undefined {
  const { source, loaded, attemptCounts } = input
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.item.revision !== loaded.state.revision) return undefined
  for (const node of orderedNodes(loaded)) {
    const task = loaded.tasks.get(node.taskId), attempt = attemptCounts.get(node.taskId)
    if (!task || !ordinaryScoutBinding(node, task) || task.status !== "completed"
      || !Number.isSafeInteger(attempt) || Number(attempt) < 1
      || !hasCurrentAttemptCompletion(loaded, node.key, Number(attempt))) continue
    const result = scoutResult(task.result)
    if (!result || result.candidates.length === 0) continue
    const jobIds: string[] = [], seen = new Set<string>()
    let malformed = false
    for (const candidate of result.candidates) {
      if (!isCanonicalTaskGraphJobId(candidate.jobId)) { malformed = true; break }
      if (!seen.has(candidate.jobId)) { seen.add(candidate.jobId); jobIds.push(candidate.jobId) }
    }
    if (malformed || jobIds.length === 0) continue
    const resultIdsDigest = createHash("sha256").update(JSON.stringify(jobIds)).digest("hex")
    return {
      source, graphRevision: loaded.item.revision, nodeKey: node.key, taskId: node.taskId,
      taskAttemptCount: Number(attempt), resultStatus: result.status,
      jobIds: jobIds.slice(0, TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS),
      truncated: jobIds.length > TASK_GRAPH_HISTORICAL_DISCOVERY_MAX_JOB_IDS, resultIdsDigest,
    }
  }
  return undefined
}

export function projectHistoricalDiscoveryPage(
  selected: SelectedHistoricalScout,
  binding: HistoricalDiscoveryBinding,
  value: unknown,
): TaskGraphHistoricalDiscoveryPage {
  const request: TaskGraphHistoricalDiscoveryPageRequest | null = parseTaskGraphHistoricalDiscoveryPageRequest(value)
  if (!request) return unavailable("no_source")
  const sourceToken = historicalDiscoverySourceToken(selected, binding)
  if (request.sourceToken !== undefined && request.sourceToken !== sourceToken) return unavailable("source_changed")
  if (request.offset >= selected.jobIds.length) return unavailable("offset_out_of_range")
  const items = selected.jobIds.slice(request.offset, request.offset + TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SIZE).map(jobId => ({ jobId }))
  const next = request.offset + items.length
  return {
    schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
    observation: "historical_discovery", verificationStatus: "unverified", sourceToken,
    sourceResultStatus: selected.resultStatus, offset: request.offset,
    nextOffset: next < selected.jobIds.length ? next : null,
    totalCount: selected.jobIds.length, truncated: selected.truncated, items,
  }
}

export function historicalDiscoverySourceToken(selected: SelectedHistoricalScout, binding: HistoricalDiscoveryBinding): string {
  const tokenBinding = {
    current: {
      userId: binding.userId, sessionId: binding.sessionId, turnId: binding.turnId,
      rootTaskId: binding.rootTaskId, turnLeaseOwner: binding.turnLeaseOwner,
      turnLeaseVersion: binding.turnLeaseVersion, parentLeaseOwner: binding.parentLeaseOwner,
      parentAttemptCount: binding.parentAttemptCount, objectiveDigest: binding.objectiveDigest,
    },
    source: {
      sessionId: selected.source.sessionId, turnId: selected.source.turnId, rootTaskId: selected.source.rootTaskId,
      terminalSequence: String(selected.source.terminalSequence), terminalAt: selected.source.terminalAt?.toISOString() ?? null,
      graphRevision: selected.graphRevision, nodeKey: selected.nodeKey, taskId: selected.taskId,
      taskAttemptCount: selected.taskAttemptCount, resultStatus: selected.resultStatus,
      resultIdsDigest: selected.resultIdsDigest,
    },
  }
  return createHash("sha256").update(JSON.stringify(tokenBinding)).digest("hex")
}

function orderedNodes(loaded: LoadedGraph): readonly StoredTaskGraphNode[] {
  return [...loaded.snapshot!.nodes].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
}

function ordinaryScoutBinding(node: StoredTaskGraphNode, task: GraphTaskRow): boolean {
  const envelope = parseRegisteredScoutEnvelope(node.registeredScoutEnvelope)
  const registered = TASK_GRAPH_TEMPLATES.scout
  return node.templateId === "scout" && node.repairOf === undefined && !Object.hasOwn(node, "nativeDelegation")
    && !!envelope && matchesRegisteredScout(envelope, registered)
    && task.id === node.taskId && task.role === registered.role && task.taskType === registered.taskType
    && outputMarker(task.expectedOutputSchema)
}

function matchesRegisteredScout(envelope: RegisteredScoutEnvelope, registered: typeof TASK_GRAPH_TEMPLATES.scout): boolean {
  return envelope.role === registered.role && envelope.taskType === registered.taskType
    && envelope.expectedOutputSchema.schemaVersion === registered.expectedOutputSchema.schemaVersion
    && envelope.expectedOutputSchema.role === registered.expectedOutputSchema.role
    && envelope.allowedActions.length === registered.allowedActions.length
    && envelope.allowedActions.every((action, index) => action === registered.allowedActions[index])
}

function outputMarker(value: unknown): boolean {
  if (!plainData(value) || !record(value)) return false
  const row = value as Record<string, unknown>
  return Reflect.ownKeys(row).length === 2 && Object.keys(row).sort().join(",") === "role,schemaVersion"
    && row.schemaVersion === ROLE_RESULT_SCHEMA && row.role === "scout"
}

function hasCurrentAttemptCompletion(loaded: LoadedGraph, nodeKey: string, attempt: number): boolean {
  const events = loaded.state!.appliedEvents
  const startKey = taskGraphLifecycleKey(loaded.rootTaskId, nodeKey, attempt, "task.started")
  const completeKey = taskGraphLifecycleKey(loaded.rootTaskId, nodeKey, attempt, "task.completed")
  const starts = events.map((event, index) => event.type === "task.started" && event.nodeKey === nodeKey && event.idempotencyKey === startKey ? index : -1).filter(index => index >= 0)
  const completions = events.map((event, index) => event.type === "task.completed" && event.nodeKey === nodeKey && event.idempotencyKey === completeKey ? index : -1).filter(index => index >= 0)
  return starts.length === 1 && completions.length === 1 && starts[0]! < completions[0]!
}

function scoutResult(value: unknown): ScoutResult | undefined {
  if (!persistedJsonWithinLimit(value)) return undefined
  const envelope = parseJson(value)
  if (!plainData(envelope) || !record(envelope)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(envelope, "structuredResult")
  if (!descriptor?.enumerable || !("value" in descriptor) || !plainData(descriptor.value)) return undefined
  try {
    const result = validateRoleResult(descriptor.value, "scout")
    return result.role === "scout" ? result : undefined
  } catch { return undefined }
}

function persistedJsonWithinLimit(value: unknown): boolean {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") <= TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT
  let bytes = 0
  const add = (text: string): boolean => {
    const size = Buffer.byteLength(text, "utf8")
    if (size > TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT - bytes) return false
    bytes += size
    return true
  }
  const visit = (current: unknown, seen: Set<object>): boolean => {
    if (current === null) return add("null")
    if (typeof current === "string") {
      if (Buffer.byteLength(current, "utf8") > TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT) return false
      try { const encoded = JSON.stringify(current); return typeof encoded === "string" && add(encoded) } catch { return false }
    }
    if (typeof current === "boolean") return add(current ? "true" : "false")
    if (typeof current === "number") return Number.isFinite(current) && add(JSON.stringify(current))
    if (typeof current !== "object" || nodeTypes.isProxy(current) || seen.has(current)) return false
    seen.add(current)
    try {
      if (Array.isArray(current)) {
        const keys = Reflect.ownKeys(current)
        if (keys.length !== current.length + 1 || !keys.includes("length") || !add("[")) return false
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0 && !add(",")) return false
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index))
          if (!descriptor?.enumerable || !("value" in descriptor) || !visit(descriptor.value, seen)) return false
        }
        if (!keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < current.length)) return false
        return add("]")
      }
      const prototype = Object.getPrototypeOf(current)
      if (prototype !== Object.prototype && prototype !== null) return false
      const keys = Reflect.ownKeys(current)
      if (!add("{")) return false
      for (const [index, key] of keys.entries()) {
        if (typeof key !== "string") return false
        const descriptor = Object.getOwnPropertyDescriptor(current, key)
        if (!descriptor?.enumerable || !("value" in descriptor)) return false
        if (index > 0 && !add(",")) return false
        if (Buffer.byteLength(key, "utf8") > TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT) return false
        let encodedKey: string | undefined
        try { encodedKey = JSON.stringify(key) } catch { return false }
        if (typeof encodedKey !== "string" || !add(encodedKey) || !add(":") || !visit(descriptor.value, seen)) return false
      }
      return add("}")
    } catch { return false }
    finally { seen.delete(current) }
  }
  return visit(value, new Set())
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null } catch { return false }
}

function plainData(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || nodeTypes.isProxy(value) || seen.has(value)) return false
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value)
      return keys.length === value.length + 1 && keys.includes("length")
        && Array.from({ length: value.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
          return !!descriptor?.enumerable && "value" in descriptor && plainData(descriptor.value, seen)
        }).every(Boolean)
        && keys.every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
    }
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => {
      if (typeof key !== "string") return false
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return !!descriptor?.enumerable && "value" in descriptor && plainData(descriptor.value, seen)
    })
  } catch { return false }
  finally { seen.delete(value) }
}

function unavailable(reason: "no_source" | "source_changed" | "offset_out_of_range"): TaskGraphHistoricalDiscoveryPage {
  return { schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable", reason }
}
