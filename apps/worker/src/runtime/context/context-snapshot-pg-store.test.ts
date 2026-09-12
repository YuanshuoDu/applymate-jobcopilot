import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { canonicalJson } from "./context-snapshot-json.js"
import type { StepContextSnapshot } from "./step-context-builder.js"
import { createPgContextSnapshotAdapterStore, ContextSnapshotAdapterStoreError } from "./context-snapshot-pg-store.js"

type QueryResult<T> = { rows: T[]; rowCount: number | null }
type Identity = { userId: string; sessionId: string; turnId: string; stepId: string; idempotencyKey: string }
type Row = Identity & { id: string; snapshotRef: string; snapshot: unknown; byteCount: number; createdAt: Date }

const identity: Identity = { userId: "user-a", sessionId: "session-a", turnId: "turn-a", stepId: "step-a", idempotencyKey: "compact-a" }
const scope: TenantScope = { userId: identity.userId }
const snapshot: StepContextSnapshot = {
  system: [{ id: "system", content: "system" }],
  profile: [{ id: "profile", content: "profile" }],
  goal: { id: "goal", content: "goal" },
  steerHistory: [{ id: "steer", content: "steer" }],
  businessRefs: [{ id: "job", kind: "job", ownerId: identity.userId }],
  toolObservations: [{ id: "context-summary:step-a", content: { kind: "context_summary", value: "summary" } }],
}

function snapshotRef(value: Identity, content: StepContextSnapshot): string {
  return createHash("sha256").update(canonicalJson({ ...value, snapshot: content }), "utf8").digest("hex")
}

function request(overrides: Partial<Identity> = {}, content = snapshot) {
  const value = { ...identity, ...overrides }
  return { snapshotRef: snapshotRef(value, content), scope: { userId: value.userId }, sessionId: value.sessionId, turnId: value.turnId, stepId: value.stepId, idempotencyKey: value.idempotencyKey, snapshot: content }
}

class FakeClient {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  readonly client: pg.PoolClient
  row: Row | null
  readonly owner: Identity
  failOn: string | null = null
  insertAttempts = 0
  released = false

  constructor(row: Row | null = null, owner: Identity = identity) {
    this.row = row
    this.owner = owner
    this.client = this as unknown as pg.PoolClient
  }

