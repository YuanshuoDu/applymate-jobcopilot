import type { ObjectiveTailorProgressSnapshot } from "../session/objective-tailor-progress-snapshot"
import { canonicalTaskGraphSourceKey } from "../session/final-task-graph-source-detail"
import type { FinalTaskGraphSourceManifest } from "../session/final-task-graph-source-manifest"
import { parseObjectiveApplicationReviewMemberProof } from "@jobcopilot/shared"
import type { ObjectiveApprovalSetSourceInput } from "./objective-application-approval-set-decision"

type Source = Readonly<{ slotOrdinal: number; writerTaskId: string; reviewerTaskId: string; artifactId: string; version: number;
  contentHash: string; sourceDigest: string; reviewHash: string }>
type Task = Readonly<Record<string, unknown>>
type Artifact = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
export type ObjectiveApplicationReviewArtifactHead = Readonly<{ artifactId: string; version: number; hash: string }>
type Prior = Readonly<{ writerTaskId: string; reviewerTaskId: string; artifactRef: Artifact; reviewHash: string; toolCallId: string }>
type CandidateWitness = Readonly<{ slotId: string; writerNodeKey: string; reviewerNodeKey: string; sourceAnalystKeys: readonly string[];
  admittedRevision: number; candidate: Readonly<{ jobId: string; materialDigest: string }> }>
type CorrectionProof = Readonly<{ schemaVersion: string; graphRevision: number; admittedRevision: number; slotId: string;
  writerNodeKey: string; reviewerNodeKey: string; candidateWitness: CandidateWitness; prior: Prior }>
export type ObjectiveApplicationReviewPairProof = Readonly<{ artifactRef: Artifact; reviewHash: string; prior?: Prior }>

const RESULT_SCHEMA = "agent-harness.v2.subagent.result"
const CANDIDATE_SCHEMA = "agent-harness.v2.objective-tailor-wave-witness.v1"
const CORRECTION_SCHEMA = "agent-harness.v2.objective-tailor-correction-proof.v1"
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const TASK = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const HASH = /^sha256:[a-f0-9]{64}$/
const REVIEW_TEXT = "Review the selected verified materials. This does not authorize an application or submission."
const MATERIAL_HASH = /^sha256:[a-f0-9]{64}$/

export function validObjectiveApplicationReviewContent(value: unknown): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 1
    || Reflect.ownKeys(value).length !== 2) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, "0")
  const row = descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? exactRecord(descriptor.value, "text,type") : undefined
  return !!row && row.type === "text" && row.text === REVIEW_TEXT
}

export function parseObjectiveApplicationReviewArtifactHead(value: unknown): ObjectiveApplicationReviewArtifactHead | undefined {
  const row = exactRecord(value, "hash,id,version")
  return row && typeof row.id === "string" && ID.test(row.id) && Number.isSafeInteger(row.version) && Number(row.version) > 0
    && typeof row.hash === "string" && MATERIAL_HASH.test(row.hash)
    ? { artifactId: row.id, version: Number(row.version), hash: row.hash } : undefined
}

export function objectiveApplicationReviewInputValid(input: ObjectiveApprovalSetSourceInput,
  proof: NonNullable<ReturnType<typeof parseObjectiveApplicationReviewMemberProof>>): boolean {
  const member = input.member, source = proof.source
  return [input.setId, input.intentHash, input.sourceTurnId, member.userId, member.sessionId, member.turnId, member.approvalId,
    member.jobId, member.toolCallId].every(value => typeof value === "string" && ID.test(value) && value.trim() === value)
    && /^[a-f0-9]{64}$/.test(input.intentHash) && Number.isSafeInteger(input.slotOrdinal) && input.slotOrdinal === source.slotOrdinal
    && member.jobId === source.jobId && member.userId === proof.resumeWitness.userId && member.jobId === proof.resumeWitness.jobId
    && input.sourceTurnId === source.sourceTurnId
}

export function validObjectiveApplicationSourceManifest(manifest: FinalTaskGraphSourceManifest, finalItemId: string,
  snapshot: ObjectiveTailorProgressSnapshot, tasks: ReadonlyMap<string, unknown>): boolean {
  const historical = manifest.schemaVersion === "agent-harness.v2.task-graph-sources.v2" ? manifest.historicalNodeIndices : []
  if (historical.some(index => index >= snapshot.marker.sourceNodeCount)) return false
  const indices = Array.from({ length: snapshot.marker.sourceNodeCount }, (_, index) => index).filter(index => !historical.includes(index))
  return indices.length === manifest.sources.length && manifest.sources.every((source, index) => {
    const nodeIndex = indices[index], node = nodeIndex === undefined ? undefined : snapshot.nodes[nodeIndex]
    const task = node && record(tasks.get(node.taskId)), result = task && structured(task.result)
    return !!node && !!task && !!result && source.nodeIndex === nodeIndex
      && source.sourceKey === canonicalTaskGraphSourceKey(finalItemId, manifest.graphRevision, nodeIndex)
      && source.role === node.templateId && (source.role === "scout" || source.role === "analyst")
      && source.taskStatus === task.status && source.resultState === "valid"
      && source.roleResultStatus === result.status && (result.status === "completed" || result.status === "partial")
  })
}

