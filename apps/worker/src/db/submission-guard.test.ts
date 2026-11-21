import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const withExactAttemptFence = vi.hoisted(() => vi.fn());
const appendFencedSubmitAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const acquireSourceMaterialFence = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../queue/application-submit-fence.js", () => ({
  withExactAttemptFence,
  appendFencedSubmitAudit,
}));
vi.mock("./source-material-fence.js", () => ({ acquireSourceMaterialFence }));

import {
  claimUnattendedSubmission,
  reconcileClaimedSubmissionUncertain,
  releaseUncertainSubmission,
  UNCONFIRMED_SUBMISSION_MESSAGE,
  updateJobForSubmission,
} from "./submission-guard.js";
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js";

const identity: ApplicationSubmitIdentity = {
  applicationTaskId: "task-1",
  userId: "user-1",
  jobId: "job-1",
  sessionId: "session-1",
  fillTurnId: "turn-1",
  approvalId: "approval-1",
  constraintHash: "a".repeat(64),
};

function poolWith(...responses: Array<{ rowCount?: number | null; rows?: unknown[] }>) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
      return { rows: [], rowCount: 1 };
    }
    return responses.shift() ?? { rowCount: 0, rows: [] };
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn().mockResolvedValue(client);
  return { pool: { connect } as unknown as Pool, client, query, release };
}

beforeEach(() => {
  withExactAttemptFence.mockClear();
  acquireSourceMaterialFence.mockReset().mockResolvedValue(undefined);
  withExactAttemptFence.mockImplementation(async (
    _client: unknown,
    _identity: ApplicationSubmitIdentity,
    work: () => Promise<unknown>,
  ) => ({ kind: "current", value: await work() }));
  appendFencedSubmitAudit.mockClear();
});

