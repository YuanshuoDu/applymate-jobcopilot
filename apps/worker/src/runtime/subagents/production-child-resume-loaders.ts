import type pg from "pg"

import type { ChildExecutorOptions } from "./child-executor.js"
import { loadChildSameAttemptContinuation } from "./child-mailbox-continuation.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.js"
import { loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"

type ResumeFailureStage = "repair_consumed_wait_sources" | "read_durable_wait" | "load_attempt_history"
type ResumeFailureCategory = "wait_invalid" | "wait_conflict" | "wait_scope_error" | "child_resume_owner_mismatch"
  | "child_resume_lease_expired" | "child_resume_step_lineage" | "child_resume_usage_overflow" | "child_resume_step_limit"
  | "child_resume_item_limit" | "child_resume_wait_step_lineage" | "child_resume_wait_tool_call_conflict"
  | "child_resume_invalid_shape" | "database_deadlock" | "database_serialization" | "database_lock" | "database_cancelled"
  | "database_permission" | "database_error" | "other"
type ResumeValidationStage = "lease_fence" | "source_ordinal" | "wait_state" | "wait_result_shape" | "target_scope"
  | "resolved_outcome" | "tool_call" | "call_binding" | "receipt_pair" | "receipt_identity" | "receipt_ids"
  | "receipt_deadline" | "input_target_ids" | "output_target_ids" | "resume_scope" | "source_step"
  | "source_call_count" | "source_call_input" | "source_item_set" | "wait_record_shape" | "provenance_marker"
  | "source_lifecycle" | "reconciliation"
type ResumeFailureDiagnostic = Readonly<{ stage: ResumeFailureStage; category: ResumeFailureCategory; validationStage: ResumeValidationStage | null }>
type ResumeFailureObserver = (diagnostic: ResumeFailureDiagnostic) => void
const RESUME_VALIDATION_STAGES = new Set<ResumeValidationStage>([
  "lease_fence", "source_ordinal", "wait_state", "wait_result_shape", "target_scope", "resolved_outcome", "tool_call",
  "call_binding", "receipt_pair", "receipt_identity", "receipt_ids", "receipt_deadline", "input_target_ids",
  "output_target_ids", "resume_scope", "source_step", "source_call_count", "source_call_input", "source_item_set",
  "wait_record_shape", "provenance_marker", "source_lifecycle", "reconciliation",
])

function resumeFailureCategory(error: unknown): ResumeFailureCategory {
  try {
    const row = error && typeof error === "object" ? error as Record<string, unknown> : undefined
    const code = typeof row?.code === "string" ? row.code : ""
    if (["wait_invalid", "wait_conflict", "wait_scope_error"].includes(code)) return code as ResumeFailureCategory
    const message = error instanceof Error ? error.message : ""
    const childCodes = new Set<ResumeFailureCategory>([
      "child_resume_owner_mismatch", "child_resume_lease_expired", "child_resume_step_lineage", "child_resume_usage_overflow",
      "child_resume_step_limit", "child_resume_item_limit", "child_resume_wait_step_lineage", "child_resume_wait_tool_call_conflict",
    ])
    if (childCodes.has(message as ResumeFailureCategory)) return message as ResumeFailureCategory
    if (message.startsWith("child_resume_invalid_")) return "child_resume_invalid_shape"
    if (code === "40P01") return "database_deadlock"
    if (code === "40001") return "database_serialization"
    if (code === "55P03") return "database_lock"
    if (code === "57014") return "database_cancelled"
    if (code === "42501") return "database_permission"
    if (/^[0-9A-Z]{5}$/.test(code)) return "database_error"
  } catch { /* Diagnostic classification must never replace the resume failure. */ }
  return "other"
}

function resumeFailureValidationStage(error: unknown): ResumeValidationStage | null {
  try {
    const row = error && typeof error === "object" ? error as Record<string, unknown> : undefined
    const stage = row?.resumeValidationStage
    if (typeof stage === "string" && RESUME_VALIDATION_STAGES.has(stage as ResumeValidationStage)) return stage as ResumeValidationStage
    if (typeof row?.sourceLifecycleStage === "string") return "source_lifecycle"
  } catch { /* Ignore malformed diagnostic properties. */ }
  return null
}

function reportResumeFailure(observer: ResumeFailureObserver | undefined, stage: ResumeFailureStage, error: unknown): void {
  if (!observer) return
  try { observer({ stage, category: resumeFailureCategory(error), validationStage: resumeFailureValidationStage(error) }) }
  catch { /* A diagnostic observer cannot alter the production failure or retry path. */ }
}

/** Installs legacy source repair before either production path reads consumed waits. */
export function createProductionChildResumeLoaders(
  pool: pg.Pool,
  observeResumeFailure?: ResumeFailureObserver,
): Pick<ChildExecutorOptions, "resumeLoader" | "sameAttemptContinuationLoader"> {
  if (typeof (pool as unknown as { readonly connect?: unknown }).connect !== "function") return {}
  return {
    resumeLoader: async lease => {
      const now = new Date()
      try { await repairConsumedChildWaitSources(pool, lease, now) }
      catch (error) { reportResumeFailure(observeResumeFailure, "repair_consumed_wait_sources", error); throw error }
      let wait: Awaited<ReturnType<typeof loadDurableSubagentWaitResume>>
      try { wait = await loadDurableSubagentWaitResume(pool, lease, now) }
      catch (error) { reportResumeFailure(observeResumeFailure, "read_durable_wait", error); throw error }
      try { return await loadChildAttemptResume(pool, lease, now, wait) }
      catch (error) { reportResumeFailure(observeResumeFailure, "load_attempt_history", error); throw error }
    },
    sameAttemptContinuationLoader: async lease => {
      const now = new Date()
      await repairConsumedChildWaitSources(pool, lease, now)
      return loadChildSameAttemptContinuation(pool, lease, now)
    },
  }
}
