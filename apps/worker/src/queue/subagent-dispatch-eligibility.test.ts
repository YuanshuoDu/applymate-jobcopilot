import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { dispatchTaskInvalidReason, markDispatchTerminal } from "./subagent-dispatch-eligibility.js"
import type { SubagentJobPayload } from "../runtime/subagents/types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }

function task(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: "session-1", rootTaskId: "root-1", turnId: "turn-1", status: "queued", attemptCount: 0, maxAttempts: 3,
    leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, rootId: "root-1", rootSessionId: "session-1",
    rootTurnId: "turn-1", rootStatus: "running", turnRowId: "turn-1", turnSessionId: "session-1", turnUserId: "user-1",
    turnStatus: "in_progress", retryDue: true, ...overrides,
  }
}

describe("subagent dispatch eligibility", () => {
  it("rejects terminal task rows", () => {
    expect(dispatchTaskInvalidReason(task({ status: "completed" }), payload, "session-1", "user-1")).toBe("task_terminal")
  })

  it("defers a future durable retry without terminalizing it", () => {
    expect(dispatchTaskInvalidReason(task({ retryDue: false }), payload, "session-1", "user-1")).toBe("retry_deferred")
  })

  it.each([
    ["scope", { sessionId: "other-session" }, "task_scope_invalid"],
    ["attempt", { attemptCount: 3 }, "attempts_exhausted"],
  ] as const)("rejects an invalid %s fence", (_label, overrides, reason) => {
    expect(dispatchTaskInvalidReason(task(overrides), payload, "session-1", "user-1")).toBe(reason)
  })

  it("marks a terminal dispatch with a bounded reason", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }) } as unknown as Pick<pg.PoolClient, "query">
    await markDispatchTerminal(client, "outbox-1", "task_missing")
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('"publishedAt" = CURRENT_TIMESTAMP'), ["outbox-1", "task_missing"])
  })
})
