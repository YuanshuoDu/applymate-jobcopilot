import { randomUUID } from "node:crypto"
import { TurnEngineError, toRepositoryJson, type ToolCallRecovery, type TurnEngineToolResult } from "./turn-engine-types.js"
import { executionId, type ExecutionItemHandle, type TurnExecutionOptions } from "./turn-execution-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { readTrustedNativeQuestionAttestation } from "./native-question-attestation.js"

function itemId(options: TurnExecutionOptions, prefix: string): string {
  const scoped = executionId(options.identity, prefix)
  return options.idFactory?.(scoped) ?? `${scoped}:${randomUUID()}`
}

/** Persists recovered tool results; native question proof stays private to the result item. */
export async function persistRecoveredToolCall(
  options: TurnExecutionOptions, writer: TurnExecutionEventWriter, recovery: ToolCallRecovery,
  result: TurnEngineToolResult, now: () => Date,
): Promise<TurnEngineToolResult> {
  const nativeQuestion = recovery.call.name === "agent.ask_user"
  let persistedResult = result
  let nativeQuestionAttestation: ReturnType<typeof readTrustedNativeQuestionAttestation> = null
  if (nativeQuestion) {
    const identity = options.identity
    if (identity.kind !== "turn" || identity.taskId !== identity.rootTaskId || recovery.toolVersion !== "1" || result.id !== recovery.call.id
      || result.toolName !== "agent.ask_user" || result.toolVersion !== "1") {
      throw new TurnEngineError("invalid_output", "Native user question recovery identity is invalid")
    }
    if (result.status === "completed") {
      nativeQuestionAttestation = readTrustedNativeQuestionAttestation(result.nativeQuestionReceipt, {
        userId: identity.userId, sessionId: identity.sessionId, turnId: identity.turnId, stepId: recovery.stepId, taskId: identity.taskId,
      }, recovery.call.id, recovery.call.arguments)
      if (!nativeQuestionAttestation || result.errorCode !== null) {
        throw new TurnEngineError("invalid_output", "Native user question recovery receipt is invalid")
      }
    }
    persistedResult = { ...result, output: nativeQuestionAttestation ? { question: "[REDACTED]", choices: [] } : null }
  }
  const callItem: ExecutionItemHandle = { id: recovery.callItem.id, type: "tool_call", phase: null, revision: recovery.callItem.revision }
  const callContent = {
    toolCallId: recovery.call.id, toolName: recovery.call.name, toolVersion: recovery.toolVersion,
    status: persistedResult.status, errorCode: persistedResult.errorCode, input: toRepositoryJson(recovery.call.arguments),
  }
  const callEventContent = nativeQuestion
    ? { toolCallId: recovery.call.id, toolName: recovery.call.name, toolVersion: recovery.toolVersion, status: persistedResult.status, errorCode: persistedResult.errorCode }
    : callContent
  await writer.completeItem(callItem, callContent, now(), `tool-call-recovered:${recovery.call.id}`, callEventContent)
  await writer.append(persistedResult.status === "completed" ? "tool_call.completed" : "tool_call.failed", recovery.call.id, callItem.id, {
    toolCallId: recovery.call.id, toolName: recovery.call.name, toolVersion: persistedResult.toolVersion, status: persistedResult.status,
    errorCode: persistedResult.errorCode, taskId: options.identity.taskId,
  }, `tool-recovered:${recovery.call.id}`)
  const resultContent = { toolCallId: recovery.call.id, output: toRepositoryJson(persistedResult.output ?? null), errorCode: persistedResult.errorCode,
    ...(nativeQuestionAttestation ? { nativeQuestionAttestation: toRepositoryJson(nativeQuestionAttestation) } : {}) }
  const resultEventContent = { toolCallId: recovery.call.id, output: toRepositoryJson(persistedResult.output ?? null), errorCode: persistedResult.errorCode }
  const resultItem: ExecutionItemHandle = recovery.resultItem
    ? { id: recovery.resultItem.id, type: "tool_result", phase: null, revision: recovery.resultItem.revision }
    : await writer.startItem({ id: itemId(options, `item:tool-result:${recovery.call.id}`), stepId: recovery.stepId, type: "tool_result", phase: null, content: resultContent, now: now() })
  await writer.completeItem(resultItem, resultContent, now(), `tool-result-recovered:${recovery.call.id}`, resultEventContent)
  return persistedResult
}
