import { Prisma, type PrismaClient } from "@prisma/client"

import { interruptActiveTurn } from "./execution-cancellation"
import { AgentCommandError, invalidCommand, isUniqueViolation } from "./errors"
import { assertApplicationFillPreflight } from "./application-fill-preflight"
import { acceptInputFacts, createRootTurn, findActiveTurn, findExistingCommand, lockOpenSession, type CommandTransaction } from "./transaction"
import type { CommandIdentity, CommandResult, InterruptCommand } from "./types"

const TERMINAL_TURNS = ["completed", "failed", "interrupted", "cancelled"]
const RETRY_CHECKPOINTS = ["fill_prestart_failed", "taskgraph_fill_failed"]
const START_CHECKPOINTS = ["materials_ready"]
const CONTENT = [{ type: "text" as const, text: "Fill the server-bound application form for user review. Never submit it." }]

async function existingFillResult(tx: CommandTransaction, turnId: string, identity: CommandIdentity): Promise<CommandResult> {
  const turn = await tx.agentTurn.findFirst({
    where: { id: turnId, sessionId: identity.sessionId, userId: identity.userId }, select: { id: true },
  })
  if (!turn) throw new AgentCommandError("retry_target_invalid", "The bound application fill Turn is unavailable", 409)
  const input = await tx.agentInput.findFirst({
    where: { sessionId: identity.sessionId, userId: identity.userId, targetTurnId: turnId },
    orderBy: { createdAt: "asc" }, select: { id: true, acceptedSequence: true },
  })
  if (!input) throw new AgentCommandError("retry_target_invalid", "The bound application fill command is unavailable", 409)
  return { inputId: input.id, turnId, disposition: "duplicate", originalDisposition: "started", sequence: input.acceptedSequence.toString() }
}

type FillCommand = {
  sessionId: string
  userId: string
  clientMessageId: string
  applicationTaskId: string
  retry?: boolean
  resumeAfterUserInput?: boolean
}

export async function startApplicationFillForReview(db: PrismaClient, command: FillCommand): Promise<CommandResult> {
  for (const [name, value] of Object.entries(command)) {
    if (name === "retry" || name === "resumeAfterUserInput") continue
    if (typeof value !== "string" || !value.trim() || value.length > 256) throw invalidCommand(`Application fill requires a valid ${name}`)
  }
  if ((command.retry !== undefined && typeof command.retry !== "boolean") || (command.resumeAfterUserInput !== undefined && typeof command.resumeAfterUserInput !== "boolean")
    || (command.retry && command.resumeAfterUserInput)) throw invalidCommand("Application fill retry and user-input resume are separate actions")
  const identity: CommandIdentity = { sessionId: command.sessionId, userId: command.userId, clientMessageId: command.clientMessageId, source: "user" }
  try {
    return await db.$transaction(async (tx) => {
      await lockOpenSession(tx, identity.sessionId, identity.userId)
      if (!command.resumeAfterUserInput) {
        const existing = await findExistingCommand(tx, identity.sessionId, identity.clientMessageId)
        if (existing) {
          if (!existing.targetTurnId) throw new AgentCommandError("turn_not_active", "Duplicate application fill has no target Turn", 409)
          return { inputId: existing.id, turnId: existing.targetTurnId, disposition: "duplicate", originalDisposition: "started", sequence: existing.acceptedSequence.toString() }
        }
      }

      const rows = await tx.$queryRaw<Array<{ id: string; status: string; checkpoint: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; confirmedAnswers?: unknown }>>(Prisma.sql`
        SELECT "id", "status", "checkpoint", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "confirmedAnswers"
        FROM "application_tasks"
        WHERE "id" = ${command.applicationTaskId} AND "userId" = ${identity.userId} AND "sessionId" = ${identity.sessionId}
        FOR UPDATE
      `)
      const task = rows[0]
      if (!task) throw new AgentCommandError("agent_session_not_found", "Application task not found", 404)
      if (command.resumeAfterUserInput) {
        if (task.fillTurnId && task.fillTurnSessionId === identity.sessionId && task.fillTurnUserId === identity.userId) {
          if (task.status !== "waiting_for_user" || task.checkpoint !== "form_answer_required") {
            const resumed = await existingResumedTurnResult(tx, task.fillTurnId, command.applicationTaskId, identity)
            if (resumed) return resumed
          } else {
            const resume = await assertResumeReady(tx, task, command.applicationTaskId, identity)
            const resumeIdentity = { ...identity, clientMessageId: resume.clientMessageId }
            const existing = await findExistingCommand(tx, identity.sessionId, resumeIdentity.clientMessageId)
            if (existing) {
              if (!existing.targetTurnId || existing.targetTurnId !== task.fillTurnId) throw new AgentCommandError("retry_target_invalid", "The user-input resume command is bound to another Turn", 409)
              return existingFillResult(tx, existing.targetTurnId, identity)
            }
            await assertApplicationFillPreflight(tx, command.applicationTaskId, identity)
            const interrupt: InterruptCommand = {
              ...resumeIdentity,
              clientMessageId: `${resumeIdentity.clientMessageId}:interrupt`,
              expectedTurnId: resume.active.id,
              expectedRevision: resume.active.revision,
            }
            await interruptActiveTurn(tx, interrupt, resume.active, { taskGraphFillCancellation: "preserve" })
            return await createFillTurn(tx, resumeIdentity, task, command.applicationTaskId, true)
          }
        }
        throw new AgentCommandError("retry_target_invalid", "Application task is not ready to resume after persisted user answers", 409)
      }
      if (task.fillTurnId && !command.retry) {
        if (task.fillTurnSessionId !== identity.sessionId || task.fillTurnUserId !== identity.userId) {
          throw new AgentCommandError("agent_session_not_found", "Application fill ownership did not match", 404)
        }
        return existingFillResult(tx, task.fillTurnId, identity)
      }

      if (command.retry) await assertRetryReady(tx, task, identity)
      else if (task.status !== "waiting_for_user" || !START_CHECKPOINTS.includes(task.checkpoint ?? "")) {
        throw new AgentCommandError("retry_target_invalid", "Application task is not ready for a fill-for-review pass", 409)
      }
      const active = await findActiveTurn(tx, identity.sessionId, identity.userId)
      if (active) throw new AgentCommandError("retry_active_conflict", "Finish or stop the active Turn before starting an application fill", 409, { turnId: active.id })
      await assertApplicationFillPreflight(tx, command.applicationTaskId, identity)
      return createFillTurn(tx, identity, task, command.applicationTaskId)
    })
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error
    return db.$transaction(async (tx) => {
      await lockOpenSession(tx, identity.sessionId, identity.userId)
      const rows = await tx.$queryRaw<Array<{ fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null }>>(Prisma.sql`
        SELECT "fillTurnId", "fillTurnSessionId", "fillTurnUserId" FROM "application_tasks"
        WHERE "id" = ${command.applicationTaskId} AND "userId" = ${identity.userId} AND "sessionId" = ${identity.sessionId}
        FOR UPDATE
      `)
      const task = rows[0]
      if (!task?.fillTurnId || task.fillTurnSessionId !== identity.sessionId || task.fillTurnUserId !== identity.userId) throw error
      if (command.resumeAfterUserInput) {
        const resumed = await existingResumedTurnResult(tx, task.fillTurnId, command.applicationTaskId, identity)
        if (!resumed) throw error
        return resumed
      }
      return existingFillResult(tx, task.fillTurnId, identity)
    })
  }
}

