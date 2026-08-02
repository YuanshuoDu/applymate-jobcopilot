/**
 * Conservative BullMQ idle settings for command-metered Redis services.
 * BullMQ caps blocking fetches at 10 seconds, so a larger value would not
 * reduce commands. The defaults preserve recovery while lowering idle churn.
 */
export interface WorkerPollingOptions {
  drainDelay: number
  stalledInterval: number
}

const DEFAULT_DRAIN_DELAY_SECONDS = 10
const DEFAULT_STALLED_INTERVAL_MS = 120_000

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw)
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback
}

export function workerPollingOptions(
  env: NodeJS.ProcessEnv = process.env,
): WorkerPollingOptions {
  return {
    // BullMQ internally limits this value to 10 seconds.
    drainDelay: boundedInteger(env.BULLMQ_DRAIN_DELAY_SECONDS, DEFAULT_DRAIN_DELAY_SECONDS, 1, 10),
    // A failed worker is still recovered within two minutes by default.
    stalledInterval: boundedInteger(env.BULLMQ_STALLED_INTERVAL_MS, DEFAULT_STALLED_INTERVAL_MS, 30_000, 300_000),
  }
}
