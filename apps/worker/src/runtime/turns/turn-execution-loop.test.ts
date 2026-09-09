import { describe, expect, it, vi } from "vitest"

import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { StepContext } from "../context/step-context-builder.js"

import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import { fingerprintPlanProposal } from "../planning/plan-fingerprint.js"
import { PLAN_PROPOSAL_SCHEMA_VERSION, type GoalContract, type GoalContractRef, type PlanProposal } from "../planning/goal-plan-contract.js"
import { createGoalUpdateTool } from "../planning/goal-update-tool.js"
import { createPlanProposalTool } from "../planning/plan-proposal-tool.js"
import { createCanonicalPlanExecutionFactory } from "../planning/canonical-plan-execution.js"
import type { ToolExecutionContext } from "../tools/types.js"
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

type FixtureTool = { readonly id?: string; readonly name: string; readonly arguments: unknown; readonly output?: unknown }
type Fixture = { options: TurnExecutionOptions; events: Array<{ id: string; type: string; itemId: string | null; taskId: string; payload?: unknown; idempotencyKey?: string }>; notifications: string[]; planEvents: unknown[]; items: TurnEngineItem[]; finalResponses: string[]; stepTasks: string[]; stepAttempts: number[]; stepStatuses: string[]; requests: HarnessModelRequest[] }

