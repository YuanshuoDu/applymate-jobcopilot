import type { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { createScheduledGatePrepareFixture, type ScheduledGatePrepareFixtureOptions } from "./scheduled-gate-prepare-pg-runner.fixture.js"

describe("scheduled Gate Prepare PG runner options", () => {
  it.each([0, 11, 1.5])("rejects invalid jobCount %s before opening database or Redis", async jobCount => {
    const query = vi.fn()
    const pool = { query } as unknown as Pool

    await expect(createScheduledGatePrepareFixture(pool, "redis://unused.invalid", { jobCount }))
      .rejects.toThrow("scheduled_gate_prepare_job_count_invalid")
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects a non-boolean supported ATS URL option before opening database or Redis", async () => {
    const query = vi.fn(), connect = vi.fn()
    const pool = { query, connect } as unknown as Pool
    const options = { useSupportedAtsUrl: "yes" } as unknown as ScheduledGatePrepareFixtureOptions

    await expect(createScheduledGatePrepareFixture(pool, "redis://unused.invalid", options))
      .rejects.toThrow("scheduled_gate_prepare_supported_ats_url_invalid")
    expect(query).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})
