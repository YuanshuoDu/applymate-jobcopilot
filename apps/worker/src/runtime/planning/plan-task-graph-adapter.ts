import { Buffer } from "node:buffer"

import type { PlanCommandExecutionRecord, PlanControlRecord } from "./plan-command-executor.js"
import type { PlanDispatchCommand, PlanDispatchResult } from "./plan-intent-dispatcher.js"
import {
  createTaskGraph,
  reduceTaskGraph,
  type TaskGraphErrorCode,
  type TaskGraphEvent,
  type TaskGraphState,
} from "./task-graph-reducer.js"

type ObservablePlanRecord = PlanCommandExecutionRecord | PlanControlRecord
export type PersistedTaskGraphEvent = {
  readonly runKey: string
  readonly event: TaskGraphEvent
  readonly state?: unknown
}
type PersistTaskGraph = (input: PersistedTaskGraphEvent & { readonly state: TaskGraphState }) => void | Promise<void>
const MAX_GRAPH_PAYLOAD_BYTES = 8 * 1024

export type PlanTaskGraphAdapterErrorCode = TaskGraphErrorCode | "invalid_event" | "graph_mismatch" | "invalid_record" | "persistence_failed"

export class PlanTaskGraphAdapterError extends Error {
  constructor(readonly code: PlanTaskGraphAdapterErrorCode, message: string) {
    super(message)
    this.name = "PlanTaskGraphAdapterError"
  }
}

export type PlanTaskGraphAdapter = {
  readonly state: TaskGraphState
  readonly observe: (record: ObservablePlanRecord) => Promise<TaskGraphState>
}

export type PlanTaskGraphAdapterOptions = {
  readonly runKey: string
  readonly persist: PersistTaskGraph
  readonly initialState?: TaskGraphState
}

export type PlanTaskGraphHydrationOptions = {
  readonly runKey: string
  readonly events: readonly PersistedTaskGraphEvent[]
}

const graphNodes = (commands: readonly PlanDispatchCommand[]) => commands.map(command => ({ id: command.localId, dependsOn: [...command.dependsOn] }))
const eventId = (runKey: string, localId: string, phase: TaskGraphEvent["type"]): string => `${runKey}:${localId}:${phase}`
const graphStatuses = new Set(["pending", "ready", "running", "completed", "failed", "waiting", "cancelled"])
const graphBlockers = new Set(["waiting_on_dependencies", "dependency_failed"])

function normalizedRunKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new PlanTaskGraphAdapterError("invalid_record", "Plan task graph runKey is invalid")
  return value.trim()
}

function boundedRunKey(value: unknown): string {
  const runKey = normalizedRunKey(value)
  if (runKey.length > 256) throw new PlanTaskGraphAdapterError("invalid_record", "Plan task graph runKey is invalid")
  return runKey
}

function graphError(error: unknown): PlanTaskGraphAdapterError {
  if (error instanceof PlanTaskGraphAdapterError) return error
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return new PlanTaskGraphAdapterError(error.code as PlanTaskGraphAdapterErrorCode, error instanceof Error ? error.message : "Task graph operation rejected")
  }
  return new PlanTaskGraphAdapterError("invalid_record", "Task graph operation rejected")
}

function hydrationEvent(value: unknown): TaskGraphEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanTaskGraphAdapterError("invalid_event", "Persisted task graph event is malformed")
  const candidate = value as Record<string, unknown>
  const keys = Reflect.ownKeys(candidate)
  if (keys.length !== 3 || keys.some(key => typeof key !== "string" || !["type", "nodeId", "eventId"].includes(key))) {
    throw new PlanTaskGraphAdapterError("invalid_event", "Persisted task graph event is malformed")
  }
  if (!(["start", "complete", "fail", "wait", "cancel"] as readonly unknown[]).includes(candidate.type)) {
    throw new PlanTaskGraphAdapterError("invalid_event", "Persisted task graph event type is invalid")
  }
  if (typeof candidate.nodeId !== "string" || !candidate.nodeId || candidate.nodeId.length > 256 || typeof candidate.eventId !== "string" || !candidate.eventId || candidate.eventId.length > 512) {
    throw new PlanTaskGraphAdapterError("invalid_event", "Persisted task graph event fields are invalid")
  }
  return { type: candidate.type as TaskGraphEvent["type"], nodeId: candidate.nodeId, eventId: candidate.eventId }
}

