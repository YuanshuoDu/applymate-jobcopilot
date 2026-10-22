import { describe, expect, it, vi } from "vitest"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { applyCompletionRecovery, FINAL_EVIDENCE_RECOVERY_FEEDBACK, tagTaskGraphRepairRecovery } from "./completion-recovery-context.js"
import { completeTurnCandidate, persistedFinalCandidate, stopForRepeatedTaskGraphDenial } from "./turn-execution-final-candidate.js"
import type { StepContext } from "../context/step-context-builder.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import { reduceTaskGraphFinalSummary } from "../subagents/task-graph-final-summary.js"
import { formatTaskGraphFinalSummary } from "../subagents/task-graph-final-summary-format.js"
import { SCHEDULED_PIPELINE_COMPLETION, type TurnEngineCompletionGate } from "./turn-execution-types.js"

describe("persistedFinalCandidate", () => {
  it("returns only the exact content agreed by the durable item and serialized response", () => {
    const final = { schemaVersion: "agent-harness.v2.final", response: "actual final" }
    expect(persistedFinalCandidate({ text: "actual final", final }, JSON.stringify(final))).toBe("actual final")
  })

  it("rejects a swapped item body or serialized response", () => {
    const final = { schemaVersion: "agent-harness.v2.final", response: "accepted candidate" }
    expect(persistedFinalCandidate({ text: "swapped candidate", final }, JSON.stringify(final))).toBeNull()
    expect(persistedFinalCandidate({ text: "accepted candidate", final }, JSON.stringify({ ...final, response: "swapped candidate" }))).toBeNull()
  })
})

