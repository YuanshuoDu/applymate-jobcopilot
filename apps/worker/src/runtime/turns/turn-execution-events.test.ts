import { describe, expect, it, vi } from "vitest"
import { Type } from "@sinclair/typebox"

import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { executeToolWithItems, persistChildWaitClaimRecovery, persistRecoveredToolCall, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import type { ToolCallRecovery } from "./turn-engine-types.js"
import type { ChildWaitClaimRecovery } from "../subagents/child-durable-wait-replay.js"
import { restoreToolCallState } from "./persisted-tool-call-state.js"
import { findToolObservation, stableJson } from "./turn-engine-replay.js"
import { executeTools } from "./turn-execution-tools.js"
import { SessionPauseRequestedError } from "../session-gate.js"
import { createToolRouterExecutor } from "./turn-engine-helpers.js"
import { InMemoryToolLifecycleSink, ToolLifecycle } from "../tools/lifecycle.js"
import { ToolRegistry } from "../tools/registry.js"
import { InMemoryToolResultReferenceStore } from "../tools/redaction.js"
import { ToolRouter } from "../tools/router.js"

function identity(kind: "turn", taskId: string): Extract<TurnExecutionIdentity, { kind: "turn" }>
function identity(kind: "task", taskId: string): Extract<TurnExecutionIdentity, { kind: "task" }>
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

  it("uses the child wait claim key for the original started event", async () => {
    const owner = identity("task", "child-1")
    const base = options(owner, [])
    const order: string[] = []
    const started = vi.fn(async (input: Parameters<TurnExecutionStore["appendEvent"]>[0]) => {
      if (input.type === "tool_call.started") order.push("started-event-persisted")
      return { id: input.id }
    })
    const executionOptions: TurnExecutionOptions = {
      ...base,
      childWaitCallStartKey: (stepId, call) => stepId === "continuation-step" && call.name === "wait_subagents"
        ? "child-wait-claim:1:continuation-step" : undefined,
      childWaitCallStarted: (stepId, call, eventId) => {
        expect(stepId).toBe("continuation-step")
        expect(call.id).toBe("fresh-wait-call")
        expect(eventId).toBe(started.mock.calls.find(([event]) => event.type === "tool_call.started")?.[0].id)
        order.push("claim-acknowledged")
      },
      executeTool: async ({ call }) => {
        order.push("execute")
        return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: { waitId: "wait-1" }, errorCode: null }
      },
      store: { ...base.store, appendEvent: started },
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await executeToolWithItems(executionOptions, writer, { id: "continuation-step", ordinal: 1 }, {
      id: "fresh-wait-call", name: "wait_subagents", arguments: { idempotencyKey: "key", taskIds: ["leaf"], mode: "all", timeoutMs: 5_000 },
    }, () => new Date("2026-10-29T10:00:00.000Z"))

    expect(started.mock.calls.find(([event]) => event.type === "tool_call.started")?.[0].idempotencyKey)
      .toBe("task:child-1:event:child-wait-claim:1:continuation-step")
    expect(order).toEqual(["started-event-persisted", "claim-acknowledged", "execute"])
  })

  it.each(["wait_subagents", "agent.wait"] as const)("redacts %s target IDs in completion events while retaining private raw item input", async toolName => {
    const owner = identity("task", "child-1")
    const base = options(owner, [])
    const savedItemContent: unknown[] = []
    const appended: Array<{ type: string; payload: unknown }> = []
    const rawTargets = ["+353 87 123 4567", "subagent-123e4567-e89b-42d3-a456-426614174000"]
    const call = {
      id: "wait-call-1", name: toolName, arguments: {
        idempotencyKey: "opaque-wait-key-001", taskIds: rawTargets, mode: "all", timeoutMs: 5_000, goal: "private extra",
      },
    }
    const executionOptions: TurnExecutionOptions = {
      ...base,
      lifecycle: { mapEventType: type => type === "item.completed" ? "mapped.item.completed" : type },
      executeTool: async ({ call: request }) => ({
        id: request.id, toolName: request.toolName, toolVersion: request.toolVersion,
        status: "completed", output: { status: "ready" }, errorCode: null,
      }),
      store: {
        ...base.store,
        createItem: async input => { savedItemContent.push(input.content); return { id: input.itemId, revision: 0 } },
        updateItem: async input => { savedItemContent.push(input.content); return { id: input.itemId, revision: input.expectedRevision + 1 } },
        appendEvent: async input => { appended.push({ type: input.type, payload: input.payload }); return { id: input.id } },
      },
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await executeToolWithItems(executionOptions, writer, { id: "step-1", ordinal: 0 }, call, () => new Date())

    const privateCall = savedItemContent.find(value => !!value && typeof value === "object" && "toolCallId" in value && (value as { toolCallId?: unknown }).toolCallId === call.id)
    expect(privateCall).toMatchObject({ input: call.arguments })
    const completion = appended.find(entry => entry.type === "mapped.item.completed" && JSON.stringify(entry.payload).includes(`"toolName":"${toolName}"`))
    expect(completion?.payload).toMatchObject({ content: { input: {
      idempotencyKey: "[REDACTED]", taskIds: ["[REDACTED]", "[REDACTED]"], mode: "all", timeoutMs: 5_000,
    } } })
    expect(JSON.stringify(completion?.payload)).not.toContain("opaque-wait-key-001")
    expect(JSON.stringify(completion?.payload)).not.toContain("subagent-123e4567-e89b-42d3-a456-426614174000")
    expect(completion?.payload).not.toHaveProperty("content.input.goal")
  })

  it.each(["wait_subagents", "agent.wait"] as const)("projects failed %s calls from the schema allowlist", async toolName => {
    const base = options(identity("turn", "root-1"), [])
    const appended: Array<{ type: string; payload: unknown }> = []
    const rawInput = { idempotencyKey: "opaque-error-key", taskIds: ["leaf-1"], mode: "sometimes", timeoutMs: "unknown", extra: "private" }
    const executionOptions: TurnExecutionOptions = {
      ...base,
      executeTool: async ({ call }) => ({
        id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "failed", errorCode: "wait_invalid",
      }),
      store: {
        ...base.store,
        appendEvent: async input => { appended.push({ type: input.type, payload: input.payload }); return { id: input.id } },
      },
    }

    await executeToolWithItems(executionOptions, new TurnExecutionEventWriter(executionOptions), { id: "step-1", ordinal: 0 }, {
      id: "failed-wait-call", name: toolName, arguments: rawInput,
    }, () => new Date())

    const completion = appended.find(entry => entry.type === "item.completed" && JSON.stringify(entry.payload).includes(`"toolName":"${toolName}"`))
    expect(completion?.payload).toMatchObject({ content: { status: "failed", input: {
      idempotencyKey: "[REDACTED]", taskIds: ["[REDACTED]"],
    } } })
    expect(completion?.payload).not.toHaveProperty("content.input.mode")
    expect(completion?.payload).not.toHaveProperty("content.input.timeoutMs")
    expect(completion?.payload).not.toHaveProperty("content.input.extra")
    expect(JSON.stringify(completion?.payload)).not.toContain("opaque-error-key")
    expect(JSON.stringify(completion?.payload)).not.toContain("private")
  })

  it("does not acknowledge or execute a child wait when its owner-fenced start write fails", async () => {
    const base = options(identity("task", "child-1"), [])
    const denied = new Error("owner_fence_rejected")
    const acknowledge = vi.fn()
    const executeTool = vi.fn()
    const executionOptions: TurnExecutionOptions = {
      ...base,
      childWaitCallStartKey: () => "child-wait-claim:2:continuation-step",
      childWaitCallStarted: acknowledge,
      executeTool,
      store: { ...base.store, appendEvent: async input => {
        if (input.type === "tool_call.started") throw denied
        return { id: input.id }
      } },
    }
    const writer = new TurnExecutionEventWriter(executionOptions)

    await expect(executeToolWithItems(executionOptions, writer, { id: "continuation-step", ordinal: 1 }, {
      id: "fresh-wait-call", name: "wait_subagents", arguments: { idempotencyKey: "key", taskIds: ["leaf"], mode: "all", timeoutMs: 5_000 },
    }, () => new Date())).rejects.toBe(denied)

    expect(acknowledge).not.toHaveBeenCalled()
    expect(executeTool).not.toHaveBeenCalled()
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

  it("projects batched wait completions using the original type before lifecycle mapping", async () => {
    const saved: Array<{ type: string; payload: unknown }> = []
    const appendEvents: NonNullable<TurnExecutionStore["appendEvents"]> = vi.fn(async (inputs: Parameters<NonNullable<TurnExecutionStore["appendEvents"]>>[0]) => {
      saved.push(...inputs.map(input => ({ type: input.type, payload: input.payload })))
      return inputs.map(input => ({ id: input.id }))
    })
    const base = options(identity("turn", "root-1"), [], appendEvents)
    const writer = new TurnExecutionEventWriter({
      ...base, lifecycle: { mapEventType: type => type === "item.completed" ? "mapped.item.completed" : type },
    })

    await writer.appendBatch([{
      type: "item.completed", correlationId: "call-item", itemId: "call-item", key: "wait-completed",
      payload: { itemId: "call-item", status: "completed", content: {
        toolCallId: "wait-call", toolName: "agent.wait", toolVersion: "1", status: "completed", errorCode: null,
        input: { idempotencyKey: "opaque-batch-key", taskIds: ["child-1"], mode: "all", timeoutMs: 5_000, extra: "private" },
      } },
    }])

    expect(saved[0]?.type).toBe("mapped.item.completed")
    expect(saved[0]?.payload).toMatchObject({
      itemId: "call-item", status: "completed", content: { input: {
        idempotencyKey: "[REDACTED]", taskIds: ["[REDACTED]"], mode: "all", timeoutMs: 5_000,
      } },
    })
    expect(JSON.stringify(saved[0]?.payload)).not.toContain("opaque-batch-key")
    expect(JSON.stringify(saved[0]?.payload)).not.toContain("private")
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

describe("persistChildWaitClaimRecovery", () => {
  it("reconciles the claimed call and a pre-existing result item without dispatch", async () => {
    const owner = identity("task", "child-1")
    const base = options(owner, [])
    const writes: Array<{ kind: string; id?: string; itemId?: string | null; type?: string; correlationId?: string | null; causationId?: string | null; payload?: unknown; content?: unknown }> = []
    const options_: TurnExecutionOptions = {
      ...base,
      idFactory: prefix => prefix,
      executeTool: async () => { throw new Error("dispatcher_must_not_run") },
      store: {
        ...base.store,
        createItem: async input => { writes.push({ kind: "createItem", itemId: input.itemId }); return { id: input.itemId, revision: 0 } },
        updateItem: async input => { writes.push({ kind: "updateItem", itemId: input.itemId, content: input.content }); return { id: input.itemId, revision: input.expectedRevision + 1 } },
        appendEvent: async input => {
          writes.push({ kind: "appendEvent", id: input.id, itemId: input.itemId, type: input.type, correlationId: input.correlationId,
            causationId: input.causationId, payload: input.payload })
          return { id: input.id }
        },
      },
    }
    const claim: ChildWaitClaimRecovery = {
      owner: { id: owner.taskId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        rootTaskId: owner.rootTaskId, ownerId: owner.ownerId, attemptCount: owner.attemptCount },
      stepId: "continuation-step", stepOrdinal: 1, stepStatus: "streaming", modelUsage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.0042 },
      sourceWaitCallId: "original-wait-call", sourceInput: { idempotencyKey: "key", taskIds: ["leaf-1"], mode: "all", timeoutMs: 5_000 },
      call: { id: "reissued-wait-call", name: "wait_subagents", arguments: { idempotencyKey: "key", taskIds: ["leaf-1"], mode: "all", timeoutMs: 5_000 } },
      callItem: { id: "call-item", revision: 0, status: "started" }, callStartedEventId: "call-start-event", claimEventId: "claim-event",
      output: { waitId: "wait-1", status: "ready" },
      resultItem: { id: "task:child-1:item:tool-result:reissued-wait-call:attempt:1", revision: 0, status: "started" },
    }
    const writer = new TurnExecutionEventWriter(options_)

    await expect(persistChildWaitClaimRecovery(options_, writer, claim, () => new Date("2026-10-29T10:00:00.000Z"))).resolves.toMatchObject({
      id: claim.call.id, toolName: "wait_subagents", status: "completed", output: claim.output,
    })

    expect(writes.filter(write => write.kind === "createItem")).toEqual([])
    expect(writes.filter(write => write.kind === "updateItem").map(write => write.itemId)).toEqual([
      "call-item", claim.resultItem!.id,
    ])
    const events = writes.filter(write => write.kind === "appendEvent")
    expect(events.map(event => event.type)).toEqual(["item.completed", "tool_call.completed", "item.started", "item.completed"])
    expect(events.map(event => event.causationId)).toEqual([
      "claim-event", events[0]!.id, events[1]!.id, events[2]!.id,
    ])
    expect(events[2]).toMatchObject({ itemId: claim.resultItem!.id, correlationId: claim.stepId, payload: { itemId: claim.resultItem!.id, type: "tool_result" } })
    expect(writes.find(write => write.kind === "updateItem" && write.itemId === "call-item")?.content)
      .toMatchObject({ input: claim.call.arguments })
    expect(events[0]?.payload).toMatchObject({ content: { input: { taskIds: ["[REDACTED]"] } } })
  })

  it("rejects a claim from another owner or attempt before any persistence", async () => {
    const owner = identity("task", "child-1")
    const base = options(owner, [])
    const appendEvent = vi.fn(async ({ id }: { id: string }) => ({ id }))
    const createItem = vi.fn(async ({ itemId }: { itemId: string }) => ({ id: itemId, revision: 0 }))
    const updateItem = vi.fn(async ({ itemId, expectedRevision }: { itemId: string; expectedRevision: number }) => ({ id: itemId, revision: expectedRevision + 1 }))
    const options_: TurnExecutionOptions = { ...base, store: { ...base.store, appendEvent, createItem, updateItem } }
    const claim: ChildWaitClaimRecovery = {
      owner: { id: owner.taskId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        rootTaskId: owner.rootTaskId, ownerId: owner.ownerId, attemptCount: owner.attemptCount },
      stepId: "continuation-step", stepOrdinal: 1, stepStatus: "streaming", modelUsage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      sourceWaitCallId: "original", sourceInput: {},
      call: { id: "reissue", name: "wait_subagents", arguments: {} }, callItem: { id: "call-item", revision: 0, status: "started" },
      callStartedEventId: "start", claimEventId: "claim", output: {},
    }

    const mismatches = [
      { ...claim, owner: { ...claim.owner, ownerId: "worker-old" } },
      { ...claim, owner: { ...claim.owner, attemptCount: claim.owner.attemptCount + 1 } },
    ]
    for (const mismatch of mismatches) {
      await expect(persistChildWaitClaimRecovery(options_, new TurnExecutionEventWriter(options_), mismatch, () => new Date()))
        .rejects.toThrow("child_wait_claim_recovery_owner_mismatch")
    }
    expect(appendEvent).not.toHaveBeenCalled()
    expect(createItem).not.toHaveBeenCalled()
    expect(updateItem).not.toHaveBeenCalled()
  })
})

describe("persistRecoveredToolCall", () => {
  it("projects the recovered agent.wait event while keeping its private call item intact", async () => {
    const base = options(identity("turn", "root-1"), [])
    const updates: Array<{ itemId: string; content: unknown }> = []
    const events: Array<{ type: string; payload: unknown }> = []
    const rawInput = { idempotencyKey: "opaque-wait-key-001", taskIds: ["+353 87 123 4567"], mode: "all", timeoutMs: 5_000, goal: "private extra" }
    const recovery: ToolCallRecovery = {
      action: "reconcile", call: { id: "root-wait-call", name: "agent.wait", arguments: rawInput },
      toolVersion: "1", stepId: "wait-step", callItem: { id: "wait-call-item", revision: 0 },
    }
    const result = { id: recovery.call.id, toolName: recovery.call.name, toolVersion: "1", status: "completed" as const, output: {}, errorCode: null }
    const executionOptions: TurnExecutionOptions = {
      ...base,
      store: {
        ...base.store,
        createItem: async input => ({ id: input.itemId, revision: 0 }),
        updateItem: async input => { updates.push({ itemId: input.itemId, content: input.content }); return { id: input.itemId, revision: input.expectedRevision + 1 } },
        appendEvent: async input => { events.push({ type: input.type, payload: input.payload }); return { id: input.id } },
      },
    }

    await persistRecoveredToolCall(executionOptions, new TurnExecutionEventWriter(executionOptions), recovery, result, () => new Date())

    expect(updates.find(item => item.itemId === recovery.callItem.id)?.content).toMatchObject({ input: rawInput })
    expect(events.find(item => item.type === "item.completed")?.payload).toMatchObject({
      content: { input: { idempotencyKey: "[REDACTED]", taskIds: ["[REDACTED]"] } },
    })
    expect(JSON.stringify(events.find(item => item.type === "item.completed")?.payload)).not.toContain("opaque-wait-key-001")
  })
})
