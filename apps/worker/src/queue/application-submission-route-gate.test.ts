import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadApprovedTurnScope } from "./application-submission-route-gate.js";

const mocks = vi.hoisted(() => ({ inspectSubmission: vi.fn() }));
vi.mock("../db/apply-results.js", () => ({ getPool: vi.fn(() => ({})) }));
vi.mock("../runtime/approval/pg-store.js", () => ({
  createPgApprovalStore: vi.fn(() => ({ inspectSubmission: mocks.inspectSubmission })),
}));

const identity = {
  applicationTaskId: "task",
  userId: "user",
  jobId: "job",
  sessionId: "session",
  fillTurnId: "turn",
  approvalId: "approval",
  constraintHash: "a".repeat(64),
};

describe("approved application route scope", () => {
  beforeEach(() => mocks.inspectSubmission.mockReset().mockResolvedValue({
    id: "approval",
    type: "submit_application",
    scope: {
      action: "submit_application",
      userId: "user",
      sessionId: "session",
      turnId: "turn",
      jobId: "job",
      toolCallId: "application-submit:task",
    },
    payload: { applicationTaskId: "task", jobId: "job" },
  }));

  it("binds the approved scope to the exact queue execution", async () => {
    await expect(loadApprovedTurnScope(identity, "execution", "worker-task")).resolves.toEqual({
      ...identity, executionId: "execution", workerTaskId: "worker-task", turnId: "turn",
    });
  });

  it("rejects an approval for another job", async () => {
    mocks.inspectSubmission.mockResolvedValueOnce({
      id: "approval",
      type: "submit_application",
      scope: {
        action: "submit_application",
        userId: "user",
        sessionId: "session",
        turnId: "turn",
        jobId: "other-job",
        toolCallId: "application-submit:task",
      },
      payload: { applicationTaskId: "task", jobId: "other-job" },
    });
    await expect(loadApprovedTurnScope(identity, "execution", "worker-task")).rejects.toThrow(
      "Approval receipt does not match the queued application task lineage.",
    );
  });
});
