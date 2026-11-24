import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import {
  hashApprovalScope, isApprovalHash, objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet,
  parseObjectiveApplicationReviewIntent, type ObjectiveApplicationReviewIntent,
} from "@jobcopilot/agent-protocol"
import { canonicalJson, parseObjectiveApplicationResumeWitness, type ObjectiveApplicationResumeWitness } from "@jobcopilot/shared"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { protocolScope } from "./approval/types.js"
import { assertObjectiveApprovalSetItem, assertObjectiveApprovalSetWakeupEvent } from "./wakeup/resume-objective-approval-set.js"
import { parseWakeup, type AgentTurnWakeupPayload } from "./wakeup/types.js"

type Row = Record<string, unknown>
type Client = Pick<PoolClient, "query">
const MEMBER_SCHEMA = "objective-application-approval-set-member.v1"
const PROOF_SCHEMA = "objective-application-review-member-proof.v1"
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export type ObjectiveApplicationReviewMemberProof = Readonly<{
  schema: typeof PROOF_SCHEMA
  source: Readonly<{ jobId: string; sourceTurnId: string; rootTaskId: string; graphItemId: string; graphRevision: number; finalItemId: string;
    slotOrdinal: number; writerTaskId: string; reviewerTaskId: string; reviewerToolCallId: string; reviewHash: string;
    artifactId: string; version: number; contentHash: string; sourceDigest: string }>
  resumeWitness: ObjectiveApplicationResumeWitness
  materialProofHash: string
}>
export type ObjectiveApplicationReviewSetMember = Readonly<{
  slotOrdinal: number; approvalId: string; applicationTaskId: string; jobId: string
  status: "pending" | "approved" | "rejected" | "expired"; receiptRevision: number; proof: ObjectiveApplicationReviewMemberProof
}>
export type ObjectiveApplicationReviewSetState = Readonly<{
  status: "pending" | "resolved"; setId: string; itemId: string; intentHash: string
  members: readonly ObjectiveApplicationReviewSetMember[]; wakeup?: AgentTurnWakeupPayload
}>

export function objectiveApplicationReviewIntentHash(selection: ObjectiveApplicationReviewIntent): string {
  return createHash("sha256").update(canonicalJson(selection)).digest("hex")
}
export function objectiveApplicationReviewSetId(sessionId: string, turnId: string): string {
  const digest = createHash("sha256").update(`objective-application-review-set.v1\0${sessionId}\0${turnId}`).digest("hex")
  return `objective-review-${digest.slice(0, 40)}`
}
export function objectiveApplicationReviewApprovalId(setId: string, ordinal: number): string { return `objective-review:${setId}:${ordinal}` }
export function objectiveApplicationReviewToolCallId(setId: string, ordinal: number): string { return `objective_review_application:${setId}:${ordinal}` }

