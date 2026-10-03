import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { parseTaskGraphSnapshot, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION, verifyTaskGraphNodeEvidence, type TaskGraphVerificationScope } from "./task-graph-pg-verification.js"

const scope: TaskGraphVerificationScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", taskId: "child-1", attemptCount: 1,
}
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout" as const,
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } },
    { id: "evidence-count", check: { kind: "evidence_count_gte" as const, minimum: 1 } },
    { id: "bound-candidate", check: { kind: "all_candidates_have_evidence" as const, minimumItems: 1 } },
  ],
}
const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [{
  key: "discover", templateId: "scout", goal: "Find jobs", successCriteria: ["Find one"], dependsOn: [], depth: 1,
  taskId: scope.taskId, verificationDisposition: "typed", verification,
}] })
const node = snapshot.nodes[0] as StoredTaskGraphNode
const structuredResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["model-job-ref"] }],
  evidence: [{ id: "model-job-ref", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one job",
}

function durableRows(overrides: { items?: Record<string, unknown>[]; events?: Record<string, unknown>[]; task?: Record<string, unknown>; replaySources?: Record<string, unknown>[]; replayEvents?: Record<string, unknown>[] } = {}) {
  const callContent = { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null }
  const items = overrides.items ?? [
    { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", joinedStepId: "step-1", rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", ordinal: 0, attempt: 1, type: "tool_call", status: "completed", revision: 2, content: callContent },
    { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", joinedStepId: "step-1", rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", ordinal: 0, attempt: 1, type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse" }] }, errorCode: null } },
  ]
  const common = { itemId: "call-item", taskId: scope.taskId, correlationId: "call-1" }
  const events = overrides.events ?? [
    { id: "started", ...common, type: "tool_call.started", sequence: 1, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.search" } },
    { id: "completed", ...common, type: "tool_call.completed", sequence: 2, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.search", status: "completed", errorCode: null } },
  ]
  const task = overrides.task ?? { id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: 1, status: "running", role: "scout", userId: scope.userId }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT task."id"')) return { rows: [task], rowCount: 1 }
    if (sql.includes('SELECT item."id"')) return { rows: items, rowCount: items.length }
    if (sql.includes('SELECT result."sessionId"')) return { rows: overrides.replaySources ?? [], rowCount: overrides.replaySources?.length ?? 0 }
    if (sql.includes('SELECT event."id"')) {
      if (sql.includes('event."taskId" = $5')) return { rows: overrides.replayEvents ?? [], rowCount: overrides.replayEvents?.length ?? 0 }
      const itemIds = Array.isArray(values?.[3]) ? (values[3] as unknown[]).filter((value): value is string => typeof value === "string") : []
      const linkedEvents = events.filter(event => typeof event.itemId === "string" && itemIds.includes(event.itemId))
      return { rows: linkedEvents, rowCount: linkedEvents.length }
    }
    throw new Error("unexpected_verification_query")
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query, items, events }
}

function replayData(options: { sourceResultItemId?: string; sourceSessionId?: string; sourceAttempt?: number; sourceInput?: unknown; sourceOutput?: unknown; currentOutput?: unknown; missingTerminalLink?: boolean; duplicateProof?: boolean } = {}) {
  const replayScope = { ...scope, attemptCount: 2 }, sourceCallId = "prior-call", sourceResultItemId = options.sourceResultItemId ?? "prior-result-item"
  const source = { toolCallId: sourceCallId, resultItemId: sourceResultItemId }, output = { jobs: [{ id: "job-1", source: "greenhouse" }] }, sourceOutput = options.sourceOutput ?? output
  const currentCalls = ["step-current", ...(options.duplicateProof ? ["step-current-2"] : [])].map((stepId, index) => {
    const toolCallId = `task-graph-replay-v1:${createHash("sha256").update(JSON.stringify([stepId, sourceCallId])).digest("hex")}`
    return {
      call: { id: `replay-call-item-${index}`, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId, joinedStepId: stepId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", ordinal: 0, attempt: 2, type: "tool_call", status: "completed", revision: 2, content: { toolCallId, toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null } },
      result: { id: `replay-result-item-${index}`, sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId, joinedStepId: stepId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", ordinal: 0, attempt: 2, type: "tool_result", status: "completed", revision: 1, content: { toolCallId, output: options.currentOutput ?? output, errorCode: null } },
      toolCallId,
    }
  })
  const currentEvents = currentCalls.flatMap((current, index) => {
    const common = { itemId: current.call.id, taskId: scope.taskId, correlationId: current.toolCallId }
    const startedPayload = { taskId: scope.taskId, toolCallId: current.toolCallId, toolName: "jobs.search", toolVersion: "1", replaySource: source }
    const completedPayload = { taskId: scope.taskId, toolCallId: current.toolCallId, toolName: "jobs.search", toolVersion: "1",
      ...(index === 0 && options.missingTerminalLink ? {} : { replaySource: source }), status: "completed", errorCode: null }
    return [
      { id: `replay-start-${index}`, ...common, type: "tool_call.started", sequence: index * 2 + 1, payload: startedPayload },
      { id: `replay-completed-${index}`, ...common, type: "tool_call.completed", sequence: index * 2 + 2, payload: completedPayload },
    ]
  })
  const items = currentCalls.flatMap(current => [current.call, current.result])
  const priorAttempt = options.sourceAttempt ?? 1
  const sourceRows = [{
    sourceSessionId: options.sourceSessionId ?? scope.sessionId, sourceTurnId: scope.turnId, sourceTaskId: scope.taskId,
    sourceRootTaskId: scope.rootTaskId, sourceTurnRootTaskId: scope.rootTaskId, sourceParentTaskId: scope.parentTaskId, sourceUserId: scope.userId,
    sourceCallItemId: "prior-call-item", sourceCallStepId: "step-prior", sourceCallType: "tool_call", sourceCallStatus: "completed", sourceCallRevision: 2,
    sourceCallContent: { toolCallId: sourceCallId, toolName: "jobs.search", toolVersion: "1", input: options.sourceInput ?? {}, status: "completed", errorCode: null }, sourceCallAttempt: priorAttempt, sourceCallOrdinal: 0,
    sourceResultItemId, sourceResultStepId: "step-prior", sourceResultType: "tool_result", sourceResultStatus: "completed", sourceResultRevision: 1,
    sourceResultContent: { toolCallId: sourceCallId, output: sourceOutput, errorCode: null }, sourceResultAttempt: priorAttempt, sourceResultOrdinal: 0,
  }]
  const priorEvents = [
    { id: "prior-started", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, itemId: "prior-call-item", taskId: scope.taskId, correlationId: sourceCallId, type: "tool_call.started", sequence: 1, payload: { taskId: scope.taskId, toolCallId: sourceCallId, toolName: "jobs.search", toolVersion: "1" } },
    { id: "prior-completed", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, itemId: "prior-call-item", taskId: scope.taskId, correlationId: sourceCallId, type: "tool_call.completed", sequence: 2, payload: { taskId: scope.taskId, toolCallId: sourceCallId, toolName: "jobs.search", toolVersion: "1", status: "completed", errorCode: null } },
  ]
  const data = durableRows({ items, events: currentEvents, replaySources: sourceRows, replayEvents: priorEvents, task: { id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: 2, status: "running", role: "scout", userId: scope.userId } })
  return { data, replayScope, sourceRows, priorEvents }
}

describe("TaskGraph PostgreSQL verification evidence", () => {
  it("rebinds candidate evidence to persisted reads and returns a bounded digest receipt", async () => {
    const data = durableRows()
    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })

    const digest = result.report.evidenceDigest
    expect(result).toMatchObject({ verified: true, evaluation: { status: "passed", reasonCode: "criteria_met" } })
    expect(result.report).toMatchObject({ verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(result.report.criteria).toEqual([
      { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
      { criterionId: "evidence-count", status: "passed", reasonCode: "criteria_met" },
      { criterionId: "bound-candidate", status: "passed", reasonCode: "criteria_met" },
    ])
    expect(result.projection).toMatchObject({ evidenceIds: ["read:job:job-1"], candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }] })
    expect(JSON.stringify(result.report)).not.toContain("job-1")
    expect(data.query.mock.calls[0]?.[1]).toEqual([scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  })

  it("verifies a replay only through its explicit prior source link and includes source IDs in the digest", async () => {
    const first = replayData()
    const verified = await verifyTaskGraphNodeEvidence(first.data.client, { scope: first.replayScope, snapshot, node, structuredResult })
    expect(verified).toMatchObject({ verified: true, report: { status: "passed", evidenceDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } })

    const changedSourceId = replayData({ sourceResultItemId: "another-prior-result-item" })
    const changed = await verifyTaskGraphNodeEvidence(changedSourceId.data.client, { scope: changedSourceId.replayScope, snapshot, node, structuredResult })
    expect(changed.verified).toBe(true)
    expect(changed.report.evidenceDigest).not.toBe(verified.report.evidenceDigest)

    const missing = replayData({ missingTerminalLink: true })
    await expect(verifyTaskGraphNodeEvidence(missing.data.client, { scope: missing.replayScope, snapshot, node, structuredResult }))
      .resolves.toMatchObject({ verified: false, report: { status: "unverified", reasonCode: "canonical_evidence_invalid", evidenceDigest: null } })
  })

  it("rejects foreign, same-attempt, mismatched, and duplicate replay source proofs", async () => {
    const cases = [
      replayData({ sourceSessionId: "foreign-session" }),
      replayData({ sourceAttempt: 2 }),
      replayData({ sourceInput: { query: "different input" } }),
      replayData({ sourceOutput: { jobs: [{ id: "job-other", source: "greenhouse" }] } }),
      replayData({ sourceOutput: { truncated: true, preview: "{}", byteLength: 100 } }),
      replayData({ duplicateProof: true }),
    ]
    for (const item of cases) {
      const result = await verifyTaskGraphNodeEvidence(item.data.client, { scope: item.replayScope, snapshot, node, structuredResult })
      expect(result.verified).toBe(false)
      expect(result.report.status).toBe("unverified")
      expect(result.report.evidenceDigest).toBeNull()
    }
  })

  it("rejects duplicate terminal receipts even when their payloads agree", async () => {
    const data = durableRows()
    const duplicate = { ...data.events[1]!, id: "duplicate-completion", sequence: 3 }
    const result = await verifyTaskGraphNodeEvidence(data.client, {
      scope, snapshot, node, structuredResult,
    })
    expect(result.verified).toBe(true)

    const duplicateData = durableRows({ events: [...data.events, duplicate] })
    const rejected = await verifyTaskGraphNodeEvidence(duplicateData.client, { scope, snapshot, node, structuredResult })
    expect(rejected.verified).toBe(false)
    expect(rejected.report.status).toBe("unverified")
    expect(rejected.report.reasonCode).toBe("canonical_evidence_ambiguous")
    expect(rejected.report.evidenceDigest).toBeNull()
  })

  it("ignores detached lifecycle copies while verifying canonical item-linked receipts", async () => {
    const canonical = durableRows()
    const detached = canonical.events.map(event => ({ ...event, id: `detached-${String(event.id)}`, itemId: null }))
    const data = durableRows({ events: [...canonical.events, ...detached] })

    await expect(verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })).resolves.toMatchObject({ verified: true })

    const eventQuery = data.query.mock.calls.find(([sql]) => sql.includes('SELECT event."id"'))
    expect(eventQuery?.[0]).toContain('event."itemId" = ANY($4::text[])')
    expect(eventQuery?.[0]).not.toContain('event."correlationId" = ANY')
    expect(eventQuery?.[1]).toEqual([scope.sessionId, scope.turnId, scope.userId, ["call-item"]])
  })

  it("does not count model-only evidence claims", async () => {
    const data = durableRows()
    const forged = {
      ...structuredResult,
      candidates: [{ ...structuredResult.candidates[0], jobId: "job-forged", evidenceIds: ["model-forged"] }],
      evidence: [{ id: "model-forged", kind: "job", ref: "job-forged", source: "greenhouse" }],
    }
    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: forged })
    expect(result.verified).toBe(false)
    expect(result.report.status).toBe("unverified")
    expect(result.report.evidenceDigest).toBeNull()

    const partial = await verifyTaskGraphNodeEvidence(data.client, {
      scope, snapshot, node, structuredResult: { ...structuredResult, status: "partial" },
    })
    expect(partial.verified).toBe(false)
    expect(partial.report.reasonCode).toBe("result_invalid")
  })

  it("rejects foreign persisted item lineage and truncated tool output", async () => {
    const foreign = durableRows({ items: durableRows().items.map(item => item.id === "call-item" ? { ...item, sessionId: "other-session" } : item) })
    const foreignResult = await verifyTaskGraphNodeEvidence(foreign.client, { scope, snapshot, node, structuredResult })
    expect(foreignResult.verified).toBe(false)
    expect(foreignResult.report.reasonCode).toBe("canonical_evidence_invalid")

    const truncatedData = durableRows()
    truncatedData.items[1]!.content = { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse" }], truncated: true, byteLength: 9000, preview: "{" }, errorCode: null }
    const truncatedResult = await verifyTaskGraphNodeEvidence(truncatedData.client, { scope, snapshot, node, structuredResult })
    expect(truncatedResult.verified).toBe(false)
    expect(truncatedResult.report.evidenceDigest).toBeNull()
  })

  it("accepts failed tool outcomes followed by a successful canonical read", async () => {
    const data = durableRows()
    const failedCall = { id: "failed-call", toolName: "jobs.search", toolVersion: "1", input: {}, status: "failed", errorCode: "temporary_failure" }
    data.items.push({ ...data.items[0]!, id: "failed-call-item", revision: 1, content: { toolCallId: "failed-call", ...failedCall } })
    data.items.push({ ...data.items[1]!, id: "failed-result-item", revision: 1, content: { toolCallId: "failed-call", output: null, errorCode: "temporary_failure" } })
    data.events.unshift(
      { id: "failed-started", itemId: "failed-call-item", taskId: scope.taskId, correlationId: "failed-call", type: "tool_call.started", sequence: 1, payload: { taskId: scope.taskId, toolCallId: "failed-call", toolName: "jobs.search" } },
      { id: "failed-terminal", itemId: "failed-call-item", taskId: scope.taskId, correlationId: "failed-call", type: "tool_call.failed", sequence: 2, payload: { taskId: scope.taskId, toolCallId: "failed-call", toolName: "jobs.search", status: "failed", errorCode: "temporary_failure" } },
    )
    data.events[2] = { ...data.events[2]!, sequence: 3 }; data.events[3] = { ...data.events[3]!, sequence: 4 }
    await expect(verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })).resolves.toMatchObject({ verified: true })
  })

  it("projects large canonical descriptions before evidence hydration and binds the digest to their bytes", async () => {
    const large = durableRows()
    large.items[1]!.content = { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse", description: "d".repeat(20_000) }] }, errorCode: null }
    const first = await verifyTaskGraphNodeEvidence(large.client, { scope, snapshot, node, structuredResult })
    expect(first.verified).toBe(true)
    expect(first.report.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    large.items[1]!.content = { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse", description: "e".repeat(20_000) }] }, errorCode: null }
    const changed = await verifyTaskGraphNodeEvidence(large.client, { scope, snapshot, node, structuredResult })
    expect(changed.verified).toBe(true)
    expect(changed.report.evidenceDigest).not.toBe(first.report.evidenceDigest)
  })

  it("rejects duplicate and over-cap canonical output and mismatched linked event correlation", async () => {
    const duplicate = durableRows()
    duplicate.items[1]!.content = { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse" }, { id: "job-1", source: "greenhouse" }] }, errorCode: null }
    expect((await verifyTaskGraphNodeEvidence(duplicate.client, { scope, snapshot, node, structuredResult })).verified).toBe(false)

    const overCap = durableRows()
    overCap.items[1]!.content = { toolCallId: "call-1", output: { jobs: [{ id: "job-1", source: "greenhouse", description: "x".repeat(530_000) }] }, errorCode: null }
    expect((await verifyTaskGraphNodeEvidence(overCap.client, { scope, snapshot, node, structuredResult })).verified).toBe(false)

    const mismatched = durableRows()
    mismatched.events[1] = { ...mismatched.events[1]!, correlationId: "foreign-call-id" }
    expect((await verifyTaskGraphNodeEvidence(mismatched.client, { scope, snapshot, node, structuredResult })).verified).toBe(false)
  })

  it("rejects a duplicate item-linked event with the wrong task", async () => {
    const data = durableRows()
    data.events.push({ ...data.events[1]!, id: "wrong-task-completion", taskId: "foreign-task" })

    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })
    expect(result.verified).toBe(false)
    expect(result.report.reasonCode).toBe("canonical_evidence_invalid")
  })
})
