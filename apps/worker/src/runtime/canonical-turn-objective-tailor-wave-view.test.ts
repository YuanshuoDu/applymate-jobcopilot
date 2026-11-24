import { describe, expect, it } from "vitest"
import { projectObjectiveTailorWaveView, OBJECTIVE_TAILOR_WAVE_VIEW_SCHEMA } from "./canonical-turn-objective-tailor-wave-view.js"

function graph(slotCount = 1, correctedSlots: readonly number[] = [], sourceCount = 2) {
  const nodes: Record<string, unknown>[] = []
  for (let index = 0; index < sourceCount; index++) nodes.push({ key: `source-${index}`, templateId: index === 0 ? "scout" : "analyst",
    goal: "SOURCE_INTENT_PROSE", successCriteria: ["source criterion"], dependsOn: index === 0 ? [] : ["source-0"],
    taskId: `source-task-${index}`, verification: { private: "source proof" }, verificationCriterionIds: ["source-criterion"],
    status: "completed", readiness: "terminal", resultProjection: { jobId: "private-source-job" } })
  const slots = []
  for (let index = 1; index <= slotCount; index++) {
    const slotId = `tailor-${index}`, writerNodeKey = `writer-${index}`, reviewerNodeKey = `reviewer-${index}`
    slots.push({ slotId, sourceAnalystNodeKey: "source-1", writerNodeKey, reviewerNodeKey,
      ...(correctedSlots.includes(index) ? { correction: {
        writerNodeKey: `correction-writer-${index}`, reviewerNodeKey: `correction-reviewer-${index}`,
      } } : {}) })
    nodes.push({ key: writerNodeKey, templateId: "cover_letter_writer", goal: "PRIVATE_WRITER_TEXT", successCriteria: [],
      dependsOn: ["source-1"], taskId: `task-w-${index}`, status: "completed", readiness: "terminal", resultSummary: "PRIVATE_DRAFT" })
    nodes.push({ key: reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "PRIVATE_REVIEW_TEXT", successCriteria: [],
      dependsOn: [writerNodeKey], taskId: `task-r-${index}`, status: "completed", readiness: "terminal", resultSummary: "PRIVATE_REVIEW" })
    if (correctedSlots.includes(index)) {
      const repairWriter = `correction-writer-${index}`, repairReviewer = `correction-reviewer-${index}`
      nodes.push({ key: repairWriter, templateId: "cover_letter_writer", goal: "PRIVATE_CORRECTION_TEXT", successCriteria: [],
        dependsOn: [reviewerNodeKey], taskId: `task-cw-${index}`, status: "running", readiness: "active", resultSummary: "PRIVATE_CORRECTION" })
      nodes.push({ key: repairReviewer, templateId: "cover_letter_reviewer", goal: "PRIVATE_CORRECTION_REVIEW_TEXT", successCriteria: [],
        dependsOn: [repairWriter], taskId: `task-cr-${index}`, status: "queued", readiness: "waiting_for_dependencies" })
    }
  }
  return { revision: 42, discoveryTurnEligibility: "ordinary", objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1",
    sourceNodeCount: sourceCount, slots }, nodes }
}

describe("Objective Tailor compact current view", () => {
  it("keeps a 40-node marked graph bounded to source identity and eight exact wait pairs", () => {
    const current = graph(8, [1, 2, 3, 4, 5, 6, 7, 8], 8)
    expect(current.nodes).toHaveLength(40)
    const result = projectObjectiveTailorWaveView(current)
    expect(result.status).toBe("valid")
    if (result.status !== "valid") return
    expect(result.view).toMatchObject({ schemaVersion: OBJECTIVE_TAILOR_WAVE_VIEW_SCHEMA, graphRevision: 42,
      sourceNodeCount: 8, ordinaryPlanAppend: "closed" })
    expect(result.view.slots).toHaveLength(8)
    expect(result.view.slots[0]).toMatchObject({ slotId: "tailor-1", effectivePair: "correction",
      initial: { writer: { taskId: "task-w-1", status: "completed" }, reviewer: { taskId: "task-r-1", status: "completed" } },
      correction: { writer: { taskId: "task-cw-1", status: "running", readiness: "active" },
        reviewer: { taskId: "task-cr-1", status: "queued", readiness: "waiting_for_dependencies" } } })
    expect(JSON.stringify(result.view)).not.toMatch(/PRIVATE|jobId|artifact|hash|proof|source criterion/)
  })

  it("distinguishes an unmarked graph from a present but malformed marker", () => {
    expect(projectObjectiveTailorWaveView({ revision: 1, nodes: [] })).toEqual({ status: "absent" })
    expect(projectObjectiveTailorWaveView({ revision: 1, nodes: [], objectiveTailor: undefined })).toEqual({ status: "invalid" })
    expect(projectObjectiveTailorWaveView({ ...graph(), discoveryTurnEligibility: "scheduled" })).toEqual({ status: "invalid" })
    expect(projectObjectiveTailorWaveView({ ...graph(), discoveryTurnEligibility: undefined })).toEqual({ status: "invalid" })
    const accessor = { revision: 1, nodes: [] }
    Object.defineProperty(accessor, "objectiveTailor", { enumerable: true, get: () => undefined })
    expect(projectObjectiveTailorWaveView(accessor)).toEqual({ status: "invalid" })
  })

  it("rejects a stale revision, a malformed slot relation, and nodes beyond the closed cap", () => {
    const current = graph()
    expect(projectObjectiveTailorWaveView({ ...current, revision: 0 })).toEqual({ status: "invalid" })
    expect(projectObjectiveTailorWaveView({ ...current, objectiveTailor: { ...current.objectiveTailor,
      slots: [{ ...current.objectiveTailor.slots[0], writerNodeKey: "wrong-writer" }] } })).toEqual({ status: "invalid" })
    expect(projectObjectiveTailorWaveView({ ...graph(8, [1, 2, 3, 4, 5, 6, 7, 8], 8), nodes: [...current.nodes, ...Array(40).fill({})] }))
      .toEqual({ status: "invalid" })
    expect(projectObjectiveTailorWaveView({ ...current, nodes: current.nodes.map((node, index) => index === 2
      ? { ...node, status: "running", readiness: "terminal" } : node) })).toEqual({ status: "invalid" })
    expect(projectObjectiveTailorWaveView({ ...current, nodes: current.nodes.map((node, index) => index === 2
      ? { ...node, taskId: current.nodes[1]!.taskId } : node) })).toEqual({ status: "invalid" })
  })
})
