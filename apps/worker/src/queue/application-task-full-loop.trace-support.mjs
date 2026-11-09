export function traceApplicationFillExecutor(executor) {
  if (!executor) return undefined
  return async input => {
    const lease = input?.lease
    if (lease?.role !== "application_filler" || lease.taskType !== "application_fill_for_review") return executor(input)

    const attemptCount = Number.isSafeInteger(lease?.attemptCount) ? lease.attemptCount : null
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
      const stages = ["entry_validation", "wait_persistence", "completion"]
      const outcomes = ["accepted", "rejected", "waiting", "completed", "stale", "conflict", "failed", "cancelled", "unavailable"]
      const staleGates = ["lease_input_invalid", "session_scope", "turn_scope", "child_lease_fence", "application_task_scope"]
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
