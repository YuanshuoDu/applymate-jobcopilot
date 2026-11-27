import { parseObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import type { ObjectiveTailorCorrectionProof } from "./subagents/objective-tailor-correction-witness.js"
import { parseObjectiveTailorCorrectionProof } from "./subagents/objective-tailor-correction-witness.js"
import { parseObjectiveTailorWaveCandidateWitness } from "./subagents/objective-tailor-wave-witness.js"
import type { ObjectiveTailorWaveCompletionResult, ObjectiveTailorWaveSlotStatus } from "./canonical-objective-tailor-wave-completion.js"
import { canonicalTaskGraphJson } from "./subagents/task-graph-snapshot.js"

export const OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA = "agent-harness.v2.objective-tailor-wave-outcomes.v1" as const
export type ObjectiveTailorWaveOutcomeObservation = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA
  graphRevision: number
  slots: readonly Readonly<{
    slotId: string
    effectivePair: "initial" | "correction"
    status: ObjectiveTailorWaveSlotStatus
  }>[]
}>

/** Projects only ordered slot state from canonical proof already read on the caller's locked graph. */
export function projectObjectiveTailorWaveOutcomeObservation(input: Readonly<{
  graphRevision: number; marker: unknown; nodes: unknown; result: ObjectiveTailorWaveCompletionResult
}>): ObjectiveTailorWaveOutcomeObservation | undefined {
  try {
    if (!Number.isSafeInteger(input.graphRevision) || input.graphRevision < 1) return undefined
    const marker = parseObjectiveTailorGraph(input.marker, input.nodes)
    if (!marker) return undefined
    const result = record(input.result), status = result?.status
    if (!result || status !== "pending" && status !== "ready") return undefined
    const outcomes = dense(result.outcomes, marker.slots.length)
    if (!outcomes || outcomes.length !== marker.slots.length) return undefined
    if (status === "ready" && !readyWitnessMatches(result, marker, outcomes, input.graphRevision)) return undefined
    if (status === "pending" && hasOwn(result, "witness")) return undefined

    const nodeRows = dense(input.nodes, 40), nodesByKey = new Map<string, Record<string, unknown>>()
    if (!nodeRows) return undefined
    for (const value of nodeRows) {
      const node = record(value)
      if (!node || typeof node.key !== "string" || nodesByKey.has(node.key)) return undefined
      nodesByKey.set(node.key, node)
    }
    const slots: ObjectiveTailorWaveOutcomeObservation["slots"][number][] = []
    const seen = new Set<string>()
    let hasPending = false
    for (const [index, expected] of marker.slots.entries()) {
      const outcome = record(outcomes[index]), candidate = parseObjectiveTailorWaveCandidateWitness(outcome?.candidateWitness)
      if (!outcome || outcome.slotId !== expected.slotId || seen.has(expected.slotId) || !candidate
        || candidate.slotId !== expected.slotId || candidate.writerNodeKey !== expected.writerNodeKey
        || candidate.reviewerNodeKey !== expected.reviewerNodeKey || candidate.sourceAnalystKeys[0] !== expected.sourceAnalystNodeKey
        || candidate.admittedRevision > input.graphRevision || !isStatus(outcome.status)) return undefined
      seen.add(expected.slotId)
      const initialWriter = nodesByKey.get(expected.writerNodeKey), initialReviewer = nodesByKey.get(expected.reviewerNodeKey)
      if (!initialWriter || !initialReviewer) return undefined
      const correction = expected.correction
      if (correction) {
        if (!validCorrection(outcome, candidate, correction, initialWriter.taskId, initialReviewer.taskId,
          nodesByKey.get(correction.writerNodeKey)?.taskId, nodesByKey.get(correction.reviewerNodeKey)?.taskId, input.graphRevision)) return undefined
      } else if (hasOwn(outcome, "correction") || !safeTaskId(initialWriter.taskId) || !safeTaskId(initialReviewer.taskId)
        || outcome.writerTaskId !== initialWriter.taskId || outcome.reviewerTaskId !== initialReviewer.taskId) return undefined
      if (outcome.status === "pending") hasPending = true
      slots.push({ slotId: expected.slotId, effectivePair: correction ? "correction" : "initial", status: outcome.status })
    }
    if (seen.size !== marker.slots.length || (status === "pending") !== hasPending) return undefined
    return { schemaVersion: OBJECTIVE_TAILOR_WAVE_OUTCOME_SCHEMA, graphRevision: input.graphRevision, slots }
  } catch { return undefined }
}

