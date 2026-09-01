import { describe, expect, it, vi } from "vitest"

import { TurnHeartbeat } from "./heartbeat.js"
import type { TurnLease } from "./lease.js"

const lease: TurnLease = {
  turnId: "turn_1", sessionId: "session_1", ownerId: "owner_1", userId: "user_1",
  leaseVersion: 4, leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"),
  leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}

function clock() {
  let handler: (() => void) | undefined
  return {
    setInterval: vi.fn((next: () => void) => { handler = next; return 1 as unknown as ReturnType<typeof setInterval> }),
    clearInterval: vi.fn(),
    tick: () => handler?.(),
  }
}

describe("TurnHeartbeat", () => {
  it("renews on the configured cadence and replaces the fencing lease", async () => {
    const timers = clock()
    const renewed = { ...lease, leaseExpiresAt: new Date("2026-09-01T00:01:20.000Z") }
    const renew = vi.fn().mockResolvedValue(renewed)
    const heartbeat = new TurnHeartbeat(lease, {
      intervalMs: 20_000, clock: timers,
      now: () => new Date("2026-09-01T00:00:20.000Z"), renew,
    })
    heartbeat.start()
    timers.tick()
    await vi.waitFor(() => expect(renew).toHaveBeenCalledOnce())
    expect(renew).toHaveBeenCalledWith(lease, new Date("2026-09-01T00:00:20.000Z"))
    expect(heartbeat.currentLease).toEqual(renewed)
  })

  it("aborts and expires the lease when renewal is rejected", async () => {
    const timers = clock()
    const expire = vi.fn().mockResolvedValue(true)
    const onLost = vi.fn()
    const heartbeat = new TurnHeartbeat(lease, {
      clock: timers, now: () => new Date("2026-09-01T00:01:01.000Z"),
      renew: vi.fn().mockResolvedValue(null), expire, onLost,
    })
    heartbeat.start()
    timers.tick()
    await expect(heartbeat.lost).resolves.toMatchObject({ code: "lease_lost" })
    expect(heartbeat.signal.aborted).toBe(true)
    expect(expire).toHaveBeenCalledWith(lease, new Date("2026-09-01T00:01:01.000Z"))
    expect(onLost).toHaveBeenCalledOnce()
  })

  it("does not schedule another renewal after stop", async () => {
    const timers = clock()
    const renew = vi.fn().mockResolvedValue(lease)
    const heartbeat = new TurnHeartbeat(lease, { clock: timers, renew })
    heartbeat.start()
    heartbeat.stop()
    timers.tick()
    await Promise.resolve()
    expect(renew).not.toHaveBeenCalled()
    expect(timers.clearInterval).toHaveBeenCalledOnce()
  })
})
