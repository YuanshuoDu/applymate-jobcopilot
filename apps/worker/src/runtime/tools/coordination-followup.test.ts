import { describe, expect, it } from "vitest"

import { CoordinationError, type CoordinationTaskView } from "./coordination-types.js"
import { assertFollowupReplay, followupContext, followupProvenance } from "./coordination-followup.js"

const source: CoordinationTaskView = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "completed", goal: "Find jobs",
  attemptCount: 2, maxAttempts: 3, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
  result: { summary: "done" },
}
const parent: CoordinationTaskView = {
  ...source, id: "root-1", rootTaskId: "root-1", parentTaskId: null, path: "/root-1", depth: 0,
  role: "orchestrator", taskType: "root", status: "running", goal: "Coordinate", attemptCount: 1, maxAttempts: 1,
}

function replay(overrides: Partial<CoordinationTaskView> = {}): CoordinationTaskView {
  return {
    ...source, id: "child-2", parentTaskId: parent.id, path: "/root-1/child-2", depth: 1, goal: "Continue",
    status: "queued", result: null, context: { provenance: { kind: "agent.followup", sourceTaskId: source.id, sourceStatus: source.status, sourceAttemptCount: source.attemptCount, priorResult: { summary: "done" } } },
    ...overrides,
  }
}

describe("follow-up coordination helpers", () => {
  it("builds a bounded context with server-owned provenance", () => {
    const value = followupContext({ email: "private@example.com", userId: "foreign", note: "keep" }, source, input => {
      if (input && typeof input === "object" && !Array.isArray(input)) return { note: "keep", email: "[REDACTED]" }
      return input
    }) as Record<string, unknown>
    expect(value).toEqual(expect.objectContaining({ callerContext: { note: "keep", email: "[REDACTED]" }, provenance: expect.objectContaining({ sourceTaskId: source.id, sourceAttemptCount: 2 }) }))
    expect(JSON.stringify(value)).not.toContain("userId")
  })

  it("accepts an exact replay and rejects stale or foreign provenance", () => {
    const exact = replay()
    expect(() => assertFollowupReplay(exact, source, parent, followupProvenance(exact.context), "turn-1")).not.toThrow()
    const foreign = replay({ context: { provenance: { kind: "agent.followup", sourceTaskId: "other", sourceStatus: source.status, sourceAttemptCount: source.attemptCount } } })
    expect(() => assertFollowupReplay(foreign, source, parent, followupProvenance(foreign.context), "turn-1"))
      .toThrowError(new CoordinationError("coordination_idempotency_conflict", "Follow-up provenance does not match its source task"))
    const stale = replay({ context: { provenance: { kind: "agent.followup", sourceTaskId: source.id, sourceStatus: source.status, sourceAttemptCount: 1 } } })
    expect(() => assertFollowupReplay(stale, source, parent, followupProvenance(stale.context), "turn-1"))
      .toThrow("Follow-up provenance does not match its source task")
  })

  it("fences replay to the current turn and runtime parent", () => {
    expect(() => assertFollowupReplay(replay({ turnId: "turn-old" }), source, parent, followupProvenance(replay().context), "turn-1"))
      .toThrow("current runtime parent")
    expect(() => assertFollowupReplay(replay({ parentTaskId: "other-parent" }), source, parent, followupProvenance(replay().context), "turn-1"))
      .toThrow("current runtime parent")
  })
})
