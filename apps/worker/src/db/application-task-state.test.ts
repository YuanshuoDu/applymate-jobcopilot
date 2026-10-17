import type { Pool, PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";

const approvalIssue = vi.hoisted(() => vi.fn());
const ensureSubmissionArtifact = vi.hoisted(() => vi.fn());
const exactSubmissionWrite = vi.hoisted(() => vi.fn());
const exactSubmissionClientWrite = vi.hoisted(() => vi.fn());

const submissionIdentity = {
  applicationTaskId: "task_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
  fillTurnId: "turn_1", approvalId: "approval_1", constraintHash: "a".repeat(64),
};

vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: () => ({ issue: approvalIssue }),
}));
vi.mock("./submission-artifact.js", () => ({ ensureSubmissionArtifact }));
vi.mock("./submission-guard.js", () => ({
  withExactSubmissionWrite: exactSubmissionWrite,
  withExactSubmissionClientWrite: exactSubmissionClientWrite,
}));

beforeEach(() => {
  exactSubmissionWrite.mockImplementation(async (
    pool: Pool,
    _identity: ApplicationSubmitIdentity,
    _phase: string,
    write: (client: PoolClient) => Promise<unknown>,
  ) => ({ kind: "current", value: await write(pool as unknown as PoolClient) }));
  exactSubmissionClientWrite.mockImplementation(async (
    _client: PoolClient,
    _identity: ApplicationSubmitIdentity,
    _phase: string,
    write: () => Promise<unknown>,
  ) => ({ kind: "current", value: await write() }));
});

