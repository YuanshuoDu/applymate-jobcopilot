import { describe, expect, it, vi } from "vitest"

import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"

function identity(kind: TurnExecutionIdentity["kind"], taskId: string): TurnExecutionIdentity {
  const common = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId, rootTaskId: "root-1", ownerId: "worker-1", leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z") }
  if (kind === "turn") return { ...common, kind, leaseVersion: 1 }
  return { ...common, kind, attemptCount: 1 }
}

function options(owner: TurnExecutionIdentity, events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }>, appendEvents?: TurnExecutionStore["appendEvents"]): TurnExecutionOptions {
  const store: TurnExecutionStore = {
    startStep: async ({ ordinal }) => ({ id: "step-1", ordinal }), updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }),
    updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ id, type, itemId, identity }) => { events.push({ id, type, itemId, identity }); return { id } },
    ...(appendEvents ? { appendEvents } : {}),
  }
  return {
    identity: owner, scope: { userId: "user-1" }, goal: "goal", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    contextBuilder: { build: async () => { throw new Error("not used") } }, store, model: {} as ModelAdapter, tools: [], executeTool: async () => { throw new Error("not used") },
    idFactory: prefix => prefix,
  }
}

describe("TurnExecutionEventWriter", () => {
  it("passes the logical item id to the owner store and preserves causation", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const writer = new TurnExecutionEventWriter(options(identity("turn", "root-1"), events))
    const item = await writer.startItem({ id: "turn:turn-1:item-1", stepId: "turn:turn-1:step-0", type: "agent_message", phase: "commentary", content: { text: "" }, now: new Date() })
    await writer.completeItem(item, { text: "done" }, new Date(), "complete")
    expect(events.map(event => event.itemId)).toEqual([item.id, item.id])
    expect(events[0]?.type).toBe("item.started")
    expect(events[1]?.type).toBe("item.completed")
    expect(events.every(event => event.identity.taskId === "root-1")).toBe(true)
  })

  it("names child turn lifecycle events as task activity", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const writer = new TurnExecutionEventWriter(options(identity("task", "child-1"), events))
    await writer.append("turn.started", "turn-1", null, { goal: "child" } satisfies RepositoryJsonValue, "started")
    expect(events[0]).toMatchObject({ type: "task.started", itemId: null, identity: { taskId: "child-1" } })
    expect(events[0]?.id).toContain("task:child-1:event:started")
  })

  it("persists a plan observation batch before notifying subscribers and chains causation", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const saved: Array<{ id: string; causationId: string | null }> = []
    let committed = false
    let subscriberSawCommit = false
    const appendEvents: NonNullable<TurnExecutionStore["appendEvents"]> = vi.fn(async (inputs: Parameters<NonNullable<TurnExecutionStore["appendEvents"]>>[0]) => {
      saved.push(...inputs.map(input => ({ id: input.id, causationId: input.causationId })))
      committed = true
      return inputs.map(input => ({ id: input.id }))
    })
    const base = options(identity("turn", "root-1"), events, appendEvents)
    const writer = new TurnExecutionEventWriter({ ...base, subscribe: () => { subscriberSawCommit = committed } })
    await expect(writer.appendBatch([
      { type: "plan.observation", correlationId: "plan-1", itemId: null, payload: { marker: "a" }, key: "plan-1:a" },
      { type: "plan.observation", correlationId: "plan-1", itemId: null, payload: { marker: "b" }, key: "plan-1:b" },
    ])).resolves.toEqual(["turn:turn-1:event:plan-1:a", "turn:turn-1:event:plan-1:b"])
    expect(appendEvents).toHaveBeenCalledOnce()
    expect(saved.map(event => event.causationId)).toEqual([null, "turn:turn-1:event:plan-1:a"])
    expect(subscriberSawCommit).toBe(true)
  })

  it("fails closed when the batch seam is absent or returns the wrong cardinality", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const entry = { type: "plan.observation", correlationId: "plan-1", itemId: null, payload: { marker: "a" }, key: "plan-1:a" }
    const missing = new TurnExecutionEventWriter(options(identity("turn", "root-1"), events))
    await expect(missing.appendBatch([entry])).rejects.toThrow("plan_observation_batch_unavailable")
    const mismatched = new TurnExecutionEventWriter(options(identity("turn", "root-1"), events, async () => []))
    await expect(mismatched.appendBatch([entry])).rejects.toThrow("plan_observation_batch_result_mismatch")
  })
})
