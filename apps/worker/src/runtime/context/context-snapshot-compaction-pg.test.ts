import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { completeCompactionItem, createCompactionStartedItem } from "./context-compaction-items.js"
import type { CompactionSnapshotDraft, CompactionSource } from "./context-compaction-types.js"
import type { CompactionPgClient, CompactionPgPool, CompactionPgRow } from "./context-compaction-pg-store.js"
import { createPgContextSnapshotCompactionPort } from "./context-snapshot-compaction-pg.js"
import { parseSnapshotContent } from "./context-snapshot-canonical.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "root-a", rootTaskId: "root-a",
  ownerId: "worker-a", leaseVersion: 4, leaseExpiresAt: new Date(Date.now() + 60_000),
}
const scope = { userId: owner.userId }
const selectedJobMemory = projectSelectedJobMemory({
  jobId: "job-a", sourceTurnId: owner.turnId, sourceRootTaskId: owner.rootTaskId, throughSequence: "7",
  graph: { revision: 1, nodes: [{ templateId: "analyst", status: "completed", readiness: "terminal" }] },
})!
const source: CompactionSource = {
  state: { ownerId: owner.userId, sessionId: owner.sessionId, throughSequence: 7n, goal: "Find a role", userConstraints: ["EU"], approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [], selectedJobMemories: [selectedJobMemory] },
  items: [{ id: "item-1", sessionId: owner.sessionId, turnId: owner.turnId, sequence: 7n, type: "agent_message", status: "completed", content: "Useful context" }],
}
const started = createCompactionStartedItem({ sessionId: owner.sessionId, turnId: owner.turnId, throughSequence: 7n, source, reason: "manual", id: "compaction-1" })
const report = { preserved: true, preservedFields: ["goal", "approvals", "answers", "artifact_hashes", "open_tasks", "do_not_repeat", "selected_job_memories"] as const, missingFields: [], changedFields: [], beforeDigest: "before", afterDigest: "after" }
const completed = completeCompactionItem(started, { summary: "Short summary", measurement: { beforeInputTokens: 100, afterInputTokens: 40, reductionTokens: 60, reductionRatio: 0.6 }, report })
const draft: CompactionSnapshotDraft = { scope, turnId: owner.turnId, state: source.state, narrativeSummary: "Short summary", tokenMeasurement: { beforeInputTokens: 100, afterInputTokens: 40, reductionTokens: 60, reductionRatio: 0.6 }, sourceItemIds: ["item-1"], reason: "manual" }

type SnapshotRow = { id: string; sessionId: string; throughSequence: string; version: number; checksum: string; content: unknown }
type ItemRow = { sessionId: string; turnId: string; taskId: string; type: string; status: string; revision: number; content: unknown }
type EventRow = { id: string; sessionId: string; turnId: string; itemId: string; taskId: string; sequence: string; type: string; actor: string; correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown }
type OutboxRow = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }
type State = { eventSequence: number; snapshots: SnapshotRow[]; items: Record<string, ItemRow>; events: Record<string, EventRow>; outbox: Record<string, OutboxRow>; contextSnapshotId: string | null }

