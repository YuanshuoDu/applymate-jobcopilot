import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type { PoolClient } from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { readConsumedTaskGraphFailureReport } from "./durable-wait-historical-failure-proof.js"
import { taskGraphItemId, taskGraphLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

type Row = Record<string, unknown>
type TaskInput = Readonly<{ id: unknown; status: unknown; attemptCount: unknown; role: unknown; taskType: unknown; failureReason: unknown; result: unknown }>
const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const report = (criterionId: string) => ({ verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
  criteria: [{ criterionId, status: "unverified", reasonCode: "result_invalid" }], evidenceDigest: null, resultDigest: null })

function fixture(input: { role?: "scout" | "analyst"; reason?: string; attempt?: number; report?: unknown; result?: unknown } = {}) {
  const role = input.role ?? "scout", reason = input.reason ?? "child_resume_unavailable", attempt = input.attempt ?? 2
  const taskId = "source-task", key = role === "scout" ? "candidate-count" : "finding-count"
  const verification: TaskGraphVerificationContract = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
    criteria: [{ id: key, check: role === "scout" ? { kind: "candidate_count_gte", minimum: 1 } : { kind: "finding_count_gte", minimum: 1 } }] }
  const snapshot: TaskGraphSnapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "source", templateId: role,
    taskId, goal: "Read-only work", successCriteria: ["Find evidence"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification }] }
  const taskReport = input.report ?? report(key)
  const task = { id: taskId, status: "failed", attemptCount: attempt, role,
    taskType: role === "scout" ? "job_discovery" : "job_analysis", failureReason: reason,
    result: input.result ?? { taskGraphVerificationReport: taskReport } }
  const eventKey = taskGraphLifecycleKey(scope.rootTaskId, "source", attempt, "task.failed"), eventId = "failure-event"
  const payload = { kind: "lifecycle", event: { type: "task.failed", nodeKey: "source", expectedRevision: 0,
    idempotencyKey: eventKey, failureReason: reason }, revision: 1,
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: taskGraphItemId(scope.rootTaskId), sessionId: scope.sessionId,
      turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null,
      revision: 1, content: snapshot, startedAt: null, completedAt: null, createdAt: null, updatedAt: null } }
  const event: Row = { id: eventId, sessionId: scope.sessionId, turnId: scope.turnId, itemId: taskGraphItemId(scope.rootTaskId),
    taskId, sequence: "10", type: "item.delta", actor: "system", correlationId: scope.turnId, causationId: null,
    idempotencyKey: eventKey, payload, sessionUserId: scope.userId, turnUserId: scope.userId, turnRootTaskId: scope.rootTaskId,
    outboxTopic: "agent.session.event", outboxAggregateId: scope.sessionId, outboxIdempotencyKey: `agent-event:${eventId}` }
  event.outboxPayload = { eventId, sessionId: scope.sessionId, turnId: scope.turnId, itemId: event.itemId, taskId,
    sequence: "10", type: event.type, actor: event.actor, correlationId: event.correlationId,
    causationId: event.causationId, idempotencyKey: event.idempotencyKey, payload }
  const query = vi.fn(async () => ({ rows: [event], rowCount: 1 }))
  return { task, taskReport, event, query, client: { query } as unknown as Pick<PoolClient, "query"> }
}

function withRows(rows: readonly Row[]) {
  const query = vi.fn(async () => ({ rows: [...rows], rowCount: rows.length }))
  return { query, client: { query } as unknown as Pick<PoolClient, "query"> }
}