/** Reads the one exact private approval set and its pending or resolved receipt lineage. */
export async function readObjectiveApplicationReviewSetState(client: Client, input: Readonly<{
  userId: string; sessionId: string; turnId: string; selection: ObjectiveApplicationReviewIntent; now?: Date
}>): Promise<ObjectiveApplicationReviewSetState | undefined> {
  const setId = objectiveApplicationReviewSetId(input.sessionId, input.turnId), itemId = objectiveApplicationApprovalSetItemId(setId)
  const intentHash = objectiveApplicationReviewIntentHash(input.selection), selection = parseObjectiveApplicationReviewIntent(input.selection)
  if (!selection || ![input.userId, input.sessionId, input.turnId].every(safeId)) return undefined
  const itemResult = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt"
    FROM "agent_items" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "type"='approval_request' FOR UPDATE`, [itemId, input.sessionId, input.turnId])
  if (itemResult.rows.length !== 1) return undefined
  const item = row(itemResult.rows[0]), set = parseObjectiveApplicationApprovalSet(item?.content)
  if (!item || !set || item.id !== itemId || item.stepId !== null || item.taskId !== null || item.phase !== "commentary"
    || set.setId !== setId || set.sourceTurnId !== selection.sourceTurnId || set.intentHash !== intentHash
    || set.members.length !== selection.slotOrdinals.length || set.members.some((member, index) =>
      member.slotOrdinal !== selection.slotOrdinals[index] || member.approvalId !== objectiveApplicationReviewApprovalId(setId, member.slotOrdinal))) return undefined
  const source = await client.query<Row>(`SELECT "id", "rootTaskId", "source", "executionMode" FROM "agent_turns"
    WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 AND "status"='completed' FOR SHARE NOWAIT`,
    [set.sourceTurnId, input.sessionId, input.userId])
  if (source.rows.length !== 1 || set.sourceTurnId === input.turnId || source.rows[0]?.rootTaskId !== selection.rootTaskId
    || source.rows[0]?.source !== "user" || source.rows[0]?.executionMode !== "canonical_task_graph") return undefined
  const pending = item.status === "started" && item.revision === 0 && item.completedAt == null
  const resolved = item.status === "completed" && item.revision === 1 && item.completedAt != null
  if (!pending && !resolved) return undefined
  if (!await startedEvent(client, input, itemId, setId, set.members.length)) return undefined
  const approvals = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "userId", "taskId", "jobId", "toolCallId", "type", "status", "payload",
      "resourceHash", "materialHash", "answersHash", "scopeHash", "nonceHash", "revision", "expiresAt", "decidedAt", "consumedAt"
    FROM "agent_approvals" WHERE "sessionId"=$1 AND "turnId"=$2 AND "userId"=$3 AND "type"='review_application'
      AND ("id"=ANY($4::text[]) OR "payload"->>'setId'=$5) ORDER BY "id" FOR UPDATE`,
    [input.sessionId, input.turnId, input.userId, set.members.map(member => member.approvalId), setId])
  if (approvals.rows.length !== set.members.length) return undefined
  const byId = new Map(approvals.rows.map(value => [value.id, row(value)]))
  const members: ObjectiveApplicationReviewSetMember[] = []
  const jobs = new Set<string>(), tasks = new Set<string>(), calls = new Set<string>(), revisions = new Set<number>()
  for (const member of set.members) {
    const approval = byId.get(member.approvalId), proof = approval && memberProof(approval.payload, setId, set.sourceTurnId, member.slotOrdinal)
    const expiresAt = date(approval?.expiresAt)
    if (!approval || !proof || !expiresAt || expiresAt.toISOString() !== set.expiresAt
      || approval.id !== member.approvalId || approval.userId !== input.userId || approval.sessionId !== input.sessionId
      || approval.turnId !== input.turnId || approval.type !== "review_application" || !safeId(approval.taskId)
      || !safeId(approval.jobId) || approval.jobId !== proof.source.jobId || !safeId(approval.toolCallId)
      || approval.toolCallId !== objectiveApplicationReviewToolCallId(setId, member.slotOrdinal)
      || proof.source.sourceTurnId !== selection.sourceTurnId || proof.source.rootTaskId !== selection.rootTaskId
      || proof.source.graphItemId !== selection.graphItemId || proof.source.graphRevision !== selection.graphRevision
      || proof.source.slotOrdinal !== member.slotOrdinal || jobs.has(approval.jobId) || tasks.has(approval.taskId)
      || calls.has(approval.toolCallId) || !Number.isSafeInteger(approval.revision) || !isApprovalHash(approval.scopeHash)
      || !isApprovalHash(approval.nonceHash) || !await scopeMatches(approval, expiresAt)) return undefined
    if (!(approval.status === "pending" || approval.status === "approved" || approval.status === "rejected" || approval.status === "expired")
      || approval.consumedAt != null || approval.status === "pending" && approval.decidedAt != null
      || approval.status !== "pending" && approval.decidedAt == null) return undefined
    const expectedMaterialHash = createHash("sha256").update(canonicalJson({ schema: proof.schema, source: proof.source,
      resumeWitness: proof.resumeWitness })).digest("hex")
    const expectedResourceHash = bareHash(hashArtifactContent({ kind: "review_application", userId: input.userId, sessionId: input.sessionId,
      jobId: approval.jobId, applicationTaskId: approval.taskId, slotOrdinal: member.slotOrdinal }))
    const expectedAnswersHash = bareHash(hashArtifactContent({ kind: "review_application", formAnswers: null }))
    const requested = await requestEvent(client, input, approval)
    if (!requested || approval.materialHash !== proof.materialProofHash || proof.materialProofHash !== expectedMaterialHash
      || approval.resourceHash !== expectedResourceHash || approval.answersHash !== expectedAnswersHash
      || resolved && approval.status === "pending") return undefined
    jobs.add(approval.jobId); tasks.add(approval.taskId); calls.add(approval.toolCallId); revisions.add(Number(approval.revision))
    members.push({ slotOrdinal: member.slotOrdinal, approvalId: member.approvalId, applicationTaskId: approval.taskId,
      jobId: approval.jobId, status: approval.status, receiptRevision: Number(approval.revision), proof })
  }
  if (revisions.size !== 1) return undefined
  if (pending) {
    if (!members.some(member => member.status === "pending") || !await memberOutcomeEvents(client, input, itemId, setId, members)) return undefined
    const wakes = await client.query(`SELECT "id" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "type"='turn.wakeup' AND "itemId"=$3 LIMIT 2`,
      [input.sessionId, input.turnId, itemId])
    return wakes.rows.length === 0 ? { status: "pending", setId, itemId, intentHash, members } : undefined
  }
  if (!await memberOutcomeEvents(client, input, itemId, setId, members)) return undefined
  const wakeRows = await client.query<Row>(`SELECT "id" AS "eventId", "sessionId", "turnId", "itemId", "type", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "type"='turn.wakeup' AND "itemId"=$3 LIMIT 2`,
    [input.sessionId, input.turnId, itemId])
  if (wakeRows.rows.length !== 1) return undefined
  const wakeup = parseWakeup(wakeRows.rows[0])
  if (!wakeup || wakeup.waitKind !== "approval_set" || wakeup.waitId !== setId || wakeup.nextTurnRevision < 1) return undefined
  const mismatch = (_code: string, _message: string): never => { throw new Error("approval_set_lineage_invalid") }
  try {
    await assertObjectiveApprovalSetWakeupEvent(client, wakeup, mismatch)
    await assertObjectiveApprovalSetItem(client, wakeup, input.userId, { taskId: item.taskId as string | null, content: item.content }, mismatch)
  } catch { return undefined }
  return { status: "resolved", setId, itemId, intentHash, members, wakeup }
}

