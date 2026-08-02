import { describe, expect, it } from "vitest"
import { workerPollingOptions } from "./worker-polling-options.js"

describe("workerPollingOptions", () => {
  it("uses low-churn defaults that retain stalled-job recovery", () => {
    expect(workerPollingOptions({})).toEqual({ drainDelay: 10, stalledInterval: 120_000 })
  })

  it("accepts bounded production overrides", () => {
    expect(workerPollingOptions({
      BULLMQ_DRAIN_DELAY_SECONDS: "8",
      BULLMQ_STALLED_INTERVAL_MS: "180000",
    })).toEqual({ drainDelay: 8, stalledInterval: 180_000 })
  })

  it("rejects unsafe or ineffective overrides", () => {
    expect(workerPollingOptions({
      BULLMQ_DRAIN_DELAY_SECONDS: "60",
      BULLMQ_STALLED_INTERVAL_MS: "5000",
    })).toEqual({ drainDelay: 10, stalledInterval: 120_000 })
  })
})
