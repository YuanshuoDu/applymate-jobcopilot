import { describe, expect, it, vi } from "vitest"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { redactAgentEvent } from "@jobcopilot/shared"

const mocks = vi.hoisted(() => ({
  withExactAttemptFence: vi.fn(),
  acquireSourceMaterialFence: vi.fn(),
  hasReviewedSubmissionArtifact: vi.fn(),
  readReviewedApplicationSubmitMaterial: vi.fn(),
}))
vi.mock("../queue/application-submit-fence.js", () => ({ withExactAttemptFence: mocks.withExactAttemptFence }))
vi.mock("./source-material-fence.js", () => ({ acquireSourceMaterialFence: mocks.acquireSourceMaterialFence }))
vi.mock("./reviewed-application-submit-material.js", () => ({
  hasReviewedSubmissionArtifact: mocks.hasReviewedSubmissionArtifact,
  readReviewedApplicationSubmitMaterial: mocks.readReviewedApplicationSubmitMaterial,
}))

import { readSubmissionTurnState, readSubmissionTurnStopState, withReviewedApplicationSubmitRequestFence, withReviewedApplicationSubmitStopPollFence } from "./reviewed-application-submit-request-fence.js"

const scope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", fillTurnId: "turn_1", applicationTaskId: "task_1",
  jobId: "job_1", approvalId: "approval_1", constraintHash: "b".repeat(64), workerTaskId: "worker_1", executionId: "execution_1",
}
const source = (sourceTurnId = "source-turn-1") => ({
  reviewedApplicationMaterialSource: { schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1", sourceTurnId },
})
const resourceHash = "a".repeat(64), materialHash = "c".repeat(64), answersHash = "d".repeat(64)
const approval = {
  userId: scope.userId, sessionId: scope.sessionId, turnId: scope.fillTurnId, taskId: scope.applicationTaskId, jobId: scope.jobId,
  toolCallId: `application-submit:${scope.applicationTaskId}`, type: "submit_application", status: "consumed",
  payload: { applicationTaskId: scope.applicationTaskId, coverLetterId: null, jobId: scope.jobId, resumeId: "resume_1" },
  resourceHash, materialHash, answersHash, scopeHash: scope.constraintHash,
  expiresAt: new Date("2026-12-01T00:00:00.000Z"), decidedAt: new Date("2026-11-20T00:00:00.000Z"),
  consumedAt: new Date("2026-11-20T00:01:00.000Z"),
}
const attempt = { userId: scope.userId, jobId: scope.jobId, receiptId: scope.approvalId, constraintHash: scope.constraintHash, artifactHash: resourceHash, state: "reserved" }
const startEvent = {
  approvalId: scope.approvalId, applicationTaskId: scope.applicationTaskId, constraintHash: scope.constraintHash,
  executionId: scope.executionId, fillTurnId: scope.fillTurnId, jobId: scope.jobId, sessionId: scope.sessionId,
  userId: scope.userId, workerTaskId: scope.workerTaskId,
}

function fixture(options: {
  phase?: "marker" | "boundary" | "stop_poll"; inputs?: unknown[]; taskCheckpoint?: string; taskWorkerTaskId?: string | null; attempt?: typeof attempt | null;
  approval?: Record<string, unknown> | null; event?: unknown; actionReservation?: boolean; startMarker?: boolean; stopStage?: boolean; requestPayload?: unknown;
  requestSequence?: string; rotations?: Array<Record<string, unknown>>;
} = {}) {
  const phase = options.phase ?? "marker", inputs = options.inputs ?? [source(), source()]
  const boundaryEvent = options.event === undefined ? (phase === "marker" ? null : startEvent) : options.event
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let sourceReads = 0
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('SELECT "input" FROM "agent_turns"')) {
      const input = inputs[Math.min(sourceReads++, inputs.length - 1)]
      return { rows: [{ input }], rowCount: 1 }
    }
    if (sql.includes('FROM "application_tasks"')) return { rows: [{ status: "filling", checkpoint: options.taskCheckpoint ?? (phase === "boundary" ? "submission_request_started" : "browser_active"), workerTaskId: options.taskWorkerTaskId ?? scope.workerTaskId, resumeId: "resume_1", coverLetterId: null }], rowCount: 1 }
    if (sql.includes('FROM "submission_attempt"')) {
      const rows = options.attempt === null || phase === "stop_poll" && options.attempt === undefined ? [] : [options.attempt ?? attempt]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_action_reservations"')) return { rows: options.actionReservation ? [{ id: "reservation-1" }] : [], rowCount: options.actionReservation ? 1 : 0 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: options.approval === null ? [] : [options.approval ?? approval], rowCount: options.approval === null ? 0 : 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes("approval.receipt_rotated")) {
      const rows = [...(options.rotations ?? [])].filter(row => Number(row.sequence) > Number(options.requestSequence ?? "1"))
        .sort((left, right) => Number(right.sequence) - Number(left.sequence)).slice(0, 1)
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_events"')) return { rows: [{ sequence: options.requestSequence ?? "1", payload: options.requestPayload ?? {
      action: "submit_application", approvalId: scope.approvalId, scopeHash: scope.constraintHash, revision: 4,
    } }], rowCount: 1 }
    if (sql.includes('FROM "application_task_events"')) {
      if (phase === "stop_poll") {
        const present = sql.includes("submission_execution_started") ? options.startMarker : options.stopStage
        return { rows: present ? [{ id: "event-1" }] : [], rowCount: present ? 1 : 0 }
      }
      const event = boundaryEvent && (!sql.includes("data\"->>'approvalId'") || (boundaryEvent as Record<string, unknown>).approvalId === values?.[1])
        ? boundaryEvent : null
      return { rows: event === null ? [] : [{ data: event }], rowCount: event === null ? 0 : 1 }
    }
    throw new Error(`Unexpected query: ${sql}`)
  })
  const client = { query } as never
  return { client, calls }
}

