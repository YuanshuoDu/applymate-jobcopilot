import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
  ttl: vi.fn(),
  keys: vi.fn(),
  del: vi.fn(),
}));

vi.mock("ioredis", () => ({
  Redis: vi.fn().mockImplementation(() => mocks),
}));

import { checkRateLimit, resetRateLimits } from "./rate-limit.js";

describe("checkRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.eval.mockResolvedValue(1);
    mocks.ttl.mockResolvedValue(3600);
    mocks.keys.mockResolvedValue([]);
    mocks.del.mockResolvedValue(0);
  });

  it("increments and sets the first-window expiry in one atomic Redis operation", async () => {
    mocks.eval.mockResolvedValueOnce(1);

    const result = await checkRateLimit("user-1", null);

    expect(result.allowed).toBe(true);
    expect(mocks.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      "ratelimit:user:user-1",
      3600,
    );
    expect(mocks.eval.mock.calls[0]?.[0]).toContain("redis.call('EXPIRE', KEYS[1], ARGV[1])");
  });

  it("blocks the 31st task for the same user", async () => {
    mocks.eval.mockResolvedValueOnce(31);
    mocks.ttl.mockResolvedValueOnce(42);

    const result = await checkRateLimit("user-1", "site-extra.com");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(42_000);
    expect(mocks.eval).toHaveBeenCalledTimes(1);
    expect(mocks.ttl).toHaveBeenCalledWith("ratelimit:user:user-1");
  });

  it("checks per-domain limits after the per-user check passes", async () => {
    mocks.eval
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(6);
    mocks.ttl.mockResolvedValueOnce(300);

    const result = await checkRateLimit("user-1", "greenhouse.io");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(300_000);
    expect(mocks.eval).toHaveBeenNthCalledWith(1, expect.any(String), 1, "ratelimit:user:user-1", 3600);
    expect(mocks.eval).toHaveBeenNthCalledWith(2, expect.any(String), 1, "ratelimit:domain:user-1:greenhouse.io", 14400);
    expect(mocks.ttl).toHaveBeenCalledWith("ratelimit:domain:user-1:greenhouse.io");
  });

  it("allows same user on different domains independently", async () => {
    mocks.eval
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);

    const result = await checkRateLimit("user-1", "lever.co");

    expect(result.allowed).toBe(true);
    expect(mocks.eval).toHaveBeenCalledWith(expect.any(String), 1, "ratelimit:domain:user-1:lever.co", 14400);
  });

  it("handles null domain gracefully", async () => {
    mocks.eval.mockResolvedValueOnce(1);

    const result = await checkRateLimit("user-1", null);

    expect(result.allowed).toBe(true);
    expect(mocks.eval).toHaveBeenCalledTimes(1);
  });

  it("resetRateLimits clears Redis rate limit keys", async () => {
    mocks.keys.mockResolvedValueOnce(["ratelimit:user:user-1", "ratelimit:domain:user-1:greenhouse.io"]);
    mocks.del.mockResolvedValueOnce(2);

    await resetRateLimits();

    expect(mocks.keys).toHaveBeenCalledWith("ratelimit:*");
    expect(mocks.del).toHaveBeenCalledWith("ratelimit:user:user-1", "ratelimit:domain:user-1:greenhouse.io");
  });
});
