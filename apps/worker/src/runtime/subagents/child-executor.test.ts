import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"

import { createChildExecutor } from "./child-executor.js"
import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import type { SubagentLease } from "./types.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { RuntimeToolDefinition } from "../tools/types.js"
import type { ContextSnapshotAdapter } from "../context/context-snapshot-adapter.js"
import { executionOwnerFence } from "../execution-owner.js"
import { runTurnExecutionLoop } from "../turns/turn-execution-loop.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}

function tool(name: string, domain: RuntimeToolDefinition["domain"]): RuntimeToolDefinition {
  return {
    schemaVersion, name, version: "1", description: name, capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: true }), outputSchema: Type.Object({}, { additionalProperties: true }),
    risk: "read", domain, idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: ["read"], execute: async () => ({ ok: true }),
  }
}

function lease(): SubagentLease {
  return {
    id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
    role: "scout", taskType: "research", status: "running", goal: "Find jobs", constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
    modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, result: null, failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
  }
}

function executionStore(events: Array<{ type: string; taskId: string }>, requests: HarnessModelRequest[]): TurnExecutionStore {
  const revisions = new Map<string, number>()
  return {
    startStep: async ({ identity, stepId, ordinal, attempt }) => { expect(identity.kind).toBe("task"); expect(attempt).toBe(2); return { id: stepId, ordinal } },
    updateStep: async () => undefined,
    createItem: async ({ identity, itemId }) => { revisions.set(`${identity.taskId}:${itemId}`, 0); return { id: itemId, revision: 0 } },
    updateItem: async ({ identity, itemId, expectedRevision }) => { const key = `${identity.taskId}:${itemId}`; expect(revisions.get(key)).toBe(expectedRevision); revisions.set(key, expectedRevision + 1); return { id: itemId, revision: expectedRevision + 1 } },
    appendEvent: async ({ identity, type }) => { events.push({ type, taskId: identity.taskId }); return { id: `event:${events.length}` } },
    recordFinalResponse: async () => undefined,
  }
}

function budgetStore(failConsumed = false): { store: TreeBudgetReservationStore; statuses: string[] } {
  const statuses: string[] = []
  const store: TreeBudgetReservationStore = {
    reserve: vi.fn(async input => ({ id: `res:${input.stepId}`, ...input, units: 1 as const, status: "reserved" as const, createdAt: new Date(), updatedAt: new Date(), settledAt: null })),
    settle: vi.fn(async input => { statuses.push(input.status); if (failConsumed && input.status === "consumed") throw new Error("tree_settlement_unknown"); return { id: input.id, ...input, units: 1 as const, createdAt: new Date(), updatedAt: new Date(), settledAt: new Date() } as TreeBudgetReservation }),
  }
  return { store, statuses }
}

