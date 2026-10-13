import { DelayedError } from "bullmq"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runWithSubagentConcurrencyDeferral } from "./subagent-concurrency-deferral.js"
import { SubagentLimitError } from "../runtime/subagents/types.js"

describe("runWithSubagentConcurrencyDeferral", () => {
  afterEach(() => vi.restoreAllMocks())

  it("moves the same locked job by a fixed short delay and signals BullMQ's no-attempt deferral", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000)
    const job = { moveToDelayed: vi.fn(async (_timestamp: number, _token?: string) => undefined) }
    const concurrency = new SubagentLimitError("concurrency", "session is full")
    const run = vi.fn(async () => { throw concurrency })

    await expect(runWithSubagentConcurrencyDeferral({ job, token: "bull-lock-token", run })).rejects.toBeInstanceOf(DelayedError)

    expect(run).toHaveBeenCalledOnce()
    expect(job.moveToDelayed).toHaveBeenCalledOnce()
    const [timestamp, token] = job.moveToDelayed.mock.calls[0]!
    expect(timestamp).toBe(10_500)
    expect(token).toBe("bull-lock-token")
  })

  it.each(["depth", "fan_out", "attempts"] as const)("does not defer the %s hard-limit error", async code => {
    const job = { moveToDelayed: vi.fn(async (_timestamp: number, _token?: string) => undefined) }
    const hardLimit = new SubagentLimitError(code, "hard limit")
    await expect(runWithSubagentConcurrencyDeferral({ job, token: "bull-lock-token", run: async () => { throw hardLimit } })).rejects.toBe(hardLimit)
    expect(job.moveToDelayed).not.toHaveBeenCalled()
  })

  it("does not defer arbitrary concurrency-shaped errors or successful work", async () => {
    const job = { moveToDelayed: vi.fn(async (_timestamp: number, _token?: string) => undefined) }
    const shaped = Object.assign(new Error("not the typed limiter error"), { code: "concurrency" })
    await expect(runWithSubagentConcurrencyDeferral({ job, token: "bull-lock-token", run: async () => { throw shaped } })).rejects.toBe(shaped)
    await expect(runWithSubagentConcurrencyDeferral({ job, token: "bull-lock-token", run: async () => "completed" })).resolves.toBe("completed")
    expect(job.moveToDelayed).not.toHaveBeenCalled()
  })

  it.each([undefined, "", "   "] as const)("propagates a real concurrency failure when the lock token is %s", async token => {
    const job = { moveToDelayed: vi.fn(async (_timestamp: number, _token?: string) => undefined) }
    const concurrency = new SubagentLimitError("concurrency", "session is full")
    await expect(runWithSubagentConcurrencyDeferral({ job, token, run: async () => { throw concurrency } })).rejects.toBe(concurrency)
    expect(job.moveToDelayed).not.toHaveBeenCalled()
  })

  it("propagates move-to-delayed failures instead of reporting a deferral", async () => {
    const moveFailure = new Error("move failed")
    const job = { moveToDelayed: vi.fn(async (_timestamp: number, _token?: string) => { throw moveFailure }) }
    const concurrency = new SubagentLimitError("concurrency", "session is full")
    await expect(runWithSubagentConcurrencyDeferral({ job, token: "bull-lock-token", run: async () => { throw concurrency } })).rejects.toBe(moveFailure)
    expect(job.moveToDelayed).toHaveBeenCalledOnce()
  })
})
