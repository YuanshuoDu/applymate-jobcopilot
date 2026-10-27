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
})
