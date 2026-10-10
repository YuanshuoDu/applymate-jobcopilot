import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import { executionKey } from "../turns/turn-execution-types.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"

export const STEERING_RECONCILIATION_EVENT_TYPE = "agent.plan.reconciliation" as const
export const STEERING_RECONCILIATION_SCHEMA_VERSION = "agent-harness.v2.plan-reconciliation.v1" as const
export const STEERING_RECONCILIATION_BLOCKER = "steering_reconciliation_pending" as const
export const STEERING_RECONCILIATION_FEEDBACK = "Accepted user steering must be reconciled against the current TaskGraph before completion. Review current input and plan, then use agent.reconcile to keep the current revision or agent.plan to revise it." as const
export const STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS = 128
const MAX_BYTES = 16 * 1024
const MAX_SEQUENCE = 9_223_372_036_854_775_807n
type Row = Record<string, unknown>

export type SteeringReconciliationReceipt = Readonly<{
  schemaVersion: typeof STEERING_RECONCILIATION_SCHEMA_VERSION
  sessionId: string
  turnId: string
  rootTaskId: string
  stepId: string
  decision: "keep" | "revise"
  observedRevision: number
  resultingRevision: number
  steerInputIds: readonly string[]
  inputCheckpoint: Readonly<{ throughSequence: string }>
}>
export type SteeringReconciliationScope = TaskGraphReadScope & Readonly<{ stepId?: string; rootInputId?: string | null }>
export type SteeringReconciliationOperation = Readonly<{
  scope: TaskGraphExecutionScope
  decision: "keep" | "revise"
  expectedRevision: number
  callId: string
  rootInputId?: string | null
}>
export type SteeringReconciliationPendingInput = Readonly<{
  id: string
  acceptedSequence: bigint
  status: "accepted" | "queued" | "consumed"
  consumedByStepId: string | null
  consumingOrdinal: number | null
}>
export type SteeringReconciliationState = Readonly<{
  originalInputId: string | null
  currentRevision: number
  decisionStepId: string | null
  decisionStepOrdinal: number | null
  decisionStepAttempt: number | null
  decisionInputThroughSequence: bigint | null
  agendaPlanRevision: number | null
  unresolvedInputs: readonly SteeringReconciliationPendingInput[]
}>
export type PreparedSteeringReconciliation = Readonly<{
  scope: TaskGraphExecutionScope
  callId: string
  decision: "keep" | "revise"
  expectedRevision: number
  resultingRevision: number
  steerInputIds: readonly string[]
  inputThroughSequence: bigint
  idempotencyKey: string
  receipt: SteeringReconciliationReceipt
}>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  return Object.keys(value).length === Object.getOwnPropertyNames(value).length
    && Object.values(descriptors).every(item => item.enumerable && "value" in item) ? value as Row : null
}
function exact(value: Row, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
export function steeringReconciliationId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}
export function steeringReconciliationRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
export function steeringReconciliationSequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= 0n && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= MAX_SEQUENCE ? parsed : null
}
export function validSteeringReconciliationScope(scope: SteeringReconciliationScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.turnLeaseOwner, scope.parentLeaseOwner].every(steeringReconciliationId)
    && scope.parentTaskId === scope.rootTaskId && Number.isSafeInteger(scope.turnLeaseVersion) && scope.turnLeaseVersion >= 1
    && Number.isSafeInteger(scope.parentAttemptCount) && scope.parentAttemptCount >= 1
    && (scope.stepId === undefined || steeringReconciliationId(scope.stepId))
    && (scope.rootInputId === undefined || scope.rootInputId === null || steeringReconciliationId(scope.rootInputId))
}
export function steeringReconciliationIdempotencyKey(scope: TaskGraphExecutionScope, callId: string): string | null {
  if (!validSteeringReconciliationScope(scope) || !steeringReconciliationId(callId)) return null
  const identity = JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.stepId, callId])
  return `agent.plan.reconciliation:sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`
}
export function validSteeringReconciliationToolCall(event: Row, item: Row, scope: TaskGraphReadScope, stepId: string,
  decision: "keep" | "revise", expectedRevision: number): boolean {
  const call = record(event.payload), content = record(item.content), input = record(content?.input)
  const toolName = decision === "keep" ? "agent.reconcile" : "agent.plan"
  const callId = call?.toolCallId
  const expectedInputKeys = decision === "keep" ? "decision,expectedRevision" : "expectedRevision,nodes"
  const scoped: TaskGraphExecutionScope = { ...scope, stepId }
  const executionIdentity = { kind: "turn" as const, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: new Date(0) }
  return Boolean(steeringReconciliationId(callId) && validSteeringReconciliationScope(scoped)
    && event.type === "tool_call.started" && event.actor === "orchestrator" && event.taskId === scope.rootTaskId
    && event.itemId === item.id && event.correlationId === callId
    && event.idempotencyKey === `${executionKey(executionIdentity)}:event:tool-started:${callId}`
    && call && Object.keys(call).sort().join(",") === "taskId,toolCallId,toolName"
    && call.toolCallId === callId && call.toolName === toolName && call.taskId === scope.rootTaskId
    && item.stepId === stepId && item.taskId === scope.rootTaskId && item.type === "tool_call"
    && content?.toolCallId === callId && content.toolName === toolName && content.toolVersion === "1" && input
    && Object.keys(input).sort().join(",") === expectedInputKeys && input.expectedRevision === expectedRevision
    && (decision === "keep" ? input.decision === "keep" : Array.isArray(input.nodes) && input.nodes.length > 0))
}
export function parseSteeringReconciliationReceipt(value: unknown, expected?: SteeringReconciliationScope): SteeringReconciliationReceipt | null {
  try {
    const row = record(value)
    if (!row || !exact(row, ["schemaVersion", "sessionId", "turnId", "rootTaskId", "stepId", "decision", "observedRevision", "resultingRevision", "steerInputIds", "inputCheckpoint"])
      || row.schemaVersion !== STEERING_RECONCILIATION_SCHEMA_VERSION || !steeringReconciliationId(row.sessionId)
      || !steeringReconciliationId(row.turnId) || !steeringReconciliationId(row.rootTaskId) || !steeringReconciliationId(row.stepId)
      || row.decision !== "keep" && row.decision !== "revise" || !steeringReconciliationRevision(row.observedRevision)
      || !steeringReconciliationRevision(row.resultingRevision)
      || row.resultingRevision !== (row.decision === "keep" ? row.observedRevision : row.observedRevision + 1)
      || !Array.isArray(row.steerInputIds)) return null
    const inputIds = row.steerInputIds as unknown[]
    if (inputIds.length === 0 || inputIds.length > STEERING_RECONCILIATION_MAX_UNRESOLVED_INPUTS || !inputIds.every(steeringReconciliationId)
      || new Set(inputIds).size !== inputIds.length || inputIds.some((id, index) => index > 0 && String(inputIds[index - 1]) >= id)) return null
    const checkpoint = record(row.inputCheckpoint)
    if (!checkpoint || !exact(checkpoint, ["throughSequence"]) || steeringReconciliationSequence(checkpoint.throughSequence) === null) return null
    if (expected && (row.sessionId !== expected.sessionId || row.turnId !== expected.turnId || row.rootTaskId !== expected.rootTaskId
      || expected.stepId !== undefined && row.stepId !== expected.stepId)) return null
    const receipt = row as unknown as SteeringReconciliationReceipt
    return Buffer.byteLength(JSON.stringify(receipt), "utf8") <= MAX_BYTES ? receipt : null
  } catch { return null }
}
