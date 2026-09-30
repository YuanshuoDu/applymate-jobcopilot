import { describe, it, expect, vi } from "vitest";
import { runWorkdayFlow } from "./workday-flow.js";
import type { ApplyTask } from "../harness/agent-harness.js";

function mockPage(
  title = "Review and Submit",
  submitIntent: { url: string; method: string } | null = {
    url: "https://sap.wd3.myworkdayjobs.com/SAP/apply",
    method: "POST",
  },
  submitVisible = true,
) {
  const submitClick = vi.fn();
  const locator = vi.fn((selector: string) => {
    const isSubmitSelector = selector === '[data-automation-id="bottom-navigation-next-button"]'
      || selector === 'button[aria-label="Submit"]';
    const click = isSubmitSelector ? submitClick : vi.fn();
    const first = {
      count: () => Promise.resolve(isSubmitSelector && !submitVisible ? 0 : 1),
      isVisible: () => Promise.resolve(!isSubmitSelector || submitVisible),
      fill: vi.fn(),
      click,
      inputValue: () => Promise.resolve(""),
      evaluate: vi.fn().mockResolvedValue(isSubmitSelector ? submitIntent : "first name"),
      setInputFiles: vi.fn(),
    };
    return { first: () => first, all: () => Promise.resolve([]) };
  });
  return {
    url: () => "https://sap.wd3.myworkdayjobs.com/SAP",
    title: () => Promise.resolve(title),
    locator,
    submitClick,
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn(),
    type: vi.fn(),
    setInputFiles: vi.fn(),
    keyboard: { type: vi.fn() },
  } as any;
}

describe("runWorkdayFlow", () => {
  it("dry-run returns dry-run status without touching page", async () => {
    const page = mockPage();
    const task: ApplyTask = {
      jobId: "j1",
      applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean", lastName: "Dupont", email: "jean@test.com" },
      jobTitle: "Engineer",
      jobCompany: "SAP",
      resumePath: "/resume.pdf",
      dryRun: true,
    };

    const result = await runWorkdayFlow(page, task);
    expect(result.status).toBe("dry-run");
    expect(page.locator).not.toHaveBeenCalled();
  });

  it("step failure returns manual with step number", async () => {
    const page = mockPage();
    // Make the first form interaction throw.
    page.fill = vi.fn().mockRejectedValue(new Error("selector not found"));

    const task: ApplyTask = {
      jobId: "j1",
      applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean" },
      jobTitle: "Engineer",
      jobCompany: "SAP",
      resumePath: "/resume.pdf",
    };

    const result = await runWorkdayFlow(page, task);
    expect(result.status).toBe("manual");
    expect(result.error).toContain("Workday flow failed at step 1");
  });

  it("stops at review when submission authorization is revoked", async () => {
    const page = mockPage();
    const beforeSubmit = vi.fn().mockResolvedValue(false);
    const result = await runWorkdayFlow(page, {
      jobId: "j2", applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean", lastName: "Dupont", email: "jean@test.com" },
      jobTitle: "Engineer", jobCompany: "SAP", resumePath: "/resume.pdf", allowSubmit: true, beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "submission_blocked" });
  });

  it("submits only after explicit authorization", async () => {
    const page = mockPage("Application submitted");
    const beforeSubmit = vi.fn().mockResolvedValue(true);

    const result = await runWorkdayFlow(page, {
      jobId: "j3", applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean", lastName: "Dupont", email: "jean@test.com" },
      jobTitle: "Engineer", jobCompany: "SAP", resumePath: "/resume.pdf", allowSubmit: true, beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(beforeSubmit).toHaveBeenCalledWith({ url: "https://sap.wd3.myworkdayjobs.com/SAP/apply", method: "POST" });
    expect(page.submitClick).toHaveBeenCalledOnce();
    expect(result.status).toBe("submitted");
  });

  it("blocks a visible submit button when authorization is missing", async () => {
    const result = await runWorkdayFlow(mockPage(), {
      jobId: "j4", applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean" },
      jobTitle: "Engineer", jobCompany: "SAP", resumePath: "/resume.pdf", allowSubmit: true,
    });

    expect(result).toMatchObject({ status: "submission_blocked" });
    expect(result.error).toContain("no runtime authorization guard");
  });

  it("fails closed without clicking when a visible submit button has no reliable intent", async () => {
    const page = mockPage("Review and Submit", null);
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    const result = await runWorkdayFlow(page, {
      jobId: "j5", applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean" },
      jobTitle: "Engineer", jobCompany: "SAP", resumePath: "/resume.pdf", allowSubmit: true, beforeSubmit,
    });

    expect(result).toMatchObject({ status: "submission_blocked" });
    expect(result.error).toContain("no reliable form request target");
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(page.submitClick).not.toHaveBeenCalled();
  });

  it("returns for manual review when no native submit control is visible", async () => {
    const page = mockPage("Application submitted", undefined, false);
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    const result = await runWorkdayFlow(page, {
      jobId: "j6", applyUrl: "https://sap.wd3.myworkdayjobs.com/SAP",
      persona: { firstName: "Jean" },
      jobTitle: "Engineer", jobCompany: "SAP", resumePath: "/resume.pdf", allowSubmit: true, beforeSubmit,
    });

    expect(result).toMatchObject({ status: "manual" });
    expect(result.error).toContain("application was not submitted");
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(page.submitClick).not.toHaveBeenCalled();
  });
});
