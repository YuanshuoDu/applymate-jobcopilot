import type { Pool } from "pg";
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
  needsUserTakeover,
  USER_TAKEOVER_CHECKPOINT,
  isUserActive,
  markSubmissionRequestStarted,
} from "./application-task-state.js";

function testPool() {
  const query = vi.fn();
  return { pool: { query } as unknown as Pool, query };
}

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

  function fencedPool(options: {
    sessionStatus?: string;
    turnStatus?: string;
    interrupted?: boolean;
    taskStatus?: string;
    checkpoint?: string;
    updateCount?: number;
  } = {}) {
    const clientQuery = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rowCount: 1, rows: [] };
      if (sql.includes('FROM "agent_sessions"')) return { rowCount: 1, rows: [{ status: options.sessionStatus ?? "running" }] };
      if (sql.includes('FROM "agent_turns"')) return { rowCount: 1, rows: [{ status: options.turnStatus ?? "in_progress" }] };
      if (sql.includes('FROM "agent_events"')) return { rowCount: 1, rows: [{ stopped: options.interrupted ?? false }] };
      if (sql.includes("SELECT") && sql.includes("FROM application_tasks")) {
        return { rowCount: 1, rows: [{ status: options.taskStatus ?? "filling", checkpoint: options.checkpoint ?? "browser_active" }] };
      }
      if (sql.includes("UPDATE application_tasks")) {
        const rowCount = options.updateCount ?? 1;
        return { rowCount, rows: rowCount === 1 ? [{ id: "task_1" }] : [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query: clientQuery, release }) } as unknown as Pool;
    return { pool, clientQuery, release };
  }

  it("locks Session then Turn then ApplicationTask, commits the exact checkpoint, and releases before returning", async () => {
    const { pool, clientQuery, release } = fencedPool();

    await expect(markSubmissionRequestStarted(pool, scope)).resolves.toBe(true);

    const statements = clientQuery.mock.calls.map(([sql]) => sql);
    const sessionLock = statements.findIndex(sql => sql.includes('FROM "agent_sessions"'));
    const turnLock = statements.findIndex(sql => sql.includes('FROM "agent_turns"'));
    const taskLock = statements.findIndex(sql => sql.includes("SELECT") && sql.includes("FROM application_tasks"));
    const taskUpdate = statements.findIndex(sql => sql.includes("UPDATE application_tasks"));
    expect(statements.indexOf("BEGIN")).toBeLessThan(sessionLock);
    expect(sessionLock).toBeLessThan(turnLock);
    expect(turnLock).toBeLessThan(taskLock);
    expect(taskLock).toBeLessThan(taskUpdate);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('"status" = \'filling\''), ["task_1", "user_1", "job_1", "session_1"]);
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining('"checkpoint" = \'browser_active\''), expect.any(Array));
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("submission_request_started"), expect.any(Array));
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    ["aborted session", { sessionStatus: "aborted" }],
    ["archived session", { sessionStatus: "archived" }],
    ["interrupted Turn", { turnStatus: "interrupted" }],
    ["durable interruption event", { interrupted: true }],
  ] as const)("does not advance the task after %s", async (_label, options) => {
    const { pool, clientQuery, release } = fencedPool(options);

    await expect(markSubmissionRequestStarted(pool, scope)).resolves.toBe(false);

    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("UPDATE application_tasks"))).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(clientQuery).not.toHaveBeenCalledWith("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it.each(["completed", "failed"] as const)("allows naturally %s session and Turn states", async status => {
    const { pool, clientQuery } = fencedPool({ sessionStatus: status, turnStatus: status });

    await expect(markSubmissionRequestStarted(pool, scope)).resolves.toBe(true);

    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("submission_request_started"), expect.any(Array));
    expect(clientQuery).toHaveBeenCalledWith("COMMIT");
  });

  it("fails closed when the ApplicationTask is no longer filling at browser_active", async () => {
    const { pool, clientQuery } = fencedPool({ taskStatus: "cancelled", checkpoint: "turn_stopped_before_submit" });

    await expect(markSubmissionRequestStarted(pool, scope)).resolves.toBe(false);

    expect(clientQuery.mock.calls.some(([sql]) => sql.includes("UPDATE application_tasks"))).toBe(false);
    expect(clientQuery).toHaveBeenCalledWith("ROLLBACK");
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
