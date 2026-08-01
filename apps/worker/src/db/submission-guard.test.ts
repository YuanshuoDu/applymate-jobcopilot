import { describe, expect, it, vi } from "vitest";
import {
  claimUnattendedSubmission,
  releaseUncertainSubmission,
  UNCONFIRMED_SUBMISSION_MESSAGE,
} from "./submission-guard.js";

function poolWith(...responses: Array<{ rowCount?: number | null; rows?: unknown[] }>) {
  return {
    query: vi.fn()
      .mockResolvedValueOnce(responses[0] ?? { rowCount: 0, rows: [] })
      .mockResolvedValueOnce(responses[1] ?? { rowCount: 0, rows: [] })
      .mockResolvedValueOnce(responses[2] ?? { rowCount: 0, rows: [] }),
  };
}

describe("submission guard", () => {
  it("claims a queued job exactly once before opening a browser", async () => {
    const pool = poolWith({ rowCount: 1, rows: [{ id: "job-1" }] });

    await expect(claimUnattendedSubmission(pool as never, "user-1", "job-1"))
      .resolves.toBe("claimed");
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("'submitting'"),
      ["job-1", "user-1"],
    );
  });

  it("releases an interrupted attempt for review instead of submitting twice", async () => {
    const pool = poolWith(
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ workflowState: "submitting" }] },
      { rowCount: 1, rows: [] },
    );

    await expect(claimUnattendedSubmission(pool as never, "user-1", "job-1"))
      .resolves.toBe("uncertain");
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("'ready_to_apply'"),
      ["job-1", "user-1", expect.stringContaining(UNCONFIRMED_SUBMISSION_MESSAGE)],
    );
  });

  it("does not change a job that is already complete or no longer queued", async () => {
    const pool = poolWith(
      { rowCount: 0, rows: [] },
      { rowCount: 1, rows: [{ workflowState: "submitted" }] },
    );

    await expect(claimUnattendedSubmission(pool as never, "user-1", "job-1"))
      .resolves.toBe("unavailable");
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("can release an uncertain submission only while it remains locked", async () => {
    const pool = poolWith({ rowCount: 1, rows: [] });

    await expect(releaseUncertainSubmission(pool as never, "user-1", "job-1"))
      .resolves.toBe(true);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('"workflowState" = \'ready_to_apply\''),
      ["job-1", "user-1", expect.stringContaining("Autopilot needs review")],
    );
  });
});
