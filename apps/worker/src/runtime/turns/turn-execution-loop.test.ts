import { describe, expect, it, vi } from "vitest"

import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type { StepContext } from "../context/step-context-builder.js"

import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import type { TurnEngineItem, TurnEngineStore, TurnEngineToolResult } from "./turn-engine-types.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}

function identity(kind: TurnExecutionIdentity["kind"], taskId: string, attemptCount = 1): TurnExecutionIdentity {
  const common = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId, rootTaskId: "root-1", ownerId: "worker-1", leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z") }
  if (kind === "turn") return { ...common, kind, leaseVersion: 1 }
  return { ...common, kind, attemptCount }
}

type Fixture = { options: TurnExecutionOptions; events: Array<{ id: string; type: string; itemId: string | null; taskId: string }>; items: TurnEngineItem[]; finalResponses: string[]; stepTasks: string[]; stepAttempts: number[]; stepStatuses: string[]; requests: HarnessModelRequest[] }

function fixture(owner: TurnExecutionIdentity, toolResult?: TurnEngineToolResult, planHook?: NonNullable<TurnExecutionOptions["executePlan"]>, initialToolObservations: Array<{ id: string; content: unknown }> = []): Fixture {
  const events: Fixture["events"] = []
  const items: TurnEngineItem[] = []
  const finalResponses: string[] = []
  const stepTasks: string[] = []
  const stepAttempts: number[] = []
  const stepStatuses: string[] = []
  const requests: HarnessModelRequest[] = []
  const revisions = new Map<string, number>()
  const store: TurnExecutionStore = {
    startStep: async ({ identity, stepId, attempt, ordinal }) => { stepTasks.push(identity.taskId); stepAttempts.push(attempt); return { id: stepId, ordinal } },
    updateStep: async ({ status }) => { stepStatuses.push(status) },
    createItem: async ({ identity, itemId }) => { const item = { id: itemId, revision: 0 }; items.push(item); revisions.set(`${identity.taskId}:${itemId}`, 0); return item },
    updateItem: async ({ identity, itemId, expectedRevision }) => { const key = `${identity.taskId}:${itemId}`; expect(revisions.get(key)).toBe(expectedRevision); const revision = expectedRevision + 1; revisions.set(key, revision); return { id: itemId, revision } },
    appendEvent: async ({ identity, id, type, itemId }) => { events.push({ id, type, itemId, taskId: identity.taskId }); return { id } },
    recordFinalResponse: async ({ identity, response }) => { finalResponses.push(`${identity.taskId}:${response}`) },
  }
  let calls = 0
  const planInput = { proposal: { schemaVersion: "agent-harness.plan.v1" } }
  const model: ModelAdapter = {
    id: "fixture-model", profile,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      requests.push(request)
      calls += 1
      if (calls === 1) {
        yield { type: "tool_call_completed", callId: `call:${owner.taskId}`, name: planHook ? "agent.plan.propose" : "jobs.search", arguments: planHook ? planInput : { location: "Dublin" } }
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text: `done:${owner.taskId}` }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
  const contextBuilder: TurnExecutionOptions["contextBuilder"] = {
    build: async ({ identity, stepId, snapshot }): Promise<StepContext> => ({
      schemaVersion: "agent-harness.v2", sessionId: identity.sessionId, turnId: identity.turnId, stepId,
      inputThroughSequence: BigInt(snapshot.toolObservations.length + 1), consumedInputIds: [],
      blocks: snapshot.toolObservations.map(observation => ({
        id: `observation:${observation.id}`, layer: "tool_observation", role: "data", trust: "external_untrusted",
        source: "tool_or_subagent", content: observation.content as { readonly job: string },
      })),
      canonicalJson: JSON.stringify(snapshot.toolObservations),
    }),
  }
  const options: TurnExecutionOptions = {
    identity: owner, scope: { userId: "user-1" }, goal: "find jobs", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: initialToolObservations },
    contextBuilder, store, model, tools: [{ name: "jobs.search", version: "1" }], executeTool: async ({ call }) => toolResult ?? ({ id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed", output: { job: "job-1" }, errorCode: null }),
    idFactory: prefix => prefix,
    subscribe: event => { events.push({ id: event.id, type: event.type, itemId: event.itemId, taskId: owner.taskId }) },
    ...(planHook ? { executePlan: planHook } : {}),
  }
  return { options, events, items, finalResponses, stepTasks, stepAttempts, stepStatuses, requests }
}

describe("owner-agnostic turn execution loop", () => {
  it("feeds a persisted tool observation into the next model step", async () => {
    const root = fixture(identity("turn", "root-1"))
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.stepTasks).toEqual(["root-1", "root-1"])
    expect(root.stepAttempts).toEqual([1, 1])
    expect(root.finalResponses).toHaveLength(1)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(root.requests[1]?.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: [{ type: "tool_use", id: "call:root-1", name: "jobs.search", input: { location: "Dublin" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call:root-1", content: '{"job":"job-1"}' }] },
    ]))
  })

  it("runs child work under its own task identity without root final persistence or completion", async () => {
    const child = fixture(identity("task", "child-1", 2))
    const result = await runTurnExecutionLoop(child.options)
    expect(result.status).toBe("completed")
    expect(child.stepTasks).toEqual(["child-1", "child-1"])
    expect(child.stepAttempts).toEqual([2, 2])
    expect(child.events.every(event => event.taskId === "child-1")).toBe(true)
    expect(child.events.some(event => event.type === "task.completed")).toBe(false)
    expect(child.events.some(event => event.type === "turn.completed")).toBe(false)
    expect(child.finalResponses).toHaveLength(0)
    expect(child.items.some(item => item.id.startsWith("task:child-1:"))).toBe(true)
  })

  it("persists a waiting tool result before returning a dependency wait", async () => {
    const child = fixture(identity("task", "child-wait", 2), {
      id: "wait-call", toolName: "wait_subagents", toolVersion: "1", status: "completed",
      output: { waitId: "wait-1", status: "waiting", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: [], taskIds: ["child-a"] }, errorCode: null,
    })
    const result = await runTurnExecutionLoop(child.options)
    expect(result).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-1", stepCount: 1, toolCallCount: 1 })
    expect(child.requests).toHaveLength(1)
    expect(child.stepStatuses).toContain("waiting_for_tool")
    expect(child.events.some(event => event.type === "tool_call.completed")).toBe(true)
    expect(child.events.some(event => event.type === "step.completed")).toBe(true)
    expect(child.events.some(event => event.type === "turn.completed" || event.type === "turn.failed")).toBe(false)
  })

  it.each([
    { label: "ready", output: { waitId: "wait-ready", status: "ready", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: ["child-a"] } },
    { label: "malformed", output: { waitId: "wait-invalid", status: "waiting", deadlineAt: 123, matchedTaskIds: "child-a" } },
  ])("continues to the next model step for $label wait output", async ({ output }) => {
    const root = fixture(identity("turn", "root-1"), { id: "wait-call", toolName: "wait_subagents", toolVersion: "1", status: "completed", output, errorCode: null })
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(root.stepStatuses).toEqual(["completed", "completed"])
  })

  it("passes owner context and completed results to the plan hook, then resumes with its observations", async () => {
    const hook = vi.fn(async (input: NonNullable<TurnExecutionOptions["executePlan"]> extends (input: infer T) => unknown ? T : never) => ({
      observations: [{ id: "plan-observation", content: { marker: "hook-result" } }],
    }))
    const root = fixture(identity("turn", "root-1"), undefined, hook)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({
      identity: expect.objectContaining({ kind: "turn", taskId: "root-1", ownerId: "worker-1" }),
      scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: expect.any(String), signal: expect.any(Object),
      call: expect.objectContaining({ name: "agent.plan.propose" }),
      result: expect.objectContaining({ status: "completed" }), completedToolResults: [expect.objectContaining({ status: "completed" })],
    }))
    expect(JSON.stringify(root.requests[1]?.messages)).toContain("hook-result")
  })

  it("maps an explicit plan wait to the existing turn wait result without another model call", async () => {
    const hook: NonNullable<TurnExecutionOptions["executePlan"]> = async () => ({
      observations: [{ id: "plan-wait-observation", content: "child still running" }],
      wait: { status: "waiting_for_dependency", waitId: "wait-plan-1", errorCode: "child_pending" },
    })
    const child = fixture(identity("task", "child-plan", 2), undefined, hook)
    const result = await runTurnExecutionLoop(child.options)
    expect(result).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-plan-1", stepCount: 1, toolCallCount: 1, errorCode: "child_pending" })
    expect(child.requests).toHaveLength(1)
    expect(child.stepStatuses).toContain("waiting_for_tool")
  })

  it("does not repeat the plan hook for a replayed proposal call", async () => {
    const hook = vi.fn(async () => ({ observations: [{ id: "should-not-appear", content: "replayed" }] }))
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal: { schemaVersion: "agent-harness.plan.v1" } }, status: "completed", output: { job: "job-1" }, errorCode: null } }]
    const root = fixture(identity("turn", "root-1"), undefined, hook, persisted)
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(hook).not.toHaveBeenCalled()
  })

  it.each([
    { label: "duplicate existing id", observations: [{ id: "tool-result:call:root-1", content: "duplicate" }] },
    { label: "duplicate ids", observations: [{ id: "same", content: "one" }, { id: "same", content: "two" }] },
    { label: "too many observations", observations: Array.from({ length: 9 }, (_, index) => ({ id: `observation-${index}`, content: index })) },
    { label: "oversized content", observations: [{ id: "large-content", content: "x".repeat(8 * 1024 + 1) }] },
    { label: "non JSON content", observations: [{ id: "bad-content", content: BigInt(1) }] },
  ])("fails closed for $label from the plan hook", async ({ observations }) => {
    const hook: NonNullable<TurnExecutionOptions["executePlan"]> = async () => ({ observations })
    const root = fixture(identity("turn", "root-1"), undefined, hook)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(1)
  })
})
