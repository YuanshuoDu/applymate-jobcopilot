import { describe, expect, it, vi } from "vitest"

import { enqueueTaskInterruptIntent, taskInterruptAcceptedEventKey, taskInterruptOutboxKey } from "./task-interrupt-intent"

describe("task interrupt intent", () => {
  it("scopes idempotency to the session and preserves the RLS aggregate", async () => {
    const tx = { agentOutbox: { create: vi.fn().mockResolvedValue({}) } }
    await enqueueTaskInterruptIntent(tx as never, {
      sessionId: "session-1", turnId: "turn-1", taskId: "child-1", intentId: "intent-1", clientMessageId: "request-1",
    })

    expect(taskInterruptOutboxKey("session-1", "request-1")).not.toBe(taskInterruptOutboxKey("session-2", "request-1"))
    expect(taskInterruptAcceptedEventKey("session-1", "request-1")).toContain("session-1")
    expect(tx.agentOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      topic: "agent.subagent.task-interrupt", aggregateId: "session-1", idempotencyKey: "agent-task-interrupt:session-1:request-1",
      payload: { sessionId: "session-1", turnId: "turn-1", taskId: "child-1", intentId: "intent-1" },
    }) })
  })
})
