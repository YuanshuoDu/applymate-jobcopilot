import type { ApplicationSubmitProvider } from "./application-submit-tool.js"
import type { HarnessResult } from "../../harness/agent-harness.js"
import type { SubmissionRequestIntent } from "../../flows/submission-intent.js"

export type BrowserSubmitRunner = (beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean>) => Promise<HarnessResult>
export type ReviewedBrowserSubmitRunner = (input: Readonly<{
  beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean>
  reviewedCoverLetter: string
}>) => Promise<HarnessResult>

export class BrowserApplicationSubmitError extends Error {
  readonly provider = "browser"
  readonly statusCode: number
  readonly code: "browser_412" | "browser_manual" | "browser_failed"

  constructor(result: HarnessResult) {
    super(result.error ?? "The browser did not confirm an application submission.")
    this.name = "BrowserApplicationSubmitError"
    this.statusCode = result.status === "submission_blocked" ? 412 : 409
    this.code = result.status === "submission_blocked"
      ? "browser_412"
      : result.status === "manual"
        ? "browser_manual"
        : "browser_failed"
  }
}

/** Adapts the existing ATS/browser execution to the typed external-write port. */
export function createBrowserApplicationSubmitProvider(input: {
  readonly run: BrowserSubmitRunner
  readonly runReviewed?: ReviewedBrowserSubmitRunner
  readonly confirmationId: string
  readonly postSubmitUrl: () => string
}): ApplicationSubmitProvider {
  const provider: ApplicationSubmitProvider = async ({ beforeSubmit, reviewedCoverLetter }) => {
    const result = reviewedCoverLetter !== undefined
      ? input.runReviewed
        ? await input.runReviewed({ beforeSubmit, reviewedCoverLetter })
        : { status: "manual" as const, error: "Reviewed application material is unsupported by this browser path.", durationMs: 0, log: [] }
      : await input.run(beforeSubmit)
    if (result.status !== "submitted") throw new BrowserApplicationSubmitError(result)
    return { confirmationId: input.confirmationId, postSubmitUrl: input.postSubmitUrl() }
  }
  if (input.runReviewed) Object.assign(provider, { acceptsReviewedApplicationMaterial: true as const })
  return provider
}