async function createFillTurn(
  tx: CommandTransaction,
  identity: CommandIdentity,
  task: { id: string; status: string; checkpoint: string | null; fillTurnId: string | null },
  applicationTaskId: string,
  resumeSession = false,
): Promise<CommandResult> {
  const turn = await createRootTurn(tx, identity, CONTENT)
  const accepted = await acceptInputFacts(tx, identity, CONTENT, turn, "follow_up", "started", true)
  const claim = await tx.applicationTask.updateMany({
    where: { id: applicationTaskId, userId: identity.userId, sessionId: identity.sessionId,
      status: task.status, checkpoint: task.checkpoint, fillTurnId: task.fillTurnId },
    data: { fillTurnId: turn.id, fillTurnSessionId: identity.sessionId, fillTurnUserId: identity.userId,
      status: "filling", checkpoint: "taskgraph_fill_queued", error: null, completedAt: null, startedAt: new Date() },
  })
  if (claim.count !== 1) throw new AgentCommandError("retry_active_conflict", "Application fill attempt was claimed by another request", 409)
  if (resumeSession) {
    const resumed = await tx.agentSession.updateMany({
      where: { id: identity.sessionId, userId: identity.userId, status: "waiting_for_user" },
      data: { status: "running", completedAt: null },
    })
    if (resumed.count !== 1) throw new AgentCommandError("retry_active_conflict", "Agent session is no longer waiting for user input", 409)
  }
  return { ...accepted, disposition: "started" }
}

