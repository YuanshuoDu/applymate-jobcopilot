import type { ApplicationSubmitProvider } from "./application-submit-tool.js"
import type { HarnessResult } from "../../harness/agent-harness.js"

export type BrowserSubmitRunner = (beforeSubmit: () => Promise<boolean>) => Promise<HarnessResult>

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
  readonly confirmationId: string
  readonly postSubmitUrl: () => string
}): ApplicationSubmitProvider {
  return async ({ beforeSubmit }) => {
    const result = await input.run(beforeSubmit)
    if (result.status !== "submitted") throw new BrowserApplicationSubmitError(result)
    return { confirmationId: input.confirmationId, postSubmitUrl: input.postSubmitUrl() }
  }
}