/** Binds the selected final slot to its effective persisted Writer/Reviewer pair and private task contexts. */
export function objectiveApplicationReviewPairProof(input: Readonly<{
  snapshot: ObjectiveTailorProgressSnapshot; slotOrdinal: number; graphRevision: number; jobId: string; source: Source
  writerTask: Task; reviewerTask: Task; tasks: ReadonlyMap<string, unknown>
}>): ObjectiveApplicationReviewPairProof | undefined {
  const slot = input.snapshot.marker.slots[input.slotOrdinal - 1]
  if (!slot || slot.slotId !== "tailor-" + input.slotOrdinal) return undefined
  const correction = slot.correction, writerKey = correction?.writerNodeKey ?? slot.writerNodeKey
  const reviewerKey = correction?.reviewerNodeKey ?? slot.reviewerNodeKey
  const writerNode = input.snapshot.nodes.find(node => node.key === writerKey)
  const reviewerNode = input.snapshot.nodes.find(node => node.key === reviewerKey)
  if (!writerNode || !reviewerNode || writerNode.taskId !== input.source.writerTaskId || reviewerNode.taskId !== input.source.reviewerTaskId
    || writerNode.templateId !== "cover_letter_writer" || reviewerNode.templateId !== "cover_letter_reviewer"
    || input.writerTask.id !== writerNode.taskId || input.reviewerTask.id !== reviewerNode.taskId
    || input.writerTask.status !== "completed" || input.reviewerTask.status !== "completed") return undefined
  const candidate = candidateContext(input.writerTask.context, input.jobId, slot, input.graphRevision, correction)
  const reviewerCandidate = candidateContext(input.reviewerTask.context, input.jobId, slot, input.graphRevision, correction)
  if (!candidate || !reviewerCandidate || JSON.stringify(candidate) !== JSON.stringify(reviewerCandidate)) return undefined
  let prior: Prior | undefined
  if (correction) {
    const initialWriter = input.snapshot.nodes.find(node => node.key === slot.writerNodeKey)
    const initialReviewer = input.snapshot.nodes.find(node => node.key === slot.reviewerNodeKey)
    const writer = initialWriter && record(input.tasks.get(initialWriter.taskId))
    const reviewer = initialReviewer && record(input.tasks.get(initialReviewer.taskId))
    const priorWriter = writer && roleResult(writer.result, "writer"), priorReview = reviewer && roleResult(reviewer.result, "reviewer")
    const proof = correctionContext(input.writerTask.context), reviewerProof = correctionContext(input.reviewerTask.context)
    if (!writer || !reviewer || typeof writer.id !== "string" || typeof reviewer.id !== "string"
      || writer.status !== "completed" || reviewer.status !== "completed" || !priorWriter || !priorReview
      || priorReview.reviewStatus !== "needs_revision" || !proof || !reviewerProof || JSON.stringify(proof) !== JSON.stringify(reviewerProof)
      || proof.slotId !== slot.slotId || proof.candidateWitness.candidate.jobId !== input.jobId
      || proof.prior.writerTaskId !== writer.id || proof.prior.reviewerTaskId !== reviewer.id
      || !sameArtifact(proof.prior.artifactRef, priorWriter.artifactRef) || !sameArtifact(proof.prior.artifactRef, priorReview.artifactRef)
      || proof.prior.reviewHash !== priorReview.reviewHash) return undefined
    prior = proof.prior
  }
  const writerResult = roleResult(input.writerTask.result, "writer"), reviewerResult = roleResult(input.reviewerTask.result, "reviewer")
  if (!writerResult || !reviewerResult || reviewerResult.reviewStatus !== "passed"
    || !sameArtifact(writerResult.artifactRef, reviewerResult.artifactRef)
    || writerResult.artifactRef.artifactId !== input.source.artifactId || writerResult.artifactRef.version !== input.source.version
    || writerResult.artifactRef.contentHash !== input.source.contentHash || writerResult.artifactRef.sourceDigest !== input.source.sourceDigest
    || reviewerResult.reviewHash !== input.source.reviewHash) return undefined
  return { artifactRef: writerResult.artifactRef, reviewHash: reviewerResult.reviewHash, ...(prior ? { prior } : {}) }
}

