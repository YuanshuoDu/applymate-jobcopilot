import type { Pool, PoolClient } from "pg"
import {
  OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA,
  objectiveApplicationApprovalSetItemId,
  parseObjectiveApplicationReviewIntent,
} from "@jobcopilot/agent-protocol"
import {
  canonicalJson,
  objectiveApplicationApprovedIntentId,
  objectiveReviewedFillHandoffIdempotencyKey,
  parseObjectiveApplicationApprovedIntent,
  parseObjectiveApplicationReviewMemberProof,
  parseObjectiveReviewedFillSource,
  type ObjectiveApplicationApprovedIntent,
  type ObjectiveApplicationReviewMemberProof,
  type ObjectiveReviewedFillSource,
  type ObjectiveApplicationResumeWitness,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId,
  readObjectiveApplicationReviewSetState } from "./objective-application-review-set-state.js"
import { readObjectiveApplicationResumeMaterial } from "./approval/objective-application-resume-witness.js"
import { readCompletedObjectiveTailorSourceEvidence } from "./subagents/objective-tailor-completed-source.js"
import type { SelectedJobReviewedArtifact } from "./selected-job-reviewed-artifact-read.js"
import { acquireSourceMaterialFence } from "../db/source-material-fence.js"

type Row = Record<string, unknown>
type Queryable = Pick<PoolClient, "query">
export type ObjectiveReviewedFillReadPhase = "prepare" | "browser_start" | "completion" | "completion_replay"
export type ObjectiveReviewedFillReadInput = Readonly<{ userId: string; sessionId: string; fillTurnId: string;
  applicationTaskId: string; jobId: string; turnInput: unknown; phase: ObjectiveReviewedFillReadPhase; now?: Date }>
export type ObjectiveReviewedApplicationFillEvidence = Readonly<{
  source: ObjectiveReviewedFillSource
  approvedIntent: ObjectiveApplicationApprovedIntent
  proof: ObjectiveApplicationReviewMemberProof
  reviewedArtifact: SelectedJobReviewedArtifact
  resumeWitness: ObjectiveApplicationResumeWitness
  resumeContent: unknown
}>

/** Opens a fenced read transaction for the pre-PDF exact source snapshot. */
export async function readObjectiveReviewedApplicationFillSourceFromPool(
  pool: Pick<Pool, "connect">, input: ObjectiveReviewedFillReadInput,
): Promise<ObjectiveReviewedApplicationFillEvidence | undefined> {
  if (!validInput(input)) return undefined
  const client = await pool.connect()
  let open = false
  try {
    await client.query("BEGIN"); open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.userId])
    await acquireSourceMaterialFence(client, [input.userId])
    const evidence = await readObjectiveReviewedApplicationFillSource(client, input)
    await client.query("COMMIT"); open = false
    return evidence
  } catch {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    return undefined
  } finally { client.release() }
}

