import { BudgetExceededError, type BudgetReservation } from "../budget.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } as const

export async function settleAndPersistModelUsage(input: {
  readonly reservation: BudgetReservation
  readonly output: ModelStepResult
  readonly stepId: string
  readonly taskId?: string
  readonly writer: Pick<TurnExecutionEventWriter, "append">
  readonly onUsageAccepted: () => void
}): Promise<void> {
  let overrun: BudgetExceededError | undefined
  try {
    input.reservation.settle(input.output.usage ?? ZERO_USAGE)
  } catch (error: unknown) {
    if (!(error instanceof BudgetExceededError)) throw error
    overrun = error
  }
  input.onUsageAccepted()
  await input.writer.append("model.usage", input.stepId, null,
    { provider: input.output.provider, model: input.output.model, usage: input.output.usage, taskId: input.taskId },
    `model-usage:${input.stepId}`)
  if (overrun) throw overrun
}
