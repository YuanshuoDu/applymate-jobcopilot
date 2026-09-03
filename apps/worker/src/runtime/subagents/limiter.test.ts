import { describe, expect, it } from "vitest"

import { SessionConcurrencyLimiter } from "./limiter.js"
import { SubagentLimitError, normalizeSubagentPolicy } from "./types.js"

const policy = normalizeSubagentPolicy({ maxConcurrency: 2 })

describe("SessionConcurrencyLimiter", () => {
  it("reserves at most the configured slots atomically per session", () => {
    const limiter = new SessionConcurrencyLimiter()
    const first = limiter.reserve("session-a", "task-1", policy)
    const second = limiter.reserve("session-a", "task-2", policy)
    expect(() => limiter.reserve("session-a", "task-3", policy)).toThrow(SubagentLimitError)
    expect(limiter.activeCount("session-a")).toBe(2)
    first.release()
    first.release()
    expect(limiter.activeCount("session-a")).toBe(1)
    second.release()
    expect(limiter.activeCount("session-a")).toBe(0)
  })

  it("does not share capacity between sessions", () => {
    const limiter = new SessionConcurrencyLimiter()
    limiter.reserve("session-a", "task-a", policy)
    limiter.reserve("session-a", "task-b", policy)
    const other = limiter.reserve("session-b", "task-c", policy)
    expect(limiter.activeCount("session-a")).toBe(2)
    expect(limiter.activeCount("session-b")).toBe(1)
    other.release()
  })

  it("rejects duplicate reservation for one task", () => {
    const limiter = new SessionConcurrencyLimiter()
    const slot = limiter.reserve("session-a", "task-a", policy)
    expect(() => limiter.reserve("session-a", "task-a", policy)).toThrow("already reserved")
    slot.release()
  })
})

