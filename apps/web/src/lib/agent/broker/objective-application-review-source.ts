import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet, parseObjectiveApplicationReviewIntent,
  parseObjectiveTailorFinalOutcomeSidecar } from "@jobcopilot/agent-protocol"
import { canonicalJson, parseObjectiveApplicationReviewMemberProof, readAgentSelectedJobMaterial,
  type AgentSelectedJobMaterialQueryClient, type AgentSelectedJobQueryParameter } from "@jobcopilot/shared"
import { canonicalTaskGraphItemId, canonicalTaskGraphSourceKey, isCanonicalTaskGraphSourceManifest } from "../session/final-task-graph-source-detail"
import { parseFinalTaskGraphSourceManifest } from "../session/final-task-graph-source-manifest"
import { parseObjectiveTailorProgressSnapshot, type ObjectiveTailorProgressSnapshot } from "../session/objective-tailor-progress-snapshot"
import { objectiveApplicationReviewInputValid, objectiveApplicationReviewPairProof, parseObjectiveApplicationReviewArtifactHead,
  validObjectiveApplicationReviewContent,
  validObjectiveApplicationSourceManifest } from "./objective-application-review-source-proof"
import { waitScopeMismatch } from "./errors"
import type { ObjectiveApprovalSetSourceInput } from "./objective-application-approval-set-decision"

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type Proof = NonNullable<ReturnType<typeof parseObjectiveApplicationReviewMemberProof>>
const REVIEW_GOAL = "Review the selected completed Objective materials for application preparation."
const HASH = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const FINAL_EVENT_PREFIX = "turn:"

/** Rechecks the approved slot against its immutable completed source and current material in the caller's transaction. */
export async function verifyObjectiveApplicationReviewSource(
  tx: Tx, input: ObjectiveApprovalSetSourceInput,
): Promise<"current" | "stale"> {
  const proof = parseObjectiveApplicationReviewMemberProof(input.member.proof)
  if (!proof || !objectiveApplicationReviewInputValid(input, proof)) return integrity()
  const selection = await readReviewSelection(tx, input.member)
  if (!selection || selection.sourceTurnId !== input.sourceTurnId || selection.graphRevision !== proof.source.graphRevision
    || selection.rootTaskId !== proof.source.rootTaskId || selection.graphItemId !== proof.source.graphItemId
    || !selection.slotOrdinals.includes(input.slotOrdinal) || intentHash(selection) !== input.intentHash
    || setId(input.member.sessionId, input.member.turnId) !== input.setId) return integrity()
  const set = await readSetItem(tx, input)
  if (!set) return integrity()
  const source = await readSourceRoot(tx, input, proof)
  if (!source) return integrity()
  const graph = await readGraph(tx, input, proof)
  if (!graph) return integrity()
  if (graph.revision !== proof.source.graphRevision || graph.revision !== selection.graphRevision) return "stale"
  const tasks = await readTasks(tx, input, proof, graph.snapshot)
  if (!tasks) return integrity()
  const final = await readFinal(tx, input, proof, graph, tasks, source.finalItemId)
  if (!final) return integrity()
  const slot = graph.marker.slots[input.slotOrdinal - 1]
  if (final.sidecar.slots[input.slotOrdinal - 1]?.status !== "ready" || !slot) return integrity()
  const material = await readAgentSelectedJobMaterial(prismaMaterialClient(tx), { userId: input.member.userId, jobId: input.member.jobId })
  if (material.preparation.sourceDigest !== proof.source.sourceDigest) return "stale"
  const writerNode = graph.snapshot.nodes.find(node => node.key === (slot.correction?.writerNodeKey ?? slot.writerNodeKey))
  const reviewerNode = graph.snapshot.nodes.find(node => node.key === (slot.correction?.reviewerNodeKey ?? slot.reviewerNodeKey))
  const writer = writerNode && tasks.byId.get(writerNode.taskId), reviewer = reviewerNode && tasks.byId.get(reviewerNode.taskId)
  if (!writerNode || !reviewerNode || !writer || !reviewer || writer.id !== proof.source.writerTaskId
    || reviewer.id !== proof.source.reviewerTaskId) return integrity()
  const pair = objectiveApplicationReviewPairProof({ snapshot: graph.snapshot, slotOrdinal: input.slotOrdinal,
    graphRevision: graph.revision, jobId: input.member.jobId, source: proof.source, writerTask: writer, reviewerTask: reviewer, tasks: tasks.byId })
  if (!pair) return integrity()
  const head = await readArtifactHead(tx, input)
  if (!head) return integrity()
  if (head.artifactId !== proof.source.artifactId || head.version !== proof.source.version || head.hash !== proof.source.contentHash) return "stale"
  if (!await readArtifactReceipt(tx, input, proof, pair.prior)) return integrity()
  return "current"
}

