import { beforeEach, describe, expect, it, vi } from "vitest"

import { createV2EventStream, parseAfterSequence, type AgentStreamRedis } from "./v2-event-stream"

function event(sequence: bigint) {
  return {
    id: `event_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: "item_1", taskId: null,
    sequence, type: sequence === BigInt(2) ? "item.completed" : "item.started", actor: "orchestrator",
    correlationId: "turn_1", causationId: null, idempotencyKey: null, payload: { token: "secret", text: `state-${sequence}` },
  }
}

function db(rows: unknown[]) {
  return { agentEvent: { findMany: vi.fn().mockResolvedValue(rows) } }
}

function redis() {
  let calls = 0
  const connection: AgentStreamRedis = {
    xread: vi.fn().mockImplementation(async () => {
      calls += 1
      if (calls === 1) return [["agent:session:session_1:deltas", [["1-0", ["payload", JSON.stringify({
        schemaVersion: "agent-harness.v2", id: "delta_1", sessionId: "session_1", turnId: "turn_1", itemId: "item_1", taskId: null,
        type: "item.snapshot", actor: "orchestrator", correlationId: "turn_1", causationId: null, idempotencyKey: null,
        sequence: null, payload: { text: "latest", accessToken: "secret" }, kind: "snapshot", baseRevision: 0, revision: 1,
      })]]]]]
      return null
    }),
    disconnect: vi.fn(),
  }
  return connection
}

describe("V2 agent event stream", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("streams durable events from afterSequence and redacts their payload", async () => {
    const controller = new AbortController()
    const database = db([event(BigInt(2))])
    const stream = createV2EventStream(database as never, { sessionId: "session_1", afterSequence: BigInt(1), signal: controller.signal, redisFactory: () => null, dbPollMs: 1, heartbeatMs: 100 })
    const reader = stream.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain("event: item.completed")
    expect(text).toContain("id: 2")
    expect(text).toContain('"token":"[REDACTED]"')
    expect(database.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { sessionId: "session_1", sequence: { gt: BigInt(1) } } }))
    controller.abort()
    await reader.cancel()
  })

  it("bridges a transient snapshot without using its id as Last-Event-ID", async () => {
    const controller = new AbortController()
    const connection = redis()
    const stream = createV2EventStream(db([]) as never, { sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal, redisFactory: () => connection, dbPollMs: 1, heartbeatMs: 100 })
    const reader = stream.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text).toContain("event: item.snapshot")
    expect(text).toContain('"streamId":"1-0"')
    expect(text).not.toContain("id: 1-0")
    expect(text).toContain('"accessToken":"[REDACTED]"')
    controller.abort()
    await reader.cancel()
    expect(connection.disconnect).toHaveBeenCalled()
  })

  it("does not cancel execution when the request stream is aborted", async () => {
    const controller = new AbortController()
    const database = db([])
    controller.abort()
    const stream = createV2EventStream(database as never, { sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal, redisFactory: () => null, dbPollMs: 50, heartbeatMs: 100 })
    const reader = stream.getReader()
    await expect(reader.read()).resolves.toMatchObject({ done: true })
    expect(database.agentEvent.findMany).not.toHaveBeenCalled()
  })

  it("filters duplicate and out-of-order transient revisions per item", async () => {
    const controller = new AbortController()
    const makeDelta = (streamId: string, revision: number) => [streamId, ["payload", JSON.stringify({
      schemaVersion: "agent-harness.v2", id: `delta_${revision}`, sessionId: "session_1", turnId: "turn_1",
      itemId: "item_1", taskId: null, type: "item.delta", actor: "orchestrator", correlationId: "turn_1",
      causationId: null, idempotencyKey: null, sequence: null, payload: { text: `rev-${revision}` },
      kind: "delta", baseRevision: revision - 1, revision,
    })]]
    const connection: AgentStreamRedis = {
      xread: vi.fn()
        .mockResolvedValueOnce([["agent:session:session_1:deltas", [makeDelta("1-0", 2), makeDelta("2-0", 1), makeDelta("3-0", 2)]]])
        .mockResolvedValue(null),
      disconnect: vi.fn(),
    }
    const stream = createV2EventStream(db([]) as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => connection, dbPollMs: 1, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)

    expect(text).toContain('"streamId":"1-0"')
    expect(text).toContain('"revision":2')
    expect(text).not.toContain('"streamId":"2-0"')
    expect(connection.xread).toHaveBeenCalledWith(
      "COUNT", "64", "BLOCK", "1", "STREAMS", "agent:session:session_1:deltas", "3-0",
    )
    controller.abort()
    await reader.cancel()
  })

  it("parses Last-Event-ID as the durable reconnect cursor", () => {
    const result = parseAfterSequence(new Request("http://localhost/events", { headers: { "Last-Event-ID": "42" } }))
    expect(result).toBe(BigInt(42))
  })
})
