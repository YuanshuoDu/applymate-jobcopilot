import { beforeEach, describe, expect, it, vi } from "vitest"

import { createV2EventStream, parseAfterSequence, type AgentStreamRedis } from "./v2-event-stream"

function event(sequence: bigint) {
  return {
    id: `event_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: "item_1", taskId: null,
    sequence, type: sequence === BigInt(2) ? "item.completed" : "item.started", actor: "orchestrator",
    correlationId: "turn_1", causationId: null, idempotencyKey: null, payload: { token: "secret", text: `state-${sequence}` },
  }
}

function compactionEvent(sequence: bigint) {
  return {
    id: `compaction_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: null, taskId: "task_1",
    sequence, type: "context.compaction", actor: "orchestrator", correlationId: "step_1", causationId: null,
    idempotencyKey: "turn:turn_1:event:context-compaction:step_1",
    payload: {
      kind: "context_compacted", observationId: "context-compacted:step_1", status: "compacted", stepId: "step_1",
      idempotencyKey: "context-compaction:step_1", beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32,
      snapshotRef: "snapshot-private",
    },
  }
}

function lifecycleEvent(sequence: bigint, type: "session.paused" | "session.resumed") {
  const paused = type === "session.paused"
  return {
    id: `event_${sequence}`, sessionId: "session_1", turnId: null, itemId: null, taskId: null,
    sequence, type, actor: "system", correlationId: "session_1", causationId: null,
    idempotencyKey: `agent-session-control:client_${sequence}`,
    payload: {
      sessionId: "session_1", operation: paused ? "pause" : "resume",
      previousGate: paused ? "open" : "user_paused", nextGate: paused ? "user_paused" : "open",
      controlRevision: Number(sequence - BigInt(4)),
      pausedAt: paused ? "2026-09-15T00:00:00.000Z" : null,
    },
  }
}

function frameData(frame: string): Record<string, unknown> {
  const line = frame.split("\n").find((value) => value.startsWith("data: "))
  if (!line) throw new Error("SSE frame did not contain data")
  return JSON.parse(line.slice("data: ".length)) as Record<string, unknown>
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

  it("projects durable context compaction events to safe metric payloads", async () => {
    const controller = new AbortController()
    const database = db([compactionEvent(BigInt(3))])
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(2), signal: controller.signal, redisFactory: () => null, dbPollMs: 1, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)
    const frame = frameData(text)

    expect(text).toContain("event: context.compaction\nid: 3\n")
    expect(frame.payload).toEqual({ kind: "context_compacted", status: "compacted", beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32 })
    expect(JSON.stringify(frame)).not.toMatch(/snapshot-private|observationId|stepId|idempotencyKey|errorCode/)
    controller.abort()
    await reader.cancel()
  })

  it("skips invalid context compaction rows while advancing the durable cursor", async () => {
    const controller = new AbortController()
    const invalid = { ...compactionEvent(BigInt(5)), payload: { ...compactionEvent(BigInt(5)).payload, afterInputTokens: 20 } }
    const database = db([])
    database.agentEvent.findMany.mockImplementation(async (args: { where: { sequence: { gt: bigint } } }) => {
      return args.where.sequence.gt === BigInt(0) ? [invalid] : [event(BigInt(6))]
    })
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal, redisFactory: () => null, dbPollMs: 1, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)

    expect(text).toContain("event: item.started\nid: 6\n")
    expect(text).not.toContain("compaction_5")
    expect(database.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", sequence: { gt: BigInt(5) } },
    }))
    controller.abort()
    await reader.cancel()
  })

  it("streams session lifecycle events with durable sequence IDs and null turn scope", async () => {
    const controller = new AbortController()
    const database = db([lifecycleEvent(BigInt(5), "session.paused"), lifecycleEvent(BigInt(6), "session.resumed")])
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(4), signal: controller.signal,
      redisFactory: () => null, dbPollMs: 50, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    const paused = new TextDecoder().decode((await reader.read()).value)
    const resumed = new TextDecoder().decode((await reader.read()).value)
    expect(paused).toContain("event: session.paused\nid: 5\n")
    expect(resumed).toContain("event: session.resumed\nid: 6\n")
    expect(frameData(paused)).toMatchObject({
      type: "session.paused", sessionId: "session_1", turnId: null, itemId: null, taskId: null,
      actor: "system", correlationId: "session_1", sequence: "5",
      payload: {
        sessionId: "session_1", operation: "pause", previousGate: "open", nextGate: "user_paused",
        controlRevision: 1, pausedAt: "2026-09-15T00:00:00.000Z",
      },
    })
    expect(frameData(resumed)).toMatchObject({
      type: "session.resumed", sessionId: "session_1", turnId: null, itemId: null, taskId: null,
      actor: "system", correlationId: "session_1", sequence: "6",
      payload: {
        sessionId: "session_1", operation: "resume", previousGate: "user_paused", nextGate: "open",
        controlRevision: 2, pausedAt: null,
      },
    })
    expect(database.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", sequence: { gt: BigInt(4) } },
    }))
    controller.abort()
    await reader.cancel()
  })

  it("uses the durable sequence cursor to resume after the last lifecycle event", async () => {
    const controller = new AbortController()
    const database = db([lifecycleEvent(BigInt(6), "session.resumed")])
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(5), signal: controller.signal,
      redisFactory: () => null, dbPollMs: 50, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    const resumed = new TextDecoder().decode((await reader.read()).value)
    expect(resumed).toContain("event: session.resumed\nid: 6\n")
    expect(resumed).not.toContain("session.paused")
    expect(database.agentEvent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: "session_1", sequence: { gt: BigInt(5) } },
    }))
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
