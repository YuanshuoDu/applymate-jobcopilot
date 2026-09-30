import { TurnEngineError, type TurnEngineStep } from "./turn-engine-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"

type CompletionGateOptions = Pick<TurnExecutionOptions, "identity" | "scope" | "completionGate">
type CompletionGateWriter = Pick<TurnExecutionEventWriter, "append">

export async function assertCompletionAllowed(options: CompletionGateOptions, writer: CompletionGateWriter, step: TurnEngineStep, signal: AbortSignal, now: () => Date): Promise<void> {
  if (!options.completionGate) return
  let decision: Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>
  try {
    decision = await options.completionGate({ identity: options.identity, scope: options.scope, rootTaskId: options.identity.rootTaskId, stepId: step.id, signal, now: now() })
  } catch {
    throw new TurnEngineError("invalid_output", "Completion gate failed closed")
  }
  if (!decision || typeof decision !== "object" || typeof decision.ok !== "boolean") throw new TurnEngineError("invalid_output", "Completion gate returned an invalid decision")
  if (decision.ok) return
  if (typeof decision.blocker !== "string" || typeof decision.feedback !== "string" || decision.blocker.length === 0 || decision.blocker.length > 256 || decision.feedback.length > 512) {
    throw new TurnEngineError("invalid_output", "Completion gate returned an invalid blocker")
  }
  await writer.append("final.rejected", step.id, null, { code: "business_precondition_failed", blocker: decision.blocker, feedback: decision.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}`)
  throw new TurnEngineError("business_precondition_failed", decision.blocker)
}
