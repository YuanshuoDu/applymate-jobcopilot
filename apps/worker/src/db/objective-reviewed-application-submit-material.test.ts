import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import {
  bindReviewedApplicationSubmissionMaterial, buildObjectiveApplicationSubmissionManifest,
  hashAgentReceiptValue, hashObjectiveApplicationSubmissionMaterial,
  OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"

const mocks = vi.hoisted(() => ({ fill: vi.fn(), manifest: vi.fn() }))
vi.mock("../runtime/objective-reviewed-application-fill-read.js", () => ({ readObjectiveReviewedApplicationFillSource: mocks.fill }))
vi.mock("./objective-submission-manifest-event.js", () => ({ readObjectiveSubmissionManifestWithClient: mocks.manifest }))
import { hasObjectiveSubmissionManifestEvidence, readObjectiveReviewedApplicationSubmitMaterial } from "./objective-reviewed-application-submit-material.js"

const identity = { userId: "user-1", sessionId: "session-1", fillTurnId: "fill-turn-1", applicationTaskId: "application-1",
  jobId: "job-1", approvalId: "submit-approval-1", constraintHash: "c".repeat(64) }
const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  approvalId: `objective-review:objective-review-${"a".repeat(40)}:2`, reviewTurnId: "review-turn-1", materialProofHash: "a".repeat(64) }
const proof = { jobId: identity.jobId, sourceTurnId: "objective-source", rootTaskId: "root-1", graphRevision: 9,
  writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1",
  reviewHash: `sha256:${"b".repeat(64)}`, artifactId: "artifact-1", version: 3,
  contentHash: `sha256:${"d".repeat(64)}`, sourceDigest: `sha256:${"e".repeat(64)}` }
const resumeWitness = { schema: "objective-application-resume-witness.v1", userId: identity.userId, jobId: identity.jobId,
  resumeId: "resume-1", finalResumeAssignmentRevision: 4, materialRevision: 6, resumeMaterialHash: "f".repeat(64) }
const resumeContent = { basics: { name: "Candidate" }, experience: [{ company: "Example" }] }
const coverLetter = "Approved cover letter"
const createdAt = new Date("2026-11-24T11:00:00.000Z")
const leaseExpiresAt = "2026-11-24T11:30:00.000Z"

async function fixture(options: { phase?: "authorize" | "marker" | "boundary"; answers?: unknown; eventData?: unknown;
  eventRows?: unknown[]; task?: Record<string, unknown>; filler?: Record<string, unknown>;
  browserEvent?: { actor?: string; data?: unknown; createdAt?: Date | string } } = {}) {
  const phase = options.phase ?? "authorize"
  const task = { resumeId: resumeWitness.resumeId, coverLetterId: null, confirmedAnswers: options.answers ?? { name: "Candidate" },
    status: "filling", checkpoint: phase === "boundary" ? "submission_request_started" : "browser_active", ...options.task }
  const filler = { id: "filler-1", attemptCount: 2, ...options.filler }
  const binding = browserData({ fillerTaskId: String(filler.id), attemptCount: Number(filler.attemptCount) })
  const event = { actor: "worker", data: options.eventData ?? binding, createdAt, ...options.browserEvent }
  const queries: Array<{ sql: string; values: readonly unknown[] }> = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values })
    if (sql.includes('JOIN "application_tasks" AS task')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "application_tasks"')) return { rows: [task], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [filler], rowCount: 1 }
    if (sql.includes('FROM "application_task_events"')) return { rows: options.eventRows ?? [event], rowCount: 1 }
    throw new Error(`unexpected query: ${sql}`)
  })
  const client = { query } as unknown as Pick<PoolClient, "query">
  const legacy = { applicationTaskId: identity.applicationTaskId, jobId: identity.jobId,
    resumeId: resumeWitness.resumeId, coverLetterId: null }
  const reviewedMaterial = await bindReviewedApplicationSubmissionMaterial(legacy, proof)
  const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers)
  const material = { schemaVersion: OBJECTIVE_APPLICATION_SUBMISSION_MATERIAL_SCHEMA, ...legacy,
    reviewedCoverLetterHash: reviewedMaterial!.reviewedCoverLetterHash, objectiveSource: source }
  const manifest = buildObjectiveApplicationSubmissionManifest(material, answersHash!)!
  const materialHash = await hashObjectiveApplicationSubmissionMaterial(material)
  const stored = { manifest, hash: hashArtifactContent(manifest) }
  mocks.manifest.mockResolvedValue(stored)
  mocks.fill.mockResolvedValue({ source, approvedIntent: {}, proof: {}, reviewedArtifact: { ...proof, content: coverLetter },
    resumeWitness, resumeContent })
  const approval = { resourceHash: stored.hash.slice(7), materialHash: materialHash!, answersHash: answersHash! }
  const turnInput = { reviewedApplicationMaterialSource: source }
  return { client, query, queries, task, filler, event, binding, manifest, stored, approval, turnInput, phase }
}

