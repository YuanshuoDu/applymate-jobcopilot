import { describe, expect, it } from "vitest"

import { InterruptRequestedError, RootAbortController, RootAbortControllerRegistry } from "./registry.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }

describe("root interrupt registry", () => {
  it("cascades one Stop to model, tool, task, browser, and wait operations", () => {
    const metadataTarget = { ...target, requestedAt: new Date() }
    const root = new RootAbortController(metadataTarget)
    const operations = [
      root.register("model", "model-1"),
      root.register("tool", "tool-1"),
      root.register("task", "task-1"),
      root.register("browser", "browser-1"),
      root.register("wait", "wait-1"),
    ]

    expect(root.stop("user_stop")).toEqual({ accepted: true, operationCount: 5 })
    expect(root.signal.reason).toBeInstanceOf(InterruptRequestedError)
    expect(operations.every((operation) => operation.signal.aborted)).toBe(true)
    expect(operations.every((operation) => operation.signal.reason instanceof InterruptRequestedError)).toBe(true)
    expect(root.stop("duplicate_stop")).toEqual({ accepted: false, operationCount: 5 })
    expect(() => root.register("step", "late-step")).toThrow(InterruptRequestedError)
  })

  it("keeps roots tenant-scoped and reuses the same root for metadata-bearing targets", () => {
    const registry = new RootAbortControllerRegistry()
    const requestTarget = { ...target, requestedAt: new Date() }
    const first = registry.getOrCreate(requestTarget)
    const same = registry.getOrCreate(target)
    const otherTarget = { ...target, userId: "user-2", startedAt: new Date() }
    const other = registry.getOrCreate(otherTarget)
    expect(same).toBe(first)
    expect(other).not.toBe(first)
    expect(registry.size).toBe(2)
    const lookupTarget = { ...target, payload: { safe: true } }
    expect(registry.get(lookupTarget)).toBe(first)
  })
})
