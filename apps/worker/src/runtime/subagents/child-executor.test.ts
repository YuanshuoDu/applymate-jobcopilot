import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import { Buffer } from "node:buffer"

import { createChildExecutor } from "./child-executor.js"
import { childContextSnapshot, createChildContextBuilder, type ChildMailboxHydrationInput, type ChildMailboxReader } from "./child-context.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { SubagentLease } from "./types.js"
import type { TreeBudgetReservation, TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { RuntimeToolDefinition } from "../tools/types.js"
import type { ContextSnapshotAdapter } from "../context/context-snapshot-adapter.js"
import { executionOwnerFence } from "../execution-owner.js"
import { runTurnExecutionLoop } from "../turns/turn-execution-loop.js"
import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"

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

function mailboxMessage(child: SubagentLease): CoordinationMailboxMessage {
  return {
    id: "mailbox-child-1", sessionId: child.sessionId, turnId: child.turnId!, fromTaskId: "parent-1", toTaskId: child.id,
    kind: "parent.note", payload: { note: "read-only context" }, idempotencyKey: "mailbox-key-child-1",
    createdAt: new Date("2026-09-09T11:00:00.000Z"), deliveredAt: null, consumedAt: null,
  }
}

type StructuredRole = "scout" | "analyst"

function structuredLease(role: StructuredRole): SubagentLease {
  return {
    ...lease(), role, taskType: `${role}.read`,
    allowedActions: role === "analyst" ? ["jobs.search", "persona.retrieve", "resume.get_base"] : ["jobs.search", "jobs.get"],
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role },
  }
}

function validScoutResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" as const, status: "completed" as const,
    candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/jobs/job-1", evidenceIds: ["evidence-job-1"] }],
    evidence: [{ id: "evidence-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }], summary: "One matching job",
  }
}

function validAnalystResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" as const, status: "completed" as const,
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["evidence-job-1"] }],
    evidence: [{ id: "evidence-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }], summary: "Strong match",
  }
}

function analystReadEvidenceResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" as const, status: "completed" as const,
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["model-job", "model-fact", "model-resume"] }],
    evidence: [
      { id: "model-job", kind: "job" as const, ref: "job-1", source: "model-job-source" },
      { id: "model-fact", kind: "persona" as const, ref: "fact-1", source: "model-persona-source" },
      { id: "model-resume", kind: "resume" as const, ref: "resume-1", source: "model-resume-source" },
    ],
    summary: "Strong match",
  }
}

