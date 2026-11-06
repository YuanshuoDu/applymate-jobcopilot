const GENERAL_ERROR_CATEGORIES = new Map([
  ["turn_not_owned", "turn_fence"], ["wait_consume_turn_fenced", "turn_fence"],
  ["context_snapshot_missing", "snapshot"], ["context_snapshot_scope_mismatch", "snapshot"],
  ["context_snapshot_sequence_mismatch", "snapshot"], ["task_graph_snapshot_invalid", "snapshot"],
  ["task_graph_snapshot_root_criteria_invalid", "snapshot"], ["task_graph_snapshot_verification_invalid", "snapshot"],
  ["task_graph_snapshot_verification_disposition_invalid", "snapshot"], ["task_graph_snapshot_repair_invalid", "snapshot"],
  ["task_graph_snapshot_native_delegation_invalid", "snapshot"], ["task_graph_snapshot_registered_scout_envelope_invalid", "snapshot"],
  ["task_graph_snapshot_duplicate", "snapshot"], ["task_graph_snapshot_dependency_invalid", "snapshot"],
  ["task_graph_snapshot_verification_dependency_invalid", "snapshot"], ["task_graph_snapshot_cycle_invalid", "snapshot"],
  ["task_graph_task_id_missing", "snapshot"], ["task_graph_snapshot_template_unsupported", "snapshot"],
  ["task_graph_snapshot_too_large", "snapshot"], ["task_graph_revision_invalid", "snapshot"],
  ["task_graph_task_missing", "snapshot"], ["steering_marker_state_invalid", "snapshot"],
  ["tool_result_replay_uncertain", "tool_receipt"], ["wait_consume_verification_report_invalid", "tool_receipt"],
  ["wait_consume_repair_receipt_invalid", "tool_receipt"], ["task_graph_verification_report_invalid", "tool_receipt"],
  ["task_graph_verification_unverified", "tool_receipt"], ["Archived wait result reference is invalid", "tool_receipt"],
  ["wait_consume_outcome_invalid", "wait_accounting"], ["archived_wait_accounting_invalid", "wait_accounting"],
  ["Archived wait control is unavailable", "wait_accounting"], ["Archived wait recovery is unavailable", "wait_accounting"],
  ["final_evidence_recovery_marker_invalid", "wait_accounting"], ["turn_goal_missing", "turn_input"],
  ["cognitive_agenda_scope_invalid", "agenda"], ["cognitive_agenda_sequence_invalid", "agenda"],
  ["cognitive_agenda_receipt_invalid", "agenda"], ["cognitive_agenda_resume_fence_invalid", "agenda"],
  ["native_verification_root_scope_invalid", "native_verification"], ["native_verification_target_scope_invalid", "native_verification"],
  ["native_verification_target_shape_invalid", "native_verification"], ["native_verification_target_contract_invalid", "native_verification"],
  ["native_verification_source_stale", "native_verification"], ["native_verification_provenance_cycle", "native_verification"],
])

const QUESTION_STORE_CATEGORIES = new Map([
  ["question_conflict", "question_store_conflict"],
  ["question_receipt_missing", "question_store_receipt_missing"],
  ["question_receipt_malformed", "question_store_receipt_malformed"],
  ["question_usage_unavailable", "question_store_usage_unavailable"],
  ["question_invalid_owner", "question_store_owner_invalid"],
  ["question_not_current", "question_store_not_current"],
])

