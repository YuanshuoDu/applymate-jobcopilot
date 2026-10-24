import type { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { createScheduledGatePrepareFixture } from "./scheduled-gate-prepare-pg-runner.fixture.js"

describe("scheduled Gate Prepare PG runner options", () => {
  it.each([0, 11, 1.5])("rejects invalid jobCount %s before opening database or Redis", async jobCount => {
    const query = vi.fn()
    const pool = { query } as unknown as Pool

    await expect(createScheduledGatePrepareFixture(pool, "redis://unused.invalid", { jobCount }))
      .rejects.toThrow("scheduled_gate_prepare_job_count_invalid")
    expect(query).not.toHaveBeenCalled()
  })
})
