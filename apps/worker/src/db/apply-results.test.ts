import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  ensureApplyResultsTable,
  insertApplyResult,
  closePool,
} from "./apply-results.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";

describe.runIf(RUN_INTEGRATION)("apply-results (integration — real Postgres)", () => {
  beforeAll(async () => {
    await ensureApplyResultsTable();
  });

  afterAll(async () => {
    await closePool();
  });

  it("inserts an apply result and returns an id", async () => {
    const id = await insertApplyResult({
      userId: `test-${Date.now()}`,
      jobId: "job-integration-1",
      status: "dry-run",
      durationMs: 250,
    });
    expect(id).toBeGreaterThan(0);
  });

  it("inserts a failed result with error message", async () => {
    const id = await insertApplyResult({
      userId: `test-${Date.now()}`,
      jobId: "job-integration-2",
      status: "failed",
      error: "Connection timeout",
      durationMs: 5000,
    });
    expect(id).toBeGreaterThan(0);
  });
});
