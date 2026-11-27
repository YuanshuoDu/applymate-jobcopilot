import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { BudgetReservation } from "../budget.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"

import { runAdmittedModelStep } from "./admitted-model-step.js"
import { settleAndPersistModelUsage } from "./turn-execution-budget-overrun.js"
import { prepareTurnFinalAnswerEvidenceRequest } from "./turn-execution-evidence.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

export function prepareTurnExecutionModelRequest(input: {
  readonly options: TurnExecutionOptions
  readonly context: StepContext
  readonly snapshot: StepContextSnapshot
  readonly stepId: string
  readonly signal: AbortSignal
  readonly continuation?: HarnessModelRequest["continuation"]
  readonly freshSteering: boolean
  readonly cognitiveAgendaReceipt: unknown
}): { readonly request: HarnessModelRequest; readonly bindingMap: ReturnType<typeof prepareTurnFinalAnswerEvidenceRequest>["bindingMap"] } {
  const identity = input.options.identity
  let request = buildModelRequest({ context: input.context, model: input.options.model, tools: input.options.tools,
    sessionId: identity.sessionId, turnId: identity.turnId, stepId: input.stepId, taskId: identity.taskId, userId: identity.userId,
    signal: input.signal, continuation: input.continuation, freshSteering: input.freshSteering,
    outputSchema: input.options.outputSchema, cognitiveAgendaReceipt: input.cognitiveAgendaReceipt,
    rootTaskId: identity.kind === "turn" ? identity.rootTaskId : undefined })
  const prepared = prepareTurnFinalAnswerEvidenceRequest(request, input.snapshot, { userId: identity.userId,
    sessionId: identity.sessionId, turnId: identity.turnId, taskId: identity.taskId, stepId: input.stepId })
  return { request: prepared.request, bindingMap: prepared.bindingMap }
}

export async function runTurnExecutionModelStep(input: {
  readonly options: TurnExecutionOptions
  readonly writer: Pick<TurnExecutionEventWriter, "append">
  readonly stepId: string
  readonly request: HarnessModelRequest
  readonly reservation: BudgetReservation
  readonly classifyRootPlanSchemaRejection: boolean
  readonly now: Date
  readonly onUsageAccepted: (output: ModelStepResult) => void
}): Promise<ModelStepResult> {
  const identity = input.options.identity
  const classifyRootPlanSchemaRejection = input.classifyRootPlanSchemaRejection
    && identity.kind === "turn" && identity.taskId === identity.rootTaskId
  const output = await runAdmittedModelStep({ writer: input.writer, stepId: input.stepId, taskId: identity.taskId,
    provider: input.request.provider, model: input.request.model, invoke: async () => {
      const result = await runModelStep(input.options.model, input.request, input.options.validateToolArguments, { classifyRootPlanSchemaRejection })
      if (classifyRootPlanSchemaRejection && result.planSchemaRejection === "invalid_arguments"
        && result.finishReason === "tool_calls" && result.toolCalls.length === 0) await persistPlanSchemaRejectionUsageCheckpoint(input, identity, result)
      return result
    },
    onStartDenied: () => input.reservation.settle({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }) })
  await settleAndPersistModelUsage({ reservation: input.reservation, output, stepId: input.stepId,
    taskId: input.options.identity.taskId, writer: input.writer, onUsageAccepted: () => input.onUsageAccepted(output) })
  return output
}

async function persistPlanSchemaRejectionUsageCheckpoint(
  input: Parameters<typeof runTurnExecutionModelStep>[0],
  identity: TurnExecutionOptions["identity"],
  output: ModelStepResult,
): Promise<void> {
  const usage = output.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
  await input.options.store.updateStep({ identity, stepId: input.stepId, status: "streaming", finishReason: "tool_calls", errorCode: null,
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, estimatedCostUsd: usage.estimatedCostUsd, now: input.now })
}
