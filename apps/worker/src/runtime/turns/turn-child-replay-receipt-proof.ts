import { canonicalJson, redactSensitiveText } from "@jobcopilot/shared"
import type { TaskExecutionOwnerFence } from "../execution-owner.js"
import type { ChildToolReplayReceipt, ChildWaitReplayReceipt } from "./turn-execution-options.js"

type Row = Record<string, unknown>

export function childReplayReceiptMatchesObservation(
  receipt: unknown,
  owner: TaskExecutionOwnerFence,
  callId: string,
  content: Record<string, unknown>,
  observationId: string,
  waitProof: boolean,
): boolean {
  const value = object(receipt), result = object(value?.result), callItem = object(value?.callItem), resultItem = object(value?.resultItem)
  if (!value || !result || !callItem || !resultItem || value.userId !== owner.userId || value.sessionId !== owner.sessionId
    || value.turnId !== owner.turnId || value.rootTaskId !== owner.rootTaskId || value.taskId !== owner.taskId
    || !Number.isSafeInteger(value.attempt) || (value.attempt as number) < 1 || (value.attempt as number) > owner.attemptCount
    || !validText(value.stepId) || value.toolCallId !== callId || value.toolName !== content.toolName || !validText(value.toolName)
    || !Object.hasOwn(content, "input") || !Object.hasOwn(content, "output") || !Object.hasOwn(result, "output")
    || !validText(callItem.id) || !validText(resultItem.id) || callItem.id === resultItem.id
    || !validRevision(callItem.revision) || !validRevision(resultItem.revision)) return false
  const status = result.status, waitReceipt = value.toolName === "wait_subagents"
  if (waitReceipt !== waitProof || status !== "completed" && status !== "failed"
    || status === "completed" && result.errorCode !== null || status === "failed" && !validErrorCode(result.errorCode)) return false
  if (waitReceipt && !validWaitReceipt(value, result, callItem, resultItem)) return false
  const historical = observationId === `child-resume:${resultItem.id}`
  if (!historical && observationId !== `tool-result:${callId}`) return false
  const observedInput = waitReceipt ? object(value.source)?.input : value.input
  if (content.status !== status || !sameJson(content.input, observedInput) || !sameJson(content.output, result.output)) return false
  return status === "failed" && historical ? content.errorCode === "tool_execution_failed" : content.errorCode === result.errorCode
}

export function childReplayReceiptMatchesInput(
  receipt: ChildToolReplayReceipt | ChildWaitReplayReceipt,
  input: unknown,
): boolean {
  return sameJson(input, replayInput(receipt))
}

function validWaitReceipt(value: Row, result: Row, callItem: Row, resultItem: Row): boolean {
  const source = object(value.source)
  if (!source) return false
  const persisted = object(source.persistedResult), output = object(result.output)
  if (!persisted || !output) return false
  const oldOutput = object(persisted.output)
  if (!oldOutput) return false
  return value.toolName === "wait_subagents" && validText(value.waitId) && output?.waitId === value.waitId
    && ["ready", "timed_out"].includes(String(output.status)) && source?.attempt === value.attempt && source.stepId === value.stepId
    && source.toolCallId === value.toolCallId && source.sourceItemId === resultItem.id
    && sameJson(source.callItem, callItem) && sameJson(source.resultItem, resultItem) && waitInputMatches(value.input, source.input)
    && persisted?.status === "completed" && persisted.errorCode === null && oldOutput?.status === "waiting" && oldOutput.waitId === value.waitId
    && validRevision(source.ordinal) && validText(source.continuationStepId) && validRevision(source.continuationOrdinal)
    && Number(source.continuationOrdinal) > Number(source.ordinal)
}

function replayInput(receipt: ChildToolReplayReceipt | ChildWaitReplayReceipt): unknown {
  return receipt.toolName === "wait_subagents" && "source" in receipt
    ? (receipt as ChildWaitReplayReceipt).source.input : receipt.input
}

function waitInputMatches(rawValue: unknown, safeValue: unknown): boolean {
  const raw = object(rawValue), safe = object(safeValue), keys = ["idempotencyKey", "mode", "taskIds", "timeoutMs"]
  if (!raw || !safe || !sameJson(Object.keys(raw).sort(), keys) || !sameJson(Object.keys(safe).sort(), keys)) return false
  return typeof raw.idempotencyKey === "string" && !!raw.idempotencyKey.trim() && raw.idempotencyKey.length <= 256
    && typeof safe.idempotencyKey === "string" && !!safe.idempotencyKey.trim() && safe.idempotencyKey.length <= 256
    && redactSensitiveText(raw.idempotencyKey) === safe.idempotencyKey && sameJson(raw.taskIds, safe.taskIds)
    && raw.mode === safe.mode && raw.timeoutMs === safe.timeoutMs
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim().length > 0
}

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validErrorCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}

function object(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Row
    : null
}
