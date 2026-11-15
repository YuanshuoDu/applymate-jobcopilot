const SAFE_WAIT_RESOLVER_ERROR_CODES = new Set([
  "idempotency_conflict", "revision_mismatch", "wait_invalid", "wait_scope_error", "wait_conflict",
  "40001", "40P01", "55P03", "57014", "08000", "08003", "08006", "57P01", "ECONNRESET", "ETIMEDOUT",
  "error", "unknown", "other", "child_wait_configuration", "child_wait_deadline_revalidation",
  "child_wait_parent_deadline_scope", "child_wait_schedule_fence", "child_wait_session_scope",
  "task_graph_prepare_or_load", "task_graph_transition_rejected", "task_graph_persist_revision_conflict",
  "task_graph_persist_outbox_conflict", "task_graph_persist_sequence_unavailable",
])

const SAFE_WAIT_RESOLVER_MESSAGE_CODES = new Map([
  ["Child wait deadline could not be revalidated", "child_wait_deadline_revalidation"],
  ["Child wait parent deadline scope could not be revalidated", "child_wait_parent_deadline_scope"],
  ["Child wait schedule update lost its eligibility fence", "child_wait_schedule_fence"],
  ["Child wait session scope is invalid", "child_wait_session_scope"],
  ["Child wait resolver batch size must be between 1 and 100", "child_wait_configuration"],
  ["Child wait resolver options are invalid", "child_wait_configuration"],
])

for (const message of `task_graph_attempt_count_invalid task_graph_child_missing task_graph_dependency_context_reserved_key
  task_graph_dependency_context_too_large task_graph_dependency_key_unsafe task_graph_dependency_missing task_graph_dependency_not_completed
  task_graph_dependency_result_contract_invalid task_graph_dependency_result_digest_invalid task_graph_dependency_result_envelope_invalid
  task_graph_dependency_result_invalid task_graph_dependency_result_too_large task_graph_dependency_scope_invalid
  task_graph_dependency_scope_mismatch task_graph_dependency_set_invalid task_graph_dependency_source_too_large
  task_graph_event_envelope_invalid task_graph_gate_choice_resume_invalid task_graph_json_invalid task_graph_lifecycle_event_invalid
  task_graph_lifecycle_receipt_invalid task_graph_native_receipt_invalid task_graph_receipt_invalid task_graph_revision_invalid
  task_graph_scope_invalid task_graph_session_fenced task_graph_turn_fenced task_graph_parent_fenced task_graph_step_fenced
  task_graph_snapshot_capacity_invalid task_graph_snapshot_cycle_invalid task_graph_snapshot_dependency_invalid
  task_graph_snapshot_duplicate task_graph_snapshot_invalid task_graph_snapshot_native_delegation_invalid
  task_graph_snapshot_registered_scout_envelope_invalid task_graph_snapshot_repair_invalid task_graph_snapshot_root_criteria_invalid
  task_graph_snapshot_template_unsupported task_graph_snapshot_too_large task_graph_snapshot_verification_dependency_invalid
  task_graph_snapshot_verification_disposition_invalid task_graph_snapshot_verification_invalid task_graph_state_missing
  task_graph_task_id_missing task_graph_task_missing task_graph_task_scope_invalid task_graph_verification_event_ambiguous
  task_graph_verification_event_invalid task_graph_verification_replay_event_invalid task_graph_verification_replay_lifecycle_invalid
  task_graph_verification_replay_source_duplicate task_graph_verification_replay_source_invalid task_graph_verification_replay_source_mismatch
  task_graph_verification_replay_source_missing task_graph_verification_report_invalid task_graph_verification_result_invalid
  task_graph_wait_identity_invalid task_graph_reviewer_writer_dependency_invalid task_graph_reviewer_writer_dependency_missing
  task_graph_dependency_context_reserved_key task_graph_dependency_context_too_large task_graph_dependency_result_envelope_invalid`.split(/\s+/)) {
  SAFE_WAIT_RESOLVER_MESSAGE_CODES.set(message, "task_graph_prepare_or_load")
}
for (const message of `task_graph_item_revision_conflict task_graph_revision_transition_mismatch`.split(/\s+/)) {
  SAFE_WAIT_RESOLVER_MESSAGE_CODES.set(message, "task_graph_persist_revision_conflict")
}
SAFE_WAIT_RESOLVER_MESSAGE_CODES.set("task_graph_event_outbox_conflict", "task_graph_persist_outbox_conflict")
SAFE_WAIT_RESOLVER_MESSAGE_CODES.set("task_graph_session_sequence_unavailable", "task_graph_persist_sequence_unavailable")
for (const code of `invalid_shape invalid_options invalid_state revision_mismatch empty_proposal duplicate_key unknown_template missing_dependency
  dependency_cycle node_limit depth_limit node_not_found invalid_transition dependencies_incomplete blocked_dependency idempotency_conflict
  verification_required verification_invalid unsupported_verification_template repair_invalid`.split(/\s+/)) {
  SAFE_WAIT_RESOLVER_MESSAGE_CODES.set(`task_graph_transition_rejected:${code}`,
    code === "idempotency_conflict" || code === "revision_mismatch" ? code : "task_graph_transition_rejected")
}

function safeWaitResolverErrorCode(error) {
  const code = error && typeof error === "object" ? error.code : null
  if (code === "task_graph_transition_rejected:idempotency_conflict") return "idempotency_conflict"
  if (code === "task_graph_transition_rejected:revision_mismatch") return "revision_mismatch"
  if (typeof code === "string" && SAFE_WAIT_RESOLVER_ERROR_CODES.has(code)) return code
  const message = error instanceof Error ? SAFE_WAIT_RESOLVER_MESSAGE_CODES.get(error.message) : undefined
  return message ?? (error instanceof Error ? "error" : "unknown")
}

export function installWaitResolverDiagnostics(say, targetConsole = console) {
  const originalConsoleError = targetConsole.error.bind(targetConsole)
  const reportedWaitResolverErrorCodes = new Set()
  targetConsole.error = (...args) => {
    if (args[0] === "[wait-resolver] scan failed:") {
      const code = safeWaitResolverErrorCode(args[1])
      if (reportedWaitResolverErrorCodes.has(code)) return
      reportedWaitResolverErrorCodes.add(code)
      say(`P1143_WAIT_RESOLVER_ERROR:${code}`)
      return
    }
    originalConsoleError(...args)
  }
}
