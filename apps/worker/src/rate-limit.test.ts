import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  incr: vi.fn(),
  expire: vi.fn(),
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
    mocks.expire.mockResolvedValue(1);
    mocks.ttl.mockResolvedValue(3600);
    mocks.keys.mockResolvedValue([]);
    mocks.del.mockResolvedValue(0);
  });

  it("uses Redis INCR and EXPIRE for the first user request in a window", async () => {
    mocks.incr.mockResolvedValueOnce(1);

    const result = await checkRateLimit("user-1", null);

    expect(result.allowed).toBe(true);
    expect(mocks.incr).toHaveBeenCalledWith("ratelimit:user:user-1");
    expect(mocks.expire).toHaveBeenCalledWith("ratelimit:user:user-1", 3600);
  });

  it("blocks the 31st task for the same user", async () => {
    mocks.incr.mockResolvedValueOnce(31);
    mocks.ttl.mockResolvedValueOnce(42);

    const result = await checkRateLimit("user-1", "site-extra.com");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(42_000);
    expect(mocks.incr).toHaveBeenCalledTimes(1);
    expect(mocks.ttl).toHaveBeenCalledWith("ratelimit:user:user-1");
  });

  it("checks per-domain limits after the per-user check passes", async () => {
    mocks.incr
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(6);
    mocks.ttl.mockResolvedValueOnce(300);

    const result = await checkRateLimit("user-1", "greenhouse.io");

    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBe(300_000);
    expect(mocks.incr).toHaveBeenNthCalledWith(1, "ratelimit:user:user-1");
    expect(mocks.incr).toHaveBeenNthCalledWith(2, "ratelimit:domain:user-1:greenhouse.io");
    expect(mocks.ttl).toHaveBeenCalledWith("ratelimit:domain:user-1:greenhouse.io");
  });

  it("allows same user on different domains independently", async () => {
    mocks.incr
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5);

    const result = await checkRateLimit("user-1", "lever.co");

    expect(result.allowed).toBe(true);
    expect(mocks.incr).toHaveBeenCalledWith("ratelimit:domain:user-1:lever.co");
  });

  it("handles null domain gracefully", async () => {
    mocks.incr.mockResolvedValueOnce(1);

    const result = await checkRateLimit("user-1", null);

    expect(result.allowed).toBe(true);
    expect(mocks.incr).toHaveBeenCalledTimes(1);
  });

  it("resetRateLimits clears Redis rate limit keys", async () => {
    mocks.keys.mockResolvedValueOnce(["ratelimit:user:user-1", "ratelimit:domain:user-1:greenhouse.io"]);
    mocks.del.mockResolvedValueOnce(2);

    await resetRateLimits();

    expect(mocks.keys).toHaveBeenCalledWith("ratelimit:*");
    expect(mocks.del).toHaveBeenCalledWith("ratelimit:user:user-1", "ratelimit:domain:user-1:greenhouse.io");
  });
});
