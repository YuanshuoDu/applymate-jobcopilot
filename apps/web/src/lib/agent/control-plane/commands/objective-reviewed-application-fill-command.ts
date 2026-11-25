import { Prisma, type PrismaClient } from "@prisma/client"
import { objectiveApplicationApprovedIntentId, objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveApplicationApprovedIntent, parseObjectiveReviewedFillSource,
  type ObjectiveReviewedFillHandoffIntent } from "@jobcopilot/shared"
import { acquireSourceMaterialFence } from "../../source-material-fence"
import { ReviewedFillHandoffDeferredError, existingFillCommandResult } from "../../approval/reviewed-fill-handoff"
import { readObjectiveReviewedFillAuthority, verifyObjectiveReviewedFillFreshness } from "../../approval/objective-reviewed-fill-authority"
import { verifyObjectiveReviewedFillContinuation } from "./objective-reviewed-application-fill-continuation"
import { assertApplicationFillPreflight, hasObjectiveApplicationFillReservation, lockApplicationFillTask } from "./application-fill-preflight"
import { AgentCommandError, invalidCommand } from "./errors"
import { acceptInputFacts, createRootTurn, findActiveTurn, findExistingCommand, lockOpenSession } from "./transaction"
import type { CommandIdentity, CommandResult } from "./types"

const CONTENT = [{ type: "text" as const, text: "Fill the server-bound application form for user review. Never submit it." }]
const ACTIVE = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])
export type ObjectiveFillDuplicateProbe = Readonly<{ kind: "none" } | { kind: "duplicate"; result: CommandResult }>

/** Detects an exact accepted command before current launch gates, including after its receipt expires. */
export async function acknowledgeExistingObjectiveReviewedFill(
  db: PrismaClient, intent: ObjectiveReviewedFillHandoffIntent,
): Promise<ObjectiveFillDuplicateProbe> {
  const clientMessageId = objectiveReviewedFillHandoffIdempotencyKey(intent.approvalId)
  if (!clientMessageId) throw invalidCommand("Objective reviewed fill handoff is invalid")
  const identity: CommandIdentity = { userId: intent.userId, sessionId: intent.sessionId, clientMessageId, source: "user" }
  return db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [intent.userId])
    await lockOpenSession(tx, intent.sessionId, intent.userId)
    await lockPredecessor(tx, intent)
    const existing = await findExistingCommand(tx, intent.sessionId, clientMessageId)
    return existing ? { kind: "duplicate", result: await replayExisting(tx, existing, identity, intent) } : { kind: "none" }
  })
}

/** Starts one bounded, non-submitting Fill Turn from an exact completed Objective approval. */
export async function startObjectiveReviewedApplicationFill(
  db: PrismaClient, intent: ObjectiveReviewedFillHandoffIntent, now = new Date(),
): Promise<CommandResult> {
  const clientMessageId = objectiveReviewedFillHandoffIdempotencyKey(intent.approvalId)
  if (!clientMessageId || !validIntent(intent) || !validDate(now)) throw invalidCommand("Objective reviewed fill handoff is invalid")
  const identity: CommandIdentity = { userId: intent.userId, sessionId: intent.sessionId, clientMessageId, source: "user" }
  return db.$transaction(async tx => {
    await acquireSourceMaterialFence(tx, [intent.userId])
    await lockOpenSession(tx, intent.sessionId, intent.userId)
    const predecessor = await lockPredecessor(tx, intent)
    const existing = await findExistingCommand(tx, intent.sessionId, clientMessageId)
    if (existing) return replayExisting(tx, existing, identity, intent)

    const session = await tx.agentSession.findFirst({
      where: { id: intent.sessionId, userId: intent.userId }, select: { id: true, status: true },
    })
    if (!session || session.status !== "running" && session.status !== "waiting_for_user") throw new ReviewedFillHandoffDeferredError()
    const needsContinuation = session.status === "waiting_for_user"

    const authority = await readObjectiveReviewedFillAuthority(tx, intent, now)
    const locked = await lockApplicationFillTask(tx, intent.applicationTaskId, identity, false)
    if (!locked.task) throw new AgentCommandError("agent_session_not_found", "Application task not found", 404)
    const task = await tx.applicationTask.findFirst({ where: { id: intent.applicationTaskId, userId: intent.userId,
      sessionId: intent.sessionId }, select: { id: true, jobId: true, resumeId: true, status: true, checkpoint: true,
      fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true, workerTaskId: true, startedAt: true, completedAt: true } })
    if (!task || task.id !== intent.applicationTaskId || task.jobId !== authority.jobId || task.resumeId !== authority.resumeId
      || task.status !== "waiting_for_user" || task.checkpoint !== "materials_ready" || task.fillTurnId !== null
      || task.fillTurnSessionId !== null || task.fillTurnUserId !== null || task.workerTaskId !== null
      || task.startedAt !== null || task.completedAt !== null || predecessor.status !== "completed") throw unavailable()
    if (!await hasObjectiveApplicationFillReservation(tx, { applicationTaskId: task.id, userId: intent.userId, sessionId: intent.sessionId })) throw unavailable()
    const active = await findActiveTurn(tx, intent.sessionId, intent.userId)
    if (active) throw new AgentCommandError("retry_active_conflict", "Finish the active Turn before starting an Objective fill", 409)
    await assertApplicationFillPreflight(tx, task.id, identity, { allowObjectiveReservation: true })
    await verifyObjectiveReviewedFillFreshness(tx, authority)
    const continuation = await verifyObjectiveReviewedFillContinuation(tx, {
      userId: intent.userId, sessionId: intent.sessionId, applicationTaskId: intent.applicationTaskId,
      approvalId: intent.approvalId, setId: authority.input.setId, slotOrdinal: authority.input.slotOrdinal,
      sourceTurnId: authority.input.sourceTurnId, reviewTurnId: intent.predecessorTurnId,
    })
    if (continuation === "deferred" || needsContinuation && continuation === "first") throw new ReviewedFillHandoffDeferredError()
    if (continuation !== "ready" && continuation !== "first") throw unavailable()
    if (needsContinuation) {
      const resumed = await tx.agentSession.updateMany({
        where: { id: intent.sessionId, userId: intent.userId, status: "waiting_for_user" },
        data: { status: "running", completedAt: null },
      })
      if (resumed.count !== 1) throw new ReviewedFillHandoffDeferredError()
    }

    const turn = await createRootTurn(tx, identity, CONTENT)
    const turnInput = { clientMessageId, content: CONTENT, goal: CONTENT[0]!.text, reviewedApplicationMaterialSource: authority.source }
    const attached = await tx.agentTurn.updateMany({ where: { id: turn.id, userId: intent.userId, sessionId: intent.sessionId,
      source: "user", status: "queued", executionMode: null }, data: { executionMode: "canonical_task_graph",
      input: turnInput as Prisma.InputJsonValue } })
    if (attached.count !== 1) throw unavailable()
    const accepted = await acceptInputFacts(tx, identity, CONTENT, { ...turn, status: "queued" }, "follow_up", "started", true)
    const claimed = await tx.applicationTask.updateMany({ where: { id: task.id, userId: intent.userId, sessionId: intent.sessionId,
      jobId: authority.jobId, resumeId: authority.resumeId, status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null },
      data: { fillTurnId: turn.id, fillTurnSessionId: intent.sessionId, fillTurnUserId: intent.userId,
        status: "filling", checkpoint: "taskgraph_fill_queued", error: null, completedAt: null, startedAt: now } })
    if (claimed.count !== 1) throw new AgentCommandError("retry_active_conflict", "Objective fill task was claimed by another request", 409)
    return { ...accepted, disposition: "started" }
  })
}

