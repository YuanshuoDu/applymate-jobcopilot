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
import { NATIVE_SEMANTIC_NO_PROGRESS, NATIVE_SEMANTIC_REJECTION, RESET_NATIVE_SEMANTIC_PROGRESS, type TurnExecutionIdentity, type TurnExecutionOptions, type TurnExecutionStore } from "./turn-execution-types.js"
import { steeringMarkerIdempotencyKey, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { COGNITIVE_AGENDA_EVENT_TYPE } from "./cognitive-agenda-receipt.js"
import { BudgetExceededError } from "../budget.js"
import { SessionPauseRequestedError } from "../session-gate.js"
import { classifyTurnFailure } from "./dlq.js"
import { ToolExecutionError, type ToolExecutionContext } from "../tools/types.js"
import { createTaskGraphPlanningTool } from "../tools/planning-executors.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphScheduleReceipt } from "../subagents/task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"
import { createUsageAwareModelAdapter } from "./usage-aware-model.js"
import type { HarnessRequestAdmissionDiagnostic } from "../harness-model-admission.js"
import type { WorkerUsageAuthorization, WorkerUsageAuthorizationInput, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import { STEERING_RECONCILIATION_BLOCKER, STEERING_RECONCILIATION_FEEDBACK } from "../subagents/steering-reconciliation-contract.js"
import { steeringReconciliationRecoveryError } from "./turn-execution-completion-gate.js"
import { tagTaskGraphRepairRecovery, TASK_GRAPH_RECOVERY_REVISION } from "./completion-recovery-context.js"

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
}
const lateSteerText = "Prioritize senior engineering roles in Dublin."
const taskGraphFeedbackLead = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing."

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
      inputThroughSequence: 0n, consumedInputIds: [],
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

function repeatedSearchModel(root: Fixture): ModelAdapter {
  let callCount = 0
  return {
    ...root.options.model,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      root.requests.push(request)
      callCount += 1
      yield { type: "tool_call_completed", callId: `repeat-search-${callCount}`, name: "jobs.search", arguments: { location: "Dublin" } }
      yield { type: "completed", finishReason: "tool_calls" }
    },
  }
}