const QUESTION_RECOVERY_CATEGORIES = new Map([
  ["question_recovery_start_lineage_invalid", "question_recovery_start"],
  ["question_recovery_start_event_ambiguous", "question_recovery_start"],
  ["question_recovery_answer_lineage_invalid", "question_recovery_answer"],
  ["question_recovery_answer_event_ambiguous", "question_recovery_answer"],
  ["question_recovery_item_scope_invalid", "question_recovery_item"],
  ["question_recovery_item_id_invalid", "question_recovery_item"],
  ["question_recovery_item_malformed", "question_recovery_item"],
  ["question_recovery_step_invalid", "question_recovery_step"],
  ["question_recovery_step_missing", "question_recovery_step"],
  ["question_recovery_order_invalid", "question_recovery_step"],
  ["question_recovery_tool_lineage_invalid", "question_recovery_tool"],
  ["question_recovery_history_duplicate", "question_recovery_history"],
  ["question_recovery_history_collision", "question_recovery_history"],
  ["question_recovery_history_order_invalid", "question_recovery_history"],
  ["question_recovery_history_pair_incomplete", "question_recovery_history"],
  ["question_recovery_history_pair_invalid", "question_recovery_history"],
  ["question_recovery_history_limit", "question_recovery_history"],
  ["question_recovery_event_history_limit", "question_recovery_history"],
  ["question_recovery_planning_summary_ambiguous", "question_recovery_history"],
  ["question_recovery_current_turn_scope_invalid", "question_recovery_history"],
  ["question_recovery_sequence_invalid", "question_recovery_sequence"],
  ["question_recovery_event_scope_invalid", "question_recovery_other"],
])

const POSTGRES_CODES = new Map([
  ["database_schema", "3D000 3F000 42601 42602 42701 42702 42703 42704 42710 42712 42723 42725 42883 42P01 42P02"],
  ["database_data", "22000 22001 22002 22003 22004 22007 22008 22012 22018 22021 22023 22P01 22P02 22P03 22P04 22P05 23000 23001 23502 23503 23505 23514 23P01"],
  ["database_concurrency", "40000 40001 40002 40003 40P01 55P03 55006"],
  ["database_other", "08000 08001 08003 08004 08006 08007 08P01 0A000 53000 53100 53200 53300 53400 57000 57014 57P01 57P02 57P03 57P04 57P05 58000 58030 58P01 58P02 XX000 XX001 XX002"],
].map(([category, codes]) => [category, new Set(codes.split(" "))]))
const DATABASE_TRANSPORT_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN", "ENOTFOUND"])

const CATEGORIES = new Set([
  ...GENERAL_ERROR_CATEGORIES.values(), ...QUESTION_STORE_CATEGORIES.values(), ...QUESTION_RECOVERY_CATEGORIES.values(),
  "type_error", "reference_error", "database_schema", "database_data", "database_concurrency", "database_other",
  "database_transport", "snapshot_store_conflict", "snapshot_checksum_mismatch", "wait_control_conflict",
  "wait_result_reference_invalid", "agenda", "other",
])

function dataProperty(value, key) {
  if (!value || typeof value !== "object") return undefined
  try {
    let current = value
    for (let depth = 0; current && depth < 4; depth += 1, current = Object.getPrototypeOf(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key)
      if (descriptor) return "value" in descriptor ? descriptor.value : undefined
    }
  } catch { return undefined }
  return undefined
}

/** Returns only a fixed category; error messages and codes are never returned to the fixture log. */
export function classifyStateLoadError(error) {
  try {
    const name = dataProperty(error, "name"), code = dataProperty(error, "code"), message = dataProperty(error, "message")
    if (name === "TurnQuestionStoreError") return QUESTION_STORE_CATEGORIES.get(code) ?? "other"
    if (name === "ContextSnapshotError") {
      if (code === "store_conflict") return "snapshot_store_conflict"
      if (code === "checksum_mismatch") return "snapshot_checksum_mismatch"
      return "other"
    }
    if (name === "TurnEngineError") {
      if (code === "persistence_conflict") return "wait_control_conflict"
      if (code === "invalid_output") return "wait_result_reference_invalid"
      return "other"
    }
    if (name === "CanonicalSteeringMarkerError") return code === "steering_marker_state_invalid" ? "snapshot" : "other"
    const questionCategory = QUESTION_RECOVERY_CATEGORIES.get(message)
    if (questionCategory) return questionCategory
    const fixedCategory = GENERAL_ERROR_CATEGORIES.get(message)
    if (fixedCategory) return fixedCategory
    if (error instanceof TypeError) return "type_error"
    if (error instanceof ReferenceError) return "reference_error"
    for (const [category, codes] of POSTGRES_CODES) if (typeof code === "string" && codes.has(code)) return category
    if (typeof code === "string" && DATABASE_TRANSPORT_CODES.has(code)) return "database_transport"
    return "other"
  } catch { return "other" }
}

