import { describe, it, expect, vi } from "vitest";
import { runWorkdayFlow } from "./workday-flow.js";
import type { ApplyTask } from "../harness/agent-harness.js";

function mockPage(title = "Review and Submit") {
  return {
    url: () => "https://sap.wd3.myworkdayjobs.com/SAP",
    title: () => Promise.resolve(title),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        isVisible: () => Promise.resolve(true),
        fill: vi.fn(),
        click: vi.fn(),
        inputValue: () => Promise.resolve(""),
        evaluate: vi.fn().mockResolvedValue("first name"),
      }),
      all: () => Promise.resolve([]),
    }),
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
});
