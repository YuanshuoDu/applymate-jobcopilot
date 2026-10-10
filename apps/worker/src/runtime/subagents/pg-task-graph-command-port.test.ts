import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import type { TaskGraphNativeCommandInput, TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { taskGraphFingerprint, taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"
import type { PgSubagentPool } from "./types.js"
import type { TaskGraphNodeProposal } from "../planning/task-graph.js"

const reconciliationMocks = vi.hoisted(() => ({
  prepare: vi.fn(), write: vi.fn(), create: vi.fn(), writePlan: vi.fn(), assertNoUnresolvedSteering: vi.fn(),
}))
vi.mock("./steering-reconciliation-ledger.js", () => ({
  prepareSteeringReconciliation: reconciliationMocks.prepare,
  writeSteeringReconciliationReceipt: reconciliationMocks.write,
  assertNoUnresolvedSteering: reconciliationMocks.assertNoUnresolvedSteering,
}))
vi.mock("./task-graph-pg-create.js", () => ({ createGraphTasks: reconciliationMocks.create }))
vi.mock("./task-graph-pg-events.js", () => ({
  appendTaskGraphReceipt: vi.fn(async () => undefined), writeTaskGraphSnapshot: vi.fn(async () => undefined),
  writePlanReceipt: reconciliationMocks.writePlan,
}))

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryCall = { sql: string; values: readonly unknown[] }
type Fence = "session" | "turn" | "parent"
type FakePoolOptions = {
  failFence?: Fence
  includeReplay?: boolean
  missingGraph?: boolean
  persistedPlanReceipt?: boolean
  allowedActions?: unknown
  graphContent?: unknown
  graphRevision?: number
  taskRows?: Array<Record<string, unknown>>
}

const empty: QueryResult = { rows: [], rowCount: 0 }

function scheduleInput(expectedRevision = 1): TaskGraphScheduleInput {
  return {
    scope: {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "parent-owner", parentAttemptCount: 2,
    },
    proposal: {
      expectedRevision,
      nodes: [{ key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"], dependsOn: [] }],
    },
    templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
  }
}

function fakePool(input: TaskGraphScheduleInput, options: FakePoolOptions = {}) {
  const calls: QueryCall[] = []
  const itemId = taskGraphItemId(input.scope.parentTaskId)
  const snapshot = {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"],
      dependsOn: [], depth: 1, taskId: "child-1",
    }],
  }
  const graphContent = options.graphContent ?? snapshot
  const graphRevision = options.graphRevision ?? 2
  const taskRows = options.taskRows ?? [{ id: "child-1", status: "queued", role: "analyst", taskType: "research", failureReason: null, result: null }]
  const replayPayload = {
    kind: "proposal",
    fingerprint: taskGraphFingerprint(input.proposal),
    receipt: { revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
  }
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return empty
      if (sql.startsWith("SELECT set_config")) return empty
      if (sql.startsWith('SELECT "id" FROM "agent_sessions"')) {
        return options.failFence === "session" ? empty : { rows: [{ id: input.scope.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT session."id" FROM "agent_sessions"')) {
        return { rows: [{ id: input.scope.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_turns"')) {
        return options.failFence === "turn" ? empty : { rows: [{ id: input.scope.turnId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task.*, session."userId" AS "userId"')) {
        return options.failFence === "parent" ? empty : { rows: [{ id: input.scope.parentTaskId, budgetSnapshot: {}, allowedActions: options.allowedActions ?? ["agent.plan"] }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_steps"')) {
        return { rows: [{ id: input.scope.stepId }], rowCount: 1 }
      }
      if (sql.startsWith("WITH wall_clock AS MATERIALIZED")) {
        return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT item."id"')) return options.missingGraph
        ? empty
        : { rows: [{ id: itemId, revision: graphRevision, content: graphContent, createdAt: new Date("2026-09-20T12:00:00.000Z") }], rowCount: 1 }
      if (sql.startsWith('SELECT task."id", task."status"')) {
        return { rows: taskRows, rowCount: taskRows.length }
      }
      if (sql.startsWith('SELECT event."payload"')) {
        if (values.length === 5 && options.includeReplay !== false) return { rows: [{ payload: replayPayload }], rowCount: 1 }
        return empty
      }
      if (sql.startsWith("SELECT EXISTS (") && sql.includes('FROM "agent_items"')) {
        return { rows: [{ exists: options.missingGraph !== true }], rowCount: 1 }
      }
      if (sql.startsWith("SELECT EXISTS (")) return { rows: [{ exists: options.persistedPlanReceipt === true }], rowCount: 1 }
      return empty
    }),
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as PgSubagentPool
  return { pool, calls, client }
}

function invalidSelectorProposal(kind: "unknown" | "indirect" | "wrong-template" | "native"): { input: TaskGraphScheduleInput; graphContent: unknown; taskRows?: Array<Record<string, unknown>> } {
  const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate_count", check: { kind: "candidate_count_gte", minimum: 1 } }] } as const
  const analystVerification = (dependencyNodeKey: string) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey } }] } as const)
  const unaryAnalyst = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "finding_count", check: { kind: "finding_count_gte", minimum: 1 } }] } as const
  const scout: TaskGraphNodeProposal = { key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], verification: scoutVerification }
  const analyst = (key: string, dependency: string, selector: string): TaskGraphNodeProposal => ({
    key, templateId: "analyst", goal: "Check findings", successCriteria: ["Findings checked"], dependsOn: [dependency], verification: analystVerification(selector),
  })
  let nodes: readonly TaskGraphNodeProposal[]
  let graphContent: unknown = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }
  let taskRows: Array<Record<string, unknown>> = []
  if (kind === "unknown") nodes = [scout, analyst("analyst", "scout", "missing")]
  else if (kind === "indirect") nodes = [scout, { key: "middle", templateId: "analyst", goal: "Intermediate", successCriteria: ["Intermediate"], dependsOn: ["scout"], verification: unaryAnalyst }, analyst("analyst", "middle", "scout")]
  else if (kind === "wrong-template") nodes = [{ key: "other-analyst", templateId: "analyst", goal: "Other analyst", successCriteria: ["Other"], dependsOn: [], verification: unaryAnalyst }, analyst("analyst", "other-analyst", "other-analyst")]
  else {
    const nativeMetadata = { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-operation", requestFingerprint: "a".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "job_discovery", contextDigest: "b".repeat(64), contextBytes: 0 }
    graphContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "native-source", taskId: "native-task", templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID,
      goal: "Native child", successCriteria: [], dependsOn: [], depth: 1, verificationDisposition: "legacy_unverified", nativeDelegation: nativeMetadata }] }
    taskRows = [{ id: "native-task", status: "queued", role: "scout", taskType: "job_discovery", failureReason: null, result: null }]
    nodes = [analyst("analyst", "native-source", "native-source")]
  }
  const base = scheduleInput(1)
  return { graphContent, taskRows, input: { ...base, proposal: { expectedRevision: 1, nodes }, templates: {
    scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
    analyst: { role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.search"] },
  } } }
}

describe("createPgTaskGraphCommandPort", () => {
  beforeEach(() => { vi.clearAllMocks() })
  it.each(["unknown", "indirect", "wrong-template", "native"] as const)("rejects a %s cross-node selector before creating tasks or writing receipts", async kind => {
    const invalid = invalidSelectorProposal(kind)
    const fake = fakePool(invalid.input, { includeReplay: false, graphRevision: 1, graphContent: invalid.graphContent, taskRows: invalid.taskRows })
    const { createGraphTasks } = await vi.importActual<typeof import("./task-graph-pg-create.js")>("./task-graph-pg-create.js")
    reconciliationMocks.create.mockImplementationOnce(createGraphTasks)

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(invalid.input)).rejects.toThrow("task_graph_snapshot_verification_dependency_invalid")
    expect(reconciliationMocks.create).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
  })

  it("keeps a missing graph pristine when no durable proposal receipt exists", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrent(scope)).resolves.toEqual({ revision: 0, nodes: [] })
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(true)
  })

  it("reloads graph state through the caller-owned client without opening another transaction", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false })
    const { stepId: _stepId, ...scope } = input.scope
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope)).resolves.toMatchObject({ revision: 2 })
    expect(fake.pool.connect).not.toHaveBeenCalled()
    expect(fake.calls.some(call => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false)
    expect(fake.calls.find(call => call.sql.startsWith("SELECT set_config"))?.values).toEqual([input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"'))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(true)
  })

  it("derives counts from the same owner-scoped LoadedGraph without another SELECT", async () => {
    const input = scheduleInput()
    const nodes = [
      ["scout-a", "scout", "scout"], ["scout-b", "scout", "scout"],
      ["analyst-a", "analyst", "analyst"], ["analyst-b", "analyst", "analyst"],
    ] as const
    const graphContent = {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: nodes.map(([key, role, templateId]) => ({
        key, templateId, goal: `Run ${role}`, successCriteria: ["Persist facts"], dependsOn: [], depth: 1, taskId: key,
      })),
    }
    const envelope = (structuredResult: unknown) => ({ status: "completed", finalText: "PRIVATE_FINAL_TEXT", structuredResult })
    const scout = (jobIds: readonly string[]) => ({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: jobIds.map(jobId => ({ jobId, source: "greenhouse", url: `https://private.example/${jobId}`, evidenceIds: [`evidence:${jobId}`] })),
      evidence: jobIds.map(jobId => ({ id: `evidence:${jobId}`, kind: "job", ref: jobId, source: "private-source" })),
      summary: "PRIVATE_SCOUT_SUMMARY",
    })
    const analyst = (findings: readonly Readonly<{ jobId: string; score: number }>[]) => {
      const jobIds = [...new Set(findings.map(finding => finding.jobId))]
      return {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
        findings: findings.map(finding => ({ ...finding, evidenceIds: [`analysis:${finding.jobId}`] })),
        evidence: jobIds.map(jobId => ({ id: `analysis:${jobId}`, kind: "job", ref: jobId, source: "private-source" })),
        summary: "PRIVATE_ANALYST_SUMMARY",
      }
    }
    const taskRows = [
      { id: "scout-a", role: "scout", taskType: "job_discovery", candidates: ["job-1", "job-2", "job-3", "job-4", "job-5"] },
      { id: "scout-b", role: "scout", taskType: "job_discovery", candidates: ["job-4", "job-5", "job-6"] },
      { id: "analyst-a", role: "analyst", taskType: "job_analysis", findings: [
        { jobId: "job-1", score: 7 }, { jobId: "job-2", score: 8 }, { jobId: "job-3", score: 6 },
        { jobId: "job-2", score: 8 }, { jobId: "job-4", score: 5 },
      ] },
      { id: "analyst-b", role: "analyst", taskType: "job_analysis", findings: [
        { jobId: "job-2", score: 9 }, { jobId: "job-5", score: 4 }, { jobId: "job-6", score: 3 },
      ] },
    ].map(task => ({
      id: task.id, role: task.role, taskType: task.taskType, status: "completed", failureReason: null,
      result: envelope(task.role === "scout" ? scout(task.candidates!) : analyst(task.findings!)),
    }))
    const fake = fakePool(input, { includeReplay: false, graphContent, graphRevision: 8, taskRows })
    const { stepId: _stepId, ...scope } = input.scope

    const current = await createPgTaskGraphCommandPort(fake.pool).readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope)

    expect(current.revision).toBe(8)
    expect(current.planningFacts).toEqual({
      graphRevision: 8,
      counts: {
        discoveredJobs: { knownCount: 6, coverage: "complete" },
        analyzedJobs: { knownCount: 6, coverage: "complete" },
        artifactReferences: { knownCount: null, coverage: "not_requested" },
        reviewOutcomes: { knownCount: null, coverage: "not_requested" },
      },
    })
    expect(JSON.stringify(current.planningFacts)).not.toContain("job-1")
    expect(JSON.stringify(current.planningFacts)).not.toContain("private.example")
    expect(JSON.stringify(current.planningFacts)).not.toContain("PRIVATE_")
    expect(fake.pool.connect).not.toHaveBeenCalled()
    expect(fake.calls.some(call => ["BEGIN", "COMMIT", "ROLLBACK"].includes(call.sql))).toBe(false)
    const itemRead = fake.calls.filter(call => call.sql.startsWith('SELECT item."id"'))
    const taskRead = fake.calls.filter(call => call.sql.startsWith('SELECT task."id", task."status"'))
    const eventRead = fake.calls.filter(call => call.sql.startsWith('SELECT event."type"'))
    expect(itemRead).toHaveLength(1)
    expect(itemRead[0]?.values).toEqual([taskGraphItemId(input.scope.parentTaskId), input.scope.sessionId,
      input.scope.turnId, input.scope.parentTaskId, input.scope.userId])
    expect(taskRead).toHaveLength(1)
    expect(taskRead[0]?.values).toEqual([nodes.map(([key]) => key), input.scope.sessionId, input.scope.turnId,
      input.scope.rootTaskId, input.scope.parentTaskId, input.scope.userId])
    expect(eventRead).toHaveLength(1)
  })

  it("reads one current typed result page under the existing owner fence and one graph load", async () => {
    const input = scheduleInput()
    const graphContent = {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ key: "planned", templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"],
        dependsOn: [], depth: 1, taskId: "child-1" }],
    }
    const jobId = "00000000-0000-4000-8000-000000000000"
    const taskRows = [{
      id: "child-1", status: "failed", role: "analyst", taskType: "job_analysis",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, failureReason: "worker_stopped",
      result: { status: "completed", finalItemId: "private-final", finalText: "PRIVATE_FINAL_TEXT", stepCount: 1, toolCallCount: 1,
        structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "partial",
          findings: [{ jobId, score: 8, evidenceIds: ["evidence-job"] }],
          evidence: [{ id: "evidence-job", kind: "job", ref: jobId, source: "private-source" }], summary: "PRIVATE_SUMMARY" } },
    }]
    const fake = fakePool(input, { includeReplay: false, graphContent, graphRevision: 8, taskRows })
    const { stepId: _stepId, ...scope } = input.scope
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.readCurrentResultPage!(scope, { nodeKey: "planned", expectedRevision: 8, offset: 0 })).resolves.toEqual({
      schemaVersion: "agent-harness.v2.task-graph.result-page.v1", trust: "untrusted", availability: "available",
      graphRevision: 8, role: "analyst", taskStatus: "failed", resultStatus: "partial", totalCount: 1,
      evidenceCount: 1, offset: 0, nextOffset: null, items: [{ jobId, score: 8, evidenceKinds: ["job"] }],
    })
    expect(fake.calls[0]?.sql).toBe("BEGIN")
    expect(fake.calls.at(-1)?.sql).toBe("COMMIT")
    expect(fake.client.release).toHaveBeenCalledOnce()
    expect(fake.calls.some(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"'))).toBe(true)
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT task."id", task."status"'))).toHaveLength(1)
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT event."type"'))).toHaveLength(1)
    expect(fake.calls.some(call => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(call.sql))).toBe(false)
    expect(JSON.stringify(fake.calls.map(call => call.values))).not.toContain("PRIVATE_FINAL_TEXT")
  })

  it("preserves the durable-receipt error when paging a missing current graph", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 0, offset: 0 })).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing",
    })
    expect(fake.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it("preserves existing typed verification and native child-contract errors before returning pages", async () => {
    const input = scheduleInput()
    const { stepId: _stepId, ...scope } = input.scope
    const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }] }
    const typedContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "planned", templateId: "analyst",
      goal: "Inspect the source", successCriteria: ["Evidence captured"], dependsOn: [], depth: 1, taskId: "child-1",
      verificationDisposition: "typed", verification }] }
    const typedResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "" }
    const invalidTyped = fakePool(input, { includeReplay: false, graphContent: typedContent, graphRevision: 8, taskRows: [{
      id: "child-1", status: "completed", role: "analyst", taskType: "job_analysis",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, failureReason: null,
      result: { status: "completed", finalItemId: null, finalText: "", stepCount: 1, toolCallCount: 1,
        structuredResult: typedResult, taskGraphVerificationReport: { status: "passed", reasonCode: "criteria_met" } },
    }] })

    await expect(createPgTaskGraphCommandPort(invalidTyped.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 8, offset: 0 })).rejects.toThrow("task_graph_verification_report_invalid")
    expect(invalidTyped.calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(invalidTyped.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)

    const nativeContent = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "planned",
      templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, goal: "Inspect the source", successCriteria: ["Evidence captured"],
      dependsOn: [], depth: 1, taskId: "child-1", verificationDisposition: "legacy_unverified",
      nativeDelegation: { schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-page",
        requestFingerprint: "a".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "job_discovery",
        contextDigest: "b".repeat(64), contextBytes: 1 } }] }
    const invalidNative = fakePool(input, { includeReplay: false, graphContent: nativeContent, graphRevision: 8, taskRows: [{
      id: "child-1", status: "completed", role: "analyst", taskType: "job_analysis",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, failureReason: null, result: null,
    }] })
    await expect(createPgTaskGraphCommandPort(invalidNative.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 8, offset: 0 })).rejects.toThrow("task_graph_native_child_contract_invalid")
    expect(invalidNative.calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(invalidNative.calls.filter(call => call.sql.startsWith('SELECT item."id"'))).toHaveLength(1)
  })

  it.each([
    ["session", "task_graph_session_fenced"], ["turn", "task_graph_turn_fenced"], ["parent", "task_graph_parent_fenced"],
  ] as const)("does not produce planning facts after a %s owner-scope fence", async (fence, error) => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false, failFence: fence })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentWithClient!(fake.client as unknown as pg.PoolClient, scope))
      .rejects.toThrow(error)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it.each([
    ["session", "task_graph_session_fenced"], ["turn", "task_graph_turn_fenced"], ["parent", "task_graph_parent_fenced"],
  ] as const)("does not read result pages after a %s owner-scope fence", async (fence, error) => {
    const input = scheduleInput()
    const fake = fakePool(input, { includeReplay: false, failFence: fence })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrentResultPage!(scope,
      { nodeKey: "planned", expectedRevision: 2, offset: 0 })).rejects.toThrow(error)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)
  })

  it("fails closed when the graph item is missing after a durable proposal receipt", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })
    const { stepId: _stepId, ...scope } = input.scope

    await expect(createPgTaskGraphCommandPort(fake.pool).readCurrent(scope)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const receiptQuery = fake.calls.find(call => call.sql.startsWith("SELECT EXISTS ("))
    expect(receiptQuery?.values).toEqual([input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId), input.scope.userId])
  })

  it("replays the original duplicate receipt when the graph item is missing", async () => {
    const input = scheduleInput()
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    })
    const replay = fake.calls.find(call => call.sql.includes('event."idempotencyKey" = $4'))
    expect(replay?.values).toEqual([
      input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId),
      taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision), input.scope.userId,
    ])
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it("rejects native replay when an owned event outlives its graph item", async () => {
    const input = scheduleInput()
    const native: TaskGraphNativeCommandInput = {
      scope: input.scope,
      request: { kind: "spawn", idempotencyKey: "native-missing", role: "auditor", taskType: "audit", goal: "Review" },
    }
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendNativeCoordination!(native)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const ownedReceiptCheck = fake.calls.findIndex(call => call.sql.startsWith("SELECT EXISTS (") && call.sql.includes('FROM "agent_events"'))
    const graphItemCheck = fake.calls.findIndex(call => call.sql.startsWith("SELECT EXISTS (") && call.sql.includes('FROM "agent_items"'))
    expect(ownedReceiptCheck).toBeGreaterThan(-1)
    expect(graphItemCheck).toBeGreaterThan(ownedReceiptCheck)
    expect(fake.calls.some(call => call.sql.includes('event."idempotencyKey" = $4'))).toBe(false)
  })

  it("rejects a new proposal against a missing graph that has an older receipt", async () => {
    const input = scheduleInput(0)
    const fake = fakePool(input, { missingGraph: true, persistedPlanReceipt: true, includeReplay: false })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "task_graph_state_missing", message: "Persisted TaskGraph state is unavailable",
    })
    const receiptQuery = fake.calls.find(call => call.sql.startsWith("SELECT EXISTS ("))
    expect(receiptQuery?.values).toEqual([input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId), input.scope.userId])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it("treats a pristine missing graph as revision zero for a first proposal", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { missingGraph: true, includeReplay: false })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "revision_mismatch", currentRevision: 0,
    })
    expect(fake.calls.some(call => call.sql.startsWith("SELECT EXISTS ("))).toBe(true)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("returns the original receipt as a duplicate for an idempotent proposal replay", async () => {
    const input = scheduleInput()
    const fake = fakePool(input)
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).resolves.toEqual({
      status: "duplicate", revision: 2, nodes: [{ key: "planned", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    })

    const replay = fake.calls.find(call => call.sql.includes('event."idempotencyKey" = $4'))
    expect(replay?.values).toEqual([
      input.scope.sessionId, input.scope.turnId, taskGraphItemId(input.scope.parentTaskId),
      taskGraphProposalKey(input.scope.parentTaskId, input.proposal.expectedRevision), input.scope.userId,
    ])
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("commits plan revise and private reconciliation through one client, in order", async () => {
    const input = scheduleInput(2), fake = fakePool(input, { includeReplay: false })
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 2, callId: "persisted-plan-call", rootInputId: "original-input" }
    const prepared = { steerInputIds: ["private-steer"], resultingRevision: 3 }
    const created = { state: { revision: 3 }, snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] }, created: [], readyTaskIds: [] }
    reconciliationMocks.prepare.mockResolvedValue(prepared)
    reconciliationMocks.create.mockResolvedValue(created)
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndScheduleWithReconciliation!(input, operation)).resolves.toEqual({ status: "accepted", revision: 3, nodes: [], readyTaskIds: [] })
    expect(reconciliationMocks.prepare).toHaveBeenCalledWith(fake.client, operation)
    expect(reconciliationMocks.assertNoUnresolvedSteering).not.toHaveBeenCalled()
    expect(reconciliationMocks.create).toHaveBeenCalledOnce()
    expect(reconciliationMocks.writePlan).toHaveBeenCalledOnce()
    expect(reconciliationMocks.write).toHaveBeenCalledWith(fake.client, prepared, 3)
    expect(reconciliationMocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.create.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.create.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.writePlan.mock.invocationCallOrder[0] ?? 0)
    expect(reconciliationMocks.writePlan.mock.invocationCallOrder[0]).toBeLessThan(reconciliationMocks.write.mock.invocationCallOrder[0] ?? 0)
    expect(fake.calls.map(call => call.sql)).toContain("COMMIT")
    expect(fake.client.release).toHaveBeenCalledOnce()
  })

  it("blocks a raw planning-root proposal while accepted steering remains unresolved", async () => {
    const input = scheduleInput(2), fake = fakePool(input, { includeReplay: false })
    reconciliationMocks.assertNoUnresolvedSteering.mockRejectedValueOnce(new Error("steering_reconciliation_pending"))

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).rejects.toThrow("steering_reconciliation_pending")
    expect(reconciliationMocks.assertNoUnresolvedSteering).toHaveBeenCalledWith(fake.client, input.scope)
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(reconciliationMocks.writePlan).not.toHaveBeenCalled()
  })

  it("does not apply the planning-root steering gate to non-planning schedules", async () => {
    const input = scheduleInput(), fake = fakePool(input, { allowedActions: ["jobs.search"] })

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndSchedule(input)).resolves.toMatchObject({ status: "duplicate" })
    expect(reconciliationMocks.assertNoUnresolvedSteering).not.toHaveBeenCalled()
  })

  it("returns an exact plan replay before preparing reconciliation and never writes a receipt", async () => {
    const input = scheduleInput(), fake = fakePool(input)
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 1, callId: "new-step-call", rootInputId: "original-input" }
    reconciliationMocks.prepare.mockRejectedValue(new Error("replay must not prepare a new reconciliation"))

    await expect(createPgTaskGraphCommandPort(fake.pool).appendAndScheduleWithReconciliation!(input, operation)).resolves.toMatchObject({ status: "duplicate", revision: 2 })
    expect(reconciliationMocks.prepare).not.toHaveBeenCalled()
    expect(reconciliationMocks.write).not.toHaveBeenCalled()
    expect(reconciliationMocks.create).not.toHaveBeenCalled()
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects a stale proposal with the current persisted revision", async () => {
    const input = scheduleInput(1)
    const fake = fakePool(input, { includeReplay: false })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).rejects.toMatchObject({
      name: "TaskGraphCommandError", code: "revision_mismatch", currentRevision: 2,
    })
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('UPDATE "agent_items"'))).toBe(false)
  })

  it.each([
    { fence: "session" as const, error: "task_graph_session_fenced", query: 'FROM "agent_sessions"', values: ["session-1", "user-1"] },
    { fence: "turn" as const, error: "task_graph_turn_fenced", query: 'FROM "agent_turns"', values: ["turn-1", "session-1", "user-1", "root-1", "turn-owner", 3] },
    { fence: "parent" as const, error: "task_graph_parent_fenced", query: 'FROM "sub_agent_tasks"', values: ["root-1", "session-1", "turn-1", "root-1", "user-1", "parent-owner", 2] },
  ])("rejects a mismatched $fence identity before reading or mutating the graph", async ({ fence, error, query, values }) => {
    const input = scheduleInput()
    const fake = fakePool(input, { failFence: fence })
    const port = createPgTaskGraphCommandPort(fake.pool)

    await expect(port.appendAndSchedule(input)).rejects.toThrow(error)
    const fencedCall = fake.calls.find(call => call.sql.includes(query))
    expect(fencedCall?.values).toEqual(values)
    expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(call => call.sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })
})
