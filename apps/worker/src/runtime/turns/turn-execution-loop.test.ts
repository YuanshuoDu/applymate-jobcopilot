import { describe, expect, it, vi } from "vitest"

import type { TenantScope } from "@jobcopilot/agent-protocol"
import { AgentModelError, type HarnessModelRequest, type ModelAdapter, type ModelStreamEvent } from "@jobcopilot/agent-model"
import type { PolicyEngine } from "@jobcopilot/agent-policy"
import { StepContextBuilder, type StepContext } from "../context/step-context-builder.js"
import type { InputClaimStore, InputClaimTransaction, StepCheckpoint, StoredAgentInput } from "../context/input-claim-store.js"
import { mergeTaskGraphCurrentObservation } from "../canonical-turn-task-graph-context.js"
import { runTurnExecutionLoop } from "./turn-execution-loop.js"
import { createHarnessModelRuntime } from "../harness-model.js"
import type { TurnEngineEvent, TurnEngineItem, TurnEngineStore, TurnEngineToolResult } from "./turn-engine-types.js"
import { NATIVE_SEMANTIC_NO_PROGRESS, RESET_NATIVE_SEMANTIC_PROGRESS, type TurnExecutionIdentity, type TurnExecutionOptions, type TurnExecutionStore } from "./turn-execution-types.js"
import { steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { COGNITIVE_AGENDA_EVENT_TYPE } from "./cognitive-agenda-receipt.js"
import { BudgetExceededError } from "../budget.js"
import { SessionPauseRequestedError } from "../session-gate.js"
import { ToolExecutionError, type ToolExecutionContext } from "../tools/types.js"
import { createTaskGraphPlanningTool } from "../tools/planning-executors.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphScheduleReceipt } from "../subagents/task-graph-command-port.js"
import { createUsageAwareModelAdapter } from "./usage-aware-model.js"
import type { HarnessRequestAdmissionDiagnostic } from "../harness-model-admission.js"
import type { WorkerUsageAuthorization, WorkerUsageAuthorizationInput, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}
const lateSteerText = "Prioritize senior engineering roles in Dublin."

function identity(kind: TurnExecutionIdentity["kind"], taskId: string, attemptCount = 1): TurnExecutionIdentity {
  const common = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId, rootTaskId: "root-1", ownerId: "worker-1", leaseExpiresAt: new Date("2026-09-08T03:00:00.000Z") }
  if (kind === "turn") return { ...common, kind, leaseVersion: 1 }
  return { ...common, kind, attemptCount }
}

type Fixture = { options: TurnExecutionOptions; events: Array<{ id: string; type: string; itemId: string | null; taskId: string; payload?: unknown; idempotencyKey?: string }>; notifications: string[]; items: TurnEngineItem[]; finalResponses: string[]; stepTasks: string[]; stepAttempts: number[]; stepStatuses: string[]; stepInputs: Array<{ inputThroughSequence: bigint; consumedInputIds: string[] }>; requests: HarnessModelRequest[] }

function fixture(owner: TurnExecutionIdentity, toolResult?: TurnEngineToolResult, initialToolObservations: Array<{ id: string; content: unknown }> = [], completionGate?: NonNullable<TurnExecutionOptions["completionGate"]>): Fixture {
  const events: Fixture["events"] = []
  const notifications: string[] = []
  const items: TurnEngineItem[] = []
  const finalResponses: string[] = []
  const stepTasks: string[] = []
  const stepAttempts: number[] = []
  const stepStatuses: string[] = []
  const stepInputs: Fixture["stepInputs"] = []
  const requests: HarnessModelRequest[] = []
  const store: TurnExecutionStore = {
    startStep: async ({ identity, stepId, attempt, ordinal, inputThroughSequence, consumedInputIds }) => { stepTasks.push(identity.taskId); stepAttempts.push(attempt); stepInputs.push({ inputThroughSequence, consumedInputIds: [...consumedInputIds] }); return { id: stepId, ordinal } },
    updateStep: async ({ status }) => { stepStatuses.push(status) },
    createItem: async ({ itemId }) => { const item = { id: itemId, revision: 0 }; items.push(item); return item },
    updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ identity, id, type, itemId, payload, idempotencyKey }) => { events.push({ id, type, itemId, taskId: identity.taskId, payload, idempotencyKey }); return { id } },
    appendEvents: async inputs => { for (const input of inputs) events.push({ id: input.id, type: input.type, itemId: input.itemId, taskId: input.identity.taskId }); return inputs.map(input => ({ id: input.id })) },
    recordFinalResponse: async ({ identity, response, terminal }) => {
      finalResponses.push(`${identity.taskId}:${response}`)
      if (!terminal) return
      items.push({ id: terminal.finalItemId, revision: 1 })
      const saved: TurnEngineEvent[] = [
        { id: "final-started", type: "item.started", itemId: terminal.finalItemId, correlationId: terminal.stepId, causationId: "step-completed", payload: { itemId: terminal.finalItemId, type: "agent_message", phase: "final_answer" } },
        { id: "final-completed", type: "item.completed", itemId: terminal.finalItemId, correlationId: terminal.finalItemId, causationId: "final-started", payload: { itemId: terminal.finalItemId, status: "completed", content: terminal.finalContent } },
        { id: "turn-completed", type: "turn.completed", itemId: terminal.finalItemId, correlationId: terminal.stepId, causationId: "final-completed", payload: { turnId: identity.turnId, taskId: identity.taskId, finalItemId: terminal.finalItemId, usage: terminal.usage } },
      ]
      return { status: "completed", finalItemId: terminal.finalItemId, events: saved }
    },
  }
  let calls = 0
  const model: ModelAdapter = {
    id: "fixture-model", profile,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      requests.push(request)
      calls += 1
      if (calls === 1) {
        yield { type: "tool_call_completed", callId: `call:${owner.taskId}`, name: "jobs.search", arguments: { location: "Dublin" } }
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
    contextBuilder, store, model, tools: [{ name: "jobs.search", version: "1" }], executeTool: async ({ call }) => toolResult ?? ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed", output: { job: "job-1" }, errorCode: null }),
    validateToolArguments: () => true,
    idFactory: prefix => prefix,
    subscribe: event => { notifications.push(event.type); events.push({ id: event.id, type: event.type, itemId: event.itemId, taskId: owner.taskId }) },
    ...(completionGate ? { completionGate } : {}),
  }
  return { options, events, notifications, items, finalResponses, stepTasks, stepAttempts, stepStatuses, stepInputs, requests }
}

