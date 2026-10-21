import { describe, expect, it } from "vitest"
import type { Job } from "@prisma/client"
import {
  buildScheduledTaskGraphPrepareCheckpoint,
  scheduledAutomationSnapshotDigest,
  scheduledTaskGraphContinuationKey,
  ScheduledTaskGraphCheckpointError,
  type ScheduledTaskGraphPipelineOwner,
} from "./scheduled-taskgraph-pipeline-checkpoint"
import type { AnalyzeOutput, ScoredJob, StageResult } from "./types"

const jobAId = "c" + "1".repeat(24)
const jobBId = "c" + "2".repeat(24)

const owner: ScheduledTaskGraphPipelineOwner = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 3, turnLeaseOwnerId: "lease-owner-1", turnLeaseVersion: 7,
  executionId: "execution-1", executionAttemptCount: 5,
}

const snapshot = {
  schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
  targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], minScore: 70,
  dailyCap: 5, requireApproval: true, autoApply: false,
}

function attestation(candidateJobIds: string[] = [jobAId, jobBId], evidenceOwner = owner) {
  return {
    schemaVersion: "agent-harness.v2.scheduled-pipeline-attestation.v1",
    owner: { userId: evidenceOwner.userId, sessionId: evidenceOwner.sessionId, turnId: evidenceOwner.turnId, rootTaskId: evidenceOwner.rootTaskId,
      rootAttemptCount: evidenceOwner.rootAttemptCount, turnLeaseOwnerId: evidenceOwner.turnLeaseOwnerId, turnLeaseVersion: evidenceOwner.turnLeaseVersion },
    snapshotDigest: scheduledAutomationSnapshotDigest(snapshot), graphRevision: 9,
    scout: {
      taskId: "scout-task", attemptCount: 2, status: "completed", verification: "passed", resultDigest: "a".repeat(64),
      candidateJobIds,
      discoveryReceipt: {
        status: "complete", taskId: "scout-task", attemptCount: 2, completedCalls: 1,
        candidateCount: candidateJobIds.length, providerFailures: 0, materializationFailures: 0,
        hasMore: false, receiptDigest: "b".repeat(64),
      },
    },
    analyst: {
      taskId: "analyst-task", attemptCount: 1, status: "completed", verification: "passed", resultDigest: "c".repeat(64),
      dependsOnTaskIds: ["scout-task"], jobIds: [...candidateJobIds].reverse(),
    },
    evidenceDigest: "d".repeat(64),
  }
}

function job(id: string, userId = owner.userId): Job {
  return { id, userId } as unknown as Job
}

function scored(jobRow: Job, score: number, analysisFenceAt: string | null = "2026-10-19T12:00:00.123Z"): ScoredJob {
  return {
    job: jobRow, score, matchedKeywords: ["TypeScript"], missingKeywords: ["Kubernetes"],
    recommendation: "Apply after tailoring the CV.", ...(typeof analysisFenceAt === "string" ? { analysisFenceAt } : {}),
  }
}

function analyzeResult(rows: readonly Job[], overrides: Partial<AnalyzeOutput> = {}): StageResult<AnalyzeOutput> {
  return {
    stage: "analyze", ok: true,
    data: { scoredJobs: rows.map((row, index) => scored(row, index === 0 ? 87 : 73)), failed: 0, ...overrides },
    metrics: { durationMs: 1, count: rows.length },
  }
}

function build(overrides: Record<string, unknown> = {}) {
  const rows = [job(jobAId), job(jobBId)]
  return buildScheduledTaskGraphPrepareCheckpoint({
    owner, snapshot, attestation: attestation(), ownedJobs: rows, analyzeResult: analyzeResult(rows), ...overrides,
  } as Parameters<typeof buildScheduledTaskGraphPrepareCheckpoint>[0])
}

function expectBlocked(action: () => unknown, reason: string) {
  try { action(); throw new Error("expected checkpoint rejection") }
  catch (error) {
    expect(error).toBeInstanceOf(ScheduledTaskGraphCheckpointError)
    expect(error).toMatchObject({ reason, code: "scheduled_taskgraph_checkpoint_blocked" })
  }
}

