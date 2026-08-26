import { Redis } from "ioredis";
import type { RedisOptions } from "ioredis";

const DEFAULT_REDIS_URL = "redis://localhost:6379";
const CONNECT_TIMEOUT_MS = 5_000;
const KEEP_ALIVE_MS = 10_000;
const MAX_RETRY_DELAY_MS = 5_000;

function resolveRedisUrl(): string {
  const configured = process.env.REDIS_URL?.trim();
  return configured || DEFAULT_REDIS_URL;
}

function retryStrategy(attempt: number): number {
  return Math.min(Math.max(attempt, 1) * 500, MAX_RETRY_DELAY_MS);
}

const sharedOptions: RedisOptions = {
  enableReadyCheck: false,
  connectTimeout: CONNECT_TIMEOUT_MS,
  keepAlive: KEEP_ALIVE_MS,
  retryStrategy,
};

/**
 * Shared base connection for BullMQ queues and workers. BullMQ creates its
 * own blocking duplicate for each Worker, so sharing this client avoids one
 * idle command connection per queue without changing worker concurrency.
 */
export const redisConnection = new Redis(resolveRedisUrl(), {
  ...sharedOptions,
  maxRetriesPerRequest: null,
});

/** Fast-failing connection for non-queue commands such as rate limiting. */
export const redisCommandConnection = new Redis(resolveRedisUrl(), {
  ...sharedOptions,
  maxRetriesPerRequest: 1,
});

export async function closeSharedRedisConnections(): Promise<void> {
  redisCommandConnection.disconnect();
  redisConnection.disconnect();
}
