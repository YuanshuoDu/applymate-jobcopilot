import { describe, expect, it } from "vitest";
import { sessionSubmissionPolicy, submissionPolicy, submissionPolicyValues } from "./automation-policy";

describe("automation submission policy", () => {
  it("treats any approval requirement as review mode", () => {
    expect(submissionPolicy({ autoApply: true, requireApproval: true })).toBe("review");
    expect(submissionPolicy({ autoApply: false, requireApproval: true })).toBe("review");
  });

  it("produces mutually exclusive persisted settings", () => {
    expect(submissionPolicyValues("review")).toEqual({ autoApply: false, requireApproval: true });
    expect(submissionPolicyValues("autopilot")).toEqual({ autoApply: true, requireApproval: false });
  });

  it("restores an autopilot label from the saved automation session", () => {
    expect(sessionSubmissionPolicy([{ type: "automation_started", data: {
      automation: { autoApply: true, requireApproval: false },
    } }])).toBe("autopilot");
    expect(sessionSubmissionPolicy([{ type: "automation_started", data: {
      payload: { automation: { autoApply: true, requireApproval: true } },
    } }])).toBe("review");
  });
});
