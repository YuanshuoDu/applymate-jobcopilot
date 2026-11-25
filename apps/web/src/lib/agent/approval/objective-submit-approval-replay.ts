import type { PrismaClient } from "@prisma/client"
import {
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR, OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE, hashObjectiveApplicationSubmissionMaterial, matchesApplyTaskSubmitPayload,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, parseObjectiveApplicationSubmissionManifestEvent, parseObjectiveReviewedFillSource,
} from "@jobcopilot/shared"
import { createSubmitIntent, isReplayableSubmitState } from "@/lib/apply-queue-client"
import { hashArtifactContent } from "../artifacts/hash"
import { hasObjectiveSubmissionManifestSignal, replayReceiptScopeMatches } from "./objective-reviewed-submit-material"

type Client = Pick<PrismaClient, "agentTurn" | "applicationTaskEvent" | "agentOutbox">
type Row = Record<string, unknown>
type ReplayApproval = Readonly<{
  id: string; status: string; payload: unknown; sessionId: string | null; taskId: string | null; turnId: string | null
  toolCallId: string | null; jobId: string | null; revision: number; expiresAt: Date | null; decidedAt: Date | null
  scopeHash: string | null; nonceHash: string | null; resourceHash: string | null; materialHash: string | null; answersHash: string | null
}>
type ReplayTask = Readonly<{
  id: string; userId: string; jobId: string; sessionId: string | null; fillTurnId: string | null
  fillTurnSessionId: string | null; fillTurnUserId: string | null; workerTaskId: string | null
  status: string; checkpoint: string | null
}>
export type ObjectiveSubmitApprovalReplay = Readonly<
  | { kind: "not_objective" }
  | { kind: "retryable" }
  | { kind: "invalid" }
  | { kind: "committed"; taskId: string }
>
export type ObjectiveSubmitApprovalReplayInput = Readonly<{
  userId: string; sessionId: string; applicationTaskId: string; jobId: string; approvalId: string; receiptNonce: string
  task: ReplayTask | null; approval: ReplayApproval | null
}>

