import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  jobFindFirst: vi.fn(),
  assessApplicationPreflight: vi.fn(),
  isSupportedAutomatedApplyUrl: vi.fn(),
  isRuntimeFeatureEnabled: vi.fn(),
  isFeatureAllowed: vi.fn(),
  resolveAiAccess: vi.fn(),
  requireLegacyPolicy: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: { user: { findUnique: mocks.userFindUnique }, job: { findFirst: mocks.jobFindFirst } },
}));
vi.mock("@/lib/agent/application-preflight", () => ({
  assessApplicationPreflight: mocks.assessApplicationPreflight,
  isSupportedAutomatedApplyUrl: mocks.isSupportedAutomatedApplyUrl,
}));
vi.mock("@/lib/runtime-feature-flags", () => ({ isRuntimeFeatureEnabled: mocks.isRuntimeFeatureEnabled }));
vi.mock("@/lib/entitlements", () => ({ isFeatureAllowed: mocks.isFeatureAllowed, resolveAiAccess: mocks.resolveAiAccess }));
vi.mock("@/lib/agent/policy/legacy", () => ({ requireLegacyPolicy: mocks.requireLegacyPolicy }));

import {
  applicationFillTaskGraphEnabled,
  asRecord,
  assertActiveAccount,
  assertJobPreflight,
  assertUnattendedApplyEnabled,
  AutoApplyError,
  validateAutoApplyUrl,
} from "./auto-apply-guards";

describe("auto-apply guards", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.userFindUnique.mockResolvedValue({ accountStatus: "active" });
    mocks.jobFindFirst.mockResolvedValue({ company: "Acme", description: "Build products.", source: "lever", url: "https://jobs.lever.co/acme/123" });
    mocks.assessApplicationPreflight.mockReturnValue({ canAutomate: true, issues: [] });
    mocks.isSupportedAutomatedApplyUrl.mockReturnValue(true);
    mocks.isFeatureAllowed.mockResolvedValue(true);
    mocks.resolveAiAccess.mockResolvedValue("allowed");
    mocks.isRuntimeFeatureEnabled.mockResolvedValue(true);
  });

  it("enables the task graph only for the explicit value", () => {
    expect(applicationFillTaskGraphEnabled("1")).toBe(true);
    expect(applicationFillTaskGraphEnabled("true")).toBe(false);
    expect(applicationFillTaskGraphEnabled(undefined)).toBe(false);
  });

  it("requires an active account", async () => {
    await expect(assertActiveAccount("user_1")).resolves.toBeUndefined();
    mocks.userFindUnique.mockResolvedValueOnce({ accountStatus: "suspended" });
    await expect(assertActiveAccount("user_1")).rejects.toThrow(new AutoApplyError("Account is not active."));
  });

  it.each([
    ["plan access", () => mocks.isFeatureAllowed.mockResolvedValueOnce(false), "This feature is not included in your current plan."],
    ["disabled AI access", () => mocks.resolveAiAccess.mockResolvedValueOnce("disabled"), "This feature is not included in your current plan."],
    ["exhausted AI access", () => mocks.resolveAiAccess.mockResolvedValueOnce("exhausted"), "Monthly AI credits exhausted."],
    ["the runtime feature", () => mocks.isRuntimeFeatureEnabled.mockResolvedValueOnce(false), "Unattended applications are temporarily unavailable."],
    ["unexpected entitlement errors", () => mocks.isFeatureAllowed.mockRejectedValueOnce(new Error("lookup failed")), "Unattended applications are temporarily unavailable."],
  ])("blocks unattended apply when %s is unavailable", async (_condition, setFailure, message) => {
    setFailure();
    await expect(assertUnattendedApplyEnabled("user_1")).rejects.toThrow(message);
  });

  it("accepts a trimmed, direct HTTPS ATS destination", () => {
    expect(validateAutoApplyUrl("  https://jobs.lever.co/acme/123  ")).toBe("https://jobs.lever.co/acme/123");
  });

  it.each([
    [undefined, "This job has no application URL."],
    ["not a URL", "The application URL is invalid."],
    ["http://jobs.lever.co/acme/123", "Automatic applications require an HTTPS destination."],
  ])("rejects an invalid application URL", (url, message) => {
    expect(() => validateAutoApplyUrl(url)).toThrow(message);
  });

  it("rejects HTTPS destinations outside the supported ATS list", () => {
    mocks.isSupportedAutomatedApplyUrl.mockReturnValueOnce(false);
    expect(() => validateAutoApplyUrl("https://example.com/apply")).toThrow("direct supported ATS");
  });

  it("scopes job preflight to the requesting user and enforces policy", async () => {
    await expect(assertJobPreflight({ userId: "user_1", jobId: "job_1" })).resolves.toBeUndefined();
    expect(mocks.jobFindFirst).toHaveBeenCalledWith({
      where: { id: "job_1", userId: "user_1" },
      select: { company: true, description: true, source: true, url: true },
    });
    expect(mocks.requireLegacyPolicy).toHaveBeenCalledWith(expect.objectContaining({
      userId: "user_1", sessionId: "application-preflight:job_1", risk: "read", capabilities: ["read"],
    }));
    expect(mocks.assessApplicationPreflight).toHaveBeenCalledWith(expect.objectContaining({ company: "Acme" }));
  });

  it("blocks missing, policy-denied, or non-automatable jobs", async () => {
    mocks.jobFindFirst.mockResolvedValueOnce(null);
    await expect(assertJobPreflight({ userId: "user_1", jobId: "missing" })).rejects.toThrow("could not be found");

    mocks.requireLegacyPolicy.mockImplementationOnce(() => { throw new Error("policy denied"); });
    await expect(assertJobPreflight({ userId: "user_1", jobId: "job_1" })).rejects.toThrow("policy denied");
    expect(mocks.assessApplicationPreflight).not.toHaveBeenCalled();

    mocks.assessApplicationPreflight.mockReturnValueOnce({ canAutomate: false, issues: [{ message: "company mismatch" }] });
    await expect(assertJobPreflight({ userId: "user_1", jobId: "job_1" })).rejects.toThrow("company mismatch");
  });

  it("converts only records into payload records", () => {
    expect(asRecord({ jobId: "job_1" })).toEqual({ jobId: "job_1" });
    expect(asRecord(null)).toEqual({});
    expect(asRecord(["array"])).toEqual({});
  });
});
