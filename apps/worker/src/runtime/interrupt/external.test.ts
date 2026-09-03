import { describe, expect, it } from "vitest"

import { ExternalActionRegistry } from "./external.js"
import { InterruptRequestedError, RootAbortController } from "./registry.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }
const startedAt = new Date("2026-09-02T10:00:00.000Z")
const resolvedAt = new Date("2026-09-02T10:00:01.000Z")

describe("external action reconciliation", () => {
  it("records resolver success as completed and never emits cancelled", async () => {
    const root = new RootAbortController(target)
    const registry = new ExternalActionRegistry()
    const handle = registry.begin(root, { ...target, actionId: "submit-1", operation: "application.submit", startedAt })
    root.stop("user_stop")
    const records = await registry.reconcile(target, {
      reconcile: async (action) => {
        expect(action.startedAt).toBe(startedAt)
        return "completed"
      }}, resolvedAt)
    expect(handle.signal.aborted).toBe(true)
    expect(records[0]).toMatchObject({ actionId: "submit-1", resolution: "completed", startedAt })
    expect(records.every((record) => record.resolution === "completed" || record.resolution === "uncertain")).toBe(true)
  })

  it("maps resolver failure to uncertain and forbids new external work after Stop", async () => {
    const root = new RootAbortController(target)
    const registry = new ExternalActionRegistry()
    registry.begin(root, { ...target, actionId: "submit-2", operation: "application.submit", startedAt })
    root.stop("user_stop")
    const records = await registry.reconcile(target, { reconcile: async () => { throw new Error("provider unavailable") } }, resolvedAt)
    expect(records).toMatchObject([{ actionId: "submit-2", resolution: "uncertain" }])
    expect(() => registry.begin(root, { ...target, actionId: "submit-3", operation: "application.submit", startedAt })).toThrow(InterruptRequestedError)
  })

  it("preserves an explicit completed resolution", async () => {
    const root = new RootAbortController(target)
    const registry = new ExternalActionRegistry()
    const handle = registry.begin(root, { ...target, actionId: "submit-4", operation: "application.submit", startedAt })
    const completed = handle.complete(resolvedAt)
    expect(await registry.reconcile(target)).toEqual([])
    expect(registry.records(target)).toEqual([completed])
  })
})
