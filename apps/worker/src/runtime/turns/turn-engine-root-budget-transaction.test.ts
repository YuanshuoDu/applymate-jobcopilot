import { describe, expect, it, vi } from "vitest"
import { withRootBudgetTenantSnapshot } from "./turn-engine-root-budget-transaction.js"

const BEGIN = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"
const SET_TENANT = "SELECT set_config('app.user_id', $1, true)"

describe("root budget tenant snapshot", () => {
  it("sets the bound owner before reading and commits the same repeatable snapshot", async () => {
    const client = { query: vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({ rows: [] })) }
    const read = vi.fn(async () => "snapshot")

    await expect(withRootBudgetTenantSnapshot(client as never, "owner-user", read)).resolves.toBe("snapshot")

    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([BEGIN, SET_TENANT, "COMMIT"])
    expect(client.query.mock.calls[1]?.[1]).toEqual(["owner-user"])
    expect(read).toHaveBeenCalledOnce()
  })

  it.each(["tenant setup", "snapshot read", "commit"] as const)("rolls back and preserves a %s failure", async failure => {
    const client = { query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      if (sql === SET_TENANT && failure === "tenant setup") throw new Error("tenant_setup_failed")
      if (sql === "owned read" && failure === "snapshot read") throw new Error("snapshot_read_failed")
      if (sql === "COMMIT" && failure === "commit") throw new Error("commit_failed")
      return { rows: [] }
    }) }
    const read = vi.fn(async () => { await client.query("owned read"); return "snapshot" })

    await expect(withRootBudgetTenantSnapshot(client as never, "owner-user", read)).rejects.toThrow(
      failure === "tenant setup" ? "tenant_setup_failed" : failure === "snapshot read" ? "snapshot_read_failed" : "commit_failed",
    )
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(
      failure === "tenant setup" ? [BEGIN, SET_TENANT, "ROLLBACK"]
        : failure === "snapshot read" ? [BEGIN, SET_TENANT, "owned read", "ROLLBACK"]
          : [BEGIN, SET_TENANT, "owned read", "COMMIT", "ROLLBACK"],
    )
    expect(read).toHaveBeenCalledTimes(failure === "tenant setup" ? 0 : 1)
  })
})