async function approvedStopPollFixture(): Promise<{ readonly scope: typeof scope; readonly approval: Record<string, unknown>; readonly requestPayload: Record<string, unknown> }> {
  const nonceHash = "e".repeat(64), expiresAt = new Date("2099-12-01T00:00:00.000Z"), revision = 4
  const approvalId = `application-fill:${scope.applicationTaskId}:${scope.fillTurnId}`
  const reviewedScope = { ...scope, approvalId, constraintHash: await hashApprovalScope({ userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.fillTurnId, jobId: scope.jobId, toolCallId: `application-submit:${scope.applicationTaskId}`, action: "submit_application" as const,
    resourceHash, materialHash, answersHash, revision, nonceHash, expiresAt: expiresAt.toISOString() }) }
  return { scope: reviewedScope, approval: { ...approval, id: approvalId, status: "approved", scopeHash: reviewedScope.constraintHash, nonceHash, revision,
    expiresAt, decidedAt: new Date("2099-11-20T00:00:00.000Z"), consumedAt: null }, requestPayload: {
      action: "submit_application", approvalId, scopeHash: reviewedScope.constraintHash, revision,
    } }
}

function rotationEvent(submissionScope: typeof scope, overrides: Record<string, unknown> = {}) {
  return { actor: "system", taskId: submissionScope.applicationTaskId, correlationId: submissionScope.approvalId,
    idempotencyKey: `approval:${submissionScope.approvalId}:receipt-rotated:${submissionScope.constraintHash}`,
    payload: { approvalId: submissionScope.approvalId, scopeHash: submissionScope.constraintHash, revision: 4 }, sequence: "2", ...overrides }
}

function productionRotationPayload(submissionScope: typeof scope) {
  return redactAgentEvent({ type: "approval.receipt_rotated", body: "", data: {
    approvalId: submissionScope.approvalId, scopeHash: submissionScope.constraintHash, revision: 4,
  }, routing: { sessionId: submissionScope.sessionId, turnId: submissionScope.fillTurnId,
    itemId: `agent-wait:approval:${submissionScope.approvalId}`,
    taskId: submissionScope.applicationTaskId, actor: "system", correlationId: submissionScope.approvalId,
    causationId: null, outboxTopic: "agent.session.event" } }).data
}

