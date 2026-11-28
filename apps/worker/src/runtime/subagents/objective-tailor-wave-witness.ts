import { createHash } from "node:crypto"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import type { TaskGraphNodeProposal, TaskGraphProposal } from "../planning/task-graph.js"
import type { TaskGraphTaskTemplate } from "./task-graph-schedule-input.js"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"

export const OBJECTIVE_TAILOR_WAVE_SELECTION_SCHEMA = "agent-harness.v2.objective-tailor-wave-selection.v1" as const
export const OBJECTIVE_TAILOR_WAVE_WITNESS_SCHEMA = "agent-harness.v2.objective-tailor-wave-witness.v1" as const
const REF = /^otc2_[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{64}$/
const MATERIAL = /^sha256:[a-f0-9]{64}$/
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SLOT = /^tailor-([1-8])$/
const MAX_REVISION = 2_147_483_646
export const OBJECTIVE_TAILOR_WAVE_MAX_SELECTIONS = 4

export type ObjectiveTailorWaveCandidateProof = Readonly<{ jobId: string; score: number; materialDigest: string }>
export type ObjectiveTailorWaveCandidateSelection = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_WAVE_SELECTION_SCHEMA
  candidateRef: string
  sourceGraphRevision: number
  sourceGraphDigest: string
  sourceStatusDigest: string
  analystProofDigest: string
  candidate: ObjectiveTailorWaveCandidateProof
  sourceAnalystKeys: readonly [string]
}>
export type ObjectiveTailorWaveCandidateWitness = Omit<ObjectiveTailorWaveCandidateSelection, "schemaVersion"> & Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_WAVE_WITNESS_SCHEMA
  slotId: string
  writerNodeKey: string
  reviewerNodeKey: string
  admittedRevision: number
}>
export type ObjectiveTailorWavePairPlan = Readonly<{
  witness: ObjectiveTailorWaveCandidateWitness
  proposal: TaskGraphProposal
  templatesByNodeKey: ReadonlyMap<string, TaskGraphTaskTemplate>
}>

export function makeObjectiveTailorWaveCandidateSelection(input: Readonly<{
  scope: GraphIdentityScope
  sourceGraphRevision: number
  sourceGraphDigest: string
  sourceStatusDigest: string
  analystProofDigest: string
  candidate: ObjectiveTailorWaveCandidateProof
  sourceAnalystKey: string
}>): ObjectiveTailorWaveCandidateSelection | undefined {
  if (!validScope(input.scope) || !validRevision(input.sourceGraphRevision)
    || !isSha(input.sourceGraphDigest) || !isSha(input.sourceStatusDigest) || !isSha(input.analystProofDigest)
    || !parseCandidate(input.candidate) || !validNodeKey(input.sourceAnalystKey)) return undefined
  const core = { sourceGraphRevision: input.sourceGraphRevision, sourceGraphDigest: input.sourceGraphDigest,
    sourceStatusDigest: input.sourceStatusDigest, analystProofDigest: input.analystProofDigest,
    candidate: { ...input.candidate }, sourceAnalystKeys: [input.sourceAnalystKey] as const }
  const candidateRef = `otc2_${createHash("sha256").update(canonicalTaskGraphJson({
    scope: { userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
      rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.parentTaskId }, ...core,
  })).digest("hex")}`
  return { schemaVersion: OBJECTIVE_TAILOR_WAVE_SELECTION_SCHEMA, candidateRef, ...core }
}

function parseObjectiveTailorWaveCandidateSelection(value: unknown): ObjectiveTailorWaveCandidateSelection | undefined {
  const row = exactRecord(value, "analystProofDigest,candidate,candidateRef,schemaVersion,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest")
  if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_WAVE_SELECTION_SCHEMA || typeof row.candidateRef !== "string" || !REF.test(row.candidateRef)
    || !validRevision(row.sourceGraphRevision)
    || !isSha(row.sourceGraphDigest) || !isSha(row.sourceStatusDigest) || !isSha(row.analystProofDigest)
    || !parseCandidate(row.candidate) || !singleNodeKey(row.sourceAnalystKeys)) return undefined
  const candidate = parseCandidate(row.candidate)!
  return { schemaVersion: OBJECTIVE_TAILOR_WAVE_SELECTION_SCHEMA, candidateRef: row.candidateRef,
    sourceGraphRevision: Number(row.sourceGraphRevision), sourceGraphDigest: row.sourceGraphDigest as string,
    sourceStatusDigest: row.sourceStatusDigest as string, analystProofDigest: row.analystProofDigest as string,
    candidate, sourceAnalystKeys: [...row.sourceAnalystKeys as [string]] }
}

/** Reads only an ordered, dense list of distinct current opaque refs. */
export function parseObjectiveTailorWaveCandidateRefs(value: unknown): readonly string[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || value.length < 1 || value.length > OBJECTIVE_TAILOR_WAVE_MAX_SELECTIONS
      || Reflect.ownKeys(value).length !== value.length + 1) return undefined
    const refs: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string" || !REF.test(descriptor.value)) return undefined
      refs.push(descriptor.value)
    }
    return new Set(refs).size === refs.length ? refs : undefined
  } catch { return undefined }
}

function objectiveTailorWaveNodeKeys(candidateRef: string, slotId: string): Readonly<{ writerNodeKey: string; reviewerNodeKey: string }> | undefined {
  if (typeof candidateRef !== "string" || !REF.test(candidateRef) || !SLOT.test(slotId)) return undefined
  return { writerNodeKey: `objective-tailor-wave-writer-${slotId}`, reviewerNodeKey: `objective-tailor-wave-reviewer-${slotId}` }
}

