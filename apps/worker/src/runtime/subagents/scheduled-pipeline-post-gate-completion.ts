import type { ScheduledPipelineCompletionDisposition } from "../turns/turn-execution-types.js"
import type { ScheduledPipelineGateContinuationResult } from "./scheduled-automation-gate-bridge.js"
import { SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK } from "./scheduled-post-gate-contract.js"

/** Maps a persisted post-Gate handoff read into a Root disposition. */
export function mapScheduledPostGateResumeResult(result: ScheduledPipelineGateContinuationResult,
  candidateText: string): ScheduledPipelineCompletionDisposition | null {
  if (result.status === "not_registered") return null
  if (result.status === "blocked") return result
  if (result.status === "replan") return result.feedback === SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK
    ? { status: "replan", candidateText, feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK }
    : { status: "blocked", errorCode: "scheduled_post_gate_replan_invalid" }
  if (result.status === "completed") return { status: "completed", candidateText }
  if (result.status === "waiting_for_dependency") return { status: result.status, waitId: result.waitId, candidateText }
  return { status: "blocked", errorCode: "scheduled_post_gate_resume_result_invalid" }
}

/** Maps Gate continuation outcomes while keeping replan inside the existing Root loop. */
export function mapScheduledGateContinuationResult(result: ScheduledPipelineGateContinuationResult,
  candidateText: string): ScheduledPipelineCompletionDisposition {
  if (result.status === "waiting_for_dependency") return { status: result.status, waitId: result.waitId, candidateText }
  if (result.status === "replan") return result.feedback === SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK
    ? { status: "replan", candidateText, feedback: SCHEDULED_POST_GATE_PLAN_REQUIRED_FEEDBACK }
    : { status: "blocked", errorCode: "scheduled_post_gate_replan_invalid" }
  if (result.status === "waiting_for_choice") return { status: "waiting_for_scheduled_gate_choice", waitId: result.waitId,
    question: result.question, binding: result.binding, candidateText }
  if (result.status === "waiting_for_external_user") return { status: result.status, externalWaitId: result.waitId, candidateText }
  if (result.status === "blocked") return result
  if (result.status === "completed") return { status: "completed", candidateText }
  return { status: "blocked", errorCode: result.status === "not_registered" ? "scheduled_audit_not_registered" : "scheduled_pipeline_gate_recovery_unexpected" }
}