describe("atomic TaskGraph finalization recovery", () => {
  it("rejects a completed receipt from the repeated-denial terminal store", async () => {
    const recordFinalResponse = vi.fn(async () => ({ status: "completed" as const, finalItemId: "final-item", events: [] }))
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      goal: "Find a role", store: { recordFinalResponse },
    } as unknown as TurnExecutionOptions
    await expect(stopForRepeatedTaskGraphDenial({ options, writer: {} as TurnExecutionEventWriter, step: { id: "step-3", ordinal: 2 },
      context: { inputThroughSequence: 0n, consumedInputIds: [] } as unknown as StepContext, stepCount: 3, toolCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, now: () => new Date() }))
      .rejects.toMatchObject({ name: "TurnEngineError", code: "persistence_conflict" })
    expect(recordFinalResponse).toHaveBeenCalledOnce()
  })

  it("records the exact final response once only after scheduled continuation completes", async () => {
    const order: string[] = []
    const candidateText = "  The exact scheduled final.  "
    const recordFinalResponse = vi.fn(async (_input: Parameters<NonNullable<TurnExecutionOptions["store"]["recordFinalResponse"]>>[0]) => {
      order.push("terminal")
      return { status: "completed" as const, finalItemId: "final-1", events: [] }
    })
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => {
      order.push("continuation")
      return { status: "completed", candidateText: input.candidateText }
    }
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      scope: { userId: "user-1" }, goal: "Find a role", snapshot, completionGate,
      store: { updateStep: vi.fn(async () => undefined), recordFinalResponse }, idFactory: (value: string) => value,
    } as unknown as TurnExecutionOptions

    const outcome = await completeTurnCandidate({ options, writer: { append: vi.fn(async () => ({ id: "event-1" })) } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 },
      output: { text: candidateText, reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn() })

    expect(outcome).toMatchObject({ kind: "completed", result: { finalText: candidateText } })
    expect(order).toEqual(["continuation", "terminal"])
    expect(recordFinalResponse).toHaveBeenCalledTimes(1)
    const recorded = recordFinalResponse.mock.calls[0]?.[0]
    if (!recorded?.terminal) throw new Error("Expected an atomic final response to be recorded")
    expect(JSON.parse(recorded.response)).toMatchObject({ response: candidateText })
    expect(recorded.terminal.finalContent).toEqual(expect.objectContaining({ text: candidateText, final: expect.objectContaining({ response: candidateText }) }))
  })

  it("persists an exact scheduled durable wait without terminal completion", async () => {
    const waitForQuestion = vi.fn(async (input: { expectedWaitId: string }) => ({ status: "waiting_for_user" as const, disposition: "created" as const,
      waitId: input.expectedWaitId, itemId: `agent-wait:question:${input.expectedWaitId}`, turnId: "turn-1", toolCallId: null, nextTurnRevision: 5 })), recordFinalResponse = vi.fn()
    const candidateText = "  Hold this exact answer.  "
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "waiting_for_user", waitId: "wait-456", candidateText: input.candidateText })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const updateStep = vi.fn(async () => undefined), append = vi.fn(async () => ({ id: "event-1" }))
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      scope: { userId: "user-1" }, goal: "Find a role", snapshot, completionGate,
      store: { updateStep, waitForQuestion, waitForUser: vi.fn(), recordFinalResponse },
    } as unknown as TurnExecutionOptions
    const onStepClosed = vi.fn()

    const outcome = await completeTurnCandidate({ options, writer: { append } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 },
      output: { text: candidateText, reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed })

    expect(outcome).toEqual({ kind: "wait", result: { status: "waiting_for_user", waitId: "wait-456", stepCount: 1, toolCallCount: 0 } })
    expect(updateStep).not.toHaveBeenCalled()
    expect(waitForQuestion).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: null, expectedWaitId: "wait-456", finishReason: "stop",
      usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 } }))
    expect(options.store.waitForUser).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalledWith("step.completed", expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(recordFinalResponse).not.toHaveBeenCalled()
    expect(onStepClosed).toHaveBeenCalledOnce()
  })

  it("suspends on the Web Gate question without passing its ID to the Worker choice store", async () => {
    const updateStep = vi.fn(async () => undefined), waitForQuestion = vi.fn(), append = vi.fn(async () => ({ id: "event-1" }))
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "waiting_for_external_user",
      externalWaitId: "web-gate-question", scheduledWaitId: "worker-choice-question", candidateText: input.candidateText })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      scope: { userId: "user-1" }, goal: "Find a role", snapshot, completionGate,
      store: { updateStep, waitForQuestion, recordFinalResponse: vi.fn() },
    } as unknown as TurnExecutionOptions

    const outcome = await completeTurnCandidate({ options, writer: { append } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 },
      output: { text: "Exact candidate.", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn() })

    expect(outcome).toEqual({ kind: "wait", result: { status: "waiting_for_user", waitId: "web-gate-question", stepCount: 1, toolCallCount: 0 } })
    expect(updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_for_user", finishReason: "stop", errorCode: null,
      inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }))
    expect(waitForQuestion).not.toHaveBeenCalled()
    expect(append).toHaveBeenCalledWith("step.completed", "step-1", null,
      { stepId: "step-1", status: "waiting_for_user", taskId: "root-1" }, "step-completed:step-1")
  })

  it("keeps scheduled blockers waiting for dependency without inventing a user wait", async () => {
    const waitForUser = vi.fn(), recordFinalResponse = vi.fn()
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async () => ({ status: "blocked", errorCode: "scheduled_pipeline_entitlement_required" })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      scope: { userId: "user-1" }, goal: "Find a role", snapshot, completionGate,
      store: { updateStep: vi.fn(async () => undefined), waitForUser, recordFinalResponse },
    } as unknown as TurnExecutionOptions

    const outcome = await completeTurnCandidate({ options, writer: { append: vi.fn(async () => ({ id: "event-1" })) } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 },
      output: { text: "An answer.", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn() })

    expect(outcome).toEqual({ kind: "wait", result: { status: "waiting_for_dependency", errorCode: "scheduled_pipeline_entitlement_required", stepCount: 1, toolCallCount: 0 } })
    expect(waitForUser).not.toHaveBeenCalled()
    expect(recordFinalResponse).not.toHaveBeenCalled()
  })

  it("keeps the race event raw while replanning with its revision-scoped recovery envelope", async () => {
    const feedback = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing. issue=verification_report nodeOrdinal=2 criterionOrdinal=1 status=unverified reasonCode=canonical_evidence_missing"
    const recoveryFeedback = tagTaskGraphRepairRecovery(feedback, 41)
    const recoveryError = Object.assign(new Error("task_graph_verification_unverified"), {
      name: "TaskGraphVerificationRecovery", blocker: "task_graph_verification_unverified", feedback,
    })
    Object.defineProperty(recoveryError, "recoveryFeedback", { value: recoveryFeedback })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "evidence-1", kind: "artifact" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = {
      identity: { kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date("2026-09-25T10:01:00.000Z") },
      goal: "complete the task", snapshot,
      store: { updateStep: vi.fn(async () => undefined), recordFinalResponse: vi.fn(async () => { throw recoveryError }) },
      idFactory: (value: string) => value,
    } as unknown as TurnExecutionOptions
    const appended: Array<{ type: string; payload: unknown }> = []
    const writer = { append: vi.fn(async (type: string, _stepId: string, _itemId: string | null, payload: unknown) => { appended.push({ type, payload }) }) } as unknown as TurnExecutionEventWriter

    const outcome = await completeTurnCandidate({
      options, writer, step: { id: "step-1", ordinal: 0 },
      output: { text: "candidate answer", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      snapshot,
      stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal, now: () => new Date("2026-09-25T10:00:00.000Z"), onStepClosed: vi.fn(),
    })

    const rejected = appended.find(event => event.type === "final.rejected")
    expect(rejected?.payload).toEqual({ code: "business_precondition_failed", blocker: "task_graph_verification_unverified", feedback, taskId: "root-1" })
    const serializedEvent = JSON.stringify(rejected)
    expect(serializedEvent).not.toContain("task-graph-repair-recovery.v1:")
    expect(serializedEvent).not.toContain("graphRevision")
    expect(outcome).toEqual({ kind: "replan", feedback: recoveryFeedback })
    if (outcome.kind !== "replan") throw new Error("Expected atomic TaskGraph recovery to replan")

    const refreshed = applyCompletionRecovery(snapshot, "step-2", outcome.feedback)
    expect(refreshed.system).toEqual([expect.objectContaining({ id: "completion-recovery:task-graph:41" })])
    expect(refreshed.system[0]?.content).toContain("graph revision 41")
  })

  it("carries the private binding while keeping all verified response copies byte-identical", async () => {
    const summary = reduceTaskGraphFinalSummary({ graphRevision: 1, nodes: [] })
    const binding = { graphRevision: 1, summary }
    const saved: unknown[] = []
    const recordFinalResponse = vi.fn(async (input: unknown) => {
      saved.push(input)
      return { status: "completed" as const, finalItemId: "final-1", events: [] }
    })
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      goal: "Find a role",
      store: { updateStep: vi.fn(async () => undefined), recordFinalResponse },
      completionGate: vi.fn(async () => ({ ok: true as const, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding })),
      idFactory: (value: string) => value,
    } as unknown as TurnExecutionOptions
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const candidate = "Verified model candidate"

    const outcome = await completeTurnCandidate({
      options, writer: { append: vi.fn(async () => "event-1") } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 },
      output: { text: candidate, reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn(),
    })

    expect(outcome).toMatchObject({ kind: "completed", result: { finalText: candidate } })
    const recorded = saved[0] as { response: string; terminal: { finalContent: { text: string; final: { response: string; summary: string } }; [TASK_GRAPH_FINAL_SUMMARY_BINDING]?: typeof binding } }
    const serialized = JSON.parse(recorded.response) as { response: string; summary: string }
    expect(serialized.response).toBe(candidate)
    expect(serialized.summary).toBe(formatTaskGraphFinalSummary(summary))
    expect(recorded.terminal.finalContent.text).toBe(candidate)
    expect(recorded.terminal.finalContent.final.response).toBe(candidate)
    expect(recorded.terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING]).toBe(binding)
    expect(JSON.stringify(recorded)).not.toContain("task_graph_final_summary_binding")
  })

  it("replans once for an evidence-free Root final and closes its Step with usage", async () => {
    const updateStep = vi.fn(async () => undefined), appended: Array<{ type: string; payload: unknown; key?: string }> = []
    const append = vi.fn(async (type: string, _stepId: string, _itemId: string | null, payload: unknown, key?: string) => {
      appended.push({ type, payload, key }); return { id: `event-${appended.length}` }
    })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] }
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      goal: "Find a role", snapshot, tools: [{ name: "jobs.search", version: "1" }], budget: { maxSteps: 3 },
      store: { updateStep }, idFactory: (value: string) => value,
    } as unknown as TurnExecutionOptions
    const onStepClosed = vi.fn()
    const outcome = await completeTurnCandidate({
      options, writer: { append } as unknown as TurnExecutionEventWriter,
      step: { id: "step-root-1", ordinal: 0 },
      output: { text: "I found a role.", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop",
        usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 },
      signal: new AbortController().signal, now: () => new Date("2026-10-11T10:00:00.000Z"), onStepClosed,
    })

    expect(outcome).toEqual({ kind: "replan", feedback: FINAL_EVIDENCE_RECOVERY_FEEDBACK })
    expect(append).toHaveBeenCalledTimes(2)
    expect(appended[0]).toEqual({ type: "final.rejected", payload: { code: "evidence_missing",
      blocker: "No verifiable evidence is attached to the candidate final",
      feedback: "Attach verified business or tool evidence before claiming completion", taskId: "root-1" },
      key: "final-rejected:step-root-1:evidence-recovery-once" })
    expect(appended[1]?.type).toBe("step.completed")
    expect(updateStep).toHaveBeenCalledWith(expect.objectContaining({ status: "completed", finishReason: "stop", errorCode: null,
      inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }))
    expect(onStepClosed).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["a child identity", { identity: { kind: "task", taskId: "child-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", attemptCount: 1 } }],
    ["no visible evidence reader", { tools: [{ name: "agent.plan", version: "1" }] }],
    ["one remaining Step", { budget: { maxSteps: 2 } }],
    ["a previously used recovery", { resume: { nextOrdinal: 1, stepCount: 1, toolCallCount: 0, finalEvidenceRecoveryUsed: true,
      inputThroughSequence: 0n, consumedInputIds: [], usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } } }],
    ["an already-failing business check", { businessChecks: [{ name: "must_find_role", ok: false }] }],
  ])("keeps evidence-free final rejection terminal for %s", async (_name, patch) => {
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      goal: "Find a role", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      tools: [{ name: "jobs.search", version: "1" }], store: { updateStep: vi.fn(async () => undefined) }, idFactory: (value: string) => value,
      ...patch,
    } as unknown as TurnExecutionOptions
    const append = vi.fn(async () => ({ id: "event-1" }))
    await expect(completeTurnCandidate({
      options, writer: { append } as unknown as TurnExecutionEventWriter,
      step: { id: "step-root-1", ordinal: 0 },
      output: { text: "I found a role.", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      snapshot: options.snapshot, stepCount: 1, toolCallCount: 0,
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn(),
    })).rejects.toMatchObject({ code: "evidence_missing" })
    expect(append).toHaveBeenCalledTimes(1)
    expect(append).toHaveBeenCalledWith("final.rejected", "step-root-1", null, expect.objectContaining({ code: "evidence_missing" }), "final-rejected:step-root-1")
  })
})
