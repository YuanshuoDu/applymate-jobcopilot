import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { cancelPausedQuestion, hasQuestionPauseEvents } from "./turn-question-store-cancellation.js"
import type { TurnQuestionPauseInput } from "./turn-question-contract.js"
import { questionId } from "./turn-question-store-guards.js"
import { recoverPausedOrphanUsage } from "./turn-question-store-events.js"
import { createPgTurnQuestionStore } from "./turn-question-store.js"
import { recoverableNativeQuestionCalls } from "./turn-execution-question.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-10-06T12:00:00.000Z"),
}
const orphanModelStartedKey = `turn:${owner.turnId}:event:model-started:step-1`
const orphanModelStartedId = `${orphanModelStartedKey}:00000000-0000-4000-8000-000000000001`
const orphanModelCompletedKey = `turn:${owner.turnId}:event:model-completed:step-1`
const orphanModelCompletedId = `${orphanModelCompletedKey}:00000000-0000-4000-8000-000000000002`
const orphanModelUsageKey = `turn:${owner.turnId}:event:model-usage:step-1`
const orphanModelUsageId = `${orphanModelUsageKey}:00000000-0000-4000-8000-000000000003`

function cancellationEvents(withResult: boolean) {
  const stepId = "step-1", toolCallId = "call-1", callItemId = "call-item-1", resultItemId = withResult ? "result-item-1" : null
  const digest = questionId(owner, stepId, toolCallId), base = `turn:${owner.turnId}:event:question-pause:${digest}`
  const callId = `agent-question-pause-call-${digest}`, itemId = `agent-question-pause-item-${digest}`
  const resultId = `agent-question-pause-result-${digest}`, stepEventId = `agent-question-pause-step-${digest}`
  const rows = [
    { id: callId, itemId: callItemId, type: "tool_call.failed", actor: "orchestrator", correlationId: toolCallId, causationId: null,
      idempotencyKey: `${base}:call`, payload: { toolCallId, toolName: "agent.ask_user", status: "cancelled", errorCode: null, taskId: owner.taskId } },
    { id: itemId, itemId: callItemId, type: "item.delta", actor: "orchestrator", correlationId: callItemId, causationId: callId,
      idempotencyKey: `${base}:item`, payload: { itemId: callItemId, status: "interrupted", content: { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "cancelled", errorCode: null } } },
    ...(resultItemId ? [{ id: resultId, itemId: resultItemId, type: "item.delta", actor: "orchestrator", correlationId: resultItemId, causationId: itemId,
      idempotencyKey: `${base}:result`, payload: { itemId: resultItemId, status: "interrupted", content: { toolCallId, output: null, status: "cancelled", errorCode: null } } }] : []),
    { id: stepEventId, itemId: null, type: "step.completed", actor: "orchestrator", correlationId: stepId,
      causationId: resultItemId ? resultId : itemId, idempotencyKey: `${base}:step`,
      payload: { stepId, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 1, taskId: owner.taskId } },
  ]
  return { stepId, toolCallId, callItemId, resultItemId, rows }
}

function stepOnlyCancellationEvent(stepId = "step-1", toolCallId = "call-1", causationId: string | null = null) {
  const digest = questionId(owner, stepId, toolCallId), base = `turn:${owner.turnId}:event:question-pause:${digest}`
  return { id: `agent-question-pause-step-${digest}`, sequence: "11", itemId: null, type: "step.completed", actor: "orchestrator",
    correlationId: stepId, causationId, idempotencyKey: `${base}:step`,
    payload: { stepId, status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 1, taskId: owner.taskId } }
}

function queryClient(rows: readonly Record<string, unknown>[], previousEventId?: string | null) {
  return { query: vi.fn(async (query: string) => {
    if (query.includes('"sequence" < $4')) {
      const previous = previousEventId ? [{ id: previousEventId }] : []
      return { rows: previous, rowCount: previous.length }
    }
    return { rows, rowCount: rows.length }
  }) } as never
}

