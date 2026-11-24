import { beforeEach, describe, expect, it, vi } from "vitest"

const settlementReader = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock("../../db/objective-application-submit-settlement.js", () => ({
  readObjectiveApplicationSubmitSettlement: settlementReader.read,
}))

import type pg from "pg"
import type { ApplicationSubmissionExecution } from "../../queue/application-submit-fence.js"
import {
  hasParkedObjectiveRootWaitWithClient,
  hasPublishedObjectiveSubmitWakeWithClient,
  objectiveSubmitRootWaitMatchesApproval,
  objectiveApplicationSubmitFinalizationEventId,
  objectiveApplicationSubmitFinalizationReceiptFor,
  parseObjectiveSubmitRootWait,
  readObjectiveApplicationSubmitFinalizationWithClient,
} from "./recovery-scanner-objective-submit.js"

const execution: ApplicationSubmissionExecution = {
  userId: "user_1", sessionId: "session_1", jobId: "job_1", applicationTaskId: "task_1", fillTurnId: "turn_1",
  approvalId: "application-fill:task_1:turn_1", constraintHash: "a".repeat(64), workerTaskId: "worker_1", executionId: "exec_1",
}
const settlement = {
  userId: execution.userId, sessionId: execution.sessionId, applicationTaskId: execution.applicationTaskId,
  jobId: execution.jobId, fillTurnId: execution.fillTurnId, approvalId: execution.approvalId,
  workerTaskId: execution.workerTaskId, executionId: execution.executionId, attemptId: "attempt_1",
  resultLinkEventId: "result_link_1", applyResultId: 19, fillTurnStatus: "waiting_for_approval" as const,
}

function clientFor(rows: (sql: string, params?: unknown[]) => unknown) {
  return { query: vi.fn(async (sql: string, params?: unknown[]) => rows(sql, params)) } as unknown as Pick<pg.PoolClient, "query">
}

