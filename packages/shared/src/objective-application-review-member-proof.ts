import { createHash } from "node:crypto"
import { canonicalJson } from "./canonical-json.js"
import { parseObjectiveApplicationResumeWitness, type ObjectiveApplicationResumeWitness } from "./agent-objective-application-resume-witness.js"

export const OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA = "objective-application-review-member-proof.v1" as const

export type ObjectiveApplicationReviewMemberProof = Readonly<{
  schema: typeof OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA
  source: Readonly<{
    jobId: string
    sourceTurnId: string
    rootTaskId: string
    graphItemId: string
    graphRevision: number
    finalItemId: string
    slotOrdinal: number
    writerTaskId: string
    reviewerTaskId: string
    reviewerToolCallId: string
    reviewHash: string
    artifactId: string
    version: number
    contentHash: string
    sourceDigest: string
  }>
  resumeWitness: ObjectiveApplicationResumeWitness
  materialProofHash: string
}>

const SOURCE_KEYS = ["artifactId", "contentHash", "finalItemId", "graphItemId", "graphRevision", "jobId", "reviewerTaskId",
  "reviewerToolCallId", "reviewHash", "rootTaskId", "slotOrdinal", "sourceDigest", "sourceTurnId", "version", "writerTaskId"] as const
const HASH = /^[a-f0-9]{64}$/
const SOURCE_HASH = /^sha256:[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

/** Builds the exact version-1 proof bytes used as the approval's materialHash. */
export function buildObjectiveApplicationReviewMemberProof(input: Readonly<{ source: unknown; resumeWitness: unknown }>): ObjectiveApplicationReviewMemberProof | null {
  const seed = exactRecord(input, ["source", "resumeWitness"])
  const source = parseSource(seed?.source), resumeWitness = parseObjectiveApplicationResumeWitness(seed?.resumeWitness)
  if (!source || !resumeWitness || source.jobId !== resumeWitness.jobId) return null
  const materialProofHash = digest(source, resumeWitness)
  return parseObjectiveApplicationReviewMemberProof({ schema: OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA,
    source, resumeWitness, materialProofHash })
}

/** Parses a closed immutable member proof and recomputes its version-1 material hash. */
export function parseObjectiveApplicationReviewMemberProof(value: unknown): ObjectiveApplicationReviewMemberProof | null {
  const proof = exactRecord(value, ["schema", "source", "resumeWitness", "materialProofHash"])
  const source = parseSource(proof?.source), resumeWitness = parseObjectiveApplicationResumeWitness(proof?.resumeWitness)
  if (!proof || proof.schema !== OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA || !source || !resumeWitness
    || source.jobId !== resumeWitness.jobId || typeof proof.materialProofHash !== "string" || !HASH.test(proof.materialProofHash)
    || proof.materialProofHash !== digest(source, resumeWitness)) return null
  return { schema: OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA, source, resumeWitness, materialProofHash: proof.materialProofHash }
}

function parseSource(value: unknown): ObjectiveApplicationReviewMemberProof["source"] | null {
  const source = exactRecord(value, SOURCE_KEYS)
  if (!source || !SOURCE_KEYS.filter(key => !["graphRevision", "slotOrdinal", "version", "reviewHash", "contentHash", "sourceDigest"].includes(key))
    .every(key => boundedId(source[key])) || !positive(source.graphRevision) || !positive(source.version)
    || !Number.isSafeInteger(source.slotOrdinal) || Number(source.slotOrdinal) < 1 || Number(source.slotOrdinal) > 8
    || ![source.reviewHash, source.contentHash, source.sourceDigest].every(value => typeof value === "string" && SOURCE_HASH.test(value))) return null
  return {
    jobId: source.jobId as string, sourceTurnId: source.sourceTurnId as string, rootTaskId: source.rootTaskId as string,
    graphItemId: source.graphItemId as string, graphRevision: source.graphRevision as number, finalItemId: source.finalItemId as string,
    slotOrdinal: source.slotOrdinal as number, writerTaskId: source.writerTaskId as string, reviewerTaskId: source.reviewerTaskId as string,
    reviewerToolCallId: source.reviewerToolCallId as string, reviewHash: source.reviewHash as string, artifactId: source.artifactId as string,
    version: source.version as number, contentHash: source.contentHash as string, sourceDigest: source.sourceDigest as string,
  }
}

function digest(source: ObjectiveApplicationReviewMemberProof["source"], resumeWitness: ObjectiveApplicationResumeWitness): string {
  return createHash("sha256").update(canonicalJson({ schema: OBJECTIVE_APPLICATION_REVIEW_MEMBER_PROOF_SCHEMA, source, resumeWitness })).digest("hex")
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length) return null
    const expected = new Set(keys)
    for (const key of ownKeys) {
      if (typeof key !== "string" || !expected.delete(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    return value as Record<string, unknown>
  } catch { return null }
}
function boundedId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && ID.test(value) }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0 }
