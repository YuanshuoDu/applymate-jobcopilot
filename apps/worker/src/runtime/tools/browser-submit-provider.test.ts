import { describe, expect, it, vi } from "vitest"

import { BrowserApplicationSubmitError, createBrowserApplicationSubmitProvider } from "./browser-submit-provider.js"
import type { SubmissionRequestIntent } from "../../flows/submission-intent.js"

describe("createBrowserApplicationSubmitProvider", () => {
  it("returns a durable browser confirmation only after a submitted result", async () => {
    const guard = vi.fn().mockResolvedValue(true)
    const intent: SubmissionRequestIntent = { url: "https://jobs.example/api/applications", method: "POST" }
    const run = vi.fn(async (beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean>) => {
      expect(await beforeSubmit(intent)).toBe(true)
      return { status: "submitted" as const, durationMs: 1 }
    })
    const provider = createBrowserApplicationSubmitProvider({ run, confirmationId: "application:task-1", postSubmitUrl: () => "https://jobs.example/confirmation" })
    await expect(provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit: guard })).resolves.toEqual({ confirmationId: "application:task-1", postSubmitUrl: "https://jobs.example/confirmation" })
    expect(run).toHaveBeenCalledOnce()
    expect(guard).toHaveBeenCalledOnce()
    expect(guard).toHaveBeenCalledWith(intent)
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

  it("forwards the exact reviewed material only through the explicit reviewed runner", async () => {
    const beforeSubmit = vi.fn().mockResolvedValue(true)
    const reviewedCoverLetter = "reviewed source text"
    const run = vi.fn()
    const runReviewed = vi.fn().mockResolvedValue({ status: "submitted" as const, durationMs: 1 })
    const provider = createBrowserApplicationSubmitProvider({
      run, runReviewed, confirmationId: "application:task-1", postSubmitUrl: () => "https://jobs.example/confirmation",
    })

    expect(provider.acceptsReviewedApplicationMaterial).toBe(true)
    await expect(provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit, reviewedCoverLetter }))
      .resolves.toEqual({ confirmationId: "application:task-1", postSubmitUrl: "https://jobs.example/confirmation" })
    expect(runReviewed).toHaveBeenCalledWith({ beforeSubmit, reviewedCoverLetter })
    expect(run).not.toHaveBeenCalled()
  })

  it("does not route reviewed material to the ordinary runner when reviewed execution is unsupported", async () => {
    const run = vi.fn().mockResolvedValue({ status: "submitted" as const, durationMs: 1 })
    const provider = createBrowserApplicationSubmitProvider({
      run, confirmationId: "application:task-1", postSubmitUrl: () => "",
    })

    expect(provider.acceptsReviewedApplicationMaterial).toBeUndefined()
    await expect(provider({ target: {} as never, artifact: {} as never, context: {} as never, beforeSubmit: vi.fn(), reviewedCoverLetter: "reviewed" }))
      .rejects.toMatchObject({ code: "browser_manual" })
    expect(run).not.toHaveBeenCalled()
  })
})
