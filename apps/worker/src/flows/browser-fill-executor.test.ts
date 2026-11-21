import { describe, expect, it, vi } from "vitest";
import { FillFormInputSchema, executeBrowserFill, parseFillFormInput } from "./browser-fill-executor.js";
import { validate } from "@jobcopilot/agent-protocol";

const input = {
  jobId: "job-1", applyUrl: "https://jobs.example.com/apply", persona: { fullName: "Ada Lovelace" },
  jobTitle: "Engineer", jobCompany: "Example", resumePath: "/resume.pdf",
};

describe("browser.fill_form", () => {
  it("has a typed false-only submit field and defaults to read-only", () => {
    expect(validate(FillFormInputSchema, input)).toBe(true);
    expect(validate(FillFormInputSchema, { ...input, submit: true })).toBe(false);
    expect(validate(FillFormInputSchema, { ...input, reviewedCoverLetter: { content: "trusted" } })).toBe(false);
    expect(() => parseFillFormInput({ ...input, submit: true })).toThrow(/cannot enable submit|validation/i);
  });

  it("uses the trusted reviewed context only for the deterministic Greenhouse flow", async () => {
    const letter = "R".repeat(2000);
    const field = {
      count: vi.fn().mockResolvedValue(1), isVisible: vi.fn().mockResolvedValue(true),
      inputValue: vi.fn().mockResolvedValue(""), fill: vi.fn().mockResolvedValue(undefined),
    };
    const pageMock = {
      locator: vi.fn((selector: string) => selector.includes("textarea[name*='cover'") ? field : { count: vi.fn().mockResolvedValue(0) }),
      $$: vi.fn().mockResolvedValue([]), fill: vi.fn(), type: vi.fn(),
    };

    const result = await executeBrowserFill({ ...input, atsType: "greenhouse", resumePath: "db:resume", persona: { coverLetter: letter } }, {
      page: pageMock as unknown as import("playwright-core").Page, reviewedCoverLetter: { content: letter },
    });

    expect(result).toMatchObject({ reviewReady: true });
    expect(field.fill).toHaveBeenCalledTimes(1);
    expect(field.fill).toHaveBeenCalledWith(letter);
    expect(pageMock.fill).not.toHaveBeenCalled();
    expect(pageMock.type).not.toHaveBeenCalled();
    expect(result.log).toContainEqual(expect.objectContaining({ field: "coverLetter", action: "fill" }));
  });

  it("fails closed instead of routing trusted reviewed material through another ATS flow", async () => {
    const pageMock = { locator: vi.fn(), fill: vi.fn(), type: vi.fn() };
    const result = await executeBrowserFill({ ...input, atsType: "lever" }, { page: pageMock as unknown as import("playwright-core").Page, reviewedCoverLetter: { content: "reviewed" } });
    expect(result).toMatchObject({ reviewReady: false });
    expect(pageMock.locator).not.toHaveBeenCalled();
  });

  it("selects a deterministic ATS flow and never passes submit authorization", async () => {
    const page = {
      locator: vi.fn().mockReturnValue({ first: () => ({ count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) }) }),
    } as never;
    const phases: string[] = [];
    const result = await executeBrowserFill({ ...input, atsType: "lever" }, { page, reviewedPhaseObserver: phase => phases.push(phase) });
    expect(result.status).toBe("manual");
    expect(result.reviewReady).toBe(true);
    expect(phases).toEqual(["executor_wait_clear", "deterministic_flow_started", "deterministic_flow_review_ready"]);
  });

  it("does not let an observer error change the deterministic fill", async () => {
    const page = { locator: vi.fn().mockReturnValue({ first: () => ({ count: vi.fn().mockResolvedValue(0), isVisible: vi.fn().mockResolvedValue(false) }) }) } as never;
    const result = await executeBrowserFill({ ...input, atsType: "lever" }, { page, reviewedPhaseObserver: () => { throw new Error("private observer error"); } });
    expect(result.reviewReady).toBe(true);
  });
});