function candidateContext(value: unknown, jobId: string, slot: ObjectiveTailorProgressSnapshot["marker"]["slots"][number],
  revision: number, correction: ObjectiveTailorProgressSnapshot["marker"]["slots"][number]["correction"]): CandidateWitness | undefined {
  const expected = correction ? "objectiveTailorCandidateMode,objectiveTailorCandidateWitness,objectiveTailorCorrectionProof,selectedJobPreparation"
    : "objectiveTailorCandidateMode,objectiveTailorCandidateWitness,selectedJobPreparation"
  const context = record(value), selected = context && exactRecord(context.selectedJobPreparation, "jobId")
  const witness = context && candidateWitness(context.objectiveTailorCandidateWitness)
  const parsedCorrection = correctionContext(value)
  return context && exact(context, expected) && context.objectiveTailorCandidateMode === true && selected?.jobId === jobId
    && witness && witness.slotId === slot.slotId && witness.candidate.jobId === jobId && witness.admittedRevision <= revision
    && witness.writerNodeKey === slot.writerNodeKey && witness.reviewerNodeKey === slot.reviewerNodeKey
    && witness.sourceAnalystKeys.length === 1 && witness.sourceAnalystKeys[0] === slot.sourceAnalystNodeKey
    && (correction ? !!parsedCorrection && parsedCorrection.slotId === slot.slotId
      && parsedCorrection.writerNodeKey === correction.writerNodeKey && parsedCorrection.reviewerNodeKey === correction.reviewerNodeKey
      && parsedCorrection.graphRevision < revision && parsedCorrection.admittedRevision <= revision
      && JSON.stringify(parsedCorrection.candidateWitness) === JSON.stringify(witness) : !parsedCorrection)
    ? witness : undefined
}

function candidateWitness(value: unknown): CandidateWitness | undefined {
  const row = exactRecord(value, "admittedRevision,analystProofDigest,candidate,candidateRef,reviewerNodeKey,schemaVersion,slotId,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest,writerNodeKey")
  const candidate = row && exactRecord(row.candidate, "jobId,materialDigest,score"), sources = denseStrings(row?.sourceAnalystKeys)
  return row?.schemaVersion === CANDIDATE_SCHEMA && typeof row.candidateRef === "string" && /^otc2_[a-f0-9]{64}$/.test(row.candidateRef)
    && positive(row.sourceGraphRevision) && positive(row.admittedRevision) && row.admittedRevision > row.sourceGraphRevision
    && [row.sourceGraphDigest, row.sourceStatusDigest, row.analystProofDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))
    && candidate && typeof candidate.jobId === "string" && ID.test(candidate.jobId) && typeof candidate.materialDigest === "string"
    && HASH.test(candidate.materialDigest) && typeof row.slotId === "string" && TASK.test(row.slotId)
    && typeof row.writerNodeKey === "string" && TASK.test(row.writerNodeKey)
    && typeof row.reviewerNodeKey === "string" && TASK.test(row.reviewerNodeKey)
    && typeof candidate.score === "number" && Number.isFinite(candidate.score) && candidate.score >= 0 && candidate.score <= 10
    && sources ? { slotId: row.slotId, writerNodeKey: row.writerNodeKey, reviewerNodeKey: row.reviewerNodeKey,
      sourceAnalystKeys: sources, admittedRevision: Number(row.admittedRevision),
      candidate: { jobId: candidate.jobId, materialDigest: candidate.materialDigest } } : undefined
}