describe("Objective finalization recovery receipt", () => {
  beforeEach(() => settlementReader.read.mockReset().mockResolvedValue(settlement))

  it.each([
    ["parked dependency", "waiting", null, { status: "waiting_for_dependency", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: "wait_1" }, { kind: "parked_dependency", waitId: "wait_1" }],
    ["explicit approval wait", "waiting_for_user", null, { status: "waiting_for_approval", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: "approval_wait_1" }, { kind: "explicit_approval", waitId: "approval_wait_1" }],
    ["policy approval projection", "waiting_for_user", "policy_requires_approval", { status: "waiting_for_approval", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: null }, { kind: "explicit_approval", waitId: null }],
  ] as const)("accepts the exact healthy Root state for %s", (_name, status, reason, result, expected) => {
    expect(parseObjectiveSubmitRootWait(status, reason, result)).toEqual(expected)
  })

  it("requires any persisted explicit approval wait to match the approved wake", () => {
    const root = parseObjectiveSubmitRootWait("waiting_for_user", null, {
      status: "waiting_for_approval", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: "approval_wait_1",
    })
    const policy = parseObjectiveSubmitRootWait("waiting_for_user", "policy_requires_approval", {
      status: "waiting_for_approval", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: null,
    })
    expect(root && objectiveSubmitRootWaitMatchesApproval(root, "approval_wait_1")).toBe(true)
    expect(root && objectiveSubmitRootWaitMatchesApproval(root, "foreign_wait")).toBe(false)
    expect(policy && objectiveSubmitRootWaitMatchesApproval(policy, "approval_wait_1")).toBe(true)
  })

  it.each([
    ["failed root", "failed", null, "waiting_for_dependency", "wait_1"],
    ["dependency with a failure reason", "waiting", "policy_requires_approval", "waiting_for_dependency", "wait_1"],
    ["approval with missing wait id", "waiting_for_user", null, "waiting_for_approval", null],
    ["approval with a conflicting wait", "waiting_for_user", "policy_requires_approval", "waiting_for_approval", "other_wait"],
    ["approval with an unknown failure reason", "waiting_for_user", "other_error", "waiting_for_approval", null],
    ["completed root", "completed", null, "completed", null],
  ] as const)("rejects %s", (_name, status, reason, resultStatus, waitId) => {
    expect(parseObjectiveSubmitRootWait(status, reason, {
      status: resultStatus, stepCount: 2, toolCallCount: 1, finalItemId: null, waitId,
    })).toBeNull()
  })

  it("binds a parked Root result to its exact owner, wait, parent, and Step", async () => {
    const client = clientFor(sql => ({ rows: sql.includes('FROM "agent_wait_conditions" AS wait')
      ? [{ id: "wait_1", stepId: "step_1" }] : [] }))
    await expect(hasParkedObjectiveRootWaitWithClient(client, {
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", waitId: "wait_1",
    })).resolves.toBe(true)
    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('wait."parentTaskId"=$5')
    expect(sql).toContain('step."status"=\'waiting_for_tool\' AND step."attempt"=1')
    expect(sql).toContain('wait."status" IN (\'waiting\',\'ready\')')
    expect(sql).toContain('wait."consumedAt" IS NULL')
    expect(sql).not.toContain("timed_out")
    expect(params).toEqual(["wait_1", "user_1", "session_1", "turn_1", "root_1"])
  })

  it("rejects missing, consumed, or differently scoped parked waits", async () => {
    const client = clientFor(() => ({ rows: [] }))
    await expect(hasParkedObjectiveRootWaitWithClient(client, {
      userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", waitId: "wait_1",
    })).resolves.toBe(false)
    await expect(hasParkedObjectiveRootWaitWithClient(client, {
      userId: " user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", waitId: "wait_1",
    })).resolves.toBe(false)
  })

  it("accepts the immutable receipt after a normal recovery generation replaces the dispatch owner", async () => {
    const receipt = objectiveApplicationSubmitFinalizationReceiptFor(execution, settlement)
    const eventId = objectiveApplicationSubmitFinalizationEventId(execution, settlement.resultLinkEventId)
    const client = clientFor(sql => sql.includes('FROM "application_task_events"')
      ? { rows: [{ id: eventId, taskId: execution.applicationTaskId, type: "objective_application_submit_finalization_queued",
          actor: "worker", body: "Objective submit finalization queued.", data: receipt, createdAt: new Date("2026-11-24T12:00:00Z") }] }
      : { rows: [{ topic: "agent.turn.dispatch", aggregateId: execution.sessionId,
          idempotencyKey: "turn-dispatch:turn_1", payload: { turnId: "turn_1", sessionId: "session_1", ownerId: "recovery-owner-2" } }] })

    await expect(readObjectiveApplicationSubmitFinalizationWithClient(client, execution)).resolves.toMatchObject({
      eventId, executionId: "exec_1", resultLinkEventId: "result_link_1",
    })
  })

  it.each([
    ["wrong Turn", { turnId: "foreign_turn", sessionId: "session_1", ownerId: "recovery-owner" }],
    ["wrong session", { turnId: "turn_1", sessionId: "foreign_session", ownerId: "recovery-owner" }],
    ["malformed payload", { turnId: "turn_1", sessionId: "session_1", ownerId: "" }],
  ] as const)("rejects a dispatch receipt with %s", async (_kind, payload) => {
    const receipt = objectiveApplicationSubmitFinalizationReceiptFor(execution, settlement)
    const eventId = objectiveApplicationSubmitFinalizationEventId(execution, settlement.resultLinkEventId)
    const client = clientFor(sql => sql.includes('FROM "application_task_events"')
      ? { rows: [{ id: eventId, taskId: execution.applicationTaskId, type: "objective_application_submit_finalization_queued",
          actor: "worker", body: "Objective submit finalization queued.", data: receipt, createdAt: new Date() }] }
      : { rows: [{ topic: "agent.turn.dispatch", aggregateId: execution.sessionId,
          idempotencyKey: "turn-dispatch:turn_1", payload }] })
    await expect(readObjectiveApplicationSubmitFinalizationWithClient(client, execution)).resolves.toBeNull()
  })

  it("requires the original approved wake to be published cleanly before moving the Turn", async () => {
    const wake = { eventId: "wake_1", sessionId: "session_1", turnId: "turn_1", itemId: "wait_1", waitKind: "approval" as const,
      waitId: execution.approvalId, toolCallId: "application-submit:task_1", status: "approved" as const, nextTurnRevision: 8 }
    const resolution = { id: "resolved_1", sessionId: "session_1", turnId: "turn_1", itemId: "wait_1", taskId: "task_1",
      type: "approval.resolved", actor: "user", correlationId: execution.approvalId, idempotencyKey: "agent-wait-command:cmd_1" }
    const envelope = { eventId: wake.eventId, sessionId: wake.sessionId, turnId: wake.turnId, itemId: wake.itemId,
      taskId: null, sequence: "91", type: "turn.wakeup", actor: "user", correlationId: wake.turnId,
      causationId: resolution.id, idempotencyKey: `${resolution.idempotencyKey}:wakeup`,
      payload: { waitKind: wake.waitKind, waitId: wake.waitId, itemId: wake.itemId, turnId: wake.turnId,
        toolCallId: wake.toolCallId, status: wake.status, nextTurnRevision: wake.nextTurnRevision, answerAvailable: false } }
    const makeClient = (lastError: unknown, publishedAt: Date | null = new Date()) => clientFor(sql => sql.includes('FROM "agent_events"')
      ? { rows: [resolution] }
      : { rows: [{ topic: "agent.turn.wakeup", aggregateId: wake.sessionId, idempotencyKey: `agent-event:${wake.eventId}`,
          payload: envelope, publishedAt, lastError }] })

    await expect(hasPublishedObjectiveSubmitWakeWithClient(makeClient(null), wake, execution.applicationTaskId)).resolves.toBe(true)
    await expect(hasPublishedObjectiveSubmitWakeWithClient(makeClient("processing_error"), wake, execution.applicationTaskId)).resolves.toBe(false)
    await expect(hasPublishedObjectiveSubmitWakeWithClient(makeClient(null, null), wake, execution.applicationTaskId)).resolves.toBe(false)
  })
})