async function startedEvent(client: Client, input: { sessionId: string; turnId: string }, itemId: string, setId: string, memberCount: number): Promise<boolean> {
  const result = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "type"='item.started' AND "idempotencyKey"=$3 LIMIT 2`,
    [input.sessionId, input.turnId, `agent-wait:${itemId}:started`])
  const event = row(result.rows[0]), payload = record(event?.payload)
  return result.rows.length === 1 && !!event && !!payload && event.sessionId === input.sessionId && event.turnId === input.turnId
    && event.itemId === itemId && event.taskId === null && event.type === "item.started" && event.actor === "orchestrator"
    && event.correlationId === itemId && event.causationId === null && event.idempotencyKey === `agent-wait:${itemId}:started`
    && exactKeys(payload, "itemId,memberCount,setId,waitKind") && payload.itemId === itemId && payload.setId === setId
    && payload.memberCount === memberCount && payload.waitKind === "approval_set"
}
async function requestEvent(client: Client, input: { sessionId: string; turnId: string }, approval: Row): Promise<boolean> {
  const result = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "type"='approval.requested' AND "correlationId"=$3 AND "idempotencyKey"=$4 LIMIT 2`,
    [input.sessionId, input.turnId, approval.id, `approval:${approval.id}:requested`])
  const event = row(result.rows[0]), payload = record(event?.payload)
  return result.rows.length === 1 && !!event && !!payload && event.sessionId === input.sessionId && event.turnId === input.turnId
    && event.itemId === null && event.taskId === approval.taskId && event.type === "approval.requested" && event.actor === "orchestrator"
    && event.correlationId === approval.id && event.causationId === null && event.idempotencyKey === `approval:${approval.id}:requested`
    && exactKeys(payload, "action,approvalId,revision,scopeHash") && payload.action === "review_application"
    && payload.approvalId === approval.id && payload.revision === approval.revision && payload.scopeHash === approval.scopeHash
}
async function memberOutcomeEvents(client: Client, input: { sessionId: string; turnId: string }, itemId: string, setId: string,
  members: readonly ObjectiveApplicationReviewSetMember[]): Promise<boolean> {
  const ids = members.map(member => member.approvalId)
  const result = await client.query<Row>(`SELECT "id", "sessionId", "turnId", "itemId", "taskId", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "correlationId"=ANY($3::text[])
      AND "type" IN ('approval.resolved','approval.expired') FOR SHARE`, [input.sessionId, input.turnId, ids])
  const grouped = new Map<string, Row[]>()
  for (const raw of result.rows) {
    const event = row(raw), key = event?.correlationId
    if (!event || typeof key !== "string") return false
    grouped.set(key, [...(grouped.get(key) ?? []), event])
  }
  for (const member of members) {
    const events = grouped.get(member.approvalId) ?? []
    if (member.status === "pending") { if (events.length !== 0) return false; continue }
    if (events.length !== 1) return false
    const event = events[0]!, body = record(event.payload)
    if (!body || event.sessionId !== input.sessionId || event.turnId !== input.turnId || event.causationId !== itemId) return false
    if (member.status === "expired") {
      const command = typeof event.idempotencyKey === "string" && event.idempotencyKey.startsWith("objective-approval-set-command:")
      const keys = command ? "action,approvalId,expectedTurnRevision,requestedDecision,revision" : "action,approvalId,revision"
      if (event.type !== "approval.expired" || event.actor !== "system" || event.itemId !== null || event.taskId !== member.applicationTaskId
        || command && (typeof event.idempotencyKey !== "string" || event.idempotencyKey.length <= "objective-approval-set-command:".length)
        || !command && event.idempotencyKey !== `approval-set:${setId}:${member.approvalId}:expired`
        || !exactKeys(body, keys) || body.approvalId !== member.approvalId || body.action !== "review_application"
        || body.revision !== member.receiptRevision
        || command && (!Number.isSafeInteger(body.expectedTurnRevision) || !["approved", "rejected"].includes(String(body.requestedDecision)))) return false
    } else if (event.type !== "approval.resolved" || event.actor !== "user" || event.itemId !== itemId
      || event.taskId !== member.applicationTaskId || typeof event.idempotencyKey !== "string"
      || !event.idempotencyKey.startsWith("objective-approval-set-command:")
      || !exactKeys(body, "itemId,nextTurnRevision,status,toolCallId,turnId,waitId,waitKind")
      || body.itemId !== itemId || body.waitId !== member.approvalId || body.waitKind !== "approval"
      || body.status !== member.status || body.turnId !== input.turnId || !Number.isSafeInteger(body.nextTurnRevision)
      || body.toolCallId !== objectiveApplicationReviewToolCallId(setId, member.slotOrdinal)) return false
  }
  return grouped.size === members.filter(member => member.status !== "pending").length
}
async function scopeMatches(row: Row, expiresAt: Date): Promise<boolean> {
  const scope = protocolScope({ userId: String(row.userId), sessionId: String(row.sessionId), turnId: String(row.turnId), jobId: String(row.jobId),
    toolCallId: String(row.toolCallId), action: "review_application", resourceHash: String(row.resourceHash), materialHash: String(row.materialHash),
    answersHash: String(row.answersHash), revision: Number(row.revision), expiresAt }, String(row.nonceHash))
  return isApprovalHash(row.resourceHash) && isApprovalHash(row.materialHash) && isApprovalHash(row.answersHash)
    && row.scopeHash === await hashApprovalScope(scope)
}
function memberProof(value: unknown, setId: string, sourceTurnId: string, ordinal: number): ObjectiveApplicationReviewMemberProof | undefined {
  const envelope = record(value), proof = record(envelope?.proof), source = record(proof?.source)
  const witness = parseObjectiveApplicationResumeWitness(proof?.resumeWitness)
  const sourceKeys = "artifactId,contentHash,finalItemId,graphItemId,graphRevision,jobId,reviewerTaskId,reviewerToolCallId,reviewHash,rootTaskId,slotOrdinal,sourceDigest,sourceTurnId,version,writerTaskId"
  if (!envelope || !proof || !source || !witness || !exactKeys(envelope, "schema,setId,slotOrdinal,sourceTurnId,proof")
    || envelope.schema !== MEMBER_SCHEMA || envelope.setId !== setId || envelope.sourceTurnId !== sourceTurnId || envelope.slotOrdinal !== ordinal
    || !exactKeys(proof, "materialProofHash,resumeWitness,schema,source") || proof.schema !== PROOF_SCHEMA
    || !exactKeys(source, sourceKeys) || ![source.jobId, source.sourceTurnId, source.rootTaskId, source.graphItemId, source.finalItemId,
      source.writerTaskId, source.reviewerTaskId, source.reviewerToolCallId, source.artifactId].every(safeId)
    || !Number.isSafeInteger(source.graphRevision) || Number(source.graphRevision) < 1 || source.slotOrdinal !== ordinal
    || !Number.isSafeInteger(source.version) || Number(source.version) < 1
    || ![source.reviewHash, source.contentHash, source.sourceDigest].every(value => typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value))
    || typeof proof.materialProofHash !== "string" || !HASH.test(proof.materialProofHash)
    || witness.jobId !== source.jobId) return undefined
  return { schema: PROOF_SCHEMA, source: source as ObjectiveApplicationReviewMemberProof["source"], resumeWitness: witness,
    materialProofHash: proof.materialProofHash }
}
function row(value: unknown): Row | null { return record(value) }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const keys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return null
    return value as Row
  } catch { return null }
}
function exactKeys(value: Row, csv: string): boolean {
  const keys = csv.split(","), actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
}
function bareHash(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && ID.test(value) }
function date(value: unknown): Date | null {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : null
}
