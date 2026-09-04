import { describe, expect, it, vi } from "vitest"

import { BrowserApplicationSubmitError, createBrowserApplicationSubmitProvider } from "./browser-submit-provider.js"

describe("createBrowserApplicationSubmitProvider", () => {
  it("returns a durable browser confirmation only after a submitted result", async () => {
    const guard = vi.fn().mockResolvedValue(true)
    const run = vi.fn(async (beforeSubmit: () => Promise<boolean>) => {
      expect(await beforeSubmit()).toBe(true)
      return { status: "submitted" as const, durationMs: 1 }
    })
    const provider = createBrowserApplicationSubmitProvider({ run, confirmationId: "application:task-1", postSubmitUrl: () => "https://jobs.example/confirmation" })
    await expect(provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit: guard })).resolves.toEqual({ confirmationId: "application:task-1", postSubmitUrl: "https://jobs.example/confirmation" })
    expect(run).toHaveBeenCalledOnce()
    expect(guard).toHaveBeenCalledOnce()
  })

  it.each(["manual", "submission_blocked", "failed"] as const)("fails closed for %s", async status => {
    const result = { status, error: "not confirmed", durationMs: 1 } as const
    const provider = createBrowserApplicationSubmitProvider({ run: vi.fn().mockResolvedValue(result), confirmationId: "application:task-1", postSubmitUrl: () => "" })
    await expect(provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit: vi.fn() })).rejects.toMatchObject({
      provider: "browser",
      statusCode: status === "submission_blocked" ? 412 : 409,
      code: status === "submission_blocked" ? "browser_412" : status === "manual" ? "browser_manual" : "browser_failed",
    })
  })
})
