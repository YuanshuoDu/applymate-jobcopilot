import { describe, expect, it, vi } from "vitest"

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

  it("bridges the exact durable Turn scope after persistence and stays idempotent", async () => {
    const events: string[] = []
    const roots = new RootAbortControllerRegistry()
    const persisted = new InMemoryInterruptPersistence()
    const terminal = new InMemoryTerminalEventPort()
    const subtree = {
      interrupt: vi.fn(async (scope: { userId: string; sessionId: string; turnId: string }) => {
        events.push("subtree")
        expect(roots.get(scope)?.stopped).toBe(true)
        return 2
      }),
    }
    const service = new TurnCancelService({
      persistence: {
        persist: async input => { events.push("persist"); return persisted.persist(input) },
        isRequested: target => persisted.isRequested(target),
      },
      roots,
      subtree,
      terminal: { append: async input => { events.push("terminal"); return terminal.append(input) } },
      now: () => now,
    })

    await service.stop({ ...target, requestId: "stop-bridge-1", requestedAt })
    await service.stop({ ...target, requestId: "stop-bridge-2", requestedAt })

    expect(events).toEqual(["persist", "subtree", "terminal", "persist", "subtree", "terminal"])
    expect(subtree.interrupt).toHaveBeenNthCalledWith(1, target)
    expect(subtree.interrupt).toHaveBeenNthCalledWith(2, target)
  })

  it("keeps the durable Stop accepted when the optional child bridge fails", async () => {
    const roots = new RootAbortControllerRegistry()
    const terminal = new InMemoryTerminalEventPort()
    const service = new TurnCancelService({
      persistence: new InMemoryInterruptPersistence(),
      roots,
      subtree: { interrupt: vi.fn(async () => { throw new Error("child bridge unavailable") }) },
      terminal,
      now: () => now,
    })

    await expect(service.stop({ ...target, requestId: "stop-bridge-failure", requestedAt })).resolves.toMatchObject({ disposition: "interrupted" })
    expect(roots.get(target)?.signal.aborted).toBe(true)
    expect(terminal.events(target)).toHaveLength(1)
  })
})
