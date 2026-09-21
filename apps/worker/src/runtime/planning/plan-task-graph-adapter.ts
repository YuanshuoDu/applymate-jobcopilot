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
type PersistTaskGraph = (input: { readonly runKey: string; readonly event: TaskGraphEvent; readonly state: TaskGraphState }) => void | Promise<void>
const MAX_GRAPH_PAYLOAD_BYTES = 8 * 1024

export type PlanTaskGraphAdapterErrorCode = TaskGraphErrorCode | "invalid_record" | "persistence_failed"

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
}

const graphNodes = (commands: readonly PlanDispatchCommand[]) => commands.map(command => ({ id: command.localId, dependsOn: [...command.dependsOn] }))
const eventId = (runKey: string, localId: string, phase: TaskGraphEvent["type"]): string => `${runKey}:${localId}:${phase}`

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
  if (typeof options.runKey !== "string" || !options.runKey.trim()) throw new PlanTaskGraphAdapterError("invalid_record", "Plan task graph runKey is required")
  let state = createTaskGraph(graphNodes(plan.commands))
  const runKey = options.runKey.trim()

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
