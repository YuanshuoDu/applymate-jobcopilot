import type { Pool, PoolClient } from "pg"

export const OBJECTIVE_SUBMISSION_FENCE_ACQUISITION_TIMEOUT_MS = 8_000

type PermitRelease = () => void
type Cancellation = "cancelled" | "timed_out"
type PermitWaiter = {
  signal: AbortSignal
  resolve: (release: PermitRelease | null) => void
  cancel: () => void
  settled: boolean
}
export type ObjectiveSubmissionFenceClient = Readonly<{
  client: PoolClient
  queryClient: PoolClient
  release(error?: Error | boolean): void
  readonly isReleased: boolean
}>

const permitQueue: PermitWaiter[] = []
let permitHeld = false
const latePoolCheckouts = new WeakMap<object, Promise<void>>()

function pumpPermitQueue(): void {
  if (permitHeld) return
  while (permitQueue.length) {
    const waiter = permitQueue.shift()!
    if (waiter.settled || waiter.signal.aborted) {
      waiter.settled = true
      waiter.signal.removeEventListener("abort", waiter.cancel)
      waiter.resolve(null)
      continue
    }
    permitHeld = true
    waiter.settled = true
    waiter.signal.removeEventListener("abort", waiter.cancel)
    let released = false
    waiter.resolve(() => {
      if (released) return
      released = true
      permitHeld = false
      pumpPermitQueue()
    })
    return
  }
}

function acquirePermit(signal: AbortSignal): Promise<PermitRelease | null> {
  if (signal.aborted) return Promise.resolve(null)
  return new Promise(resolve => {
    const waiter: PermitWaiter = {
      signal, resolve, settled: false,
      cancel: () => {
        if (waiter.settled) return
        waiter.settled = true
        const index = permitQueue.indexOf(waiter)
        if (index >= 0) permitQueue.splice(index, 1)
        signal.removeEventListener("abort", waiter.cancel)
        resolve(null)
      },
    }
    permitQueue.push(waiter)
    signal.addEventListener("abort", waiter.cancel, { once: true })
    if (signal.aborted) waiter.cancel()
    pumpPermitQueue()
  })
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const finish = (): void => { signal.removeEventListener("abort", finish); resolve() }
    signal.addEventListener("abort", finish, { once: true })
    if (signal.aborted) finish()
  })
}

function trackClient(client: PoolClient, signal: AbortSignal, onRelease: () => void): ObjectiveSubmissionFenceClient {
  let released = false
  const release = (error?: Error | boolean): void => {
    if (released) return
    released = true
    signal.removeEventListener("abort", destroy)
    try { client.release(error) } finally { onRelease() }
  }
  const destroy = (): void => { release(new Error("Objective submission fence acquisition ended.")) }
  signal.addEventListener("abort", destroy, { once: true })
  if (signal.aborted) destroy()

  type Query = (...args: unknown[]) => Promise<unknown>
  const originalQuery = client.query.bind(client) as unknown as Query
  const query = (...args: unknown[]): Promise<unknown> => abortableQuery(() => originalQuery(...args), signal)
  const queryClient = new Proxy(client, {
    get(target, property) {
      if (property === "query") return query
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as PoolClient
  return { client, queryClient, release, get isReleased() { return released } }
}

function abortableQuery<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Objective submission fence acquisition ended."))
  const query = Promise.resolve().then(() => {
    if (signal.aborted) throw new Error("Objective submission fence acquisition ended.")
    return run()
  })
  query.catch(() => undefined)
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (complete: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", onAbort)
      complete()
    }
    const onAbort = (): void => finish(() => reject(new Error("Objective submission fence acquisition ended.")))
    signal.addEventListener("abort", onAbort, { once: true })
    query.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    if (signal.aborted) onAbort()
  })
}

