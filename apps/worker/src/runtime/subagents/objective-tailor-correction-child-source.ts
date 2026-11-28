import type pg from "pg"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { parseObjectiveTailorCorrectionProof, type ObjectiveTailorCorrectionProof } from "./objective-tailor-correction-witness.js"
import { readObjectiveTailorWaveInventory, type ObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { parseObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type Occupied = import("./objective-tailor-wave-inventory.js").ObjectiveTailorWaveOccupiedSlot

/** Rebinds a correction child to the exact private slot stored with its live graph and task row. */
export async function readObjectiveTailorCorrectionChildBinding(input: Readonly<{
  client: Queryable; scope: GraphIdentityScope; loaded: LoadedGraph; taskId: string; role: "writer" | "reviewer"; context: unknown
  inventory?: ObjectiveTailorWaveInventory; dependency?: unknown
}>): Promise<Readonly<{ proof: ObjectiveTailorCorrectionProof; slot: Occupied }> | undefined> {
  const context = record(input.context), proof = parseObjectiveTailorCorrectionProof(context?.objectiveTailorCorrectionProof)
  const witness = parseObjectiveTailorWaveCandidateWitness(context?.objectiveTailorCandidateWitness)
  const selected = record(context?.selectedJobPreparation)
  if (!proof || !witness || context?.objectiveTailorCandidateMode !== true || !input.loaded.snapshot || !input.loaded.state
    || canonicalTaskGraphJson(witness) !== canonicalTaskGraphJson(proof.candidateWitness)
    || !selected || Reflect.ownKeys(selected).length !== 1 || selected.jobId !== witness.candidate.jobId
    || Object.hasOwn(input, "dependency") && !objectiveTailorCorrectionDependencyMatches(proof, input.dependency)) return undefined
  const inventory = input.inventory ?? await readObjectiveTailorWaveInventory(input.client, input.scope, input.loaded)
  if (!inventory?.marker) return undefined
  const matches = inventory.occupiedSlots.filter(slot => {
    const correction = slot.correction
    return (input.role === "writer" ? correction?.writerTaskId : correction?.reviewerTaskId) === input.taskId
  })
  const slot = matches[0]
  if (matches.length !== 1 || !slot?.correction || slot.correction.writerTaskId === slot.correction.reviewerTaskId
    || canonicalTaskGraphJson(slot.correction.proof) !== canonicalTaskGraphJson(proof)
    || canonicalTaskGraphJson(slot.witness) !== canonicalTaskGraphJson(proof.candidateWitness)
    || slot.writerTaskId !== proof.prior.writerTaskId || slot.reviewerTaskId !== proof.prior.reviewerTaskId) return undefined
  const marker = inventory.marker.slots.filter(item => item.slotId === proof.slotId)
  const initialWriter = input.loaded.snapshot.nodes.filter(node => node.key === proof.candidateWitness.writerNodeKey)
  const initialReviewer = input.loaded.snapshot.nodes.filter(node => node.key === proof.candidateWitness.reviewerNodeKey)
  const correctionWriter = input.loaded.snapshot.nodes.filter(node => node.key === proof.writerNodeKey)
  const correctionReviewer = input.loaded.snapshot.nodes.filter(node => node.key === proof.reviewerNodeKey)
  if (marker.length !== 1 || marker[0]?.writerNodeKey !== proof.candidateWitness.writerNodeKey
    || marker[0]?.reviewerNodeKey !== proof.candidateWitness.reviewerNodeKey
    || marker[0]?.correction?.writerNodeKey !== proof.writerNodeKey || marker[0]?.correction?.reviewerNodeKey !== proof.reviewerNodeKey
    || initialWriter.length !== 1 || initialReviewer.length !== 1 || correctionWriter.length !== 1 || correctionReviewer.length !== 1
    || initialWriter[0]?.taskId !== slot.writerTaskId || initialReviewer[0]?.taskId !== slot.reviewerTaskId
    || correctionWriter[0]?.taskId !== slot.correction.writerTaskId || correctionReviewer[0]?.taskId !== slot.correction.reviewerTaskId
    || correctionWriter[0]?.templateId !== "cover_letter_writer" || correctionReviewer[0]?.templateId !== "cover_letter_reviewer"
    || !correctionReviewer[0]?.dependsOn.includes(proof.writerNodeKey)
    || !correctionWriter[0]?.dependsOn.includes(proof.candidateWitness.reviewerNodeKey)) return undefined
  const task = input.loaded.tasks.get(input.taskId), state = input.loaded.state.nodes.find(node => node.taskId === input.taskId)
  if (!task || !state || task.id !== input.taskId || task.role !== input.role || task.status !== state.status
    || input.role === "writer" && task.taskType !== "cover_letter_draft"
    || input.role === "reviewer" && task.taskType !== "cover_letter_review") return undefined
  return { proof, slot }
}

export function objectiveTailorCorrectionDependencyMatches(binding: ObjectiveTailorCorrectionProof, value: unknown): boolean {
  const dependency = record(value), ref = record(dependency?.artifactRef), prior = binding.prior
  return dependency?.dependencyKey === binding.candidateWitness.reviewerNodeKey
    && dependency.dependencyTaskId === prior.reviewerTaskId && dependency.reviewHash === prior.reviewReceipt.reviewHash
    && ref?.artifactId === prior.artifactRef.artifactId && ref.version === prior.artifactRef.version
    && ref.contentHash === prior.artifactRef.contentHash && ref.sourceDigest === prior.artifactRef.sourceDigest
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
