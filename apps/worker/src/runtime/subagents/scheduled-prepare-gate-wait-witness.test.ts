import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { scheduledPrepareGateApprovalWitnessIds, scheduledPrepareGateRootWitnessMatches,
  type ScheduledPrepareGateWaitWitness } from "./scheduled-prepare-gate-wait-witness.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const now = new Date("2026-11-14T12:00:00.000Z")
const witness: ScheduledPrepareGateWaitWitness = { gateTaskId: "gate-1", gateAttemptCount: 2,
  leaseOwnerId: "worker-owner-1", requestAttemptCount: 1, preparedJobIds: ["job-1", "job-2"] }
const approvalMarker = "agent-harness.v2.scheduled-gate-review-marker.v1"

type Row = Record<string, unknown>
type Fixtures = { gates: Row[]; waits: Row[]; approvals: Row[]; applications: Row[]; items: Row[]; events: Row[] }

function gateRow(overrides: Row = {}): Row {
  return { id: witness.gateTaskId, role: SCHEDULED_GATE_ROLE, taskType: SCHEDULED_GATE_TASK_TYPE, status: "running",
    attemptCount: witness.gateAttemptCount, maxAttempts: 4, failureReason: null, leaseOwner: witness.leaseOwnerId,
    leaseValid: true, deadlineValid: true, interruptRequestedAt: null, ...overrides }
}
function gateWaitRow(overrides: Row = {}): Row {
  const stepId = "root-step-2", waitId = "gate-wait-1"
  return { id: waitId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    parentTaskId: scope.rootTaskId, stepId, idempotencyKey: waitKey(witness.gateTaskId, stepId, witness.requestAttemptCount),
    targetTaskIds: [witness.gateTaskId], mode: "any", status: "waiting", matchedTaskIds: [],
    result: { request: { targetTaskIds: [witness.gateTaskId], mode: "any", timeoutMs: 86_400_000,
      scheduledGate: { gateTaskId: witness.gateTaskId, requestAttemptCount: witness.requestAttemptCount } } },
    suspendedAt: new Date("2026-11-14T11:59:00.000Z"), resolvedAt: null, consumedAt: null,
    parentStatus: "waiting", parentAttemptCount: 3, parentResult: { status: "waiting_for_dependency", stepCount: 5,
      toolCallCount: 3, finalItemId: null, waitId }, parentFailureReason: null,
    turnStatus: "waiting_for_dependency", turnLeaseOwnerId: null, turnLeaseExpiresAt: null,
    stepTaskId: scope.rootTaskId, stepAttempt: 1, stepStatus: "waiting_for_tool", activeGateWaitCount: 1, ...overrides }
}
function approvalRow(id: string, jobId: string, overrides: Row = {}): Row {
  const taskId = `application-task-${id}`, toolCallId = `tool-call-${id}`, expiresAt = new Date("2026-11-15T12:00:00.000Z")
  return { id, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, taskId, jobId, toolCallId,
    type: "review_application", status: "pending", title: `Review ${jobId}`, body: `Review details for ${jobId}`,
    impact: { externalSubmission: false, jobId }, payload: { jobId, applicationTaskId: taskId, artifactBindings: [],
      scheduledGateReview: { schemaVersion: approvalMarker, gateTaskId: witness.gateTaskId } },
    scopeHash: `scope-${id}`, revision: 2, expiresAt, decidedAt: null, consumedAt: null, ...overrides }
}
function applicationRow(approval: Row, overrides: Row = {}): Row {
  return { id: approval.taskId, userId: approval.userId, sessionId: approval.sessionId, jobId: approval.jobId, ...overrides }
}
function itemFor(approval: Row, overrides: Row = {}): Row {
  const id = String(approval.id), toolCallId = String(approval.toolCallId), jobId = String(approval.jobId)
  return { id: `agent-wait:approval:${id}`, sessionId: scope.sessionId, turnId: scope.turnId, stepId: null, taskId: null,
    type: "approval_request", status: "started", revision: 0, startedAt: now, completedAt: null,
    content: { waitKind: "approval", approvalId: id, toolCallId, action: "review_application", title: `Review ${jobId}`,
      body: `Review details for ${jobId}`, impact: { externalSubmission: false, jobId }, scopeHash: `scope-${id}`,
      receiptRevision: 2, expiresAt: "2026-11-15T12:00:00.000Z", decision: null }, ...overrides }
}
function eventFor(approval: Row, overrides: Row = {}): Row {
  const id = String(approval.id), taskId = String(approval.taskId)
  return { id: `event-${id}`, sessionId: scope.sessionId, turnId: scope.turnId, itemId: null, taskId,
    type: "approval.requested", actor: "orchestrator", correlationId: id, idempotencyKey: `approval:${id}:requested`,
    payload: { approvalId: id, action: "review_application", scopeHash: `scope-${id}`, revision: 2 }, ...overrides }
}
function client(options: Partial<Fixtures> = {}) {
  const approvals = options.approvals ?? []
  const fixtures: Fixtures = { gates: [gateRow()], waits: [gateWaitRow()], approvals,
    applications: options.applications ?? approvals.map(row => applicationRow(row)), items: [], events: [], ...options }
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.includes('FROM "agent_approvals" AS approval')
    ? fixtures.approvals.flatMap(approval => {
      const application = fixtures.applications.find(row => row.id === approval.taskId && row.userId === approval.userId
        && row.sessionId === approval.sessionId && row.jobId === approval.jobId)
      return application ? [{ ...approval, applicationTaskId: application.id, applicationUserId: application.userId,
        applicationSessionId: application.sessionId, applicationJobId: application.jobId }] : []
    }) : sql.includes('FROM "agent_items"') ? fixtures.items : sql.includes('FROM "agent_events"') ? fixtures.events
      : sql.includes('FROM "agent_wait_conditions" AS wait') ? fixtures.waits
        : sql.includes('FROM "sub_agent_tasks" AS task') ? fixtures.gates : [] }))
  return { query }
}
function gateInput(overrides: Partial<Parameters<typeof scheduledPrepareGateRootWitnessMatches>[1]> = {}) {
  return { scope, rootStatus: "waiting" as const, rootAttemptCount: 3, turnStatus: "waiting_for_dependency",
    turnLeaseOwnerId: null, turnLeaseExpiresAt: null, waitId: "gate-wait-1", witness, now, ...overrides }
}
function waitKey(taskId: string, stepId: string, attempt: number): string {
  return `scheduled-gate-wait:${createHash("sha256").update(JSON.stringify([taskId, stepId, attempt]), "utf8").digest("hex")}`
}

