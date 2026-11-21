import type { PoolClient } from "pg"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "../db/agent-artifact-repo.js"
import { hashArtifactContent } from "./subagents/artifact-adapters.js"
import { currentTaskGraph } from "./subagents/task-graph-pg-current-node.js"
import { loadTaskGraph } from "./subagents/task-graph-pg-state.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphArtifactProjectionReference } from "./subagents/task-graph-command-port.js"
import { readSelectedJobSourceDigestWithClient } from "./subagents/selected-job-artifact-context.js"
import { restoreToolCallState } from "./turns/persisted-tool-call-state.js"

const WRITER = "cover_letter_writer"
const REVIEWER = "cover_letter_reviewer"
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const MAX_CONTENT_LENGTH = 20_000
type Queryable = Pick<PoolClient, "query">
type RecordValue = Record<string, unknown>

export type SelectedJobReviewedArtifact = Readonly<{
  sourceTurnId: string
  rootTaskId: string
  graphRevision: number
  jobId: string
  writerTaskId: string
  reviewerTaskId: string
  reviewerToolCallId: string
  reviewHash: string
  artifactId: string
  version: number
  contentHash: string
  sourceDigest: string
  content: string
}>

/** Reads the exact completed selected-job review without recreating a historical lease. */
export async function readSelectedJobReviewedArtifactWithClient(
  client: Queryable,
  input: Readonly<{ userId: string; sessionId: string; jobId: string; sourceTurnId: string }>,
): Promise<SelectedJobReviewedArtifact | null> {
  if (![input.userId, input.sessionId, input.jobId, input.sourceTurnId].every(value => text(value, 256))) return null
  try {
    const turn = await readCompletedSourceTurn(client, input)
    if (!turn) return null
    const loaded = await loadTaskGraph(client, {
      userId: input.userId, sessionId: input.sessionId, turnId: input.sourceTurnId,
      rootTaskId: turn.rootTaskId, parentTaskId: turn.rootTaskId,
    }, false)
    if (!loaded.item || !loaded.snapshot || !loaded.state) return null
    const lineage = latestPassedLineage(loaded.snapshot.nodes, currentTaskGraph(loaded))
    if (!lineage) return null
    const { artifactRef } = lineage
    const sourceDigest = await readSelectedJobSourceDigestWithClient(client, input.userId, input.jobId)
    if (sourceDigest !== artifactRef.sourceDigest) return null
    const head = await findCurrentDraftHeadWithClient(client, {
      userId: input.userId, sessionId: input.sessionId, jobId: input.jobId, artifactId: artifactRef.artifactId,
    })
    if (!head || !sameReference({ artifactId: head.artifactId, version: head.version, contentHash: head.contentHash, sourceDigest: head.sourceDigest }, artifactRef)) return null
    const review = await findReviewReceiptWithClient(client, {
      userId: input.userId, sessionId: input.sessionId, jobId: input.jobId,
      artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash: artifactRef.contentHash,
      sourceDigest: artifactRef.sourceDigest, currentSourceDigest: sourceDigest, status: "passed",
      taskId: lineage.reviewerTaskId, reviewHash: lineage.reviewHash,
    })
    if (!review || review.userId !== input.userId || review.sessionId !== input.sessionId || review.jobId !== input.jobId
      || review.artifactId !== artifactRef.artifactId || review.version !== artifactRef.version
      || review.contentHash !== artifactRef.contentHash || review.sourceDigest !== artifactRef.sourceDigest
      || review.currentSourceDigest !== sourceDigest || review.status !== "passed" || review.taskId !== lineage.reviewerTaskId
      || review.reviewHash !== lineage.reviewHash || review.toolCallId.length > 256) return null
    const version = await readArtifactContent(client, input, artifactRef, lineage.writerTaskId)
    if (!version || !await hasWrittenArtifactReceipt(client, input, lineage, artifactRef, version.toolCallId)
      || !await hasPassedToolReceipt(client, input, lineage, artifactRef, review.toolCallId)) return null
    if (await readSelectedJobSourceDigestWithClient(client, input.userId, input.jobId) !== sourceDigest) return null
    return {
      sourceTurnId: input.sourceTurnId, rootTaskId: turn.rootTaskId, graphRevision: loaded.item.revision,
      jobId: input.jobId, writerTaskId: lineage.writerTaskId, reviewerTaskId: lineage.reviewerTaskId,
      reviewerToolCallId: review.toolCallId, reviewHash: lineage.reviewHash,
      artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash: artifactRef.contentHash,
      sourceDigest, content: version.content,
    }
  } catch {
    return null
  }
}

