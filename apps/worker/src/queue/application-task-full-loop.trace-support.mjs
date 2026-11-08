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