import {
  applicationTaskStillActive,
  CAPTCHA_USER_TAKEOVER_MESSAGE,
  CHALLENGE_DETECTION_FAILED_MESSAGE,
  completeFillForReview,
  claimApplicationTask,
  finishApplicationTask,
  needsUserTakeover,
  USER_TAKEOVER_CHECKPOINT,
  isUserActive,
  markSubmissionRequestStarted,
  pauseForFormInput,
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

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", submissionIdentity);

    const transition = query.mock.calls[0]?.[0] as string;
    expect(transition).toContain('SET status = $2, "checkpoint" = $3');
    expect(transition).toContain("status NOT IN ('cancelled', 'submitted')");
    expect(transition).toContain("status = 'cancelled' AND \"checkpoint\" = 'turn_stopped_before_submit'");
    expect(transition).toContain("$2 = 'waiting_for_user' AND $3 = 'submission_uncertain'");
    expect(transition).toContain('"checkpoint" = \'submission_request_started\'');
    expect(transition).toContain("NOT ($2 = 'submitted' OR ($2 = 'waiting_for_user' AND $3 = 'submission_uncertain'))");
    expect(transition).toContain('status IS DISTINCT FROM $2 OR "checkpoint" IS DISTINCT FROM $3 OR error IS DISTINCT FROM $4');
    expect(transition).toContain('RETURNING "sessionId"');
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", "session_1", "turn_1"]);
    const sessionRefresh = query.mock.calls[3]?.[0] as string;
    expect(sessionRefresh).toContain('"completedAt" = CASE WHEN $2 = \'completed\' THEN NOW() ELSE NULL END');
    expect(sessionRefresh).toContain("status NOT IN ('aborted', 'archived', 'completed', 'failed')");
    expect(sessionRefresh.indexOf('"completedAt"')).toBeLessThan(sessionRefresh.indexOf("WHERE id = $1 AND status NOT IN"));
    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "waiting_for_user"]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("prevents late failure cleanup from overwriting a durable start marker", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: null }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: null }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: null }] });

    await finishApplicationTask(pool, "task_1", "failed", "execution_failed", "Late cleanup callback", "submit", submissionIdentity);
    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", submissionIdentity);
    await finishApplicationTask(pool, "task_1", "submitted", "submission_verified", null, "submit", submissionIdentity);

    const failureGuard = String(query.mock.calls[0]?.[0]);
    expect(failureGuard).toContain('"checkpoint" = \'submission_request_started\'');
    expect(failureGuard).toContain("NOT ($2 = 'submitted' OR ($2 = 'waiting_for_user' AND $3 = 'submission_uncertain'))");
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "failed", "execution_failed", "Late cleanup callback", "submit", "session_1", "turn_1"]);
    expect(query.mock.calls[1]?.[1]).toEqual(["task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", "session_1", "turn_1"]);
    expect(query.mock.calls[3]?.[1]).toEqual(["task_1", "submitted", "submission_verified", null, "submit", "session_1", "turn_1"]);
  });

  it("repairs a Stop cancellation after request start while preserving the aborted session", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "waiting_for_user" }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", submissionIdentity);

    const repair = String(query.mock.calls[0]?.[0]);
    expect(repair).toContain("status = 'cancelled' AND \"checkpoint\" = 'turn_stopped_before_submit'");
    expect(repair).toContain("$2 = 'waiting_for_user' AND $3 = 'submission_uncertain'");
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", "session_1", "turn_1"]);
    const sessionRefresh = String(query.mock.calls[3]?.[0]);
    expect(sessionRefresh).toContain("status NOT IN ('aborted', 'archived', 'completed', 'failed')");
    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "waiting_for_user"]);

    await finishApplicationTask(pool, "task_1", "failed", "execution_failed", "Late cleanup callback", "submit", submissionIdentity);

    const lateCleanup = String(query.mock.calls[4]?.[0]);
    expect(lateCleanup).toContain("\"checkpoint\" IN ('submission_uncertain', 'admin_review')");
    expect(lateCleanup).toContain("$2 <> 'submitted'");
    expect(query).toHaveBeenCalledTimes(5);
  });

  it("retains ordinary refresh mapping for nonterminal sessions", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ sessionId: "session_1" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rows: [{ status: "filling" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", submissionIdentity);

    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "running"]);
    expect(query.mock.calls[3]?.[0]).toContain("status NOT IN ('aborted', 'archived', 'completed', 'failed')");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each(["cancelled", "submitted"] as const)("suppresses late callbacks after a %s task", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "failed", "execution_failed", "Late worker callback", "submit", submissionIdentity);

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("status NOT IN ('cancelled', 'submitted')");
    expect(String(query.mock.calls[0]?.[0])).toContain('RETURNING "sessionId"');
  });

  it("suppresses a late account-suspended failure after submission became uncertain", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "failed", "account_suspended", "Account suspended by an administrator.", "submit", submissionIdentity);

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain("\"checkpoint\" IN ('submission_uncertain', 'admin_review')");
    expect(transition).toContain("$2 <> 'submitted'");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "task_1", "failed", "account_suspended", "Account suspended by an administrator.", "submit", "session_1", "turn_1",
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

    await finishApplicationTask(pool, "task_1", "submitted", "submission_verified", null, "submit", submissionIdentity);

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain("AND NOT (\"checkpoint\" IN ('submission_uncertain', 'admin_review') AND $2 <> 'submitted')");
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "submitted", "submission_verified", null, "submit", "session_1", "turn_1"]);
    expect(query.mock.calls[1]?.[0]).toContain("INSERT INTO application_task_events");
    expect(query.mock.calls[1]?.[1]).toEqual(["task_1", "submitted", "submission_verified"]);
    expect(query.mock.calls[3]?.[1]).toEqual(["session_1", "running"]);
    expect(query).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["failed", "account_suspended", "Account suspended by an administrator."],
    ["waiting_for_user", "submission_uncertain", "A late browser result was inconclusive."],
  ] as const)("does not replace an admin review checkpoint with a late %s callback", async (status, checkpoint, error) => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", status, checkpoint, error, "submit", submissionIdentity);

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain("\"checkpoint\" IN ('submission_uncertain', 'admin_review')");
    expect(transition).toContain("$2 <> 'submitted'");
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", status, checkpoint, error, "submit", "session_1", "turn_1"]);
    // A rejected transition must not create a Worker event or refresh the session.
    expect(query).toHaveBeenCalledOnce();
  });

  it("suppresses a duplicate uncertainty callback after its first transition", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "waiting_for_user", "submission_uncertain", "Request outcome is uncertain", "submit", submissionIdentity);

    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).toContain("status IS DISTINCT FROM $2");
    expect(String(query.mock.calls[0]?.[0])).toContain('"checkpoint" IS DISTINCT FROM $3');
    expect(String(query.mock.calls[0]?.[0])).toContain("error IS DISTINCT FROM $4");
  });

  it("preserves submission uncertainty even when the task status is inconsistent", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await finishApplicationTask(pool, "task_1", "failed", "execution_failed", "Inconsistent late failure", "submit", submissionIdentity);

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain("AND NOT (\"checkpoint\" IN ('submission_uncertain', 'admin_review') AND $2 <> 'submitted')");
    expect(transition).not.toContain("status = 'waiting_for_user' AND \"checkpoint\" IN");
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "failed", "execution_failed", "Inconsistent late failure", "submit", "session_1", "turn_1"]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("suppresses every task/result transition when the exact attempt was superseded", async () => {
    const { pool, query } = testPool();
    exactSubmissionClientWrite.mockResolvedValueOnce({ kind: "superseded" });

    await expect(finishApplicationTask(
      pool, "task_1", "submitted", "submission_verified", null, "submit", submissionIdentity,
    )).resolves.toBe("superseded");

    expect(query).not.toHaveBeenCalled();
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

  it("does not replace a committed submission marker with form_filled", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(completeFillForReview(pool, "task_1", "user_1", "job_1")).resolves.toBe(false);

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain('"fillTurnId" IS NULL');
    expect(transition).toContain('"checkpoint" IS DISTINCT FROM \'submission_request_started\'');
    expect(transition).toContain('"checkpoint" IS DISTINCT FROM \'submission_uncertain\'');
    // A stale fill callback must not issue authorization or emit handoff events.
    expect(query).toHaveBeenCalledOnce();
    expect(approvalIssue).not.toHaveBeenCalled();
    expect(ensureSubmissionArtifact).not.toHaveBeenCalled();
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

describe("applicationTaskStillActive", () => {
  it("rechecks the TaskGraph binding for fill while allowing explicit submit", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(applicationTaskStillActive(pool, "task_1", "user_1", "job_1", "fill")).resolves.toBe(false);
    await expect(applicationTaskStillActive(pool, "task_1", "user_1", "job_1", "submit", submissionIdentity)).resolves.toBe(true);

    expect(String(query.mock.calls[0]?.[0])).toContain('($4 = \'submit\' OR t."fillTurnId" IS NULL)');
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "user_1", "job_1", "fill", null, null]);
    expect(query.mock.calls[1]?.[1]).toEqual(["task_1", "user_1", "job_1", "submit", "session_1", "turn_1"]);
  });
});

