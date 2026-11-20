import { describe, expect, it } from "vitest"

import { hashAgentReceiptValue } from "./agent-receipt.js"
import {
  bindReviewedApplicationSubmissionMaterial,
  buildApplicationSubmissionManifest,
  hashApplicationSubmissionMaterial,
  hashReviewedApplicationMaterialProof,
  isApplicationSubmissionManifest,
  isApplicationSubmissionMaterial,
  isLegacyApplicationSubmissionMaterial,
  isReviewedApplicationMaterialProof,
  isReviewedApplicationSubmissionMaterial,
  matchesReviewedApplicationMaterialProof,
  LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA,
  REVIEWED_APPLICATION_SUBMISSION_MANIFEST_SCHEMA,
  type LegacyApplicationSubmissionMaterial,
  type ReviewedApplicationMaterialProof,
} from "./application-submission-material.js"

const legacy: LegacyApplicationSubmissionMaterial = {
  applicationTaskId: "application-task-1",
  jobId: "job-1",
  resumeId: "resume-1",
  coverLetterId: null,
}

const proof: ReviewedApplicationMaterialProof = {
  jobId: "job-1",
  sourceTurnId: "turn-1",
  rootTaskId: "root-1",
  graphRevision: 4,
  writerTaskId: "writer-1",
  reviewerTaskId: "reviewer-1",
  reviewerToolCallId: "review-call-1",
  reviewHash: `sha256:${"c".repeat(64)}`,
  artifactId: "cover-letter:job-1",
  version: 3,
  contentHash: `sha256:${"a".repeat(64)}`,
  sourceDigest: `sha256:${"b".repeat(64)}`,
}

