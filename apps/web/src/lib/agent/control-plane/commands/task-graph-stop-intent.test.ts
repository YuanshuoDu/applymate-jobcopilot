import { describe, expect, it, vi } from "vitest"

import type { CommandTransaction } from "./transaction"
import { enqueueTaskGraphStopIntent } from "./task-graph-stop-intent"

describe("TaskGraph Stop outbox intent", () => {
  it("uses stable session and Turn identifiers with duplicate insertion enabled", async () => {
    const createMany = vi.fn(async (_args: unknown) => ({ count: 1 }))
    const tx = { agentOutbox: { createMany } } as unknown as CommandTransaction
    const scope = { sessionId: "session_1", turnId: "turn_1" }
    const expected = {
      data: [{
        id: "task-graph-stop-turn_1",
        topic: "agent.task-graph.stop",
        aggregateId: "session_1",
        idempotencyKey: "agent-task-graph-stop:session_1:turn_1",
        payload: { sessionId: "session_1", turnId: "turn_1" },
      }],
      skipDuplicates: true,
    }

    await enqueueTaskGraphStopIntent(tx, scope)
    await enqueueTaskGraphStopIntent(tx, scope)

    expect(createMany).toHaveBeenNthCalledWith(1, expected)
    expect(createMany).toHaveBeenNthCalledWith(2, expected)
    expect(createMany).toHaveBeenCalledTimes(2)
  })
})