type FakePauseStep = {
  id: string; status: string; taskId: string; attempt: number; finishReason: string | null; errorCode: string | null
  inputTokens: number; outputTokens: number; estimatedCostUsd: number
}
type FakePauseItem = { id: string; status: string; content: Record<string, unknown>; type?: string }
type FakePauseEvent = {
  id: string; sessionId: string; turnId: string; itemId: string | null; taskId: string | null; sequence: string; type: string
  actor: string; correlationId: string; causationId: string | null; idempotencyKey: string; payload: Record<string, unknown>
}
type FakePauseOutbox = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: Record<string, unknown> }
type FakePauseState = {
  step: FakePauseStep; call?: FakePauseItem; result?: FakePauseItem; events: Map<string, FakePauseEvent>; outboxes: Map<string, FakePauseOutbox>; eventSequence: number
}

function clonePauseState(state: FakePauseState): FakePauseState {
  return structuredClone(state)
}

function cancellationDatabase(options: { readonly withCallRow?: boolean; readonly withResultRow?: boolean; readonly ambiguousCommit?: boolean; readonly recoverPaused?: boolean;
  readonly orphanStarted?: boolean; readonly orphanCompleted?: boolean; readonly orphanUsage?: boolean; readonly orphanPause?: boolean; readonly malformedOrphanUsage?: boolean;
  readonly malformedOrphanPause?: boolean; readonly orphanCompletedCausation?: string | null; readonly orphanUsageCausation?: string | null;
  readonly orphanCompletedSequence?: string; readonly orphanUsageSequence?: string; readonly stepStatus?: string; readonly transientStepUpdates?: number } = {}) {
  const modelUsageKey = orphanModelUsageKey, modelStartedKey = orphanModelStartedKey, modelCompletedKey = orphanModelCompletedKey
  const events = new Map<string, FakePauseEvent>()
  if (options.recoverPaused) {
    events.set(modelUsageKey, { id: orphanModelUsageId, sessionId: owner.sessionId, turnId: owner.turnId, itemId: null, taskId: owner.taskId,
      sequence: "10", type: "model.usage", actor: "orchestrator", correlationId: "step-1", causationId: null, idempotencyKey: modelUsageKey,
      payload: { provider: "fixture", model: "fixture", usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }, taskId: owner.taskId } })
    events.set("pause-after-question-intent", { id: "pause-after-question-intent", sessionId: owner.sessionId, turnId: owner.turnId, itemId: null, taskId: null,
      sequence: "11", type: "session.pause_requested", actor: "user", correlationId: owner.turnId, causationId: null,
      idempotencyKey: "agent-session-control:pause-recovery", payload: { turnId: owner.turnId, expectedRevision: 0, requestedAt: "2026-10-06T12:00:00.000Z" } })
  }
  if (options.orphanStarted) events.set(modelStartedKey, {
    id: orphanModelStartedId, sessionId: owner.sessionId, turnId: owner.turnId, itemId: null, taskId: owner.taskId,
    sequence: "9", type: "model.started", actor: "orchestrator", correlationId: "step-1", causationId: null,
    idempotencyKey: modelStartedKey, payload: { provider: "fixture", model: "fixture", taskId: owner.taskId },
  })
  if (options.orphanCompleted) events.set(modelCompletedKey, {
    id: orphanModelCompletedId, sessionId: owner.sessionId, turnId: owner.turnId, itemId: null, taskId: owner.taskId,
    sequence: options.orphanCompletedSequence ?? "10", type: "model.completed", actor: "orchestrator", correlationId: "step-1",
    causationId: options.orphanCompletedCausation === undefined ? orphanModelStartedId : options.orphanCompletedCausation,
    idempotencyKey: modelCompletedKey, payload: { taskId: owner.taskId, provider: "fixture", model: "fixture" },
  })
  if (options.orphanUsage) {
    const key = `turn:${owner.turnId}:event:model-usage:step-1`
    events.set(key, { id: orphanModelUsageId, sessionId: owner.sessionId, turnId: owner.turnId, itemId: null, taskId: owner.taskId,
      sequence: options.orphanUsageSequence ?? "11", type: "model.usage", actor: "orchestrator", correlationId: "step-1",
      causationId: options.orphanUsageCausation === undefined ? orphanModelCompletedId : options.orphanUsageCausation, idempotencyKey: key,
      payload: { provider: "fixture", model: "fixture", usage: { inputTokens: options.malformedOrphanUsage ? "10" : 10, outputTokens: 4, estimatedCostUsd: 0.02 }, taskId: owner.taskId } })
  }
  if (options.orphanPause) events.set("pause-after-orphan-model-usage", { id: "pause-after-orphan-model-usage", sessionId: owner.sessionId, turnId: owner.turnId, itemId: null, taskId: null,
    sequence: "12", type: "session.pause_requested", actor: "user", correlationId: owner.turnId, causationId: null,
    idempotencyKey: "agent-session-control:pause-orphan-recovery", payload: options.malformedOrphanPause ? { turnId: owner.turnId } : {
      turnId: owner.turnId, expectedRevision: 0, requestedAt: "2026-10-06T12:00:00.000Z",
    } })
  let database: FakePauseState = {
    step: { id: "step-1", status: options.stepStatus ?? "streaming", taskId: owner.taskId, attempt: 1, finishReason: null, errorCode: null,
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
    ...(options.withCallRow === false ? {} : { call: { id: "call-item-1", status: "started", type: "tool_call", content: { toolCallId: "call-1", toolName: "agent.ask_user", toolVersion: "1", input: { question: "Which city?" } } } }),
    ...(options.withResultRow ? { result: { id: "result-item-1", status: "started", type: "tool_result", content: { toolCallId: "call-1", output: { question: "Which city?" }, errorCode: null } } } : {}),
    events, outboxes: new Map(), eventSequence: options.orphanPause ? 13 : options.recoverPaused ? 12 : 10,
  }
  let connections = 0, commits = 0, rollbacks = 0, stepUpdates = 0, eventSequenceUpdates = 0, eventInserts = 0, outboxInserts = 0
  let injectTransient = true, injectAmbiguousCommit = options.ambiguousCommit === true, transientStepUpdates = options.transientStepUpdates ?? 0
  const result = (rows: Record<string, unknown>[] = [], rowCount = rows.length) => ({ rows, rowCount })
  const pool = {
    connect: async () => {
      connections += 1
      let transaction: FakePauseState | null = null
      return {
        query: async (query: string, values: unknown[] = []) => {
          const sql = query.replace(/\s+/g, " ").trim()
          if (sql === "BEGIN") { transaction = clonePauseState(database); return result() }
          if (sql === "ROLLBACK") { transaction = null; rollbacks += 1; return result() }
          if (sql === "COMMIT") {
            if (!transaction) throw new Error("missing question transaction")
            database = transaction; transaction = null; commits += 1
            if (injectAmbiguousCommit) {
              injectAmbiguousCommit = false
              throw Object.assign(new Error("connection reset after server commit"), { code: "ECONNRESET" })
            }
            return result()
          }
          if (sql.startsWith("SELECT set_config(")) return result()
          if (!transaction) throw new Error(`question query outside transaction: ${sql}`)
          const state = transaction
          if (sql.startsWith('SELECT session."id"')) return result([{ id: owner.sessionId }])
          if (sql.startsWith('SELECT turn."id"')) return result([{ id: owner.turnId, status: "in_progress", revision: 1 }])
          if (sql.startsWith('SELECT step."id"')) return result(state.step.status === "streaming" ? [{ ...state.step }] : [])
          if (sql.startsWith('SELECT "id", "status", "taskId", "attempt"') && sql.includes('FROM "agent_steps"')) return result([state.step])
          if (sql.startsWith('SELECT callItem."id" AS "callItemId"')) return result(state.call ? [{ callItemId: state.call.id, stepId: state.step.id,
            callStatus: state.call.status, callContent: state.call.content, stepStatus: state.step.status, stepErrorCode: state.step.errorCode,
            finishReason: state.step.finishReason, inputTokens: state.step.inputTokens, outputTokens: state.step.outputTokens, estimatedCostUsd: state.step.estimatedCostUsd,
            resultItemId: null, resultStatus: null, resultContent: null, resultCount: 0 }] : [])
          if (sql.startsWith('SELECT callItem."stepId"')) return result(state.call ? [{ stepId: state.step.id, ordinal: 1,
            stepStatus: state.step.status, stepErrorCode: state.step.errorCode, finishReason: state.step.finishReason,
            inputTokens: state.step.inputTokens, outputTokens: state.step.outputTokens, estimatedCostUsd: state.step.estimatedCostUsd,
            callItemId: state.call.id, callStatus: state.call.status, callContent: state.call.content,
            resultItemId: null, resultStatus: null, resultContent: null, resultCount: 0 }] : [])
          if (sql.startsWith('SELECT "id", "status", "content" FROM "agent_items"')) {
            if (sql.includes('"type" = \'tool_call\'')) return result(state.call ? [state.call] : [])
            if (sql.includes('"type" = \'tool_result\'')) return result()
          }
          if (sql.startsWith('SELECT "id", "type" FROM "agent_items"')) return result([state.call, state.result].filter((item): item is FakePauseItem => !!item).map(item => ({ id: item.id, type: item.type })))
          if (sql.startsWith('SELECT "id" FROM "agent_items" WHERE "id" = $1')) return result()
          if (sql.startsWith('SELECT "id", "causationId" FROM "agent_events"')) {
            const event = state.events.get(String(values[1]))
            return result(event ? [{ id: event.id, causationId: event.causationId }] : [])
          }
          if (sql.startsWith('SELECT "id", "turnId", "itemId"')) {
            const event = state.events.get(String(values[1]))
            return result(event ? [event] : [])
          }
          if (sql.startsWith('SELECT "id" FROM "agent_events"') && (sql.includes('NOT ("idempotencyKey" = ANY') || sql.includes('"sequence" < $4'))) return result()
          if (sql.startsWith('SELECT "id", "sequence"') && sql.includes('FROM "agent_events"')) {
            if (sql.includes("model.started") || sql.includes("ANY($4::text[])")) {
              const keys = new Set(values[3] as string[])
              return result([...state.events.values()].filter(event => keys.has(event.idempotencyKey)
                || event.correlationId === values[2] && ["model.started", "model.completed", "model.usage"].includes(event.type)))
            }
            if (sql.includes("session.pause_requested")) {
              const after = String(values[2]), pauses = [...state.events.values()].filter(event => event.type === "session.pause_requested" && BigInt(event.sequence) > BigInt(after))
              return result(pauses.slice(0, 1))
            }
            if (sql.includes('= ANY($4::text[])')) {
              const keys = new Set(values[3] as string[])
              return result([...state.events.values()].filter(event => keys.has(event.idempotencyKey)))
            }
            if (sql.includes('"idempotencyKey" = $4')) {
              const event = state.events.get(String(values[3]))
              return result(event ? [event] : [])
            }
            const event = state.events.get(String(values[1]))
            return result(event ? [event] : [])
          }
          if (sql.startsWith('UPDATE "agent_items"')) {
            if (!state.call) throw new Error("cannot update absent call row")
            const content = JSON.parse(String(values[0])) as Record<string, unknown>
            state.call = { ...state.call, status: "interrupted", content }
            if (injectTransient) {
              injectTransient = false
              throw Object.assign(new Error("serialization failure after cancellation update"), { code: "40001" })
            }
            return result([], 1)
          }
          if (sql.startsWith('UPDATE "agent_steps"')) {
            stepUpdates += 1
            state.step = sql.includes('"finishReason"')
              ? { ...state.step, status: "interrupted", finishReason: String(values[0]), errorCode: String(values[1]),
                inputTokens: Number(values[2]), outputTokens: Number(values[3]), estimatedCostUsd: Number(values[4]) }
              : { ...state.step, status: "interrupted", errorCode: String(values[0]), inputTokens: Number(values[1]),
                outputTokens: Number(values[2]), estimatedCostUsd: Number(values[3]) }
            if (transientStepUpdates > 0) {
              transientStepUpdates -= 1
              throw Object.assign(new Error("serialization failure after no-call cancellation step update"), { code: "40001" })
            }
            return result([], 1)
          }
          if (sql.startsWith('UPDATE "agent_sessions" SET "eventSequence"')) {
            eventSequenceUpdates += 1
            state.eventSequence += 1
            return result([{ eventSequence: state.eventSequence }])
          }
          if (sql.startsWith('INSERT INTO "agent_events"')) {
            eventInserts += 1
            const event: FakePauseEvent = { id: String(values[0]), sessionId: String(values[1]), turnId: String(values[2]),
              itemId: values[3] === null ? null : String(values[3]), taskId: String(values[4]), sequence: String(values[5]),
              type: String(values[6]), actor: "orchestrator", correlationId: String(values[7]),
              causationId: values[8] === null ? null : String(values[8]), idempotencyKey: String(values[9]),
              payload: JSON.parse(String(values[10])) as Record<string, unknown> }
            state.events.set(event.idempotencyKey, event)
            return result([], 1)
          }
          if (sql.startsWith('INSERT INTO "agent_outbox"')) {
            const key = String(values[3]), existing = state.outboxes.get(key)
            if (existing) return result([], 0)
            outboxInserts += 1
            state.outboxes.set(key, { id: String(values[0]), topic: String(values[1]), aggregateId: String(values[2]), idempotencyKey: key,
              payload: JSON.parse(String(values[4])) as Record<string, unknown> })
            return result([], 1)
          }
          if (sql.startsWith('SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"')) {
            const outbox = state.outboxes.get(String(values[0]))
            return result(outbox ? [outbox] : [])
          }
          throw new Error(`unhandled question query: ${sql}`)
        },
        release: () => undefined,
      }
    },
  }
  return { pool, state: () => database, metrics: () => ({ connections, commits, rollbacks, stepUpdates, eventSequenceUpdates, eventInserts, outboxInserts }) }
}