export function createObjectiveSubmissionFenceAcquisition(input: Readonly<{
  parentSignal?: AbortSignal
  timeoutMs?: number
}> = {}) {
  const controller = new AbortController()
  let cancellation: Cancellation | null = null
  const parent = input.parentSignal
  const onParentAbort = (): void => {
    if (cancellation !== null) return
    cancellation = "cancelled"
    controller.abort()
  }
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener("abort", onParentAbort, { once: true })

  const timeoutMs = input.timeoutMs === undefined
    ? (parent ? OBJECTIVE_SUBMISSION_FENCE_ACQUISITION_TIMEOUT_MS : undefined)
    : Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0
      ? input.timeoutMs : OBJECTIVE_SUBMISSION_FENCE_ACQUISITION_TIMEOUT_MS
  const timer = timeoutMs === undefined ? null : setTimeout(() => {
    if (cancellation !== null) return
    cancellation = "timed_out"
    controller.abort()
  }, timeoutMs)
  timer?.unref?.()
  let onAbort = (): void => undefined
  const dispose = (): void => {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener("abort", onParentAbort)
    controller.signal.removeEventListener("abort", onAbort)
  }
  const clients = new Set<ObjectiveSubmissionFenceClient>()
  let activePermit: PermitRelease | null = null
  onAbort = (): void => {
    const error = new Error("Objective submission fence acquisition ended.")
    for (const client of [...clients]) client.release(error)
    activePermit?.()
    activePermit = null
    dispose()
  }
  controller.signal.addEventListener("abort", onAbort, { once: true })

  return {
    signal: controller.signal,
    cancellation: (): Cancellation | null => cancellation,
    async acquirePermit(): Promise<PermitRelease | null> {
      const release = await acquirePermit(controller.signal)
      if (!release) return null
      let released = false
      const ownedRelease = (): void => {
        if (released) return
        released = true
        if (activePermit === ownedRelease) activePermit = null
        release()
      }
      activePermit = ownedRelease
      if (controller.signal.aborted) ownedRelease()
      return ownedRelease
    },
    async connect(pool: Pick<Pool, "connect">): Promise<ObjectiveSubmissionFenceClient | null> {
      if (controller.signal.aborted) return null
      const previous = latePoolCheckouts.get(pool)
      if (previous) {
        const drained = await Promise.race([previous.then(() => true), abortPromise(controller.signal).then(() => false)])
        if (!drained || controller.signal.aborted) return null
        if (latePoolCheckouts.get(pool) === previous) latePoolCheckouts.delete(pool)
      }
      let abandoned = false
      let acquired: PoolClient | null = null
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error("Objective submission fence acquisition ended.")
        return pool.connect()
      })
      const checkout = pending.then(client => {
        if (abandoned || controller.signal.aborted) { client.release(); return null }
        acquired = client
        return client
      })
      const drain = checkout.then(() => undefined, () => undefined)
      latePoolCheckouts.set(pool, drain)
      const outcome = await Promise.race([
        checkout.then(client => client ? ({ kind: "connected" as const, client }) : ({ kind: "aborted" as const }), error => ({ kind: "failed" as const, error })),
        abortPromise(controller.signal).then(() => ({ kind: "aborted" as const })),
      ])
      if (outcome.kind === "aborted" || controller.signal.aborted) {
        abandoned = true
        acquired?.release()
        acquired = null
        void drain.then(() => { if (latePoolCheckouts.get(pool) === drain) latePoolCheckouts.delete(pool) })
        return null
      }
      if (outcome.kind === "failed") {
        if (latePoolCheckouts.get(pool) === drain) latePoolCheckouts.delete(pool)
        throw outcome.error
      }
      if (latePoolCheckouts.get(pool) === drain) latePoolCheckouts.delete(pool)
      acquired = null
      let tracked: ObjectiveSubmissionFenceClient | undefined
      tracked = trackClient(outcome.client, controller.signal, () => { if (tracked) clients.delete(tracked) })
      if (!tracked.isReleased) clients.add(tracked)
      return tracked
    },
    dispose(): void {
      dispose()
    },
  }
}
