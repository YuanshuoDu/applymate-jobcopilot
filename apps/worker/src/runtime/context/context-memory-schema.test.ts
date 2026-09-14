import { describe, expect, it } from "vitest"

import type { StepContextSnapshot } from "./step-context-builder.js"
import { buildContextMemoryProjection } from "./context-memory-projection.js"
import { deriveContextMemoryNarrative, validateContextMemoryProjection } from "./context-memory-schema.js"

const snapshot: StepContextSnapshot = {
  system: [], profile: [], goal: { id: "goal-2", content: { revision: 2, objective: "Find a role" } }, steerHistory: [], businessRefs: [],
  toolObservations: [
    { id: "plan-revision:plan-1", content: { kind: "plan_revision", goalRevision: 2, planRevision: 4, sequence: "4" } },
    { id: "plan-control:plan-1:join:replan", content: { kind: "plan_control", localId: "join:replan", status: "replan_required", reason: "child_failure", sequence: "5" } },
    { id: "wait-result:wait-1", content: { kind: "wait_result", status: "waiting", goalRevision: 2, planRevision: 4, sequence: "6" } },
  ],
}

function projection(): NonNullable<ReturnType<typeof buildContextMemoryProjection>> {
  const value = buildContextMemoryProjection(snapshot)
  if (!value) throw new Error("fixture projection should be valid")
  return value
}

describe("context memory schema", () => {
  it("derives traceable decisions and unresolved questions for the current goal", () => {
    const value = projection()
    expect(value.decisions).toEqual([{ id: "decision:plan-revision:plan-1", summary: "Accepted plan revision 4 for goal revision 2", sourceRef: "plan-revision:plan-1", goalRevision: 2, planRevision: 4 }])
    expect(value.unresolvedQuestions).toEqual([{ id: "question:wait-result:wait-1", summary: "A child task result is still pending", sourceRef: "wait-result:wait-1", goalRevision: 2, planRevision: 4 }])
    expect(validateContextMemoryProjection(value)).toEqual(value)
  })

  it("accepts a legacy projection without the new fields as empty arrays", () => {
    const value = projection()
    const legacy = { ...value } as unknown as Record<string, unknown>
    delete legacy.decisions
    delete legacy.unresolvedQuestions
    expect(validateContextMemoryProjection(legacy)).toMatchObject({ decisions: [], unresolvedQuestions: [] })
  })

  it.each([
    { label: "nested summary", change: (value: ReturnType<typeof projection>) => ({ ...value, activeGoals: [{ ...value.activeGoals[0]!, summary: { text: "nested" } }] }) },
    { label: "duplicate ids", change: (value: ReturnType<typeof projection>) => ({ ...value, eventRefs: [{ id: "event:a" }, { id: "event:a" }] }) },
    { label: "unsorted ids", change: (value: ReturnType<typeof projection>) => ({ ...value, steering: [{ id: "z", trust: "external_untrusted" as const }, { id: "a", trust: "external_untrusted" as const }] }) },
    { label: "future sequence", change: (value: ReturnType<typeof projection>) => ({ ...value, eventRefs: [{ id: "event:future", sequence: "7" }] }) },
    { label: "oversized summary", change: (value: ReturnType<typeof projection>) => ({ ...value, activeGoals: [{ id: "goal-2", trust: "external_untrusted" as const, summary: "x".repeat(161) }] }) },
    { label: "future narrative", change: (value: ReturnType<typeof projection>) => ({ ...value, decisions: [{ ...value.decisions[0]!, goalRevision: 3 }] }) },
  ])("fails closed for $label", ({ change }) => {
    expect(validateContextMemoryProjection(change(projection()), { expectedGoalRevision: 2 })).toBeNull()
  })

  it("fails closed when the canonical projection exceeds its byte budget", () => {
    expect(validateContextMemoryProjection(projection(), { maxBytes: 256 })).toBeNull()
  })

  it("isolates stale narrative evidence from a newer goal revision", () => {
    const stale = deriveContextMemoryNarrative(snapshot.toolObservations, 3)
    expect(stale).toEqual({ decisions: [], unresolvedQuestions: [] })
  })

  it("filters stale narrative carried by a prior compacted projection", () => {
    const old = buildContextMemoryProjection({
      ...snapshot,
      goal: { id: "goal-1", content: { revision: 1, objective: "Old goal" } },
      toolObservations: [
        { id: "plan-revision:old-plan", content: { kind: "plan_revision", goalRevision: 1, planRevision: 99, sequence: "1" } },
        { id: "wait-result:old-wait", content: { kind: "wait_result", status: "waiting", goalRevision: 1, planRevision: 99, sequence: "2" } },
      ],
    })
    expect(old).not.toBeNull()
    const current = buildContextMemoryProjection({
      ...snapshot,
      toolObservations: [{ id: "context-summary:old", content: { kind: "context_summary", value: {}, memory: old } }, ...snapshot.toolObservations],
    })
    expect(current?.decisions.map(item => item.sourceRef)).toEqual(["plan-revision:plan-1"])
    expect(current?.unresolvedQuestions.map(item => item.sourceRef)).toEqual(["wait-result:wait-1"])
  })

  it("rejects a malformed new field instead of treating it as absent", () => {
    expect(validateContextMemoryProjection({ ...projection(), decisions: null })).toBeNull()
  })
})
