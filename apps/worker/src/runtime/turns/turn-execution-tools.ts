import type { ModelStepResult } from "./turn-engine-model.js"
import { findToolResultObservation, stableJson } from "./turn-engine-replay.js"
import { toRepositoryJson, TurnEngineError, type TurnEngineResult, type TurnEngineStep, type ToolCallRecovery } from "./turn-engine-types.js"
import { executeToolWithItems, persistRecoveredToolCall, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { assertExecutionAlive } from "./turn-engine-helpers.js"
import type { StepContext } from "../context/step-context-builder.js"
import type { SteeringMarkerPayload } from "../context/steering-marker.js"

type MarkerState = { readonly active: readonly SteeringMarkerPayload[] } | undefined
type ToolOutcome = { readonly wait: TurnEngineResult | null; readonly snapshot: TurnExecutionOptions["snapshot"]; readonly steeringMarkerState: MarkerState }

export function hasFreshSteering(context: StepContext, consumedInputIds: readonly string[]): boolean {
  if (context.steeringMarkerControl && (context.steeringMarkerControl.activeInputIds.length > 0 || context.steeringMarkerControl.newlyObservedInputIds.length > 0)) return true
  const consumedBeforeBuild = new Set(consumedInputIds)
  const newlyConsumed = new Set(context.consumedInputIds.filter(inputId => !consumedBeforeBuild.has(inputId)))
  return context.blocks.some(block => {
    if (block.layer !== "pending_input" || block.role !== "data" || block.source !== "user_input" || block.trust !== "external_untrusted") return false
    const content = block.content
    if (!content || typeof content !== "object" || Array.isArray(content)) return false
    const inputId = content.inputId
    return typeof inputId === "string" && inputId.trim().length > 0 && newlyConsumed.has(inputId)
  })
}

export function rememberSteeringMarkers(current: MarkerState, additions: readonly SteeringMarkerPayload[]): MarkerState {
  const byKey = new Map<string, SteeringMarkerPayload>()
  for (const marker of [...current?.active ?? [], ...additions]) byKey.set(marker.idempotencyKey, marker)
  return { active: [...byKey.values()].sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey)) }
}

export async function executeTools(
  options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep, output: ModelStepResult,
  initial: TurnExecutionOptions["snapshot"], seen: Set<string>, signal: AbortSignal, now: () => Date, markerState: MarkerState,
  onToolCallPersisted: () => void,
): Promise<ToolOutcome> {
  let snapshot = initial
  for (const call of output.toolCalls) {
    assertExecutionAlive(options, signal)
    if (seen.has(call.id)) throw new TurnEngineError("invalid_output", `Tool call ${call.id} was repeated in the Turn`)
    seen.add(call.id)
    const replayed = findToolResultObservation(snapshot, call.id)
    if (replayed) {
      if (replayed.toolName !== call.name || stableJson(replayed.input) !== stableJson(call.arguments)) throw new TurnEngineError("invalid_output", `Tool call ${call.id} does not match its persisted replay record`)
      const wait = dependencyWaitReceipt(replayed.status === "completed" ? replayed.output : null)
      if (wait && !hasResolvedWaitOutcome(snapshot, wait.waitId, replayed.input)) return { wait: { status: "waiting_for_dependency", waitId: wait.waitId, stepCount: 0, toolCallCount: 0 }, snapshot, steeringMarkerState: markerState }
      continue
    }
    const result = await executeToolWithItems(options, writer, step, call, now, onToolCallPersisted)
    assertExecutionAlive(options, signal)
    if (result.status === "failed" && result.errorCode === "policy_requires_approval") return { wait: { status: "waiting_for_approval", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot, steeringMarkerState: markerState }
    if (result.status === "failed" && (result.errorCode === "policy_requires_user_input" || result.errorCode === "gmail_oauth_required")) return { wait: { status: "waiting_for_user", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot, steeringMarkerState: markerState }
    snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, { id: `tool-result:${call.id}`, content: toRepositoryJson({ toolCallId: call.id, toolName: call.name, input: call.arguments, status: result.status, output: result.output ?? null, errorCode: result.errorCode }) }] }
    const wait = dependencyWaitReceipt(result.status === "completed" ? result.output : null)
    if (wait) return { wait: { status: "waiting_for_dependency", waitId: wait.waitId, stepCount: 0, toolCallCount: 0 }, snapshot, steeringMarkerState: markerState }
  }
  return { wait: null, snapshot, steeringMarkerState: markerState }
}