describe("submission guard", () => {
  it("acquires the exact user source fence before the attempt fence and Job update", async () => {
    const order: string[] = [];
    const { pool, client, query } = poolWith({ rowCount: 1, rows: [] });
    query.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN") order.push("begin");
      if (sql.includes("set_config")) order.push("tenant-context");
      if (sql.includes('UPDATE "Job" SET status')) order.push("job-write");
      if (sql === "COMMIT") order.push("commit");
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    acquireSourceMaterialFence.mockImplementationOnce(async (fencedClient: unknown, userIds: readonly string[]) => {
      expect(fencedClient).toBe(client);
      expect(userIds).toEqual([identity.userId]);
      order.push("source-fence");
    });
    withExactAttemptFence.mockImplementationOnce(async (
      _client: unknown,
      _identity: ApplicationSubmitIdentity,
      write: () => Promise<unknown>,
    ) => {
      order.push("attempt-fence");
      return { kind: "current", value: await write() };
    });

    await expect(updateJobForSubmission(
      pool, identity, { status: "applied", workflowState: "submitted", applied: true }, "finish_apply_job_state",
    )).resolves.toEqual({ kind: "current", value: true });

    expect(order).toEqual(["begin", "tenant-context", "source-fence", "attempt-fence", "job-write", "commit"]);
    expect(acquireSourceMaterialFence).toHaveBeenCalledOnce();
  });

  it("rolls back before attempt locks or Job writes when the source fence fails", async () => {
    const fenceError = new Error("source material fence failed");
    const { pool, query } = poolWith();
    acquireSourceMaterialFence.mockRejectedValueOnce(fenceError);

    await expect(updateJobForSubmission(
      pool, identity, { status: "applied", workflowState: "submitted", applied: true }, "finish_apply_job_state",
    )).rejects.toBe(fenceError);

    expect(acquireSourceMaterialFence).toHaveBeenCalledOnce();
    expect(acquireSourceMaterialFence).toHaveBeenCalledWith(expect.anything(), [identity.userId]);
    expect(withExactAttemptFence).not.toHaveBeenCalled();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)", "ROLLBACK",
    ]);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "Job"'), expect.anything());
  });

  it("claims a queued job exactly once before opening a browser", async () => {
    const { pool, query, release } = poolWith(
      { rowCount: 1, rows: [{ id: "approval-1" }] },
      { rowCount: 1, rows: [{ id: "task-1" }] },
      { rowCount: 1, rows: [{ id: "job-1" }] },
    );

    await expect(claimUnattendedSubmission(pool, identity, "bull-1")).resolves.toBe("claimed");
    expect(query.mock.calls[2]?.[0]).toContain('"status" = \'approved\'');
    expect(query.mock.calls[3]?.[0]).toContain('"workerTaskId" = $6');
    expect(query.mock.calls[3]?.[0]).toContain('"checkpoint" = \'submission_authorized\'');
    expect(query.mock.calls[3]?.[1]).toEqual(["task-1", "user-1", "job-1", "session-1", "turn-1", "bull-1"]);
    expect(query.mock.calls[4]?.[0]).toContain('"workflowState" = \'queued\'');
    expect(query.mock.calls[4]?.[1]).toEqual(["job-1", "user-1"]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a child-task-bound approval before mutating the application task or Job", async () => {
    const { pool, query } = poolWith({ rowCount: 0, rows: [] });

    await expect(claimUnattendedSubmission(pool, identity, "bull-1")).resolves.toBe("unavailable");
    const approvalCall = query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_approvals"'));
    expect(String(approvalCall?.[0])).toContain('"taskId" = $5');
    expect(approvalCall?.[1]?.[4]).toBe(identity.applicationTaskId);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "application_tasks"'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "Job"'))).toBe(false);
  });

  it("does not reset a duplicate claim or touch the Job after its task is claimed", async () => {
    const { pool, query } = poolWith(
      { rowCount: 1, rows: [{ id: "approval-1" }] },
      { rowCount: 0, rows: [] },
    );

    await expect(claimUnattendedSubmission(pool, identity, "bull-1")).resolves.toBe("unavailable");
    expect(query.mock.calls[3]?.[1]?.[5]).toBe("bull-1");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE \"Job\""))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("ready_to_apply"))).toBe(false);
  });

  it("rejects a mismatched BullMQ id before updating the Job", async () => {
    const { pool, query } = poolWith(
      { rowCount: 1, rows: [{ id: "approval-1" }] },
      { rowCount: 0, rows: [] },
    );

    await expect(claimUnattendedSubmission(pool, identity, "bull-wrong")).resolves.toBe("unavailable");
    expect(query.mock.calls[3]?.[0]).toContain('"workerTaskId" = $6');
    expect(query.mock.calls[3]?.[1]?.[5]).toBe("bull-wrong");
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE "Job"'))).toBe(false);
  });

  it("rolls back the task claim if the locked Job is no longer queued", async () => {
    const { pool, query } = poolWith(
      { rowCount: 1, rows: [{ id: "approval-1" }] },
      { rowCount: 1, rows: [{ id: "task-1" }] },
      { rowCount: 0, rows: [] },
    );

    await expect(claimUnattendedSubmission(pool, identity, "bull-1")).rejects.toThrow("changed during its exact submit claim");
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(query).not.toHaveBeenCalledWith("COMMIT");
  });

  it("fails closed when the queue task id is absent", async () => {
    const { pool, query } = poolWith();

    await expect(claimUnattendedSubmission(pool, identity, " ")).resolves.toBe("unavailable");
    expect(query).not.toHaveBeenCalled();
  });

  it("reconciles only exact pre- or post-marker claims while leaving its Job submitting", async () => {
    const { pool, query } = poolWith(
      { rowCount: 1, rows: [{ sessionId: "session-1" }] },
      { rowCount: 1, rows: [] },
      { rowCount: 1, rows: [{ status: "waiting_for_user" }] },
      { rowCount: 1, rows: [] },
    );

    await expect(reconcileClaimedSubmissionUncertain(pool, identity, "bull-1", async () => true)).resolves.toBe(true);

    const transition = String(query.mock.calls[2]?.[0]);
    expect(transition).toContain('"workerTaskId" = $6');
    expect(transition).toContain('"checkpoint" IN (\'browser_active\', \'submission_request_started\')');
    expect(transition).toContain('j."workflowState" = \'submitting\'');
    expect(query.mock.calls[2]?.[1]).toEqual([
      "task-1", "user-1", "job-1", "session-1", "turn-1", "bull-1", UNCONFIRMED_SUBMISSION_MESSAGE,
    ]);
    expect(String(query.mock.calls[3]?.[0])).toContain("INSERT INTO application_task_events");
    expect(String(query.mock.calls[5]?.[0])).toContain("UPDATE agent_sessions");
    expect(query.mock.calls.some(([sql]) => String(sql).includes("ready_to_apply"))).toBe(false);
  });

  it("does not reconcile a task owned by another BullMQ id", async () => {
    const { pool, query } = poolWith({ rowCount: 0, rows: [] });

    await expect(reconcileClaimedSubmissionUncertain(pool, identity, "bull-stale", async () => true)).resolves.toBe(false);

    expect(String(query.mock.calls[2]?.[0])).toContain('"workerTaskId" = $6');
    expect(query.mock.calls[2]?.[1]?.[5]).toBe("bull-stale");
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("validates the current terminal Queue delivery under the exact attempt fence before recovery writes", async () => {
    const { pool, query } = poolWith();
    let fenceActive = false;
    const currentDelivery = vi.fn(async () => {
      expect(fenceActive).toBe(true);
      return false;
    });
    withExactAttemptFence.mockImplementationOnce(async (
      _client: unknown,
      _identity: ApplicationSubmitIdentity,
      work: () => Promise<unknown>,
    ) => {
      fenceActive = true;
      try {
        return { kind: "current", value: await work() };
      } finally {
        fenceActive = false;
      }
    });

    await expect(reconcileClaimedSubmissionUncertain(pool, identity, "bull-1", currentDelivery)).resolves.toBe(false);

    expect(withExactAttemptFence).toHaveBeenCalledOnce();
    expect(currentDelivery).toHaveBeenCalledOnce();
    expect(acquireSourceMaterialFence).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => String(sql).includes("UPDATE application_tasks"))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO application_task_events"))).toBe(false);
    expect(query).toHaveBeenCalledWith("COMMIT");
  });

  it("can release an uncertain submission only while it remains locked", async () => {
    const { pool, query } = poolWith({ rowCount: 1, rows: [] });

    await expect(releaseUncertainSubmission(pool, identity)).resolves.toEqual({ kind: "current", value: true });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('"workflowState" = \'ready_to_apply\''),
      ["job-1", "user-1", expect.stringContaining("Autopilot needs review")],
    );
  });

  it("suppresses Job workflow writes after a successor fill is bound", async () => {
    const { pool, query } = poolWith({ rowCount: 1, rows: [] });
    withExactAttemptFence.mockResolvedValueOnce({ kind: "superseded" });

    await expect(updateJobForSubmission(
      pool, identity, { status: "submitted", workflowState: "submitted", applied: true }, "late_submit_result",
    )).resolves.toEqual({ kind: "superseded" });

    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE "Job"'), expect.anything());
    expect(appendFencedSubmitAudit).toHaveBeenCalledOnce();
  });

  it("compares expected Job workflow states as text for the PostgreSQL enum column", async () => {
    const { pool, query } = poolWith({ rowCount: 1, rows: [] });

    await expect(updateJobForSubmission(
      pool,
      identity,
      { status: "submitted", workflowState: "submitted", applied: true, expectedWorkflowStates: ["submitting", "submitted"] },
      "late_submit_result",
    )).resolves.toEqual({ kind: "current", value: true });

    const jobUpdate = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE "Job" SET status'));
    expect(jobUpdate?.[0]).toContain('"workflowState"::text = ANY($6::text[])');
    expect(jobUpdate?.[1]).toEqual([
      "submitted", "submitted", true, "job-1", "user-1", ["submitting", "submitted"],
    ]);
  });
});
