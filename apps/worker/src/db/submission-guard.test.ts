import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const withExactAttemptFence = vi.hoisted(() => vi.fn());
const appendFencedSubmitAudit = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("../queue/application-submit-fence.js", () => ({
  withExactAttemptFence,
  appendFencedSubmitAudit,
}));

import {
  claimUnattendedSubmission,
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
  const query = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
      return { rows: [], rowCount: 1 };
    }
    return responses.shift() ?? { rowCount: 0, rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  return { pool: { connect } as unknown as Pool, query, release };
}

beforeEach(() => {
  withExactAttemptFence.mockImplementation(async (
    _client: unknown,
    _identity: ApplicationSubmitIdentity,
    work: () => Promise<unknown>,
  ) => ({ kind: "current", value: await work() }));
  appendFencedSubmitAudit.mockClear();
});

describe("submission guard", () => {
  it("claims a queued job exactly once before opening a browser", async () => {
    const { pool, query, release } = poolWith({ rowCount: 1, rows: [{ id: "job-1" }] });

    await expect(claimUnattendedSubmission(pool, identity)).resolves.toBe("claimed");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'submitting'"),
      ["job-1", "user-1"],
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases an interrupted attempt for review instead of submitting twice", async () => {
    const { pool, query } = poolWith(
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ workflowState: "submitting" }] },
      { rowCount: 1, rows: [] },
    );

    await expect(claimUnattendedSubmission(pool, identity)).resolves.toBe("uncertain");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("'ready_to_apply'"),
      ["job-1", "user-1", expect.stringContaining(UNCONFIRMED_SUBMISSION_MESSAGE)],
    );
  });

  it("does not change a job that is already complete or no longer queued", async () => {
    const { pool, query } = poolWith(
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ workflowState: "submitted" }] },
    );

    await expect(claimUnattendedSubmission(pool, identity)).resolves.toBe("unavailable");
    expect(query).toHaveBeenCalledTimes(5); // transaction setup, claim, state read, commit
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
});
