import { describe, expect, it } from "vitest"

import { TaskGraphCommandError, parseRegisteredScoutEnvelope, parseTaskGraphVerificationReport, taskGraphNodeKeysMatch } from "./task-graph-command-port.js"

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

describe("registered Scout template envelope", () => {
  const envelope = {
    role: "scout", taskType: "research",
    expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" },
    allowedActions: ["jobs.search"],
  }

  it("parses bounded exact envelopes including explicit empty action sets", () => {
    expect(parseRegisteredScoutEnvelope(envelope)).toEqual(envelope)
    expect(parseRegisteredScoutEnvelope({ ...envelope, allowedActions: [] })).toEqual({ ...envelope, allowedActions: [] })
  })

  it("rejects malformed, sparse, oversized, or unbounded registered envelopes", () => {
    const sparseActions = new Array<string>(1)
    const invalid = [
      { ...envelope, extra: true },
      { ...envelope, taskType: " " },
      { ...envelope, expectedOutputSchema: { ...envelope.expectedOutputSchema, role: "analyst" } },
      { ...envelope, allowedActions: [" "] },
      { ...envelope, allowedActions: sparseActions },
      { ...envelope, allowedActions: Array.from({ length: 33 }, () => "jobs.search") },
    ]
    for (const value of invalid) expect(parseRegisteredScoutEnvelope(value)).toBeUndefined()
  })

  it("allows only the exact node shape with the optional persisted envelope", () => {
    const node = {
      key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"],
      dependsOn: [], depth: 1, taskId: "task-scout",
    }
    const keys = "dependsOn,depth,goal,key,successCriteria,taskId,templateId"
    expect(taskGraphNodeKeysMatch(node, keys)).toBe(true)
    expect(taskGraphNodeKeysMatch({ ...node, registeredScoutEnvelope: envelope }, keys)).toBe(true)
    expect(taskGraphNodeKeysMatch({ ...node, registeredScoutEnvelope: envelope, private: true }, keys)).toBe(false)
  })
})