function validCorrection(outcome: Record<string, unknown>, candidate: ReturnType<typeof parseObjectiveTailorWaveCandidateWitness>,
  expected: Readonly<{ writerNodeKey: string; reviewerNodeKey: string }>, initialWriterId: unknown, initialReviewerId: unknown,
  correctionWriterId: unknown, correctionReviewerId: unknown, graphRevision: number): boolean {
  const binding = record(outcome.correction), proof = parseObjectiveTailorCorrectionProof(binding?.proof)
  return !!candidate && !!binding && exactKeys(binding, ["proof", "writerTaskId", "reviewerTaskId"]) && !!proof
    && sameCorrection(proof, candidate, expected, initialWriterId, initialReviewerId, correctionWriterId, correctionReviewerId, graphRevision)
    && outcome.writerTaskId === correctionWriterId && outcome.reviewerTaskId === correctionReviewerId
    && binding.writerTaskId === correctionWriterId && binding.reviewerTaskId === correctionReviewerId
}

function sameCorrection(proof: ObjectiveTailorCorrectionProof, candidate: NonNullable<ReturnType<typeof parseObjectiveTailorWaveCandidateWitness>>,
  expected: Readonly<{ writerNodeKey: string; reviewerNodeKey: string }>, initialWriterId: unknown, initialReviewerId: unknown,
  correctionWriterId: unknown, correctionReviewerId: unknown, graphRevision: number): boolean {
  return proof.slotId === candidate.slotId && proof.writerNodeKey === expected.writerNodeKey && proof.reviewerNodeKey === expected.reviewerNodeKey
    && canonicalTaskGraphJson(proof.candidateWitness) === canonicalTaskGraphJson(candidate)
    && proof.prior.writerTaskId === initialWriterId && proof.prior.reviewerTaskId === initialReviewerId
    && proof.admittedRevision <= graphRevision && safeTaskId(correctionWriterId) && safeTaskId(correctionReviewerId)
    && new Set([initialWriterId, initialReviewerId, correctionWriterId, correctionReviewerId]).size === 4
}

function readyWitnessMatches(result: Record<string, unknown>, marker: unknown, outcomes: unknown[], graphRevision: number): boolean {
  const witness = record(result.witness)
  return !!witness && witness.graphRevision === graphRevision
    && canonicalTaskGraphJson(witness.marker) === canonicalTaskGraphJson(marker)
    && canonicalTaskGraphJson(witness.outcomes) === canonicalTaskGraphJson(outcomes)
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const keys = Reflect.ownKeys(value), proto = Object.getPrototypeOf(value)
    return (proto === Object.prototype || proto === null) && keys.every(key => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!)
      ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}
function dense(value: unknown, max: number): unknown[] | undefined {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max
    || Reflect.ownKeys(value).length !== value.length + 1) return undefined
  const values: unknown[] = []
  for (let index = 0; index < value.length; index++) {
    const item = Object.getOwnPropertyDescriptor(value, String(index))
    if (!item?.enumerable || !("value" in item)) return undefined
    values.push(item.value)
  }
  return values
}
function isStatus(value: unknown): value is ObjectiveTailorWaveSlotStatus {
  return value === "pending" || value === "ready" || value === "needs_revision" || value === "rejected" || value === "stale" || value === "failed"
}
function safeTaskId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) }
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.hasOwn(value, key) }