export function safeStateLoadCategory(value) {
  return CATEGORIES.has(value) ? value : "other"
}

export function classifyStateLoadQuery(statement) {
  if (typeof statement !== "string") return "other"
  const sql = statement.replace(/\s+/g, " ").toLowerCase()
  if (/^(begin|commit|rollback|savepoint|release savepoint)\b/.test(sql)) return "transaction"
  if (sql.includes("set_config")) return "rls_config"
  if (sql.includes("agent_context_snapshots")) return "snapshot"
  if (sql.includes("native_verification") || sql.includes("current_start")) return "native_advisory"
  if (sql.includes("questionitemid") || sql.includes("'waitid'") || sql.includes("'schemaversion'")
    || sql.includes("turn.\"roottaskid\"")) return "question_planning"
  if (sql.includes("question.answered") || sql.includes("agent.ask_user") || sql.includes("answeravailable")) return "question_lineage"
  if (sql.includes("agent_wait_conditions")) return "wait_outcomes"
  if (sql.includes("max(\"ordinal\")")) return "ordinal"
  if (sql.includes("\"targetturnid\" = $1") && sql.includes("\"acceptedsequence\"")) return "root_input"
  if (sql.includes("from \"agent_turns\"")) return "turn"
  if (sql.includes("from \"agent_steps\"")) return "steps"
  if (sql.includes("from \"agent_items\"")) return "items"
  if (sql.includes("from \"agent_events\"")) return "events"
  if (sql.includes("from \"agent_inputs\"")) return "inputs"
  if (sql.includes("sub_agent_tasks")) return "root_task"
  if (sql.includes("agent_sessions")) return "sessions"
  return "other"
}

const MAX_QUERY_MARKER_PAIRS = 48
function report(emit, group, phase) {
  try { emit(`SYNTHETIC_STATE_QUERY ${group} ${phase}`) } catch { /* Diagnostics cannot change loader behavior. */ }
}

/** Transparently instruments one loader invocation's pool; it never logs SQL, values, IDs, or thrown errors. */
export function withStateLoadQueryDiagnostics(operation, emit = marker => process.stdout.write(`${marker}\n`)) {
  if (typeof operation !== "function") throw new TypeError("state loader operation is required")
  return function (...args) {
    const pool = args[0]
    if (!pool || typeof pool.connect !== "function") return Reflect.apply(operation, this, args)
    const observedPool = {
      connect(...connectArgs) {
        const enabled = this.queryCount < MAX_QUERY_MARKER_PAIRS
        this.queryCount += 1
        if (enabled) report(emit, "connection", "start")
        let pending
        try { pending = Reflect.apply(pool.connect, pool, connectArgs) }
        catch (error) { if (enabled) report(emit, "connection", "fail"); throw error }
        return Promise.resolve(pending).then(client => {
          if (enabled) report(emit, "connection", "pass")
          const query = (...queryArgs) => {
            const group = classifyStateLoadQuery(queryArgs[0])
            const queryEnabled = this.queryCount < MAX_QUERY_MARKER_PAIRS
            this.queryCount += 1
            if (queryEnabled) report(emit, group, "start")
            let result
            try { result = Reflect.apply(client.query, client, queryArgs) }
            catch (error) { if (queryEnabled) report(emit, group, "fail"); throw error }
            if (result && typeof result.then === "function") return result.then(
              value => { if (queryEnabled) report(emit, group, "pass"); return value },
              error => { if (queryEnabled) report(emit, group, "fail"); throw error },
            )
            if (queryEnabled) report(emit, group, "pass")
            return result
          }
          return { query, release: (...releaseArgs) => Reflect.apply(client.release, client, releaseArgs) }
        }, error => { if (enabled) report(emit, "connection", "fail"); throw error })
      },
      queryCount: 0,
    }
    return Reflect.apply(operation, this, [observedPool, ...args.slice(1)])
  }
}
