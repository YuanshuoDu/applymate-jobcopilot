import { Prisma } from "@prisma/client"

import { AgentCommandError } from "./errors"
import type { CommandIdentity } from "./types"
import type { CommandTransaction } from "./transaction"

type PersistedApplicationMaterial = {
  jobId: string
  resumeId: string | null
  coverLetterId: string | null
}

const RETRY_CHECKPOINTS = ["fill_prestart_failed", "taskgraph_fill_failed"]
const TERMINAL_TURNS = ["completed", "failed", "interrupted", "cancelled"]
const TERMINAL_FILLERS = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])

type ApplicationFillTask = {
  id: string
  status: string
  checkpoint: string | null
  fillTurnId: string | null
  fillTurnSessionId: string | null
  fillTurnUserId: string | null
  confirmedAnswers?: unknown
}

/** Preserve Session → Turn → filler → application-task lock order for stopped retries. */
export async function lockApplicationFillTask(
  tx: CommandTransaction,
  applicationTaskId: string,
  identity: Pick<CommandIdentity, "userId" | "sessionId">,
  retry: boolean,
): Promise<{ task: ApplicationFillTask | undefined; stoppedRetryReady: boolean }> {
  let stoppedCandidate: ApplicationFillTask | undefined
  if (retry) {
    const candidates = await tx.$queryRaw<ApplicationFillTask[]>(Prisma.sql`
      SELECT "id", "status", "checkpoint", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "confirmedAnswers"
      FROM "application_tasks"
      WHERE "id" = ${applicationTaskId} AND "userId" = ${identity.userId} AND "sessionId" = ${identity.sessionId}
    `)
    const candidate = candidates[0]
    if (candidate?.status === "cancelled" && candidate.checkpoint === "turn_stopped_before_submit") {
      await lockStoppedApplicationFillRetry(tx, candidate, identity)
      stoppedCandidate = candidate
    }
  }

  const rows = await tx.$queryRaw<ApplicationFillTask[]>(Prisma.sql`
    SELECT "id", "status", "checkpoint", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "confirmedAnswers"
    FROM "application_tasks"
    WHERE "id" = ${applicationTaskId} AND "userId" = ${identity.userId} AND "sessionId" = ${identity.sessionId}
    FOR UPDATE
  `)
  const task = rows[0]
  if (stoppedCandidate && task && !sameStoppedRetryBinding(task, stoppedCandidate)) throw unavailable()
  return { task, stoppedRetryReady: Boolean(stoppedCandidate && task) }
}

function sameStoppedRetryBinding(task: ApplicationFillTask, candidate: ApplicationFillTask): boolean {
  return task.status === candidate.status && task.checkpoint === candidate.checkpoint
    && task.fillTurnId === candidate.fillTurnId && task.fillTurnSessionId === candidate.fillTurnSessionId
    && task.fillTurnUserId === candidate.fillTurnUserId
}

