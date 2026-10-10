import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope } from "./task-graph-pg-state.js"
import type { GraphIdentityScope, GraphScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, TASK_GRAPH_ITEM_TYPE, taskGraphItemId, taskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryCall = { sql: string; values: readonly unknown[] }
type ClientOptions = {
  itemContent?: unknown
  taskRows?: Array<Record<string, unknown>>
  events?: Array<{ type: string; payload: unknown; itemId?: unknown; taskId?: unknown; idempotencyKey?: unknown; causationId?: unknown }>
  sourceRows?: Array<Record<string, unknown>>
  failFence?: "session" | "turn" | "parent" | "step"
  sessionLockWait?: () => Promise<void>
  expireDuringSessionLockWait?: "turn" | "parent"
}

const empty: QueryResult = { rows: [], rowCount: 0 }
const identity: GraphIdentityScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
}
const scope: GraphScope = {
  ...identity, stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 3,
  parentLeaseOwner: "parent-owner", parentAttemptCount: 2,
}

function validSnapshot(nodeCount = 1) {
  return {
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      key: index === 0 ? "child" : `child-${index + 1}`,
      templateId: "analyst", goal: "Inspect the source", successCriteria: ["Evidence captured"],
      dependsOn: [], depth: 1, taskId: `child-${index + 1}`,
    })),
  }
}

function validTaskRow(overrides: Record<string, unknown> = {}) {
  return { id: "child-1", status: "queued", role: "analyst", failureReason: null, result: null, ...overrides }
}

