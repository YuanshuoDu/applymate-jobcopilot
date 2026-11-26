import type { ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { objectiveApplicationReviewPairProof } from "../broker/objective-application-review-source-proof"
import type { ObjectiveJourneyProofContext } from "./objective-journey-report-source"

type Row = Record<string, unknown>
type Progress = ObjectiveJourneyProofContext["progress"]
type Tasks = ObjectiveJourneyProofContext["tasks"]
type ArtifactRef = Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
type PriorArtifact = Readonly<{
  writerTaskId: string; reviewerTaskId: string; artifactRef: ArtifactRef; reviewHash: string; toolCallId: string
}>

export type ObjectiveJourneySlotCandidate = Readonly<{
  jobId: string; sourceAnalystKeys: readonly string[]; analystProofDigest: string; jobMaterialDigest: string
}>
export type ObjectiveJourneyReadySlotProof = Readonly<{
  ordinal: number; jobId: string; writerTaskId: string; reviewerTaskId: string
  artifactRef: ArtifactRef; reviewHash: string; prior?: PriorArtifact
}>

export function readObjectiveJourneyReadySlot(context: ObjectiveJourneyProofContext, ordinal: number): ObjectiveJourneyReadySlotProof | null {
  const marker = context.progress.marker.slots[ordinal - 1]
  const sidecar = context.sidecar.slots[ordinal - 1]
  const candidate = marker && sidecar?.status === "ready"
    ? readObjectiveJourneySlotCandidate(marker, ordinal, context.graphRevision, context.progress, context.tasks) : undefined
  const candidates = context.progress.marker.slots.map((slot, index) =>
    readObjectiveJourneySlotCandidate(slot, index + 1, context.graphRevision, context.progress, context.tasks))
  if (!candidate || candidates.filter(value => value?.jobId === candidate.jobId).length !== 1) return null
  const pair = readObjectiveJourneySlotPair(marker!, ordinal, context.graphRevision, candidate.jobId, context.progress, context.tasks)
  return pair ? { ordinal, jobId: candidate.jobId, ...pair } : null
}

export function readObjectiveJourneySlotCandidate(slot: ObjectiveTailorGraph["slots"][number], ordinal: number, revision: number,
  progress: Progress, tasks: Tasks): ObjectiveJourneySlotCandidate | undefined {
  const writerNode = progress.nodes.find(node => node.key === slot.writerNodeKey)
  const writer = writerNode && tasks.get(writerNode.taskId)
  const context = writer && record(writer.context)
  const selected = context && exactRecord(context.selectedJobPreparation, "jobId")
  const witness = context && candidateWitness(context.objectiveTailorCandidateWitness)
  const contextKeys = context && Object.keys(context).sort().join(",")
  const allowed = "objectiveTailorCandidateMode,objectiveTailorCandidateWitness,selectedJobPreparation"
  const withDependencies = `${allowed},taskGraphDependencyResults`
  const sourceNodes = new Map(progress.nodes.map(node => [node.key, node]))
  const sourceAnalystsMatch = witness?.sourceAnalystKeys.every(key => sourceNodes.get(key)?.templateId === "analyst")
  if (context?.objectiveTailorCandidateMode !== true || contextKeys !== allowed && contextKeys !== withDependencies
    || selected?.jobId !== witness?.jobId || witness?.slotId !== `tailor-${ordinal}`
    || witness.writerNodeKey !== slot.writerNodeKey || witness.reviewerNodeKey !== slot.reviewerNodeKey
    || !witness.sourceAnalystKeys.includes(slot.sourceAnalystNodeKey) || !sourceAnalystsMatch
    || witness.admittedRevision > revision) return undefined
  return { jobId: witness.jobId, sourceAnalystKeys: witness.sourceAnalystKeys,
    analystProofDigest: witness.analystProofDigest, jobMaterialDigest: witness.materialDigest }
}

export function readObjectiveJourneySlotPair(slot: ObjectiveTailorGraph["slots"][number], ordinal: number, revision: number,
  jobId: string, progress: Progress, tasks: Tasks) {
  const correction = slot.correction
  const writerNode = progress.nodes.find(node => node.key === (correction?.writerNodeKey ?? slot.writerNodeKey))
  const reviewerNode = progress.nodes.find(node => node.key === (correction?.reviewerNodeKey ?? slot.reviewerNodeKey))
  const writerTask = writerNode && tasks.get(writerNode.taskId)
  const reviewerTask = reviewerNode && tasks.get(reviewerNode.taskId)
  const source = pairSource(ordinal, writerNode?.taskId, reviewerNode?.taskId, writerTask?.result, reviewerTask?.result)
  if (!writerNode || !reviewerNode || !writerTask || !reviewerTask || !source) return undefined
  const proof = objectiveApplicationReviewPairProof({ snapshot: progress, slotOrdinal: ordinal,
    graphRevision: revision, jobId, source, writerTask, reviewerTask, tasks })
  return proof ? { writerTaskId: writerNode.taskId, reviewerTaskId: reviewerNode.taskId,
    artifactRef: proof.artifactRef, reviewHash: proof.reviewHash, ...(proof.prior ? { prior: proof.prior } : {}) } : undefined
}

function pairSource(slotOrdinal: number, writerTaskId: string | undefined, reviewerTaskId: string | undefined,
  writerValue: unknown, reviewerValue: unknown) {
  const writer = record(record(writerValue)?.structuredResult)
  const reviewer = record(record(reviewerValue)?.structuredResult)
  const ref = record(writer?.artifactRef)
  if (!writerTaskId || !reviewerTaskId || !ref || !reviewer || !id(ref.artifactId)
    || typeof ref.version !== "number" || !Number.isSafeInteger(ref.version) || ref.version < 1
    || typeof ref.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.contentHash)
    || typeof ref.sourceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.sourceDigest)
    || typeof reviewer.reviewHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reviewer.reviewHash)) return undefined
  return { slotOrdinal, writerTaskId, reviewerTaskId, artifactId: ref.artifactId, version: ref.version,
    contentHash: ref.contentHash, sourceDigest: ref.sourceDigest, reviewHash: reviewer.reviewHash }
}

