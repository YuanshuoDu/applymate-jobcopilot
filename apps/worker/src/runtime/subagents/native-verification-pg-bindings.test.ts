import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { loadNativeVerificationOwnedState } from "./native-verification-pg-bindings.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"

const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-lease", turnLeaseVersion: 1, parentLeaseOwner: "parent-lease", parentAttemptCount: 1,
}

function client(input: unknown, successCriteria: unknown = [], goal = "Original objective"): Pick<pg.PoolClient, "query"> {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ goal, successCriteria, input }] }))
  return { query } as unknown as Pick<pg.PoolClient, "query">
}

describe("native verification owned goal and criteria binding", () => {
  it("uses the canonical nested Turn goal and falls back to that frozen goal for empty criteria", async () => {
    const loaded = await loadNativeVerificationOwnedState(client({ input: { goal: " Original objective ", content: "Original objective" } }), scope, null)
    expect(loaded.goal).toBe("Original objective")
    expect(loaded.criteria).toEqual(["Original objective"])
    expect(loaded.criteriaValid).toBe(true)
    expect(loaded.turnGoalConflict).toBe(false)
  })

  it("accepts the canonical human command goal with validated typed input parts", async () => {
    const longReference = `Reference context, not a goal. ${"Supporting background details. ".repeat(450)}`
    const loaded = await loadNativeVerificationOwnedState(client({ input: {
      goal: "Original objective",
      content: [{ type: "text", text: longReference }, { type: "attachment_ref", attachmentId: "resume-1", mediaType: "application/pdf" }],
    } }), scope, null)
    expect(loaded.goal).toBe("Original objective")
    expect(loaded.criteria).toEqual(["Original objective"])
    expect(loaded.criteriaValid).toBe(true)
    expect(loaded.turnGoalConflict).toBe(false)
  })

  it("binds the whole canonical goal with human criteria and the checklist pinned in its owned snapshot", async () => {
    const goal = "Find software roles across every requested European market and prepare a shortlist"
    const checklist = "Include source-backed evidence for each shortlisted role"
    const loaded = await loadNativeVerificationOwnedState(client({ input: {
      goal, content: goal, successCriteria: ["Retain the user's explicit salary range"],
    } }, [], goal), scope, { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [], rootSuccessCriteria: [goal, checklist] })

    expect(loaded.goal).toBe(goal)
    expect(loaded.criteria).toEqual([goal, "Retain the user's explicit salary range", checklist])
    expect(loaded.criteriaValid).toBe(true)
    expect(loaded.turnGoalConflict).toBe(false)
  })

  it("fails closed rather than falling back when a pinned snapshot omits or changes the canonical goal", async () => {
    const goal = "Preserve the entire human objective"
    for (const rootSuccessCriteria of [["Only the first subgoal"], ["Changed goal", "Additional check"]]) {
      const loaded = await loadNativeVerificationOwnedState(client({ input: { goal, content: goal } }), scope, {
        schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [], rootSuccessCriteria,
      })
      expect(loaded.goal).toBe(goal)
      expect(loaded.criteria).toEqual([])
      expect(loaded.criteriaValid).toBe(false)
    }
  })

  it("rejects structurally invalid pinned snapshot criteria", async () => {
    await expect(loadNativeVerificationOwnedState(client({ input: { goal: "Original objective" } }), scope, {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [], rootSuccessCriteria: ["Original objective", "Original objective"],
    })).rejects.toThrow("task_graph_snapshot_root_criteria_invalid")
  })

  it("still rejects an explicit goal beyond the frozen native objective bound", async () => {
    const oversizedGoal = "x".repeat(4_097)
    const loaded = await loadNativeVerificationOwnedState(client({ input: {
      goal: oversizedGoal, content: [{ type: "text", text: "Background remains separate." }],
    } }), scope, null)
    expect(loaded.goal).toBeNull()
    expect(loaded.turnGoalConflict).toBe(true)
    expect(loaded.criteriaValid).toBe(false)
  })

  it("fails closed for malformed, unsupported, or sparse typed input parts", async () => {
    const sparse: unknown[] = []
    sparse[1] = { type: "text", text: "Original objective" }
    for (const content of [[], [{ type: "text", text: "" }], [{ type: "image", url: "https://example.invalid" }],
      [{ type: "text", text: "Original objective", extra: true }], sparse]) {
      const loaded = await loadNativeVerificationOwnedState(client({ input: { goal: "Original objective", content } }), scope, null)
      expect(loaded.goal).toBeNull()
      expect(loaded.turnGoalConflict).toBe(true)
      expect(loaded.criteriaValid).toBe(false)
    }
  })

  it("rejects malformed or oversized explicit criteria without truncating them", async () => {
    for (const criteria of [[1], Array.from({ length: 33 }, (_, index) => `criterion ${index}`)]) {
      const loaded = await loadNativeVerificationOwnedState(client({ input: { goal: "Original objective" } }, criteria), scope, null)
      expect(loaded.criteriaValid).toBe(false)
      expect(loaded.criteria).toEqual([])
    }
    const oversized = "x".repeat(2_001)
    const loaded = await loadNativeVerificationOwnedState(client({ input: { goal: "Original objective" } }, [oversized]), scope, null)
    expect(loaded.criteriaValid).toBe(false)
    expect(loaded.criteria).toEqual([])
  })

  it("fails closed when fallback goal exceeds the frozen criterion bound or nested goal conflicts", async () => {
    const longGoal = "x".repeat(2_001)
    const long = await loadNativeVerificationOwnedState(client({ input: { goal: longGoal } }), scope, null)
    expect(long.criteria).toEqual([longGoal])
    expect(long.criteriaValid).toBe(false)

    const conflict = await loadNativeVerificationOwnedState(client({
      input: { goal: "Original objective", content: "Different objective" },
    }), scope, null)
    expect(conflict.turnGoalConflict).toBe(true)
    expect(conflict.criteriaValid).toBe(false)
  })
})
