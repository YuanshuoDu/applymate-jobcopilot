import { describe, expect, it } from "vitest"

import { taskGraphObjectiveProgressDelta, type ObjectiveProgressSnapshot } from "../context/task-graph-objective-progress-delta.js"
import { TASK_GRAPH_OBJECTIVE_PROGRESS_OBSERVATION_ID, TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION } from "../context/task-graph-objective-progress.js"
import type { StepContext } from "../context/step-context-builder.js"
import { buildCognitiveActionAgenda } from "./cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, type CognitiveAgendaReceiptScope } from "./cognitive-agenda-receipt.js"
import { buildCognitiveAgendaStepReceipt, cognitiveAgendaProgressDelta } from "./cognitive-agenda-progress-delta.js"

const rootScope: CognitiveAgendaReceiptScope = { sessionId: "session-1", turnId: "turn-1", taskId: "root-1", stepId: "step-1" }
const goalRevision = "a".repeat(64)
const progress = (revision: number | null, status: "active" | "reported_passed" | "unknown" = "active"): ObjectiveProgressSnapshot => ({
  schemaVersion: TASK_GRAPH_OBJECTIVE_PROGRESS_SCHEMA_VERSION, advisory: true, revision,
  requirements: [{ id: "candidate-count", kind: "candidate_count_gte", minimum: 3, status }],
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
    { name: "no history", previousReceipt: undefined, scope: rootScope, currentStepId: "step-2", goalRevision },
    { name: "legacy v1", previousReceipt: buildCognitiveAgendaReceipt({ ...rootScope, agenda: buildCognitiveActionAgenda(context("step-1")) }), scope: rootScope, currentStepId: "step-2", goalRevision },
    { name: "same step", previousReceipt: prior(), scope: rootScope, currentStepId: "step-1", goalRevision },
    { name: "changed goal", previousReceipt: prior(), scope: rootScope, currentStepId: "step-2", goalRevision: "b".repeat(64) },
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
