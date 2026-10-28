import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import type { ValidatedRootTaskHistoryOutcome } from "./root-task-history.js"
import type { RootTaskHistoryFence } from "./root-task-history-fence.js"
import type { RootTaskHistorySessionAuthorization } from "./root-task-history-session-memory.js"
import { ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE } from "./root-task-history-session-memory.js"
import {
  ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE, withRootTaskHistoryObjectiveSnapshot,
  type RootTaskHistoryObjectiveSnapshotInput,
} from "./root-task-history-objective-snapshot.js"

const fence: RootTaskHistoryFence = { currentStartSequence: 5n, currentStartCreatedAt: new Date("2026-10-28T12:00:00Z"),
  objectiveDigest: "c".repeat(64), currentOrigin: '["user","none"]' }
const authorization: RootTaskHistorySessionAuthorization = { eventId: "authorization-event-1", sessionId: "session-1", userId: "user-1",
  consentVersion: 4, consentEnabled: true, gateEnabledAtCapture: false }
const outcome: ValidatedRootTaskHistoryOutcome = { sourceTurnId: "old-turn", sourceRootTaskId: "old-root", terminalSequence: 30n,
  terminalAt: new Date("2026-10-27T10:00:00Z"), sourceSessionDiffers: true,
  taskGraph: { revision: 1, nodes: [{ templateId: "scout", status: "completed", goal: "PRIVATE GOAL", discoveryQueryFootprint: { location: "PRIVATE LOCATION" } }] } as unknown as ValidatedRootTaskHistoryOutcome["taskGraph"] }
const key = (input: RootTaskHistoryObjectiveSnapshotInput) => {
  const id = JSON.stringify({ schemaVersion: "agent-harness.v2.root-task-history-objective-snapshot.v1", sessionId: input.lease.sessionId,
    userId: input.lease.userId, authorizationEventId: input.authorization.eventId, consentVersion: input.authorization.consentVersion,
    gateEnabledAtCapture: input.authorization.gateEnabledAtCapture, objectiveDigest: input.fence.objectiveDigest,
    canonicalOrigin: input.fence.currentOrigin, intentKind: null, intentVersion: null, acceptedInputRevision: input.acceptedInputRevision.toString(),
    steerEvidence: "no_accepted_steer" })
  return `root-task-history-objective-snapshot:${input.lease.sessionId}:${createHash("sha256").update(id, "utf8").digest("hex")}:v1`
}
const eventId = (value: string) => `agent-root-task-history-${createHash("sha256").update(value).digest("hex")}`

function fakeClient() {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = []
  const events: Array<Record<string, unknown>> = [], outboxes: Array<Record<string, unknown>> = []
  let sequence = 0
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_events"')) {
      const rows = events.filter(row => row.idempotencyKey === values[0] || row.id === values[1])
      return { rows }
    }
    if (sql.includes('FROM "agent_turns" turn')) {
      const row = events.find(value => value.turnId === values[0] && value.sessionId === values[1])
      return { rows: row ? [{ id: row.turnId, rootId: row.taskId }] : [] }
    }
    if (sql.includes('FROM "agent_outbox"') && sql.includes('"topic"')) {
      return { rows: outboxes.filter(row => row.idempotencyKey === values[0] || row.id === values[1]) }
    }
    if (sql.includes('FROM "agent_outbox"')) return { rows: outboxes.filter(row => row.idempotencyKey === values[0] || row.id === values[1]) }
    if (sql.startsWith('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: ++sequence }] }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      events.push({ id: values[0], sessionId: values[1], turnId: values[2], itemId: null, taskId: values[3], sequence: values[4],
        type: values[5], actor: "orchestrator", correlationId: values[3], causationId: null, idempotencyKey: values[6], payload: JSON.parse(String(values[7])) })
      return { rows: [] }
    }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) {
      outboxes.push({ id: values[0], topic: values[1], aggregateId: values[2], idempotencyKey: values[3], payload: JSON.parse(String(values[4])) })
      return { rows: [] }
    }
    return { rows: [] }
  })
  const client = { query } as unknown as Pick<pg.PoolClient, "query">
  return { client, calls, events, outboxes }
}

function input(client: Pick<pg.PoolClient, "query">, load = vi.fn(async () => [outcome])): RootTaskHistoryObjectiveSnapshotInput {
  return { client, lease: { userId: "user-1", sessionId: "session-1", turnId: "turn-current", ownerId: "worker-1", leaseVersion: 2,
    leaseStartedAt: new Date("2026-10-28T11:59:00Z"), leaseExpiresAt: new Date("2026-10-28T12:05:00Z") }, rootTaskId: "root-current",
    authorization, fence, acceptedInputRevision: 0n, steerEvidence: { kind: "no_accepted_steer" }, loadOutcomes: load }
}

