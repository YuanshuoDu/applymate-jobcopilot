import { hashApprovalNonce, hashApprovalScope, type ApprovalScope } from "@jobcopilot/agent-protocol"
import {
  bindReviewedApplicationSubmissionMaterial, buildApplicationSubmissionManifest, hashAgentReceiptValue,
  hashApplicationSubmissionMaterial, isApplicationSubmissionManifest, parseReviewedApplicationFillBrowserStartEvent,
  REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA, REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA,
} from "@jobcopilot/shared"
import { describe, expect, it, vi } from "vitest"
import { hashArtifactContent } from "../artifacts/hash"
import { resolveReviewedSubmitMaterial } from "./reviewed-submit-material"

const input = { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1", jobId: "job-1",
  fillTurnId: "fill-turn-1", approvalId: "approval-1", receiptNonce: "a".repeat(64) }
const sourceTurnId = "source-turn-1"
const material = { applicationTaskId: input.applicationTaskId, jobId: input.jobId, resumeId: "resume-1", coverLetterId: "cover-1" }
const proof = {
  jobId: input.jobId, sourceTurnId, rootTaskId: "source-root-1", graphRevision: 4, writerTaskId: "writer-1",
  reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1", reviewHash: `sha256:${"a".repeat(64)}`,
  artifactId: "cover-artifact-1", version: 2, contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
}

async function fixture(reviewed = false) {
  const answers = { rightToWork: "yes" }
  const answersHash = await hashAgentReceiptValue("answers", answers)
  const boundMaterial = reviewed ? await bindReviewedApplicationSubmissionMaterial(material, proof) : null
  const manifest = buildApplicationSubmissionManifest(boundMaterial ?? material, answersHash)!
  const artifactHash = hashArtifactContent(manifest)
  const resourceHash = artifactHash.slice("sha256:".length)
  const materialHash = boundMaterial ? await hashApplicationSubmissionMaterial(boundMaterial) : await hashAgentReceiptValue("material", material)
  if (!materialHash) throw new Error("invalid fixture material")
  const nonceHash = await hashApprovalNonce(input.receiptNonce)
  const scope: ApprovalScope = { userId: input.userId, sessionId: input.sessionId, turnId: input.fillTurnId, jobId: input.jobId,
    toolCallId: `application-submit:${input.applicationTaskId}`, action: "submit_application", resourceHash, materialHash,
    answersHash, revision: 3, nonceHash, expiresAt: "2027-01-01T00:00:00.000Z" }
  const approval = { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, turnId: input.fillTurnId,
    taskId: input.applicationTaskId, jobId: input.jobId, type: "submit_application", status: "approved",
    toolCallId: scope.toolCallId, payload: material, resourceHash, materialHash, answersHash,
    scopeHash: await hashApprovalScope(scope), nonceHash, revision: scope.revision, expiresAt: new Date(scope.expiresAt) }
  const browserData = {
    schemaVersion: REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA, userId: input.userId, sessionId: input.sessionId,
    fillTurnId: input.fillTurnId, applicationTaskId: input.applicationTaskId,
    fillerTaskId: "filler-1", attemptCount: 2, leaseOwner: "worker-1", leaseExpiresAt: "2026-11-20T12:00:00.000Z", ...proof,
  }
  const task = { id: input.applicationTaskId, userId: input.userId, sessionId: input.sessionId, jobId: input.jobId,
    fillTurnId: input.fillTurnId, fillTurnSessionId: input.sessionId, fillTurnUserId: input.userId,
    resumeId: material.resumeId, coverLetterId: material.coverLetterId, confirmedAnswers: answers }
  type StartRow = { id: string; taskId: string; type: string; actor: string; data: unknown }
  const starts: StartRow[] = reviewed ? [{ id: "event-1", taskId: task.id, type: "reviewed_application_fill_browser_started",
    actor: "worker", data: browserData }] : []
  const artifact = { id: `application:${task.id}`, userId: task.userId, jobId: task.jobId,
    artifactType: "application", lifecycle: "base", baseId: `application:${task.id}`, baseHash: artifactHash,
    content: manifest, hash: artifactHash, constraintHash: hashArtifactContent({ applicationTaskId: task.id, jobId: task.jobId }),
    provenanceRefs: [`application-task:${task.id}`], evidenceRefs: [`application-task:${task.id}`], previousHash: null, version: 1 }
  const fake = {
    applicationTask: { findMany: vi.fn(async () => [task]) },
    agentTurn: { findMany: vi.fn(async () => [{ id: input.fillTurnId, userId: input.userId, sessionId: input.sessionId,
      source: "user", status: "waiting_for_approval", input: reviewed ? { reviewedApplicationMaterialSource: {
        schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId,
      } } : { goal: "Fill for review" } }]) },
    applicationTaskEvent: { findMany: vi.fn(async (query: { where: { taskId: string; type: string; data?: { path: string[]; equals: string } }; take: number }) =>
      starts.filter(row => row.taskId === query.where.taskId && row.type === query.where.type
        && (!query.where.data || (row.data as { fillTurnId?: unknown }).fillTurnId === query.where.data.equals)).slice(0, query.take)) },
    subAgentTask: { findMany: vi.fn(async (_query: { where: Record<string, unknown> }) => [{ id: "filler-1", attemptCount: 2,
      status: "completed", completedAt: new Date(), rootTaskId: "source-root-1", leaseOwner: null as string | null,
      leaseExpiresAt: null as Date | null, interruptRequestedAt: null as Date | null }]) },
    agentArtifact: { findMany: vi.fn(async () => [artifact]) },
    agentApproval: { findMany: vi.fn(async () => [approval]) },
  }
  return { fake, task, approval, manifest, artifact, browserData, expectedHashes: { resourceHash, materialHash, answersHash } }
}

