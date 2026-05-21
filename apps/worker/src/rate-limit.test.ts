import { describe, it, expect, beforeEach } from "vitest";
import { checkRateLimit, resetRateLimits } from "./rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimits();
  });

  it("allows up to 30 tasks per user per hour (different domains)", () => {
    // Use unique domains to avoid per-domain limit blocking
    for (let i = 0; i < 30; i++) {
      const result = checkRateLimit("user-1", `site-${i}.com`);
      expect(result.allowed, `iteration ${i}`).toBe(true);
    }
  });

  it("blocks the 31st task for the same user", () => {
    for (let i = 0; i < 30; i++) {
      checkRateLimit("user-1", `site-${i}.com`);
    }
    const result = checkRateLimit("user-1", "site-extra.com");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("allows 5 tasks per user per domain per 4 hours", () => {
    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit("user-1", "greenhouse.io");
      expect(result.allowed).toBe(true);
    }
    const blocked = checkRateLimit("user-1", "greenhouse.io");
    expect(blocked.allowed).toBe(false);
  });

  it("allows same user on different domains independently", () => {
    for (let i = 0; i < 5; i++) {
      checkRateLimit("user-1", "greenhouse.io");
    }
    const result = checkRateLimit("user-1", "lever.co");
    expect(result.allowed).toBe(true);
  });

  it("handles null domain gracefully", () => {
    const result = checkRateLimit("user-1", null);
    expect(result.allowed).toBe(true);
  });

  it("different users get independent limits", () => {
    for (let i = 0; i < 30; i++) {
      checkRateLimit("user-1", `site-${i}.com`);
    }
    const blocked = checkRateLimit("user-1", "site-extra.com");
    expect(blocked.allowed).toBe(false);
    const allowed = checkRateLimit("user-2", "example.com");
    expect(allowed.allowed).toBe(true);
  });
});
