import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { AgentTurnWakeupPayload } from "./types.js"

const lineage = vi.hoisted(() => ({ read: vi.fn(), verify: vi.fn() }))
vi.mock("../subagents/canonical-turn-scheduled-pipeline-context.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../subagents/canonical-turn-scheduled-pipeline-context.js")>(),
  readMaterialDriftRecoveryIntent: lineage.read,
  verifyMaterialDriftRecoveryLineage: lineage.verify,
}))

import { MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, scheduledAutomationSnapshotDigest, type MaterialDriftRecoveryIntent } from "../subagents/canonical-turn-scheduled-pipeline-context.js"
import { resumeWakeupInTransaction } from "./material-drift-wakeup.js"

const wakeup: AgentTurnWakeupPayload = {
  eventId: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:q1",
  waitKind: "question", waitId: "q1", toolCallId: "call_1", status: "answered", nextTurnRevision: 6,
}
const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["engineer"], targetLocations: ["Dublin"],
  minScore: 70, dailyCap: 8, requireApproval: true, autoApply: false }
const intent: MaterialDriftRecoveryIntent = {
  schemaVersion: MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, turnId: "turn_1", userId: "user_1", sessionId: "session_1", automationId: "automation_1",
  previousTurnId: "old_turn", previousExecutionId: "old_execution", previousRecoveryTurnId: "prior_recovery",
  previousGateTaskId: "old_gate", previousGateAttemptCount: 3, previousRootTaskId: "old_root", previousRootAttemptCount: 2,
  previousTurnLeaseVersion: 5, previousExecutionAttemptCount: 7, reservedExecutionAttemptCount: 9,
  currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshot)!, sourceMarker: {
    schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1", reason: "scheduled_prepare_material_source_changed",
    owner: { userId: "user_1", sessionId: "session_1", turnId: "old_turn", rootTaskId: "old_root", rootAttemptCount: 2,
      turnLeaseOwnerId: "old_worker", turnLeaseVersion: 5, executionId: "old_execution", executionAttemptCount: 7 },
    gate: { taskId: "old_gate", leaseOwnerId: "old_gate_worker", attemptCount: 3 },
    analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`, prepareProofDigest: `sha256:${"b".repeat(64)}`,
    artifactDigest: `sha256:${"c".repeat(64)}`, currentMaterialDigest: `sha256:${"d".repeat(64)}`, proofDigest: `sha256:${"e".repeat(64)}`,
  },
}

function client(input: unknown = { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot, materialDriftRecovery: intent }, hasLiveLease = true) {
  const calls: string[] = []
  const turn = {
    id: wakeup.turnId, sessionId: wakeup.sessionId, userId: "user_1", status: "waiting_for_user", revision: 6,
    source: "automation", executionMode: "canonical_task_graph", input, rootTaskId: "root_1", hasLiveLease,
  }
  const event = { sessionId: wakeup.sessionId, turnId: wakeup.turnId, itemId: wakeup.itemId, type: "turn.wakeup", payload: {
    waitKind: wakeup.waitKind, waitId: wakeup.waitId, itemId: wakeup.itemId, turnId: wakeup.turnId,
    toolCallId: wakeup.toolCallId, status: wakeup.status, nextTurnRevision: wakeup.nextTurnRevision,
  } }
  const query = vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('FROM "agent_sessions" WHERE')) return { rows: [{ userId: "user_1", status: "running" }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [turn], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) return { rows: [event], rowCount: 1 }
    if (sql.includes('FROM "agent_items"')) return { rows: [{ status: "completed", taskId: "root_1", content: {
      waitKind: "question", questionId: "q1", toolCallId: "call_1", answerAvailable: true, answer: "continue",
    } }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as unknown as pg.PoolClient, calls }
}

describe("material-drift wakeup authority", () => {
  it("defers a verified manual recovery answer while its canonical Turn still owns the live lease", async () => {
    lineage.read.mockReturnValue({ status: "valid", intent })
    lineage.verify.mockResolvedValue(true)
    const fake = client()

    await expect(resumeWakeupInTransaction(fake.client, wakeup)).resolves.toMatchObject({ status: "deferred" })
    expect(lineage.verify).toHaveBeenCalledOnce()
    expect(fake.calls.some(sql => sql.startsWith("UPDATE") || sql.startsWith("INSERT"))).toBe(false)
  })

  it("fails closed for a forged recovery marker before checking or resuming the wait", async () => {
    lineage.read.mockReturnValue({ status: "invalid" })
    lineage.verify.mockReset()
    const fake = client()

    await expect(resumeWakeupInTransaction(fake.client, wakeup)).rejects.toMatchObject({ code: "material_drift_recovery_invalid" })
    expect(lineage.verify).not.toHaveBeenCalled()
    expect(fake.calls.some(sql => sql.startsWith("UPDATE") || sql.startsWith("INSERT"))).toBe(false)
  })

  it("does not resume when the saved recovery intent no longer matches its source lineage", async () => {
    lineage.read.mockReturnValue({ status: "valid", intent })
    lineage.verify.mockResolvedValue(false)
    const fake = client()

    await expect(resumeWakeupInTransaction(fake.client, wakeup)).rejects.toMatchObject({ code: "material_drift_recovery_lineage_mismatch" })
    expect(fake.calls.some(sql => sql.startsWith("UPDATE") || sql.startsWith("INSERT"))).toBe(false)
  })
})
