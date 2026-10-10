import {
  parseTaskGraphRepairOf, parseTaskGraphRepairReceipt, parseTaskGraphVerificationCriterionIds, parseTaskGraphVerificationReport,
  TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphAnalystProjectionItem, type TaskGraphArtifactProjectionReference, type TaskGraphCurrentNode,
  type TaskGraphProjectionEvidenceKind, type TaskGraphProjectionSource, type TaskGraphResultProjection,
  type TaskGraphScoutProjectionItem,
} from "./task-graph-command-port.js"
import { nativeGraphNodeFields } from "../canonical-turn-native-graph-context.js"

export type TaskGraphInputRelation = "predates_current_inputs" | "covers_current_inputs" | "unknown"
export type TaskGraphSourceIntentData = Readonly<{
  goal: string
  successCriteria: readonly string[]
  inputRelation: TaskGraphInputRelation
}>
export type TaskGraphSourceIntent = TaskGraphSourceIntentData & Readonly<{ trust: "untrusted" }>
type SourceCheckpointMetadata = Readonly<{
  currentStepId: string
  sourceStepIds: ReadonlyMap<string, string | undefined>
  sourceInputCursors: ReadonlyMap<string, bigint | undefined>
}>
const sourceCheckpointMetadata = new WeakMap<object, SourceCheckpointMetadata>()

export const TASK_GRAPH_CONTEXT_MAX_NODES = 16
export const TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT = 160_000
const MAX_RESULT_PROJECTION_BYTES = 2 * 1024
const MAX_RESULT_PROJECTION_ITEMS = 3
const STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const READINESS = new Set(["ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal"])
const PROJECTION_SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "other"])
const PROJECTION_EVIDENCE_KINDS = new Set(["job", "persona", "resume", "source"])
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_SHA256 = /^sha256:[a-f0-9]{64}$/
const REVIEW_STATUSES = new Set(["passed", "needs_revision", "rejected", "stale"])
const UNAVAILABLE_PROJECTION: TaskGraphResultProjection = {
  schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
}

function record(value: unknown): Record<string, unknown> | null {
  return isTaskGraphPlainRecord(value) ? value : null
}
export function isTaskGraphPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}
function text(value: unknown, maxLength: number, path: string, clip = false): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("task_graph_current_state_invalid")
  if (value.length > maxLength && !clip) throw new Error(`task_graph_current_state_invalid:${path}`)
  return value.slice(0, maxLength)
}
function stringList(value: unknown, maxItems: number, maxLength: number, path: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`task_graph_current_state_invalid:${path}`)
  return value.map((item, index) => text(item, maxLength, `${path}[${index}]`))
}
function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}

export function taskGraphInputRelation(value: unknown): TaskGraphInputRelation {
  return value === "predates_current_inputs" || value === "covers_current_inputs" ? value : "unknown"
}

export function compareTaskGraphInputCursors(source: bigint | undefined, current: bigint | undefined): TaskGraphInputRelation {
  if (source === undefined || current === undefined || source < 0n || current < 0n || source > current) return "unknown"
  return source < current ? "predates_current_inputs" : "covers_current_inputs"
}

/** Keeps cursor and Step provenance outside any enumerable/model-visible object. */
export function rememberTaskGraphSourceCheckpointMetadata(target: object, metadata: SourceCheckpointMetadata): void {
  sourceCheckpointMetadata.set(target, metadata)
}

/** Carries only the private WeakMap association across a trusted projection. */
export function copyTaskGraphSourceCheckpointMetadata(source: object | undefined, target: object): void {
  if (!source) return
  const metadata = sourceCheckpointMetadata.get(source)
  if (metadata) sourceCheckpointMetadata.set(target, metadata)
}

/** Finalizes advisory relations after this exact Step's accepted checkpoint is durable. */
export function projectTaskGraphInputRelationAfterCheckpoint(
  value: unknown,
  stepId: string,
  inputThroughSequence: unknown,
  consumedInputIds: unknown,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const metadata = sourceCheckpointMetadata.get(value)
  const current = acceptedInputCursor(inputThroughSequence, consumedInputIds)
  const observation = value as Record<string, unknown>
  if (observation.kind !== "task_graph_current" || !Array.isArray(observation.nodes)) return value
  if (!metadata || metadata.currentStepId !== stepId || current === undefined) {
    return inputRelationFallback(observation)
  }
  const nodes = observation.nodes.map(node => {
    const row = record(node)
    if (!row || typeof row.key !== "string") return node
    const sourceStep = metadata.sourceStepIds.get(row.key)
    const source = sourceStep === stepId ? current : metadata.sourceInputCursors.get(row.key)
    return { ...row, inputRelation: compareTaskGraphInputCursors(source, current) }
  })
  const projected = { ...observation, nodes }
  if (JSON.stringify(projected).length > TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT) {
    return inputRelationFallback(observation)
  }
  sourceCheckpointMetadata.set(projected, metadata)
  return projected
}