/** Rebuilds one approved Objective slot on the caller's source-fenced fill transaction. */
export async function readObjectiveReviewedApplicationFillSource(
  client: Queryable, input: ObjectiveReviewedFillReadInput,
): Promise<ObjectiveReviewedApplicationFillEvidence | undefined> {
  const source = parseObjectiveReviewedFillSource(input.turnInput)
  if (!source || !validInput(input)) return undefined
  try {
    const row = await readApprovedIntentEvent(client, input, source)
    const intent = parseObjectiveApplicationApprovedIntent(row?.data)
    if (!row || !intent || row.id !== objectiveApplicationApprovedIntentId(intent.setId, intent.slotOrdinal)
      || row.taskId !== input.applicationTaskId || row.type !== "objective_application_review_approved"
      || row.actor !== "user" || row.body !== "Objective application review approval recorded."
      || intent.userId !== input.userId || intent.sessionId !== input.sessionId || intent.applicationTaskId !== input.applicationTaskId
      || intent.jobId !== input.jobId || intent.approvalId !== source.approvalId || intent.reviewTurnId !== source.reviewTurnId
      || intent.materialProofHash !== source.materialProofHash) return undefined

    const review = await readReviewIntent(client, input, intent.reviewTurnId)
    const selection = review && parseObjectiveApplicationReviewIntent(review.selection)
    if (!review || !selection || selection.schema !== OBJECTIVE_APPLICATION_REVIEW_INTENT_SCHEMA
      || selection.sourceTurnId !== intent.sourceTurnId || selection.slotOrdinals.length === 0
      || !selection.slotOrdinals.includes(intent.slotOrdinal)
      || objectiveApplicationReviewSetId(input.sessionId, intent.reviewTurnId) !== intent.setId) return undefined

    const setState = await readObjectiveApplicationReviewSetState(client, { userId: input.userId, sessionId: input.sessionId,
      turnId: intent.reviewTurnId, selection, now: input.now ?? new Date() })
    const member = setState?.members.find(value => value.slotOrdinal === intent.slotOrdinal)
    if (!setState || setState.status !== "resolved" || setState.setId !== intent.setId
      || setState.itemId !== objectiveApplicationApprovalSetItemId(intent.setId)
      || setState.intentHash !== objectiveApplicationReviewIntentHash(selection)
      || !member || member.status !== "approved" || member.approvalId !== intent.approvalId
      || member.applicationTaskId !== input.applicationTaskId || member.jobId !== input.jobId
      || member.proof.materialProofHash !== source.materialProofHash) return undefined

    const proof = parseObjectiveApplicationReviewMemberProof(member.proof)
    if (!proof || !matchesIntent(proof, intent, selection)
      || !await approvalAndFillTurnValid(client, input, intent, source)) return undefined
    const evidence = await readCompletedObjectiveTailorSourceEvidence(client, { userId: input.userId, sessionId: input.sessionId,
      reviewTurnId: intent.reviewTurnId, reviewTurnMode: "completed", sourceTurnId: intent.sourceTurnId,
      rootTaskId: proof.source.rootTaskId, graphItemId: proof.source.graphItemId, graphRevision: proof.source.graphRevision,
      selectedSlotIds: [`tailor-${intent.slotOrdinal}`] })
    const outcome = evidence?.outcomes[0]
    if (!evidence || evidence.sourceTurnId !== intent.sourceTurnId || evidence.reviewTurnId !== intent.reviewTurnId
      || evidence.sourceRootTaskId !== proof.source.rootTaskId || evidence.graphItemId !== proof.source.graphItemId
      || evidence.graphRevision !== proof.source.graphRevision || evidence.finalItemId !== proof.source.finalItemId
      || !outcome || outcome.status !== "ready"
      || !outcome.artifactRef || !sameOutcome(outcome, intent, proof)) return undefined
    const resume = await readObjectiveApplicationResumeMaterial(client, { userId: input.userId, jobId: input.jobId })
    const task = await readApplicationTask(client, input)
    if (!resume || canonicalJson(resume.witness) !== canonicalJson(proof.resumeWitness)
      || !task || task.resumeId !== resume.witness.resumeId || task.fillTurnId !== input.fillTurnId
      || task.fillTurnSessionId !== input.sessionId || task.fillTurnUserId !== input.userId) return undefined
    const content = await readArtifactContent(client, input, proof)
    if (content === undefined) return undefined
    return { source, approvedIntent: intent, proof, resumeWitness: resume.witness, resumeContent: resume.resumeContent,
      reviewedArtifact: { sourceTurnId: proof.source.sourceTurnId, rootTaskId: proof.source.rootTaskId,
        graphRevision: proof.source.graphRevision, jobId: proof.source.jobId, writerTaskId: proof.source.writerTaskId,
        reviewerTaskId: proof.source.reviewerTaskId, reviewerToolCallId: proof.source.reviewerToolCallId,
        reviewHash: proof.source.reviewHash, artifactId: proof.source.artifactId, version: proof.source.version,
        contentHash: proof.source.contentHash, sourceDigest: proof.source.sourceDigest, content } }
  } catch { return undefined }
}

async function readApprovedIntentEvent(client: Queryable, input: ObjectiveReviewedFillReadInput, source: ObjectiveReviewedFillSource): Promise<Row | undefined> {
  const result = await client.query<Row>(`SELECT event."id", event."taskId", event."type", event."actor", event."body", event."data"
    FROM "application_task_events" AS event JOIN "application_tasks" AS app ON app."id"=event."taskId"
    WHERE event."taskId"=$1 AND event."type"='objective_application_review_approved' AND event."data"->>'approvalId'=$5
      AND app."id"=$1 AND app."userId"=$2 AND app."sessionId"=$3 AND app."jobId"=$4
    FOR SHARE OF event, app`, [input.applicationTaskId, input.userId, input.sessionId, input.jobId, source.approvalId])
  if (result.rows.length !== 1) return undefined
  const row = record(result.rows[0]), intent = parseObjectiveApplicationApprovedIntent(row?.data)
  return intent?.approvalId === source.approvalId && intent.reviewTurnId === source.reviewTurnId
    && intent.materialProofHash === source.materialProofHash ? row : undefined
}

