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

describe("current TaskGraph active child deadline advisory", () => {
  function withDeadline(status: string, deadlineAt: unknown, observedAt: unknown = "2026-11-23T12:00:00.000Z") {
    const base = loaded("ordinary"), task = base.tasks.get("child-1")!
    const liveTask = { ...task, status: status as typeof task.status, result: status === "completed" ? task.result : null, absoluteDeadlineAt: deadlineAt, deadlineObservedAt: observedAt }
    const state = taskGraphState(base.snapshot!, 2, new Map([["child-1", { status: liveTask.status, failureReason: null }]]), [])
    return currentTaskGraph({ ...base, state, tasks: new Map([["child-1", liveTask]]) })
  }

  it("projects only a future deadline for an active child outside the existing node shape", () => {
    const projected = withDeadline("running", "2026-11-23T12:30:00.000Z")
    expect(projected.activeChildDeadlines).toEqual({ revision: 2, observedAt: "2026-11-23T12:00:00.000Z",
      entries: [{ nodeKey: "scout", deadlineAt: "2026-11-23T12:30:00.000Z" }] })
    expect(projected.nodes[0]).not.toHaveProperty("absoluteDeadlineAt")
    expect(JSON.stringify(projected.activeChildDeadlines)).not.toContain("child-1")
  })

  it("keeps deadline entries in persisted graph node order independent of task row order", () => {
    const base = loaded("ordinary"), template = base.snapshot!.nodes[0]!
    const snapshot = { ...base.snapshot!, nodes: ["first", "second", "third"].map((key, index) => ({
      ...template, key, taskId: `child-${index + 1}`,
    })) }
    const task = (id: string) => ({ ...base.tasks.get("child-1")!, id, status: "running" as const, result: null,
      absoluteDeadlineAt: "2026-11-23T12:30:00.000Z", deadlineObservedAt: "2026-11-23T12:00:00.000Z" })
    const tasks = new Map([["child-3", task("child-3")], ["child-1", task("child-1")], ["child-2", task("child-2")]])
    const state = taskGraphState(snapshot, 2, new Map([...tasks].map(([id, row]) => [id, { status: row.status, failureReason: null }])), [])
    const projected = currentTaskGraph({ ...base, snapshot, state, tasks })
    expect(projected.activeChildDeadlines?.entries.map(entry => entry.nodeKey)).toEqual(["first", "second", "third"])
  })

  it.each(["queued", "running", "retrying", "waiting", "waiting_for_user"])("accepts only active status %s", status => {
    expect(withDeadline(status, "2026-11-23T12:30:00.000Z").activeChildDeadlines?.entries).toHaveLength(1)
  })

  it.each([
    ["completed", "2026-11-23T12:30:00.000Z", "2026-11-23T12:00:00.000Z"],
    ["running", "2026-11-23T11:59:59.999Z", "2026-11-23T12:00:00.000Z"],
    ["running", "not-a-date", "2026-11-23T12:00:00.000Z"],
    ["running", "2026-11-23T12:30:00.000Z", "not-a-date"],
    ["running", null, "2026-11-23T12:00:00.000Z"],
  ])("omits terminal, expired, malformed or absent deadline %s", (status, deadlineAt, observedAt) => {
    expect(withDeadline(status, deadlineAt, observedAt).activeChildDeadlines).toBeUndefined()
  })

  it("remains compatible with an older graph fixture that has no deadline columns", () => {
    expect(currentTaskGraph(loaded("ordinary")).activeChildDeadlines).toBeUndefined()
  })
})
