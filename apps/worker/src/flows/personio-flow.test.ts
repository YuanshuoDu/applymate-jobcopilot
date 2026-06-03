import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright-core";
import { detectFlow } from "./index.js";
import { runPersonioFlow } from "./personio-flow.js";

function visibleLocator(count = 1) {
  return {
    first: () => ({
      count: () => Promise.resolve(count),
      isVisible: () => Promise.resolve(count > 0),
      inputValue: () => Promise.resolve(""),
      click: vi.fn().mockResolvedValue(undefined),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    }),
    count: () => Promise.resolve(count),
    isVisible: () => Promise.resolve(count > 0),
    inputValue: () => Promise.resolve(""),
    click: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<Page["locator"]>;
}

function mockPersonioPage(url = "https://flixbus.jobs.personio.com/job/123"): Page {
  return {
    url: () => url,
    title: () => Promise.resolve("Vielen Dank fur Ihre Bewerbung"),
    locator: vi.fn().mockReturnValue(visibleLocator()),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    $$: vi.fn().mockResolvedValue([{
      isVisible: () => Promise.resolve(true),
      inputValue: () => Promise.resolve(""),
      getAttribute: (attr: string) => Promise.resolve(attr === "name" ? "portfolio" : ""),
    }]),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function baseTask() {
  return {
    jobId: "job-1",
    applyUrl: "https://flixbus.jobs.personio.com/job/123",
    persona: {
      firstName: "Jean",
      lastName: "Dupont",
      email: "jean@example.com",
      phone: "+33 6 12 34 56 78",
      portfolio: "https://jean.dev",
      coverLetter: "I am excited to apply.",
    },
    jobTitle: "Senior Engineer",
    jobCompany: "FlixBus",
    resumePath: "/resume.pdf",
  };
}

describe("runPersonioFlow", () => {
  it("dry-run mode skips fills", async () => {
    const page = mockPersonioPage();
    const result = await runPersonioFlow(page, { ...baseTask(), dryRun: true });

    expect(result.status).toBe("dry-run");
    expect(result.turns).toBeLessThanOrEqual(1);
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.type).not.toHaveBeenCalled();
  });

  it("fills personal fields from persona", async () => {
    const page = mockPersonioPage();
    const result = await runPersonioFlow(page, baseTask());

    expect(result.status).toBe("submitted");
    expect(result.log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "firstName", action: "fill" }),
        expect.objectContaining({ field: "lastName", action: "fill" }),
        expect.objectContaining({ field: "email", action: "fill" }),
      ])
    );
  });

  it("returns manual when submit button not found", async () => {
    const page = mockPersonioPage();
    vi.mocked(page.locator).mockImplementation((selector: string) => {
      if (selector.includes("submit") || selector.includes("Submit") || selector.includes("Apply")) {
        return visibleLocator(0);
      }
      return visibleLocator(1);
    });

    const result = await runPersonioFlow(page, baseTask());

    expect(result.status).toBe("manual");
    expect(result.error).toContain("Submit button not found");
  });
});

describe("detectFlow", () => {
  it("returns personio", () => {
    expect(detectFlow("https://flixbus.jobs.personio.com/job/123")).toBe("personio");
  });
});