describe("scheduled Prepare Gate root wait witness", () => {
  it("accepts only the exact suspended, unconsumed Gate wait under the live attempt lease", async () => {
    const db = client()
    await expect(scheduledPrepareGateRootWitnessMatches(db as never, gateInput())).resolves.toBe(true)
    const gateCall = db.query.mock.calls.find(([sql]) => String(sql).includes('FROM "sub_agent_tasks" AS task'))!
    expect(gateCall[1]).toEqual([witness.gateTaskId, scope.sessionId, scope.turnId, scope.rootTaskId,
      SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, witness.gateAttemptCount, witness.leaseOwnerId, scope.userId])
    expect(gateCall[0]).toContain('JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $9')
    expect(gateCall[0]).toContain('AND turn."userId" = $9 AND turn."rootTaskId" = $4')
    const waitCall = db.query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_wait_conditions" AS wait'))!
    expect(waitCall[1]).toEqual(["gate-wait-1", scope.userId, scope.sessionId, scope.rootTaskId, scope.turnId,
      witness.gateTaskId, "waiting_for_dependency", 3])
  })

  it("accepts multiple active same-Gate approvals only when every witness is persisted and linked", async () => {
    const approvals = [approvalRow("approval-1", "job-1"), approvalRow("approval-2", "job-2")]
    const db = client({ waits: [gateWaitRow({ turnStatus: "waiting_for_approval" })], approvals,
      items: approvals.map(row => itemFor(row)), events: approvals.map(row => eventFor(row)) })
    await expect(scheduledPrepareGateApprovalWitnessIds(db as never, scope, witness, now)).resolves.toEqual(["approval-1", "approval-2"])
    const approvalQuery = db.query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_approvals" AS approval'))!
    expect(approvalQuery[0]).toContain('JOIN "application_tasks" AS application ON application."id" = approval."taskId"')
    expect(approvalQuery[0]).toContain('application."userId" = approval."userId"')
    expect(approvalQuery[0]).toContain('application."sessionId" = approval."sessionId"')
    expect(approvalQuery[0]).toContain('application."jobId" = approval."jobId"')
    await expect(scheduledPrepareGateRootWitnessMatches(db as never, gateInput({ turnStatus: "waiting_for_approval" })) )
      .resolves.toBe(true)
  })

  it.each([
    ["missing approval", [], [], []],
    ["missing started item", [approvalRow("approval-1", "job-1")], [], [eventFor(approvalRow("approval-1", "job-1"))]],
    ["missing requested event", [approvalRow("approval-1", "job-1")], [itemFor(approvalRow("approval-1", "job-1"))], []],
    ["expired approval", [approvalRow("approval-1", "job-1", { expiresAt: new Date("2026-11-14T11:00:00.000Z") })],
      [itemFor(approvalRow("approval-1", "job-1"))], [eventFor(approvalRow("approval-1", "job-1"))]],
    ["decided approval", [approvalRow("approval-1", "job-1", { status: "approved", decidedAt: now })],
      [itemFor(approvalRow("approval-1", "job-1"))], [eventFor(approvalRow("approval-1", "job-1"))]],
    ["consumed approval", [approvalRow("approval-1", "job-1", { consumedAt: now })],
      [itemFor(approvalRow("approval-1", "job-1"))], [eventFor(approvalRow("approval-1", "job-1"))]],
    ["wrong Gate marker", [approvalRow("approval-1", "job-1", { payload: { jobId: "job-1", applicationTaskId: "application-task-approval-1",
      scheduledGateReview: { schemaVersion: approvalMarker, gateTaskId: "other-gate" } } })],
      [itemFor(approvalRow("approval-1", "job-1"))], [eventFor(approvalRow("approval-1", "job-1"))]],
    ["unprepared job", [approvalRow("approval-1", "other-job")],
      [itemFor(approvalRow("approval-1", "other-job"))], [eventFor(approvalRow("approval-1", "other-job"))]],
    ["external submission impact", [approvalRow("approval-1", "job-1", { impact: { externalSubmission: true, jobId: "job-1" } })],
      [itemFor(approvalRow("approval-1", "job-1"))], [eventFor(approvalRow("approval-1", "job-1"))]],
  ] as const)("does not use an approval with %s", async (_name, approvals, items, events) => {
    const db = client({ approvals: [...approvals], items: [...items], events: [...events] })
    await expect(scheduledPrepareGateApprovalWitnessIds(db as never, scope, witness, now)).resolves.toEqual([])
    await expect(scheduledPrepareGateRootWitnessMatches(db as never, gateInput({ turnStatus: "waiting_for_approval" })) )
      .resolves.toBe(false)
  })

  it.each([
    ["no task row", []],
    ["foreign user", [approvalRow("approval-1", "job-1")].map(row => applicationRow(row, { userId: "other-user" }))],
    ["wrong session", [approvalRow("approval-1", "job-1")].map(row => applicationRow(row, { sessionId: "other-session" }))],
    ["wrong job", [approvalRow("approval-1", "job-1")].map(row => applicationRow(row, { jobId: "other-job" }))],
  ] as const)("rejects an approval when its ApplicationTask has %s", async (_name, applications) => {
    const approval = approvalRow("approval-1", "job-1")
    const db = client({ approvals: [approval], applications: [...applications],
      items: [itemFor(approval)], events: [eventFor(approval)] })
    await expect(scheduledPrepareGateApprovalWitnessIds(db as never, scope, witness, now)).resolves.toEqual([])
    await expect(scheduledPrepareGateRootWitnessMatches(db as never,
      gateInput({ turnStatus: "waiting_for_approval" }))).resolves.toBe(false)
  })

  it("rejects more than one canonical approval.requested event for an approval", async () => {
    const approval = approvalRow("approval-1", "job-1"), first = eventFor(approval)
    const db = client({ approvals: [approval], items: [itemFor(approval)], events: [first, { ...first, id: "duplicate-event" }] })
    await expect(scheduledPrepareGateApprovalWitnessIds(db as never, scope, witness, now)).resolves.toEqual([])
  })

  it.each([
    ["not suspended", { suspendedAt: null }], ["resolved", { resolvedAt: now }], ["consumed", { consumedAt: now }],
    ["already matched", { matchedTaskIds: [witness.gateTaskId] }], ["multiple active waits", { activeGateWaitCount: 2 }],
    ["wrong target", { targetTaskIds: ["other-gate"] }], ["wrong mode", { mode: "all" }], ["wrong request attempt", {
      result: { request: { targetTaskIds: [witness.gateTaskId], mode: "any", timeoutMs: 86_400_000,
        scheduledGate: { gateTaskId: witness.gateTaskId, requestAttemptCount: 0 } } } }],
    ["wrong source step state", { stepStatus: "completed" }], ["changed root wait receipt", {
      parentResult: { status: "waiting_for_dependency", stepCount: 5, toolCallCount: 3, finalItemId: null, waitId: "stale-wait" } }],
  ] as const)("rejects Gate wait with %s", async (_name, overrides) => {
    const row = gateWaitRow(overrides)
    await expect(scheduledPrepareGateRootWitnessMatches(client({ waits: [row] }) as never, gateInput())).resolves.toBe(false)
  })

  it.each([
    ["wrong owner", { leaseOwner: "other-owner" }], ["expired lease", { leaseValid: false }],
    ["wrong attempt", { attemptCount: witness.gateAttemptCount - 1 }], ["interrupted child", { interruptRequestedAt: now }],
  ] as const)("rejects Gate wait with %s", async (_name, overrides) => {
    await expect(scheduledPrepareGateRootWitnessMatches(client({ gates: [gateRow(overrides)] }) as never, gateInput())).resolves.toBe(false)
  })

  it("requires an approval witness for Turn approval waits and rejects waiting_for_user", async () => {
    await expect(scheduledPrepareGateRootWitnessMatches(client() as never,
      gateInput({ rootStatus: "running", waitId: null, turnStatus: "waiting_for_approval" }))).resolves.toBe(false)
    await expect(scheduledPrepareGateRootWitnessMatches(client() as never,
      gateInput({ turnStatus: "waiting_for_user" }))).resolves.toBe(false)
    await expect(scheduledPrepareGateRootWitnessMatches(client() as never,
      gateInput({ turnStatus: "waiting_for_approval", turnLeaseOwnerId: "still-leased" }))).resolves.toBe(false)
  })
})
