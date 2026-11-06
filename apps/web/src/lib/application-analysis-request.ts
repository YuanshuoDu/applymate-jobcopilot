/** Keep a bounded, memory-only result for a completed unchanged analysis. */
export function createApplicationAnalysisRequestPool<T>(retain?: (result: T) => boolean) {
  const inFlight = new Map<string, Promise<T>>()
  const completed = new Map<string, T>()
  const request = (key: string, start: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key)
    if (existing) return existing
    if (completed.has(key)) return Promise.resolve(completed.get(key) as T)
    const pending = start()
    inFlight.set(key, pending)
    void pending.then(
      result => {
        if (inFlight.get(key) !== pending) return
        inFlight.delete(key)
        if (retain?.(result)) {
          completed.set(key, result)
          if (completed.size > 20) completed.delete(completed.keys().next().value as string)
        }
      },
      () => { if (inFlight.get(key) === pending) inFlight.delete(key) },
    )
    return pending
  }
  request.forget = (key: string) => { inFlight.delete(key); completed.delete(key) }
  return request
}
