import { Prisma, type PrismaClient } from "@prisma/client"

import { verifyAndCancelSubmissionJob } from "@/lib/apply-queue-client"
import { AgentCommandError, invalidCommand, isUniqueViolation } from "./errors"
import { assertApplicationFillPreflight } from "./application-fill-preflight"
import { acceptInputFacts, createRootTurn, lockOpenSession, type CommandTransaction } from "./transaction"
import type { CommandIdentity, CommandResult } from "./types"

const TERMINAL_TURNS = new Set(["completed", "failed", "interrupted", "cancelled"])
const FILL_CONTENT = [{ type: "text" as const, text: "Fill the server-bound application form for user review. Never submit it." }]

export type ConfirmSubmissionRecoveryCommand = { sessionId: string; userId: string; applicationTaskId: string; requestId: string;
  confirmedNotReceived: true }

type RecoveryTask = {
  id: string; userId: string; sessionId: string | null; jobId: string; status: string; checkpoint: string | null
  fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; workerTaskId: string | null
}
type TurnFence = { id: string; status: string; leaseOwnerId: string | null; leaseExpiresAt: Date | null }
type FillerFence = { id: string; status: string; leaseOwner: string | null; leaseExpiresAt: Date | null; interruptRequestedAt: Date | null; role: string; taskType: string }
type TaskEvent = { id: string; data: unknown }
type ApprovalFence = { id: string; sessionId: string; userId: string; turnId: string | null; jobId: string | null; type: string; status: string; scopeHash: string | null; payload: unknown }
type JobFence = { id: string; status: string; workflowState: "queued" | "submitting" | "ready_to_apply"; appliedAt: Date | null }
type SubmissionAttemptFence = { userId: string; jobId: string; receiptId: string; constraintHash: string; state: string }

function conflict(message: string): never {
  throw new AgentCommandError("retry_target_invalid", message, 409)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0
}

function sameAttempt(task: RecoveryTask, candidate: RecoveryTask): boolean {
  return task.id === candidate.id && task.userId === candidate.userId && task.sessionId === candidate.sessionId
    && task.jobId === candidate.jobId && task.status === candidate.status && task.checkpoint === candidate.checkpoint
    && task.fillTurnId === candidate.fillTurnId && task.fillTurnSessionId === candidate.fillTurnSessionId
    && task.fillTurnUserId === candidate.fillTurnUserId && task.workerTaskId === candidate.workerTaskId
}

function validateCommand(command: ConfirmSubmissionRecoveryCommand): CommandIdentity {
  for (const [name, value] of Object.entries(command)) {
    if (name === "confirmedNotReceived") continue
    if (!nonEmpty(value) || value.length > 256) throw invalidCommand(`Submission recovery requires a valid ${name}`)
  }
  if (command.confirmedNotReceived !== true || !/^[A-Za-z0-9_-]{8,128}$/.test(command.requestId)) {
    throw invalidCommand("Submission recovery requires an explicit employer-site confirmation and request ID")
  }
  return { sessionId: command.sessionId, userId: command.userId, clientMessageId: recoveryMessageId(command), source: "user" }
}

function recoveryMessageId(command: ConfirmSubmissionRecoveryCommand): string {
  return `application-submit-recovery:${command.applicationTaskId}:${command.requestId}`
}

async function priorRecoveryResult(tx: CommandTransaction, command: ConfirmSubmissionRecoveryCommand): Promise<CommandResult | null> {
  const rows = await tx.$queryRaw<TaskEvent[]>(Prisma.sql`
    SELECT "id", "data" FROM "application_task_events"
    WHERE "taskId" = ${command.applicationTaskId} AND "type" = 'submission_not_received_confirmed'
      AND "actor" = 'user' AND "data"->>'userId' = ${command.userId}
      AND "data"->>'sessionId' = ${command.sessionId} AND "data"->>'requestId' = ${command.requestId}
    ORDER BY "createdAt", "id" FOR SHARE
  `)
  if (rows.length === 0) return null
  if (rows.length !== 1) conflict("Submission recovery has duplicate attestation evidence")
  const data = record(rows[0]?.data)
  const turnId = data?.newFillTurnId
  if (!nonEmpty(turnId) || data?.applicationTaskId !== command.applicationTaskId) conflict("Submission recovery evidence is incomplete")
  const turn = await tx.agentTurn.findFirst({ where: { id: turnId, sessionId: command.sessionId, userId: command.userId }, select: { id: true } })
  const input = await tx.agentInput.findFirst({
    where: { sessionId: command.sessionId, userId: command.userId, targetTurnId: turnId, clientMessageId: recoveryMessageId(command) },
    select: { id: true, acceptedSequence: true },
  })
  if (!turn || !input) conflict("The previously created recovery Turn is unavailable")
  return { inputId: input.id, turnId, disposition: "duplicate", originalDisposition: "started", sequence: input.acceptedSequence.toString() }
}

