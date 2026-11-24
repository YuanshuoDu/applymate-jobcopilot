import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION } from "./child-discovery-query-footprint.js"
import { currentTaskGraph } from "./task-graph-pg-current-node.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphState } from "./task-graph-snapshot.js"

const footprint = {
  schemaVersion: DISCOVERY_QUERY_FOOTPRINT_SCHEMA_VERSION, availability: "available",
  calls: [{ criteria: { targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], hasCursor: false },
    outcome: "completed", requestCount: 2, observedCandidateCount: 3, providerFailures: 0, materializationFailures: 0, hasMore: false }],
} as const
const health = {
  schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION, attemptedCalls: 1, completedCalls: 1, failedCalls: 0,
  unresolvedCalls: 0, candidateCount: 3, providerFailures: 0, materializationFailures: 0, hasMore: false,
} as const
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const
const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const

function loaded(turn: "ordinary" | "scheduled" | "unknown", attemptCount = 1, sidecarAttemptCount = attemptCount): LoadedGraph {
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "scout", templateId: "scout", goal: "Find current roles", successCriteria: ["Return candidates"],
    dependsOn: [], depth: 1, taskId: "child-1", verification, verificationDisposition: "typed",
    registeredScoutEnvelope: { role: "scout", taskType: "job_discovery",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: ["jobs.discover"] },
  }] })
  const report = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) }
  const task = { id: "child-1", status: "completed" as const, role: "scout", taskType: "job_discovery",
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: ["jobs.discover"], attemptCount,
    failureReason: null, result: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [],
      taskGraphVerificationReport: report, discoveryAttempt: { attemptCount: sidecarAttemptCount, health, queryFootprint: footprint } } }
  const state = taskGraphState(snapshot, 2, new Map([[task.id, { status: task.status, failureReason: task.failureReason }]]), [])
  return { rootTaskId: "root-1", snapshot, item: { id: "task_graph:root-1", revision: 2, content: snapshot, createdAt: new Date(0) },
    state, tasks: new Map([[task.id, task]]), discoveryTurnEligibility: turn }
}

function objectiveWaveLoaded(): LoadedGraph {
  const marker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2,
    slots: [{ slotId: "tailor-1", sourceAnalystNodeKey: "analyst", writerNodeKey: "writer", reviewerNodeKey: "reviewer" }] }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, objectiveTailor: marker, nodes: [
    { key: "scout", templateId: "scout", goal: "Find roles", successCriteria: ["Return candidates"], dependsOn: [], depth: 1,
      taskId: "scout-task", verification, verificationDisposition: "typed" },
    { key: "analyst", templateId: "analyst", goal: "Analyze source", successCriteria: ["Analyze candidates"], dependsOn: ["scout"], depth: 2,
      taskId: "analyst-task", verification: analystVerification, verificationDisposition: "typed" },
    { key: "writer", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Save draft"], dependsOn: ["analyst"], depth: 3,
      taskId: "writer-task", verificationDisposition: "specialized" },
    { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review exact draft"], dependsOn: ["writer"], depth: 4,
      taskId: "reviewer-task", verificationDisposition: "specialized" },
  ] })
  const tasks = new Map([
    ["scout-task", { id: "scout-task", status: "queued", role: "scout", taskType: "job_discovery", failureReason: null, result: null }],
    ["analyst-task", { id: "analyst-task", status: "queued", role: "analyst", taskType: "job_analysis", failureReason: null, result: null }],
    ["writer-task", { id: "writer-task", status: "queued", role: "writer", taskType: "cover_letter_draft", failureReason: null, result: null }],
    ["reviewer-task", { id: "reviewer-task", status: "queued", role: "reviewer", taskType: "cover_letter_review", failureReason: null, result: null }],
  ] as const)
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status as "queued", failureReason: null }]))
  const state = taskGraphState(snapshot, 2, statuses, [])
  return { rootTaskId: "root-1", snapshot, item: { id: "task-graph:root-1", revision: 2, content: snapshot, createdAt: new Date(0) },
    state, tasks, discoveryTurnEligibility: "ordinary" }
}

describe("current TaskGraph query footprint projection", () => {
  it("exposes the strict current Scout footprint only for an ordinary owner Turn", () => {
    const ordinary = currentTaskGraph(loaded("ordinary"))
    expect(ordinary.discoveryTurnEligibility).toBe("ordinary")
    expect(ordinary.nodes[0]?.discoveryQueryFootprint).toEqual(footprint)
    for (const turn of ["scheduled", "unknown"] as const) {
      const projected = currentTaskGraph(loaded(turn))
      expect(projected).not.toHaveProperty("discoveryTurnEligibility")
      expect(projected.nodes[0]).not.toHaveProperty("discoveryQueryFootprint")
    }
  })

  it("omits the query footprint when its sidecar belongs to a different attempt", () => {
    const projected = currentTaskGraph(loaded("ordinary", 2, 1))
    expect(projected).not.toHaveProperty("discoveryTurnEligibility")
    expect(projected.nodes[0]).not.toHaveProperty("discoveryQueryFootprint")
  })

  it("returns only an exact owner-read Objective Tailor marker and rejects task-role drift", () => {
    const current = objectiveWaveLoaded(), projection = currentTaskGraph(current)
    expect(projection.objectiveTailor).toEqual(current.snapshot?.objectiveTailor)
    expect(projection.revision).toBe(current.item?.revision)
    expect(projection.discoveryTurnEligibility).toBe("ordinary")
    const tasks = new Map(current.tasks)
    tasks.set("writer-task", { ...tasks.get("writer-task")!, role: "reviewer" })
    expect(() => currentTaskGraph({ ...current, tasks })).toThrow("task_graph_objective_tailor_current_invalid")
  })

  it("rejects a present marker missing from the state or a source plan projection mismatch", () => {
    const current = objectiveWaveLoaded()
    const { objectiveTailor: _marker, ...stateWithoutMarker } = current.state!
    expect(() => currentTaskGraph({ ...current, state: stateWithoutMarker as LoadedGraph["state"] }))
      .toThrow("task_graph_objective_tailor_current_invalid")
    const mutatedState = { ...current.state!, nodes: current.state!.nodes.map((node, index) => index === 1 ? { ...node, goal: "Changed source goal" } : node) }
    expect(() => currentTaskGraph({ ...current, state: mutatedState })).toThrow("task_graph_objective_tailor_current_invalid")
  })

  it("rejects a marked graph outside ordinary owner-read eligibility", () => {
    expect(() => currentTaskGraph({ ...objectiveWaveLoaded(), discoveryTurnEligibility: "scheduled" }))
      .toThrow("task_graph_objective_tailor_current_invalid")
  })
})
