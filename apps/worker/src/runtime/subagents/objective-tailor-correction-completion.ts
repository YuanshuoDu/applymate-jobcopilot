import type { PoolClient } from "pg"
import type { AgentArtifactReviewReceipt } from "../../db/agent-artifact-repo.js"
import { findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "../../db/agent-artifact-repo.js"
import { readSelectedJobSourceDigestWithClient } from "./selected-job-artifact-context.js"
import { readCurrentScheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { selectedJobArtifactCompletionGateWithWitness } from "../selected-job-completion-gate.js"
import { selectedJobReviewedDraftEvidenceWithWitness } from "./selected-job-reviewed-draft-evidence.js"
import { projectTaskGraphResult } from "./task-graph-result-projection.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { ObjectiveTailorWaveOccupiedSlot } from "./objective-tailor-wave-inventory.js"
import type { ObjectiveTailorCorrectionProof } from "./objective-tailor-correction-witness.js"
import type { ObjectiveTailorWaveSlotOutcome, ObjectiveTailorWaveSlotStatus } from "../canonical-objective-tailor-wave-completion.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import type { TurnLease } from "../turns/lease.js"
import type { SubagentTaskRecord } from "./types.js"

const SHA256 = /^sha256:[a-f0-9]{64}$/
const FAILED = new Set(["failed", "interrupted", "cancelled", "closed"])
type Version = Readonly<{ artifactId: string; artifactType: "cover_letter"; taskId: string; version: number; contentHash: string; sourceDigest: string; previousHash: string | null }>

/** Computes only the effective correction pair; malformed bindings never fall back to the initial pair. */
export async function readObjectiveTailorCorrectionCompletion(input: Readonly<{
  client: PoolClient; lease: TurnLease; root: Pick<SubagentTaskRecord, "id" | "attemptCount">; loaded: LoadedGraph
  scope: GraphIdentityScope; slot: ObjectiveTailorWaveOccupiedSlot
}>): Promise<ObjectiveTailorWaveSlotOutcome | undefined> {
  return readCompletion(input)
}

/** Rebuilds one settled correction slot without requiring the completed source Turn's old lease. */
export async function readCompletedObjectiveTailorCorrectionEvidence(input: Readonly<{
  client: PoolClient; loaded: LoadedGraph; scope: GraphIdentityScope; slot: ObjectiveTailorWaveOccupiedSlot
}>): Promise<ObjectiveTailorWaveSlotOutcome | undefined> {
  return readCompletion(input)
}

async function readCompletion(input: Readonly<{
  client: PoolClient; loaded: LoadedGraph; scope: GraphIdentityScope; slot: ObjectiveTailorWaveOccupiedSlot
  lease?: TurnLease; root?: Pick<SubagentTaskRecord, "id" | "attemptCount">
}>): Promise<ObjectiveTailorWaveSlotOutcome | undefined> {
  const loadedRevision = input.loaded.item?.revision
  const correction = input.slot.correction, proof = correction?.proof
  if (!correction || !proof || proof.slotId !== input.slot.slotId || proof.candidateWitness.candidate.jobId !== input.slot.jobId
    || proof.prior.writerTaskId !== input.slot.writerTaskId || proof.prior.reviewerTaskId !== input.slot.reviewerTaskId
    || canonicalTaskGraphJson(proof.candidateWitness) !== canonicalTaskGraphJson(input.slot.witness)
    || proof.graphRevision + 1 !== proof.admittedRevision || loadedRevision === undefined || proof.admittedRevision > loadedRevision) return undefined
  const { snapshot, state, tasks } = input.loaded
  if (!snapshot || !state) return undefined
  const marker = snapshot.objectiveTailor?.slots.filter(value => value.slotId === proof.slotId)
  if (!marker || marker.length !== 1 || marker[0]?.writerNodeKey !== proof.candidateWitness.writerNodeKey
    || marker[0]?.reviewerNodeKey !== proof.candidateWitness.reviewerNodeKey
    || marker[0]?.correction?.writerNodeKey !== proof.writerNodeKey || marker[0]?.correction?.reviewerNodeKey !== proof.reviewerNodeKey) return undefined
  const writerNode = snapshot.nodes.find(node => node.key === proof.writerNodeKey), reviewerNode = snapshot.nodes.find(node => node.key === proof.reviewerNodeKey)
  const writerTask = tasks.get(correction.writerTaskId), reviewerTask = tasks.get(correction.reviewerTaskId)
  const writerState = state.nodes.find(node => node.key === proof.writerNodeKey), reviewerState = state.nodes.find(node => node.key === proof.reviewerNodeKey)
  if (!writerNode || !reviewerNode || !writerTask || !reviewerTask || !writerState || !reviewerState
    || writerNode.taskId !== correction.writerTaskId || reviewerNode.taskId !== correction.reviewerTaskId
    || writerNode.templateId !== "cover_letter_writer" || reviewerNode.templateId !== "cover_letter_reviewer"
    || writerNode.dependsOn.length !== 1 || writerNode.dependsOn[0] !== proof.candidateWitness.reviewerNodeKey
    || reviewerNode.dependsOn.length !== 1 || reviewerNode.dependsOn[0] !== proof.writerNodeKey
    || writerTask.role !== "writer" || reviewerTask.role !== "reviewer" || writerTask.taskType !== "cover_letter_draft"
    || reviewerTask.taskType !== "cover_letter_review" || writerTask.status !== writerState.status || reviewerTask.status !== reviewerState.status) return undefined
  const base = { slotId: input.slot.slotId, jobId: input.slot.jobId, writerTaskId: correction.writerTaskId,
    reviewerTaskId: correction.reviewerTaskId, candidateWitness: input.slot.witness,
    correction: { proof, writerTaskId: correction.writerTaskId, reviewerTaskId: correction.reviewerTaskId } }
  if (!terminal(writerTask.status) || !terminal(reviewerTask.status)) return { ...base, status: "pending" }
  if (FAILED.has(writerTask.status) || FAILED.has(reviewerTask.status)) return { ...base, status: "failed" }
  const draft = projectTaskGraphResult(writerTask.role, writerTask.status, writerTask.result)
  const review = projectTaskGraphResult(reviewerTask.role, reviewerTask.status, reviewerTask.result)
  if (draft.availability !== "available" || draft.role !== "writer" || draft.status !== "completed"
    || review.availability !== "available" || review.role !== "reviewer" || review.status !== "completed"
    || !sameRef(draft.artifactRef, review.artifactRef)) return undefined
  const ref = draft.artifactRef, prior = proof.prior
  if (ref.artifactId !== prior.artifactRef.artifactId || ref.version !== prior.artifactRef.version + 1
    || ref.sourceDigest !== prior.artifactRef.sourceDigest) return undefined
  const version = await readSuccessorVersion(input.client, input.scope, input.slot.jobId, correction.writerTaskId, ref, prior.artifactRef.contentHash)
  if (!version) return undefined
  const currentSourceDigest = await readSelectedJobSourceDigestWithClient(input.client, input.scope.userId, input.slot.jobId)
  const materialDigest = await readCurrentScheduledDraftJobMaterialDigest(input.client, input.scope.userId, input.slot.jobId)
  if (!isDigest(currentSourceDigest) || !isDigest(materialDigest)) return undefined
  const receipt = review.reviewStatus === "stale"
    ? await readStaleReceipt(input.client, input.scope, input.slot.jobId, correction.reviewerTaskId, ref, review.reviewHash)
    : await findReviewReceiptWithClient(input.client, { userId: input.scope.userId, sessionId: input.scope.sessionId,
      jobId: input.slot.jobId, artifactId: ref.artifactId, version: ref.version, contentHash: ref.contentHash,
      sourceDigest: ref.sourceDigest, currentSourceDigest: ref.sourceDigest, status: review.reviewStatus,
      taskId: correction.reviewerTaskId, reviewHash: review.reviewHash })
  if (!receipt || !matchesReceipt(receipt, input.scope, input.slot.jobId, correction.reviewerTaskId, ref, review.reviewHash, review.reviewStatus)) return undefined
  if (currentSourceDigest !== ref.sourceDigest || materialDigest !== input.slot.witness.candidate.materialDigest
    || review.reviewStatus === "stale") return { ...base, status: "stale", artifactRef: ref, artifactVersion: version,
      reviewReceipt: receiptIdentity(receipt), currentSourceDigest }
  const checkedReceipt: { value: AgentArtifactReviewReceipt | null } = { value: null }
  const checkedHead: { value: Awaited<ReturnType<typeof findCurrentDraftHeadWithClient>> | undefined } = { value: undefined }
  const graph: TaskGraphCurrentState = { revision: loadedRevision, nodes: [
      { key: writerNode.key, templateId: writerNode.templateId, goal: writerNode.goal, successCriteria: writerNode.successCriteria,
        dependsOn: [], taskId: writerNode.taskId, status: writerTask.status, readiness: "terminal", resultSummary: null,
        resultProjection: draft, failureReason: null },
      { key: reviewerNode.key, templateId: reviewerNode.templateId, goal: reviewerNode.goal, successCriteria: reviewerNode.successCriteria,
        dependsOn: reviewerNode.dependsOn, taskId: reviewerNode.taskId, status: reviewerTask.status, readiness: "terminal", resultSummary: null,
        resultProjection: review, failureReason: null },
    ] }
  const readCurrentDraftHead = async (headScope: Parameters<typeof findCurrentDraftHeadWithClient>[1]) => {
    const head = await findCurrentDraftHeadWithClient(input.client, headScope)
    checkedHead.value = head
    return head
  }
  const readCurrentReviewReceipt = async (receiptScope: Parameters<typeof findReviewReceiptWithClient>[1]) => {
    const found = await findReviewReceiptWithClient(input.client, receiptScope)
    checkedReceipt.value = found
    return found
  }
  const checked = input.lease && input.root
    ? await selectedJobArtifactCompletionGateWithWitness({
      commandPort: { readCurrent: async () => graph }, lease: input.lease, root: input.root, selectedJobId: input.slot.jobId,
      readCurrentDraftHead, readCurrentSourceDigest: () => readSelectedJobSourceDigestWithClient(input.client, input.scope.userId, input.slot.jobId),
      readCurrentReviewReceipt,
    })
    : await selectedJobReviewedDraftEvidenceWithWitness({
      graph, userId: input.scope.userId, sessionId: input.scope.sessionId, selectedJobId: input.slot.jobId,
      readCurrentDraftHead, readCurrentSourceDigest: () => readSelectedJobSourceDigestWithClient(input.client, input.scope.userId, input.slot.jobId),
      readCurrentReviewReceipt,
    })
  const verified = checkedReceipt.value
  if (!checked.ok) {
    if (checkedHead.value !== undefined && (checkedHead.value === null || !sameRef(ref, checkedHead.value))
      && await currentMaterialStillMatches(input.client, input.scope, input.slot.jobId, ref.sourceDigest, input.slot.witness.candidate.materialDigest)) {
      return { ...base, status: "stale", artifactRef: ref, artifactVersion: version,
        reviewReceipt: receiptIdentity(receipt), currentSourceDigest }
    }
    return undefined
  }
  if (!verified || !matchesReceipt(verified, input.scope, input.slot.jobId, correction.reviewerTaskId, ref, review.reviewHash, review.reviewStatus)
    || verified.currentSourceDigest !== currentSourceDigest) return undefined
  const status: ObjectiveTailorWaveSlotStatus = review.reviewStatus === "passed" ? "ready" : review.reviewStatus
  return { ...base, status, artifactRef: ref, artifactVersion: version, reviewReceipt: receiptIdentity(verified), currentSourceDigest }
}

async function readSuccessorVersion(client: PoolClient, scope: GraphIdentityScope, jobId: string, taskId: string, ref: ObjectiveTailorWaveSlotOutcome["artifactRef"], previousHash: string): Promise<Version | undefined> {
  if (!ref) return undefined
  const result = await client.query<Version>(`SELECT "artifactId", "artifactType", "taskId", "version", "contentHash", "sourceDigest", "previousHash"
    FROM "agent_artifact_version" WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4
      AND "version"=$5 AND "artifactType"='cover_letter' AND "taskId"=$6 LIMIT 2`,
  [scope.userId, scope.sessionId, jobId, ref.artifactId, ref.version, taskId])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.artifactId === ref.artifactId && row.artifactType === "cover_letter"
    && row.taskId === taskId && row.version === ref.version && row.version > 1 && row.contentHash === ref.contentHash
    && row.sourceDigest === ref.sourceDigest && row.previousHash === previousHash ? row : undefined
}

async function readStaleReceipt(client: PoolClient, scope: GraphIdentityScope, jobId: string, taskId: string,
  ref: NonNullable<ObjectiveTailorWaveSlotOutcome["artifactRef"]>, reviewHash: string): Promise<AgentArtifactReviewReceipt | null> {
  const result = await client.query<AgentArtifactReviewReceipt>(`SELECT "userId", "sessionId", "jobId", "artifactId", "version", "contentHash",
    "sourceDigest", "currentSourceDigest", "status", "taskId", "toolCallId", "reviewHash" FROM "agent_artifact_review"
    WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5
      AND "contentHash"=$6 AND "sourceDigest"=$7 AND "status"='stale' AND "taskId"=$8 AND "reviewHash"=$9 LIMIT 2`,
  [scope.userId, scope.sessionId, jobId, ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest, taskId, reviewHash])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.userId === scope.userId && row.sessionId === scope.sessionId && row.jobId === jobId
    && row.artifactId === ref.artifactId && row.version === ref.version && row.contentHash === ref.contentHash
    && row.sourceDigest === ref.sourceDigest && row.status === "stale" && row.taskId === taskId && row.reviewHash === reviewHash
    && isDigest(row.currentSourceDigest) && typeof row.toolCallId === "string" && row.toolCallId.trim() ? row : null
}
async function currentMaterialStillMatches(client: PoolClient, scope: GraphIdentityScope, jobId: string, sourceDigest: string, materialDigest: string): Promise<boolean> {
  const source = await readSelectedJobSourceDigestWithClient(client, scope.userId, jobId)
  const material = await readCurrentScheduledDraftJobMaterialDigest(client, scope.userId, jobId)
  return source === sourceDigest && material === materialDigest
}

function matchesReceipt(receipt: AgentArtifactReviewReceipt, scope: GraphIdentityScope, jobId: string, taskId: string,
  ref: NonNullable<ObjectiveTailorWaveSlotOutcome["artifactRef"]>, reviewHash: string, status: string): boolean {
  return receipt.userId === scope.userId && receipt.sessionId === scope.sessionId && receipt.jobId === jobId
    && receipt.artifactId === ref.artifactId && receipt.version === ref.version && receipt.contentHash === ref.contentHash
    && receipt.sourceDigest === ref.sourceDigest && receipt.taskId === taskId && receipt.reviewHash === reviewHash && receipt.status === status
    && isDigest(receipt.currentSourceDigest) && typeof receipt.toolCallId === "string" && !!receipt.toolCallId.trim()
}
function receiptIdentity(receipt: AgentArtifactReviewReceipt): ObjectiveTailorWaveSlotOutcome["reviewReceipt"] {
  return { taskId: receipt.taskId, artifactId: receipt.artifactId, version: receipt.version, contentHash: receipt.contentHash,
    sourceDigest: receipt.sourceDigest, currentSourceDigest: receipt.currentSourceDigest, status: receipt.status,
    reviewHash: receipt.reviewHash, toolCallId: receipt.toolCallId }
}
function sameRef(left: NonNullable<ObjectiveTailorWaveSlotOutcome["artifactRef"]>, right: NonNullable<ObjectiveTailorWaveSlotOutcome["artifactRef"]>): boolean {
  return left.artifactId === right.artifactId && left.version === right.version && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function terminal(status: string): boolean { return status === "completed" || FAILED.has(status) }
function isDigest(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
