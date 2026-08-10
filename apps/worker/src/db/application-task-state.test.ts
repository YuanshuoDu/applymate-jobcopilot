import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { completeFillForReview, isUserActive } from "./application-task-state.js";

function testPool() {
  const query = vi.fn();
  return { pool: { query } as unknown as Pool, query };
}

describe("completeFillForReview", () => {
  it("does not create an authorization when the task was cancelled before the fill pass finished", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(completeFillForReview(pool, "task_1", "user_1", "job_1")).resolves.toBe(false);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain("status = 'filling'");
  });

  it("creates the final authorization only after the fill state transition succeeds", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1" }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });

    await expect(completeFillForReview(pool, "task_1", "user_1", "job_1")).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0]?.[0]).toContain("RETURNING \"sessionId\"");
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO agent_approvals");
  });
});

describe("isUserActive", () => {
  it("blocks suspended users before a queued task can start a browser", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rows: [{ accountStatus: "suspended" }] });

    await expect(isUserActive(pool, "user_1")).resolves.toBe(false);
    expect(String(query.mock.calls[0]?.[0])).toContain('"accountStatus"');
  });

  it("fails open when an older database has no account status column", async () => {
    const { pool, query } = testPool();
    query.mockRejectedValueOnce(new Error('column "accountStatus" does not exist'));

    await expect(isUserActive(pool, "user_1")).resolves.toBe(true);
  });
});
