import type { ApplicationTarget } from "../../db/application-submit-repo.js"
import type { ObjectiveReviewedApplicationSubmitPacket } from "../../db/objective-reviewed-application-submit-material.js"
import type { ApplicationSubmitProvider } from "./application-submit-tool.js"
import type { ToolExecutionContext } from "./types.js"
import type { HarnessResult } from "../../harness/agent-harness.js"
import type { SubmissionRequestIntent } from "../../flows/submission-intent.js"

export type BrowserSubmitRunner = (beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean>) => Promise<HarnessResult>
export type ObjectiveBrowserSubmitRunner = (input: Readonly<{
  target: ApplicationTarget; material: ObjectiveReviewedApplicationSubmitPacket; context: ToolExecutionContext
  beforeSubmit: (intent?: SubmissionRequestIntent) => Promise<boolean>
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
  readonly runObjective?: ObjectiveBrowserSubmitRunner
  readonly supportsObjectiveTarget?: (url: unknown) => boolean
  readonly confirmationId: string
  readonly postSubmitUrl: () => string
}): ApplicationSubmitProvider {
  const provider: ApplicationSubmitProvider = async ({ target, context, beforeSubmit, objectiveMaterial }) => {
    if (objectiveMaterial) {
      if (!input.runObjective || !input.supportsObjectiveTarget?.(objectiveMaterial.approvedApplyUrl)) {
        throw new BrowserApplicationSubmitError({ status: "manual", error: "Objective submission route is unavailable.", durationMs: 0 })
      }
      const result = await input.runObjective({ target: { ...target, applyUrl: objectiveMaterial.approvedApplyUrl },
        material: objectiveMaterial, context, beforeSubmit })
      if (result.status !== "submitted") throw new BrowserApplicationSubmitError(result)
      return { confirmationId: input.confirmationId, postSubmitUrl: input.postSubmitUrl() }
    }
    const result = await input.run(beforeSubmit)
    if (result.status !== "submitted") throw new BrowserApplicationSubmitError(result)
    return { confirmationId: input.confirmationId, postSubmitUrl: input.postSubmitUrl() }
  }
  return input.runObjective && input.supportsObjectiveTarget
    ? Object.assign(provider, { acceptsObjectiveReviewedApplicationMaterial: true as const,
      supportsObjectiveApplicationSubmitTarget: input.supportsObjectiveTarget })
    : provider
}
