import { parseObjectiveTailorWaveCandidateWitness, type ObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"

export const OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA = "agent-harness.v2.objective-tailor-correction-proof.v1" as const
const SLOT = /^tailor-([1-8])$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SHA256 = /^sha256:[a-f0-9]{64}$/
const MAX_REVISION = 2_147_483_646

export type ObjectiveTailorCorrectionArtifactRef = Readonly<{
  artifactId: string; version: number; contentHash: string; sourceDigest: string
}>
export type ObjectiveTailorCorrectionArtifactVersion = Readonly<{
  artifactId: string; artifactType: "cover_letter"; taskId: string; version: number
  contentHash: string; sourceDigest: string; previousHash: string | null
}>
export type ObjectiveTailorCorrectionReviewReceipt = Readonly<{
  jobId: string; artifactId: string; version: number; contentHash: string; sourceDigest: string; currentSourceDigest: string
  status: "needs_revision"; taskId: string; toolCallId: string; reviewHash: string
}>
export type ObjectiveTailorCorrectionProof = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA
  graphRevision: number; admittedRevision: number; slotId: string
  candidateWitness: ObjectiveTailorWaveCandidateWitness
  writerNodeKey: string; reviewerNodeKey: string
  prior: Readonly<{
    writerTaskId: string; reviewerTaskId: string; artifactRef: ObjectiveTailorCorrectionArtifactRef
    artifactVersion: ObjectiveTailorCorrectionArtifactVersion; reviewReceipt: ObjectiveTailorCorrectionReviewReceipt
  }>
}>

/** Successor keys expose only the slot, never Job, artifact, or receipt identity. */
export function objectiveTailorCorrectionNodeKeys(slotId: string): Readonly<{ writerNodeKey: string; reviewerNodeKey: string }> | undefined {
  if (!SLOT.test(slotId)) return undefined
  return { writerNodeKey: `objective-tailor-wave-correction-writer-${slotId}`,
    reviewerNodeKey: `objective-tailor-wave-correction-reviewer-${slotId}` }
}

/** Parses the closed private correction witness persisted on both successor tasks. */
export function parseObjectiveTailorCorrectionProof(value: unknown): ObjectiveTailorCorrectionProof | undefined {
  const row = record(value), expected = "admittedRevision,candidateWitness,graphRevision,prior,reviewerNodeKey,schemaVersion,slotId,writerNodeKey"
  if (!row || !exactKeys(row, expected) || row.schemaVersion !== OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA
    || !revision(row.graphRevision) || !revision(row.admittedRevision) || Number(row.admittedRevision) !== Number(row.graphRevision) + 1
    || typeof row.slotId !== "string" || !SLOT.test(row.slotId)) return undefined
  const candidateWitness = parseObjectiveTailorWaveCandidateWitness(row.candidateWitness)
  const keys = objectiveTailorCorrectionNodeKeys(row.slotId), prior = parsePrior(row.prior)
  if (!candidateWitness || !keys || !prior || candidateWitness.slotId !== row.slotId
    || candidateWitness.admittedRevision > Number(row.graphRevision)
    || prior.writerTaskId === prior.reviewerTaskId || prior.reviewReceipt.jobId !== candidateWitness.candidate.jobId
    || prior.artifactRef.sourceDigest !== prior.reviewReceipt.currentSourceDigest
    || prior.reviewReceipt.taskId !== prior.reviewerTaskId || prior.artifactVersion.taskId !== prior.writerTaskId
    || row.writerNodeKey !== keys.writerNodeKey || row.reviewerNodeKey !== keys.reviewerNodeKey) return undefined
  return { schemaVersion: OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA, graphRevision: Number(row.graphRevision),
    admittedRevision: Number(row.admittedRevision), slotId: row.slotId, candidateWitness, ...keys, prior }
}

/** Builds a private witness only from already revalidated, same-transaction facts. */
export function bindObjectiveTailorCorrectionProof(input: Readonly<{
  graphRevision: number; slotId: string; candidateWitness: unknown
  writerTaskId: string; reviewerTaskId: string; artifactRef: unknown; artifactVersion: unknown; reviewReceipt: unknown
}>): ObjectiveTailorCorrectionProof | undefined {
  const keys = objectiveTailorCorrectionNodeKeys(input.slotId), candidateWitness = parseObjectiveTailorWaveCandidateWitness(input.candidateWitness)
  if (!keys || !candidateWitness || candidateWitness.slotId !== input.slotId || !revision(input.graphRevision)) return undefined
  return parseObjectiveTailorCorrectionProof({ schemaVersion: OBJECTIVE_TAILOR_CORRECTION_PROOF_SCHEMA,
    graphRevision: input.graphRevision, admittedRevision: input.graphRevision + 1, slotId: input.slotId,
    candidateWitness, ...keys, prior: { writerTaskId: input.writerTaskId, reviewerTaskId: input.reviewerTaskId,
      artifactRef: input.artifactRef, artifactVersion: input.artifactVersion, reviewReceipt: input.reviewReceipt } })
}

