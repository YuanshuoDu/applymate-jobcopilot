import { TurnEngineError, type TurnEngineStep } from "./turn-engine-types.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { NATIVE_SEMANTIC_NO_PROGRESS, NATIVE_SEMANTIC_REJECTION, RESET_NATIVE_SEMANTIC_PROGRESS,
  SCHEDULED_PIPELINE_COMPLETION, SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME, TASK_GRAPH_DENIAL_CHECKPOINT,
  parseScheduledPipelineCompletionDisposition, parseScheduledPipelineExistingAuditResumeDisposition,
  type TurnExecutionOptions } from "./turn-execution-types.js"
import { parseNativeSemanticRejectionIdentity } from "./native-semantic-rejection-ledger.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK } from "../subagents/scheduled-post-gate-contract.js"
import { signalWasInterrupted } from "../interrupt/registry.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import type { TaskGraphFinalSummaryBinding } from "../subagents/task-graph-final-summary-binding.js"
import type { TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import { parseTaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"
import { STEERING_RECONCILIATION_BLOCKER, STEERING_RECONCILIATION_FEEDBACK } from "../subagents/steering-reconciliation-contract.js"
import { tagTaskGraphRepairRecovery, TASK_GRAPH_RECOVERY_REVISION } from "./completion-recovery-context.js"
import { isTurnStateRefreshRetryError } from "./turn-execution-question.js"

export const TASK_GRAPH_VERIFICATION_BLOCKER = "task_graph_verification_unverified"
export const NATIVE_VERIFICATION_PENDING_BLOCKER = "native_verification_pending"
export const TASK_GRAPH_FEEDBACK = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing."

type CompletionGateOptions = Pick<TurnExecutionOptions, "identity" | "scope" | "completionGate" | "isOwnershipLost">
type CompletionGateWriter = Pick<TurnExecutionEventWriter, "append">
type CompletionDecision = Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>
type CompletionResult = TaskGraphFinalSummaryBinding | { feedback: string; readonly [NATIVE_SEMANTIC_NO_PROGRESS]?: true;
  readonly [NATIVE_SEMANTIC_REJECTION]?: import("./native-semantic-rejection-ledger.js").NativeSemanticRejectionIdentity;
  readonly [TASK_GRAPH_DENIAL_CHECKPOINT]?: TaskGraphDenialCheckpoint } | { waitId: string }
  | { scheduledWaitId: string; candidateText: string }
  | { scheduledGateChoice: Extract<import("./turn-execution-types.js").ScheduledPipelineCompletionDisposition,
    { status: "waiting_for_scheduled_gate_choice" }> } | { externalWaitId: string; scheduledWaitId?: string }
  | { scheduledBlocker: string } | undefined

/** Evaluates terminal state and routes scheduled work back through the active Turn loop. */
export async function assertCompletionAllowed(options: CompletionGateOptions, writer: CompletionGateWriter, step: TurnEngineStep,
  signal: AbortSignal, now: () => Date, candidateText: string, allowTaskGraphDenialCheckpoint = false): Promise<CompletionResult> {
  if (!options.completionGate) return undefined
  let decision = await readCompletionDecision(options, step, signal, now, candidateText)
  validateCompletionDecision(decision)
  if (!decision.ok && decision.blocker === "child_tasks_pending") {
    const resume = options.completionGate[SCHEDULED_PIPELINE_EXISTING_AUDIT_RESUME]
    if (resume) {
      let disposition
      try {
        disposition = parseScheduledPipelineExistingAuditResumeDisposition(await resume({ identity: options.identity, scope: options.scope,
          rootTaskId: options.identity.rootTaskId, stepId: step.id, stepOrdinal: step.ordinal, candidateText, signal, now: now(), isOwnershipLost: options.isOwnershipLost }))
      } catch (error: unknown) {
        if (isTurnStateRefreshRetryError(error) || isSessionPauseRequestedError(error) || signalWasInterrupted(signal)
          || signal.aborted || options.isOwnershipLost?.(error, signal)) throw error
        throw new TurnEngineError("invalid_output", "Scheduled Audit resume failed closed")
      }
      if (!disposition) throw new TurnEngineError("invalid_output", "Scheduled Audit resume returned an invalid disposition")
      if (disposition.status === "replan") {
        await writer.append("final.rejected", step.id, null, { code: "scheduled_post_gate_plan_required", blocker: "scheduled_post_gate_plan_required",
          feedback: disposition.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}:scheduled-post-gate-plan-required`)
        return { feedback: disposition.feedback }
      }
      if (disposition.status === "waiting_for_dependency") return { waitId: disposition.waitId }
      if (disposition.status === "completed") {
        decision = await readCompletionDecision(options, step, signal, now, candidateText)
        validateCompletionDecision(decision)
      }
    }
  }
  if (decision.ok) {
    const binding = decision[TASK_GRAPH_FINAL_SUMMARY_BINDING]
    const scheduledCompletion = options.completionGate[SCHEDULED_PIPELINE_COMPLETION]
    if (scheduledCompletion) {
      let parsed
      try {
        parsed = parseScheduledPipelineCompletionDisposition(await scheduledCompletion({ identity: options.identity, scope: options.scope,
          rootTaskId: options.identity.rootTaskId, stepId: step.id, stepOrdinal: step.ordinal, candidateText, signal, now: now(), isOwnershipLost: options.isOwnershipLost }))
      } catch (error: unknown) {
        if (isTurnStateRefreshRetryError(error) || isSessionPauseRequestedError(error) || signalWasInterrupted(signal)
          || signal.aborted || options.isOwnershipLost?.(error, signal)) throw error
        throw new TurnEngineError("invalid_output", "Scheduled pipeline completion failed closed")
      }
      if (!parsed) throw new TurnEngineError("invalid_output", "Scheduled pipeline completion returned an invalid disposition")
      if (parsed.status === "blocked") return { scheduledBlocker: parsed.errorCode }
      if (parsed.candidateText !== candidateText) throw new TurnEngineError("invalid_output", "Scheduled pipeline completion changed the final candidate")
      if (parsed.status === "replan") {
        if (parsed.feedback !== SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK) throw new TurnEngineError("invalid_output", "Scheduled post-Gate plan feedback is invalid")
        await writer.append("final.rejected", step.id, null, { code: "scheduled_post_gate_plan_required", blocker: "scheduled_post_gate_plan_required",
          feedback: parsed.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}:scheduled-post-gate-plan-required`)
        return { feedback: parsed.feedback }
      }
      if (parsed.status === "waiting_for_dependency") return { waitId: parsed.waitId }
      if (parsed.status === "waiting_for_user") return { scheduledWaitId: parsed.waitId, candidateText: parsed.candidateText }
      if (parsed.status === "waiting_for_scheduled_gate_choice") return { scheduledGateChoice: parsed }
      if (parsed.status === "waiting_for_external_user") return { externalWaitId: parsed.externalWaitId,
        ...(parsed.scheduledWaitId ? { scheduledWaitId: parsed.scheduledWaitId } : {}) }
    }
    return binding
  }
  const stopForSemanticNoProgress = decision[NATIVE_SEMANTIC_NO_PROGRESS]
  const rawRejection = decision[NATIVE_SEMANTIC_REJECTION]
  const rejection = rawRejection === undefined ? undefined : parseNativeSemanticRejectionIdentity(rawRejection)
  if (decision.waitId !== undefined) return { waitId: decision.waitId }
  const feedback = decision.blocker === STEERING_RECONCILIATION_BLOCKER ? STEERING_RECONCILIATION_FEEDBACK : decision.feedback
  const code = decision.blocker === STEERING_RECONCILIATION_BLOCKER ? STEERING_RECONCILIATION_BLOCKER : "business_precondition_failed"
  const denialCheckpoint = allowTaskGraphDenialCheckpoint && options.identity.kind === "turn" && options.identity.taskId === options.identity.rootTaskId
    && decision.blocker === TASK_GRAPH_VERIFICATION_BLOCKER && decision.feedback.startsWith(TASK_GRAPH_FEEDBACK)
    && stopForSemanticNoProgress !== true && rejection === undefined
    ? parseTaskGraphDenialCheckpoint(Reflect.get(decision, TASK_GRAPH_DENIAL_CHECKPOINT), options.identity.rootTaskId) : null
  if (denialCheckpoint) await writer.append("agent.plan.denial_checkpoint", step.id, null,
    { ...denialCheckpoint, stepId: step.id }, `task-graph-denial-checkpoint:${step.id}`)
  await writer.append("final.rejected", step.id, null, { code, blocker: decision.blocker, feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}`)
  if (decision.blocker === TASK_GRAPH_VERIFICATION_BLOCKER) {
    const stamped: unknown = Reflect.get(decision, TASK_GRAPH_RECOVERY_REVISION)
    const revision = typeof stamped === "number" && Number.isSafeInteger(stamped) && stamped >= 0 ? stamped : null
    return { feedback: tagTaskGraphRepairRecovery(feedback, revision),
      ...(stopForSemanticNoProgress ? { [NATIVE_SEMANTIC_NO_PROGRESS]: true as const } : {}),
      ...(rejection ? { [NATIVE_SEMANTIC_REJECTION]: rejection } : {}),
      ...(denialCheckpoint ? { [TASK_GRAPH_DENIAL_CHECKPOINT]: denialCheckpoint } : {}) }
  }
  if (decision.blocker === STEERING_RECONCILIATION_BLOCKER) {
    options.completionGate?.[RESET_NATIVE_SEMANTIC_PROGRESS]?.()
    return { feedback }
  }
  throw new TurnEngineError("business_precondition_failed", decision.blocker)
}

async function readCompletionDecision(options: CompletionGateOptions, step: TurnEngineStep, signal: AbortSignal,
  now: () => Date, candidateText: string): Promise<CompletionDecision> {
  try {
    return await options.completionGate!({ identity: options.identity, scope: options.scope, rootTaskId: options.identity.rootTaskId,
      stepId: step.id, candidateText, signal, now: now() })
  } catch (error: unknown) {
    if (isTurnStateRefreshRetryError(error) || isSessionPauseRequestedError(error) || signalWasInterrupted(signal)
      || signal.aborted || options.isOwnershipLost?.(error, signal)) throw error
    if (error instanceof TurnEngineError && error.code === "persistence_conflict") throw error
    throw new TurnEngineError("invalid_output", "Completion gate failed closed")
  }
}

function validateCompletionDecision(decision: CompletionDecision): void {
  if (!decision || typeof decision !== "object" || typeof decision.ok !== "boolean") throw new TurnEngineError("invalid_output", "Completion gate returned an invalid decision")
  if (decision.ok) {
    if (Object.hasOwn(decision, NATIVE_SEMANTIC_NO_PROGRESS) || Object.hasOwn(decision, NATIVE_SEMANTIC_REJECTION)) throw new TurnEngineError("invalid_output", "Completion gate returned an invalid semantic progress signal")
    const binding = decision[TASK_GRAPH_FINAL_SUMMARY_BINDING]
    if (binding !== undefined && (!binding || !Number.isSafeInteger(binding.graphRevision) || binding.graphRevision < 1 || !binding.summary || typeof binding.summary !== "object")) throw new TurnEngineError("invalid_output", "Completion gate returned an invalid TaskGraph summary binding")
    return
  }
  if (decision[TASK_GRAPH_FINAL_SUMMARY_BINDING] !== undefined) throw new TurnEngineError("invalid_output", "Completion gate returned a TaskGraph summary binding while denying completion")
  const stop = decision[NATIVE_SEMANTIC_NO_PROGRESS], raw = decision[NATIVE_SEMANTIC_REJECTION]
  const rejection = raw === undefined ? undefined : parseNativeSemanticRejectionIdentity(raw)
  if (raw !== undefined && (!rejection || decision.blocker !== TASK_GRAPH_VERIFICATION_BLOCKER || stop === true)) throw new TurnEngineError("invalid_output", "Completion gate returned an invalid semantic rejection identity")
  if (stop !== undefined && (stop !== true || decision.blocker !== TASK_GRAPH_VERIFICATION_BLOCKER)) throw new TurnEngineError("invalid_output", "Completion gate returned an invalid semantic progress signal")
  if (typeof decision.blocker !== "string" || typeof decision.feedback !== "string" || decision.blocker.length === 0 || decision.blocker.length > 256 || decision.feedback.length > 512) throw new TurnEngineError("invalid_output", "Completion gate returned an invalid blocker")
  if (decision.waitId !== undefined && (decision.blocker !== NATIVE_VERIFICATION_PENDING_BLOCKER || typeof decision.waitId !== "string" || !decision.waitId.trim() || decision.waitId.length > 128)) throw new TurnEngineError("invalid_output", "Completion gate returned an invalid wait")
  if (decision.blocker === NATIVE_VERIFICATION_PENDING_BLOCKER && decision.waitId === undefined) throw new TurnEngineError("invalid_output", "Completion gate omitted a durable wait receipt")
  if (decision.blocker === STEERING_RECONCILIATION_BLOCKER && decision.feedback !== STEERING_RECONCILIATION_FEEDBACK) throw new TurnEngineError("invalid_output", "Completion gate returned invalid steering reconciliation feedback")
}
