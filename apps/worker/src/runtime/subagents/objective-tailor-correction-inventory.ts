import type { PoolClient } from "pg"
import { findReviewReceiptWithClient } from "../../db/agent-artifact-repo.js"
import { projectTaskGraphResult } from "./task-graph-result-projection.js"
import { objectiveTailorCorrectionNodeKeys, parseObjectiveTailorCorrectionProof,
  type ObjectiveTailorCorrectionProof } from "./objective-tailor-correction-witness.js"
import type { ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import type { ObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"

type Row = Record<string, unknown>
type Queryable = Pick<PoolClient, "query">
export type ObjectiveTailorCorrectionInventory = Readonly<{
  proof: ObjectiveTailorCorrectionProof; writerTaskId: string; reviewerTaskId: string
}>

/** Reconstructs one marked correction pair from its owner-scoped tasks and original immutable receipt. */
export async function readObjectiveTailorCorrectionInventory(input: Readonly<{
  client: Queryable; scope: GraphIdentityScope; loaded: LoadedGraph; slot: ObjectiveTailorGraph["slots"][number]
  witness: ObjectiveTailorWaveCandidateWitness; initialWriterTaskId: string; initialReviewerTaskId: string
  rows: readonly Row[]
}>): Promise<ObjectiveTailorCorrectionInventory | undefined> {
  const repair = input.slot.correction, keys = objectiveTailorCorrectionNodeKeys(input.slot.slotId)
  if (!repair || !keys || repair.writerNodeKey !== keys.writerNodeKey || repair.reviewerNodeKey !== keys.reviewerNodeKey) return undefined
  const graph = input.loaded, writer = graph.snapshot?.nodes.filter(node => node.key === repair.writerNodeKey) ?? []
  const reviewer = graph.snapshot?.nodes.filter(node => node.key === repair.reviewerNodeKey) ?? []
  const writerNode = writer[0], reviewerNode = reviewer[0]
  if (!writerNode || !reviewerNode || writer.length !== 1 || reviewer.length !== 1) return undefined
  const proof = pairedProof(input.rows, writerNode.taskId, reviewerNode.taskId), parsed = proof && parseObjectiveTailorCorrectionProof(proof)
  if (writer.length !== 1 || reviewer.length !== 1 || !writerNode || !reviewerNode || !parsed
    || !graph.state || !graph.item || graph.item.revision < parsed.admittedRevision
    || parsed.slotId !== input.slot.slotId || parsed.graphRevision + 1 !== parsed.admittedRevision
    || canonicalTaskGraphJson(parsed.candidateWitness) !== canonicalTaskGraphJson(input.witness)
    || parsed.prior.writerTaskId !== input.initialWriterTaskId || parsed.prior.reviewerTaskId !== input.initialReviewerTaskId
    || new Set([writerNode.taskId, reviewerNode.taskId, input.initialWriterTaskId, input.initialReviewerTaskId]).size !== 4
    || writerNode.templateId !== "cover_letter_writer" || reviewerNode.templateId !== "cover_letter_reviewer"
    || !sameList(writerNode.dependsOn, [input.slot.reviewerNodeKey]) || !sameList(reviewerNode.dependsOn, [writerNode.key])) return undefined
  const writerState = graph.state.nodes.find(node => node.key === writerNode.key), reviewerState = graph.state.nodes.find(node => node.key === reviewerNode.key)
  const writerTask = graph.tasks.get(writerNode.taskId), reviewerTask = graph.tasks.get(reviewerNode.taskId)
  const writerRow = input.rows.find(row => row.id === writerNode.taskId), reviewerRow = input.rows.find(row => row.id === reviewerNode.taskId)
  if (!writerState || !reviewerState || !writerTask || !reviewerTask || !writerRow || !reviewerRow
    || writerTask.role !== "writer" || reviewerTask.role !== "reviewer"
    || writerTask.taskType !== "cover_letter_draft" || reviewerTask.taskType !== "cover_letter_review"
    || writerTask.status !== writerState.status || reviewerTask.status !== reviewerState.status
    || !rowMatches(writerRow, input.scope, writerNode.taskId, "writer", "cover_letter_draft", writerState.status)
    || !rowMatches(reviewerRow, input.scope, reviewerNode.taskId, "reviewer", "cover_letter_review", reviewerState.status)
    || !contextsMatch(writerRow.context, reviewerRow.context, parsed)) return undefined
  if (!await originalEvidenceMatches(input.client, input.scope, graph, input.initialWriterTaskId, input.initialReviewerTaskId, parsed)) return undefined
  return { proof: parsed, writerTaskId: writerNode.taskId, reviewerTaskId: reviewerNode.taskId }
}

function pairedProof(rows: readonly Row[], writerId: string, reviewerId: string): unknown {
  const writer = record(rows.find(row => row.id === writerId)?.context), reviewer = record(rows.find(row => row.id === reviewerId)?.context)
  if (!writer || !reviewer || writer.objectiveTailorCandidateMode !== true || reviewer.objectiveTailorCandidateMode !== true) return undefined
  const left = parseObjectiveTailorCorrectionProof(writer.objectiveTailorCorrectionProof)
  const right = parseObjectiveTailorCorrectionProof(reviewer.objectiveTailorCorrectionProof)
  return left && right && canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) ? left : undefined
}

async function originalEvidenceMatches(client: Queryable, scope: GraphIdentityScope, graph: LoadedGraph,
  writerId: string, reviewerId: string, proof: ObjectiveTailorCorrectionProof): Promise<boolean> {
  const writer = graph.tasks.get(writerId), reviewer = graph.tasks.get(reviewerId)
  if (!writer || !reviewer || writer.role !== "writer" || reviewer.role !== "reviewer"
    || writer.status !== "completed" || reviewer.status !== "completed"
    || writer.failureReason !== null || reviewer.failureReason !== null) return false
  const draft = projectTaskGraphResult(writer.role, writer.status, writer.result)
  const review = projectTaskGraphResult(reviewer.role, reviewer.status, reviewer.result), prior = proof.prior
  if (draft.availability !== "available" || draft.role !== "writer" || draft.status !== "completed"
    || review.availability !== "available" || review.role !== "reviewer" || review.status !== "completed"
    || draft.artifactRef.artifactId !== prior.artifactRef.artifactId || draft.artifactRef.version !== prior.artifactRef.version
    || draft.artifactRef.contentHash !== prior.artifactRef.contentHash || draft.artifactRef.sourceDigest !== prior.artifactRef.sourceDigest
    || review.artifactRef.artifactId !== prior.artifactRef.artifactId || review.artifactRef.version !== prior.artifactRef.version
    || review.artifactRef.contentHash !== prior.artifactRef.contentHash || review.artifactRef.sourceDigest !== prior.artifactRef.sourceDigest
    || review.reviewStatus !== "needs_revision" || review.reviewHash !== prior.reviewReceipt.reviewHash) return false
  const versionResult = await client.query<Row>(`SELECT "artifactId", "artifactType", "taskId", "version", "contentHash", "sourceDigest", "previousHash"
    FROM "agent_artifact_version" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4
      AND "version"=$5 AND "artifactType"='cover_letter' AND "taskId"=$6 LIMIT 2`,
  [scope.userId, scope.sessionId, proof.candidateWitness.candidate.jobId, prior.artifactRef.artifactId, prior.artifactRef.version, writerId])
  const version = versionResult.rows[0], receipt = await findReviewReceiptWithClient(client, {
    userId: scope.userId, sessionId: scope.sessionId, jobId: proof.candidateWitness.candidate.jobId,
    artifactId: prior.artifactRef.artifactId, version: prior.artifactRef.version, contentHash: prior.artifactRef.contentHash,
    sourceDigest: prior.artifactRef.sourceDigest, currentSourceDigest: prior.reviewReceipt.currentSourceDigest,
    status: "needs_revision", taskId: reviewerId, reviewHash: prior.reviewReceipt.reviewHash,
  })
  return versionResult.rows.length === 1 && version?.artifactId === prior.artifactVersion.artifactId
    && version.artifactType === prior.artifactVersion.artifactType && version.taskId === prior.artifactVersion.taskId
    && Number(version.version) === prior.artifactVersion.version && version.contentHash === prior.artifactVersion.contentHash
    && version.sourceDigest === prior.artifactVersion.sourceDigest && version.previousHash === prior.artifactVersion.previousHash
    && !!receipt && receipt.jobId === prior.reviewReceipt.jobId && receipt.artifactId === prior.reviewReceipt.artifactId
    && receipt.version === prior.reviewReceipt.version && receipt.contentHash === prior.reviewReceipt.contentHash
    && receipt.sourceDigest === prior.reviewReceipt.sourceDigest && receipt.currentSourceDigest === prior.reviewReceipt.currentSourceDigest
    && receipt.status === prior.reviewReceipt.status && receipt.taskId === prior.reviewReceipt.taskId
    && receipt.toolCallId === prior.reviewReceipt.toolCallId && receipt.reviewHash === prior.reviewReceipt.reviewHash
}

function contextsMatch(writerValue: unknown, reviewerValue: unknown, proof: ObjectiveTailorCorrectionProof): boolean {
  const selected = taskGraphTemplatesForSelectedJob({ jobId: proof.candidateWitness.candidate.jobId })
  const context = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId: proof.candidateWitness.candidate.jobId },
    objectiveTailorCandidateWitness: proof.candidateWitness, objectiveTailorCorrectionProof: proof }
  return !!selected.cover_letter_writer && !!selected.cover_letter_reviewer
    && contextMatches(writerValue, context) && contextMatches(reviewerValue, context)
}
function contextMatches(value: unknown, expected: unknown): boolean {
  const actual = record(value), target = record(expected)
  if (!actual || !target) return false
  const base = { ...actual }; delete base.taskGraphDependencyResults
  return canonicalTaskGraphJson(base) === canonicalTaskGraphJson(target)
}
function rowMatches(row: Row, scope: GraphIdentityScope, id: string, role: string, type: string, status: string): boolean {
  return row.id === id && row.sessionId === scope.sessionId && row.turnId === scope.turnId && row.rootTaskId === scope.rootTaskId
    && row.parentTaskId === scope.parentTaskId && row.userId === scope.userId && row.turnUserId === scope.userId
    && row.turnRootTaskId === scope.rootTaskId && row.role === role && row.taskType === type && row.status === status
}
function sameList(value: readonly string[], expected: readonly string[]): boolean {
  return value.length === expected.length && value.every((entry, index) => entry === expected[index])
}
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Row, keys = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(row, key)?.enumerable
        && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined
  } catch { return undefined }
}
