import type { Prisma, PrismaClient } from "@prisma/client"

export const REVIEWED_FILL_SOURCE_SCHEMA = "agent-harness.v2.selected-job-reviewed-fill-source.v1"
export const REVIEWED_FILL_SOURCE_EVENT = "reviewed_material_source_bound"

type ReviewedFillSourceClient = Pick<PrismaClient,
  "agentApproval" | "applicationTask" | "applicationTaskEvent" | "agentTurn">

type SourceScope = Readonly<{
  userId: string
  sessionId: string
  jobId: string
  applicationTaskId: string
  approvalId: string
  sourceTurnId: string
}>

export class ReviewedFillSourceBindingError extends Error {
  readonly code = "reviewed_fill_source_unavailable" as const
  constructor() {
    super("The selected reviewed material source is unavailable for this application")
    this.name = "ReviewedFillSourceBindingError"
  }
}

export function parseReviewedSourceTurnId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 256
    ? value : null
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256
}

function requestData(value: unknown, approvalId: string): string | null {
  const data = record(value)
  if (!data || Object.keys(data).sort().join(",") !== "approvalId,schemaVersion,sourceTurnId"
    || data.schemaVersion !== REVIEWED_FILL_SOURCE_SCHEMA || data.approvalId !== approvalId
    || !nonempty(data.sourceTurnId)) return null
  return data.sourceTurnId
}

async function assertSelectedJobTurn(client: ReviewedFillSourceClient, scope: Pick<SourceScope, "userId" | "sessionId" | "jobId" | "sourceTurnId">): Promise<void> {
  const turn = await client.agentTurn.findFirst({
    where: { id: scope.sourceTurnId, userId: scope.userId, sessionId: scope.sessionId, status: "completed" },
    select: { id: true, source: true, rootTaskId: true, input: true },
  })
  const input = record(turn?.input)
  const selection = record(input?.selectedJobPreparation)
  if (!turn || turn.source !== "user" || !nonempty(turn.rootTaskId)
    || !selection || Object.keys(selection).sort().join(",") !== "jobId" || selection.jobId !== scope.jobId) {
    throw new ReviewedFillSourceBindingError()
  }
}

export async function validateReviewedSourceForApplication(
  client: ReviewedFillSourceClient,
  input: { userId: string; sessionId: string; applicationTaskId: string; sourceTurnId: string },
): Promise<{ jobId: string }> {
  const task = await client.applicationTask.findFirst({
    where: { id: input.applicationTaskId, userId: input.userId, sessionId: input.sessionId },
    select: { id: true, jobId: true },
  })
  if (!task || !nonempty(task.jobId)) throw new ReviewedFillSourceBindingError()
  await assertSelectedJobTurn(client, { ...input, jobId: task.jobId })
  return { jobId: task.jobId }
}

/** Persists the user's selector only after the matching approval CAS, inside that same transaction. */
export async function persistReviewedFillSourceInTransaction(
  client: ReviewedFillSourceClient,
  input: { approvalId: string; userId: string; sessionId: string; decision: string; sourceTurnId: string },
): Promise<void> {
  if (input.decision !== "approved" || !nonempty(input.sourceTurnId)) throw new ReviewedFillSourceBindingError()
  const approval = await client.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, status: "approved", type: "review_application" },
    select: { id: true, taskId: true, jobId: true, payload: true },
  })
  const payload = record(approval?.payload)
  if (!approval || !nonempty(approval.taskId) || !nonempty(approval.jobId)
    || payload?.applicationTaskId !== approval.taskId || payload.jobId !== approval.jobId) {
    throw new ReviewedFillSourceBindingError()
  }
  const scope: SourceScope = {
    approvalId: approval.id, userId: input.userId, sessionId: input.sessionId,
    jobId: approval.jobId, applicationTaskId: approval.taskId, sourceTurnId: input.sourceTurnId,
  }
  const task = await client.applicationTask.findFirst({
    where: { id: scope.applicationTaskId, userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId,
      status: "waiting_for_user", checkpoint: "materials_ready" },
    select: { id: true },
  })
  if (!task) throw new ReviewedFillSourceBindingError()
  await assertSelectedJobTurn(client, scope)
  const prior = await client.applicationTaskEvent.findMany({
    where: { taskId: task.id, type: REVIEWED_FILL_SOURCE_EVENT, actor: "user", data: { path: ["approvalId"], equals: scope.approvalId } },
    take: 2, select: { id: true },
  })
  if (prior.length !== 0) throw new ReviewedFillSourceBindingError()
  await client.applicationTaskEvent.create({
    data: {
      taskId: task.id, type: REVIEWED_FILL_SOURCE_EVENT, actor: "user",
      body: "User selected a reviewed material source for this application fill.",
      data: { schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, approvalId: scope.approvalId, sourceTurnId: scope.sourceTurnId } as Prisma.InputJsonValue,
    },
  })
}

