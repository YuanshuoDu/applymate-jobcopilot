import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import { describe, expect, it, vi } from "vitest"

import { createOptionalProductionChildExecutor, childExecutionEnabled } from "./production-child-runtime.js"
import type { SubagentLease } from "./types.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import type { PublicToolDefinition } from "../tools/types.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
  continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
  supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
}

function lease(): SubagentLease {
  return {
    id: "child-runtime-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-runtime-1", depth: 1,
    role: "analyst", taskType: "research", status: "running", goal: "Read jobs", constraints: [], successCriteria: [],
    allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {}, modelProfileSnapshot: { provider: "fixture", model: "fixture-model" },
    result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
  }
}

function store(): TurnEngineStore {
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }),
    updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }),
    updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ id }) => ({ id }),
    recordFinalResponse: async () => undefined,
  }
}

function budget(): TreeBudgetReservationStore {
  return {
    reserve: async input => ({ id: `reservation:${input.stepId}`, ...input, units: 1, status: "reserved", createdAt: new Date(), updatedAt: new Date(), settledAt: null }),
    settle: async input => ({ ...input, units: 1, createdAt: new Date(), updatedAt: new Date(), settledAt: new Date() }),
  }
}

function publicTool(name: string): PublicToolDefinition {
  return {
    schemaVersion, name, version: "1", description: name, capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({}, { additionalProperties: true }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [],
  }
}

describe("production child runtime", () => {
  it("keeps child construction behind the explicit flag", () => {
    expect(childExecutionEnabled("0")).toBe(false)
    expect(childExecutionEnabled("1")).toBe(true)
    expect(createOptionalProductionChildExecutor({ enabled: false, pool: undefined as never })).toBeUndefined()
  })

  it("passes the actual child lease and owner fence through the production seam", async () => {
    const child = lease()
    const requests: HarnessModelRequest[] = []
    let modelCalls = 0
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        requests.push(request)
        modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "jobs-call", name: "jobs.search", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "Jobs read" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const toolFactory = vi.fn(({ lease: actualLease, owner }) => {
      expect(actualLease).toBe(child)
      expect(owner).toMatchObject({ kind: "task", taskId: child.id, rootTaskId: child.rootTaskId, attemptCount: child.attemptCount })
      return {
        definitions: [publicTool("jobs.search")],
        router: { execute: async (_context: unknown, request: { id: string; toolName: string; toolVersion: string }) => ({ ...request, status: "completed" as const, errorCode: null }) },
      }
    })
    const executor = createOptionalProductionChildExecutor({
      enabled: true, pool: {} as never, turnStore: store(), treeBudget: budget(),
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model, toolRuntimeFactory: toolFactory,
    })

    if (!executor) throw new Error("child executor was not created")
    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "completed" })
    expect(toolFactory).toHaveBeenCalledOnce()
    expect(requests[0]?.metadata).toMatchObject({ taskId: child.id, turnId: child.turnId })
    expect(requests[0]?.tools.map(tool => (tool as { name: string }).name)).toEqual(["jobs.search"])
  })
})
