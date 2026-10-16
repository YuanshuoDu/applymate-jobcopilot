import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";

const RUN_INTEGRATION = process.env.RUN_INTEGRATION_TESTS === "1";
const identity: ApplicationSubmitIdentity = {
  applicationTaskId: "task-1",
  userId: "user-1",
  jobId: "job-1",
  sessionId: "session-1",
  fillTurnId: "turn-1",
  approvalId: "approval-1",
  constraintHash: "c".repeat(64),
};

async function loadMockedApplyResults(fenceOutcome: "current" | "superseded" = "current") {
  vi.resetModules();
  const query = vi.fn().mockResolvedValue({ rows: [{ id: 19 }], rowCount: 1 });
  const release = vi.fn();
  const client = { query, release };
  const pool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() };
  const fence = vi.fn(async (
    _pool: Pool,
    _attempt: ApplicationSubmitIdentity,
    _phase: string,
    write: (transactionClient: PoolClient) => Promise<number>,
  ) => fenceOutcome === "current"
    ? { kind: "current" as const, value: await write(client as unknown as PoolClient) }
    : { kind: "superseded" as const });
  vi.doMock("pg", () => ({ default: { Pool: vi.fn(() => pool) } }));
  vi.doMock("./submission-guard.js", () => ({ withExactSubmissionWrite: fence }));
  return { module: await import("./apply-results.js"), query, release, pool, fence };
}

afterEach(() => {
  vi.doUnmock("pg");
  vi.doUnmock("./submission-guard.js");
  vi.resetModules();
});

describe("apply-results exact-attempt writes", () => {
  it("rejects canonical submit results without attempt identity", async () => {
    const { module } = await loadMockedApplyResults();

    await expect(module.insertApplyResult({
      userId: "user-1", jobId: "job-1", flowUsed: "application.submit", status: "submitted",
    })).rejects.toThrow("Canonical submit results require an exact application attempt identity.");
  });

  it("inserts a submit result only inside its exact attempt fence", async () => {
    const { module, query, fence } = await loadMockedApplyResults();

    await expect(module.insertApplyResult({
      userId: "user-1", jobId: "job-1", flowUsed: "application.submit", status: "submitted",
      submissionIdentity: identity,
    })).resolves.toBe(19);

    expect(fence).toHaveBeenCalledWith(expect.anything(), identity, "insert_apply_result", expect.any(Function));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO apply_results"), expect.arrayContaining([
      "user-1", "job-1", "unattended", null, "application.submit", "submitted",
    ]));
  });

  it("does not insert or return a success result when the identity was superseded", async () => {
    const { module, query } = await loadMockedApplyResults("superseded");

    await expect(module.insertApplyResult({
      userId: "user-1", jobId: "job-1", flowUsed: "application.submit", status: "submitted",
      submissionIdentity: identity,
    })).resolves.toBeNull();

    expect(query).not.toHaveBeenCalledWith(expect.stringContaining("INSERT INTO apply_results"), expect.anything());
  });
});

describe.runIf(RUN_INTEGRATION)("apply-results (integration — real Postgres)", () => {
  beforeAll(async () => {
    const { ensureApplyResultsTable } = await import("./apply-results.js");
    await ensureApplyResultsTable();
  });

  afterAll(async () => {
    const { closePool } = await import("./apply-results.js");
    await closePool();
  });

  it("inserts an apply result and returns an id", async () => {
    const { insertApplyResult } = await import("./apply-results.js");
    const id = await insertApplyResult({
      userId: `test-${Date.now()}`,
      jobId: "job-integration-1",
      status: "dry-run",
      durationMs: 250,
    });
    expect(id).toBeGreaterThan(0);
  });

  it("inserts a failed result with error message", async () => {
    const { insertApplyResult } = await import("./apply-results.js");
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
