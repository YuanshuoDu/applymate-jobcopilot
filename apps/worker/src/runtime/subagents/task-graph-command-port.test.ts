import { describe, expect, it } from "vitest"

import { TaskGraphCommandError, parseTaskGraphVerificationReport } from "./task-graph-command-port.js"

describe("TaskGraphCommandError", () => {
  it("exposes a stable name, code, message, and optional current revision", () => {
    const error = new TaskGraphCommandError("revision_mismatch", "TaskGraph revision is stale", 7)

    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: "TaskGraphCommandError",
      code: "revision_mismatch",
      message: "TaskGraph revision is stale",
      currentRevision: 7,
    })
  })

  it("leaves currentRevision undefined when the error has no current graph revision", () => {
    const error = new TaskGraphCommandError("idempotency_conflict", "Proposal key was already used")

    expect(error.name).toBe("TaskGraphCommandError")
    expect(error.code).toBe("idempotency_conflict")
    expect(error.currentRevision).toBeUndefined()
  })
})

describe("TaskGraph verification public report reader", () => {
  it("strips private dependency bindings while preserving the legacy six-field report", () => {
    const digest = "a".repeat(64)
    const publicReport = {
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1",
      status: "passed",
      reasonCode: "criteria_met",
      criteria: [{ criterionId: "from-scout", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: digest,
      resultDigest: digest,
    }
    const report = parseTaskGraphVerificationReport({
      ...publicReport,
      dependencyBindings: [{
        nodeKey: "scout-a", taskId: "task-scout-a", attemptCount: 2,
        nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest,
      }],
    }, ["from-scout"])

    expect(report).toEqual(publicReport)
    expect(Object.keys(report!).sort()).toEqual([
      "criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion",
    ])
  })
})
