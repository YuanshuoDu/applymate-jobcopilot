import type { Page } from "playwright-core"
import { describe, expect, it, vi } from "vitest"
import type { HarnessResult } from "../../harness/agent-harness.js"
import type { SelectedJobReviewedArtifact } from "../selected-job-reviewed-artifact-read.js"
import type { SubagentLease } from "./types.js"
import { reviewedMaterialWasFilled } from "./application-fill-reviewed-readback.js"

const proof: SelectedJobReviewedArtifact = {
  sourceTurnId: "source-turn-1", rootTaskId: "root-1", graphRevision: 2, jobId: "job-1",
  writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1",
  reviewHash: "sha256:" + "a".repeat(64), artifactId: "artifact-1", version: 3,
  contentHash: "sha256:" + "b".repeat(64), sourceDigest: "sha256:" + "c".repeat(64),
  content: "Exact reviewed letter\nSecond line.",
}
const lease = {
  id: "filler-1", userId: "user-1", sessionId: "session-1", turnId: "fill-turn-1",
  attemptCount: 2, leaseOwner: "worker-1", ownerId: "worker-1", leaseExpiresAt: new Date("2026-11-21T16:00:00.000Z"),
} as unknown as SubagentLease

function surface(options: { count?: number; tag?: string; value?: string; fail?: boolean } = {}) {
  const element = { tagName: options.tag ?? "TEXTAREA", value: options.value ?? proof.content } as unknown as Element
  const locator = {
    count: vi.fn(async () => options.count ?? 1),
    evaluate: vi.fn(async (read: (node: Element) => unknown) => {
      if (options.fail) throw new Error("private DOM detail")
      return read(element)
    }),
  }
  const page = { locator: (selector: string) => {
    expect(selector).toBe("textarea#cover-letter")
    return locator
  } } as unknown as Page
  return { page, locator }
}

function result(log: unknown[]): HarnessResult {
  return { status: "manual", error: null, durationMs: 1, reviewReady: true, log } as HarnessResult
}

describe("reviewed material browser readback", () => {
  it("mints a readback only after reading the exact unique cover-letter value", async () => {
    const { page, locator } = surface()
    const readback = await reviewedMaterialWasFilled(page, result([
      { field: "coverLetter", selector: "textarea#cover-letter", action: "fill", phase: "completed" },
    ]), proof, lease, "application-1")

    expect(readback).toMatchObject({
      schemaVersion: "agent-harness.v2.reviewed-application-fill-readback.v1",
      userId: "user-1", sessionId: "session-1", fillTurnId: "fill-turn-1", applicationTaskId: "application-1",
      jobId: "job-1", fillerTaskId: "filler-1", attemptCount: 2, sourceTurnId: "source-turn-1",
    })
    expect(locator.evaluate).toHaveBeenCalled()
  })

  it.each([
    ["other field", [{ field: "resume", selector: "textarea#cover-letter", action: "fill" }]],
    ["incomplete fill", [{ field: "coverLetter", selector: "textarea#cover-letter", action: "fill", phase: "started" }]],
    ["multiple selectors", [
      { field: "coverLetter", selector: "textarea#cover-letter", action: "fill" },
      { field: "coverLetter", selector: "textarea#other", action: "replay-fill" },
    ]],
  ])("rejects %s evidence without reading the page", async (_name, log) => {
    const { page } = surface()
    await expect(reviewedMaterialWasFilled(page, result(log), proof, lease, "application-1")).resolves.toBe(false)
  })

  it("does not create a readback when the current field differs from the reviewed content", async () => {
    const { page } = surface({ value: "different letter" })
    await expect(reviewedMaterialWasFilled(page, result([
      { field: "coverLetter", selector: "textarea#cover-letter", action: "fill" },
    ]), proof, lease, "application-1")).resolves.toBeNull()
  })

  it("does not create a readback for an unsupported element", async () => {
    const { page } = surface({ tag: "div" })
    await expect(reviewedMaterialWasFilled(page, result([
      { field: "coverLetter", selector: "textarea#cover-letter", action: "fill" },
    ]), proof, lease, "application-1")).resolves.toBeNull()
  })

  it.each([
    ["ambiguous field", { count: 2 }],
    ["DOM read error", { fail: true }],
  ])("fails closed for %s", async (_name, options) => {
    const { page } = surface(options)
    await expect(reviewedMaterialWasFilled(page, result([
      { field: "coverLetter", selector: "textarea#cover-letter", action: "fill" },
    ]), proof, lease, "application-1")).resolves.toBe(false)
  })
})