async function readReviewIntent(client: Queryable, input: ObjectiveReviewedFillReadInput, reviewTurnId: string): Promise<{ selection: unknown } | undefined> {
  const result = await client.query<Row>(`SELECT "status", "source", "executionMode", "input" FROM "agent_turns"
    WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 FOR SHARE NOWAIT`, [reviewTurnId, input.sessionId, input.userId])
  const row = record(result.rows[0]), turnInput = record(row?.input), envelope = record(turnInput?.intent)
  return result.rows.length === 1 && row?.status === "completed" && row.source === "user" && row.executionMode === "canonical_task_graph"
    && exactKeys(turnInput, "clientMessageId,content,goal,intent") && exactKeys(envelope, "kind,selection,version")
    && envelope?.kind === "objective_application_review" && envelope.version === 1
    ? { selection: envelope.selection } : undefined
}

async function approvalAndFillTurnValid(client: Queryable, input: ObjectiveReviewedFillReadInput, intent: ObjectiveApplicationApprovedIntent,
  source: ObjectiveReviewedFillSource): Promise<boolean> {
  const result = await client.query<Row>(`SELECT approval."status", approval."expiresAt", approval."decidedAt", approval."consumedAt", approval."materialHash",
      fill."createdAt" AS "fillCreatedAt", fill."source" AS "fillSource", fill."executionMode" AS "fillExecutionMode",
      fill."status" AS "fillStatus", fill."input" AS "fillInput"
    FROM "agent_approvals" AS approval JOIN "agent_turns" AS fill ON fill."id"=$7
      AND fill."sessionId"=approval."sessionId" AND fill."userId"=approval."userId"
    WHERE approval."id"=$1 AND approval."userId"=$2 AND approval."sessionId"=$3 AND approval."turnId"=$4
      AND approval."taskId"=$5 AND approval."jobId"=$6 AND approval."type"='review_application'
      AND fill."id"=$7 AND fill."sessionId"=$3 AND fill."userId"=$2
    FOR SHARE OF approval, fill`,
  [intent.approvalId, input.userId, input.sessionId, intent.reviewTurnId, input.applicationTaskId, input.jobId, input.fillTurnId])
  const row = record(result.rows[0]), expires = date(row?.expiresAt), decided = date(row?.decidedAt)
  const created = date(row?.fillCreatedAt)
  const expectedTurnStatus = input.phase === "completion_replay" ? ["waiting_for_approval"]
    : input.phase === "completion" ? ["queued", "in_progress", "waiting_for_dependency"] : ["in_progress"]
  return result.rows.length === 1 && row?.status === "approved" && row.materialHash === intent.materialProofHash
    && row.consumedAt === null && !!expires && !!decided && !!created && decided <= created && created <= expires
    && row.fillSource === "user" && row.fillExecutionMode === "canonical_task_graph"
    && expectedTurnStatus.includes(String(row.fillStatus))
    && sameSelector(parseObjectiveReviewedFillSource(row.fillInput), source)
    && exactFillInput(row.fillInput, source, intent.approvalId)
}

function exactFillInput(value: unknown, source: ObjectiveReviewedFillSource, approvalId: string): boolean {
  const input = record(value), key = objectiveReviewedFillHandoffIdempotencyKey(approvalId)
  const content = input?.content
  return !!input && !!key && exactKeys(input, "clientMessageId,content,goal,reviewedApplicationMaterialSource")
    && input.clientMessageId === key && input.goal === "Fill the server-bound application form for user review. Never submit it."
    && Array.isArray(content) && content.length === 1 && record(content[0])?.type === "text"
    && record(content[0])?.text === "Fill the server-bound application form for user review. Never submit it."
    && sameSelector(parseObjectiveReviewedFillSource(input), source)
}

async function readApplicationTask(client: Queryable, input: ObjectiveReviewedFillReadInput): Promise<{ resumeId: string; fillTurnId: string; fillTurnSessionId: string;
  fillTurnUserId: string; status: string; checkpoint: string | null } | undefined> {
  const result = await client.query<Row>(`SELECT "id", "userId", "sessionId", "jobId", "resumeId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint" FROM "application_tasks"
    WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "jobId"=$4 FOR SHARE`,
  [input.applicationTaskId, input.userId, input.sessionId, input.jobId])
  const row = record(result.rows[0])
  const expected = input.phase === "completion_replay" ? { status: "waiting_for_authorization", checkpoint: "form_filled" }
    : input.phase === "completion" ? { status: "filling", checkpoint: "browser_active" }
      : { status: "filling", checkpoint: "taskgraph_fill_queued" }
  return result.rows.length === 1 && row?.id === input.applicationTaskId && safeId(row.resumeId)
    && row.fillTurnId === input.fillTurnId && row.fillTurnSessionId === input.sessionId && row.fillTurnUserId === input.userId
    && row.status === expected.status && row.checkpoint === expected.checkpoint
    ? { resumeId: row.resumeId, fillTurnId: input.fillTurnId, fillTurnSessionId: input.sessionId, fillTurnUserId: input.userId,
      status: expected.status, checkpoint: expected.checkpoint } : undefined
}

