import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { deriveTaskGraphReadModel } from "../planning/task-graph.js"

import { PgSubagentTaskStore } from "./pg-store.js"
import { normalizeSubagentPolicy, SubagentLimitError, type SubagentPolicy } from "./types.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphItemId } from "./task-graph-snapshot.js"
import { resolveTaskGraphRepairDependencies } from "./task-graph-dependency-context.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import { loadScopedTaskGraphDependencyContext } from "./task-graph-pg-dependency-context-loader.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const { verifyEvidenceMock, resultDigestMock } = vi.hoisted(() => ({ verifyEvidenceMock: vi.fn(), resultDigestMock: vi.fn(() => "d".repeat(64)) }))
vi.mock("./task-graph-pg-verification.js", () => ({
  TASK_GRAPH_VERIFIER_VERSION: "agent-harness.v2.task-graph-verifier.v1",
  verifyTaskGraphNodeEvidence: verifyEvidenceMock,
  taskGraphResultDigest: resultDigestMock,
}))

const now = new Date("2026-09-03T00:00:00.000Z")
const policy: SubagentPolicy = normalizeSubagentPolicy({ maxConcurrency: 2, maxAttempts: 2 })

function taskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "task-1", parentTaskId: null,
    path: "/task-1", depth: 0, role: "scout", taskType: "test", status: "queued", goal: "inspect",
    constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null,
    failureReason: null, attemptCount: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null,
    interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: policy }, toolPolicySnapshot: {}, ...overrides,
  }
}

function fakePool(handler: (sql: string, params?: unknown[]) => { rows?: unknown[]; rowCount?: number }) {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      const result = handler(sql, params)
      if (sql.startsWith('SELECT "leaseExpiresAt" FROM "sub_agent_tasks"') && result.rows === undefined) {
        return { rows: [{ leaseExpiresAt: new Date(now.getTime() + 60_000) }], rowCount: 1, ...result }
      }
      if (sql.startsWith("SELECT clock_timestamp()") && result.rows === undefined) {
        return { rows: [{ checkedAt: now }], rowCount: 1, ...result }
      }
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE") && result.rows === undefined) {
        return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1, ...result }
      }
      if (sql.includes('SELECT task."id", task."status", task."attemptCount"') && result.rows === undefined) {
        const count = sql.includes('task."turnId" = $2') ? 2 : 3
        return { rows: Array.from({ length: count }, (_, index) => ({ id: `task-${index + 1}`, status: index === 0 ? "running" : "waiting", attemptCount: 1 })), rowCount: count, ...result }
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1") && result.rows === undefined) {
        return { rows: [{ id: "task-1", sessionId: "session-1", rootTaskId: "task-1", userId: "user-1" }], rowCount: 1, ...result }
      }
      if (sql.includes('session."status" AS "sessionStatus"') && result.rows === undefined) {
        return { rows: [taskRow({ sessionStatus: "running", attemptCount: 1 })], rowCount: 1, ...result }
      }
      if (sql.includes('SELECT task."turnId"') && result.rows === undefined) {
        return { rows: [taskRow()], rowCount: 1, ...result }
      }
      return { rows: [], rowCount: 0, ...result }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool, calls, client }
}

function fakeInterruptedTurnPool(options: { missingGraphItem?: boolean } = {}) {
  const statuses = new Map([ ["child-1", "running"], ["dependent-1", "waiting"] ])
  const lifecycleEvents: unknown[] = []
  const pendingDispatches = new Set(["subagent-dispatch:child-1"])
  const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    { key: "child", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "child-1" },
    { key: "dependent", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: ["child"], depth: 2, taskId: "dependent-1" },
  ] }
  let revision = 2
  let sequence = 0
  const fake = fakePool((sql, params) => {
    const taskId = String(params?.[0] ?? "child-1")
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
    if (sql.includes('SELECT task."interruptRequestedAt"')) return { rows: [{ interruptRequestedAt: now, turnStatus: "interrupted" }], rowCount: 1 }
    if (sql.startsWith("UPDATE \"sub_agent_tasks\"") && sql.includes('SET "leaseExpiresAt" = LEAST')) return { rowCount: 0 }
    if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", attemptCount: taskId === "child-1" ? 1 : 0, userId: "user-1" }], rowCount: 1 }
    if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: { kind: "proposal", receipt: {
      revision: 1,
      nodes: snapshot.nodes.map(node => ({ key: node.key, taskId: node.taskId, status: node.dependsOn.length ? "waiting" : "queued" })),
      readyTaskIds: snapshot.nodes.filter(node => node.dependsOn.length === 0).map(node => node.taskId),
    } } }], rowCount: 1 }
    if (sql.includes('SELECT item."id"')) return options.missingGraphItem
      ? { rows: [], rowCount: 0 }
      : { rows: [{ id: taskGraphItemId("root-1"), revision, content: snapshot, createdAt: now }], rowCount: 1 }
    if (sql.includes('SELECT task."id", task."status"')) return { rows: (params?.[0] as string[]).map(id => ({ id, status: statuses.get(id), role: "analyst", failureReason: null, result: null })), rowCount: 2 }
    if (sql.includes('SELECT event."payload"')) return { rows: lifecycleEvents.map(payload => ({ payload })), rowCount: lifecycleEvents.length }
    if (sql.startsWith("SELECT task.*, session.")) return { rows: [taskRow({ id: taskId, status: statuses.get(taskId), userId: "user-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: now })], rowCount: 1 }
    if (sql.startsWith('UPDATE "sub_agent_tasks"') && sql.includes('SET "status" = $3')) { statuses.set(taskId, String(params?.[2])); return { rowCount: 1 } }
    if (sql.startsWith('UPDATE "sub_agent_tasks"') && sql.includes("SET \"status\" = 'cancelled'")) { statuses.set(taskId, "cancelled"); return { rowCount: 1 } }
    if (sql.startsWith('UPDATE "agent_items"')) { revision = Number(params?.[5]); return { rows: [{ stepId: null, status: "streaming", phase: null, startedAt: now, completedAt: null, createdAt: now }], rowCount: 1 } }
    if (sql.startsWith('UPDATE "agent_sessions" AS session')) return { rows: [{ eventSequence: ++sequence }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_events"')) { lifecycleEvents.push(JSON.parse(String(params?.[10])) as unknown); return { rowCount: 1 } }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rowCount: 1 }
    if (sql.startsWith('DELETE FROM "agent_outbox"')) { pendingDispatches.delete(String(params?.[1])); return { rowCount: 1 } }
    return {}
  })
  return { ...fake, statuses, lifecycleEvents, pendingDispatches, revision: () => revision }
}

const analystContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst" as const,
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } }],
}
function validAnalystResult() {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
    findings: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }],
    evidence: [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "One verified finding." }
}

