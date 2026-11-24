import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  bindReviewedApplicationSubmissionMaterial, buildApplicationSubmissionManifest, hashAgentReceiptValue,
  hashApplicationSubmissionMaterial, REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA,
} from "@jobcopilot/shared"
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"
import { hasReviewedSubmissionArtifact, readReviewedApplicationSubmitMaterial } from "./reviewed-application-submit-material.js"

const sourceRead = vi.hoisted(() => vi.fn())
vi.mock("../runtime/selected-job-reviewed-artifact-read.js", () => ({ readSelectedJobReviewedArtifactWithClient: sourceRead }))

const identity: ApplicationSubmitIdentity = {
  sessionId: "session-a", fillTurnId: "fill-turn", applicationTaskId: "application-a", userId: "user-a",
  jobId: "job-a", approvalId: "receipt-a", constraintHash: "d".repeat(64),
}
const proof = {
  jobId: "job-a", sourceTurnId: "source-turn", rootTaskId: "root-a", graphRevision: 2,
  writerTaskId: "writer-a", reviewerTaskId: "reviewer-a", reviewerToolCallId: "review-call",
  reviewHash: "sha256:" + "a".repeat(64), artifactId: "artifact-a", version: 3,
  contentHash: "sha256:" + "b".repeat(64), sourceDigest: "sha256:" + "c".repeat(64),
}
const legacy = { applicationTaskId: "application-a", jobId: "job-a", resumeId: "resume-a", coverLetterId: null }
const content = "Reviewed and approved cover letter."
const expiry = "2026-11-20T12:00:00.000Z"

function browserStart(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA, userId: identity.userId, sessionId: identity.sessionId,
    fillTurnId: identity.fillTurnId, applicationTaskId: identity.applicationTaskId,
    fillerTaskId: "filler-a", attemptCount: 2, leaseOwner: "worker-a", leaseExpiresAt: expiry, ...proof, ...overrides,
  }
}

async function fixture(options: {
  eventActor?: string; eventData?: unknown; duplicateEvent?: boolean; attemptCount?: number; resourceHash?: string;
  materialHash?: string; answersHash?: string; sourceProof?: typeof proof | null; artifactManifest?: unknown;
} = {}) {
  const answersHash = await hashAgentReceiptValue("answers", { city: "Dublin" })
  const material = await bindReviewedApplicationSubmissionMaterial(legacy, proof)
  if (!material) throw new Error("fixture reviewed material was not valid")
  const manifest = buildApplicationSubmissionManifest(material, answersHash)
  if (!manifest) throw new Error("fixture manifest was not valid")
  const materialHash = await hashApplicationSubmissionMaterial(material)
  if (!materialHash) throw new Error("fixture material hash was not valid")
  const artifactContent = options.artifactManifest ?? manifest
  const artifactHash = hashArtifactContent(artifactContent)
  const artifactResource = artifactHash.slice("sha256:".length)
  const event = { actor: options.eventActor ?? "worker", data: options.eventData ?? browserStart(), createdAt: new Date("2026-11-20T11:59:00.000Z") }
  const rows = {
    task: [{ id: identity.applicationTaskId, userId: identity.userId, jobId: identity.jobId, sessionId: identity.sessionId,
      fillTurnId: identity.fillTurnId, fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId,
      resumeId: legacy.resumeId, coverLetterId: legacy.coverLetterId, confirmedAnswers: { city: "Dublin" } }],
    filler: [{ id: "filler-a", attemptCount: options.attemptCount ?? 2 }],
    events: options.duplicateEvent ? [event, event] : [event],
    artifact: [{ id: "application:application-a", userId: identity.userId, jobId: identity.jobId, artifactType: "application",
      lifecycle: "base", content: artifactContent, hash: artifactHash }],
  }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "application_tasks"')) return { rows: rows.task, rowCount: rows.task.length }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: rows.filler, rowCount: rows.filler.length }
    if (sql.includes('FROM "application_task_events"')) return { rows: rows.events, rowCount: rows.events.length }
    if (sql.includes('FROM "agent_artifact"')) return { rows: rows.artifact, rowCount: rows.artifact.length }
    return { rows: [], rowCount: 0 }
  })
  const current = options.sourceProof === null ? null : { ...proof, ...(options.sourceProof ?? {}), content }
  sourceRead.mockResolvedValue(current)
  return {
    client: { query } as never,
    approval: {
      resourceHash: options.resourceHash ?? artifactResource,
      materialHash: options.materialHash ?? materialHash,
      answersHash: options.answersHash ?? answersHash,
    },
    artifactResource, query, rows,
  }
}

describe("reviewed application submit material", () => {
  beforeEach(() => sourceRead.mockReset())

  it("returns current reviewed content only after matching the owned v2 manifest and browser receipt", async () => {
    const test = await fixture()
    await expect(readReviewedApplicationSubmitMaterial({
      client: test.client, identity, sourceTurnId: proof.sourceTurnId, approval: test.approval, currentSource: true,
    })).resolves.toEqual({ artifactHash: test.artifactResource, reviewedCoverLetter: content })
    expect(sourceRead).toHaveBeenCalledWith(test.client, {
      userId: identity.userId, sessionId: identity.sessionId, jobId: identity.jobId, sourceTurnId: proof.sourceTurnId,
    })
  })

  it("keeps exact already-reserved replay read-only without returning source text", async () => {
    const test = await fixture()
    await expect(readReviewedApplicationSubmitMaterial({
      client: test.client, identity, sourceTurnId: proof.sourceTurnId, approval: test.approval, currentSource: false,
    })).resolves.toEqual({ artifactHash: test.artifactResource })
    expect(sourceRead).not.toHaveBeenCalled()
  })

  it("detects a v2 or malformed reviewed marker on the exact task artifact for downgrade denial", async () => {
    const reviewed = await fixture()
    await expect(hasReviewedSubmissionArtifact(reviewed.client, identity)).resolves.toBe(true)
    const malformed = await fixture({ artifactManifest: { schemaVersion: "agent-harness.application-submission.v2", extra: true } })
    await expect(hasReviewedSubmissionArtifact(malformed.client, identity)).resolves.toBe(true)
  })

  it("leaves the exact v1 task artifact on the legacy path", async () => {
    const legacyManifest = { schemaVersion: "agent-harness.application-submission.v1", ...legacy, answersHash: "a".repeat(64) }
    const test = await fixture({ artifactManifest: legacyManifest })
    await expect(hasReviewedSubmissionArtifact(test.client, identity)).resolves.toBe(false)
  })

  it.each([
    ["foreign actor", { eventActor: "user" }],
    ["duplicate browser event", { duplicateEvent: true }],
    ["different filler attempt", { attemptCount: 3 }],
    ["changed approval resource hash", { resourceHash: "e".repeat(64) }],
    ["changed material hash", { materialHash: "e".repeat(64) }],
    ["changed answers hash", { answersHash: "e".repeat(64) }],
    ["missing current source", { sourceProof: null }],
    ["changed current source proof", { sourceProof: { ...proof, version: 4 } }],
    ["legacy manifest on marked Turn", { artifactManifest: { schemaVersion: "agent-harness.application-submission.v1", ...legacy, answersHash: "a".repeat(64) } }],
    ["malformed browser event", { eventData: { ...browserStart(), extra: true } }],
  ] as const)("fails closed for %s", async (_label, options) => {
    const test = await fixture(options)
    await expect(readReviewedApplicationSubmitMaterial({
      client: test.client, identity, sourceTurnId: proof.sourceTurnId, approval: test.approval, currentSource: true,
    })).resolves.toBeNull()
  })
})