beforeEach(() => { vi.clearAllMocks() })

describe("Objective reviewed application submit material", () => {
  it.each(["authorize", "marker", "boundary"] as const)("rebuilds current V3 material at %s", async phase => {
    const test = await fixture({ phase })
    await expect(readObjectiveReviewedApplicationSubmitMaterial({ client: test.client, identity, turnInput: test.turnInput,
      approval: test.approval, phase })).resolves.toEqual({ artifactHash: test.approval.resourceHash,
        reviewedCoverLetter: coverLetter, reviewedResumeContent: resumeContent, objectiveSource: source })
    expect(mocks.fill).toHaveBeenCalledWith(test.client, expect.objectContaining({ phase, turnInput: test.turnInput }))
    expect(test.query).toHaveBeenCalledTimes(3)
  })

  it.each([
    ["resource receipt changed", { resourceHash: "9".repeat(64) }],
    ["material receipt changed", { materialHash: "9".repeat(64) }],
    ["answers receipt changed", { answersHash: "9".repeat(64) }],
  ])("rejects when the %s does not match the current manifest", async (_name, changed) => {
    const test = await fixture()
    await expect(readObjectiveReviewedApplicationSubmitMaterial({ client: test.client, identity, turnInput: test.turnInput,
      approval: { ...test.approval, ...changed }, phase: test.phase })).resolves.toBeNull()
  })

  it.each([
    ["foreign source marker", { reviewedApplicationMaterialSource: { ...source, approvalId: "other" } }],
    ["missing source marker", {}],
  ])("fails closed for %s", async (_name, turnInput) => {
    const test = await fixture()
    await expect(readObjectiveReviewedApplicationSubmitMaterial({ client: test.client, identity, turnInput,
      approval: test.approval, phase: test.phase })).resolves.toBeNull()
    expect(test.query).not.toHaveBeenCalled()
  })

  it.each([
    ["duplicate browser-start event", { eventRows: Array(2).fill(undefined) }],
    ["wrong task checkpoint", { task: { checkpoint: "taskgraph_fill_queued" } }],
    ["different current Resume", { task: { resumeId: "resume-other" } }],
    ["different browser-start source", { eventData: { ...browserData(), objectiveSource: { ...source, approvalId: "other" } } }],
    ["different browser-start attempt", { filler: { attemptCount: 3 }, browserEvent: { data: browserData({ attemptCount: 2 }) } }],
    ["browser start after lease expiry", { browserEvent: { data: browserData({ leaseExpiresAt: "2026-11-24T10:59:00.000Z" }) } }],
    ["browser attempt differs from completed filler", { browserEvent: { data: browserData({ attemptCount: 1 }) } }],
  ])("rejects %s", async (_name, options) => {
    const test = await fixture(options as Parameters<typeof fixture>[0])
    await expect(readObjectiveReviewedApplicationSubmitMaterial({ client: test.client, identity, turnInput: test.turnInput,
      approval: test.approval, phase: test.phase })).resolves.toBeNull()
  })

  it("requires the current source, exact manifest and immutable cover-letter proof", async () => {
    const test = await fixture()
    mocks.fill.mockResolvedValueOnce(undefined)
    await expect(readObjectiveReviewedApplicationSubmitMaterial({ client: test.client, identity, turnInput: test.turnInput,
      approval: test.approval, phase: test.phase })).resolves.toBeNull()
    mocks.fill.mockResolvedValueOnce({ source: { ...source, materialProofHash: "8".repeat(64) }, resumeWitness, resumeContent,
      reviewedArtifact: { ...proof, content: coverLetter } })
    await expect(readObjectiveReviewedApplicationSubmitMaterial({ client: test.client, identity, turnInput: test.turnInput,
      approval: test.approval, phase: test.phase })).resolves.toBeNull()
  })

  it("treats malformed current manifest evidence and query failures as a downgrade fence", async () => {
    const test = await fixture()
    const evidenceClient = { query: vi.fn(async () => ({ rows: [{ id: "malformed-v3-event" }] })) } as never
    await expect(hasObjectiveSubmissionManifestEvidence(evidenceClient, identity)).resolves.toBe(true)
    const errorClient = { query: vi.fn(async () => { throw new Error("db unavailable") }) } as never
    await expect(hasObjectiveSubmissionManifestEvidence(errorClient, identity)).resolves.toBe(true)
    await expect(hasObjectiveSubmissionManifestEvidence(test.client, identity)).resolves.toBe(false)
  })
})

function browserData(overrides: Record<string, unknown> = {}) {
  return { ...proof, schemaVersion: OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA, userId: identity.userId, sessionId: identity.sessionId,
    fillTurnId: identity.fillTurnId, jobId: identity.jobId, applicationTaskId: identity.applicationTaskId,
    fillerTaskId: "filler-1", attemptCount: 2, leaseOwner: "worker-1", leaseExpiresAt, objectiveSource: source, ...overrides }
}