export function bindObjectiveTailorWaveCandidateWitness(
  selectionValue: ObjectiveTailorWaveCandidateSelection, binding: Readonly<{ slotId: string; admittedRevision: number }>,
): ObjectiveTailorWaveCandidateWitness | undefined {
  const selection = parseObjectiveTailorWaveCandidateSelection(selectionValue)
  const keys = selection && objectiveTailorWaveNodeKeys(selection.candidateRef, binding.slotId)
  if (!selection || !keys || !validRevision(binding.admittedRevision)
    || binding.admittedRevision <= selection.sourceGraphRevision) return undefined
  return parseObjectiveTailorWaveCandidateWitness({ ...selection, schemaVersion: OBJECTIVE_TAILOR_WAVE_WITNESS_SCHEMA,
    slotId: binding.slotId, ...keys, admittedRevision: binding.admittedRevision })
}

export function parseObjectiveTailorWaveCandidateWitness(value: unknown): ObjectiveTailorWaveCandidateWitness | undefined {
  const row = exactRecord(value, "admittedRevision,analystProofDigest,candidate,candidateRef,reviewerNodeKey,schemaVersion,slotId,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest,writerNodeKey")
  if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_WAVE_WITNESS_SCHEMA || !validRevision(row.admittedRevision)
    || !validRevision(row.sourceGraphRevision) || Number(row.admittedRevision) <= Number(row.sourceGraphRevision)
    || typeof row.candidateRef !== "string" || !REF.test(row.candidateRef)
    || !isSha(row.sourceGraphDigest) || !isSha(row.sourceStatusDigest) || !isSha(row.analystProofDigest)
    || !parseCandidate(row.candidate) || !singleNodeKey(row.sourceAnalystKeys) || typeof row.slotId !== "string") return undefined
  const keys = objectiveTailorWaveNodeKeys(row.candidateRef, row.slotId)
  if (!keys || row.writerNodeKey !== keys.writerNodeKey || row.reviewerNodeKey !== keys.reviewerNodeKey) return undefined
  return { schemaVersion: OBJECTIVE_TAILOR_WAVE_WITNESS_SCHEMA, candidateRef: row.candidateRef, sourceGraphRevision: Number(row.sourceGraphRevision),
    sourceGraphDigest: row.sourceGraphDigest as string, sourceStatusDigest: row.sourceStatusDigest as string,
    analystProofDigest: row.analystProofDigest as string, candidate: parseCandidate(row.candidate)!,
    sourceAnalystKeys: [...row.sourceAnalystKeys as [string]], slotId: row.slotId,
    writerNodeKey: keys.writerNodeKey, reviewerNodeKey: keys.reviewerNodeKey, admittedRevision: Number(row.admittedRevision) }
}

export function objectiveTailorWavePairPlan(value: unknown): ObjectiveTailorWavePairPlan | undefined {
  const witness = parseObjectiveTailorWaveCandidateWitness(value)
  if (!witness) return undefined
  const jobId = witness.candidate.jobId, selected = taskGraphTemplatesForSelectedJob({ jobId })
  const context = { objectiveTailorCandidateMode: true, selectedJobPreparation: { jobId }, objectiveTailorCandidateWitness: witness }
  const writer: TaskGraphTaskTemplate = { ...selected.cover_letter_writer!, context }
  const reviewer: TaskGraphTaskTemplate = { ...selected.cover_letter_reviewer!, context }
  const nodes: readonly TaskGraphNodeProposal[] = [
    { key: witness.writerNodeKey, templateId: "cover_letter_writer", goal: "Draft the current cover letter for the server-bound job.",
      successCriteria: ["Save one current immutable cover letter artifact."], dependsOn: [...witness.sourceAnalystKeys] },
    { key: witness.reviewerNodeKey, templateId: "cover_letter_reviewer", goal: "Review only the exact Writer artifact for this server-bound job.",
      successCriteria: ["Persist a review receipt for the exact Writer artifact."], dependsOn: [witness.writerNodeKey] },
  ]
  return { witness, proposal: { expectedRevision: witness.admittedRevision - 1, nodes },
    templatesByNodeKey: new Map([[witness.writerNodeKey, writer], [witness.reviewerNodeKey, reviewer]]) }
}

function parseCandidate(value: unknown): ObjectiveTailorWaveCandidateProof | undefined {
  const row = exactRecord(value, "jobId,materialDigest,score")
  return row && isCanonicalJobId(row.jobId)
    && typeof row.materialDigest === "string" && MATERIAL.test(row.materialDigest)
    && typeof row.score === "number" && Number.isFinite(row.score) && row.score >= 0 && row.score <= 10
    ? { jobId: row.jobId, score: row.score, materialDigest: row.materialDigest } : undefined
}
function singleNodeKey(value: unknown): value is [string] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== 1
      || Reflect.ownKeys(value).length !== 2) return false
    const descriptor = Object.getOwnPropertyDescriptor(value, "0")
    return Boolean(descriptor?.enumerable && "value" in descriptor && validNodeKey(descriptor.value))
  } catch { return false }
}
function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Record<string, unknown>, actual = Reflect.ownKeys(row), expected = keys.split(",")
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key)
        && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(row, key)!)) ? row : undefined
  } catch { return undefined }
}
function validScope(scope: GraphIdentityScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId]
    .every(value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256)
}
function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_REVISION
}
function validNodeKey(value: unknown): value is string { return typeof value === "string" && NODE_KEY.test(value) }
function isSha(value: unknown): value is string { return typeof value === "string" && SHA.test(value) }