function unknownInputRelation(value: unknown): unknown {
  const row = record(value)
  return row ? { ...row, inputRelation: "unknown" } : value
}

function inputRelationFallback(observation: Record<string, unknown>): unknown {
  const nodes = Array.isArray(observation.nodes) ? observation.nodes : []
  const unknown = { ...observation, nodes: nodes.map(unknownInputRelation) }
  const originalLength = JSON.stringify(observation).length
  const unknownLength = JSON.stringify(unknown).length
  if (unknownLength <= TASK_GRAPH_CURRENT_CONTEXT_MAX_TEXT && unknownLength <= originalLength) return unknown
  return { ...observation, nodes: nodes.map(withoutInputRelation) }
}

function withoutInputRelation(value: unknown): unknown {
  const row = record(value)
  if (!row) return value
  const projected = { ...row }
  delete projected.inputRelation
  return projected
}

function acceptedInputCursor(cursor: unknown, ids: unknown): bigint | undefined {
  if (typeof cursor !== "bigint" || cursor < 0n || cursor > 9_223_372_036_854_775_807n
    || !Array.isArray(ids) || ids.some((id: unknown) => typeof id !== "string" || !id.trim() || id.length > 256)
    || cursor === 0n && ids.length > 0
    || new Set<unknown>(ids).size !== ids.length) return undefined
  return cursor
}

/** Project only bounded, untrusted source intent; IDs and cursors have no output path. */
export function projectTaskGraphSourceIntent(value: unknown): TaskGraphSourceIntent | undefined {
  const row = record(value)
  if (!row || !exactKeys(row, "goal,inputRelation,successCriteria")) return undefined
  try {
    return {
      trust: "untrusted", goal: text(row.goal, 1200, "goal", true),
      successCriteria: stringList(row.successCriteria, 8, 320, "successCriteria"),
      inputRelation: taskGraphInputRelation(row.inputRelation),
    }
  } catch { return undefined }
}

export function projectTaskGraphResultProjection(value: unknown): TaskGraphResultProjection {
  const row = record(value)
  if (!row || row.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || row.trust !== "untrusted") return UNAVAILABLE_PROJECTION
  if (row.availability === "unavailable") return UNAVAILABLE_PROJECTION
  if (row.availability !== "available") return UNAVAILABLE_PROJECTION

  let parsed: TaskGraphResultProjection | null = null
  if (row.role === "scout" && exactKeys(row, "availability,candidateCount,candidates,evidenceCount,role,schemaVersion,status,trust")
    && validStatus(row.status) && count(row.candidateCount) && count(row.evidenceCount) && Array.isArray(row.candidates)
    && row.candidates.length <= MAX_RESULT_PROJECTION_ITEMS) {
    const candidates = row.candidates.map(scoutItem)
    if (candidates.every((item): item is TaskGraphScoutProjectionItem => item !== null)) parsed = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "scout", status: row.status,
      candidateCount: row.candidateCount, evidenceCount: row.evidenceCount, candidates,
    }
  } else if (row.role === "analyst" && exactKeys(row, "availability,evidenceCount,findingCount,findings,role,schemaVersion,status,trust")
    && validStatus(row.status) && count(row.findingCount) && count(row.evidenceCount) && Array.isArray(row.findings)
    && row.findings.length <= MAX_RESULT_PROJECTION_ITEMS) {
    const findings = row.findings.map(analystItem)
    if (findings.every((item): item is TaskGraphAnalystProjectionItem => item !== null)) parsed = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "analyst", status: row.status,
      findingCount: row.findingCount, evidenceCount: row.evidenceCount, findings,
    }
  } else if (row.role === "writer" && exactKeys(row, "artifactRef,availability,role,schemaVersion,status,trust") && row.status === "completed") {
    const artifactRef = artifactReference(row.artifactRef)
    if (artifactRef) parsed = { schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "writer", status: "completed", artifactRef }
  } else if (row.role === "reviewer" && exactKeys(row, "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust")
    && row.status === "completed" && typeof row.reviewStatus === "string" && REVIEW_STATUSES.has(row.reviewStatus)
    && typeof row.reviewHash === "string" && SAFE_SHA256.test(row.reviewHash)) {
    const artifactRef = artifactReference(row.artifactRef)
    if (artifactRef) parsed = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available", role: "reviewer", status: "completed",
      artifactRef, reviewStatus: row.reviewStatus as "passed" | "needs_revision" | "rejected" | "stale", reviewHash: row.reviewHash,
    }
  }
  return parsed && Buffer.byteLength(JSON.stringify(parsed), "utf8") <= MAX_RESULT_PROJECTION_BYTES ? parsed : UNAVAILABLE_PROJECTION
}

