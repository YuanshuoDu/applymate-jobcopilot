export const OBJECTIVE_SUBMISSION_ROUTE_SETTLE_TIMEOUT_MS = 2_000

export function createObjectiveSubmissionRouteLifecycle(timeoutMs = OBJECTIVE_SUBMISSION_ROUTE_SETTLE_TIMEOUT_MS) {
  const controller = new AbortController()
  let work: Promise<void> | null = null
  let settlement: Promise<boolean> | null = null
  return {
    signal: controller.signal,
    cancel(): void { if (!controller.signal.aborted) controller.abort() },
    track(next: Promise<void>): void {
      work = next
      void next.then(() => { if (work === next) work = null }, () => { if (work === next) work = null })
    },
    settle(): Promise<boolean> {
      if (settlement) return settlement
      const pending = work
      if (!pending) return Promise.resolve(true)
      settlement = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const completed = await Promise.race([
            pending.then(() => true, () => true),
            new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.() }),
          ])
          if (!completed) controller.abort()
          return completed
        } finally { if (timer) clearTimeout(timer) }
      })()
      return settlement
    },
  }
}
