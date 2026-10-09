import { randomUUID } from "node:crypto"
import { signalWasInterrupted } from "../interrupt/registry.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { TurnQuestionStoreError, parseTurnQuestionArguments, parseTurnQuestionIntentEnvelope, type TurnQuestionRecovery } from "./turn-question-contract.js"
import { toRepositoryJson, TurnEngineError, type ToolCallRecovery, type TurnEngineResult, type TurnEngineStep, type TurnEngineToolCall, type TurnEngineToolResult } from "./turn-engine-types.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import { executionId, type TurnExecutionIdentity, type TurnExecutionOptions } from "./turn-execution-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { assertExecutionAlive } from "./turn-engine-helpers.js"
import { OrphanPauseUsageRecoveredError } from "./turn-question-store-events.js"

export class PreparedQuestionRetryError extends Error {
  readonly code = "prepared_question_wait_retry_required"
  constructor() { super("Prepared user question requires a durable wait retry"); this.name = "PreparedQuestionRetryError" }
}

export function isPreparedQuestionRetryError(error: unknown): error is PreparedQuestionRetryError {
  return error instanceof PreparedQuestionRetryError
}

export class TurnStateRefreshRetryError extends Error {
  readonly code = "turn_state_refresh_retry_required"
  constructor() { super("Durable Turn state changed; reload it before replanning"); this.name = "TurnStateRefreshRetryError" }
}

export function isTurnStateRefreshRetryError(error: unknown): error is TurnStateRefreshRetryError {
  return error instanceof TurnStateRefreshRetryError
}

export function nativeQuestionCallId(output: ModelStepResult, identity: TurnExecutionIdentity): string | null {
  const asks = output.toolCalls.filter(call => call.name === "agent.ask_user")
  if (asks.length === 0) return null
  if (identity.kind !== "turn" || identity.taskId !== identity.rootTaskId || output.toolCalls.length !== 1
    || output.finishReason !== "tool_calls" || !output.usage || !parseTurnQuestionArguments(asks[0]?.arguments)) {
    throw new TurnEngineError("invalid_output", "Native user question call is not valid for this root model step")
  }
  return asks[0]!.id
}

export function nativeQuestionResultMatches(input: unknown, output: unknown): boolean {
  const expected = parseTurnQuestionArguments(input), receipt = parseTurnQuestionIntentEnvelope(output)
  return expected !== null && receipt !== null && JSON.stringify(expected) === JSON.stringify(receipt)
}

export function rejectQuestionReplay(toolName: string): void {
  if (toolName === "agent.ask_user") throw new TurnEngineError("invalid_output", "A persisted question call cannot be replayed as a new question")
}

export function nativeQuestionResultCall(stepId: string, call: TurnEngineToolCall, result: TurnEngineToolResult): { readonly stepId: string; readonly toolCallId: string } | null {
  if (call.name !== "agent.ask_user") return null
  if (result.status !== "completed" || result.errorCode !== null || !nativeQuestionResultMatches(call.arguments, result.output)) {
    throw new TurnEngineError("invalid_output", "Native user question result is invalid")
  }
  return { stepId, toolCallId: call.id }
}

export async function executeNativeQuestionTool(
  options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep,
  call: TurnEngineToolCall, output: ModelStepResult, now: () => Date, onCallPersisted: () => void,
): Promise<TurnEngineToolResult> {
  if (call.id !== nativeQuestionCallId(output, options.identity) || !options.store.stageQuestionUsage) {
    throw new TurnEngineError("invalid_output", "Native question usage store is unavailable")
  }
  const callItemId = options.idFactory?.(executionId(options.identity, `item:tool-call:${call.id}`))
    ?? `${executionId(options.identity, `item:tool-call:${call.id}`)}:${randomUUID()}`
  const callItem = await writer.startItem({ id: callItemId, stepId: step.id, type: "tool_call", phase: null,
    content: { toolCallId: call.id, toolName: call.name, toolVersion: "1", input: toRepositoryJson(call.arguments) }, now: now() })
  onCallPersisted()
  await writer.append("tool_call.started", call.id, callItem.id, { toolCallId: call.id, toolName: call.name, taskId: options.identity.taskId }, `tool-started:${call.id}`)
  await options.store.stageQuestionUsage({ identity: options.identity, stepId: step.id, toolCallId: call.id,
    finishReason: output.finishReason, usage: output.usage!, now: now() })
  assertExecutionAlive(options, options.signal ?? new AbortController().signal)
  let result: TurnEngineToolResult
  try {
    result = await options.executeTool({ scope: options.scope, sessionId: options.identity.sessionId, turnId: options.identity.turnId,
      stepId: step.id, taskId: options.identity.taskId, rootTaskId: options.identity.rootTaskId, actorRole: options.actorRole,
      signal: options.signal ?? new AbortController().signal, capabilities: options.capabilities,
      call: { id: call.id, toolName: call.name, toolVersion: "1", input: call.arguments } })
  } catch (error: unknown) {
    if (signalWasInterrupted(options.signal ?? new AbortController().signal) || isSessionPauseRequestedError(error)) throw error
    result = { id: call.id, toolName: call.name, toolVersion: "1", status: "failed", errorCode: "tool_execution_failed" }
  }
  await writer.completeItem(callItem, { toolCallId: call.id, toolName: call.name, toolVersion: result.toolVersion,
    status: result.status, errorCode: result.errorCode, input: toRepositoryJson(call.arguments) }, now(), `tool-call-completed:${call.id}`)
  await writer.append(result.status === "completed" ? "tool_call.completed" : "tool_call.failed", call.id, callItem.id,
    { toolCallId: call.id, toolName: call.name, status: result.status, errorCode: result.errorCode, taskId: options.identity.taskId }, `tool-finished:${call.id}`)
  const resultItem = await writer.startItem({ id: options.idFactory?.(executionId(options.identity, `item:tool-result:${call.id}`))
      ?? `${executionId(options.identity, `item:tool-result:${call.id}`)}:${randomUUID()}`, stepId: step.id, type: "tool_result", phase: null,
    content: { toolCallId: call.id, output: toRepositoryJson(result.output ?? null), errorCode: result.errorCode }, now: now() })
  await writer.completeItem(resultItem, { toolCallId: call.id, output: toRepositoryJson(result.output ?? null), errorCode: result.errorCode }, now(), `tool-result-completed:${call.id}`)
  return result
}