/** Resolve all fill materials from the locked, server-owned ApplicationTask. */
export async function assertApplicationFillPreflight(
  tx: CommandTransaction,
  applicationTaskId: string,
  identity: Pick<CommandIdentity, "userId" | "sessionId">,
): Promise<void> {
  const rows = await tx.$queryRaw<PersistedApplicationMaterial[]>(Prisma.sql`
    SELECT app."jobId", app."resumeId", app."coverLetterId"
    FROM "application_tasks" AS app
    INNER JOIN "Job" AS job ON job."id" = app."jobId" AND job."userId" = app."userId"
    INNER JOIN "Resume" AS resume ON resume."id" = app."resumeId" AND resume."userId" = app."userId"
      AND (resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")
    WHERE app."id" = ${applicationTaskId} AND app."userId" = ${identity.userId}
      AND app."sessionId" = ${identity.sessionId} AND app."resumeId" IS NOT NULL
    FOR SHARE OF app, job, resume
  `)
  const material = rows[0]
  if (!material?.resumeId) throw unavailable()

  if (material.coverLetterId) {
    const coverLetters = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT cover."id" FROM "CoverLetter" AS cover
      WHERE cover."id" = ${material.coverLetterId} AND cover."userId" = ${identity.userId}
        AND cover."jobId" = ${material.jobId}
      FOR SHARE OF cover
    `)
    if (!coverLetters[0]) throw unavailable()
  }
}

function unavailable(): AgentCommandError {
  return new AgentCommandError("retry_target_invalid", "Application fill materials are unavailable for this task", 409)
}

/** Require a terminal, lease-free filler before a user retries a stopped fill. */
export async function assertApplicationFillRetryReady(
  tx: CommandTransaction,
  task: { fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; status: string; checkpoint: string | null },
  identity: Pick<CommandIdentity, "userId" | "sessionId">,
): Promise<void> {
  const retryableFailure = task.status === "failed" && RETRY_CHECKPOINTS.includes(task.checkpoint ?? "")
  const stopped = task.status === "cancelled" && task.checkpoint === "turn_stopped_before_submit"
  if (!task.fillTurnId || (!retryableFailure && !stopped)) {
    throw new AgentCommandError("retry_target_invalid", "Application fill is not in a safely retryable terminal state", 409)
  }
  if (task.fillTurnSessionId !== identity.sessionId || task.fillTurnUserId !== identity.userId) {
    throw new AgentCommandError("retry_target_invalid", "The application fill Turn is not bound to this user and session", 409)
  }
  if (stopped) {
    await lockStoppedApplicationFillRetry(tx, task, identity)
    return
  }
  const previous = await tx.agentTurn.findFirst({
    where: { id: task.fillTurnId, sessionId: identity.sessionId, userId: identity.userId }, select: { id: true, status: true },
  })
  if (!previous || !TERMINAL_TURNS.includes(previous.status)) {
    throw new AgentCommandError("retry_target_invalid", "The prior application fill Turn is not terminal", 409)
  }
}

async function lockStoppedApplicationFillRetry(
  tx: CommandTransaction,
  task: { fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; status: string; checkpoint: string | null },
  identity: Pick<CommandIdentity, "userId" | "sessionId">,
): Promise<void> {
  if (task.status !== "cancelled" || task.checkpoint !== "turn_stopped_before_submit" || !task.fillTurnId
    || task.fillTurnSessionId !== identity.sessionId || task.fillTurnUserId !== identity.userId) {
    throw new AgentCommandError("retry_target_invalid", "The application fill Turn is not bound to this stopped task", 409)
  }
  const turns = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_turns"
    WHERE "id" = ${task.fillTurnId} AND "sessionId" = ${identity.sessionId} AND "userId" = ${identity.userId}
    FOR UPDATE
  `)
  if (!turns[0] || !TERMINAL_TURNS.includes(turns[0].status)) {
    throw new AgentCommandError("retry_target_invalid", "The prior application fill Turn is not terminal", 409)
  }
  const fillers = await tx.$queryRaw<Array<{ id: string; status: string; leaseOwner: string | null; leaseExpiresAt: Date | null }>>(Prisma.sql`
    SELECT task."id", task."status", task."leaseOwner", task."leaseExpiresAt"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = ${identity.userId}
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = ${identity.userId}
    WHERE task."sessionId" = ${identity.sessionId} AND task."turnId" = ${task.fillTurnId}
      AND task."role" = 'application_filler' AND task."taskType" = 'application_fill_for_review'
    FOR UPDATE OF task
  `)
  if (fillers.length !== 1 || !TERMINAL_FILLERS.has(fillers[0]!.status)
    || fillers[0]!.leaseOwner !== null || fillers[0]!.leaseExpiresAt !== null) {
    throw new AgentCommandError("retry_target_invalid", "The stopped application filler must be terminal with no live lease", 409)
  }
}
