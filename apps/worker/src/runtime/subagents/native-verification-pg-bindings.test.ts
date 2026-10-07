import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { loadNativeVerificationOwnedState } from "./native-verification-pg-bindings.js"

const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-lease", turnLeaseVersion: 1, parentLeaseOwner: "parent-lease", parentAttemptCount: 1,
}

function client(input: unknown, successCriteria: unknown = []): Pick<pg.PoolClient, "query"> {
  const query = vi.fn(async (..._args: unknown[]) => ({ rows: [{ goal: "Original objective", successCriteria, input }] }))
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