async function readReviewSelection(tx: Tx, member: ObjectiveApprovalSetSourceInput["member"]) {
  const turn = await tx.agentTurn.findFirst({ where: { id: member.turnId, userId: member.userId, sessionId: member.sessionId },
    select: { id: true, status: true, source: true, executionMode: true, input: true, rootTaskId: true } })
  const input = record(turn?.input), intent = exactRecord(input?.intent, ["kind", "selection", "version"])
  const selection = parseObjectiveApplicationReviewIntent(intent?.selection)
  if (!turn || !ID.test(String(turn.rootTaskId)) || turn.rootTaskId === selection?.rootTaskId
    || turn.status !== "waiting_for_approval" || turn.source !== "user" || turn.executionMode !== "canonical_task_graph"
    || !input || !exactKeys(input, ["clientMessageId", "content", "goal", "intent"]) || input.goal !== REVIEW_GOAL
    || !validObjectiveApplicationReviewContent(input.content) || !text(input.clientMessageId) || !intent
    || intent.kind !== "objective_application_review" || intent.version !== 1 || !selection) return null
  return selection
}

async function readSetItem(tx: Tx, input: ObjectiveApprovalSetSourceInput) {
  const itemId = objectiveApplicationApprovalSetItemId(input.setId)
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "type", "status", "phase", "revision", "stepId", "taskId", "content"
    FROM "agent_items" WHERE "id"=${itemId} AND "sessionId"=${input.member.sessionId} AND "turnId"=${input.member.turnId}
      AND "type"='approval_request' FOR SHARE NOWAIT`)
  const item = rows[0], set = item && parseObjectiveApplicationApprovalSet(item.content)
  return rows.length === 1 && item?.id === itemId && item.type === "approval_request" && item.status === "started"
    && item.phase === "commentary" && item.revision === 0 && item.stepId === null && item.taskId === null
    && set?.setId === input.setId && set.sourceTurnId === input.sourceTurnId && set.intentHash === input.intentHash
    && set.members.some(member => member.slotOrdinal === input.slotOrdinal && member.approvalId === input.member.approvalId)
}

async function readSourceRoot(tx: Tx, input: ObjectiveApprovalSetSourceInput, proof: Proof): Promise<{ finalItemId: string } | null> {
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT source."id", source."rootTaskId", source."status", source."source", source."executionMode",
    root."id" AS "rootId", root."status" AS "rootStatus", root."role" AS "rootRole", root."taskType" AS "rootTaskType", root."depth",
    root."result", session."status" AS "sessionStatus"
    FROM "agent_turns" AS source JOIN "agent_sessions" AS session ON session."id"=source."sessionId" AND session."userId"=source."userId"
    JOIN "sub_agent_tasks" AS root ON root."id"=source."rootTaskId" AND root."sessionId"=source."sessionId"
      AND root."turnId"=source."id" AND root."rootTaskId"=root."id" AND root."parentTaskId" IS NULL
    WHERE source."id"=${input.sourceTurnId} AND source."sessionId"=${input.member.sessionId} AND source."userId"=${input.member.userId}
      AND source."status"='completed' AND source."source"='user' AND source."executionMode"='canonical_task_graph'
      AND root."status"='completed' AND root."role"='orchestrator' AND root."taskType"='root' AND root."depth"=0
      AND session."status" NOT IN ('aborted','archived') FOR SHARE OF source,root NOWAIT`)
  const row = rows[0], result = record(parseJson(row?.result)), finalItemId = result?.finalItemId
  return rows.length === 1 && row?.id === input.sourceTurnId && row.rootId === proof.source.rootTaskId
    && row.rootTaskId === proof.source.rootTaskId && row.sessionStatus !== "aborted" && row.sessionStatus !== "archived"
    && result?.status === "completed" && typeof finalItemId === "string" && ID.test(finalItemId) ? { finalItemId } : null
}

