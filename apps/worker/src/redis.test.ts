import { afterEach, describe, expect, it, vi } from "vitest";

const clients: Array<{ options: Record<string, unknown>; disconnect: ReturnType<typeof vi.fn> }> = [];

vi.mock("ioredis", () => ({
  Redis: class MockRedis {
    options: Record<string, unknown>;
    disconnect = vi.fn();

    constructor(_url: string, options: Record<string, unknown>) {
      this.options = options;
      clients.push(this);
    }
  },
}));

describe("shared Redis connections", () => {
  afterEach(() => {
    vi.resetModules();
    clients.length = 0;
  });

  it("creates resilient BullMQ and fast-failing command clients", async () => {
    vi.stubEnv("REDIS_URL", "rediss://redis.example.test:6380");
    const module = await import("./redis.js");

    expect(clients).toHaveLength(2);
    expect(clients[0].options).toMatchObject({
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 5_000,
      keepAlive: 10_000,
    });
    expect(clients[1].options).toMatchObject({
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      connectTimeout: 5_000,
      keepAlive: 10_000,
    });

    const retry = clients[0].options.retryStrategy as (attempt: number) => number;
    expect(retry(1)).toBe(500);
    expect(retry(20)).toBe(5_000);

    await module.closeSharedRedisConnections();
    expect(clients[0].disconnect).toHaveBeenCalledOnce();
    expect(clients[1].disconnect).toHaveBeenCalledOnce();
  });
});
