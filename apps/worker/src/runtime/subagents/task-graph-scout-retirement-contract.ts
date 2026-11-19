import { createHash } from "node:crypto"
import type { TaskGraphExecutionScope } from "./task-graph-schedule-input.js"

export const TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION = "agent-harness.v2.task-graph.superseded-scout-retirement.v1" as const
export const TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_EVENT_TYPE = "task_graph.superseded_scout_retirement" as const
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
type Row = Record<string, unknown>

export type TaskGraphScoutRetirementInput = Readonly<{
  scope: TaskGraphExecutionScope
  expectedRevision: number
  taskId: string
  callId: string
}>
export type TaskGraphScoutRetirementIdentity = Readonly<{
  scope: Pick<TaskGraphExecutionScope, "userId" | "sessionId" | "turnId" | "rootTaskId" | "stepId">
  expectedRevision: number
  taskId: string
  callId: string
}>
export type TaskGraphSupersededScoutRetirementReceipt = Readonly<{
  schemaVersion: typeof TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION
  sessionId: string
  turnId: string
  rootTaskId: string
  nodeKey: string
  taskId: string
  attempt: number
  interruptRequestedAt: string
  graphRevision: number
  acceptedPlanRevision: number
  acceptedSteerSequence: string
  reconciliationStepId: string
  reconciliationThroughSequence: string
  reconciliationEventId: string
  reconciliationEventSequence: string
  reconciliationIdempotencyKey: string
  planEventId: string
  planEventSequence: string
  planIdempotencyKey: string
  replacementNodeKey: string
  replacementTaskId: string
  replacementSourceSequence: string
}>
export type TaskGraphScoutRetirementResult = Readonly<{
  status: "requested" | "duplicate"
  taskId: string
  receiptEventId: string
  receipt: TaskGraphSupersededScoutRetirementReceipt
}>
export type TaskGraphSupersededScoutRetirementPlan = Omit<TaskGraphSupersededScoutRetirementReceipt,
  "attempt" | "interruptRequestedAt">

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      && Object.keys(value).length === Object.getOwnPropertyNames(value).length
      && Object.values(descriptors).every(item => item.enumerable && "value" in item) ? value as Row : null
  } catch { return null }
}
function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}
function sequence(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/u.test(value)) return false
  try { return BigInt(value) <= MAX_SEQUENCE } catch { return false }
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function exactKeys(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}

export function taskGraphScoutRetirementIdempotencyKey(input: TaskGraphScoutRetirementInput): string | null {
  const { scope } = input
  if (!scope || [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.stepId,
    scope.turnLeaseOwner, scope.parentLeaseOwner, input.taskId, input.callId].some(value => !id(value))
    || scope.rootTaskId !== scope.parentTaskId || !revision(input.expectedRevision)
    || !Number.isSafeInteger(scope.turnLeaseVersion) || scope.turnLeaseVersion < 1
    || !Number.isSafeInteger(scope.parentAttemptCount) || scope.parentAttemptCount < 1) return null
  return taskGraphScoutRetirementIdempotencyKeyFromIdentity(input)
}

/** Recomputes the durable key from persisted identity without inventing a live lease attempt. */
export function taskGraphScoutRetirementIdempotencyKeyFromIdentity(input: TaskGraphScoutRetirementIdentity): string | null {
  const { scope } = input
  if (!scope || [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.stepId, input.taskId, input.callId].some(value => !id(value))
    || !revision(input.expectedRevision)) return null
  const identity = JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.stepId, input.callId, input.expectedRevision, input.taskId])
  return `task_graph.scout_retirement:sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`
}

const RECEIPT_KEYS = ["schemaVersion", "sessionId", "turnId", "rootTaskId", "nodeKey", "taskId", "attempt",
  "interruptRequestedAt", "graphRevision", "acceptedPlanRevision", "acceptedSteerSequence", "reconciliationStepId", "reconciliationThroughSequence",
  "reconciliationEventId", "reconciliationEventSequence", "reconciliationIdempotencyKey", "planEventId", "planEventSequence",
  "planIdempotencyKey", "replacementNodeKey", "replacementTaskId", "replacementSourceSequence"] as const

export function parseTaskGraphSupersededScoutRetirementReceipt(value: unknown,
  expected?: Partial<Pick<TaskGraphSupersededScoutRetirementReceipt, "sessionId" | "turnId" | "rootTaskId" | "nodeKey" | "taskId">>): TaskGraphSupersededScoutRetirementReceipt | null {
  const row = record(value)
  if (!row || !exactKeys(row, RECEIPT_KEYS) || row.schemaVersion !== TASK_GRAPH_SUPERSEDED_SCOUT_RETIREMENT_SCHEMA_VERSION
    || ![row.sessionId, row.turnId, row.rootTaskId, row.nodeKey, row.taskId, row.reconciliationStepId,
      row.reconciliationEventId, row.planEventId, row.replacementNodeKey, row.replacementTaskId].every(id)
    || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1 || !revision(row.graphRevision)
    || !revision(row.acceptedPlanRevision) || Number(row.acceptedPlanRevision) > Number(row.graphRevision)
    || typeof row.interruptRequestedAt !== "string" || !Number.isFinite(Date.parse(row.interruptRequestedAt))
    || new Date(row.interruptRequestedAt).toISOString() !== row.interruptRequestedAt
    || ![row.acceptedSteerSequence, row.reconciliationThroughSequence, row.reconciliationEventSequence,
      row.planEventSequence, row.replacementSourceSequence].every(sequence)
    || BigInt(row.acceptedSteerSequence as string) > BigInt(row.reconciliationThroughSequence as string)
    || BigInt(row.planEventSequence as string) >= BigInt(row.reconciliationEventSequence as string)
    || BigInt(row.replacementSourceSequence as string) < BigInt(row.acceptedSteerSequence as string)
    || typeof row.reconciliationIdempotencyKey !== "string" || !/^agent\.plan\.reconciliation:sha256:[0-9a-f]{64}$/u.test(row.reconciliationIdempotencyKey)
    || typeof row.planIdempotencyKey !== "string" || !/^task-graph-[0-9a-f]{64}:proposal:[0-9]+$/u.test(row.planIdempotencyKey)) return null
  if (expected && Object.entries(expected).some(([key, item]) => item !== undefined && row[key] !== item)) return null
  return row as unknown as TaskGraphSupersededScoutRetirementReceipt
}