  async query<T>(sql: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push({ sql, values })
    if (this.failOn && sql.includes(this.failOn)) throw new Error("query failure")
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 } as QueryResult<T>
    if (sql.includes('FROM "agent_steps"')) {
      const matches = values?.[0] === this.owner.stepId && values?.[1] === this.owner.turnId && values?.[2] === this.owner.sessionId && values?.[3] === this.owner.userId
      return { rows: matches ? [{ id: this.owner.stepId } as T] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_turns" AS turn')) {
      const matches = values?.[0] === this.owner.turnId && values?.[1] === this.owner.sessionId && values?.[2] === this.owner.userId
      return { rows: matches ? [{ id: this.owner.turnId } as T] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.startsWith('INSERT INTO "agent_context_compaction_snapshots"')) {
      this.insertAttempts += 1
      const next = values as readonly unknown[]
      const nextIdentity: Identity = { userId: String(next[1]), sessionId: String(next[2]), turnId: String(next[3]), stepId: String(next[4]), idempotencyKey: String(next[5]) }
      const conflict = this.row && (sameIdentity(this.row, nextIdentity) || this.row.snapshotRef === next[6])
      if (conflict) return { rows: [], rowCount: 0 } as QueryResult<T>
      const encoded = String(next[7])
      this.row = { id: String(next[0]), ...nextIdentity, snapshotRef: String(next[6]), snapshot: JSON.parse(encoded), byteCount: Number(next[8]), createdAt: next[9] as Date }
      return { rows: [this.row as T], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_context_compaction_snapshots"') && sql.includes('"userId" = $1')) {
      const valuesList = values ?? []
      const found = this.row && sameIdentity(this.row, { userId: String(valuesList[0]), sessionId: String(valuesList[1]), turnId: String(valuesList[2]), stepId: String(valuesList[3]), idempotencyKey: String(valuesList[4]) })
      return { rows: found ? [this.row as T] : [], rowCount: found ? 1 : 0 }
    }
    if (sql.includes('FROM "agent_context_compaction_snapshots"') && sql.includes('"snapshotRef" = $1')) {
      const valuesList = values ?? []
      const found = this.row && this.row.snapshotRef === valuesList[0] && this.row.userId === valuesList[1] && this.row.sessionId === valuesList[2] && this.row.turnId === valuesList[3]
      return { rows: found ? [this.row as T] : [], rowCount: found ? 1 : 0 }
    }
    return { rows: [], rowCount: 0 } as QueryResult<T>
  }

  release(): void { this.released = true }
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId && left.stepId === right.stepId && left.idempotencyKey === right.idempotencyKey
}

function poolFor(client: FakeClient): Pick<pg.Pool, "connect"> { return { connect: async () => client.client } }

describe("PostgreSQL context snapshot adapter store", () => {
  it("round-trips through save, load, and idempotency lookup", async () => {
    const client = new FakeClient()
    const store = createPgContextSnapshotAdapterStore(poolFor(client))
    const input = request()
    await expect(store.save(input)).resolves.toEqual({ snapshotRef: input.snapshotRef, scope, sessionId: identity.sessionId, turnId: identity.turnId })
    await expect(store.load({ snapshotRef: input.snapshotRef, scope, sessionId: identity.sessionId, turnId: identity.turnId })).resolves.toEqual({ snapshot, scope, sessionId: identity.sessionId, turnId: identity.turnId })
    await expect(store.loadByIdempotencyKey({ scope, sessionId: identity.sessionId, turnId: identity.turnId, stepId: identity.stepId, idempotencyKey: identity.idempotencyKey })).resolves.toMatchObject({ snapshotRef: input.snapshotRef, snapshot, scope })
    expect(client.calls.filter(call => call.sql === "BEGIN")).toHaveLength(3)
    expect(client.calls.filter(call => call.sql.includes("set_config"))).toHaveLength(3)
  })

  it("replays the same identity without creating a second row", async () => {
    const client = new FakeClient()
    const store = createPgContextSnapshotAdapterStore(poolFor(client))
    const input = request()
    const first = await store.save(input)
    const second = await store.save(input)
    expect(second).toEqual(first)
    expect(client.row).toBeTruthy()
    expect(client.insertAttempts).toBe(2)
    expect(client.calls.filter(call => call.sql.startsWith('INSERT INTO "agent_context_compaction_snapshots"'))).toHaveLength(2)
  })

  it("fails closed for concurrent same identity and conflicting content", async () => {
    const client = new FakeClient()
    const store = createPgContextSnapshotAdapterStore(poolFor(client))
    const input = request()
    const same = await Promise.all([store.save(input), store.save(input)])
    expect(same[0]).toEqual(same[1])
    const changed = { ...snapshot, toolObservations: [...snapshot.toolObservations, { id: "recent", content: "different" }] }
    const result = await Promise.allSettled([store.save(input), store.save(request({}, changed))])
    expect(result.filter(item => item.status === "rejected")).toHaveLength(1)
    expect(result.find(item => item.status === "rejected")).toMatchObject({ reason: { code: "snapshot_conflict" } })
  })

  it("fails closed for cross-user, session, turn, and step identities", async () => {
    const client = new FakeClient()
    const store = createPgContextSnapshotAdapterStore(poolFor(client))
    const input = request()
    await store.save(input)
    await expect(store.save(request({ userId: "user-b" }))).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.save(request({ sessionId: "session-b" }))).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.save(request({ turnId: "turn-b" }))).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.save(request({ stepId: "step-b" }))).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.load({ snapshotRef: input.snapshotRef, scope: { userId: "user-b" }, sessionId: identity.sessionId, turnId: identity.turnId })).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.load({ snapshotRef: input.snapshotRef, scope, sessionId: "session-b", turnId: identity.turnId })).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.load({ snapshotRef: input.snapshotRef, scope, sessionId: identity.sessionId, turnId: "turn-b" })).rejects.toMatchObject({ code: "snapshot_scope_error" })
    await expect(store.loadByIdempotencyKey({ scope, sessionId: identity.sessionId, turnId: identity.turnId, stepId: "step-b", idempotencyKey: identity.idempotencyKey })).rejects.toMatchObject({ code: "snapshot_scope_error" })
  })

  it("rejects malformed rows, oversized snapshots, and reference mismatches", async () => {
    const input = request()
    const malformed = (changes: Partial<Row>) => {
      const row: Row = { id: "snapshot-a", ...identity, snapshotRef: input.snapshotRef, snapshot, byteCount: Buffer.byteLength(canonicalJson(snapshot), "utf8"), createdAt: new Date("2026-09-12T00:00:00Z"), ...changes }
      return createPgContextSnapshotAdapterStore(poolFor(new FakeClient(row)))
    }
    await expect(malformed({ snapshotRef: "z".repeat(64) }).loadByIdempotencyKey({ scope, sessionId: identity.sessionId, turnId: identity.turnId, stepId: identity.stepId, idempotencyKey: identity.idempotencyKey })).rejects.toMatchObject({ code: "snapshot_corrupt" })
    await expect(malformed({ snapshotRef: "0".repeat(64) }).loadByIdempotencyKey({ scope, sessionId: identity.sessionId, turnId: identity.turnId, stepId: identity.stepId, idempotencyKey: identity.idempotencyKey })).rejects.toMatchObject({ code: "snapshot_reference_mismatch" })
    await expect(malformed({ byteCount: 0 }).loadByIdempotencyKey({ scope, sessionId: identity.sessionId, turnId: identity.turnId, stepId: identity.stepId, idempotencyKey: identity.idempotencyKey })).rejects.toMatchObject({ code: "snapshot_corrupt" })
    const oversized = { ...snapshot, toolObservations: [{ id: "large", content: "x".repeat(270 * 1024) }] }
    const largeRow: Row = { id: "snapshot-large", ...identity, snapshotRef: input.snapshotRef, snapshot: oversized, byteCount: 270 * 1024, createdAt: new Date() }
    await expect(createPgContextSnapshotAdapterStore(poolFor(new FakeClient(largeRow))).loadByIdempotencyKey({ scope, sessionId: identity.sessionId, turnId: identity.turnId, stepId: identity.stepId, idempotencyKey: identity.idempotencyKey })).rejects.toBeInstanceOf(ContextSnapshotAdapterStoreError)
  })

  it("rolls back and releases the client when a write fails", async () => {
    const client = new FakeClient()
    client.failOn = "INSERT INTO"
    const store = createPgContextSnapshotAdapterStore(poolFor(client))
    await expect(store.save(request())).rejects.toThrow("query failure")
    expect(client.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(client.released).toBe(true)
  })
})