function fixture(owner: TurnExecutionIdentity, toolResult?: TurnEngineToolResult, planHook?: NonNullable<TurnExecutionOptions["executePlan"]>, initialToolObservations: Array<{ id: string; content: unknown }> = [], failPlanObservation = false, completionGate?: NonNullable<TurnExecutionOptions["completionGate"]>, firstTool?: FixtureTool, failGoalRevision = false, goalRef?: GoalContractRef, toolExecutor?: TurnExecutionOptions["executeTool"], firstTools?: readonly FixtureTool[]): Fixture {
  const events: Fixture["events"] = []
  const planEvents: unknown[] = []
  const notifications: string[] = []
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
    appendEvent: async ({ identity, id, type, itemId, payload, idempotencyKey }) => { if (type === "plan.observation") { if (failPlanObservation) throw new Error("durable_event_failed"); planEvents.push(payload) }; if (type === "goal.revision" && failGoalRevision) throw new Error("durable_event_failed"); events.push({ id, type, itemId, taskId: identity.taskId, payload, idempotencyKey }); return { id } },
    appendEvents: async inputs => { for (const input of inputs) { if (input.type === "plan.observation") { if (failPlanObservation) throw new Error("durable_event_failed"); planEvents.push(input.payload) }; events.push({ id: input.id, type: input.type, itemId: input.itemId, taskId: input.identity.taskId }) }; return inputs.map(input => ({ id: input.id })) },
    recordFinalResponse: async ({ identity, response }) => { finalResponses.push(`${identity.taskId}:${response}`) },
  }
  let calls = 0
  const planProposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "fixture" }
  const planInput = { proposal: planProposal }
  const acceptedPlanOutput = { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: planInput.proposal, intents: [], proposalHash: fingerprintPlanProposal(planInput.proposal) }
  const initialTool = firstTool ?? { name: planHook ? "agent.plan.propose" : "jobs.search", arguments: planHook ? planInput : { location: "Dublin" } }
  const initialTools = firstTools ?? [initialTool]
  const model: ModelAdapter = {
    id: "fixture-model", profile,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      requests.push(request)
      calls += 1
      if (calls === 1) {
        for (const [index, tool] of initialTools.entries()) yield { type: "tool_call_completed", callId: tool.id ?? (index === 0 ? `call:${owner.taskId}` : `call:${owner.taskId}:${index}`), name: tool.name, arguments: tool.arguments }
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
    identity: owner, scope: { userId: "user-1" }, goal: "find jobs", ...(goalRef ? { goalRef } : {}), snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: initialToolObservations },
    contextBuilder, store, model, tools: [{ name: "jobs.search", version: "1" }, ...initialTools.map(tool => ({ name: tool.name, version: "1" }))], executeTool: toolExecutor ?? (async ({ call }) => toolResult ?? ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed", output: call.toolName === "agent.plan.propose" ? acceptedPlanOutput : initialTool.output ?? { job: "job-1" }, errorCode: null })),
    idFactory: prefix => prefix,
    subscribe: event => { notifications.push(event.type); events.push({ id: event.id, type: event.type, itemId: event.itemId, taskId: owner.taskId }) },
    ...(planHook ? { executePlan: planHook } : {}),
    ...(completionGate ? { completionGate } : {}),
  }
  return { options, events, notifications, planEvents, items, finalResponses, stepTasks, stepAttempts, stepStatuses, requests }
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

  it("persists a goal revision before the next model step and updates the bounded snapshot", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } },
      output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract },
    })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.events.find(event => event.type === "goal.revision" && event.payload)).toMatchObject({
      payload: { goalRevision: 2, basedOnGoalRevision: 1, goalContract },
      idempotencyKey: expect.stringContaining("goal-revision:call:root-1"),
    })
    expect(JSON.stringify(root.requests[1]?.messages)).toContain("Find senior jobs")
  })

  it("uses the revised goal for a following plan proposal and execution bridge in one loop", async () => {
    const initialGoal: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const current = { value: initialGoal }
    const goalRef: GoalContractRef = { get: () => current.value, update: next => { current.value = next } }
    const goalTool = createGoalUpdateTool({ goal: initialGoal, goalRef })
    const planTool = createPlanProposalTool({ goal: initialGoal, goalRef, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8 })
    const bridge = createCanonicalPlanExecutionFactory({
      goal: initialGoal, goalRef, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8,
      capabilities: ["read", "canPlan"], actorRole: "orchestrator", scope: { userId: "user-1" }, lease: { sessionId: "session-1", turnId: "turn-1" },
      rootTaskId: "root-1", taskId: "root-1", router: { execute: async () => ({ id: "unused", toolName: "unused", toolVersion: "1", status: "completed" as const, errorCode: null }) },
      registry: { list: () => [] }, policy: {} as PolicyEngine,
    })
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 2, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "Replan after goal update" }
    const root = fixture(
      identity("turn", "root-1"), undefined, bridge, [], false, undefined, undefined, false, goalRef,
      async input => {
        const context: ToolExecutionContext = { scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, signal: input.signal, capabilities: ["canPlan"], reportProgress: async () => undefined }
        if (input.call.toolName === "agent.goal.update") return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "completed" as const, output: await goalTool.execute(context, input.call.input as { changes: { objective: string } }), errorCode: null }
        if (input.call.toolName === "agent.plan.propose") return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "completed" as const, output: await planTool.execute(context, input.call.input as { proposal: PlanProposal }), errorCode: null }
        return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "failed" as const, errorCode: "unexpected_tool" }
      },
      [
        { id: "goal-call", name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } } },
        { id: "plan-call", name: "agent.plan.propose", arguments: { proposal } },
      ],
    )
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 2 })
    expect(current.value).toMatchObject({ revision: 2, objective: "Find senior jobs" })
    expect(root.events.some(event => event.type === "goal.revision")).toBe(true)
    expect(root.events.some(event => event.type === "plan.revision")).toBe(true)
    expect(root.finalResponses[0]).toContain("Find senior jobs")
  })

  it("fails visibly when a goal update output or revision append is invalid", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } },
      output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1 },
    })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.some(event => event.type === "goal.revision")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("fails visibly when the goal revision event cannot be appended", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } },
      output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract },
    }, true)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "turn_execution_failed" })
    expect(root.events.some(event => event.type === "goal.revision")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("does not repeat a goal revision event for a replayed update call", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const input = { changes: { objective: "Find senior jobs" } }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.goal.update", input, status: "completed", output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract }, errorCode: null } }]
    const revisionObservation = { id: "goal-revision:2", content: { kind: "goal_revision", goalRevision: 2, basedOnGoalRevision: 1, goalContract } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [...persisted, revisionObservation], false, undefined, { name: "agent.goal.update", arguments: input, output: persisted[0]!.content.output })
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.events.some(event => event.type === "goal.revision")).toBe(false)
  })

  it("repairs a missing goal revision for a replayed accepted update", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const input = { changes: { objective: "Find senior jobs" } }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.goal.update", input, status: "completed", output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract }, errorCode: null } }]
    const root = fixture(identity("turn", "root-1"), undefined, undefined, persisted, false, undefined, { name: "agent.goal.update", arguments: input, output: persisted[0]!.content.output })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.events.filter(event => event.type === "goal.revision" && event.payload)).toHaveLength(1)
    expect(root.events.find(event => event.type === "goal.revision" && event.payload)).toMatchObject({
      payload: { goalRevision: 2, basedOnGoalRevision: 1, goalContract },
      idempotencyKey: expect.stringContaining("goal-revision:call:root-1"),
    })
    expect(JSON.stringify(root.requests[1]?.messages)).toContain("Find senior jobs")
  })

  it("runs the completion gate before final persistence and blocks an unfinished child tree", async () => {
    const gate = vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child work is still running" }))
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, gate)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "business_precondition_failed" })
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", stepId: expect.any(String), signal: expect.any(Object) }))
    expect(root.events.some(event => event.type === "final.rejected")).toBe(true)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("fails closed when the completion gate throws", async () => {
    const gate = vi.fn(async () => { throw new Error("database unavailable") })
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, gate)
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
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

  it("persists validated plan observations as durable events", async () => {
    const hook: NonNullable<TurnExecutionOptions["executePlan"]> = async () => ({ observations: [{ id: "plan-observation", content: { marker: "durable" } }] })
    const root = fixture(identity("turn", "root-1"), undefined, hook)
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "completed" })
    expect(root.planEvents).toEqual([{ planCallId: "call:root-1", observationId: "plan-observation", content: { marker: "durable" } }])
    expect(root.events.some(event => event.type === "plan.revision")).toBe(true)
  })

  it("fails the turn when a plan observation cannot be persisted", async () => {
    const hook: NonNullable<TurnExecutionOptions["executePlan"]> = async () => ({ observations: [{ id: "unpersisted", content: { marker: "must-fail" } }] })
    const root = fixture(identity("turn", "root-1"), undefined, hook, [], true)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "turn_execution_failed" })
    expect(root.requests).toHaveLength(1)
    expect(root.planEvents).toEqual([])
    expect(root.events.some(event => event.type === "plan.observation")).toBe(false)
    expect(root.notifications.some(type => type === "plan.observation")).toBe(false)
  })

  it("does not repeat the plan hook for a replayed proposal call", async () => {
    const hook = vi.fn(async () => ({ observations: [{ id: "should-not-appear", content: "replayed" }] }))
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal: { schemaVersion: "agent-harness.plan.v1", basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "fixture" } }, status: "completed", output: { job: "job-1" }, errorCode: null } }]
    const root = fixture(identity("turn", "root-1"), undefined, hook, persisted)
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(hook).not.toHaveBeenCalled()
    expect(root.events.some(event => event.type === "plan.revision")).toBe(false)
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
