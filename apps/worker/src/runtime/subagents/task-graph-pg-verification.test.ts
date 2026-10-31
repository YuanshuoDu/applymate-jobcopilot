import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION } from "./scheduled-automation-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { parseTaskGraphSnapshot, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION, verifyCompletedTaskGraphNodeEvidence, verifyTaskGraphNodeEvidence, type TaskGraphVerificationScope } from "./task-graph-pg-verification.js"

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
const emptyScoutResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [], evidence: [], summary: "No matching jobs",
}
const scheduledTurnFixture = {
  source: "automation", executionMode: "canonical_task_graph", input: {
    automationRunMode: "scheduled", scheduledAutomationSnapshot: {
      schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION, targetRoles: ["Engineer"], targetLocations: ["Dublin"],
      minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false,
    },
  },
}
const structuredResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["model-job-ref"] }],
  evidence: [{ id: "model-job-ref", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one job",
}

function durableRows(overrides: { items?: Record<string, unknown>[]; events?: Record<string, unknown>[]; task?: Record<string, unknown>; replaySources?: Record<string, unknown>[]; replayEvents?: Record<string, unknown>[]; toolName?: string; input?: unknown; output?: unknown; turn?: Record<string, unknown> } = {}) {
  const toolName = overrides.toolName ?? "jobs.search"
  const output = overrides.output ?? { jobs: [{ id: "job-1", source: "greenhouse" }] }
  const callContent = { toolCallId: "call-1", toolName, toolVersion: "1", input: overrides.input ?? {}, status: "completed", errorCode: null }
  const items = overrides.items ?? [
    { id: "call-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", joinedStepId: "step-1", rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", ordinal: 0, attempt: 1, type: "tool_call", status: "completed", revision: 2, content: callContent },
    { id: "result-item", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId: "step-1", joinedStepId: "step-1", rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", ordinal: 0, attempt: 1, type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output, errorCode: null } },
  ]
  const common = { itemId: "call-item", taskId: scope.taskId, correlationId: "call-1" }
  const events = overrides.events ?? [
    { id: "started", ...common, type: "tool_call.started", sequence: 1, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName } },
    { id: "completed", ...common, type: "tool_call.completed", sequence: 2, payload: { taskId: scope.taskId, toolCallId: "call-1", toolName, status: "completed", errorCode: null } },
  ]
  const turn = overrides.turn ?? scheduledTurnFixture
  const task = { ...(overrides.task ?? { id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: 1, status: "running", role: "scout", userId: scope.userId }), turnSource: turn.source, turnExecutionMode: turn.executionMode, turnInput: turn.input }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('SELECT task."id"')) return { rows: [task], rowCount: 1 }
    if (sql.includes('SELECT item."id"')) {
      const attempt = values?.[6]
      const attemptItems = items.filter(item => item.attempt === attempt)
      return { rows: attemptItems, rowCount: attemptItems.length }
    }
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

function emptyDiscoveryRows(output: unknown, options: { input?: unknown; turn?: Record<string, unknown>; persistedResult?: unknown } = {}) {
  const data = durableRows({ toolName: "jobs.discover", output, input: options.input ?? { targetRoles: ["Engineer"], targetLocations: ["Dublin"] }, turn: options.turn, task: {
    id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    turnRootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: 1,
    status: "completed", role: "scout", userId: scope.userId,
    result: Object.hasOwn(options, "persistedResult") ? options.persistedResult : { status: "completed", structuredResult: emptyScoutResult },
  } })
  const outputValue = (data.items.find(item => item.type === "tool_result")!.content as Record<string, unknown>).output
  const common = { taskId: scope.taskId, toolCallId: "call-1", toolName: "jobs.discover", toolVersion: "1" }
  data.events[0] = { ...data.events[0]!, payload: common }
  data.events[1] = { ...data.events[1]!, payload: { ...common, status: "completed", output: outputValue, errorCode: null } }
  return data
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
  it("verifies a zero-result Scout only from the complete persisted owner/attempt-bound discovery receipt", async () => {
    const emptyResult = emptyScoutResult
    const output = {
      jobs: [], evidence: [], nextCursor: null,
      usage: {
        ledgerKey: [scope.userId, scope.sessionId, scope.turnId, "step-1", "call-1"].join(":"),
        toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-1",
        sessionId: scope.sessionId, turnId: scope.turnId, stepId: "step-1",
        requests: 1, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, providerFailures: 0,
        aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1,
      },
    }
    const data = emptyDiscoveryRows(output)
    const zeroSnapshot = parseTaskGraphSnapshot({ schemaVersion: snapshot.schemaVersion, nodes: [{
      ...node, verification: { ...verification, criteria: verification.criteria.filter(item => item.id !== "evidence-count") },
    }] })
    const result = await verifyCompletedTaskGraphNodeEvidence(data.client, { scope, snapshot: zeroSnapshot, node: zeroSnapshot.nodes[0]!, structuredResult: emptyResult })
    expect(result.verified).toBe(true)
    expect(result.projection).toMatchObject({ role: "scout", candidates: [], emptyDiscoveryReceipt: { digest: expect.stringMatching(/^[a-f0-9]{64}$/) } })
    expect(result.projection?.evidenceIds).toEqual([expect.stringMatching(/^read:source:jobs\.discover:[a-f0-9]{64}$/)])
    expect(result.report.criteria).toEqual([
      { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
      { criterionId: "bound-candidate", status: "passed", reasonCode: "criteria_met" },
    ])
    const strictEvidenceCount = await verifyCompletedTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: emptyResult })
    expect(strictEvidenceCount).toMatchObject({ verified: true, report: { criteria: expect.arrayContaining([
      { criterionId: "evidence-count", status: "passed", reasonCode: "criteria_met" },
    ]) } })
    const twoEvidenceSnapshot = parseTaskGraphSnapshot({ schemaVersion: snapshot.schemaVersion, nodes: [{
      ...node,
      verification: { ...verification, criteria: verification.criteria.map(item => item.id === "evidence-count"
        ? { ...item, check: { kind: "evidence_count_gte" as const, minimum: 2 } } : item) },
    }] })
    const twoEvidence = await verifyCompletedTaskGraphNodeEvidence(data.client, {
      scope, snapshot: twoEvidenceSnapshot, node: twoEvidenceSnapshot.nodes[0]!, structuredResult: emptyResult,
    })
    expect(twoEvidence).toMatchObject({ verified: false, report: { criteria: expect.arrayContaining([
      { criterionId: "evidence-count", status: "failed", reasonCode: "criterion_not_met" },
    ]) } })

    for (const persistedResult of [null, { status: "completed", structuredResult: { ...emptyResult, summary: "different result" } }]) {
      const unbound = await verifyCompletedTaskGraphNodeEvidence(emptyDiscoveryRows(output, { persistedResult }).client, { scope, snapshot, node, structuredResult: emptyResult })
      expect(unbound.verified).toBe(false)
      expect(unbound.projection).toBeUndefined()
    }

    for (const incomplete of [
      { ...output, usage: { ...output.usage, providerFailures: 1 } },
      { ...output, usage: { ...output.usage, jobsProcessed: 1 } },
      { ...output, nextCursor: "next-page" },
      { ...output, evidence: [{ id: "unbound" }] },
      { ...output, truncated: true, byteLength: 9_000, preview: "{" },
    ]) {
      const invalid = await verifyCompletedTaskGraphNodeEvidence(emptyDiscoveryRows(incomplete).client, {
        scope, snapshot: zeroSnapshot, node: zeroSnapshot.nodes[0]!, structuredResult: emptyResult,
      })
      expect(invalid.verified).toBe(false)
      expect(invalid.report.status).toBe("unverified")
      expect(invalid.projection).toBeUndefined()
    }

    const missingProviderProof = emptyDiscoveryRows({ ...output, usage: { ...output.usage, requests: 0, providers: [] } })
    expect((await verifyCompletedTaskGraphNodeEvidence(missingProviderProof.client, {
      scope, snapshot: zeroSnapshot, node: zeroSnapshot.nodes[0]!, structuredResult: emptyResult,
    })).projection).toBeUndefined()

    const foreignAttempt = emptyDiscoveryRows(output)
    foreignAttempt.items.forEach(item => { item.attempt = 2 })
    const foreign = await verifyCompletedTaskGraphNodeEvidence(foreignAttempt.client, {
      scope, snapshot: zeroSnapshot, node: zeroSnapshot.nodes[0]!, structuredResult: emptyResult,
    })
    expect(foreign.verified).toBe(false)
    expect(foreign.projection).toBeUndefined()

    for (const input of [
      { targetRoles: ["Other Engineer"], targetLocations: ["Dublin"] },
      { targetRoles: ["Engineer"], targetLocations: [] },
      { targetRoles: ["Engineer"], targetLocations: ["Dublin"], source: "greenhouse" },
      { targetRoles: ["Engineer"], targetLocations: ["Dublin"], pageSize: 1 },
      { targetRoles: ["Engineer"], targetLocations: ["Dublin"], cursor: "next-page" },
    ]) {
      const narrowed = await verifyCompletedTaskGraphNodeEvidence(emptyDiscoveryRows(output, { input }).client, {
        scope, snapshot: zeroSnapshot, node: zeroSnapshot.nodes[0]!, structuredResult: emptyResult,
      })
      expect(narrowed.verified).toBe(false)
      expect(narrowed.projection).toBeUndefined()
    }
  })

  it("accepts an empty Analyst only when its exact Scout dependency is reverified from persisted receipts", async () => {
    const analystScope = { ...scope, taskId: "analyst-child" }
    const emptyAnalystResult = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
      findings: [], evidence: [], summary: "No jobs to analyze",
    }
    const scoutVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
      criteria: [
        { id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } },
        { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence" as const, minimumItems: 1 } },
      ],
    }
    const analystVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
      criteria: [
        { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
        { id: "finding-evidence", check: { kind: "all_findings_have_evidence" as const, minimumItems: 1 } },
        { id: "scout-membership", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: "scout-source" } },
        { id: "scout-coverage", check: { kind: "findings_cover_scout_candidates_gte" as const, dependencyNodeKey: "scout-source", minimumPercent: 75 } },
      ],
    }
    const graph = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
      { key: "scout-source", templateId: "scout", goal: "Find jobs", successCriteria: ["Find matching jobs"], dependsOn: [], depth: 1,
        taskId: scope.taskId, verificationDisposition: "typed", verification: scoutVerification },
      { key: "analyst", templateId: "analyst", goal: "Analyze jobs", successCriteria: ["Analyze matches"], dependsOn: ["scout-source"], depth: 2,
        taskId: analystScope.taskId, verificationDisposition: "typed", verification: analystVerification },
    ] })
    const scoutNode = graph.nodes[0]!, analystNode = graph.nodes[1]!
    const emptyOutput = {
      jobs: [], evidence: [], nextCursor: null,
      usage: {
        ledgerKey: [scope.userId, scope.sessionId, scope.turnId, "step-1", "call-1"].join(":"),
        toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-1", sessionId: scope.sessionId,
        turnId: scope.turnId, stepId: "step-1", requests: 1, jobsProcessed: 0, jobsSucceeded: 0,
        jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1,
      },
    }
    const scoutData = emptyDiscoveryRows(emptyOutput)
    const scoutTask = {
      id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, turnRootTaskId: scope.rootTaskId, attemptCount: 1, status: "completed",
      role: "scout", failureReason: null, userId: scope.userId,
      turnSource: scheduledTurnFixture.source, turnExecutionMode: scheduledTurnFixture.executionMode, turnInput: scheduledTurnFixture.input,
      result: { status: "completed", structuredResult: emptyScoutResult },
    }
    const createClient = (options: { persistedResult?: unknown; analystItems?: Record<string, unknown>[]; analystEvents?: Record<string, unknown>[] } = {}) => {
      const analystTask = { ...scoutTask, id: analystScope.taskId, status: "completed", role: "analyst", result: Object.hasOwn(options, "persistedResult") ? options.persistedResult : { status: "completed", structuredResult: emptyAnalystResult } }
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('task."failureReason"')) return { rows: [scoutTask], rowCount: 1 }
      if (sql.includes('SELECT task."id"')) return { rows: [values?.[0] === scope.taskId ? scoutTask : analystTask], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return values?.[0] === scope.taskId
        ? scoutData.query(sql, values) : { rows: options.analystItems ?? [], rowCount: options.analystItems?.length ?? 0 }
      if (sql.includes('SELECT event."id"')) return Array.isArray(values?.[3]) ? scoutData.query(sql, values) : { rows: options.analystEvents ?? [], rowCount: options.analystEvents?.length ?? 0 }
      throw new Error("unexpected_empty_analyst_verification_query")
      })
      return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
    }
    const { client } = createClient()
    const scoutProof = await verifyCompletedTaskGraphNodeEvidence(client, {
      scope, snapshot: graph, node: scoutNode, structuredResult: emptyScoutResult,
    })
    expect(scoutProof.verified).toBe(true)
    expect(scoutProof.projection?.role).toBe("scout")
    const dependencies = new Map<string, TaskGraphVerificationEvidenceProjection>([["scout-source", scoutProof.projection!]])
    const analystProof = await verifyCompletedTaskGraphNodeEvidence(client, {
      scope: analystScope, snapshot: graph, node: analystNode, structuredResult: emptyAnalystResult, dependencies,
    })
    expect(analystProof).toMatchObject({ verified: true, evaluation: { status: "passed", reasonCode: "criteria_met" } })
    expect(analystProof.projection).toMatchObject({ role: "analyst", findings: [], evidenceIds: [] })
    const forged = new Map(dependencies)
    forged.set("scout-source", { ...scoutProof.projection!, emptyDiscoveryReceipt: { digest: "f".repeat(64) } })
    const mismatch = await verifyCompletedTaskGraphNodeEvidence(client, {
      scope: analystScope, snapshot: graph, node: analystNode, structuredResult: emptyAnalystResult, dependencies: forged,
    })
    expect(mismatch.verified).toBe(false)
    expect(mismatch.report.reasonCode).toBe("canonical_evidence_missing")

    const missingResult = createClient({ persistedResult: null })
    const missing = await verifyCompletedTaskGraphNodeEvidence(missingResult.client, {
      scope: analystScope, snapshot: graph, node: analystNode, structuredResult: emptyAnalystResult, dependencies,
    })
    expect(missing.verified).toBe(false)

    const duplicateRows = createClient({ analystItems: [{ id: "duplicate-call", taskId: analystScope.taskId }] })
    const duplicate = await verifyCompletedTaskGraphNodeEvidence(duplicateRows.client, {
      scope: analystScope, snapshot: graph, node: analystNode, structuredResult: emptyAnalystResult, dependencies,
    })
    expect(duplicate.verified).toBe(false)

    const changedResult = createClient()
    const changed = await verifyCompletedTaskGraphNodeEvidence(changedResult.client, {
      scope: analystScope, snapshot: graph, node: analystNode, structuredResult: { ...emptyAnalystResult, summary: "not the persisted result" }, dependencies,
    })
    expect(changed.verified).toBe(false)
  })

  it("keeps a zero-evidence empty Analyst with multiple Scout dependencies unverified", async () => {
    const analystScope = { ...scope, taskId: "analyst-empty" }
    const emptyAnalystResult = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
      findings: [], evidence: [], summary: "No jobs to analyze",
    }
    const scoutVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout" as const,
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }],
    }
    const analystVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst" as const,
      criteria: [
        { id: "source-coverage", check: { kind: "findings_cover_each_scout_candidates_gte" as const, dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 50 } },
        { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
      ],
    }
    const graph = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
      { key: "scout-a", templateId: "scout", goal: "Find jobs A", successCriteria: ["Find candidates A"], dependsOn: [], depth: 1,
        taskId: "scout-a-task", verificationDisposition: "typed", verification: scoutVerification },
      { key: "scout-b", templateId: "scout", goal: "Find jobs B", successCriteria: ["Find candidates B"], dependsOn: [], depth: 1,
        taskId: "scout-b-task", verificationDisposition: "typed", verification: scoutVerification },
      { key: "analyst", templateId: "analyst", goal: "Analyze jobs", successCriteria: ["Cover each source"], dependsOn: ["scout-a", "scout-b"], depth: 2,
        taskId: analystScope.taskId, verificationDisposition: "typed", verification: analystVerification },
    ] })
    const analystNode = graph.nodes[2]!
    const analystTask = {
      id: analystScope.taskId, sessionId: analystScope.sessionId, turnId: analystScope.turnId,
      rootTaskId: analystScope.rootTaskId, turnRootTaskId: analystScope.rootTaskId, parentTaskId: analystScope.parentTaskId,
      attemptCount: 1, status: "completed", role: "analyst", userId: analystScope.userId,
      result: { status: "completed", structuredResult: emptyAnalystResult },
    }
    const scoutProjection = (jobId: string): TaskGraphVerificationEvidenceProjection => ({
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout",
      candidates: [{ jobId, evidenceIds: [`read:job:${jobId}`] }], evidenceIds: [`read:job:${jobId}`],
    })
    const dependencies = new Map<string, TaskGraphVerificationEvidenceProjection>([
      ["scout-a", scoutProjection("job-a")], ["scout-b", scoutProjection("job-b")],
    ])
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT task."id"')) return { rows: [analystTask], rowCount: 1 }
      if (sql.includes('SELECT item."id"') || sql.includes('SELECT event."id"')) return { rows: [], rowCount: 0 }
      throw new Error("unexpected_empty_multi_scout_query")
    })
    const result = await verifyCompletedTaskGraphNodeEvidence({ query } as unknown as Pick<pg.PoolClient, "query">, {
      scope: analystScope, snapshot: graph, node: analystNode, structuredResult: emptyAnalystResult, dependencies,
    })

    expect(result).toMatchObject({
      verified: false,
      report: { status: "unverified", reasonCode: "canonical_evidence_missing", evidenceDigest: null, resultDigest: null },
      evaluation: { status: "unverified", reasonCode: "canonical_evidence_missing" },
    })
    expect(result.projection).toBeUndefined()
  })

  it("persists independent candidate coverage over owner-scoped Scout dependencies", async () => {
    const analystScope = { ...scope, taskId: "analyst-task" }
    const analystSnapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
      { key: "scout-a", templateId: "scout", goal: "Find jobs A", successCriteria: ["Find candidates A"], dependsOn: [], depth: 1,
        taskId: "scout-task", verificationDisposition: "typed", verification },
      { key: "scout-b", templateId: "scout", goal: "Find jobs B", successCriteria: ["Find candidates B"], dependsOn: [], depth: 1,
        taskId: "scout-b-task", verificationDisposition: "typed", verification },
      { key: "analyst", templateId: "analyst", goal: "Analyze jobs", successCriteria: ["Analyze one"], dependsOn: ["scout-a", "scout-b"], depth: 2,
        taskId: analystScope.taskId, verificationDisposition: "typed", verification: {
          schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
          criteria: [
            { id: "scout-coverage", check: { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 50 } },
            { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
          ],
        } },
    ] })
    const analystNode = analystSnapshot.nodes[2]!
    const analystResult = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
      findings: [{ jobId: "job-1", score: 8, evidenceIds: ["analyst-model-ref"] }],
      evidence: [{ id: "analyst-model-ref", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Analyzed one job",
    }
    const readOutput = { job: { id: "job-1", source: "greenhouse" } }
    const callContent = { toolCallId: "analyst-call", toolName: "jobs.get", toolVersion: "1", input: { jobId: "job-1" }, status: "completed", errorCode: null }
    const items = [
      { id: "analyst-call-item", sessionId: analystScope.sessionId, turnId: analystScope.turnId, taskId: analystScope.taskId,
        stepId: "analyst-step", joinedStepId: "analyst-step", rootTaskId: analystScope.rootTaskId, turnRootTaskId: analystScope.rootTaskId,
        stepStatus: "completed", ordinal: 1, attempt: 1, type: "tool_call", status: "completed", revision: 0, content: callContent },
      { id: "analyst-result-item", sessionId: analystScope.sessionId, turnId: analystScope.turnId, taskId: analystScope.taskId,
        stepId: "analyst-step", joinedStepId: "analyst-step", rootTaskId: analystScope.rootTaskId, turnRootTaskId: analystScope.rootTaskId,
        stepStatus: "completed", ordinal: 1, attempt: 1, type: "tool_result", status: "completed", revision: 0,
        content: { toolCallId: "analyst-call", output: readOutput, errorCode: null } },
    ]
    const events = [
      { id: "analyst-started", itemId: "analyst-call-item", taskId: analystScope.taskId, correlationId: "analyst-call",
        type: "tool_call.started", sequence: 1, payload: { taskId: analystScope.taskId, toolCallId: "analyst-call", toolName: "jobs.get" } },
      { id: "analyst-completed", itemId: "analyst-call-item", taskId: analystScope.taskId, correlationId: "analyst-call",
        type: "tool_call.completed", sequence: 2, payload: { taskId: analystScope.taskId, toolCallId: "analyst-call", toolName: "jobs.get", status: "completed", errorCode: null } },
    ]
    const task = { id: analystScope.taskId, sessionId: analystScope.sessionId, turnId: analystScope.turnId,
      rootTaskId: analystScope.rootTaskId, turnRootTaskId: analystScope.rootTaskId, parentTaskId: analystScope.parentTaskId,
      attemptCount: 1, status: "completed", role: "analyst", userId: analystScope.userId }
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT task."id"')) return { rows: [task], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return { rows: items, rowCount: items.length }
      if (sql.includes('SELECT event."id"')) return { rows: events, rowCount: events.length }
      throw new Error("unexpected_completed_analyst_verification_query")
    })
    const dependencyEvidence = new Map<string, TaskGraphVerificationEvidenceProjection>([
      ["scout-a", { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout",
        candidates: ["job-1", "job-a"].map(jobId => ({ jobId, evidenceIds: [`read:job:${jobId}`] })),
        evidenceIds: ["read:job:job-1", "read:job:job-a"] }],
      ["scout-b", { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout",
        candidates: ["job-1", "job-b"].map(jobId => ({ jobId, evidenceIds: [`read:job:${jobId}`] })),
        evidenceIds: ["read:job:job-1", "read:job:job-b"] }],
    ])
    const result = await verifyCompletedTaskGraphNodeEvidence({ query } as unknown as Pick<pg.PoolClient, "query">, {
      scope: analystScope, snapshot: analystSnapshot, node: analystNode, structuredResult: analystResult, dependencies: dependencyEvidence,
    })

    expect(result).toMatchObject({ verified: true, evaluation: { status: "passed", reasonCode: "criteria_met" } })
    expect(result.report.criteria).toEqual([
      { criterionId: "scout-coverage", status: "passed", reasonCode: "criteria_met" },
      { criterionId: "finding-count", status: "passed", reasonCode: "criteria_met" },
    ])
  })

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

  it("verifies a Scout candidate from only a fresh current-attempt jobs.get receipt", async () => {
    const data = durableRows({ toolName: "jobs.get", output: { job: { id: "job-1", source: "greenhouse" } } })
    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })

    expect(result).toMatchObject({ verified: true, report: { status: "passed" } })
    expect(result.projection).toMatchObject({ candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }] })
    expect(data.items.filter(item => item.type === "tool_call").map(item => (item.content as Record<string, unknown>).toolName)).toEqual(["jobs.get"])
  })

  it("does not verify a Scout candidate from historical job receipts without current-attempt reads", async () => {
    const attemptScope = { ...scope, attemptCount: 2 }
    const priorAttempt = durableRows()
    const currentStepId = "current-step"
    const currentCall = {
      ...priorAttempt.items[0]!, id: "current-call-item", stepId: currentStepId, joinedStepId: currentStepId, attempt: 2,
      content: { toolCallId: "current-call", toolName: "application.outcomes_summary", toolVersion: "1", input: {}, status: "completed", errorCode: null },
    }
    const currentResult = {
      ...priorAttempt.items[1]!, id: "current-result-item", stepId: currentStepId, joinedStepId: currentStepId, attempt: 2,
      content: { toolCallId: "current-call", output: { jobCount: 1 }, errorCode: null },
    }
    const currentEvents = [
      { id: "current-started", itemId: currentCall.id, taskId: scope.taskId, correlationId: "current-call", type: "tool_call.started", sequence: 3, payload: { taskId: scope.taskId, toolCallId: "current-call", toolName: "application.outcomes_summary" } },
      { id: "current-completed", itemId: currentCall.id, taskId: scope.taskId, correlationId: "current-call", type: "tool_call.completed", sequence: 4, payload: { taskId: scope.taskId, toolCallId: "current-call", toolName: "application.outcomes_summary", status: "completed", errorCode: null } },
    ]
    const data = durableRows({
      items: [...priorAttempt.items, currentCall, currentResult],
      events: [...priorAttempt.events, ...currentEvents],
      task: { id: scope.taskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: 2, status: "running", role: "scout", userId: scope.userId },
    })
    const result = await verifyTaskGraphNodeEvidence(data.client, { scope: attemptScope, snapshot, node, structuredResult })
    const itemQuery = data.query.mock.calls.find(([sql]) => sql.includes('SELECT item."id"'))

    expect(priorAttempt.items).toHaveLength(2)
    expect(priorAttempt.items.every(item => item.attempt === 1)).toBe(true)
    expect(itemQuery?.[0]).toContain('AND step."attempt" = $7')
    expect(itemQuery?.[1]).toEqual([scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, 2])
    expect(result).toMatchObject({
      verified: false,
      report: { status: "unverified", reasonCode: "canonical_evidence_missing", evidenceDigest: null, resultDigest: null },
    })
    expect(result.projection).toBeUndefined()
  })

  it("rejects Scout source attribution that differs from the fresh jobs.get receipt", async () => {
    const data = durableRows({ toolName: "jobs.get", output: { job: { id: "job-1", source: "greenhouse" } } })
    const mismatchedResult = {
      ...structuredResult,
      candidates: [{ ...structuredResult.candidates[0], source: "lever" }],
    }
    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: mismatchedResult })

    expect(result).toMatchObject({ verified: false, report: { status: "unverified", reasonCode: "result_invalid", evidenceDigest: null } })
  })

  it("binds a padded canonical source from jobs.get only when Scout matches it exactly", async () => {
    const source = " greenhouse "
    const data = durableRows({ toolName: "jobs.get", output: { job: { id: "job-1", source } } })
    const matchingResult = {
      ...structuredResult,
      candidates: [{ ...structuredResult.candidates[0], source }],
      evidence: [{ ...structuredResult.evidence[0], source }],
    }
    const matching = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: matchingResult })
    const mismatchedResult = {
      ...structuredResult,
      candidates: [{ ...structuredResult.candidates[0], source: "greenhouse" }],
    }
    const mismatched = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: mismatchedResult })

    expect(matching).toMatchObject({ verified: true, projection: { candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }] } })
    expect(mismatched).toMatchObject({ verified: false, report: { status: "unverified", reasonCode: "result_invalid", evidenceDigest: null } })
  })

  it("allows only the generic jobs.read label when a current jobs.get receipt omits its source", async () => {
    const data = durableRows({ toolName: "jobs.get", output: { job: { id: "job-1" } } })
    const genericResult = {
      ...structuredResult,
      candidates: [{ ...structuredResult.candidates[0], source: "jobs.read" }],
      evidence: [{ ...structuredResult.evidence[0], source: "jobs.read" }],
    }
    const generic = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: genericResult })
    const inventedResult = {
      ...structuredResult,
      candidates: [{ ...structuredResult.candidates[0], source: "greenhouse" }],
      evidence: [{ ...structuredResult.evidence[0], source: "greenhouse" }],
    }
    const invented = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult: inventedResult })

    expect(generic).toMatchObject({ verified: true, projection: { candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }] } })
    expect(invented).toMatchObject({ verified: false, report: { status: "unverified", reasonCode: "result_invalid" } })
  })

  it("fails closed when current jobs.get receipts conflict on the same job source", async () => {
    const data = durableRows({ toolName: "jobs.get", output: { job: { id: "job-1", source: "greenhouse" } } })
    const firstCall = data.items[0]!
    const firstResult = data.items[1]!
    data.items.push(
      { ...firstCall, id: "call-item-2", stepId: "step-2", joinedStepId: "step-2", ordinal: 1,
        content: { ...(firstCall.content as Record<string, unknown>), toolCallId: "call-2" } },
      { ...firstResult, id: "result-item-2", stepId: "step-2", joinedStepId: "step-2", ordinal: 1,
        content: { toolCallId: "call-2", output: { job: { id: "job-1", source: "lever" } }, errorCode: null } },
    )
    const started = data.events[0]!
    const completed = data.events[1]!
    data.events.push(
      { ...started, id: "started-2", itemId: "call-item-2", correlationId: "call-2", sequence: 3,
        payload: { ...(started.payload as Record<string, unknown>), toolCallId: "call-2" } },
      { ...completed, id: "completed-2", itemId: "call-item-2", correlationId: "call-2", sequence: 4,
        payload: { ...(completed.payload as Record<string, unknown>), toolCallId: "call-2" } },
    )

    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })

    expect(result).toMatchObject({ verified: false, report: { status: "unverified", reasonCode: "canonical_evidence_ambiguous", evidenceDigest: null } })
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

  it("does not treat application outcome summaries as TaskGraph evidence", async () => {
    const data = durableRows()
    data.items[0]!.content = { ...(data.items[0]!.content as Record<string, unknown>), toolName: "application.outcomes_summary" }
    data.items[1]!.content = {
      toolCallId: "call-1",
      output: {
        schemaVersion: 2, advisoryOnly: true,
        coverage: { basis: "latest_100_jobs_by_updatedAt", jobCount: 1, truncated: false },
        jobStatusCounts: { saved: 1, applied: 0, interview: 0, offer: 0, rejected: 0 },
        linkedJobsByGmailKind: { application_received: 0, interview_invitation: 0, offer: 0, rejection: 0, application_update: 0 },
        gmailSemantics: { classification: "heuristic_advisory_only", matchConfidence: "job_linkage_only" },
        sourceBreakdown: { basis: "same_latest_100_jobs_by_updatedAt", minimumAppliedOrBeyondJobCount: 10, groups: [], suppressedGroupCount: 0, semantics: "descriptive_source_association_only" },
      },
      errorCode: null,
    }
    data.events = data.events.map(event => ({
      ...event, payload: { ...(event.payload as Record<string, unknown>), toolName: "application.outcomes_summary" },
    }))

    const result = await verifyTaskGraphNodeEvidence(data.client, { scope, snapshot, node, structuredResult })

    expect(result.verified).toBe(false)
    expect(result.report.status).toBe("unverified")
    expect(result.report.evidenceDigest).toBeNull()
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
