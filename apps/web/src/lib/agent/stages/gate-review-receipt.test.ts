import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

const mocks = vi.hoisted(() => ({ turnFindFirst: vi.fn(), issueLegacyReceipt: vi.fn(), clientReceipt: vi.fn(), hashLegacyValue: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentTurn: { findFirst: mocks.turnFindFirst } } }))
vi.mock("../approval/legacy-receipt", () => ({ issueLegacyReceipt: mocks.issueLegacyReceipt, clientReceipt: mocks.clientReceipt, hashLegacyValue: mocks.hashLegacyValue }))

import type { ApplicationPackage, PipelineCtx } from "../types"
import { createGateReviewReceipt } from "./gate-review-receipt"

function ctx(overrides: Partial<PipelineCtx> = {}): PipelineCtx {
  return {
    userId: "user_1",
    sessionId: "session_1",
    turnId: "turn_1",
    executionAttempt: { id: "execution_1", attemptCount: 4 },
    agentCfg: {} as PipelineCtx["agentCfg"],
    roleConfigs: {} as PipelineCtx["roleConfigs"],
    resumeText: "resume",
    resumeContent: {} as PipelineCtx["resumeContent"],
    defaultResume: { id: "resume_1", name: "Resume", templateId: null, templateOptions: null, directionId: null, basicsDetached: false },
    aiConfig: {} as PipelineCtx["aiConfig"],
    autonomous: false,
    emit: vi.fn(),
    ...overrides,
  }
}

const pkg = {
  job: { id: "job_1", company: "Acme", role: "Engineer", location: "Dublin", url: "https://jobs.example/1", description: "Build software", salary: "€70k" },
  score: 88,
  matchedKeywords: ["TypeScript"],
  missingKeywords: ["Kubernetes"],
  recommendation: "Strong match",
  tailoredResumeId: "resume_tailored_1",
  tailoredResumeName: "Tailored resume",
  tailoredResumeArtifact: { id: "artifact_resume_1", hash: "resume-hash" },
  coverLetterId: "cover_letter_1",
  coverLetter: "Dear Acme",
  coverLetterArtifact: { id: "artifact_cover_1", hash: "cover-hash" },
  artifactReviews: [{ artifactId: "artifact_resume_1", artifactHash: "resume-hash", constraintHash: "constraints", status: "passed" }],
} as unknown as ApplicationPackage

function taskTransaction(taskId = "application_task_1") {
  return {
    applicationTask: {
      upsert: vi.fn().mockResolvedValue({ id: taskId }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ id: taskId }),
    },
    applicationTaskEvent: { create: vi.fn().mockResolvedValue({ id: "task_event_1" }) },
  } as unknown as Prisma.TransactionClient & {
    applicationTask: { upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> }
    applicationTaskEvent: { create: ReturnType<typeof vi.fn> }
  }
}

beforeEach(() => {
  Object.values(mocks).forEach(mock => mock.mockReset())
  mocks.turnFindFirst.mockResolvedValue({ revision: 7, status: "in_progress" })
  mocks.issueLegacyReceipt.mockResolvedValue({ approval: {} })
  mocks.clientReceipt.mockReturnValue({ id: "receipt_1" })
  mocks.hashLegacyValue.mockImplementation(async (_label, value) => `sha256:${JSON.stringify(value) ?? "undefined"}`)
})

