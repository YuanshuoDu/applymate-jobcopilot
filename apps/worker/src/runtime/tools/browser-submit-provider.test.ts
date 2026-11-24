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

  it("advertises separate Objective capability only with its supported dedicated runner", async () => {
    const run = vi.fn(), beforeSubmit = vi.fn().mockResolvedValue(true)
    const material = { reviewedResumeContent: { basics: { name: "Candidate" } }, reviewedCoverLetter: "Reviewed",
      confirmedAnswers: { city: "Dublin" }, approvedApplyUrl: "https://boards.greenhouse.io/acme/jobs/123" }
    const runObjective = vi.fn(async () => ({ status: "submitted" as const, durationMs: 1 }))
    const provider = createBrowserApplicationSubmitProvider({ run, runObjective,
      supportsObjectiveTarget: url => url === material.approvedApplyUrl,
      confirmationId: "objective-confirmation", postSubmitUrl: () => "https://boards.greenhouse.io/confirmation" })
    expect(provider.acceptsObjectiveReviewedApplicationMaterial).toBe(true)
    expect(provider.supportsObjectiveApplicationSubmitTarget?.(material.approvedApplyUrl)).toBe(true)
    await expect(provider({ target: { id: "job", userId: "user", jobId: "job", company: "Acme", role: "Engineer",
      applyUrl: "https://old.example/apply", source: "greenhouse" }, context: {} as never, beforeSubmit, objectiveMaterial: material }))
      .resolves.toEqual({ confirmationId: "objective-confirmation", postSubmitUrl: "https://boards.greenhouse.io/confirmation" })
    expect(runObjective).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({ applyUrl: material.approvedApplyUrl }), material, beforeSubmit,
    }))
    expect(run).not.toHaveBeenCalled()
  })

  it("does not let the generic browser runner consume Objective material for an unsupported target", async () => {
    const run = vi.fn(), runObjective = vi.fn()
    const material = { reviewedResumeContent: {}, reviewedCoverLetter: "Reviewed", confirmedAnswers: {}, approvedApplyUrl: "https://example.com/apply" }
    const provider = createBrowserApplicationSubmitProvider({ run, runObjective, supportsObjectiveTarget: () => false,
      confirmationId: "objective-confirmation", postSubmitUrl: () => "" })
    await expect(provider({ target: {} as never, context: {} as never, beforeSubmit: vi.fn(), objectiveMaterial: material }))
      .rejects.toMatchObject({ code: "browser_manual" })
    expect(runObjective).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(createBrowserApplicationSubmitProvider({ run, confirmationId: "legacy", postSubmitUrl: () => "" })
      .acceptsObjectiveReviewedApplicationMaterial).toBeUndefined()
  })
})
