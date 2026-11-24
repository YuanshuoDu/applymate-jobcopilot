import { createHash } from "node:crypto"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

export const OBJECTIVE_TAILOR_CANDIDATE_SELECTION_SCHEMA = "agent-harness.v2.objective-tailor-candidate-selection.v1" as const
export const OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA = "agent-harness.v2.objective-tailor-candidate-witness.v1" as const
const NODE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MATERIAL_DIGEST = /^sha256:[a-f0-9]{64}$/
const CANDIDATE_REF = /^otc1_[a-f0-9]{64}$/
const MAX_ANALYSTS = 8

export type ObjectiveTailorCandidateProof = Readonly<{ jobId: string; score: number; materialDigest: string }>
export type ObjectiveTailorCandidateSelection = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_CANDIDATE_SELECTION_SCHEMA
  candidateRef: string
  sourceGraphRevision: number
  sourceGraphDigest: string
  sourceStatusDigest: string
  analystProofDigest: string
  candidate: ObjectiveTailorCandidateProof
  sourceAnalystKeys: readonly string[]
}>
export type ObjectiveTailorCandidateWitness = Omit<ObjectiveTailorCandidateSelection, "schemaVersion"> & Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA
  writerNodeKey: string
  reviewerNodeKey: string
  admittedRevision: number
}>
export type ObjectiveTailorPairBinding = Readonly<{ writerNodeKey: string; reviewerNodeKey: string; admittedRevision: number }>

/** Opaque UI selector: resolution always recomputes the source proof under the current graph scope. */
export function makeObjectiveTailorCandidateSelection(input: Readonly<{
  scope: GraphIdentityScope
  sourceGraphRevision: number
  sourceGraphDigest: string
  sourceStatusDigest: string
  analystProofDigest: string
  candidate: ObjectiveTailorCandidateProof
  sourceAnalystKeys: readonly string[]
}>): ObjectiveTailorCandidateSelection | undefined {
  const core = selectionCore(input)
  if (!core) return undefined
  const candidateRef = `otc1_${createHash("sha256").update(canonical({
    scope: { userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId,
      rootTaskId: input.scope.rootTaskId, parentTaskId: input.scope.parentTaskId },
    sourceGraphRevision: core.sourceGraphRevision, sourceGraphDigest: core.sourceGraphDigest,
    sourceStatusDigest: core.sourceStatusDigest, analystProofDigest: core.analystProofDigest,
    candidate: core.candidate, sourceAnalystKeys: core.sourceAnalystKeys,
  })).digest("hex")}`
  return { schemaVersion: OBJECTIVE_TAILOR_CANDIDATE_SELECTION_SCHEMA, candidateRef, ...core }
}

export function bindObjectiveTailorCandidateWitness(
  selectionValue: ObjectiveTailorCandidateSelection,
  pair: ObjectiveTailorPairBinding,
): ObjectiveTailorCandidateWitness | undefined {
  const selection = parseObjectiveTailorCandidateSelection(selectionValue)
  if (!selection || !validNodeKey(pair.writerNodeKey) || !validNodeKey(pair.reviewerNodeKey)
    || pair.writerNodeKey === pair.reviewerNodeKey || selection.sourceAnalystKeys.includes(pair.writerNodeKey)
    || selection.sourceAnalystKeys.includes(pair.reviewerNodeKey)
    || !Number.isSafeInteger(pair.admittedRevision) || pair.admittedRevision !== selection.sourceGraphRevision + 1) return undefined
  return parseObjectiveTailorCandidateWitness({
    schemaVersion: OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA,
    candidateRef: selection.candidateRef, sourceGraphRevision: selection.sourceGraphRevision,
    sourceGraphDigest: selection.sourceGraphDigest, sourceStatusDigest: selection.sourceStatusDigest,
    analystProofDigest: selection.analystProofDigest, candidate: selection.candidate,
    sourceAnalystKeys: selection.sourceAnalystKeys, writerNodeKey: pair.writerNodeKey,
    reviewerNodeKey: pair.reviewerNodeKey, admittedRevision: pair.admittedRevision,
  })
}

export function parseObjectiveTailorCandidateSelection(value: unknown): ObjectiveTailorCandidateSelection | undefined {
  const row = exactRecord(value, "analystProofDigest,candidate,candidateRef,schemaVersion,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest")
  if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_CANDIDATE_SELECTION_SCHEMA || !validSelectionFields(row)) return undefined
  return selectionFrom(row)
}