const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const
const findingReport = {
  verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "failed", reasonCode: "criterion_not_met",
  criteria: [{ criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met" }], evidenceDigest: "a".repeat(64), resultDigest: "e".repeat(64),
} as const
const passedFindingReport = {
  verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
  criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "b".repeat(64), resultDigest: "f".repeat(64),
} as const

function typedSnapshot() {
  const snapshot = validSnapshot()
  return {
    ...snapshot,
    nodes: snapshot.nodes.map(node => ({ ...node, verification: analystVerification, verificationDisposition: "typed" as const })),
  }
}

function completedEnvelope(structuredResult: unknown, finalText = "persisted child text") {
  return { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "internal-item-id", finalText, structuredResult }
}

function scoutResult(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed",
    candidates: [{ jobId: "job-42", source: "greenhouse", url: "https://example.test/apply?email=person@example.com", evidenceIds: ["private-evidence-id"] }],
    evidence: [{ id: "private-evidence-id", kind: "job", ref: "job-42", source: "Ada Lovelace" }],
    summary: "Ada Lovelace found https://private.example/apply",
    ...overrides,
  }
}

function fakeClient(options: ClientOptions = {}) {
  const calls: QueryCall[] = []
  const itemId = taskGraphItemId(identity.parentTaskId)
  let wallClockAfterSessionLockWait = false
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []): Promise<QueryResult> => {
      calls.push({ sql, values })
      if (sql.startsWith('SELECT "id" FROM "agent_sessions"')) {
        await options.sessionLockWait?.()
        wallClockAfterSessionLockWait = true
        return options.failFence === "session" ? empty : { rows: [{ id: identity.sessionId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_turns"')) {
        return options.failFence === "turn" ? empty : { rows: [{ id: identity.turnId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task.*, session."userId" AS "userId"')) {
        return options.failFence === "parent" ? empty : { rows: [{ id: identity.parentTaskId }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT "id" FROM "agent_steps"')) {
        return options.failFence === "step" ? empty : { rows: [{ id: scope.stepId }], rowCount: 1 }
      }
      if (sql.startsWith("WITH wall_clock AS MATERIALIZED")) {
        return {
          rows: [{
            turnLeaseValid: !(wallClockAfterSessionLockWait && options.expireDuringSessionLockWait === "turn"),
            parentLeaseValid: !(wallClockAfterSessionLockWait && options.expireDuringSessionLockWait === "parent"),
          }],
          rowCount: 1,
        }
      }
      if (sql.startsWith('SELECT item."id"')) {
        return { rows: [{ id: itemId, revision: 4, content: options.itemContent ?? validSnapshot(), createdAt: new Date("2026-09-20T12:00:00.000Z") }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task."id", task."status"')) {
        return { rows: options.taskRows ?? [validTaskRow()], rowCount: (options.taskRows ?? [validTaskRow()]).length }
      }
      if (sql.startsWith('SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload"')) {
        const rows = options.events ?? []
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith("WITH current_steps AS MATERIALIZED")) {
        const rows = options.sourceRows ?? []
        return { rows, rowCount: rows.length }
      }
      return empty
    }),
  }
  return { client: client as unknown as Pick<pg.PoolClient, "query">, calls }
}

describe("TaskGraph PostgreSQL state loading", () => {
  it("restores a typed contract from persisted canonical content across a Worker restart", async () => {
    const persisted = canonicalTaskGraphJson(typedSnapshot())
    const first = fakeClient({ itemContent: persisted })
    const firstWorker = await loadTaskGraph(first.client, identity)

    expect(firstWorker.snapshot?.nodes[0]).toMatchObject({ verificationDisposition: "typed", verification: analystVerification })
    expect(firstWorker.state?.nodes[0]?.verification).toEqual(analystVerification)
    expect(first.calls.some(call => call.sql.startsWith("WITH current_steps AS MATERIALIZED"))).toBe(false)
    expect(currentTaskGraph(firstWorker).nodes[0]).not.toHaveProperty("inputRelation")
    const rewritten = taskGraphSnapshot(firstWorker.state!, new Map([["child", "child-1"]]))
    const restartedWorker = await loadTaskGraph(fakeClient({ itemContent: canonicalTaskGraphJson(rewritten) }).client, identity)
    expect(restartedWorker.snapshot?.nodes[0]).toMatchObject({ verificationDisposition: "typed", verification: analystVerification })
    expect(restartedWorker.state?.nodes[0]?.verification).toEqual(analystVerification)
  })

  it("projects only the exact server-authored verification report for snapshot criteria", async () => {
    const report = { ...findingReport, privateOutput: "person@example.com" }
    const fake = fakeClient({ itemContent: typedSnapshot(), taskRows: [validTaskRow({
      status: "failed", role: "analyst", result: { taskGraphVerificationReport: findingReport, raw: "private raw output" },
    })] })
    const node = currentTaskGraph(await loadTaskGraph(fake.client, identity)).nodes[0]!
    expect(node).toMatchObject({ verificationCriterionIds: ["finding-count"], verificationReport: findingReport })
    expect(JSON.stringify(node)).not.toContain("private raw output")
    const malformed = fakeClient({ itemContent: typedSnapshot(), taskRows: [validTaskRow({
      status: "failed", role: "analyst", result: { taskGraphVerificationReport: report },
    })] })
    await expect(loadTaskGraph(malformed.client, identity).then(currentTaskGraph)).rejects.toThrow("task_graph_verification_report_invalid")
    const wrongCriterion = fakeClient({ itemContent: typedSnapshot(), taskRows: [validTaskRow({
      status: "failed", role: "analyst", result: { taskGraphVerificationReport: { ...findingReport, criteria: [{ ...findingReport.criteria[0], criterionId: "other" }] } },
    })] })
    await expect(loadTaskGraph(wrongCriterion.client, identity).then(currentTaskGraph)).rejects.toThrow("task_graph_verification_report_invalid")
    const missing = fakeClient({ itemContent: typedSnapshot(), taskRows: [validTaskRow({ status: "completed", role: "analyst" })] })
    await expect(loadTaskGraph(missing.client, identity).then(currentTaskGraph)).rejects.toThrow("task_graph_verification_report_invalid")
    const incoherent = fakeClient({ itemContent: typedSnapshot(), taskRows: [validTaskRow({
      status: "completed", role: "analyst", result: { taskGraphVerificationReport: { ...findingReport, status: "passed", reasonCode: "criteria_met" } },
    })] })
    await expect(loadTaskGraph(incoherent.client, identity).then(currentTaskGraph)).rejects.toThrow("task_graph_verification_report_invalid")
  })

  it("restores advisory source checkpoint intent from a validated causal proposal receipt", async () => {
    const content = validSnapshot()
    const itemId = taskGraphItemId(identity.parentTaskId)
    const payload = {
      kind: "proposal", fingerprint: "a".repeat(64), revision: 1,
      receipt: { status: "accepted", revision: 1, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"] },
      item: {
        schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: identity.sessionId, turnId: identity.turnId,
        stepId: "cause-step", taskId: identity.parentTaskId, type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null,
        revision: 1, content,
      },
    }
    const fake = fakeClient({
      itemContent: content,
      events: [{
        type: "item.started", itemId, taskId: identity.parentTaskId, idempotencyKey: `${itemId}:proposal:0`,
        causationId: "cause-step", payload,
      }],
      sourceRows: [
        { id: "cause-step", sessionId: identity.sessionId, turnId: identity.turnId, taskId: identity.parentTaskId,
          rootTaskId: identity.rootTaskId, userId: identity.userId, inputThroughSequence: "1", consumedInputIds: ["input-before"], isCurrent: false },
        { id: "current-step", sessionId: identity.sessionId, turnId: identity.turnId, taskId: identity.parentTaskId,
          rootTaskId: identity.rootTaskId, userId: identity.userId, inputThroughSequence: "2", consumedInputIds: ["input-before", "input-after"], isCurrent: true },
      ],
    })
    const graph = await loadTaskGraph(fake.client, { ...identity, stepId: "current-step" }, true, true)
    const node = currentTaskGraph(graph).nodes[0]!
    const provenanceReads = fake.calls.filter(call => call.sql.startsWith("WITH current_steps AS MATERIALIZED"))

    expect(node).toMatchObject({ status: "queued", readiness: "ready", inputRelation: "predates_current_inputs" })
    expect(node).toHaveProperty("inputRelation", "predates_current_inputs")
    expect(provenanceReads).toHaveLength(1)
    expect(provenanceReads[0]?.values).toEqual([ ["cause-step"], "current-step", "root-1", "session-1", "turn-1", "root-1", "user-1" ])
  })

  it("projects repair receipts separately and preserves the original failed target report", async () => {
    const snapshot = typedSnapshot()
    const source = snapshot.nodes[0]!
    const repair = {
      ...source, key: "repair", taskId: "child-2", repairOf: {
        graphRootTaskId: "root-1", nodeKey: source.key, taskId: source.taskId, criterionIds: ["finding-count"],
      },
    }
    const itemContent = { ...snapshot, nodes: [source, repair] }
    const passed = { ...findingReport, status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "b".repeat(64) }
    const receipt = {
      schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: "root-1", targetNodeKey: "child", targetTaskId: "child-1", criterionIds: ["finding-count"],
      repairNodeKey: "repair", repairTaskId: "child-2", verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: passed.evidenceDigest,
    }
    const fake = fakeClient({ itemContent, taskRows: [
      validTaskRow({ status: "failed", role: "analyst", result: { taskGraphVerificationReport: findingReport } }),
      validTaskRow({ id: "child-2", status: "completed", role: "analyst", result: { taskGraphVerificationReport: passed, taskGraphRepairReceipt: receipt } }),
    ] })
    const nodes = currentTaskGraph(await loadTaskGraph(fake.client, identity)).nodes
    expect(nodes[0]).toMatchObject({ verificationReport: findingReport })
    expect(nodes[0]).not.toHaveProperty("repairReceipt")
    expect(nodes[1]).toMatchObject({ verificationReport: passed, repairReceipt: receipt, repairOf: repair.repairOf })
    const missingReceipt = fakeClient({ itemContent, taskRows: [
      validTaskRow({ status: "failed", role: "analyst", result: { taskGraphVerificationReport: findingReport } }),
      validTaskRow({ id: "child-2", status: "completed", role: "analyst", result: { taskGraphVerificationReport: passed } }),
    ] })
    await expect(loadTaskGraph(missingReceipt.client, identity).then(currentTaskGraph)).rejects.toThrow("task_graph_verification_report_invalid")
  })

  it("retains legacy_unverified on pre-verifier snapshots through load, rewrite, and restart", async () => {
    const oldSnapshot = validSnapshot()
    const firstWorker = await loadTaskGraph(fakeClient({ itemContent: oldSnapshot }).client, identity)

    expect(firstWorker.snapshot?.nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })
    expect(firstWorker.snapshot?.nodes[0]).not.toHaveProperty("verification")
    expect(firstWorker.state?.nodes[0]?.verification).toBeUndefined()
    const rewritten = taskGraphSnapshot(firstWorker.state!, new Map([["child", "child-1"]]))
    const restartedWorker = await loadTaskGraph(fakeClient({ itemContent: canonicalTaskGraphJson(rewritten) }).client, identity)
    expect(restartedWorker.snapshot?.nodes[0]).toMatchObject({ verificationDisposition: "legacy_unverified" })
    expect(restartedWorker.snapshot?.nodes[0]).not.toHaveProperty("verification")
  })

  it("keeps legacy and specialized terminal nodes compatible without generic reports", async () => {
    const legacy = fakeClient({ itemContent: validSnapshot(), taskRows: [validTaskRow({ status: "completed" })] })
    expect(currentTaskGraph(await loadTaskGraph(legacy.client, identity)).nodes[0]).not.toHaveProperty("verificationReport")
    const specialized = {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [{ key: "child", taskId: "child-1", templateId: "cover_letter_writer", goal: "Write", successCriteria: ["Save"], dependsOn: [], depth: 1, verificationDisposition: "specialized" }],
    }
    const writer = fakeClient({ itemContent: specialized, taskRows: [validTaskRow({ status: "completed", role: "writer" })] })
    expect(currentTaskGraph(await loadTaskGraph(writer.client, identity)).nodes[0]).not.toHaveProperty("verificationReport")
  })

  it("binds tenant, session, turn, root, parent, and lease identities on scoped reads", async () => {
    const fake = fakeClient()

    await lockTaskGraphScope(fake.client, scope)
    const loaded = await loadTaskGraph(fake.client, identity)

    expect(loaded.state?.revision).toBe(4)
    const session = fake.calls.find(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"'))
    expect(session?.sql).toContain('"id" = $1 AND "userId" = $2')
    expect(session?.values).toEqual(["session-1", "user-1"])
    const turn = fake.calls.find(call => call.sql.startsWith('SELECT "id" FROM "agent_turns"'))
    expect(turn?.sql).toContain('"rootTaskId" = $4')
    expect(turn?.sql).toContain('"leaseOwnerId" = $5 AND "leaseVersion" = $6')
    expect(turn?.sql).not.toContain('"leaseExpiresAt"')
    expect(turn?.values).toEqual(["turn-1", "session-1", "user-1", "root-1", "turn-owner", 3])
    const parent = fake.calls.find(call => call.sql.startsWith('SELECT task.*, session."userId" AS "userId"'))
    expect(parent?.sql).toContain('task."rootTaskId" = $4 AND session."userId" = $5')
    expect(parent?.sql).toContain('task."leaseOwner" = $6 AND task."attemptCount" = $7')
    expect(parent?.sql).not.toContain('task."leaseExpiresAt"')
    expect(parent?.values).toEqual(["root-1", "session-1", "turn-1", "root-1", "user-1", "parent-owner", 2])
    const step = fake.calls.find(call => call.sql.startsWith('SELECT "id" FROM "agent_steps"'))
    expect(step?.values).toEqual(["step-1", "turn-1", "session-1", "root-1"])
    const leases = fake.calls.find(call => call.sql.startsWith("WITH wall_clock AS MATERIALIZED"))
    expect(leases?.sql).toContain("clock_timestamp()")
    expect(leases?.sql).not.toContain("CURRENT_TIMESTAMP")
    expect(leases?.sql).toContain('turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6')
    expect(leases?.sql).toContain('task."leaseOwner" = $8 AND task."attemptCount" = $9')
    expect(leases?.values).toEqual(["turn-1", "session-1", "user-1", "root-1", "turn-owner", 3, "root-1", "parent-owner", 2])
    expect(fake.calls.indexOf(leases!)).toBeGreaterThan(fake.calls.indexOf(step!))

    const item = fake.calls.find(call => call.sql.startsWith('SELECT item."id"'))
    expect(item?.sql).toContain('item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4')
    expect(item?.sql).toContain('turn."userId" = $5 AND session."userId" = $5')
    expect(item?.values).toEqual([taskGraphItemId("root-1"), "session-1", "turn-1", "root-1", "user-1"])
    const tasks = fake.calls.find(call => call.sql.startsWith('SELECT task."id", task."status"'))
    expect(tasks?.sql).toContain('task."rootTaskId" = $4 AND task."parentTaskId" = $5 AND session."userId" = $6')
    expect(tasks?.values).toEqual([["child-1"], "session-1", "turn-1", "root-1", "root-1", "user-1"])
    const events = fake.calls.find(call => call.sql.startsWith('SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload"'))
    expect(events?.sql).toContain('SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload"')
    expect(events?.sql).toContain('event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3')
    expect(events?.sql).toContain('session."userId" = $4 AND turn."userId" = $4')
    expect(events?.values).toEqual(["session-1", "turn-1", taskGraphItemId("root-1"), "user-1"])
  })

  it("redacts sensitive failure and result text and truncates each to 500 UTF-8 bytes", async () => {
    const secret = "authorization: Bearer abcdefghijklmnop user@example.com\n" + "detail ".repeat(120)
    const fake = fakeClient({ taskRows: [validTaskRow({ status: "failed", failureReason: secret, result: { summary: secret } })] })
    const graph = await loadTaskGraph(fake.client, identity)
    const node = currentTaskGraph(graph).nodes[0]!

    expect(node.failureReason).not.toContain("abcdefghijklmnop")
    expect(node.failureReason).not.toContain("user@example.com")
    expect(node.failureReason).not.toContain("\n")
    expect(Buffer.byteLength(node.failureReason ?? "", "utf8")).toBeLessThanOrEqual(500)
    expect(node.resultSummary).not.toContain("abcdefghijklmnop")
    expect(node.resultSummary).not.toContain("user@example.com")
    expect(node.resultSummary).not.toContain("\n")
    expect(Buffer.byteLength(node.resultSummary ?? "", "utf8")).toBeLessThanOrEqual(500)
  })

  it("recovers a bounded validated projection from a persisted nested result larger than the wait cap", async () => {
    const result = completedEnvelope(scoutResult(), "final text beyond wait cap ".repeat(140))
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeGreaterThan(2 * 1024)
    const fake = fakeClient({ taskRows: [validTaskRow({ status: "completed", role: "scout", result })] })
    const graph = await loadTaskGraph(fake.client, identity)
    const node = currentTaskGraph(graph).nodes[0]!

    expect(node.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
      trust: "untrusted", availability: "available", role: "scout", status: "completed",
      candidateCount: 1, evidenceCount: 1,
      candidates: [{ jobId: "job-42", source: "greenhouse", evidenceKinds: ["job"] }],
    })
    const encodedProjection = JSON.stringify(node.resultProjection)
    expect(Buffer.byteLength(encodedProjection, "utf8")).toBeLessThanOrEqual(2 * 1024)
    expect(encodedProjection).not.toContain("Ada Lovelace")
    expect(encodedProjection).not.toContain("private.example")
    expect(encodedProjection).not.toContain("private-evidence-id")
    expect(encodedProjection).not.toContain("internal-item-id")
    expect(encodedProjection).not.toContain("final text beyond wait cap")
  })

  it("maps unknown Scout source labels to other and omits model-authored URL and name text", async () => {
    const structured = scoutResult({
      candidates: [{
        jobId: "job-42", source: "Jane Doe", url: "https://private.example/apply", evidenceIds: ["private-evidence-id"],
      }],
      evidence: [{ id: "private-evidence-id", kind: "job", ref: "job-42", source: "Jane Doe" }],
      summary: "Jane Doe recommends https://private.example/apply",
    })
    const fake = fakeClient({ taskRows: [validTaskRow({ status: "completed", role: "scout", result: completedEnvelope(structured) })] })
    const graph = await loadTaskGraph(fake.client, identity)
    const projection = currentTaskGraph(graph).nodes[0]?.resultProjection

    expect(projection).toMatchObject({
      availability: "available",
      candidates: [{ jobId: "job-42", source: "other", evidenceKinds: ["job"] }],
    })
    expect(JSON.stringify(projection)).not.toContain("Jane Doe")
    expect(JSON.stringify(projection)).not.toContain("private.example")
    expect(JSON.stringify(projection)).not.toContain("private-evidence-id")
  })

  it("projects valid typed verification wrappers while leaving unrelated envelope keys invalid", async () => {
    const snapshot = {
      ...validSnapshot(),
      nodes: validSnapshot().nodes.map(node => ({
        ...node, templateId: "scout", verificationDisposition: "typed" as const, verification: scoutVerification,
      })),
    }
    const verifiedResult = {
      ...completedEnvelope(scoutResult()),
      taskGraphVerificationReport: {
        verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
        criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
        evidenceDigest: "c".repeat(64), resultDigest: "d".repeat(64),
      },
    }
    const valid = fakeClient({ itemContent: snapshot, taskRows: [validTaskRow({ status: "completed", role: "scout", result: verifiedResult })] })
    expect(currentTaskGraph(await loadTaskGraph(valid.client, identity)).nodes[0]?.resultProjection).toMatchObject({
      availability: "available", role: "scout", candidateCount: 1,
      candidates: [{ jobId: "job-42", evidenceKinds: ["job"] }],
    })

    const extra = fakeClient({
      itemContent: snapshot,
      taskRows: [validTaskRow({ status: "completed", role: "scout", result: { ...verifiedResult, unexpected: true } })],
    })
    expect(currentTaskGraph(await loadTaskGraph(extra.client, identity)).nodes[0]?.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })
  })

  it("projects a valid repair wrapper after checking its report and receipt", async () => {
    const snapshot = typedSnapshot()
    const target = snapshot.nodes[0]!
    const repair = {
      ...target, key: "repair", taskId: "child-2", repairOf: {
        graphRootTaskId: "root-1", nodeKey: target.key, taskId: target.taskId, criterionIds: ["finding-count"],
      },
    }
    const receipt = {
      schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: "root-1",
      targetNodeKey: target.key, targetTaskId: target.taskId, criterionIds: ["finding-count"],
      repairNodeKey: "repair", repairTaskId: "child-2", verifierVersion: "agent-harness.v2.task-graph-verifier.v1",
      evidenceDigest: passedFindingReport.evidenceDigest,
    }
    const structuredResult = {
      schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed",
      findings: [{ jobId: "job-42", score: 8, evidenceIds: ["private-evidence-id"] }],
      evidence: [{ id: "private-evidence-id", kind: "job", ref: "job-42", source: "greenhouse" }], summary: "Scored the fixture role",
    }
    const fake = fakeClient({ itemContent: { ...snapshot, nodes: [target, repair] }, taskRows: [
      validTaskRow({ status: "failed", role: "analyst", result: { taskGraphVerificationReport: findingReport } }),
      validTaskRow({ id: "child-2", status: "completed", role: "analyst", result: {
        ...completedEnvelope(structuredResult), taskGraphVerificationReport: passedFindingReport, taskGraphRepairReceipt: receipt,
      } }),
    ] })
    const nodes = currentTaskGraph(await loadTaskGraph(fake.client, identity)).nodes
    expect(nodes[1]?.resultProjection).toMatchObject({
      availability: "available", role: "analyst", findingCount: 1,
      findings: [{ jobId: "job-42", score: 8, evidenceKinds: ["job"] }],
    })
    expect(nodes[1]?.repairReceipt).toEqual(receipt)
  })

  it("uses an unavailable marker for an invalid role schema or an oversized persisted envelope", async () => {
    const invalid = fakeClient({
      taskRows: [validTaskRow({ status: "completed", role: "scout", result: completedEnvelope({ ...scoutResult(), unexpected: true }) })],
    })
    const invalidGraph = await loadTaskGraph(invalid.client, identity)
    expect(currentTaskGraph(invalidGraph).nodes[0]?.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })
    const malformedEnvelope = fakeClient({
      taskRows: [validTaskRow({ status: "completed", role: "scout", result: { ...completedEnvelope(scoutResult()), ownerId: "internal" } })],
    })
    const malformedGraph = await loadTaskGraph(malformedEnvelope.client, identity)
    expect(currentTaskGraph(malformedGraph).nodes[0]?.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })

    const oversized = fakeClient({
      taskRows: [validTaskRow({ status: "completed", role: "scout", result: completedEnvelope(scoutResult(), "x".repeat(17 * 1024)) })],
    })
    const oversizedGraph = await loadTaskGraph(oversized.client, identity)
    expect(currentTaskGraph(oversizedGraph).nodes[0]?.resultProjection).toEqual({
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
    })
  })

  it("keeps all eight node projections inside aggregate byte and item limits", async () => {
    const snapshot = validSnapshot(8)
    const taskRows = snapshot.nodes.map((node, index) => validTaskRow({
      id: node.taskId, status: "completed", role: "analyst",
      result: completedEnvelope({
        schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed",
        findings: [{
          jobId: `job-${index}-1`, score: 8, evidenceIds: [`evidence-${index}-1`],
        }, {
          jobId: `job-${index}-2`, score: 7, evidenceIds: [`evidence-${index}-2`],
        }, {
          jobId: `job-${index}-3`, score: 6, evidenceIds: [`evidence-${index}-3`],
        }],
        evidence: [1, 2, 3].map(item => ({
          id: `evidence-${index}-${item}`, kind: "job", ref: `job-${index}-${item}`, source: "https://private.example/person",
        })),
        summary: "private summary is omitted",
      }),
    }))
    const fake = fakeClient({ itemContent: snapshot, taskRows })
    const graph = await loadTaskGraph(fake.client, identity)
    const projections = currentTaskGraph(graph).nodes.map(node => node.resultProjection!)

    expect(projections).toHaveLength(8)
    expect(projections.every(projection => projection.availability === "available")).toBe(true)
    expect(projections[0]).toMatchObject({
      role: "analyst", findingCount: 3,
      findings: expect.arrayContaining([{ jobId: "job-0-1", score: 8, evidenceKinds: ["job"] }]),
    })
    expect(projections.reduce((total, projection) =>
      total + (projection.availability === "available" && projection.role === "analyst" ? projection.findings.length : 0), 0)).toBeLessThanOrEqual(24)
    expect(Buffer.byteLength(JSON.stringify(projections), "utf8")).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.stringify(projections)).not.toContain("private.example")
  })

  it("fails closed when the persisted snapshot or a scoped child row is invalid", async () => {
    const malformed = fakeClient({ itemContent: { schemaVersion: "unknown", nodes: [] } })
    await expect(loadTaskGraph(malformed.client, identity)).rejects.toThrow("task_graph_snapshot_invalid")
    expect(malformed.calls.some(call => call.sql.startsWith('SELECT task."id", task."status"'))).toBe(false)

    const missingTask = fakeClient({ taskRows: [] })
    await expect(loadTaskGraph(missingTask.client, identity)).rejects.toThrow("task_graph_task_scope_invalid")

    const wrongTask = fakeClient({ taskRows: [validTaskRow({ id: "other-child" })] })
    await expect(loadTaskGraph(wrongTask.client, identity)).rejects.toThrow("task_graph_task_missing")
  })

  it("fails closed when a persisted lifecycle envelope contains a malformed event", async () => {
    const fake = fakeClient({ events: [{ type: "item.delta", payload: { kind: "lifecycle", event: { type: "task.completed", nodeKey: 7 } } }] })
    await expect(loadTaskGraph(fake.client, identity)).rejects.toThrow("task_graph_lifecycle_event_invalid")
  })

  it("fails closed when a selected TaskGraph delta has no known envelope kind", async () => {
    const fake = fakeClient({ events: [{ type: "item.delta", payload: { revision: 2 } }] })
    await expect(loadTaskGraph(fake.client, identity)).rejects.toThrow("task_graph_event_envelope_invalid")
  })

  it("stops when session, turn, parent, or step ownership cannot be proven", async () => {
    for (const [fence, error] of [
      ["session", "task_graph_session_fenced"],
      ["turn", "task_graph_turn_fenced"],
      ["parent", "task_graph_parent_fenced"],
      ["step", "task_graph_step_fenced"],
    ] as const) {
      const fake = fakeClient({ failFence: fence })
      await expect(lockTaskGraphScope(fake.client, scope)).rejects.toThrow(error)
      expect(fake.calls.some(call => call.sql.startsWith('SELECT item."id"'))).toBe(false)
    }
  })

  it("rejects a Turn or parent lease that expires while waiting for the session lock", async () => {
    for (const [expiredLease, error] of [
      ["turn", "task_graph_turn_fenced"],
      ["parent", "task_graph_parent_fenced"],
    ] as const) {
      let releaseSessionLock!: () => void
      let notifySessionLockWait!: () => void
      const sessionLockBlocked = new Promise<void>(resolve => { releaseSessionLock = resolve })
      const sessionLockWaitStarted = new Promise<void>(resolve => { notifySessionLockWait = resolve })
      const fake = fakeClient({
        expireDuringSessionLockWait: expiredLease,
        sessionLockWait: async () => {
          notifySessionLockWait()
          await sessionLockBlocked
        },
      })

      const locking = lockTaskGraphScope(fake.client, scope)
      await sessionLockWaitStarted
      releaseSessionLock()
      await expect(locking).rejects.toThrow(error)

      const leases = fake.calls.find(call => call.sql.startsWith("WITH wall_clock AS MATERIALIZED"))
      expect(leases?.sql).toContain("clock_timestamp()")
      expect(leases?.sql).not.toContain("CURRENT_TIMESTAMP")
      expect(fake.calls.indexOf(leases!)).toBeGreaterThan(fake.calls.findIndex(call => call.sql.startsWith('SELECT "id" FROM "agent_sessions"')))
    }
  })

  it("rejects a parent/root identity mismatch before querying", async () => {
    const fake = fakeClient()
    await expect(lockTaskGraphScope(fake.client, { ...scope, parentTaskId: "child-1" })).rejects.toThrow("task_graph_scope_invalid")
    expect(fake.calls).toHaveLength(0)
  })
})
