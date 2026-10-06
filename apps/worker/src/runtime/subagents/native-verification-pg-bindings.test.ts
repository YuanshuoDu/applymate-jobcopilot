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