describe("readConsumedTaskGraphFailureReport", () => {
  it.each([
    ["scout", "child_resume_unavailable"],
    ["analyst", "child_resume_evidence_unavailable"],
  ] as const)("uses the immutable typed failure graph for %s / %s", async (role, reason) => {
    const f = fixture({ role, reason }), proof = await readConsumedTaskGraphFailureReport(f.client,
      { scope, task: f.task, archivedReport: f.taskReport })
    expect(proof).toEqual({ criterionIds: [role === "scout" ? "candidate-count" : "finding-count"], report: f.taskReport })
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it("accepts the full persisted task row used by consumed-wait replay", async () => {
    const f = fixture(), persistedTask = { ...f.task, sessionId: scope.sessionId, rootTaskId: scope.rootTaskId,
      leaseOwnerId: "worker-1", updatedAt: new Date("2026-10-26T10:00:00.000Z") }
    await expect(readConsumedTaskGraphFailureReport(f.client, { scope, task: persistedTask, archivedReport: f.taskReport }))
      .resolves.toEqual({ criterionIds: ["candidate-count"], report: f.taskReport })
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it("accepts the serialized report-only and explicit-null no-output envelopes", async () => {
    const reportOnly = fixture(), explicitNull = fixture({ role: "analyst", result: { workerResult: null, taskGraphVerificationReport: report("finding-count") } })
    await expect(readConsumedTaskGraphFailureReport(reportOnly.client, { scope, task: reportOnly.task, archivedReport: reportOnly.taskReport })).resolves.toMatchObject({ criterionIds: ["candidate-count"] })
    await expect(readConsumedTaskGraphFailureReport(explicitNull.client, { scope, task: explicitNull.task, archivedReport: explicitNull.taskReport })).resolves.toMatchObject({ criterionIds: ["finding-count"] })
  })

  it("selects the current-attempt receipt when an earlier failed attempt is also present", async () => {
    const prior = fixture({ attempt: 1 }), current = fixture({ attempt: 2 })
    const withIdentity = (event: Row, id: string, sequence: string): Row => ({
      ...event, id, sequence, outboxIdempotencyKey: `agent-event:${id}`,
      outboxPayload: { ...(event.outboxPayload as Row), eventId: id, sequence },
    })
    const { client } = withRows([
      withIdentity(current.event, "current-failure", "11"),
      withIdentity(prior.event, "prior-failure", "10"),
    ])
    await expect(readConsumedTaskGraphFailureReport(client, { scope, task: current.task, archivedReport: current.taskReport }))
      .resolves.toEqual({ criterionIds: ["candidate-count"], report: current.taskReport })
  })

  it("rejects duplicate receipts for the current attempt", async () => {
    const f = fixture(), duplicate = { ...f.event, id: "duplicate-current-failure", sequence: "11",
      outboxIdempotencyKey: "agent-event:duplicate-current-failure",
      outboxPayload: { ...(f.event.outboxPayload as Row), eventId: "duplicate-current-failure", sequence: "11" } }
    await expect(readConsumedTaskGraphFailureReport(withRows([f.event, duplicate]).client,
      { scope, task: f.task, archivedReport: f.taskReport })).resolves.toBeNull()
  })

  it("rejects changed output, failure cause, role/type, status, and attempt", async () => {
    const f = fixture(), call = (task: TaskInput) => readConsumedTaskGraphFailureReport(f.client, { scope, task, archivedReport: f.taskReport })
    await expect(call({ ...f.task, failureReason: "task_graph_verification_unverified" })).resolves.toBeNull()
    await expect(call({ ...f.task, taskType: "job_analysis" })).resolves.toBeNull()
    await expect(call({ ...f.task, role: "analyst" })).resolves.toBeNull()
    await expect(call({ ...f.task, status: "completed" })).resolves.toBeNull()
    await expect(call({ ...f.task, attemptCount: 1 })).resolves.toBeNull()
    await expect(call({ ...f.task, result: { workerResult: { output: "model result" }, taskGraphVerificationReport: f.taskReport } })).resolves.toBeNull()
    await expect(call({ ...f.task, result: { ...f.task.result as Row, extra: true } })).resolves.toBeNull()
  })

  it("rejects missing, foreign, ambiguous, wrong-attempt, or un-outboxed failure receipts", async () => {
    const f = fixture(), input = { scope, task: f.task, archivedReport: f.taskReport }
    await expect(readConsumedTaskGraphFailureReport(withRows([]).client, input)).resolves.toBeNull()
    await expect(readConsumedTaskGraphFailureReport(withRows([{ ...f.event, sessionId: "session-other" }]).client, input)).resolves.toBeNull()
    const alternateSnapshot = { ...(f.event.payload as Row).item as Row }
    const snapshotContent = { ...alternateSnapshot.content as Row, nodes: [{ ...((alternateSnapshot.content as Row).nodes as Row[])[0], key: "alternate-source" }] }
    const alternateKey = taskGraphLifecycleKey(scope.rootTaskId, "alternate-source", 2, "task.failed")
    const alternatePayload = { ...(f.event.payload as Row), event: { ...((f.event.payload as Row).event as Row),
      nodeKey: "alternate-source", idempotencyKey: alternateKey }, item: { ...alternateSnapshot, content: snapshotContent } }
    const ambiguousCurrent = { ...f.event, id: "current-alternate", sequence: "11", idempotencyKey: alternateKey,
      payload: alternatePayload, outboxIdempotencyKey: "agent-event:current-alternate", outboxPayload: {
        ...(f.event.outboxPayload as Row), eventId: "current-alternate", sequence: "11", idempotencyKey: alternateKey, payload: alternatePayload } }
    await expect(readConsumedTaskGraphFailureReport(withRows([f.event]).client, input)).resolves.not.toBeNull()
    await expect(readConsumedTaskGraphFailureReport(withRows([ambiguousCurrent]).client, input)).resolves.not.toBeNull()
    await expect(readConsumedTaskGraphFailureReport(withRows([f.event, ambiguousCurrent]).client, input)).resolves.toBeNull()
    const oldAttempt = fixture({ attempt: 1 })
    await expect(readConsumedTaskGraphFailureReport(oldAttempt.client, { ...input, task: f.task })).resolves.toBeNull()
    await expect(readConsumedTaskGraphFailureReport(withRows([{ ...f.event, outboxPayload: {} }]).client, input)).resolves.toBeNull()
  })

  it("rejects a report that does not match the receipt snapshot criteria or archived outcome", async () => {
    const f = fixture(), changed = fixture({ report: report("different-criterion") })
    await expect(readConsumedTaskGraphFailureReport(f.client, { scope, task: f.task, archivedReport: report("different-criterion") })).resolves.toBeNull()
    await expect(readConsumedTaskGraphFailureReport(changed.client, { scope, task: changed.task, archivedReport: report("candidate-count") })).resolves.toBeNull()
  })

  it("rejects a mismatched lifecycle event envelope and noncanonical report", async () => {
    const f = fixture(), changed = { ...f.event, actor: "orchestrator" }
    await expect(readConsumedTaskGraphFailureReport(withRows([changed]).client,
      { scope, task: f.task, archivedReport: f.taskReport })).resolves.toBeNull()
    await expect(readConsumedTaskGraphFailureReport(f.client, { scope, task: f.task,
      archivedReport: { ...f.taskReport as Row, extra: "untrusted" } })).resolves.toBeNull()
  })
})
