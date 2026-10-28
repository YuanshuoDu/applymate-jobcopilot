import { describe, expect, it } from "vitest"
import {
  parseScheduledAuditRegistrationReceipt,
  parseScheduledAuditReport,
  parseScheduledAuditTaskEnvelope,
  SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA,
  type ScheduledAuditReport,
} from "./scheduled-audit-contract.js"

const report: ScheduledAuditReport = { processed: 3, applied: 0, queued: 1, pending: 1, skipped: 1, failed: 0, durationMs: 42 }
const envelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
  taskGraphVerificationReport: null, structuredResult: report }
const registration = {
  schemaVersion: SCHEDULED_AUDIT_REGISTRATION_RECEIPT_SCHEMA,
  owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
    executionId: "execution-1", executionAttemptCount: 3 },
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
  snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
  analyzeGraphRevision: 7, prepareScheduleRevision: 8, prepareWaitId: "prepare-wait", gateTaskId: "gate-task",
  gateAttemptCount: 1, gateResultDigest: `sha256:${"e".repeat(64)}`, gateCompletedEventRevision: 12,
  gateProofDigest: `sha256:${"f".repeat(64)}`, scheduledWaitId: null, auditTaskId: "audit-task", gateGraphRevision: 12,
  auditAppendRevision: 13, expectedAttemptCount: 1,
}

describe("scheduled Audit fixed contract", () => {
  it("accepts only the exact seven non-negative safe-integer report fields", () => {
    expect(parseScheduledAuditReport(report)).toEqual(report)
    for (const bad of [
      { ...report, extra: 1 }, { ...report, failed: undefined }, { ...report, applied: -1 },
      { ...report, queued: Number.MAX_SAFE_INTEGER + 1 }, { ...report, pending: "1" },
      { ...report, durationMs: Infinity }, Object.assign(Object.create({ inherited: 1 }), report),
    ]) expect(parseScheduledAuditReport(bad)).toBeNull()
  })

  it("accepts only the fixed completed no-step, no-tool envelope", () => {
    expect(parseScheduledAuditTaskEnvelope(envelope, "completed")).toMatchObject({ structuredResult: report })
    expect(parseScheduledAuditTaskEnvelope(envelope, "failed")).toBeNull()
    expect(parseScheduledAuditTaskEnvelope({ ...envelope, toolCallCount: 1 }, "completed")).toBeNull()
    expect(parseScheduledAuditTaskEnvelope({ ...envelope, modelName: "unexpected" }, "completed")).toBeNull()
    expect(parseScheduledAuditTaskEnvelope({ ...envelope, structuredResult: { ...report, warning: "x" } }, "completed")).toBeNull()
  })

  it("parses the exact owner and Gate-to-Audit registration binding", () => {
    expect(parseScheduledAuditRegistrationReceipt(registration)).toMatchObject({ auditTaskId: "audit-task", auditAppendRevision: 13 })
    expect(parseScheduledAuditRegistrationReceipt({ ...registration, continuationKey: `scheduled-taskgraph:v2:sha256:${"a".repeat(64)}` }))
      .toMatchObject({ auditTaskId: "audit-task" })
    expect(parseScheduledAuditRegistrationReceipt({ ...registration, auditAppendRevision: 12 })).toBeNull()
    expect(parseScheduledAuditRegistrationReceipt({ ...registration, continuationKey: `${registration.continuationKey}\n` })).toBeNull()
    expect(parseScheduledAuditRegistrationReceipt({ ...registration, owner: { ...registration.owner, extra: true } })).toBeNull()
    expect(parseScheduledAuditRegistrationReceipt({ ...registration, expectedAttemptCount: 2 })).toBeNull()
  })
})