async function readCompletedSourceTurn(client: Queryable, input: Readonly<{ userId: string; sessionId: string; jobId: string; sourceTurnId: string }>): Promise<{ rootTaskId: string } | null> {
  const result = await client.query(`SELECT turn."input", turn."rootTaskId", turn."status" AS "turnStatus",
      turn."source" AS "turnSource", turn."executionMode", root."status" AS "rootStatus",
      root."role" AS "rootRole", root."taskType" AS "rootTaskType", root."depth" AS "rootDepth"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
      AND root."turnId" = turn."id" AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND session."userId" = $3
      AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph' AND turn."status" = 'completed'
      AND root."role" = 'orchestrator' AND root."taskType" = 'root' AND root."depth" = 0 AND root."status" = 'completed'`,
  [input.sourceTurnId, input.sessionId, input.userId])
  if (result.rows.length !== 1) return null
  const row = record(result.rows[0]), rootTaskId = row?.rootTaskId
  if (!row || !text(rootTaskId, 256) || row.turnStatus !== "completed" || row.turnSource !== "user"
    || row.executionMode !== "canonical_task_graph" || row.rootStatus !== "completed" || row.rootRole !== "orchestrator"
    || row.rootTaskType !== "root" || row.rootDepth !== 0 || !selectedJobInput(row.input, input.jobId)) return null
  return { rootTaskId }
}

function selectedJobInput(value: unknown, jobId: string): boolean {
  const input = record(value), intent = record(input?.intent), selected = record(input?.selectedJobPreparation)
  if (!input || !selected || !exactKeys(selected, "jobId") || selected.jobId !== jobId) return false
  if (Object.hasOwn(input, "intent")) return Boolean(intent && exactKeys(intent, "kind,version")
    && intent.kind === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind && intent.version === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version)
  return exactKeys(input, "clientMessageId,content,goal,selectedJobPreparation")
    && text(input.clientMessageId, 256) && typeof input.goal === "string" && Array.isArray(input.content)
}

function latestPassedLineage(snapshot: readonly { key: string; taskId: string; templateId: string; dependsOn: readonly string[] }[], graph: ReturnType<typeof currentTaskGraph>): {
  writerTaskId: string; reviewerTaskId: string; reviewHash: string; artifactRef: TaskGraphArtifactProjectionReference
} | null {
  if (graph.nodes.length !== snapshot.length) return null
  const byKey = new Map(snapshot.map(node => [node.key, node] as const))
  const nodes = graph.nodes
  const writers: Array<{ key: string; taskId: string; ref: TaskGraphArtifactProjectionReference }> = []
  const reviewers: Array<{ taskId: string; dependsOn: readonly string[]; ref: TaskGraphArtifactProjectionReference; hash: string; status: string }> = []
  for (const node of nodes) {
    const projection = record(node.resultProjection), role = projection?.role
    const writerCandidate = node.templateId === WRITER || role === "writer"
    const reviewerCandidate = node.templateId === REVIEWER || role === "reviewer"
    if (writerCandidate && reviewerCandidate) return null
    if (!writerCandidate && !reviewerCandidate) continue
    const stored = byKey.get(node.key)
    if (!stored || stored.taskId !== node.taskId || node.status !== "completed") return null
    if (writerCandidate) {
      const ref = projectedReference(projection, "writer")
      if (stored.templateId !== WRITER || !ref) return null
      writers.push({ key: stored.key, taskId: stored.taskId, ref })
    } else {
      const ref = projectedReference(projection, "reviewer")
      if (stored.templateId !== REVIEWER || !ref || !projection || typeof projection.reviewHash !== "string" || !SHA256.test(projection.reviewHash)
        || typeof projection.reviewStatus !== "string") return null
      reviewers.push({ taskId: stored.taskId, dependsOn: stored.dependsOn, ref, hash: projection.reviewHash, status: projection.reviewStatus })
    }
  }
  if (!writers.length || !reviewers.length || new Set(writers.map(node => node.ref.artifactId)).size !== 1) return null
  const latestVersion = Math.max(...writers.map(node => node.ref.version))
  const latest = writers.filter(node => node.ref.version === latestVersion)
  if (latest.length !== 1) return null
  const writer = latest[0]!
  const matching = reviewers.filter(node => node.dependsOn.includes(writer.key) && sameReference(node.ref, writer.ref))
  if (matching.length !== 1 || matching[0]!.status !== "passed") return null
  return { writerTaskId: writer.taskId, reviewerTaskId: matching[0]!.taskId, reviewHash: matching[0]!.hash, artifactRef: writer.ref }
}

