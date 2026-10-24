import type { Pool } from "pg"
import { describe, expect, it, vi } from "vitest"
import { seedScheduledGatePrepareFixture } from "./scheduled-gate-prepare-pg.fixture.js"

describe("scheduled Gate Prepare PG seed options", () => {
  it.each([
    ["zero jobs", { jobCount: 0 }],
    ["more jobs than the fixture schedule cap", { jobCount: 11 }],
    ["fractional job count", { jobCount: 1.5 }],
    ["score outside the persisted snapshot range", { minScore: 101 }],
    ["fractional score", { minScore: 70.5 }],
    ["unknown option", { jobCount: 1, appendPrepare: true }],
  ])("rejects %s before opening a database connection", async (_name, options) => {
    const connect = vi.fn()
    const pool = { connect } as unknown as Pool

    await expect(seedScheduledGatePrepareFixture(pool, options)).rejects.toThrow(
      "scheduled_gate_prepare_fixture_options_invalid",
    )
    expect(connect).not.toHaveBeenCalled()
  })
})