describe("shared application submission material", () => {
  it("preserves the exact legacy material shape and canonical receipt hash", async () => {
    expect(isLegacyApplicationSubmissionMaterial(legacy)).toBe(true)
    expect(isApplicationSubmissionMaterial(legacy)).toBe(true)
    const hash = await hashApplicationSubmissionMaterial(legacy)
    expect(hash).toBe(await hashAgentReceiptValue("material", legacy))
    expect(hash).toBe("1d9501542866db38190b4793d164b6eee48bf38940cd7bcb0b986954da9beab3")
    expect(buildApplicationSubmissionManifest(legacy, "d".repeat(64))).toEqual({
      schemaVersion: LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA,
      ...legacy,
      answersHash: "d".repeat(64),
    })
  })

  it("rejects legacy material with missing, extra, malformed, or alternate fields", async () => {
    for (const value of [
      { ...legacy, unexpected: true },
      { applicationTaskId: legacy.applicationTaskId, jobId: legacy.jobId, resumeId: legacy.resumeId },
      { ...legacy, applicationTaskId: " " },
      { ...legacy, resumeId: undefined },
      Object.assign(Object.create(null), legacy),
    ]) {
      expect(isApplicationSubmissionMaterial(value)).toBe(false)
      expect(await hashApplicationSubmissionMaterial(value)).toBeNull()
      expect(buildApplicationSubmissionManifest(value, "d".repeat(64))).toBeNull()
    }
  })

  it("binds a reviewed commitment to the source proof and not the fill attempt", async () => {
    expect(isReviewedApplicationMaterialProof(proof)).toBe(true)
    const first = await bindReviewedApplicationSubmissionMaterial(legacy, proof)
    const anotherAttempt = await bindReviewedApplicationSubmissionMaterial({ ...legacy, applicationTaskId: "application-task-2" }, proof)
    expect(first).not.toBeNull()
    expect(first?.reviewedCoverLetterHash).toBe(anotherAttempt?.reviewedCoverLetterHash)
    expect(await matchesReviewedApplicationMaterialProof(first, proof)).toBe(true)
    expect(isReviewedApplicationSubmissionMaterial(first)).toBe(true)
    expect(await hashApplicationSubmissionMaterial(first)).not.toBe(await hashApplicationSubmissionMaterial(anotherAttempt))
    const mutable = { ...legacy }
    const pending = bindReviewedApplicationSubmissionMaterial(mutable, proof)
    mutable.jobId = "changed-after-call"
    await expect(pending).resolves.toMatchObject({ jobId: "job-1" })
  })

  it.each([
    ["jobId", { jobId: "job-2" }],
    ["sourceTurnId", { sourceTurnId: "turn-2" }],
    ["rootTaskId", { rootTaskId: "root-2" }],
    ["graphRevision", { graphRevision: 5 }],
    ["writerTaskId", { writerTaskId: "writer-2" }],
    ["reviewerTaskId", { reviewerTaskId: "reviewer-2" }],
    ["reviewerToolCallId", { reviewerToolCallId: "review-call-2" }],
    ["reviewHash", { reviewHash: `sha256:${"d".repeat(64)}` }],
    ["artifactId", { artifactId: "cover-letter:other" }],
    ["version", { version: 4 }],
    ["contentHash", { contentHash: `sha256:${"e".repeat(64)}` }],
    ["sourceDigest", { sourceDigest: `sha256:${"f".repeat(64)}` }],
  ] as const)("changes commitment when %s changes", async (_field, change) => {
    const changed = { ...proof, ...change }
    expect(await hashReviewedApplicationMaterialProof(changed)).not.toBe(await hashReviewedApplicationMaterialProof(proof))
    expect(await matchesReviewedApplicationMaterialProof(await bindReviewedApplicationSubmissionMaterial(legacy, proof), changed)).toBe(false)
  })

  it("fails closed for malformed proof, wrong Job, or altered commitment", async () => {
    expect(isReviewedApplicationMaterialProof({ ...proof, extra: "x" })).toBe(false)
    expect(isReviewedApplicationMaterialProof({ ...proof, reviewHash: proof.reviewHash.toUpperCase() })).toBe(false)
    expect(isReviewedApplicationMaterialProof({ ...proof, version: 0 })).toBe(false)
    expect(await hashReviewedApplicationMaterialProof({ ...proof, extra: "x" })).toBeNull()
    expect(await bindReviewedApplicationSubmissionMaterial(legacy, { ...proof, jobId: "job-2" })).toBeNull()
    const reviewed = await bindReviewedApplicationSubmissionMaterial(legacy, proof)
    expect(await matchesReviewedApplicationMaterialProof({ ...reviewed!, reviewedCoverLetterHash: "0".repeat(64) }, proof)).toBe(false)
  })

  it("builds and validates a versioned reviewed manifest without proof fields or content", async () => {
    const material = await bindReviewedApplicationSubmissionMaterial(legacy, proof)
    const manifest = buildApplicationSubmissionManifest(material, "d".repeat(64))
    expect(manifest).toEqual({
      schemaVersion: REVIEWED_APPLICATION_SUBMISSION_MANIFEST_SCHEMA,
      ...material,
      answersHash: "d".repeat(64),
    })
    expect(isApplicationSubmissionManifest(manifest)).toBe(true)
    expect(JSON.stringify(manifest)).not.toContain("reviewerTaskId")
    expect(JSON.stringify(manifest)).not.toContain("contentHash")
    expect(isApplicationSubmissionManifest({ ...manifest!, proof })).toBe(false)
    expect(buildApplicationSubmissionManifest(material, "D".repeat(64))).toBeNull()
  })

  it("rejects a manifest accessor without invoking it", () => {
    let accessed = false
    const manifest = buildApplicationSubmissionManifest(legacy, "d".repeat(64)) as Record<string, unknown>
    Object.defineProperty(manifest, "schemaVersion", {
      enumerable: true,
      get() { accessed = true; return LEGACY_APPLICATION_SUBMISSION_MANIFEST_SCHEMA },
    })
    expect(isApplicationSubmissionManifest(manifest)).toBe(false)
    expect(accessed).toBe(false)
  })
})
