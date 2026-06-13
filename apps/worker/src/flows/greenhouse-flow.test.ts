import { describe, it, expect, vi } from "vitest";
import { runGreenhouseFlow } from "./greenhouse-flow.js";
import { detectFlow } from "./index.js";
import type { Page } from "playwright-core";

function mockPage(url: string = "https://boards.greenhouse.io/booking/jobs/123/applications/new"): Page {
  return {
    url: () => url,
    title: () => Promise.resolve("Application Submitted — Booking.com"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        count: () => Promise.resolve(1),
        isVisible: () => Promise.resolve(true),
        click: vi.fn().mockResolvedValue(undefined),
      }),
      count: () => Promise.resolve(1),
      isVisible: () => Promise.resolve(true),
      click: vi.fn().mockResolvedValue(undefined),
    }),
    fill: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    $$: vi.fn().mockResolvedValue([{
      isVisible: () => Promise.resolve(true),
      inputValue: () => Promise.resolve(""),
      getAttribute: (attr: string) => Promise.resolve(attr === "name" ? "work_experience" : ""),
    }]),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
}

function mockPageNoSubmit(url = "https://boards.greenhouse.io/booking/jobs/789/applications/new"): Page {
  const p = mockPage(url);
  vi.mocked(p.locator).mockReturnValue({
    first: () => ({
      count: () => Promise.resolve(0),
      isVisible: () => Promise.resolve(false),
      click: vi.fn(),
    }),
    count: () => Promise.resolve(0),
    isVisible: () => Promise.resolve(false),
    click: vi.fn(),
  } as unknown as ReturnType<Page["locator"]>);
  return p;
}

describe("runGreenhouseFlow", () => {
  it("happy path: fields filled, submit clicked, URL matches → submitted", async () => {
    const page = mockPage();
    const result = await runGreenhouseFlow(page, {
      jobId: "job-1",
      applyUrl: "https://boards.greenhouse.io/booking/jobs/123/applications/new",
      persona: {
        firstName: "Jean",
        lastName: "Dupont",
        email: "jean@example.com",
        phone: "+33 6 12 34 56 78",
        location: "Paris",
        linkedinUrl: "https://linkedin.com/in/jean",
        work_experience: "5 years of engineering",
      },
      jobTitle: "Senior Engineer",
      jobCompany: "Booking.com",
      resumePath: "/resume.pdf",
    });

    expect(result.status).toBe("submitted");
    expect(result.turns).toBe(1);
  });

  it("missing persona field: skipped gracefully, no error", async () => {
    const page = mockPage();
    const result = await runGreenhouseFlow(page, {
      jobId: "job-2",
      applyUrl: "https://boards.greenhouse.io/booking/jobs/456",
      persona: { firstName: "Jean" },
      jobTitle: "Engineer",
      jobCompany: "Corp",
      resumePath: "/r.pdf",
    });

    expect(["submitted", "manual"]).toContain(result.status);
  });

  it("no submit button found → returns manual", async () => {
    const page = mockPageNoSubmit();
    const result = await runGreenhouseFlow(page, {
      jobId: "job-3",
      applyUrl: "https://boards.greenhouse.io/booking/jobs/789",
      persona: { firstName: "Jane", email: "jane@test.com" },
      jobTitle: "Dev",
      jobCompany: "Inc",
      resumePath: "/r.pdf",
    });

    expect(result.status).toBe("manual");
    expect(result.error).toContain("No submit button");
  });
});

describe("detectFlow", () => {
  it("greenhouse URL detected", () => {
    expect(detectFlow("https://boards.greenhouse.io/booking/jobs/123")).toBe("greenhouse");
    expect(detectFlow("https://job.boards.greenhouse.io/n26/jobs/456")).toBe("greenhouse");
    expect(detectFlow("https://grnh.se/abc123")).toBe("greenhouse");
  });

  it("workday URL detected", () => {
    expect(detectFlow("https://sap.wd3.myworkdayjobs.com/SAP")).toBe("workday");
  });

  it("unknown URL returns null", () => {
    // Lever URLs are now handled — returns 'lever', not null
    expect(detectFlow("https://jobs.lever.co/spotify")).toBe("lever");
    expect(detectFlow("https://example.com")).toBe(null);
  });

  it("mixed-case URLs still match", () => {
    expect(detectFlow("https://BOARDS.GREENHOUSE.IO/Booking/jobs/1")).toBe("greenhouse");
  });
});