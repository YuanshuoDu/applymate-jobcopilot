import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Prisma } from "@prisma/client"
import { AgentExecutionCancelledError } from "../execution-control"
import type { Job } from "@prisma/client"
import { AnalyzeSourceChangedError, createAnalyzeSourceChangedErrorWithClaims, createAnalyzeSourceFingerprint } from "./analyze-model-input"
import { validateAnalyzeRecoverySources } from "./analyze-ownership"
import type { ScoredJob } from "../types"

const mocks = vi.hoisted(() => ({
  applicationTaskUpsert: vi.fn(),
  applicationTaskFindUnique: vi.fn(),
  applicationTaskUpdateMany: vi.fn(),
  executionUpdateMany: vi.fn(),
  transaction: vi.fn(),
  applicationTaskFindMany: vi.fn(),
  sourceFence: vi.fn(),
  jobFindFirst: vi.fn(),
  resumeFindFirst: vi.fn(),
}))

vi.mock("@/lib/db", () => ({ db: { $transaction: mocks.transaction, applicationTask: { findMany: mocks.applicationTaskFindMany } } }))
vi.mock("../source-material-fence", () => ({ acquireSourceMaterialFence: mocks.sourceFence }))

import { ANALYZE_SOURCE_CHANGED_CHECKPOINT, claimAnalyzeTask, cleanupAnalyzeSourceChangedClaims, failAnalyzeClaimsAfterSourceChange, failAnalyzeTaskAfterSourceChange, findAnalyzeSourceChangedJobIds, transitionAnalyzeTask } from "./analyze-ownership"