export function parseObjectiveTailorCandidateWitness(value: unknown): ObjectiveTailorCandidateWitness | undefined {
  const row = exactRecord(value, "admittedRevision,analystProofDigest,candidate,candidateRef,reviewerNodeKey,schemaVersion,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest,writerNodeKey")
  if (!row || row.schemaVersion !== OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA || !validSelectionFields(row)
    || !validNodeKey(row.writerNodeKey) || !validNodeKey(row.reviewerNodeKey) || row.writerNodeKey === row.reviewerNodeKey
    || (row.sourceAnalystKeys as string[]).includes(row.writerNodeKey as string)
    || (row.sourceAnalystKeys as string[]).includes(row.reviewerNodeKey as string)
    || !Number.isSafeInteger(row.admittedRevision) || row.admittedRevision !== Number(row.sourceGraphRevision) + 1) return undefined
  return { ...selectionFrom(row), schemaVersion: OBJECTIVE_TAILOR_CANDIDATE_WITNESS_SCHEMA,
    writerNodeKey: row.writerNodeKey, reviewerNodeKey: row.reviewerNodeKey, admittedRevision: row.admittedRevision }
}

function selectionCore(input: Omit<ObjectiveTailorCandidateSelection, "schemaVersion" | "candidateRef"> & { scope?: GraphIdentityScope }): Omit<ObjectiveTailorCandidateSelection, "schemaVersion" | "candidateRef"> | undefined {
  if (!Number.isSafeInteger(input.sourceGraphRevision) || input.sourceGraphRevision < 1
    || !isSha(input.sourceGraphDigest) || !isSha(input.sourceStatusDigest) || !isSha(input.analystProofDigest)
    || !parseCandidate(input.candidate) || !validAnalystKeys(input.sourceAnalystKeys)
    || input.scope && !validScope(input.scope)) return undefined
  return { sourceGraphRevision: input.sourceGraphRevision, sourceGraphDigest: input.sourceGraphDigest,
    sourceStatusDigest: input.sourceStatusDigest, analystProofDigest: input.analystProofDigest,
    candidate: { jobId: input.candidate.jobId, score: input.candidate.score, materialDigest: input.candidate.materialDigest },
    sourceAnalystKeys: [...input.sourceAnalystKeys] }
}
function validSelectionFields(row: Record<string, unknown>): boolean {
  return typeof row.candidateRef === "string" && CANDIDATE_REF.test(row.candidateRef)
    && Number.isSafeInteger(row.sourceGraphRevision) && Number(row.sourceGraphRevision) >= 1
    && isSha(row.sourceGraphDigest) && isSha(row.sourceStatusDigest) && isSha(row.analystProofDigest)
    && Boolean(parseCandidate(row.candidate)) && validAnalystKeys(row.sourceAnalystKeys)
}
function selectionFrom(row: Record<string, unknown>): ObjectiveTailorCandidateSelection {
  const candidate = parseCandidate(row.candidate)!
  return { schemaVersion: OBJECTIVE_TAILOR_CANDIDATE_SELECTION_SCHEMA, candidateRef: row.candidateRef as string,
    sourceGraphRevision: row.sourceGraphRevision as number, sourceGraphDigest: row.sourceGraphDigest as string,
    sourceStatusDigest: row.sourceStatusDigest as string, analystProofDigest: row.analystProofDigest as string,
    candidate, sourceAnalystKeys: [...row.sourceAnalystKeys as string[]] }
}
function parseCandidate(value: unknown): ObjectiveTailorCandidateProof | undefined {
  const row = exactRecord(value, "jobId,materialDigest,score")
  return row && validJobId(row.jobId) && typeof row.score === "number" && Number.isFinite(row.score)
    && row.score >= 0 && row.score <= 10 && typeof row.materialDigest === "string" && MATERIAL_DIGEST.test(row.materialDigest)
    ? { jobId: row.jobId, score: row.score, materialDigest: row.materialDigest as string } : undefined
}
function validAnalystKeys(value: unknown): value is string[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > MAX_ANALYSTS) return false
    const keys = Reflect.ownKeys(value)
    if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return false
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index)), key = descriptor && "value" in descriptor ? descriptor.value : undefined
      if (!descriptor?.enumerable || !validNodeKey(key) || index > 0 && compare(value[index - 1]!, key) >= 0) return false
    }
    return true
  } catch { return false }
}
function exactRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Record<string, unknown>, actual = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && actual.length === keys.split(",").length && actual.every(key => typeof key === "string" && keys.split(",").includes(key)
        && Boolean(Object.getOwnPropertyDescriptor(row, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(row, key)!))
      ? row : undefined
  } catch { return undefined }
}
function validScope(value: GraphIdentityScope): boolean {
  return [value.userId, value.sessionId, value.turnId, value.rootTaskId, value.parentTaskId]
    .every(item => typeof item === "string" && item.trim() === item && item.length > 0 && item.length <= 256)
}
function validJobId(value: unknown): value is string { return isCanonicalJobId(value) }
function validNodeKey(value: unknown): value is string { return typeof value === "string" && NODE_KEY.test(value) }
function isSha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}