function candidateWitness(value: unknown): {
  jobId: string; slotId: string; writerNodeKey: string; reviewerNodeKey: string; sourceAnalystKeys: readonly string[]
  analystProofDigest: string; materialDigest: string; admittedRevision: number
} | undefined {
  const row = record(value)
  const candidate = row && record(row.candidate)
  const sources = row?.sourceAnalystKeys
  if (!row || !candidate
    || Object.keys(row).sort().join(",") !== "admittedRevision,analystProofDigest,candidate,candidateRef,reviewerNodeKey,schemaVersion,slotId,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest,writerNodeKey"
    || Object.keys(candidate).sort().join(",") !== "jobId,materialDigest,score"
    || !id(candidate.jobId) || typeof candidate.materialDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(candidate.materialDigest)
    || row.schemaVersion !== "agent-harness.v2.objective-tailor-wave-witness.v1"
    || typeof row.slotId !== "string" || typeof row.writerNodeKey !== "string" || typeof row.reviewerNodeKey !== "string"
    || !denseStrings(sources) || !Number.isSafeInteger(row.admittedRevision) || Number(row.admittedRevision) < 1
    || !Number.isSafeInteger(row.sourceGraphRevision) || Number(row.sourceGraphRevision) < 1
    || Number(row.admittedRevision) <= Number(row.sourceGraphRevision)
    || typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 10
    || typeof row.candidateRef !== "string" || !/^otc2_[a-f0-9]{64}$/.test(row.candidateRef)
    || ![row.analystProofDigest, row.sourceGraphDigest, row.sourceStatusDigest]
      .every(digest => typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest))) return undefined
  return { jobId: candidate.jobId, slotId: row.slotId, writerNodeKey: row.writerNodeKey,
    reviewerNodeKey: row.reviewerNodeKey, sourceAnalystKeys: sources, analystProofDigest: row.analystProofDigest as string,
    materialDigest: candidate.materialDigest, admittedRevision: Number(row.admittedRevision) }
}

function denseStrings(value: unknown): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 8) return false
  try {
    if (Reflect.ownKeys(value).length !== value.length + 1) return false
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !id(descriptor.value)) return false
      items.push(descriptor.value)
    }
    return new Set(items).size === items.length
  } catch { return false }
}

function exactRecord(value: unknown, keys: string): Row | undefined {
  const row = record(value)
  return row && Object.keys(row).sort().join(",") === keys ? row : undefined
}

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value)
    const plain = Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null
    const dataProperties = keys.every(key => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))
    return plain && dataProperties ? value as Row : undefined
  } catch { return undefined }
}

function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && value.trim() === value
}
