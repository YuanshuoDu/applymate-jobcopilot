import type pg from "pg"
import { describe, expect, it, vi } from "vitest"

import { snapshotChecksum } from "./context-snapshot-canonical.js"
import { CONTEXT_SNAPSHOT_SCHEMA_VERSION, ContextSnapshotError } from "./context-snapshot-types.js"
import { loadCanonicalTurnSnapshot } from "./canonical-turn-snapshot-loader.js"
import type { ContextSnapshotRow } from "./context-snapshot-row.js"

const scope = { userId: "user-a" }

function row(): ContextSnapshotRow {
  const content = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ownerId: "user-a",
    sessionId: "session-a",
    throughSequence: "7",
    goal: "Find roles",
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
    context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: "tool-1", content: "Useful summary" }] },
    tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
  }
  return {
    id: "snapshot-1",
    sessionId: "session-a",
    throughSequence: "7",
    version: 2,
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    content,
    summary: "Goal: Find roles",
    checksum: snapshotChecksum({ sessionId: "session-a", throughSequence: 7n, version: 2, content }),
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: "0.00000000",
    tokenAccounting: content.tokenAccounting,
    createdAt: new Date("2026-10-27T00:00:00.000Z"),
  }
}

function fakeClient(rows: readonly ContextSnapshotRow[]) {
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows }))
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

describe("canonical Turn snapshot loader", () => {
  it("loads and validates a pinned full row in the caller transaction", async () => {
    const saved = row()
    const fake = fakeClient([saved])
    const loaded = await loadCanonicalTurnSnapshot(fake.client, {
      scope, sessionId: "session-a", pinnedSnapshotId: saved.id,
    })

    expect(loaded).toMatchObject({ throughSequence: 7n, snapshot: { toolObservations: [{ id: "tool-1", content: "Useful summary" }] } })
    expect(fake.query).toHaveBeenCalledWith(expect.stringContaining('snapshot."checksum" AS "checksum"'), ["snapshot-1", "session-a", "user-a"])
    expect(fake.query.mock.calls[0]?.[0]).toContain('snapshot."id" = $1')
    expect(fake.query.mock.calls[0]?.[0]).toContain('session."userId" = $3')
  })

  it("keeps latest ordering and returns empty when there is no unpinned row", async () => {
    const fake = fakeClient([])
    await expect(loadCanonicalTurnSnapshot(fake.client, { scope, sessionId: "session-a", pinnedSnapshotId: null })).resolves.toBeNull()

    const sql = fake.query.mock.calls[0]?.[0] ?? ""
    expect(sql).toContain('ORDER BY snapshot."throughSequence" DESC, snapshot."version" DESC LIMIT 1')
    expect(fake.query).toHaveBeenCalledWith(expect.any(String), ["session-a", "user-a"])
  })

  it("fails closed for a corrupt selected latest row without another query or fallback", async () => {
    const valid = row()
    const altered = {
      ...(valid.content as Record<string, unknown>),
      context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: "tool-1", content: "CORRUPTED SUMMARY" }] },
    }
    const fake = fakeClient([{ ...valid, content: altered }])
    let caught: unknown
    try {
      await loadCanonicalTurnSnapshot(fake.client, { scope, sessionId: "session-a", pinnedSnapshotId: null })
    } catch (error: unknown) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ContextSnapshotError)
    expect(caught).toMatchObject({ code: "checksum_mismatch" })
    expect(caught instanceof Error ? caught.message : "").not.toContain("CORRUPTED SUMMARY")
    expect(fake.query).toHaveBeenCalledTimes(1)
  })

  it("preserves the missing-pinned error rather than falling back to latest", async () => {
    const fake = fakeClient([])
    await expect(loadCanonicalTurnSnapshot(fake.client, {
      scope, sessionId: "session-a", pinnedSnapshotId: "missing-snapshot",
    })).rejects.toThrow("context_snapshot_missing")
    expect(fake.query).toHaveBeenCalledTimes(1)
    expect(fake.query.mock.calls[0]?.[0]).toContain('snapshot."id" = $1')
  })
})