function scoutItem(value: unknown): TaskGraphScoutProjectionItem | null {
  const row = record(value)
  if (!row || !exactKeys(row, "evidenceKinds,jobId,source") || !safeJobId(row.jobId)
    || typeof row.source !== "string" || !PROJECTION_SOURCES.has(row.source)) return null
  const evidenceKinds = projectionEvidenceKinds(row.evidenceKinds)
  return evidenceKinds ? { jobId: row.jobId, source: row.source as TaskGraphProjectionSource, evidenceKinds } : null
}
function analystItem(value: unknown): TaskGraphAnalystProjectionItem | null {
  const row = record(value)
  if (!row || !exactKeys(row, "evidenceKinds,jobId,score") || !safeJobId(row.jobId)
    || typeof row.score !== "number" || !Number.isFinite(row.score) || row.score < 0 || row.score > 10) return null
  const evidenceKinds = projectionEvidenceKinds(row.evidenceKinds)
  return evidenceKinds ? { jobId: row.jobId, score: row.score, evidenceKinds } : null
}
function artifactReference(value: unknown): TaskGraphArtifactProjectionReference | null {
  const row = record(value)
  if (!row || !exactKeys(row, "artifactId,contentHash,sourceDigest,version") || typeof row.artifactId !== "string"
    || !SAFE_ARTIFACT_ID.test(row.artifactId) || !Number.isSafeInteger(row.version) || Number(row.version) < 1
    || typeof row.contentHash !== "string" || !SAFE_SHA256.test(row.contentHash)
    || typeof row.sourceDigest !== "string" || !SAFE_SHA256.test(row.sourceDigest)) return null
  return { artifactId: row.artifactId, version: row.version as number, contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}
function projectionEvidenceKinds(value: unknown): TaskGraphProjectionEvidenceKind[] | null {
  if (!Array.isArray(value) || value.length > PROJECTION_EVIDENCE_KINDS.size
    || value.some(item => typeof item !== "string" || !PROJECTION_EVIDENCE_KINDS.has(item)) || new Set(value).size !== value.length) return null
  return value as TaskGraphProjectionEvidenceKind[]
}
function safeJobId(value: unknown): value is string { return typeof value === "string" && SAFE_JOB_ID.test(value) }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validStatus(value: unknown): value is "completed" | "partial" { return value === "completed" || value === "partial" }

export function projectTaskGraphObservationNode(value: unknown): TaskGraphCurrentNode {
  const row = record(value)
  if (!row || typeof row.status !== "string" || !STATUSES.has(row.status) || typeof row.readiness !== "string" || !READINESS.has(row.readiness)) throw new Error("task_graph_current_state_invalid:node")
  const hasIds = Object.hasOwn(row, "verificationCriterionIds"), hasReport = Object.hasOwn(row, "verificationReport")
  const verificationCriterionIds = hasIds ? parseTaskGraphVerificationCriterionIds(row.verificationCriterionIds) : undefined
  const verificationReport = hasReport && verificationCriterionIds ? parseTaskGraphVerificationReport(row.verificationReport, verificationCriterionIds) : undefined
  const hasRelation = Object.hasOwn(row, "repairOf"), repairOf = hasRelation ? parseTaskGraphRepairOf(row.repairOf) : undefined
  const hasReceipt = Object.hasOwn(row, "repairReceipt")
  const key = text(row.key, 128, "key"), taskId = text(row.taskId, 128, "taskId")
  const repairReceipt = hasReceipt ? parseTaskGraphRepairReceipt(row.repairReceipt, { repairOf, repairNodeKey: key, repairTaskId: taskId, report: verificationReport }) : undefined
  if (hasIds && !verificationCriterionIds || hasReport && !verificationReport || hasRelation && !repairOf || hasReceipt && !repairReceipt) throw new Error("task_graph_current_state_invalid:verification")
  return {
    key, templateId: text(row.templateId, 128, "templateId"), goal: text(row.goal, 1200, "goal", true),
    successCriteria: stringList(row.successCriteria, 8, 320, "successCriteria"),
    dependsOn: stringList(row.dependsOn, TASK_GRAPH_CONTEXT_MAX_NODES, 128, "dependsOn"), taskId,
    status: row.status as TaskGraphCurrentNode["status"], readiness: row.readiness as TaskGraphCurrentNode["readiness"],
    resultSummary: null, resultProjection: projectTaskGraphResultProjection(row.resultProjection), inputRelation: taskGraphInputRelation(row.inputRelation),
    ...(verificationCriterionIds ? { verificationCriterionIds } : {}), ...(verificationReport ? { verificationReport } : {}),
    ...(repairOf ? { repairOf } : {}), ...(repairReceipt ? { repairReceipt } : {}), ...nativeGraphNodeFields(row), failureReason: null,
  }
}
