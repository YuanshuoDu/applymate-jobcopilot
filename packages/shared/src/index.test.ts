import { describe, expect, it } from "vitest";
import { matchesApplyTaskSubmitPayload, type ApplyTaskSubmitIdentity, type ApplyTaskSubmitPayload } from "./index.js";

const identity: ApplyTaskSubmitIdentity = {
  applicationTaskId: "application_1",
  jobId: "job_1",
  userId: "user_1",
  sessionId: "session_1",
  fillTurnId: "turn_1",
  receiptId: "approval_1",
  constraintHash: "a".repeat(64),
};

const payload: ApplyTaskSubmitPayload = {
  ...identity,
  operation: "submit",
  applyUrl: "https://jobs.example/apply",
  personaId: "server-side",
  resumePath: "",
};

describe("apply task submit payload identity", () => {
  it("accepts a complete payload bound to the current task and approval", () => {
    expect(matchesApplyTaskSubmitPayload(payload, identity)).toBe(true);
  });

  it("rejects each missing required submit identity field", () => {
    const keys: (keyof ApplyTaskSubmitIdentity)[] = [
      "applicationTaskId", "jobId", "userId", "sessionId", "fillTurnId", "receiptId", "constraintHash",
    ];
    for (const key of keys) {
      expect(matchesApplyTaskSubmitPayload({ ...payload, [key]: undefined }, identity), key).toBe(false);
    }
  });

  it("rejects a payload whose task, user, job, Turn, session, or approval differs", () => {
    const keys: (keyof ApplyTaskSubmitIdentity)[] = [
      "applicationTaskId", "jobId", "userId", "sessionId", "fillTurnId", "receiptId", "constraintHash",
    ];
    for (const key of keys) {
      expect(matchesApplyTaskSubmitPayload({ ...payload, [key]: "other_attempt" }, identity), key).toBe(false);
    }
  });

  it("does not accept a fill payload as submission authorization", () => {
    expect(matchesApplyTaskSubmitPayload({ ...payload, operation: "fill" }, identity)).toBe(false);
  });
});
