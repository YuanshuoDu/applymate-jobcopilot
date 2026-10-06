import { describe, expect, it } from "vitest"

import { assertCompactionInvariantsPreserved, compareCompactionInvariants } from "./context-compaction-validator.js"
import type { CompactionState } from "./context-compaction-types.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"

const memories = [projectSelectedJobMemory({
  jobId: "job-a", sourceTurnId: "turn-a", sourceRootTaskId: "root-a", throughSequence: "1",
  graph: { revision: 1, nodes: [{ templateId: "analyst", status: "completed", readiness: "terminal" }] },
})!]
const state: CompactionState = {
  ownerId: "user-a", sessionId: "session-a", throughSequence: 1n, goal: "Find work", userConstraints: [],
  approvals: [{ id: "approval-1", status: "pending", scopeHash: "scope" }],
  answers: [{ id: "answer-1", question: "Permit", answer: "yes" }],
  artifacts: [{ id: "artifact-1", type: "resume", hash: "hash-1" }],
  openTasks: [{ taskId: "task-1", status: "open", blocker: null }], doNotRepeat: ["bad path"], facts: [], selectedJobMemories: memories,
}

describe("compaction invariant validator", () => {
  it("accepts exact preservation and exposes only invariant digests", () => {
    const report = assertCompactionInvariantsPreserved(state, structuredClone(state))
    expect(report.preserved).toBe(true)
    expect(report.preservedFields).toEqual(["goal", "approvals", "answers", "artifact_hashes", "open_tasks", "do_not_repeat", "selected_job_memories"])
    expect(report.beforeDigest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("detects malicious hash changes and missing answer fields", () => {
    const changed = { ...state, artifacts: [{ ...state.artifacts[0], hash: "attacker-hash" }] }
    expect(compareCompactionInvariants(state, changed)).toMatchObject({ preserved: false, changedFields: ["artifact_hashes"] })
    const missing = { ...state, answers: undefined } as unknown as CompactionState
    expect(compareCompactionInvariants(state, missing)).toMatchObject({ preserved: false, missingFields: ["after.answers"] })
    expect(() => assertCompactionInvariantsPreserved(state, changed)).toThrow("invariant")
    expect(compareCompactionInvariants(state, { ...state, selectedJobMemories: [] })).toMatchObject({ preserved: false, changedFields: ["selected_job_memories"] })
  })
})
