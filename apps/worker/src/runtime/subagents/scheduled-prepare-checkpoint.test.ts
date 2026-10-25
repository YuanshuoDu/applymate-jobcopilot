import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION, type ScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { readScheduledPrepareCheckpoint, type ScheduledPrepareCheckpointStage } from "./scheduled-prepare-checkpoint.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
  turnLeaseOwnerId: "turn-owner-1", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 1 }
const automation: ScheduledAutomationSnapshot = { schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION,
  targetRoles: ["Software Engineer"], targetLocations: [], minScore: 50, dailyCap: 1, requireApproval: true, autoApply: false }
const snapshotDigest = "sha256:" + "b".repeat(64), evidenceDigest = "c".repeat(64), handoffKey = "scheduled-taskgraph:sha256:" + "d".repeat(64)
const report = { processed: 1, applied: 0, queued: 0, pending: 0, skipped: 1, failed: 0, durationMs: 9 }

function fixture() {
  const scoredJobs = [{ job: { id: "job-1", userId: owner.userId }, score: 80, matchedKeywords: ["TypeScript"],
    missingKeywords: [], recommendation: "Review" }]
  const projection = { owner: [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
    owner.executionId, owner.executionAttemptCount], snapshotDigest, evidenceDigest, analyzeGraphRevision: 12,
    analysisFailed: 0, scoredJobs: [{ jobId: "job-1", score: 80, matchedKeywords: ["TypeScript"],
      missingKeywords: [], recommendation: "Review" }] }
  const checkpointDigest = createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")
  const binding = { owner, continuationKey: "scheduled-taskgraph:sha256:" + "a".repeat(64), snapshotDigest,
    evidenceDigest, checkpointDigest, analyzeGraphRevision: 12, prepareScheduleRevision: 13 }
  const continuationKey = scheduledTaskGraphStableContinuationKey(binding)!
  const receipt = buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey })!
  const state = { nextStage: "completed", report, analysisFailed: 0, scoutedJobs: [{ id: "job-1", userId: owner.userId }],
    scoredJobs, scheduledTaskGraphContinuation: { schemaVersion: "agent-harness.v2.scheduled-pipeline-continuation.v1",
      key: handoffKey, owner: { ...owner, turnLeaseOwnerId: "completed-root-turn", turnLeaseVersion: 10 },
      snapshotDigest, graphRevision: 12, evidenceDigest } }
  const execution = { id: owner.executionId, status: "completed", attemptCount: owner.executionAttemptCount,
    checkpoint: "completed", state }
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM "agent_executions"') ? [execution] : [] }))
  return { receipt, state, execution, query, checkpointDigest }
}

function read(value: ReturnType<typeof fixture>, stage: ScheduledPrepareCheckpointStage) {
  return readScheduledPrepareCheckpoint({ query: value.query } as never, value.receipt, automation, handoffKey, stage)
}

describe("scheduled Prepare checkpoint reader", () => {
  it("reconstructs the exact completed Audit report checkpoint and eligible set without mutation", async () => {
    const value = fixture(), before = structuredClone(value.state)
    await expect(read(value, "audit_completed_report")).resolves.toEqual({ checkpointDigest: value.checkpointDigest,
      eligibleJobIds: ["job-1"] })
    expect(value.state).toEqual(before)
    expect(value.query).toHaveBeenCalledOnce()
    expect(value.query).toHaveBeenCalledWith(expect.stringContaining('SELECT "id", "status", "attemptCount", "checkpoint", "state"'),
      [owner.executionId, owner.userId, owner.sessionId])
  })

  it.each(["prepare", "gate"] as const)("does not treat completed execution as the historical %s checkpoint", async stage => {
    await expect(read(fixture(), stage)).resolves.toBeNull()
  })

  it("rejects an unknown runtime checkpoint mode", async () => {
    await expect(read(fixture(), "unknown" as never)).resolves.toBeNull()
  })

  it.each(["missing report", "malformed report", "wrong status", "wrong checkpoint", "wrong state stage",
    "wrong execution id", "foreign marker owner", "wrong handoff", "wrong snapshot", "wrong evidence revision"] as const)(
    "rejects a completed checkpoint with %s", async mismatch => {
      const value = fixture(), state = value.state as Record<string, unknown>, marker = state.scheduledTaskGraphContinuation as Record<string, unknown>
      if (mismatch === "missing report") delete state.report
      if (mismatch === "malformed report") state.report = { ...report, extra: true }
      if (mismatch === "wrong status") (value.execution as { status: string }).status = "running"
      if (mismatch === "wrong checkpoint") (value.execution as { checkpoint: string }).checkpoint = "gate"
      if (mismatch === "wrong state stage") state.nextStage = "execute"
      if (mismatch === "wrong execution id") (value.execution as { id: string }).id = "other-execution"
      if (mismatch === "foreign marker owner") marker.owner = { ...(marker.owner as object), rootTaskId: "other-root" }
      if (mismatch === "wrong handoff") marker.key = "scheduled-taskgraph:sha256:" + "e".repeat(64)
      if (mismatch === "wrong snapshot") marker.snapshotDigest = "sha256:" + "f".repeat(64)
      if (mismatch === "wrong evidence revision") marker.graphRevision = 13
      await expect(read(value, "audit_completed_report")).resolves.toBeNull()
    })

  it("recomputes the Analyze digest when persisted scored evidence changes", async () => {
    const value = fixture()
    ;(value.state.scoredJobs[0] as { score: number }).score = 81
    const changed = await read(value, "audit_completed_report")
    expect(changed).toMatchObject({ eligibleJobIds: ["job-1"] })
    expect(changed?.checkpointDigest).not.toBe(value.checkpointDigest)
  })
})
