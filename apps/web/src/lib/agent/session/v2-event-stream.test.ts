import { beforeEach, describe, expect, it, vi } from "vitest"

import { createV2EventStream, parseAfterSequence, type AgentStreamRedis } from "./v2-event-stream"
import { publicAgentEventId, publicIdempotencyKey, publicToolCallId, publicToolItemId } from "./public-tool-identity"
import type { AgentEventPubSubRedis } from "./event-wakeup"

function event(sequence: bigint) {
  return {
    id: `event_${sequence}`, sessionId: "session_1", turnId: "turn_1", itemId: "item_1", taskId: null,
    sequence, type: sequence === BigInt(2) ? "item.completed" : "item.started", actor: "orchestrator",
    correlationId: "turn_1", causationId: null, idempotencyKey: null, payload: { token: "secret", text: `state-${sequence}` },
  }
}

function taskGraphPayload() {
  return {
    kind: "lifecycle", event: { type: "task.completed", nodeKey: "research" }, revision: 1, item: {
      schemaVersion: "agent-harness.v2", id: "graph_1", sessionId: "session_1", turnId: "turn_1",
      stepId: null, taskId: "root_task_1", type: "task_graph", status: "streaming", phase: null, revision: 1,
      content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [{
        key: "research", templateId: "jobs.search", goal: "Review role; Bearer very-secret-token",
        successCriteria: ["Summarize fit"], dependsOn: [], depth: 1, taskId: "child_task_1",
      }] },
      startedAt: "2026-09-28T00:00:00.000Z", completedAt: null,
      createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z",
    },
  }
}

function goalFromFrame(text: string): unknown {
  const data = text.split("data: ")[1]?.split("\n")[0]
  if (!data) throw new Error("Stream frame is missing its data payload")
  const frame = JSON.parse(data) as { payload?: { item?: { content?: { nodes?: Array<{ goal?: unknown }> } } } }
  return frame.payload?.item?.content?.nodes?.[0]?.goal
}

function db(rows: unknown[]) {
  return {
    agentEvent: { findMany: vi.fn().mockResolvedValue(rows) },
    agentItem: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map(id => ({ id, type: "agent_message" }))) },
  }
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