describe("buildScheduledTaskGraphPrepareCheckpoint", () => {
  it("builds a Prepare checkpoint from owner-scoped Jobs and the real 0–100 scorer output", () => {
    const rows = [job(jobAId), job(jobBId)]
    const result = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: attestation(), ownedJobs: rows, analyzeResult: analyzeResult(rows) })

    expect(result.checkpoint.nextStage).toBe("prepare")
    expect(result.checkpoint.scoutedJobs).toEqual(rows.map(row => ({ ...row, coverLetter: null })))
    expect(result.checkpoint.scoredJobs?.map(item => item.score)).toEqual([73, 87])
    expect(result.checkpoint.scoredJobs?.[0]).toMatchObject({
      job: { ...rows[1], coverLetter: null }, matchedKeywords: ["TypeScript"], missingKeywords: ["Kubernetes"],
      recommendation: "Apply after tailoring the CV.", analysisFenceAt: "2026-10-19T12:00:00.123Z",
    })
    expect(result.checkpoint.scheduledTaskGraphContinuation).toMatchObject({
      schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1", evidenceDigest: "d".repeat(64), graphRevision: 9,
    })
    expect(result.continuationKey).toMatch(/^scheduled-taskgraph:sha256:[a-f0-9]{64}$/)
    expect(result.alreadyPersisted).toBe(false)
  })

  it("does not serialize deprecated Job cover-letter bodies in the initial checkpoint", () => {
    const sentinel = "legacy-cover-letter-body-must-not-persist"
    const rows = [job(jobAId), job(jobBId)].map(row => ({ ...row, coverLetter: sentinel })) as Job[]
    const result = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: attestation(),
      ownedJobs: rows, analyzeResult: analyzeResult(rows) })

    expect(result.checkpoint.scoutedJobs?.map(row => [row.id, row.coverLetter])).toEqual(rows.map(row => [row.id, null]))
    expect(result.checkpoint.scoredJobs?.map(row => [row.job.id, row.job.coverLetter])).toEqual(rows.slice().reverse().map(row => [row.id, null]))
    expect(JSON.stringify(result.checkpoint)).not.toContain(sentinel)
  })

  it("keeps the continuation key stable across leases and fences a different execution attempt", () => {
    const first = build()
    expect(build().continuationKey).toBe(first.continuationKey)
    const nextExecution = { ...owner, executionAttemptCount: 6 }
    expect(build({ owner: nextExecution, attestation: attestation(undefined, nextExecution) }).continuationKey).not.toBe(first.continuationKey)
    expect(scheduledTaskGraphContinuationKey(owner, attestation())).toBe(first.continuationKey)
    const nextLease = { ...owner, turnLeaseOwnerId: "lease-owner-2", turnLeaseVersion: 8 }
    expect(scheduledTaskGraphContinuationKey(nextLease, attestation())).toBe(first.continuationKey)
    expect(build({ owner: nextLease, attestation: attestation() }).continuationKey).toBe(first.continuationKey)
    expect(build({ owner: nextLease, attestation: attestation(undefined, nextLease), existingCheckpoint: first.checkpoint }))
      .toMatchObject({ continuationKey: first.continuationKey, alreadyPersisted: true })
  })

  it("accepts Prisma's initial zero execution attempt and persists that exact owner", () => {
    const initialOwner = { ...owner, executionAttemptCount: 0 }
    const result = build({ owner: initialOwner })
    expect(result.checkpoint.scheduledTaskGraphContinuation.owner).toEqual(initialOwner)
    expect(build({ owner: initialOwner, existingCheckpoint: result.checkpoint }).alreadyPersisted).toBe(true)
  })

  it("returns the persisted checkpoint before requiring another score run", () => {
    const first = build()
    const rows = [job(jobAId), job(jobBId)]
    const result = buildScheduledTaskGraphPrepareCheckpoint({
      owner, snapshot, attestation: attestation(), ownedJobs: rows, existingCheckpoint: first.checkpoint,
    })
    expect(result).toMatchObject({ checkpoint: first.checkpoint, continuationKey: first.continuationKey, alreadyPersisted: true })
    expect(result.checkpoint.scoutedJobs).toEqual(rows.map(row => ({ ...row, coverLetter: null })))
    expect(result.checkpoint.scoredJobs?.every(item => rows.some(row => row.id === item.job.id) && item.job.coverLetter === null)).toBe(true)
  })

  it("fails closed when a nonempty attestation has empty persisted candidate and score arrays", () => {
    const first = build()
    const empty = { ...first.checkpoint, scoutedJobs: [], scoredJobs: [], analysisFailed: 0 }
    expectBlocked(() => build({ existingCheckpoint: empty }), "jobs_mismatch")
  })

  it("rebuilds a persisted checkpoint with fresh owner-scoped Job objects", () => {
    const first = build()
    const fresh = [job(jobAId), job(jobBId)]
    const validPersisted = JSON.parse(JSON.stringify(first.checkpoint)) as Record<string, unknown>
    const result = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: attestation(), ownedJobs: fresh,
      existingCheckpoint: validPersisted })

    expect(result.checkpoint.scoutedJobs?.[0]).toMatchObject({ id: fresh[0]?.id, coverLetter: null })
    expect(result.checkpoint.scoredJobs?.every(item => fresh.some(job => job.id === item.job.id) && item.job.coverLetter === null)).toBe(true)
    expect(result.checkpoint.scoredJobs?.every(item => item.score >= 0 && item.score <= 100 && item.analysisFenceAt)).toBe(true)
  })

  it("strips legacy cover-letter bodies while replaying a persisted checkpoint", () => {
    const sentinel = "legacy-cover-letter-replay-body-must-not-persist"
    const originalRows = [job(jobAId), job(jobBId)]
    const first = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: attestation(),
      ownedJobs: originalRows, analyzeResult: analyzeResult(originalRows) })
    const persisted = JSON.parse(JSON.stringify(first.checkpoint)) as Record<string, unknown>
    const savedJobs = persisted.scoutedJobs as Array<Record<string, unknown>>
    const savedScores = persisted.scoredJobs as Array<Record<string, unknown>>
    savedJobs[0] = { ...savedJobs[0], coverLetter: sentinel }
    savedScores[0] = { ...savedScores[0], job: { ...(savedScores[0]?.job as Record<string, unknown>), coverLetter: sentinel } }
    const freshRows = originalRows.map(row => ({ ...row, coverLetter: sentinel })) as Job[]
    const replay = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: attestation(),
      ownedJobs: freshRows, existingCheckpoint: persisted })

    expect(replay.checkpoint.scoutedJobs?.map(row => row.coverLetter)).toEqual([null, null])
    expect(replay.checkpoint.scoredJobs?.every(row => row.job.coverLetter === null)).toBe(true)
    expect(JSON.stringify(replay.checkpoint)).not.toContain(sentinel)
  })

  it.each([
    ["score outside 0–100", { score: 101 }],
    ["missing analysis fence", { analysisFenceAt: undefined }],
    ["failure count beyond candidate total", { analysisFailed: 1 }],
  ])("rejects a persisted checkpoint with %s", (_label, patch) => {
    const first = build()
    const invalid = JSON.parse(JSON.stringify(first.checkpoint)) as Record<string, unknown>
    if ("analysisFailed" in patch) invalid.analysisFailed = 3
    else {
      const scores = invalid.scoredJobs as Array<Record<string, unknown>>
      if ("analysisFenceAt" in patch && patch.analysisFenceAt === undefined) {
        scores[0] = { ...scores[0] }
        delete scores[0].analysisFenceAt
      } else scores[0] = { ...scores[0], ...patch }
    }
    expectBlocked(() => build({ existingCheckpoint: invalid }), "analysis_invalid")
  })

  it("rejects a persisted checkpoint created from different evidence", () => {
    const first = build()
    const changed = attestation()
    changed.evidenceDigest = "e".repeat(64)
    expectBlocked(() => buildScheduledTaskGraphPrepareCheckpoint({
      owner, snapshot, attestation: changed, ownedJobs: [job(jobAId), job(jobBId)], existingCheckpoint: first.checkpoint,
    }), "checkpoint_conflict")
  })

  it("preserves a persisted pre-analysis claim when replacing the checkpoint", () => {
    const claim = { key: "claim-1", owner }
    const result = build({ existingCheckpoint: { nextStage: "scout", scheduledTaskGraphClaim: claim } })
    expect(result.checkpoint).toMatchObject({ scheduledTaskGraphClaim: claim })
  })

  it("accepts a trusted completed zero-result receipt without inventing a Job or scoring call", () => {
    const zero = attestation([])
    const result = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: zero, ownedJobs: [] })
    expect(result.checkpoint).toMatchObject({ nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0 })
  })

  it("replays a valid persisted zero-result checkpoint", () => {
    const zero = attestation([])
    const first = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: zero, ownedJobs: [] })
    const replay = buildScheduledTaskGraphPrepareCheckpoint({ owner, snapshot, attestation: zero,
      ownedJobs: [], existingCheckpoint: first.checkpoint })
    expect(replay).toMatchObject({ alreadyPersisted: true, continuationKey: first.continuationKey,
      checkpoint: { nextStage: "prepare", scoutedJobs: [], scoredJobs: [], analysisFailed: 0 } })
  })

  it.each([
    ["provider failure", { providerFailures: 1 }],
    ["materialization failure", { materializationFailures: 1 }],
    ["incomplete pagination", { hasMore: true }],
    ["no completed search call", { completedCalls: 0 }],
    ["candidate count mismatch", { candidateCount: 1 }],
    ["wrong task binding", { taskId: "another-scout" }],
    ["wrong attempt binding", { attemptCount: 1 }],
  ])("rejects a discovery receipt with %s", (_label, receiptPatch) => {
    const invalid = attestation() as ReturnType<typeof attestation> & { scout: { discoveryReceipt: Record<string, unknown> } }
    invalid.scout.discoveryReceipt = { ...invalid.scout.discoveryReceipt, ...receiptPatch }
    expectBlocked(() => build({ attestation: invalid }), "discovery_incomplete")
  })

  it("rejects missing, foreign, duplicate, or extra Job rows", () => {
    const rows = [job(jobAId), job(jobBId)]
    for (const ownedJobs of [[rows[0]], [rows[0], job(jobBId, "other-user")], [rows[0], rows[0]], [rows[0], rows[1], job("c" + "3".repeat(24))]]) {
      expectBlocked(() => build({ ownedJobs }), "jobs_mismatch")
    }
  })

  it("requires the exact same Job object that the authoritative scorer received", () => {
    const rows = [job(jobAId), job(jobBId)]
    const analyzed = analyzeResult(rows)
    analyzed.data!.scoredJobs[0] = scored({ ...rows[0] } as Job, 87)
    expectBlocked(() => build({ ownedJobs: rows, analyzeResult: analyzed }), "analysis_invalid")
  })

  it.each([
    ["score outside legacy range", (rows: Job[]) => analyzeResult(rows, { scoredJobs: [scored(rows[0]!, 101)] })],
    ["missing real analysis fence", (rows: Job[]) => analyzeResult(rows, { scoredJobs: [scored(rows[0]!, 87, null)] })],
    ["failed analyze stage", (rows: Job[]) => ({ ...analyzeResult(rows), ok: false })],
    ["no successful scores", (rows: Job[]) => analyzeResult(rows, { scoredJobs: [], failed: rows.length })],
  ])("rejects %s", (_label, makeResult) => {
    const rows = [job(jobAId), job(jobBId)]
    expectBlocked(() => build({ ownedJobs: rows, analyzeResult: makeResult(rows) }), "analysis_invalid")
  })

  it("rejects incomplete or malformed typed evidence", () => {
    const invalid = attestation() as Record<string, unknown>
    invalid.unexpected = "extra"
    expectBlocked(() => build({ attestation: invalid }), "invalid_attestation")

    const missingProof = attestation() as ReturnType<typeof attestation> & { analyst: { verification: string } }
    missingProof.analyst.verification = "unverified"
    expectBlocked(() => build({ attestation: missingProof }), "invalid_attestation")

    const wrongDependency = attestation() as ReturnType<typeof attestation> & { analyst: { dependsOnTaskIds: string[] } }
    wrongDependency.analyst.dependsOnTaskIds = ["wrong-task"]
    expectBlocked(() => build({ attestation: wrongDependency }), "invalid_attestation")

    const foreignAnalystJob = attestation() as ReturnType<typeof attestation> & { analyst: { jobIds: string[] } }
    foreignAnalystJob.analyst.jobIds = ["c" + "9".repeat(24)]
    expectBlocked(() => build({ attestation: foreignAnalystJob }), "invalid_attestation")
  })

  it("rejects owner, pinned-snapshot, and checkpoint-stage mismatches", () => {
    expectBlocked(() => build({ owner: { ...owner, rootAttemptCount: 4 } }), "owner_mismatch")
    expect(build({ attestation: attestation(undefined, { ...owner, turnLeaseVersion: 6 }) }).continuationKey).toBe(build().continuationKey)
    expectBlocked(() => build({ attestation: attestation(undefined, { ...owner, rootAttemptCount: 4 }) }), "owner_mismatch")
    expectBlocked(() => build({ snapshot: { ...snapshot, minScore: 71 } }), "snapshot_mismatch")
    expectBlocked(() => build({ existingCheckpoint: { nextStage: "gate" } }), "checkpoint_conflict")
  })

  it("rejects a zero-result receipt that claims a nonzero or incomplete search", () => {
    const zero = attestation([])
    zero.scout.discoveryReceipt.candidateCount = 1
    expectBlocked(() => build({ attestation: zero, ownedJobs: [] }), "discovery_incomplete")
  })

  it("rejects a noncanonical snapshot envelope", () => {
    expect(() => scheduledAutomationSnapshotDigest({ ...snapshot, injected: true }))
      .toThrowError(ScheduledTaskGraphCheckpointError)
  })
})