function finalTextModel(text: string): ModelAdapter {
  let calls = 0
  return {
    id: "fixture-model", profile,
    async *stream() {
      calls += 1
      if (calls === 1) {
        yield { type: "tool_call_completed", callId: "evidence-call", name: "jobs.search", arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
}

function readSequenceModel(text: string, toolNames: readonly string[]): ModelAdapter {
  let calls = 0
  return {
    id: "fixture-model", profile,
    async *stream() {
      calls += 1
      const toolName = toolNames[calls - 1]
      if (toolName) {
        yield { type: "tool_call_completed", callId: `read-call-${calls}`, name: toolName, arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
}

function textOnlyModel(text: string, onRequest?: (request: HarnessModelRequest) => void): ModelAdapter {
  return {
    id: "fixture-model", profile,
    async *stream(request) {
      onRequest?.(request)
      yield { type: "text_delta", text }
      yield { type: "completed", finishReason: "stop" }
    },
  }
}

function restoredRead(id: string, toolName: string, output: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id,
    content: { toolCallId: `call-${id}`, toolName, input: {}, status: "completed", output, errorCode: null, ...overrides },
  }
}

function finalTextExecutor(model: ModelAdapter, outputs: Readonly<Record<string, unknown>> = {}) {
  return createChildExecutor({
    store: executionStore([], []), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
    modelRuntimeFactory: () => model,
    toolRuntimeFactory: () => ({
      definitions: [tool("jobs.search", "jobs"), tool("jobs.get", "jobs"), tool("persona.retrieve", "persona"), tool("resume.get_base", "resume")],
      router: { execute: async (_context, request) => ({
        ...request, status: "completed", output: outputs[request.toolName] ?? { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null,
      }) },
    }),
  })
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
  it("passes durable mailbox hydration into child context construction", async () => {
    const child = lease(); const requests: HarnessModelRequest[] = []; let modelCalls = 0
    const hydrateMessages = vi.fn<(input: ChildMailboxHydrationInput) => Promise<readonly CoordinationMailboxMessage[]>>(async input => {
      expect(input).toEqual({
        userId: child.userId, sessionId: child.sessionId, turnId: child.turnId, rootTaskId: child.rootTaskId, toTaskId: child.id,
        ownerId: child.ownerId, attemptCount: child.attemptCount, stepId: expect.any(String), limit: 20,
      })
      return [mailboxMessage(child)]
    })
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage(child)])
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        requests.push(request); modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "mailbox-context-call", name: "jobs.search", arguments: {} }
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
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null }) } }),
      mailboxReader: { listPendingMessages, hydrateMessages },
    })

    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "completed", mailboxMessageIds: ["mailbox-child-1"] })
    expect(hydrateMessages).toHaveBeenCalledTimes(2)
    expect(listPendingMessages).not.toHaveBeenCalled()
    expect(JSON.stringify(requests[0]?.messages)).toContain("mailbox-child-1")
    expect(JSON.stringify(requests[0]?.messages)).toContain("UNTRUSTED_DATA")
  })

  it("starts a recovered child attempt after durable steps and restores tool observations", async () => {
    const child = lease(); const requests: HarnessModelRequest[] = []; const startedOrdinals: number[] = []
    const resumeLoader = vi.fn(async () => ({
      resume: { nextOrdinal: 3, stepCount: 3, toolCallCount: 1, inputThroughSequence: 8n, consumedInputIds: ["input-1"], usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.2 } },
      observations: [{ id: "child-resume:item-result", content: { toolCallId: "prior-call", toolName: "jobs.search", input: {}, status: "completed", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }],
    }))
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) { requests.push(request); yield { type: "text_delta", text: "recovered" }; yield { type: "completed", finishReason: "stop" } },
    }
    const executor = createChildExecutor({
      store: { ...executionStore([], requests), startStep: async ({ ordinal, stepId }) => { startedOrdinals.push(ordinal); return { id: stepId, ordinal } } },
      treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }), modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
      resumeLoader,
    })

    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "completed", result: { stepCount: 4 } })
    expect(resumeLoader).toHaveBeenCalledWith(child)
    expect(startedOrdinals).toEqual([3])
    expect(JSON.stringify(requests[0]?.messages)).toContain("prior-call")
    expect(JSON.stringify(requests[0]?.messages)).toContain("job-1")
    expect(requests[0]?.metadata).not.toHaveProperty("continuation")
  })

  it("binds restored jobs, persona, and resume evidence before a resumed provider call", async () => {
    const child = structuredLease("analyst"); const requests: HarnessModelRequest[] = []
    const resultText = JSON.stringify(analystReadEvidenceResult())
    const resumeLoader = vi.fn(async () => ({
      resume: { nextOrdinal: 3, stepCount: 3, toolCallCount: 3, inputThroughSequence: 8n, consumedInputIds: ["input-1"], usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.2 } },
      observations: [
        restoredRead("job", "jobs.search", { jobs: [{ id: "job-1", source: "greenhouse" }] }),
        restoredRead("fact", "persona.retrieve", { facts: [{ id: "fact-1", source: "persona.database" }] }),
        restoredRead("resume", "resume.get_base", { resume: { id: "resume-1" } }),
      ],
    }))
    const model = textOnlyModel(resultText, request => requests.push(request))
    const executor = createChildExecutor({
      store: executionStore([], requests), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs"), tool("persona.retrieve", "persona"), tool("resume.get_base", "resume")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
      resumeLoader,
    })

    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "completed", result: { status: "completed", structuredResult: { role: "analyst" } } })
    expect((result.result as { readonly structuredResult: { readonly evidence: readonly unknown[] } }).structuredResult.evidence).toEqual([
      { id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" },
      { id: "read:persona:fact-1", kind: "persona", ref: "fact-1", source: "persona.database" },
      { id: "read:resume:resume-1", kind: "resume", ref: "resume-1", source: "resume.get_base" },
    ])
    expect(requests).toHaveLength(1)
  })

  it("fails closed before the provider when restored evidence is malformed", async () => {
    const child = structuredLease("scout"); const modelRuntimeFactory = vi.fn(() => textOnlyModel("unreachable"))
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }), modelRuntimeFactory,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
      resumeLoader: async () => ({
        resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 1n, consumedInputIds: [], usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } },
        observations: [restoredRead("bad", "jobs.search", { jobs: [] }, { errorCode: undefined })],
      }),
    })

    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "failed", failureReason: "child_resume_evidence_unavailable", retryDisposition: "terminal" })
    expect(modelRuntimeFactory).not.toHaveBeenCalled()
  })

  it("returns a terminal disposition when the recovered attempt cannot be loaded", async () => {
    const child = lease(); const modelRuntimeFactory = vi.fn(() => textOnlyModel("unreachable"))
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }), modelRuntimeFactory,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
      resumeLoader: async () => { throw new Error("resume snapshot is unavailable") },
    })

    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "failed", failureReason: "child_resume_unavailable", retryDisposition: "terminal" })
    expect(modelRuntimeFactory).not.toHaveBeenCalled()
  })

  it("keeps attempt one unchanged and does not invoke the resume loader", async () => {
    const child = { ...lease(), attemptCount: 1 }; const resumeLoader = vi.fn(async () => undefined); const modelRuntimeFactory = vi.fn(() => finalTextModel("completed output"))
    const executor = createChildExecutor({
      store: { ...executionStore([], []), startStep: async ({ ordinal, stepId }) => ({ id: stepId, ordinal }) },
      treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }), modelRuntimeFactory,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }), resumeLoader,
    })

    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "completed" })
    expect(result.retryDisposition).toBeUndefined()
    expect(resumeLoader).not.toHaveBeenCalled()
    expect(modelRuntimeFactory).toHaveBeenCalledOnce()
  })

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

  it("projects a redacted, bounded final response for a completed child", async () => {
    const child = lease()
    const finalText = `Candidate contact: alice@example.com\n${"你".repeat(5_000)}`
    let calls = 0
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield { type: "tool_call_completed", callId: "evidence-call", name: "jobs.search", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: finalText }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({ definitions: [tool("jobs.search", "jobs")], router: { execute: async (_context, request) => ({ ...request, status: "completed", errorCode: null }) } }),
    })

    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "completed", result: { status: "completed", finalItemId: expect.any(String), finalText: expect.any(String) } })
    const projected = (result.result as { readonly finalText?: unknown }).finalText
    expect(typeof projected).toBe("string")
    if (typeof projected !== "string") throw new Error("child final text was not projected")
    expect(projected).toContain("[REDACTED_EMAIL]")
    expect(projected).not.toContain("alice@example.com")
    expect(projected.endsWith("...[TRUNCATED]")).toBe(true)
    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(8 * 1024)
    expect(Buffer.from(projected, "utf8").toString("utf8")).toBe(projected)
    expect(JSON.stringify(result.result)).not.toMatch(/userId|sessionId|turnId|stepId|taskId|parentTaskId|rootTaskId|ownerId|lease|capabilit|budget/i)
  })

  it.each([
    ["scout", validScoutResult],
    ["analyst", validAnalystResult],
  ] as const)("projects a validated structured %s result with bound evidence", async (role, makeResult) => {
    const result = await finalTextExecutor(finalTextModel(JSON.stringify(makeResult())))({ lease: structuredLease(role) })
    expect(result).toMatchObject({ status: "completed", result: { status: "completed", finalText: expect.any(String), structuredResult: expect.any(Object) } })
    const childOutput = result.result as { readonly structuredResult?: unknown }
    expect(childOutput.structuredResult).toMatchObject({
      evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }],
    })
    const projected = childOutput.structuredResult as { readonly candidates?: readonly { readonly evidenceIds: readonly string[] }[]; readonly findings?: readonly { readonly evidenceIds: readonly string[] }[] }
    expect(projected.candidates?.[0]?.evidenceIds ?? projected.findings?.[0]?.evidenceIds).toEqual(["read:job:job-1"])
    expect(JSON.stringify(result.result)).not.toMatch(/userId|sessionId|turnId|stepId|taskId|parentTaskId|rootTaskId|ownerId|lease|capabilit|budget/i)
  })

  it("binds analyst persona and resume evidence to successful read records", async () => {
    const result = await finalTextExecutor(
      readSequenceModel(JSON.stringify(analystReadEvidenceResult()), ["jobs.search", "persona.retrieve", "resume.get_base"]),
      {
        "jobs.search": { jobs: [{ id: "job-1", source: "greenhouse" }] },
        "persona.retrieve": { facts: [{ id: "fact-1", source: "persona.database" }] },
        "resume.get_base": { resume: { id: "resume-1" } },
      },
    )({ lease: structuredLease("analyst") })
    expect(result).toMatchObject({ status: "completed", result: { status: "completed", structuredResult: expect.any(Object) } })
    const projected = (result.result as { readonly structuredResult: { readonly evidence: readonly unknown[]; readonly findings: readonly { readonly evidenceIds: readonly string[] }[] } }).structuredResult
    expect(projected.evidence).toEqual([
      { id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" },
      { id: "read:persona:fact-1", kind: "persona", ref: "fact-1", source: "persona.database" },
      { id: "read:resume:resume-1", kind: "resume", ref: "resume-1", source: "resume.get_base" },
    ])
    expect(projected.findings[0]?.evidenceIds).toEqual(["read:job:job-1", "read:persona:fact-1", "read:resume:resume-1"])
  })

  it.each([
    ["fabricated job", validScoutResult(), ["jobs.search"] as const, {}],
    ["null jobs.get", validScoutResult(), ["jobs.get"] as const, { "jobs.get": { job: null } }],
    ["unknown evidence ref", { ...validScoutResult(), evidence: [...validScoutResult().evidence, { id: "unknown", kind: "persona" as const, ref: "fact-404", source: "model" }] }, ["jobs.search"] as const, {}],
  ] as const)("fails closed for %s without a matching observed record", async (_name, original, toolNames, outputs) => {
    const value = _name === "fabricated job"
      ? { ...original, candidates: [{ ...original.candidates[0], jobId: "job-fake" }], evidence: [{ ...original.evidence[0], ref: "job-fake" }] }
      : original
    const result = await finalTextExecutor(readSequenceModel(JSON.stringify(value), toolNames), outputs)({ lease: structuredLease("scout") })
    expect(result).toMatchObject({ status: "failed", result: { status: "failed" }, failureReason: "invalid_structured_result" })
    expect(result.result).not.toHaveProperty("finalText")
    expect(result.result).not.toHaveProperty("structuredResult")
  })

  it("fails closed when two model evidence entries resolve to one observed record", async () => {
    const value = validScoutResult()
    const result = {
      ...value,
      candidates: [{ ...value.candidates[0], evidenceIds: ["model-one", "model-two"] }],
      evidence: [
        { id: "model-one", kind: "job" as const, ref: "job-1", source: "first" },
        { id: "model-two", kind: "job" as const, ref: "job-1", source: "second" },
      ],
    }
    const output = await finalTextExecutor(finalTextModel(JSON.stringify(result)))({ lease: structuredLease("scout") })
    expect(output).toMatchObject({ status: "failed", result: { status: "failed" }, failureReason: "invalid_structured_result" })
    expect(output.result).not.toHaveProperty("structuredResult")
  })

  it("accepts an empty observed search when the structured result has no claims", async () => {
    const result = await finalTextExecutor(
      finalTextModel(JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "No matches" })),
      { "jobs.search": { jobs: [] } },
    )({ lease: structuredLease("scout") })
    expect(result).toMatchObject({ status: "completed", result: { status: "completed", structuredResult: { candidates: [], evidence: [], summary: "No matches" } } })
  })

  it.each([
    ["invalid JSON", "not-json"],
    ["fenced markdown", `\`\`\`json\n${JSON.stringify(validScoutResult())}\n\`\`\``],
    ["extra runtime key", JSON.stringify({ ...validScoutResult(), userId: "forged-user" })],
    ["missing evidence", JSON.stringify({ ...validScoutResult(), candidates: [{ ...validScoutResult().candidates[0], evidenceIds: [] }] })],
    ["duplicate evidence", JSON.stringify({ ...validScoutResult(), evidence: [validScoutResult().evidence[0], validScoutResult().evidence[0]] })],
    ["cross-role result", JSON.stringify({ ...validScoutResult(), role: "analyst" })],
  ] as const)("fails closed for %s structured output", async (_name, text) => {
    const result = await finalTextExecutor(finalTextModel(text))({ lease: structuredLease("scout") })
    expect(result).toMatchObject({ status: "failed", result: { status: "failed" }, failureReason: "invalid_structured_result" })
    expect(result.result).not.toHaveProperty("finalText")
    expect(result.result).not.toHaveProperty("structuredResult")
  })

  it("fails closed before parsing oversized structured output", async () => {
    const text = JSON.stringify({ ...validScoutResult(), summary: "x".repeat(9_000) })
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(8 * 1024)
    const result = await finalTextExecutor(finalTextModel(text))({ lease: structuredLease("scout") })
    expect(result).toMatchObject({ status: "failed", result: { status: "failed" }, failureReason: "invalid_structured_result" })
    expect(result.result).not.toHaveProperty("finalText")
    expect(result.result).not.toHaveProperty("structuredResult")
  })

  it("keeps a valid-looking final text as generic output without a structured marker", async () => {
    const result = await finalTextExecutor(finalTextModel(JSON.stringify(validScoutResult())))({ lease: lease() })
    expect(result).toMatchObject({ status: "completed", result: { status: "completed", finalText: JSON.stringify(validScoutResult()) } })
    expect(result.result).not.toHaveProperty("structuredResult")
  })

  it("does not project final text while a child is waiting", async () => {
    const child = structuredLease("scout")
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream() {
        yield { type: "tool_call_completed", callId: "wait-call", name: "jobs.search", arguments: {} }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    }
    const executor = createChildExecutor({
      store: executionStore([], []), treeBudget: budgetStore().store, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model,
      toolRuntimeFactory: () => ({
        definitions: [tool("jobs.search", "jobs")],
        router: { execute: async (_context, request) => ({
          ...request, status: "completed", output: { status: "waiting", waitId: "wait-1", deadlineAt: "2026-09-12T12:00:00.000Z", matchedTaskIds: [] }, errorCode: null,
        }) },
      }),
    })

    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "waiting", result: { status: "waiting_for_dependency" } })
    expect(result).not.toHaveProperty("mailboxMessageIds")
    expect(result.result).not.toHaveProperty("finalText")
    expect(result.result).not.toHaveProperty("structuredResult")
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
