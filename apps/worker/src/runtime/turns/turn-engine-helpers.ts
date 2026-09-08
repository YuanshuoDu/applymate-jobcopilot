import { randomUUID } from "node:crypto"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { signalWasInterrupted } from "../interrupt/registry.js"
import { BudgetExceededError, createTurnBudgetLedger } from "../budget.js"
import { TurnLeaseError, type TurnLease } from "./lease.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnEngineToolExecutor, TurnResumeState } from "./turn-engine-types.js"
import { executionId, type TurnExecutionOptions, type TurnExecutionStore } from "./turn-execution-types.js"
import type { TurnBudgetLimits, TurnUsage } from "../budget.js"

export function turnErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code
  return "turn_execution_failed"
}

export function makeStepUpdate(lease: TurnLease, stepId: string, output: ModelStepResult | null, status: "completed" | "failed" | "interrupted" | "waiting_for_tool" | "waiting_for_approval" | "waiting_for_user", now: Date, errorCode: string | null = null) {
  return {
    lease, stepId, status, finishReason: output?.finishReason ?? null, errorCode,
    inputTokens: output?.usage?.inputTokens ?? 0, outputTokens: output?.usage?.outputTokens ?? 0,
    estimatedCostUsd: output?.usage?.estimatedCostUsd ?? 0, now,
  }
}

export function createToolRouterExecutor(router: {
  execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult>
}): TurnEngineToolExecutor {
  return (input) => router.execute({
    scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId,
    taskId: input.taskId, rootTaskId: input.rootTaskId,
    signal: input.signal, capabilities: input.capabilities, actorRole: input.actorRole ?? "orchestrator",
  }, input.call)
}

/** Keep durable usage and step ceilings in force after a lease recovery. */
export function resumedBudgetLimits(limits: TurnBudgetLimits | undefined, resume: TurnResumeState | undefined): TurnBudgetLimits | undefined {
  if (!limits || !resume) return limits
  return {
    ...(limits.maxSteps === undefined ? {} : { maxSteps: Math.max(0, limits.maxSteps - resume.stepCount) }),
    ...(limits.maxToolCalls === undefined ? {} : { maxToolCalls: Math.max(0, limits.maxToolCalls - resume.toolCallCount) }),
    ...(limits.maxInputTokens === undefined ? {} : { maxInputTokens: Math.max(0, limits.maxInputTokens - resume.usage.inputTokens) }),
    ...(limits.maxOutputTokens === undefined ? {} : { maxOutputTokens: Math.max(0, limits.maxOutputTokens - resume.usage.outputTokens) }),
    ...(limits.maxCostUsd === undefined ? {} : { maxCostUsd: Math.max(0, limits.maxCostUsd - resume.usage.estimatedCostUsd) }),
  }
}

export function totalTurnUsage(previous: TurnUsage | undefined, current: TurnUsage): TurnUsage {
  return {
    inputTokens: (previous?.inputTokens ?? 0) + current.inputTokens,
    outputTokens: (previous?.outputTokens ?? 0) + current.outputTokens,
    estimatedCostUsd: (previous?.estimatedCostUsd ?? 0) + current.estimatedCostUsd,
  }
}

export function isTurnLeaseLoss(error: unknown, signal: AbortSignal): boolean {
  return error instanceof TurnLeaseError || signal.aborted
}

export function makeExecutionId(options: TurnExecutionOptions, prefix: string): string {
  const scoped = executionId(options.identity, prefix)
  return options.idFactory?.(scoped) ?? `${scoped}:${randomUUID()}`
}

export function assertExecutionAlive(options: TurnExecutionOptions, signal: AbortSignal): void {
  if (signalWasInterrupted(signal)) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Execution was interrupted")
  }
  if (signal.aborted) throw options.signalError?.() ?? new Error("execution_lost")
}

export function canPersistFinalResponse(options: TurnExecutionOptions): boolean {
  return options.identity.kind === "turn" && options.lifecycle?.persistFinalResponse !== false
}

export function canEmitTurnCompleted(options: TurnExecutionOptions): boolean {
  return options.identity.kind === "turn" && options.lifecycle?.emitTurnCompleted !== false
}

type BudgetSnapshot = ReturnType<ReturnType<typeof createTurnBudgetLedger>["snapshot"]>

export function assertModelAllowance(snapshot: BudgetSnapshot): void {
  const checks = [
    ["input_tokens", snapshot.limits.maxInputTokens, snapshot.used.inputTokens + snapshot.reserved.inputTokens],
    ["output_tokens", snapshot.limits.maxOutputTokens, snapshot.used.outputTokens + snapshot.reserved.outputTokens],
    ["cost_usd", snapshot.limits.maxCostUsd, snapshot.used.estimatedCostUsd + snapshot.reserved.estimatedCostUsd],
  ] as const
  for (const [metric, limit, used] of checks) {
    if (limit !== undefined && used >= limit) throw new BudgetExceededError(metric, limit, used + 1, used)
  }
}

export function updateExecutionStep(options: TurnExecutionOptions, input: Omit<Parameters<TurnExecutionStore["updateStep"]>[0], "identity">): Promise<void> {
  return options.store.updateStep({ identity: options.identity, ...input })
}
