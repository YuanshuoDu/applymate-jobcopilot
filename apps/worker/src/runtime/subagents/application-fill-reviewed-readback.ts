import type { Page } from "playwright-core"
import type { ObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { HarnessResult } from "../../harness/agent-harness.js"
import { createObjectiveReviewedApplicationFillReadback, createReviewedApplicationFillReadback,
  type ObjectiveReviewedApplicationFillReadback, type ReviewedApplicationFillReadback } from "../../db/reviewed-application-fill-completion.js"
import type { SelectedJobReviewedArtifact } from "../selected-job-reviewed-artifact-read.js"
import type { SubagentLease } from "./types.js"

/** Confirms the exact reviewed cover-letter field before minting its private readback. */
export async function reviewedMaterialWasFilled(
  page: Page,
  result: HarnessResult,
  proof: SelectedJobReviewedArtifact,
  lease: SubagentLease,
  applicationTaskId: string,
): Promise<ReviewedApplicationFillReadback | null | false> {
  const matched = await reviewedFieldWasFilled(page, result, proof)
  return matched === true ? createReviewedApplicationFillReadback(lease, applicationTaskId, proof) : matched
}

/** Binds the exact Objective approval selector to the same observed cover-letter field. */
export async function objectiveReviewedMaterialWasFilled(
  page: Page, result: HarnessResult, proof: SelectedJobReviewedArtifact, source: ObjectiveReviewedFillSource,
  lease: SubagentLease, applicationTaskId: string,
): Promise<ObjectiveReviewedApplicationFillReadback | null | false> {
  const matched = await reviewedFieldWasFilled(page, result, proof)
  return matched === true ? createObjectiveReviewedApplicationFillReadback(lease, applicationTaskId, source, proof) : matched
}

async function reviewedFieldWasFilled(page: Page, result: HarnessResult, proof: SelectedJobReviewedArtifact): Promise<boolean | null | false> {
  const selectors: string[] = []
  for (const entry of result.log ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const value = entry as Record<string, unknown>
    if (value.field !== "coverLetter" || !["fill", "replay-fill"].includes(String(value.action))
      || (value.phase !== undefined && value.phase !== "completed")) continue
    if (typeof value.selector !== "string" || !value.selector.trim() || value.selector.length > 2048) return false
    selectors.push(value.selector)
  }
  const unique = [...new Set(selectors)]
  if (unique.length !== 1) return false
  try {
    const field = page.locator(unique[0]!)
    if (await field.count() !== 1) return false
    const current = await field.evaluate(element => {
      const tag = element.tagName.toLowerCase()
      return tag === "input" || tag === "textarea" ? (element as HTMLInputElement | HTMLTextAreaElement).value : null
    }, undefined, { timeout: 1000 })
    return current === proof.content ? true : null
  } catch { return false }
}