function correctionContext(value: unknown): CorrectionProof | undefined {
  const context = record(value), proof = context && exactRecord(context.objectiveTailorCorrectionProof,
    "admittedRevision,candidateWitness,graphRevision,prior,reviewerNodeKey,schemaVersion,slotId,writerNodeKey")
  const candidate = proof && candidateWitness(proof.candidateWitness), prior = proof && exactRecord(proof.prior,
    "artifactRef,artifactVersion,reviewReceipt,reviewerTaskId,writerTaskId")
  const ref = prior && artifactRef(prior.artifactRef), version = prior && exactRecord(prior.artifactVersion,
    "artifactId,artifactType,contentHash,previousHash,sourceDigest,taskId,version")
  const receipt = prior && exactRecord(prior.reviewReceipt,
    "artifactId,contentHash,currentSourceDigest,jobId,reviewHash,sourceDigest,status,taskId,toolCallId,version")
  if (!proof || proof.schemaVersion !== CORRECTION_SCHEMA || !positive(proof.graphRevision) || !positive(proof.admittedRevision)
    || proof.admittedRevision !== proof.graphRevision + 1 || typeof proof.slotId !== "string" || !TASK.test(proof.slotId)
    || typeof proof.writerNodeKey !== "string" || !TASK.test(proof.writerNodeKey)
    || typeof proof.reviewerNodeKey !== "string" || !TASK.test(proof.reviewerNodeKey) || !candidate || !ref || !version || !receipt
    || proof.slotId !== candidate.slotId || !safeId(prior?.writerTaskId) || !safeId(prior?.reviewerTaskId)
    || version.artifactType !== "cover_letter" || version.taskId !== prior.writerTaskId || version.version !== ref.version
    || version.artifactId !== ref.artifactId || version.contentHash !== ref.contentHash || version.sourceDigest !== ref.sourceDigest
    || !(version.previousHash === null || typeof version.previousHash === "string" && HASH.test(version.previousHash))
    || receipt.jobId !== candidate.candidate.jobId || receipt.status !== "needs_revision" || receipt.taskId !== prior.reviewerTaskId
    || receipt.artifactId !== ref.artifactId || receipt.version !== ref.version || receipt.contentHash !== ref.contentHash
    || receipt.sourceDigest !== ref.sourceDigest || receipt.currentSourceDigest !== ref.sourceDigest
    || typeof receipt.reviewHash !== "string" || !HASH.test(receipt.reviewHash)
    || typeof receipt.toolCallId !== "string" || !ID.test(receipt.toolCallId)) return undefined
  return { schemaVersion: CORRECTION_SCHEMA, graphRevision: proof.graphRevision, admittedRevision: proof.admittedRevision,
    slotId: proof.slotId, writerNodeKey: proof.writerNodeKey, reviewerNodeKey: proof.reviewerNodeKey, candidateWitness: candidate,
    prior: { writerTaskId: prior.writerTaskId as string, reviewerTaskId: prior.reviewerTaskId as string, artifactRef: ref,
      reviewHash: receipt.reviewHash, toolCallId: receipt.toolCallId } }
}

function roleResult(value: unknown, role: "writer" | "reviewer") {
  const envelope = record(value), resultKeys = role === "writer" ? "artifactRef,role,schemaVersion,status" : "artifactRef,reviewHash,reviewStatus,role,schemaVersion,status"
  const result = envelope && exactRecord(envelope.structuredResult, resultKeys), ref = result && artifactRef(result.artifactRef)
  return envelope && exact(envelope, "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount") && envelope.status === "completed"
    && (envelope.finalItemId === null || ID.test(String(envelope.finalItemId))) && typeof envelope.finalText === "string"
    && Number.isSafeInteger(envelope.stepCount) && Number(envelope.stepCount) >= 0
    && Number.isSafeInteger(envelope.toolCallCount) && Number(envelope.toolCallCount) >= 0
    && result?.schemaVersion === RESULT_SCHEMA && result.role === role && result.status === "completed" && ref
    && (role === "writer" || ["passed", "needs_revision", "rejected"].includes(String(result.reviewStatus)) && HASH.test(String(result.reviewHash)))
    ? { artifactRef: ref, ...(role === "reviewer" ? { reviewStatus: result.reviewStatus, reviewHash: result.reviewHash } : {}) } : undefined
}

function artifactRef(value: unknown): Artifact | undefined {
  const row = exactRecord(value, "artifactId,contentHash,sourceDigest,version")
  return row && typeof row.artifactId === "string" && TASK.test(row.artifactId) && positive(row.version)
    && HASH.test(String(row.contentHash)) && HASH.test(String(row.sourceDigest))
    ? { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash as string, sourceDigest: row.sourceDigest as string } : undefined
}
function sameArtifact(a: Artifact, b: Artifact): boolean { return a.artifactId === b.artifactId && a.version === b.version && a.contentHash === b.contentHash && a.sourceDigest === b.sourceDigest }
function exact(value: Record<string, unknown>, csv: string): boolean { return Reflect.ownKeys(value).length === csv.split(",").length && Object.keys(value).sort().join(",") === csv.split(",").sort().join(",") }
function exactRecord(value: unknown, csv: string): Record<string, unknown> | undefined { const row = record(value); return row && exact(row, csv) ? row : undefined }
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const keys = Reflect.ownKeys(value); return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Record<string, unknown> : undefined } catch { return undefined }
}
function denseStrings(value: unknown): string[] | undefined { return Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype
  && Reflect.ownKeys(value).length === value.length + 1 && value.length <= 1 && value.every(item => typeof item === "string" && TASK.test(item)) ? value : undefined }
function structured(value: unknown): Record<string, unknown> | undefined {
  const envelope = record(typeof value === "string" ? parseJson(value) : value), result = envelope && record(envelope.structuredResult)
  return envelope && exact(envelope, "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount")
    && envelope.status === "completed" && result && typeof result.role === "string"
    && (result.status === "completed" || result.status === "partial") ? result : undefined
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 }
function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
