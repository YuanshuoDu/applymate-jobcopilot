import type { PoolClient } from "pg"
import { createHash } from "node:crypto"
import type { AgentArtifactReviewReceipt } from "../db/agent-artifact-repo.js"
import { findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "../db/agent-artifact-repo.js"
import { readSelectedJobSourceDigestWithClient } from "./subagents/selected-job-artifact-context.js"
import { readCurrentScheduledDraftJobMaterialDigest } from "./subagents/scheduled-draft-job-material.js"
import { selectedJobArtifactCompletionGateWithWitness } from "./selected-job-completion-gate.js"
import type { SelectedJobBatchArtifactVersion, SelectedJobBatchArtifactVersionScope } from "./multi-selected-job-correction-evidence.js"
import { readObjectiveTailorWaveInventory, type ObjectiveTailorWaveInventory } from "./subagents/objective-tailor-wave-inventory.js"
import type { ObjectiveTailorWaveCandidateWitness } from "./subagents/objective-tailor-wave-witness.js"
import { canonicalTaskGraphJson } from "./subagents/task-graph-snapshot.js"
import type { GraphIdentityScope, LoadedGraph } from "./subagents/task-graph-pg-state.js"
import type { TaskGraphArtifactProjectionReference, TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import { projectTaskGraphResult } from "./subagents/task-graph-result-projection.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"

const SHA256 = /^sha256:[a-f0-9]{64}$/
const FAILED = new Set(["failed", "interrupted", "cancelled", "closed"])
export type ObjectiveTailorWaveSlotStatus = "ready" | "needs_revision" | "rejected" | "stale" | "failed" | "pending"
export type ObjectiveTailorWaveSlotOutcome = Readonly<{
  slotId: string; jobId: string; writerTaskId: string; reviewerTaskId: string; status: ObjectiveTailorWaveSlotStatus
  artifactRef?: TaskGraphArtifactProjectionReference; artifactVersion?: SelectedJobBatchArtifactVersion
  reviewReceipt?: Readonly<Pick<AgentArtifactReviewReceipt, "taskId" | "artifactId" | "version" | "contentHash" | "sourceDigest" | "currentSourceDigest" | "status" | "reviewHash" | "toolCallId">>
  currentSourceDigest?: string
  candidateWitness: ObjectiveTailorWaveCandidateWitness
}>
export type ObjectiveTailorWaveCompletionWitness = Readonly<{
  graphRevision: number; graphDigest: string; marker: NonNullable<ObjectiveTailorWaveInventory["marker"]>
  sourceGraphRevision: number; sourceGraphDigest: string; sourceStatusDigest: string
  outcomes: readonly ObjectiveTailorWaveSlotOutcome[]
}>
export type ObjectiveTailorWaveCompletionResult =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "pending" | "blocked"; outcomes: readonly ObjectiveTailorWaveSlotOutcome[] }>
  | Readonly<{ status: "ready"; outcomes: readonly ObjectiveTailorWaveSlotOutcome[]; witness: ObjectiveTailorWaveCompletionWitness }>
type Input = Readonly<{
  client: PoolClient; lease: TurnLease; root: Pick<SubagentTaskRecord, "id" | "attemptCount">
  loaded: LoadedGraph; allowAbsent: boolean; acceptedWitness?: ObjectiveTailorWaveCompletionWitness
}>

/** Revalidates V2 slot outcomes on the caller's exact candidate or terminal client. */
export async function verifyCanonicalObjectiveTailorWaveCompletion(input: Input): Promise<ObjectiveTailorWaveCompletionResult> {
  try { return await verifyCompletion(input) } catch { return blocked([]) }
}

async function verifyCompletion(input: Input): Promise<ObjectiveTailorWaveCompletionResult> {
  const scope: GraphIdentityScope = { userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
    rootTaskId: input.root.id, parentTaskId: input.root.id }
  if (!input.root.id || !input.client || !input.loaded.item || !input.loaded.snapshot || !input.loaded.state
    || input.loaded.rootTaskId !== input.root.id || input.loaded.discoveryTurnEligibility !== "ordinary") return blocked([])
  let inventory: ObjectiveTailorWaveInventory | undefined
  try { inventory = await readObjectiveTailorWaveInventory(input.client, scope, input.loaded) } catch { return blocked([]) }
  if (!inventory) return blocked([])
  if (!inventory.marker) return input.allowAbsent && inventory.occupiedSlots.length === 0 ? { status: "absent" } : blocked([])
  if (inventory.marker.slots.some(slot => slot.correction) || inventory.occupiedSlots.length !== inventory.marker.slots.length
    || inventory.graphRevision !== input.loaded.item.revision) return blocked([])
  const outcomes: ObjectiveTailorWaveSlotOutcome[] = []
  for (const slot of inventory.occupiedSlots) {
    const writer = input.loaded.snapshot.nodes.find(node => node.key === slot.witness.writerNodeKey)
    const reviewer = input.loaded.snapshot.nodes.find(node => node.key === slot.witness.reviewerNodeKey)
    const writerTask = input.loaded.tasks.get(slot.writerTaskId), reviewerTask = input.loaded.tasks.get(slot.reviewerTaskId)
    const writerState = input.loaded.state.nodes.find(node => node.key === slot.witness.writerNodeKey)
    const reviewerState = input.loaded.state.nodes.find(node => node.key === slot.witness.reviewerNodeKey)
    if (!writer || !reviewer || !writerTask || !reviewerTask || !writerState || !reviewerState
      || writer.taskId !== slot.writerTaskId || reviewer.taskId !== slot.reviewerTaskId
      || writer.templateId !== "cover_letter_writer" || reviewer.templateId !== "cover_letter_reviewer") return blocked(outcomes)
    const writerTerminal = writerTask.status === "completed" || FAILED.has(writerTask.status)
    const reviewerTerminal = reviewerTask.status === "completed" || FAILED.has(reviewerTask.status)
    if (!writerTerminal || !reviewerTerminal) {
      outcomes.push(outcome(slot, "pending")); continue
    }
    if (FAILED.has(writerTask.status) || FAILED.has(reviewerTask.status)) { outcomes.push(outcome(slot, "failed")); continue }
    const writerProjection = projectTaskGraphResult(writerTask.role, writerTask.status, writerTask.result)
    const reviewerProjection = projectTaskGraphResult(reviewerTask.role, reviewerTask.status, reviewerTask.result)
    if (writerProjection.availability !== "available" || writerProjection.role !== "writer"
      || reviewerProjection.availability !== "available" || reviewerProjection.role !== "reviewer"
      || !sameArtifact(writerProjection.artifactRef, reviewerProjection.artifactRef)
      || writerProjection.status !== "completed" || reviewerProjection.status !== "completed") return blocked(outcomes)
    const artifactRef = writerProjection.artifactRef
    const version = await readArtifactVersion(input.client, { userId: scope.userId, sessionId: scope.sessionId, jobId: slot.jobId,
      artifactId: artifactRef.artifactId, taskId: slot.writerTaskId, version: artifactRef.version })
    if (!version || version.contentHash !== artifactRef.contentHash || version.sourceDigest !== artifactRef.sourceDigest) return blocked(outcomes)
    const receipt = reviewerProjection.reviewStatus === "stale"
      ? await readStaleReviewReceipt(input.client, { userId: scope.userId, sessionId: scope.sessionId, jobId: slot.jobId,
        artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash: artifactRef.contentHash,
        sourceDigest: artifactRef.sourceDigest, taskId: slot.reviewerTaskId, reviewHash: reviewerProjection.reviewHash })
      : await findReviewReceiptWithClient(input.client, { userId: scope.userId, sessionId: scope.sessionId, jobId: slot.jobId,
        artifactId: artifactRef.artifactId, version: artifactRef.version, contentHash: artifactRef.contentHash,
        sourceDigest: artifactRef.sourceDigest, currentSourceDigest: artifactRef.sourceDigest,
        status: reviewerProjection.reviewStatus, taskId: slot.reviewerTaskId, reviewHash: reviewerProjection.reviewHash })
    if (!receipt || receipt.taskId !== slot.reviewerTaskId || receipt.status !== reviewerProjection.reviewStatus
      || receipt.reviewHash !== reviewerProjection.reviewHash) return blocked(outcomes)
    const currentSourceDigest = await readSelectedJobSourceDigestWithClient(input.client, scope.userId, slot.jobId)
    if (typeof currentSourceDigest !== "string" || !SHA256.test(currentSourceDigest)) return blocked(outcomes)
    const materialDigest = await readCurrentScheduledDraftJobMaterialDigest(input.client, scope.userId, slot.jobId)
    if (typeof materialDigest !== "string" || !SHA256.test(materialDigest)) return blocked(outcomes)
    if (currentSourceDigest !== artifactRef.sourceDigest || materialDigest !== slot.witness.candidate.materialDigest
      || reviewerProjection.reviewStatus === "stale") {
      outcomes.push({ ...outcome(slot, "stale"), artifactRef, artifactVersion: version,
        reviewReceipt: receiptIdentity(receipt), currentSourceDigest }); continue
    }
    let checkedReceipt: AgentArtifactReviewReceipt | null = null
    const checked = await selectedJobArtifactCompletionGateWithWitness({
      commandPort: { readCurrent: async () => ({ revision: inventory.graphRevision, nodes: [
        { key: writer.key, templateId: writer.templateId, goal: writer.goal, successCriteria: writer.successCriteria,
          dependsOn: [], taskId: writer.taskId, status: writerTask.status, readiness: writerState.readiness,
          resultSummary: null, resultProjection: writerProjection, failureReason: null },
        { key: reviewer.key, templateId: reviewer.templateId, goal: reviewer.goal, successCriteria: reviewer.successCriteria,
          dependsOn: [writer.key], taskId: reviewer.taskId, status: reviewerTask.status, readiness: reviewerState.readiness,
          resultSummary: null, resultProjection: reviewerProjection, failureReason: null },
      ] }) },
      lease: input.lease, root: input.root, selectedJobId: slot.jobId,
      readCurrentDraftHead: scope => findCurrentDraftHeadWithClient(input.client, scope),
      readCurrentSourceDigest: () => readSelectedJobSourceDigestWithClient(input.client, scope.userId, slot.jobId),
      readCurrentReviewReceipt: async receiptScope => { checkedReceipt = await findReviewReceiptWithClient(input.client, receiptScope); return checkedReceipt },
    })
    if (!checked.ok || !checkedReceipt || checkedReceipt.taskId !== slot.reviewerTaskId || checkedReceipt.status !== reviewerProjection.reviewStatus
      || checkedReceipt.reviewHash !== reviewerProjection.reviewHash || checkedReceipt.currentSourceDigest !== currentSourceDigest) return blocked(outcomes)
    const status = reviewerProjection.reviewStatus === "passed" ? "ready" : reviewerProjection.reviewStatus
    outcomes.push({ ...outcome(slot, status), artifactRef, artifactVersion: version,
      reviewReceipt: receiptIdentity(checkedReceipt), currentSourceDigest })
  }
  if (outcomes.some(value => value.status === "pending")) return input.acceptedWitness ? blocked(outcomes) : { status: "pending", outcomes }
  const witness: ObjectiveTailorWaveCompletionWitness = {
    graphRevision: inventory.graphRevision, graphDigest: digest(input.loaded.snapshot), marker: inventory.marker,
    sourceGraphRevision: inventory.sourceGraphRevision, sourceGraphDigest: inventory.sourceGraphDigest,
    sourceStatusDigest: inventory.sourceStatusDigest, outcomes,
  }
  if (input.acceptedWitness && !sameWitness(input.acceptedWitness, witness)) return blocked(outcomes)
  return { status: "ready", outcomes, witness }
}

function outcome(slot: ObjectiveTailorWaveInventory["occupiedSlots"][number], status: ObjectiveTailorWaveSlotStatus): ObjectiveTailorWaveSlotOutcome {
  return { slotId: slot.slotId, jobId: slot.jobId, writerTaskId: slot.writerTaskId, reviewerTaskId: slot.reviewerTaskId,
    status, candidateWitness: slot.witness }
}
function sameArtifact(left: TaskGraphArtifactProjectionReference, right: TaskGraphArtifactProjectionReference): boolean {
  return left.artifactId === right.artifactId && left.version === right.version && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function receiptIdentity(receipt: AgentArtifactReviewReceipt): ObjectiveTailorWaveSlotOutcome["reviewReceipt"] {
  return { taskId: receipt.taskId, artifactId: receipt.artifactId, version: receipt.version, contentHash: receipt.contentHash,
    sourceDigest: receipt.sourceDigest, currentSourceDigest: receipt.currentSourceDigest, status: receipt.status,
    reviewHash: receipt.reviewHash, toolCallId: receipt.toolCallId }
}
async function readArtifactVersion(client: PoolClient, scope: SelectedJobBatchArtifactVersionScope): Promise<SelectedJobBatchArtifactVersion | null> {
  const result = await client.query<SelectedJobBatchArtifactVersion>(`SELECT "artifactId", "artifactType", "taskId", "version", "contentHash", "sourceDigest", "previousHash"
    FROM "agent_artifact_version" WHERE "userId" = $1 AND "sessionId" = $2 AND "jobId" = $3 AND "artifactId" = $4
      AND "version" = $5 AND "artifactType" = 'cover_letter' AND "taskId" = $6 LIMIT 2`,
  [scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version, scope.taskId])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.artifactId === scope.artifactId && row.artifactType === "cover_letter"
    && row.taskId === scope.taskId && row.version === scope.version && typeof row.contentHash === "string"
    && SHA256.test(row.contentHash) && typeof row.sourceDigest === "string" && SHA256.test(row.sourceDigest)
    && (row.previousHash === null || typeof row.previousHash === "string" && SHA256.test(row.previousHash)) ? row : null
}
async function readStaleReviewReceipt(client: PoolClient, scope: Omit<AgentArtifactReviewReceipt, "currentSourceDigest" | "toolCallId">): Promise<AgentArtifactReviewReceipt | null> {
  const result = await client.query<AgentArtifactReviewReceipt>(`SELECT "userId", "sessionId", "jobId", "artifactId", "version", "contentHash",
    "sourceDigest", "currentSourceDigest", "status", "taskId", "toolCallId", "reviewHash" FROM "agent_artifact_review"
    WHERE "userId"=$1 AND "sessionId"=$2 AND "jobId"=$3 AND "artifactId"=$4 AND "version"=$5 AND "contentHash"=$6
      AND "sourceDigest"=$7 AND "status"='stale' AND "taskId"=$8 AND "reviewHash"=$9 LIMIT 2`,
  [scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version, scope.contentHash, scope.sourceDigest, scope.taskId, scope.reviewHash])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.userId === scope.userId && row.sessionId === scope.sessionId && row.jobId === scope.jobId
    && row.artifactId === scope.artifactId && row.version === scope.version && row.contentHash === scope.contentHash
    && row.sourceDigest === scope.sourceDigest && row.status === "stale" && row.taskId === scope.taskId
    && row.reviewHash === scope.reviewHash && SHA256.test(row.currentSourceDigest) && typeof row.toolCallId === "string" && row.toolCallId.trim()
    ? row : null
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function sameWitness(left: ObjectiveTailorWaveCompletionWitness, right: ObjectiveTailorWaveCompletionWitness): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function blocked(outcomes: readonly ObjectiveTailorWaveSlotOutcome[]): ObjectiveTailorWaveCompletionResult { return { status: "blocked", outcomes } }
