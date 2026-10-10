import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { readRootInputContext, type RootInputContextRow } from "./root-input-context-reader.js"
import type { StoredAgentInput } from "./input-claim-store.js"

const row: RootInputContextRow = {
  id: "root-1", sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: "client-1",
  delivery: "follow_up", status: "consumed", content: [{ type: "text", text: "reference" }], acceptedSequence: "4",
  consumedByStepId: "step-0", consumedAt: new Date("2026-10-01T00:00:00.000Z"), createdAt: new Date("2026-10-01T00:00:00.000Z"),
}

describe("read-only root input context reader", () => {
  it("uses exact tenant/Turn/input scope, live or durably consumed states, owner validation, and a shared row lock", async () => {
    const calls: Array<{ sql: string; values: readonly unknown[] }> = []
    const client = { query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => { calls.push({ sql: String(sql), values }); return { rows: [row] } }) }
    const validateOwner = vi.fn(async () => undefined)
    const mapInput = vi.fn((value: RootInputContextRow) => value as unknown as StoredAgentInput)
    const result = await readRootInputContext(client as unknown as Pick<pg.PoolClient, "query">, { userId: "user-1" }, { sessionId: "session-1", turnId: "turn-1", inputId: "root-1" }, validateOwner, mapInput)
    expect(result).toBe(row)
    expect(validateOwner).toHaveBeenCalledOnce()
    expect(mapInput).toHaveBeenCalledWith(row)
    expect(calls[0].values).toEqual(["session-1", "turn-1", "user-1", "root-1"])
    expect(calls[0].sql).toContain('"delivery" IN (\'steer\', \'follow_up\')')
    expect(calls[0].sql).toContain('"cancelledAt" IS NULL')
    expect(calls[0].sql).toContain('"status" IN (\'accepted\', \'queued\')')
    expect(calls[0].sql).toContain('"status" = \'consumed\' AND "consumedByStepId" IS NOT NULL AND "consumedAt" IS NOT NULL')
    expect(calls[0].sql).toContain("FOR SHARE")
    expect(calls[0].sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i)
  })

  it("returns null when the scoped reader finds no eligible root row", async () => {
    const client = { query: vi.fn(async () => ({ rows: [] })) }
    const result = await readRootInputContext(client as unknown as Pick<pg.PoolClient, "query">, { userId: "user-1" }, { sessionId: "session-1", turnId: "turn-1", inputId: "missing" }, async () => undefined, value => value as unknown as StoredAgentInput)
    expect(result).toBeNull()
  })
})
