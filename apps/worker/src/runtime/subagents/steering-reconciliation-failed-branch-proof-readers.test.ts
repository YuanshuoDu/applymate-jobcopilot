import { describe, expect, it } from "vitest"
import { parseTaskGraphReplacementScheduleReceipt, parseTaskGraphReplacementSnapshot,
  validTaskGraphReplacementLifecycleKey } from "./steering-reconciliation-failed-branch-proof-readers.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"

describe("strict failed-branch proof readers", () => {
  it("keeps accepted schedule receipts closed and bound to ready queued successors", () => {
    const value = { status: "accepted", revision: 4, nodes: [{ key: "scout-new", taskId: "task-new", status: "queued" }],
      readyTaskIds: ["task-new"] }
    expect(parseTaskGraphReplacementScheduleReceipt(value)).toEqual(value)
    expect(parseTaskGraphReplacementScheduleReceipt({ ...value, readyTaskIds: ["other-task"] })).toBeNull()
    expect(parseTaskGraphReplacementScheduleReceipt({ ...value, privateText: "untrusted" })).toBeNull()
  })

  it("parses snapshots and reconstructs only the exact lifecycle key", () => {
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "scout-old", taskId: "task-old",
      templateId: "scout", goal: "Find evidence", successCriteria: ["Find one"], dependsOn: [], depth: 1,
      verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
        criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }] } }] }
    expect(parseTaskGraphReplacementSnapshot(snapshot)?.nodes[0]?.templateId).toBe("scout")
    expect(parseTaskGraphReplacementSnapshot({ ...snapshot, unknown: true })).toBeNull()
    const key = taskGraphLifecycleKey("root-1", "scout-old", 2, "task.failed")
    expect(validTaskGraphReplacementLifecycleKey(key, "root-1", "scout-old", "task.failed")).toBe(true)
    expect(validTaskGraphReplacementLifecycleKey(key, "root-1", "scout-old", "task.completed")).toBe(false)
  })
})
