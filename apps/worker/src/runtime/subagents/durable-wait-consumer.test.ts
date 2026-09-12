import { describe, expect, it } from "vitest"

import { consumeDurableWaitOutcomes } from "./durable-wait-consumer.js"
import type { TurnLease } from "../turns/lease.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-09T10:00:00.000Z"), leaseExpiresAt: new Date("2026-09-09T11:00:00.000Z"),
}
const turn = { id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: "worker-1", leaseVersion: 2, leaseExpiresAt: lease.leaseExpiresAt, rootTaskId: "root-1" }
const now = new Date("2026-09-09T10:30:00.000Z")

function fixture(input: { waitStatus?: string; consumed?: boolean; targetStatus?: string; foreign?: boolean; failUpdate?: boolean; large?: boolean } = {}) {
  const wait = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "all", status: input.waitStatus ?? "ready", matchedTaskIds: ["child-1"], result: input.consumed ? { request: { mode: "all" }, outcome: { waitId: "wait-1", status: "ready", targetTaskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [] } } : { request: { mode: "all" } }, suspendedAt: now, consumedAt: input.consumed ? now : null }
  const state: { wait: typeof wait; consumedAt: Date | null; result: Record<string, unknown>; updates: number } = { wait, consumedAt: wait.consumedAt, result: wait.result, updates: 0 }
  const client = {
    query: async (sql: string) => {
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [state.wait], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])") ) return { rows: input.foreign ? [] : [{ id: "child-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1", status: input.targetStatus ?? "completed", result: { safe: input.large ? "x".repeat(10_000) : true, secret: "hide-me" }, failureReason: input.targetStatus === "failed" ? "provider failed" : null }], rowCount: input.foreign ? 0 : 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        if (input.failUpdate) throw new Error("update failed")
        state.consumedAt = now; state.result = { ...state.result, outcome: { waitId: "wait-1" } }; state.updates += 1
        return { rows: [{ id: "wait-1" }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
  }
  return { client, state }
}

describe("durable wait outcome consumer", () => {
  it("projects a ready all result and consumes it once", async () => {
    const fake = fixture()
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]).toMatchObject({ id: "wait-result:wait-1", content: { toolCallId: "wait:wait-1", toolName: "wait_subagents", input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { status: "ready", matchedTaskIds: ["child-1"] } } })
    expect(fake.state.consumedAt).toBe(now)
    expect(fake.state.result).toMatchObject({ request: { mode: "all" }, outcome: { waitId: "wait-1" } })
    expect(fake.state.updates).toBe(1)
  })

  it("keeps timeout and failed child status explicit in the outcome", async () => {
    const fake = fixture({ waitStatus: "timed_out", targetStatus: "failed" })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]?.content).toMatchObject({ output: { status: "timed_out", tasks: [{ status: "failed", failureReason: "provider failed" }] } })
    expect(JSON.stringify(projections)).not.toContain("hide-me")
  })

  it("bounds a large child result in the durable projection", async () => {
    const fake = fixture({ large: true })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]?.content).toMatchObject({ output: { tasks: [{ result: { truncated: true } }] } })
  })

  it("rebuilds an already consumed outcome without writing a second receipt", async () => {
    const fake = fixture({ consumed: true })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections).toHaveLength(1)
    expect(fake.state.updates).toBe(0)
  })

  it("fails closed for stale ownership and foreign lineage", async () => {
    const stale = { ...turn, leaseOwnerId: "other-worker" }
    const fake = fixture()
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn: stale, now })).rejects.toThrow("wait_consume_turn_fenced")
    const foreign = fixture({ foreign: true })
    await expect(consumeDurableWaitOutcomes({ client: foreign.client as never, lease, turn, now })).resolves.toEqual([])
    expect(foreign.state.updates).toBe(0)
  })

  it("leaves consumedAt unchanged when the receipt write fails", async () => {
    const fake = fixture({ failUpdate: true })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("update failed")
    expect(fake.state.consumedAt).toBeNull()
    expect(fake.state.updates).toBe(0)
  })
})
