import { describe, expect, it, vi } from "vitest"
import type { TaskGraphState } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import { taskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"
import { validateTaskGraphRepairTargets } from "./task-graph-pg-create-repair-validation.js"

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
} as const
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const relation = { graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-task", criterionIds: ["finding-count"] }
const current: TaskGraphState = {
  revision: 1,
  appliedEvents: [],
  nodes: [{ key: "target", templateId: "analyst", goal: "Analyze findings", successCriteria: ["Find a result"], dependsOn: [],
    depth: 1, status: "failed", taskId: "target-task", verificationDisposition: "typed", verification }],
}
const taskIds = new Map([["target", "target-task"]])
const snapshot = taskGraphSnapshot(current, taskIds)
const input: TaskGraphScheduleInput = {
  scope,
  proposal: { expectedRevision: 1, nodes: [{ key: "repair", templateId: "analyst", goal: "Repair the finding",
    successCriteria: ["Resolve the finding"], dependsOn: [], verification, repairOf: relation }] },
  templates: { analyst: { role: "analyst", taskType: "analysis", allowedActions: [] } },
}
const failedResult = { taskGraphVerificationReport: {
  verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
  criteria: [{ criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met" }],
  evidenceDigest: "a".repeat(64), resultDigest: "e".repeat(64),
} }
const failedTargetRow = {
  id: "target-task", status: "failed", role: "analyst", failureReason: "task_graph_verification_failed", result: failedResult,
  rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, sessionId: scope.sessionId, turnId: scope.turnId,
}

function clientWithSnapshot(storedSnapshot: unknown = snapshot) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => sql.includes('SELECT item."content"')
    ? { rows: [{ content: storedSnapshot }], rowCount: 1 }
    : { rows: [failedTargetRow], rowCount: 1 })
  return { client: { query } as unknown as Queryable, query }
}

describe("validateTaskGraphRepairTargets", () => {
  it("accepts a repair only after matching the persisted snapshot and failed typed target proof", async () => {
    const { client, query } = clientWithSnapshot()

    await expect(validateTaskGraphRepairTargets(client, input, current, taskIds)).resolves.toBeUndefined()
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[1]).toEqual(["target-task", scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  })

  it("rejects a stale persisted snapshot before reading the target row", async () => {
    const { client, query } = clientWithSnapshot({ schemaVersion: snapshot.schemaVersion, nodes: [] })

    await expect(validateTaskGraphRepairTargets(client, input, current, taskIds)).rejects.toThrow("task_graph_repair_snapshot_invalid")
    expect(query).toHaveBeenCalledTimes(1)
  })
})