function resetMocks() {
  mocks.withExactAttemptFence.mockReset().mockImplementation(async (_client: unknown, _scope: unknown, work: () => Promise<unknown>) => ({
    kind: "current", value: await work(),
  }))
  mocks.acquireSourceMaterialFence.mockReset().mockResolvedValue(undefined)
  mocks.hasReviewedSubmissionArtifact.mockReset().mockResolvedValue(false)
  mocks.readReviewedApplicationSubmitMaterial.mockReset().mockResolvedValue({ artifactHash: resourceHash })
}

describe("reviewed application submit request source fence", () => {
  it("reads lease and interruption evidence for the protocol without widening the legacy reader", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{
        status: "in_progress", leaseOwnerId: "worker-1", leaseStartedAt: new Date("2026-11-21T10:00:00Z"),
        leaseExpiresAt: new Date("2026-11-21T10:05:00Z"), leaseVersion: 4,
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_events"')) return { rows: [{ stopped: true }], rowCount: 1 }
      throw new Error(`Unexpected query: ${sql}`)
    })
    const client = { query } as never

    await expect(readSubmissionTurnStopState(client, scope)).resolves.toEqual({
      sessionStatus: "running", turnStatus: "in_progress", leaseOwnerId: "worker-1",
      leaseStartedAt: new Date("2026-11-21T10:00:00Z"), leaseExpiresAt: new Date("2026-11-21T10:05:00Z"),
      leaseVersion: 4, interruptionEvidence: true,
    })
    expect(calls[1]?.sql).toContain('"leaseOwnerId", "leaseStartedAt", "leaseExpiresAt", "leaseVersion"')
    expect(calls[1]?.values).toEqual([scope.turnId, scope.sessionId, scope.userId])
    expect(calls[2]?.sql).toContain("'turn.interrupt.requested', 'turn.interrupted', 'turn.failed'")

    calls.length = 0
    await expect(readSubmissionTurnState(client, scope)).resolves.toEqual({
      sessionStatus: "running", turnStatus: "in_progress", interrupted: true,
    })
    const legacyEventQuery = calls.find(call => call.sql.includes('FROM "agent_events"'))?.sql ?? ""
    expect(legacyEventQuery).toContain('"type" = \'turn.interrupted\'')
    expect(legacyEventQuery).not.toContain("turn.interrupt.requested")
    expect(legacyEventQuery).not.toContain("turn.failed")
  })

  it("locks source material before exact attempt rows and validates the consumed receipt and live reviewed proof", async () => {
    resetMocks()
    const { client, calls } = fixture()

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async sourceTurnId => sourceTurnId)).resolves.toEqual({
      kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1",
    })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.acquireSourceMaterialFence.mock.invocationCallOrder[0]).toBeLessThan(mocks.withExactAttemptFence.mock.invocationCallOrder[0]!)
    expect(mocks.readReviewedApplicationSubmitMaterial).toHaveBeenCalledWith({
      client, identity: scope, sourceTurnId: "source-turn-1",
      approval: { resourceHash, materialHash, answersHash }, currentSource: true,
    })
    expect(calls.find(call => call.sql.includes('FROM "submission_attempt"'))?.sql).toContain("FOR UPDATE")
    expect(calls.find(call => call.sql.includes('FROM "agent_approvals"'))?.sql).toContain("FOR UPDATE")
  })

  it("reacquires the source fence before exact locks at the paused request boundary", async () => {
    resetMocks()
    const { client } = fixture({ phase: "boundary" })

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "boundary", "source-turn-1", async sourceTurnId => sourceTurnId))
      .resolves.toEqual({ kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1" })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.acquireSourceMaterialFence.mock.invocationCallOrder[0]).toBeLessThan(mocks.withExactAttemptFence.mock.invocationCallOrder[0]!)
    expect(mocks.readReviewedApplicationSubmitMaterial).toHaveBeenCalledWith(expect.objectContaining({ currentSource: true, sourceTurnId: "source-turn-1" }))
  })

  it("admits only the exact approved, unreserved reviewed request to the read-only Stop poll", async () => {
    resetMocks()
    const approved = await approvedStopPollFixture(), test = fixture({ phase: "stop_poll", approval: approved.approval, requestPayload: approved.requestPayload })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async sourceTurnId => sourceTurnId)).resolves.toEqual({
      kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1",
    })
    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(test.client, [approved.scope.userId])
    expect(mocks.readReviewedApplicationSubmitMaterial).toHaveBeenCalledWith({ client: test.client, identity: approved.scope,
      sourceTurnId: "source-turn-1", approval: { resourceHash, materialHash, answersHash }, currentSource: true })
    expect(test.calls.some(call => call.sql.includes('FROM "agent_action_reservations"'))).toBe(true)
    expect(test.calls.some(call => call.sql.includes("submission_execution_started"))).toBe(true)
    expect(test.calls.some(call => call.sql.includes("submission_stop_protocol"))).toBe(true)
    const requestQuery = test.calls.find(call => call.sql.includes("approval.requested"))
    expect(requestQuery?.sql).toContain('request."actor"=\'orchestrator\'')
    expect(requestQuery?.sql).toContain('request."taskId"=$5')
    expect(requestQuery?.sql).toContain('request."correlationId"=$3')
    expect(requestQuery?.sql).toContain('request."idempotencyKey"=$4')
    expect(requestQuery?.sql).toContain("goal.revision")
  })

  it("accepts the exact latest receipt rotation after its immutable request event", async () => {
    resetMocks()
    const approved = await approvedStopPollFixture(), priorScopeHash = "f".repeat(64)
    const test = fixture({ phase: "stop_poll", approval: approved.approval,
      requestPayload: { ...approved.requestPayload, scopeHash: priorScopeHash }, rotations: [rotationEvent(approved.scope)] })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async sourceTurnId => sourceTurnId)).resolves.toEqual({
      kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1",
    })
    const query = test.calls.find(call => call.sql.includes("approval.receipt_rotated"))
    expect(query?.sql).toContain('"sequence">$4')
    expect(query?.sql).toContain('ORDER BY "sequence" DESC LIMIT 1')
  })

  it("accepts the canonical approvalId redaction produced by the real event router", async () => {
    resetMocks()
    const approved = await approvedStopPollFixture(), priorScopeHash = "f".repeat(64)
    const payload = productionRotationPayload(approved.scope)
    const redacted = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null
    expect({ marker: redacted?.approvalId === "[REDACTED]", scopeHashPreserved: redacted?.scopeHash === approved.scope.constraintHash,
      revisionPreserved: redacted?.revision === 4, closedKeys: Object.keys(redacted ?? {}).sort().join(",") })
      .toEqual({ marker: true, scopeHashPreserved: true, revisionPreserved: true, closedKeys: "approvalId,revision,scopeHash" })
    const test = fixture({ phase: "stop_poll", approval: approved.approval,
      requestPayload: { ...approved.requestPayload, scopeHash: priorScopeHash }, rotations: [rotationEvent(approved.scope, { payload })] })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async sourceTurnId => sourceTurnId)).resolves.toEqual({
      kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1",
    })
  })

  it.each([
    ["missing rotation for changed hash", "missing"],
    ["stale rotation", "stale"],
    ["malformed rotation", "malformed"],
    ["different literal approval id", "differentId"],
    ["foreign rotation", "foreign"],
    ["superseded by malformed latest rotation", "latest"],
    ["rotation predating the request", "predates"],
  ] as const)("rejects %s during Stop polling", async (_name, kind) => {
    resetMocks()
    const approved = await approvedStopPollFixture(), priorScopeHash = "f".repeat(64)
    const exact = rotationEvent(approved.scope)
    const requestPayload = { ...approved.requestPayload, scopeHash: priorScopeHash }
    const rotations = kind === "missing" ? [] : kind === "predates" ? [rotationEvent(approved.scope, { sequence: "1" })]
      : kind === "stale" ? [rotationEvent(approved.scope, {
        idempotencyKey: `approval:${approved.scope.approvalId}:receipt-rotated:${priorScopeHash}`,
        payload: { approvalId: approved.scope.approvalId, scopeHash: priorScopeHash, revision: 4 },
      })]
      : kind === "malformed" ? [rotationEvent(approved.scope, { payload: { ...exact.payload, unexpected: true } })]
      : kind === "differentId" ? [rotationEvent(approved.scope, { payload: { ...exact.payload, approvalId: "different-approval" } })]
      : kind === "foreign" ? [rotationEvent(approved.scope, { taskId: "another-task" })]
      : [exact, rotationEvent(approved.scope, { sequence: "3", idempotencyKey: "wrong-key" })]
    const test = fixture({ phase: "stop_poll", approval: approved.approval, requestPayload, rotations })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async () => false)).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it.each([
    ["foreign task", { taskId: "another-task" }],
    ["foreign correlation", { correlationId: "another-approval" }],
    ["wrong actor", { actor: "orchestrator" }],
    ["wrong idempotency key", { idempotencyKey: "other-rotation" }],
  ])("rejects the real redacted rotation with %s routing", async (_name, override) => {
    resetMocks()
    const approved = await approvedStopPollFixture(), priorScopeHash = "f".repeat(64)
    const payload = productionRotationPayload(approved.scope)
    const test = fixture({ phase: "stop_poll", approval: approved.approval,
      requestPayload: { ...approved.requestPayload, scopeHash: priorScopeHash }, rotations: [rotationEvent(approved.scope, { ...override, payload })] })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async () => false)).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it.each([
    ["foreign owner", { userId: "another-user" }],
    ["foreign session", { sessionId: "another-session" }],
    ["foreign turn", { turnId: "another-turn" }],
    ["foreign task", { taskId: "another-task" }],
    ["foreign job", { jobId: "another-job" }],
  ])("rejects a Stop poll receipt with a %s", async (_name, override) => {
    resetMocks()
    const approved = await approvedStopPollFixture()
    const test = fixture({ phase: "stop_poll", approval: { ...approved.approval, ...override }, requestPayload: approved.requestPayload })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async () => false)).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("rejects a malformed immutable approval request scope digest", async () => {
    resetMocks()
    const approved = await approvedStopPollFixture()
    const test = fixture({ phase: "stop_poll", approval: approved.approval,
      requestPayload: { ...approved.requestPayload, scopeHash: "not-a-digest" } })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async () => false)).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("keeps a consumed reserved attempt on the original strict marker proof during polling", async () => {
    resetMocks()
    const test = fixture({ phase: "stop_poll", attempt })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, scope, async sourceTurnId => sourceTurnId))
      .resolves.toMatchObject({ kind: "current", value: "source-turn-1" })
    expect(test.calls.some(call => call.sql.includes('FROM "submission_attempt"') && call.sql.includes("FOR UPDATE"))).toBe(true)
    expect(test.calls.find(call => call.sql.includes('FROM "agent_approvals"'))?.sql).toContain("FOR UPDATE")
    expect(mocks.readReviewedApplicationSubmitMaterial).toHaveBeenCalledOnce()
  })

  it.each([
    ["expired approval", (row: Record<string, unknown>) => ({ ...row, expiresAt: new Date("2000-01-01T00:00:00.000Z") }), {}],
    ["wrong consumer", (row: Record<string, unknown>) => ({ ...row, toolCallId: "another-consumer" }), {}],
    ["wrong scope hash", (row: Record<string, unknown>) => ({ ...row, scopeHash: "f".repeat(64) }), {}],
    ["partially reserved approval", (row: Record<string, unknown>) => row, { actionReservation: true }],
    ["request marker already present", (row: Record<string, unknown>) => row, { startMarker: true }],
  ] as const)("rejects %s before Stop polling", async (_name, change, options) => {
    resetMocks()
    const approved = await approvedStopPollFixture()
    const test = fixture({ phase: "stop_poll", approval: change(approved.approval), requestPayload: approved.requestPayload, ...options })
    await expect(withReviewedApplicationSubmitStopPollFence(test.client, approved.scope, async () => false)).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("retains the valid legacy path when no reviewed selector exists", async () => {
    resetMocks()
    const { client } = fixture({ inputs: [{}, {}] })

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async sourceTurnId => sourceTurnId ?? "legacy"))
      .resolves.toEqual({ kind: "current", value: "legacy", sourceTurnId: null })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.hasReviewedSubmissionArtifact).toHaveBeenCalledWith(client, scope)
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()

    resetMocks()
    const legacyPoll = fixture({ phase: "stop_poll", inputs: [{}, {}] })
    await expect(withReviewedApplicationSubmitStopPollFence(legacyPoll.client, scope, async () => "legacy-poll"))
      .resolves.toMatchObject({ kind: "current", value: "legacy-poll", sourceTurnId: null })
    expect(mocks.hasReviewedSubmissionArtifact).toHaveBeenCalledWith(legacyPoll.client, scope)
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("does not downgrade a missing selector when the exact task already has a reviewed manifest", async () => {
    resetMocks()
    mocks.hasReviewedSubmissionArtifact.mockResolvedValueOnce(true)
    const { client } = fixture({ inputs: [{}, {}] })

    await expect(withReviewedApplicationSubmitRequestFence(client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })

    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(client, [scope.userId])
    expect(mocks.hasReviewedSubmissionArtifact).toHaveBeenCalledWith(client, scope)
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("rejects a changed or removed selector rather than downgrading the reviewed request", async () => {
    resetMocks()
    const changed = fixture({ inputs: [source("source-turn-1"), source("source-turn-2")] })
    await expect(withReviewedApplicationSubmitRequestFence(changed.client, scope, "marker", undefined, async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()

    resetMocks()
    const missingAtBoundary = fixture({ phase: "boundary", inputs: [{}, {}] })
    await expect(withReviewedApplicationSubmitRequestFence(missingAtBoundary.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
    expect(mocks.acquireSourceMaterialFence).toHaveBeenCalledWith(missingAtBoundary.client, [scope.userId])
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()

    resetMocks()
    mocks.withExactAttemptFence.mockResolvedValueOnce({ kind: "superseded" })
    const removedBeforeLock = fixture({ phase: "boundary", inputs: [{}, {}] })
    await expect(withReviewedApplicationSubmitRequestFence(removedBeforeLock.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
  })

  it.each([
    ["wrong task checkpoint", { taskCheckpoint: "submission_uncertain" }, "marker" as const],
    ["current Worker task changed", { taskWorkerTaskId: "other-worker" }, "marker" as const],
    ["request boundary Worker task changed", { taskWorkerTaskId: "other-worker" }, "boundary" as const],
    ["missing reserved attempt", { attempt: null }, "marker" as const],
    ["attempt artifact differs from the consumed approval", { attempt: { ...attempt, artifactHash: "e".repeat(64) } }, "marker" as const],
    ["approval was not consumed", { approval: { ...approval, status: "approved" } }, "marker" as const],
    ["boundary event names another worker task", { event: { ...startEvent, workerTaskId: "other-worker" } }, "boundary" as const],
  ])("rejects %s", async (_name, overrides, phase) => {
    resetMocks()
    const test = fixture({ ...overrides, phase })
    await expect(withReviewedApplicationSubmitRequestFence(
      test.client, scope, phase, phase === "boundary" ? "source-turn-1" : undefined, async () => "sent",
    )).resolves.toEqual({ kind: "invalid" })
    expect(mocks.readReviewedApplicationSubmitMaterial).not.toHaveBeenCalled()
  })

  it("rejects a live material proof mismatch or selector change at the request boundary", async () => {
    resetMocks()
    mocks.readReviewedApplicationSubmitMaterial.mockResolvedValueOnce(null)
    const invalidProof = fixture({ phase: "boundary" })
    await expect(withReviewedApplicationSubmitRequestFence(invalidProof.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })

    resetMocks()
    const changed = fixture({ phase: "boundary", inputs: [source("source-turn-1"), source("source-turn-2")] })
    await expect(withReviewedApplicationSubmitRequestFence(changed.client, scope, "boundary", "source-turn-1", async () => "sent"))
      .resolves.toEqual({ kind: "invalid" })
  })

  it("ignores start history belonging to another consumed approval", async () => {
    resetMocks()
    const test = fixture({ event: { ...startEvent, approvalId: "prior-approval" } })

    await expect(withReviewedApplicationSubmitRequestFence(test.client, scope, "marker", undefined, async sourceTurnId => sourceTurnId))
      .resolves.toEqual({ kind: "current", value: "source-turn-1", sourceTurnId: "source-turn-1" })

    const starts = test.calls.find(call => call.sql.includes('FROM "application_task_events"'))
    expect(starts?.sql).toContain("data\"->>'approvalId'=$2")
    expect(starts?.values).toEqual([scope.applicationTaskId, scope.approvalId])
  })
})