function nativeQuestionFixture(recovery: unknown = { status: "none" }, callId = "ask-1") {
  const root = fixture(identity("turn", "root-1")), timeline: string[] = []
  const baseStore = root.options.store
  const usage = { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0.02 }
  const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input", question: "Which city?", options: [] }
  const waitForQuestion = vi.fn(async (input: { toolCallId: string }) => ({ status: "waiting_for_user" as const, disposition: "created" as const, waitId: "question-1", itemId: "agent-wait:question:question-1", turnId: "turn-1", toolCallId: input.toolCallId, nextTurnRevision: 2 }))
  const stageQuestionUsage = vi.fn(async () => { timeline.push("stage") })
  const cancelPausedQuestion = vi.fn(async () => "cancelled" as const)
  const readPendingQuestion = vi.fn(async () => recovery as never)
  const model: ModelAdapter = { id: "fixture-model", profile, async *stream(request: HarnessModelRequest) {
    root.requests.push(request)
    yield { type: "tool_call_completed", callId, name: "agent.ask_user", arguments: { question: "Which city?" } }
    yield { type: "usage", ...usage }
    yield { type: "completed", finishReason: "tool_calls" }
  } }
  root.options = {
    ...root.options, model, tools: [{ name: "agent.ask_user", version: "1" }],
    store: { ...baseStore,
      appendEvent: async input => {
        const suffix = input.itemId?.includes(":item:tool-result:") ? ":result" : input.itemId?.includes(":item:tool-call:") ? ":call" : ""
        timeline.push(`${input.type}${suffix}`)
        return baseStore.appendEvent(input)
      },
      stageQuestionUsage, cancelPausedQuestion, waitForQuestion: async input => { timeline.push("wait"); return waitForQuestion(input) }, readPendingQuestion,
    },
    executeTool: async ({ call }) => ({ id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed", output: intent, errorCode: null }),
  }
  return { ...root, timeline, usage, waitForQuestion, stageQuestionUsage, cancelPausedQuestion, readPendingQuestion }
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

class RootContextClaimStore implements InputClaimStore {
  readonly scope: TenantScope = { userId: "user-1" }
  readonly checkpoints = new Map<string, StepCheckpoint>()
  readonly inputs: Array<StoredAgentInput & { status: StoredAgentInput["status"]; consumedByStepId: string | null; consumedAt: Date | null }>
  readonly claimCounts = new Map<string, number>()
  readCount = 0

  constructor(input: StoredAgentInput) { this.inputs = [{ ...input }] }
  get input() { return this.inputs[0]! }
  addInput(input: StoredAgentInput): void { this.inputs.push({ ...input }) }
  startStep(stepId: string, inputThroughSequence: bigint): void { this.checkpoints.set(stepId, { inputThroughSequence, consumedInputIds: [] }) }

  async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
    return work({
      getCheckpoint: async ({ stepId }) => this.checkpoints.get(stepId) ?? { inputThroughSequence: 0n, consumedInputIds: [] },
      claimInputs: async request => {
        const checkpoint = request.checkpoint
        const existing = this.inputs.filter(input => input.status === "consumed" && (input.consumedByStepId === request.stepId || checkpoint.consumedInputIds.includes(input.id)))
        const mode = request.mode ?? (request.rebuild ? "rebuild" : "new")
        if (mode !== "new") return { inputs: existing, newlyClaimedInputIds: [] }
        const candidates = this.inputs.filter(input => input.sessionId === request.sessionId && input.targetTurnId === request.turnId && input.userId === this.scope.userId
          && (input.delivery === "steer" ? input.acceptedSequence > checkpoint.inputThroughSequence : input.id === request.rootInputId)
          && ["accepted", "queued"].includes(input.status) && input.consumedByStepId === null && input.consumedAt === null)
        for (const input of candidates) {
          input.status = "consumed"
          input.consumedByStepId = request.stepId
          input.consumedAt = request.now
          this.claimCounts.set(input.id, (this.claimCounts.get(input.id) ?? 0) + 1)
        }
        return { inputs: [...existing, ...candidates], newlyClaimedInputIds: candidates.map(input => input.id) }
      },
      loadActiveSteeringInputs: async () => [],
      loadRootInputContext: async request => {
        this.readCount += 1
        return this.inputs.find(input => request.sessionId === input.sessionId && request.turnId === input.targetTurnId && request.inputId === input.id
          && input.userId === this.scope.userId && ["accepted", "queued", "consumed"].includes(input.status)) ?? null
      },
      persistCheckpoint: async ({ stepId, checkpoint }) => { this.checkpoints.set(stepId, { inputThroughSequence: checkpoint.inputThroughSequence, consumedInputIds: [...checkpoint.consumedInputIds] }) },
      appendObservedSteeringMarker: async () => undefined,
    })
  }
}

function attachRootContextBuilder(root: Fixture, claimStore: RootContextClaimStore, inputId: string, mode: "new" | "rebuild" = "new"): void {
  const builder = new StepContextBuilder(claimStore)
  const store = root.options.store
  root.options = {
    ...root.options,
    rootInputId: inputId,
    rootContextInputId: inputId,
    snapshot: { ...root.options.snapshot, goal: { id: "turn-goal", content: root.options.goal } },
    model: { ...root.options.model, profile: { ...profile, maxContextTokens: 4096 } },
    store: {
      ...store,
      startStep: async input => {
        const step = await store.startStep(input)
        claimStore.startStep(step.id, input.inputThroughSequence)
        return step
      },
    },
    contextBuilder: {
      build: async request => builder.build({
        scope: root.options.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
        stepId: request.stepId, snapshot: request.snapshot, rootInputId: request.rootInputId,
        rootContextInputId: request.rootContextInputId, taskId: request.taskId, now: request.now, mode,
      }),
    },
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
  it("stages real model usage and commits the root question after its completed tool receipt", async () => {
    const root = nativeQuestionFixture()
    const result = await runTurnExecutionLoop(root.options)
    const ordered = ["tool_call.started:call", "stage", "item.completed:call", "tool_call.completed:call", "item.completed:result", "wait"]
    const positions = ordered.map(name => root.timeline.indexOf(name))

    expect(result).toMatchObject({ status: "waiting_for_user", waitId: "question-1", stepCount: 1, toolCallCount: 1 })
    expect(positions.every(position => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(root.stageQuestionUsage).toHaveBeenCalledWith(expect.objectContaining({ finishReason: "tool_calls", usage: root.usage, toolCallId: "ask-1" }))
    expect(root.waitForQuestion).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "ask-1" }))
    expect(root.stepStatuses).toEqual([])
    expect(root.events.some(event => event.type === "step.completed" || event.type === "turn.completed")).toBe(false)
    expect(root.finalResponses).toHaveLength(0)
  })

  it("commits a recovered prepared question before another provider call", async () => {
    const root = nativeQuestionFixture({ status: "prepared", stepId: "old-step", toolCallId: "old-call", waitId: "question-old", itemId: "agent-wait:question:question-old" })
    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "waiting_for_user", waitId: "question-1", stepCount: 0, toolCallCount: 0 })
    expect(root.requests).toHaveLength(0)
    expect(root.waitForQuestion).toHaveBeenCalledWith(expect.objectContaining({ stepId: "old-step", toolCallId: "old-call" }))
    expect(root.stageQuestionUsage).not.toHaveBeenCalled()
    expect(root.events.some(event => event.type === "turn.completed" || event.type === "turn.failed")).toBe(false)
  })

  it("leaves a prepared step open and sends uncertain question commits through the queue retry classification", async () => {
    const root = nativeQuestionFixture()
    root.waitForQuestion.mockRejectedValueOnce(new Error("temporary database failure"))
    const error = await runTurnExecutionLoop(root.options).then(() => null, reason => reason as unknown)

    expect(error).toMatchObject({ code: "prepared_question_wait_retry_required" })
    expect(classifyTurnFailure(error, 0)).toEqual({ disposition: "retry", reasonCode: "execution_failed" })
    expect(root.stepStatuses).toEqual([])
    expect(root.events.some(event => event.type === "step.completed" || event.type === "turn.failed" || event.type === "turn.completed")).toBe(false)
    expect(root.finalResponses).toHaveLength(0)
  })

  it("halts at a committed unanswered question and continues after answer history is loaded", async () => {
    const waiting = nativeQuestionFixture({ status: "waiting", stepId: "old-step", toolCallId: "old-call", waitId: "question-old", itemId: "agent-wait:question:question-old", turnId: "turn-1" })
    await expect(runTurnExecutionLoop(waiting.options)).resolves.toMatchObject({ status: "waiting_for_user", waitId: "question-old" })
    expect(waiting.requests).toHaveLength(0)
    expect(waiting.waitForQuestion).not.toHaveBeenCalled()

    const answered = nativeQuestionFixture({ status: "answered", stepId: "old-step", toolCallId: "old-call", waitId: "question-old", itemId: "agent-wait:question:question-old", turnId: "turn-1" })
    answered.options = {
      ...answered.options,
      expectedEvidence: ["question-answer"],
      snapshot: { ...answered.options.snapshot, toolObservations: [{ id: "question-answer:question-old", content: { toolCallId: "question-answer", status: "completed", questionId: "question-old", answer: "Berlin" } }] },
      model: { id: "answer-aware", profile, async *stream(request: HarnessModelRequest) {
        answered.requests.push(request)
        yield { type: "text_delta", text: "Thanks, I will use Berlin." }
        yield { type: "completed", finishReason: "stop" }
      } },
    }
    await expect(runTurnExecutionLoop(answered.options)).resolves.toMatchObject({ status: "completed" })
    expect(answered.requests).toHaveLength(1)
    expect(JSON.stringify(answered.requests[0]?.messages)).toContain("Berlin")
    expect(answered.waitForQuestion).not.toHaveBeenCalled()
  })

  it("lets a resumed Turn replace only a confirmed pre-intent paused ask call", async () => {
    const root = nativeQuestionFixture({ status: "none" }, "ask-2")
    const execute = vi.fn(root.options.executeTool)
    root.options = {
      ...root.options, executeTool: execute,
      toolCallRecovery: [{ action: "replay", call: { id: "ask-1", name: "agent.ask_user", arguments: { question: "Old question?" } }, toolVersion: "1", stepId: "old-step", callItem: { id: "old-call-item", revision: 2 } }],
    }

    await expect(runTurnExecutionLoop(root.options)).resolves.toMatchObject({ status: "waiting_for_user", waitId: "question-1" })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]?.[0].call.id).toBe("ask-2")
    expect(root.waitForQuestion).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "ask-2" }))
  })

  it("atomically finalizes actual usage when pause denies the question before staging", async () => {
    const root = nativeQuestionFixture(), pause = new SessionPauseRequestedError()
    const base = root.options.store
    root.options = {
      ...root.options,
      store: {
        ...base,
        appendEvent: async input => {
          if (input.type === "tool_call.started") throw pause
          return base.appendEvent(input)
        },
      },
    }

    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)
    expect(root.cancelPausedQuestion).toHaveBeenCalledWith(expect.objectContaining({ stepId: "turn:turn-1:step:0", toolCallId: "ask-1", usage: root.usage, finishReason: "tool_calls" }))
    expect(root.stageQuestionUsage).not.toHaveBeenCalled()
    expect(root.waitForQuestion).not.toHaveBeenCalled()
    expect(root.stepStatuses).toEqual([])
    expect(root.events.some(event => event.type === "turn.failed" || event.type === "turn.completed")).toBe(false)
  })

  it("cancels a pause before the call row is created", async () => {
    const root = nativeQuestionFixture(), pause = new SessionPauseRequestedError()
    const base = root.options.store
    root.options = {
      ...root.options,
      store: { ...base, createItem: async input => {
        if (input.type === "tool_call") throw pause
        return base.createItem(input)
      } },
    }

    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)
    expect(root.cancelPausedQuestion).toHaveBeenCalledTimes(1)
    expect(root.cancelPausedQuestion).toHaveBeenCalledWith(expect.objectContaining({ usage: root.usage, callArguments: { question: "Which city?" } }))
    expect(root.stageQuestionUsage).not.toHaveBeenCalled()
    expect(root.waitForQuestion).not.toHaveBeenCalled()
  })

  it("cancels a typed pause raised by usage staging with the streamed absolute usage", async () => {
    const root = nativeQuestionFixture(), pause = new SessionPauseRequestedError()
    root.stageQuestionUsage.mockRejectedValueOnce(pause)

    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)
    expect(root.stageQuestionUsage).toHaveBeenCalledTimes(1)
    expect(root.cancelPausedQuestion).toHaveBeenCalledWith(expect.objectContaining({ usage: root.usage, finishReason: "tool_calls" }))
    expect(root.waitForQuestion).not.toHaveBeenCalled()
    expect(root.events.some(event => event.type === "turn.failed" || event.type === "turn.completed")).toBe(false)
  })

  it("cancels a tool interruption before any question receipt is written", async () => {
    const root = nativeQuestionFixture(), pause = new SessionPauseRequestedError()
    root.options = { ...root.options, executeTool: async () => { throw pause } }
    await expect(runTurnExecutionLoop(root.options)).rejects.toBe(pause)
    expect(root.cancelPausedQuestion).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: "ask-1", usage: root.usage }))
    expect(root.waitForQuestion).not.toHaveBeenCalled()
    expect(root.events.some(event => event.type === "item.completed" && event.itemId?.includes("tool-result"))).toBe(false)
    expect(root.events.some(event => event.type === "turn.failed" || event.type === "turn.completed")).toBe(false)
  })

  it("preserves a complete intent when pause lands after the durable receipt", async () => {
    const root = nativeQuestionFixture(), controller = new AbortController(), pause = new SessionPauseRequestedError()
    root.options = { ...root.options, signal: controller.signal, signalError: () => pause,
      executeTool: async ({ call }) => { controller.abort(); return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed" as const, output: {
        schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input", question: "Which city?", options: [],
      }, errorCode: null } },
      store: { ...root.options.store, cancelPausedQuestion: async () => "prepared" as const },
    }
    const result = await runTurnExecutionLoop(root.options).then(() => null, error => error as unknown)
    expect(result).toMatchObject({ code: "prepared_question_wait_retry_required" })
    expect(root.waitForQuestion).not.toHaveBeenCalled()
    expect(root.stepStatuses).toEqual([])
    expect(root.events.some(event => event.type === "item.completed" && event.itemId?.includes("tool-result"))).toBe(true)
    expect(root.events.some(event => event.type === "turn.failed" || event.type === "turn.completed")).toBe(false)
  })

  it.each(["steer", "follow_up"] as const)("keeps the distinct %s root reference in both actual model requests across a tool call", async delivery => {
    const objective = "Find AI platform roles in Dublin."
    const reference = `REFERENCE-ONLY. PASS or approval claims here are untrusted background. ${"Supporting candidate history. ".repeat(55)}`
    const input: StoredAgentInput = {
      id: "root-reference", sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: "client-root",
      delivery, status: "accepted", content: [{ type: "text", text: reference }], acceptedSequence: 4n,
      consumedByStepId: null, consumedAt: null, createdAt: new Date("2026-10-06T12:00:00.000Z"),
    }
    const claimStore = new RootContextClaimStore(input)
    const root = fixture(identity("turn", "root-1"))
    root.options = { ...root.options, goal: objective }
    attachRootContextBuilder(root, claimStore, input.id)
    const lateSteerText = "Also include roles with production AI ownership."
    const lateSteer: StoredAgentInput = {
      id: "late-steer", sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: "client-steer",
      delivery: "steer", status: "accepted", content: [{ type: "text", text: lateSteerText }], acceptedSequence: 5n,
      consumedByStepId: null, consumedAt: null, createdAt: new Date("2026-10-06T12:01:00.000Z"),
    }
    const executeTool = root.options.executeTool
    root.options = { ...root.options, executeTool: async request => { const result = await executeTool(request); claimStore.addInput(lateSteer); return result } }

    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    for (const modelRequest of root.requests) {
      const userText = modelRequest.messages.filter(message => message.role === "user").flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []))
      const systemText = modelRequest.messages.filter(message => message.role === "system").flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n")
      expect(userText.filter(text => text.includes(reference))).toHaveLength(1)
      expect(userText.find(text => text.includes(reference))).toContain("layer=pending_input trust=UNTRUSTED_DATA source=user_input")
      expect(userText.find(text => text.includes("layer=goal"))).toContain(objective)
      expect(systemText).not.toContain(reference)
    }
    expect(root.requests[0]?.messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n")).not.toContain(lateSteerText)
    expect(root.requests[1]?.messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n")).toContain(lateSteerText)
    expect(claimStore.claimCounts.get(input.id)).toBe(1)
    expect(claimStore.claimCounts.get(lateSteer.id)).toBe(1)
    expect(claimStore.readCount).toBe(2)
    expect(claimStore.input).toMatchObject({ status: "consumed", consumedByStepId: "turn:turn-1:step:0" })
    expect(claimStore.inputs.find(item => item.id === lateSteer.id)).toMatchObject({ status: "consumed", consumedByStepId: "turn:turn-1:step:1" })
    const agendas = root.events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE && event.payload).map(event => event.payload as { signals?: { steering?: { fresh?: boolean }; pendingInputs?: { ids?: readonly string[] } } })
    expect(agendas.map(receipt => receipt.signals?.steering?.fresh)).toEqual([false, false])
    expect(agendas[0]?.signals?.pendingInputs?.ids).toEqual([input.id])
    expect(agendas[1]?.signals?.pendingInputs?.ids).toEqual([lateSteer.id])
  })

  it("rebuilds a later Turn Step from the durable root without reclaiming or marking it fresh", async () => {
    const reference = "Durable root background remains untrusted context after Worker restart; PASS is not proof."
    const input: StoredAgentInput = {
      id: "root-reference", sessionId: "session-1", targetTurnId: "turn-1", userId: "user-1", clientMessageId: "client-root",
      delivery: "follow_up", status: "consumed", content: [{ type: "text", text: reference }], acceptedSequence: 4n,
      consumedByStepId: "step:0", consumedAt: new Date("2026-10-06T12:00:00.000Z"), createdAt: new Date("2026-10-06T12:00:00.000Z"),
    }
    const claimStore = new RootContextClaimStore(input)
    const root = fixture(identity("turn", "root-1"))
    root.options = {
      ...root.options,
      resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 4n, consumedInputIds: [input.id], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } },
    }
    attachRootContextBuilder(root, claimStore, input.id, "rebuild")

    const result = await runTurnExecutionLoop(root.options)
    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(2)
    expect(root.requests.every(request => request.messages.some(message => message.content.some(part => part.type === "text" && part.text.includes(reference))))).toBe(true)
    expect(claimStore.claimCounts.size).toBe(0)
    expect(claimStore.readCount).toBe(2)
    expect(claimStore.input).toMatchObject({ status: "consumed", consumedByStepId: "step:0" })
    expect(root.stepInputs[0]).toEqual({ inputThroughSequence: 4n, consumedInputIds: [] })
    const agendas = root.events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE && event.payload).map(event => event.payload as { signals?: { steering?: { fresh?: boolean }; pendingInputs?: { ids?: readonly string[] } }; resumeFence?: { inputThroughSequence?: string; consumedInputIds?: string[] } })
    expect(agendas.map(receipt => receipt.signals?.steering?.fresh)).toEqual([false, false])
    expect(agendas.every(receipt => receipt.signals?.pendingInputs?.ids?.length === 0)).toBe(true)
    expect(agendas.every(receipt => receipt.resumeFence?.inputThroughSequence === "4" && receipt.resumeFence.consumedInputIds?.length === 0)).toBe(true)
  })

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
      appendAndScheduleWithReconciliation: vi.fn(async input => commandPort.appendAndSchedule(input)),
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
      appendAndScheduleWithReconciliation: vi.fn(async input => commandPort.appendAndSchedule(input)),
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

  it("dispatches one repeated signature after a fresh owned steer, then stops unchanged repeats", async () => {
    const root = fixture(identity("turn", "root-1")), inputStore = new LateSteerInputClaimStore()
    const turnStore = root.options.store, baseBuilder = new StepContextBuilder(inputStore)
    const executeTool = root.options.executeTool
    let builds = 0, dispatches = 0
    root.options = {
      ...root.options,
      store: { ...turnStore, startStep: async input => {
        inputStore.startStep(input.stepId, input.inputThroughSequence, input.consumedInputIds)
        return turnStore.startStep(input)
      } },
      contextBuilder: { build: async request => {
        const context = await baseBuilder.build({
          scope: request.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
          stepId: request.stepId, snapshot: request.snapshot, taskId: request.taskId, now: request.now,
          steeringMarkerState: request.steeringMarkerState,
        })
        if (++builds === 2) inputStore.acceptSteer()
        return context
      } },
      model: repeatedSearchModel(root),
      executeTool: async request => { dispatches += 1; return executeTool(request) },
    }

    const result = await runTurnExecutionLoop(root.options)
    const steeredMessages = root.requests[2]?.messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : [])).join("\n") ?? ""
    const diagnostic = root.events.find(event => event.type === "turn.no_progress")?.payload

    expect(result).toMatchObject({ status: "failed", errorCode: "no_progress", stepCount: 4, toolCallCount: 3 })
    expect(root.requests).toHaveLength(4)
    expect(dispatches).toBe(3)
    expect(steeredMessages).toContain(lateSteerText)
    expect(JSON.stringify(diagnostic)).not.toContain(lateSteerText)
    expect(JSON.stringify(diagnostic)).not.toContain("steer-539")
  })

  it("opens one repeated-signature window for a trusted TaskGraph revision change", async () => {
    const root = fixture(identity("turn", "root-1")), baseBuilder = root.options.contextBuilder
    const executeTool = root.options.executeTool
    let refreshes = 0, dispatches = 0
    const revisionsSeen: Array<number | undefined> = []
    root.options = {
      ...root.options,
      refreshTaskGraphBeforeStep: async snapshot => mergeTaskGraphCurrentObservation(snapshot, {
        revision: refreshes++ < 2 ? 0 : 1, nodes: [],
      }),
      contextBuilder: { build: async request => {
        const context = await baseBuilder.build(request)
        const taskGraphRevision = request.snapshot.taskGraphRevision
        revisionsSeen.push(taskGraphRevision)
        return { ...context, ...(taskGraphRevision === undefined ? {} : { taskGraphRevision }) }
      } },
      model: repeatedSearchModel(root),
      executeTool: async request => { dispatches += 1; return executeTool(request) },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "failed", errorCode: "no_progress", stepCount: 4, toolCallCount: 3 })
    expect(revisionsSeen).toEqual([0, 0, 1, 1])
    expect(root.requests).toHaveLength(4)
    expect(dispatches).toBe(3)
  })

  it("binds each refreshed graph revision to the same-step fresh-steering request and agenda", async () => {
    const root = fixture(identity("turn", "root-1"))
    const inputStore = new LateSteerInputClaimStore()
    const turnStore = root.options.store
    const contextBuilder = new StepContextBuilder(inputStore)
    let graphRead = 0
    let contextBuild = 0
    const refresh = vi.fn(async snapshot => mergeTaskGraphCurrentObservation(snapshot, { revision: graphRead++ === 0 ? 0 : 7, nodes: [] }))
    root.options = {
      ...root.options,
      tools: [{ name: "jobs.search", version: "1" }, { name: "agent.plan", version: "1" }, { name: "agent.followup", version: "1" }, { name: "agent.ask_user", version: "1" }],
      refreshTaskGraphBeforeStep: refresh,
      store: {
        ...turnStore,
        startStep: async input => {
          inputStore.startStep(input.stepId, input.inputThroughSequence, input.consumedInputIds)
          return turnStore.startStep(input)
        },
      },
      contextBuilder: {
        build: async request => {
          const built = await contextBuilder.build({
            scope: request.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
            stepId: request.stepId, snapshot: request.snapshot, taskId: request.taskId, now: request.now,
            steeringMarkerState: request.steeringMarkerState,
          })
          if (contextBuild++ === 0) inputStore.acceptSteer()
          return built
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)
    const secondRequest = root.requests[1]
    const instruction = secondRequest?.messages.find(message => message.role === "system" && message.content.some(part => part.type === "text" && part.text.includes("Fresh user steering")))
    const instructionText = instruction?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? ""
    const agendas = root.events.filter(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE && event.payload)

    expect(result).toMatchObject({ status: "completed", stepCount: 2 })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(instructionText).toContain("TaskGraph revision is 7")
    expect(instructionText).toContain("agent.plan with expectedRevision 7")
    expect(instructionText).not.toContain("agent.ask_user")
    expect(instructionText).toContain("state what clarification is needed")
    expect(instructionText).not.toContain(lateSteerText)
    expect(JSON.stringify(secondRequest?.messages)).toContain(lateSteerText)
    expect(agendas).toHaveLength(2)
    expect(agendas.map(event => (event.payload as { planRevision?: number | null }).planRevision)).toEqual([0, 7])
    expect(agendas[1]?.payload).toMatchObject({
      stepId: secondRequest?.metadata.stepId, goalRevision: null, planRevision: 7,
    })
  })

  it("fails before dispatch on Root refresh failure and skips refresh for child tasks", async () => {
    const root = fixture(identity("turn", "root-1"))
    const refreshFailure = new Error("task graph read unavailable")
    const refresh = vi.fn(async () => { throw refreshFailure })
    root.options = { ...root.options, refreshTaskGraphBeforeStep: refresh }
    const failed = await runTurnExecutionLoop(root.options)
    expect(failed.status).toBe("failed")
    expect(refresh).toHaveBeenCalledOnce()
    expect(root.requests).toHaveLength(0)
    expect(root.events.some(event => event.type === COGNITIVE_AGENDA_EVENT_TYPE)).toBe(false)

    const child = fixture(identity("task", "child-1", 2))
    const childRefresh = vi.fn(async snapshot => snapshot)
    child.options = { ...child.options, refreshTaskGraphBeforeStep: childRefresh }
    await expect(runTurnExecutionLoop(child.options)).resolves.toMatchObject({ status: "completed" })
    expect(childRefresh).not.toHaveBeenCalled()
    expect(child.requests).toHaveLength(2)
  })

  it("keeps child fresh input untrusted without Root plan guidance despite graph metadata", async () => {
    const child = fixture(identity("task", "child-1", 2), undefined, [{
      id: "task-graph-current", content: { kind: "task_graph_current", revision: 9, nodes: [] },
    }])
    const inputStore = new LateSteerInputClaimStore()
    const turnStore = child.options.store
    const contextBuilder = new StepContextBuilder(inputStore)
    let contextBuild = 0
    const refresh = vi.fn(async snapshot => snapshot)
    child.options = {
      ...child.options,
      snapshot: { ...child.options.snapshot, taskGraphRevision: 9 },
      refreshTaskGraphBeforeStep: refresh,
      store: {
        ...turnStore,
        startStep: async input => {
          inputStore.startStep(input.stepId, input.inputThroughSequence, input.consumedInputIds)
          return turnStore.startStep(input)
        },
      },
      contextBuilder: {
        build: async request => {
          const built = await contextBuilder.build({
            scope: request.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
            stepId: request.stepId, snapshot: request.snapshot, taskId: request.taskId, now: request.now,
            steeringMarkerState: request.steeringMarkerState,
          })
          if (contextBuild++ === 0) inputStore.acceptSteer()
          return built
        },
      },
    }

    const result = await runTurnExecutionLoop(child.options)
    const secondRequest = child.requests[1]
    const messageText = secondRequest?.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? ""

    expect(result).toMatchObject({ status: "completed", stepCount: 2 })
    expect(refresh).not.toHaveBeenCalled()
    expect(secondRequest?.messages).toBeDefined()
    expect(messageText).toContain(lateSteerText)
    expect(messageText).toContain("trust=UNTRUSTED_DATA")
    expect(messageText).not.toContain("Fresh user steering is present")
    expect(messageText).not.toContain("owner-scoped TaskGraph revision is")
    expect(messageText).not.toContain("expectedRevision 9")
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
    const denialFeedback = `${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing repair=missing`
    const gate = vi.fn(async () => {
      if (++checks > 1) return { ok: true as const }
      const denial = { ok: false as const, blocker: "task_graph_verification_unverified", feedback: denialFeedback }
      Object.defineProperty(denial, TASK_GRAPH_RECOVERY_REVISION, { value: 1, enumerable: true })
      return denial
    })
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
    expect(snapshots[2]?.system.at(-1)?.content).toContain("at graph revision 1:")
    expect(snapshots[2]?.system.at(-1)?.content).toContain("nodeOrdinal=1 criterionOrdinal=1")
    expect(root.requests[2]?.messages.some(message => message.role === "system" && JSON.stringify(message.content).includes("nodeOrdinal=1 criterionOrdinal=1"))).toBe(true)
    expect(root.events.some(event => event.type === "final.rejected")).toBe(true)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed"])
  })

  it("takes a fresh Root step after a steering reconciliation denial without charging semantic no-progress", async () => {
    let checks = 0
    const reset = vi.fn()
    const gate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => ++checks === 1
      ? ({ ok: false, blocker: STEERING_RECONCILIATION_BLOCKER, feedback: STEERING_RECONCILIATION_FEEDBACK })
      : ({ ok: true })
    gate[RESET_NATIVE_SEMANTIC_PROGRESS] = reset
    const root = fixture(identity("turn", "root-1"), undefined, [], gate)
    const build = root.options.contextBuilder.build
    root.options.contextBuilder.build = async request => {
      const context = await build(request)
      const system = request.snapshot.system.map(seed => ({ id: `system:${seed.id}`, layer: "system" as const,
        role: "instruction" as const, trust: "system" as const, source: "harness", content: seed.content as StepContext["blocks"][number]["content"] }))
      return { ...context, blocks: [...system, ...context.blocks] }
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", stepCount: 3 })
    expect(root.requests).toHaveLength(3)
    expect(JSON.stringify(root.requests[2]?.messages)).toContain(STEERING_RECONCILIATION_FEEDBACK)
    expect(JSON.stringify(root.requests[2]?.messages)).toContain("Review the current user instructions")
    expect(root.events.find(event => event.type === "final.rejected")?.payload).toMatchObject({
      code: STEERING_RECONCILIATION_BLOCKER, blocker: STEERING_RECONCILIATION_BLOCKER,
      feedback: STEERING_RECONCILIATION_FEEDBACK,
    })
    expect(root.events.some(event => event.type === "turn.no_progress" || event.type === "turn.failed")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(reset).toHaveBeenCalledOnce()
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

  it("keeps a committed semantic-receipt Step completed when its separate completion event fails", async () => {
    const root = fixture(identity("turn", "root-1"))
    let receiptStepStatus = "streaming"
    const updateStep = vi.fn(root.options.store.updateStep)
    const complete = vi.fn(async () => {
      receiptStepStatus = "completed"
      return { inputThroughSequence: 0n, distinctStepCount: 1 }
    })
    const appendEvent = root.options.store.appendEvent
    const persistEvent = vi.fn(async (input: Parameters<typeof appendEvent>[0]) => {
      if (input.type === "step.completed") throw new Error("fixture step event failure")
      return appendEvent(input)
    })
    const rejection = { candidateDigest: "a".repeat(64), controlTaskId: "control-root", controlOperationId: "operation-root",
      controlAttempt: 1, controlReportDigest: "b".repeat(64) }
    const completionGate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => ({
      ok: false, blocker: "task_graph_verification_unverified", feedback: "Independent proof rejected the candidate.",
      [NATIVE_SEMANTIC_REJECTION]: rejection,
    })
    root.options = {
      ...root.options,
      nativeSemanticProgressMode: "durable_v1",
      completionGate,
      snapshot: { ...root.options.snapshot, businessRefs: [{ id: "owned-source", kind: "job", ownerId: "user-1" }] },
      store: { ...root.options.store, updateStep, appendEvent: persistEvent, completeNativeSemanticRejectionStep: complete },
      model: {
        ...root.options.model,
        async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
          root.requests.push(request)
          yield { type: "text_delta", text: "A complete candidate." }
          yield { type: "completed", finishReason: "stop" }
        },
      },
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result.status).toBe("failed")
    expect(receiptStepStatus).toBe("completed")
    expect(complete).toHaveBeenCalledOnce()
    expect(persistEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "step.completed" }))
    expect(updateStep).not.toHaveBeenCalled()
    expect(root.stepStatuses).toEqual([])
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

  it.each([
    { label: "validated revision", recoveryFeedback: tagTaskGraphRepairRecovery(`${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing repair=missing`, 23), expectedRevision: 23 },
    { label: "missing revision", recoveryFeedback: tagTaskGraphRepairRecovery(`${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing repair=missing`, null), expectedRevision: null },
    { label: "invalid revision", recoveryFeedback: tagTaskGraphRepairRecovery(`${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing repair=missing`, null).replace('"graphRevision":null', '"graphRevision":-1'), expectedRevision: null },
  ])("recovers inside the loop when atomic TaskGraph finalization loses a race with a $label", async ({ recoveryFeedback, expectedRevision }) => {
    const root = fixture(identity("turn", "root-1"))
    const feedback = `${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing repair=missing`
    let denyOnce = true
    const persist = root.options.store.recordFinalResponse!
    root.options.store.recordFinalResponse = async input => {
      if (input.terminal && denyOnce) {
        denyOnce = false
        const recovery = Object.assign(new Error("race"), { name: "TaskGraphVerificationRecovery", blocker: "task_graph_verification_unverified", feedback })
        Object.defineProperty(recovery, "recoveryFeedback", { value: recoveryFeedback })
        throw recovery
      }
      return persist(input)
    }
    const build = root.options.contextBuilder.build
    root.options.contextBuilder.build = async request => {
      const context = await build(request)
      const system = request.snapshot.system.map(seed => ({ id: `system:${seed.id}`, layer: "system" as const,
        role: "instruction" as const, trust: "system" as const, source: "harness", content: seed.content as StepContext["blocks"][number]["content"] }))
      return { ...context, blocks: [...system, ...context.blocks] }
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", stepCount: 3 })
    expect(root.requests).toHaveLength(3)
    const nextRequest = JSON.stringify(root.requests[2]?.messages)
    if (expectedRevision === null) {
      expect(nextRequest).toContain("no validated graph revision is available")
      expect(nextRequest).toContain("no node or criterion ordinal from this denial is actionable")
      expect(nextRequest).not.toContain("nodeOrdinal=1")
    } else {
      expect(nextRequest).toContain(`at graph revision ${expectedRevision}:`)
      expect(nextRequest).toContain("These ordinals apply only to this graph revision.")
      expect(nextRequest).toContain("nodeOrdinal=1 criterionOrdinal=1")
    }
    const rejection = root.events.find(event => event.type === "final.rejected" && event.id.includes("task-graph-race"))
    expect(rejection?.payload).toEqual({ code: "business_precondition_failed", blocker: "task_graph_verification_unverified", feedback, taskId: "root-1" })
    expect(JSON.stringify(rejection)).not.toContain("task-graph-repair-recovery.v1:")
    expect(JSON.stringify(rejection)).not.toContain("graphRevision")
    expect(root.events.some(event => event.type === "turn.failed")).toBe(false)
    expect(root.events.some(event => event.type === "turn.no_progress")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed"])
  })

  it("recovers from the atomic unresolved-steering race and asks a fresh model step", async () => {
    const root = fixture(identity("turn", "root-1"))
    const reset = vi.fn()
    const completionGate: NonNullable<TurnExecutionOptions["completionGate"]> = vi.fn(async () => ({ ok: true as const }))
    completionGate[RESET_NATIVE_SEMANTIC_PROGRESS] = reset
    root.options = { ...root.options, completionGate }
    const build = root.options.contextBuilder.build
    root.options.contextBuilder.build = async request => {
      const context = await build(request)
      const system = request.snapshot.system.map(seed => ({ id: `system:${seed.id}`, layer: "system" as const,
        role: "instruction" as const, trust: "system" as const, source: "harness", content: seed.content as StepContext["blocks"][number]["content"] }))
      return { ...context, blocks: [...system, ...context.blocks] }
    }
    let denyOnce = true
    const persist = root.options.store.recordFinalResponse!
    root.options.store.recordFinalResponse = async input => {
      if (input.terminal && denyOnce) { denyOnce = false; throw steeringReconciliationRecoveryError() }
      return persist(input)
    }

    const result = await runTurnExecutionLoop(root.options)

    expect(result).toMatchObject({ status: "completed", stepCount: 3 })
    expect(root.requests).toHaveLength(3)
    expect(JSON.stringify(root.requests[2]?.messages)).toContain(STEERING_RECONCILIATION_FEEDBACK)
    expect(root.events.some(event => event.type === "final.rejected" && event.id.includes("steering-reconciliation-race"))).toBe(true)
    expect(root.events.some(event => event.type === "turn.failed" || event.type === "turn.no_progress")).toBe(false)
    expect(root.events.some(event => event.type === "turn.completed")).toBe(true)
    expect(reset).toHaveBeenCalledOnce()
    expect(root.stepStatuses).toEqual(["completed", "completed", "completed"])
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

  it("retires old denial guidance on an accepted plan and stops unchanged repeats after observing its revision", async () => {
    const root = fixture(identity("turn", "root-1"), undefined, [{ id: "seed-search", content: {
      toolCallId: "seed-search", toolName: "jobs.search", input: { location: "Dublin" }, status: "completed",
      output: { jobs: [{ id: "job-1" }] }, errorCode: null,
    } }]), inputStore = new LateSteerInputClaimStore()
    const feedback = `${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=1 criterionOrdinal=1 status=failed reasonCode=criterion_not_met`
    const humanHistory = "The user clarified that Dublin remains the preferred location for senior engineering roles."
    const verifiedNode: TaskGraphCurrentState["nodes"][number] = {
      key: "research", templateId: "scout", goal: "Find roles", successCriteria: ["Return verified links"], dependsOn: [],
      taskId: "child-research", status: "completed", readiness: "terminal", resultSummary: null, failureReason: null,
      verificationCriterionIds: ["candidate-count"], verificationReport: {
        verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
        criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }],
        evidenceDigest: "a".repeat(64), resultDigest: "e".repeat(64),
      },
    }
    let graph: TaskGraphCurrentState = { revision: 5, nodes: [verifiedNode] }, calls = 0, denials = 0, contextBuilds = 0
    const builtRevisions: Array<number | undefined> = [], dispatchedCalls: string[] = []
    const completionGate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => {
      denials += 1
      if (denials > 1) return { ok: true }
      const decision = { ok: false as const, blocker: "task_graph_verification_unverified", feedback }
      Object.defineProperty(decision, TASK_GRAPH_RECOVERY_REVISION, { value: 5, enumerable: true })
      return decision
    }
    const turnStore = root.options.store, baseBuilder = new StepContextBuilder(inputStore)
    const baseModel = root.options.model
    const beforeStep = vi.fn(async snapshot => mergeTaskGraphCurrentObservation(snapshot, graph))
    const afterPlan = vi.fn(async snapshot => {
      graph = { revision: 6, nodes: [verifiedNode] }
      return mergeTaskGraphCurrentObservation(snapshot, graph)
    })
    root.options = {
      ...root.options,
      completionGate,
      snapshot: {
        ...root.options.snapshot,
        steerHistory: [{ id: "human-clarification", content: humanHistory }],
      },
      tools: [{ name: "agent.plan", version: "1" }, { name: "jobs.search", version: "1" }],
      refreshTaskGraphBeforeStep: beforeStep,
      refreshTaskGraphAfterPlan: afterPlan,
      store: { ...turnStore, startStep: async input => {
        inputStore.startStep(input.stepId, input.inputThroughSequence, input.consumedInputIds)
        return turnStore.startStep(input)
      } },
      contextBuilder: { build: async request => {
        const context = await baseBuilder.build({
          scope: request.scope, sessionId: request.identity.sessionId, turnId: request.identity.turnId,
          stepId: request.stepId, snapshot: request.snapshot, taskId: request.taskId, now: request.now,
          steeringMarkerState: request.steeringMarkerState,
        })
        builtRevisions.push(context.taskGraphRevision)
        if (++contextBuilds === 1) inputStore.acceptSteer()
        return context
      } },
      model: { ...baseModel, async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
        root.requests.push(request)
        calls += 1
        if (calls === 1) {
          yield { type: "text_delta", text: "candidate-before-replan" }
          yield { type: "completed", finishReason: "stop" }
          return
        }
        if (calls === 2) {
          yield { type: "tool_call_completed", callId: "plan-call", name: "agent.plan", arguments: { expectedRevision: 5, nodes: [] } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "tool_call_completed", callId: `search-call-${calls}`, name: "jobs.search", arguments: { location: "Dublin" } }
        yield { type: "completed", finishReason: "tool_calls" }
      } },
      executeTool: async ({ call }) => {
        dispatchedCalls.push(call.toolName)
        return { id: call.id, toolName: call.toolName, toolVersion: "1", status: "completed",
          output: call.toolName === "agent.plan" ? { status: "accepted", revision: 6 } : { job: "job-1" }, errorCode: null }
      },
    }

    const result = await runTurnExecutionLoop(root.options)
    expect(result).toMatchObject({ status: "failed", errorCode: "no_progress", stepCount: 5, toolCallCount: 3 })
    const second = JSON.stringify(root.requests[1]?.messages).replaceAll("\\\"", "\"")
    const third = JSON.stringify(root.requests[2]?.messages).replaceAll("\\\"", "\"")
    const last = JSON.stringify(root.requests[4]?.messages).replaceAll("\\\"", "\"")
    const rejection = root.events.find(event => event.type === "final.rejected")?.payload
    const noProgress = root.events.find(event => event.type === "turn.no_progress")?.payload

    expect(root.requests).toHaveLength(5)
    expect(builtRevisions).toEqual([5, 5, 6, 6, 6])
    expect(beforeStep).toHaveBeenCalledTimes(5)
    expect(afterPlan).toHaveBeenCalledOnce()
    expect(dispatchedCalls).toEqual(["agent.plan", "jobs.search", "jobs.search"])
    expect(second).toContain(lateSteerText)
    expect(second).toContain("at graph revision 5")
    expect(second).toContain("nodeOrdinal=1")
    expect(third).toContain('"revision":6')
    expect(third).not.toContain("at graph revision 5")
    expect(third).not.toContain("nodeOrdinal=1")
    expect(third).toContain(humanHistory)
    expect(third).toContain('"verificationReport"')
    expect(third).toContain("a".repeat(64))
    expect(last).not.toContain("at graph revision 5")
    expect(last).not.toContain("nodeOrdinal=1")
    expect(rejection).toMatchObject({ feedback })
    expect(JSON.stringify(rejection)).not.toContain("task-graph-repair-recovery.v1")
    expect(JSON.stringify(noProgress)).not.toContain("task-graph-repair-recovery.v1")
    expect(JSON.stringify(root.finalResponses)).not.toContain("task-graph-repair-recovery.v1")
  })

  it("shows fixed generic recovery on the next request when the denial revision is unknown", async () => {
    const feedback = `${taskGraphFeedbackLead} issue=verification_report nodeOrdinal=8 criterionOrdinal=8 status=unverified reasonCode=canonical_evidence_missing`
    let checks = 0
    const completionGate: NonNullable<TurnExecutionOptions["completionGate"]> = async () => ++checks === 1
      ? ({ ok: false, blocker: "task_graph_verification_unverified", feedback })
      : ({ ok: true })
    const root = fixture(identity("turn", "root-1"), undefined, [], completionGate)
    const baseBuilder = root.options.contextBuilder
    root.options = {
      ...root.options,
      refreshTaskGraphBeforeStep: async snapshot => mergeTaskGraphCurrentObservation(snapshot, { revision: 4, nodes: [] }),
      contextBuilder: { build: async request => {
        const context = await baseBuilder.build(request)
        const system = request.snapshot.system.map(seed => ({ id: `system:${seed.id}`, layer: "system" as const,
          role: "instruction" as const, trust: "system" as const, source: "harness", content: seed.content as StepContext["blocks"][number]["content"] }))
        return { ...context, blocks: [...system, ...context.blocks] }
      } },
    }

    const result = await runTurnExecutionLoop(root.options)
    const nextRequest = JSON.stringify(root.requests[2]?.messages).replaceAll("\\", "")
    const rejection = root.events.find(event => event.type === "final.rejected")?.payload

    expect(result.status).toBe("completed")
    expect(root.requests).toHaveLength(3)
    expect(nextRequest).toContain("no validated graph revision is available")
    expect(nextRequest).toContain('"revision":4')
    expect(nextRequest).not.toContain("nodeOrdinal=")
    expect(nextRequest).not.toContain("criterionOrdinal=")
    expect(nextRequest).not.toContain("private-criterion")
    expect(nextRequest).not.toContain("task-graph-repair-recovery.v1")
    expect(rejection).toMatchObject({ feedback })
  })


})
