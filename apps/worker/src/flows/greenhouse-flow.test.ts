import { describe, it, expect, vi } from "vitest";
import { runGreenhouseFlow } from "./greenhouse-flow.js";
import { detectFlow } from "./index.js";
import type { Page } from "playwright-core";

const COVER_LETTER_UNION = "textarea[name*='cover' i], textarea[id*='cover' i], textarea[placeholder*='cover' i]";

function reviewedPage(options: {
  count?: number; visible?: boolean; value?: string; onIntent?: () => void; onIntentValue?: string; sequence?: string[];
  sameForm?: boolean; name?: string; disabled?: boolean; finalVisible?: boolean; finalCount?: number; duplicateName?: boolean;
} = {}) {
  let value = options.value ?? "";
  let currentUrl = "https://boards.greenhouse.io/booking/jobs/123/applications/new";
  const formElements = { namedItem: vi.fn(() => null as unknown) };
  const form = { action: "https://boards.greenhouse.io/booking/apply", method: "POST", target: "", elements: formElements };
  const fieldForm = options.sameForm === false ? {} : form;
  const textarea = {
    tagName: "TEXTAREA", form: fieldForm, name: options.name ?? "cover_letter",
    matches: vi.fn((selector: string) => selector === ":disabled" && options.disabled === true),
    getClientRects: vi.fn(() => options.finalVisible === false ? [] : [{}]),
    get value() { return value; }, set value(next: string) { value = next; },
  };
  formElements.namedItem.mockReturnValue(options.duplicateName ? { length: 2 } : textarea);
  const document = {
    querySelectorAll: vi.fn(() => Array.from({ length: options.finalCount ?? 1 }, () => textarea)),
    defaultView: { getComputedStyle: vi.fn(() => ({ display: "block", visibility: "visible" })) },
    querySelector: vi.fn(() => null),
  };
  const field = {
    count: vi.fn().mockResolvedValue(options.count ?? 1), isVisible: vi.fn().mockResolvedValue(options.visible ?? true),
    inputValue: vi.fn(async () => { options.sequence?.push("readback"); return value; }),
    fill: vi.fn(async (content: string) => { value = content; }),
  };
  const locator = { ...field, first: () => field };
  const submitter = {
    count: vi.fn().mockResolvedValue(1), isVisible: vi.fn().mockResolvedValue(true),
    evaluate: vi.fn(async (callback: (element: Element, arg?: unknown) => unknown, arg?: unknown) => {
      if (arg === undefined) {
        options.onIntent?.();
        if (options.onIntentValue !== undefined) value = options.onIntentValue;
        return { url: form.action, method: form.method };
      }
      options.sequence?.push("readback");
      const submitterElement = {
        tagName: "BUTTON", type: "submit", form, formAction: "", formMethod: "", formTarget: "",
        hasAttribute: () => false, ownerDocument: document,
      };
      return callback(submitterElement as unknown as Element, arg);
    }),
    click: vi.fn(async () => { options.sequence?.push("click"); currentUrl = "https://boards.greenhouse.io/booking/confirmation"; }),
  };
  const submitterLocator = { ...submitter, first: () => submitter };
  const page = {
    url: () => currentUrl,
    title: vi.fn().mockResolvedValue("Application Submitted"),
    locator: vi.fn((selector: string) => selector === COVER_LETTER_UNION || selector.startsWith("textarea[") ? locator : submitterLocator),
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    focus: vi.fn().mockResolvedValue(undefined), fill: vi.fn(), type: vi.fn(), click: vi.fn(), $$: vi.fn().mockResolvedValue([]),
  } as unknown as Page;
  return { page, field, submitter };
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

  it("allows approved submission only after a final exact readback immediately before the typed/session guard", async () => {
    const content = "Reviewed source text";
    const sequence: string[] = [];
    const { page, field, submitter } = reviewedPage({ sequence });
    const beforeSubmit = vi.fn(async () => { sequence.push("guard"); return true; });

    const result = await runGreenhouseFlow(page, { ...reviewedTask(content), allowSubmit: true, beforeSubmit }, {
      reviewedCoverLetter: content, mode: "approved-submit",
    });

    expect(result.status).toBe("submitted");
    expect(field.fill).toHaveBeenCalledWith(content);
    expect(sequence.slice(-3)).toEqual(["readback", "guard", "click"]);
    expect(beforeSubmit).toHaveBeenCalledOnce();
    expect(beforeSubmit).toHaveBeenCalledWith({ url: "https://boards.greenhouse.io/booking/apply", method: "POST" });
    expect(submitter.click).toHaveBeenCalledOnce();
  });

  it("accepts only an exact existing reviewed value in approved mode; fill-only still refuses to reuse it", async () => {
    const content = "Reviewed source text";
    const approved = reviewedPage({ value: content });
    const submit = await runGreenhouseFlow(approved.page, { ...reviewedTask(content), allowSubmit: true, beforeSubmit: vi.fn().mockResolvedValue(true) }, {
      reviewedCoverLetter: content, mode: "approved-submit",
    });
    expect(submit.status).toBe("submitted");
    expect(approved.field.fill).not.toHaveBeenCalled();

    const fillOnly = reviewedPage({ value: content });
    const review = await runGreenhouseFlow(fillOnly.page, reviewedTask(content), { reviewedCoverLetter: content });
    expect(review).toMatchObject({ status: "manual", reviewReady: false });
    expect(fillOnly.submitter.click).not.toHaveBeenCalled();
  });

  it("does not fill or submit in approved mode without both submit permission and the existing guard", async () => {
    const { page, field, submitter } = reviewedPage();
    const result = await runGreenhouseFlow(page, reviewedTask("Reviewed source text"), {
      reviewedCoverLetter: "Reviewed source text", mode: "approved-submit",
    });
    expect(result).toMatchObject({ status: "manual", reviewReady: false });
    expect(field.fill).not.toHaveBeenCalled();
    expect(submitter.click).not.toHaveBeenCalled();
  });

  it("rejects a field changed while resolving the submit intent before invoking either guard or click", async () => {
    const content = "Reviewed source text";
    const sequence: string[] = [];
    const { page, field, submitter } = reviewedPage({ sequence, onIntentValue: "Changed after final fill" });
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    const result = await runGreenhouseFlow(page, { ...reviewedTask(content), allowSubmit: true, beforeSubmit }, {
      reviewedCoverLetter: content, mode: "approved-submit",
    });

    expect(result.status).toBe("submission_blocked");
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(submitter.click).not.toHaveBeenCalled();
    expect(field.fill).toHaveBeenCalledWith(content);
  });

  it.each([
    ["a different form", { sameForm: false }], ["an unnamed field", { name: "" }],
    ["a field in a disabled fieldset", { disabled: true }], ["an ambiguous field", { finalCount: 2 }],
    ["a hidden field", { finalVisible: false }], ["a duplicate named control", { duplicateName: true }],
  ])("blocks approved submit when reviewed text is in %s", async (_case, options) => {
    const content = "Reviewed source text";
    const { page, submitter } = reviewedPage(options);
    const beforeSubmit = vi.fn().mockResolvedValue(true);
    const result = await runGreenhouseFlow(page, { ...reviewedTask(content), allowSubmit: true, beforeSubmit }, {
      reviewedCoverLetter: content, mode: "approved-submit",
    });

    expect(result.status).toBe("submission_blocked");
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(submitter.click).not.toHaveBeenCalled();
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
