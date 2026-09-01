import { describe, expect, it } from "vitest"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"

import { TurnEventWriter } from "./turn-engine-events.js"
import type { TurnEngineOptions, TurnEngineStore } from "./turn-engine-types.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1", userId: "user-1", leaseVersion: 1,
  leaseStartedAt: new Date("2026-09-01T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-01T00:01:00.000Z"),
}

function options(store: TurnEngineStore): TurnEngineOptions {
  return {
    lease, scope: { userId: "user-1" }, goal: "goal", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    contextBuilder: { build: async () => { throw new Error("not used") } }, store,
    model: {} as ModelAdapter, tools: [], executeTool: async () => { throw new Error("not used") },
    idFactory: (() => { let index = 0; return (prefix: string) => `${prefix}:${++index}` })(),
    subscribe: async () => { throw new Error("disconnected subscriber") },
  }
}

function store(): { value: TurnEngineStore; events: Array<{ id: string; causationId: string | null; type: string }>; revisions: number } {
  const events: Array<{ id: string; causationId: string | null; type: string }> = []
  let revisions = 0
  const value: TurnEngineStore = {
    startStep: async () => ({ id: "step-1" }), updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }),
    updateItem: async ({ itemId }) => ({ id: itemId, revision: ++revisions }),
    appendEvent: async ({ id, causationId, type }) => { events.push({ id, causationId, type }); return { id } },
    recordFinalResponse: async () => undefined,
  }
  return { value, events, get revisions() { return revisions } }
}

describe("TurnEventWriter", () => {
  it("persists item lifecycle events with a durable causation chain", async () => {
    const fake = store()
    const writer = new TurnEventWriter(options(fake.value))
    const item = await writer.startItem({ id: "item-1", stepId: "step-1", type: "agent_message", phase: "commentary", content: { text: "" }, now: new Date() })
    await writer.updateItem(item, "streaming", { text: "working" }, new Date(), "delta")
    await writer.completeItem(item, { text: "working" }, new Date(), "complete")
    expect(fake.events.map((event) => event.causationId)).toEqual([null, fake.events[0].id, fake.events[1].id])
    expect(fake.events.map((event) => event.type)).toEqual(["item.started", "item.delta", "item.completed"])
  })

  it("does not let an SSE subscriber failure stop durable persistence", async () => {
    const fake = store()
    const writer = new TurnEventWriter(options(fake.value))
    await expect(writer.append("turn.started", "turn-1", null, { ok: true } satisfies RepositoryJsonValue, "started")).resolves.toBeTypeOf("string")
    expect(fake.events).toHaveLength(1)
  })
})