function transaction() {
  return {
    job: { findFirst: mocks.jobFindFirst },
    resume: { findFirst: mocks.resumeFindFirst },
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
    mocks.applicationTaskFindMany.mockResolvedValue([])
    mocks.sourceFence.mockResolvedValue(undefined)
    mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => work(transaction()))
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
          { status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT },
        ],
        AND: [
          { OR: [
            { sessionId: null }, { sessionId: "session_1" },
            { status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT },
          ] },
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

  it("allows only the exact source-change failure marker to cross sessions", async () => {
    await claimAnalyzeTask(transaction(), {
      userId: "user_1", jobId: "job_1", sessionId: "session_2",
    })

    const claim = mocks.applicationTaskUpdateMany.mock.calls[0]![0]
    expect(claim.where.OR).toContainEqual({ status: "failed", checkpoint: "analyze_source_changed" })
    expect(claim.where.AND[0]).toEqual({ OR: [
      { sessionId: null }, { sessionId: "session_2" },
      { status: "failed", checkpoint: "analyze_source_changed" },
    ] })
    expect(claim.where.AND[0].OR).not.toContainEqual({ status: "failed", checkpoint: "match_analysis_failed" })
  })

  it("loads retry Job IDs only from the tenant's exact source-change marker", async () => {
    mocks.applicationTaskFindMany.mockResolvedValue([{ jobId: "job_1" }])

    await expect(findAnalyzeSourceChangedJobIds("user_1", ["job_1", "job_2"])).resolves.toEqual(new Set(["job_1"]))

    expect(mocks.applicationTaskFindMany).toHaveBeenCalledWith({
      where: { userId: "user_1", jobId: { in: ["job_1", "job_2"] }, status: "failed", checkpoint: "analyze_source_changed" },
      select: { jobId: true },
    })
  })

  it("marks a source-changed claim failed with its exact fence and owner identity", async () => {
    const analysisFenceAt = new Date("2099-01-01T00:00:00.001Z")

    await failAnalyzeTaskAfterSourceChange(transaction(), {
      userId: "user_1", jobId: "job_1", sessionId: "session_1", analysisFenceAt,
      executionAttempt: { id: "execution_1", attemptCount: 4 }, error: "source changed",
    })

    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        userId: "user_1", jobId: "job_1", status: "analyzing", sessionId: "session_1",
        checkpoint: "match_analysis", updatedAt: analysisFenceAt,
      }),
      data: expect.objectContaining({ status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT, error: "source changed" }),
    })
  })

  it("does not overwrite a task whose exact source-change CAS loses to a newer or terminal state", async () => {
    mocks.applicationTaskUpdateMany.mockResolvedValue({ count: 0 })
    const analysisFenceAt = new Date("2099-01-01T00:00:00.001Z")

    await expect(failAnalyzeTaskAfterSourceChange(transaction(), {
      userId: "user_1", jobId: "job_1", sessionId: "session_1", analysisFenceAt, error: "source changed",
    })).resolves.toBe(false)

    expect(mocks.applicationTaskUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userId: "user_1", jobId: "job_1", status: "analyzing",
        sessionId: "session_1", checkpoint: "match_analysis", updatedAt: analysisFenceAt }),
      data: expect.objectContaining({ status: "failed", checkpoint: ANALYZE_SOURCE_CHANGED_CHECKPOINT }),
    }))
  })

  it("checks the scheduled owner before source-change cleanup and stops after ownership loss", async () => {
    const assertOwnerCurrent = vi.fn(async () => false)

    await expect(failAnalyzeClaimsAfterSourceChange({
      claims: [{ jobId: "job_1", analysisFenceAt: new Date("2099-01-01T00:00:00.001Z") }],
      userId: "user_1", sessionId: "session_1", error: "source changed", assertOwnerCurrent,
    })).rejects.toBeInstanceOf(AgentExecutionCancelledError)

    expect(assertOwnerCurrent).toHaveBeenCalledOnce()
    expect(mocks.applicationTaskUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects duplicate or out-of-scope cleanup claims before task writes", async () => {
    const fence = new Date("2099-01-01T00:00:00.001Z")
    await expect(cleanupAnalyzeSourceChangedClaims({
      claims: [{ jobId: "job_1", analysisFenceAt: fence }, { jobId: "job_1", analysisFenceAt: fence }],
      maxClaims: 2, userId: "user_1", sessionId: "session_1", sourceError: new AnalyzeSourceChangedError(),
    })).rejects.toThrow("Analyze source-change claims are invalid.")

    const error = createAnalyzeSourceChangedErrorWithClaims([{ jobId: "job_1", analysisFenceAt: fence.toISOString() }])
    await expect(cleanupAnalyzeSourceChangedClaims({
      claims: [{ jobId: "job_2", analysisFenceAt: fence }], maxClaims: 1,
      userId: "user_1", sessionId: "session_1", sourceError: error,
    })).rejects.toThrow("Analyze source-change claims are invalid.")

    expect(mocks.transaction).not.toHaveBeenCalled()
    expect(mocks.applicationTaskUpdateMany).not.toHaveBeenCalled()
  })

  it("validates restored score inputs before checking the scheduled owner in the same fenced transaction", async () => {
    const sourceJob = { id: "job_1", userId: "user_1", company: "Example", role: "Engineer", location: "Dublin",
      description: "Role description", source: "agent", url: "https://jobs.example/job_1" } as Job
    const content = { summary: "Candidate resume" }, resumeText = "\nSUMMARY:\nCandidate resume", order: string[] = []
    mocks.sourceFence.mockImplementation(async () => { order.push("fence") })
    mocks.resumeFindFirst.mockImplementation(async () => { order.push("resume"); return { id: "resume_1", content } })
    mocks.jobFindFirst.mockImplementation(async () => { order.push("job"); return sourceJob })
    mocks.transaction.mockImplementation((work: (tx: unknown) => Promise<unknown>) => {
      const tx = transaction(); return work(tx)
    })
    const fingerprint = createAnalyzeSourceFingerprint({ userId: "user_1", jobId: sourceJob.id,
      job: sourceJob, resumeId: "resume_1", resumeText })
    const scored = { job: sourceJob, score: 80, matchedKeywords: [], missingKeywords: [], recommendation: "Good fit.",
      analysisFenceAt: "2099-01-01T00:00:00.001Z" } as ScoredJob
    const assertOwnerCurrent = vi.fn(async () => { order.push("owner"); return false })

    await expect(validateAnalyzeRecoverySources({ userId: "user_1", resumeId: "resume_1", resumeText,
      scoredJobs: [scored], sourceFingerprintsByJob: { [sourceJob.id]: fingerprint }, assertOwnerCurrent }))
      .rejects.toBeInstanceOf(AgentExecutionCancelledError)

    expect(order).toEqual(["fence", "resume", "job", "owner"])
    expect(assertOwnerCurrent).toHaveBeenCalledOnce()
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
