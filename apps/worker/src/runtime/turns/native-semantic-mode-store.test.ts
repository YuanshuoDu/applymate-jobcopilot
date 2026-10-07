import { describe, expect, it, vi } from "vitest"

import { resolveNativeSemanticProgressModeWithClient } from "./native-semantic-mode-store.js"
import type { TurnEngineQueryClient } from "./turn-engine-owner-sql.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "u", sessionId: "s", turnId: "t", taskId: "root", rootTaskId: "root",
  ownerId: "lease", leaseVersion: 3, leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
}
function client(options: { mode?: unknown; column?: boolean; steps?: boolean; ledger?: boolean; canSelect?: boolean; canInsert?: boolean } = {}) {
  const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "s" }], rowCount: 1 }
    if (sql.startsWith('SELECT turn."id"')) return { rows: [{ id: "t" }], rowCount: 1 }
    if (sql.includes("to_jsonb(turn)")) return { rows: [{ mode: options.mode ?? null }], rowCount: 1 }
    if (sql.includes("information_schema.columns")) return { rows: [{ present: options.column ?? true }], rowCount: 1 }
    if (sql.includes("has_table_privilege")) return { rows: [{ tablePresent: options.ledger ?? true, canSelect: options.canSelect ?? true, canInsert: options.canInsert ?? true }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: [{ present: options.steps ?? false }], rowCount: 1 }
    if (sql.startsWith('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
    throw new Error(`unexpected query: ${sql.slice(0, 45)}`)
  })
  return { query, db: { query } as unknown as TurnEngineQueryClient }
}
const input = { owner, now: new Date("2026-10-07T00:00:00Z") }

describe("native semantic progress mode store", () => {
  it("keeps legacy flag-off reads compatible with a database lacking the new column", async () => {
    const mock = client({ column: false })
    await expect(resolveNativeSemanticProgressModeWithClient(mock.db, { ...input, requestedEnabled: false })).resolves.toBe("legacy_v1")
    expect(mock.query.mock.calls.some(([sql]) => sql.includes("information_schema") || sql.startsWith("UPDATE"))).toBe(false)
  })

  it("pins durable mode only for an enabled pristine root Turn", async () => {
    const mock = client()
    await expect(resolveNativeSemanticProgressModeWithClient(mock.db, { ...input, requestedEnabled: true })).resolves.toBe("durable_v1")
    const update = mock.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "agent_turns"'))
    expect(update?.[1]).toEqual(["durable_v1", input.now, "t", "s", "u"])
  })

  it("pins legacy for a Turn that already has Steps when the flag is first enabled", async () => {
    const mock = client({ steps: true })
    await expect(resolveNativeSemanticProgressModeWithClient(mock.db, { ...input, requestedEnabled: true })).resolves.toBe("legacy_v1")
    expect(mock.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE "agent_turns"'))?.[1]?.[0]).toBe("legacy_v1")
  })

  it("continues a persisted mode independent of the current flag", async () => {
    const mock = client({ mode: "durable_v1" })
    await expect(resolveNativeSemanticProgressModeWithClient(mock.db, { ...input, requestedEnabled: false })).resolves.toBe("durable_v1")
    expect(mock.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("fails closed with a typed persistence conflict for invalid mode or missing enabled schema", async () => {
    const invalid = client({ mode: "future_mode" })
    await expect(resolveNativeSemanticProgressModeWithClient(invalid.db, { ...input, requestedEnabled: true }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
    const missing = client({ column: false })
    await expect(resolveNativeSemanticProgressModeWithClient(missing.db, { ...input, requestedEnabled: true }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
    expect(missing.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    for (const dependency of [{ ledger: false }, { canSelect: false }, { canInsert: false }]) {
      const unavailable = client(dependency)
      await expect(resolveNativeSemanticProgressModeWithClient(unavailable.db, { ...input, requestedEnabled: true }))
        .rejects.toMatchObject({ code: "persistence_conflict" })
      expect(unavailable.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE "agent_turns"'))).toBe(false)
    }
    const pinned = client({ mode: "durable_v1", canInsert: false })
    await expect(resolveNativeSemanticProgressModeWithClient(pinned.db, { ...input, requestedEnabled: false }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
  })
})