async function readTask(tx: CommandTransaction, command: ConfirmSubmissionRecoveryCommand, locked: boolean): Promise<RecoveryTask | undefined> {
  const lock = locked ? Prisma.sql`FOR UPDATE` : Prisma.empty
  const rows = await tx.$queryRaw<RecoveryTask[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "jobId", "status", "checkpoint", "fillTurnId",
      "fillTurnSessionId", "fillTurnUserId", "workerTaskId"
    FROM "application_tasks"
    WHERE "id" = ${command.applicationTaskId} AND "userId" = ${command.userId} AND "sessionId" = ${command.sessionId}
    ${lock}
  `)
  return rows[0]
}

async function assertOldAttemptFenced(tx: CommandTransaction, task: RecoveryTask, identity: CommandIdentity): Promise<void> {
  // Match the Worker fence: session → Turn → filler → ApplicationTask → Job → attempt → approval.
  const turns = await tx.$queryRaw<TurnFence[]>(Prisma.sql`
    SELECT "id", "status", "leaseOwnerId", "leaseExpiresAt" FROM "agent_turns"
    WHERE "id" = ${task.fillTurnId} AND "sessionId" = ${identity.sessionId} AND "userId" = ${identity.userId}
    FOR UPDATE
  `)
  const turn = turns[0]
  if (!turn || !TERMINAL_TURNS.has(turn.status) || turn.leaseOwnerId !== null || turn.leaseExpiresAt !== null) {
    conflict("The prior fill Turn must be terminal and have no live execution lease")
  }
  const fillers = await tx.$queryRaw<FillerFence[]>(Prisma.sql`
    SELECT task."id", task."status", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt", task."role", task."taskType"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = ${identity.userId}
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = ${identity.userId}
    WHERE task."sessionId" = ${identity.sessionId} AND task."turnId" = ${task.fillTurnId}
      AND task."role" = 'application_filler' AND task."taskType" = 'application_fill_for_review'
    FOR UPDATE OF task
  `)
  if (fillers.length !== 1 || fillers[0]?.status !== "completed" || fillers[0]?.leaseOwner !== null
    || fillers[0]?.leaseExpiresAt !== null || fillers[0]?.interruptRequestedAt !== null) {
    conflict("The exact application filler must be terminal with no active lease or interrupt")
  }
}

async function resolveSubmission(tx: CommandTransaction, task: RecoveryTask, identity: CommandIdentity): Promise<{ workerTaskId: string; receiptId: string; constraintHash: string }> {
  if (!nonEmpty(task.workerTaskId)) conflict("The uncertain submission has no current Worker task binding")
  const rows = await tx.$queryRaw<TaskEvent[]>(Prisma.sql`
    SELECT "id", "data" FROM "application_task_events"
    WHERE "taskId" = ${task.id} AND "type" = 'submission_queued' AND "actor" = 'user'
      AND "data"->>'applicationTaskId' = ${task.id} AND "data"->>'userId' = ${identity.userId}
      AND "data"->>'jobId' = ${task.jobId} AND "data"->>'sessionId' = ${identity.sessionId}
      AND "data"->>'fillTurnId' = ${task.fillTurnId}
    ORDER BY "createdAt", "id" FOR SHARE
  `)
  if (rows.length !== 1) conflict("The exact submit queue event is missing or ambiguous")
  const eventData = record(rows[0]?.data)
  const receiptId = eventData?.receiptId ?? eventData?.approvalId
  const constraintHash = eventData?.constraintHash
  if (!eventData || eventData.workerTaskId !== task.workerTaskId || !nonEmpty(receiptId) || !nonEmpty(constraintHash)
    || (nonEmpty(eventData.receiptId) && nonEmpty(eventData.approvalId) && eventData.receiptId !== eventData.approvalId)) {
    conflict("The exact submit queue event conflicts with the current attempt")
  }
  const execution = await tx.$queryRaw<{ safe: boolean }[]>(Prisma.sql`SELECT COUNT(*) = 0 OR (COUNT(*) = 2 AND COUNT(*) FILTER (WHERE "type" = 'submission_execution_started') = 1 AND COUNT(*) FILTER (WHERE "type" = 'submission_execution_settled') = 1 AND COUNT(DISTINCT "data"->>'executionId') = 1 AND COUNT(*) FILTER (WHERE "actor" = 'worker' AND "data"->>'applicationTaskId' = ${task.id} AND "data"->>'userId' = ${identity.userId} AND "data"->>'jobId' = ${task.jobId} AND "data"->>'sessionId' = ${identity.sessionId} AND "data"->>'fillTurnId' = ${task.fillTurnId} AND "data"->>'workerTaskId' = ${task.workerTaskId} AND "data"->>'approvalId' = ${receiptId} AND "data"->>'constraintHash' = ${constraintHash} AND "data"->>'executionId' <> '') = 2) AS safe FROM "application_task_events" WHERE "taskId" = ${task.id} AND "type" IN ('submission_execution_started', 'submission_execution_settled') AND ("data"->>'fillTurnId' = ${task.fillTurnId} OR "data"->>'workerTaskId' = ${task.workerTaskId})`)
  if (execution[0]?.safe !== true) conflict("The prior Worker browser execution is not durably settled")
  const attempts = await tx.$queryRaw<SubmissionAttemptFence[]>(Prisma.sql`SELECT "userId", "jobId", "receiptId", "constraintHash", "state" FROM "submission_attempt" WHERE "receiptId" = ${receiptId} FOR UPDATE`)
  const attempt = attempts[0]
  if (attempts.length !== 1 || attempt?.userId !== identity.userId || attempt?.jobId !== task.jobId
    || attempt?.receiptId !== receiptId || attempt?.constraintHash !== constraintHash
    || !["reserved", "failed"].includes(attempt?.state ?? "")) conflict("The durable submission attempt is missing, mismatched, or not safely recoverable")
  const approvals = await tx.$queryRaw<ApprovalFence[]>(Prisma.sql`
    SELECT "id", "sessionId", "userId", "turnId", "jobId", "type", "status", "scopeHash", "payload"
    FROM "agent_approvals"
    WHERE "id" = ${receiptId} AND "sessionId" = ${identity.sessionId} AND "userId" = ${identity.userId}
      AND "turnId" = ${task.fillTurnId} AND "jobId" = ${task.jobId} AND "type" = 'submit_application'
      AND "scopeHash" = ${constraintHash} AND "status" IN ('approved', 'consumed')
    FOR UPDATE
  `)
  const approval = approvals[0]
  const payload = record(approval?.payload)
  if (approvals.length !== 1 || approval?.id !== receiptId || approval?.sessionId !== identity.sessionId || approval?.userId !== identity.userId
    || approval?.turnId !== task.fillTurnId || approval?.jobId !== task.jobId || approval?.type !== "submit_application"
    || !["approved", "consumed"].includes(approval?.status ?? "") || approval?.scopeHash !== constraintHash
    || payload?.applicationTaskId !== task.id || payload?.jobId !== task.jobId) {
    conflict("The original submission approval no longer matches its immutable attempt")
  }
  return { workerTaskId: task.workerTaskId!, receiptId, constraintHash }
}
async function lockUnsubmittedJob(tx: CommandTransaction, task: RecoveryTask, identity: CommandIdentity): Promise<void> {
  const rows = await tx.$queryRaw<JobFence[]>(Prisma.sql`
    SELECT "id", "status", "workflowState", "appliedAt" FROM "Job"
    WHERE "id" = ${task.jobId} AND "userId" = ${identity.userId}
    FOR UPDATE
  `)
  const job = rows[0]
  if (!job || job.status !== "saved" || job.appliedAt !== null
    || !["queued", "submitting", "ready_to_apply"].includes(job.workflowState)) {
    conflict("The employer application may already be submitted or the Job state is not recoverable")
  }
  if (job.workflowState !== "ready_to_apply") {
    const reset = await tx.job.updateMany({
      where: { id: task.jobId, userId: identity.userId, status: "saved", workflowState: job.workflowState, appliedAt: null },
      data: { workflowState: "ready_to_apply", analysisNote: "[Autopilot needs review] Previous submission outcome is uncertain; confirm the employer result before any new submission." },
    })
    if (reset.count !== 1) conflict("The unsubmitted Job changed while recovery was being prepared")
  }
}

export async function confirmSubmissionNotReceived(db: PrismaClient, command: ConfirmSubmissionRecoveryCommand): Promise<CommandResult> {
  const identity = validateCommand(command)
  try {
    return await db.$transaction(async tx => {
      await lockOpenSession(tx, identity.sessionId, identity.userId)
      const duplicate = await priorRecoveryResult(tx, command)
      if (duplicate) return duplicate
      const candidate = await readTask(tx, command, false)
      if (!candidate) throw new AgentCommandError("agent_session_not_found", "Application task not found", 404)
      if (candidate.status !== "waiting_for_user" || candidate.checkpoint !== "submission_uncertain"
        || !candidate.fillTurnId || candidate.fillTurnSessionId !== identity.sessionId || candidate.fillTurnUserId !== identity.userId) {
        conflict("Only the current canonical uncertain submission can be recovered")
      }
      await assertOldAttemptFenced(tx, candidate, identity)
      const task = await readTask(tx, command, true)
      if (!task || !sameAttempt(task, candidate)) conflict("The application attempt changed while recovery was being prepared")
      await lockUnsubmittedJob(tx, task, identity)
      await assertApplicationFillPreflight(tx, task.id, identity)
      const submission = await resolveSubmission(tx, task, identity)
      const active = await tx.agentTurn.findFirst({
        where: { sessionId: identity.sessionId, userId: identity.userId, status: { in: ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] } },
        select: { id: true },
      })
      if (active) throw new AgentCommandError("retry_active_conflict", "Finish or stop the active Turn before recovering this application", 409, { turnId: active.id })
      const turn = await createRootTurn(tx, identity, FILL_CONTENT)
      const accepted = await acceptInputFacts(tx, identity, FILL_CONTENT, turn, "follow_up", "started", true)
      const updated = await tx.applicationTask.updateMany({
        where: { id: task.id, userId: identity.userId, sessionId: identity.sessionId, jobId: task.jobId,
          status: "waiting_for_user", checkpoint: "submission_uncertain", fillTurnId: task.fillTurnId,
          fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId, workerTaskId: task.workerTaskId },
        data: { fillTurnId: turn.id, fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId,
          workerTaskId: null, status: "filling", checkpoint: "taskgraph_fill_queued", error: null, completedAt: null, startedAt: new Date() },
      })
      if (updated.count !== 1) throw new AgentCommandError("retry_active_conflict", "Application recovery was claimed by another request", 409)
      await tx.applicationTaskEvent.create({
        data: { taskId: task.id, type: "submission_not_received_confirmed", actor: "user",
          body: "Candidate confirmed after checking the employer site that no application was present; this is a user attestation, not provider proof.",
          createdAt: new Date(), data: { applicationTaskId: task.id, userId: identity.userId, jobId: task.jobId,
            sessionId: identity.sessionId, oldFillTurnId: task.fillTurnId, approvalId: submission.receiptId,
            receiptId: submission.receiptId, constraintHash: submission.constraintHash, workerTaskId: submission.workerTaskId,
            requestId: command.requestId, confirmedNotReceived: true, newFillTurnId: turn.id },
        },
      })
      const session = await tx.agentSession.updateMany({
        where: { id: identity.sessionId, userId: identity.userId, status: "waiting_for_user" },
        data: { status: "running", completedAt: null },
      })
      if (session.count !== 1) throw new AgentCommandError("retry_active_conflict", "The Agent session is no longer waiting for submission recovery", 409)
      // DB changes stay uncommitted until exact queue cancellation and lock verification succeed.
      const verified = await verifyAndCancelSubmissionJob({
        workerTaskId: submission.workerTaskId,
        expected: { applicationTaskId: task.id, userId: identity.userId, jobId: task.jobId,
          sessionId: identity.sessionId, fillTurnId: task.fillTurnId!, receiptId: submission.receiptId, constraintHash: submission.constraintHash },
        withExactAttemptFence: removePendingJob => removePendingJob(),
      })
      if (!verified) conflict("The prior submit job or Redis lock is not safely terminal")
      return { ...accepted, disposition: "started" }
    })
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error
    return db.$transaction(async tx => {
      await lockOpenSession(tx, identity.sessionId, identity.userId)
      const duplicate = await priorRecoveryResult(tx, command)
      if (duplicate) return duplicate
      throw new AgentCommandError("retry_active_conflict", "Application recovery conflicted with another attempt", 409)
    })
  }
}