function parsePrior(value: unknown): ObjectiveTailorCorrectionProof["prior"] | undefined {
  const row = record(value)
  if (!row || !exactKeys(row, "artifactRef,artifactVersion,reviewReceipt,reviewerTaskId,writerTaskId")
    || !safeTask(row.writerTaskId) || !safeTask(row.reviewerTaskId)) return undefined
  const artifactRef = parseArtifactRef(row.artifactRef), artifactVersion = parseArtifactVersion(row.artifactVersion)
  const reviewReceipt = parseReviewReceipt(row.reviewReceipt)
  return artifactRef && artifactVersion && reviewReceipt
    && artifactVersion.artifactId === artifactRef.artifactId && artifactVersion.version === artifactRef.version
    && artifactVersion.contentHash === artifactRef.contentHash && artifactVersion.sourceDigest === artifactRef.sourceDigest
    && artifactVersion.taskId === row.writerTaskId && reviewReceipt.taskId === row.reviewerTaskId
    && reviewReceipt.artifactId === artifactRef.artifactId && reviewReceipt.version === artifactRef.version
    && reviewReceipt.contentHash === artifactRef.contentHash && reviewReceipt.sourceDigest === artifactRef.sourceDigest
    ? { writerTaskId: row.writerTaskId, reviewerTaskId: row.reviewerTaskId, artifactRef, artifactVersion, reviewReceipt } : undefined
}
function parseArtifactRef(value: unknown): ObjectiveTailorCorrectionArtifactRef | undefined {
  const row = record(value)
  return row && exactKeys(row, "artifactId,contentHash,sourceDigest,version") && safeId(row.artifactId)
    && positive(row.version) && sha(row.contentHash) && sha(row.sourceDigest)
    ? { artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest } : undefined
}
function parseArtifactVersion(value: unknown): ObjectiveTailorCorrectionArtifactVersion | undefined {
  const row = record(value)
  return row && exactKeys(row, "artifactId,artifactType,contentHash,previousHash,sourceDigest,taskId,version")
    && safeId(row.artifactId) && row.artifactType === "cover_letter" && safeTask(row.taskId) && positive(row.version)
    && sha(row.contentHash) && sha(row.sourceDigest) && (row.previousHash === null || sha(row.previousHash))
    ? { artifactId: row.artifactId, artifactType: "cover_letter", taskId: row.taskId, version: Number(row.version),
      contentHash: row.contentHash, sourceDigest: row.sourceDigest, previousHash: row.previousHash as string | null } : undefined
}
function parseReviewReceipt(value: unknown): ObjectiveTailorCorrectionReviewReceipt | undefined {
  const row = record(value)
  return row && exactKeys(row, "artifactId,contentHash,currentSourceDigest,jobId,reviewHash,sourceDigest,status,taskId,toolCallId,version")
    && safeId(row.artifactId) && safeId(row.jobId) && positive(row.version) && sha(row.contentHash) && sha(row.sourceDigest)
    && row.status === "needs_revision" && safeTask(row.taskId) && safeCall(row.toolCallId) && sha(row.reviewHash)
    && row.currentSourceDigest === row.sourceDigest
    ? { jobId: row.jobId, artifactId: row.artifactId, version: Number(row.version), contentHash: row.contentHash, sourceDigest: row.sourceDigest,
      currentSourceDigest: row.currentSourceDigest, status: "needs_revision", taskId: row.taskId,
      toolCallId: row.toolCallId, reviewHash: row.reviewHash } : undefined
}
function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Record<string, unknown>, keys = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(row, key)?.enumerable
        && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined
  } catch { return undefined }
}
function exactKeys(row: Record<string, unknown>, keys: string): boolean {
  const expected = keys.split(","), actual = Reflect.ownKeys(row)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key))
}
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_REVISION }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 1 }
function safeId(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value) }
function safeTask(value: unknown): value is string { return typeof value === "string" && SAFE_ID.test(value) }
function safeCall(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) }
function sha(value: unknown): value is string { return typeof value === "string" && SHA256.test(value) }
