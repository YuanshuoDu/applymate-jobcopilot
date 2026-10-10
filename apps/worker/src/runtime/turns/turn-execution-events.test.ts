import { describe, expect, it, vi } from "vitest"
import { Type } from "@sinclair/typebox"

import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { executeToolWithItems, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import { restoreToolCallState } from "./persisted-tool-call-state.js"
import { findToolObservation, stableJson } from "./turn-engine-replay.js"
import { executeTools } from "./turn-execution-tools.js"
import { SessionPauseRequestedError } from "../session-gate.js"
import { createToolRouterExecutor } from "./turn-engine-helpers.js"
import { InMemoryToolLifecycleSink, ToolLifecycle } from "../tools/lifecycle.js"
import { ToolRegistry } from "../tools/registry.js"
import { InMemoryToolResultReferenceStore } from "../tools/redaction.js"
import { ToolRouter } from "../tools/router.js"

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
  it("closes a tool item whose started event is denied by the pause fence without executing it", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const base = options(identity("turn", "root-1"), events)
    const pause = new SessionPauseRequestedError()
    const itemStatuses: string[] = []
    const executeTool = vi.fn()
    const executionOptions: TurnExecutionOptions = {
      ...base,
      executeTool,
      store: {
        ...base.store,
        appendEvent: async input => {
          if (input.type === "tool_call.started") throw pause
          events.push({ id: input.id, type: input.type, itemId: input.itemId, identity: input.identity })
          return { id: input.id }
        },
        updateItem: async ({ itemId, expectedRevision, status }) => {
          itemStatuses.push(status)
          return { id: itemId, revision: expectedRevision + 1 }
        },
      },
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await expect(executeToolWithItems(executionOptions, writer, { id: "step-1", ordinal: 0 }, {
      id: "call-1", name: "agent.spawn", arguments: { idempotencyKey: "spawn-1" },
    }, () => new Date())).rejects.toBe(pause)

    expect(executeTool).not.toHaveBeenCalled()
    expect(events.some(event => event.type === "tool_call.started")).toBe(false)
    expect(itemStatuses).toEqual(["interrupted"])
  })

  it("settles a started tool call before propagating a pause denial from its durable side effect", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const pause = new SessionPauseRequestedError()
    const executionOptions: TurnExecutionOptions = {
      ...options(identity("turn", "root-1"), events),
      executeTool: async () => { throw pause },
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await expect(executeToolWithItems(executionOptions, writer, { id: "step-1", ordinal: 0 }, {
      id: "call-1", name: "agent.spawn", arguments: { idempotencyKey: "spawn-1" },
    }, () => new Date())).rejects.toBe(pause)

    expect(events.map(event => event.type)).toContain("tool_call.started")
    expect(events.map(event => event.type)).toContain("tool_call.failed")
  })

  it("settles Router lifecycle and canonical events before yielding a typed pause", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const pause = new SessionPauseRequestedError()
    const lifecycleSink = new InMemoryToolLifecycleSink()
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "test.pause", version: "1", description: "pause boundary fixture",
      capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs: 100,
      requiredCapabilities: [], execute: async () => { throw pause },
    }])
    const router = new ToolRouter(registry, new ToolLifecycle({ sink: lifecycleSink, references: new InMemoryToolResultReferenceStore() }))
    const executionOptions: TurnExecutionOptions = {
      ...options(identity("turn", "root-1"), events), capabilities: ["read"], executeTool: createToolRouterExecutor(router),
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await expect(executeToolWithItems(executionOptions, writer, { id: "step-1", ordinal: 0 }, {
      id: "pause-call", name: "test.pause", arguments: { query: "fenced" },
    }, () => new Date())).rejects.toBe(pause)

    expect(lifecycleSink.events.map(event => event.phase)).toEqual(["started", "failed"])
    expect(events.map(event => event.type)).toContain("tool_call.started")
    expect(events.map(event => event.type)).toContain("tool_call.failed")
  })

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

  it("preserves completed tool-call input for replay after restoring persisted items", async () => {
    const events: Array<{ id: string; type: string; itemId: string | null; identity: TurnExecutionIdentity }> = []
    const items = new Map<string, { id: string; stepId: string | null; type: string; status: string; revision: number; content: unknown }>()
    const base = options(identity("turn", "root-1"), events)
    const executionOptions: TurnExecutionOptions = {
      ...base,
      store: {
        ...base.store,
        createItem: async ({ itemId, stepId, type, status, content }) => {
          items.set(itemId, { id: itemId, stepId, type, status, revision: 0, content })
          return { id: itemId, revision: 0 }
        },
        updateItem: async ({ itemId, expectedRevision, status, content }) => {
          const current = items.get(itemId)
          if (!current) throw new Error("fixture_item_missing")
          items.set(itemId, { ...current, status, revision: expectedRevision + 1, content })
          return { id: itemId, revision: expectedRevision + 1 }
        },
      },
      executeTool: vi.fn(async ({ call }: Parameters<TurnExecutionOptions["executeTool"]>[0]) => ({
        id: call.id, toolName: call.toolName, toolVersion: call.toolVersion,
        status: "completed" as const, output: { taskId: "task-1" }, errorCode: null,
      })),
    }
    const call = {
      id: "spawn-call-1", name: "agent.spawn", arguments: {
        idempotencyKey: "spawn-operation-1", role: "analyst", taskType: "research",
        goal: "Research the company", context: { source: "fixture" },
      },
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await executeToolWithItems(executionOptions, writer, { id: "step-1", ordinal: 0 }, call, () => new Date("2026-09-25T00:00:00.000Z"))

    const restored = restoreToolCallState([...items.values()], [])
    expect(restored.pending).toEqual([])
    const observation = findToolObservation({ ...executionOptions.snapshot, toolObservations: restored.observations }, call.id)
    expect(observation?.toolName).toBe(call.name)
    expect(stableJson(observation?.input)).toBe(stableJson(call.arguments))
    expect([...items.values()].find(item => item.type === "tool_call")?.content).toMatchObject({ input: call.arguments })

    await expect(executeTools(executionOptions, writer, { id: "step-2", ordinal: 1 }, {
      text: "", reasoningSummary: "", toolCalls: [call], provider: "fixture", model: "fixture",
      finishReason: "tool_calls", usage: null, continuation: null,
    }, { ...executionOptions.snapshot, toolObservations: restored.observations }, new Set(), new AbortController().signal,
    () => new Date("2026-09-25T00:00:00.000Z"), undefined, () => undefined)).resolves.toMatchObject({ wait: null })
    expect(executionOptions.executeTool).toHaveBeenCalledOnce()
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

  it("passes the server-owned system actor through a batch", async () => {
    const events: Array<{ actor?: string; type: string }> = []
    const appendEvents: NonNullable<TurnExecutionStore["appendEvents"]> = vi.fn(async (inputs: Parameters<NonNullable<TurnExecutionStore["appendEvents"]>>[0]) => {
      events.push(...inputs.map(input => ({ actor: input.actor, type: input.type })))
      return inputs.map(input => ({ id: input.id }))
    })
    const writer = new TurnExecutionEventWriter(options(identity("turn", "root-1"), [], appendEvents))
    await writer.appendBatch([
      { type: "goal.revision", correlationId: "goal-call", itemId: null, payload: { revision: 2 }, key: "goal-revision:goal-call" },
      { type: "agent.steering.marker", correlationId: "goal-call", itemId: null, payload: { status: "applied" }, key: "marker-applied:input-1", actor: "system" },
    ])
    expect(events).toEqual([{ type: "goal.revision" }, { type: "agent.steering.marker", actor: "system" }])
  })

  it("rejects a system actor on an ordinary event before persistence", async () => {
    const appendEvents: NonNullable<TurnExecutionStore["appendEvents"]> = vi.fn(async (inputs: Parameters<NonNullable<TurnExecutionStore["appendEvents"]>>[0]) => inputs.map(input => ({ id: input.id })))
    const writer = new TurnExecutionEventWriter(options(identity("turn", "root-1"), [], appendEvents))
    await expect(writer.appendBatch([{ type: "goal.revision", correlationId: "goal-call", itemId: null, payload: { revision: 2 }, key: "goal-revision:goal-call", actor: "system" } as never])).rejects.toThrow("system_actor_requires_steering_marker")
    expect(appendEvents).not.toHaveBeenCalled()
  })

  it("keeps marker event types server exact when lifecycle mapping is configured", async () => {
    const captured: string[] = []
    const appendEvents: NonNullable<TurnExecutionStore["appendEvents"]> = vi.fn(async (inputs: Parameters<NonNullable<TurnExecutionStore["appendEvents"]>>[0]) => {
      captured.push(...inputs.map(input => input.type))
      return inputs.map(input => ({ id: input.id }))
    })
    const writer = new TurnExecutionEventWriter({ ...options(identity("turn", "root-1"), [], appendEvents), lifecycle: { mapEventType: type => `mapped.${type}` } })
    await writer.appendBatch([{ type: "agent.steering.marker", correlationId: "plan-call", itemId: null, payload: {}, key: "marker" }])
    expect(captured).toEqual(["agent.steering.marker"])
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
