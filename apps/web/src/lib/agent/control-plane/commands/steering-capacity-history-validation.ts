import { createHash } from "node:crypto"
import { redactSensitiveText } from "@jobcopilot/shared"
import { AgentCommandError } from "./errors"

export type Row = Record<string, unknown>
export type Candidate = { id: string; acceptedSequence: bigint; status: "accepted" | "queued" | "consumed"; consumedByStepId: string | null; consumer: { ordinal: number; attempt: number } | null }
export type Step = { id: string; taskId: string | null; ordinal: number; attempt: number; status: string; cursor: bigint; ids: string[] }
export type Receipt = { sessionId: string; turnId: string; rootTaskId: string; stepId: string; decision: "keep" | "revise"; observedRevision: number; resultingRevision: number; steerInputIds: string[]; through: bigint; supersession?: { operationKey: string; observedRevision: number; cancellationRevision: number; resultingRevision: number; source: { nodeKey: string; taskId: string }; replacement: { nodeKey: string; taskId: string }; cancellationEvent: { id: string; sequence: bigint }; planEvent: { id: string; sequence: bigint; idempotencyKey: string }; replacementFingerprint: string; agentPlanCall: { callId: string; stepId: string; expectedRevision: number; replaceUnstarted: { nodeKey: string } } } }
export type Supersession = NonNullable<Receipt["supersession"]>
export type StoredReceipt = { receipt: Receipt; sequence: bigint; idempotencyKey: string; finalReplacement?: Row }
export type Cursor = { sequence: bigint; id: string }
export const MAX_UNRESOLVED_STEERING_INPUTS = 128

const MAX_SEQUENCE = BigInt("9223372036854775807")
const STEP_STATUSES = new Set(["streaming", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "completed", "failed", "interrupted"])
const INPUT_STATUSES = new Set(["accepted", "queued", "consumed", "cancelled", "rejected"])
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : null
}
export function exact(row: Row, keys: readonly string[]): boolean { return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) }
export function id(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
export function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value >= BigInt(0) && value <= MAX_SEQUENCE ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return null
  return BigInt(value) <= MAX_SEQUENCE ? BigInt(value) : null
}
export function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
export function graphItemId(rootTaskId: string): string { return "task-graph-" + createHash("sha256").update(rootTaskId).digest("hex") }
export function failClosed(): never { throw new AgentCommandError("invalid_command", "The current Turn's steering history could not be validated", 409) }

export function rootClientMessageId(value: unknown): string | null | undefined {
  const envelope = object(value), nested = object(envelope?.input), source = nested && Object.keys(nested).length ? nested : envelope
  return !source || !Object.hasOwn(source, "clientMessageId") ? undefined : id(source.clientMessageId) ? source.clientMessageId : null
}

