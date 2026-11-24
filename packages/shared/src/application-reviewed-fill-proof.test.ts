import { describe, expect, it, vi } from "vitest"
import {
  OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, parseObjectiveReviewedApplicationFillBrowserStartEvent,
  parseReviewedApplicationFillBrowserStartEvent, parseReviewedApplicationFillSource,
  REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA, REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA,
} from "./application-reviewed-fill-proof.js"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA } from "./agent-objective-reviewed-fill.js"

const proof = {
  jobId: "job-a", sourceTurnId: "source-turn", rootTaskId: "root-a", graphRevision: 2,
  writerTaskId: "writer-a", reviewerTaskId: "reviewer-a", reviewerToolCallId: "review-call",
  reviewHash: `sha256:${"a".repeat(64)}`, artifactId: "artifact-a", version: 3,
  contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
}

const browserStart = () => ({
  schemaVersion: REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA, userId: "user-a", sessionId: "session-a",
  fillTurnId: "fill-turn", jobId: "job-a", applicationTaskId: "application-a", fillerTaskId: "filler-a",
  attemptCount: 2, leaseOwner: "worker-a", leaseExpiresAt: "2026-11-19T12:00:00.000Z", ...proof,
})
const objectiveBrowserStart = () => ({
  schemaVersion: OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, userId: "user-a", sessionId: "session-a",
  fillTurnId: "fill-turn", jobId: "job-a", applicationTaskId: "application-a", fillerTaskId: "filler-a",
  attemptCount: 2, leaseOwner: "worker-a", leaseExpiresAt: "2026-11-19T12:00:00.000Z", ...proof,
  objectiveSource: { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
    approvalId: `objective-review:objective-review-${"d".repeat(40)}:1`, reviewTurnId: "review-turn", materialProofHash: "e".repeat(64) },
})

describe("reviewed fill proof parser", () => {
  it("distinguishes legacy absence from an exact source selector", () => {
    expect(parseReviewedApplicationFillSource({ goal: "apply" })).toEqual({ kind: "absent" })
    expect(parseReviewedApplicationFillSource(null)).toEqual({ kind: "absent" })
    expect(parseReviewedApplicationFillSource({ reviewedApplicationMaterialSource: {
      schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId: "source-turn",
    } })).toEqual({ kind: "selected", sourceTurnId: "source-turn" })
  })

  it("fails closed on malformed selectors and accessor properties", () => {
    expect(parseReviewedApplicationFillSource(7)).toEqual({ kind: "invalid" })
    expect(parseReviewedApplicationFillSource({ reviewedApplicationMaterialSource: { schemaVersion: "wrong", sourceTurnId: "source" } })).toEqual({ kind: "invalid" })
    expect(parseReviewedApplicationFillSource({ reviewedApplicationMaterialSource: {
      schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId: "source", extra: true,
    } })).toEqual({ kind: "invalid" })
    const input = {}; const getter = vi.fn(() => ({ schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId: "source" }))
    Object.defineProperty(input, "reviewedApplicationMaterialSource", { enumerable: true, get: getter })
    expect(parseReviewedApplicationFillSource(input)).toEqual({ kind: "invalid" })
    expect(getter).not.toHaveBeenCalled()
  })

  it("returns the exact flat identity and 12-field source proof", () => {
    const { jobId, sourceTurnId, rootTaskId, graphRevision, writerTaskId, reviewerTaskId, reviewerToolCallId,
      reviewHash, artifactId, version, contentHash, sourceDigest, ...identity } = browserStart()
    expect(parseReviewedApplicationFillBrowserStartEvent(browserStart())).toEqual({
      ...identity, jobId, proof: { jobId, sourceTurnId, rootTaskId, graphRevision, writerTaskId, reviewerTaskId,
        reviewerToolCallId, reviewHash, artifactId, version, contentHash, sourceDigest },
    })
  })

  it("parses the exact Objective V3 browser-start binding and source selector", () => {
    const value = objectiveBrowserStart()
    const parsed = parseObjectiveReviewedApplicationFillBrowserStartEvent(value)
    expect(parsed).toEqual({
      schemaVersion: OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, userId: "user-a", sessionId: "session-a",
      fillTurnId: "fill-turn", jobId: "job-a", applicationTaskId: "application-a", fillerTaskId: "filler-a",
      attemptCount: 2, leaseOwner: "worker-a", leaseExpiresAt: "2026-11-19T12:00:00.000Z", objectiveSource: value.objectiveSource,
      proof,
    })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.objectiveSource)).toBe(true)
    expect(Object.isFrozen(parsed?.proof)).toBe(true)
  })

  it.each([
    ["extra field", { ...objectiveBrowserStart(), extra: true }],
    ["wrong schema", { ...objectiveBrowserStart(), schemaVersion: REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA }],
    ["malformed Objective source", { ...objectiveBrowserStart(), objectiveSource: { ...objectiveBrowserStart().objectiveSource, extra: true } }],
    ["crossed review and source Turns", { ...objectiveBrowserStart(), objectiveSource: {
      ...objectiveBrowserStart().objectiveSource, reviewTurnId: "source-turn",
    } }],
  ])("rejects Objective V3 browser binding with %s", (_name, value) => {
    expect(parseObjectiveReviewedApplicationFillBrowserStartEvent(value)).toBeNull()
  })

  it("rejects Objective browser-start accessors without invoking them", () => {
    const value = objectiveBrowserStart()
    const getter = vi.fn(() => "foreign-user")
    Object.defineProperty(value, "userId", { enumerable: true, get: getter })
    expect(parseObjectiveReviewedApplicationFillBrowserStartEvent(value)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })

  it.each([
    ["extra field", { ...browserStart(), extra: true }],
    ["wrong schema", { ...browserStart(), schemaVersion: "wrong" }],
    ["zero attempt", { ...browserStart(), attemptCount: 0 }],
    ["fractional attempt", { ...browserStart(), attemptCount: 1.5 }],
    ["noncanonical expiry", { ...browserStart(), leaseExpiresAt: "2026-11-19T12:00:00Z" }],
    ["missing proof field", (() => { const value = browserStart(); delete (value as Partial<typeof value>).writerTaskId; return value })()],
    ["invalid proof digest", { ...browserStart(), reviewHash: "a".repeat(64) }],
  ])("rejects %s", (_name, value) => {
    expect(parseReviewedApplicationFillBrowserStartEvent(value)).toBeNull()
  })
})