async function readArtifactContent(client: Queryable, input: ObjectiveReviewedFillReadInput, proof: ObjectiveApplicationReviewMemberProof): Promise<string | undefined> {
  const source = proof.source
  const result = await client.query<Row>(`SELECT "content", "artifactType", "taskId", "contentHash", "sourceDigest"
    FROM "agent_artifact_version" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4
      AND "version"=$5 FOR SHARE`, [input.userId, input.sessionId, input.jobId, source.artifactId, source.version])
  const row = record(result.rows[0]), content = row?.content
  return result.rows.length === 1 && typeof content === "string" && content.trim().length > 0 && content.length <= 20_000
    && row?.artifactType === "cover_letter" && row.taskId === source.writerTaskId && row.contentHash === source.contentHash
    && row.sourceDigest === source.sourceDigest && hashArtifactContent(content) === source.contentHash ? content : undefined
}

function matchesIntent(proof: ObjectiveApplicationReviewMemberProof, intent: ObjectiveApplicationApprovedIntent,
  selection: ReturnType<typeof parseObjectiveApplicationReviewIntent>): boolean {
  const source = proof.source
  return proof.materialProofHash === intent.materialProofHash && source.jobId === intent.jobId
    && source.sourceTurnId === intent.sourceTurnId && source.slotOrdinal === intent.slotOrdinal && !!selection
    && source.rootTaskId === selection.rootTaskId && source.graphItemId === selection.graphItemId
    && source.graphRevision === selection.graphRevision
}
function sameSelector(left: ObjectiveReviewedFillSource | null, right: ObjectiveReviewedFillSource): boolean {
  return !!left && left.schemaVersion === right.schemaVersion && left.approvalId === right.approvalId
    && left.reviewTurnId === right.reviewTurnId && left.materialProofHash === right.materialProofHash
}
function sameOutcome(outcome: NonNullable<Awaited<ReturnType<typeof readCompletedObjectiveTailorSourceEvidence>>>["outcomes"][number],
  intent: ObjectiveApplicationApprovedIntent, proof: ObjectiveApplicationReviewMemberProof): boolean {
  const source = proof.source, receipt = outcome.reviewReceipt, ref = outcome.artifactRef
  return outcome.slotId === `tailor-${intent.slotOrdinal}` && outcome.jobId === intent.jobId
    && outcome.writerTaskId === source.writerTaskId && outcome.reviewerTaskId === source.reviewerTaskId
    && ref?.artifactId === source.artifactId && ref.version === source.version && ref.contentHash === source.contentHash
    && ref.sourceDigest === source.sourceDigest && receipt?.taskId === source.reviewerTaskId && receipt.status === "passed"
    && receipt.artifactId === source.artifactId && receipt.version === source.version && receipt.contentHash === source.contentHash
    && receipt.sourceDigest === source.sourceDigest && receipt.currentSourceDigest === source.sourceDigest
    && receipt.toolCallId === source.reviewerToolCallId && receipt.reviewHash === source.reviewHash
}
function validInput(input: ObjectiveReviewedFillReadInput): boolean {
  return [input.userId, input.sessionId, input.fillTurnId, input.applicationTaskId, input.jobId].every(safeId)
    && ["prepare", "browser_start", "completion", "completion_replay"].includes(input.phase)
    && (input.now === undefined || input.now instanceof Date && Number.isFinite(input.now.getTime()))
}
function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined }
  catch { return undefined }
}
function exactKeys(value: unknown, expected: string): boolean {
  const row = record(value), keys = expected.split(",")
  if (!row) return false
  try { const own = Reflect.ownKeys(row); return own.length === keys.length && own.every(key => typeof key === "string"
    && keys.includes(key) && Object.hasOwn(Object.getOwnPropertyDescriptor(row, key) ?? {}, "value")) } catch { return false }
}
function date(value: unknown): Date | undefined {
  const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined
}
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
