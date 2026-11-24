import type pg from "pg"
import { hashApprovalScope, isApprovalHash } from "@jobcopilot/agent-protocol"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, canonicalJson, hashObjectiveApplicationSubmissionMaterial,
  parseObjectiveReviewedFillSource, type ObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { AgentTurnWakeupPayload } from "./types.js"
import { protocolScope } from "../approval/types.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Turn = Readonly<{ source: string; executionMode: string | null; input: unknown; status: string; revision: number }>
export type ObjectiveFinalSubmitWakeDisposition = "not_applicable" | "acknowledge" | "mismatch"

/** Recognizes only the durable approved submit wait for an Objective Fill Turn. */
export async function inspectObjectiveFinalSubmitWake(
  client: Client,
  payload: AgentTurnWakeupPayload,
  turn: Turn,
  userId: string,
): Promise<ObjectiveFinalSubmitWakeDisposition> {
  if (payload.waitKind !== "approval" || payload.status !== "approved"
    || typeof payload.toolCallId !== "string" || !payload.toolCallId.startsWith("application-submit:")) return "not_applicable"
  const source = parseObjectiveReviewedFillSource(turn.input)
  const marked = objectiveMarkerPresent(turn.input)

  const tasks = await client.query<Row>(`SELECT "id", "userId", "sessionId", "jobId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "resumeId", "coverLetterId"
    FROM "application_tasks" WHERE "userId"=$1 AND "sessionId"=$2 AND "fillTurnId"=$3 AND "fillTurnSessionId"=$2 AND "fillTurnUserId"=$1 FOR SHARE`,
  [userId, payload.sessionId, payload.turnId])
  if (tasks.rows.length !== 1) return source || marked ? "mismatch" : "not_applicable"
  const task = record(tasks.rows[0])
  if (!task || !safeId(task.id) || task.userId !== userId || task.sessionId !== payload.sessionId
    || !safeId(task.jobId) || task.fillTurnId !== payload.turnId || task.fillTurnSessionId !== payload.sessionId
    || task.fillTurnUserId !== userId || !nullableId(task.resumeId) || !nullableId(task.coverLetterId)) return source || marked ? "mismatch" : "not_applicable"

  const approvalId = `application-fill:${task.id}:${payload.turnId}`
  const toolCallId = `application-submit:${task.id}`
  const itemId = `agent-wait:approval:${approvalId}`
  const approvals = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "jobId", "type", "taskId", "status", "toolCallId", "payload", "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt", "decidedAt", "consumedAt", "impact"
    FROM "agent_approvals" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "turnId"=$4 AND "taskId"=$5 FOR SHARE`,
  [approvalId, userId, payload.sessionId, payload.turnId, task.id])
  const approval = record(approvals.rows[0])
  const constraintHash = isApprovalHash(approval?.scopeHash) ? approval.scopeHash : "0".repeat(64)
  const identity = { userId, sessionId: payload.sessionId, applicationTaskId: task.id, jobId: task.jobId,
    fillTurnId: payload.turnId, approvalId, constraintHash }
  const { hasObjectiveSubmissionManifestEvidence } = await import("../../db/objective-reviewed-application-submit-material.js")
  const manifestEvidence = await hasObjectiveSubmissionManifestEvidence(client, identity)
  if (!source) return manifestEvidence || marked ? "mismatch" : "not_applicable"
  if (!manifestEvidence || turn.source !== "user" || turn.executionMode !== "canonical_task_graph"
    || turn.status !== "waiting_for_approval" || turn.revision !== payload.nextTurnRevision
    || payload.waitId !== approvalId || payload.itemId !== itemId || payload.toolCallId !== toolCallId) return "mismatch"
  if (approvals.rows.length !== 1 || !approval || !await validApproval(approval, task, payload, approvalId, toolCallId)) return "mismatch"
  const { readObjectiveSubmissionManifestWithClient } = await import("../../db/objective-submission-manifest-event.js")
  const manifestScope = { userId, sessionId: payload.sessionId, applicationTaskId: task.id, jobId: task.jobId, fillTurnId: payload.turnId }
  const storedManifest = await readObjectiveSubmissionManifestWithClient(client, manifestScope)
  if (!storedManifest || storedManifest.hash.slice(7) !== approval.resourceHash
    || storedManifest.manifest.answersHash !== approval.answersHash
    || storedManifest.manifest.material.applicationTaskId !== task.id || storedManifest.manifest.material.jobId !== task.jobId
    || storedManifest.manifest.material.resumeId !== task.resumeId || storedManifest.manifest.material.coverLetterId !== task.coverLetterId
    || !sameObjectiveSource(storedManifest.manifest.material.objectiveSource, source)
    || await hashObjectiveApplicationSubmissionMaterial(storedManifest.manifest.material) !== approval.materialHash) return "mismatch"

  const items = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "type", "status", "taskId", "content" FROM "agent_items"
    WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 FOR SHARE`, [itemId, payload.sessionId, payload.turnId])
  const resolutions = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "itemId"=$3 AND "correlationId"=$4 AND "type"='approval.resolved' AND "actor"='user' FOR SHARE`,
  [payload.sessionId, payload.turnId, itemId, approvalId])
  const wakeups = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "itemId"=$4 AND "type"='turn.wakeup' FOR SHARE`,
  [payload.eventId, payload.sessionId, payload.turnId, itemId])
  if (approvals.rows.length !== 1 || items.rows.length !== 1 || wakeups.rows.length !== 1 || resolutions.rows.length !== 1) return "mismatch"
  const item = record(items.rows[0]), wakeup = record(wakeups.rows[0]), resolution = record(resolutions.rows[0])
  if (!item || !wakeup || !resolution) return "mismatch"
  if (!validWaitItem(item, task, approval, payload, itemId, toolCallId)) return "mismatch"
  if (!validResolution(resolution, task, payload, approvalId, itemId, toolCallId)) return "mismatch"
  return validWakeup(wakeup, resolution, payload, itemId, toolCallId) ? "acknowledge" : "mismatch"
}