describe("pauseForFormInput", () => {
  it("does not replace a committed submission marker or emit a stale handoff", async () => {
    const { pool, query } = testPool();
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await pauseForFormInput(pool, "task_1", "Missing required field", { missing: [{ key: null, label: "Email" }], sensitive: [] });

    const transition = String(query.mock.calls[0]?.[0]);
    expect(transition).toContain('"checkpoint" IS DISTINCT FROM \'submission_request_started\'');
    expect(transition).toContain('"checkpoint" IS DISTINCT FROM \'submission_uncertain\'');
    expect(transition).toContain('"fillTurnId" IS NULL');
    expect(transition).toContain('RETURNING "sessionId"');
    // The lost conditional update suppresses stale task and transcript events.
    expect(query).toHaveBeenCalledOnce();
    expect(transition).not.toContain("INSERT INTO application_task_events");
    expect(transition).not.toContain("INSERT INTO agent_transcript_events");
  });
});

describe("claimApplicationTask", () => {
  it("claims only a queued legacy fill before browser setup", async () => {
    let checkpoint = "form_fill_queued";
    const query = vi.fn().mockImplementation(async () => {
      const claimable = checkpoint === "form_fill_queued";
      if (claimable) checkpoint = "browser_active";
      return { rowCount: claimable ? 1 : 0, rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(true);
    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(false);
    checkpoint = "submission_authorized";
    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(false);

    const claim = String(query.mock.calls[0]?.[0]);
    expect(claim).toContain('status = \'filling\'');
    expect(claim).toContain('"fillTurnId" IS NULL');
    expect(claim).toContain('"checkpoint" = \'form_fill_queued\'');
    expect(claim).not.toContain('"checkpoint" = \'submission_authorized\'');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("allows one legacy fill owner and a later known-before-browser requeue", async () => {
    let checkpoint = "form_fill_queued";
    const query = vi.fn().mockImplementation(async () => {
      const claimable = checkpoint === "form_fill_queued";
      if (claimable) checkpoint = "browser_active";
      return { rowCount: claimable ? 1 : 0, rows: [] };
    });
    const pool = { query } as unknown as Pool;

    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(true);
    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(false);
    expect(String(query.mock.calls[0]?.[0])).toContain('"checkpoint" = \'form_fill_queued\'');
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "user_1", "job_1"]);

    // The existing safe requeue path resets to form_fill_queued before delivery.
    checkpoint = "form_fill_queued";
    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
  });
});

describe("TaskGraph-bound legacy fill fencing", () => {
  it("rejects fill claims and late fill failures for TaskGraph-bound tasks", async () => {
    const { pool, query } = testPool();
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    await expect(claimApplicationTask(pool, "task_1", "user_1", "job_1")).resolves.toBe(false);
    await finishApplicationTask(pool, "task_1", "failed", "execution_failed", "Late fill callback", "fill");

    expect(String(query.mock.calls[0]?.[0])).toContain('"fillTurnId" IS NULL');
    expect(query.mock.calls[0]?.[1]).toEqual(["task_1", "user_1", "job_1"]);
    expect(String(query.mock.calls[1]?.[0])).toContain('"fillTurnId" IS NULL');
    expect(query.mock.calls[1]?.[1]).toEqual(["task_1", "failed", "execution_failed", "Late fill callback", "fill", null, null]);
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe("markSubmissionRequestStarted", () => {
  const scope = { ...submissionIdentity, turnId: "turn_1", workerTaskId: "bull_1", executionId: "execution_1" };

  it("writes the checkpoint on the caller's exact-fenced connection", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: "task_1" }] });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;

    await expect(markSubmissionRequestStarted(client, scope)).resolves.toBe("started");

    expect(query).toHaveBeenCalledWith(expect.stringContaining("submission_execution_started"), [
      "task_1", "user_1", "job_1", "session_1", "turn_1", "execution_1", "bull_1", "approval_1", "a".repeat(64),
    ]);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([expect.stringContaining("submission_request_started")]);
    expect(String(query.mock.calls[0]?.[0])).toContain('INSERT INTO application_task_events');
    expect(String(query.mock.calls[0]?.[0])).toContain("'workerTaskId', $7::text");
    expect(String(query.mock.calls[0]?.[0])).toContain("'approvalId', $8::text");
    expect(String(query.mock.calls[0]?.[0])).toContain("'constraintHash', $9::text");
    expect(release).not.toHaveBeenCalled();
  });

  it("reports an inactive task without committing a request-start marker", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;

    await expect(markSubmissionRequestStarted(client, scope)).resolves.toBe("inactive");
    expect(query).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
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
