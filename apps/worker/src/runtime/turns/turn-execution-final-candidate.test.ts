import { describe, expect, it, vi } from "vitest"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { applyCompletionRecovery, tagTaskGraphRepairRecovery } from "./completion-recovery-context.js"
import { completeTurnCandidate, persistedFinalCandidate } from "./turn-execution-final-candidate.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "../subagents/task-graph-final-summary-binding.js"
import { reduceTaskGraphFinalSummary } from "../subagents/task-graph-final-summary.js"
import { formatTaskGraphFinalSummary } from "../subagents/task-graph-final-summary-format.js"

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
})