function fakeGraphFinishPool(options: {
  legacy?: boolean; includeDependent?: boolean; repair?: boolean; priorReceipt?: boolean; fenceTaskUpdate?: boolean;
  targetReport?: Record<string, unknown> | null;
} = {}) {
  const childId = options.repair ? "repair-1" : "child-1"
  const nodes = [
    ...(options.repair ? [{ key: "target", templateId: "analyst", goal: "Find", successCriteria: ["Find one"], dependsOn: [], depth: 1, taskId: "target-1", verificationDisposition: "typed", verification: analystContract }] : []),
    ...(options.priorReceipt ? [{ key: "prior-repair", templateId: "analyst", goal: "Repair prior finding", successCriteria: ["Find one"], dependsOn: [], depth: 2, taskId: "prior-repair-1", verificationDisposition: "typed", verification: analystContract, repairOf: { graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-1", criterionIds: ["finding-count"] } }] : []),
    {
      key: options.repair ? "repair" : "child", templateId: "analyst", goal: "Inspect", successCriteria: ["Find one"],
      dependsOn: [], depth: options.priorReceipt ? 3 : options.repair ? 2 : 1, taskId: childId,
      ...(options.legacy ? { verificationDisposition: "legacy_unverified" } : { verificationDisposition: "typed", verification: analystContract }),
      ...(options.repair ? { repairOf: { graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-1", criterionIds: ["finding-count"] } } : {}),
    },
    ...(options.includeDependent || options.repair ? [{ key: "dependent", templateId: "analyst", goal: "Continue", successCriteria: ["Continue"], dependsOn: [options.repair ? "target" : "child"], depth: 2, taskId: "dependent-1", verificationDisposition: "typed", verification: analystContract }] : []),
  ]
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes })
  const statuses = new Map<string, string>([
    ...(options.repair ? [["target-1", "failed"] as const] : []),
    ...(options.priorReceipt ? [["prior-repair-1", "completed"] as const] : []),
    [childId, "running"],
    ...(options.includeDependent || options.repair ? [["dependent-1", options.priorReceipt ? "queued" : "waiting"] as const] : []),
  ])
  const targetReport = options.targetReport ?? {
    verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "failed", reasonCode: "criterion_not_met",
    criteria: [{ criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met" }], evidenceDigest: "b".repeat(64), resultDigest: "d".repeat(64),
  }
  const previousReport = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64) }
  const previousReceipt = { schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1", targetNodeKey: "target", targetTaskId: "target-1", criterionIds: ["finding-count"], repairNodeKey: "prior-repair", repairTaskId: "prior-repair-1", verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: previousReport.evidenceDigest }
  const taskResults = new Map<string, unknown>([
    ...(options.repair ? [["target-1", { status: "completed", finalText: "Findings", finalItemId: null, stepCount: 0, toolCallCount: 0,
      structuredResult: validAnalystResult(), taskGraphVerificationReport: targetReport }] as const] : []),
    ...(options.priorReceipt ? [["prior-repair-1", { taskGraphVerificationReport: previousReport, taskGraphRepairReceipt: previousReceipt }] as const] : []),
  ])
  const failureReasons = new Map<string, string | null>([
    ...(options.repair ? [["target-1", targetReport.reasonCode === "repair_target_unresolved" ? "task_graph_repair_target_unresolved" : targetReport.status === "failed" ? "task_graph_verification_failed" : "task_graph_verification_unverified"] as const] : []),
  ])
  const lifecycleEvents: Array<{ type: string; payload: unknown }> = []
  const order: string[] = []
  let revision = 1
  let sequence = 0
  const proposal = { kind: "proposal", receipt: {
    revision: 1,
    nodes: snapshot.nodes.map(node => ({ key: node.key, taskId: node.taskId, status: node.dependsOn.length ? "waiting" : "queued" })),
    readyTaskIds: snapshot.nodes.filter(node => node.dependsOn.length === 0).map(node => node.taskId),
  } }
  const fake = fakePool((sql, params) => {
    const taskId = String(params?.[0] ?? childId)
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
    if (sql.startsWith("SELECT task.*, session.")) return { rows: [taskRow({
      id: childId, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      role: "analyst", taskType: "research", status: "running", leaseOwner: "worker-1", attemptCount: 1, maxAttempts: 2,
      leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: null,
    })], rowCount: 1 }
    if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", attemptCount: taskId === childId ? 1 : 0, userId: "user-1" }], rowCount: 1 }
    if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: proposal }], rowCount: 1 }
    if (sql.includes('SELECT item."id"')) return { rows: [{ id: taskGraphItemId("root-1"), revision, content: snapshot, createdAt: now }], rowCount: 1 }
    if (sql.includes('task."expectedOutputSchema"') && sql.includes('task."context"')) return {
      rows: (params?.[0] as string[]).map(id => ({ id, status: statuses.get(id), role: "analyst", failureReason: failureReasons.get(id) ?? null,
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, result: taskResults.get(id) ?? null, context: {},
        sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", userId: "user-1" })),
      rowCount: (params?.[0] as string[]).length,
    }
    if (sql.includes('SELECT task."id", task."status", task."role", task."failureReason"')) return {
      rows: snapshot.nodes.map(node => ({ id: node.taskId, status: statuses.get(node.taskId), role: "analyst", failureReason: failureReasons.get(node.taskId) ?? null, result: taskResults.get(node.taskId) ?? null })),
      rowCount: snapshot.nodes.length,
    }
    if (sql.includes('SELECT event."type", event."payload"')) return { rows: lifecycleEvents, rowCount: lifecycleEvents.length }
    if (sql.startsWith('SELECT target."id"')) return options.repair ? { rows: [{
      id: "target-1", status: "failed", failureReason: failureReasons.get("target-1"), result: taskResults.get("target-1"), rootTaskId: "root-1", parentTaskId: "root-1",
    }], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.startsWith('SELECT prior."id"')) return { rows: (params?.[0] as string[]).map(id => ({ id, status: statuses.get(id), result: taskResults.get(id), failureReason: null })), rowCount: (params?.[0] as string[]).length }
    if (sql.includes("FOR UPDATE OF task")) return statuses.get(childId) === "running" ? { rows: [taskRow({
      id: childId, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      role: "analyst", status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000),
    })], rowCount: 1 } : { rows: [], rowCount: 0 }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3')) {
      order.push("task-update")
      if (options.fenceTaskUpdate) return { rowCount: 0 }
      statuses.set(taskId, String(params?.[2]))
      taskResults.set(taskId, JSON.parse(String(params?.[3])) as unknown)
      failureReasons.set(taskId, params?.[4] === null || params?.[4] === undefined ? null : String(params[4]))
      return { rowCount: 1 }
    }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "context" = $6::jsonb')) { statuses.set(taskId, "queued"); return { rowCount: 1 } }
    if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = \'cancelled\'')) {
      statuses.set(taskId, "cancelled")
      failureReasons.set(taskId, "A prerequisite task did not complete.")
      return { rowCount: 1 }
    }
    if (sql.startsWith('UPDATE "agent_items"')) {
      revision = Number(params?.[5])
      return { rows: [{ stepId: null, status: "streaming", phase: null, startedAt: now, completedAt: null, createdAt: now }], rowCount: 1 }
    }
    if (sql.includes('UPDATE "agent_sessions" AS session') && sql.includes('RETURNING "eventSequence"')) return { rows: [{ eventSequence: ++sequence }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      lifecycleEvents.push({ type: String(params?.[6]), payload: JSON.parse(String(params?.[10])) as unknown })
      return { rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rowCount: 1 }
    return {}
  })
  return { ...fake, statuses, taskResults, failureReasons, lifecycleEvents, order, childId, snapshot }
}

describe("PgSubagentTaskStore", () => {
  const candidateResult = {
    status: "completed", finalText: "Done", finalItemId: null, stepCount: 0, toolCallCount: 0,
    structuredResult: { ...validAnalystResult(), verificationReport: { forged: true } },
    taskGraphVerificationReport: { forged: true }, taskGraphRepairReceipt: { forged: true },
  }

  function setVerifierResult(status: "passed" | "failed" | "unverified") {
    verifyEvidenceMock.mockClear()
    const reasonCode = status === "passed" ? "criteria_met" : status === "failed" ? "criterion_not_met" : "canonical_evidence_missing"
    const report = {
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status, reasonCode,
      criteria: [{ criterionId: "finding-count", status, reasonCode }],
      evidenceDigest: status === "unverified" ? null : "a".repeat(64),
      resultDigest: status === "unverified" ? null : "d".repeat(64),
    }
    verifyEvidenceMock.mockResolvedValue({
      verified: status === "passed", report, evaluation: report,
      ...(status !== "unverified" ? { structuredResult: validAnalystResult() } : {}),
    } as never)
  }

  it("persists only a server-verified typed result and report before completing the graph node", async () => {
    const fake = fakeGraphFinishPool()
    setVerifierResult("passed")
    verifyEvidenceMock.mockImplementationOnce(async (...args: unknown[]) => {
      fake.order.push("verify")
      return (verifyEvidenceMock.getMockImplementation() as (...input: unknown[]) => unknown)(...args)
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("completed")

    expect(fake.statuses.get(fake.childId)).toBe("completed")
    const stored = fake.taskResults.get(fake.childId) as Record<string, unknown>
    expect(stored.taskGraphVerificationReport).toMatchObject({ status: "passed", evidenceDigest: "a".repeat(64) })
    expect(stored.structuredResult).toEqual(validAnalystResult())
    expect(stored).not.toHaveProperty("taskGraphRepairReceipt.forged")
    expect(JSON.stringify(stored)).not.toContain("forged")
    expect(verifyEvidenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", taskId: fake.childId, attemptCount: 1 },
      node: expect.objectContaining({ verificationDisposition: "typed" }),
      structuredResult: expect.objectContaining({ role: "analyst" }),
    }))
    expect(fake.order.indexOf("verify")).toBeLessThan(fake.order.indexOf("task-update"))
  })

  it.each([
    ["failed", "task_graph_verification_failed"],
    ["unverified", "task_graph_verification_unverified"],
  ] as const)("terminalizes a %s verification without releasing dependents", async (verificationStatus, failureReason) => {
    const fake = fakeGraphFinishPool({ includeDependent: true })
    setVerifierResult(verificationStatus)
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("failed")

    expect(fake.statuses.get(fake.childId)).toBe("failed")
    expect(fake.statuses.get("dependent-1")).toBe("waiting")
    expect(fake.calls.some(([sql]) => sql.includes("'agent.subagent.dispatch'"))).toBe(false)
    const update = fake.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    expect(update?.[1]?.[2]).toBe("failed")
    expect(update?.[1]?.[4]).toBe(failureReason)
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).taskGraphVerificationReport).toMatchObject({ status: verificationStatus })
    if (verificationStatus === "failed") expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).structuredResult).toEqual(validAnalystResult())
    else expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).structuredResult).toBeUndefined()
    expect(fake.lifecycleEvents.some(event => JSON.stringify(event.payload).includes('"type":"task.completed"'))).toBe(false)
  })

  it("fails legacy-unverified nodes with a server report even if a mocked verifier claims pass", async () => {
    const fake = fakeGraphFinishPool({ legacy: true })
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("failed")

    expect(verifyEvidenceMock).not.toHaveBeenCalled()
    expect(fake.statuses.get(fake.childId)).toBe("failed")
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).taskGraphVerificationReport)
      .toMatchObject({ status: "unverified", reasonCode: "contract_invalid", criteria: [] })
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).structuredResult).toBeUndefined()
  })

  it("does not verify a failed executor result and records unresolved criteria only on terminal failure", async () => {
    const fake = fakeGraphFinishPool()
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "failed", retryDisposition: "terminal", failureReason: "private executor detail", result: candidateResult, now })).resolves.toBe("failed")

    expect(verifyEvidenceMock).not.toHaveBeenCalled()
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).taskGraphVerificationReport)
      .toMatchObject({ status: "unverified", reasonCode: "result_invalid", criteria: [{ criterionId: "finding-count", status: "unverified" }] })
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).structuredResult).toBeUndefined()
    const taskUpdate = fake.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    expect(taskUpdate?.[1]?.[4]).toBe("task_graph_verification_unverified")
    expect(JSON.stringify(fake.lifecycleEvents)).not.toContain("private executor detail")
  })

  it("does not write a final verification report while a failed child is retrying", async () => {
    const fake = fakeGraphFinishPool()
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "failed", retryDisposition: "retryable", result: candidateResult, now })).resolves.toBe("retrying")

    expect(verifyEvidenceMock).not.toHaveBeenCalled()
    const stored = fake.taskResults.get(fake.childId) as Record<string, unknown>
    expect(stored.taskGraphVerificationReport).toBeUndefined()
    expect(stored.taskGraphRepairReceipt).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain("forged")
  })

  it("strips reserved verifier fields from non-TaskGraph worker results", async () => {
    const fake = fakePool(sql => sql.startsWith("SELECT task.*, session.") ? { rows: [taskRow({
      status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000),
    })], rowCount: 1 } : sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3') ? { rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("completed")

    const update = fake.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    const stored = JSON.parse(String(update?.[1]?.[3])) as Record<string, unknown>
    expect(stored.taskGraphVerificationReport).toBeUndefined()
    expect(stored.taskGraphRepairReceipt).toBeUndefined()
    expect(JSON.stringify(stored)).not.toContain("verificationReport")
  })

  it("rolls back a verification pass if the conditional task write loses its lease fence", async () => {
    const fake = fakeGraphFinishPool({ fenceTaskUpdate: true })
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBeNull()

    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_items"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.statuses.get(fake.childId)).toBe("running")
  })

  it("stores a repair receipt only for the exact unresolved same-scope target criteria", async () => {
    const fake = fakeGraphFinishPool({ repair: true })
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("completed")

    const result = fake.taskResults.get(fake.childId) as Record<string, unknown>
    expect(result.taskGraphRepairReceipt).toEqual({
      schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1",
      targetNodeKey: "target", targetTaskId: "target-1", criterionIds: ["finding-count"],
      repairNodeKey: "repair", repairTaskId: "repair-1", verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: "a".repeat(64),
    })
    expect(fake.statuses.get("target-1")).toBe("failed")
    expect((fake.taskResults.get("target-1") as Record<string, unknown>).taskGraphVerificationReport).toMatchObject({ status: "failed" })
    const taskRows = new Map(fake.snapshot.nodes.map(node => [node.taskId, {
      id: node.taskId, status: fake.statuses.get(node.taskId) as GraphTaskRow["status"], role: "analyst",
      failureReason: fake.failureReasons.get(node.taskId) ?? null, result: fake.taskResults.get(node.taskId) ?? null,
    } satisfies GraphTaskRow] as const))
    expect(resolveTaskGraphRepairDependencies(fake.snapshot, taskRows, "root-1")).toEqual({ satisfied: ["target"], pending: [] })
    const queryable = fake.client as unknown as Pick<pg.PoolClient, "query">
    const loaded = await loadTaskGraph(queryable, { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" })
    expect(loaded.state?.repairSatisfiedNodeKeys).toContain("target")
    const waitingState = { ...loaded.state!, nodes: loaded.state!.nodes.map(node => node.key === "dependent" ? { ...node, status: "waiting" as const } : node) }
    expect(deriveTaskGraphReadModel(waitingState).find(node => node.key === "dependent")?.readiness).toBe("ready")
    fake.statuses.set("dependent-1", "waiting")
    await expect(loadScopedTaskGraphDependencyContext(queryable,
      { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" },
      "dependent-1", ["target"], fake.snapshot.nodes)).resolves.toMatchObject({ dependencies: [{ repairComposite: true, status: "completed" }] })
    fake.statuses.set("dependent-1", "queued")
    expect(fake.statuses.get("dependent-1")).toBe("queued")
    expect(fake.calls.some(([sql]) => sql.includes("'agent.subagent.dispatch'"))).toBe(true)
  })

  it("rejects a repair when its requested target criterion is already passed", async () => {
    const targetReport = {
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "failed", reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "b".repeat(64), resultDigest: "d".repeat(64),
    }
    const fake = fakeGraphFinishPool({ repair: true, targetReport })
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("failed")

    expect(fake.statuses.get(fake.childId)).toBe("failed")
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).taskGraphRepairReceipt).toBeUndefined()
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"') && sql.includes("'agent.subagent.dispatch'"))).toBe(false)
  })

  it("rejects a repair when the target verification report is malformed", async () => {
    const targetReport = {
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "failed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met" }], evidenceDigest: "invalid", resultDigest: "d".repeat(64),
    }
    const fake = fakeGraphFinishPool({ repair: true, targetReport })
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("failed")

    expect(fake.statuses.get(fake.childId)).toBe("failed")
    const result = fake.taskResults.get(fake.childId) as Record<string, unknown>
    expect(result.taskGraphRepairReceipt).toBeUndefined()
    expect(result.taskGraphVerificationReport).toMatchObject({
      status: "unverified", reasonCode: "repair_target_unresolved", evidenceDigest: null,
      criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }],
    })
    const update = fake.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = $3'))
    expect(update?.[1]?.[4]).toBe("task_graph_repair_target_unresolved")
  })

  it("rejects a repair when a prior committed receipt already resolved the same criterion", async () => {
    const fake = fakeGraphFinishPool({ repair: true, priorReceipt: true })
    setVerifierResult("passed")
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: fake.childId, sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "completed", result: candidateResult, now })).resolves.toBe("failed")

    expect(fake.statuses.get(fake.childId)).toBe("failed")
    expect((fake.taskResults.get(fake.childId) as Record<string, unknown>).taskGraphRepairReceipt).toBeUndefined()
    expect(fake.calls.some(([sql]) => sql.startsWith('SELECT prior."id"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes("'agent.subagent.dispatch'"))).toBe(false)
  })

  it("creates a root task under a locked session and persists an inherited policy", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.create({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy })
    expect(result).toMatchObject({ id: "task-1", rootTaskId: "task-1", depth: 0, status: "queued" })
    const sessionQuery = fake.calls.find(([sql]) => sql.includes('FROM "agent_sessions"'))?.[0] ?? ""
    expect(sessionQuery).toContain('"status"')
    expect(sessionQuery).toContain("FOR UPDATE")
    const insert = fake.calls.find(([sql]) => sql.startsWith("INSERT INTO"))
    expect(insert?.[1]).toContain(JSON.stringify({ subagentPolicy: policy }))
    expect(insert?.[0]).toContain('"maxAttempts", "updatedAt")')
    expect(insert?.[0]).toContain("$19, CURRENT_TIMESTAMP)")
  })

  it("atomically creates a child with its spawn operation and dispatch outbox", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith("INSERT INTO \"sub_agent_tasks\"")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      if (sql.startsWith("INSERT INTO \"agent_outbox\"")) return { rows: [], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.createWithSpawn({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy, spawnIdempotencyKey: "spawn-1" })
    expect(result).toMatchObject({ duplicate: false, task: { id: "task-1", status: "queued" } })
    const writes = fake.calls.filter(([sql]) => sql.startsWith("INSERT INTO \"agent_outbox\""))
    expect(writes).toHaveLength(2)
    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const taskIndex = fake.calls.findIndex(([sql]) => sql.startsWith("INSERT INTO \"sub_agent_tasks\""))
    const operationIndex = fake.calls.findIndex(([sql]) => sql.startsWith("INSERT INTO \"agent_outbox\"") && sql.includes("'agent.subagent.spawn'"))
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(sessionIndex).toBeLessThan(taskIndex)
    expect(operationIndex).toBeGreaterThan(taskIndex)
    const taskInsert = fake.calls[taskIndex]?.[0] ?? ""
    expect(taskInsert).toContain('"maxAttempts", "updatedAt")')
    expect(taskInsert).toContain("$19, CURRENT_TIMESTAMP)")
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("replays an existing spawn key before parent fan-out validation", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [{ payload: { taskId: "task-1" } }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ id: "task-1" })], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.createWithSpawn({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "scout", taskType: "test", goal: "inspect", policy: normalizeSubagentPolicy({ maxFanOut: 1 }), spawnIdempotencyKey: "spawn-1" })
    expect(result).toMatchObject({ duplicate: true, task: { id: "task-1" } })
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO \"sub_agent_tasks\""))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO \"agent_outbox\""))).toBe(false)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("rolls back the task when the atomic dispatch outbox write fails", async () => {
    let taskInserted = false
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_outbox"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith("INSERT INTO \"sub_agent_tasks\"")) { taskInserted = true; return { rows: [{ id: "task-1" }], rowCount: 1 } }
      if (sql === "ROLLBACK") { taskInserted = false; return {} }
      if (sql.startsWith("INSERT INTO \"agent_outbox\"")) throw new Error("outbox unavailable")
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.createWithSpawn({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy, spawnIdempotencyKey: "spawn-fail" })).rejects.toThrow("outbox unavailable")
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(taskInserted).toBe(false)
  })

  it.each(["aborted", "archived"] as const)("rejects child creation for a %s session", async status => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [{ id: "session-1", status }], rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.create({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy })).rejects.toThrow("Session is unavailable")
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO"))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("keeps child creation compatible with a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.create({ userId: "user-1", sessionId: "session-1", role: "scout", taskType: "test", goal: "inspect", policy })).resolves.toMatchObject({ status: "queued" })
    expect(fake.calls.some(([sql]) => sql.startsWith("INSERT INTO"))).toBe(true)
  })

  it("claims with a session lock and a conditional lease update", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.claim({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", policy, now })
    expect(result).toMatchObject({ status: "running", leaseOwner: "worker-1", attemptCount: 1 })
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain("attemptCount")
    expect(update).toContain('"interruptRequestedAt" IS NULL')
    expect(update).toContain('"leaseExpiresAt" = clock_timestamp()')
    expect(update).toContain('"nextAttemptAt" <= clock_timestamp()')
    expect(fake.calls.find(([sql]) => sql.includes('FROM "agent_sessions"'))?.[0]).not.toContain("controlGate")
    expect(update).not.toContain("controlGate")
  })

  it.each([
    ["missing item", "task_graph_state_missing"],
    ["corrupt snapshot", "task_graph_snapshot_invalid"],
  ] as const)("rolls back a graph child claim before task or outbox writes when its graph %s is unavailable", async (failure, error) => {
    const proposal = { kind: "proposal", receipt: {
      revision: 1, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
    } }
    const fake = fakePool(sql => {
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", attemptCount: 0, userId: "user-1" }], rowCount: 1 }
      if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: proposal }], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return failure === "missing item"
        ? { rows: [], rowCount: 0 }
        : { rows: [{ id: taskGraphItemId("root-1"), revision: 1, content: { schemaVersion: "invalid", nodes: [] }, createdAt: now }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.claim({ taskId: "child-1", sessionId: "session-1", ownerId: "worker-1", policy, now }))
      .rejects.toThrow(error)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
  })

  it("keeps a same-root task on the legacy claim path when valid proposal receipts do not include its ID", async () => {
    const proposal = { kind: "proposal", receipt: {
      revision: 1, nodes: [{ key: "graph-child", taskId: "graph-child", status: "queued" }], readyTaskIds: ["graph-child"],
    } }
    const claimed = taskRow({
      id: "legacy-child", userId: "user-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000),
    })
    const fake = fakePool(sql => {
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", attemptCount: 0, userId: "user-1" }], rowCount: 1 }
      if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: proposal }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rows: [], rowCount: 1 }
      if (sql.startsWith('SELECT task.*, session."userId" AS "userId"')) return { rows: [claimed], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.claim({ taskId: "legacy-child", sessionId: "session-1", ownerId: "worker-1", policy, now }))
      .resolves.toMatchObject({ id: "legacy-child", status: "running", leaseOwner: "worker-1" })
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.includes('SELECT item."id"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it.each(["aborted", "archived"] as const)("does not claim a queued child from a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.claim({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", policy, now })).resolves.toBeNull()
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("keeps queued child claims compatible with a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", status }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rows: [{ id: "task-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.claim({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", policy, now })).resolves.toMatchObject({ status: "running" })
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(update).not.toContain("controlGate")
  })

  it("inherits the parent model route and only permits a requested action subset", async () => {
    const parent = taskRow({ id: "parent-1", rootTaskId: "parent-1", path: "/parent-1", status: "running", allowedActions: ["jobs.search", "persona.read"], modelProfileSnapshot: { provider: "fixture", model: "parent-model" } })
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ id: "child-1", rootTaskId: "parent-1", parentTaskId: "parent-1", modelProfileSnapshot: parent.modelProfileSnapshot, allowedActions: ["jobs.search"] })], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR UPDATE')) return { rows: [parent], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "child-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await store.create({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "parent-1", role: "analyst", taskType: "research", goal: "inspect", allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "override" }, policy })
    const insert = fake.calls.find(([sql]) => sql.startsWith("INSERT INTO"))?.[1] ?? []
    expect(insert[12]).toBe(JSON.stringify(["jobs.search"]))
    expect(insert[15]).toBe(JSON.stringify(parent.modelProfileSnapshot))
    expect(insert[17]).toBe(JSON.stringify({ subagentPolicy: policy }))
  })

  it("inherits all parent actions when the child request is empty and rejects expansion", async () => {
    const parent = taskRow({ id: "parent-1", rootTaskId: "parent-1", path: "/parent-1", status: "running", allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "parent-model" } })
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ id: "child-1", rootTaskId: "parent-1", parentTaskId: "parent-1", modelProfileSnapshot: parent.modelProfileSnapshot, allowedActions: ["jobs.search"] })], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('FOR UPDATE')) return { rows: [parent], rowCount: 1 }
      if (sql.startsWith("INSERT INTO")) return { rows: [{ id: "child-1" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await store.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "scout", taskType: "research", goal: "inspect", allowedActions: [], policy })
    const insert = fake.calls.find(([sql]) => sql.startsWith("INSERT INTO"))?.[1] ?? []
    expect(insert[12]).toBe(JSON.stringify(["jobs.search"]))
    await expect(store.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "scout", taskType: "research", goal: "inspect", allowedActions: ["gmail.send"], policy })).rejects.toThrow("exceed parent")
  })

  it("rejects a child that would exceed the inherited depth or fan-out", async () => {
    const parent = taskRow({ id: "parent-1", rootTaskId: "parent-1", path: "/parent-1", depth: 2, status: "running" })
    const depthFake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [parent], rowCount: 1 }
      return {}
    })
    const depthStore = new PgSubagentTaskStore(depthFake.pool)
    await expect(depthStore.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "analyst", taskType: "test", goal: "inspect", policy: normalizeSubagentPolicy({ maxDepth: 2 }) })).rejects.toMatchObject({ code: "depth" })

    const fanOutFake = fakePool(sql => {
      if (sql.includes("COUNT(*)")) return { rows: [{ count: 2 }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [taskRow({ id: "parent-1", status: "running" })], rowCount: 1 }
      return {}
    })
    const fanOutStore = new PgSubagentTaskStore(fanOutFake.pool)
    await expect(fanOutStore.create({ userId: "user-1", sessionId: "session-1", parentTaskId: "parent-1", role: "analyst", taskType: "test", goal: "inspect", policy: normalizeSubagentPolicy({ maxFanOut: 2 }) })).rejects.toMatchObject({ code: "fan_out" })
  })

  it("returns retrying while putting a transient failure back in queued state", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "failed", failureReason: "timeout", now })).resolves.toBe("retrying")
    const finishSelect = fake.calls.find(([sql]) => sql.includes('task."status" = \'running\'') && sql.includes("FOR UPDATE OF task"))?.[0] ?? ""
    expect(finishSelect).toContain("FOR UPDATE OF task")
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))
    expect(update?.[0]).toContain('"attemptCount" = $9')
    expect(update?.[0]).toContain('"nextAttemptAt" = $10')
    expect(update?.[0]).toContain('"leaseExpiresAt" > clock_timestamp()')
    expect(update?.[1]).toContain(1)
    expect(update?.[1]?.[9]).toEqual(new Date(now.getTime() + 1_000))
    const dispatchReset = fake.calls.find(([sql]) => sql.startsWith('UPDATE "agent_outbox"'))
    expect(dispatchReset?.[0]).toContain('"publishedAt" = NULL')
    expect(dispatchReset?.[0]).toContain('"attemptCount" = "attemptCount" + 1')
    expect(dispatchReset?.[0]).toContain('"lastError" = NULL')
    expect(dispatchReset?.[0]).toContain('"topic" = \'agent.subagent.dispatch\'')
    expect(dispatchReset?.[0]).toContain('"idempotencyKey" = $1')
    expect(dispatchReset?.[0]).toContain('"aggregateId" = $2')
    expect(dispatchReset?.[1]).toEqual(["subagent-dispatch:task-1", "session-1"])
    expect(fake.calls.indexOf(dispatchReset!)).toBeGreaterThan(fake.calls.indexOf(update!))
  })

  it("rolls back the queued task when retry dispatch reset fails", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_outbox"')) throw new Error("dispatch reset unavailable")
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "failed", failureReason: "timeout", now })).rejects.toThrow("dispatch reset unavailable")
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(fake.calls.some(([sql]) => sql === "COMMIT")).toBe(false)
  })

  it.each([
    ["resume loader", "child_resume_unavailable"],
    ["resume evidence hydration", "child_resume_evidence_unavailable"],
  ] as const)("writes a terminal %s failure without resetting dispatch", async (_label, failureReason) => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, maxAttempts: 2, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({
      taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "failed", failureReason, retryDisposition: "terminal", now,
    })).resolves.toBe("failed")
    const update = fake.calls.find(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(update?.[0]).toContain('"status" = $3')
    expect(update?.[0]).toContain('"leaseOwner" = NULL')
    expect(update?.[0]).toContain('"leaseExpiresAt" = NULL')
    expect(update?.[1]?.[2]).toBe("failed")
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_outbox"'))).toBe(false)
  })

  it("completes the task and consumes the read mailbox ids in one transaction", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) return { rows: [{ id: "message-2" }, { id: "message-1" }], rowCount: 2 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({
      taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now,
      mailboxMessageIds: ["message-2", "unknown", "message-1", "message-2"],
    })).resolves.toBe("completed")

    const taskUpdateIndex = fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    const mailboxUpdateIndex = fake.calls.findIndex(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))
    const mailboxUpdate = fake.calls[mailboxUpdateIndex]
    expect(taskUpdateIndex).toBeGreaterThan(-1)
    expect(mailboxUpdateIndex).toBeGreaterThan(taskUpdateIndex)
    expect(mailboxUpdate?.[0]).toContain('message."consumedAt" IS NULL')
    expect(mailboxUpdate?.[1]).toEqual(["session-1", "task-1", ["message-2", "unknown", "message-1"]])
    expect(fake.calls.map(([sql]) => sql)).toContain("BEGIN")
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("does not confirm a completed mailbox id from another turn", async () => {
    const crossTurnId = "message-cross-turn"
    const mailboxRows = [{ id: crossTurnId, sessionId: "session-1", toTaskId: "task-1", turnId: "turn-old" }]
    const confirmedIds: string[] = []
    const fake = fakePool((sql, params) => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) {
        const hasTurnFence = sql.includes('message."turnId" = target."turnId"')
        const selected = mailboxRows.filter(row => params?.[2] instanceof Array && params[2].includes(row.id)
          && (!hasTurnFence || row.turnId === "turn-1"))
        confirmedIds.push(...selected.map(row => row.id))
        return { rows: selected, rowCount: selected.length }
      }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({
      taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now,
      mailboxMessageIds: [crossTurnId],
    })).resolves.toBe("completed")

    const mailboxUpdate = fake.calls.find(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))
    expect(mailboxUpdate?.[0]).toContain('message."turnId" = target."turnId"')
    expect(confirmedIds).toEqual([])
  })

  it("keeps completion idempotent when mailbox ids are unknown or already consumed", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["unknown", "unknown"] })).resolves.toBe("completed")
    expect(fake.calls.filter(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toHaveLength(1)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it.each([
    ["terminal failure", 1],
    ["retrying failure", 2],
  ] as const)("does not consume mailbox ids for a %s", async (_label, maxAttempts) => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, maxAttempts, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "failed", failureReason: "provider failed", now, mailboxMessageIds: ["message-1"] })).resolves.toBe(maxAttempts === 1 ? "failed" : "retrying")
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_outbox"'))).toBe(maxAttempts !== 1)
  })

  it.each([
    ["foreign owner", { leaseOwner: "worker-foreign" }],
    ["wrong attempt", { attemptCount: 2 }],
    ["expired lease", { leaseExpiresAt: new Date(now.getTime() - 1) }],
    ["foreign session", { sessionId: "session-other" }],
  ] as const)("fences a finish from a %s", async (_label, overrides) => {
    const fake = fakePool(sql => sql.includes('FROM "sub_agent_tasks" task') ? { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000), ...overrides })], rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["message-1"] })).resolves.toBeNull()
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
  })

  it("rejects finish when a lease expires while waiting for its task lock", async () => {
    const leaseExpiresAt = new Date(now.getTime() + 1_000)
    const checkedAt = new Date(leaseExpiresAt.getTime() + 1)
    const fake = fakePool(sql => {
      if (sql.startsWith("SELECT task.*, session.")) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt })], rowCount: 1 }
      if (sql.startsWith('SELECT clock_timestamp() AS "checkedAt"')) return { rows: [{ checkedAt }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    expect(now.getTime()).toBeLessThan(leaseExpiresAt.getTime())
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now })).resolves.toBeNull()
    const taskLock = fake.calls.findIndex(([sql]) => sql.includes("FOR UPDATE OF task"))
    const leaseClock = fake.calls.findIndex(([sql]) => sql.startsWith('SELECT clock_timestamp() AS "checkedAt"'))
    expect(leaseClock).toBeGreaterThan(taskLock)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("rolls back when the task update loses its fence", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 0 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["message-1"] })).resolves.toBeNull()
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
    expect(fake.calls.some(([sql]) => sql.includes('UPDATE "agent_mailbox_messages"'))).toBe(false)
  })

  it("rolls back both writes when mailbox confirmation fails", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.includes('UPDATE "agent_mailbox_messages"')) throw new Error("mailbox unavailable")
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now, mailboxMessageIds: ["message-1"] })).rejects.toThrow("mailbox unavailable")
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
  })

  it("does not report completion when the lease fence update loses a race", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 0 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now })).resolves.toBeNull()
  })

  it.each(["aborted", "archived"] as const)("does not finish a child in a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" task')) return { rows: [taskRow({ status: "running", sessionStatus: status, leaseOwner: "worker-1", attemptCount: 1, leaseExpiresAt: new Date(now.getTime() + 60_000) })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 0 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.finish({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, status: "completed", now })).resolves.toBeNull()
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
  })

  it("releases only the fenced running lease and republishes its outbox row", async () => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.release({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe(true)
    const updates = fake.calls.filter(([sql]) => sql.startsWith("UPDATE"))
    expect(updates).toHaveLength(2)
    expect(updates[0]?.[0]).toContain('"leaseOwner" = $3')
    expect(updates[0]?.[0]).toContain('"status" = \'running\'')
    expect(updates[0]?.[0]).toContain('"attemptCount" = $4')
    expect(updates[0]?.[0]).toContain('"updatedAt" = $5')
    expect(updates[0]?.[0]).toContain('"interruptRequestedAt" IS NULL')
    expect(updates[0]?.[0]).toContain('"leaseExpiresAt" > clock_timestamp()')
    expect(updates[0]?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(updates[1]?.[0]).toContain("publishedAt")
    expect(updates[1]?.[0]).toContain('"topic" = \'agent.subagent.dispatch\'')
    expect(updates[1]?.[0]).toContain('"idempotencyKey" = $1')
    expect(updates[1]?.[0]).toContain('"aggregateId" = $2')
    expect(updates[1]?.[1]).toEqual(["subagent-dispatch:task-1", "session-1"])
  })

  it("does not release or redispatch a lease that expires while waiting for its task lock", async () => {
    const leaseExpiresAt = new Date(now.getTime() + 1_000)
    const checkedAt = new Date(leaseExpiresAt.getTime() + 1)
    const fake = fakePool(sql => {
      if (sql.startsWith('SELECT "leaseExpiresAt" FROM "sub_agent_tasks"')) return { rows: [{ leaseExpiresAt }], rowCount: 1 }
      if (sql.startsWith("SELECT clock_timestamp()")) return { rows: [{ checkedAt }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    expect(now.getTime()).toBeLessThan(leaseExpiresAt.getTime())
    await expect(store.release({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox"'))).toBe(false)
  })

  it.each(["aborted", "archived"] as const)("does not release a child in a %s session", async status => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 0 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.release({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe(false)
    const updates = fake.calls.filter(([sql]) => sql.startsWith("UPDATE"))
    expect(updates).toHaveLength(1)
    expect(updates[0]?.[0]).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
    expect(updates.some(([sql]) => sql.includes('"agent_outbox"'))).toBe(false)
  })

  it("surfaces a durable interrupt during heartbeat instead of renewing", async () => {
    const fake = fakePool(sql => {
      if (sql.startsWith("UPDATE")) return { rows: [{ interruptRequestedAt: now }], rowCount: 1 }
      if (sql.startsWith("SELECT") && sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.heartbeat({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("interrupted")
    const update = fake.calls.find(([sql]) => sql.startsWith("UPDATE"))?.[0] ?? ""
    expect(update).toContain('"attemptCount" = $5')
    expect(update).toContain('"leaseExpiresAt" > clock_timestamp()')
    expect(update).toContain('LEAST(clock_timestamp()')
    expect(update).toContain('session."status" NOT IN (\'aborted\', \'archived\')')
  })

  it("rejects heartbeat when its task lock wait outlives the lease", async () => {
    const leaseExpiresAt = new Date(now.getTime() + 1_000)
    const checkedAt = new Date(leaseExpiresAt.getTime() + 1)
    const fake = fakePool(sql => {
      if (sql.startsWith('SELECT "leaseExpiresAt" FROM "sub_agent_tasks"')) return { rows: [{ leaseExpiresAt }], rowCount: 1 }
      if (sql.startsWith("SELECT clock_timestamp()")) return { rows: [{ checkedAt }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    expect(now.getTime()).toBeLessThan(leaseExpiresAt.getTime())
    await expect(store.heartbeat({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("lost")
    const taskLock = fake.calls.findIndex(([sql]) => sql.startsWith('SELECT "leaseExpiresAt" FROM "sub_agent_tasks"'))
    const leaseClock = fake.calls.findIndex(([sql]) => sql.startsWith("SELECT clock_timestamp()"))
    expect(leaseClock).toBeGreaterThan(taskLock)
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("finishes a marker-backed interrupted Turn through canonical TaskGraph receipts", async () => {
    const fake = fakeInterruptedTurnPool()
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.heartbeat({ taskId: "child-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("interrupted")
    const fallback = fake.calls.find(([sql]) => sql.includes('SELECT task."interruptRequestedAt"'))?.[0] ?? ""
    expect(fallback).toContain('turn."status" AS "turnStatus"')
    expect(fallback).toContain('task."leaseOwner" = $3')
    expect(fallback).toContain('task."attemptCount" = $4')
    expect(fallback).toContain('task."leaseExpiresAt" > clock_timestamp()')

    await expect(store.finish({
      taskId: "child-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "failed", failureReason: "Turn stopped", retryDisposition: "terminal", now,
    })).resolves.toBe("interrupted")

    expect(fake.statuses.get("child-1")).toBe("interrupted")
    expect(fake.statuses.get("dependent-1")).toBe("cancelled")
    const events = fake.lifecycleEvents.map(value => (value as { kind?: string; event?: { type?: string } }))
    expect(events.filter(value => value.kind === "lifecycle").map(value => value.event?.type)).toEqual(["task.interrupted", "task.cancelled"])
    expect(fake.revision()).toBe(4)
    expect(fake.pendingDispatches.has("subagent-dispatch:child-1")).toBe(false)
    const deletion = fake.calls.find(([sql, params]) => sql.startsWith('DELETE FROM "agent_outbox"') && params?.[1] === "subagent-dispatch:child-1")
    expect(deletion?.[0]).toContain('"topic" = \'agent.subagent.dispatch\'')
    expect(deletion?.[0]).toContain('"publishedAt" IS NULL')
    expect(deletion?.[1]).toEqual(["session-1", "subagent-dispatch:child-1"])
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("rolls back terminal finish for a marked graph child when its TaskGraph item is missing", async () => {
    const fake = fakeInterruptedTurnPool({ missingGraphItem: true })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.finish({
      taskId: "child-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1,
      status: "failed", retryDisposition: "terminal", now, mailboxMessageIds: ["message-1"],
    })).rejects.toThrow("task_graph_state_missing")

    expect(fake.statuses.get("child-1")).toBe("running")
    expect(fake.statuses.get("dependent-1")).toBe("waiting")
    expect(fake.calls.some(([sql]) => sql.includes("event.\"payload\"->>'kind' = 'proposal'"))).toBe(true)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('INSERT INTO "agent_events"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('"agent_outbox"'))).toBe(false)
    expect(fake.calls.some(([sql]) => sql.includes('"agent_mailbox_messages"'))).toBe(false)
    expect(fake.calls.map(([sql]) => sql)).toContain("ROLLBACK")
  })

  it("does not classify a marker alone as an interrupted Turn after renewal loses its fence", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ status: "running" }], rowCount: 1 }
      if (sql.startsWith('UPDATE "sub_agent_tasks"')) return { rowCount: 0 }
      if (sql.includes('SELECT task."interruptRequestedAt"')) return { rows: [{ interruptRequestedAt: now, turnStatus: "in_progress" }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)

    await expect(store.heartbeat({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("lost")
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"') && sql.includes('SET "status"'))).toBe(false)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it.each(["aborted", "archived"] as const)("does not renew a child in a %s session", async status => {
    const fake = fakePool(sql => {
      if (sql.startsWith("UPDATE")) return { rowCount: 0 }
      if (sql.startsWith("SELECT") && sql.includes('FROM "agent_sessions"')) return { rows: [{ status }], rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.heartbeat({ taskId: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1, now })).resolves.toBe("interrupted")
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("marks the whole root tree for interruption without cancelling terminal tasks", async () => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptTree({ sessionId: "session-1", rootTaskId: "task-1", now })).resolves.toBe(3)
    const select = fake.calls.find(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))?.[0] ?? ""
    const updates = fake.calls.filter(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(select).toContain('"status" IN (\'queued\', \'running\', \'retrying\', \'waiting\', \'waiting_for_user\')')
    expect(updates).toHaveLength(3)
    expect(updates.some(([sql]) => sql.includes('"interruptRequestedAt"') && sql.includes("'running'"))).toBe(true)
    expect(updates.some(([sql]) => sql.includes('"nextAttemptAt" = NULL'))).toBe(true)
  })

  it("interrupts every nonterminal task for an owned Turn", async () => {
    const fake = fakePool(sql => sql.startsWith("UPDATE") ? { rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptTurn({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", now })).resolves.toBe(2)
    const select = fake.calls.find(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))?.[0] ?? ""
    const updates = fake.calls.filter(([sql]) => sql.startsWith('UPDATE "sub_agent_tasks"'))
    expect(select).toContain('session."userId" = $3')
    expect(select).toContain('task."turnId" = $2')
    expect(updates).toHaveLength(2)
    expect(updates.some(([sql]) => sql.includes('"interruptRequestedAt"'))).toBe(true)
  })

  it("interrupts only the requested path subtree in a transaction", async () => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", status: "running" }], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptSubtree({ sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/child-a", now })).resolves.toBe(3)
    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const updateIndex = fake.calls.findIndex(([sql]) => sql.startsWith("UPDATE"))
    const select = fake.calls.find(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))?.[0] ?? ""
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(sessionIndex).toBeLessThan(updateIndex)
    expect(select).toContain('"rootTaskId" = $2')
    expect(select).toContain('(task."path" = $3 OR task."path" LIKE $3 || \'/%\')')
    expect(fake.calls.map(([sql]) => sql)).toContain("BEGIN")
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it.each(["aborted", "archived"] as const)("does not update tasks for a %s session", async status => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [{ id: "session-1", status }], rowCount: 1 } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptSubtree({ sessionId: "session-1", rootTaskId: "root-1", targetPath: "/root-1/child-a", now })).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
    expect(fake.calls.find(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))?.[0]).toContain('FOR UPDATE')
    expect(fake.calls.some(([sql]) => sql.includes('SELECT task."id", task."status", task."attemptCount"'))).toBe(false)
    expect(fake.calls.map(([sql]) => sql)).toContain("COMMIT")
  })

  it("does not update tasks when the scoped session is missing", async () => {
    const fake = fakePool(sql => sql.includes('FROM "agent_sessions"') ? { rows: [] } : {})
    const store = new PgSubagentTaskStore(fake.pool)
    await expect(store.interruptSubtree({ sessionId: "missing-session", rootTaskId: "root-1", targetPath: "/root-1/child-a", now })).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"] as const)("reclaims stale leases from an open %s session", async sessionStatus => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1")) return { rows: [{ id: "task-1", sessionId: "session-1", rootTaskId: "task-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status: sessionStatus }], rowCount: 1 }
      if (sql.includes('session."status" AS "sessionStatus"')) return { rows: [taskRow({ status: "running", sessionStatus, leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 1), attemptCount: 1 })], rowCount: 1 }
      if (sql.includes("leaseExpiresAt") && sql.includes("FOR UPDATE OF task")) return { rows: [taskRow({ status: "running", sessionStatus, leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 1), attemptCount: 1 })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.recoverExpired({ now, limit: 10 })
    expect(result).toHaveLength(1)
    expect(result[0].status).toBe("queued")
    const scan = fake.calls.find(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("LIMIT $1"))?.[0] ?? ""
    const taskLock = fake.calls.find(([sql]) => sql.includes("FOR UPDATE OF task"))?.[0] ?? ""
    expect(scan).toContain("LIMIT $1")
    expect(scan).not.toContain("FOR UPDATE")
    expect(taskLock).toContain("FOR UPDATE OF task")
  })

  it.each(["aborted", "archived"] as const)("reclaims a stale child from a %s session as interrupted", async status => {
    const fake = fakePool(sql => {
      if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: "session-1", userId: "user-1", status }], rowCount: 1 }
      if (sql.includes('session."status" AS "sessionStatus"')) return { rows: [taskRow({ status: "running", sessionStatus: status, leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 1), attemptCount: 1 })], rowCount: 1 }
      if (sql.includes("leaseExpiresAt") && sql.includes("FOR UPDATE OF task")) return { rows: [taskRow({ status: "running", sessionStatus: status, leaseOwner: "dead-worker", leaseExpiresAt: new Date(now.getTime() - 1), attemptCount: 1 })], rowCount: 1 }
      if (sql.startsWith("UPDATE")) return { rowCount: 1 }
      return {}
    })
    const store = new PgSubagentTaskStore(fake.pool)
    const result = await store.recoverExpired({ now, limit: 10 })
    expect(result[0]?.status).toBe("interrupted")
    const select = fake.calls.find(([sql]) => sql.includes('session."status" AS "sessionStatus"'))?.[0] ?? ""
    expect(select).toContain('session."status"')
  })
})