describe("Gate review receipt ownership", () => {
  it("binds receipt preparation to the pipeline Turn and exact execution attempt", async () => {
    const pipeline = ctx()

    await createGateReviewReceipt(pipeline, pkg, false)

    expect(mocks.turnFindFirst).toHaveBeenCalledWith({
      where: { id: "turn_1", sessionId: "session_1", userId: "user_1" },
      select: { revision: true, status: true },
    })
    expect(mocks.issueLegacyReceipt).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sessionId: "session_1",
      turnId: "turn_1",
      revision: 7,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      answers: null,
      material: expect.objectContaining({
        job: expect.objectContaining({ id: "job_1", description: "Build software", url: "https://jobs.example/1" }),
        match: expect.objectContaining({ score: 88, matchedKeywords: ["TypeScript"] }),
        resume: expect.objectContaining({
          id: "resume_tailored_1",
          artifact: { id: "artifact_resume_1", hash: "resume-hash" },
          sourceContentHash: `sha256:${JSON.stringify(pipeline.resumeContent)}`,
        }),
        coverLetter: expect.objectContaining({ id: "cover_letter_1", content: "Dear Acme" }),
        artifactReviews: pkg.artifactReviews,
      }),
      projectWait: true,
      prepareInTransaction: expect.any(Function),
    }))
    const receiptInput = mocks.issueLegacyReceipt.mock.calls[0]?.[1]
    expect(receiptInput).not.toHaveProperty("replayMode")
    expect(receiptInput).not.toHaveProperty("scheduledOwnerFence")
  })

  it("creates and links the review task inside the receipt transaction preparation", async () => {
    await createGateReviewReceipt(ctx(), pkg, false)
    const receiptInput = mocks.issueLegacyReceipt.mock.calls[0]?.[1]
    const tx = taskTransaction()

    const prepared = await receiptInput.prepareInTransaction(tx)

    expect(tx.applicationTask.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_jobId: { userId: "user_1", jobId: "job_1" } },
      create: expect.objectContaining({ sessionId: "session_1", status: "waiting_for_user", checkpoint: "materials_ready" }),
    }))
    expect(tx.applicationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sessionId: "session_1" }),
      data: expect.objectContaining({ status: "waiting_for_user", checkpoint: "materials_ready" }),
    }))
    expect(prepared).toMatchObject({
      taskId: "application_task_1",
      payload: { applicationTaskId: "application_task_1", jobId: "job_1" },
      material: expect.objectContaining({
        job: expect.objectContaining({ id: "job_1" }),
        resume: expect.objectContaining({ id: "resume_tailored_1" }),
        coverLetter: expect.objectContaining({ content: "Dear Acme" }),
      }),
    })
    expect(tx.applicationTaskEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ taskId: "application_task_1", type: "materials_ready" }) })
  })

  it("changes the reviewed scope when the source resume content changes", async () => {
    const first = ctx({ resumeContent: { experience: [{ role: "Engineer" }] } as unknown as PipelineCtx["resumeContent"] })
    const second = ctx({ resumeContent: { experience: [{ role: "Senior Engineer" }] } as unknown as PipelineCtx["resumeContent"] })

    await createGateReviewReceipt(first, pkg, false)
    await createGateReviewReceipt(second, pkg, false)

    const firstMaterial = mocks.issueLegacyReceipt.mock.calls[0]?.[1].material
    const secondMaterial = mocks.issueLegacyReceipt.mock.calls[1]?.[1].material
    expect(firstMaterial.resume.sourceContentHash).not.toBe(secondMaterial.resume.sourceContentHash)
  })

  it("uses truthful review wording when the package has no cover letter", async () => {
    const withoutCoverLetter = {
      ...pkg,
      coverLetterId: undefined,
      coverLetter: undefined,
      coverLetterArtifact: undefined,
    } as ApplicationPackage

    await createGateReviewReceipt(ctx(), withoutCoverLetter, false)

    expect(mocks.issueLegacyReceipt.mock.calls[0]?.[1].body).toBe(
      "Review the job and prepared materials. Approval here only unlocks form-fill; it never submits by itself.",
    )
  })

  it("enables deterministic replay only when scheduled TaskGraph ownership is present", async () => {
    const ownerFence = {
      owner: {
        userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_task_1", rootAttemptCount: 2,
        turnLeaseOwnerId: "lease_owner_1", turnLeaseVersion: 5, executionId: "execution_1", executionAttemptCount: 0,
      },
      key: "continuation_key_1",
      claimToken: "claim_token_1",
      assertCurrent: vi.fn(async () => true),
    }
    const pipeline = ctx({
      executionAttempt: { id: "execution_1", attemptCount: 0 },
      scheduledTaskGraphOwnerFence: ownerFence,
    })

    await createGateReviewReceipt(pipeline, pkg, false)

    expect(mocks.issueLegacyReceipt.mock.calls[0]?.[1]).toMatchObject({
      replayMode: "gate-review",
      scheduledOwnerFence: { owner: { rootTaskId: "root_task_1", rootAttemptCount: 2, executionAttemptCount: 0 } },
    })
  })

  it("keeps non-scheduled receipts on independent random tool-call identities", async () => {
    await createGateReviewReceipt(ctx(), pkg, false)
    await createGateReviewReceipt(ctx(), pkg, false)

    const first = mocks.issueLegacyReceipt.mock.calls[0]?.[1]
    const second = mocks.issueLegacyReceipt.mock.calls[1]?.[1]
    expect(first.toolCallId).toMatch(/^application-review:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(second.toolCallId).toMatch(/^application-review:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(second.toolCallId).not.toBe(first.toolCallId)
    expect(first).not.toHaveProperty("replayMode")
    expect(second).not.toHaveProperty("replayMode")
  })

  it("does not create a replacement Turn when the pipeline has no exact Turn", async () => {
    const pipeline = ctx({ turnId: undefined })

    await expect(createGateReviewReceipt(pipeline, pkg, false)).rejects.toMatchObject({ name: "AgentExecutionCancelledError" })
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.issueLegacyReceipt).not.toHaveBeenCalled()
  })

  it("requires the exact execution attempt before preparing a review receipt", async () => {
    const pipeline = ctx({ executionAttempt: undefined })

    await expect(createGateReviewReceipt(pipeline, pkg, false)).rejects.toMatchObject({ name: "AgentExecutionCancelledError" })
    expect(mocks.turnFindFirst).not.toHaveBeenCalled()
    expect(mocks.issueLegacyReceipt).not.toHaveBeenCalled()
  })

  it("rejects a terminal Turn before receipt issuance", async () => {
    mocks.turnFindFirst.mockResolvedValue({ revision: 8, status: "interrupted" })

    await expect(createGateReviewReceipt(ctx(), pkg, false)).rejects.toMatchObject({ name: "AgentExecutionCancelledError" })
    expect(mocks.issueLegacyReceipt).not.toHaveBeenCalled()
  })
})
