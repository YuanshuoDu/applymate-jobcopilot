import { describe, expect, it } from "vitest"

import type { TenantScope } from "@jobcopilot/agent-protocol"

import { AgentContextSnapshotBuilder } from "./context-snapshot-builder.js"
import { assertSnapshotIntegrity } from "./context-snapshot-canonical.js"
import { assertForkIdempotency, planFork, type ForkSource } from "./context-fork.js"

const scope: TenantScope = { userId: "user-a" }

function source(): ForkSource {
  return {
    sessionId: "session-a",
    ownerId: "user-a",
    scope,
    goal: "Find backend roles",
    turns: [
      { id: "turn-1", status: "completed", createdAt: 1 },
      { id: "turn-2", status: "in_progress", createdAt: 2 },
    ],
    items: [
      { id: "item-1", turnId: "turn-1", type: "user_message", status: "completed", content: { text: "start" } },
      { id: "item-receipt", turnId: "turn-1", type: "action_receipt", status: "completed", content: { receipt: "secret" } },
      { id: "item-pending", turnId: "turn-1", type: "tool_result", status: "pending", content: { state: "pending" } },
    ],
    events: [
      { id: "event-1", turnId: "turn-1", itemId: "item-1", sequence: 4n, type: "input.accepted", actor: "user", correlationId: "turn-1", payload: {} },
      { id: "event-receipt", turnId: "turn-1", sequence: 5n, type: "action.receipt.issued", actor: "system", correlationId: "turn-1", payload: {} },
    ],
  }
}

describe("context fork planner", () => {
  it("copies only through the terminal lastTurn boundary and allocates independent ids/counters", () => {
    const plan = planFork(source(), { sourceSessionId: "session-a", lastTurnId: "turn-1", clientMessageId: "fork-1" }, (() => {
      let next = 0
      return () => `new-${++next}`
    })())

    expect(plan.targetSessionId).toMatch(/^fork-/)
    expect(plan.turns.map((turn) => turn.sourceId)).toEqual(["turn-1"])
    expect(plan.turns[0]).toMatchObject({ leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null, leaseVersion: 0, revision: 0 })
    expect(plan.items.map((item) => item.sourceId)).toEqual(["item-1"])
    expect(plan.events.map((event) => event.sourceId)).toEqual(["event-1"])
    expect(plan.events[0]).toMatchObject({ sequence: 1n, taskId: null, idempotencyKey: expect.stringContaining("fork-history:") })
    expect(plan.nextEventSequence).toBe(1n)
    expect(plan.excluded).toEqual({ leases: true, receipts: true, pendingInputs: true, approvals: true, reservations: true, outbox: true })
  })

  it("rejects a non-terminal boundary and a cross-tenant source", () => {
    expect(() => planFork(source(), { sourceSessionId: "session-a", lastTurnId: "turn-2", clientMessageId: "fork-2" })).toThrow(/terminal Turn/)
    expect(() => planFork({ ...source(), ownerId: "user-b", scope }, { sourceSessionId: "session-a", lastTurnId: "turn-1", clientMessageId: "fork-3" })).toThrow(/tenant scope/)
  })

  it("does not reuse an idempotency key for a different boundary", () => {
    expect(assertForkIdempotency({ sourceSessionId: "session-a", lastTurnId: "turn-1", clientMessageId: "fork-1", targetSessionId: "fork-target" }, { sourceSessionId: "session-a", lastTurnId: "turn-1", clientMessageId: "fork-1" })).toBe("fork-target")
    expect(() => assertForkIdempotency({ sourceSessionId: "session-a", lastTurnId: "turn-1", clientMessageId: "fork-1", targetSessionId: "fork-target" }, { sourceSessionId: "session-a", lastTurnId: "turn-2", clientMessageId: "fork-1" })).toThrow(/different fork/)
  })

  it("restores a canonical snapshot and remains stable for 100+ Items", async () => {
    const snapshot = await new AgentContextSnapshotBuilder(
      {
        load: async () => ({
          goal: "Find backend roles", userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: ["approval-1"],
          artifacts: [], facts: [], failedAttempts: [], references: [{ id: "job-1", kind: "job", ownerId: "user-a", source: "jobs" }], tokenUsage: [],
          context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
        }),
      },
      { verify: async (reference) => ({ ...reference, verified: true as const }) },
    ).build({ scope, sessionId: "session-a", throughSequence: 128n, version: 2 })
    const base = source()
    const large: ForkSource = {
      ...base,
      items: Array.from({ length: 128 }, (_, index) => ({ id: `item-${index}`, turnId: "turn-1", type: "agent_message", status: "completed", content: { index } })),
      events: Array.from({ length: 128 }, (_, index) => ({ id: `event-${index}`, turnId: "turn-1", itemId: `item-${index}`, sequence: index + 1, type: "item.completed", actor: "agent", correlationId: "turn-1", payload: { index } })),
    }
    const plan = planFork({ ...large, snapshot }, { sourceSessionId: "session-a", lastTurnId: "turn-1", clientMessageId: "fork-large" })

    expect(plan.items).toHaveLength(128)
    expect(plan.events).toHaveLength(128)
    expect(plan.snapshot).not.toBeNull()
    expect(plan.snapshot).toMatchObject({ sessionId: plan.targetSessionId, throughSequence: 128n, version: 1 })
    expect(plan.snapshot?.content.pendingApprovals).toEqual([])
    expect(plan.snapshot?.content.references).toEqual([{ id: "job-1", kind: "job", ownerId: "user-a", source: "jobs", verified: true }])
    assertSnapshotIntegrity(plan.snapshot as NonNullable<typeof plan.snapshot>)
    expect(large.sessionId).toBe("session-a")
    expect(large.events[0]?.id).toBe("event-0")
  })
})
