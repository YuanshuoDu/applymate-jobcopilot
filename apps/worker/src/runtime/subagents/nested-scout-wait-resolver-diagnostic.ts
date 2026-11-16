const SAFE_WAIT_RESOLVER_CODES = [
  "idempotency_conflict", "revision_mismatch", "wait_invalid", "wait_scope_error", "wait_conflict",
  "40001", "40P01", "55P03", "57014", "08000", "08003", "08006", "57P01", "ECONNRESET", "ETIMEDOUT", "error", "unknown", "other",
  "child_wait_configuration", "child_wait_deadline_revalidation", "child_wait_parent_deadline_scope", "child_wait_schedule_fence",
  "child_wait_session_scope", "task_graph_prepare_or_load", "task_graph_transition_rejected", "task_graph_persist_revision_conflict",
  "task_graph_persist_outbox_conflict", "task_graph_persist_sequence_unavailable",
] as const

export function waitResolverErrorCodesFromOutput(output: readonly string[]): string[] {
  return [...new Set(output.flatMap(value => {
    const match = value.match(/^P1143_WAIT_RESOLVER_ERROR:([A-Za-z0-9_]+)$/)
    return match && SAFE_WAIT_RESOLVER_CODES.includes(match[1] as typeof SAFE_WAIT_RESOLVER_CODES[number]) ? [match[1]] : []
  }))]
}