function fakePool(options: { readonly failCompletedOutbox?: boolean; readonly ownerValid?: boolean; readonly contextSnapshotId?: string | null } = {}) {
  const state: State = { eventSequence: 7, snapshots: [], items: {}, events: {}, outbox: {}, contextSnapshotId: options.contextSnapshotId ?? null }
  let transaction: State | null = null
  let failCompletedOutbox = options.failCompletedOutbox ?? false
  const result = (rows: Record<string, unknown>[] = [], rowCount = rows.length) => ({ rows, rowCount })
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === "BEGIN") { transaction = structuredClone(state); return result() }
    if (sql === "COMMIT") { transaction = null; return result() }
    if (sql === "ROLLBACK") { if (transaction) Object.assign(state, transaction); transaction = null; return result() }
    if (sql.includes("set_config")) return result()
    if (sql.includes('FROM "agent_sessions" AS session')) return result([{ id: owner.sessionId }])
    if (sql.includes('FROM "agent_turns" AS turn')) return options.ownerValid === false ? result() : result([{ id: owner.turnId, contextSnapshotId: state.contextSnapshotId }])
    if (sql.includes('FROM "agent_context_snapshots"')) {
      if (sql.includes('ORDER BY "version"')) return result([...state.snapshots].sort((a, b) => b.version - a.version).slice(0, 1))
      const match = state.snapshots.find(row => row.sessionId === values[0] && (row.throughSequence === String(values[1]) || row.version === Number(values[2])))
      return result(match ? [match] : [])
    }
    if (sql.startsWith('INSERT INTO "agent_context_snapshots"')) {
      const row: SnapshotRow = { id: String(values[0]), sessionId: String(values[1]), throughSequence: String(values[2]), version: Number(values[3]), content: JSON.parse(String(values[4])) as unknown, checksum: String(values[6]) }
      if (state.snapshots.some(existing => existing.sessionId === row.sessionId && (existing.version === row.version || existing.throughSequence === row.throughSequence))) return result([], 0)
      state.snapshots.push(row); return result([row])
    }
    if (sql.includes('SELECT "id", "turnId", "itemId", "taskId", "sequence"') && sql.includes('FROM "agent_events"')) {
      const event = state.events[String(values[1])]; return result(event ? [event] : [])
    }
    if (sql.startsWith('UPDATE "agent_sessions"')) { state.eventSequence += 1; return result([{ eventSequence: state.eventSequence }]) }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      const event: EventRow = { id: String(values[0]), sessionId: String(values[1]), turnId: String(values[2]), itemId: String(values[3]), taskId: String(values[4]), sequence: String(values[5]), type: String(values[6]), actor: "orchestrator", correlationId: String(values[7]), causationId: values[8] === null ? null : String(values[8]), idempotencyKey: String(values[9]), payload: JSON.parse(String(values[10])) as unknown }
      state.events[event.idempotencyKey] = event; return result([], 1)
    }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) {
      if (failCompletedOutbox && String(values[2]).endsWith(":completed")) throw new Error("outbox write failed")
      const key = String(values[2]); if (state.outbox[key]) return result([], 0)
      const row: OutboxRow = { id: String(values[0]), topic: "agent.events", aggregateId: String(values[1]), idempotencyKey: key, payload: JSON.parse(String(values[3])) as unknown }
      state.outbox[key] = row; return result([], 1)
    }
    if (sql.includes('FROM "agent_outbox"')) { const row = state.outbox[String(values[0])]; return result(row ? [row] : []) }
    if (sql.startsWith('INSERT INTO "agent_items"')) {
      const id = String(values[0]); if (state.items[id]) return result([], 0)
      state.items[id] = { sessionId: String(values[1]), turnId: String(values[2]), taskId: String(values[3]), type: String(values[4]), status: "started", revision: 0, content: JSON.parse(String(values[5])) as unknown }
      return result([], 1)
    }
    if (sql.startsWith('UPDATE "agent_items"')) {
      const row = state.items[String(values[2])]
      if (!row || row.status !== "started" || row.revision !== 0) return result([], 0)
      row.status = String(values[0]); row.content = JSON.parse(String(values[1])) as unknown; row.revision += 1; return result([], 1)
    }
    if (sql.includes('FROM "agent_items"')) { const row = state.items[String(values[0])]; return result(row ? [row] : []) }
    throw new Error(`Unexpected SQL in fake: ${sql}`)
  })
  const client = { query, release: vi.fn() }
  const pool = { connect: vi.fn(async () => client as unknown as CompactionPgClient) }
  return { pool: pool as unknown as CompactionPgPool, state, query, failCompletedOutbox: (value: boolean) => { failCompletedOutbox = value } }
}