async function validApproval(approval: Row, task: Row, payload: AgentTurnWakeupPayload, id: string, toolCallId: string): Promise<boolean> {
  const expiresAt = date(approval.expiresAt), decidedAt = date(approval.decidedAt)
  const revision = approval.revision
  const impact = record(approval.impact), body = record(approval.payload)
  if (approval.id !== id || approval.userId !== task.userId || approval.sessionId !== task.sessionId
    || approval.turnId !== payload.turnId || approval.jobId !== task.jobId || approval.type !== "submit_application"
    || approval.taskId !== task.id || !["approved", "consumed"].includes(String(approval.status)) || approval.toolCallId !== toolCallId
    || !expiresAt || !decidedAt || decidedAt > expiresAt
    || !Number.isSafeInteger(revision) || Number(revision) < 0 || !body || !impact
    || impact.externalSubmission !== true || impact.jobId !== task.jobId
    || !isApprovalHash(approval.resourceHash) || !isApprovalHash(approval.materialHash) || !isApprovalHash(approval.answersHash)
    || !isApprovalHash(approval.scopeHash) || !isApprovalHash(approval.nonceHash)
    || !sameSubmissionPayload(body, task)) return false
  const scope = { userId: String(task.userId), sessionId: String(task.sessionId), turnId: payload.turnId,
    jobId: String(task.jobId), toolCallId, action: "submit_application" as const, resourceHash: String(approval.resourceHash),
    materialHash: String(approval.materialHash), answersHash: String(approval.answersHash), revision: Number(revision), expiresAt }
  const consumedAt = date(approval.consumedAt)
  const consumptionMatches = approval.status === "approved" ? approval.consumedAt === null
    : !!consumedAt && decidedAt <= consumedAt && consumedAt < expiresAt
  return consumptionMatches && payload.nextTurnRevision === Number(revision) + 2
    && await hashApprovalScope(protocolScope(scope, String(approval.nonceHash))) === approval.scopeHash
}