function replaceHarnessRoute(
  runtime: ReturnType<typeof createHarnessModelRuntime>,
  provider: string,
  model: string,
  maxContextTokens: number,
  stream: ModelAdapter["stream"],
): void {
  const existing = runtime.registry.list().find(adapter => adapter.profile.provider === provider && adapter.profile.model === model)
  if (!existing) throw new Error(`Missing fixture route ${provider}/${model}`)
  runtime.registry.unregister(existing.id)
  runtime.registry.register({
    id: existing.id,
    profile: { ...existing.profile, maxContextTokens, maxOutputTokens: 4_096, defaultMaxOutputTokens: 256 },
    stream,
  })
}

class LateSteerInputClaimStore implements InputClaimStore {
  readonly scope: TenantScope = { userId: "user-1" }
  readonly inputs: StoredAgentInput[] = []
  private readonly checkpoints = new Map<string, StepCheckpoint>()

  startStep(stepId: string, inputThroughSequence: bigint, consumedInputIds: readonly string[]): void {
    this.checkpoints.set(stepId, { inputThroughSequence, consumedInputIds: [...consumedInputIds] })
  }

  acceptSteer(): void {
    this.inputs.push({
      id: "steer-539", sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: "client-steer-539",
      delivery: "steer", status: "accepted", content: [{ type: "text", text: lateSteerText }],
      acceptedSequence: 1n, consumedByStepId: null, consumedAt: null, createdAt: new Date("2026-10-02T12:00:00.000Z"),
    })
  }

  async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
    return work({
      getCheckpoint: async ({ stepId }) => {
        const checkpoint = this.checkpoints.get(stepId)
        if (!checkpoint) throw new Error(`missing step checkpoint: ${stepId}`)
        return { inputThroughSequence: checkpoint.inputThroughSequence, consumedInputIds: [...checkpoint.consumedInputIds] }
      },
      claimInputs: async request => {
        const candidates = this.inputs.filter(input =>
          input.sessionId === request.sessionId && input.targetTurnId === request.turnId && input.userId === this.scope.userId &&
          input.delivery === "steer" && (input.status === "accepted" || input.status === "queued") &&
          input.consumedByStepId === null && input.consumedAt === null && input.acceptedSequence > request.checkpoint.inputThroughSequence,
        )
        for (const input of candidates) {
          const mutable = input as unknown as { status: StoredAgentInput["status"]; consumedByStepId: string | null; consumedAt: Date | null }
          mutable.status = "consumed"
          mutable.consumedByStepId = request.stepId
          mutable.consumedAt = request.now
        }
        return { inputs: candidates, newlyClaimedInputIds: candidates.map(input => input.id) }
      },
      persistCheckpoint: async ({ stepId, checkpoint }) => {
        this.checkpoints.set(stepId, { inputThroughSequence: checkpoint.inputThroughSequence, consumedInputIds: [...checkpoint.consumedInputIds] })
      },
    })
  }
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

