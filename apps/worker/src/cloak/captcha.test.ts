import { beforeEach, describe, expect, it, vi } from "vitest";

describe("captcha", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("detects CAPTCHA iframes, selector widgets, and page text", async () => {
    const { detectCaptcha } = await import("./captcha.js");
    const page = {
      locator: vi.fn((selector: string) => ({
        count: vi.fn().mockResolvedValue(
          selector.includes("challenges.cloudflare.com") ||
            selector.includes(".g-recaptcha")
            ? 1
            : 0
        ),
      })),
      textContent: vi.fn().mockResolvedValue("Please verify you are human"),
    };

    await expect(detectCaptcha(page as never)).resolves.toBe(true);
  });

  it("returns false when no CAPTCHA signal is present", async () => {
    const { detectCaptcha } = await import("./captcha.js");
    const page = {
      locator: vi.fn(() => ({ count: vi.fn().mockResolvedValue(0) })),
      textContent: vi.fn().mockResolvedValue("Apply for this job"),
    };

    await expect(detectCaptcha(page as never)).resolves.toBe(false);
  });

  it("exports detection only, so the worker cannot solve or inject CAPTCHA tokens", async () => {
    const captcha = await import("./captcha.js");
    expect("solveCaptcha" in captcha).toBe(false);
  });
});
