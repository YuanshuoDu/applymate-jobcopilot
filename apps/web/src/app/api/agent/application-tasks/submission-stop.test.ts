import { Prisma } from "@prisma/client"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { hashAgentReceiptValue } from "@jobcopilot/shared"
import {
  APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA,
  applicationSubmissionStopEventId,
  type ApplicationSubmissionStopAttempt,
  type ApplicationSubmissionStopStage,
} from "@jobcopilot/shared/application-submission-stop-protocol"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { protocolScope } from "@/lib/agent/approval/types"
import type { SubmissionEvidenceEventType } from "@/lib/agent/application-submission-evidence"
import {
  ApplicationSubmissionStopError,
  createApplicationSubmissionStopTarget,
  requestApplicationSubmissionStopInTransaction,
} from "./submission-stop"

const body = "Application submission Stop protocol state recorded."
const identity = {
  userId: "user-1", sessionId: "session-1", applicationTaskId: "application-task-1", jobId: "job-1",
  fillTurnId: "fill-turn-1", workerTaskId: "worker-task-1", approvalId: "approval-1", receiptId: "approval-1",
  executionId: "execution-1",
}
const task = {
  id: identity.applicationTaskId, userId: identity.userId, sessionId: identity.sessionId, jobId: identity.jobId,
  status: "filling", checkpoint: "submission_request_started", fillTurnId: identity.fillTurnId,
  fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId, workerTaskId: identity.workerTaskId,
  resumeId: "resume-1", coverLetterId: null, confirmedAnswers: { questions: [] },
}
const startData = {
  executionId: identity.executionId, workerTaskId: identity.workerTaskId, applicationTaskId: identity.applicationTaskId,
  userId: identity.userId, jobId: identity.jobId, sessionId: identity.sessionId, fillTurnId: identity.fillTurnId,
  approvalId: identity.approvalId, constraintHash: "",
}

type FixtureOptions = {
  stages?: ApplicationSubmissionStopStage[]; malformed?: "body" | "actor" | "payload"
  submitted?: boolean; uncertain?: boolean; settled?: boolean; reviewed?: boolean; drift?: boolean
  turnStatus?: string; sessionStatus?: string; invalidLease?: boolean
  turnEvent?: "turn.interrupt.requested" | "turn.interrupted" | "turn.failed"
}

