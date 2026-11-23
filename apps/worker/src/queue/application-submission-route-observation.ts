export type SubmissionRouteObservationResult =
  | { readonly kind: "matched"; readonly work: Promise<void> }
  | { readonly kind: "no_match" }

export type SubmissionRouteObservation = Readonly<{
  readonly pending: Promise<SubmissionRouteObservationResult>
  observe(work: Promise<void>): boolean
  close(): boolean
  dispose(): void
}>

// Keep the work promise inside an envelope so the observation resolves before the work itself.
export function createSubmissionRouteObservation(signal?: AbortSignal): SubmissionRouteObservation {
  let resolvePending!: (result: SubmissionRouteObservationResult) => void
  let settled = false
  const pending = new Promise<SubmissionRouteObservationResult>(resolve => { resolvePending = resolve })
  const close = (): boolean => settle({ kind: "no_match" })
  const onAbort = (): void => { close() }
  const settle = (result: SubmissionRouteObservationResult): boolean => {
    if (settled) return false
    settled = true
    resolvePending(result)
    return true
  }

  if (signal?.aborted) close()
  else signal?.addEventListener("abort", onAbort, { once: true })

  return {
    pending,
    observe: work => settle({ kind: "matched", work }),
    close,
    dispose: () => {
      close()
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

type Outcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }

export async function runAndSettleSubmissionRoute<T>(input: Readonly<{
  run(): Promise<T>
  observation(): SubmissionRouteObservation | null | undefined
  currentWork(): Promise<void> | null
}>): Promise<T> {
  let runOutcome: Outcome<T>
  try { runOutcome = { kind: "fulfilled", value: await input.run() } }
  catch (error: unknown) { runOutcome = { kind: "rejected", error } }

  let routeOutcome: Outcome<void>
  try {
    const observation = input.observation()
    const observed = observation ? await observation.pending : { kind: "no_match" as const }
    const work = observed.kind === "matched" ? observed.work : null
    const current = input.currentWork()
    const workItems = work && current && work !== current ? [work, current] : work ? [work] : current ? [current] : []
    const settled = await Promise.allSettled(workItems)
    const rejection = settled.find((item): item is PromiseRejectedResult => item.status === "rejected")
    if (rejection) throw rejection.reason
    routeOutcome = { kind: "fulfilled", value: undefined }
  } catch (error: unknown) {
    routeOutcome = { kind: "rejected", error }
  }

  if (runOutcome.kind === "rejected") throw runOutcome.error
  if (routeOutcome.kind === "rejected") throw routeOutcome.error
  return runOutcome.value
}
