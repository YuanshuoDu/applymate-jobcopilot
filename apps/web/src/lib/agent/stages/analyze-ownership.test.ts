import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"
import { AgentExecutionCancelledError } from "../execution-control"

const mocks = vi.hoisted(() => ({
  applicationTaskUpsert: vi.fn(),
  applicationTaskFindUnique: vi.fn(),
  applicationTaskUpdateMany: vi.fn(),
  executionUpdateMany: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: {} }))

import { claimAnalyzeTask, transitionAnalyzeTask } from "./analyze-ownership"

function transaction() {
  return {
    applicationTask: {
      upsert: mocks.applicationTaskUpsert,
      findUnique: mocks.applicationTaskFindUnique,
      updateMany: mocks.applicationTaskUpdateMany,
    },
    agentExecution: { updateMany: mocks.executionUpdateMany },
  } as unknown as Prisma.TransactionClient
}

describe("Analyze task ownership", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.applicationTaskUpsert.mockResolvedValue({ id: "task_1" })
    mocks.applicationTaskFindUnique.mockResolvedValue({ updatedAt: new Date("2099-01-01T00:00:00.000Z") })
    mocks.applicationTaskUpdateMany.mockResolvedValue({ count: 1 })
    mocks.executionUpdateMany.mockResolvedValue({ count: 1 })
  })

  it("claims with an exact version token, allowed retry state, session fence, and protected checkpoints", async () => {
    const tx = transaction()
    const storedVersion = new Date("2099-01-01T00:00:00.000Z")
    const fenceAt = new Date(storedVersion.getTime() + 1)
    mocks.applicationTaskFindUnique.mockResolvedValue({ updatedAt: storedVersion })

    const result = await claimAnalyzeTask(tx, {
      userId: "user_1",
      jobId: "job_1",
      sessionId: "session_1",
      executionAttempt: { id: "execution_1", attemptCount: 4 },
    })

    expect(result).toEqual(fenceAt)
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", status: "running", attemptCount: 4 },
      data: { updatedAt: expect.any(Date) },
    })
    expect(mocks.applicationTaskUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId_jobId: { userId: "user_1", jobId: "job_1" } },
      create: { userId: "user_1", jobId: "job_1", sessionId: "session_1", status: "analyzing", checkpoint: "match_analysis" },
      update: {},
    }))
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        jobId: "job_1",
        updatedAt: storedVersion,
        OR: [
          { status: { in: ["discovered", "analyzing"] } },
          { status: "failed", checkpoint: "match_analysis_failed" },
        ],
        AND: [
          { OR: [{ sessionId: null }, { sessionId: "session_1" }] },
          { OR: [
            { checkpoint: null },
            { checkpoint: { notIn: ["submission_request_started", "submission_uncertain", "turn_stopped_before_submit"] } },
          ] },
        ],
      },
      data: {
        sessionId: "session_1",
        status: "analyzing",
        checkpoint: "match_analysis",
        error: null,
        completedAt: null,
        updatedAt: fenceAt,
      },
    })
  })

  it("returns null without claiming when the execution attempt has been reclaimed", async () => {
    mocks.executionUpdateMany.mockResolvedValue({ count: 0 })

    const result = await claimAnalyzeTask(transaction(), {
      userId: "user_1",
      jobId: "job_1",
      executionAttempt: { id: "execution_1", attemptCount: 3 },
    })

    expect(result).toBeNull()
    expect(mocks.applicationTaskUpsert).not.toHaveBeenCalled()
    expect(mocks.applicationTaskFindUnique).not.toHaveBeenCalled()
    expect(mocks.applicationTaskUpdateMany).not.toHaveBeenCalled()
  })

  it("uses the same task token for guarded transitions and returns false when the claim is lost", async () => {
    mocks.applicationTaskUpdateMany.mockResolvedValue({ count: 0 })
    const tx = transaction()
    const analysisFenceAt = new Date("2099-01-01T00:00:00.001Z")
    const data = { status: "skipped" as const, checkpoint: "job_preflight_failed", error: "blocked", completedAt: new Date() }

    const result = await transitionAnalyzeTask(tx, {
      userId: "user_1",
      jobId: "job_1",
      sessionId: "session_1",
      analysisFenceAt,
      executionAttempt: { id: "execution_1", attemptCount: 4 },
      data,
    })

    expect(result).toBe(false)
    expect(mocks.executionUpdateMany).toHaveBeenCalledWith({
      where: { id: "execution_1", userId: "user_1", status: "running", attemptCount: 4 },
      data: { updatedAt: expect.any(Date) },
    })
    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        jobId: "job_1",
        status: "analyzing",
        sessionId: "session_1",
        checkpoint: "match_analysis",
        updatedAt: analysisFenceAt,
        OR: [
          { checkpoint: null },
          { checkpoint: { notIn: ["submission_request_started", "submission_uncertain", "turn_stopped_before_submit"] } },
        ],
      },
      data,
    })
  })

  it("returns false without transitioning when the execution attempt has been reclaimed", async () => {
    mocks.executionUpdateMany.mockResolvedValue({ count: 0 })

    const result = await transitionAnalyzeTask(transaction(), {
      userId: "user_1",
      jobId: "job_1",
      analysisFenceAt: new Date("2099-01-01T00:00:00.001Z"),
      executionAttempt: { id: "execution_1", attemptCount: 3 },
      data: { status: "failed", checkpoint: "match_analysis_failed", error: "failed", completedAt: new Date() },
    })

    expect(result).toBe(false)
    expect(mocks.executionUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.applicationTaskUpdateMany).not.toHaveBeenCalled()
  })

  it("throws cancellation after an awaited task write so the surrounding transaction can roll back", async () => {
    const controller = new AbortController()
    mocks.applicationTaskUpdateMany.mockImplementation(async () => {
      controller.abort()
      return { count: 1 }
    })

    await expect(transitionAnalyzeTask(transaction(), {
      userId: "user_1",
      jobId: "job_1",
      analysisFenceAt: new Date("2099-01-01T00:00:00.001Z"),
      signal: controller.signal,
      data: { status: "failed", checkpoint: "match_analysis_failed", error: "failed", completedAt: new Date() },
    })).rejects.toBeInstanceOf(AgentExecutionCancelledError)
  })
})