export function parseSupersession(value: unknown, rootTaskId: string): Supersession | null {
  const row = object(value), source = object(row?.source), replacement = object(row?.replacement), cancellation = object(row?.cancellationEvent), plan = object(row?.planEvent), call = object(row?.agentPlanCall), replace = object(call?.replaceUnstarted)
  const seq = (candidate: unknown) => typeof candidate === "string" && /^[1-9][0-9]{0,18}$/.test(candidate) ? sequence(candidate) : null
  if (!row || !exact(row, ["schemaVersion", "operationKey", "observedRevision", "cancellationRevision", "resultingRevision", "source", "replacement", "cancellationEvent", "planEvent", "replacementFingerprint", "agentPlanCall"]) || row.schemaVersion !== "agent-harness.v2.task-graph-supersession.v2" || typeof row.operationKey !== "string" || !/^agent\.plan\.reconciliation:sha256:[a-f0-9]{64}$/.test(row.operationKey) || !Number.isSafeInteger(row.observedRevision) || Number(row.observedRevision) < 0 || Number(row.observedRevision) > Number.MAX_SAFE_INTEGER - 2 || row.cancellationRevision !== Number(row.observedRevision) + 1 || row.resultingRevision !== Number(row.observedRevision) + 2) return null
  if (!source || !exact(source, ["nodeKey", "taskId"]) || !id(source.nodeKey) || source.nodeKey.length > 128 || !id(source.taskId) || !replacement || !exact(replacement, ["nodeKey", "taskId"]) || !id(replacement.nodeKey) || replacement.nodeKey.length > 128 || !id(replacement.taskId) || source.nodeKey === replacement.nodeKey || source.taskId === replacement.taskId) return null
  if (!cancellation || !exact(cancellation, ["id", "sequence"]) || !id(cancellation.id) || !plan || !exact(plan, ["id", "sequence", "idempotencyKey"]) || !id(plan.id) || plan.idempotencyKey !== `${graphItemId(rootTaskId)}:supersession:${row.observedRevision}` || cancellation.id === plan.id || seq(cancellation.sequence) === null || seq(plan.sequence) === null || seq(cancellation.sequence)! >= seq(plan.sequence)! || typeof row.replacementFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.replacementFingerprint)) return null
  if (!call || !exact(call, ["callId", "stepId", "expectedRevision", "replaceUnstarted"]) || !id(call.callId) || !id(call.stepId) || call.expectedRevision !== row.observedRevision || !replace || !exact(replace, ["nodeKey"]) || replace.nodeKey !== source.nodeKey) return null
  return { operationKey: row.operationKey, observedRevision: Number(row.observedRevision), cancellationRevision: Number(row.cancellationRevision), resultingRevision: Number(row.resultingRevision), source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacement: { nodeKey: replacement.nodeKey, taskId: replacement.taskId }, cancellationEvent: { id: cancellation.id, sequence: seq(cancellation.sequence)! }, planEvent: { id: plan.id, sequence: seq(plan.sequence)!, idempotencyKey: plan.idempotencyKey as string }, replacementFingerprint: row.replacementFingerprint, agentPlanCall: { callId: call.callId, stepId: call.stepId, expectedRevision: Number(call.expectedRevision), replaceUnstarted: { nodeKey: replace.nodeKey as string } } }
}

export function parseReceipt(value: unknown, sessionId: string, turnId: string, rootTaskId: string): Receipt | null {
  const row = object(value), v2 = row?.schemaVersion === "agent-harness.v2.plan-reconciliation.v2", supersession = v2 ? parseSupersession(row.supersession, rootTaskId) : null
  const keys = ["schemaVersion", "sessionId", "turnId", "rootTaskId", "stepId", "decision", "observedRevision", "resultingRevision", "steerInputIds", "inputCheckpoint", ...(v2 ? ["supersession"] : [])]
  if (!row || !exact(row, keys) || row.schemaVersion !== (v2 ? "agent-harness.v2.plan-reconciliation.v2" : "agent-harness.v2.plan-reconciliation.v1")
    || v2 !== Boolean(supersession) || row.sessionId !== sessionId || row.turnId !== turnId || row.rootTaskId !== rootTaskId || !id(row.stepId)
    || row.decision !== "keep" && row.decision !== "revise" || !Number.isSafeInteger(row.observedRevision) || Number(row.observedRevision) < 0 || !Number.isSafeInteger(row.resultingRevision) || Number(row.resultingRevision) < 0
    || row.resultingRevision !== (v2 ? Number(row.observedRevision) + 2 : row.decision === "keep" ? row.observedRevision : Number(row.observedRevision) + 1)
    || v2 && (row.decision !== "revise" || supersession!.observedRevision !== row.observedRevision || supersession!.resultingRevision !== row.resultingRevision || supersession!.agentPlanCall.stepId !== row.stepId)
    || !Array.isArray(row.steerInputIds)) return null
  const steerInputIds = row.steerInputIds, checkpoint = object(row.inputCheckpoint), through = checkpoint && exact(checkpoint, ["throughSequence"]) ? sequence(checkpoint.throughSequence) : null
  if (steerInputIds.length === 0 || steerInputIds.length > MAX_UNRESOLVED_STEERING_INPUTS || !steerInputIds.every(id) || new Set(steerInputIds).size !== steerInputIds.length
    || steerInputIds.some((candidate, index) => index > 0 && String(steerInputIds[index - 1]) >= candidate) || through === null) return null
  try { if (new TextEncoder().encode(JSON.stringify(row)).byteLength > 16 * 1024) return null } catch { return null }
  return { sessionId, turnId, rootTaskId, stepId: row.stepId, decision: row.decision, observedRevision: Number(row.observedRevision), resultingRevision: Number(row.resultingRevision), steerInputIds: steerInputIds as string[], through, ...(v2 ? { supersession: supersession! } : {}) }
}

