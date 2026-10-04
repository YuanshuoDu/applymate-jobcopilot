import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"

import { assertCanonicalCoordinationSurface, classifyToolCallRecovery, durableLifecycleSink } from "./canonical-runtime-tool-recovery.js"
import type { PersistedToolCallRecovery } from "./turn-engine-types.js"

const pending: PersistedToolCallRecovery = {
  call: { id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0", callItem: { id: "item-1", revision: 0 },
}

const lifecyclePayload = { toolCallId: "call-shared", toolName: "jobs.search", toolVersion: "1", status: "started" }

type LifecycleRecord = { owner: { sessionId: string }; id: string; idempotencyKey: string }
type LifecycleOutbox = { id: string; idempotencyKey: string; eventId: string }

function lifecycleEvent(payload = lifecyclePayload): never {
  return { phase: "started", eventType: "tool_call.started", item: { toolCallId: "call-shared" }, payload } as never
}

function lifecycleOwner(taskId: string): never {
  return { kind: "task", taskId, sessionId: "session-shared", turnId: "turn-shared" } as never
}

function lifecyclePersistence() {
  const events = new Map<string, LifecycleRecord>()
  const outbox = new Map<string, LifecycleOutbox>()
  const appendEvent = vi.fn(async (input: LifecycleRecord) => {
    const idempotencyScope = `${input.owner.sessionId}:${input.idempotencyKey}`
    const existing = [...events.values()].find(row => `${row.owner.sessionId}:${row.idempotencyKey}` === idempotencyScope)
    if (existing) {
      outbox.set(`agent-outbox-${existing.id}`, { id: `agent-outbox-${existing.id}`, idempotencyKey: `agent-event:${existing.id}`, eventId: existing.id })
      return { id: existing.id }
    }
    if (events.has(input.id)) throw new Error(`duplicate event id ${input.id}`)
    events.set(input.id, input)
    outbox.set(`agent-outbox-${input.id}`, { id: `agent-outbox-${input.id}`, idempotencyKey: `agent-event:${input.id}`, eventId: input.id })
    return { id: input.id }
  })
  return { store: { appendEvent } as never, appendEvent, events, outbox }
}

function lifecycleDigest(): string {
  return createHash("sha256").update(JSON.stringify(lifecyclePayload)).digest("hex").slice(0, 24)
}

describe("canonical runtime tool recovery", () => {
  it("replays only server-classified read-only or idempotent tools", () => {
    const resolve = vi.fn((name: string, _version: string) => ({ idempotency: name === "safe" ? "idempotent" as const : "non_repeatable" as const }))
    const result = classifyToolCallRecovery([
      { ...pending, call: { ...pending.call, name: "safe" } },
      { ...pending, call: { ...pending.call, id: "call-2", name: "unsafe" } },
      { ...pending, call: { ...pending.call, id: "call-3", name: "requires-key" } },
      { ...pending, call: { ...pending.call, id: "call-4", name: "unknown" } },
    ], name => {
      if (name === "unknown") throw new Error("not registered")
      return name === "requires-key" ? { idempotency: "requires_key" as const } : resolve(name, "1")
    })
    expect(result.map(item => item.action)).toEqual(["replay", "fail", "fail", "fail"])
    expect(resolve).toHaveBeenCalledWith("safe", "1")
    expect(resolve).toHaveBeenCalledWith("unsafe", "1")
  })

  it("reconciles a durable result without consulting tool replay metadata", () => {
    const resolve = vi.fn(() => { throw new Error("registry unavailable") })
    const result = classifyToolCallRecovery([{ ...pending, durableResult: { id: "call-1", toolName: "jobs.search", toolVersion: "1", status: "completed", output: [], errorCode: null } }], resolve)
    expect(result[0]?.action).toBe("reconcile")
    expect(resolve).not.toHaveBeenCalled()
  })

  it("resolves the persisted server-owned tool version", () => {
    const resolve = vi.fn((_name: string, version: string) => ({ idempotency: version === "2" ? "read_only" as const : "non_repeatable" as const }))
    const result = classifyToolCallRecovery([{ ...pending, toolVersion: "2" }], resolve)
    expect(result[0]?.action).toBe("replay")
    expect(resolve).toHaveBeenCalledWith("jobs.search", "2")
  })

  it("keeps replay ambiguity terminal across a second restart", () => {
    const result = classifyToolCallRecovery([{ ...pending, durableResult: { id: "call-1", toolName: "apply.submit", toolVersion: "1", status: "failed", output: null, errorCode: "tool_result_replay_uncertain" } }], () => ({ idempotency: "read_only" }))
    expect(result[0]?.action).toBe("terminal")
  })

  it("requires every canonical coordination tool when the gate is enabled", () => {
    expect(() => assertCanonicalCoordinationSurface({ list: () => [{ name: "agent.spawn" }] }, [])).toThrow("canonical_coordination_tools_unconfigured")
  })

  it("persists distinct lifecycle event and outbox IDs for distinct task owners", async () => {
    const persistence = lifecyclePersistence()
    await durableLifecycleSink(persistence.store, lifecycleOwner("task-a")).append(lifecycleEvent())
    await durableLifecycleSink(persistence.store, lifecycleOwner("task-b")).append(lifecycleEvent())

    const digest = lifecycleDigest()
    const eventIds = [
      `tool-lifecycle:task:task-a:call-shared:started:${digest}`,
      `tool-lifecycle:task:task-b:call-shared:started:${digest}`,
    ]
    expect([...persistence.events.keys()]).toEqual(eventIds)
    expect([...persistence.events.values()].map(row => row.idempotencyKey)).toEqual([
      `task:task-a:tool-lifecycle:call-shared:started:${digest}`,
      `task:task-b:tool-lifecycle:call-shared:started:${digest}`,
    ])
    expect([...persistence.outbox.values()]).toEqual(eventIds.map(id => ({ id: `agent-outbox-${id}`, idempotencyKey: `agent-event:${id}`, eventId: id })))
  })

  it("replays the same owner's lifecycle event with a deterministic ID and one persisted row", async () => {
    const persistence = lifecyclePersistence()
    const sink = durableLifecycleSink(persistence.store, lifecycleOwner("task-a"))
    await sink.append(lifecycleEvent())
    await sink.append(lifecycleEvent())

    const digest = lifecycleDigest()
    const expectedId = `tool-lifecycle:task:task-a:call-shared:started:${digest}`
    expect(persistence.appendEvent.mock.calls.map(([input]) => input.id)).toEqual([expectedId, expectedId])
    expect(persistence.events.size).toBe(1)
    expect(persistence.events.get(expectedId)?.idempotencyKey).toBe(`task:task-a:tool-lifecycle:call-shared:started:${digest}`)
    expect(persistence.outbox.size).toBe(1)
    expect(persistence.outbox.get(`agent-outbox-${expectedId}`)).toEqual({ id: `agent-outbox-${expectedId}`, idempotencyKey: `agent-event:${expectedId}`, eventId: expectedId })
  })
})
