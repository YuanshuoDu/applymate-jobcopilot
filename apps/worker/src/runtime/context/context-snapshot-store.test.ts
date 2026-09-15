import { describe, expect, it } from "vitest"
import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { snapshotCanonicalJson, snapshotChecksum } from "./context-snapshot-canonical.js"
import { createPgContextSnapshotStore } from "./context-snapshot-store.js"
import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, type AgentContextSnapshot } from "./context-snapshot-types.js"

type QueryResult<T> = { rows: T[]; rowCount: number }
type Row = {
  id: string
  sessionId: string
  throughSequence: string
  version: number
  schemaVersion: string
  content: unknown
  summary: string
  checksum: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: string
  tokenAccounting: unknown
  createdAt: Date
}

function snapshot(): AgentContextSnapshot {
  const content = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ownerId: "user-a",
    sessionId: "session-a",
    throughSequence: "3",
    goal: "Test snapshot",
    userConstraints: [],
    confirmedDecisions: [],
    completedWork: [],
    openWork: [],
    pendingApprovals: [],
    artifacts: [],
    facts: [],
    failedAttempts: [],
    references: [],
    consumedInputIds: [],
    context: { system: [], profile: [], steerHistory: [], toolObservations: [] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
  } as const
  const base = { sessionId: "session-a", throughSequence: 3n, version: 1, content }
  return {
    ...base,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    summary: "Goal: Test snapshot",
    memorySummary: "Goal: Test snapshot",
    checksum: snapshotChecksum(base),
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    tokenAccounting: content.tokenAccounting,
    canonicalJson: snapshotCanonicalJson(base),
  }
}

class FakeClient {
  readonly calls: string[] = []
  readonly client: pg.PoolClient
  private row: Row
  private readonly visible: boolean
  private readonly sessionStatus: string
  private readonly sessionUserId: string

  constructor(value: AgentContextSnapshot, options: { visible?: boolean; checksum?: string; sessionStatus?: string; sessionUserId?: string } = {}) {
    this.visible = options.visible ?? true
    this.sessionStatus = options.sessionStatus ?? "running"
    this.sessionUserId = options.sessionUserId ?? "user-a"
    this.row = {
      id: value.id ?? "snapshot-1",
      sessionId: value.sessionId,
      throughSequence: value.throughSequence.toString(),
      version: value.version,
      schemaVersion: value.schemaVersion,
      content: value.content,
      summary: value.summary,
      checksum: options.checksum ?? value.checksum,
      inputTokens: value.inputTokens,
      outputTokens: value.outputTokens,
      estimatedCostUsd: value.estimatedCostUsd.toFixed(8),
      tokenAccounting: value.tokenAccounting,
      createdAt: new Date("2026-09-02T00:00:00.000Z"),
    }
    this.client = this as unknown as pg.PoolClient
  }

  async query<T>(text: string, values?: readonly unknown[]): Promise<QueryResult<T>> {
    this.calls.push(text)
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) return { rows: [], rowCount: 0 } as QueryResult<T>
    if (text.includes('FROM "agent_sessions"') && text.includes("FOR UPDATE")) {
      const allowed = this.visible && values?.[0] === this.row.sessionId && values?.[1] === this.sessionUserId
        && !["aborted", "archived"].includes(this.sessionStatus)
      return { rows: allowed ? [{ id: this.row.sessionId } as T] : [], rowCount: allowed ? 1 : 0 }
    }
    if (text.startsWith('INSERT INTO "agent_context_snapshots"')) return { rows: [this.row as T], rowCount: 1 }
    if (text.startsWith('UPDATE "agent_sessions"')) return { rows: [], rowCount: 1 } as QueryResult<T>
    if (text.includes('FROM "agent_context_snapshots" AS snapshot')) return { rows: this.visible ? [this.row as T] : [], rowCount: this.visible ? 1 : 0 }
    if (text.includes('FROM "agent_context_snapshots"')) return { rows: this.visible ? [this.row as T] : [], rowCount: this.visible ? 1 : 0 }
    void values
    return { rows: [], rowCount: 0 } as QueryResult<T>
  }

  release(): void {}
}

