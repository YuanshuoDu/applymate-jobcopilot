import type { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { executeScheduledGatePrepareChild } from "./scheduled-gate-prepare-child-runner.fixture.js"

describe("scheduled Gate Prepare child runner fixture", () => {
  it("rejects an invalid task identity before touching PostgreSQL or Redis", async () => {
    const query = vi.fn(), connect = vi.fn()
    const pool = { query, connect } as unknown as Pool
    await expect(executeScheduledGatePrepareChild(pool, "redis://unused.invalid", {} as never, " "))
      .rejects.toThrow("scheduled_prepare_task_id_invalid")
    expect(query).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})
