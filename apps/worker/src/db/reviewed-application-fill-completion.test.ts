import { beforeEach, describe, expect, it, vi } from "vitest"
import { buildObjectiveApplicationResumeWitness, type ObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { PoolClient } from "pg"
import type { SubagentLease } from "../runtime/subagents/types.js"
import {
  createObjectiveReviewedApplicationFillReadback, createReviewedApplicationFillReadback,
  readObjectiveReviewedApplicationFillCompletionMaterial, readReviewedApplicationFillCompletionMaterial,
} from "./reviewed-application-fill-completion.js"

const source = vi.hoisted(() => ({ read: vi.fn(), objectiveRead: vi.fn() }))
vi.mock("../runtime/selected-job-reviewed-artifact-read.js", () => ({ readSelectedJobReviewedArtifactWithClient: source.read }))
vi.mock("../runtime/objective-reviewed-application-fill-read.js", () => ({ readObjectiveReviewedApplicationFillSource: source.objectiveRead }))

const proof = {
  sourceTurnId: "source-turn", rootTaskId: "source-root", graphRevision: 4, jobId: "job-a", writerTaskId: "writer-task",
  reviewerTaskId: "reviewer-task", reviewerToolCallId: "review-call", reviewHash: `sha256:${"1".repeat(64)}`,
  artifactId: "draft-a", version: 2, contentHash: `sha256:${"2".repeat(64)}`, sourceDigest: `sha256:${"3".repeat(64)}`, content: "Private reviewed letter",
}
const lease = {
  id: "filler-task", userId: "user-a", sessionId: "session-a", turnId: "fill-turn", rootTaskId: "fill-root", parentTaskId: "fill-root",
  role: "application_filler", taskType: "application_fill_for_review", status: "running", attemptCount: 2, maxAttempts: 3,
  leaseOwner: "worker-a", ownerId: "worker-a", leaseExpiresAt: new Date("2026-11-20T12:00:00.000Z"), interruptRequestedAt: null,
  signal: new AbortController().signal, goal: "Fill", path: "/fill", depth: 1, constraints: [], successCriteria: [], allowedActions: [],
  context: {}, expectedOutputSchema: {}, result: null, failureReason: null, budgetSnapshot: {}, toolPolicySnapshot: {},
} satisfies SubagentLease
const legacyMaterial = { applicationTaskId: "application-a", jobId: "job-a", resumeId: "resume-a", coverLetterId: null }
const resumeWitness = buildObjectiveApplicationResumeWitness({ userId: "user-a", jobId: "job-a", resumeId: "resume-a",
  finalResumeAssignmentRevision: 3, materialRevision: 2, material: { name: "Tailored", content: { basics: {} }, templateId: "modern",
    templateOptions: {}, kind: "adapted", targetJobId: "job-a", parentResumeId: "resume-base", basicsDetached: false } })!
const objectiveSource = {
  schemaVersion: "agent-harness.v2.objective-reviewed-fill-source.v1",
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:1`,
  reviewTurnId: "review-turn", materialProofHash: "4".repeat(64),
} as const

function event(attemptCount = lease.attemptCount, leaseOwner = lease.ownerId, expires = lease.leaseExpiresAt.toISOString()) {
  return { actor: "worker", data: { schemaVersion: "agent-harness.v2.reviewed-application-fill-browser-start.v1", userId: lease.userId,
    sessionId: lease.sessionId, fillTurnId: lease.turnId, jobId: "job-a", applicationTaskId: "application-a", fillerTaskId: lease.id,
    attemptCount, leaseOwner, leaseExpiresAt: expires, sourceTurnId: proof.sourceTurnId, rootTaskId: proof.rootTaskId,
    graphRevision: proof.graphRevision, writerTaskId: proof.writerTaskId, reviewerTaskId: proof.reviewerTaskId,
    reviewerToolCallId: proof.reviewerToolCallId, reviewHash: proof.reviewHash, artifactId: proof.artifactId,
    version: proof.version, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest } }
}

function objectiveEvent(selector: ObjectiveReviewedFillSource = objectiveSource, attemptCount = lease.attemptCount, leaseOwner = lease.ownerId,
  expires = lease.leaseExpiresAt.toISOString()) {
  return { actor: "worker", data: { schemaVersion: "agent-harness.v2.objective-reviewed-fill-browser-start.v1", userId: lease.userId,
    sessionId: lease.sessionId, fillTurnId: lease.turnId, jobId: "job-a", applicationTaskId: "application-a", fillerTaskId: lease.id,
    attemptCount, leaseOwner, leaseExpiresAt: expires, sourceTurnId: proof.sourceTurnId, rootTaskId: proof.rootTaskId,
    graphRevision: proof.graphRevision, writerTaskId: proof.writerTaskId, reviewerTaskId: proof.reviewerTaskId,
    reviewerToolCallId: proof.reviewerToolCallId, reviewHash: proof.reviewHash, artifactId: proof.artifactId,
    version: proof.version, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest, objectiveSource: selector } }
}

function client(rows = [event()]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
  return { query } as unknown as Pick<PoolClient, "query"> & { query: typeof query }
}

function objectiveClient(rows = [objectiveEvent()]) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }))
  return { query } as unknown as Pick<PoolClient, "query"> & { query: typeof query }
}

beforeEach(() => {
  source.read.mockResolvedValue(proof)
  source.objectiveRead.mockResolvedValue({ source: objectiveSource, reviewedArtifact: proof, resumeWitness, resumeContent: { basics: {} } })
})

describe("reviewed application fill completion proof", () => {
  it("binds the exact browser readback to the current attempt and fresh source proof", async () => {
    const readback = await createReviewedApplicationFillReadback(lease, "application-a", proof)
    expect(readback).toMatchObject({ schemaVersion: "agent-harness.v2.reviewed-application-fill-readback.v1", attemptCount: 2, sourceTurnId: "source-turn" })
    expect(JSON.stringify(readback)).not.toContain(proof.content)
    const db = client()
    const material = await readReviewedApplicationFillCompletionMaterial(db, {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial,
      readback, requireCurrentAttempt: true,
    })
    expect(material).toMatchObject({ ...legacyMaterial, reviewedCoverLetterHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("reviewed_application_fill_browser_started"), ["application-a", "fill-turn"])
  })

  it("rejects missing, mutated, duplicate, or foreign attempt bindings", async () => {
    const readback = await createReviewedApplicationFillReadback(lease, "application-a", proof)
    const db = client()
    await expect(readReviewedApplicationFillCompletionMaterial(db, {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial, requireCurrentAttempt: true,
    })).resolves.toBeNull()
    await expect(readReviewedApplicationFillCompletionMaterial(client([event(1, "old-worker", "2026-11-19T12:00:00.000Z")]), {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial, readback, requireCurrentAttempt: true,
    })).resolves.toBeNull()
    await expect(readReviewedApplicationFillCompletionMaterial(client([event(), event()]), {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial, readback, requireCurrentAttempt: true,
    })).resolves.toBeNull()
    const changed = { ...readback!, reviewedCoverLetterHash: "f".repeat(64) }
    await expect(readReviewedApplicationFillCompletionMaterial(client(), {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial, readback: changed, requireCurrentAttempt: true,
    })).resolves.toBeNull()
  })

  it("allows a validated already-issued browser binding from an earlier lease attempt", async () => {
    const earlier = event(1, "worker-before-recovery", "2026-11-19T12:00:00.000Z")
    await expect(readReviewedApplicationFillCompletionMaterial(client([earlier]), {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial, requireCurrentAttempt: false,
    })).resolves.toMatchObject({ jobId: "job-a", reviewedCoverLetterHash: expect.any(String) })
  })

  it("rejects an unchanged browser receipt when the source proof is no longer current", async () => {
    const changedProof = { ...proof, sourceDigest: `sha256:${"4".repeat(64)}` }
    source.read.mockResolvedValueOnce(changedProof)
    await expect(readReviewedApplicationFillCompletionMaterial(client(), {
      lease, applicationTaskId: "application-a", jobId: "job-a", sourceTurnId: "source-turn", legacyMaterial, requireCurrentAttempt: false,
    })).resolves.toBeNull()
  })

  it("requires exact Objective selector and current-attempt browser readback", async () => {
    const readback = await createObjectiveReviewedApplicationFillReadback(lease, "application-a", objectiveSource, proof)
    expect(readback).toMatchObject({ schemaVersion: "agent-harness.v2.objective-reviewed-fill-readback.v1", objectiveSource })
    expect(JSON.stringify(readback)).not.toContain(proof.content)
    const material = await readObjectiveReviewedApplicationFillCompletionMaterial(objectiveClient(), {
      lease, applicationTaskId: "application-a", jobId: "job-a", source: objectiveSource,
      turnInput: { reviewedApplicationMaterialSource: objectiveSource }, legacyMaterial, readback, requireCurrentAttempt: true,
    })
    expect(material).toMatchObject({ ...legacyMaterial, reviewedCoverLetterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      objectiveSubmissionMaterial: { applicationTaskId: "application-a", jobId: "job-a", resumeId: "resume-a", objectiveSource } })
    expect(source.objectiveRead).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ phase: "completion" }))
    await expect(readObjectiveReviewedApplicationFillCompletionMaterial(objectiveClient([objectiveEvent({ ...objectiveSource, approvalId: "other" })]), {
      lease, applicationTaskId: "application-a", jobId: "job-a", source: objectiveSource,
      turnInput: { reviewedApplicationMaterialSource: objectiveSource }, legacyMaterial, readback, requireCurrentAttempt: true,
    })).resolves.toBeNull()
    await expect(readObjectiveReviewedApplicationFillCompletionMaterial(objectiveClient(), {
      lease, applicationTaskId: "application-a", jobId: "job-a", source: objectiveSource,
      turnInput: { reviewedApplicationMaterialSource: objectiveSource }, legacyMaterial, requireCurrentAttempt: true,
    })).resolves.toBeNull()
  })

  it("replays an exact prior Objective browser binding without a new attempt readback", async () => {
    await expect(readObjectiveReviewedApplicationFillCompletionMaterial(objectiveClient([
      objectiveEvent(objectiveSource, 1, "worker-before-recovery", "2026-11-19T12:00:00.000Z"),
    ]), {
      lease, applicationTaskId: "application-a", jobId: "job-a", source: objectiveSource,
      turnInput: { reviewedApplicationMaterialSource: objectiveSource }, legacyMaterial, requireCurrentAttempt: false,
    })).resolves.toMatchObject({ jobId: "job-a", reviewedCoverLetterHash: expect.any(String) })
    expect(source.objectiveRead).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ phase: "completion_replay" }))
  })
})
