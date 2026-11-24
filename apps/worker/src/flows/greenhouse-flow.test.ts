import { describe, it, expect, vi } from "vitest";
import { runGreenhouseFlow } from "./greenhouse-flow.js";
import { detectFlow } from "./index.js";
import type { Page } from "playwright-core";

const COVER_LETTER_UNION = "textarea[name*='cover' i], textarea[id*='cover' i], textarea[placeholder*='cover' i]";

function reviewedPage(options: { count?: number; visible?: boolean; value?: string } = {}) {
  const field = {
    count: vi.fn().mockResolvedValue(options.count ?? 1), isVisible: vi.fn().mockResolvedValue(options.visible ?? true),
    inputValue: vi.fn().mockResolvedValue(options.value ?? ""), fill: vi.fn().mockResolvedValue(undefined),
  };
  const locator = { ...field, first: () => field };
  const page = {
    url: () => "https://boards.greenhouse.io/booking/jobs/123/applications/new",
    locator: vi.fn(() => locator),
    focus: vi.fn().mockResolvedValue(undefined), fill: vi.fn(), type: vi.fn(), click: vi.fn(), $$: vi.fn().mockResolvedValue([]),
  } as unknown as Page;
  return { page, field };
}

function reviewedTask(content: string) {
  return { jobId: "job-1", applyUrl: "https://boards.greenhouse.io/booking/jobs/123", persona: { coverLetter: content }, jobTitle: "Engineer", jobCompany: "Booking", resumePath: "db:resume" };
}

function mockPage(url: string = "https://boards.greenhouse.io/booking/jobs/123/applications/new"): Page {
  return {
    url: () => url,
    title: () => Promise.resolve("Application Submitted — Booking.com"),
    locator: vi.fn().mockReturnValue({
      first: () => ({
        count: () => Promise.resolve(1),
        isVisible: () => Promise.resolve(true),
        evaluate: vi.fn(async () => ({ url: "https://boards.greenhouse.io/booking/apply", method: "POST" })),
        click: vi.fn().mockResolvedValue(undefined),
      }),
      count: () => Promise.resolve(1),
      isVisible: () => Promise.resolve(true),
      evaluate: vi.fn(async () => ({ url: "https://boards.greenhouse.io/booking/apply", method: "POST" })),
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
  it("fills exact reviewed text once into a unique visible empty textarea without submitting", async () => {
    const content = "R".repeat(2000);
    const { page, field } = reviewedPage();

    const result = await runGreenhouseFlow(page, { ...reviewedTask(content), allowSubmit: true }, { reviewedCoverLetter: content });

    expect(page.locator).toHaveBeenCalledTimes(1);
    expect(page.locator).toHaveBeenCalledWith(COVER_LETTER_UNION);
    expect(field.fill).toHaveBeenCalledTimes(1);
    expect(field.fill).toHaveBeenCalledWith(content);
    expect(result).toMatchObject({ status: "manual", reviewReady: true });
    expect(result.log).toContainEqual({ field: "coverLetter", selector: COVER_LETTER_UNION, action: "fill" });
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.type).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
  });

  it.each([
    ["ambiguous", { count: 2 }], ["hidden", { visible: false }], ["pre-filled", { value: "candidate text" }],
  ])("does not overwrite a %s field or fall back to generic typing", async (_name, options) => {
    const { page, field } = reviewedPage(options);

    const result = await runGreenhouseFlow(page, reviewedTask("Reviewed"), { reviewedCoverLetter: "Reviewed" });

    expect(result).toMatchObject({ status: "manual", reviewReady: false });
    expect(field.fill).not.toHaveBeenCalled();
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.type).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
  });

  it.each([
    ["over-limit", "R".repeat(2001), "R".repeat(2001)],
    ["mismatched", "Reviewed", "Different"],
  ])("rejects %s reviewed content without truncating or filling", async (_name, persona, reviewed) => {
    const { page, field } = reviewedPage();

    const result = await runGreenhouseFlow(page, reviewedTask(persona), { reviewedCoverLetter: reviewed });

    expect(result).toMatchObject({ reviewReady: false });
    expect(page.locator).not.toHaveBeenCalled();
    expect(field.fill).not.toHaveBeenCalled();
  });

  it("preserves legacy cover-letter typing when no reviewed marker is supplied", async () => {
    const { page, field } = reviewedPage();
    const result = await runGreenhouseFlow(page, reviewedTask("Legacy"));

    expect(result).toMatchObject({ reviewReady: true });
    expect(page.fill).toHaveBeenCalledTimes(1);
    expect(page.fill).toHaveBeenCalledWith(COVER_LETTER_UNION.split(", ")[0], "");
    expect(page.type).toHaveBeenCalledTimes("Legacy".length);
    expect(field.fill).not.toHaveBeenCalled();
  });

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
      allowSubmit: true,
      beforeSubmit: vi.fn().mockResolvedValue(true),
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
      allowSubmit: true,
      beforeSubmit: vi.fn().mockResolvedValue(true),
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
      allowSubmit: true,
    });

    expect(result.status).toBe("manual");
    expect(result.error).toContain("No submit button");
  });

  it("rechecks submission authorization immediately before clicking submit", async () => {
    const page = mockPage();
    const beforeSubmit = vi.fn().mockResolvedValue(false);

    const result = await runGreenhouseFlow(page, {
      jobId: "job-4",
      applyUrl: "https://boards.greenhouse.io/booking/jobs/789",
      persona: { firstName: "Jane", email: "jane@test.com" },
      jobTitle: "Dev",
      jobCompany: "Inc",
      resumePath: "/r.pdf",
      allowSubmit: true,
      beforeSubmit,
    });

    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(result.status).toBe("submission_blocked");
    expect(result.error).toContain("denied");
  });
});

describe("detectFlow", () => {
  it("greenhouse URL detected", () => {
    expect(detectFlow("https://boards.greenhouse.io/booking/jobs/123")).toBe("greenhouse");
    expect(detectFlow("https://job-boards.greenhouse.io/embed/job_app?for=n26")).toBe("greenhouse");
    expect(detectFlow("https://grnh.se/abc123")).toBe("greenhouse");
  });

  it("workday URL detected", () => {
    expect(detectFlow("https://sap.wd3.myworkdayjobs.com/SAP")).toBe("workday");
  });

  it("direct Lever job URLs are detected while unknown URLs return null", () => {
    expect(detectFlow("https://jobs.lever.co/spotify/abc123")).toBe("lever");
    expect(detectFlow("https://example.com")).toBe(null);
  });

  it("mixed-case URLs still match", () => {
    expect(detectFlow("https://BOARDS.GREENHOUSE.IO/Booking/jobs/1")).toBe("greenhouse");
  });
});
