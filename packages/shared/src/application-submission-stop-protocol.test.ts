import { describe, expect, it, vi } from "vitest"
import {
  APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
  APPLICATION_SUBMISSION_STOP_STAGES,
  matchesExactApplicationSubmissionStopAttempt,
  parseApplicationSubmissionStopRecord,
  type ApplicationSubmissionStopAttempt,
  type ApplicationSubmissionStopStage,
} from "./application-submission-stop-protocol"

const attempt: ApplicationSubmissionStopAttempt = {
  sessionId: "session_1",
  fillTurnId: "turn_1",
  applicationTaskId: "application_1",
  userId: "user_1",
  jobId: "job_1",
  approvalId: "receipt_1",
  receiptId: "receipt_1",
  constraintHash: "a".repeat(64),
  workerTaskId: "worker_1",
  executionId: "execution_1",
}

function record(stage: ApplicationSubmissionStopStage = "armed") {
  return { schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage, ...attempt }
}

describe("application submission stop protocol", () => {
  it("parses and freezes each supported stage", () => {
    for (const stage of APPLICATION_SUBMISSION_STOP_STAGES) {
      const parsed = parseApplicationSubmissionStopRecord(record(stage))
      expect(parsed).toEqual(record(stage))
      expect(Object.isFrozen(parsed)).toBe(true)
    }
  })

  it.each([
    ["unknown schema", { ...record(), schemaVersion: "agent-harness.v2.other.v1" }],
    ["unknown stage", { ...record(), stage: "dispatched" }],
    ["extra property", { ...record(), actor: "user" }],
    ["missing property", Object.fromEntries(Object.entries(record()).filter(([key]) => key !== "executionId"))],
    ["different receipt identity", { ...record(), receiptId: "receipt_2" }],
    ["uppercase hash", { ...record(), constraintHash: "A".repeat(64) }],
    ["short hash", { ...record(), constraintHash: "a".repeat(63) }],
    ["empty execution", { ...record(), executionId: "" }],
    ["padded execution", { ...record(), executionId: " execution_1" }],
  ])("rejects %s", (_label, value) => {
    expect(parseApplicationSubmissionStopRecord(value)).toBeNull()
  })

  it("rejects inherited, null-prototype, symbol, and accessor properties", () => {
    expect(parseApplicationSubmissionStopRecord(Object.assign(Object.create({ inherited: true }), record()))).toBeNull()
    expect(parseApplicationSubmissionStopRecord(Object.assign(Object.create(null), record()))).toBeNull()
    const symbolRecord = { ...record(), [Symbol("extra")]: true }
    expect(parseApplicationSubmissionStopRecord(symbolRecord)).toBeNull()
    const getter = vi.fn(() => attempt.sessionId)
    const accessorRecord = { ...record() }
    Object.defineProperty(accessorRecord, "sessionId", { enumerable: true, get: getter })
    expect(parseApplicationSubmissionStopRecord(accessorRecord)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })

  it("matches only the exact persisted attempt across stages", () => {
    for (const stage of APPLICATION_SUBMISSION_STOP_STAGES) {
      expect(matchesExactApplicationSubmissionStopAttempt(record(stage), attempt)).toBe(true)
    }
    for (const key of Object.keys(attempt) as (keyof ApplicationSubmissionStopAttempt)[]) {
      const changed = { ...attempt, [key]: key === "constraintHash" ? "b".repeat(64) : `${attempt[key]}_other` }
      expect(matchesExactApplicationSubmissionStopAttempt({ ...record(), ...changed }, attempt)).toBe(false)
    }
    expect(matchesExactApplicationSubmissionStopAttempt({ ...record(), unknown: true }, attempt)).toBe(false)
  })
})
