import { describe, expect, it } from "vitest"

import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import {
  parseTaskGraphCurrentDiscoveryAttemptHealth, parseTaskGraphCurrentDiscoveryQueryFootprint,
  projectTaskGraphDiscoveryAttemptHealth, projectTaskGraphDiscoveryAttemptQueryFootprint,
} from "./task-graph-discovery-attempt-health.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { captureDiscoveryQueryCriteria, createDiscoveryQueryFootprint } from "./child-discovery-query-footprint.js"

const verification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
}
const schema = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }
const health = {
  schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
  attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0,
  candidateCount: 0, providerFailures: 0, materializationFailures: 0, hasMore: false,
}
const sidecar = { attemptCount: 2, health }
const query = captureDiscoveryQueryCriteria({ targetRoles: ["Engineer"], targetLocations: ["Dublin"], pageSize: 10, cursor: "private-cursor" })
if (query.availability !== "captured") throw new Error("query fixture invalid")
const queryFootprint = createDiscoveryQueryFootprint([{
  criteria: query.criteria, outcome: "completed", requestCount: 1, observedCandidateCount: 2,
  providerFailures: 0, materializationFailures: 0, hasMore: false,
}])
const envelope = { role: "scout", taskType: "job_discovery", expectedOutputSchema: schema, allowedActions: ["jobs.discover"] }

function storedNode(overrides: Record<string, unknown> = {}) {
  return parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Return sourced roles"],
    dependsOn: [], depth: 1, taskId: "task-1", verification, verificationDisposition: "typed",
    registeredScoutEnvelope: envelope, ...overrides,
  }] }).nodes[0]!
}
const task = { status: "failed", role: "scout", taskType: "job_discovery", expectedOutputSchema: schema, attemptCount: 2 }

describe("TaskGraph discovery-attempt health projection", () => {
  it.each(["completed", "failed"])("projects server health for a current terminal Scout attempt (%s)", status => {
    const projected = projectTaskGraphDiscoveryAttemptHealth(storedNode(), { ...task, status }, { discoveryAttempt: sidecar })

    expect(projected).toEqual(health)
    expect(projected).not.toHaveProperty("attemptCount")
  })

  it("requires the ordinary registered discovery template, schema marker, and current lease attempt", () => {
    const base = storedNode()
    const noEnvelope = { ...base }
    delete noEnvelope.registeredScoutEnvelope
    const invalid = [
      projectTaskGraphDiscoveryAttemptHealth(storedNode(), { ...task, status: "running" }, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth(storedNode(), { ...task, role: "analyst" }, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth(storedNode(), { ...task, taskType: "selected_job_discovery" }, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth(storedNode(), { ...task, expectedOutputSchema: { ...schema, role: "analyst" } }, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth({ ...base, templateId: "analyst" } as never, task, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth(noEnvelope, task, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth(storedNode({ registeredScoutEnvelope: { ...envelope, allowedActions: ["jobs.search"] } }), task, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth({ ...base, repairOf: {} } as never, task, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth({ ...storedNode(), nativeDelegation: {} } as never, task, { discoveryAttempt: sidecar }),
      projectTaskGraphDiscoveryAttemptHealth(storedNode(), { ...task, attemptCount: 3 }, { discoveryAttempt: sidecar }),
    ]

    expect(invalid).toEqual(Array(invalid.length).fill(undefined))
  })

  it("ignores absent or malformed outer sidecars without interpreting model result fields", () => {
    expect(projectTaskGraphDiscoveryAttemptHealth(storedNode(), task, { structuredResult: { discoveryAttempt: sidecar } })).toBeUndefined()
    expect(projectTaskGraphDiscoveryAttemptHealth(storedNode(), task, { discoveryAttempt: { ...sidecar, private: "secret" } })).toBeUndefined()
    expect(projectTaskGraphDiscoveryAttemptHealth(storedNode(), task, { discoveryAttempt: sidecar, private: "not projected" })).toEqual(health)
  })

  it("revalidates health as a separate typed Scout observation and ignores hostile fields", () => {
    const row = { discoveryAttemptHealth: health, provider: "private-provider", attemptCount: 2 }
    const gate = { templateId: "scout", status: "failed", verification, native: false, nativeResult: false }

    expect(parseTaskGraphCurrentDiscoveryAttemptHealth(row, gate)).toEqual(health)
    expect(parseTaskGraphCurrentDiscoveryAttemptHealth(row, { ...gate, templateId: "analyst" })).toBeUndefined()
    expect(parseTaskGraphCurrentDiscoveryAttemptHealth(row, { ...gate, repairOf: {} })).toBeUndefined()
    expect(parseTaskGraphCurrentDiscoveryAttemptHealth({ discoveryAttemptHealth: { ...health, provider: "secret" } }, gate)).toBeUndefined()

    let reads = 0
    const accessor: Record<string, unknown> = {}
    Object.defineProperty(accessor, "discoveryAttemptHealth", { enumerable: true, get: () => { reads += 1; throw new Error("must not read") } })
    expect(parseTaskGraphCurrentDiscoveryAttemptHealth(accessor, gate)).toBeUndefined()
    expect(reads).toBe(0)
  })

  it("projects the separate current-attempt footprint only for an explicitly ordinary turn", () => {
    const base = storedNode()
    const result = { discoveryAttempt: { ...sidecar, queryFootprint } }
    expect(projectTaskGraphDiscoveryAttemptQueryFootprint(base, task, result, "ordinary")).toEqual(queryFootprint)
    expect(projectTaskGraphDiscoveryAttemptQueryFootprint(base, task, result, "scheduled")).toBeUndefined()
    expect(projectTaskGraphDiscoveryAttemptQueryFootprint(base, task, result, "unknown")).toBeUndefined()
    expect(projectTaskGraphDiscoveryAttemptQueryFootprint(base, { ...task, attemptCount: 3 }, result, "ordinary")).toBeUndefined()
    expect(projectTaskGraphDiscoveryAttemptQueryFootprint(base, task, { discoveryAttempt: { ...sidecar, queryFootprint: { ...queryFootprint, taskId: "private" } } }, "ordinary")).toBeUndefined()

    const row = { discoveryQueryFootprint: queryFootprint }
    const gate = { templateId: "scout", status: "failed", verification, native: false, nativeResult: false }
    expect(parseTaskGraphCurrentDiscoveryQueryFootprint(row, gate, "ordinary")).toEqual(queryFootprint)
    expect(parseTaskGraphCurrentDiscoveryQueryFootprint(row, gate, "scheduled")).toBeUndefined()
    expect(parseTaskGraphCurrentDiscoveryQueryFootprint(row, { ...gate, repairReceipt: {} }, "ordinary")).toBeUndefined()
    expect(parseTaskGraphCurrentDiscoveryQueryFootprint({ discoveryQueryFootprint: null }, gate, "ordinary")).toBeUndefined()
  })
})