async function readGraph(tx: Tx, input: ObjectiveApprovalSetSourceInput, proof: Proof) {
  const id = canonicalTaskGraphItemId(proof.source.rootTaskId)
  if (id !== proof.source.graphItemId) return null
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "revision", "content" FROM "agent_items"
    WHERE "id"=${id} AND "sessionId"=${input.member.sessionId} AND "turnId"=${input.sourceTurnId}
      AND "taskId"=${proof.source.rootTaskId} AND "type"='task_graph' FOR SHARE NOWAIT`)
  const row = rows[0], content = record(parseJson(row?.content)), snapshot = parseObjectiveTailorProgressSnapshot(content)
  if (rows.length !== 1 || row?.id !== id || !snapshot || !Number.isSafeInteger(row.revision)) return null
  return { revision: Number(row.revision), content: content!, marker: snapshot.marker, snapshot }
}

async function readTasks(tx: Tx, input: ObjectiveApprovalSetSourceInput, proof: Proof, snapshot: ObjectiveTailorProgressSnapshot) {
  const ids = [proof.source.rootTaskId, ...snapshot.nodes.map(node => node.taskId)]
  if (new Set(ids).size !== ids.length) return null
  const result = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
    task."role", task."taskType", task."status", task."result", task."context", session."userId", turn."userId" AS "turnUserId",
    turn."rootTaskId" AS "turnRootTaskId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id"=task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id"=task."turnId" AND turn."sessionId"=task."sessionId"
    WHERE task."id"=ANY(${ids}::text[]) AND task."sessionId"=${input.member.sessionId} AND task."turnId"=${input.sourceTurnId}
      AND task."rootTaskId"=${proof.source.rootTaskId} AND session."userId"=${input.member.userId} AND turn."userId"=${input.member.userId}
      AND turn."rootTaskId"=${proof.source.rootTaskId} ORDER BY task."id" FOR SHARE OF task NOWAIT`)
  if (result.length !== ids.length || result.some(row => row.userId !== input.member.userId || row.turnUserId !== input.member.userId
    || row.sessionId !== input.member.sessionId || row.turnId !== input.sourceTurnId || row.rootTaskId !== proof.source.rootTaskId
    || row.turnRootTaskId !== proof.source.rootTaskId) || new Set(result.map(row => row.id)).size !== ids.length) return null
  const byId = new Map(result.map(row => [String(row.id), row])), root = byId.get(proof.source.rootTaskId)
  if (!root || root.parentTaskId !== null || root.role !== "orchestrator" || root.taskType !== "root" || root.status !== "completed") return null
  for (const node of snapshot.nodes) {
    const task = byId.get(node.taskId), expected = node.templateId === "scout" ? ["scout", "job_discovery"]
      : node.templateId === "analyst" ? ["analyst", "job_analysis"]
        : node.templateId === "cover_letter_writer" ? ["writer", "cover_letter_draft"] : ["reviewer", "cover_letter_review"]
    if (!task || task.parentTaskId !== proof.source.rootTaskId || task.role !== expected[0] || task.taskType !== expected[1]) return null
  }
  return { byId }
}