function poolFor(client: FakeClient): Pick<pg.Pool, "connect"> {
  return { connect: async () => client.client }
}

const scope: TenantScope = { userId: "user-a" }

describe("PostgreSQL context snapshot store", () => {
  it("saves idempotently, projects memorySummary, and loads with tenant scope", async () => {
    const value = snapshot()
    const client = new FakeClient(value)
    const store = createPgContextSnapshotStore(poolFor(client))
    const saved = await store.save(value, scope)
    const loaded = await store.load({ scope, sessionId: "session-a", throughSequence: 3n })
    expect(saved.checksum).toBe(value.checksum)
    expect(loaded?.canonicalJson).toBe(value.canonicalJson)
    const sessionLock = client.calls.findIndex((sql) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const insert = client.calls.findIndex((sql) => sql.startsWith('INSERT INTO "agent_context_snapshots"'))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(insert)
    expect(client.calls[sessionLock]).toContain('"userId" = $2')
    expect(client.calls[sessionLock]).toContain('"status" NOT IN (\'aborted\', \'archived\')')
    expect(client.calls.some((sql) => sql.includes('session."userId" = $3'))).toBe(true)
    expect(client.calls.some((sql) => sql.includes('SET "memorySummary"'))).toBe(true)
  })

  it.each(["aborted", "archived"])("rejects save for a %s session before snapshot writes", async sessionStatus => {
    const value = snapshot()
    const client = new FakeClient(value, { sessionStatus })
    const store = createPgContextSnapshotStore(poolFor(client))

    await expect(store.save(value, scope)).rejects.toMatchObject({ code: "session_not_found" })
    const sessionLock = client.calls.find((sql) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    expect(sessionLock).toContain('"status" NOT IN (\'aborted\', \'archived\')')
    expect(sessionLock).toContain("FOR UPDATE")
    expect(client.calls.some((sql) => sql.startsWith('INSERT INTO "agent_context_snapshots"'))).toBe(false)
    expect(client.calls.some((sql) => sql.includes('SET "memorySummary"'))).toBe(false)
    expect(client.calls).toContain("ROLLBACK")
  })

  it.each([
    ["missing", { visible: false }],
    ["cross-user", { sessionUserId: "user-b" }],
  ] as const)("rejects %s save before snapshot writes", (_label, options) => {
    const value = snapshot()
    const client = new FakeClient(value, options)
    const store = createPgContextSnapshotStore(poolFor(client))
    return expect(store.save(value, scope)).rejects.toMatchObject({ code: "session_not_found" }).then(() => {
      expect(client.calls.some((sql) => sql.startsWith('INSERT INTO "agent_context_snapshots"'))).toBe(false)
      expect(client.calls.some((sql) => sql.includes('SET "memorySummary"'))).toBe(false)
      expect(client.calls).toContain("ROLLBACK")
    })
  })

  it("returns null for an invisible tenant row and rejects corrupted checksums", async () => {
    const value = snapshot()
    const hidden = new FakeClient(value, { visible: false })
    const hiddenStore = createPgContextSnapshotStore(poolFor(hidden))
    await expect(hiddenStore.load({ scope, sessionId: "session-a", throughSequence: 3n })).resolves.toBeNull()
    const corrupt = new FakeClient(value, { checksum: "0".repeat(64) })
    const corruptStore = createPgContextSnapshotStore(poolFor(corrupt))
    await expect(corruptStore.load({ scope, sessionId: "session-a", throughSequence: 3n })).rejects.toMatchObject({ code: "checksum_mismatch" })
  })

  it("rejects a snapshot whose content owner does not match the persistence scope", async () => {
    const value = snapshot()
    const client = new FakeClient(value)
    const store = createPgContextSnapshotStore({ connect: async () => client as unknown as pg.PoolClient })
    await expect(store.save(value, { userId: "user-b" })).rejects.toMatchObject({ code: "reference_cross_tenant" })
    expect(client.calls).toHaveLength(0)
  })
})
