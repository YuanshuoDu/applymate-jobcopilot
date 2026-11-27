import type { StepContextSnapshot } from "../context/step-context-builder.js"
import type { ModelStepResult } from "./turn-engine-model.js"
import { TurnEngineError, type TurnEngineStep, type TurnResumeState } from "./turn-engine-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

export const PLAN_SCHEMA_REPAIR_ERROR_CODE = "agent_plan_schema_rejected"
export const PLAN_SCHEMA_REPAIR_INSTRUCTION = "The prior agent.plan proposal failed registered argument validation and was not applied. Read the current owner-scoped TaskGraph and its current expectedRevision, then submit one valid agent.plan proposal using request-visible tools. Do not retry invalid arguments verbatim."

export function withPlanSchemaRepairSnapshot(snapshot: StepContextSnapshot, stepId: string): StepContextSnapshot {
  const markerId = `plan-schema-repair:${stepId}`
  return { ...snapshot, system: [...snapshot.system.filter(seed => seed.id !== markerId), { id: markerId, content: PLAN_SCHEMA_REPAIR_INSTRUCTION }] }
}

export async function schedulePlanSchemaRepair(input: {
  readonly identity: TurnExecutionOptions["identity"]
  readonly store: Pick<TurnExecutionOptions["store"], "updateStep">
  readonly writer: Pick<TurnExecutionEventWriter, "append">
  readonly step: TurnEngineStep
  readonly output: ModelStepResult
  readonly now: Date
  readonly alreadyUsed: boolean
  readonly onStepClosed: () => void
}): Promise<NonNullable<TurnResumeState["planSchemaRepair"]>> {
  if (input.identity.kind !== "turn" || input.identity.taskId !== input.identity.rootTaskId || input.alreadyUsed
    || input.output.planSchemaRejection !== "invalid_arguments" || input.output.toolCalls.length !== 0
    || input.output.finishReason !== "tool_calls") {
    throw new TurnEngineError("invalid_output", "Root agent.plan arguments remained invalid after the single repair attempt")
  }

  const usage = input.output.usage
  await input.store.updateStep({ identity: input.identity, stepId: input.step.id, status: "completed",
    finishReason: input.output.finishReason, errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE,
    inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0,
    estimatedCostUsd: usage?.estimatedCostUsd ?? 0, now: input.now })
  await input.writer.append("step.completed", input.step.id, null,
    { stepId: input.step.id, status: "completed", errorCode: PLAN_SCHEMA_REPAIR_ERROR_CODE, taskId: input.identity.taskId },
    `step-completed:${input.step.id}`)
  input.onStepClosed()
  return { sourceStepId: input.step.id, sourceStepOrdinal: input.step.ordinal, retryPending: true }
}