/** Replays only one exact accepted selector bound to the original approved receipt and task. */
export async function readAcceptedReviewedFillSource(
  client: ReviewedFillSourceClient,
  input: Omit<SourceScope, "sourceTurnId"> & { requestedSourceTurnId?: string },
): Promise<{ sourceTurnId: string } | undefined> {
  const approval = await client.agentApproval.findFirst({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId,
      status: { in: ["approved", "consumed"] }, type: "review_application" },
    select: { id: true, taskId: true, jobId: true, payload: true },
  })
  const payload = record(approval?.payload)
  if (!approval || approval.taskId !== input.applicationTaskId || approval.jobId !== input.jobId
    || payload?.applicationTaskId !== approval.taskId || payload.jobId !== approval.jobId) {
    throw new ReviewedFillSourceBindingError()
  }
  const task = await client.applicationTask.findFirst({
    where: { id: input.applicationTaskId, userId: input.userId, sessionId: input.sessionId, jobId: input.jobId },
    select: { id: true },
  })
  if (!task) throw new ReviewedFillSourceBindingError()
  const rows = await client.applicationTaskEvent.findMany({
    where: { taskId: task.id, type: REVIEWED_FILL_SOURCE_EVENT, actor: "user", data: { path: ["approvalId"], equals: approval.id } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2, select: { id: true, data: true },
  })
  if (rows.length === 0) {
    if (input.requestedSourceTurnId !== undefined) throw new ReviewedFillSourceBindingError()
    return undefined
  }
  const sourceTurnId = rows.length === 1 ? requestData(rows[0]?.data, approval.id) : null
  if (!sourceTurnId || (input.requestedSourceTurnId !== undefined && input.requestedSourceTurnId !== sourceTurnId)) {
    throw new ReviewedFillSourceBindingError()
  }
  await assertSelectedJobTurn(client, { ...input, sourceTurnId })
  return { sourceTurnId }
}

export async function acceptedFillTurnMatchesReviewedSource(
  client: ReviewedFillSourceClient,
  input: { turnId: string; userId: string; sessionId: string; sourceTurnId: string },
): Promise<boolean> {
  const turn = await client.agentTurn.findFirst({
    where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId }, select: { input: true },
  })
  return reviewedSourceMarker(turn?.input) === input.sourceTurnId
}

function reviewedSourceMarker(value: unknown): string | null | undefined {
  const input = record(value)
  if (!input || !Object.prototype.hasOwnProperty.call(input, "reviewedApplicationMaterialSource")) return undefined
  const marker = record(input.reviewedApplicationMaterialSource)
  if (!marker || Object.keys(marker).sort().join(",") !== "schemaVersion,sourceTurnId"
    || marker.schemaVersion !== REVIEWED_FILL_SOURCE_SCHEMA || !nonempty(marker.sourceTurnId)) return null
  return marker.sourceTurnId
}

export function matchesReviewedSourceTurn(value: unknown, sourceTurnId: string): boolean {
  return reviewedSourceMarker(value) === sourceTurnId
}

export async function reviewedSourceForExistingFillTurn(
  client: ReviewedFillSourceClient,
  input: { turnId: string; userId: string; sessionId: string; applicationTaskId: string },
): Promise<string | undefined> {
  const turn = await client.agentTurn.findFirst({
    where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId }, select: { input: true },
  })
  if (!turn) throw new ReviewedFillSourceBindingError()
  const sourceTurnId = reviewedSourceMarker(turn.input)
  if (sourceTurnId === null) throw new ReviewedFillSourceBindingError()
  if (sourceTurnId) await validateReviewedSourceForApplication(client, { ...input, sourceTurnId })
  return sourceTurnId
}

export async function persistReviewedSourceOnFillTurn(
  client: ReviewedFillSourceClient,
  input: { turnId: string; userId: string; sessionId: string; clientMessageId: string; sourceTurnId: string },
): Promise<void> {
  const turn = await client.agentTurn.findFirst({
    where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId, status: "queued", source: "user" },
    select: { id: true, input: true },
  })
  const prior = record(turn?.input)
  if (!turn || !prior || prior.clientMessageId !== input.clientMessageId || reviewedSourceMarker(prior) !== undefined) {
    throw new ReviewedFillSourceBindingError()
  }
  const updated = await client.agentTurn.updateMany({
    where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId, status: "queued", source: "user" },
    data: { input: { ...prior, reviewedApplicationMaterialSource: {
      schemaVersion: REVIEWED_FILL_SOURCE_SCHEMA, sourceTurnId: input.sourceTurnId,
    } } as Prisma.InputJsonValue },
  })
  if (updated.count !== 1) throw new ReviewedFillSourceBindingError()
}