function projectedReference(value: RecordValue | null, role: "writer" | "reviewer"): TaskGraphArtifactProjectionReference | null {
  if (!value || value.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || value.trust !== "untrusted"
    || value.availability !== "available" || value.role !== role || value.status !== "completed") return null
  return parseReference(value.artifactRef)
}

async function readArtifactContent(client: Queryable, input: Readonly<{ userId: string; sessionId: string; jobId: string }>, ref: TaskGraphArtifactProjectionReference, writerTaskId: string): Promise<{ content: string; toolCallId: string } | null> {
  const result = await client.query(`SELECT "content", "contentHash", "sourceDigest", "taskId", "toolCallId" FROM "agent_artifact_version"
    WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5
      AND "artifactType"='cover_letter' AND "contentHash"=$6 AND "sourceDigest"=$7 AND "taskId"=$8`,
  [input.userId, input.sessionId, input.jobId, ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest, writerTaskId])
  if (result.rows.length !== 1) return null
  const row = record(result.rows[0])
  if (!row || typeof row.content !== "string" || !row.content.trim() || row.content.length > MAX_CONTENT_LENGTH
    || hashArtifactContent(row.content) !== ref.contentHash || row.contentHash !== ref.contentHash || row.sourceDigest !== ref.sourceDigest
    || row.taskId !== writerTaskId || !text(row.toolCallId, 256)) return null
  return { content: row.content, toolCallId: row.toolCallId }
}

async function readCompletedToolReceipt(client: Queryable, input: Readonly<{ sessionId: string; sourceTurnId: string }>, taskId: string,
  toolName: string, toolCallId: string): Promise<{ input: RecordValue; output: RecordValue } | null> {
  const params = [input.sessionId, input.sourceTurnId, taskId, toolCallId]
  const items = await client.query(`SELECT "id", "stepId", "type", "status", "revision", "content" FROM "agent_items"
    WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3 AND "type" IN ('tool_call','tool_result')
      AND "content"->>'toolCallId'=$4 LIMIT 3`, params)
  const events = await client.query(`SELECT "id", "sessionId", "turnId", "taskId", "actor", "itemId", "type", "correlationId", "payload"
    FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3 AND "correlationId"=$4
      AND "type" IN ('tool_call.completed','tool_call.failed') LIMIT 3`, params)
  if (items.rows.length !== 2 || events.rows.length !== 1) return null
  const callItem = items.rows.find(row => record(row)?.type === "tool_call"), resultItem = items.rows.find(row => record(row)?.type === "tool_result")
  const callRow = record(callItem), resultRow = record(resultItem), event = record(events.rows[0])
  const call = record(callRow?.content), callInput = record(call?.input), result = record(resultRow?.content)
  const output = record(result?.output)
  const eventPayload = record(event?.payload)
  if (!callRow || !text(callRow.id, 256) || !resultRow || !text(resultRow.id, 256) || !event || !text(event.id, 256)
    || callRow.id !== event.itemId || callRow.stepId !== resultRow.stepId || !callRow.stepId
    || event.sessionId !== input.sessionId || event.turnId !== input.sourceTurnId
    || event.taskId !== taskId || event.actor !== "subagent" || event.correlationId !== toolCallId || event.type !== "tool_call.completed"
    || !eventPayload || !exactKeys(eventPayload, "errorCode,status,taskId,toolCallId,toolName")
    || eventPayload.errorCode !== null || eventPayload.status !== "completed" || eventPayload.taskId !== taskId
    || eventPayload.toolCallId !== toolCallId || eventPayload.toolName !== toolName
    || !call || !exactKeys(call, "errorCode,input,status,toolCallId,toolName,toolVersion") || call.toolCallId !== toolCallId
    || call.toolName !== toolName || call.toolVersion !== "1" || call.status !== "completed" || call.errorCode !== null
    || !callInput || !result || !exactKeys(result, "errorCode,output,toolCallId")
    || result.toolCallId !== toolCallId || result.errorCode !== null || !output) return null
  const restored = restoreToolCallState(items.rows.map(row => record(row)!), events.rows.map(row => record(row)!))
  return restored.pending.length === 0 && restored.observations.length === 1 && output
    ? { input: callInput, output } : null
}

