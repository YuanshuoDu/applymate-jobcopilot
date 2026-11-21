import { hashApprovalNonce, hashApprovalScope, type ApprovalScope } from "@jobcopilot/agent-protocol"
import {
  bindReviewedApplicationSubmissionMaterial, buildApplicationSubmissionManifest, hashAgentReceiptValue,
  hashApplicationSubmissionMaterial, isApplicationSubmissionManifest, parseReviewedApplicationFillBrowserStartEvent,
  REVIEWED_APPLICATION_FILL_BROWSER_START_SCHEMA, REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA,
} from "@jobcopilot/shared"
import { describe, expect, it, vi } from "vitest"
import { hashArtifactContent } from "../artifacts/hash"
import { lockReviewedSubmitSourceScope, resolveReviewedSubmitMaterial, sameReviewedSubmitMaterialSnapshot } from "./reviewed-submit-material"

const input = { userId: "user-1", sessionId: "session-1", applicationTaskId: "application-1", jobId: "job-1",
  fillTurnId: "fill-turn-1", approvalId: "approval-1", receiptNonce: "a".repeat(64) }
const sourceTurnId = "source-turn-1"
const material = { applicationTaskId: input.applicationTaskId, jobId: input.jobId, resumeId: "resume-1", coverLetterId: "cover-1" }
const proof = {
  jobId: input.jobId, sourceTurnId, rootTaskId: "source-root-1", graphRevision: 4, writerTaskId: "writer-1",
  reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1", reviewHash: `sha256:${"a".repeat(64)}`,
  artifactId: "cover-artifact-1", version: 2, contentHash: `sha256:${"b".repeat(64)}`, sourceDigest: `sha256:${"c".repeat(64)}`,
}
const fillRootTaskId = "fill-root-1"

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
  const fillers = [{ id: "filler-1", sessionId: input.sessionId, turnId: input.fillTurnId, role: "application_filler",
    taskType: "application_fill_for_review", attemptCount: 2, status: "completed", completedAt: new Date(),
    rootTaskId: fillRootTaskId, leaseOwner: null as string | null, leaseExpiresAt: null as Date | null,
    interruptRequestedAt: null as Date | null }]
  const artifact = { id: `application:${task.id}`, userId: task.userId, jobId: task.jobId,
    artifactType: "application", lifecycle: "base", baseId: `application:${task.id}`, baseHash: artifactHash,
    content: manifest, hash: artifactHash, constraintHash: hashArtifactContent({ applicationTaskId: task.id, jobId: task.jobId }),
    provenanceRefs: [`application-task:${task.id}`], evidenceRefs: [`application-task:${task.id}`], previousHash: null, version: 1 }
  const fake = {
    applicationTask: { findMany: vi.fn(async () => [task]) },
    agentTurn: { findMany: vi.fn(async (_query: { where: Record<string, unknown>; take: number; select: Record<string, unknown> }) => [{ id: input.fillTurnId, userId: input.userId, sessionId: input.sessionId,
      source: "user", status: "waiting_for_approval", rootTaskId: fillRootTaskId, input: reviewed ? { reviewedApplicationMaterialSource: {
        schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId,
      } } : { goal: "Fill for review" } }]) },
    applicationTaskEvent: { findMany: vi.fn(async (query: { where: { taskId: string; type: string; data?: { path: string[]; equals: string } }; take: number }) =>
      starts.filter(row => row.taskId === query.where.taskId && row.type === query.where.type
        && (!query.where.data || (row.data as { fillTurnId?: unknown }).fillTurnId === query.where.data.equals)).slice(0, query.take)) },
    subAgentTask: { findMany: vi.fn(async (query: { where: Record<string, unknown>; take: number }) => fillers.filter(row =>
      row.sessionId === query.where.sessionId && row.turnId === query.where.turnId && row.rootTaskId === query.where.rootTaskId
      && row.role === query.where.role && row.taskType === query.where.taskType && row.status === query.where.status
      && row.completedAt !== null && row.leaseOwner === query.where.leaseOwner && row.leaseExpiresAt === query.where.leaseExpiresAt
      && row.interruptRequestedAt === query.where.interruptRequestedAt
      && (query.where.session as { is: { userId: string } }).is.userId === input.userId).slice(0, query.take)) },
    agentArtifact: { findMany: vi.fn(async () => [artifact]) },
    agentApproval: { findMany: vi.fn(async () => [approval]) },
  }
  return { fake, task, approval, manifest, artifact, browserData, fillers, expectedHashes: { resourceHash, materialHash, answersHash } }
}

describe("resolveReviewedSubmitMaterial", () => {
  it("locks the exact owner scope in Session, Turn, Task, Job, approval order", async () => {
    const responses: unknown[][] = [[{ transaction_id: "41" }], [{ transaction_id: "41" }],
      [{ id: input.sessionId }], [{ id: input.fillTurnId }], [{ id: input.applicationTaskId }], [{ id: input.jobId }], [{ id: input.approvalId }]]
    const queryRaw = vi.fn(async (_query: unknown) => responses.shift() ?? [])
    await expect(lockReviewedSubmitSourceScope({ $queryRaw: queryRaw } as never, input)).resolves.toBe(true)
    const statements = queryRaw.mock.calls.slice(2).map(([query]) => query as { sql: string; values: unknown[] })
    expect(statements.map(query => query.sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('FROM "agent_sessions"'), expect.stringContaining('FROM "agent_turns"'),
      expect.stringContaining('FROM "application_tasks"'), expect.stringContaining('FROM "Job"'), expect.stringContaining('FROM "agent_approvals"'),
    ]))
    expect(statements.map(query => query.values)).toEqual([
      [input.sessionId, input.userId], [input.fillTurnId, input.sessionId, input.userId],
      [input.applicationTaskId, input.userId, input.sessionId, input.fillTurnId, input.jobId], [input.jobId, input.userId],
      [input.approvalId, input.userId, input.sessionId, input.applicationTaskId, input.fillTurnId, input.jobId],
    ])
  })

  it("does not treat a changed proof mode or signed hash as the same material snapshot", () => {
    expect(sameReviewedSubmitMaterialSnapshot({ mode: "legacy" }, { mode: "reviewed", ready: true,
      resourceHash: "r", materialHash: "m", answersHash: "a" })).toBe(false)
    expect(sameReviewedSubmitMaterialSnapshot({ mode: "reviewed", ready: true, resourceHash: "r", materialHash: "m", answersHash: "a" },
      { mode: "reviewed", ready: true, resourceHash: "r", materialHash: "changed", answersHash: "a" })).toBe(false)
  })

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

  it("preserves historical v1 artifacts without imposing new immutability requirements", async () => {
    const state = await fixture()
    state.fake.agentArtifact.findMany.mockResolvedValueOnce([{ ...state.artifact, version: 2 }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "legacy" })
    expect(state.fake.agentArtifact.findMany).toHaveBeenCalledWith({
      where: { id: `application:${input.applicationTaskId}`, userId: input.userId, jobId: input.jobId }, take: 2, select: { content: true },
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
    expect(state.fake.agentTurn.findMany.mock.calls[0]![0].select).toMatchObject({ rootTaskId: true })
    expect(state.fake.subAgentTask.findMany.mock.calls[0]![0].where).toMatchObject({ turnId: input.fillTurnId,
      rootTaskId: fillRootTaskId, role: "application_filler", taskType: "application_fill_for_review", status: "completed",
      completedAt: { not: null }, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null })
    expect(state.fake.subAgentTask.findMany.mock.calls[0]![0].where).not.toHaveProperty("id")
    expect(state.fake.subAgentTask.findMany.mock.calls[0]![0].where).not.toHaveProperty("attemptCount")
    expect(state.browserData.rootTaskId).toBe("source-root-1")
  })

  it("fails closed when the v2 manifest lacks its persisted selector", async () => {
    const state = await fixture(true)
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: input.userId,
      sessionId: input.sessionId, source: "user", status: "completed", rootTaskId: fillRootTaskId, input: { goal: "legacy" } }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
  })

  it("rejects a v2 manifest downgrade when its current-turn browser event is absent", async () => {
    const state = await fixture(true)
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: input.userId,
      sessionId: input.sessionId, source: "user", status: "waiting_for_approval", rootTaskId: fillRootTaskId, input: { goal: "legacy" } }])
    state.fake.applicationTaskEvent.findMany.mockResolvedValueOnce([])
    state.fake.agentArtifact.findMany.mockResolvedValueOnce([{ ...state.artifact, artifactType: "other", lifecycle: "draft" }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.agentArtifact.findMany).toHaveBeenCalledWith({ where: { id: `application:${input.applicationTaskId}`,
      userId: input.userId, jobId: input.jobId }, take: 2, select: { content: true } })
    expect(state.fake.agentApproval.findMany).not.toHaveBeenCalled()
  })

  it("rejects an ambiguous or malformed reviewed artifact signal on the legacy branch", async () => {
    const duplicate = await fixture()
    duplicate.fake.agentArtifact.findMany.mockResolvedValueOnce([duplicate.artifact, duplicate.artifact])
    await expect(resolveReviewedSubmitMaterial(duplicate.fake as never, input)).resolves.toEqual({ mode: "unavailable" })

    const malformed = await fixture()
    const malformedContent = { ...malformed.manifest, reviewedCoverLetterHash: "a".repeat(64) }
    malformed.fake.agentArtifact.findMany.mockResolvedValueOnce([{ ...malformed.artifact, content: malformedContent }])
    await expect(resolveReviewedSubmitMaterial(malformed.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
  })

  it("requires stored task identity to match the exact fill scope", async () => {
    const state = await fixture(true)
    state.fake.applicationTask.findMany.mockResolvedValueOnce([{ ...state.task, fillTurnSessionId: "foreign-session" }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.subAgentTask.findMany).not.toHaveBeenCalled()
  })

  it("requires the stored user Turn identity to match the exact fill scope", async () => {
    const state = await fixture()
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: "foreign-user",
      sessionId: input.sessionId, source: "user", status: "waiting_for_approval", rootTaskId: fillRootTaskId, input: { goal: "legacy" } }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.applicationTaskEvent.findMany).not.toHaveBeenCalled()
  })

  it.each(["foreign task", "missing completed attempt", "wrong attempt", "wrong event actor", "duplicate start"])(
    "rejects %s proof without selecting a best match", async mode => {
      const state = await fixture(true)
      if (mode === "foreign task") state.fake.applicationTask.findMany.mockResolvedValueOnce([])
      if (mode === "missing completed attempt") state.fake.subAgentTask.findMany.mockResolvedValueOnce([])
      if (mode === "wrong attempt") state.fake.subAgentTask.findMany.mockResolvedValueOnce([{ ...state.fillers[0]!, attemptCount: 1 }])
      if (mode === "wrong event actor") state.fake.applicationTaskEvent.findMany.mockResolvedValueOnce([{ id: "event-1", taskId: input.applicationTaskId,
        type: "reviewed_application_fill_browser_started", actor: "user", data: state.browserData }])
      if (mode === "duplicate start") state.fake.applicationTaskEvent.findMany.mockResolvedValueOnce([
        { id: "event-1", taskId: input.applicationTaskId, type: "reviewed_application_fill_browser_started", actor: "worker", data: state.browserData },
        { id: "event-2", taskId: input.applicationTaskId, type: "reviewed_application_fill_browser_started", actor: "worker", data: state.browserData },
      ])
      await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    },
  )

  it.each(["wrong fill root", "duplicate fill-root filler"])("rejects %s filler scope", async mode => {
    const state = await fixture(true)
    if (mode === "wrong fill root") state.fillers[0]!.rootTaskId = "other-fill-root"
    if (mode === "duplicate fill-root filler") state.fillers.push({ ...state.fillers[0]!, id: "filler-2", attemptCount: 1 })
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
  })

  it("rejects a source Root reused as the fill Turn Root", async () => {
    const state = await fixture(true)
    state.fake.agentTurn.findMany.mockResolvedValueOnce([{ id: input.fillTurnId, userId: input.userId,
      sessionId: input.sessionId, source: "user", status: "waiting_for_approval", rootTaskId: proof.rootTaskId,
      input: { reviewedApplicationMaterialSource: { schemaVersion: REVIEWED_APPLICATION_FILL_SOURCE_SCHEMA, sourceTurnId } } }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable" })
    expect(state.fake.subAgentTask.findMany).not.toHaveBeenCalled()
  })

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
    state.fake.subAgentTask.findMany.mockResolvedValueOnce([{ ...state.fillers[0]!, leaseOwner: "worker-still-running", leaseExpiresAt: new Date() }])
    await expect(resolveReviewedSubmitMaterial(state.fake as never, input)).resolves.toEqual({ mode: "unavailable"})
    expect(state.fake.subAgentTask.findMany.mock.calls[0]![0].where).toMatchObject({ session: { is: { userId: input.userId } },
      rootTaskId: fillRootTaskId, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null })
  })

  it("returns unavailable on database failure and leaves the public result free of material", async () => {
    const state = await fixture(true)
    state.fake.applicationTask.findMany.mockRejectedValueOnce(new Error("private database detail"))
    const result = await resolveReviewedSubmitMaterial(state.fake as never, input)
    expect(result).toEqual({ mode: "unavailable" })
    expect(JSON.stringify(result)).not.toContain("private database detail")
  })
})