describe("root task history objective snapshot", () => {
  it("uses the private snapshot event type excluded from public session surfaces", () => {
    expect(ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE).toBe(ROOT_TASK_HISTORY_MEMORY_SNAPSHOT_EVENT_TYPE)
    expect(ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE).toBe("agent.plan.root_task_history_memory_snapshot")
  })

  it("persists safe prior-session outcomes and deterministic event/outbox in the caller-owned transaction", async () => {
    const fake = fakeClient(), load = vi.fn(async () => [outcome]), request = input(fake.client, load)
    const result = await withRootTaskHistoryObjectiveSnapshot(request)
    expect(result?.reused).toBe(false)
    expect(result?.outcomes).toHaveLength(1)
    expect(result?.outcomes[0]?.sourceTurnId).toBe("old-turn")
    expect(result?.outcomes[0]?.taskGraph.nodes[0]).toEqual({ templateId: "scout", status: "completed" })
    expect(fake.events).toHaveLength(1)
    expect(fake.events[0]).toMatchObject({ id: eventId(key(request)), type: ROOT_TASK_HISTORY_OBJECTIVE_SNAPSHOT_EVENT_TYPE,
      sessionId: "session-1", turnId: "turn-current", taskId: "root-current", sequence: "1" })
    expect(fake.outboxes).toHaveLength(1)
    expect(fake.outboxes[0]).toMatchObject({ id: `agent-outbox-${eventId(key(request))}`, topic: "agent.events" })
    const payload = JSON.stringify(fake.events[0]?.payload)
    expect(payload).not.toContain("PRIVATE GOAL")
    expect(payload).not.toContain("PRIVATE LOCATION")
    expect(payload).not.toContain("discoveryQueryFootprint")
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(8192)
    expect(load).toHaveBeenCalledOnce()
    expect(fake.calls.some(call => /BEGIN|COMMIT|ROLLBACK/.test(call.sql))).toBe(false)
  })

  it("replays the exact immutable snapshot without rereading source outcomes", async () => {
    const fake = fakeClient(), first = input(fake.client)
    await withRootTaskHistoryObjectiveSnapshot(first)
    const loader = vi.fn(async () => [outcome])
    const replay = await withRootTaskHistoryObjectiveSnapshot(input(fake.client, loader))
    expect(replay).toMatchObject({ reused: true, outcomes: [{ sourceTurnId: "old-turn" }] })
    expect(loader).not.toHaveBeenCalled()
    expect(fake.events).toHaveLength(1)
    expect(fake.outboxes).toHaveLength(1)
  })

  it("rejects an existing snapshot whose outbox identity was changed", async () => {
    const fake = fakeClient(), request = input(fake.client)
    await withRootTaskHistoryObjectiveSnapshot(request)
    fake.outboxes[0]!.topic = "agent.other"
    await expect(withRootTaskHistoryObjectiveSnapshot(request)).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("rejects duplicate events with the same snapshot idempotency key", async () => {
    const fake = fakeClient(), request = input(fake.client)
    await withRootTaskHistoryObjectiveSnapshot(request)
    fake.events.push({ ...fake.events[0]! })
    await expect(withRootTaskHistoryObjectiveSnapshot(request)).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("rejects a snapshot event with a mismatched event id", async () => {
    const fake = fakeClient(), request = input(fake.client)
    await withRootTaskHistoryObjectiveSnapshot(request)
    fake.events[0]!.id = "wrong-event-id"
    await expect(withRootTaskHistoryObjectiveSnapshot(request)).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("rejects a snapshot event with a mismatched idempotency key", async () => {
    const fake = fakeClient(), request = input(fake.client)
    await withRootTaskHistoryObjectiveSnapshot(request)
    fake.events[0]!.idempotencyKey = "wrong-idempotency-key"
    await expect(withRootTaskHistoryObjectiveSnapshot(request)).rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("records an immutable empty snapshot and never queries history for absent consent or unsafe steer", async () => {
    const fake = fakeClient(), emptyLoader = vi.fn(async () => []), empty = await withRootTaskHistoryObjectiveSnapshot(input(fake.client, emptyLoader))
    expect(empty).toEqual({ outcomes: [], reused: false })
    expect(fake.events).toHaveLength(1)
    const replay = await withRootTaskHistoryObjectiveSnapshot(input(fake.client, vi.fn(async () => [outcome])))
    expect(replay).toEqual({ outcomes: [], reused: true })
    const noConsent = await withRootTaskHistoryObjectiveSnapshot({ ...input(fake.client), authorization: { ...authorization, consentEnabled: false },
      loadOutcomes: vi.fn(async () => [outcome]) })
    const steered = await withRootTaskHistoryObjectiveSnapshot({ ...input(fake.client), steerEvidence: { kind: "accepted_steer" },
      loadOutcomes: vi.fn(async () => [outcome]) })
    expect(noConsent).toBeUndefined()
    expect(steered).toBeUndefined()
    expect(fake.events).toHaveLength(1)
  })

  it("fails closed on corrupt replay payload, owner mismatch, orphan outbox, or non-prior outcomes", async () => {
    const fake = fakeClient(), request = input(fake.client)
    await withRootTaskHistoryObjectiveSnapshot(request)
    const eventPayload = fake.events[0]?.payload as Record<string, unknown>
    eventPayload.objectiveDigest = "wrong"
    await expect(withRootTaskHistoryObjectiveSnapshot(request)).rejects.toMatchObject({ code: "persistence_conflict" })

    const ownerFake = fakeClient()
    await withRootTaskHistoryObjectiveSnapshot(input(ownerFake.client))
    const ownerEvent = ownerFake.events[0]!
    ownerEvent.sessionId = "another-session"
    await expect(withRootTaskHistoryObjectiveSnapshot(input(ownerFake.client))).rejects.toMatchObject({ code: "persistence_conflict" })

    const orphanFake = fakeClient()
    const orphanKey = key(input(orphanFake.client)), orphanId = eventId(orphanKey)
    orphanFake.outboxes.push({ id: `agent-outbox-${orphanId}`, topic: "agent.events", aggregateId: "session-1",
      idempotencyKey: `agent-event:${orphanId}`, payload: {} })
    const sourceFuture = { ...outcome, terminalAt: new Date("2026-10-28T12:00:00Z") }
    await expect(withRootTaskHistoryObjectiveSnapshot(input(orphanFake.client, vi.fn(async () => [sourceFuture]))))
      .rejects.toMatchObject({ code: "persistence_conflict" })
  })
})
