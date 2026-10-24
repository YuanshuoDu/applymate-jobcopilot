import { AsyncLocalStorage } from "node:async_hooks"

export const SCHEDULED_GATE_FINISH_STAGES = ["not_observed", "pre_query_guard", "gate_lease", "execution", "turn",
  "registration", "prepare_wait", "prepare_step", "prepare_prefix"] as const
export type ScheduledGateFinishStage = typeof SCHEDULED_GATE_FINISH_STAGES[number]
type ValidatorStage = Exclude<ScheduledGateFinishStage, "not_observed" | "pre_query_guard">
type Trace = { graphTransitions: number; validatorStarted: boolean; rank: number; stage: ScheduledGateFinishStage; frozen: boolean }
type QueryConfig = { text?: unknown }
export type ScheduledGateFinishTrace<T> = { ok: true; value: T; stage: ScheduledGateFinishStage }
  | { ok: false; error: unknown; stage: ScheduledGateFinishStage }
const traceStorage = new AsyncLocalStorage<Trace>()
const stageRanks: Readonly<Record<ValidatorStage, number>> = {
  gate_lease: 1, execution: 2, turn: 3, registration: 4, prepare_wait: 5, prepare_step: 6, prepare_prefix: 7,
}
const gateFailureReasons = new Set([
  "scheduled_gate_task_invalid", "scheduled_gate_cancelled", "scheduled_gate_handoff_retryable", "scheduled_gate_runtime_failed",
  "scheduled_gate_checkpoint_invalid", "scheduled_gate_owner_stale", "scheduled_gate_graph_invalid",
  "scheduled_gate_registration_invalid", "scheduled_gate_prepare_proof_invalid", "scheduled_gate_analyze_proof_invalid",
  "scheduled_pipeline_owner_mismatch", "scheduled_pipeline_turn_stale", "scheduled_pipeline_mode_mismatch",
  "scheduled_pipeline_root_mismatch", "scheduled_pipeline_execution_mismatch", "scheduled_pipeline_attestation_invalid",
  "scheduled_pipeline_snapshot_mismatch", "scheduled_pipeline_discovery_incomplete", "scheduled_pipeline_jobs_mismatch",
  "scheduled_pipeline_claim_conflict", "scheduled_pipeline_analysis_interrupted", "scheduled_pipeline_request_invalid",
  "scheduled_pipeline_unauthorized", "scheduled_pipeline_account_unavailable", "scheduled_pipeline_entitlement_required",
  "scheduled_pipeline_ai_unavailable", "scheduled_pipeline_ai_budget_exhausted", "scheduled_pipeline_gate_checkpoint_missing",
  "scheduled_pipeline_wait_identity_mismatch", "scheduled_pipeline_gate_checkpoint_unexpected",
  "scheduled_pipeline_analyze_checkpoint_invalid", "scheduled_pipeline_gate_input_invalid", "scheduled_pipeline_gate_response_invalid",
  "scheduled_pipeline_agent_unavailable", "scheduled_pipeline_resume_unavailable", "scheduled_pipeline_execution_failed",
  "scheduled_pipeline_gate_proof_invalid", "scheduled_pipeline_handoff_unavailable", "scheduled_pipeline_handoff_in_progress",
  "scheduled_pipeline_handoff_retryable", "scheduled_gate_result_invalid", "task_graph_verification_unverified",
  "task_graph_verification_failed", "task_graph_repair_target_unresolved",
])
const choiceFailureReasons = new Set([
  "scheduled_gate_choice_scope_invalid", "scheduled_gate_choice_checkpoint_invalid", "scheduled_gate_choice_graph_invalid",
  "scheduled_gate_choice_history_invalid",
])
const choiceSqlStates = new Set(["23503", "23505", "23514", "40001", "40P01", "42501", "42703", "42P01", "55P03", "57014", "22P02"])

export function scheduledGateChoiceFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "unknown"
  const value = error as { message?: unknown; code?: unknown }
  if (typeof value.message === "string" && choiceFailureReasons.has(value.message)) return value.message
  return typeof value.code === "string" && choiceSqlStates.has(value.code) ? `pg_${value.code.toLowerCase()}` : "unknown"
}

export async function withScheduledGateChoiceTrace<T>(work: () => Promise<T>, onPhase: (phase: string) => void): Promise<T> {
  onPhase("started")
  try {
    const value = await work()
    onPhase("loaded")
    return value
  } catch (error: unknown) {
    onPhase(`failed_${scheduledGateChoiceFailureCode(error)}`)
    throw error
  }
}

export function scheduledGateRuntimeDiagnostic(phase: unknown, leaseAttempt: unknown, requestedAttempt: unknown): string {
  const safeFailure = typeof phase === "string" && phase.startsWith("failed_") ? phase.slice(7) : ""
  const sqlState = safeFailure.startsWith("pg_") ? safeFailure.slice(3) : ""
  const allowedPhase = phase === "not_started" || phase === "started" || phase === "loaded"
    || choiceFailureReasons.has(safeFailure) || safeFailure === "unknown"
    || choiceSqlStates.has(sqlState.toUpperCase()) && sqlState === sqlState.toLowerCase()
  const safePhase = allowedPhase ? String(phase) : "unknown"
  const safeAttempt = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 54 ? String(value) : "none"
  return `${safePhase}_lease_${safeAttempt(leaseAttempt)}_request_${safeAttempt(requestedAttempt)}`
}