function eventRedis(options: { subscribe?: () => Promise<unknown> } = {}) {
  let messageListener: ((channel: string, message: string) => void) | undefined
  let errorListener: ((error: unknown) => void) | undefined
  const connection = {
    subscribe: vi.fn(options.subscribe ?? (async () => 1)),
    unsubscribe: vi.fn(async () => 0),
    onMessage: vi.fn(listener => { messageListener = listener }),
    onError: vi.fn(listener => { errorListener = listener }),
    removeMessageListener: vi.fn(listener => { if (messageListener === listener) messageListener = undefined }),
    removeErrorListener: vi.fn(listener => { if (errorListener === listener) errorListener = undefined }),
    disconnect: vi.fn(),
  } satisfies AgentEventPubSubRedis
  return {
    connection,
    emit(channel: string, message: string) { messageListener?.(channel, message) },
    fail(error: unknown) { errorListener?.(error) },
  }
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1))
  if (!condition()) throw new Error("Timed out waiting for test condition")
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

  it("projects raw call, item, event, cause, and idempotency identities on durable SSE", async () => {
    const rawCallId = "+353851234567"
    const callItemId = `turn:turn_1:item:tool-call:${rawCallId}:call-suffix`
    const resultItemId = `turn:turn_1:item:tool-result:${rawCallId}:result-suffix`
    const eventIds = [
      `turn:turn_1:event:item-started:${callItemId}`,
      `turn:turn_1:event:tool-started:${rawCallId}`,
      `turn:turn_1:event:item-completed:${callItemId}`,
      `turn:turn_1:event:item-started:${resultItemId}`,
      `turn:turn_1:event:item-completed:${resultItemId}`,
    ]
    const base = (sequence: number, id: string, itemId: string, type: string, correlationId: string, payload: unknown, causationId: string | null = null) => ({
      id, sessionId: "session_1", turnId: "turn_1", itemId, taskId: "root-task", sequence: BigInt(sequence), type,
      actor: "orchestrator", correlationId, causationId, idempotencyKey: `idem:${rawCallId}:${sequence}`, payload,
    })
    const rows = [
      base(1, eventIds[0]!, callItemId, "item.started", callItemId, { itemId: callItemId, type: "tool_call", phase: null }),
      base(2, eventIds[1]!, callItemId, "tool_call.started", rawCallId, { toolCallId: rawCallId, toolName: "jobs.search", taskId: "root-task" }, eventIds[0]!),
      base(3, eventIds[2]!, callItemId, "item.completed", callItemId, { itemId: callItemId, status: "completed", content: { toolCallId: rawCallId, toolName: "jobs.search", toolVersion: "1", status: "completed", input: { query: "engineer" } } }, eventIds[1]!),
      base(4, eventIds[3]!, resultItemId, "item.started", resultItemId, { itemId: resultItemId, type: "tool_result", phase: null }, eventIds[2]!),
      base(5, eventIds[4]!, resultItemId, "item.completed", resultItemId, { itemId: resultItemId, status: "completed", content: { toolCallId: rawCallId, output: { count: 2 }, errorCode: null } }, eventIds[3]!),
    ]
    const database = db(rows)
    database.agentItem.findMany.mockResolvedValue([{ id: callItemId, type: "tool_call" }, { id: resultItemId, type: "tool_result" }])
    const controller = new AbortController()
    const stream = createV2EventStream(database as never, { sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal, redisFactory: () => null, dbPollMs: 1, heartbeatMs: 60_000 })
    const reader = stream.getReader()
    let events: Array<{ id: string; itemId: string | null; correlationId: string; causationId: string | null; idempotencyKey: string | null; payload: Record<string, unknown> }> = []
    try {
      const frames: string[] = []
      for (let index = 0; index < rows.length; index += 1) frames.push(new TextDecoder().decode((await reader.read()).value))
      const text = frames.join("")
      events = frames.map(frame => JSON.parse(frame.split("data: ")[1]!.split("\n")[0]!) as typeof events[number])
      const callAlias = publicToolCallId("session_1", "turn_1", rawCallId)
      const callItemAlias = publicToolItemId("session_1", "turn_1", callItemId)
      const resultItemAlias = publicToolItemId("session_1", "turn_1", resultItemId)
      expect(text).not.toContain(rawCallId)
      expect(text).not.toContain(callItemId)
      expect(text).not.toContain(resultItemId)
      expect(events[0]).toMatchObject({ id: publicAgentEventId("session_1", eventIds[0]!), itemId: callItemAlias, correlationId: callItemAlias, payload: { itemId: callItemAlias } })
      expect(events[1]).toMatchObject({ id: publicAgentEventId("session_1", eventIds[1]!), itemId: callItemAlias, correlationId: callAlias, causationId: events[0]!.id, payload: { toolCallId: callAlias } })
      expect(events[2]).toMatchObject({ idempotencyKey: publicIdempotencyKey("session_1", `idem:${rawCallId}:3`), payload: { content: { toolCallId: callAlias } } })
      expect(events[3]).toMatchObject({ itemId: resultItemAlias, correlationId: resultItemAlias, payload: { itemId: resultItemAlias } })
      expect(events[4]).toMatchObject({ itemId: resultItemAlias, payload: { content: { toolCallId: callAlias } } })
      expect(frames.map(frame => frame.match(/\nid: (\d+)\n/)?.[1])).toEqual(["1", "2", "3", "4", "5"])
      expect(database.agentItem.findMany).toHaveBeenCalledTimes(1)
      expect(database.agentItem.findMany).toHaveBeenCalledWith({ where: { sessionId: "session_1", id: { in: [callItemId, resultItemId] } }, select: { id: true, type: true } })
    } finally {
      controller.abort()
      await reader.cancel()
    }
    const reconnectController = new AbortController()
    const reconnect = createV2EventStream(database as never, { sessionId: "session_1", afterSequence: BigInt(3), signal: reconnectController.signal, redisFactory: () => null, dbPollMs: 1, heartbeatMs: 60_000 })
    const reconnectReader = reconnect.getReader()
    try {
      const resumed = [
        JSON.parse(new TextDecoder().decode((await reconnectReader.read()).value).split("data: ")[1]!.split("\n")[0]!) as typeof events[number],
        JSON.parse(new TextDecoder().decode((await reconnectReader.read()).value).split("data: ")[1]!.split("\n")[0]!) as typeof events[number],
      ]
      expect(resumed.map(item => item.id)).toEqual([events[3]!.id, events[4]!.id])
      expect(resumed.map(item => item.itemId)).toEqual([events[3]!.itemId, events[4]!.itemId])
      expect(resumed.map(item => item.itemId)).toEqual([publicToolItemId("session_1", "turn_1", resultItemId), publicToolItemId("session_1", "turn_1", resultItemId)])
      expect(database.agentEvent.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { sessionId: "session_1", sequence: { gt: BigInt(3) } } }))
    } finally {
      reconnectController.abort()
      await reconnectReader.cancel()
    }
  })

  it("fails closed for an item event whose canonical item type is missing", async () => {
    const rawItemId = "turn:turn_1:item:tool-call:private.user@example.com:missing"
    const database = db([{
      id: `event:${rawItemId}`, sessionId: "session_1", turnId: "turn_1", itemId: rawItemId, taskId: null,
      sequence: BigInt(9), type: "item.failed", actor: "orchestrator", correlationId: rawItemId,
      causationId: null, idempotencyKey: `idem:${rawItemId}`, payload: { itemId: rawItemId, errorCode: "tool_execution_failed" },
    }])
    database.agentItem.findMany.mockResolvedValueOnce([])
    const controller = new AbortController()
    const stream = createV2EventStream(database as never, { sessionId: "session_1", afterSequence: BigInt(8), signal: controller.signal, redisFactory: () => null, dbPollMs: 1, heartbeatMs: 60_000 })
    const reader = stream.getReader()
    try {
      const text = new TextDecoder().decode((await reader.read()).value)
      const frame = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!) as { id: string; itemId: string | null; payload: unknown }
      expect(text).not.toContain(rawItemId)
      expect(text).toContain("id: 9")
      expect(frame.itemId).toBeNull()
      expect(frame.payload).toBeNull()
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it("retries a durable item event after its item-type lookup fails without consuming the sequence", async () => {
    const rawItemId = "turn:turn_1:item:tool-call:private-call-id"
    const row = {
      id: "event-private-call-id", sessionId: "session_1", turnId: "turn_1", itemId: rawItemId, taskId: null,
      sequence: BigInt(9), type: "item.failed", actor: "orchestrator", correlationId: rawItemId,
      causationId: null, idempotencyKey: null, payload: { errorCode: "tool_execution_failed" },
    }
    const database = db([row])
    database.agentItem.findMany
      .mockRejectedValueOnce(new Error("temporary item lookup failure"))
      .mockResolvedValueOnce([{ id: rawItemId, type: "tool_call" }])
    const controller = new AbortController()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(8), signal: controller.signal,
      redisFactory: () => null, dbPollMs: 1, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    try {
      await waitFor(() => database.agentItem.findMany.mock.calls.length >= 2)
      const text = new TextDecoder().decode((await reader.read()).value)
      const frame = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!) as { itemId: string | null }
      expect(text).toContain("id: 9")
      expect(text).not.toContain(rawItemId)
      expect(frame.itemId).toBe(publicToolItemId("session_1", "turn_1", rawItemId))
      expect(database.agentEvent.findMany.mock.calls.slice(0, 2).map(call => call[0].where.sequence.gt))
        .toEqual([BigInt(8), BigInt(8)])
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it("omits private durable verification events and advances the database cursor", async () => {
    const controller = new AbortController()
    const marker = "native-private-control-marker"
    const privateEvent = (sequence: bigint, type: string, suffix: string) => {
      const chronologyWitness = type === "agent.plan.root_task_history_chronology_witness"
      const boundaryEventId = chronologyWitness ? "PRIVATE_CHRONOLOGY_BOUNDARY_EVENT" : `private-causation-${suffix}`
      return {
        id: chronologyWitness ? "private-root-task-history-chronology-event" : "private-event-" + suffix,
        sessionId: "session_1", turnId: "turn_1",
        itemId: chronologyWitness ? null : "private-item-" + suffix,
        taskId: chronologyWitness ? "private-root-task" : "private-task-" + suffix,
        sequence, type, actor: chronologyWitness ? "orchestrator" : "system",
        correlationId: chronologyWitness ? "private-root-task" : "private-correlation-" + suffix,
        causationId: chronologyWitness ? boundaryEventId : `private-causation-${suffix}`,
        idempotencyKey: chronologyWitness
          ? `root-task-history-chronology-witness:turn_start:${boundaryEventId}:v1`
          : "private-idempotency-" + suffix,
        payload: {
          stepId: "private-step-" + suffix, controlTaskId: "private-control-" + suffix,
          controlOperationId: marker, goalDigest: marker, evidencePacketDigest: marker,
          reference: marker, sentinel: marker,
          ...(type === "native_verification.scheduled_candidate_staged" ? { candidateText: "PRIVATE_SCHEDULED_FINAL_CANDIDATE" } : {}),
          ...(type === "agent.plan.discovery_persona_snapshot" ? { projection: { facts: [{ value: "PRIVATE_DISCOVERY_FACT_VALUE" }] } } : {}),
          ...(type === "agent.plan.discovery_persona_overflow" ? { observedFactCount: 33, rawValue: "PRIVATE_OVERFLOW_VALUE" } : {}),
          ...(type === "agent.plan.root_task_history_session_authorization" ? { snapshotKey: "PRIVATE_HISTORY_AUTHORIZATION_KEY" } : {}),
          ...(type === "agent.plan.root_task_history_memory_snapshot" ? { id: "root-task-history", value: "PRIVATE_ROOT_TASK_HISTORY_VALUE" } : {}),
          ...(chronologyWitness ? {
            schemaVersion: "agent-harness.v2.root-task-history-chronology-witness.v1",
            boundary: "turn_start", boundaryEventId, xid8: "90000000000000001",
          } : {}),
        },
      }
    }
    const rejection = {
      id: "public-rejection-event", sessionId: "session_1", turnId: "turn_1", itemId: null,
      taskId: "public-root-task", sequence: BigInt(7), type: "final.rejected", actor: "orchestrator",
      correlationId: "turn_1", causationId: null, idempotencyKey: "final-rejected:step_1",
      payload: {
        code: "business_precondition_failed", blocker: "task_graph_verification_unverified",
        feedback: "Current task graph requirements are incomplete", taskId: "public-root-task",
      },
    }
    const visible = {
      id: "ordinary-event", sessionId: "session_1", turnId: "turn_1", itemId: "ordinary-item",
      taskId: "ordinary-task", sequence: BigInt(8), type: "item.completed", actor: "orchestrator",
      correlationId: "ordinary-correlation", causationId: null, idempotencyKey: "ordinary-idempotency",
      payload: { text: "ordinary event remains visible" },
    }
    const database = db([])
    const cursors: bigint[] = []
    let calls = 0
    database.agentEvent.findMany.mockImplementation(async (args: { where: { sequence: { gt: bigint } } }) => {
      cursors.push(args.where.sequence.gt)
      calls += 1
      return calls === 1
        ? [
            privateEvent(BigInt(2), "native_verification.requested", "request"),
            privateEvent(BigInt(3), "native_verification.scheduled_candidate_staged", "candidate"),
          ]
        : calls === 2
          ? [
              privateEvent(BigInt(4), "agent.plan.reconciliation", "reconciliation"),
              { ...privateEvent(BigInt(5), "agent.plan.clarification", "clarification"), itemId: null },
            ]
          : [
              privateEvent(BigInt(6), "agent.plan.discovery_persona_snapshot", "discovery-snapshot"),
              privateEvent(BigInt(7), "agent.plan.discovery_persona_overflow", "discovery-overflow"),
              privateEvent(BigInt(8), "agent.plan.root_task_history_session_authorization", "history-authorization"),
              privateEvent(BigInt(9), "agent.plan.root_task_history_memory_snapshot", "history-snapshot"),
              privateEvent(BigInt(10), "agent.plan.root_task_history_chronology_witness", "history-chronology"),
              {
                ...privateEvent(BigInt(11), "agent.plan.denial_checkpoint", "denial-checkpoint"),
                itemId: null,
                payload: {
                  schemaVersion: "agent-harness.v2.task-graph-denial-checkpoint.v1",
                  taskId: "private-checkpoint-task",
                  stepId: "private-checkpoint-step",
                  graphRevision: 23,
                  verificationDigest: marker,
                },
              },
              { ...rejection, sequence: BigInt(12) },
              { ...visible, sequence: BigInt(13) },
            ]
    })
    const pubsub = eventRedis()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => null, eventRedisFactory: () => pubsub.connection,
      dbPollMs: 60_000, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    try {
      await waitFor(() => cursors.length === 1 && pubsub.connection.subscribe.mock.calls.length === 1)
      pubsub.emit("agent:session:session_1:events", "wake")
      await waitFor(() => cursors.length === 2)
      pubsub.emit("agent:session:session_1:events", "wake")

      const decoder = new TextDecoder()
      const text = decoder.decode((await reader.read()).value) + decoder.decode((await reader.read()).value)
      expect(text).toContain("event: item.completed")
      expect(text).toContain("event: final.rejected")
      expect(text).toContain("task_graph_verification_unverified")
      expect(text).toContain("Current task graph requirements are incomplete")
      expect(text).toContain("ordinary event remains visible")
      expect(text).toContain("ordinary-task")
      expect(text).not.toContain("native_verification.")
      expect(text).not.toContain("agent.plan.reconciliation")
      expect(text).not.toContain("agent.plan.clarification")
      expect(text).not.toContain("agent.plan.denial_checkpoint")
      expect(text).not.toContain("agent.plan.discovery_persona_snapshot")
      expect(text).not.toContain("agent.plan.discovery_persona_overflow")
      expect(text).not.toContain("agent.plan.root_task_history_session_authorization")
      expect(text).not.toContain("agent.plan.root_task_history_memory_snapshot")
      expect(text).not.toContain("agent.plan.root_task_history_chronology_witness")
      expect(text).not.toContain('"verificationDigest"')
      expect(text).not.toContain('"graphRevision"')
      expect(text).not.toContain("task-graph-denial-checkpoint.v1")
      expect(text).not.toContain(marker)
      expect(text).not.toContain("PRIVATE_SCHEDULED_FINAL_CANDIDATE")
      expect(text).not.toContain("PRIVATE_DISCOVERY_FACT_VALUE")
      expect(text).not.toContain("PRIVATE_OVERFLOW_VALUE")
      expect(text).not.toContain("PRIVATE_HISTORY_AUTHORIZATION_KEY")
      expect(text).not.toContain("PRIVATE_ROOT_TASK_HISTORY_VALUE")
      expect(text).not.toContain("PRIVATE_CHRONOLOGY_BOUNDARY_EVENT")
      expect(text).not.toContain("90000000000000001")
      expect(text).not.toContain("root-task-history")
      expect(text).not.toContain("private-event-")
      expect(text).not.toContain("private-item-")
      expect(text).not.toContain("private-task-")
      expect(text).not.toContain("private-step-")
      expect(text).not.toContain("private-idempotency-")
      expect(text).not.toContain("private-checkpoint-task")
      expect(text).not.toContain("private-checkpoint-step")
      expect(cursors).toEqual([BigInt(0), BigInt(3), BigInt(5)])
    } finally {
      controller.abort()
      await reader.cancel()
      await waitFor(() => pubsub.connection.disconnect.mock.calls.length === 1)
    }
    expect(pubsub.connection.unsubscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    expect(pubsub.connection.removeMessageListener).toHaveBeenCalledTimes(1)
    expect(pubsub.connection.removeErrorListener).toHaveBeenCalledTimes(1)
  })

  it("skips private transient namespaces while advancing the Redis cursor", async () => {
    const controller = new AbortController()
    const marker = "native-private-delta-marker"
    const privateEnvelope = {
      schemaVersion: "agent-harness.v2", id: "private-delta-event", sessionId: "session_1",
      turnId: "turn_1", itemId: "private-item", taskId: "private-task", type: "native_verification.scheduled_candidate_staged",
      actor: "system", correlationId: "private-correlation", causationId: "private-causation",
      idempotencyKey: "private-idempotency", sequence: null,
      payload: { stepId: "private-step", controlOperationId: marker, goalDigest: marker, evidencePacketDigest: marker, candidateText: "PRIVATE_DELTA_FINAL_CANDIDATE" },
      kind: "snapshot", baseRevision: 0, revision: 1,
    }
    const privateReconciliationEnvelope = {
      ...privateEnvelope, id: "private-reconciliation-event", type: "agent.plan.reconciliation",
    }
    const privateClarificationEnvelope = {
      ...privateEnvelope, id: "private-clarification-event", type: "agent.plan.clarification",
    }
    const privateDenialCheckpointEnvelope = {
      ...privateEnvelope,
      id: "private-denial-checkpoint-event",
      type: "agent.plan.denial_checkpoint",
      payload: {
        schemaVersion: "agent-harness.v2.task-graph-denial-checkpoint.v1",
        taskId: "private-denial-task",
        stepId: "private-denial-step",
        graphRevision: 23,
        verificationDigest: marker,
      },
    }
    const privateDiscoverySnapshotEnvelope = {
      ...privateEnvelope, id: "private-discovery-snapshot-event", type: "agent.plan.discovery_persona_snapshot",
      payload: { projection: { facts: [{ factId: "fact-1", value: "PRIVATE_DISCOVERY_FACT_VALUE" }] } },
    }
    const privateDiscoveryOverflowEnvelope = {
      ...privateEnvelope, id: "private-discovery-overflow-event", type: "agent.plan.discovery_persona_overflow",
      payload: { observedFactCount: 33, rawValue: "PRIVATE_OVERFLOW_VALUE" },
    }
    const privateRootTaskHistoryAuthorizationEnvelope = {
      ...privateEnvelope, id: "private-root-task-history-authorization-event",
      type: "agent.plan.root_task_history_session_authorization",
      payload: { snapshotKey: "PRIVATE_HISTORY_AUTHORIZATION_KEY" },
    }
    const privateRootTaskHistorySnapshotEnvelope = {
      ...privateEnvelope, id: "private-root-task-history-snapshot-event",
      type: "agent.plan.root_task_history_memory_snapshot",
      payload: { id: "root-task-history", value: "PRIVATE_ROOT_TASK_HISTORY_VALUE" },
    }
    const privateRootTaskHistoryChronologyEnvelope = {
      ...privateEnvelope, id: "private-root-task-history-chronology-event", itemId: null, taskId: "root-task-1",
      type: "agent.plan.root_task_history_chronology_witness", actor: "orchestrator", correlationId: "root-task-1",
      causationId: "PRIVATE_CHRONOLOGY_BOUNDARY_EVENT",
      idempotencyKey: "root-task-history-chronology-witness:turn_start:PRIVATE_CHRONOLOGY_BOUNDARY_EVENT:v1",
      payload: { schemaVersion: "agent-harness.v2.root-task-history-chronology-witness.v1", boundary: "turn_start",
        boundaryEventId: "PRIVATE_CHRONOLOGY_BOUNDARY_EVENT", xid8: "90000000000000001" },
    }
    const visibleEnvelope = {
      schemaVersion: "agent-harness.v2", id: "ordinary-delta-event", sessionId: "session_1",
      turnId: "turn_1", itemId: "ordinary-item", taskId: "ordinary-task", type: "item.snapshot",
      actor: "orchestrator", correlationId: "ordinary-correlation", causationId: null,
      idempotencyKey: "ordinary-idempotency", sequence: null,
      payload: { text: "ordinary transient event remains visible" },
      kind: "snapshot", baseRevision: 0, revision: 1,
    }
    const entry = (streamId: string, envelope: unknown) => [streamId, ["payload", JSON.stringify(envelope)]]
    const disconnect = vi.fn()
    const connection: AgentStreamRedis = {
      xread: vi.fn()
        .mockResolvedValueOnce([["agent:session:session_1:deltas", [
          entry("1-0", privateEnvelope), entry("2-0", privateReconciliationEnvelope), entry("3-0", privateClarificationEnvelope),
          entry("4-0", privateDenialCheckpointEnvelope), entry("5-0", privateDiscoverySnapshotEnvelope), entry("6-0", privateDiscoveryOverflowEnvelope),
          entry("7-0", privateRootTaskHistoryAuthorizationEnvelope), entry("8-0", privateRootTaskHistorySnapshotEnvelope),
          entry("9-0", privateRootTaskHistoryChronologyEnvelope),
        ]]])
        .mockResolvedValueOnce([["agent:session:session_1:deltas", [entry("10-0", visibleEnvelope)]]])
        .mockImplementation(() => new Promise(resolve => {
          if (controller.signal.aborted) return resolve(null)
          controller.signal.addEventListener("abort", () => resolve(null), { once: true })
        })),
      disconnect,
    }
    const stream = createV2EventStream(db([]) as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => connection, dbPollMs: 1, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    try {
      const text = new TextDecoder().decode((await reader.read()).value)
      expect(text).toContain("event: item.snapshot")
      expect(text).toContain('"streamId":"10-0"')
      expect(text).toContain("ordinary transient event remains visible")
      expect(text).not.toContain("native_verification.")
      expect(text).not.toContain("agent.plan.reconciliation")
      expect(text).not.toContain("agent.plan.clarification")
      expect(text).not.toContain("agent.plan.denial_checkpoint")
      expect(text).not.toContain("agent.plan.discovery_persona_snapshot")
      expect(text).not.toContain("agent.plan.discovery_persona_overflow")
      expect(text).not.toContain("agent.plan.root_task_history_session_authorization")
      expect(text).not.toContain("agent.plan.root_task_history_memory_snapshot")
      expect(text).not.toContain("agent.plan.root_task_history_chronology_witness")
      expect(text).not.toContain('"verificationDigest"')
      expect(text).not.toContain('"graphRevision"')
      expect(text).not.toContain("task-graph-denial-checkpoint.v1")
      expect(text).not.toContain(marker)
      expect(text).not.toContain("PRIVATE_DELTA_FINAL_CANDIDATE")
      expect(text).not.toContain("PRIVATE_DISCOVERY_FACT_VALUE")
      expect(text).not.toContain("PRIVATE_OVERFLOW_VALUE")
      expect(text).not.toContain("PRIVATE_HISTORY_AUTHORIZATION_KEY")
      expect(text).not.toContain("PRIVATE_ROOT_TASK_HISTORY_VALUE")
      expect(text).not.toContain("PRIVATE_CHRONOLOGY_BOUNDARY_EVENT")
      expect(text).not.toContain("90000000000000001")
      expect(text).not.toContain("root-task-history")
      expect(text).not.toContain("private-delta-event")
      expect(text).not.toContain("private-clarification-event")
      expect(text).not.toContain("private-denial-checkpoint-event")
      expect(text).not.toContain("private-root-task-history-authorization-event")
      expect(text).not.toContain("private-root-task-history-snapshot-event")
      expect(text).not.toContain("private-root-task-history-chronology-event")
      expect(text).not.toContain("private-denial-task")
      expect(text).not.toContain("private-denial-step")
      expect(text).not.toContain("private-item")
      expect(text).not.toContain("private-task")
      expect(text).not.toContain("private-step")
      expect(text).not.toContain("private-idempotency")
      expect(connection.xread).toHaveBeenNthCalledWith(
        1, "COUNT", "64", "BLOCK", "1", "STREAMS", "agent:session:session_1:deltas", "$",
      )
      expect(connection.xread).toHaveBeenNthCalledWith(
        2, "COUNT", "64", "BLOCK", "1", "STREAMS", "agent:session:session_1:deltas", "8-0",
      )
    } finally {
      controller.abort()
      await reader.cancel()
    }
    await waitFor(() => disconnect.mock.calls.length === 1)
  })
  it("preserves a valid redacted TaskGraph item in a durable item.delta", async () => {
    const controller = new AbortController()
    const database = db([{
      id: "graph-event", sessionId: "session_1", turnId: "turn_1", itemId: "graph_1", taskId: "child_task_1",
      sequence: BigInt(1), type: "item.delta", actor: "system", correlationId: "turn_1", causationId: null,
      idempotencyKey: "graph-revision-1", payload: taskGraphPayload(),
    }])
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => null, dbPollMs: 1, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    try {
      const text = new TextDecoder().decode((await reader.read()).value)
      expect(goalFromFrame(text)).toBe("Review role; Bearer [REDACTED]")
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it("preserves a valid redacted TaskGraph item in a transient item.delta", async () => {
    const controller = new AbortController()
    const envelope = {
      schemaVersion: "agent-harness.v2", id: "graph-delta", sessionId: "session_1", turnId: "turn_1",
      itemId: "graph_1", taskId: "child_task_1", type: "item.delta", actor: "system", correlationId: "turn_1",
      causationId: null, idempotencyKey: "graph-revision-1", sequence: null, payload: taskGraphPayload(),
      kind: "snapshot", baseRevision: 0, revision: 1,
    }
    const connection: AgentStreamRedis = {
      xread: vi.fn()
        .mockResolvedValueOnce([["agent:session:session_1:deltas", [["1-0", ["payload", JSON.stringify(envelope)]]]]])
        .mockImplementation(() => new Promise(resolve => {
          if (controller.signal.aborted) return resolve(null)
          controller.signal.addEventListener("abort", () => resolve(null), { once: true })
        })),
      disconnect: vi.fn(),
    }
    const stream = createV2EventStream(db([]) as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => connection, dbPollMs: 1, heartbeatMs: 100,
    })
    const reader = stream.getReader()
    try {
      const text = new TextDecoder().decode((await reader.read()).value)
      expect(goalFromFrame(text)).toBe("Review role; Bearer [REDACTED]")
    } finally {
      controller.abort()
      await reader.cancel()
    }
  })

  it("uses the session event channel as a durable database poll wakeup", async () => {
    const controller = new AbortController()
    const database = db([])
    let calls = 0
    database.agentEvent.findMany.mockImplementation(async () => {
      calls += 1
      return calls === 1 ? [] : [event(BigInt(2))]
    })
    const pubsub = eventRedis()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => null, eventRedisFactory: () => pubsub.connection, dbPollMs: 60_000, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    await waitFor(() => pubsub.connection.subscribe.mock.calls.length === 1)

    pubsub.emit("agent:session:session_1:events", "malformed payload is ignored")
    const text = new TextDecoder().decode((await reader.read()).value)

    expect(text).toContain("event: item.completed\nid: 2\n")
    expect(text).not.toContain("malformed payload")
    expect(database.agentEvent.findMany).toHaveBeenCalledTimes(2)
    controller.abort()
    await reader.cancel()
  })

  it("keeps duplicate and out-of-order Pub/Sub hints behind the database cursor", async () => {
    const controller = new AbortController()
    const database = db([])
    const cursors: bigint[] = []
    let calls = 0
    database.agentEvent.findMany.mockImplementation(async (args: { where: { sequence: { gt: bigint } } }) => {
      cursors.push(args.where.sequence.gt)
      calls += 1
      return calls === 1 ? [event(BigInt(2))] : []
    })
    const pubsub = eventRedis()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(1), signal: controller.signal,
      redisFactory: () => null, eventRedisFactory: () => pubsub.connection, dbPollMs: 60_000, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    await waitFor(() => pubsub.connection.subscribe.mock.calls.length === 1)

    pubsub.emit("agent:session:session_1:events", JSON.stringify({ sequence: "99" }))
    pubsub.emit("agent:session:session_1:events", JSON.stringify({ sequence: "1" }))
    await waitFor(() => cursors.length >= 2)

    expect(first).toContain("id: 2")
    expect(cursors[0]).toBe(BigInt(1))
    expect(cursors.slice(1).every(cursor => cursor === BigInt(2))).toBe(true)
    controller.abort()
    await reader.cancel()
  })

  it("keeps the PostgreSQL fallback when the Pub/Sub connection fails", async () => {
    const controller = new AbortController()
    const database = db([event(BigInt(2))])
    const pubsub = eventRedis({ subscribe: vi.fn().mockRejectedValue(new Error("redis unavailable")) })
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(1), signal: controller.signal,
      redisFactory: () => null, eventRedisFactory: () => pubsub.connection, dbPollMs: 1, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    const text = new TextDecoder().decode((await reader.read()).value)

    expect(text).toContain("event: item.completed\nid: 2\n")
    expect(pubsub.connection.subscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    expect(database.agentEvent.findMany).toHaveBeenCalled()
    controller.abort()
    await reader.cancel()
  })

  it("cleans up the independent Pub/Sub subscriber on abort", async () => {
    const controller = new AbortController()
    const database = db([])
    const pubsub = eventRedis()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => null, eventRedisFactory: () => pubsub.connection, dbPollMs: 60_000, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    await waitFor(() => pubsub.connection.subscribe.mock.calls.length === 1)

    controller.abort()
    await reader.cancel()
    await waitFor(() => pubsub.connection.disconnect.mock.calls.length === 1)

    expect(pubsub.connection.unsubscribe).toHaveBeenCalledWith("agent:session:session_1:events")
    expect(pubsub.connection.removeMessageListener).toHaveBeenCalledTimes(1)
    expect(pubsub.connection.removeErrorListener).toHaveBeenCalledTimes(1)
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

  it("projects nested tool-item snapshots and keeps reconnect identity stable", async () => {
    const rawCallId = "Bearer sk-secret123456"
    const rawItemId = `turn:turn_1:item:tool-call:${rawCallId}:snapshot-suffix`
    const eventId = `delta:${rawCallId}`
    const envelope = {
      schemaVersion: "agent-harness.v2", id: eventId, sessionId: "session_1", turnId: "turn_1", itemId: rawItemId,
      taskId: "root-task", type: "item.snapshot", actor: "orchestrator", correlationId: rawItemId,
      causationId: "cause:" + rawCallId, idempotencyKey: "idem:" + rawCallId, sequence: null,
      payload: { item: {
        schemaVersion: "agent-harness.v2", id: rawItemId, sessionId: "session_1", turnId: "turn_1", stepId: "step_1",
        taskId: "root-task", type: "tool_call", status: "started", phase: null, revision: 1,
        content: { toolCallId: rawCallId, toolName: "jobs.search", toolVersion: "1", input: { query: "engineer" } },
        startedAt: "2026-10-29T00:00:00.000Z", completedAt: null, createdAt: "2026-10-29T00:00:00.000Z", updatedAt: "2026-10-29T00:00:00.000Z",
      } },
      kind: "snapshot", baseRevision: 0, revision: 1,
    }
    const connection: AgentStreamRedis = {
      xread: vi.fn().mockResolvedValueOnce([["agent:session:session_1:deltas", [["1-0", ["payload", JSON.stringify(envelope)]]]]]).mockResolvedValue(null),
      disconnect: vi.fn(),
    }
    const database = db([])
    database.agentItem.findMany.mockResolvedValueOnce([{ id: rawItemId, type: "tool_call" }])
    const controller = new AbortController()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal, redisFactory: () => connection, dbPollMs: 1, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    try {
      const text = new TextDecoder().decode((await reader.read()).value)
      const frame = JSON.parse(text.split("data: ")[1]!.split("\n")[0]!) as {
        id: string; itemId: string; correlationId: string; causationId: string | null; idempotencyKey: string | null;
        payload: { item: { id: string; content: { toolCallId: string } } }; streamId: string
      }
      const toolCallAlias = publicToolCallId("session_1", "turn_1", rawCallId)
      const toolItemAlias = publicToolItemId("session_1", "turn_1", rawItemId)
      expect(text).not.toContain(rawCallId)
      expect(text).not.toContain(rawItemId)
      expect(frame).toMatchObject({ id: publicAgentEventId("session_1", eventId), itemId: toolItemAlias, correlationId: toolItemAlias, causationId: publicAgentEventId("session_1", "cause:" + rawCallId), idempotencyKey: publicIdempotencyKey("session_1", "idem:" + rawCallId) })
      expect(frame.payload.item).toMatchObject({ id: toolItemAlias, content: { toolCallId: toolCallAlias } })
      expect(frame.streamId).toBe("1-0")
    } finally {
      controller.abort()
      await reader.cancel()
    }
    expect(connection.disconnect).toHaveBeenCalled()
  })

  it("replays a transient delta after its item-type lookup fails without advancing Redis", async () => {
    const rawCallId = "private-provider-call"
    const rawItemId = `turn:turn_1:item:tool-call:${rawCallId}`
    const envelope = {
      schemaVersion: "agent-harness.v2", id: "delta:private-call", sessionId: "session_1", turnId: "turn_1",
      itemId: rawItemId, taskId: null, type: "item.snapshot", actor: "orchestrator", correlationId: rawItemId,
      causationId: null, idempotencyKey: null, sequence: null,
      payload: { item: {
        schemaVersion: "agent-harness.v2", id: rawItemId, sessionId: "session_1", turnId: "turn_1",
        type: "tool_call", status: "started", revision: 1, content: { toolCallId: rawCallId },
      } }, kind: "snapshot", baseRevision: 0, revision: 1,
    }
    const batch = [["agent:session:session_1:deltas", [["1-0", ["payload", JSON.stringify(envelope)]]]]]
    let delivered = false
    const xread = vi.fn(async (...args: string[]) => {
      if (args.at(-1) === "$" && !delivered) {
        delivered = true
        return batch
      }
      await new Promise(resolve => setTimeout(resolve, 20))
      return null
    })
    const connection: AgentStreamRedis = {
      xread,
      disconnect: vi.fn(),
    }
    const database = db([])
    database.agentItem.findMany
      .mockRejectedValueOnce(new Error("temporary item lookup failure"))
      .mockResolvedValueOnce([{ id: rawItemId, type: "tool_call" }])
    const controller = new AbortController()
    const stream = createV2EventStream(database as never, {
      sessionId: "session_1", afterSequence: BigInt(0), signal: controller.signal,
      redisFactory: () => connection, dbPollMs: 1, heartbeatMs: 60_000,
    })
    const reader = stream.getReader()
    try {
      await waitFor(() => database.agentItem.findMany.mock.calls.length >= 2)
      const text = new TextDecoder().decode((await reader.read()).value)
      expect(text).toContain('"streamId":"1-0"')
      expect(text).not.toContain(rawCallId)
      expect(text).not.toContain(rawItemId)
      expect(xread.mock.calls.filter(call => call.at(-1) === "$")).toHaveLength(1)
    } finally {
      controller.abort()
      await reader.cancel()
    }
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