function validWaitItem(item: Row, task: Row, approval: Row, payload: AgentTurnWakeupPayload, itemId: string, toolCallId: string): boolean {
  const content = record(item.content), impact = record(content?.impact)
  const expires = date(approval.expiresAt), decided = date(approval.decidedAt)
  return item.id === itemId && item.sessionId === payload.sessionId && item.turnId === payload.turnId
    && item.type === "approval_request" && item.status === "completed" && item.taskId === null && !!content
    && content.waitKind === "approval" && content.approvalId === approval.id && content.toolCallId === toolCallId
    && content.action === "submit_application" && content.scopeHash === approval.scopeHash
    && content.receiptRevision === approval.revision && content.expiresAt === expires?.toISOString()
    && content.decision === "approved" && content.responseAvailable === true
    && content.respondedAt === decided?.toISOString() && impact?.externalSubmission === true && impact.jobId === task.jobId
}

function validResolution(event: Row, task: Row, payload: AgentTurnWakeupPayload, approvalId: string, itemId: string, toolCallId: string): boolean {
  const body = record(event.payload)
  return safeId(event.id) && event.sessionId === payload.sessionId && event.turnId === payload.turnId && event.itemId === itemId
    && event.taskId === task.id && event.type === "approval.resolved" && event.actor === "user"
    && event.correlationId === approvalId && event.causationId === itemId
    && typeof event.idempotencyKey === "string" && event.idempotencyKey.startsWith("agent-wait-command:")
    && event.idempotencyKey.length > "agent-wait-command:".length && !!body
    && body.waitKind === "approval" && body.waitId === approvalId && body.itemId === itemId
    && body.turnId === payload.turnId && body.toolCallId === toolCallId && body.status === "approved"
    && body.nextTurnRevision === payload.nextTurnRevision && body.answerAvailable === false
}

function validWakeup(event: Row, resolution: Row, payload: AgentTurnWakeupPayload, itemId: string, toolCallId: string): boolean {
  const body = record(event.payload)
  return event.id === payload.eventId && event.sessionId === payload.sessionId && event.turnId === payload.turnId
    && event.itemId === itemId && event.taskId === null && event.type === "turn.wakeup" && event.actor === "user"
    && event.correlationId === payload.turnId && event.causationId === resolution.id
    && event.idempotencyKey === `${String(resolution.idempotencyKey)}:wakeup` && !!body
    && body.waitKind === "approval" && body.waitId === payload.waitId && body.itemId === itemId
    && body.turnId === payload.turnId && body.toolCallId === toolCallId && body.status === "approved"
    && body.nextTurnRevision === payload.nextTurnRevision
}

function sameSubmissionPayload(payload: Row, task: Row): boolean {
  const keys = ["applicationTaskId", "coverLetterId", "jobId", "resumeId"]
  try {
    const own = Reflect.ownKeys(payload)
    return Object.getPrototypeOf(payload) === Object.prototype && own.length === keys.length
      && own.every(key => typeof key === "string" && keys.includes(key))
      && payload.applicationTaskId === task.id && payload.jobId === task.jobId
      && payload.resumeId === task.resumeId && payload.coverLetterId === task.coverLetterId
  } catch { return false }
}

function objectiveMarkerPresent(input: unknown): boolean {
  const turn = record(input), descriptor = turn && Object.getOwnPropertyDescriptor(turn, "reviewedApplicationMaterialSource")
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false
  const selector = record(descriptor.value)
  return selector?.schemaVersion === OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA
    || typeof selector?.approvalId === "string" && selector.approvalId.startsWith("objective-review:")
}

function sameObjectiveSource(left: ObjectiveReviewedFillSource, right: ObjectiveReviewedFillSource): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try {
    const prototype = Object.getPrototypeOf(parsed), keys = Reflect.ownKeys(parsed)
    if ((prototype !== Object.prototype && prototype !== null) || keys.some(key => typeof key !== "string"
      || !Object.getOwnPropertyDescriptor(parsed, key)?.enumerable || !Object.hasOwn(Object.getOwnPropertyDescriptor(parsed, key) ?? {}, "value"))) return null
    return parsed as Row
  } catch { return null }
}

function date(value: unknown): Date | undefined {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined
}

function nullableId(value: unknown): boolean { return value === null || safeId(value) }
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
