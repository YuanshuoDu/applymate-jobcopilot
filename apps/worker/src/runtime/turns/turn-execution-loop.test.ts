import { describe, expect, it, vi } from "vitest"

import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import type { StepContext } from "../context/step-context-builder.js"
import type { ToolCallRequest, ToolRouterContext } from "../tools/types.js"

import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import { fingerprintPlanProposal } from "../planning/plan-fingerprint.js"
import { PLAN_PROPOSAL_SCHEMA_VERSION, type GoalContract, type GoalContractRef, type PlanProposal } from "../planning/goal-plan-contract.js"
import { createGoalUpdateTool } from "../planning/goal-update-tool.js"
import { createPlanProposalTool } from "../planning/plan-proposal-tool.js"
import { createCanonicalPlanExecutionFactory } from "../planning/canonical-plan-execution.js"
import { createPlanRevisionRecoveryDispatcher, planRevisionObservation } from "../planning/plan-revision-receipt.js"
import { PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, PLAN_COMPLETION_FEEDBACK_TEXT } from "../planning/plan-completion-feedback.js"
import type { ToolExecutionContext } from "../tools/types.js"
import type { TurnEngineItem, TurnEngineStore, TurnEngineToolResult } from "./turn-engine-types.js"
import type { TurnExecutionIdentity, TurnExecutionOptions, TurnExecutionStore } from "./turn-execution-types.js"
import { steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { COGNITIVE_AGENDA_EVENT_TYPE } from "./cognitive-agenda-receipt.js"

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
type Fixture = { options: TurnExecutionOptions; events: Array<{ id: string; type: string; itemId: string | null; taskId: string; payload?: unknown; idempotencyKey?: string }>; notifications: string[]; planEvents: unknown[]; items: TurnEngineItem[]; finalResponses: string[]; stepTasks: string[]; stepAttempts: number[]; stepStatuses: string[]; stepInputs: Array<{ inputThroughSequence: bigint; consumedInputIds: string[] }>; requests: HarnessModelRequest[] }

function fixture(owner: TurnExecutionIdentity, toolResult?: TurnEngineToolResult, planHook?: NonNullable<TurnExecutionOptions["executePlan"]>, initialToolObservations: Array<{ id: string; content: unknown }> = [], failPlanObservation = false, completionGate?: NonNullable<TurnExecutionOptions["completionGate"]>, firstTool?: FixtureTool, failGoalRevision = false, goalRef?: GoalContractRef, toolExecutor?: TurnExecutionOptions["executeTool"], firstTools?: readonly FixtureTool[]): Fixture {
  const events: Fixture["events"] = []
  const planEvents: unknown[] = []
  const notifications: string[] = []
  const items: TurnEngineItem[] = []
  const finalResponses: string[] = []
  const stepTasks: string[] = []
  const stepAttempts: number[] = []
  const stepStatuses: string[] = []
  const stepInputs: Fixture["stepInputs"] = []
  const requests: HarnessModelRequest[] = []
  const revisions = new Map<string, number>()
  const store: TurnExecutionStore = {
    startStep: async ({ identity, stepId, attempt, ordinal, inputThroughSequence, consumedInputIds }) => { stepTasks.push(identity.taskId); stepAttempts.push(attempt); stepInputs.push({ inputThroughSequence, consumedInputIds: [...consumedInputIds] }); return { id: stepId, ordinal } },
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
    validateToolArguments: () => true,
    idFactory: prefix => prefix,
    subscribe: event => { notifications.push(event.type); events.push({ id: event.id, type: event.type, itemId: event.itemId, taskId: owner.taskId }) },
    ...(planHook ? { executePlan: planHook } : {}),
    ...(completionGate ? { completionGate } : {}),
  }
  return { options, events, notifications, planEvents, items, finalResponses, stepTasks, stepAttempts, stepStatuses, stepInputs, requests }
}

function addSteeringInput(root: Fixture, alreadyConsumed = false): void {
  const inputId = "steer-1"
  const baseBuilder = root.options.contextBuilder
  const pending: StepContext["blocks"][number] = {
    id: `${inputId}:part:0`, layer: "pending_input", role: "data", trust: "external_untrusted", source: "user_input",
    content: { inputId, partIndex: 0, text: "Change the target to senior roles" },
  }
  root.options = {
    ...root.options,
    ...(alreadyConsumed ? {
      resume: { nextOrdinal: 0, stepCount: 0, toolCallCount: 0, inputThroughSequence: 0n, consumedInputIds: [inputId], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
    } : {}),
    contextBuilder: {
      build: async request => {
        const context = await baseBuilder.build(request)
        return { ...context, consumedInputIds: [...new Set([...context.consumedInputIds, inputId])], blocks: [...context.blocks, pending] }
      },
    },
  }
}

const replanGoal: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }

function replanGoalRef(): GoalContractRef {
  const current = { value: replanGoal }
  return { get: () => current.value, update: next => { current.value = next } }
}

function failedJoinObservations(): Array<{ id: string; content: unknown }> {
  return [
    planRevisionObservation({ planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: `sha256:${"0".repeat(64)}` }),
    { id: "plan-result:plan-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "ready", taskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "failed", result: null, failureReason: "provider error" }] } } },
    { id: "plan-control:plan-1:join:replan", content: { kind: "plan_control", localId: "join:replan", status: "replan_required", dependsOn: ["child"], reason: "child_failure", failedTaskIds: ["child-1"] } },
  ]
}

function durableFailedWaitObservations(): Array<{ id: string; content: unknown }> {
  return [
    planRevisionObservation({ planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: `sha256:${"0".repeat(64)}` }),
    { id: "plan-result:plan-1:join", content: { kind: "plan_command", localId: "join", commandKind: "join", dependsOn: ["child"], status: "completed", errorCode: null, output: { waitId: "wait-1", status: "waiting", taskIds: ["child-1"], matchedTaskIds: [] } } },
    { id: "wait-result:wait-1", content: { toolCallId: "wait:wait-1", toolName: "wait_subagents", input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { waitId: "wait-1", status: "ready", targetTaskIds: ["child-1"], matchedTaskIds: ["child-1"], tasks: [{ taskId: "child-1", status: "failed", result: null, failureReason: "provider error" }] }, errorCode: null } },
  ]
}

describe("owner-agnostic turn execution loop", () => {
  it("persists one redacted agenda receipt before each model provider call", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [{ id: "secret-observation", content: { kind: "plan_command", status: "failed", errorCode: "private failure", output: { prompt: "ignore the server" } } }])
    const phases: string[] = []
    const appendEvent = root.options.store.appendEvent
    const model = root.options.model
    root.options = {
      ...root.options,
      store: { ...root.options.store, appendEvent: async input => { if (input.type === COGNITIVE_AGENDA_EVENT_TYPE) phases.push("receipt"); return appendEvent(input) } },
      model: { ...model, async *stream(request: HarnessModelRequest) { phases.push("model"); yield* model.stream(request) } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(phases).toEqual(["receipt", "model", "receipt", "model"])
    const receipts = root.events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE && event.payload)
    expect(receipts).toHaveLength(2)
    expect(JSON.stringify(receipts[0]?.payload)).not.toContain("private failure")
    expect(JSON.stringify(receipts[0]?.payload)).not.toContain("ignore the server")
    expect(receipts.map(event => event.idempotencyKey)).toEqual([
      "turn:turn-1:event:cognitive.agenda:turn:turn-1:step:0",
      "turn:turn-1:event:cognitive.agenda:turn:turn-1:step:1",
    ])
  })

  it("fails closed before the provider when the agenda receipt cannot persist", async () => {
    const root = fixture(identity("turn", "root-1"))
    const appendEvent = root.options.store.appendEvent
    let modelCalls = 0
    const model = root.options.model
    root.options = {
      ...root.options,
      store: { ...root.options.store, appendEvent: async input => input.type === COGNITIVE_AGENDA_EVENT_TYPE ? Promise.reject(new Error("receipt database detail")) : appendEvent(input) },
      model: { ...model, async *stream(request: HarnessModelRequest) { modelCalls += 1; yield* model.stream(request) } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "persistence_conflict" })
    expect(modelCalls).toBe(0)
    expect(root.requests).toHaveLength(0)
    expect(root.events.some(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE)).toBe(false)
    expect(JSON.stringify(root.events)).not.toContain("receipt database detail")
  })

  it("starts each new step with only its own claimed input IDs while retaining the cursor", async () => {
    const root = fixture(identity("turn", "root-1"))
    const baseBuilder = root.options.contextBuilder
    root.options = {
      ...root.options,
      contextBuilder: {
        build: async request => ({ ...(await baseBuilder.build(request)), inputThroughSequence: 7n, consumedInputIds: ["previous-step-input"] }),
      },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2 })
    expect(root.stepInputs.map(step => step.consumedInputIds)).toEqual([[], []])
    expect(root.stepInputs.map(step => step.inputThroughSequence)).toEqual([0n, 7n])
  })

  it("passes a matching durable marker state through the loop only for its active obligation", async () => {
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
    }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, replanGoalRef())
    const seen: Array<{ readonly active?: readonly SteeringMarkerPayload[] }> = []
    const baseBuilder = root.options.contextBuilder
    const options: TurnExecutionOptions = {
      ...root.options, steeringMarkerState: { active: [marker] }, contextBuilder: {
        build: async request => { seen.push(request.steeringMarkerState ?? {}); return baseBuilder.build(request) },
      },
    }
    await runTurnExecutionLoop(options)
    expect(seen[0]?.active).toEqual([marker])
  })

  it("atomically applies matching markers and retires them before the next step", async () => {
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
    }
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1, nodes: [], completionCriteria: [], briefRationale: "replan" }
    const accepted = { status: "accepted" as const, goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, { name: "agent.plan.propose", arguments: { proposal }, output: accepted }, false, replanGoalRef(), async ({ call }) => ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: accepted, errorCode: null }))
    const seen: Array<readonly SteeringMarkerPayload[]> = []
    const batches: Array<readonly { readonly type: string; readonly actor?: "system" }[]> = []
    const baseBuilder = root.options.contextBuilder
    const appendEvents = root.options.store.appendEvents!
    root.options = {
      ...root.options,
      steeringMarkerState: { active: [marker] },
      contextBuilder: { build: async request => { seen.push(request.steeringMarkerState?.active ?? []); return baseBuilder.build(request) } },
      store: { ...root.options.store, appendEvents: async inputs => { batches.push(inputs); return appendEvents(inputs) } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.events.map(event => event.type)).toContain("agent.steering.marker")
    expect(batches.find(batch => batch.some(entry => entry.type === "agent.steering.marker"))).toEqual([
      expect.objectContaining({ type: "plan.revision" }), expect.objectContaining({ type: "agent.steering.marker", actor: "system" }),
    ])
    expect(seen[0]).toEqual([marker])
    expect(seen[1]).toEqual([])
  })

  it("repairs an accepted replay with the revision and matching applied marker batch", async () => {
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
    }
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1, nodes: [], completionCriteria: [], briefRationale: "replay" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = { id: "tool-result:plan-2", content: { toolCallId: "plan-2", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [...failedJoinObservations(), persisted], false, undefined, { id: "plan-2", name: "agent.plan.propose", arguments: { proposal } }, false, replanGoalRef())
    const batches: Array<readonly { readonly type: string; readonly actor?: "system" }[]> = []
    const appendEvents = root.options.store.appendEvents!
    root.options = { ...root.options, steeringMarkerState: { active: [marker] }, store: { ...root.options.store, appendEvents: async inputs => { batches.push(inputs); return appendEvents(inputs) } } }
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(batches.find(batch => batch.some(entry => entry.type === "agent.steering.marker"))).toEqual([
      expect.objectContaining({ type: "plan.revision" }), expect.objectContaining({ type: "agent.steering.marker", actor: "system" }),
    ])
  })

  it("repairs an already projected replay with an applied-only batch", async () => {
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
    }
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1, nodes: [], completionCriteria: [], briefRationale: "projected replay" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = { id: "tool-result:plan-2", content: { toolCallId: "plan-2", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }
    const projection = planRevisionObservation({ planCallId: "plan-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: output.proposalHash })
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [...failedJoinObservations(), persisted, projection], false, undefined, { id: "plan-2", name: "agent.plan.propose", arguments: { proposal } }, false, replanGoalRef())
    const batches: Array<readonly { readonly type: string; readonly actor?: "system" }[]> = []
    const appendEvents = root.options.store.appendEvents!
    root.options = { ...root.options, steeringMarkerState: { active: [marker] }, store: { ...root.options.store, appendEvents: async inputs => { batches.push(inputs); return appendEvents(inputs) } } }
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(batches.find(batch => batch.some(entry => entry.type === "agent.steering.marker"))).toEqual([
      expect.objectContaining({ type: "agent.steering.marker", actor: "system" }),
    ])
  })

  it("allows exactly one goal update for fresh steering while replanning", async () => {
    const goalContract = { ...replanGoal, revision: 2, objective: "Find senior jobs" }
    const goalReceipt = { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract }
    const goalRef = replanGoalRef()
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } }, output: goalReceipt,
    }, false, goalRef, async ({ call }) => {
      goalRef.update(goalContract)
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: goalReceipt, errorCode: null }
    })
    addSteeringInput(root)
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
    }
    const batches: Array<readonly { readonly type: string; readonly actor?: "system" }[]> = []
    const seen: Array<readonly SteeringMarkerPayload[]> = []
    const baseBuilder = root.options.contextBuilder
    const appendEvents = root.options.store.appendEvents!
    root.options = {
      ...root.options, steeringMarkerState: { active: [marker] },
      contextBuilder: { build: async request => { seen.push(request.steeringMarkerState?.active ?? []); return baseBuilder.build(request) } },
      store: { ...root.options.store, appendEvents: async inputs => { batches.push(inputs); return appendEvents(inputs) } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.planEvents).toHaveLength(0)
    expect(root.events.some(event => event.type === "goal.revision")).toBe(true)
    expect(batches.find(batch => batch.some(entry => entry.type === "agent.steering.marker"))).toEqual([
      expect.objectContaining({ type: "goal.revision" }), expect.objectContaining({ type: "agent.steering.marker", actor: "system" }),
    ])
    expect(seen[0]).toEqual([marker])
    expect(seen[1]).toEqual([])
    expect(root.requests[0]?.messages[0]).toEqual(expect.objectContaining({ role: "system", content: [{ type: "text", text: expect.stringContaining("Fresh authenticated user steering") }] }))
  })

  it("does not treat an already consumed steer as fresh and keeps proposal-only enforcement", async () => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1, nodes: [], completionCriteria: [], briefRationale: "replan" }
    const accepted = { status: "accepted" as const, goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, {
      name: "agent.plan.propose", arguments: { proposal }, output: accepted,
    }, false, replanGoalRef(), async ({ call }) => ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: accepted, errorCode: null }))
    addSteeringInput(root, true)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.requests[0]?.messages[0]).toEqual(expect.objectContaining({ role: "system", content: [{ type: "text", text: expect.stringContaining("A child task failure requires replanning") }] }))
    expect(root.requests[0]?.messages[0]).not.toEqual(expect.objectContaining({ content: [{ type: "text", text: expect.stringContaining("Fresh authenticated user steering") }] }))
  })

  it("rejects fresh steering mixed with a side-effect tool before execution", async () => {
    let executions = 0
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, replanGoalRef(),
      async ({ call }) => { executions += 1; return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: {}, errorCode: null } },
      [{ name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } } }, { name: "jobs.search", arguments: { location: "Dublin" } }])
    addSteeringInput(root)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", toolCallCount: 0 })
    expect(executions).toBe(0)
    expect(root.planEvents).toHaveLength(2)
  })

  it("keeps the obligation active when the fresh goal update fails", async () => {
    const goalRef = replanGoalRef()
    const advancedGoal = { ...replanGoal, revision: 2, objective: "Find senior jobs" }
    const root = fixture(identity("turn", "root-1"), { id: "goal-call", toolName: "agent.goal.update", toolVersion: "1", status: "failed", output: null, errorCode: "goal_update_rejected" }, undefined, failedJoinObservations(), false, undefined, {
      id: "goal-call", name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } },
    }, false, goalRef, async ({ call }) => {
      goalRef.update(advancedGoal)
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "failed" as const, output: null, errorCode: "goal_update_rejected" }
    })
    addSteeringInput(root)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", toolCallCount: 1 })
    expect(root.events.some(event => event.type === "goal.revision")).toBe(false)
    expect(root.planEvents).toHaveLength(2)
    expect(goalRef.get()).toEqual(replanGoal)
  })

  it("blocks an unqualified final while a child failure replan obligation is active", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, replanGoalRef())
    let calls = 0
    root.options = {
      ...root.options,
      model: {
        ...root.options.model,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          calls += 1
          yield { type: "text_delta", text: "forged final" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", stepCount: 3 })
    expect(calls).toBe(3)
    expect(root.planEvents).toHaveLength(2)
    expect(root.planEvents.map(payload => (payload as { observationId: string }).observationId)).toEqual([
      "plan-replan-feedback:turn-1:plan-1:1:1",
      "plan-replan-feedback:turn-1:plan-1:1:2",
    ])
    expect(root.requests[0]?.messages[0]).toMatchObject({ role: "system", content: [{ type: "text", text: expect.stringContaining("SERVER CONTROL") }] })
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
    expect(root.events.filter(event => event.type === "plan.observation").length).toBeGreaterThanOrEqual(2)
  })

  it("recovers a missing replan signal from a durable failed wait", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, durableFailedWaitObservations(), false, undefined, undefined, false, replanGoalRef())
    const result = await runTurnExecutionLoop({
      ...root.options,
      model: {
        ...root.options.model,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          yield { type: "text_delta", text: "forged final" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    })
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", stepCount: 3 })
    expect(root.planEvents.map(payload => (payload as { observationId: string }).observationId)).toEqual([
      "plan-replan-feedback:turn-1:plan-1:1:1",
      "plan-replan-feedback:turn-1:plan-1:1:2",
    ])
  })

  it.each([
    { label: "a proposal mixed with another tool", tools: [{ name: "agent.plan.propose" }, { name: "jobs.search" }] },
    { label: "multiple proposals", tools: [{ name: "agent.plan.propose" }, { name: "agent.plan.propose" }] },
  ])("rejects $label before executing any tool while replanning", async ({ tools }) => {
    const proposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1, nodes: [], completionCriteria: [], briefRationale: "replan" }
    let executions = 0
    const root = fixture(
      identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, replanGoalRef(),
      async ({ call }) => { executions += 1; return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: {}, errorCode: null } },
      tools.map(tool => ({ ...tool, arguments: tool.name === "agent.plan.propose" ? { proposal } : { location: "Dublin" } })),
    )
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", stepCount: 3, toolCallCount: 0 })
    expect(executions).toBe(0)
    expect(root.events.some(event => event.type === "tool_call.started")).toBe(false)
    expect(root.planEvents.map(payload => (payload as { observationId: string }).observationId)).toEqual([
      "plan-replan-feedback:turn-1:plan-1:1:1",
      "plan-replan-feedback:turn-1:plan-1:1:2",
    ])
  })

  it("fails closed when compaction drops an active replan obligation", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, replanGoalRef())
    const hook: NonNullable<TurnExecutionOptions["contextCompaction"]> = request => ({ status: "compacted", snapshot: { ...request.snapshot, toolObservations: [] }, snapshotRef: "snapshot-compact-1" })
    const result = await runTurnExecutionLoop({ ...root.options, contextCompaction: hook })
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(0)
    expect(JSON.stringify(root.events)).toContain("context.compaction")
  })

  it("clears the obligation only after an accepted next revision based on the failed revision", async () => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1, nodes: [], completionCriteria: [], briefRationale: "replan" }
    const accepted = { status: "accepted" as const, goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, replanGoalRef(), async ({ call }) => ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: accepted, errorCode: null }), [{ name: "agent.plan.propose", arguments: { proposal } }])
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.planEvents).toHaveLength(0)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
  })

  it("allows a new goal to proceed past stale failure evidence", async () => {
    const current = { value: { ...replanGoal, revision: 2, objective: "New goal" } }
    const goalRef: GoalContractRef = { get: () => current.value, update: next => { current.value = next } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, undefined, false, goalRef)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.planEvents).toHaveLength(0)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
  })

  it("requires a server-owned completion proposal with completed same-plan dependencies when enabled", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [
      { id: "plan-result:plan:call:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { job: "job-1" } } },
      { id: "plan-control:plan:call:finish", content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["read"], completionCriteria: ["finish"] } },
    ])
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true })
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(result.finalText).toBe("done:root-1")
    expect(root.events.some(event => event.type === "final.rejected")).toBe(false)
  })

  it("keeps a goal 1 completion blocked after a same-turn goal update to revision 2", async () => {
    const nextGoal: GoalContract = { ...replanGoal, revision: 2, objective: "Find senior jobs" }
    const goalReceipt = { status: "accepted" as const, goalRevision: 2, basedOnGoalRevision: 1, goalContract: nextGoal }
    const goalRef = replanGoalRef()
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [
      planRevisionObservation({ planCallId: "old-plan", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null }),
      { id: "plan-result:old-plan:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { job: "job-1" } } },
      { id: "plan-control:old-plan:finish", content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["read"], completionCriteria: ["finish"] } },
    ], false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } }, output: goalReceipt,
    }, false, goalRef, async ({ call }) => {
      goalRef.update(nextGoal)
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: goalReceipt, errorCode: null }
    })
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true, planCompletionRecoveryLimit: 1 })
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", stepCount: 3, toolCallCount: 1 })
    expect(root.events.filter(event => event.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE && event.payload)).toHaveLength(1)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
    expect(goalRef.get().revision).toBe(2)
  })

  it.each([
    { label: "missing proposal", observations: [] },
    { label: "failed dependency", observations: [
      { id: "plan-result:plan:call:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "failed", errorCode: "denied" } },
      { id: "plan-control:plan:call:finish", content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["read"], completionCriteria: ["finish"] } },
    ] },
  ])("rejects a final response for $label under the completion barrier", async ({ observations }) => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, observations)
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true })
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified" })
    expect(result.finalText).toBeUndefined()
    expect(root.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "final.rejected", payload: expect.objectContaining({ code: "final_unverified" }) })]))
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("gives one bounded replan opportunity with fixed feedback in the next model context", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, async ({ call }) => ({
      observations: [{ id: `plan-control:${call.id}:finish`, content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: [], completionCriteria: ["done"] } }],
    }), [{ id: "tool-result:seed", content: { toolCallId: "seed", toolName: "jobs.search", input: {}, status: "completed", output: { job: "job-1" }, errorCode: null } }])
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "replan" }
    const accepted = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    let calls = 0
    const requests: HarnessModelRequest[] = []
    root.options = {
      ...root.options,
      planCompletionRequired: true,
      planCompletionRecoveryLimit: 1,
      model: {
        ...root.options.model,
        profile: { ...root.options.model.profile, continuationCursor: true },
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          requests.push(request)
          calls += 1
          if (calls === 2) {
            yield { type: "tool_call_completed", callId: "replan-call", name: "agent.plan.propose", arguments: { proposal } }
            yield { type: "completed", finishReason: "tool_calls" }
          } else {
            yield { type: "text_delta", text: "done" }
            if (calls === 1) yield { type: "continuation", continuation: { cursor: "stale-final-cursor" } }
            yield { type: "completed", finishReason: "stop" }
          }
        },
      },
      executeTool: async ({ call }) => ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: call.toolName === "agent.plan.propose" ? accepted : { job: "job-1" }, errorCode: null }),
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 3, toolCallCount: 1 })
    expect(JSON.stringify(requests[1]?.messages)).toContain("plan_completion_feedback")
    expect(JSON.stringify(requests[1]?.messages)).toContain(PLAN_COMPLETION_FEEDBACK_TEXT)
    expect(requests[1]?.continuation).toBeUndefined()
    expect(root.events.some(event => event.type === "final.rejected")).toBe(false)
  })

  it("persists completion feedback before advancing to the recovery model step", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, async ({ call }) => ({
      observations: [{ id: `plan-control:${call.id}:finish`, content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["missing"], completionCriteria: ["done"] } }],
    }), [{ id: "tool-result:seed", content: { toolCallId: "seed", toolName: "jobs.search", input: {}, status: "completed", output: { job: "job-1" }, errorCode: null } }])
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true, planCompletionRecoveryLimit: 1 })
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified" })
    const persisted = root.events.filter(event => event.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE && event.payload)
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      payload: {
        observationId: "plan-completion-feedback:turn:turn-1:step:1",
        turnId: "turn-1",
        stepId: "turn:turn-1:step:1",
        attempt: 1,
        status: "blocked",
        blocker: "plan_completion_unverified",
        feedback: PLAN_COMPLETION_FEEDBACK_TEXT,
        planId: "call:root-1",
      },
      idempotencyKey: "turn:turn-1:event:plan-completion-feedback:turn:turn-1:step:1",
    })
    const feedbackIndex = root.events.findIndex(event => event.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE && event.payload)
    const nextStepIndex = root.events.findIndex((event, index) => index > feedbackIndex && event.type === "step.started" && event.payload)
    expect(feedbackIndex).toBeGreaterThanOrEqual(0)
    expect(nextStepIndex).toBeGreaterThan(feedbackIndex)
  })

  it("fails closed when durable completion feedback cannot be appended", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, async ({ call }) => ({
      observations: [{ id: `plan-control:${call.id}:finish`, content: { kind: "plan_control", localId: "finish", status: "completion_proposed", dependsOn: ["missing"], completionCriteria: ["done"] } }],
    }), [{ id: "tool-result:seed", content: { toolCallId: "seed", toolName: "jobs.search", input: {}, status: "completed", output: { job: "job-1" }, errorCode: null } }])
    const appendEvent = root.options.store.appendEvent
    root.options = {
      ...root.options,
      store: {
        ...root.options.store,
        appendEvent: async input => input.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE ? Promise.reject(new Error("database detail")) : appendEvent(input),
      },
    }
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true, planCompletionRecoveryLimit: 1 })
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(2)
    expect(root.events.some(event => event.type === PLAN_COMPLETION_FEEDBACK_EVENT_TYPE)).toBe(false)
    expect(JSON.stringify(root.events)).not.toContain("database detail")
  })

  it("fails closed immediately when the server-owned recovery limit is zero", async () => {
    const root = fixture(identity("turn", "root-1"))
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true, planCompletionRecoveryLimit: 0 })
    expect(result).toMatchObject({ status: "failed", errorCode: "final_unverified", stepCount: 2 })
    expect(result.finalText).toBeUndefined()
    expect(root.requests).toHaveLength(2)
  })

  it.each([-1, 3, 1.5, Number.NaN])("fails closed for an out-of-bound recovery limit (%s)", async limit => {
    const root = fixture(identity("turn", "root-1"))
    const result = await runTurnExecutionLoop({ ...root.options, planCompletionRequired: true, planCompletionRecoveryLimit: limit })
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(0)
  })

  it("feeds a persisted tool observation into the next model step", async () => {
    const root = fixture(identity("turn", "root-1"))
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(result.finalText).toBe("done:root-1")
    expect(root.stepTasks).toEqual(["root-1", "root-1"])
    expect(root.stepAttempts).toEqual([1, 1])
    expect(root.finalResponses).toHaveLength(1)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(root.requests[1]?.messages).toEqual(expect.arrayContaining([
      { role: "assistant", content: [{ type: "tool_use", id: "call:root-1", name: "jobs.search", input: { location: "Dublin" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call:root-1", content: '{"job":"job-1"}' }] },
    ]))
  })

  it("clears a provider continuation after tool feedback enters the next model context", async () => {
    const root = fixture(identity("turn", "root-1"))
    const requests: HarnessModelRequest[] = []
    const baseModel = root.options.model
    let calls = 0
    root.options = {
      ...root.options,
      model: {
        ...baseModel,
        profile: { ...baseModel.profile, continuationCursor: true },
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          requests.push(request)
          calls += 1
          if (calls === 1) {
            yield { type: "tool_call_completed", callId: "call:root-1", name: "jobs.search", arguments: { location: "Dublin" } }
            yield { type: "continuation", continuation: { cursor: "stale-tool-cursor" } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          yield { type: "text_delta", text: "done:root-1" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(requests[1]?.continuation).toBeUndefined()
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([
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
    const goalRef = replanGoalRef()
    const advancedGoal = { ...replanGoal, revision: 2, objective: "Find senior jobs" }
    const invalidOutput = { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1 }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } },
      output: invalidOutput,
    }, false, goalRef, async ({ call }) => {
      goalRef.update(advancedGoal)
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: invalidOutput, errorCode: null }
    })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.some(event => event.type === "goal.revision")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
    expect(goalRef.get()).toEqual(replanGoal)
  })

  it("fails visibly when the goal revision event cannot be appended", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const goalRef = replanGoalRef()
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [], false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } },
      output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract },
    }, true, goalRef, async ({ call }) => {
      goalRef.update(goalContract)
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract }, errorCode: null }
    })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "turn_execution_failed" })
    expect(root.events.some(event => event.type === "goal.revision")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
    expect(goalRef.get()).toEqual(replanGoal)
  })

  it("restores the prior goal when the revision and marker batch fails", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const goalReceipt = { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract }
    const goalRef = replanGoalRef()
    const root = fixture(identity("turn", "root-1"), undefined, undefined, failedJoinObservations(), false, undefined, {
      name: "agent.goal.update", arguments: { changes: { objective: "Find senior jobs" } }, output: goalReceipt,
    }, false, goalRef, async ({ call }) => {
      goalRef.update(goalContract)
      return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: goalReceipt, errorCode: null }
    })
    addSteeringInput(root)
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "plan-replan:plan-1:1", goalRevision: 1, planRevision: 1, acceptedSequence: "2",
    }
    const appendEvents = root.options.store.appendEvents!
    root.options = {
      ...root.options, steeringMarkerState: { active: [marker] },
      store: { ...root.options.store, appendEvents: async inputs => {
        if (inputs.some(input => input.type === "goal.revision")) throw new Error("revision-marker batch failed")
        return appendEvents(inputs)
      } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "turn_execution_failed" })
    expect(goalRef.get()).toEqual(replanGoal)
    expect(root.events.some(event => event.type === "goal.revision" || event.type === "agent.steering.marker")).toBe(false)
  })

  it("does not repeat a goal revision event for a replayed update call", async () => {
    const goalContract = { revision: 2, objective: "Find senior jobs", constraints: ["EU"], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const input = { changes: { objective: "Find senior jobs" } }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.goal.update", input, status: "completed", output: { status: "accepted", goalRevision: 2, basedOnGoalRevision: 1, goalContract }, errorCode: null } }]
    const revisionObservation = { id: "goal-revision:2", content: { kind: "goal_revision", goalRevision: 2, basedOnGoalRevision: 1, goalContract } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [...persisted, revisionObservation], false, undefined, { name: "agent.goal.update", arguments: input, output: persisted[0]!.content.output })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed" })
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
    expect(result.finalText).toBeUndefined()
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
    expect(result.finalText).toBeUndefined()
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
    expect(result.finalText).toBeUndefined()
    expect(child.requests).toHaveLength(1)
    expect(child.stepStatuses).toContain("waiting_for_tool")
  })

  it("projects a canonical question through the atomic store seam", async () => {
    const question = { turnId: "turn-1", questionId: "question:turn-1:plan-1:1:ask", toolCallId: "plan-1", question: "Where?", options: [], planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1 } as const
    const hook: NonNullable<TurnExecutionOptions["executePlan"]> = async () => ({ observations: [], wait: { status: "waiting_for_user", waitId: question.questionId, errorCode: "plan_request_input", question } })
    const root = fixture(identity("turn", "root-1"), undefined, hook)
    const createQuestionWait = vi.fn(async () => ({ itemId: `agent-wait:question:${question.questionId}`, turnRevision: 1 }))
    const waitForUser = vi.fn(async () => undefined)
    root.options = { ...root.options, store: { ...root.options.store, createQuestionWait, waitForUser } as typeof root.options.store }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "waiting_for_user", waitId: question.questionId, question })
    expect(createQuestionWait).toHaveBeenCalledWith(expect.objectContaining({ owner: root.options.identity, stepId: expect.any(String), question }))
    expect(waitForUser).not.toHaveBeenCalled()
  })

  it("fails closed when a stale answer has no matching durable plan revision", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const observations = [
      { id: `question-answer:${questionId}`, content: { kind: "question_answer", questionId, toolCallId: "plan-1", question: "Where?", answer: "Dublin", answerAvailable: true, planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1 } },
      { id: "plan-control:plan-1:ask", content: { kind: "plan_control", localId: "ask", status: "waiting_for_user", question: "Where?" } },
    ]
    const root = fixture(identity("turn", "root-1"), undefined, undefined, observations)
    let executed = 0
    const executeTool = root.options.executeTool
    root.options = { ...root.options, maxSteps: 1, executeTool: async input => { executed += 1; return executeTool(input) } }
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed" })
    expect(executed).toBe(0)
    expect(root.requests).toHaveLength(0)
  })

  it("consumes an answered question after a newer server plan is accepted", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const observations = [
      { id: `question-answer:${questionId}`, content: { kind: "question_answer", questionId, toolCallId: "plan-1", question: "Where?", answer: "Dublin", answerAvailable: true, planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1 } },
      { id: "plan-revision:plan-1", content: { kind: "plan_revision", planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
      { id: "plan-revision:plan-2", content: { kind: "plan_revision", planCallId: "plan-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
    ]
    const root = fixture(identity("turn", "root-1"), undefined, undefined, observations)
    let executed = 0
    const executeTool = root.options.executeTool
    root.options = { ...root.options, maxSteps: 1, executeTool: async input => { executed += 1; return executeTool(input) } }
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed" })
    expect(executed).toBe(1)
    expect(root.requests).toHaveLength(1)
  })

  it("fails closed when a question answer snapshot has the wrong kind", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const observations = [
      { id: `question-answer:${questionId}`, content: { kind: "plan_command", questionId, toolCallId: "plan-1", question: "Where?", answer: "Dublin", answerAvailable: true, planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1 } },
      { id: "plan-control:plan-1:ask", content: { kind: "plan_control", localId: "ask", status: "waiting_for_user", question: "Where?" } },
      { id: "plan-revision:plan-1", content: { kind: "plan_revision", planCallId: "plan-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null } },
    ]
    const root = fixture(identity("turn", "root-1"), undefined, undefined, observations)
    let executed = 0
    const executeTool = root.options.executeTool
    root.options = { ...root.options, maxSteps: 1, executeTool: async input => { executed += 1; return executeTool(input) } }
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(executed).toBe(0)
    expect(root.requests).toHaveLength(0)
  })

  it("fails closed for a current-goal question answer without an active plan", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [
      { id: `question-answer:${questionId}`, content: { kind: "question_answer", questionId, toolCallId: "plan-1", question: "Where?", answer: "Dublin", answerAvailable: true, planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1 } },
    ])
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(0)
  })

  it("ignores an old-goal question answer when no active plan remains", async () => {
    const questionId = "question:turn-1:plan-1:1:ask"
    const goalRef = replanGoalRef()
    goalRef.update({ ...replanGoal, revision: 2 })
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [
      { id: `question-answer:${questionId}`, content: { kind: "question_answer", questionId, toolCallId: "plan-1", question: "Where?", answer: "Dublin", answerAvailable: true, planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1 } },
    ], false, undefined, undefined, false, goalRef)
    let executed = 0
    const executeTool = root.options.executeTool
    root.options = { ...root.options, maxSteps: 1, executeTool: async input => { executed += 1; return executeTool(input) } }
    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "failed" })
    expect(executed).toBe(1)
    expect(root.requests).toHaveLength(1)
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

  it("marks a replayed proposal for the plan hook without replaying side effects", async () => {
    const hook = vi.fn(async ({ replayed }: { readonly replayed: boolean }) => ({ observations: replayed ? [] : [{ id: "should-not-appear", content: "replayed" }] }))
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "fixture" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }]
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const recovered = vi.fn()
    dispatcher.register(recovered)
    const root = fixture(identity("turn", "root-1"), undefined, hook, persisted)
    const result = await runTurnExecutionLoop({ ...root.options, recoveryDispatcher: dispatcher })
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }))
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)).toHaveLength(1)
    expect(recovered).toHaveBeenCalledWith({ goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: output.proposalHash })
  })

  it("does not advance replay recovery before a missing revision is durable", async () => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "fixture" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }]
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const recovered = vi.fn()
    dispatcher.register(recovered)
    const root = fixture(identity("turn", "root-1"), undefined, undefined, persisted, false, undefined, { name: "agent.plan.propose", arguments: { proposal } })
    const appendEvent = root.options.store.appendEvent
    const appendEvents = root.options.store.appendEvents!
    root.options = {
      ...root.options,
      recoveryDispatcher: dispatcher,
      store: { ...root.options.store, appendEvent: async input => {
        if (input.type === "plan.revision") throw new Error("revision append failed")
        return appendEvent(input)
      },
      appendEvents: async inputs => {
        if (inputs.some(input => input.type === "plan.revision")) throw new Error("revision append failed")
        return appendEvents(inputs)
      } },
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "turn_execution_failed" })
    expect(recovered).not.toHaveBeenCalled()
    expect(root.events.some(event => event.type === "plan.revision")).toBe(false)
  })

  it("repairs a replayed plan receipt before the next proposal without replay side effects", async () => {
    const initialGoal: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const current = { value: initialGoal }
    const goalRef: GoalContractRef = { get: () => current.value, update: next => { current.value = next } }
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const replayProposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "replayed" }
    const nextProposal: PlanProposal = {
      schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 1,
      nodes: [{ localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null, toolName: "jobs.search" }],
      completionCriteria: [], briefRationale: "continue",
    }
    const replayOutput = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: replayProposal, intents: [], proposalHash: fingerprintPlanProposal(replayProposal) }
    const persisted = { id: "tool-result:replay-plan", content: { toolCallId: "replay-plan", toolName: "agent.plan.propose", input: { proposal: replayProposal }, status: "completed", output: replayOutput, errorCode: null } }
    const planTool = createPlanProposalTool({ goal: initialGoal, goalRef, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8, recoveryDispatcher: dispatcher })
    const routed = vi.fn(async (_context: unknown, request: { readonly id: string; readonly toolName: string; readonly toolVersion: string; readonly input: unknown }) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null }))
    const bridge = createCanonicalPlanExecutionFactory({
      goal: initialGoal, goalRef, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8,
      capabilities: ["read", "canPlan"], actorRole: "orchestrator", scope: { userId: "user-1" }, lease: { sessionId: "session-1", turnId: "turn-1" },
      rootTaskId: "root-1", taskId: "root-1", router: { execute: routed }, registry: { list: () => [{ name: "jobs.search", version: "1", risk: "read", capabilities: ["read"] }] }, policy: {} as PolicyEngine, recoveryDispatcher: dispatcher,
    })
    const nextOutput: { value?: unknown } = {}
    const root = fixture(
      identity("turn", "root-1"), undefined, bridge, [persisted], false, undefined, undefined, false, goalRef,
      async input => {
        const context: ToolExecutionContext = { scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId, signal: input.signal, capabilities: ["canPlan"], reportProgress: async () => undefined }
        if (input.call.id === "replay-plan") return { ...persisted.content, id: input.call.id, toolName: input.call.toolName, toolVersion: "1" } as TurnEngineToolResult
        const result = await planTool.execute(context, input.call.input as { proposal: PlanProposal })
        nextOutput.value = result
        return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "completed" as const, output: result, errorCode: null }
      },
      [{ id: "replay-plan", name: "agent.plan.propose", arguments: { proposal: replayProposal } }, { id: "next-plan", name: "agent.plan.propose", arguments: { proposal: nextProposal } }],
    )
    const result = await runTurnExecutionLoop({ ...root.options, recoveryDispatcher: dispatcher })
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 2 })
    expect(nextOutput.value).toMatchObject({ planRevision: 2, basedOnPlanRevision: 1 })
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)).toHaveLength(2)
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)[0]?.payload).toMatchObject({ planRevision: 1 })
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)[1]?.payload).toMatchObject({ planRevision: 2 })
    expect(routed).toHaveBeenCalledTimes(1)
  })

  it("replays a partially persisted plan and routes only the missing command", async () => {
    const goal: GoalContract = { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const proposal: PlanProposal = {
      schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null,
      nodes: [
        { localId: "read", kind: "use_tool", objective: "Read jobs", inputRefs: [], dependsOn: [], successCriteria: ["done"], outputSchemaRef: null, toolName: "jobs.search" },
        { localId: "review", kind: "use_tool", objective: "Review jobs", inputRefs: ["read"], dependsOn: ["read"], successCriteria: ["done"], outputSchemaRef: null, toolName: "jobs.search" },
      ], completionCriteria: [], briefRationale: "resume",
    }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = { id: "tool-result:replay-plan", content: { toolCallId: "replay-plan", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }
    const existing = { id: "plan-result:replay-plan:read", content: { kind: "plan_command", localId: "read", commandKind: "tool_call", dependsOn: [], status: "completed", errorCode: null, output: { jobId: "job-1" } } }
    const routed = vi.fn(async (_context: ToolRouterContext, request: ToolCallRequest) => ({ ...request, status: "completed" as const, output: { ok: true }, errorCode: null }))
    const bridge = createCanonicalPlanExecutionFactory({
      goal, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8,
      capabilities: ["read", "canPlan"], actorRole: "orchestrator", scope: { userId: "user-1" }, lease: { sessionId: "session-1", turnId: "turn-1" },
      rootTaskId: "root-1", taskId: "root-1", router: { execute: routed }, registry: { list: () => [{ name: "jobs.search", version: "1", risk: "read", capabilities: ["read"] }] }, policy: {} as PolicyEngine, recoveryDispatcher: dispatcher,
    })
    const root = fixture(identity("turn", "root-1"), undefined, bridge, [persisted, existing], false, undefined, { id: "replay-plan", name: "agent.plan.propose", arguments: { proposal } })
    const result = await runTurnExecutionLoop({ ...root.options, recoveryDispatcher: dispatcher })
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(routed).toHaveBeenCalledTimes(1)
    expect(root.planEvents).toHaveLength(1)
    expect(root.planEvents[0]).toMatchObject({ observationId: "plan-result:replay-plan:review" })
  })

  it("does not duplicate an existing plan revision projection during replay", async () => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "fixture" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }]
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const recovered = vi.fn()
    dispatcher.register(recovered)
    const hook = vi.fn(async ({ replayed }: { readonly replayed: boolean }) => ({ observations: replayed ? [] : [{ id: "unexpected", content: "replayed" }] }))
    const root = fixture(identity("turn", "root-1"), undefined, hook, [...persisted, planRevisionObservation({ planCallId: "call:root-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: output.proposalHash })])
    const result = await runTurnExecutionLoop({ ...root.options, recoveryDispatcher: dispatcher })
    expect(result.status).toBe("completed")
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)).toHaveLength(0)
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ replayed: true }))
    expect(recovered).toHaveBeenCalledTimes(1)
  })

  it("persists a replay revision before a recovery gap is rejected", async () => {
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: 2, nodes: [], completionCriteria: [], briefRationale: "gap" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 3, basedOnPlanRevision: 2, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = { id: "tool-result:gap", content: { toolCallId: "gap", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }
    createPlanProposalTool({ goal: { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" }, allowedTools: ["jobs.search"], allowedTemplates: [], allowedRoles: ["scout"], maxNodes: 8, initialPlanRevision: 1, maxPlanRevisions: 3, recoveryDispatcher: dispatcher })
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [persisted], false, undefined, { id: "gap", name: "agent.plan.propose", arguments: { proposal } })
    const result = await runTurnExecutionLoop({ ...root.options, recoveryDispatcher: dispatcher })
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.some(event => event.type === "plan.revision")).toBe(true)
  })

  it.each([
    { label: "malformed receipt", output: { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: {}, intents: [] } },
    { label: "unknown status", output: { status: "running" } },
  ])("fails closed for a replayed plan $label", async ({ output }) => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "fixture" }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }]
    const root = fixture(identity("turn", "root-1"), undefined, undefined, persisted)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)).toHaveLength(0)
  })

  it("fails closed when a replayed plan receipt belongs to another goal revision", async () => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 2, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "foreign goal" }
    const output = { status: "accepted" as const, goalRevision: 2, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }]
    const current: { value: GoalContract } = { value: { revision: 1, objective: "Find jobs", constraints: [], successCriteria: [], knownFacts: [], unresolvedQuestions: [], approvalBoundaries: [], budgetRef: "runtime:turn" } }
    const goalRef: GoalContractRef = { get: () => current.value, update: next => { current.value = next } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, persisted, false, undefined, { name: "agent.plan.propose", arguments: { proposal }, output }, false, goalRef)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)).toHaveLength(0)
  })

  it("fails closed when replay has duplicate persisted plan results", async () => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "duplicate" }
    const output = { status: "accepted" as const, goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [], proposalHash: fingerprintPlanProposal(proposal) }
    const resultObservation = { id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status: "completed", output, errorCode: null } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [resultObservation, { ...resultObservation, content: { ...resultObservation.content, output: { ...output, proposalHash: `sha256:${"a".repeat(64)}` } } }])
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.events.some(event => event.type === "plan.revision")).toBe(false)
  })

  it.each(["failed", "cancelled"] as const)("continues replay for an already %s plan result", async status => {
    const proposal: PlanProposal = { schemaVersion: PLAN_PROPOSAL_SCHEMA_VERSION, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "failed" }
    const persisted = [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "agent.plan.propose", input: { proposal }, status, output: null, errorCode: "plan_invalid" } }]
    const root = fixture(identity("turn", "root-1"), undefined, undefined, persisted, false, undefined, { name: "agent.plan.propose", arguments: { proposal } })
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "evidence_conflict" })
    expect(root.events.filter(event => event.type === "plan.revision" && event.payload)).toHaveLength(0)
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

  it("runs the optional context compaction hook before the model and persists a bounded projection", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [{ id: "large", content: { text: "x".repeat(1000) } }])
    const hook: NonNullable<TurnExecutionOptions["contextCompaction"]> = async request => request.stepId.endsWith("step:0")
      ? { status: "compacted", snapshot: { ...request.snapshot, toolObservations: [] }, snapshotRef: "snapshot-compact-1" }
      : { status: "unchanged", snapshot: request.snapshot }
    const result = await runTurnExecutionLoop({ ...root.options, contextCompaction: hook })
    expect(result.status).toBe("completed")
    expect(root.events.filter(event => event.type === "context.compaction" && event.payload)).toHaveLength(2)
    expect(root.events.find(event => event.type === "context.compaction" && event.payload)).toMatchObject({ payload: expect.objectContaining({ status: "compacted", snapshotRef: "snapshot-compact-1" }) })
  })

  it("fails the turn closed when context compaction fails before model invocation", async () => {
    const root = fixture(identity("turn", "root-1"))
    const hook: NonNullable<TurnExecutionOptions["contextCompaction"]> = () => { throw new Error("sensitive hook detail") }
    const result = await runTurnExecutionLoop({ ...root.options, contextCompaction: hook })
    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(0)
    expect(root.events.some(event => event.type === "context.compaction" && (event.payload as Record<string, unknown>)?.status === "failed")).toBe(true)
    expect(JSON.stringify(root.events)).not.toContain("sensitive hook detail")
  })

  it("replays a compacted snapshot through the server-owned loader without rerunning the hook", async () => {
    const persisted = { id: "context-compacted:turn:turn-1:step:0", content: {
      kind: "context_compacted", status: "compacted", stepId: "turn:turn-1:step:0", idempotencyKey: "context-compaction:turn:turn-1:step:0",
      beforeInputTokens: 20, afterInputTokens: 8, beforeBytes: 80, afterBytes: 32, snapshotRef: "snapshot-compact-1",
    } }
    const root = fixture(identity("turn", "root-1"), undefined, undefined, [persisted])
    const result = await runTurnExecutionLoop({ ...root.options, contextCompactionLoadSnapshot: async request => ({ snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [{ id: "tool-result:call:root-1", content: { toolCallId: "call:root-1", toolName: "jobs.search", input: { location: "Dublin" }, status: "completed", output: { job: "job-1" }, errorCode: null } }] }, scope: request.scope, sessionId: request.sessionId, turnId: request.turnId }) })
    expect(result.status).toBe("completed")
    expect(JSON.stringify(root.requests[0]?.messages)).toContain("job-1")
    expect(root.events.filter(event => event.type === "context.compaction" && event.payload)).toHaveLength(0)
  })
})