describe("child executor composition", () => {
  it("runs a server-owned context adapter hook before the child model", async () => {
    const child = lease(); const order: string[] = []; const requests: HarnessModelRequest[] = []; let modelCalls = 0
    const hook = vi.fn<ContextSnapshotAdapter["hook"]>(async input => {
      order.push("hook")
      expect(input.identity.taskId).toBe(child.id)
      expect(input.scope.userId).toBe(child.userId)
      return { status: "unchanged" as const, snapshot: input.snapshot }
    })
    const loadSnapshot = vi.fn<ContextSnapshotAdapter["loadSnapshot"]>(async () => null)
    const adapter: ContextSnapshotAdapter = {
      hook, loadSnapshot,
    }
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        requests.push(request); order.push("model"); modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "context-call", name: "jobs.search", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "done" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const executor = createChildExecutor({
      store: executionStore([], requests), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", output: { job: "job-1" }, errorCode: null }) } }),
      contextSnapshotAdapter: adapter,
    })

    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "completed", result: { stepCount: 2 } })
    expect(order).toEqual(["hook", "model", "hook", "model"])
    expect(hook).toHaveBeenCalledTimes(2)
    expect(loadSnapshot).not.toHaveBeenCalled()
  })

  it("fails closed before the child model when the context adapter hook fails", async () => {
    const child = lease(); let modelCalls = 0
    const hook = vi.fn<ContextSnapshotAdapter["hook"]>(() => { throw new Error("sensitive adapter detail") })
    const loadSnapshot = vi.fn<ContextSnapshotAdapter["loadSnapshot"]>(async () => null)
    const adapter: ContextSnapshotAdapter = {
      hook, loadSnapshot,
    }
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream() {
        modelCalls += 1
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
      contextSnapshotAdapter: adapter,
    })

    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "failed", failureReason: "invalid_output" })
    expect(modelCalls).toBe(0)
    expect(JSON.stringify(hook.mock.results)).not.toContain("sensitive adapter detail")
  })

  it("fails closed when a child replay loader rejects before model invocation", async () => {
    const child = lease(); const owner = executionOwnerFence({ kind: "task", lease: child }); const requests: HarnessModelRequest[] = []
    const stepId = `task:${child.id}:step:0:attempt:${child.attemptCount}`
    const snapshot = {
      ...childContextSnapshot(child),
      toolObservations: [{
        id: `context-compacted:${stepId}`,
        content: {
          kind: "context_compacted", status: "compacted", stepId, idempotencyKey: `context-compaction:${stepId}`,
          beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32, snapshotRef: "snapshot-child-1",
        },
      }],
    }
    const hook = vi.fn<ContextSnapshotAdapter["hook"]>()
    const loadSnapshot = vi.fn<ContextSnapshotAdapter["loadSnapshot"]>(async () => { throw new Error("sensitive loader detail") })
    const adapter: ContextSnapshotAdapter = { hook, loadSnapshot }
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream() {
        yield { type: "completed", finishReason: "stop" }
      },
    }

    const result = await runTurnExecutionLoop({
      identity: owner, scope: { userId: child.userId }, goal: child.goal, snapshot,
      contextBuilder: createChildContextBuilder(child), store: executionStore([], requests), model, tools: [], executeTool: async () => { throw new Error("unreachable") },
      signal: child.signal, publishReasoningSummary: false, idFactory: prefix => `${prefix}:attempt:${child.attemptCount}`,
      contextCompaction: adapter.hook, contextCompactionLoadSnapshot: adapter.loadSnapshot,
    })

    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(loadSnapshot).toHaveBeenCalledWith(expect.objectContaining({ snapshotRef: "snapshot-child-1", sessionId: child.sessionId, turnId: child.turnId }))
    expect(hook).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
  })

  it("runs model → tool observation → model under child identity and shared reservation", async () => {
    const child = lease(); const events: Array<{ type: string; taskId: string }> = []; const requests: HarnessModelRequest[] = []; const budget = budgetStore(); let calls = 0
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        requests.push(request); calls += 1
        if (calls === 1) {
          yield { type: "tool_call_completed", callId: "call-1", name: "jobs.search", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "done" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const authorize = vi.fn(async input => ({ settle: vi.fn(async () => undefined), input }))
    const executor = createChildExecutor({
      store: executionStore(events, requests), treeBudget: budget.store, authorizeUsage: authorize,
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs"), tool("spawn_subagent", "coordination")], router: { execute: async (_context, request) => ({ ...request, status: "completed", output: { job: "job-1" }, errorCode: null }) }, validateArguments: () => true }),
    })
    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "completed", result: { stepCount: 2, toolCallCount: 1 } })
    expect(requests).toHaveLength(2)
    expect(requests[0].metadata).toMatchObject({ taskId: child.id, turnId: child.turnId, stepId: expect.any(String) })
    expect(requests[0].metadata.stepId).toContain(":attempt:2")
    expect(requests[0].tools.map(tool => (tool as { name: string }).name)).toEqual(["jobs.search"])
    expect(requests[1].messages).toEqual(expect.arrayContaining([{ role: "tool", content: [{ type: "tool_result", toolUseId: "call-1", content: '{"job":"job-1"}' }] }]))
    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls.every(([input]) => input.executionOwner?.kind === "task" && input.executionOwner.attemptCount === 2)).toBe(true)
    expect(budget.statuses).toEqual(["consumed", "consumed"])
    expect(events.every(event => event.taskId === child.id)).toBe(true)
    expect(events.some(event => event.type === "turn.completed" || event.type === "turn.failed")).toBe(false)
  })

  it("releases before the provider when account admission fails", async () => {
    const budget = budgetStore()
    const model: ModelAdapter = { id: "fixture-model", profile, async *stream() { yield { type: "completed", finishReason: "stop" } } }
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budget.store, authorizeUsage: async () => { throw Object.assign(new Error("account_denied"), { code: "account_denied" }) }, modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
    })
    await expect(executor({ lease: lease() })).resolves.toMatchObject({ status: "failed", failureReason: "account_denied" })
    expect(budget.statuses).toEqual(["released"])
  })

  it("exposes only the private result reader from the coordination domain", async () => {
    const child = { ...lease(), allowedActions: ["tool_results.read", "spawn_subagent", "wait_subagents"] }
    const requests: HarnessModelRequest[] = []
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) { requests.push(request); yield { type: "text_delta", text: "summary" }; yield { type: "completed", finishReason: "stop" } },
    }
    const executor = createChildExecutor({
      store: executionStore([], requests), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("tool_results.read", "coordination"), tool("spawn_subagent", "coordination"), tool("wait_subagents", "coordination")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
    })

    await executor({ lease: child })
    expect(requests[0]?.tools.map(tool => (tool as { name: string }).name)).toEqual(["tool_results.read"])
  })

  it("keeps a reserved tree step when settlement is unknown", async () => {
    const budget = budgetStore(true)
    const model: ModelAdapter = { id: "fixture-model", profile, async *stream() { yield { type: "completed", finishReason: "stop" } } }
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budget.store, authorizeUsage: async () => ({ settle: async () => undefined }), modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
    })
    await expect(executor({ lease: lease() })).resolves.toMatchObject({ status: "failed" })
    expect(budget.statuses).toEqual(["consumed"])
  })
})