async function lockPredecessor(tx: Prisma.TransactionClient, intent: ObjectiveReviewedFillHandoffIntent): Promise<{ status: string }> {
  const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
    SELECT "id", "status" FROM "agent_turns" WHERE "id" = ${intent.predecessorTurnId}
      AND "sessionId" = ${intent.sessionId} AND "userId" = ${intent.userId} FOR UPDATE
  `)
  if (rows.length !== 1) throw unavailable()
  if (ACTIVE.has(rows[0]!.status)) throw new ReviewedFillHandoffDeferredError()
  if (rows[0]!.status !== "completed") throw unavailable()
  return rows[0]!
}

async function replayExisting(tx: Prisma.TransactionClient, existing: NonNullable<Awaited<ReturnType<typeof findExistingCommand>>>,
  identity: CommandIdentity, intent: ObjectiveReviewedFillHandoffIntent): Promise<CommandResult> {
  if (!existing.targetTurnId) throw unavailable()
  const locked = await lockApplicationFillTask(tx, intent.applicationTaskId, identity, false)
  const task = locked.task
  const fill = task?.fillTurnId ? await tx.agentTurn.findFirst({ where: { id: task.fillTurnId, userId: intent.userId,
    sessionId: intent.sessionId }, select: { input: true, executionMode: true } }) : null
  const input = isRecord(fill?.input) ? fill.input : null
  const source = parseObjectiveReviewedFillSource(input)
  const events = await tx.applicationTaskEvent.findMany({ where: { taskId: intent.applicationTaskId,
    type: "objective_application_review_approved", actor: "user", data: { path: ["approvalId"], equals: intent.approvalId } },
    take: 2, select: { id: true, taskId: true, type: true, actor: true, data: true } })
  const approved = events.length === 1 ? parseObjectiveApplicationApprovedIntent(events[0]?.data) : null
  if (!task || existing.targetTurnId !== task.fillTurnId || task.fillTurnSessionId !== intent.sessionId
    || task.fillTurnUserId !== intent.userId || fill?.executionMode !== "canonical_task_graph"
    || !exactFillInput(input, identity.clientMessageId) || input.clientMessageId !== identity.clientMessageId
    || source?.approvalId !== intent.approvalId || source.reviewTurnId !== intent.predecessorTurnId
    || !approved || approved.approvalId !== intent.approvalId || approved.userId !== intent.userId
    || approved.sessionId !== intent.sessionId || approved.applicationTaskId !== intent.applicationTaskId
    || approved.reviewTurnId !== intent.predecessorTurnId || source.materialProofHash !== approved.materialProofHash
    || events[0]?.id !== objectiveApplicationApprovedIntentId(approved.setId, approved.slotOrdinal)) throw unavailable()
  return existingFillCommandResult(tx, existing.targetTurnId, identity, undefined, existing)
}

function validIntent(value: ObjectiveReviewedFillHandoffIntent): boolean {
  return [value.userId, value.sessionId, value.applicationTaskId, value.approvalId, value.predecessorTurnId]
    .every(text)
}
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) }
function exactFillInput(value: Record<string, unknown> | null, clientMessageId: string): value is Record<string, unknown> {
  if (!value || Object.keys(value).sort().join(",") !== "clientMessageId,content,goal,reviewedApplicationMaterialSource"
    || value.clientMessageId !== clientMessageId || value.goal !== CONTENT[0]!.text
    || !Array.isArray(value.content) || value.content.length !== 1) return false
  const part = value.content[0]
  return isRecord(part) && Object.keys(part).sort().join(",") === "text,type"
    && part.type === "text" && part.text === CONTENT[0]!.text
}
function unavailable(): AgentCommandError { return new AgentCommandError("retry_target_invalid", "Objective reviewed fill is unavailable", 409) }
