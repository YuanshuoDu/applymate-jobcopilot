import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFetch = vi.fn();

describe("captcha", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("fetch", mockFetch);
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

  it("skips solving when CAPSOLVER_API_KEY is not configured", async () => {
    const { solveCaptcha } = await import("./captcha.js");

    await expect(solveCaptcha({} as never)).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("creates and polls a CapSolver task, then injects the solved token", async () => {
    vi.stubEnv("CAPSOLVER_API_KEY", "capsolver-key");
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ errorId: 0, taskId: "task-1" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          errorId: 0,
          status: "ready",
          solution: { gRecaptchaResponse: "captcha-token" },
        }),
      });
    const page = {
      url: vi.fn().mockReturnValue("https://jobs.example/apply"),
      locator: vi.fn(() => ({
        first: vi.fn().mockReturnValue({
          getAttribute: vi.fn().mockResolvedValue("site-key"),
        }),
      })),
      evaluate: vi.fn().mockResolvedValue(undefined),
    };

    const { solveCaptcha } = await import("./captcha.js");
    await expect(solveCaptcha(page as never, { pollIntervalMs: 1 })).resolves.toBe(true);

    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      "https://api.capsolver.com/createTask",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("site-key"),
      })
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      "https://api.capsolver.com/getTaskResult",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("task-1"),
      })
    );
    expect(page.evaluate).toHaveBeenCalledWith(expect.any(Function), "captcha-token");
  });
});
