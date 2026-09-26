import { describe, expect, it, vi } from "vitest"

import { RootAbortController } from "../interrupt/registry.js"
import type { LeasePool, TurnLease } from "./lease.js"
import { interruptPollInterval, startInterruptProbe, TURN_INTERRUPT_POLL_INTERVAL_MS } from "./turn-interrupt-probe.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1",
  leaseVersion: 1, leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000),
}

describe("Turn interrupt probe helpers", () => {
  it("validates the bounded polling interval and preserves its default", () => {
    expect(interruptPollInterval(undefined)).toBe(TURN_INTERRUPT_POLL_INTERVAL_MS)
    expect(interruptPollInterval(1)).toBe(1)
    expect(() => interruptPollInterval(0)).toThrow(RangeError)
    expect(() => interruptPollInterval(30_001)).toThrow(RangeError)
  })

  it("stops the root controller when the durable probe reports a Stop", async () => {
    const root = new RootAbortController({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    const isInterrupted = vi.fn().mockResolvedValue(true)
    const stop = startInterruptProbe({ pool: {} as LeasePool, isInterrupted }, lease, root, 60_000)
    try {
      await vi.waitFor(() => expect(root.stopped).toBe(true))
      expect(isInterrupted).toHaveBeenCalledOnce()
    } finally {
      stop()
    }
  })

  it("keeps transient probe errors advisory", async () => {
    const root = new RootAbortController({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
    const isInterrupted = vi.fn().mockRejectedValue(new Error("status unavailable"))
    const stop = startInterruptProbe({ pool: {} as LeasePool, isInterrupted }, lease, root, 60_000)
    try {
      await vi.waitFor(() => expect(isInterrupted).toHaveBeenCalledOnce())
      expect(root.stopped).toBe(false)
    } finally {
      stop()
    }
  })
})
