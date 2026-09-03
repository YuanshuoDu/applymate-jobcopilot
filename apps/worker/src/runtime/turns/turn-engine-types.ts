import type { ModelAdapter, ModelCapabilityProfile } from "@jobcopilot/agent-model"
import type { RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"

import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import type { TurnBudgetLimits } from "../budget.js"
import type { BusinessCheck } from "../verifier.js"
import type { TurnLease } from "./lease.js"

export type TurnEngineItemType = "agent_message" | "reasoning_summary" | "tool_call" | "tool_result" | "error"
export type TurnEngineItemPhase = "commentary" | "final_answer" | null
export type TurnEngineItemStatus = "started" | "streaming" | "completed" | "failed" | "interrupted"

export type TurnEngineStep = {
  readonly id: string
}

export type TurnEngineItem = {
  readonly id: string
  readonly revision: number
}

export type TurnEngineEvent = {
  readonly id: string
  readonly type: string
  readonly itemId: string | null
  readonly correlationId: string
  readonly causationId: string | null
  readonly payload: RepositoryJsonValue
}

export type TurnEngineToolCall = {
  readonly id: string
  readonly name: string
  readonly arguments: unknown
}

export type TurnEngineToolResult = {
  readonly id: string
  readonly toolName: string
  readonly toolVersion: string
  readonly status: "completed" | "failed" | "cancelled"
  readonly output?: unknown
  readonly errorCode: string | null
}

export type TurnEngineStore = {
  startStep(input: {
    lease: TurnLease
    stepId: string
    ordinal: number
    attempt: number
    inputThroughSequence: bigint
    consumedInputIds: readonly string[]
    modelProfileSnapshot: RepositoryJsonValue
    now: Date
  }): Promise<TurnEngineStep>
  updateStep(input: {
    lease: TurnLease
    stepId: string
    status: "completed" | "failed" | "waiting_for_tool" | "waiting_for_approval" | "waiting_for_user"
    finishReason: string | null
    errorCode: string | null
    inputTokens: number
    outputTokens: number
    estimatedCostUsd: number
    now: Date
  }): Promise<void>
  createItem(input: {
    lease: TurnLease
    itemId: string
    stepId: string | null
    type: TurnEngineItemType
    status: TurnEngineItemStatus
    phase: TurnEngineItemPhase
    content: RepositoryJsonValue
    now: Date
  }): Promise<TurnEngineItem>
  updateItem(input: {
    lease: TurnLease
    itemId: string
    expectedRevision: number
    status: TurnEngineItemStatus
    phase: TurnEngineItemPhase
    content: RepositoryJsonValue
    startedAt: Date | null
    completedAt: Date | null
    now: Date
  }): Promise<TurnEngineItem>
  appendEvent(input: {
    lease: TurnLease
    id: string
    itemId: string | null
    type: string
    correlationId: string
    causationId: string | null
    idempotencyKey: string
    payload: RepositoryJsonValue
  }): Promise<{ id: string }>
  recordFinalResponse(input: { lease: TurnLease; response: string; now: Date }): Promise<void>
}

export type TurnEngineToolExecutor = (input: {
  scope: TenantScope
  sessionId: string
  turnId: string
  stepId: string
  signal: AbortSignal
  capabilities?: readonly string[]
  call: { id: string; toolName: string; toolVersion: string; input: unknown }
}) => Promise<TurnEngineToolResult>

export type TurnEngineEventSubscriber = (event: TurnEngineEvent) => void | Promise<void>

export type TurnEngineOptions = {
  readonly lease: TurnLease
  readonly scope: TenantScope
  readonly goal: string
  readonly snapshot: StepContextSnapshot
  readonly contextBuilder: {
    build(request: {
      scope: TenantScope
      sessionId: string
      turnId: string
      stepId: string
      snapshot: StepContextSnapshot
      rootInputId?: string
      mode?: "new" | "retry" | "rebuild"
      lease?: { ownerId: string; leaseVersion: number; now: Date }
      now?: Date
    }): Promise<StepContext>
  }
  readonly store: TurnEngineStore
  readonly model: ModelAdapter
  readonly tools: readonly unknown[]
  readonly executeTool: TurnEngineToolExecutor
  readonly rootInputId?: string
  readonly rootTaskId?: string
  readonly capabilities?: readonly string[]
  readonly validateToolArguments?: (toolName: string, input: unknown) => boolean | string
  readonly signal?: AbortSignal
  readonly maxSteps?: number
  readonly now?: () => Date
  readonly idFactory?: (prefix: string) => string
  readonly subscribe?: TurnEngineEventSubscriber
  /** Provider reasoning is private by default; only explicitly safe summaries may be published. */
  readonly publishReasoningSummary?: boolean
  readonly budget?: TurnBudgetLimits
  readonly expectedEvidence?: readonly string[]
  readonly businessChecks?: readonly BusinessCheck[]
  readonly noProgressRepeatLimit?: number
}

export type TurnEngineResult = {
  readonly status: "completed" | "waiting_for_dependency" | "waiting_for_approval" | "waiting_for_user" | "failed"
  readonly stepCount: number
  readonly toolCallCount: number
  readonly finalItemId?: string
  readonly errorCode?: string
}

export type ModelProfileSnapshot = Pick<ModelCapabilityProfile, "provider" | "model" | "nativeTools" | "structuredOutput" | "streaming" | "continuationCursor">

export class TurnEngineError extends Error {
  constructor(
    readonly code: "final_unverified" | "step_limit" | "model_incomplete" | "persistence_conflict" | "invalid_output" | "budget_exhausted" | "no_progress" | "evidence_missing" | "evidence_conflict" | "business_precondition_failed",
    message: string,
  ) {
    super(message)
    this.name = "TurnEngineError"
  }
}

export function toRepositoryJson(value: unknown): RepositoryJsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TurnEngineError("invalid_output", "Engine output contains a non-finite number")
    return value
  }
  if (Array.isArray(value)) return value.map(toRepositoryJson)
  if (typeof value !== "object") throw new TurnEngineError("invalid_output", "Engine output is not JSON serializable")
  const result: { [key: string]: RepositoryJsonValue } = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) result[key] = toRepositoryJson(child)
  }
  return result
}