export function stepFrom(row: Row): Step | null {
  const cursor = sequence(row.inputThroughSequence), parsedIds = typeof row.consumedInputIds === "string" ? (() => { try { return JSON.parse(row.consumedInputIds) as unknown } catch { return null } })() : row.consumedInputIds
  if (!id(row.id) || !(row.taskId === null || id(row.taskId)) || !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0 || !Number.isSafeInteger(row.attempt) || Number(row.attempt) < 1
    || typeof row.status !== "string" || !STEP_STATUSES.has(row.status) || cursor === null || !Array.isArray(parsedIds) || parsedIds.length > 256 || new Set(parsedIds).size !== parsedIds.length || !parsedIds.every(id)) return null
  return { id: row.id, taskId: row.taskId as string | null, ordinal: Number(row.ordinal), attempt: Number(row.attempt), status: row.status, cursor, ids: parsedIds as string[] }
}

export function acceptedSource(row: Row, scope: { sessionId: string; userId: string; turnId: string }): "user" | "automation" | "system" | null {
  const payload = object(row.acceptedPayload), item = object(row.acceptedItemContent), source = payload?.source
  const acceptedSequence = sequence(row.acceptedSequence), eventSequence = sequence(row.acceptedEventSequence)
  const canonicalInputId = typeof row.id === "string" && UUID_V4.test(row.id)
  const projectedInputId = payload?.inputId === row.id || canonicalInputId && payload?.inputId === redactSensitiveText(row.id as string)
  if (!payload || !item || !exact(payload, ["clientMessageId", "delivery", "disposition", "inputId", "source"])
    || row.inputSessionId !== scope.sessionId || row.inputTargetTurnId !== scope.turnId || row.inputUserId !== scope.userId
    || row.acceptedType !== "input.accepted" || !id(row.acceptedEventId) || row.acceptedEventSessionId !== scope.sessionId || row.acceptedEventTurnId !== scope.turnId
    || row.acceptedEventTaskId !== null || row.acceptedEventCausationId !== null || row.acceptedEventCorrelationId !== scope.turnId
    || acceptedSequence === null || eventSequence !== acceptedSequence || row.acceptedItemId !== row.acceptedItemRowId || !id(row.acceptedItemId)
    || row.acceptedItemSessionId !== scope.sessionId || row.acceptedItemTurnId !== scope.turnId || row.acceptedItemStepId !== null
    || row.acceptedItemType !== "user_message" || row.acceptedItemTaskId !== null || row.acceptedItemStatus !== "completed"
    || !canonicalInputId || !projectedInputId || typeof row.clientMessageId !== "string" || payload.clientMessageId !== redactSensitiveText(row.clientMessageId)
    || payload.delivery !== row.delivery || !["steer", "follow_up"].includes(String(row.delivery))
    || typeof payload.disposition !== "string" || !["started", "steered", "queued_follow_up", "duplicate", "interrupted"].includes(payload.disposition)
    || source !== "user" && source !== "automation" && source !== "system"
    || row.acceptedActor !== (source === "user" ? "user" : "system")
    || !exact(item, ["clientMessageId", "disposition", "parts", "source"]) || item.clientMessageId !== row.clientMessageId
    || item.source !== source || item.disposition !== payload.disposition || !Array.isArray(item.parts)
    || canonicalJson(item.parts) !== canonicalJson(row.inputContent)) return null
  return source
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  const row = object(value)
  return row ? "{" + Object.keys(row).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(row[key])).join(",") + "}" : JSON.stringify(value) ?? "null"
}
