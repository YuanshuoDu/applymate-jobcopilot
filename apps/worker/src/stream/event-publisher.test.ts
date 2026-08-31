import { describe, expect, it, vi } from "vitest"

import { ItemSnapshotCoalescer, publishAgentDelta, publishAgentEvent, publishAgentItemSnapshot, type AgentItemSnapshotUpdate } from "./event-publisher.js"

function redis() {
  return { publish: vi.fn().mockResolvedValue(1), xadd: vi.fn().mockResolvedValue("17-0") }
}

const update: AgentItemSnapshotUpdate = {
  sessionId: "session_1", turnId: "turn_1", itemId: "item_1", taskId: null, type: "agent_message",
  actor: "orchestrator", correlationId: "turn_1", causationId: null, idempotencyKey: null,
  baseRevision: 0, revision: 1, payload: { text: "working" },
}

describe("agent stream publisher", () => {
  it("publishes durable events to the session channel", async () => {
    const connection = redis()
    await publishAgentEvent(connection, {
      id: "event_1", sessionId: "session_1", turnId: "turn_1", itemId: "item_1", taskId: null,
      sequence: BigInt(7), type: "item.completed", actor: "orchestrator", correlationId: "turn_1",
      causationId: null, idempotencyKey: "key_1", payload: { text: "done" }, createdAt: "2026-08-31T00:00:00.000Z",
    })
    expect(connection.publish).toHaveBeenCalledWith("agent:session:session_1:events", expect.stringContaining('"sequence":"7"'))
  })

  it("writes bounded snapshots to the transient Redis stream", async () => {
    const connection = redis()
    const result = await publishAgentItemSnapshot(connection, update)
    expect(connection.xadd).toHaveBeenCalledWith(
      "agent:session:session_1:deltas", "MAXLEN", "~", "2000", "*", "payload", expect.any(String),
    )
    expect(connection.publish).toHaveBeenCalledWith("agent:session:session_1:delta-notify", "17-0")
    expect(result.envelope).toMatchObject({ kind: "snapshot", baseRevision: 0, revision: 1 })
  })

  it("keeps fine-grained deltas distinct from reconstructable snapshots", async () => {
    const connection = redis()
    const result = await publishAgentDelta(connection, update)
    expect(result.envelope).toMatchObject({ kind: "delta", revision: 1 })
  })

  it("coalesces an item's intermediate updates and preserves the first base revision", async () => {
    const published: typeof update[] = []
    const coalescer = new ItemSnapshotCoalescer(async (value) => { published.push(value) })
    coalescer.enqueue(update)
    coalescer.enqueue({ ...update, baseRevision: 1, revision: 2, payload: { text: "latest" } })
    await coalescer.flush()
    expect(published).toEqual([{ ...update, revision: 2, payload: { text: "latest" } }])
  })
})