describe("PostgreSQL context snapshot compaction publisher", () => {
  it("publishes the snapshot, completed Item/Event and outbox as one idempotent transaction", async () => {
    const fake = fakePool()
    const port = createPgContextSnapshotCompactionPort(fake.pool, owner)
    await port.recordStarted(started, scope)
    const previous = await port.loadLatest({ scope, sessionId: owner.sessionId })
    const input = { scope, previousSnapshot: previous, draft, startedItem: started, completedItem: completed }
    const first = await port.publishAtomically(input)
    const second = await port.publishAtomically(input)
    expect(first).toEqual({ id: `context-compaction:${owner.sessionId}:7`, sessionId: owner.sessionId, throughSequence: 7n, version: 1 })
    expect(second).toEqual(first)
    expect(fake.state.snapshots).toHaveLength(1)
    const content = fake.state.snapshots[0]?.content
    expect(parseSnapshotContent(content).compaction?.state?.selectedJobMemories).toEqual([selectedJobMemory])
    expect(fake.state.items[started.id]).toMatchObject({ status: "completed", revision: 1 })
    expect(Object.values(fake.state.events).map(event => event.type)).toEqual(["item.started", "item.completed"])
    expect(Object.keys(fake.state.outbox)).toEqual([`agent-event:${started.id}:started`, `agent-event:${started.id}:completed`])
    expect(fake.state.contextSnapshotId).toBeNull()
    expect(fake.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.query.mock.calls.some(([sql]) => sql.includes('"leaseOwnerId"') && sql.includes('"leaseVersion"') && sql.includes('"leaseExpiresAt" > CURRENT_TIMESTAMP'))).toBe(true)
  })

  it("rolls back the snapshot, Item/Event and outbox when completed publish fails", async () => {
    const fake = fakePool({ failCompletedOutbox: true })
    const port = createPgContextSnapshotCompactionPort(fake.pool, owner)
    await port.recordStarted(started, scope)
    await expect(port.publishAtomically({ scope, previousSnapshot: null, draft, startedItem: started, completedItem: completed })).rejects.toThrow("outbox write failed")
    expect(fake.state.snapshots).toEqual([])
    expect(fake.state.contextSnapshotId).toBeNull()
    expect(fake.state.items[started.id]).toMatchObject({ status: "started", revision: 0 })
    expect(Object.values(fake.state.events).map(event => event.type)).toEqual(["item.started"])
    expect(Object.keys(fake.state.outbox)).toEqual([`agent-event:${started.id}:started`])
    fake.failCompletedOutbox(false)
    await expect(port.publishAtomically({ scope, previousSnapshot: null, draft, startedItem: started, completedItem: completed })).resolves.toMatchObject({ version: 1 })
  })

  it("rejects stale lease fences before inserting the lifecycle Item", async () => {
    const fake = fakePool({ ownerValid: false })
    const port = createPgContextSnapshotCompactionPort(fake.pool, owner)
    await expect(port.recordStarted(started, scope)).rejects.toThrow("owned turn")
    expect(fake.state.items).toEqual({})
    expect(fake.state.events).toEqual({})
    expect(fake.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("rejects publication when the turn has a pinned context snapshot", async () => {
    const fake = fakePool({ contextSnapshotId: "explicit-snapshot" })
    const port = createPgContextSnapshotCompactionPort(fake.pool, owner)
    await expect(port.publishAtomically({ scope, previousSnapshot: null, draft, startedItem: started, completedItem: completed }))
      .rejects.toThrow("explicit context snapshot pin")
    expect(fake.state.snapshots).toEqual([])
    expect(fake.state.items).toEqual({})
    expect(fake.state.events).toEqual({})
    expect(fake.state.outbox).toEqual({})
    expect(fake.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("writes the cumulative narrative summary on a second compaction", async () => {
    const fake = fakePool()
    const port = createPgContextSnapshotCompactionPort(fake.pool, owner)
    await port.recordStarted(started, scope)
    const firstSnapshot = await port.publishAtomically({ scope, previousSnapshot: null, draft, startedItem: started, completedItem: completed })
    const secondSource: CompactionSource = {
      state: { ...source.state, throughSequence: 8n },
      items: [
        { id: "prior-summary", sessionId: owner.sessionId, turnId: owner.turnId, sequence: 7n, type: "compaction_summary", status: "completed", content: "Short summary" },
        { id: "new-tail", sessionId: owner.sessionId, turnId: owner.turnId, sequence: 8n, type: "agent_message", status: "completed", content: "Fresh tail" },
      ],
    }
    const secondStarted = createCompactionStartedItem({ sessionId: owner.sessionId, turnId: owner.turnId, throughSequence: 8n, source: secondSource, reason: "turn_boundary", id: "compaction-2" })
    const secondCompleted = completeCompactionItem(secondStarted, { summary: "Cumulative summary: prior summary plus fresh tail", measurement: draft.tokenMeasurement, report })
    await port.recordStarted(secondStarted, scope)
    const secondSnapshot = await port.publishAtomically({ scope, previousSnapshot: firstSnapshot, draft: { ...draft, state: secondSource.state, narrativeSummary: "Cumulative summary: prior summary plus fresh tail", sourceItemIds: secondSource.items.map(item => item.id) }, startedItem: secondStarted, completedItem: secondCompleted })
    const content = fake.state.snapshots.find(row => row.id === secondSnapshot.id)?.content as { compaction?: { narrativeSummary?: string } } | undefined
    expect(secondSnapshot.version).toBe(2)
    expect(content?.compaction?.narrativeSummary).toBe("Cumulative summary: prior summary plus fresh tail")
  })
})