describe("resolveReviewedSubmitMaterial", () => {
  it("preserves the legacy v1 path when no exact current-turn v2 event exists", async () => {
    const state = await fixture()
    state.fake.applicationTaskEvent.findMany.mockImplementationOnce(async query => [{ id: "old-event", taskId: input.applicationTaskId,
      type: "reviewed_application_fill_browser_started", actor: "worker", data: { fillTurnId: "previous-fill-turn" } }]
      .filter(row => row.taskId === query.where.taskId && row.type === query.where.type
        && (!query.where.data || (row.data as { fillTurnId?: unknown }).fillTurnId === query.where.data.equals)).slice(0, query.take))
    state.fake.agentArtifact.findMany.mockResolvedValueOnce([])
    state.fake.agentApproval.findMany.mockResolvedValueOnce([])
    const result = await resolveReviewedSubmitMaterial(state.fake as never, input)
    expect(state.fake.applicationTaskEvent.findMany).toHaveBeenCalledWith({ where: { taskId: input.applicationTaskId,
      type: "reviewed_application_fill_browser_started", data: { path: ["fillTurnId"], equals: input.fillTurnId } }, take: 1, select: { id: true } })
    expect([state.fake.agentTurn.findMany.mock.calls.length, state.fake.applicationTaskEvent.findMany.mock.calls.length,
      state.fake.agentArtifact.findMany.mock.calls.length, state.fake.agentApproval.findMany.mock.calls.length]).toEqual([1, 1, 1, 0])
    expect(result).toEqual({ mode: "legacy" })
  })

  it("preserves a fully bound immutable v1 application artifact", async () => {
    const state = await fixture()
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "legacy" })
    expect(state.fake.agentArtifact.findMany).toHaveBeenCalledWith({
      where: { id: `application:${input.applicationTaskId}`, userId: input.userId, jobId: input.jobId }, take: 2,
      select: { id: true, userId: true, jobId: true, artifactType: true, lifecycle: true, baseId: true, baseHash: true,
        content: true, hash: true, constraintHash: true, provenanceRefs: true, evidenceRefs: true, previousHash: true, version: true },
    })
    expect(state.fake.agentApproval.findMany).not.toHaveBeenCalled()
  })

  it("returns only signed scoped hashes for one completed reviewed browser attempt", async () => {
    const state = await fixture(true)
    expect(parseReviewedApplicationFillBrowserStartEvent(state.browserData)).not.toBeNull()
    expect(state.manifest.schemaVersion).toBe("agent-harness.application-submission.v2")
    expect(isApplicationSubmissionManifest(state.manifest)).toBe(true)
    expect(state.artifact.baseHash).toBe(state.artifact.hash)
    expect(state.approval.payload).toEqual(material)
    expect(state.approval.resourceHash).toBe(state.expectedHashes.resourceHash)
    expect(state.approval.materialHash).toBe(state.expectedHashes.materialHash)
    expect(state.approval.answersHash).toBe(state.expectedHashes.answersHash)
    expect(state.approval.nonceHash).toBe(await hashApprovalNonce(input.receiptNonce))
    expect(state.approval.scopeHash).toBe(await hashApprovalScope({ userId: input.userId, sessionId: input.sessionId,
      turnId: input.fillTurnId, jobId: input.jobId, toolCallId: `application-submit:${input.applicationTaskId}`,
      action: "submit_application", resourceHash: state.expectedHashes.resourceHash, materialHash: state.expectedHashes.materialHash,
      answersHash: state.expectedHashes.answersHash, revision: state.approval.revision, nonceHash: state.approval.nonceHash,
      expiresAt: state.approval.expiresAt.toISOString() }))
    const result = await resolveReviewedSubmitMaterial(state.fake as never, input)
    expect([state.fake.agentTurn.findMany.mock.calls.length, state.fake.applicationTaskEvent.findMany.mock.calls.length,
      state.fake.subAgentTask.findMany.mock.calls.length, state.fake.agentArtifact.findMany.mock.calls.length,
      state.fake.agentApproval.findMany.mock.calls.length]).toEqual([1, 1, 1, 1, 1])
    expect(result).toEqual({ mode: "reviewed", ready: true, ...state.expectedHashes })
    expect(JSON.stringify(result)).not.toMatch(/application-1|source-turn-1|cover-artifact-1|worker-1/)
  })

  it("fails closed when the v2 manifest lacks its persisted selector", async () => {
    const state = await fixture(true)
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: input.userId,
      sessionId: input.sessionId, source: "user", status: "completed", input: { goal: "legacy" } }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
  })

  it("rejects a v2 manifest downgrade when its current-turn browser event is absent", async () => {
    const state = await fixture(true)
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: input.userId,
      sessionId: input.sessionId, source: "user", status: "waiting_for_approval", input: { goal: "legacy" } }])
    state.fake.applicationTaskEvent.findMany.mockResolvedValueOnce([])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.agentArtifact.findMany).toHaveBeenCalledWith({ where: { id: `application:${input.applicationTaskId}`,
      userId: input.userId, jobId: input.jobId }, take: 2,
      select: { id: true, userId: true, jobId: true, artifactType: true, lifecycle: true, baseId: true, baseHash: true,
        content: true, hash: true, constraintHash: true, provenanceRefs: true, evidenceRefs: true, previousHash: true, version: true } })
    expect(state.fake.agentApproval.findMany).not.toHaveBeenCalled()
  })

  it("rejects an ambiguous or malformed application artifact on the legacy branch", async () => {
    const duplicate = await fixture()
    duplicate.fake.agentArtifact.findMany.mockResolvedValueOnce([duplicate.artifact, duplicate.artifact])
    await expect(resolveReviewedSubmitMaterial(duplicate.fake as never, input)).resolves.toEqual({ mode: "unavailable" })

    const malformed = await fixture()
    malformed.fake.agentArtifact.findMany.mockResolvedValueOnce([{ ...malformed.artifact, version: 2 }])
    await expect(resolveReviewedSubmitMaterial(malformed.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
  })

  it("requires stored task identity to match the exact fill scope", async () => {
    const state = await fixture()
    state.fake.applicationTask.findMany.mockResolvedValueOnce([{ ...state.task, fillTurnSessionId: "foreign-session" }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.agentTurn.findMany).not.toHaveBeenCalled()
  })

  it("requires the stored user Turn identity to match the exact fill scope", async () => {
    const state = await fixture()
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: "foreign-user",
      sessionId: input.sessionId, source: "user", status: "waiting_for_approval", input: { goal: "legacy" } }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.applicationTaskEvent.findMany).not.toHaveBeenCalled()
  })

  it.each(["foreign task", "missing completed attempt", "wrong attempt", "wrong event actor", "duplicate start"])(
    "rejects %s proof without selecting a best match", async mode => {
      const state = await fixture(true)
      if (mode === "foreign task") state.fake.applicationTask.findMany.mockResolvedValueOnce([])
      if (mode === "missing completed attempt") state.fake.subAgentTask.findMany.mockResolvedValueOnce([])
      if (mode === "wrong attempt") state.fake.subAgentTask.findMany.mockResolvedValueOnce([{ id: "filler-1", attemptCount: 1,
        status: "completed", completedAt: new Date(), rootTaskId: "source-root-1", leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null }])
      if (mode === "wrong event actor") state.fake.applicationTaskEvent.findMany.mockResolvedValueOnce([{ id: "event-1", taskId: input.applicationTaskId,
        type: "reviewed_application_fill_browser_started", actor: "user", data: state.browserData }])
      if (mode === "duplicate start") state.fake.applicationTaskEvent.findMany.mockResolvedValueOnce([
        { id: "event-1", taskId: input.applicationTaskId, type: "reviewed_application_fill_browser_started", actor: "worker", data: state.browserData },
        { id: "event-2", taskId: input.applicationTaskId, type: "reviewed_application_fill_browser_started", actor: "worker", data: state.browserData },
      ])
      await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    },
  )

  it("rejects current answers, immutable manifest, approval scope, and nonce drift", async () => {
    const changedAnswers = await fixture(true)
    changedAnswers.fake.applicationTask.findMany.mockResolvedValueOnce([{ ...changedAnswers.task, confirmedAnswers: { rightToWork: "no" } }])
    await expect(resolveReviewedSubmitMaterial(changedAnswers.fake as never, input)).resolves.toEqual({ mode: "unavailable" })

    const badScope = await fixture(true)
    badScope.fake.agentApproval.findMany.mockResolvedValueOnce([{ ...badScope.approval, scopeHash: "0".repeat(64) }])
    await expect(resolveReviewedSubmitMaterial(badScope.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    await expect(resolveReviewedSubmitMaterial((await fixture(true)).fake as never, { ...input, receiptNonce: "b".repeat(64) }))
      .resolves.toEqual({ mode: "unavailable" })

    const drifted = await fixture(true)
    drifted.fake.agentArtifact.findMany.mockResolvedValueOnce([{ ...drifted.artifact,
      content: { ...drifted.manifest, answersHash: "0".repeat(64) } }])
    await expect(resolveReviewedSubmitMaterial(drifted.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
  })

  it("requires the exact completed filler attempt to have released its lease", async () => {
    const state = await fixture(true)
    state.fake.subAgentTask.findMany.mockResolvedValueOnce([{ id: "filler-1", attemptCount: 2, status: "completed",
      completedAt: new Date(), rootTaskId: "source-root-1", leaseOwner: "worker-still-running", leaseExpiresAt: new Date(), interruptRequestedAt: null }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable"})
    expect(state.fake.subAgentTask.findMany.mock.calls[0]![0].where).toMatchObject({ session: { is: { userId: input.userId } },
      rootTaskId: "source-root-1", leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null })
  })

  it("returns unavailable on database failure and leaves the public result free of material", async () => {
    const state = await fixture(true)
    state.fake.applicationTask.findMany.mockRejectedValueOnce(new Error("private database detail"))
    const result = await resolveReviewedSubmitMaterial(state.fake as never, input)
    expect(result).toEqual({ mode: "unavailable" })
    expect(JSON.stringify(result)).not.toContain("private database detail")
  })
})