const QUEUED_BODY = "User approved this job for background submission."
const OUTBOX_KEYS = ["applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "receiptId", "constraintHash", "workerTaskId", "submitPayload"]
const EVENT_KEYS = ["applicationTaskId", "userId", "jobId", "sessionId", "fillTurnId", "approvalId", "receiptId", "constraintHash", "workerTaskId"]

/** Recognizes an existing immutable Objective submit intent before consulting mutable Resume/source state. */
export async function readObjectiveSubmitApprovalReplay(
  client: Client, input: ObjectiveSubmitApprovalReplayInput, now = new Date(),
): Promise<ObjectiveSubmitApprovalReplay> {
  try {
    const { task, approval } = input
    if (!task || !sameTask(task, input) || !validDate(now)) return { kind: "invalid" }
    const fillTurnId = task.fillTurnId!
    const turns = await client.agentTurn.findMany({ where: { id: fillTurnId, userId: input.userId,
      sessionId: input.sessionId, source: "user" }, take: 2,
    select: { id: true, userId: true, sessionId: true, source: true, executionMode: true, input: true } })
    if (turns.length !== 1 || turns[0]?.id !== task.fillTurnId || turns[0]?.userId !== input.userId
      || turns[0]?.sessionId !== input.sessionId || turns[0]?.source !== "user") return { kind: "invalid" }
    const turn = turns[0]!
    const source = parseObjectiveReviewedFillSource(turn.input)
    if (!source) return hasObjectiveMarker(turn.input)
      || await hasObjectiveSubmissionManifestSignal(client, task.id, fillTurnId) ? { kind: "invalid" } : { kind: "not_objective" }
    if (turns[0].executionMode !== "canonical_task_graph" || !approval || !sameApproval(approval, input, task)
      || !await replayReceiptScopeMatches(approval, { userId: input.userId, receiptNonce: input.receiptNonce })) return { kind: "invalid" }
    const manifest = await readManifest(client, input, task, fillTurnId, source)
    if (!manifest || !await approvalMatchesManifest(approval, manifest)) return { kind: "invalid" }
    const intent = createSubmitIntent({ applicationTaskId: input.applicationTaskId, userId: input.userId, jobId: input.jobId,
      sessionId: input.sessionId, fillTurnId, receiptId: approval.id, constraintHash: approval.scopeHash!,
      operation: "submit", applyUrl: "", personaId: "server-side", resumePath: "" })
    const [outbox, scopedOutboxes, queued, started] = await Promise.all([
      client.agentOutbox.findUnique({ where: { idempotencyKey: intent.idempotencyKey }, select: {
        id: true, topic: true, aggregateId: true, idempotencyKey: true, payload: true,
      } }),
      client.agentOutbox.findMany({ where: { topic: intent.topic, aggregateId: input.sessionId, AND: [
        { payload: { path: ["applicationTaskId"], equals: task.id } },
        { payload: { path: ["fillTurnId"], equals: fillTurnId } },
      ] }, take: 2, select: { id: true } }),
      client.applicationTaskEvent.findMany({ where: { taskId: task.id, type: "submission_queued",
        data: { path: ["fillTurnId"], equals: fillTurnId } }, take: 2,
      select: { id: true, taskId: true, type: true, actor: true, body: true, data: true, createdAt: true } }),
      client.applicationTaskEvent.findMany({ where: { taskId: task.id, type: { in: ["submission_execution_started", "submission_execution_settled"] },
        data: { path: ["fillTurnId"], equals: fillTurnId } }, take: 1, select: { id: true } }),
    ])
    if (scopedOutboxes.length > 1 || scopedOutboxes.some(row => row.id !== intent.id)) return { kind: "invalid" }
    if (outbox || scopedOutboxes.length || queued.length || task.workerTaskId) {
      const replay = await exactCommittedIntent(input, task, approval, intent, outbox, queued)
      return replay ? { kind: "committed", taskId: replay } : { kind: "invalid" }
    }
    if (started.length) return { kind: "invalid" }
    return task.status === "waiting_for_authorization" && task.checkpoint === "queue_retry"
      && approval.status === "approved" && approval.expiresAt !== null && approval.expiresAt > now
      ? { kind: "retryable" } : { kind: "invalid" }
  } catch { return { kind: "invalid" } }
}

async function readManifest(client: Client, input: ObjectiveSubmitApprovalReplayInput, task: ReplayTask, fillTurnId: string,
  source: NonNullable<ReturnType<typeof parseObjectiveReviewedFillSource>>) {
  const id = `objective-submission-manifest:${hashArtifactContent([task.id, fillTurnId]).slice(7)}`
  const rows = await client.applicationTaskEvent.findMany({ where: { taskId: input.applicationTaskId, OR: [
    { id }, { type: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
      data: { path: ["scope", "fillTurnId"], equals: fillTurnId } },
  ] }, take: 2, select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const row = rows[0], packet = rows.length === 1 && row?.id === id && row.taskId === input.applicationTaskId
    && row.type === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE
    && row.actor === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR && row.body === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY
    ? parseObjectiveApplicationSubmissionManifestEvent(row.data) : null
  if (!packet || packet.scope.userId !== input.userId || packet.scope.sessionId !== input.sessionId
    || packet.scope.applicationTaskId !== input.applicationTaskId || packet.scope.jobId !== input.jobId
    || packet.scope.fillTurnId !== fillTurnId || !sameSource(packet.manifest.material.objectiveSource, source)
    || hashArtifactContent(packet.manifest) !== packet.hash) return null
  return packet
}

async function approvalMatchesManifest(approval: ReplayApproval, packet: NonNullable<Awaited<ReturnType<typeof readManifest>>>): Promise<boolean> {
  const material = packet.manifest.material
  return approval.resourceHash === packet.hash.slice(7)
    && approval.materialHash === await hashObjectiveApplicationSubmissionMaterial(material)
    && approval.answersHash === packet.manifest.answersHash
    && exactPayload(approval.payload, { applicationTaskId: material.applicationTaskId, jobId: material.jobId,
      resumeId: material.resumeId, coverLetterId: material.coverLetterId })
}

async function exactCommittedIntent(input: ObjectiveSubmitApprovalReplayInput, task: ReplayTask, approval: ReplayApproval,
  intent: ReturnType<typeof createSubmitIntent>, outbox: unknown, queued: readonly Row[]): Promise<string | null> {
  if (!task.workerTaskId || !isReplayableSubmitState(task.status, task.checkpoint) || queued.length !== 1) return null
  const row = exactRecord(outbox, ["id", "topic", "aggregateId", "idempotencyKey", "payload"])
  const payload = row && exactRecord(row.payload, OUTBOX_KEYS), submit = payload?.submitPayload
  const expected = { applicationTaskId: input.applicationTaskId, jobId: input.jobId, userId: input.userId,
    sessionId: input.sessionId, fillTurnId: task.fillTurnId!, receiptId: approval.id, constraintHash: approval.scopeHash! }
  if (!row || !payload || row.id !== intent.id || row.topic !== intent.topic || row.aggregateId !== intent.aggregateId
    || row.idempotencyKey !== intent.idempotencyKey || payload.applicationTaskId !== input.applicationTaskId
    || payload.userId !== input.userId || payload.jobId !== input.jobId || payload.sessionId !== input.sessionId
    || payload.fillTurnId !== task.fillTurnId || payload.receiptId !== approval.id || payload.constraintHash !== approval.scopeHash
    || payload.workerTaskId !== task.workerTaskId || !matchesApplyTaskSubmitPayload(submit, expected)) return null
  const storedIntent = createSubmitIntent(submit)
  const event = queued[0]!, data = exactRecord(event.data, EVENT_KEYS)
  if (storedIntent.id !== row.id || storedIntent.idempotencyKey !== row.idempotencyKey
    || storedIntent.payload.workerTaskId !== task.workerTaskId || !data || event.taskId !== task.id
    || event.type !== "submission_queued" || event.actor !== "user" || event.body !== QUEUED_BODY
    || typeof event.id !== "string" || !validDate(event.createdAt) || !approval.decidedAt || !approval.expiresAt
    || event.createdAt < approval.decidedAt || event.createdAt >= approval.expiresAt
    || !Object.entries(expected).every(([key, value]) => data[key] === value)
    || data.applicationTaskId !== input.applicationTaskId || data.approvalId !== approval.id
    || data.receiptId !== approval.id || data.workerTaskId !== task.workerTaskId) return null
  return task.workerTaskId
}

function sameTask(task: ReplayTask, input: ObjectiveSubmitApprovalReplayInput): boolean {
  return task.userId === input.userId && task.jobId === input.jobId && task.sessionId === input.sessionId
    && task.fillTurnId !== null && task.fillTurnSessionId === input.sessionId && task.fillTurnUserId === input.userId
}
function hasObjectiveMarker(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false
  try {
    const row = input as Row
    const key = Object.getOwnPropertyDescriptor(row, "clientMessageId")
    const selector = Object.getOwnPropertyDescriptor(row, "reviewedApplicationMaterialSource")
    if (key?.enumerable && Object.hasOwn(key, "value") && typeof key.value === "string"
      && key.value.startsWith("agent-objective-reviewed-fill:")) return true
    if (!selector?.enumerable || !Object.hasOwn(selector, "value") || !selector.value
      || typeof selector.value !== "object" || Array.isArray(selector.value)) return false
    const version = Object.getOwnPropertyDescriptor(selector.value, "schemaVersion")
    return version?.enumerable === true && Object.hasOwn(version, "value")
      && version.value === OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA
  } catch { return false }
}
function sameApproval(approval: ReplayApproval, input: ObjectiveSubmitApprovalReplayInput, task: ReplayTask): boolean {
  return approval.id === input.approvalId && ["approved", "consumed"].includes(approval.status)
    && approval.sessionId === input.sessionId && approval.taskId === input.applicationTaskId
    && approval.turnId === task.fillTurnId && approval.toolCallId === `application-submit:${task.id}`
    && approval.jobId === input.jobId && Number.isSafeInteger(approval.revision) && approval.revision >= 0
    && validDate(approval.expiresAt) && validDate(approval.decidedAt) && typeof approval.scopeHash === "string"
    && typeof approval.nonceHash === "string" && typeof approval.resourceHash === "string"
    && typeof approval.materialHash === "string" && typeof approval.answersHash === "string"
}
function sameSource(left: { schemaVersion: string; approvalId: string; reviewTurnId: string; materialProofHash: string },
  right: { schemaVersion: string; approvalId: string; reviewTurnId: string; materialProofHash: string }): boolean {
  return left.schemaVersion === right.schemaVersion && left.approvalId === right.approvalId
    && left.reviewTurnId === right.reviewTurnId && left.materialProofHash === right.materialProofHash
}
function exactPayload(value: unknown, expected: Record<string, unknown>): boolean {
  const row = exactRecord(value, Object.keys(expected))
  return !!row && Object.entries(expected).every(([key, value]) => row[key] === value)
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const own = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || own.length !== keys.length || own.some(key => typeof key !== "string" || !keys.includes(key))) return null
    if (!own.every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable === true && Object.hasOwn(descriptor, "value") })) return null
    return value as Row
  } catch { return null }
}
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
