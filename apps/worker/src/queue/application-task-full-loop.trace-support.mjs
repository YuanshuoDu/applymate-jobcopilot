let nextExecutorInvocationOrdinal = 0

const STAGE8_MACHINE_CODES = new Set([
  "cognitive_agenda_resume_fence_invalid", "turn_not_owned", "archived_wait_accounting_invalid",
  "child_wait_claim_recovery_owner_mismatch", "child_resume_wait_tool_call_conflict",
  "persistence_conflict", "turn_execution_error", "application_fill_material_unavailable",
  "application_fill_state_invalid", "application_fill_binding_invalid", "lease_lost",
])
const STAGE8_SQLSTATES = new Set(["08000", "08001", "08003", "08006", "23502", "23503", "23505", "23514", "40001", "40P01", "55P03", "57P01", "57P03"])
const STAGE8_REPO_FILES = new Map([
  ["canonical-turn-runtime.ts", "canonical_turn_runtime"],
  ["canonical-turn-runtime-model.ts", "canonical_turn_model"],
  ["canonical-turn-runtime-turn-setup.ts", "canonical_turn_setup"],
  ["canonical-turn-durable-wait-control.ts", "durable_wait"],
  ["durable-wait-control.ts", "durable_wait"],
  ["turn-execution-child-wait-recovery.ts", "durable_wait"],
  ["durable-wait-resolver.ts", "durable_wait"],
  ["durable-wait-control-reader.ts", "durable_wait"],
  ["durable-wait-consumer.ts", "durable_wait"],
  ["durable-child-wait-replay.ts", "durable_wait"],
  ["durable-wait-store.ts", "durable_wait"],
  ["agent-run-turn-executor.ts", "turn_queue"],
  ["agent-run-queue.ts", "turn_queue"],
  ["production-worker-runtime.ts", "worker_runtime"],
])

function stage8RepoStage(stack) {
  if (typeof stack !== "string") return "other"
  for (const frame of stack.split("\n").slice(1, 41)) {
    const parenthesized = /^\s*at .+ \((.+):\d+:\d+\)$/.exec(frame)
    const bare = /^\s*at ((?:file:\/\/)?[^\s]+):\d+:\d+$/.exec(frame)
    const path = parenthesized?.[1] ?? bare?.[1]
    if (!path) continue
    const file = path.split(/[\\/]/).at(-1)
    const stage = STAGE8_REPO_FILES.get(file)
    if (stage) return stage
  }
  return "other"
}

export function classifyStage8ExecutionFailure(error) {
  const isError = error instanceof Error
  const message = isError && typeof error.message === "string" ? error.message : null
  const code = isError && typeof error.code === "string" ? error.code : null
  const machineCode = [message, code].find(value => value !== null && STAGE8_MACHINE_CODES.has(value))
  const sqlValue = isError && typeof error.sqlState === "string" ? error.sqlState : code
  const sqlState = sqlValue === null || sqlValue === undefined ? "none" : STAGE8_SQLSTATES.has(sqlValue) ? sqlValue : "other"
  const errorKinds = new Map([["Error", "error"], ["TypeError", "type_error"], ["RangeError", "range_error"],
    ["SyntaxError", "syntax_error"], ["ReferenceError", "reference_error"], ["AggregateError", "aggregate_error"]])
  const errorKind = machineCode ? "known_code" : sqlState !== "none" && sqlState !== "other" ? "postgres"
    : isError ? errorKinds.get(error.name) ?? "other" : "non_error"
  return {
    errorKind,
    machineCode: machineCode ?? (message !== null || code !== null ? "other" : "none"),
    repoStage: stage8RepoStage(isError ? error.stack : null),
    sqlState,
  }
}

export function createStage8ExecutionFailureDiagnostics(writeLine, input = process.stdin) {
  let target = null
  let buffer = ""
  input.setEncoding("utf8")
  input.on("data", chunk => {
    buffer += String(chunk)
    if (buffer.length > 1_024) buffer = buffer.slice(-1_024)
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    for (const line of lines) {
      const match = /^stage8-failure-target ([^\s]{1,256}) ([^\s]{1,256})$/.exec(line.trim())
      if (!match || target) continue
      target = { sessionId: match[1], turnId: match[2] }
      writeLine("STAGE8_FAILURE_TARGET_ARMED")
    }
  })
  return {
    record(job, error) {
      if (!target || job?.data?.sessionId !== target.sessionId || job?.data?.turnId !== target.turnId) return false
      writeLine(`STAGE8_TURN_EXECUTION_FAILURE ${JSON.stringify(classifyStage8ExecutionFailure(error))}`)
      return true
    },
  }
}