function hydrationEntry(value: unknown, runKey: string): { readonly event: TaskGraphEvent } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PlanTaskGraphAdapterError("invalid_record", "Persisted task graph entry is malformed")
  const candidate = value as Record<string, unknown>
  const keys = Reflect.ownKeys(candidate)
  if (keys.some(key => typeof key !== "string" || !["runKey", "event", "state"].includes(key))
    || !Object.hasOwn(candidate, "runKey") || !Object.hasOwn(candidate, "event")) {
    throw new PlanTaskGraphAdapterError("invalid_record", "Persisted task graph entry is malformed")
  }
  if (candidate.runKey !== runKey) throw new PlanTaskGraphAdapterError("graph_mismatch", "Persisted task graph runKey does not match")
  return { event: hydrationEvent(candidate.event) }
}

function boundedHistory(runKey: string, events: readonly PersistedTaskGraphEvent[]): void {
  let encoded: string | undefined
  try { encoded = JSON.stringify({ runKey, events }) } catch { encoded = undefined }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_GRAPH_PAYLOAD_BYTES) {
    throw new PlanTaskGraphAdapterError("persistence_failed", "Persisted task graph history exceeded the bounded payload")
  }
}

function initialStateShape(value: unknown): value is TaskGraphState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  if (Object.keys(state).some(key => !["nodes", "statuses", "readyNodeIds", "blockedReasons", "appliedEvents"].includes(key))) return false
  if (!Array.isArray(state.nodes) || !state.statuses || typeof state.statuses !== "object" || Array.isArray(state.statuses) || !Array.isArray(state.readyNodeIds) || !state.blockedReasons || typeof state.blockedReasons !== "object" || Array.isArray(state.blockedReasons) || !Array.isArray(state.appliedEvents)) return false
  if (state.nodes.some(node => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return true
    const candidate = node as Record<string, unknown>
    return Object.keys(candidate).some(key => !["id", "dependsOn"].includes(key)) || typeof candidate.id !== "string" || !candidate.id || !Array.isArray(candidate.dependsOn) || candidate.dependsOn.some(dependency => typeof dependency !== "string" || !dependency)
  })) return false
  const nodeIds = new Set(state.nodes.map(node => (node as Record<string, unknown>).id))
  const statuses = state.statuses as Record<string, unknown>
  if (Object.keys(statuses).some(id => !nodeIds.has(id) || typeof statuses[id] !== "string" || !graphStatuses.has(statuses[id] as string)) || nodeIds.size !== Object.keys(statuses).length) return false
  if (state.readyNodeIds.some(id => typeof id !== "string" || !nodeIds.has(id)) || new Set(state.readyNodeIds).size !== state.readyNodeIds.length) return false
  const blockedReasons = state.blockedReasons as Record<string, unknown>
  if (Object.keys(blockedReasons).some(id => !nodeIds.has(id) || typeof blockedReasons[id] !== "string" || !graphBlockers.has(blockedReasons[id] as string))) return false
  try { state.appliedEvents.forEach(event => hydrationEvent(event)) } catch { return false }
  return true
}

export function hydratePlanTaskGraph(plan: PlanDispatchResult, options: PlanTaskGraphHydrationOptions): TaskGraphState {
  const runKey = boundedRunKey(options.runKey)
  if (!Array.isArray(options.events)) throw new PlanTaskGraphAdapterError("invalid_record", "Persisted task graph history is invalid")
  boundedHistory(runKey, options.events)
  let state: TaskGraphState
  try { state = createTaskGraph(graphNodes(plan.commands)) } catch (error: unknown) { throw graphError(error) }
  const seen = new Set<string>()
  for (const persisted of options.events) {
    const { event } = hydrationEntry(persisted, runKey)
    if (seen.has(event.eventId)) throw new PlanTaskGraphAdapterError("duplicate_event", `Persisted task graph event ${event.eventId} is duplicated`)
    if (event.eventId !== eventId(runKey, event.nodeId, event.type)) throw new PlanTaskGraphAdapterError("graph_mismatch", "Persisted task graph event ID does not match its runKey and phase")
    const reduction = reduceTaskGraph(state, event)
    if (!reduction.ok) throw new PlanTaskGraphAdapterError(reduction.errorCode, reduction.message)
    seen.add(event.eventId)
    state = reduction.state
  }
  return state
}

function outputStatus(record: PlanCommandExecutionRecord): string | undefined {
  if (!record.result || typeof record.result !== "object") return undefined
  const output = record.result.output
  if (!output || typeof output !== "object" || Array.isArray(output)) return undefined
  const status = (output as Record<string, unknown>).status
  return typeof status === "string" ? status : undefined
}