export async function recoverPersistedToolCalls(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, now: () => Date): Promise<readonly { id: string; content: ReturnType<typeof toRepositoryJson> }[]> {
  const recovery = options.toolCallRecovery ?? []
  if (recovery.length === 0) return []
  const mustFailTurn = recovery.some(item => item.action === "fail" || item.action === "terminal")
  const observations: Array<{ id: string; content: ReturnType<typeof toRepositoryJson> }> = []
  for (const item of recovery) {
    let result = item.durableResult
    if (item.action === "replay" && !mustFailTurn) {
      assertExecutionAlive(options, options.signal ?? new AbortController().signal)
      try {
        result = await options.executeTool({
          scope: options.scope, sessionId: options.identity.sessionId, turnId: options.identity.turnId, stepId: item.stepId,
          taskId: options.identity.taskId, rootTaskId: options.identity.rootTaskId, actorRole: options.actorRole,
          signal: options.signal ?? new AbortController().signal, capabilities: options.capabilities,
          call: { id: item.call.id, toolName: item.call.name, toolVersion: item.toolVersion, input: item.call.arguments },
        })
      } catch (error: unknown) {
        if (options.signal?.aborted) throw error
        result = { id: item.call.id, toolName: item.call.name, toolVersion: item.toolVersion, status: "failed", errorCode: "tool_execution_failed" }
      }
    }
    if (!result) result = { id: item.call.id, toolName: item.call.name, toolVersion: item.toolVersion, status: "failed", errorCode: item.action === "replay" ? "tool_recovery_aborted" : "tool_result_replay_uncertain" }
    await persistRecoveredToolCall(options, writer, item, result, now)
    observations.push({ id: `tool-result:${item.call.id}`, content: toRepositoryJson({
      toolCallId: item.call.id, toolName: item.call.name, input: item.call.arguments, status: result.status, output: result.output ?? null, errorCode: result.errorCode,
    }) })
  }
  if (mustFailTurn) {
    const error = new Error("A persisted tool call has an ambiguous external result and cannot be replayed")
    Object.assign(error, { code: "tool_result_replay_uncertain" })
    throw error
  }
  return observations
}

type DependencyWaitReceipt = { readonly waitId: string; readonly deadlineAt: string; readonly matchedTaskIds: readonly string[] }
function dependencyWaitReceipt(value: unknown): DependencyWaitReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.status !== "waiting" || typeof record.waitId !== "string" || !record.waitId.trim() || typeof record.deadlineAt !== "string" || !record.deadlineAt.trim() || !Array.isArray(record.matchedTaskIds)) return null
  if (!record.matchedTaskIds.every(item => typeof item === "string" && item.trim().length > 0)) return null
  return { waitId: record.waitId, deadlineAt: record.deadlineAt, matchedTaskIds: record.matchedTaskIds }
}

type WaitMode = "any" | "all"
type WaitRequest = { readonly taskIds: readonly string[]; readonly mode: WaitMode }

function waitRequest(value: unknown): WaitRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const taskIds = normalizedWaitIds(record.taskIds)
  if (!taskIds || (record.mode !== "any" && record.mode !== "all")) return null
  return { taskIds, mode: record.mode }
}

function normalizedWaitIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) return null
  const ids: string[] = []
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || id.trim() !== id) return null
    ids.push(id)
  }
  if (new Set(ids).size !== ids.length) return null
  return [...ids].sort()
}

function hasResolvedWaitOutcome(snapshot: TurnExecutionOptions["snapshot"], waitId: string, expectedInput: unknown): boolean {
  const expected = waitRequest(expectedInput)
  if (!expected) return false
  return snapshot.toolObservations.some(observation => {
    if (observation.id !== `wait-result:${waitId}` || !observation.content || typeof observation.content !== "object" || Array.isArray(observation.content)) return false
    const content = observation.content as Record<string, unknown>
    if (content.toolCallId !== `wait:${waitId}` || content.toolName !== "agent.wait" || content.status !== "completed") return false
    const request = waitRequest(content.input)
    if (!request || request.mode !== expected.mode || request.taskIds.length !== expected.taskIds.length
      || request.taskIds.some((id, index) => id !== expected.taskIds[index])) return false
    const output = content.output
    if (!output || typeof output !== "object" || Array.isArray(output)) return false
    const result = output as Record<string, unknown>
    if (result.waitId !== waitId || (result.status !== "ready" && result.status !== "timed_out")) return false
    if (!Array.isArray(result.targetTaskIds) || !Array.isArray(result.matchedTaskIds)) return false
    const targetTaskIds = normalizedWaitIds(result.targetTaskIds)
    const matchedTaskIds: readonly unknown[] = result.matchedTaskIds
    if (!targetTaskIds || targetTaskIds.length !== expected.taskIds.length
      || targetTaskIds.some((id, index) => id !== expected.taskIds[index])) return false
    const matched = new Set<string>()
    for (const id of matchedTaskIds) {
      if (typeof id !== "string" || !targetTaskIds.includes(id) || matched.has(id)) return false
      matched.add(id)
    }
    if (result.status === "ready" && (matched.size === 0 || (expected.mode === "all" && matched.size !== targetTaskIds.length))) return false
    if (!Array.isArray(result.tasks) || result.tasks.length !== targetTaskIds.length) return false
    const taskIds = new Set<string>()
    for (const task of result.tasks) {
      if (!task || typeof task !== "object" || Array.isArray(task)) return false
      const row = task as Record<string, unknown>
      if (typeof row.taskId !== "string" || row.taskId.length === 0 || row.taskId.length > 256 || row.taskId.trim() !== row.taskId
        || !targetTaskIds.includes(row.taskId) || taskIds.has(row.taskId)
        || typeof row.status !== "string" || row.status.trim().length === 0 || row.status.length > 256) return false
      taskIds.add(row.taskId)
    }
    return taskIds.size === targetTaskIds.length
  })
}
