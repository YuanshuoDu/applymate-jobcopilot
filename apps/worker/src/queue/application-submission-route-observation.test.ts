import { describe, expect, it } from "vitest"
import { createSubmissionRouteObservation, runAndSettleSubmissionRoute } from "./application-submission-route-observation.js"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe("submission route observation", () => {
  it("hands off the assigned work promise without awaiting or assimilating it", async () => {
    const work = deferred<void>()
    const observation = createSubmissionRouteObservation()
    expect(observation.observe(work.promise)).toBe(true)
    const result = await observation.pending
    expect(result).toEqual({ kind: "matched", work: work.promise })
    work.resolve(undefined)
  })

  it("settles as no-match on abort and rejects a later route handoff", async () => {
    const controller = new AbortController()
    const observation = createSubmissionRouteObservation(controller.signal)
    controller.abort()
    await expect(observation.pending).resolves.toEqual({ kind: "no_match" })
    expect(observation.observe(Promise.resolve())).toBe(false)
    observation.dispose()
  })

  it("waits for a delayed matching callback after a normal runner result", async () => {
    const observation = createSubmissionRouteObservation()
    const work = deferred<void>()
    let returned = false
    const settlement = runAndSettleSubmissionRoute({
      run: async () => "manual",
      observation: () => observation,
      currentWork: () => null,
    }).then(value => { returned = true; return value })

    await Promise.resolve()
    expect(returned).toBe(false)
    expect(observation.observe(work.promise)).toBe(true)
    await Promise.resolve()
    expect(returned).toBe(false)
    work.resolve(undefined)
    await expect(settlement).resolves.toBe("manual")
  })

  it("drains matched work before preserving a rejected runner error", async () => {
    const observation = createSubmissionRouteObservation()
    const work = deferred<void>()
    const runnerError = new Error("runner failed")
    let returned = false
    const settlement = runAndSettleSubmissionRoute({
      run: async () => { throw runnerError },
      observation: () => observation,
      currentWork: () => null,
    }).catch(error => { returned = true; throw error })

    await Promise.resolve()
    expect(returned).toBe(false)
    observation.observe(work.promise)
    await Promise.resolve()
    expect(returned).toBe(false)
    work.resolve(undefined)
    await expect(settlement).rejects.toBe(runnerError)
  })

  it("drains active work when there is no armed observation", async () => {
    const work = deferred<void>()
    let returned = false
    const settlement = runAndSettleSubmissionRoute({
      run: async () => "manual",
      observation: () => null,
      currentWork: () => work.promise,
    }).then(value => { returned = true; return value })

    await Promise.resolve()
    expect(returned).toBe(false)
    work.resolve(undefined)
    await expect(settlement).resolves.toBe("manual")
  })

  it("preserves the runner error if route work also rejects", async () => {
    const observation = createSubmissionRouteObservation()
    const runnerError = new Error("runner failed")
    const routeError = new Error("route failed")
    const settlement = runAndSettleSubmissionRoute({
      run: async () => { throw runnerError },
      observation: () => observation,
      currentWork: () => null,
    })
    observation.observe(Promise.reject(routeError))
    await expect(settlement).rejects.toBe(runnerError)
  })
})