function terminalPhase(record: PlanCommandExecutionRecord): TaskGraphEvent["type"] {
  if (!record.result || typeof record.result !== "object") throw new PlanTaskGraphAdapterError("invalid_record", "Plan execution record result is required")
  const status = (record.result as { readonly status: string }).status
  if (status === "failed") return "fail"
  if (status === "cancelled") return "cancel"
  if (status === "waiting" || ["waiting", "waiting_for_dependency", "waiting_for_user", "waiting_for_approval"].includes(outputStatus(record) ?? "")) return "wait"
  if (status === "completed") return "complete"
  throw new PlanTaskGraphAdapterError("invalid_record", "Plan execution record has an unsupported status")
}

function isReplan(record: ObservablePlanRecord): record is Extract<PlanControlRecord, { readonly kind: "replan_required" }> {
  return Boolean(record && typeof record === "object" && record.kind === "replan_required")
}

function controlRecord(record: ObservablePlanRecord): record is Exclude<PlanControlRecord, { readonly kind: "replan_required" }> {
  return record.kind === "request_input" || record.kind === "propose_completion"
}

function isExecutionRecord(record: ObservablePlanRecord): record is PlanCommandExecutionRecord {
  return record.kind === "tool_call" || record.kind === "delegate" || record.kind === "join"
}

export function createPlanTaskGraphAdapter(plan: PlanDispatchResult, options: PlanTaskGraphAdapterOptions): PlanTaskGraphAdapter {
  const runKey = boundedRunKey(options.runKey)
  const freshState = createTaskGraph(graphNodes(plan.commands))
  let state = freshState
  if (options.initialState !== undefined) {
    if (!initialStateShape(options.initialState)) throw new PlanTaskGraphAdapterError("graph_mismatch", "Initial task graph state is malformed")
    if (JSON.stringify(options.initialState.nodes) !== JSON.stringify(freshState.nodes)) throw new PlanTaskGraphAdapterError("graph_mismatch", "Initial task graph nodes do not match the dispatched plan")
    const hydrated = hydratePlanTaskGraph(plan, { runKey, events: options.initialState.appliedEvents.map(event => ({ runKey, event })) })
    if (JSON.stringify(hydrated) !== JSON.stringify(options.initialState)) throw new PlanTaskGraphAdapterError("graph_mismatch", "Initial task graph state is not reducer-derived")
    state = hydrated
  }

  const persist = async (event: TaskGraphEvent, nextState: TaskGraphState): Promise<void> => {
    const payload = { runKey, event, state: nextState }
    let encoded: string | undefined
    try { encoded = JSON.stringify(payload) } catch { encoded = undefined }
    if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_GRAPH_PAYLOAD_BYTES) throw new PlanTaskGraphAdapterError("persistence_failed", "Task graph persistence exceeded the bounded payload")
    try { await options.persist(payload) } catch { throw new PlanTaskGraphAdapterError("persistence_failed", "Task graph persistence failed") }
  }

  const apply = async (localId: string, phase: TaskGraphEvent["type"]): Promise<void> => {
    const event: TaskGraphEvent = { type: phase, nodeId: localId, eventId: eventId(runKey, localId, phase) }
    const replayed = state.appliedEvents.some(previous => previous.eventId === event.eventId && previous.nodeId === event.nodeId && previous.type === event.type)
    const reduction = reduceTaskGraph(state, event)
    if (!reduction.ok) throw new PlanTaskGraphAdapterError(reduction.errorCode, reduction.message)
    if (replayed) return
    await persist(event, reduction.state)
    state = reduction.state
  }

  const observe = async (record: ObservablePlanRecord): Promise<TaskGraphState> => {
    if (!record || typeof record !== "object") throw new PlanTaskGraphAdapterError("invalid_record", "Unsupported plan observation record")
    if (isReplan(record)) return state
    if (!record || typeof record.localId !== "string" || !record.localId.trim()) throw new PlanTaskGraphAdapterError("invalid_record", "Plan observation localId is required")
    let phase: TaskGraphEvent["type"]
    if (controlRecord(record)) phase = "wait"
    else if (isExecutionRecord(record)) phase = terminalPhase(record)
    else throw new PlanTaskGraphAdapterError("invalid_record", "Unsupported plan observation record")
    await apply(record.localId, "start")
    await apply(record.localId, phase)
    return state
  }

  return { get state() { return state }, observe }
}