async function fixture(options: FixtureOptions = {}) {
  const material = { applicationTaskId: task.id, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: null }
  const proof = {
    jobId: identity.jobId, sourceTurnId: "source-turn-1", rootTaskId: "root-1", graphRevision: 4,
    writerTaskId: "writer-1", reviewerTaskId: "reviewer-1", reviewerToolCallId: "review-call-1",
    reviewHash: `sha256:${"c".repeat(64)}`, artifactId: "cover-letter:job-1", version: 3,
    contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
  }
  const reviewedCoverLetterHash = await hashAgentReceiptValue("reviewed-application-material", {
    schemaVersion: "agent-harness.v2.reviewed-application-material-proof.v1", ...proof,
  })
  const frozenMaterial = options.reviewed ? { ...material, reviewedCoverLetterHash } : material
  const materialHash = await hashAgentReceiptValue("material", frozenMaterial)
  const frozenAnswers = task.confirmedAnswers
  const answersHash = await hashAgentReceiptValue("answers", frozenAnswers)
  const artifactHash = "c".repeat(64)
  const nonceHash = "d".repeat(64)
  const expiresAt = new Date(Date.now() + 60_000)
  const scope = protocolScope({
    userId: identity.userId, sessionId: identity.sessionId, turnId: identity.fillTurnId, jobId: identity.jobId,
    toolCallId: `application-submit:${task.id}`, action: "submit_application", resourceHash: artifactHash,
    materialHash, answersHash, revision: 4, expiresAt,
  }, nonceHash)
  const constraintHash = await hashApprovalScope(scope)
  const currentStart = { ...startData, constraintHash }
  const queueData = {
    applicationTaskId: task.id, userId: identity.userId, jobId: identity.jobId, sessionId: identity.sessionId,
    fillTurnId: identity.fillTurnId, approvalId: identity.approvalId, receiptId: identity.receiptId,
    constraintHash, workerTaskId: identity.workerTaskId,
  }
  const currentTask = {
    ...task,
    ...(options.drift ? { resumeId: "resume-after-approval", coverLetterId: "letter-after-approval", confirmedAnswers: { questions: ["changed"] } } : {}),
    ...(options.submitted ? { status: "submitted", checkpoint: "submission_verified" } : {}),
    ...(options.uncertain ? { status: "waiting_for_user", checkpoint: "submission_uncertain" } : {}),
  }
  const attempt: ApplicationSubmissionStopAttempt = { ...identity, constraintHash }
  const key = {
    sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, applicationTaskId: identity.applicationTaskId,
    userId: identity.userId, jobId: identity.jobId, approvalId: identity.approvalId, receiptId: identity.receiptId,
    constraintHash, workerTaskId: identity.workerTaskId,
  }
  const protocolRows: Array<{ id: string; taskId: string; type: string; actor: string; body: string; data: unknown }> = (options.stages ?? ["armed"]).map(stage => ({
    id: applicationSubmissionStopEventId(key, stage), taskId: task.id, type: "submission_stop_protocol",
    actor: stage === "stop_requested" ? "user" : "worker", body,
    data: { schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage, ...attempt },
  }))
  if (options.malformed === "body" && protocolRows[0]) protocolRows[0].body = "unexpected body"
  if (options.malformed === "actor" && protocolRows[0]) protocolRows[0].actor = "system"
  if (options.malformed === "payload" && protocolRows[0]) protocolRows[0].data = { ...(protocolRows[0].data as Record<string, unknown>), extra: true }
  const attemptEvents: Array<{ id: string; taskId: string; type: SubmissionEvidenceEventType; actor: string; data: unknown }> = [
    { id: "queued-1", taskId: task.id, type: "submission_queued", actor: "user", data: queueData },
    { id: `evt_${identity.executionId}`, taskId: task.id, type: "submission_execution_started", actor: "worker", data: currentStart },
  ]
  if (options.submitted || options.settled) attemptEvents.push({ id: "settled-1", taskId: task.id, type: "submission_execution_settled", actor: "worker", data: currentStart })
  if (options.submitted) {
    attemptEvents.push({ id: "evidence-1", taskId: task.id, type: "submission_evidence_recorded", actor: "worker", data: {
        schemaVersion: 1, userId: identity.userId, sessionId: identity.sessionId, fillTurnId: identity.fillTurnId,
        applicationTaskId: task.id, jobId: identity.jobId, approvalId: identity.approvalId, constraintHash,
        workerTaskId: identity.workerTaskId, executionId: identity.executionId, attemptId: "attempt-row-1",
        artifactHash, workerReport: "recorded_submitted", localRecord: "correlated", siteOutcome: "unverified",
      } })
  }
  const approval = {
    id: identity.approvalId, userId: identity.userId, sessionId: identity.sessionId, taskId: task.id,
    turnId: identity.fillTurnId, jobId: identity.jobId, toolCallId: `application-submit:${task.id}`,
    type: "submit_application", status: "consumed", scopeHash: constraintHash, resourceHash: artifactHash,
    materialHash, answersHash, nonceHash, revision: 4, expiresAt, decidedAt: new Date(), consumedAt: new Date(),
    payloadApplicationTaskId: task.id, payloadJobId: identity.jobId,
  }
  const submitAttempt = {
    id: "attempt-row-1", userId: identity.userId, jobId: identity.jobId, receiptId: identity.receiptId,
    constraintHash, artifactHash, state: options.submitted ? "submitted" : options.uncertain ? "failed" : "reserved",
    responseRef: options.submitted ? "receipt-ref" : null,
  }
  const now = Date.now()
  const turn = {
    id: identity.fillTurnId, status: options.turnStatus ?? "completed",
    leaseOwnerId: options.turnStatus === "in_progress" ? "lease-owner-1" : null,
    leaseStartedAt: options.turnStatus === "in_progress" ? new Date(now - 1_000) : null,
    leaseExpiresAt: options.turnStatus === "in_progress" ? new Date(now + 60_000) : null,
    leaseVersion: options.turnStatus === "in_progress" ? 2 : 0,
    ...(options.invalidLease ? { leaseOwnerId: null, leaseExpiresAt: new Date(now - 1_000) } : {}),
  }
  const create = vi.fn(async ({ data }: { data: typeof protocolRows[number] }) => { protocolRows.push(data) })
  const raw = vi.fn(async (query: Prisma.Sql) => {
    const sql = query.sql
    if (sql.includes('FROM "application_tasks"')) return [currentTask]
    if (sql.includes('FROM "agent_sessions"') && sql.includes("NOT IN")) return [{ id: identity.sessionId }]
    if (sql.includes('FROM "agent_sessions"')) return [{ status: options.sessionStatus ?? (options.turnStatus === "in_progress" ? "running" : "completed") }]
    if (sql.includes('FROM "agent_turns"')) return [turn]
    if (sql.includes('FROM "agent_events"')) return [{ stopped: options.turnEvent !== undefined }]
    if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: "filler-1", status: "completed", leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null, role: "application_filler", taskType: "application_fill_for_review" }]
    if (sql.includes('FROM "Job"')) return [{ id: identity.jobId }]
    if (sql.includes('FROM "application_task_events"') && sql.includes('"id" IN')) return [...protocolRows]
    if (sql.includes('FROM "application_task_events"')) return attemptEvents
    if (sql.includes('FROM "submission_attempt"')) return [submitAttempt]
    if (sql.includes('FROM "agent_approvals"')) return [approval]
    throw new Error(`Unexpected transaction query: ${sql}`)
  })
  const tx = { $queryRaw: raw, applicationTaskEvent: { create } } as unknown as Prisma.TransactionClient
  const input = { userId: identity.userId, sessionId: identity.sessionId, applicationTaskId: task.id,
    expectedAttemptTarget: createApplicationSubmissionStopTarget(attempt) }
  return { tx, input, attempt, protocolRows, create, raw, approval, materialHash, answersHash }
}

