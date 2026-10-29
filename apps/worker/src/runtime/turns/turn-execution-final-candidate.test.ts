import { describe, expect, it, vi } from "vitest"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { applyCompletionRecovery, FINAL_EVIDENCE_RECOVERY_FEEDBACK, tagTaskGraphRepairRecovery } from "./completion-recovery-context.js"
import { completeTurnCandidate as runCompleteTurnCandidate, persistedFinalCandidate, stopForRepeatedTaskGraphDenial } from "./turn-execution-final-candidate.js"
import type { StepContext } from "../context/step-context-builder.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { buildTaskGraphFinalSummaryBinding, TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import type { GraphTaskRow, LoadedGraph } from "../subagents/task-graph-pg-state.js"
import { formatTaskGraphFinalSummary } from "../subagents/task-graph-final-summary-format.js"
import type { TaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import { SCHEDULED_PIPELINE_COMPLETION, type TurnEngineCompletionGate } from "./turn-execution-types.js"
import { TURN_SCHEDULED_GATE_CHOICE_SCHEMA, turnScheduledGateChoiceWaitId } from "./turn-question-gate-choice-contract.js"
import { TurnStateRefreshRetryError } from "./turn-execution-question.js"

type CandidateTestInput = Omit<Parameters<typeof runCompleteTurnCandidate>[0], "finalResponseText"> & { finalResponseText?: string }
function completeWithTestDefaults(input: CandidateTestInput) {
  return runCompleteTurnCandidate({ ...input, finalResponseText: input.finalResponseText ?? input.output.text })
}

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
    const candidateText = `  The exact scheduled final [[source:E-${"a".repeat(64)}]].  `
    const finalResponseText = "  The exact scheduled final [[source:S1]].  "
    const answerEvidence = { schemaVersion: 1 as const, sources: [{ key: "S1" as const, kind: "job" as const, label: "Senior Engineer", excerpt: "A bounded preview." }] }
    const gateCandidates: string[] = []
    const recordFinalResponse = vi.fn(async (_input: Parameters<NonNullable<TurnExecutionOptions["store"]["recordFinalResponse"]>>[0]) => {
      order.push("terminal")
      return { status: "completed" as const, finalItemId: "final-1", events: [] }
    })
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => {
      order.push("continuation")
      gateCandidates.push(input.candidateText)
      return { status: "completed", candidateText: input.candidateText }
    }
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      scope: { userId: "user-1" }, goal: "Find a role", snapshot, completionGate,
      store: { updateStep: vi.fn(async () => undefined), recordFinalResponse }, idFactory: (value: string) => value,
    } as unknown as TurnExecutionOptions

    const outcome = await completeWithTestDefaults({ options, writer: { append: vi.fn(async () => ({ id: "event-1" })) } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 },
      output: { text: candidateText, reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      finalResponseText, answerEvidence,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn() })

    expect(outcome).toMatchObject({ kind: "completed", result: { finalText: finalResponseText } })
    expect(gateCandidates).toEqual([candidateText])
    expect(order).toEqual(["continuation", "terminal"])
    expect(recordFinalResponse).toHaveBeenCalledTimes(1)
    const recorded = recordFinalResponse.mock.calls[0]?.[0]
    if (!recorded?.terminal) throw new Error("Expected an atomic final response to be recorded")
    const serializedFinal = JSON.parse(recorded.response) as { response?: string; answerEvidence?: unknown }
    expect(serializedFinal).toMatchObject({ response: finalResponseText, answerEvidence })
    expect(recorded.terminal.finalContent).toEqual(expect.objectContaining({ text: finalResponseText,
      final: expect.objectContaining({ response: finalResponseText, answerEvidence }) }))
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

    const outcome = await completeWithTestDefaults({ options, writer: { append } as unknown as TurnExecutionEventWriter,
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

  it("persists a private Gate choice with the current model step finish reason and usage", async () => {
    const binding = { schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA,
      owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
        executionId: "execution-1", executionAttemptCount: 4 }, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
      snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
      analyzeGraphRevision: 3, graphRevision: 5, gateTaskId: "gate-1", gateAttempt: 1, kind: "weak_cover_letter" as const,
      jobIds: ["job-1"], allowedChoiceIds: ["continue", "review", "skip"] as const }
    const waitId = turnScheduledGateChoiceWaitId(binding)!, question = "A prepared application has a weak cover letter. How should I handle it?"
    const waitForQuestion = vi.fn(async (input: { expectedWaitId?: string }) => ({ status: "waiting_for_user" as const, disposition: "created" as const,
      waitId: input.expectedWaitId!, itemId: `agent-wait:question:${input.expectedWaitId}`, turnId: "turn-1", toolCallId: null, nextTurnRevision: 6 }))
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "waiting_for_scheduled_gate_choice", waitId,
      question, binding, candidateText: input.candidateText })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = { identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() }, scope: { userId: "user-1" }, goal: "Find a role",
      snapshot, completionGate, store: { waitForQuestion, updateStep: vi.fn(), recordFinalResponse: vi.fn() } } as unknown as TurnExecutionOptions
    const output = { text: "Exact candidate.", reasoningSummary: "", toolCalls: [], provider: "fixture", model: "fixture-model",
      finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, continuation: null } satisfies ModelStepResult
    const outcome = await completeWithTestDefaults({ options, writer: { append: vi.fn(async () => ({ id: "event-1" })) } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 }, output, snapshot, stepCount: 1, toolCallCount: 0,
      usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 }, signal: new AbortController().signal,
      now: () => new Date(), onStepClosed: vi.fn() })

    expect(outcome).toEqual({ kind: "wait", result: { status: "waiting_for_user", waitId, stepCount: 1, toolCallCount: 0 } })
    expect(waitForQuestion).toHaveBeenCalledWith(expect.objectContaining({ stepId: "step-1", toolCallId: null, expectedWaitId: waitId,
      gateChoiceBinding: binding, gateChoiceQuestion: question, finishReason: "stop", usage: output.usage }))
    expect(options.store.recordFinalResponse).not.toHaveBeenCalled()
  })

  it("records the exact durable wait only for a scheduled recovery Step", async () => {
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const waitId = "scheduled-audit-wait:exact"
    const execute = async (provider: string, stepId: string) => {
      const appended: Array<{ type: string; stepId: string; payload: unknown }> = [], updates: unknown[] = []
      const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
      completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "waiting_for_dependency", waitId, candidateText: input.candidateText })
      const options = { identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1",
        turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() }, scope: { userId: "user-1" },
        goal: "Find a role", snapshot, completionGate, store: { updateStep: vi.fn(async (input: unknown) => { updates.push(input) }) } } as unknown as TurnExecutionOptions
      const outcome = await completeWithTestDefaults({ options, writer: { append: vi.fn(async (type: string, eventStepId: string,
        _itemId: string | null, payload: unknown) => { appended.push({ type, stepId: eventStepId, payload }); return { id: "event-1" } }) } as unknown as TurnExecutionEventWriter,
        step: { id: stepId, ordinal: 8 }, output: { text: "Exact candidate.", reasoningSummary: "", toolCalls: [], provider,
          model: "recovered", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
        snapshot, stepCount: 2, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn() })
      expect(outcome).toEqual({ kind: "wait", result: { status: "waiting_for_dependency", waitId, stepCount: 2, toolCallCount: 0 } })
      expect(updates[0]).toMatchObject({ stepId, status: "waiting_for_tool", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
      return appended.find(event => event.type === "step.completed")
    }
    await expect(execute("scheduled_recovery", "recovery-step-8")).resolves.toEqual({ type: "step.completed", stepId: "recovery-step-8",
      payload: { stepId: "recovery-step-8", status: "waiting_for_dependency", taskId: "root-1", waitId } })
    await expect(execute("recovered", "generic-recovery-step")).resolves.toEqual({ type: "step.completed", stepId: "generic-recovery-step",
      payload: { stepId: "generic-recovery-step", status: "waiting_for_dependency", taskId: "root-1" } })
  })

  it("refreshes when the Gate answer arrives before the private wait is inserted", async () => {
    const binding = { schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA,
      owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 2,
        executionId: "execution-1", executionAttemptCount: 4 }, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
      snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
      analyzeGraphRevision: 3, graphRevision: 5, gateTaskId: "gate-1", gateAttempt: 1, kind: "weak_cover_letter" as const,
      jobIds: ["job-1"], allowedChoiceIds: ["continue", "review", "skip"] as const }
    const waitId = turnScheduledGateChoiceWaitId(binding)!
    const completionGate: TurnEngineCompletionGate = async () => ({ ok: true })
    completionGate[SCHEDULED_PIPELINE_COMPLETION] = async input => ({ status: "waiting_for_scheduled_gate_choice", waitId,
      question: "A prepared application has a weak cover letter. How should I handle it?", binding, candidateText: input.candidateText })
    const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "job-1", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] }
    const options = { identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1",
      turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() }, scope: { userId: "user-1" }, goal: "Find a role",
      snapshot, completionGate, store: { waitForQuestion: vi.fn(async () => ({ status: "answered" as const, disposition: "replayed" as const,
        waitId, itemId: `agent-wait:question:${waitId}`, turnId: "turn-1", toolCallId: null, nextTurnRevision: 6 })) } } as unknown as TurnExecutionOptions
    await expect(completeWithTestDefaults({ options, writer: { append: vi.fn() } as unknown as TurnExecutionEventWriter,
      step: { id: "step-1", ordinal: 0 }, output: { text: "Exact candidate.", reasoningSummary: "", toolCalls: [], provider: "fixture",
        model: "fixture-model", finishReason: "stop", usage: null, continuation: null } satisfies ModelStepResult,
      snapshot, stepCount: 1, toolCallCount: 0, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      signal: new AbortController().signal, now: () => new Date(), onStepClosed: vi.fn() })).rejects.toBeInstanceOf(TurnStateRefreshRetryError)
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

    const outcome = await completeWithTestDefaults({ options, writer: { append } as unknown as TurnExecutionEventWriter,
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

    const outcome = await completeWithTestDefaults({ options, writer: { append: vi.fn(async () => ({ id: "event-1" })) } as unknown as TurnExecutionEventWriter,
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

    const outcome = await completeWithTestDefaults({
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

  it("formats current task outcomes in final.summary without changing model response or exposing private task data", async () => {
    const partialScoutResult = (jobId: string) => ({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial",
      candidates: [{ jobId, source: "private-source", url: `https://private.test/${jobId}`, evidenceIds: [`private-evidence:${jobId}`] }],
      evidence: [{ id: `private-evidence:${jobId}`, kind: "job", ref: jobId, source: "private-source" }],
      summary: "PRIVATE_TASK_PROSE_DO_NOT_RENDER",
    })
    const taskRows: GraphTaskRow[] = [
      { id: "task-private-current-scout", role: "scout", taskType: "research", status: "completed", failureReason: null,
        result: { status: "completed", structuredResult: partialScoutResult("job-private-current") } },
      { id: "task-private-repaired-scout-history", role: "scout", taskType: "research", status: "failed", failureReason: "PRIVATE_FAILURE_REASON",
        result: { status: "failed", structuredResult: partialScoutResult("job-private-history"), failureReason: "PRIVATE_FAILURE_REASON" } },
      { id: "task-private-prepare-partial", role: "prepare", taskType: "scheduled_application_prepare", status: "completed", attemptCount: 1, failureReason: null,
        result: { status: "completed", structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "partial", taskId: "task-private-prepare-partial", attemptCount: 1,
          snapshotDigest: `sha256:${"a".repeat(64)}`, checkpointDigest: "b".repeat(64),
          jobs: [{ jobId: "job-private-shared", status: "prepared" }, { jobId: "job-private-failed", status: "failed" }], materials: [] } } },
      { id: "task-private-prepare-completed", role: "prepare", taskType: "scheduled_application_prepare", status: "completed", attemptCount: 1, failureReason: null,
        result: { status: "completed", structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed", taskId: "task-private-prepare-completed", attemptCount: 1,
          snapshotDigest: `sha256:${"c".repeat(64)}`, checkpointDigest: "d".repeat(64),
          jobs: [{ jobId: "job-private-shared", status: "skipped" }, { jobId: "job-private-prepared", status: "prepared" }], materials: [] } } },
      { id: "task-private-missing-analyst", role: "analyst", taskType: "analysis", status: "failed", failureReason: "PRIVATE_FAILURE_REASON",
        result: { status: "failed", failureReason: "PRIVATE_FAILURE_REASON" } },
      { id: "task-private-invalid-reviewer", role: "reviewer", taskType: "review", status: "completed", failureReason: null,
        result: { status: "completed", structuredResult: { summary: "PRIVATE_TASK_PROSE_DO_NOT_RENDER" } } },
    ]
    const loadedGraph = {
      rootTaskId: "root-private-id",
      item: { id: "task-graph:root-private-id", revision: 41, content: {}, createdAt: new Date(0) },
      snapshot: { nodes: taskRows.map(({ id }) => ({ taskId: id })) } as unknown as TaskGraphSnapshot,
      state: { revision: 41 } as LoadedGraph["state"],
      tasks: new Map(taskRows.map(row => [row.id, row])),
    } as LoadedGraph
    const binding = buildTaskGraphFinalSummaryBinding(loadedGraph)
    if (!binding) throw new Error("Expected a current TaskGraph final-summary binding")
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
    const candidate = "The model's final answer remains exactly as generated."

    const outcome = await completeWithTestDefaults({
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
    const expectedOverview = "Recorded task outcomes (earlier attempts may be superseded; not verification): role=analyst, task state=failed, result structure=missing, reported result status=not reported: 1; role=prepare, task state=completed, result structure=valid, reported result status=completed: 1; role=prepare, task state=completed, result structure=valid, reported result status=partial: 1; role=reviewer, task state=completed, result structure=invalid, reported result status=not reported: 1; role=scout, task state=completed, result structure=valid, reported result status=partial: 1; 1 outcome group omitted."
    expect(serialized.summary).toBe(formatTaskGraphFinalSummary(binding.summary))
    expect(serialized.summary.slice(serialized.summary.indexOf("Recorded task outcomes"))).toBe(expectedOverview)
    expect(serialized.summary).toMatch(/^Task-reported results: discovered jobs: 2 observed \(partial\);/)
    expect(serialized.summary).toContain("Prepare outcome records: 4 observed (partial)")
    expect(serialized.summary).toContain("Prepare-reported outcome records (observed per task; repeated jobs may count separately; submission not verified): prepared=2, skipped=1, failed=1.")
    expect(serialized.summary.length).toBeLessThanOrEqual(1_000)
    expect(new TextEncoder().encode(serialized.summary).byteLength).toBeLessThanOrEqual(1_000)
    expect(recorded.terminal.finalContent.text).toBe(candidate)
    expect(recorded.terminal.finalContent.final.response).toBe(candidate)
    expect(recorded.terminal.finalContent.final.summary).toBe(serialized.summary)
    expect(recorded.terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING]).toBe(binding)
    for (const privateValue of ["task-private-", "job-private-", "root-private-id", "PRIVATE_TASK_PROSE_DO_NOT_RENDER", "PRIVATE_FAILURE_REASON", "private.test", "graphRevision"]) {
      expect(serialized.summary).not.toContain(privateValue)
    }
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
    const outcome = await completeWithTestDefaults({
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
    ["current evidence that conflicts with configured expected evidence", {
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [{ id: "current-role", kind: "job" as const, ownerId: "user-1" }], toolObservations: [] },
      expectedEvidence: ["expected-role"],
    }],
  ])("keeps ineligible evidence rejection terminal for %s", async (_name, patch) => {
    const options = {
      identity: { kind: "turn" as const, taskId: "root-1", rootTaskId: "root-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 1, leaseExpiresAt: new Date() },
      goal: "Find a role", snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      tools: [{ name: "jobs.search", version: "1" }], store: { updateStep: vi.fn(async () => undefined) }, idFactory: (value: string) => value,
      ...patch,
    } as unknown as TurnExecutionOptions
    const append = vi.fn(async () => ({ id: "event-1" }))
    await expect(completeWithTestDefaults({
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
