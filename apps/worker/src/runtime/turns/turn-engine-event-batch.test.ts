import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import { appendChildWaitSourceLifecycleEventBatch, appendTurnEngineEventBatch } from "./turn-engine-event-batch.js"
import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import { safeSubagentWaitJson, waitResult } from "../subagents/durable-subagent-wait-store.js"
import { projectWaitCallEventContent } from "./turn-execution-wait-event-projection.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import type { TurnEngineEventInput } from "./turn-engine-types.js"

const owner = { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
  rootTaskId: "root-1", ownerId: "owner-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-10-20T12:01:00Z") }
const input: TurnEngineEventInput = { owner, id: "turn:turn-1:event:turn-started", itemId: null, type: "turn.started",
  correlationId: owner.turnId, causationId: null, idempotencyKey: "turn:turn-1:event:turn-started",
  payload: { goal: "Find a role", taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId } }

function fixture() {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const events = new Map<string, Record<string, unknown>>()
  const outboxes = new Map<string, Record<string, unknown>>()
  let sequence = 0
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 }
    if (sql.includes("pg_current_xact_id")) return { rows: [{ xid8: "101" }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return { rows: [{ id: owner.turnId }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"')) {
      if (sql.includes('WHERE "id"=$1 AND "sessionId"=$2')) {
        const row = [...events.values()].find(event => event.id === values?.[0] && event.sessionId === values?.[1]
          && event.turnId === values?.[2] && event.taskId === values?.[3])
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      const row = [...events.values()].find(event => event.idempotencyKey === values?.[0] || event.id === values?.[1]
        || event.idempotencyKey === values?.[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_outbox"')) {
      const row = [...outboxes.values()].find(entry => entry.idempotencyKey === values?.[0] || entry.id === values?.[1])
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
    }
    if (sql.includes('UPDATE "agent_sessions"')) { sequence += 1; return { rows: [{ eventSequence: String(sequence) }], rowCount: 1 } }
    if (sql.includes('INSERT INTO "agent_events"')) {
      let event: Record<string, unknown>
      if (/VALUES\s*\(\$1,\s*\$2,\s*\$3,\s*NULL,\s*\$4,\s*\$5,\s*\$6,\s*'orchestrator'/.test(sql)) {
        const [id, sessionId, turnId, taskId, eventSequence, type, causationId, idempotencyKey, payload] = values ?? []
        event = { id, sessionId, turnId, taskId, sequence: eventSequence, type, actor: "orchestrator", itemId: null,
          correlationId: taskId, causationId, idempotencyKey, payload: JSON.parse(String(payload)) }
      } else {
        const [id, sessionId, turnId, itemId, taskId, eventSequence, type, actor, correlationId, causationId, idempotencyKey, payload] = values ?? []
        event = { id, sessionId, turnId, itemId, taskId, sequence: eventSequence, type, actor, correlationId, causationId,
          idempotencyKey, payload: JSON.parse(String(payload)) }
      }
      events.set(String(event.idempotencyKey), event)
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) {
      const [id, topic, aggregateId, idempotencyKey, payload] = values?.length === 5
        ? values : [values?.[0], "agent.events", values?.[1], values?.[2], values?.[3]]
      outboxes.set(String(idempotencyKey), { id, topic, aggregateId, idempotencyKey, payload: JSON.parse(String(payload)) })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { calls, client, pool, events, outboxes }
}

function defaultEventWriter(fake: ReturnType<typeof fixture>, submitted: TurnEngineEventInput[]) {
  const appendEvent: TurnExecutionOptions["store"]["appendEvent"] = async event => {
    const persistedInput: TurnEngineEventInput = {
      owner: event.identity, id: event.id, itemId: event.itemId, type: event.type,
      correlationId: event.correlationId, causationId: event.causationId,
      idempotencyKey: event.idempotencyKey, payload: event.payload,
    }
    submitted.push(persistedInput)
    const persisted = await appendTurnEngineEventBatch(fake.pool, [persistedInput])
    const result = persisted[0]
    if (!result) throw new Error("event batch omitted the persisted event")
    return result
  }
  return new TurnExecutionEventWriter({ identity: owner, store: { appendEvent } } as unknown as TurnExecutionOptions)
}

describe("TurnEngine event batch chronology", () => {
  it("binds a random writer start ID across first write, idempotent replay, and strict identity rejection", async () => {
    const fake = fixture(), submitted: TurnEngineEventInput[] = []
    const startKey = `turn:${owner.turnId}:event:turn-started`
    const appendStart = (goal = "Find a role") => defaultEventWriter(fake, submitted).append("turn.started", owner.turnId, null,
      { goal, taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId }, "turn-started")

    const firstId = await appendStart()
    expect(submitted[0]?.id).toMatch(/^turn:turn-1:event:turn-started:[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
    expect(submitted[0]?.idempotencyKey).toBe(startKey)
    expect(firstId).toBe(submitted[0]?.id)
    const parent = fake.events.get(startKey)
    const witnessKey = `root-task-history-chronology-witness:turn_start:${firstId}:v1`
    const witness = fake.events.get(witnessKey)
    expect(parent).toMatchObject({ id: firstId, type: "turn.started", idempotencyKey: startKey })
    expect(witness).toMatchObject({ idempotencyKey: witnessKey, causationId: firstId,
      payload: { boundary: "turn_start", boundaryEventId: firstId } })
    expect(fake.outboxes.get(`agent-event:${firstId}`)).toMatchObject({ payload: { eventId: firstId, idempotencyKey: startKey } })
    expect(fake.outboxes.get(`agent-event:${String(witness?.id)}`)).toMatchObject({
      id: `agent-outbox-${String(witness?.id)}`, payload: { eventId: witness?.id, causationId: firstId },
    })
    const eventInsertCount = () => fake.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"')).length
    const writesBeforeReplay = eventInsertCount()

    const replayId = await appendStart()
    expect(submitted[1]?.id).not.toBe(submitted[0]?.id)
    expect(submitted[1]?.idempotencyKey).toBe(startKey)
    expect(replayId).toBe(firstId)
    expect(eventInsertCount()).toBe(writesBeforeReplay)
    expect(fake.events.size).toBe(2)

    await expect(appendStart("Changed objective")).rejects.toThrow(`event ${startKey} identity`)
    expect(submitted[2]?.idempotencyKey).toBe(startKey)
    expect(eventInsertCount()).toBe(writesBeforeReplay)
    expect(fake.events.get(startKey)).toMatchObject({ id: firstId, payload: { goal: "Find a role" } })
  })

  it("rejects an empty persisted ID for the reserved root start boundary", async () => {
    const fake = fixture()
    await expect(appendTurnEngineEventBatch(fake.pool, [{ ...input, id: "" }])).rejects.toThrow("root turn-start boundary")
    expect(fake.calls).toHaveLength(0)
  })

  it("rejects the canonical start key when its payload names a different Root", async () => {
    const fake = fixture()
    await expect(appendTurnEngineEventBatch(fake.pool, [{
      ...input, id: `${input.id}:random-id`, payload: { goal: "Find a role", taskId: "foreign-root", rootTaskId: "foreign-root" },
    }])).rejects.toThrow("root turn-start boundary")
    expect(fake.calls).toHaveLength(0)
  })

  it("serializes root start, writes a paired private witness, and validates replay without backfill", async () => {
    const fake = fixture()
    await expect(appendTurnEngineEventBatch(fake.pool, [input])).resolves.toEqual([{ id: input.id }])
    const lock = fake.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock"))
    const xid = fake.calls.findIndex(call => call.sql.includes("pg_current_xact_id"))
    const session = fake.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE"))
    const turn = fake.calls.findIndex(call => call.sql.includes('SELECT turn."id"'))
    const writes = fake.calls.flatMap((call, index) => call.sql.includes('INSERT INTO "agent_events"') ? [index] : [])
    expect(lock).toBeGreaterThan(-1)
    expect(lock).toBeLessThan(xid)
    expect(xid).toBeLessThan(session)
    expect(session).toBeLessThan(turn)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toBeGreaterThan(turn)
    expect(writes[1]).toBeGreaterThan(writes[0])
    expect(fake.events.size).toBe(2)
    expect(fake.outboxes.size).toBe(2)

    await appendTurnEngineEventBatch(fake.pool, [input])
    expect(fake.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(2)
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
  })

  it("does not record an unrelated or child start as a root chronology boundary", async () => {
    const unrelated = { ...input, id: "custom-start", idempotencyKey: "custom-start" }
    const fake = fixture()
    await appendTurnEngineEventBatch(fake.pool, [unrelated])
    expect(fake.calls.some(call => call.sql.includes("pg_advisory_xact_lock"))).toBe(false)
    const childOwner = { kind: "task" as const, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      taskId: "child-1", rootTaskId: owner.rootTaskId, ownerId: owner.ownerId, leaseExpiresAt: owner.leaseExpiresAt, attemptCount: 1 }
    const child = { ...input, owner: childOwner, id: "child-start", idempotencyKey: "child-start" }
    const childFake = fixture()
    await appendTurnEngineEventBatch(childFake.pool, [child])
    expect(childFake.calls.some(call => call.sql.includes("pg_advisory_xact_lock"))).toBe(false)
  })
})

const sourceOwner = { kind: "task" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "child-1",
  rootTaskId: "root-1", ownerId: "owner-current", attemptCount: 2, leaseExpiresAt: new Date("2026-10-30T12:01:00Z") }
const sourceStep = { id: "source-step", attempt: 1 }
const sourceCallId = "provider-wait-call", sourceCallItemId = "source-call-item", sourceWaitId = "source-wait"
const sourceTargetIds = ["target-child"]
const sourceDeadline = new Date("2026-10-30T12:00:30.000Z")
const sourceWait = {
  id: sourceWaitId, userId: sourceOwner.userId, sessionId: sourceOwner.sessionId, turnId: sourceOwner.turnId, parentTaskId: sourceOwner.taskId,
  stepId: sourceStep.id, targetTaskIds: sourceTargetIds, idempotencyKey: "opaque-wait-key", mode: "all", status: "ready",
  deadlineAt: sourceDeadline, matchedTaskIds: ["target-child"], suspendedAt: new Date("2026-10-30T11:59:00.000Z"), consumedAt: new Date("2026-10-30T12:00:00.000Z"),
  result: { request: { targetTaskIds: sourceTargetIds, mode: "all", timeoutMs: 30_000 }, outcome: {
    waitId: sourceWaitId, status: "ready", taskIds: sourceTargetIds, deadlineAt: sourceDeadline.toISOString(), matchedTaskIds: ["target-child"],
    tasks: [{ taskId: "target-child", status: "completed", role: "worker", result: null, failureReason: null }],
  } },
}
const sourceResultItemId = `task:${sourceOwner.taskId}:item:tool-result:source-wait-recovery:${createHash("sha256").update("child-wait-source-result:v1\0" + sourceWaitId + "\0" + sourceCallId).digest("hex")}`
const sourceCallContent = { toolCallId: sourceCallId, toolName: "wait_subagents", toolVersion: "1", status: "completed", errorCode: null,
  input: { idempotencyKey: "opaque-wait-key", taskIds: sourceTargetIds, mode: "all", timeoutMs: 30_000 } }
const sourceSafeResult = (() => {
  const value = safeSubagentWaitJson({ toolCallId: sourceCallId, output: waitResult(sourceWait), errorCode: null }, 16_384) as Record<string, unknown>
  value.toolCallId = sourceCallId
  return value
})()
const sourceItems = [
  { id: sourceCallItemId, stepId: sourceStep.id, taskId: sourceOwner.taskId, type: "tool_call", status: "completed", phase: null, revision: 1, content: sourceCallContent },
  { id: sourceResultItemId, stepId: sourceStep.id, taskId: sourceOwner.taskId, type: "tool_result", status: "completed", phase: null, revision: 1,
    content: { toolCallId: sourceCallId, output: (sourceSafeResult as Record<string, unknown>).output, errorCode: null } },
]
const sourceItemStart = { id: "source-item-start", itemId: sourceCallItemId, type: "item.started", actor: "subagent", correlationId: sourceStep.id,
  causationId: "source-prior", sequence: "10", idempotencyKey: `task:${sourceOwner.taskId}:event:item-started:${sourceCallItemId}`,
  payload: { itemId: sourceCallItemId, type: "tool_call", phase: null } }
const sourceToolStart = { id: "source-tool-start", itemId: sourceCallItemId, type: "tool_call.started", actor: "subagent", correlationId: sourceCallId,
  causationId: sourceItemStart.id, sequence: "11", idempotencyKey: `task:${sourceOwner.taskId}:event:tool-started:${sourceCallId}`,
  payload: { toolCallId: sourceCallId, toolName: "wait_subagents", taskId: sourceOwner.taskId } }

function historicalFixture(options: { marker?: boolean; existingCompletion?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: unknown[] }> = [], events = new Map<string, Record<string, unknown>>(), outboxes = new Map<string, Record<string, unknown>>()
  const wait = structuredClone(sourceWait) as Record<string, unknown>
  if (options.marker) wait.result = { ...sourceWait.result, sourceLifecycleRecovery: { schemaVersion: "child-wait-source-lifecycle.v1",
    userId: sourceOwner.userId, sessionId: sourceOwner.sessionId, turnId: sourceOwner.turnId, rootTaskId: sourceOwner.rootTaskId,
    taskId: sourceOwner.taskId, ownerId: "owner-previous", attempt: sourceStep.attempt, stepId: sourceStep.id, waitId: sourceWaitId,
    toolCallId: sourceCallId, callItemId: sourceCallItemId, resultItemId: sourceResultItemId } }
  events.set(sourceItemStart.idempotencyKey, { ...sourceItemStart })
  events.set(sourceToolStart.idempotencyKey, { ...sourceToolStart })
  events.set("source-prior-key", { id: "source-prior", sessionId: sourceOwner.sessionId, turnId: sourceOwner.turnId, taskId: sourceOwner.taskId,
    itemId: null, type: "model.usage", actor: "subagent", correlationId: sourceStep.id, causationId: null, sequence: "9", idempotencyKey: "source-prior-key", payload: {} })
  const expected = sourceCompletionInputs()
  if (options.existingCompletion) {
    let cause = sourceToolStart.id
    expected.forEach((input, index) => {
      const event = { id: `source-completion-${index}`, sessionId: sourceOwner.sessionId, turnId: sourceOwner.turnId, taskId: sourceOwner.taskId,
        itemId: input.itemId, type: input.type, actor: "subagent", correlationId: input.correlationId, causationId: cause, sequence: String(12 + index),
        idempotencyKey: input.idempotencyKey, payload: input.payload }
      events.set(String(event.idempotencyKey), event); cause = String(event.id)
    })
  }
  let sequenceValue = 20
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: sourceOwner.sessionId }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"')) return values?.[5] === sourceOwner.ownerId && values?.[6] === sourceOwner.attemptCount
      ? { rows: [{ id: sourceOwner.turnId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_wait_conditions"')) return values?.[0] === sourceWaitId && values?.[5] === sourceStep.id && wait.consumedAt
      ? { rows: [{ ...wait }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_steps"')) return values?.[0] === sourceStep.id && values?.[4] === sourceStep.attempt
      ? { rows: [{ id: sourceStep.id }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_items"') && sql.includes('"content"->>\'toolName\'')) return values?.[3] === sourceStep.id
      ? { rows: [{ id: sourceCallItemId }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_items" AS item') && sql.includes('JOIN "agent_steps"')) return values?.[5] === sourceStep.id && values?.[6] === sourceStep.attempt
      ? { rows: sourceItems.map(item => ({ ...item })), rowCount: 2 } : { rows: [], rowCount: 0 }
    if (sql.includes('SELECT item."id" FROM "agent_items" AS item') && sql.includes('owner_step')) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_items"') && sql.includes('WHERE "id" = $1')) return sourceItems.some(item => item.id === values?.[0]
      && item.taskId === values?.[3]) ? { rows: [{ id: values?.[0] }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_events"') && sql.includes('idempotencyKey" = ANY')) return { rows: [{ ...sourceItemStart }, { ...sourceToolStart }], rowCount: 2 }
    if (sql.includes('FROM "agent_events" AS event') && sql.includes('event."id" = $1')) return values?.[0] === "source-prior"
      ? { rows: [{ id: "source-prior" }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_events"') && sql.includes('"idempotencyKey" = $2')) {
      const found = [...events.values()].find(event => event.idempotencyKey === values?.[1])
      return found ? { rows: [{ ...found }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_outbox"')) {
      const found = [...outboxes.values()].find(item => item.idempotencyKey === values?.[0])
      return found ? { rows: [{ ...found }], rowCount: 1 } : { rows: [], rowCount: 0 }
    }
    if (sql.includes('UPDATE "agent_sessions"')) { sequenceValue += 1; return { rows: [{ eventSequence: String(sequenceValue) }], rowCount: 1 } }
    if (sql.includes('INSERT INTO "agent_events"')) {
      const [id, sessionId, turnId, itemId, taskId, eventSequence, type, actor, correlationId, causationId, idempotencyKey, payload] = values ?? []
      events.set(String(idempotencyKey), { id, sessionId, turnId, itemId, taskId, sequence: eventSequence, type, actor, correlationId, causationId,
        idempotencyKey, payload: JSON.parse(String(payload)) })
      return { rows: [], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_outbox"')) {
      const [id, topic, aggregateId, idempotencyKey, payload] = values?.length === 5
        ? values : [values?.[0], "agent.events", values?.[1], values?.[2], values?.[3]]
      if (outboxes.has(String(idempotencyKey))) return { rows: [], rowCount: 0 }
      outboxes.set(String(idempotencyKey), { id, topic, aggregateId, idempotencyKey, payload: JSON.parse(String(payload)) })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { calls, client, pool, events, outboxes, wait, proof: { owner: sourceOwner, waitId: sourceWaitId, sourceStepId: sourceStep.id,
    sourceAttempt: sourceStep.attempt, callItemId: sourceCallItemId, resultItemId: sourceResultItemId, toolCallId: sourceCallId, events: expected } }
}

function sourceCompletionInputs(): TurnEngineEventInput[] {
  const ownerFence = sourceOwner, callEventContent = projectWaitCallEventContent(sourceCallContent)
  const resultContent = sourceItems[1]!.content as unknown as RepositoryJsonValue
  return [
    { owner: ownerFence, id: "new-call-complete", itemId: sourceCallItemId, type: "item.completed", correlationId: sourceCallItemId,
      causationId: sourceToolStart.id, idempotencyKey: `task:${sourceOwner.taskId}:event:tool-call-completed:${sourceCallId}:${sourceCallItemId}:1`,
      payload: { itemId: sourceCallItemId, status: "completed", content: callEventContent } },
    { owner: ownerFence, id: "new-tool-complete", itemId: sourceCallItemId, type: "tool_call.completed", correlationId: sourceCallId, causationId: null,
      idempotencyKey: `task:${sourceOwner.taskId}:event:tool-finished:${sourceCallId}`,
      payload: { toolCallId: sourceCallId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: sourceOwner.taskId } },
    { owner: ownerFence, id: "new-result-start", itemId: sourceResultItemId, type: "item.started", correlationId: sourceStep.id, causationId: null,
      idempotencyKey: `task:${sourceOwner.taskId}:event:item-started:${sourceResultItemId}`, payload: { itemId: sourceResultItemId, type: "tool_result", phase: null } },
    { owner: ownerFence, id: "new-result-complete", itemId: sourceResultItemId, type: "item.completed", correlationId: sourceResultItemId, causationId: null,
      idempotencyKey: `task:${sourceOwner.taskId}:event:tool-result-completed:${sourceCallId}:${sourceResultItemId}:1`,
      payload: { itemId: sourceResultItemId, status: "completed", content: resultContent } },
  ]
}

describe("historical consumed child-wait event batches", () => {
  it("keeps the current lease fence while appending a historical source attempt and repairing a missing replay outbox", async () => {
    const fake = historicalFixture()
    await expect(appendChildWaitSourceLifecycleEventBatch(fake.pool, fake.proof, fake.client as never)).resolves.toHaveLength(4)
    expect(fake.events.size).toBe(7)
    expect(fake.outboxes.size).toBe(4)
    expect(fake.calls.some(call => call.sql.includes('owner_step."attempt" = $5'))).toBe(false)

    const firstCompletion = fake.proof.events[0]!.idempotencyKey
    const savedEvent = fake.events.get(firstCompletion)
    fake.outboxes.delete(`agent-event:${String(savedEvent?.id)}`)
    await expect(appendChildWaitSourceLifecycleEventBatch(fake.pool, fake.proof, fake.client as never)).resolves.toHaveLength(4)
    expect(fake.outboxes.has(`agent-event:${String(savedEvent?.id)}`)).toBe(true)
    expect(fake.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(4)
  })

  it("replays an exact lifecycle under a new owner after validating the old marker and current attempt", async () => {
    const fake = historicalFixture({ marker: true, existingCompletion: true })
    await expect(appendChildWaitSourceLifecycleEventBatch(fake.pool, fake.proof, fake.client as never)).resolves.toHaveLength(4)
    expect(fake.outboxes.size).toBe(4)
    expect(fake.calls.filter(call => call.sql.includes('INSERT INTO "agent_events"'))).toHaveLength(0)
    expect(fake.calls.some(call => call.sql.includes('SELECT turn."id"') && call.values?.[6] === sourceOwner.attemptCount)).toBe(true)
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_steps"') && call.values?.[4] === sourceStep.attempt)).toBe(true)
  })

  it("accepts a bounded canonical historical owner identifier", async () => {
    const fake = historicalFixture({ marker: true, existingCompletion: true })
    const saved = fake.wait.result as Record<string, unknown>
    const marker = saved.sourceLifecycleRecovery as Record<string, unknown>
    marker.ownerId = "o".repeat(256)
    await expect(appendChildWaitSourceLifecycleEventBatch(fake.pool, fake.proof, fake.client as never)).resolves.toHaveLength(4)
  })

  it.each([
    ["padded", " owner-previous "],
    ["overlong", "o".repeat(257)],
  ])("rejects a %s historical owner identifier", async (_label, ownerId) => {
    const fake = historicalFixture({ marker: true })
    const saved = fake.wait.result as Record<string, unknown>
    const marker = saved.sourceLifecycleRecovery as Record<string, unknown>
    marker.ownerId = ownerId
    await expect(appendChildWaitSourceLifecycleEventBatch(fake.pool, fake.proof, fake.client as never)).rejects.toThrow("historical child wait marker")
    expect(fake.calls.some(call => call.sql.includes('INSERT INTO "agent_events"') || call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it.each([
    ["forged source attempt", (proof: ReturnType<typeof historicalFixture>["proof"]) => ({ ...proof, sourceAttempt: 3 })],
    ["wrong wait identity", (proof: ReturnType<typeof historicalFixture>["proof"]) => ({ ...proof, waitId: "other-wait" })],
    ["wrong source item", (proof: ReturnType<typeof historicalFixture>["proof"]) => ({ ...proof, callItemId: "other-source-call" })],
    ["stale current owner", (proof: ReturnType<typeof historicalFixture>["proof"]) => {
      const owner = { ...proof.owner, ownerId: "stale-owner" }
      return { ...proof, owner, events: proof.events.map(event => ({ ...event, owner })) }
    }],
    ["changed event payload", (proof: ReturnType<typeof historicalFixture>["proof"]) => ({ ...proof, events: proof.events.map((event, index) => index === 3 ? { ...event, payload: {} } : event) })],
  ])("rejects %s before event or outbox writes", async (_label, change) => {
    const fake = historicalFixture(), proof = change(fake.proof)
    await expect(appendChildWaitSourceLifecycleEventBatch(fake.pool, proof, fake.client as never)).rejects.toThrow()
    expect(fake.calls.some(call => call.sql.includes('INSERT INTO "agent_events"') || call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("keeps generic event append fenced to the current item attempt", async () => {
    const fake = historicalFixture()
    const oldAttemptCall = { ...fake.proof.events[0]!, owner: sourceOwner }
    await expect(appendTurnEngineEventBatch(fake.pool, [oldAttemptCall])).rejects.toThrow("item source-call-item lineage")
    expect(fake.calls.some(call => call.sql.includes('owner_step."attempt" = $5'))).toBe(true)
  })
})
