import { describe, expect, it } from "vitest"

import { ExternalActionRegistry } from "./external.js"
import { InMemoryInterruptPersistence } from "./persistence.js"
import { RootAbortControllerRegistry } from "./registry.js"
import { TurnCancelService } from "./service.js"
import { InMemoryTerminalEventPort } from "./terminal.js"

const target = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }
const requestedAt = new Date("2026-09-02T10:00:00.000Z")
const startedAt = new Date("2026-09-02T10:00:00.100Z")
const now = new Date("2026-09-02T10:00:01.000Z")

function setup() {
  const roots = new RootAbortControllerRegistry()
  const root = roots.getOrCreate(target)
  const operations = ["model", "tool", "task", "browser", "wait"].map((kind, index) => root.register(kind as "model" | "tool" | "task" | "browser" | "wait", `operation-${index}`))
  const external = new ExternalActionRegistry()
  const action = external.begin(root, { ...target, actionId: "submit-1", operation: "application.submit", startedAt })
  const terminal = new InMemoryTerminalEventPort()
  const service = new TurnCancelService({
    persistence: new InMemoryInterruptPersistence(), roots, terminal, external,
    evidence: { reconcile: async () => "completed" }, now: () => now,
  })
  return { roots, root, operations, action, external, terminal, service }
}

describe("TurnCancelService", () => {
  it("persists before stopping the root and emits one terminal event", async () => {
    const fixture = setup()
    const [first, second] = await Promise.all([
      fixture.service.stop({ ...target, requestId: "stop-1", reason: "user_stop", requestedAt }),
      fixture.service.stop({ ...target, requestId: "stop-2", reason: "duplicate_stop", requestedAt }),
    ])
    expect([first.disposition, second.disposition].sort()).toEqual(["duplicate", "interrupted"])
    expect(fixture.root.signal.aborted).toBe(true)
    expect(fixture.operations.every((operation) => operation.signal.aborted)).toBe(true)
    expect(fixture.action.signal.aborted).toBe(true)
    expect(fixture.terminal.events()).toHaveLength(1)
    expect(fixture.terminal.events()[0].payload).toMatchObject({ externalActions: [{ actionId: "submit-1", resolution: "completed" }] })
  })

  it("records uncertain when the external evidence resolver fails", async () => {
    const fixture = setup()
    const service = new TurnCancelService({
      persistence: new InMemoryInterruptPersistence(), roots: fixture.roots, terminal: fixture.terminal,
      external: fixture.external, evidence: { reconcile: async () => { throw new Error("provider unavailable") } }, now: () => now,
    })
    const result = await service.stop({ ...target, requestId: "stop-3", requestedAt })
    expect(result.externalActions).toMatchObject([{ actionId: "submit-1", resolution: "uncertain" }])
  })
})
