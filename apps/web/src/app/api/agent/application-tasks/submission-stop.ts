import { createHash, timingSafeEqual } from "node:crypto"

import { Prisma } from "@prisma/client"
import { hashApprovalScope } from "@jobcopilot/agent-protocol"
import { APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, applicationSubmissionStopEventId, matchesExactApplicationSubmissionStopAttempt, parseApplicationSubmissionStopRecord, type ApplicationSubmissionStopAttempt, type ApplicationSubmissionStopEventKey, type ApplicationSubmissionStopStage } from "@jobcopilot/shared/application-submission-stop-protocol"
import { protocolScope } from "@/lib/agent/approval/types"
import { evaluateApplicationSubmissionEvidence, type SubmissionEvidenceEventType } from "@/lib/agent/application-submission-evidence"
import { lockOpenSession } from "@/lib/agent/control-plane/commands/transaction"
const STOP_EVENT_TYPE = "submission_stop_protocol"
const STOP_EVENT_BODY = "Application submission Stop protocol state recorded."
const ATTEMPT_EVENTS: readonly SubmissionEvidenceEventType[] = ["submission_queued", "submission_execution_started", "submission_execution_settled", "submission_evidence_recorded"]
const ATTEMPT_EVENT_KEYS = ["applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "receiptId", "constraintHash", "workerTaskId"]
const START_EVENT_KEYS = ["executionId", "workerTaskId", "applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "constraintHash"]

export type ApplicationSubmissionStopOutcome = "stop_requested" | "too_late" | "submitted" | "uncertain"
export type ApplicationSubmissionStopInput = Readonly<{ userId: string; sessionId: string; applicationTaskId: string; expectedAttemptTarget: string }>
export class ApplicationSubmissionStopError extends Error { constructor(readonly code: "stop_scope_invalid" | "stop_target_stale" | "stop_protocol_invalid", message: string) { super(message); this.name = "ApplicationSubmissionStopError" } }
type TaskRow = {
  id: string; userId: string; sessionId: string | null; jobId: string; status: string; checkpoint: string | null
  fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; workerTaskId: string | null
}
type EventRow = { id: string; taskId: string; type: string; actor: string; data: unknown }
type AttemptRow = { id: string; userId: string; jobId: string; receiptId: string; constraintHash: string; artifactHash: string; state: string; responseRef: string | null }
type ApprovalRow = {
  id: string; userId: string; sessionId: string; taskId: string | null; turnId: string | null; jobId: string | null
  toolCallId: string | null; type: string; status: string; scopeHash: string | null; resourceHash: string | null
  materialHash: string | null; answersHash: string | null; nonceHash: string | null; revision: number
  expiresAt: Date | null; decidedAt: Date | null; consumedAt: Date | null
  payloadApplicationTaskId: string | null; payloadJobId: string | null
}
type ProtocolEventRow = EventRow & { body: string }; type TurnRow = { id: string; status: string; leaseOwnerId: string | null; leaseStartedAt: Date | null; leaseExpiresAt: Date | null; leaseVersion: number }
function fail(code: ConstructorParameters<typeof ApplicationSubmissionStopError>[0], message: string): never { throw new ApplicationSubmissionStopError(code, message) }
function record(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null }
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.trim() === value }
function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function validHash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function normalTurn(turn: TurnRow, sessionStatus: string): boolean {
  if (!Number.isSafeInteger(turn.leaseVersion) || turn.leaseVersion < 0) return false
  if (turn.status === "completed") return turn.leaseOwnerId === null && turn.leaseStartedAt === null && turn.leaseExpiresAt === null
  const now = Date.now(), started = turn.leaseStartedAt?.getTime(), expires = turn.leaseExpiresAt?.getTime()
  return turn.status === "in_progress" && sessionStatus === "running" && nonEmpty(turn.leaseOwnerId) && turn.leaseVersion > 0
    && started !== undefined && expires !== undefined && Number.isFinite(started) && Number.isFinite(expires) && started <= now && expires > now
}
function stopEventKey(attempt: ApplicationSubmissionStopAttempt): ApplicationSubmissionStopEventKey {
  return { sessionId: attempt.sessionId, fillTurnId: attempt.fillTurnId, applicationTaskId: attempt.applicationTaskId,
    userId: attempt.userId, jobId: attempt.jobId, approvalId: attempt.approvalId, receiptId: attempt.receiptId,
    constraintHash: attempt.constraintHash, workerTaskId: attempt.workerTaskId }
}
function validAttempt(attempt: ApplicationSubmissionStopAttempt): boolean {
  return [attempt.sessionId, attempt.fillTurnId, attempt.applicationTaskId, attempt.userId, attempt.jobId, attempt.approvalId, attempt.receiptId, attempt.workerTaskId, attempt.executionId].every(nonEmpty)
    && attempt.approvalId === attempt.receiptId && validHash(attempt.constraintHash)
}
/** Stable optimistic-concurrency token for an exact attempt; it is not authorization. */
export function createApplicationSubmissionStopTarget(attempt: ApplicationSubmissionStopAttempt): string {
  if (!validAttempt(attempt)) fail("stop_scope_invalid", "The submission attempt identity is incomplete.")
  const armedEventId = applicationSubmissionStopEventId(stopEventKey(attempt), "armed")
  const digest = createHash("sha256").update(JSON.stringify(["agent-harness.v2.application-submission-stop-target.v1", armedEventId, attempt.executionId])).digest("hex")
  return `ast1_${digest}`
}
function targetMatches(target: unknown, attempt: ApplicationSubmissionStopAttempt): boolean {
  if (typeof target !== "string" || !/^ast1_[a-f0-9]{64}$/.test(target)) return false
  const expected = createApplicationSubmissionStopTarget(attempt)
  return timingSafeEqual(Buffer.from(target), Buffer.from(expected))
}
async function readTask(tx: Prisma.TransactionClient, input: ApplicationSubmissionStopInput, lock: boolean): Promise<TaskRow | null> {
  const suffix = lock ? Prisma.sql`FOR UPDATE` : Prisma.empty
  const rows = await tx.$queryRaw<TaskRow[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "jobId", "status", "checkpoint", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "workerTaskId"
    FROM "application_tasks" WHERE "id" = ${input.applicationTaskId} AND "userId" = ${input.userId}
      AND "sessionId" = ${input.sessionId} ${suffix}
  `)
  return rows.length === 1 ? rows[0]! : null
}
async function readProtocolEvents(tx: Prisma.TransactionClient, taskId: string, attempt: ApplicationSubmissionStopAttempt): Promise<Partial<Record<ApplicationSubmissionStopStage, ProtocolEventRow>>> {
  const ids = new Map<ApplicationSubmissionStopStage, string>((["armed", "stop_requested", "dispatch_granted"] as const).map(stage => [stage, applicationSubmissionStopEventId(stopEventKey(attempt), stage)]))
  const rows = await tx.$queryRaw<ProtocolEventRow[]>(Prisma.sql`
    SELECT "id", "taskId", "type", "actor", "body", "data" FROM "application_task_events"
    WHERE "taskId" = ${taskId} AND "id" IN (${Prisma.join([...ids.values()])}) FOR UPDATE
  `)
  if (rows.length > ids.size) fail("stop_protocol_invalid", "The submission Stop protocol records are ambiguous.")
  const found: Partial<Record<ApplicationSubmissionStopStage, ProtocolEventRow>> = {}
  for (const row of rows) {
    const stage = [...ids].find(([, id]) => id === row.id)?.[0]
    const expectedActor = stage === "stop_requested" ? "user" : "worker"
    const parsed = parseApplicationSubmissionStopRecord(row.data)
    if (!stage || found[stage] || row.taskId !== taskId || row.type !== STOP_EVENT_TYPE || row.actor !== expectedActor
      || row.body !== STOP_EVENT_BODY
      || !parsed || parsed.stage !== stage || !matchesExactApplicationSubmissionStopAttempt(row.data, attempt)) {
      fail("stop_protocol_invalid", "The submission Stop protocol records do not match the current attempt.")
    }
    found[stage] = row
  }
  return found
}
/** Uses the caller's authenticated, RLS-scoped transaction and leaves commit/rollback to its owner. */
export async function requestApplicationSubmissionStopInTransaction(
  tx: Prisma.TransactionClient, input: ApplicationSubmissionStopInput,
): Promise<ApplicationSubmissionStopOutcome> {
  if (![input.userId, input.sessionId, input.applicationTaskId].every(nonEmpty)) fail("stop_scope_invalid", "The submission Stop scope is incomplete.")
  const candidate = await readTask(tx, input, false)
  if (!candidate?.fillTurnId || candidate.sessionId !== input.sessionId || candidate.fillTurnSessionId !== input.sessionId
    || candidate.fillTurnUserId !== input.userId || !candidate.workerTaskId) {
    fail("stop_scope_invalid", "The application has no current owned submission attempt.")
  }
  await lockOpenSession(tx, input.sessionId, input.userId)
  const sessions = await tx.$queryRaw<Array<{ status: string }>>(Prisma.sql`
    SELECT "status" FROM "agent_sessions" WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
  `)
  const sessionStatus = sessions[0]?.status
  if (sessions.length !== 1 || !sessionStatus || !["idle", "running", "pausing", "resuming", "waiting_for_user", "paused", "completed"].includes(sessionStatus)) {
    fail("stop_scope_invalid", "The owning session is not in a supported state.")
  }
  const turns = await tx.$queryRaw<TurnRow[]>(Prisma.sql`
    SELECT "id", "status", "leaseOwnerId", "leaseStartedAt", "leaseExpiresAt", "leaseVersion" FROM "agent_turns"
    WHERE "id" = ${candidate.fillTurnId} AND "sessionId" = ${input.sessionId} AND "userId" = ${input.userId} FOR UPDATE
  `)
  const turn = turns[0]
  if (turns.length !== 1 || !turn || !normalTurn(turn, sessionStatus)) fail("stop_scope_invalid", "The Fill Turn state or lease is not supported.")
  const interrupted = await tx.$queryRaw<Array<{ stopped: boolean }>>(Prisma.sql`
    SELECT EXISTS (SELECT 1 FROM "agent_events" WHERE "sessionId" = ${input.sessionId}
      AND "turnId" = ${candidate.fillTurnId} AND "type" IN ('turn.interrupt.requested', 'turn.interrupted', 'turn.failed')) AS "stopped"
  `)
  if (interrupted[0]?.stopped !== false) fail("stop_scope_invalid", "The Fill Turn has interruption evidence.")
  const fillers = await tx.$queryRaw<Array<{ id: string; status: string; leaseOwner: string | null; leaseExpiresAt: Date | null; interruptRequestedAt: Date | null; role: string; taskType: string }>>(Prisma.sql`
    SELECT filler."id", filler."status", filler."leaseOwner", filler."leaseExpiresAt", filler."interruptRequestedAt", filler."role", filler."taskType"
    FROM "sub_agent_tasks" AS filler JOIN "agent_turns" AS turn ON turn."id" = filler."turnId"
      AND turn."sessionId" = filler."sessionId" AND turn."userId" = ${input.userId}
    WHERE filler."sessionId" = ${input.sessionId} AND filler."turnId" = ${candidate.fillTurnId}
      AND filler."role" = 'application_filler' AND filler."taskType" = 'application_fill_for_review'
    ORDER BY filler."id" FOR UPDATE OF filler
  `)
  const filler = fillers[0]
  if (fillers.length !== 1 || filler?.status !== "completed" || filler.leaseOwner !== null
    || filler.leaseExpiresAt !== null || filler.interruptRequestedAt !== null) {
    fail("stop_scope_invalid", "The exact application filler is not completed and lease-free.")
  }
  const task = await readTask(tx, input, true)
  if (!task || task.jobId !== candidate.jobId || task.fillTurnId !== candidate.fillTurnId
    || task.workerTaskId !== candidate.workerTaskId || task.fillTurnSessionId !== input.sessionId || task.fillTurnUserId !== input.userId) {
    fail("stop_target_stale", "The application submission attempt changed.")
  }
  const jobs = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Job" WHERE "id" = ${task.jobId} AND "userId" = ${input.userId} FOR UPDATE
  `)
  if (jobs.length !== 1) fail("stop_scope_invalid", "The application Job is not owned by this user.")
  const attemptEvents = await tx.$queryRaw<EventRow[]>(Prisma.sql`
    SELECT "id", "taskId", "type", "actor", "data" FROM "application_task_events"
    WHERE "taskId" = ${task.id} AND "type" IN (${Prisma.join(ATTEMPT_EVENTS)})
      AND "data"->>'workerTaskId' = ${task.workerTaskId} ORDER BY "id" LIMIT 34 FOR SHARE
  `)
  if (attemptEvents.length > 33) fail("stop_protocol_invalid", "The current submit attempt has too many history records.")
  const queued = attemptEvents.filter(event => event.type === "submission_queued")
  if (queued.length !== 1 || queued[0]!.actor !== "user") fail("stop_scope_invalid", "The exact submit receipt is missing or ambiguous.")
  const queue = record(queued[0]!.data)
  if (!queue || !hasExactKeys(queue, ATTEMPT_EVENT_KEYS) || queue.applicationTaskId !== task.id || queue.userId !== input.userId
    || queue.jobId !== task.jobId || queue.sessionId !== input.sessionId || queue.fillTurnId !== task.fillTurnId
    || queue.workerTaskId !== task.workerTaskId || !nonEmpty(queue.approvalId) || queue.approvalId !== queue.receiptId
    || !validHash(queue.constraintHash)) fail("stop_scope_invalid", "The submit receipt conflicts with the current attempt.")
  const attemptRows = await tx.$queryRaw<AttemptRow[]>(Prisma.sql`
    SELECT "id", "userId", "jobId", "receiptId", "constraintHash", "artifactHash", "state", "responseRef"
    FROM "submission_attempt" WHERE "receiptId" = ${queue.receiptId} AND "userId" = ${input.userId}
      AND "jobId" = ${task.jobId} AND "constraintHash" = ${queue.constraintHash} FOR UPDATE
  `)
  const submitAttempt = attemptRows[0]
  if (attemptRows.length !== 1 || submitAttempt?.userId !== input.userId || submitAttempt?.jobId !== task.jobId
    || submitAttempt?.receiptId !== queue.receiptId || submitAttempt?.constraintHash !== queue.constraintHash
    || !validHash(submitAttempt?.artifactHash)) fail("stop_scope_invalid", "The reserved submission attempt is missing or mismatched.")
  const approvals = await tx.$queryRaw<ApprovalRow[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "taskId", "turnId", "jobId", "toolCallId", "type", "status", "scopeHash",
      "resourceHash", "materialHash", "answersHash", "nonceHash", "revision", "expiresAt", "decidedAt", "consumedAt",
      "payload"->>'applicationTaskId' AS "payloadApplicationTaskId", "payload"->>'jobId' AS "payloadJobId"
    FROM "agent_approvals" WHERE "id" = ${queue.approvalId} AND "userId" = ${input.userId}
      AND "sessionId" = ${input.sessionId} FOR UPDATE
  `)
  const approval = approvals[0]
  if (approvals.length !== 1 || approval?.id !== queue.approvalId || approval.taskId !== task.id || approval.turnId !== task.fillTurnId
    || approval.jobId !== task.jobId || approval.toolCallId !== `application-submit:${task.id}` || approval.type !== "submit_application"
    || approval.status !== "consumed" || !approval.consumedAt || !approval.decidedAt || !approval.expiresAt
    || approval.decidedAt > approval.consumedAt || approval.consumedAt > approval.expiresAt
    || approval.scopeHash !== queue.constraintHash || approval.resourceHash !== submitAttempt.artifactHash
    || !validHash(approval.materialHash) || !validHash(approval.answersHash) || !validHash(approval.nonceHash)
    || !Number.isSafeInteger(approval.revision) || approval.revision < 0
    || approval.payloadApplicationTaskId !== task.id || approval.payloadJobId !== task.jobId) {
    fail("stop_scope_invalid", "The consumed submit approval no longer matches its reserved scope.")
  }
  const approvalScope = protocolScope({ userId: approval.userId, sessionId: approval.sessionId, turnId: approval.turnId!, jobId: approval.jobId!,
    toolCallId: approval.toolCallId!, action: "submit_application", resourceHash: approval.resourceHash!, materialHash: approval.materialHash!,
    answersHash: approval.answersHash!, revision: approval.revision, expiresAt: approval.expiresAt }, approval.nonceHash!)
  if (await hashApprovalScope(approvalScope) !== approval.scopeHash) fail("stop_scope_invalid", "The consumed approval hash is invalid.")
  const starts = attemptEvents.filter(event => event.type === "submission_execution_started")
  if (starts.length !== 1 || starts[0]!.actor !== "worker") fail("stop_scope_invalid", "The exact Worker execution marker is missing or ambiguous.")
  const start = record(starts[0]!.data)
  if (!start || starts[0]!.id !== `evt_${start.executionId}` || !hasExactKeys(start, START_EVENT_KEYS) || !nonEmpty(start.executionId)
    || start.workerTaskId !== task.workerTaskId || start.applicationTaskId !== task.id || start.userId !== input.userId
    || start.jobId !== task.jobId || start.sessionId !== input.sessionId || start.fillTurnId !== task.fillTurnId
    || start.approvalId !== queue.approvalId || start.constraintHash !== queue.constraintHash) {
    fail("stop_scope_invalid", "The Worker execution marker conflicts with the current attempt.")
  }
  const attempt: ApplicationSubmissionStopAttempt = {
    sessionId: input.sessionId, fillTurnId: task.fillTurnId!, applicationTaskId: task.id, userId: input.userId,
    jobId: task.jobId, approvalId: queue.approvalId as string, receiptId: queue.receiptId as string,
    constraintHash: queue.constraintHash, workerTaskId: task.workerTaskId!, executionId: start.executionId,
  }
  if (!validAttempt(attempt)) fail("stop_scope_invalid", "The exact submission attempt is invalid.")
  if (!targetMatches(input.expectedAttemptTarget, attempt)) fail("stop_target_stale", "The expected submission attempt has changed.")
  const stages = await readProtocolEvents(tx, task.id, attempt)
  if (!stages.armed || (stages.stop_requested && stages.dispatch_granted)) {
    fail("stop_protocol_invalid", "The exact armed Stop protocol state is missing or contradictory.")
  }
  if (task.status === "submitted" || task.checkpoint === "submission_verified" || submitAttempt.state === "submitted") {
    if (!stages.dispatch_granted || stages.stop_requested) fail("stop_protocol_invalid", "The completed submission conflicts with its Stop protocol state.")
    const evidence = evaluateApplicationSubmissionEvidence({
      task: { id: task.id, userId: input.userId, jobId: task.jobId, sessionId: input.sessionId, fillTurnId: task.fillTurnId,
        fillTurnSessionId: task.fillTurnSessionId, fillTurnUserId: task.fillTurnUserId, workerTaskId: task.workerTaskId,
        status: task.status, checkpoint: task.checkpoint },
      events: attemptEvents.map(event => ({ id: event.id, type: event.type as SubmissionEvidenceEventType, actor: event.actor, data: event.data })),
      approvals: [{ id: approval.id, userId: approval.userId, sessionId: approval.sessionId, taskId: approval.taskId, turnId: approval.turnId,
        jobId: approval.jobId, toolCallId: approval.toolCallId, type: approval.type, status: approval.status,
        scopeHash: approval.scopeHash, resourceHash: approval.resourceHash }],
    })
    const evidenceData = record(attemptEvents.find(event => event.type === "submission_evidence_recorded")?.data)
    return task.status === "submitted" && task.checkpoint === "submission_verified" && submitAttempt.state === "submitted"
      && nonEmpty(submitAttempt.responseRef) && evidence.workerReport === "submitted" && evidenceData?.attemptId === submitAttempt.id ? "submitted" : "uncertain"
  }
  if (stages.stop_requested) {
    if (attemptEvents.some(event => event.type === "submission_evidence_recorded")) {
      fail("stop_protocol_invalid", "The stopped submission also has terminal execution evidence.")
    }
    return "stop_requested"
  }
  if (stages.dispatch_granted) return "too_late"
  if (task.status !== "filling" || task.checkpoint !== "submission_request_started" || submitAttempt.state !== "reserved"
    || attemptEvents.some(event => event.type === "submission_execution_settled" || event.type === "submission_evidence_recorded")) {
    return "uncertain"
  }
  const stopId = applicationSubmissionStopEventId(stopEventKey(attempt), "stop_requested")
  await tx.applicationTaskEvent.create({
    data: { id: stopId, taskId: task.id, type: STOP_EVENT_TYPE, actor: "user", body: STOP_EVENT_BODY,
      data: { schemaVersion: APPLICATION_SUBMISSION_STOP_PROTOCOL_SCHEMA, stage: "stop_requested", ...attempt } as Prisma.InputJsonObject },
  })
  const afterWrite = await readProtocolEvents(tx, task.id, attempt)
  if (!afterWrite.armed || !afterWrite.stop_requested || afterWrite.dispatch_granted) {
    fail("stop_protocol_invalid", "The Stop request could not be read back exactly.")
  }
  return "stop_requested"
}
