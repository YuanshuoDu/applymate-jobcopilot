import { describe, expect, it, vi } from "vitest";
import type { Page } from "playwright-core";
import type { FormPatternRow } from "../db/form-patterns.js";
import { replayPattern } from "./replay.js";

function pattern(fieldMapping: Record<string, string>): FormPatternRow {
  return {
    id: "pattern-1",
    atsHost: "jobs.example.com",
    urlPattern: "/apply",
    fieldMapping,
    successCount: 3,
    failureCount: 0,
    lastSuccessAt: new Date().toISOString(),
  };
}

function mockPage(options: {
  visibleSelectors?: string[];
  submitVisible?: boolean;
  url?: string;
  title?: string;
} = {}) {
  const visibleSelectors = new Set(options.visibleSelectors ?? []);
  const submitVisible = options.submitVisible ?? true;
  const fill = vi.fn(async () => {});
  const type = vi.fn(async () => {});
  const click = vi.fn(async () => {});
  const waitForLoadState = vi.fn(async () => {});

  const page = {
    fill,
    type,
    click,
    waitForLoadState,
    url: vi.fn(() => options.url ?? "https://jobs.example.com/thank-you"),
    title: vi.fn(async () => options.title ?? "Application submitted"),
    locator: vi.fn((selector: string) => {
      const isSubmitSelector = selector.includes("submit") || selector.includes("Submit") || selector.includes("Apply");
      const exists = isSubmitSelector ? submitVisible : visibleSelectors.has(selector);
      return {
        first: () => ({
          count: vi.fn(async () => (exists ? 1 : 0)),
          isVisible: vi.fn(async () => exists),
          click,
        }),
      };
    }),
    $$: vi.fn(async () => []),
  } as unknown as Page & {
    fill: typeof fill;
    type: typeof type;
    click: typeof click;
    waitForLoadState: typeof waitForLoadState;
  };

  return page;
}

describe("replayPattern", () => {
  it("fills fields from a pattern and submits the form", async () => {
    const page = mockPage({
      visibleSelectors: ["#name", "#email"],
      submitVisible: true,
      url: "https://jobs.example.com/confirmation",
    });

    const result = await replayPattern(
      page,
      pattern({ "#name": "fullName", "#email": "email" }),
      { fullName: "Ada Lovelace", email: "ada@example.com" }
    );

    expect(result.status).toBe("submitted");
    expect(page.fill).toHaveBeenCalledWith("#name", "");
    expect(page.fill).toHaveBeenCalledWith("#email", "");
    expect(page.type).toHaveBeenCalledWith("#name", "A", expect.objectContaining({ delay: expect.any(Number) }));
    expect(page.type).toHaveBeenCalledWith("#email", "a", expect.objectContaining({ delay: expect.any(Number) }));
    expect(page.click).toHaveBeenCalledTimes(1);
    expect(page.waitForLoadState).toHaveBeenCalledWith("networkidle", { timeout: 20_000 });
    expect(result.log).toEqual(
      expect.arrayContaining([
        { field: "fullName", selector: "#name", action: "replay-fill" },
        { field: "email", selector: "#email", action: "replay-fill" },
      ])
    );
  });

  it("returns manual when no pattern fields match the page", async () => {
    const page = mockPage({ visibleSelectors: [], submitVisible: true });

    const result = await replayPattern(page, pattern({ "#missing": "fullName" }), {
      fullName: "Ada Lovelace",
    });

    expect(result.status).toBe("manual");
    expect(result.error).toBe("No matching fields found in pattern");
    expect(page.fill).not.toHaveBeenCalled();
    expect(page.click).not.toHaveBeenCalled();
    expect(result.log).toEqual([{ selector: "#missing", action: "replay-miss" }]);
  });

  it("returns manual when fields fill but submit button is missing", async () => {
    const page = mockPage({ visibleSelectors: ["#name"], submitVisible: false });

    const result = await replayPattern(page, pattern({ "#name": "fullName" }), {
      fullName: "Ada Lovelace",
    });

    expect(result.status).toBe("manual");
    expect(result.error).toBe("Submit button not found");
    expect(page.fill).toHaveBeenCalledWith("#name", "");
    expect(page.click).not.toHaveBeenCalled();
  });
});
