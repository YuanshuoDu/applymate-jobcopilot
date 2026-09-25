import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalIssue = vi.hoisted(() => vi.fn());
const ensureSubmissionArtifact = vi.hoisted(() => vi.fn());

vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: () => ({ issue: approvalIssue }),
}));
vi.mock("./submission-artifact.js", () => ({ ensureSubmissionArtifact }));

import {
  CAPTCHA_USER_TAKEOVER_MESSAGE,
  CHALLENGE_DETECTION_FAILED_MESSAGE,
  completeFillForReview,
  finishApplicationTask,
  needsUserTakeover,
  USER_TAKEOVER_CHECKPOINT,
  isUserActive,
  markSubmissionRequestStarted,
} from "./application-task-state.js";

function testPool() {
  const query = vi.fn();
  return { pool: { query } as unknown as Pool, query };
}

describe("finishApplicationTask", () => {
  it("keeps submission uncertainty durable without reopening a stopped or terminal session", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "waiting_for_user" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain");

    const transition = query.mock.calls[0]?.[0] as string;
    expect(transition).toContain('SET status = $2, "checkpoint" = $3');
    expect(transition).toContain("status NOT IN ('cancelled', 'submitted')");
    expect(transition).toContain('status IS DISTINCT FROM $2 OR "checkpoint" IS DISTINCT FROM $3 OR error IS DISTINCT FROM $4');
    expect(transition).toContain('RETURNING "sessionId"');
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain"]);
    const sessionRefresh = query.mock.calls[3]?.[0] as string;
    expect(sessionRefresh).toContain('"completedAt" = CASE WHEN $2 = \'completed\' THEN NOW() ELSE NULL END');
    expect(sessionRefresh).toContain("status NOT IN ('aborted', 'archived', 'completed', 'failed')");
    expect(sessionRefresh.indexOf('"completedAt"')).toBeLessThan(sessionRefresh.indexOf("WHERE id = $1 AND status NOT IN"));
    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "waiting_for_user"]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("retains ordinary refresh mapping for nonterminal sessions", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "filling" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain");

    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "running"]);
    expect(query.mock.calls[3]?.[0]).toContain("status NOT IN ('aborted', 'archived', 'completed', 'failed')");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each(["cancelled", "submitted"] as const)("suppresses late callbacks after a %s task", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "failed", "execution_failed", "Late worker callback");

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("status NOT IN ('cancelled', 'submitted')");
    expect(String(query.mock.calls[0]?.[0])).toContain('RETURNING "sessionId"');
  });

  it("suppresses a late account-suspended failure after submission became uncertain", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "failed", "account_suspended", "Account suspended by an administrator.");

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain("status = 'waiting_for_user'");
    expect(transition).toContain("\"checkpoint\" = 'submission_uncertain'");
    expect(transition).toContain("$2 <> 'submitted'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "task_1", "failed", "account_suspended", "Account suspended by an administrator.",
    ]);
    // A rejected transition must not create a misleading event or refresh the session.
    expect(query).toHaveBeenCalledOnce();
  });

  it("allows an explicit submitted confirmation to resolve submission uncertainty", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "filling" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await finishApplicationTask(pool, "task_1", "submitted", "submission_verified", null);

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain("AND NOT (status = 'waiting_for_user' AND \"checkpoint\" = 'submission_uncertain' AND $2 <> 'submitted')");
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "submitted", "submission_verified", null]);
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO application_task_events");
    expect(query.mock.calls[1]?.[1]).toEqual(["task_1", "submitted", "submission_verified"]);
    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "running"]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("suppresses a duplicate uncertainty callback after its first transition", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain");

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("status IS DISTINCT FROM $2");
    expect(String(query.mock.calls[0]?.[0])).toContain('"checkpoint" IS DISTINCT FROM $3');
    expect(String(query.mock.calls[0]?.[0])).toContain("error IS DISTINCT FROM $4");
  });
});

describe("completeFillForReview", () => {
  beforeEach(() => {
    approvalIssue.mockReset();
    ensureSubmissionArtifact.mockReset();
    ensureSubmissionArtifact.mockResolvedValue({ hash: "sha256:" + "a".repeat(64) });
    approvalIssue.mockResolvedValue({
      approval: { id: "approval_1", scopeHash: "scope-hash" },
      nonce: "nonce-never-persisted",
    });
  });

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
        resourceHash: "sha256:" + "a".repeat(64),
      }),
    }));
    expect(ensureSubmissionArtifact).toHaveBeenCalledWith(expect.anything(), {
      applicationTaskId: "task_1",
      userId: "user_1",
      jobId: "job_1",
      resumeId: "resume_1",
      coverLetterId: null,
      answersHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
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

describe("markSubmissionRequestStarted", () => {
  const scope = { userId: "user_1", sessionId: "session_1", turnId: "turn_1", applicationTaskId: "task_1", jobId: "job_1" };

  it("records the checkpoint only for the active task from the same session", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "task_1" }] });
    const client = { query } as unknown as PoolClient;

    await expect(markSubmissionRequestStarted(client, scope)).resolves.toBe(true);

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"status" = \'filling\''), ["task_1", "user_1", "job_1", "session_1"]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("submission_request_started"), expect.any(Array));
  });

  it("returns false when the task is no longer at the active pre-submit checkpoint", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const client = { query } as unknown as PoolClient;

    await expect(markSubmissionRequestStarted(client, scope)).resolves.toBe(false);
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