export function traceApplicationFillExecutor(executor) {
  if (!executor) return undefined
  return async input => {
    const lease = input?.lease
    if (lease?.role !== "application_filler" || lease.taskType !== "application_fill_for_review") return executor(input)

    const attemptCount = Number.isSafeInteger(lease?.attemptCount) ? lease.attemptCount : null
    nextExecutorInvocationOrdinal += 1
    const executorInvocationOrdinal = nextExecutorInvocationOrdinal
    const leaseSignalAbortedAtStart = Boolean(lease?.signal?.aborted)
    const startedAt = Date.now()
    let returned = false
    let threw = false
    let result
    try {
      result = await executor(input)
      returned = true
      return result
    } catch (error) {
      threw = true
      throw error
    } finally {
      try {
        const status = result?.status
        process.stdout.write(`APPLICATION_FILL_EXEC_TRACE ${JSON.stringify({
          attemptCount,
          executorInvocationOrdinal,
          elapsedMs: Math.max(0, Date.now() - startedAt),
          returned,
          threw,
          statusCompleted: status === "completed",
          statusWaiting: status === "waiting",
          statusWaitingForUser: status === "waiting_for_user",
          statusFailed: status === "failed",
          failureReasonLeaseLost: result?.failureReason === "lease_lost",
          leaseSignalAbortedAtStart,
          leaseSignalAbortedAtEnd: Boolean(lease?.signal?.aborted),
        })}\n`)
      } catch {
        // Trace output must not mask the executor result or its error.
      }
    }
  }
}

export function applicationFillStageTrace() {
  return event => {
    try {
      const acquisitionPhases = ["before_control_read", "before_pattern_read", "context_requested", "page_acquired", "navigation_returned", "navigation_response_success", "navigation_response_unavailable", "destination_allowed", "destination_rejected", "wait_detection_returned", "outer_wait_clear", "outer_wait_detected", "executor_started", "executor_wait_clear", "executor_wait_detected", "deterministic_flow_started", "deterministic_flow_review_ready", "deterministic_flow_wait", "deterministic_flow_other", "fill_returned", "callback_settled", "context_returned"]
      if (event?.stage === "browser_acquisition") {
        if (!acquisitionPhases.includes(event.phase)) return
        process.stdout.write("APPLICATION_FILL_PHASE_TRACE " + JSON.stringify({ phase: event.phase }) + "\n")
        return
      }
      const stages = ["entry_validation", "wait_persistence", "completion"]
      const outcomes = ["accepted", "rejected", "waiting", "completed", "stale", "conflict", "failed", "cancelled", "unavailable"]
      const staleGates = ["lease_input_invalid", "session_scope", "turn_row_unavailable", "turn_status_queued", "turn_status_interrupted", "turn_status_terminal", "turn_status_other", "child_lease_fence", "application_task_scope"]
      if (!event || !stages.includes(event.stage) || !outcomes.includes(event.outcome)
        || typeof event.leaseLost !== "boolean" || typeof event.signalAborted !== "boolean"
        || (event.staleGate !== undefined && (!staleGates.includes(event.staleGate) || event.stage !== "completion" || event.outcome !== "stale"))
        || (event.stage === "completion" && event.outcome === "stale" && !event.staleGate)) return
      process.stdout.write(`APPLICATION_FILL_STAGE_TRACE ${JSON.stringify({
        entryValidation: event.stage === "entry_validation", waitPersistence: event.stage === "wait_persistence", completion: event.stage === "completion",
        accepted: event.outcome === "accepted", rejected: event.outcome === "rejected", waiting: event.outcome === "waiting",
        completed: event.outcome === "completed", stale: event.outcome === "stale", conflict: event.outcome === "conflict",
        failed: event.outcome === "failed", cancelled: event.outcome === "cancelled",
        unavailable: event.outcome === "unavailable", leaseLost: event.leaseLost, signalAborted: event.signalAborted,
        ...(event.staleGate ? { staleGate: event.staleGate } : {}),
      })}\n`)
    } catch {
      // Diagnostics must never affect fixture execution.
    }
  }
}
