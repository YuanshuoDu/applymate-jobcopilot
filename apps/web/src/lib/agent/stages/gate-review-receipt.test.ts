import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"

const mocks = vi.hoisted(() => ({ turnFindFirst: vi.fn(), issueLegacyReceipt: vi.fn(), clientReceipt: vi.fn() }))
vi.mock("@/lib/db", () => ({ db: { agentTurn: { findFirst: mocks.turnFindFirst } } }))
vi.mock("../approval/legacy-receipt", () => ({ issueLegacyReceipt: mocks.issueLegacyReceipt, clientReceipt: mocks.clientReceipt }))

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

const pkg = { job: { id: "job_1", company: "Acme", role: "Engineer" }, artifactReviews: [] } as unknown as ApplicationPackage

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
      projectWait: true,
      prepareInTransaction: expect.any(Function),
    }))
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
      material: { applicationTaskId: "application_task_1", jobId: "job_1" },
    })
    expect(tx.applicationTaskEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ taskId: "application_task_1", type: "materials_ready" }) })
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