export function isScheduledGateFailureReason(value: unknown): value is string {
  return typeof value === "string" && gateFailureReasons.has(value)
}
export function isScheduledGateFinishStage(value: unknown): value is ScheduledGateFinishStage {
  return typeof value === "string" && (SCHEDULED_GATE_FINISH_STAGES as readonly string[]).includes(value)
}

export async function withScheduledGateFinishTrace<T>(work: () => Promise<T>): Promise<ScheduledGateFinishTrace<T>> {
  const trace: Trace = { graphTransitions: 0, validatorStarted: false, rank: 0, stage: "not_observed", frozen: false }
  const stage = () => trace.stage === "not_observed" ? "pre_query_guard" : trace.stage
  try { return { ok: true, value: await traceStorage.run(trace, work), stage: stage() } }
  catch (error: unknown) { return { ok: false, error, stage: stage() } }
}

/** Wraps only clients acquired from this pool; query and release calls retain their original receiver and arguments. */
export function createScheduledGateFinishDiagnosticPool<T extends object>(pool: T): T {
  return new Proxy(pool, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (property !== "connect" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value
      return new Proxy(value, {
        apply(connect, _receiver, args: unknown[]) {
          const callbackIndex = args.findIndex(argument => typeof argument === "function")
          if (callbackIndex >= 0) {
            const forwarded = [...args], callback = forwarded[callbackIndex]
            if (typeof callback === "function") forwarded[callbackIndex] = function (this: unknown, ...callbackArgs: unknown[]) {
              if (callbackArgs.length < 2) return Reflect.apply(callback, this, callbackArgs)
              const values = [...callbackArgs]
              values[1] = wrapClient(values[1])
              return Reflect.apply(callback, this, values)
            }
            return Reflect.apply(connect, target, forwarded)
          }
          const connected: unknown = Reflect.apply(connect, target, args)
          return isPromiseLike(connected) ? connected.then(wrapClient) : connected
        },
      })
    },
  }) as T
}

export function classifyScheduledGateFinishQuery(value: unknown): string | null {
  const sql = queryText(value).replace(/\s+/g, " ").toLowerCase()
  if (sql.includes('select task."turnid", task."roottaskid"') && sql.includes('from "sub_agent_tasks" as task')) return "graph_transition_identity"
  if (sql.includes('as "leasevalid"') && sql.includes('"maxattempts"')) return "gate_lease"
  if (sql.includes('from "agent_executions"') && sql.includes('"state"')) return "execution"
  if (sql.includes('from "agent_sessions" as session') && sql.includes('join "agent_turns" as turn')
    && sql.includes('join "sub_agent_tasks" as root')) return "turn"
  if (sql.includes('from "agent_events" as event') && sql.includes('event."actor"') && sql.includes('"hasoutbox"')) return "registration"
  if (sql.includes('from "agent_wait_conditions"')) return "prepare_wait"
  if (sql.includes('from "agent_steps"')) return "prepare_step"
  if (sql.includes('agent_artifact') || sql.includes('agent_items') || sql.includes('verification_receipt')) return "prepare_prefix"
  return null
}

function wrapClient(value: unknown): unknown {
  if (!value || typeof value !== "object") return value
  return new Proxy(value, {
    get(target, property) {
      const method = Reflect.get(target, property, target)
      if (property === "query" && typeof method === "function") return (...args: unknown[]) => {
        observeQuery(args[0])
        return Reflect.apply(method, target, args)
      }
      return typeof method === "function" ? method.bind(target) : method
    },
  })
}

function observeQuery(value: unknown): void {
  const trace = traceStorage.getStore()
  if (!trace || trace.frozen) return
  const classified = classifyScheduledGateFinishQuery(value)
  if (classified === "graph_transition_identity") {
    trace.graphTransitions += 1
    if (trace.graphTransitions >= 2) {
      if (!trace.validatorStarted) trace.stage = "pre_query_guard"
      trace.frozen = true
    }
    return
  }
  if (classified === "gate_lease") {
    trace.validatorStarted = true
    advance(trace, "gate_lease")
  } else if (trace.validatorStarted && classified && classified in stageRanks) {
    advance(trace, classified as ValidatorStage)
  } else if (trace.validatorStarted && trace.rank >= stageRanks.prepare_step) {
    advance(trace, "prepare_prefix")
  }
}

function advance(trace: Trace, stage: ValidatorStage): void {
  const rank = stageRanks[stage]
  if (rank > trace.rank) { trace.rank = rank; trace.stage = stage }
}
function queryText(value: unknown): string {
  if (typeof value === "string") return value
  return value && typeof value === "object" && "text" in value && typeof (value as QueryConfig).text === "string"
    ? (value as QueryConfig).text as string : ""
}
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof value === "object" && "then" in value
    && typeof (value as { then?: unknown }).then === "function"
}
