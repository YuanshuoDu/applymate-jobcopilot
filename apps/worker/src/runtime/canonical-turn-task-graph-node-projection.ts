import { Buffer } from "node:buffer"
import {
  TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphAnalystProjectionItem, type TaskGraphArtifactProjectionReference,
  type TaskGraphProjectionEvidenceKind, type TaskGraphProjectionSource, type TaskGraphResultProjection,
  type TaskGraphScoutProjectionItem,
} from "./subagents/task-graph-command-port.js"

const MAX_RESULT_PROJECTION_BYTES = 2 * 1024
const MAX_RESULT_PROJECTION_ITEMS = 3
const PROJECTION_SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "other"])
const PROJECTION_EVIDENCE_KINDS = new Set(["job", "persona", "resume", "source"])
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/
const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_SHA256 = /^sha256:[a-f0-9]{64}$/
const REVIEW_STATUSES = new Set(["passed", "needs_revision", "rejected", "stale"])
export const UNAVAILABLE_PROJECTION: TaskGraphResultProjection = {
  schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function parseTaskGraphResultProjection(value: unknown): TaskGraphResultProjection {
  const row = record(value)
  if (!row || row.schemaVersion !== TASK_GRAPH_RESULT_PROJECTION_SCHEMA || row.trust !== "untrusted") return UNAVAILABLE_PROJECTION
  if (row.availability === "unavailable") return UNAVAILABLE_PROJECTION
  if (row.availability !== "available") return UNAVAILABLE_PROJECTION

  let parsed: TaskGraphResultProjection | null = null
  if (row.role === "scout" && exactKeys(row, "availability,candidateCount,candidates,evidenceCount,role,schemaVersion,status,trust")
    && validStatus(row.status)
    && count(row.candidateCount) && count(row.evidenceCount) && Array.isArray(row.candidates)
    && row.candidates.length <= MAX_RESULT_PROJECTION_ITEMS) {
    const candidates = row.candidates.map(scoutItem)
    if (candidates.every((item): item is TaskGraphScoutProjectionItem => item !== null)) {
      parsed = {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
        trust: "untrusted", availability: "available", role: "scout", status: row.status,
        candidateCount: row.candidateCount, evidenceCount: row.evidenceCount, candidates,
      }
    }
  } else if (row.role === "analyst" && exactKeys(row, "availability,evidenceCount,findingCount,findings,role,schemaVersion,status,trust")
    && validStatus(row.status)
    && count(row.findingCount) && count(row.evidenceCount) && Array.isArray(row.findings)
    && row.findings.length <= MAX_RESULT_PROJECTION_ITEMS) {
    const findings = row.findings.map(analystItem)
    if (findings.every((item): item is TaskGraphAnalystProjectionItem => item !== null)) {
      parsed = {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
        trust: "untrusted", availability: "available", role: "analyst", status: row.status,
        findingCount: row.findingCount, evidenceCount: row.evidenceCount, findings,
      }
    }
  } else if (row.role === "writer" && exactKeys(row, "artifactRef,availability,role,schemaVersion,status,trust")
    && row.status === "completed") {
    const artifactRef = artifactReference(row.artifactRef)
    if (artifactRef) parsed = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
      trust: "untrusted", availability: "available", role: "writer", status: "completed", artifactRef,
    }
  } else if (row.role === "reviewer" && exactKeys(row, "artifactRef,availability,reviewHash,reviewStatus,role,schemaVersion,status,trust")
    && row.status === "completed" && typeof row.reviewStatus === "string" && REVIEW_STATUSES.has(row.reviewStatus)
    && typeof row.reviewHash === "string" && SAFE_SHA256.test(row.reviewHash)) {
    const artifactRef = artifactReference(row.artifactRef)
    if (artifactRef) parsed = {
      schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
      trust: "untrusted", availability: "available", role: "reviewer", status: "completed",
      artifactRef, reviewStatus: row.reviewStatus as "passed" | "needs_revision" | "rejected" | "stale", reviewHash: row.reviewHash,
    }
  }
  return parsed && Buffer.byteLength(JSON.stringify(parsed), "utf8") <= MAX_RESULT_PROJECTION_BYTES
    ? parsed
    : UNAVAILABLE_PROJECTION
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
    || value.some(item => typeof item !== "string" || !PROJECTION_EVIDENCE_KINDS.has(item))
    || new Set(value).size !== value.length) return null
  return value as TaskGraphProjectionEvidenceKind[]
}

function safeJobId(value: unknown): value is string { return typeof value === "string" && SAFE_JOB_ID.test(value) }

function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }

function validStatus(value: unknown): value is "completed" | "partial" { return value === "completed" || value === "partial" }

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
export function taskGraphResultProjectionItems(value: TaskGraphResultProjection): number {
  if (value.availability !== "available") return 0
  if (value.role === "scout") return value.candidates.length
  if (value.role === "analyst") return value.findings.length
  return 1
}

export function taskGraphResultProjectionBytes(value: TaskGraphResultProjection): number { return Buffer.byteLength(JSON.stringify(value), "utf8") }