describe("native question pause cancellation readback", () => {
  it.each([false, true])("accepts the exact server event chain (result present: %s)", async withResult => {
    const fixture = cancellationEvents(withResult)
    const client = queryClient(fixture.rows)
    await expect(hasQuestionPauseEvents(client, owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, fixture.resultItemId)).resolves.toBe(true)
  })

  it("fails closed for missing, duplicate, or altered server cancellation events", async () => {
    const fixture = cancellationEvents(false)
    await expect(hasQuestionPauseEvents(queryClient(fixture.rows.slice(0, 2)), owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, null)).resolves.toBe(false)
    await expect(hasQuestionPauseEvents(queryClient([...fixture.rows, fixture.rows[0]!]), owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, null)).resolves.toBe(false)
    const forged = fixture.rows.map(row => row.type === "tool_call.failed" ? { ...row, payload: { ...row.payload, status: "failed" } } : row)
    await expect(hasQuestionPauseEvents(queryClient(forged), owner, fixture.stepId, fixture.toolCallId, fixture.callItemId, null)).resolves.toBe(false)
  })

  it("retries one transient atomic cancellation failure and leaves exact durable pause evidence", async () => {
    const database = cancellationDatabase()
    const input: TurnQuestionPauseInput = {
      owner, stepId: "step-1", toolCallId: "call-1", callArguments: { question: "Which city?" }, finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }, now: new Date("2026-10-06T12:00:00.000Z"),
    }

    await expect(cancelPausedQuestion(database.pool as never, input)).resolves.toBe("cancelled")

    const saved = database.state()
    expect(database.metrics()).toEqual({ connections: 2, commits: 1, rollbacks: 1, stepUpdates: 1, eventSequenceUpdates: 3, eventInserts: 3, outboxInserts: 3 })
    expect(saved.call).toMatchObject({ id: "call-item-1", status: "interrupted", content: { toolCallId: "call-1", status: "cancelled", errorCode: null } })
    expect(saved.step).toMatchObject({ id: "step-1", status: "interrupted", errorCode: "session_pause_requested", finishReason: "tool_calls",
      inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 })
    expect([...saved.events.values()].map(event => event.type)).toEqual(["tool_call.failed", "item.delta", "step.completed"])
    expect(saved.events.size).toBe(3)
    expect(saved.outboxes.size).toBe(3)
    await expect(hasQuestionPauseEvents(queryClient([...saved.events.values()]), owner, "step-1", "call-1", "call-item-1", null)).resolves.toBe(true)

    await expect(cancelPausedQuestion(database.pool as never, input)).resolves.toBe("cancelled")
    expect(database.state().events.size).toBe(3)
    expect(database.state().outboxes.size).toBe(3)
  })

  it("reads back an ambiguous committed no-call cancellation without repeating writes", async () => {
    const database = cancellationDatabase({ withCallRow: false, ambiguousCommit: true })
    const input: TurnQuestionPauseInput = {
      owner, stepId: "step-1", toolCallId: "call-1", callArguments: { question: "Which city?" }, finishReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }, now: new Date("2026-10-06T12:00:00.000Z"),
    }

    await expect(cancelPausedQuestion(database.pool as never, input)).resolves.toBe("cancelled")

    const saved = database.state()
    expect(database.metrics()).toEqual({ connections: 2, commits: 2, rollbacks: 1, stepUpdates: 1, eventSequenceUpdates: 1, eventInserts: 1, outboxInserts: 1 })
    expect(saved.call).toBeUndefined()
    expect(saved.step).toMatchObject({ status: "interrupted", errorCode: "session_pause_requested", finishReason: "tool_calls",
      inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 })
    expect([...saved.events.values()]).toMatchObject([stepOnlyCancellationEvent()])
    expect(saved.outboxes.size).toBe(1)
    await expect(hasQuestionPauseEvents(queryClient([...saved.events.values()]), owner, "step-1", "call-1", null, null)).resolves.toBe(true)
    await expect(hasQuestionPauseEvents(queryClient([...saved.events.values(), cancellationEvents(false).rows[0]!]), owner, "step-1", "call-1", null, null)).resolves.toBe(false)
  })

  it("recovers an exhausted partial pause cleanup from the exact persisted call and real model usage", async () => {
    const database = cancellationDatabase({ recoverPaused: true })
    const store = createPgTurnQuestionStore(database.pool as never)
    const input = { owner, now: new Date("2026-10-06T12:00:00.000Z") }
    expect(database.state().events.get(orphanModelUsageKey)).toMatchObject({ id: orphanModelUsageId, idempotencyKey: orphanModelUsageKey })
    const recoveredAsk = [{ action: "replay", stepId: "step-1", toolVersion: "1", call: { id: "call-1", name: "agent.ask_user",
      arguments: { question: "Which city?" } }, callItem: { id: "call-item-1", revision: 1 }, durableResult: null }]
    const executionStore = { readPendingQuestion: ({ identity, now }: { identity: typeof owner; now: Date }) => store.readPendingQuestion({ owner: identity, now }) }

    await expect(store.readPendingQuestion(input)).rejects.toMatchObject({ code: "orphan_pause_usage_recovered_reload_required" })
    await expect(store.readPendingQuestion(input)).resolves.toEqual({ status: "none" })
    await expect(recoverableNativeQuestionCalls({ identity: owner, store: executionStore } as never, recoveredAsk as never, () => input.now)).resolves.toEqual([])

    const saved = database.state(), metrics = database.metrics()
    expect(saved.call).toMatchObject({ id: "call-item-1", status: "interrupted", content: {
      toolCallId: "call-1", toolName: "agent.ask_user", toolVersion: "1", input: { question: "Which city?" }, status: "cancelled", errorCode: null,
    } })
    expect(saved.step).toMatchObject({ id: "step-1", status: "interrupted", errorCode: "session_pause_requested", finishReason: "tool_calls",
      inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 })
    expect(metrics).toMatchObject({ stepUpdates: 1, eventSequenceUpdates: 3, eventInserts: 3, outboxInserts: 3 })
    expect([...saved.events.values()].filter(event => event.idempotencyKey.includes("question-pause:"))).toHaveLength(3)
    expect(saved.events.size).toBe(5)
    expect([...saved.events.values()].some(event => ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))).toBe(false)
    expect(saved.outboxes.size).toBe(3)
  })

  it("restores an orphan model usage after both no-call cancellation attempts roll back", async () => {
    const database = cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanCompleted: true, orphanUsage: true, orphanPause: true, transientStepUpdates: 2 })
    const modelUsageKey = orphanModelUsageKey
    const now = new Date("2026-10-06T12:00:00.000Z"), store = createPgTurnQuestionStore(database.pool as never)
    const cleanupInput: TurnQuestionPauseInput = { owner, stepId: "step-1", toolCallId: "call-1", callArguments: { question: "Which city?" },
      finishReason: "tool_calls", usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }, now }

    await expect(cancelPausedQuestion(database.pool as never, cleanupInput)).rejects.toMatchObject({ code: "40001" })
    expect(database.metrics()).toMatchObject({ commits: 0, rollbacks: 2, stepUpdates: 2, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })
    await expect(store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "orphan_pause_usage_recovered_reload_required" })

    const saved = database.state(), metrics = database.metrics(), recovered = [...saved.events.values()].find(event => event.type === "step.completed")
    expect(saved.step).toMatchObject({ id: "step-1", status: "interrupted", errorCode: "session_pause_requested", finishReason: null,
      inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 })
    expect(recovered).toMatchObject({ type: "step.completed", taskId: owner.taskId, itemId: null, actor: "orchestrator", correlationId: "step-1",
      causationId: orphanModelUsageId, payload: { stepId: "step-1", status: "interrupted", errorCode: "session_pause_requested", toolCallCount: 0, taskId: owner.taskId } })
    expect(saved.events.get(modelUsageKey)?.id).toBe(orphanModelUsageId)
    expect(saved.events.get(modelUsageKey)?.id).not.toBe(saved.events.get(modelUsageKey)?.idempotencyKey)
    expect(recovered?.idempotencyKey).toContain("question-pause-orphan:")
    expect([...saved.events.values()].some(event => ["item.started", "tool_call.failed", "turn.completed", "turn.failed", "turn.interrupted"].includes(event.type))).toBe(false)
    expect(saved.call).toBeUndefined(); expect(saved.result).toBeUndefined()
    expect(saved.events.size).toBe(5); expect(saved.outboxes.size).toBe(1)
    expect([...saved.outboxes.values()][0]).toMatchObject({ topic: "agent.events", aggregateId: owner.sessionId,
      payload: { eventId: recovered?.id, taskId: owner.taskId, type: "step.completed", causationId: orphanModelUsageId } })
    expect(metrics).toMatchObject({ stepUpdates: 3, eventSequenceUpdates: 1, eventInserts: 1, outboxInserts: 1 })

    await expect(store.readPendingQuestion({ owner, now })).resolves.toEqual({ status: "none" })
    expect(database.metrics()).toMatchObject({ stepUpdates: 3, eventSequenceUpdates: 1, eventInserts: 1, outboxInserts: 1 })
    expect(database.state().events.size).toBe(5); expect(database.state().outboxes.size).toBe(1)
  })

  it("fails closed on missing or malformed orphan usage and writes nothing without a later pause", async () => {
    const now = new Date("2026-10-06T12:00:00.000Z")
    for (const database of [
      cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanPause: true }),
      cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanCompleted: true, orphanUsage: true, orphanPause: true, malformedOrphanUsage: true }),
    ]) {
      const store = createPgTurnQuestionStore(database.pool as never)
      await expect(store.readPendingQuestion({ owner, now })).rejects.toMatchObject({ code: "question_usage_unavailable" })
      expect(database.metrics()).toMatchObject({ stepUpdates: 0, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })
      expect(database.state().step.status).toBe("streaming")
    }
    const noPause = cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanCompleted: true, orphanUsage: true })
    await expect(createPgTurnQuestionStore(noPause.pool as never).readPendingQuestion({ owner, now })).resolves.toEqual({ status: "none" })
    expect(noPause.metrics()).toMatchObject({ stepUpdates: 0, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })

    const malformedPause = cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanCompleted: true, orphanUsage: true, orphanPause: true, malformedOrphanPause: true })
    await expect(recoverPausedOrphanUsage(malformedPause.pool as never, owner, now)).rejects.toMatchObject({ code: "question_conflict" })
    expect(malformedPause.metrics()).toMatchObject({ stepUpdates: 0, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })
  })

  it.each([
    ["tool call", { withCallRow: true }],
    ["tool result", { withCallRow: false, withResultRow: true }],
  ] as const)("rejects orphan recovery when a %s row conflicts", async (_name, rows) => {
    const database = cancellationDatabase({ ...rows, orphanStarted: true, orphanCompleted: true, orphanUsage: true, orphanPause: true })
    await expect(recoverPausedOrphanUsage(database.pool as never, owner, new Date("2026-10-06T12:00:00.000Z")))
      .rejects.toMatchObject({ code: "question_conflict" })
    expect(database.metrics()).toMatchObject({ stepUpdates: 0, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })
    expect(database.state().step.status).toBe("streaming")
  })

  it("ignores a non-streaming step during orphan pause recovery", async () => {
    const database = cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanCompleted: true, orphanUsage: true, orphanPause: true, stepStatus: "interrupted" })
    await expect(recoverPausedOrphanUsage(database.pool as never, owner, new Date("2026-10-06T12:00:00.000Z"))).resolves.toBe(false)
    expect(database.metrics()).toMatchObject({ stepUpdates: 0, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })
  })

  it.each([
    ["missing usage cause", { orphanUsageCausation: null }],
    ["wrong usage cause", { orphanUsageCausation: orphanModelStartedId }],
    ["foreign usage cause", { orphanUsageCausation: "turn:foreign-turn:event:model-completed:step-1" }],
    ["wrong completion cause", { orphanCompletedCausation: "turn:foreign-turn:event:model-started:step-1" }],
    ["missing completion receipt", { orphanCompleted: false }],
    ["out-of-order completion", { orphanCompletedSequence: "8" }],
    ["out-of-order usage", { orphanUsageSequence: "10" }],
  ] as const)("rejects orphan model recovery with %s", async (_name, chain) => {
    const database = cancellationDatabase({ withCallRow: false, orphanStarted: true, orphanCompleted: true, orphanUsage: true, orphanPause: true, ...chain })
    await expect(recoverPausedOrphanUsage(database.pool as never, owner, new Date("2026-10-06T12:00:00.000Z")))
      .rejects.toMatchObject({ code: "question_receipt_malformed" })
    expect(database.metrics()).toMatchObject({ stepUpdates: 0, eventSequenceUpdates: 0, eventInserts: 0, outboxInserts: 0 })
    expect(database.state().step.status).toBe("streaming")
  })
})
