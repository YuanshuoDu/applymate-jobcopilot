import { describe, expect, it, vi } from "vitest"
import type { ModelStepResult } from "./turn-engine-model.js"
import type { TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { applyCompletionRecovery, tagTaskGraphRepairRecovery } from "./completion-recovery-context.js"
import { completeTurnCandidate, persistedFinalCandidate } from "./turn-execution-final-candidate.js"

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
})
