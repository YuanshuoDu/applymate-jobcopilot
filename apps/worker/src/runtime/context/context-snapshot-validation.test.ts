import { describe, expect, it } from "vitest"

import { CONTEXT_SNAPSHOT_SCHEMA_VERSION } from "./context-snapshot-types.js"
import { validateSnapshotContent } from "./context-snapshot-validation.js"
import { sha256Hex } from "./context-compaction-canonical.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"

const selectedJobMemory = projectSelectedJobMemory({
  jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "2",
  graph: { revision: 1, nodes: [{ templateId: "analyst", status: "completed", readiness: "terminal" }] },
})!

function compaction(selectedJobMemories?: readonly unknown[]) {
  const state: Record<string, unknown> = {
    ownerId: "user-a", sessionId: "session-a", throughSequence: "2", goal: "Find a role", userConstraints: [],
    approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [],
    ...(selectedJobMemories === undefined ? {} : { selectedJobMemories }),
  }
  const itemId = "compaction-2", narrativeSummary = "summary", tokenMeasurement = { beforeInputTokens: 2, afterInputTokens: 1, reductionTokens: 1, reductionRatio: 0.5 }, sourceItemIds: string[] = []
  return { itemId, digest: sha256Hex({ state, summary: narrativeSummary, measurement: tokenMeasurement, sourceItemIds, itemId }), state, narrativeSummary, tokenMeasurement, sourceItemIds }
}

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
    expect(validateSnapshotContent(content({ compaction: compaction([selectedJobMemory]) })).compaction?.state?.selectedJobMemories).toEqual([selectedJobMemory])
    expect(validateSnapshotContent(content({ compaction: compaction() })).throughSequence).toBe("2")
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

  it("rejects memory records with extra free-text fields or an invalid digest", () => {
    const extraField = { ...selectedJobMemory, narrative: "unsafe" }
    const invalidDigest = { ...selectedJobMemory, graphDigest: "0".repeat(64) }
    expect(() => validateSnapshotContent(content({
      compaction: compaction([extraField]),
    }))).toThrow("selected-job memory")
    expect(() => validateSnapshotContent(content({
      compaction: compaction([invalidDigest]),
    }))).toThrow("selected-job memory")
  })
})
