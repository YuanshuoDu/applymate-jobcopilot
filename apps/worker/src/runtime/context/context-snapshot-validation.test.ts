import { describe, expect, it } from "vitest"

import { CONTEXT_SNAPSHOT_SCHEMA_VERSION } from "./context-snapshot-types.js"
import { validateSnapshotContent } from "./context-snapshot-validation.js"

function content(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ownerId: "user-a",
    sessionId: "session-a",
    throughSequence: "2",
    goal: "Find a role",
    userConstraints: [],
    confirmedDecisions: [],
    completedWork: [],
    openWork: [],
    pendingApprovals: [],
    artifacts: [],
    facts: [],
    failedAttempts: [],
    references: [],
    consumedInputIds: [],
    context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    ...overrides,
  }
}

describe("context snapshot content validation", () => {
  it("accepts the additive v1 shape", () => {
    expect(validateSnapshotContent(content()).throughSequence).toBe("2")
  })

  it("rejects unsorted lists and unverified references", () => {
    expect(() => validateSnapshotContent(content({ userConstraints: ["z", "a"] }))).toThrow("sorted")
    expect(() => validateSnapshotContent(content({
      references: [{ id: "job-1", kind: "job", ownerId: "user-a", source: "jobs", verified: false }],
    }))).toThrow("verified")
  })

  it("rejects duplicate or out-of-order work records", () => {
    expect(() => validateSnapshotContent(content({
      completedWork: [
        { taskId: "task-b", resultRef: "r", summary: "done", sequence: "2" },
        { taskId: "task-a", resultRef: "r", summary: "done", sequence: "1" },
      ],
    }))).toThrow("sorted")
    expect(() => validateSnapshotContent(content({
      openWork: [
        { taskId: "task-a", status: "waiting", blocker: null },
        { taskId: "task-a", status: "running", blocker: null },
      ],
    }))).toThrow("duplicate")
  })
})
