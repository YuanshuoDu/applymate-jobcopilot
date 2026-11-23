import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "./role-results.js"
import { verifyCompletedTaskGraphNodeEvidence, type TaskGraphVerificationScope } from "./task-graph-pg-verification.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import { parseTaskGraphSnapshot, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { verifyTaskGraphRetainedScoutLocationProof } from "./task-graph-retained-scout-location-proof.js"

const scope: TaskGraphVerificationScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", taskId: "scout-task", attemptCount: 1,
}
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } },
    { id: "evidence-count", check: { kind: "evidence_count_gte" as const, minimum: 1 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence" as const, minimumItems: 1 } },
  ],
}
const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [{
  key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find one"], dependsOn: [], depth: 1,
  taskId: scope.taskId, verificationDisposition: "typed", verification,
}] })
const node = snapshot.nodes[0] as StoredTaskGraphNode
const structuredResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["model-job-ref"] }],
  evidence: [{ id: "model-job-ref", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one job",
}
const locationRequirement = (locations: readonly string[]) => ({
  id: "successor-location", kind: "candidate_location_in" as const, locations,
})

async function fixture(options: Readonly<{
  output?: unknown
  candidateEmpty?: boolean
  changedResultAfterProof?: boolean
  partialRoleResult?: boolean
  taskType?: string
}> = {}) {
  const result = options.candidateEmpty ? {
    ...structuredResult, candidates: [], evidence: [], summary: "No matching jobs",
  } : options.partialRoleResult ? { ...structuredResult, status: "partial" } : structuredResult
  const output = options.output ?? { jobs: [{ id: "job-1", source: "greenhouse", location: "Dublin, Ireland" }] }
  const callContent = { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null }
  const items = [
    { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1",
      joinedStepId: "step-1", rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed",
      ordinal: 0, attempt: 1, type: "tool_call", status: "completed", revision: 1, content: callContent },
    { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1",
      joinedStepId: "step-1", rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed",
      ordinal: 0, attempt: 1, type: "tool_result", status: "completed", revision: 1,
      content: { toolCallId: "call-1", output, errorCode: null } },
  ]
  const events = [
    { id: "started", itemId: "call-item", taskId: scope.taskId, correlationId: "call-1", type: "tool_call.started",
      sequence: 1, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.search" } },
    { id: "completed", itemId: "call-item", taskId: scope.taskId, correlationId: "call-1", type: "tool_call.completed",
      sequence: 2, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.search", status: "completed", errorCode: null } },
  ]
  let task: GraphTaskRow & {
    sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; turnRootTaskId: string; userId: string
    turnSource: string; turnExecutionMode: string; turnInput: unknown
  } = {
    id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    turnRootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: scope.attemptCount,
    status: "completed", role: "scout", taskType: options.taskType ?? "job_discovery", failureReason: null, userId: scope.userId,
    turnSource: "manual", turnExecutionMode: "canonical_task_graph", turnInput: {},
    result: { status: "completed", structuredResult: result },
  }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT task."id"')) return { rows: [task], rowCount: 1 }
    if (sql.includes('SELECT item."id"')) {
      const rows = items.filter(item => item.attempt === values?.[6])
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('SELECT result."sessionId"')) return { rows: [], rowCount: 0 }
    if (sql.includes('SELECT event."id"')) {
      const itemIds = Array.isArray(values?.[3]) ? values[3] as string[] : []
      const rows = events.filter(event => itemIds.includes(event.itemId))
      return { rows, rowCount: rows.length }
    }
    throw new Error("unexpected_retained_scout_query")
  })
  const client = { query } as unknown as Pick<pg.PoolClient, "query">
  const original = await verifyCompletedTaskGraphNodeEvidence(client, { scope, snapshot, node, structuredResult: result })
  const persistedResult = options.changedResultAfterProof ? { ...structuredResult, summary: "changed after proof" } : result
  task = { ...task, result: { status: "completed", structuredResult: persistedResult, taskGraphVerificationReport: original.report } }
  return { client, task, query, original }
}

describe("retained Scout location proof", () => {
  it("matches a successor location requirement using rebound receipts even without an old location criterion", async () => {
    const data = await fixture()
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope, snapshot, node, task: data.task,
      requirement: locationRequirement(["dublin, ireland"]),
    })

    expect(decision).toEqual({ status: "compatible" })
    expect(JSON.stringify(decision)).not.toContain("job-1")
    expect(JSON.stringify(decision)).not.toContain("dublin")
  })

  it("reports a known location mismatch as incompatible", async () => {
    const data = await fixture()
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope, snapshot, node, task: data.task,
      requirement: locationRequirement(["cork"]),
    })

    expect(decision).toEqual({ status: "incompatible" })
  })

  it("leaves a validated partial result unavailable when the canonical receipt binder has no partial proof", async () => {
    const data = await fixture({ partialRoleResult: true })
    expect(validateRoleResult(data.task.result && (data.task.result as Record<string, unknown>).structuredResult, "scout").status).toBe("partial")
    expect(data.original.verified).toBe(false)
    expect(data.original.projection).toBeUndefined()
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope, snapshot, node, task: data.task,
      requirement: locationRequirement(["dublin, ireland"]),
    })

    expect(decision).toEqual({ status: "unavailable" })
  })

  it("rejects a non-ordinary Scout task type", async () => {
    const data = await fixture({ taskType: "selected_job_discovery" })
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope, snapshot, node, task: data.task,
      requirement: locationRequirement(["dublin, ireland"]),
    })

    expect(decision).toEqual({ status: "unavailable" })
  })

  it("rejects malformed owner task identity", async () => {
    const data = await fixture()
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope: { ...scope, userId: " user-1 " }, snapshot, node, task: data.task,
      requirement: locationRequirement(["dublin, ireland"]),
    })

    expect(decision).toEqual({ status: "unavailable" })
  })

  it.each([
    ["missing observed location", { output: { jobs: [{ id: "job-1", source: "greenhouse" }] } }],
    ["empty retained results", { candidateEmpty: true }],
    ["changed retained result", { changedResultAfterProof: true }],
    ["conflicting observed locations", { output: { jobs: [
      { id: "job-1", source: "greenhouse", location: "Dublin" },
      { id: "job-1", source: "greenhouse", location: "Cork" },
    ] } }],
  ])("leaves %s evidence unavailable", async (_name, options) => {
    const data = await fixture(options)
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope, snapshot, node, task: data.task,
      requirement: locationRequirement(["dublin, ireland"]),
    })

    expect(decision).toEqual({ status: "unavailable" })
  })

  it("leaves a stale stored canonical report unavailable", async () => {
    const data = await fixture()
    const result = data.task.result as Record<string, unknown>
    const report = result.taskGraphVerificationReport as Record<string, unknown>
    data.task = { ...data.task, result: { ...result, taskGraphVerificationReport: { ...report, evidenceDigest: "f".repeat(64) } } }
    const decision = await verifyTaskGraphRetainedScoutLocationProof({
      client: data.client, scope, snapshot, node, task: data.task,
      requirement: locationRequirement(["dublin, ireland"]),
    })

    expect(decision).toEqual({ status: "unavailable" })
  })
})
