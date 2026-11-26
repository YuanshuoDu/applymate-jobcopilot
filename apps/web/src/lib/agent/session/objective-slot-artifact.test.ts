import { beforeEach, describe, expect, it, vi } from "vitest"
import { hashArtifactContent } from "../artifacts/hash"

const mocks = vi.hoisted(() => ({ context: vi.fn(), ready: vi.fn(), manifest: vi.fn() }))
vi.mock("./objective-journey-report-source", () => ({ readObjectiveJourneyProofContext: mocks.context, readObjectiveJourneyReadySlot: mocks.ready }))
vi.mock("../broker/objective-application-review-source-proof", () => ({ validObjectiveApplicationSourceManifest: mocks.manifest }))

const input = { userId: "user-1", sessionId: "session-1", finalItemId: "final-1", graphRevision: 7, slotOrdinal: 1 }
const sourceDigest = `sha256:${"b".repeat(64)}`, reviewHash = `sha256:${"c".repeat(64)}`
const body = "Saved immutable draft", contentHash = hashArtifactContent(body)
const ref = { artifactId: "cover-letter-1", version: 1, contentHash, sourceDigest }
const writer = { id: "writer-1", sessionId: input.sessionId, turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", role: "writer", taskType: "cover_letter_draft", status: "completed" }
const reviewer = { id: "reviewer-1", sessionId: input.sessionId, turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", role: "reviewer", taskType: "cover_letter_review", status: "completed" }

function version(overrides: Record<string, unknown> = {}) {
  return { id: "version-1", artifactId: ref.artifactId, version: ref.version, userId: input.userId, sessionId: input.sessionId,
    jobId: "job-1", artifactType: "cover_letter", content: body, contentHash, sourceDigest, previousHash: null, taskId: writer.id, ...overrides }
}
function review(overrides: Record<string, unknown> = {}) {
  return { artifactVersionId: "version-1", userId: input.userId, sessionId: input.sessionId, jobId: "job-1", taskId: reviewer.id,
    artifactId: ref.artifactId, version: ref.version, contentHash, sourceDigest, currentSourceDigest: sourceDigest, status: "passed", reviewHash, toolCallId: "review-call", ...overrides }
}
function txFixture(options: { job?: readonly Record<string, unknown>[]; versions?: readonly Record<string, unknown>[]; reviews?: readonly Record<string, unknown>[] } = {}) {
  const tx = {
    job: { findMany: vi.fn(async () => options.job ?? [{ id: "job-1", userId: input.userId }]) },
    agentArtifactVersion: { findMany: vi.fn(async ({ where }: { where: { version: number } }) => {
      const rows = options.versions ?? [version()]
      return rows.filter(row => row.version === where.version)
    }) },
    agentArtifactReview: { findMany: vi.fn(async ({ where }: { where: { status: string } }) => {
      const rows = options.reviews ?? [review()]
      return rows.filter(row => row.status === where.status)
    }) },
  }
  return tx
}

describe("Objective slot immutable artifact evidence", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.manifest.mockReturnValue(true)
    mocks.context.mockResolvedValue({ userId: input.userId, sessionId: input.sessionId, sourceTurnId: "turn-1", rootTaskId: "root-1", graphRevision: 7,
      manifest: {}, progress: {}, tasks: new Map([[writer.id, writer], [reviewer.id, reviewer]]) })
    mocks.ready.mockReturnValue({ ordinal: 1, jobId: "job-1", writerTaskId: writer.id, reviewerTaskId: reviewer.id, artifactRef: ref, reviewHash })
  })

  it("returns only the exact immutable reference for a passed effective pair", async () => {
    const { readObjectiveSlotArtifactEvidence } = await import("./objective-slot-artifact")
    const tx = txFixture()
    const result = await readObjectiveSlotArtifactEvidence(tx as never, input)
    expect(result).toEqual({ schemaVersion: "agent-harness.v2.objective-slot-artifact.v1", graphRevision: 7, slotOrdinal: 1, artifactRef: ref })
    expect(tx.job.findMany).toHaveBeenCalledWith({ where: { id: "job-1", userId: input.userId }, take: 2, select: { id: true, userId: true } })
    expect(JSON.stringify(result)).not.toContain("job-1")
    expect((tx as never as { agentArtifact?: unknown }).agentArtifact).toBeUndefined()
  })

  it("returns an opaque receipt for the exact current passed Reviewer row", async () => {
    const { readObjectiveSlotReviewerReceiptEvidence } = await import("./objective-slot-artifact")
    const result = await readObjectiveSlotReviewerReceiptEvidence(txFixture() as never, input)
    expect(result).toMatchObject({ schemaVersion: "agent-harness.v2.objective-slot-reviewer-receipt.v1", graphRevision: 7,
      slotOrdinal: 1, artifactVersion: 1, outcome: "passed" })
    expect(result?.receiptKey).toMatch(/^review-[a-f0-9]{64}$/)
    expect(JSON.stringify(result)).not.toContain("review-call")
    expect(JSON.stringify(result)).not.toContain("job-1")
    expect(JSON.stringify(result)).not.toContain(reviewHash)
  })

  it("is replay-stable and changes when the verified Reviewer identity changes", async () => {
    const { readObjectiveSlotReviewerReceiptEvidence } = await import("./objective-slot-artifact")
    const first = await readObjectiveSlotReviewerReceiptEvidence(txFixture() as never, input)
    const replay = await readObjectiveSlotReviewerReceiptEvidence(txFixture() as never, input)
    const changed = await readObjectiveSlotReviewerReceiptEvidence(txFixture({ reviews: [review({ toolCallId: "review-call-2" })] }) as never, input)
    expect(first?.receiptKey).toBe(replay?.receiptKey)
    expect(changed?.receiptKey).not.toBe(first?.receiptKey)
  })

  it("keeps a historical corrected version bound to its prior needs-revision receipt", async () => {
    const priorBody = "Initial draft", priorHash = hashArtifactContent(priorBody)
    const currentBody = "Corrected draft", currentRef = { ...ref, version: 2, contentHash: hashArtifactContent(currentBody) }
    const priorRef = { ...ref, contentHash: priorHash }
    mocks.ready.mockReturnValue({ ordinal: 1, jobId: "job-1", writerTaskId: writer.id, reviewerTaskId: reviewer.id, artifactRef: currentRef, reviewHash,
      prior: { writerTaskId: writer.id, reviewerTaskId: reviewer.id, artifactRef: priorRef, reviewHash: `sha256:${"e".repeat(64)}`, toolCallId: "prior-review" } })
    const tx = txFixture({ versions: [version({ version: 2, content: currentBody, contentHash: currentRef.contentHash, previousHash: priorHash }),
      version({ id: "version-0", version: 1, content: priorBody, contentHash: priorHash, previousHash: null })], reviews: [review({ version: 2, contentHash: currentRef.contentHash }), review({ artifactVersionId: "version-0", version: 1,
        contentHash: priorHash, status: "needs_revision", reviewHash: `sha256:${"e".repeat(64)}`, toolCallId: "prior-review" })] })
    const { readObjectiveSlotArtifactEvidence } = await import("./objective-slot-artifact")
    expect(await readObjectiveSlotArtifactEvidence(tx as never, input)).toEqual({ schemaVersion: "agent-harness.v2.objective-slot-artifact.v1", graphRevision: 7, slotOrdinal: 1, artifactRef: currentRef })
    const { readObjectiveSlotReviewerReceiptEvidence } = await import("./objective-slot-artifact")
    const receipt = await readObjectiveSlotReviewerReceiptEvidence(tx as never, input)
    expect(receipt).toMatchObject({ graphRevision: 7, slotOrdinal: 1, artifactVersion: 2, outcome: "passed" })
    expect(receipt?.receiptKey).toMatch(/^review-[a-f0-9]{64}$/)
  })

  it.each([
    ["wrong task role", { reviewer: { ...reviewer, role: "writer" } }],
    ["foreign job", { job: [{ id: "job-1", userId: "foreign" }] }],
    ["changed immutable content", { versions: [version({ content: "tampered" })] }],
    ["missing passed receipt", { reviews: [] }],
  ])("fails closed for %s", async (_label, override) => {
    const value = override as { reviewer?: typeof reviewer; job?: readonly Record<string, unknown>[]; versions?: readonly Record<string, unknown>[]; reviews?: readonly Record<string, unknown>[] }
    if (value.reviewer) mocks.context.mockResolvedValue({ userId: input.userId, sessionId: input.sessionId, sourceTurnId: "turn-1", rootTaskId: "root-1", graphRevision: 7,
      manifest: {}, progress: {}, tasks: new Map([[writer.id, writer], [reviewer.id, value.reviewer]]) })
    const tx = txFixture(value)
    const { readObjectiveSlotArtifactEvidence } = await import("./objective-slot-artifact")
    expect(await readObjectiveSlotArtifactEvidence(tx as never, input)).toBeNull()
    const { readObjectiveSlotReviewerReceiptEvidence } = await import("./objective-slot-artifact")
    expect(await readObjectiveSlotReviewerReceiptEvidence(tx as never, input)).toBeNull()
  })
})
