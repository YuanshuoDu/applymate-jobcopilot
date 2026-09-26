export type SchedulerTaskState = {
  lastSuccessfulAt: number | null
  consecutiveFailures: number
  nextAttemptAt: number
  lastFailure: string | null
}

export function createSchedulerTaskState(): SchedulerTaskState {
  return { lastSuccessfulAt: null, consecutiveFailures: 0, nextAttemptAt: 0, lastFailure: null }
}

export function getSchedulerTaskState(states: Map<string, SchedulerTaskState>, name: string): SchedulerTaskState {
  const existing = states.get(name)
  if (existing) return existing
  const created = createSchedulerTaskState()
  states.set(name, created)
  return created
}

export function markSchedulerTaskFailure(
  state: SchedulerTaskState,
  failure: string,
  now: number,
  taskIntervalMs: number,
  retryBaseDelayMs: number,
  retryMaxDelayMs: number,
): void {
  state.consecutiveFailures += 1
  const baseDelay = Math.max(taskIntervalMs, retryBaseDelayMs)
  const maxDelay = Math.max(baseDelay, retryMaxDelayMs)
  const exponent = Math.min(state.consecutiveFailures - 1, 30)
  state.nextAttemptAt = now + Math.min(maxDelay, baseDelay * 2 ** exponent)
  state.lastFailure = failure
}

export function markSchedulerTaskSuccess(state: SchedulerTaskState, now: number): void {
  state.lastSuccessfulAt = now
  state.consecutiveFailures = 0
  state.nextAttemptAt = 0
  state.lastFailure = null
}