async function assertResumeReady(
  tx: CommandTransaction,
  task: { id: string; status: string; checkpoint: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; confirmedAnswers?: unknown },
  applicationTaskId: string,
  identity: CommandIdentity,
): Promise<{ active: NonNullable<Awaited<ReturnType<typeof findActiveTurn>>>; clientMessageId: string }> {
  if (!task.fillTurnId || task.fillTurnSessionId !== identity.sessionId || task.fillTurnUserId !== identity.userId
    || task.status !== "waiting_for_user" || task.checkpoint !== "form_answer_required" || !hasConfirmedAnswers(task.confirmedAnswers)) {
    throw new AgentCommandError("retry_target_invalid", "Application task is not waiting for persisted form answers", 409)
  }
  const waits = await tx.$queryRaw<Array<{ id: string; createdAt: Date }>>(Prisma.sql`
    SELECT "id", "createdAt" FROM "application_task_events"
    WHERE "taskId" = ${applicationTaskId} AND "type" = 'form_answer_required' AND "actor" = 'worker'
      AND "data"->>'turnId' = ${task.fillTurnId}
    ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
  `)
  const wait = waits[0]
  if (!wait || !(wait.createdAt instanceof Date) || !Number.isFinite(wait.createdAt.getTime())) {
    throw new AgentCommandError("retry_target_invalid", "The bound fill Turn has no durable form-answer wait", 409)
  }
  const answers = await tx.$queryRaw<Array<{ id: string; createdAt: Date; answeredFieldCount: string | number | null }>>(Prisma.sql`
    SELECT "id", "createdAt", "data"->>'answeredFieldCount' AS "answeredFieldCount" FROM "application_task_events"
    WHERE "taskId" = ${applicationTaskId} AND "type" = 'user_answers_confirmed' AND "actor" = 'user'
      AND "createdAt" > ${wait.createdAt}
    ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
  `)
  const answer = answers[0]
  if (!answer || Number(answer.answeredFieldCount) < 1) {
    throw new AgentCommandError("retry_target_invalid", "Persist form answers for this wait before resuming", 409)
  }
  const active = await findActiveTurn(tx, identity.sessionId, identity.userId)
  if (!active || active.id !== task.fillTurnId || active.status !== "waiting_for_user") {
    throw new AgentCommandError("retry_target_invalid", "The bound fill Turn is not durably waiting for user input", 409)
  }
  const turn = await tx.agentTurn.findFirst({
    where: { id: task.fillTurnId, sessionId: identity.sessionId, userId: identity.userId },
    select: { id: true, status: true, leaseOwnerId: true, leaseExpiresAt: true },
  })
  if (!turn || turn.status !== "waiting_for_user" || turn.leaseOwnerId !== null || turn.leaseExpiresAt !== null) {
    throw new AgentCommandError("retry_target_invalid", "The prior fill Turn still owns an active execution lease", 409)
  }
  const fillers = await tx.$queryRaw<Array<{ id: string; status: string; leaseOwner: string | null; leaseExpiresAt: Date | null; interruptRequestedAt: Date | null }>>(Prisma.sql`
    SELECT task."id", task."status", task."leaseOwner", task."leaseExpiresAt", task."interruptRequestedAt"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = ${identity.userId}
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = ${identity.userId}
    WHERE task."sessionId" = ${identity.sessionId} AND task."turnId" = ${task.fillTurnId}
      AND task."role" = 'application_filler' AND task."taskType" = 'application_fill_for_review'
    FOR UPDATE OF task
  `)
  if (fillers.length !== 1 || fillers[0].status !== "waiting_for_user" || fillers[0].leaseOwner !== null
    || fillers[0].leaseExpiresAt !== null || fillers[0].interruptRequestedAt !== null) {
    throw new AgentCommandError("retry_target_invalid", "The application filler must be durably waiting with no live browser lease", 409)
  }
  return { active, clientMessageId: `application-fill-resume:${task.id}:${wait.id}:${answer.id}` }
}

async function existingResumedTurnResult(
  tx: CommandTransaction,
  turnId: string,
  applicationTaskId: string,
  identity: CommandIdentity,
): Promise<CommandResult | null> {
  const turn = await tx.agentTurn.findFirst({
    where: { id: turnId, sessionId: identity.sessionId, userId: identity.userId },
    select: { id: true, input: true },
  })
  const input = turn?.input && typeof turn.input === "object" && !Array.isArray(turn.input) ? turn.input as Record<string, unknown> : null
  const marker = input?.clientMessageId
  return typeof marker === "string" && marker.startsWith(`application-fill-resume:${applicationTaskId}:`)
    ? existingFillResult(tx, turnId, identity) : null
}

function hasConfirmedAnswers(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.entries(value).some(([key, answer]) => key.trim().length > 0 && typeof answer === "string" && answer.trim().length > 0)
}

async function assertRetryReady(
  tx: CommandTransaction,
  task: { fillTurnId: string | null; status: string; checkpoint: string | null },
  identity: CommandIdentity,
): Promise<void> {
  if (!task.fillTurnId || task.status !== "failed" || !RETRY_CHECKPOINTS.includes(task.checkpoint ?? "")) {
    throw new AgentCommandError("retry_target_invalid", "Application fill is not in a safely retryable terminal state", 409)
  }
  const previous = await tx.agentTurn.findFirst({
    where: { id: task.fillTurnId, sessionId: identity.sessionId, userId: identity.userId }, select: { id: true, status: true },
  })
  if (!previous || !TERMINAL_TURNS.includes(previous.status)) {
    throw new AgentCommandError("retry_target_invalid", "The prior application fill Turn is not terminal", 409)
  }
}