async function readFinal(tx: Tx, input: ObjectiveApprovalSetSourceInput, proof: Proof,
  graph: Awaited<ReturnType<typeof readGraph>> & {}, tasks: NonNullable<Awaited<ReturnType<typeof readTasks>>>, finalItemId: string) {
  const key = `${FINAL_EVENT_PREFIX}${input.sourceTurnId}:event:turn-completed`
  const events = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "itemId", "taskId", "actor", "type", "idempotencyKey", "payload"
    FROM "agent_events" WHERE "sessionId"=${input.member.sessionId} AND "turnId"=${input.sourceTurnId}
      AND "type"='turn.completed' AND "idempotencyKey"=${key} FOR SHARE NOWAIT`)
  const event = events[0], payload = record(parseJson(event?.payload))
  if (events.length !== 1 || event?.itemId !== finalItemId || event.taskId !== proof.source.rootTaskId
    || event.actor !== "orchestrator" || event.type !== "turn.completed" || event.idempotencyKey !== key
    || payload?.turnId !== input.sourceTurnId || payload.taskId !== proof.source.rootTaskId || payload.finalItemId !== finalItemId) return null
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "sessionId", "turnId", "taskId", "type", "status", "phase", "content"
    FROM "agent_items" WHERE "id"=${finalItemId} AND "sessionId"=${input.member.sessionId} AND "turnId"=${input.sourceTurnId}
      AND "taskId"=${proof.source.rootTaskId} AND "type"='agent_message' AND "status"='completed' AND "phase"='final_answer'
    FOR SHARE NOWAIT`)
  const item = rows[0], content = record(parseJson(item?.content)), answer = record(content?.final)
  const manifest = parseFinalTaskGraphSourceManifest(content?.taskGraphSources)
  const sidecar = parseObjectiveTailorFinalOutcomeSidecar(content?.objectiveTailorFinalOutcomes)
  if (rows.length !== 1 || item?.id !== finalItemId || item.sessionId !== input.member.sessionId || item.turnId !== input.sourceTurnId
    || item.taskId !== proof.source.rootTaskId || typeof content?.text !== "string" || answer?.schemaVersion !== "agent-harness.v2.final"
    || answer.response !== content.text || !manifest || manifest.graphRevision !== proof.source.graphRevision
    || !isCanonicalTaskGraphSourceManifest(finalItemId, manifest) || !sidecar || sidecar.slots.length !== graph.marker.slots.length
    || !validObjectiveApplicationSourceManifest(manifest, finalItemId, graph.snapshot, tasks.byId)) return null
  return { sidecar }
}