describe("private application submission Stop transaction", () => {
  beforeEach(() => vi.restoreAllMocks())

  it("creates an opaque target bound to the exact Worker execution", async () => {
    const f = await fixture()
    const target = createApplicationSubmissionStopTarget(f.attempt)
    expect(target).toMatch(/^ast1_[a-f0-9]{64}$/)
    expect(createApplicationSubmissionStopTarget({ ...f.attempt, executionId: "execution-2" })).not.toBe(target)
    expect(createApplicationSubmissionStopTarget({ ...f.attempt, workerTaskId: "worker-task-2" })).not.toBe(target)
  })

  it("writes one exact user Stop only for an armed-only attempt and reads it back", async () => {
    const f = await fixture()
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("stop_requested")
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      id: applicationSubmissionStopEventId({
        sessionId: identity.sessionId, fillTurnId: identity.fillTurnId, applicationTaskId: identity.applicationTaskId,
        userId: identity.userId, jobId: identity.jobId, approvalId: identity.approvalId, receiptId: identity.receiptId,
        constraintHash: f.attempt.constraintHash, workerTaskId: identity.workerTaskId,
      }, "stop_requested"), type: "submission_stop_protocol", actor: "user", body,
      data: expect.objectContaining({ stage: "stop_requested", executionId: identity.executionId }),
    }) })
  })

  it("accepts the exact v2 domain commitment after current application material drifts", async () => {
    const f = await fixture({ reviewed: true, drift: true })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("stop_requested")
    expect(f.approval.materialHash).toBe(f.materialHash)
    expect(f.materialHash).not.toBe(await hashAgentReceiptValue("material", {
      applicationTaskId: task.id, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: null,
    }))
    expect(f.approval.answersHash).toBe(f.answersHash)
    expect(f.create).toHaveBeenCalledTimes(1)
    const sql = f.raw.mock.calls.map(([query]) => query.sql).join("\n")
    expect(sql).not.toContain('"confirmedAnswers"')
    expect(sql).not.toContain('"resumeId"')
    expect(sql).not.toContain('"coverLetterId"')
    const approvalSql = f.raw.mock.calls.map(([query]) => query.sql).find(query => query.includes('FROM "agent_approvals"'))
    expect(approvalSql).toContain('"payload"->>\'applicationTaskId\'')
    expect(approvalSql).toContain('"payload"->>\'jobId\'')
    expect(approvalSql).not.toMatch(/,\s*"payload"(?:\s|,|$)/)
  })

  it("preserves a v1 consumed approval against its frozen material and answer hashes", async () => {
    const f = await fixture()
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("stop_requested")
    expect(f.approval.materialHash).toBe(f.materialHash)
    expect(f.approval.answersHash).toBe(f.answersHash)
  })

  it("allows a known active owning Turn with a valid lease", async () => {
    const f = await fixture({ turnStatus: "in_progress" })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("stop_requested")
  })

  it.each(["failed", "cancelled", "interrupted", "queued", "unknown"])("rejects unsupported Turn state %s without writing", async turnStatus => {
    const f = await fixture({ turnStatus })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_scope_invalid" })
    expect(f.create).not.toHaveBeenCalled()
  })

  it("rejects an active Turn without a normal live lease", async () => {
    const f = await fixture({ turnStatus: "in_progress", invalidLease: true })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_scope_invalid" })
    expect(f.create).not.toHaveBeenCalled()
  })

  it("rejects an active Turn when its owning session is not running", async () => {
    const f = await fixture({ turnStatus: "in_progress", sessionStatus: "paused" })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_scope_invalid" })
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each(["turn.interrupt.requested", "turn.interrupted", "turn.failed"] as const)("rejects %s evidence even when the Turn snapshot looks normal", async turnEvent => {
    const f = await fixture({ turnEvent })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_scope_invalid" })
    expect(f.create).not.toHaveBeenCalled()
  })

  it("rejects a consumed approval whose frozen scope no longer hashes to its receipt", async () => {
    const f = await fixture()
    f.approval.nonceHash = "e".repeat(64)
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_scope_invalid" })
    expect(f.create).not.toHaveBeenCalled()
  })

  it("replays a persisted Stop without writing a second event", async () => {
    const f = await fixture({ stages: ["armed", "stop_requested"] })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("stop_requested")
    expect(f.create).not.toHaveBeenCalled()
  })

  it("keeps a persisted Stop idempotent after a non-submitted execution settlement", async () => {
    const f = await fixture({ stages: ["armed", "stop_requested"], settled: true })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("stop_requested")
    expect(f.create).not.toHaveBeenCalled()
  })

  it("returns too_late for a grant and never recreates or reauthorizes dispatch", async () => {
    const f = await fixture({ stages: ["armed", "dispatch_granted"] })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("too_late")
    expect(f.create).not.toHaveBeenCalled()
  })

  it("returns submitted only with exact completed evidence and a dispatch grant", async () => {
    const f = await fixture({ stages: ["armed", "dispatch_granted"], submitted: true })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("submitted")
    expect(f.create).not.toHaveBeenCalled()
  })

  it("preserves uncertain state without writing a Stop", async () => {
    const f = await fixture({ uncertain: true })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).resolves.toBe("uncertain")
    expect(f.create).not.toHaveBeenCalled()
  })

  it("rejects a stale attempt target before writing", async () => {
    const f = await fixture()
    f.input.expectedAttemptTarget = createApplicationSubmissionStopTarget({ ...f.attempt, workerTaskId: "replacement-worker" })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_target_stale" })
    expect(f.create).not.toHaveBeenCalled()
  })

  it.each(["body", "actor", "payload"] as const)("fails closed for a malformed protocol %s", async malformed => {
    const f = await fixture({ malformed })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toBeInstanceOf(ApplicationSubmissionStopError)
    expect(f.create).not.toHaveBeenCalled()
  })

  it("rejects contradictory Stop and grant records", async () => {
    const f = await fixture({ stages: ["armed", "stop_requested", "dispatch_granted"] })
    await expect(requestApplicationSubmissionStopInTransaction(f.tx, f.input)).rejects.toMatchObject({ code: "stop_protocol_invalid" })
    expect(f.create).not.toHaveBeenCalled()
  })
})