function retryableStoreFailure(options: TurnExecutionOptions, error: unknown): boolean {
  const signal = options.signal ?? new AbortController().signal
  return !isSessionPauseRequestedError(error) && !signalWasInterrupted(signal)
    && !signal.aborted && !options.isOwnershipLost?.(error, signal)
    && !(error instanceof TurnQuestionStoreError)
}

async function commitQuestion(
  options: TurnExecutionOptions, stepId: string, toolCallId: string, now: () => Date,
): Promise<TurnEngineResult> {
  if (!options.store.waitForQuestion) throw new TurnEngineError("invalid_output", "Native question wait store is unavailable")
  try {
    const receipt = await options.store.waitForQuestion({ identity: options.identity, stepId, toolCallId, now: now() })
    if (receipt.status === "answered") throw new PreparedQuestionRetryError()
    return { status: "waiting_for_user", waitId: receipt.waitId, stepCount: 0, toolCallCount: 0 }
  } catch (error: unknown) {
    if (isPreparedQuestionRetryError(error) || !retryableStoreFailure(options, error)) throw error
    throw new PreparedQuestionRetryError()
  }
}

export async function readPendingNativeQuestion(options: TurnExecutionOptions, now: () => Date): Promise<TurnQuestionRecovery | null> {
  if (options.identity.kind !== "turn" || !options.store.readPendingQuestion) return null
  try { return await options.store.readPendingQuestion({ identity: options.identity, now: now() }) }
  catch (error: unknown) {
    if (error instanceof OrphanPauseUsageRecoveredError) throw new TurnStateRefreshRetryError()
    if (!retryableStoreFailure(options, error)) throw error
    throw new PreparedQuestionRetryError()
  }
}

export async function recoverableNativeQuestionCalls(
  options: TurnExecutionOptions, calls: readonly ToolCallRecovery[], now: () => Date,
): Promise<readonly ToolCallRecovery[]> {
  if (!calls.some(item => item.call.name === "agent.ask_user")) return calls
  const pending = await readPendingNativeQuestion(options, now)
  if (pending?.status === "replayable") {
    const matching = calls.filter(item => item.call.name === "agent.ask_user" && item.call.id === pending.toolCallId
      && item.stepId === pending.stepId && item.callItem.id === pending.callItemId && item.toolVersion === "1"
      && nativeQuestionResultMatches(item.call.arguments, pending.intent)
      && (item.action === "replay" && item.durableResult == null
        || item.action === "reconcile" && item.durableResult?.status === "completed" && item.durableResult.errorCode === null
          && nativeQuestionResultMatches(item.call.arguments, item.durableResult.output)))
    if (matching.length !== 1) throw new TurnStateRefreshRetryError()
    return calls
  }
  return pending?.status === "none"
    ? calls.filter(item => item.call.name !== "agent.ask_user")
    : calls
}

export async function recoverPendingNativeQuestion(
  options: TurnExecutionOptions, now: () => Date, stepCount: number, toolCallCount: number,
  recovered?: TurnQuestionRecovery | null,
): Promise<TurnEngineResult | null> {
  const pending = recovered === undefined ? await readPendingNativeQuestion(options, now) : recovered
  if (!pending) return null
  if (pending.status === "replayable") throw new TurnStateRefreshRetryError()
  if (pending.status === "none" || pending.status === "answered") return null
  if (pending.status === "closed" || pending.status === "not_current") {
    throw new TurnQuestionStoreError("question_not_current", "Native question is no longer current")
  }
  if (pending.status === "waiting") return { status: "waiting_for_user", waitId: pending.waitId, stepCount, toolCallCount }
  const result = await commitQuestion(options, pending.stepId, pending.toolCallId, now)
  return { ...result, stepCount, toolCallCount }
}

export function questionWaitResult(
  options: TurnExecutionOptions, stepId: string, toolCallId: string, now: () => Date,
  stepCount: number, toolCallCount: number,
): Promise<TurnEngineResult> {
  return commitQuestion(options, stepId, toolCallId, now).then(result => ({ ...result, stepCount, toolCallCount }))
}
