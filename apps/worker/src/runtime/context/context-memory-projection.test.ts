import { describe, expect, it } from "vitest"

import type { StepContextSnapshot } from "./step-context-builder.js"
import { buildContextMemoryProjection, isContextMemoryAnchorObservation } from "./context-memory-projection.js"

const base: StepContextSnapshot = {
  system: [{ id: "constraint-system", content: "Use only approved tools" }],
  profile: [],
  goal: { id: "goal-current", content: { revision: 2, objective: "Find a role" } },
  steerHistory: [{ id: "steer-2", content: "Prefer Dublin and never expose token=secret-value" }, { id: "steer-1", content: "Keep the answer concise" }],
  businessRefs: [{ id: "artifact-1", kind: "artifact", ownerId: "user-1", hash: "hash-1" }, { id: "fact-1", kind: "job", ownerId: "user-1", resource: "persona_fact" }],
  toolObservations: [
    { id: "plan-revision:plan-1", content: { kind: "plan_revision", goalRevision: 2, planRevision: 1, sequence: "10" } },
    { id: "plan-result:plan-1:join", content: { kind: "plan_command", localId: "join", status: "completed", goalRevision: 2, planRevision: 1, sequence: "11" } },
    { id: "plan-control:plan-1:join:replan", content: { kind: "plan_control", localId: "join:replan", status: "replan_required", sequence: "12" } },
    { id: "wait-result:wait-1", content: { kind: "wait_result", status: "completed", sequence: "13" } },
    { id: "approval:approval-1", content: { kind: "approval", status: "pending", sequence: "14" } },
    { id: "evidence:read-1", content: { kind: "evidence", verified: true, sequence: "15" } },
    { id: "task:child-1", content: { kind: "task", status: "failed", taskId: "child-1", sequence: "16" } },
    { id: "event:event-1", content: { kind: "event", status: "recorded", sequence: "17" } },
    { id: "context-summary:old", content: { kind: "context_summary", value: { removedObservationIds: ["old-1", "old-3"] } } },
  ],
}

describe("context memory projection", () => {
  it("projects typed anchors and durable evidence without raw text", () => {
    const projection = buildContextMemoryProjection(base)
    expect(projection).toMatchObject({
      schemaVersion: "agent-harness.cognitive-memory.v1",
      revisions: { goalRevision: 2, planRevision: 1 },
      activeGoals: [{ id: "goal-current", trust: "external_untrusted", summary: "Find a role" }],
      fixedConstraints: [{ id: "constraint-system", trust: "system" }],
      steering: [{ id: "steer-1" }, { id: "steer-2" }],
      waits: [{ id: "wait-result:wait-1", status: "completed", sequence: "13" }],
      approvals: [{ id: "approval:approval-1", status: "pending", sequence: "14" }],
      artifacts: [{ id: "artifact-1" }],
      verifiedEvidence: [{ id: "evidence:read-1" }, { id: "fact-1" }],
      taskRefs: [{ id: "task:child-1", status: "failed", sequence: "16" }],
      omittedRanges: [{ fromId: "old-1", toId: "old-3", reason: "compaction" }],
      coveredSequence: "17",
    })
    expect(JSON.stringify(projection)).not.toContain("secret-value")
  })

  it("sorts deterministically and remains stable across repeated compaction inputs", () => {
    const reversed = { ...base, steerHistory: [...base.steerHistory].reverse(), toolObservations: [...base.toolObservations].reverse() }
    expect(JSON.stringify(buildContextMemoryProjection(base))).toBe(JSON.stringify(buildContextMemoryProjection(reversed)))
  })

  it("validates and merges a prior projection deterministically within bounded input", () => {
    const prior = buildContextMemoryProjection(base)
    expect(prior).not.toBeNull()
    const current = { ...base, toolObservations: base.toolObservations.filter(item => item.id !== "context-summary:old") }
    const withPrior = { ...current, toolObservations: [{ id: "context-summary:prior", content: { kind: "context_summary", value: {}, memory: prior } }, ...current.toolObservations] }
    const first = buildContextMemoryProjection(withPrior)
    const second = buildContextMemoryProjection(withPrior)
    expect(first).not.toBeNull()
    expect(JSON.stringify(first)).toBe(JSON.stringify(second))
    expect(first?.decisions).toEqual(prior?.decisions)
  })

  it("does not expose an old goal plan revision as the current plan", () => {
    const stale = { ...base, goal: { id: "goal-new", content: { revision: 3, objective: "New goal" } }, toolObservations: [{ id: "plan-revision:old", content: { kind: "plan_revision", goalRevision: 2, planRevision: 99 } }] }
    expect(buildContextMemoryProjection(stale)).toMatchObject({ revisions: { goalRevision: 3, planRevision: null } })
  })

  it("filters active waits, approvals, and unresolved refs from superseded plans", () => {
    const observations = [
      { id: "plan-revision:plan-1", content: { kind: "plan_revision", planCallId: "plan-1", goalRevision: 2, planRevision: 1, basedOnPlanRevision: null } },
      { id: "plan-revision:plan-2", content: { kind: "plan_revision", planCallId: "plan-2", goalRevision: 2, planRevision: 2, basedOnPlanRevision: 1 } },
      { id: "wait-result:old", content: { kind: "wait_result", status: "waiting", goalRevision: 2, planRevision: 1 } },
      { id: "approval:old", content: { kind: "approval", status: "pending", goalRevision: 2, planRevision: 1 } },
      { id: "wait-result:current", content: { kind: "wait_result", status: "waiting", goalRevision: 2, planRevision: 2 } },
      { id: "approval:current", content: { kind: "approval", status: "pending", goalRevision: 2, planRevision: 2 } },
    ]
    const value = buildContextMemoryProjection({ ...base, toolObservations: observations })
    expect(value?.revisions).toEqual({ goalRevision: 2, planRevision: 2 })
    expect(value?.waits.map(item => item.id)).toEqual(["wait-result:current"])
    expect(value?.approvals.map(item => item.id)).toEqual(["approval:current"])
    expect(value?.unresolved.map(item => item.id)).toEqual(["approval:current", "wait-result:current"])
    expect(value?.unresolvedQuestions.map(item => item.sourceRef)).toEqual(["approval:current", "wait-result:current"])
  })

  it("filters stale goal references from prior and current observations while retaining legacy references", () => {
    const old = buildContextMemoryProjection({
      ...base,
      toolObservations: [
        { id: "plan-revision:old", content: { kind: "plan_revision", goalRevision: 2, planRevision: 1, sequence: "20" } },
        { id: "wait-result:old", content: { kind: "wait_result", status: "pending", goalRevision: 2, planRevision: 1, sequence: "21" } },
        { id: "approval:old", content: { kind: "approval", status: "pending", goalRevision: 2, planRevision: 1, sequence: "22" } },
        { id: "event:old", content: { kind: "event", status: "recorded", goalRevision: 2, sequence: "23" } },
        { id: "wait-result:legacy", content: { kind: "wait_result", status: "pending", sequence: "24" } },
      ],
    })
    expect(old).not.toBeNull()
    const current = buildContextMemoryProjection({
      ...base,
      goal: { id: "goal-new", content: { revision: 3, objective: "New goal" } },
      toolObservations: [
        { id: "context-summary:old", content: { kind: "context_summary", value: {}, memory: old } },
        { id: "wait-result:old-direct", content: { kind: "wait_result", status: "pending", goalRevision: 2, sequence: "25" } },
        { id: "approval:old-direct", content: { kind: "approval", status: "pending", goalRevision: 2, sequence: "26" } },
        { id: "event:old-direct", content: { kind: "event", status: "recorded", goalRevision: 2, sequence: "27" } },
        { id: "wait-result:legacy-direct", content: { kind: "wait_result", status: "pending", sequence: "28" } },
        { id: "event:legacy-direct", content: { kind: "event", status: "recorded", sequence: "29" } },
      ],
    })
    expect(current?.waits.map(item => item.id)).toEqual(["wait-result:legacy", "wait-result:legacy-direct"])
    expect(current?.approvals).toEqual([])
    expect(current?.eventRefs.map(item => item.id)).toEqual(["event:legacy-direct", "wait-result:legacy", "wait-result:legacy-direct"])
    expect(current?.unresolved.map(item => item.id)).toEqual(["wait-result:legacy", "wait-result:legacy-direct"])
  })

  it("fails closed for a future goal reference", () => {
    const future = { ...base, toolObservations: [{ id: "event:future", content: { kind: "event", status: "recorded", goalRevision: 3 } }] }
    expect(buildContextMemoryProjection(future)).toBeNull()
  })

  it("trims low priority references to a requested byte budget", () => {
    const many: StepContextSnapshot = { ...base, toolObservations: Array.from({ length: 32 }, (_, index) => ({ id: `event:event-${index}`, content: { status: "recorded", sequence: String(index) } })) }
    const projection = buildContextMemoryProjection(many, { maxBytes: 900 })
    expect(projection).not.toBeNull()
    expect(projection!.eventRefs.length).toBeLessThan(32)
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThanOrEqual(900)
  })

  it("fails closed for malformed, duplicate, or overbound snapshot input", () => {
    expect(buildContextMemoryProjection({ ...base, toolObservations: [{ id: "plan-revision:bad", content: { kind: "plan_revision", goalRevision: 0, planRevision: 1 } }] })).toBeNull()
    expect(buildContextMemoryProjection({ ...base, toolObservations: [...base.toolObservations, base.toolObservations[0]!] })).toBeNull()
    expect(buildContextMemoryProjection({ ...base, toolObservations: Array.from({ length: 257 }, (_, index) => ({ id: `event:${index}`, content: {} })) })).toBeNull()
    expect(buildContextMemoryProjection(base, { maxBytes: 255 })).toBeNull()
  })

  it("identifies plan, join, wait, approval, and task anchors for adapter retention", () => {
    expect(base.toolObservations.filter(isContextMemoryAnchorObservation).map(item => item.id)).toEqual([
      "plan-revision:plan-1", "plan-result:plan-1:join", "plan-control:plan-1:join:replan", "wait-result:wait-1", "approval:approval-1", "task:child-1", "event:event-1",
    ])
  })

  it.each(["agent.wait", "wait_subagents"] as const)("projects %s as a wait memory anchor", toolName => {
    const observation = { id: `tool-wait-${toolName}`, content: { toolName, status: "completed" } }
    const projection = buildContextMemoryProjection({ ...base, toolObservations: [observation] })

    expect(projection?.waits).toEqual([{ id: observation.id, status: "completed" }])
    expect(isContextMemoryAnchorObservation(observation)).toBe(true)
  })
})
