import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import type { TaskGraphNativeSourceProvenance, TaskGraphReadScope } from "./task-graph-command-port.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { loadNativeVerificationSourceTasks, nativeVerificationSourceIsCurrent } from "./native-verification-pg-sources.js"

const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-lease", turnLeaseVersion: 1, parentLeaseOwner: "parent-lease", parentAttemptCount: 1,
}
const result = { facts: ["actual source fact"] }
const task = {
  id: "legacy-1", parentTaskId: "root-1", rootTaskId: "root-1", turnId: "turn-1", role: "analyst", taskType: "research",
  status: "failed", attemptCount: 2, result, failureReason: "source stopped", goal: "Research the source", successCriteria: ["Find the fact"],
  expectedOutputSchema: {}, context: {}, outputArtifactIds: [],
}
const source: TaskGraphNativeSourceProvenance = {
  taskId: task.id, rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, turnId: task.turnId,
  role: task.role, taskType: task.taskType, status: "failed", attemptCount: task.attemptCount,
  resultDigest: taskGraphResultDigest(result), graphNodeKey: null, origin: "native_legacy",
}

describe("native verification durable source reads", () => {
  it("requires exact current owner, lineage, status, attempt and result provenance for legacy sources", () => {
    expect(nativeVerificationSourceIsCurrent(null, source, task, scope)).toBe(true)
    for (const stale of [
      { ...task, rootTaskId: "foreign-root" }, { ...task, parentTaskId: "other-parent" },
      { ...task, turnId: "old-turn" }, { ...task, role: "scout" }, { ...task, taskType: "other" },
      { ...task, status: "completed" }, { ...task, attemptCount: 1 }, { ...task, result: { facts: ["changed"] } },
    ]) expect(nativeVerificationSourceIsCurrent(null, source, stale, scope)).toBe(false)
    expect(nativeVerificationSourceIsCurrent(null, source, undefined, scope)).toBe(false)
  })

  it("binds graph source goal and criteria to their current graph task", () => {
    const graphSource: TaskGraphNativeSourceProvenance = { ...source, graphNodeKey: "source-node", origin: "task_graph" }
    const snapshot = { nodes: [{ key: "source-node", taskId: task.id, goal: task.goal, successCriteria: task.successCriteria }] } as unknown as TaskGraphSnapshot
    expect(nativeVerificationSourceIsCurrent(snapshot, graphSource, task, scope)).toBe(true)
    expect(nativeVerificationSourceIsCurrent({ nodes: [{ ...snapshot.nodes[0]!, goal: "changed" }] } as unknown as TaskGraphSnapshot, graphSource, task, scope)).toBe(false)
    expect(nativeVerificationSourceIsCurrent({ nodes: [{ ...snapshot.nodes[0]!, successCriteria: ["changed"] }] } as unknown as TaskGraphSnapshot, graphSource, task, scope)).toBe(false)
    expect(nativeVerificationSourceIsCurrent(snapshot, source, task, scope)).toBe(false)
  })

  it("loads bounded owned legacy source facts and actual result under the current user/root/Turn", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ ...task }] }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const snapshot = { nodes: [{ nativeDelegation: { source } }] } as unknown as TaskGraphSnapshot
    const loaded = await loadNativeVerificationSourceTasks(client, scope, snapshot, true)
    expect(loaded.get(task.id)).toMatchObject({ goal: task.goal, successCriteria: task.successCriteria, result })
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0]?.[1]).toEqual([[task.id], scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
    expect(String(query.mock.calls[0]?.[0])).toContain('task."goal", task."successCriteria"')
    expect(String(query.mock.calls[0]?.[0])).toContain('session."userId" = $5 AND turn."userId" = $5')
  })
})
