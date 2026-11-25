import type { Pool, PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"

import { createObjectiveSubmissionFenceAcquisition, OBJECTIVE_SUBMISSION_FENCE_ACQUISITION_TIMEOUT_MS } from "./objective-submission-fence-acquisition.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function fakeClient(query = vi.fn().mockResolvedValue({ rows: [] })) {
  return { query, release: vi.fn() } as unknown as PoolClient & { release: ReturnType<typeof vi.fn> }
}

describe("Objective submission fence acquisition", () => {
  it("removes a cancelled FIFO permit waiter so later callers can proceed", async () => {
    const owner = createObjectiveSubmissionFenceAcquisition({ timeoutMs: 1_000 })
    const ownerRelease = await owner.acquirePermit()
    const cancelledController = new AbortController()
    const waiting = createObjectiveSubmissionFenceAcquisition({ parentSignal: cancelledController.signal, timeoutMs: 1_000 })
    const waitingPermit = waiting.acquirePermit()

    cancelledController.abort()
    await expect(waitingPermit).resolves.toBeNull()
    ownerRelease?.()

    const next = createObjectiveSubmissionFenceAcquisition({ timeoutMs: 1_000 })
    const nextRelease = await next.acquirePermit()
    expect(nextRelease).toEqual(expect.any(Function))
    nextRelease?.()
    owner.dispose(); waiting.dispose(); next.dispose()
  })

  it("releases a pool client that arrives after checkout cancellation", async () => {
    const checkout = deferred<PoolClient>()
    const client = fakeClient()
    const controller = new AbortController()
    const acquisition = createObjectiveSubmissionFenceAcquisition({ parentSignal: controller.signal, timeoutMs: 1_000 })

    const connect = vi.fn(() => checkout.promise)
    const pending = acquisition.connect({ connect } as unknown as Pick<Pool, "connect">)
    await Promise.resolve()
    expect(connect).toHaveBeenCalledOnce()
    controller.abort()
    await expect(pending).resolves.toBeNull()
    checkout.resolve(client)
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledOnce())

    expect(client.release).toHaveBeenCalledOnce()
    acquisition.dispose()
  })

  it("keeps only one outstanding late checkout per pool across cancelled acquisitions", async () => {
    const checkout = deferred<PoolClient>()
    const client = fakeClient()
    const connect = vi.fn(() => checkout.promise)
    const pool = { connect } as unknown as Pick<Pool, "connect">
    const firstController = new AbortController()
    const first = createObjectiveSubmissionFenceAcquisition({ parentSignal: firstController.signal, timeoutMs: 1_000 })
    const firstPending = first.connect(pool)
    firstController.abort()
    await expect(firstPending).resolves.toBeNull()

    const nextController = new AbortController()
    const next = createObjectiveSubmissionFenceAcquisition({ parentSignal: nextController.signal, timeoutMs: 1_000 })
    const nextPending = next.connect(pool)
    await Promise.resolve()
    expect(connect).toHaveBeenCalledOnce()
    nextController.abort()
    await expect(nextPending).resolves.toBeNull()

    checkout.resolve(client)
    await Promise.resolve()
    await Promise.resolve()
    expect(connect).toHaveBeenCalledOnce()
    expect(client.release).toHaveBeenCalledOnce()
    first.dispose(); next.dispose()
  })

  it("does not dispatch pool checkout or SQL after a synchronous abort", async () => {
    const checkoutController = new AbortController()
    const checkout = vi.fn().mockResolvedValue(fakeClient())
    const checkoutAcquisition = createObjectiveSubmissionFenceAcquisition({ parentSignal: checkoutController.signal })
    const pendingCheckout = checkoutAcquisition.connect({ connect: checkout } as unknown as Pick<Pool, "connect">)
    checkoutController.abort()
    await expect(pendingCheckout).resolves.toBeNull()
    expect(checkout).not.toHaveBeenCalled()
    checkoutAcquisition.dispose()

    const queryController = new AbortController()
    const query = vi.fn().mockResolvedValue({ rows: [] })
    const queryAcquisition = createObjectiveSubmissionFenceAcquisition({ parentSignal: queryController.signal })
    const tracked = await queryAcquisition.connect({ connect: vi.fn().mockResolvedValue(fakeClient(query)) } as unknown as Pick<Pool, "connect">)
    const pendingQuery = tracked!.queryClient.query("SELECT 1")
    queryController.abort()
    await expect(pendingQuery).rejects.toThrow("Objective submission fence acquisition ended")
    expect(query).not.toHaveBeenCalled()
    queryAcquisition.dispose()
  })

  it("keeps the prior no-deadline behavior when no Objective cancellation is supplied", async () => {
    vi.useFakeTimers()
    try {
      const acquisition = createObjectiveSubmissionFenceAcquisition()
      const release = await acquisition.acquirePermit()
      await vi.advanceTimersByTimeAsync(OBJECTIVE_SUBMISSION_FENCE_ACQUISITION_TIMEOUT_MS + 1)

      expect(acquisition.cancellation()).toBeNull()
      release?.()
      acquisition.dispose()
    } finally { vi.useRealTimers() }
  })

  it("destroys an active client and rejects its pending query when cancellation wins", async () => {
    const queryResult = deferred<{ rows: unknown[] }>()
    const client = fakeClient(vi.fn(() => queryResult.promise))
    const controller = new AbortController()
    const acquisition = createObjectiveSubmissionFenceAcquisition({ parentSignal: controller.signal, timeoutMs: 1_000 })
    const tracked = await acquisition.connect({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<Pool, "connect">)

    const query = tracked!.queryClient.query("SELECT 1")
    controller.abort()
    await expect(query).rejects.toThrow("Objective submission fence acquisition ended")
    expect(tracked?.isReleased).toBe(true)
    expect(client.release).toHaveBeenCalledWith(expect.any(Error))

    queryResult.resolve({ rows: [] })
    acquisition.dispose()
  })

  it("enforces its deadline while an active transaction query is pending", async () => {
    const client = fakeClient(vi.fn(() => new Promise(() => undefined)))
    const acquisition = createObjectiveSubmissionFenceAcquisition({ timeoutMs: 5 })
    const tracked = await acquisition.connect({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pick<Pool, "connect">)

    const query = tracked!.queryClient.query("SELECT pg_advisory_xact_lock(1)")
    const rejection = expect(query).rejects.toThrow("Objective submission fence acquisition ended")
    await new Promise(resolve => setTimeout(resolve, 10))

    await rejection
    expect(acquisition.cancellation()).toBe("timed_out")
    expect(client.release).toHaveBeenCalledWith(expect.any(Error))
    acquisition.dispose()
  })
})
