import { describe, it, expect, vi } from "vitest";
import { runWorkdayFlow } from "./workday-flow.js";
import type { ApplyTask } from "../harness/agent-harness.js";

function mockPage() {
  return {
    url: () => "https://sap.wd3.myworkdayjobs.com/SAP",
    title: () => Promise.resolve("Review and Submit"),
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
      jobTitle: "Engineer", jobCompany: "SAP", resumePath: "/resume.pdf", beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
  });
});
