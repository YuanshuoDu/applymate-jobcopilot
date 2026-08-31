import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

const approvalIssue = vi.hoisted(() => vi.fn());

vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: () => ({ issue: approvalIssue }),
}));

import {
  CAPTCHA_USER_TAKEOVER_MESSAGE,
  CHALLENGE_DETECTION_FAILED_MESSAGE,
  completeFillForReview,
  needsUserTakeover,
  USER_TAKEOVER_CHECKPOINT,
  isUserActive,
} from "./application-task-state.js";

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
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1", resumeId: "resume_1", coverLetterId: null, confirmedAnswers: null }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "turn_1", revision: 3 }] })
      .mockResolvedValue({ rowCount: 1, rows: [] });
    approvalIssue.mockResolvedValue({
      approval: { id: "approval_1", scopeHash: "scope-hash" },
      nonce: "nonce-never-persisted",
    });

    await expect(completeFillForReview(pool, "task_1", "user_1", "job_1")).resolves.toBe(true);

    expect(query).toHaveBeenCalledTimes(5);
    expect(query.mock.calls[0]?.[0]).toContain("RETURNING \"sessionId\"");
    expect(query.mock.calls[1]?.[0]).toContain("FROM agent_turns");
    expect(approvalIssue).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: expect.stringMatching(/^approval_/),
      taskId: "task_1",
      scope: expect.objectContaining({
        userId: "user_1",
        sessionId: "session_1",
        turnId: "turn_1",
        jobId: "job_1",
        action: "submit_application",
        revision: 3,
      }),
    }));
  });
});

describe("isUserActive", () => {
  it("blocks suspended users before a queued task can start a browser", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rows: [{ accountStatus: "suspended" }] });

    await expect(isUserActive(pool, "user_1")).resolves.toBe(false);
    expect(String(query.mock.calls[0]?.[0])).toContain('"accountStatus"');
  });

  it("fails closed when account status cannot be checked", async () => {
    const { pool, query } = testPool();
    query.mockRejectedValueOnce(new Error('column "accountStatus" does not exist'));

    await expect(isUserActive(pool, "user_1")).resolves.toBe(false);
  });
});

describe("user takeover classification", () => {
  it.each([
    "CAPTCHA detected",
    "Login required",
    "MFA / two-factor verification required",
    "Verification code required",
  ])("classifies %s with the shared takeover checkpoint", (error) => {
    expect(needsUserTakeover(error)).toBe(true);
    expect(USER_TAKEOVER_CHECKPOINT).toBe("user_takeover");
  });

  it("keeps ordinary execution failures out of takeover", () => {
    expect(needsUserTakeover("Submit button not found")).toBe(false);
  });

  it("keeps challenge messages stable for persisted task events", () => {
    expect(CAPTCHA_USER_TAKEOVER_MESSAGE).toContain("no bypass was attempted");
    expect(CHALLENGE_DETECTION_FAILED_MESSAGE).toContain("no bypass was attempted");
  });
});
