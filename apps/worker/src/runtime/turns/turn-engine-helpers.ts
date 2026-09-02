import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { TurnLeaseError, type TurnLease } from "./lease.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnEngineToolExecutor } from "./turn-engine-types.js"

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
    signal: input.signal, capabilities: input.capabilities, actorRole: "orchestrator",
  }, input.call)
}

export function isTurnLeaseLoss(error: unknown, signal: AbortSignal): boolean {
  return error instanceof TurnLeaseError || signal.aborted
}