async function readArtifactHead(tx: Tx, input: ObjectiveApprovalSetSourceInput) {
  const rows = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "id", "version", "hash" FROM "agent_artifact"
    WHERE "userId"=${input.member.userId} AND "jobId"=${input.member.jobId} AND "artifactType"='cover_letter'
      AND "lifecycle"='draft' ORDER BY "id" FOR SHARE NOWAIT`)
  return rows.length === 1 ? parseObjectiveApplicationReviewArtifactHead(rows[0]) ?? null : null
}

async function readArtifactReceipt(tx: Tx, input: ObjectiveApprovalSetSourceInput, proof: Proof,
  prior: Readonly<{ writerTaskId: string; reviewerTaskId: string; artifactRef: { artifactId: string; version: number; contentHash: string; sourceDigest: string };
    reviewHash: string; toolCallId: string }> | undefined): Promise<boolean> {
  const source = proof.source
  const versions = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "artifactId", "version", "artifactType", "taskId", "contentHash", "sourceDigest", "previousHash"
    FROM "agent_artifact_version" WHERE "userId"=${input.member.userId} AND "sessionId"=${input.member.sessionId}
      AND "jobId"=${input.member.jobId} AND "artifactId"=${source.artifactId} AND "version"=${source.version}
      AND "contentHash"=${source.contentHash} AND "sourceDigest"=${source.sourceDigest} AND "taskId"=${source.writerTaskId}
      AND "artifactType"='cover_letter' FOR SHARE NOWAIT`)
  const reviews = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest",
    "status", "taskId", "toolCallId", "reviewHash" FROM "agent_artifact_review"
    WHERE "userId"=${input.member.userId} AND "sessionId"=${input.member.sessionId} AND "jobId"=${input.member.jobId}
      AND "artifactId"=${source.artifactId} AND "version"=${source.version} AND "contentHash"=${source.contentHash}
      AND "sourceDigest"=${source.sourceDigest} AND "currentSourceDigest"=${source.sourceDigest} AND "status"='passed'
      AND "taskId"=${source.reviewerTaskId} AND "toolCallId"=${source.reviewerToolCallId} AND "reviewHash"=${source.reviewHash}
    FOR SHARE NOWAIT`)
  const version = versions[0], review = reviews[0]
  if (versions.length !== 1 || reviews.length !== 1 || !version || !review || version.artifactId !== source.artifactId
    || version.version !== source.version || version.taskId !== source.writerTaskId
    || prior !== undefined && version.previousHash !== prior.artifactRef.contentHash
    || review.taskId !== source.reviewerTaskId || review.toolCallId !== source.reviewerToolCallId
    || review.reviewHash !== source.reviewHash || review.status !== "passed") return false
  if (!prior) return true
  if (prior.artifactRef.artifactId !== source.artifactId || source.version !== prior.artifactRef.version + 1
    || prior.writerTaskId === source.writerTaskId || prior.reviewerTaskId === source.reviewerTaskId) return false
  const previousVersions = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "artifactId", "version", "artifactType", "taskId", "contentHash", "sourceDigest"
    FROM "agent_artifact_version" WHERE "userId"=${input.member.userId} AND "sessionId"=${input.member.sessionId}
      AND "jobId"=${input.member.jobId} AND "artifactId"=${prior.artifactRef.artifactId}
      AND "version"=${prior.artifactRef.version} AND "contentHash"=${prior.artifactRef.contentHash}
      AND "sourceDigest"=${prior.artifactRef.sourceDigest} AND "taskId"=${prior.writerTaskId} AND "artifactType"='cover_letter' FOR SHARE NOWAIT`)
  const previousReviews = await tx.$queryRaw<Row[]>(Prisma.sql`SELECT "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest",
    "status", "taskId", "toolCallId", "reviewHash" FROM "agent_artifact_review"
    WHERE "userId"=${input.member.userId} AND "sessionId"=${input.member.sessionId} AND "jobId"=${input.member.jobId}
      AND "artifactId"=${prior.artifactRef.artifactId} AND "version"=${prior.artifactRef.version}
      AND "contentHash"=${prior.artifactRef.contentHash} AND "sourceDigest"=${prior.artifactRef.sourceDigest}
      AND "currentSourceDigest"=${prior.artifactRef.sourceDigest} AND "status"='needs_revision'
      AND "taskId"=${prior.reviewerTaskId} AND "toolCallId"=${prior.toolCallId} AND "reviewHash"=${prior.reviewHash} FOR SHARE NOWAIT`)
  return previousVersions.length === 1 && previousReviews.length === 1
}

function prismaMaterialClient(tx: Tx): AgentSelectedJobMaterialQueryClient {
  return { query: async <T>(sql: string, values: readonly AgentSelectedJobQueryParameter[]) => ({
    rows: await tx.$queryRawUnsafe<T[]>(sql, ...values),
  }) }
}
function integrity(): never { throw waitScopeMismatch() }
function intentHash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }
function setId(sessionId: string, turnId: string): string {
  return `objective-review-${createHash("sha256").update(`objective-application-review-set.v1\0${sessionId}\0${turnId}`).digest("hex").slice(0, 40)}`
}
function text(value: unknown): boolean { return typeof value === "string" && value.length > 0 && value.length <= 128 && value.trim() === value }
function structured(value: unknown): Record<string, unknown> | undefined {
  const envelope = record(parseJson(value)), result = envelope && record(envelope.structuredResult)
  return envelope && exactKeys(envelope, ["finalItemId", "finalText", "status", "stepCount", "structuredResult", "toolCallCount"])
    && envelope.status === "completed" && result && typeof result.role === "string"
    && (result.status === "completed" || result.status === "partial") ? result : undefined
}
function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return undefined } }
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
        && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Row : undefined
  } catch { return undefined }
}
function exactRecord(value: unknown, keys: readonly string[]): Row | undefined {
  const row = record(value)
  return row && exactKeys(row, keys) ? row : undefined
}
function exactKeys(value: Row, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