async function hasWrittenArtifactReceipt(client: Queryable, input: Readonly<{ sessionId: string; sourceTurnId: string }>, lineage: {
  writerTaskId: string
}, ref: TaskGraphArtifactProjectionReference, toolCallId: string): Promise<boolean> {
  const receipt = await readCompletedToolReceipt(client, input, lineage.writerTaskId, "cover_letter.draft", toolCallId)
  return Boolean(receipt && text(receipt.input.baseArtifactId, 256) && typeof receipt.input.baseHash === "string" && SHA256.test(receipt.input.baseHash)
    && Object.keys(receipt.input).every(key => ["baseArtifactId", "baseHash", "expectedPreviousHash", "expectedPreviousVersion"].includes(key))
    && exactKeys(receipt.output, "artifactRef") && sameReference(parseReference(receipt.output.artifactRef), ref))
}

async function hasPassedToolReceipt(client: Queryable, input: Readonly<{ sessionId: string; sourceTurnId: string }>, lineage: {
  reviewerTaskId: string; reviewHash: string
}, ref: TaskGraphArtifactProjectionReference, toolCallId: string): Promise<boolean> {
  const receipt = await readCompletedToolReceipt(client, input, lineage.reviewerTaskId, "artifact.review", toolCallId)
  return Boolean(receipt && exactKeys(receipt.input, "artifactRef,decision,findings") && Array.isArray(receipt.input.findings)
    && receipt.input.decision === "passed" && sameReference(parseReference(receipt.input.artifactRef), ref)
    && exactKeys(receipt.output, "artifactRef") && sameReference(parseReference(receipt.output.artifactRef), ref))
}

function parseReference(value: unknown): TaskGraphArtifactProjectionReference | null {
  const row = record(value)
  if (!row || !exactKeys(row, "artifactId,contentHash,sourceDigest,version") || !text(row.artifactId, 128) || !ARTIFACT_ID.test(row.artifactId)
    || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.contentHash !== "string" || !SHA256.test(row.contentHash)
    || typeof row.sourceDigest !== "string" || !SHA256.test(row.sourceDigest)) return null
  return { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}
function sameReference(left: unknown, right: TaskGraphArtifactProjectionReference): boolean {
  const parsed = parseReference(left)
  return Boolean(parsed && parsed.artifactId === right.artifactId && parsed.version === right.version
    && parsed.contentHash === right.contentHash && parsed.sourceDigest === right.sourceDigest)
}
function record(value: unknown): RecordValue | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return (prototype === Object.prototype || prototype === null)
    && Object.getOwnPropertySymbols(parsed).length === 0 ? parsed as RecordValue : null } catch { return null }
}
function exactKeys(value: RecordValue, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit }
