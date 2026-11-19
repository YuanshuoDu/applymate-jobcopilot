import { describe, expect, it } from "vitest"
import { normalizeAgentLocationAllowlist } from "@jobcopilot/shared"

import { taskGraphObjectiveProgressDelta, type ObjectiveProgressSnapshot } from "../context/task-graph-objective-progress-delta.js"
import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID, TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION } from "../context/task-graph-objective-progress.js"
import type { StepContext } from "../context/step-context-builder.js"
import { buildCognitiveActionAgenda } from "./cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, type CognitiveAgendaReceiptScope } from "./cognitive-agenda-receipt.js"
import { buildCognitiveAgendaStepReceipt, cognitiveAgendaProgressDelta } from "./cognitive-agenda-progress-delta.js"

const rootScope: CognitiveAgendaReceiptScope = { sessionId: "session-1", turnId: "turn-1", taskId: "root-1", stepId: "step-1" }
const goalRevision = "a".repeat(64)
type ProgressRequirement = ObjectiveProgressSnapshot["requirements"][number]
function canonicalLocations(values: readonly string[]): readonly string[] {
  const normalized = normalizeAgentLocationAllowlist(values)
  if (!normalized) throw new Error("fixture location list should be valid")
  return normalized
}
const locationTarget = canonicalLocations([" Dublin ", "BERLIN", "dublin"])
const changedLocationTarget = canonicalLocations(["Cork", "Berlin"])
const progress = (revision: number | null, status: "active" | "reported_passed" | "unknown" = "active"): ObjectiveProgressSnapshot => ({
  schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION, advisory: true, revision,
  requirements: [{ id: "candidate-count", kind: "candidate_count_gte", minimum: 3, status }],
})
const locationRequirement = (id: string, locations: readonly string[], status: ProgressRequirement["status"] = "active"): ProgressRequirement => ({
  id, kind: "candidate_location_in", locations, status,
})
const countRequirement = (id: string, status: ProgressRequirement["status"] = "active"): ProgressRequirement => ({
  id, kind: "candidate_count_gte", minimum: 3, status,
})
const progressWith = (revision: number | null, requirements: readonly ProgressRequirement[]): ObjectiveProgressSnapshot => ({
  schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION, advisory: true, revision, requirements,
})
function context(stepId: string, snapshot?: ObjectiveProgressSnapshot, taskGraphRevision?: number): StepContext {
  return { schemaVersion: "agent-harness.v2", sessionId: rootScope.sessionId, turnId: rootScope.turnId, stepId,
    inputThroughSequence: 2n, consumedInputIds: [], canonicalJson: "{}",
    ...(taskGraphRevision === undefined ? {} : { taskGraphRevision }), blocks: snapshot ? [{
      id: TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID, layer: "tool_observation", role: "data", trust: "external_untrusted",
      source: "tool_or_subagent", content: snapshot as never,
    }] : [] }
}
function prior(snapshot = progress(1)) {
  const value = buildCognitiveAgendaReceipt({ ...rootScope, agenda: buildCognitiveActionAgenda(context(rootScope.stepId, undefined, snapshot.revision ?? undefined)),
    objectiveProgress: { goalRevision, objectiveProgressSnapshot: snapshot,
      progressDelta: taskGraphObjectiveProgressDelta(null, snapshot, false) } })
  if (!value) throw new Error("v2 receipt fixture should be valid")
  return value
}

describe("Cognitive agenda objective progress delta", () => {
  it("uses the shared location allowlist normalization for persisted targets", () => {
    expect(locationTarget).toEqual(["berlin", "dublin"])
  })

  it("builds Root v2 receipts and compares only a validated same-scope predecessor", () => {
    const current = progress(8, "reported_passed"), previous = prior()
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentSnapshot: current })
    expect(delta).toMatchObject({ availability: "available", previousPlanRevision: 1, currentPlanRevision: 8,
      requirements: [{ beforeStatus: "active", afterStatus: "reported_passed" }] })
    const receipt = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, stepId: "step-2" }, rootTaskId: "root-1",
      agenda: buildCognitiveActionAgenda(context("step-2", current, current.revision ?? undefined)),
      context: context("step-2", current, current.revision ?? undefined), previousReceipt: previous,
      objectiveProgressGoalRevision: () => goalRevision, inputThroughSequence: 3n, consumedInputIds: [] })
    expect(receipt).toMatchObject({ schemaVersion: "agent-harness.cognitive-agenda-receipt.v2", goalRevision,
      objectiveProgressSnapshot: current, progressDelta: delta })
  })

  it.each([
    ["location-only", [locationRequirement("candidate-location", locationTarget)],
      [locationRequirement("candidate-location", locationTarget, "reported_passed")]],
    ["mixed count-first", [countRequirement("candidate-count"), locationRequirement("candidate-location", locationTarget)],
      [countRequirement("candidate-count", "reported_passed"), locationRequirement("candidate-location", locationTarget, "reported_passed")]],
    ["mixed location-first", [locationRequirement("candidate-location", locationTarget), countRequirement("candidate-count")],
      [locationRequirement("candidate-location", locationTarget, "reported_passed"), countRequirement("candidate-count", "reported_passed")]],
  ] as const)("preserves real cross-step progress for %s objectives", (_name, beforeRequirements, afterRequirements) => {
    const previous = prior(progressWith(4, beforeRequirements))
    const current = progressWith(9, afterRequirements)
    const currentContext = context("step-2", current, 9)
    const receipt = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, stepId: "step-2" }, rootTaskId: "root-1",
      agenda: buildCognitiveActionAgenda(currentContext), context: currentContext, previousReceipt: previous,
      objectiveProgressGoalRevision: () => goalRevision, inputThroughSequence: 3n, consumedInputIds: [] })

    if (receipt?.schemaVersion !== "agent-harness.cognitive-agenda-receipt.v2") {
      throw new Error("location progress fixture should produce a v2 Root receipt")
    }
    expect(receipt.objectiveProgressSnapshot).toEqual(current)
    expect(receipt.progressDelta).toMatchObject({ availability: "available", previousPlanRevision: 4, currentPlanRevision: 9 })
    expect(receipt.progressDelta.requirements.map(row => [row.id, row.beforeStatus, row.afterStatus])).toEqual(
      beforeRequirements.map(row => [row.id, "active", "reported_passed"]),
    )
    expect(JSON.stringify(receipt.progressDelta)).not.toContain("berlin")
    expect(JSON.stringify(receipt.progressDelta)).not.toContain("dublin")
  })

  it.each([
    ["changed location list", locationRequirement("candidate-location", changedLocationTarget, "reported_passed")],
    ["changed location requirement identity", locationRequirement("candidate-location-new", locationTarget, "reported_passed")],
  ])("keeps %s progress unavailable with unknown prior status", (_name, currentRequirement) => {
    const previous = prior(progressWith(4, [locationRequirement("candidate-location", locationTarget)]))
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentSnapshot: progressWith(9, [currentRequirement]) })

    expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 9,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
  })

  it("makes the whole mixed delta unavailable when any location target changes", () => {
    const previous = prior(progressWith(4, [
      countRequirement("candidate-count"), locationRequirement("candidate-location", locationTarget),
    ]))
    const current = progressWith(9, [
      countRequirement("candidate-count", "reported_passed"),
      locationRequirement("candidate-location", changedLocationTarget, "reported_passed"),
    ])
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentSnapshot: current })

    expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 9,
      requirements: [
        { id: "candidate-count", beforeStatus: "unknown", afterStatus: "reported_passed" },
        { id: "candidate-location", beforeStatus: "unknown", afterStatus: "reported_passed" },
      ] })
  })

  it("keeps location progress unavailable without history and across Session identity", () => {
    const currentSnapshot = progressWith(9, [locationRequirement("candidate-location", locationTarget, "reported_passed")])
    const missing = cognitiveAgendaProgressDelta({ scope: rootScope, currentStepId: "step-2", goalRevision, currentSnapshot })
    const previous = prior(progressWith(4, [locationRequirement("candidate-location", locationTarget)]))
    const foreignSession = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: { ...rootScope, sessionId: "session-2" },
      currentStepId: "step-2", goalRevision, currentSnapshot })

    for (const delta of [missing, foreignSession]) {
      expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null,
        requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
    }
  })

  it("keeps progress unavailable when the current TaskGraph revision moves backwards", () => {
    const previous = prior(progressWith(9, [locationRequirement("candidate-location", locationTarget)]))
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentPlanRevision: 4,
      currentSnapshot: progressWith(4, [locationRequirement("candidate-location", locationTarget, "reported_passed")]) })

    expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 4,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
  })

  it("fails closed on invalid persisted location evidence", () => {
    const validPrevious = prior(progressWith(4, [locationRequirement("candidate-location", locationTarget)]))
    if (validPrevious.schemaVersion !== "agent-harness.cognitive-agenda-receipt.v2" || !validPrevious.objectiveProgressSnapshot) {
      throw new Error("fixture must contain a persisted v2 location snapshot")
    }
    const firstRequirement = validPrevious.objectiveProgressSnapshot.requirements[0]
    if (!firstRequirement) throw new Error("fixture must contain a location requirement")
    const invalidPrevious = { ...validPrevious, objectiveProgressSnapshot: {
      ...validPrevious.objectiveProgressSnapshot, requirements: [{ ...firstRequirement, extra: "unexpected" }],
    } }
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: invalidPrevious, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentSnapshot: progressWith(9, [locationRequirement("candidate-location", locationTarget, "reported_passed")]) })

    expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
  })

  it.each([
    { name: "no history", previousReceipt: undefined, scope: rootScope, currentStepId: "step-2", goalRevision },
    { name: "legacy v1", previousReceipt: buildCognitiveAgendaReceipt({ ...rootScope, agenda: buildCognitiveActionAgenda(context("step-1")) }), scope: rootScope, currentStepId: "step-2", goalRevision },
    { name: "same step", previousReceipt: prior(), scope: rootScope, currentStepId: "step-1", goalRevision },
    { name: "changed goal", previousReceipt: prior(), scope: rootScope, currentStepId: "step-2", goalRevision: "b".repeat(64) },
    { name: "cross Session", previousReceipt: prior(), scope: { ...rootScope, sessionId: "session-2" }, currentStepId: "step-2", goalRevision },
    { name: "cross Turn", previousReceipt: prior(), scope: { ...rootScope, turnId: "turn-2" }, currentStepId: "step-2", goalRevision },
    { name: "cross root", previousReceipt: prior(), scope: { ...rootScope, taskId: "root-2" }, currentStepId: "step-2", goalRevision },
  ])("marks $name history unavailable", scenario => {
    const delta = cognitiveAgendaProgressDelta({ ...scenario, currentSnapshot: progress(2) })
    expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null,
      requirements: [{ beforeStatus: "unknown", afterStatus: "active" }] })
  })

  it("keeps malformed or absent projections unavailable and does not write a hash for invalid identity", () => {
    const base = context("step-2")
    const receipt = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, stepId: "step-2" }, rootTaskId: "root-1",
      agenda: buildCognitiveActionAgenda(base), context: base, previousReceipt: { stepId: "bad" },
      objectiveProgressGoalRevision: () => "not-a-digest", inputThroughSequence: 3n, consumedInputIds: [] })
    expect(receipt).toMatchObject({ schemaVersion: "agent-harness.cognitive-agenda-receipt.v2", goalRevision: null,
      objectiveProgressSnapshot: null, progressDelta: { availability: "unavailable", requirements: [] } })
  })

  it("preserves the top-level plan revision when the current projection is absent", () => {
    const current = context("step-2", undefined, 9)
    const receipt = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, stepId: "step-2" }, rootTaskId: "root-1",
      agenda: buildCognitiveActionAgenda(current), context: current, previousReceipt: prior(),
      objectiveProgressGoalRevision: () => goalRevision, inputThroughSequence: 3n, consumedInputIds: [] })
    expect(receipt).toMatchObject({ planRevision: 9, objectiveProgressSnapshot: null,
      progressDelta: { availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 9, requirements: [] } })
  })

  it("does not compare progress when the current snapshot revision is unavailable", () => {
    const currentSnapshot = progress(null, "unknown"), current = context("step-2", currentSnapshot, 9)
    const receipt = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, stepId: "step-2" }, rootTaskId: "root-1",
      agenda: buildCognitiveActionAgenda(current), context: current, previousReceipt: prior(),
      objectiveProgressGoalRevision: () => goalRevision, inputThroughSequence: 3n, consumedInputIds: [] })
    expect(receipt).toMatchObject({ planRevision: 9, objectiveProgressSnapshot: { revision: null,
      requirements: [{ status: "unknown" }] }, progressDelta: { availability: "unavailable", previousPlanRevision: null,
      currentPlanRevision: 9, requirements: [{ beforeStatus: "unknown", afterStatus: "unknown" }] } })
  })

  it("does not compare progress with a prior snapshot whose revision is unavailable", () => {
    const previous = prior(progress(null, "unknown"))
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentPlanRevision: 9, currentSnapshot: progress(9, "reported_passed") })
    expect(delta).toMatchObject({ availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 9,
      requirements: [{ beforeStatus: "unknown", afterStatus: "reported_passed" }] })
  })

  it("downgrades a malformed null-revision projection to unavailable progress", () => {
    const malformed = context("step-2", progress(null, "active"), 9)
    const receipt = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, stepId: "step-2" }, rootTaskId: "root-1",
      agenda: buildCognitiveActionAgenda(malformed), context: malformed, previousReceipt: prior(),
      objectiveProgressGoalRevision: () => goalRevision, inputThroughSequence: 3n, consumedInputIds: [] })
    expect(receipt).toMatchObject({ planRevision: 9, objectiveProgressSnapshot: null,
      progressDelta: { availability: "unavailable", previousPlanRevision: null, currentPlanRevision: 9, requirements: [] } })
  })

  it("keeps child receipts on v1 and records unchanged progress across plan changes", () => {
    const previous = prior(progress(4)), current = progress(9)
    const delta = cognitiveAgendaProgressDelta({ previousReceipt: previous, scope: rootScope, currentStepId: "step-2",
      goalRevision, currentSnapshot: current })
    expect(delta).toMatchObject({ availability: "available", previousPlanRevision: 4, currentPlanRevision: 9,
      requirements: [{ beforeStatus: "active", afterStatus: "active" }] })
    const child = buildCognitiveAgendaStepReceipt({ scope: { ...rootScope, taskId: "child-1", stepId: "step-child" },
      rootTaskId: "root-1", agenda: buildCognitiveActionAgenda(context("step-child")), context: context("step-child"),
      objectiveProgressGoalRevision: () => goalRevision, inputThroughSequence: 3n, consumedInputIds: [] })
    expect(child?.schemaVersion).toBe("agent-harness.cognitive-agenda-receipt.v1")
  })
})