describe("owner-agnostic turn execution loop", () => {
  it("rethrows a pause rejected by startStep without terminalizing or invoking the model", async () => {
    const root = fixture(identity("turn", "root-1"))
    const pause = new SessionPauseRequestedError()
    const store = root.options.store
    root.options = { ...root.options, store: { ...store, startStep: async () => { throw pause } } }

    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)

    expect(root.requests).toHaveLength(0)
    expect(root.events.some(event => event.type === "turn.failed")).toBe(false)
  })

  it("preserves the same Turn when a durable pause fence rejects step admission", async () => {
    const root = fixture(identity("turn", "root-1"))
    const pause = new SessionPauseRequestedError()
    const store = root.options.store
    root.options = {
      ...root.options,
      store: {
        ...store,
        appendEvent: async input => {
          if (input.type === "step.started") throw pause
          return store.appendEvent(input)
        },
      },
    }

    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)

    expect(root.requests).toHaveLength(0)
    expect(root.stepStatuses).toEqual(["interrupted"])
    expect(root.events.some(event => event.type === "turn.failed")).toBe(false)
  })

  it("rethrows the same typed pause from the actual completion-gate boundary", async () => {
    const pause = new SessionPauseRequestedError()
    const gate = vi.fn(async () => { throw pause })
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)

    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)

    expect(gate).toHaveBeenCalledTimes(1)
    expect(root.stepStatuses).toEqual(["completed", "interrupted"])
    expect(root.events.some(event => event.type === "turn.failed")).toBe(false)
  })

  it("completes an exact recovered candidate without another provider call or double-counting resumed usage", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, [{ id: "resume-observation", content: { toolCallId: "resume-evidence", status: "completed" } }])
    const resume = {
      nextOrdinal: 1, stepCount: 1, toolCallCount: 0, inputThroughSequence: 0n, consumedInputIds: [],
      usage: { inputTokens: 17, outputTokens: 9, estimatedCostUsd: 0.23 },
    }
    root.options = { ...root.options, resume, expectedEvidence: ["resume-evidence"], recoveredFinalCandidate: "done:root-1" }

    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, finalText: "done:root-1" })
    expect(root.requests).toHaveLength(0)
    const saved = JSON.parse(root.finalResponses[0]!.slice("root-1:".length)) as { usage: unknown }
    expect(saved.usage).toEqual(resume.usage)
  })

  it("fails once when the full resumed Turn request outgrows every route after an earlier provider attempt", async () => {
    const root = fixture(identity("turn", "root-1"))
    const diagnostics: HarnessRequestAdmissionDiagnostic[] = []
    const selections: string[] = []
    const requestCaptures: HarnessModelRequest[] = []
    const routeErrors: unknown[] = []
    const primaryRequests: HarnessModelRequest[] = []
    const settlements: WorkerUsageSettlementInput[] = []
    const authorizations: WorkerUsageAuthorizationInput[] = []
    const runtime = createHarnessModelRuntime({
      primary: { provider: "minimax", model: "MiniMax-M3", apiKey: "fixture-minimax" },
      fallbacks: [{ provider: "anthropic", model: "claude-sonnet-5", apiKey: "fixture-anthropic" }],
      allowEnvironmentFallbacks: false,
      maxReroutes: 1,
      onRequestAdmission: diagnostic => diagnostics.push(diagnostic),
      onSelectionEvent: event => selections.push(event.type),
    })
    let primaryCalls = 0
    let fallbackCalls = 0
    replaceHarnessRoute(runtime, "minimax", "MiniMax-M3", 100_000, async function* (request) {
      primaryRequests.push(request)
      primaryCalls += 1
      if (primaryCalls === 1) {
        yield { type: "tool_call_completed", callId: "call:large-search", name: "jobs.search", arguments: { location: "Dublin" } }
        yield { type: "usage", inputTokens: 41, outputTokens: 13, estimatedCostUsd: 0.037 }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      throw new AgentModelError({
        code: "provider_error", message: "fixture provider rejected the second request",
        provider: request.provider, model: request.model, retryable: true, recoverable: true,
      })
    })
    replaceHarnessRoute(runtime, "anthropic", "claude-sonnet-5", 4_096, async function* () {
      fallbackCalls += 1
      throw new Error("oversized fallback must not reach its provider adapter")
    })

    const capturedRouter: ModelAdapter = {
      ...runtime.adapter,
      async *stream(request) {
        requestCaptures.push(request)
        try { yield* runtime.adapter.stream(request) }
        catch (error: unknown) { routeErrors.push(error); throw error }
      },
    }
    const authorize = async (input: WorkerUsageAuthorizationInput): Promise<WorkerUsageAuthorization> => {
      authorizations.push(input)
      return { settle: async settlement => { settlements.push(settlement) } }
    }
    const model = createUsageAwareModelAdapter(capturedRouter, { owner: root.options.identity, authorize })
    const goal = "Find senior software engineering roles in Dublin while preserving the original candidate constraints."
    const goalBlock: StepContext["blocks"][number] = {
      id: "goal:original", layer: "goal", role: "data", trust: "external_untrusted", source: "turn_goal", content: goal,
    }
    const baseBuilder = root.options.contextBuilder
    const searchOutput = `Dublin role result with the original search detail. `.repeat(2_000)
    const tools = [{
      name: "jobs.search", version: "1", description: "Search public job postings.",
      inputSchema: { type: "object", properties: { location: { type: "string" } }, required: ["location"], additionalProperties: false },
    }]
    const outputSchema = {
      type: "object", properties: { summary: { type: "string" }, sourceCount: { type: "integer" } },
      required: ["summary", "sourceCount"], additionalProperties: false,
    }
    const resumedUsage = { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.011 }
    root.options = {
      ...root.options,
      goal,
      snapshot: { ...root.options.snapshot, goal: { id: "original", content: goal } },
      contextBuilder: {
        build: async request => {
          const context = await baseBuilder.build(request)
          return {
            ...context,
            blocks: [goalBlock, ...context.blocks],
            canonicalJson: JSON.stringify({ goal, context: context.canonicalJson }),
          }
        },
      },
      model,
      tools,
      outputSchema,
      executeTool: async ({ call }) => ({
        id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed",
        output: { summary: searchOutput }, errorCode: null,
      }),
      resume: {
        nextOrdinal: 0, stepCount: 0, toolCallCount: 0, inputThroughSequence: 0n, consumedInputIds: [], usage: resumedUsage,
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", errorCode: "context_estimate_exceeded", stepCount: 2, toolCallCount: 1 })
    expect(primaryCalls).toBe(2)
    expect(fallbackCalls).toBe(0)
    expect(requestCaptures).toHaveLength(2)
    expect(primaryRequests).toHaveLength(2)
    expect(routeErrors).toHaveLength(1)
    expect(routeErrors[0]).toMatchObject({
      code: "context_estimate_exceeded", provider: "anthropic", model: "claude-sonnet-5", guaranteedNoProviderAttempt: false,
    })
    expect(selections).toContain("model.rerouted")
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.map(item => [item.provider, item.status, item.withinWindow])).toEqual([
      ["minimax", "known", true], ["minimax", "known", true], ["anthropic", "known", false],
    ])

    const finalRequest = requestCaptures[1]!
    expect(finalRequest.messages).toEqual(expect.arrayContaining([
      { role: "user", content: expect.arrayContaining([expect.objectContaining({ type: "text", text: expect.stringContaining(goal) })]) },
      { role: "tool", content: expect.arrayContaining([expect.objectContaining({ type: "tool_result", content: expect.stringContaining(searchOutput) })]) },
    ]))
    expect(finalRequest.tools).toEqual(tools)
    expect(finalRequest.outputSchema).toEqual(outputSchema)
    expect(finalRequest.toolChoice).toBe("auto")

    expect(authorizations).toHaveLength(2)
    expect(settlements).toEqual([
      { status: "success", inputTokens: 41, outputTokens: 13, estimatedCostUsd: 0.037 },
      { status: "error", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, errorCode: "context_estimate_exceeded" },
    ])
    expect(root.stepStatuses).toEqual(["completed", "failed"])
    expect(root.finalResponses).toHaveLength(1)
    const finalResponse = JSON.parse(root.finalResponses[0]!.slice("root-1:".length)) as {
      completed: boolean; blocker: string; usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number }
    }
    expect(finalResponse).toMatchObject({
      completed: false,
      blocker: expect.stringMatching(/Approximate.*retained prompt\/tool context.*required content was not removed/),
      usage: { inputTokens: 48, outputTokens: 16, estimatedCostUsd: 0.048 },
    })
    const persistedFailure = root.events.find(event => event.type === "turn.failed" && event.payload !== undefined)
    expect(persistedFailure?.payload).toMatchObject({
      errorCode: "context_estimate_exceeded", final: { completed: false, usage: finalResponse.usage },
    })
    const modelUsageEvents = root.events.filter(event => event.type === "model.usage" && event.payload !== undefined)
    expect(modelUsageEvents).toHaveLength(1)
    expect(modelUsageEvents[0]?.payload).toMatchObject({ usage: { inputTokens: 41, outputTokens: 13, estimatedCostUsd: 0.037 } })
    expect(root.events.some(event => event.type === "model.failed" && event.payload !== undefined)).toBe(true)
    expect(root.events.filter(event => event.type === "turn.failed" && event.payload !== undefined)).toHaveLength(1)
  })

  it("replaces a recovered candidate when fresh steering arrives before the resumed step", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, [{ id: "evidence", content: { toolCallId: "fresh-evidence", toolName: "jobs.search", status: "completed", errorCode: null, input: {}, output: { jobs: [] } } }])
    addSteeringInput(root)
    const model = root.options.model
    const completionGate = vi.fn(async () => ({ ok: true as const }))
    root.options = {
      ...root.options,
      expectedEvidence: ["fresh-evidence"],
      recoveredFinalCandidate: "stale answer from before steering",
      completionGate,
      model: {
        ...model,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          yield { type: "text_delta", text: "fresh answer for senior Dublin roles" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", finalText: "fresh answer for senior Dublin roles" })
    expect(root.requests).toHaveLength(1)
    expect(JSON.stringify(root.requests[0]?.messages)).toContain("Change the target to senior roles")
    expect(root.finalResponses[0]).toContain("fresh answer for senior Dublin roles")
    expect(root.finalResponses[0]).not.toContain("stale answer from before steering")
    expect(completionGate).toHaveBeenCalledWith(expect.objectContaining({ candidateText: "fresh answer for senior Dublin roles" }))
  })

  it("finishes the Turn once after atomic terminal commit without a same-Turn follow-up step", async () => {
    const root = fixture(identity("turn", "root-1"))

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(root.requests).toHaveLength(2)
    expect(root.finalResponses).toHaveLength(1)
    expect(root.items.filter(item => item.id.includes("item:final:")).map(item => item.revision)).toEqual([1])
    expect(root.notifications.filter(type => type === "turn.completed")).toHaveLength(1)
  })

  it.each([
    { maxSteps: 1, expectedRemaining: 0, expectedWrites: 0 },
    { maxSteps: 3, expectedRemaining: 2, expectedWrites: 1 },
  ])("keeps TaskGraph scheduling behind the live root step budget (maxSteps=$maxSteps)", async ({ maxSteps, expectedRemaining, expectedWrites }) => {
    const root = fixture(identity("turn", "root-1"))
    const receipt: TaskGraphScheduleReceipt = {
      status: "accepted", revision: 1,
      nodes: [{ key: "research", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    }
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async () => receipt),
      readCurrent: vi.fn(async () => ({ revision: 0, nodes: [] })),
    }
    const planTool = createTaskGraphPlanningTool({
      commandPort,
      templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: () => 1,
    })
    const proposal = {
      expectedRevision: 0,
      nodes: [{ key: "research", templateId: "scout", goal: "Find relevant roles", successCriteria: ["Return role links"], dependsOn: [] }],
    }
    const requests: HarnessModelRequest[] = []
    const remainingAtPlan: number[] = []
    let modelCalls = 0
    const baseModel = root.options.model
    root.options = {
      ...root.options,
      budget: { maxSteps },
      tools: [planTool],
      model: {
        ...baseModel,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          requests.push(request)
          modelCalls += 1
          if (modelCalls === 1) {
            yield { type: "tool_call_completed", callId: "plan-call", name: "agent.plan", arguments: proposal }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          yield { type: "text_delta", text: "The graph plan is ready." }
          yield { type: "completed", finishReason: "stop" }
        },
      },
      executeTool: async input => {
        const context: ToolExecutionContext = {
          scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId,
          toolCallId: input.call.id, taskId: input.taskId, rootTaskId: input.rootTaskId,
          actorRole: input.actorRole, remainingTurnSteps: input.remainingTurnSteps,
          signal: input.signal, capabilities: input.capabilities ?? [], reportProgress: async () => undefined,
        }
        if (typeof input.remainingTurnSteps === "number") remainingAtPlan.push(input.remainingTurnSteps)
        try {
          const output = await planTool.execute(context, input.call.input)
          return { id: input.call.id, toolName: input.call.toolName, toolVersion: input.call.toolVersion, status: "completed", output, errorCode: null }
        } catch (error: unknown) {
          const code = error instanceof ToolExecutionError ? error.code : "tool_execution_failed"
          const output = error instanceof ToolExecutionError ? error.safeOutput : undefined
          return { id: input.call.id, toolName: input.call.toolName, toolVersion: input.call.toolVersion, status: "failed", output, errorCode: code }
        }
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(remainingAtPlan).toEqual([expectedRemaining])
    expect(commandPort.appendAndSchedule).toHaveBeenCalledTimes(expectedWrites)
    if (maxSteps === 1) expect(result).toMatchObject({ status: "failed", errorCode: "budget_exhausted", stepCount: 1 })
    else expect(result.status).toBe("completed")
    expect(requests[0]?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "agent.plan" })]))
  })

  it.each(["accepted", "duplicate"] as const)("refreshes TaskGraph evidence after an inline-ready wait and %s plan", async planStatus => {
    const root = fixture(identity("turn", "root-1"))
    const currentGraph: TaskGraphCurrentState = {
      revision: 4,
      nodes: [{
        key: "child", templateId: "scout", goal: "Find roles", successCriteria: ["Return evidence"], dependsOn: [],
        taskId: "child-1", status: "completed" as const, readiness: "terminal" as const,
        resultSummary: "One matching role", failureReason: null,
        resultProjection: {
          schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted" as const,
          availability: "available" as const, role: "scout" as const, status: "completed" as const,
          candidateCount: 1, evidenceCount: 1,
          candidates: [{ jobId: "job-42", source: "greenhouse" as const, evidenceKinds: ["job" as const] }],
        },
      }],
    }
    const refresh = vi.fn(async snapshot => mergeTaskGraphCurrentObservation(snapshot, currentGraph))
    const appendExpectedRevisions: number[] = []
    const nextReceipt: TaskGraphScheduleReceipt = {
      status: planStatus, revision: 5,
      nodes: [{ key: "next", taskId: "child-2", status: "queued" }], readyTaskIds: ["child-2"],
    }
    const plannedGraph: TaskGraphCurrentState = {
      revision: 5,
      nodes: [...currentGraph.nodes, {
        key: "next", templateId: "scout", goal: "Find more roles", successCriteria: ["Return evidence"], dependsOn: [],
        taskId: "child-2", status: "queued", readiness: "ready", resultSummary: null, failureReason: null,
      }],
    }
    const refreshAfterPlan = vi.fn(async snapshot => mergeTaskGraphCurrentObservation(snapshot, plannedGraph))
    const commandPort: TaskGraphCommandPort = {
      appendAndSchedule: vi.fn(async input => {
        appendExpectedRevisions.push(input.proposal.expectedRevision)
        return nextReceipt
      }),
      readCurrent: vi.fn(async () => currentGraph),
    }
    const planTool = createTaskGraphPlanningTool({
      commandPort,
      templates: { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } },
      turnLeaseOwner: "worker-1", turnLeaseVersion: 1, parentLeaseOwner: "worker-1", parentAttemptCount: () => 1,
    })
    const model = root.options.model
    let modelCalls = 0
    root.options = {
      ...root.options,
      tools: [{ name: "agent.wait", version: "1" }, planTool],
      refreshTaskGraphAfterReadyWait: refresh,
      refreshTaskGraphAfterPlan: refreshAfterPlan,
      model: {
        ...model,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          modelCalls += 1
          if (modelCalls === 1) {
            yield { type: "tool_call_completed", callId: "wait-call", name: "agent.wait", arguments: { taskIds: ["child-1"], mode: "all", timeoutMs: 5000 } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          if (modelCalls === 2) {
            const requestContext = JSON.stringify(request.messages).replaceAll("\\\"", "\"")
            const hasFreshGraph = requestContext.includes('"revision":4') && requestContext.includes('"jobId":"job-42"')
            yield {
              type: "tool_call_completed", callId: "plan-call", name: "agent.plan",
              arguments: {
                expectedRevision: hasFreshGraph ? 4 : 0,
                nodes: [{ key: "next", templateId: "scout", goal: "Find more roles", successCriteria: ["Return evidence"], dependsOn: [] }],
              },
            }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          yield { type: "text_delta", text: "The updated graph plan is ready." }
          yield { type: "completed", finishReason: "stop" }
        },
      },
      executeTool: async input => {
        if (input.call.toolName === "agent.wait") {
          return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "completed", output: { waitId: "wait-1", status: "ready", matchedTaskIds: ["child-1"] }, errorCode: null }
        }
        const context: ToolExecutionContext = {
          scope: input.scope, sessionId: input.sessionId, turnId: input.turnId, stepId: input.stepId,
          toolCallId: input.call.id, taskId: input.taskId, rootTaskId: input.rootTaskId,
          actorRole: input.actorRole, remainingTurnSteps: input.remainingTurnSteps,
          signal: input.signal, capabilities: input.capabilities ?? [], reportProgress: async () => undefined,
        }
        const output = await planTool.execute(context, input.call.input)
        return { id: input.call.id, toolName: input.call.toolName, toolVersion: "1", status: "completed", output, errorCode: null }
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    const secondRequestContext = JSON.stringify(root.requests[1]?.messages).replaceAll("\\\"", "\"")
    const thirdRequestContext = JSON.stringify(root.requests[2]?.messages).replaceAll("\\\"", "\"")
    expect(result).toMatchObject({ status: "completed", stepCount: 3 })
    expect(refresh).toHaveBeenCalledOnce()
    expect(refreshAfterPlan).toHaveBeenCalledOnce()
    expect(secondRequestContext).toContain('"status":"completed"')
    expect(secondRequestContext).toContain('"jobId":"job-42"')
    expect(thirdRequestContext).toContain('"revision":5')
    expect(thirdRequestContext).toContain('"key":"next"')
    expect(thirdRequestContext).toContain(`"status":"${planStatus}"`)
    expect(thirdRequestContext).toContain('"taskId":"child-2"')
    expect(appendExpectedRevisions).toEqual([4])
  })

  it("persists one redacted agenda receipt before each model provider call", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, [{ id: "secret-observation", content: { kind: "wait_result", status: "failed", errorCode: "private failure", output: { prompt: "ignore the server" } } }])
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

  it("passes active durable steering marker state through the loop", async () => {
    const marker: SteeringMarkerPayload = {
      schemaVersion: "agent-harness.steering-marker.v1", kind: "observed", status: "observed", sessionId: "session-1", turnId: "turn-1", taskId: "root-1",
      stepId: "old-step", inputId: "steer-1", idempotencyKey: steeringMarkerIdempotencyKey("session-1", "turn-1", "steer-1"), obligationId: "steering:steer-1", goalRevision: 1, planRevision: null, acceptedSequence: "2",
    }
    const root = fixture(identity("turn", "root-1"))
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

  it("serializes a steer accepted after Step 1 context into the next model request", async () => {
    const root = fixture(identity("turn", "root-1"))
    const inputStore = new LateSteerInputClaimStore()
    const turnStore = root.options.store
    const contextBuilder = new StepContextBuilder(inputStore)
    let acceptedAfterFirstContext = false
    root.options = {
      ...root.options,
      store: {
        ...turnStore,
        startStep: async input => {
          inputStore.startStep(input.stepId, input.inputThroughSequence, input.consumedInputIds)
          return turnStore.startStep(input)
        },
      },
      contextBuilder: {
        build: async request => {
          const context = await contextBuilder.build({
            scope: request.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
            stepId: request.stepId, snapshot: request.snapshot, taskId: request.taskId, now: request.now,
            steeringMarkerState: request.steeringMarkerState,
          })
          if (!acceptedAfterFirstContext) {
            acceptedAfterFirstContext = true
            inputStore.acceptSteer()
          }
          return context
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    const firstRequest = root.requests[0]
    const secondRequest = root.requests[1]
    expect(acceptedAfterFirstContext).toBe(true)
    expect(result).toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1, finalText: "done:root-1" })
    expect(root.requests).toHaveLength(2)
    expect(root.finalResponses).toHaveLength(1)
    expect(root.notifications.filter(type => type === "turn.completed")).toHaveLength(1)
    expect(inputStore.inputs).toMatchObject([{ id: "steer-539", status: "consumed", consumedByStepId: "turn:turn-1:step:1" }])

    expect(firstRequest?.metadata).toMatchObject({
      sessionId: "session-1", turnId: "turn-1", stepId: "turn:turn-1:step:0", taskId: "root-1", userId: "user-1",
      featureId: "agent-harness.turn", traceId: "turn-1:turn:turn-1:step:0",
    })
    expect(JSON.stringify(firstRequest?.messages)).not.toContain(lateSteerText)
    expect(secondRequest?.metadata).toMatchObject({
      sessionId: "session-1", turnId: "turn-1", stepId: "turn:turn-1:step:1", taskId: "root-1", userId: "user-1",
      featureId: "agent-harness.turn", traceId: "turn-1:turn:turn-1:step:1",
    })
    expect(secondRequest?.messages).toEqual(expect.arrayContaining([
      {
        role: "user",
        content: [{
          type: "text",
          text: `[harness context layer=pending_input trust=UNTRUSTED_DATA source=user_input]\n{"inputId":"steer-539","partIndex":0,"text":"${lateSteerText}"}`,
        }],
      },
      { role: "assistant", content: [{ type: "tool_use", id: "call:root-1", name: "jobs.search", input: { location: "Dublin" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "call:root-1", content: '{"job":"job-1"}' }] },
    ]))
    expect(JSON.stringify(secondRequest?.messages).split(lateSteerText)).toHaveLength(2)
    expect(JSON.stringify(secondRequest?.messages).match(/"type":"tool_result"/g)).toHaveLength(1)
  })

  it("preserves the count of persisted calls when a later call in the batch exceeds budget", async () => {
    const root = fixture(identity("turn", "root-1"))
    const baseModel = root.options.model
    let modelCalls = 0
    const model: ModelAdapter = {
      ...baseModel,
      async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
        root.requests.push(request)
        modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "persisted-call", name: "jobs.search", arguments: { location: "Dublin" } }
          yield { type: "tool_call_completed", callId: "over-budget-call", name: "jobs.search", arguments: { location: "Berlin" } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "text_delta", text: "done:root-1" }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const executeTool = vi.fn(root.options.executeTool)
    const createItem = root.options.store.createItem
    let persistedToolCalls = 0
    root.options = {
      ...root.options,
      model,
      executeTool,
      store: {
        ...root.options.store,
        createItem: async input => {
          if (input.type === "tool_call") {
            if (persistedToolCalls === 1) throw new BudgetExceededError("tool_calls", 1, 2, 1)
            persistedToolCalls += 1
          }
          return createItem(input)
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", errorCode: "budget_exhausted", stepCount: 1, toolCallCount: 1 })
    expect(persistedToolCalls).toBe(1)
    expect(executeTool).toHaveBeenCalledOnce()
  })

  it("counts a persisted call when a later result write fails", async () => {
    const root = fixture(identity("turn", "root-1"))
    const executeTool = vi.fn(root.options.executeTool)
    root.options = {
      ...root.options,
      executeTool,
      store: {
        ...root.options.store,
        updateItem: async () => { throw new Error("result_write_failed") },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", toolCallCount: 1 })
    expect(executeTool).toHaveBeenCalledOnce()
    expect(root.items[0]?.id).toContain("item:tool-call:call:root-1")
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

  it("runs the completion gate before final persistence and blocks an unfinished child tree", async () => {
    const gate = vi.fn(async () => ({ ok: false as const, blocker: "child_tasks_pending", feedback: "Child work is still running" }))
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "business_precondition_failed" })
    expect(result.finalText).toBeUndefined()
    expect(gate).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-1", stepId: expect.any(String), signal: expect.any(Object) }))
    expect(root.events.some(event => event.type === "final.rejected")).toBe(true)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("replans in the same root loop after a TaskGraph evidence denial", async () => {
    let checks = 0
    const gate = vi.fn(async () => ++checks === 1
      ? ({ ok: false as const, blocker: "task_graph_verification_unverified", feedback: "node=scout criterion=candidate-present status=unverified reasonCode=canonical_evidence_missing repair=missing" })
      : ({ ok: true as const }))
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    const snapshots: TurnExecutionOptions["snapshot"][] = []
    const build = root.options.contextBuilder.build
    root.options.contextBuilder.build = async request => {
      snapshots.push(request.snapshot)
      const context = await build(request)
      const systemBlocks = request.snapshot.system.map(seed => ({ id: `system:${seed.id}`, layer: "system" as const, role: "instruction" as const, trust: "system" as const, source: "harness", content: seed.content as StepContext["blocks"][number]["content"] }))
      return { ...context, blocks: [...systemBlocks, ...context.blocks] }
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 3 })
    expect(root.requests).toHaveLength(3)
    expect(snapshots[2]?.system.at(-1)?.content).toContain("node=scout criterion=candidate-present status=unverified reasonCode=canonical_evidence_missing repair=missing")
    expect(root.requests[2]?.messages.some(message => message.role === "system" && JSON.stringify(message.content).includes("node=scout criterion=candidate-present status=unverified reasonCode=canonical_evidence_missing repair=missing"))).toBe(true)
    expect(root.events.some(event => event.type === "final.rejected")).toBe(true)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed"])
  })

  it("finalizes the third unchanged semantic rejection before the fixed no-progress failure", async () => {
    const candidate = "unchanged candidate"
    let rejects = 0
    const gate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => {
      rejects += 1
      return { ok: false, blocker: "task_graph_verification_unverified", feedback: "criterion=current-evidence status=failed reason=evidence_missing",
        ...(rejects === 3 ? { [NATIVE_SEMANTIC_NO_PROGRESS]: true as const } : {}) }
    }
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    root.options = { ...root.options, snapshot: { ...root.options.snapshot, businessRefs: [{ id: "owned-source", kind: "job", ownerId: "user-1" }] }, model: {
      ...root.options.model,
      async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
        root.requests.push(request)
        yield { type: "text_delta", text: candidate }
        yield { type: "completed", finishReason: "stop" }
      },
    } }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "no_progress", stepCount: 3 })
    expect(root.requests).toHaveLength(3)
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed"])
    expect(new Set(root.events.filter(event => event.type === "step.completed").map(event => event.id)).size).toBe(3)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
    const diagnostic = root.events.find(event => event.type === "turn.no_progress")?.payload
    expect(diagnostic).toMatchObject({ reasonCode: "repeated_signature", signature: "native_semantic_rejection", stateFingerprint: "root_candidate" })
    expect(JSON.stringify(diagnostic)).not.toContain(candidate)
    expect(JSON.stringify(root.finalResponses)).not.toContain(candidate)
  })

  it("keeps progress across a persistent active marker and resets once for a newly claimed input", async () => {
    let rejects = 0, resets = 0, builds = 0
    const completionGate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => {
      rejects += 1
      return { ok: false, blocker: "task_graph_verification_unverified", feedback: "criterion=current status=failed reason=evidence_missing",
        ...(rejects === 3 ? { [NATIVE_SEMANTIC_NO_PROGRESS]: true as const } : {}) }
    }
    completionGate[RESET_NATIVE_SEMANTIC_PROGRESS] = () => { resets += 1; rejects = 0 }
    const root = fixture(identity("turn", "root-1"), undefined, [], completionGate)
    const build = root.options.contextBuilder.build
    root.options = {
      ...root.options,
      snapshot: { ...root.options.snapshot, businessRefs: [{ id: "owned-source", kind: "job", ownerId: "user-1" }] },
      resume: { nextOrdinal: 0, stepCount: 0, toolCallCount: 0, inputThroughSequence: 0n, consumedInputIds: ["marker-old"], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
      contextBuilder: { build: async request => {
        const context = await build(request)
        builds += 1
        const hasNewInput = builds >= 3
        return {
          ...context,
          consumedInputIds: hasNewInput ? ["marker-old", "marker-new"] : ["marker-old"],
          steeringMarkerControl: {
            activeInputIds: hasNewInput ? ["marker-old", "marker-new"] : ["marker-old"],
            newlyObservedInputIds: builds === 3 ? ["marker-new"] : [],
            newlyObservedMarkers: [],
          },
        }
      } },
      model: {
        ...root.options.model,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          yield { type: "text_delta", text: "unchanged candidate" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }
    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", errorCode: "no_progress", stepCount: 5 })
    expect(root.requests).toHaveLength(5)
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed", "completed", "completed"])
    expect(resets).toBe(1)
    expect(root.events.find(event => event.type === "turn.no_progress")?.payload).toMatchObject({ reasonCode: "repeated_signature" })
  })

  it("does not turn repeated proof denials into success after the root step budget is exhausted", async () => {
    const gate = vi.fn(async () => ({ ok: false as const, blocker: "task_graph_verification_unverified", feedback: "scout:candidate-present" }))
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    root.options = { ...root.options, budget: { maxSteps: 2 } }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "budget_exhausted", stepCount: 2 })
    expect(root.requests).toHaveLength(2)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(false)
  })

  it("recovers inside the loop when atomic TaskGraph finalization loses a race", async () => {
    const root = fixture(identity("turn", "root-1"))
    let denyOnce = true
    const persist = root.options.store.recordFinalResponse!
    root.options.store.recordFinalResponse = async input => {
      if (input.terminal && denyOnce) { denyOnce = false; throw Object.assign(new Error("race"), { name: "TaskGraphVerificationRecovery", blocker: "task_graph_verification_unverified", feedback: "scout:candidate-present" }) }
      return persist(input)
    }
    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "completed", stepCount: 3 })
    expect(root.requests).toHaveLength(3)
    expect(root.events.some(event => event.type === "final.rejected" && event.id.includes("task-graph-race"))).toBe(true)
    expect(root.events.some(event => event.type === "turn.failed")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
  })

  it("replans with a steer accepted during native finalization instead of publishing the old answer", async () => {
    const root = fixture(identity("turn", "root-1"))
    const inputStore = new LateSteerInputClaimStore()
    const turnStore = root.options.store
    const contextBuilder = new StepContextBuilder(inputStore)
    let modelCalls = 0
    const baseModel = root.options.model
    const ordering: string[] = []
    const completionGate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => ({ ok: true })
    completionGate[RESET_NATIVE_SEMANTIC_PROGRESS] = () => { ordering.push("reset") }
    root.options = {
      ...root.options,
      completionGate,
      store: {
        ...turnStore,
        startStep: async input => {
          inputStore.startStep(input.stepId, input.inputThroughSequence, input.consumedInputIds)
          return turnStore.startStep(input)
        },
      },
      contextBuilder: {
        build: async request => contextBuilder.build({
          scope: request.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
          stepId: request.stepId, snapshot: request.snapshot, taskId: request.taskId, now: request.now,
          steeringMarkerState: request.steeringMarkerState,
        }),
      },
      model: {
        ...baseModel,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          modelCalls += 1
          ordering.push(`model-${modelCalls}`)
          if (modelCalls === 1) {
            yield { type: "tool_call_completed", callId: "call:root-1", name: "jobs.search", arguments: { location: "Dublin" } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          yield { type: "text_delta", text: modelCalls === 2 ? "stale answer before the new steering" : "fresh answer for senior engineering roles in Dublin" }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }
    let steerAcceptedDuringTerminal = false
    const persist = root.options.store.recordFinalResponse!
    root.options.store.recordFinalResponse = async input => {
      if (input.terminal && !steerAcceptedDuringTerminal) {
        steerAcceptedDuringTerminal = true
        inputStore.acceptSteer()
        throw Object.assign(new Error("new steering arrived during native verification"), {
          name: "TaskGraphVerificationRecovery", blocker: "task_graph_verification_unverified",
          feedback: "A new steering instruction arrived during verification. Re-read current input and prepare a fresh answer.",
        })
      }
      return persist(input)
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", stepCount: 3, finalText: "fresh answer for senior engineering roles in Dublin" })
    expect(root.requests).toHaveLength(3)
    expect(JSON.stringify(root.requests[1]?.messages)).not.toContain(lateSteerText)
    expect(JSON.stringify(root.requests[2]?.messages)).toContain(lateSteerText)
    expect(inputStore.inputs).toMatchObject([{ status: "consumed", consumedByStepId: "turn:turn-1:step:2" }])
    expect(root.finalResponses).toHaveLength(1)
    expect(root.finalResponses[0]).toContain("fresh answer for senior engineering roles in Dublin")
    expect(root.finalResponses[0]).not.toContain("stale answer before the new steering")
    expect(root.events.some(event => event.type === "final.rejected")).toBe(true)
    expect(root.events.some(event => event.type === "turn.failed")).toBe(false)
    expect(root.notifications.filter(type => type === "turn.completed")).toHaveLength(1)
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed"])
    expect(ordering).toEqual(["model-1", "model-2", "reset", "model-3"])
  })

  it("fails closed when the completion gate throws", async () => {
    const gate = vi.fn(async () => { throw new Error("database unavailable") })
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
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
      output: { waitId: "wait-12345678-1234-4234-9234-123456789012", status: "waiting", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: [], taskIds: ["child-a"] }, errorCode: null,
    })
    const result = await runTurnExecutionLoop(child.options)
    expect(result).toMatchObject({ status: "waiting_for_dependency", waitId: "wait-12345678-1234-4234-9234-123456789012", stepCount: 1, toolCallCount: 1 })
    expect(result.finalText).toBeUndefined()
    expect(child.requests).toHaveLength(1)
    expect(child.stepStatuses).toContain("waiting_for_tool")
    expect(child.events.some(event => event.type === "tool_call.completed")).toBe(true)
    expect(child.events.some(event => event.type === "step.completed")).toBe(true)
    expect(child.events.some(event => event.type === "turn.completed" || event.type === "turn.failed")).toBe(false)
  })

  it("continues to the next model step for ready wait output", async () => {
    const output = { waitId: "wait-ready", status: "ready", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: ["child-a"] }
    const root = fixture(identity("turn", "root-1"), { id: "wait-call", toolName: "wait_subagents", toolVersion: "1", status: "completed", output, errorCode: null })
    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(root.stepStatuses).toEqual(["completed", "completed"])
  })

  it.each([
    { label: "malformed ID", output: { waitId: "wait-invalid", status: "waiting", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: [], taskIds: ["child-a"] } },
    { label: "missing ID", output: { status: "waiting", deadlineAt: "2026-09-09T13:00:00.000Z", matchedTaskIds: [], taskIds: ["child-a"] } },
  ])("fails the Turn visibly for a waiting receipt with a $label", async ({ output }) => {
    const root = fixture(identity("turn", "root-1"), { id: "wait-call", toolName: "wait_subagents", toolVersion: "1", status: "completed", output, errorCode: null })
    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", errorCode: "invalid_output" })
    expect(root.requests).toHaveLength(1)
    expect(root.stepStatuses).toEqual(["failed"])
    expect(root.events.some(event => event.type === "turn.failed")).toBe(true)
  })


})
