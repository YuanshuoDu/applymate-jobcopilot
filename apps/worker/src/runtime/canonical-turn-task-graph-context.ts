import { Buffer } from "node:buffer"
import type { StepContextSnapshot } from "./context/step-context-builder.js"
import {
  parseTaskGraphRepairOf, parseTaskGraphRepairReceipt, parseTaskGraphVerificationCriterionIds, parseTaskGraphVerificationReport,
  TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
  type TaskGraphAnalystProjectionItem, type TaskGraphArtifactProjectionReference, type TaskGraphCurrentNode,
  type TaskGraphCommandPort, type TaskGraphCurrentState, type TaskGraphProjectionEvidenceKind, type TaskGraphProjectionSource,
  type TaskGraphReadScope, type TaskGraphResultProjection, type TaskGraphScoutProjectionItem,
} from "./subagents/task-graph-command-port.js"
import { type TaskGraphRepairOf } from "./planning/task-graph.js"
import type { TurnLease } from "./turns/lease.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import { nativeGraphNodeFields } from "./canonical-turn-native-graph-context.js"
const SELECTED_JOB_ROOT_TOOLS = new Set(["agent.plan", "agent.wait", "agent.list", "list_subagents"])

export function isSelectedJobRootTool(definition: unknown): boolean {
  const name = record(definition)?.name
  return typeof name === "string" && SELECTED_JOB_ROOT_TOOLS.has(name)
}
export function selectedJobToolAllowed(name: string): boolean {
  return SELECTED_JOB_ROOT_TOOLS.has(name)
}
/** Restrict selected-job root context to coordination tools and the current graph observation. */
export function selectedJobSnapshot(snapshot: StepContextSnapshot): StepContextSnapshot {
  return {
    ...snapshot,
    toolObservations: snapshot.toolObservations.filter(observation => {
      const content = record(observation.content)
      const toolName = content?.toolName
      return (typeof toolName === "string" && SELECTED_JOB_ROOT_TOOLS.has(toolName))
        || (observation.id === "task-graph-current" && content?.kind === "task_graph_current")
    }),
  }
}

const OBSERVATION_ID = "task-graph-current"
const MAX_NODES = 16
const MAX_TEXT = 160_000
const MAX_RESULT_PROJECTION_BYTES = 2 * 1024
const MAX_RESULT_PROJECTION_TOTAL_BYTES = 16 * 1024
const MAX_RESULT_PROJECTION_ITEMS = 3
const MAX_RESULT_PROJECTION_TOTAL_ITEMS = 24
const MAX_VERIFICATION_CONTEXT_BYTES = 32 * 1024
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
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
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
function projection(value: unknown): TaskGraphResultProjection {
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

function safeJobId(value: unknown): value is string {
  return typeof value === "string" && SAFE_JOB_ID.test(value)
}

function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validStatus(value: unknown): value is "completed" | "partial" {
  return value === "completed" || value === "partial"
}

function exactKeys(value: Record<string, unknown>, expected: string): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.every((key): key is string => typeof key === "string") && keys.sort().join(",") === expected
}
function projectionItems(value: TaskGraphResultProjection): number {
  if (value.availability !== "available") return 0
  if (value.role === "scout") return value.candidates.length
  if (value.role === "analyst") return value.findings.length
  return 1
}

function projectionBytes(value: TaskGraphResultProjection): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function node(value: unknown): TaskGraphCurrentNode {
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
    key, templateId: text(row.templateId, 128, "templateId"),
    goal: text(row.goal, 1200, "goal", true), successCriteria: stringList(row.successCriteria, 8, 320, "successCriteria"),
    dependsOn: stringList(row.dependsOn, MAX_NODES, 128, "dependsOn"), taskId,
    status: row.status as TaskGraphCurrentNode["status"], readiness: row.readiness as TaskGraphCurrentNode["readiness"],
    resultSummary: null,
    resultProjection: projection(row.resultProjection),
    ...(verificationCriterionIds ? { verificationCriterionIds } : {}), ...(verificationReport ? { verificationReport } : {}),
    ...(repairOf ? { repairOf } : {}), ...(repairReceipt ? { repairReceipt } : {}), ...nativeGraphNodeFields(row),
    failureReason: null,
  }
}

/** Replace an old read with the server-fenced current graph, as untrusted model evidence. */
export function mergeTaskGraphCurrentObservation(snapshot: StepContextSnapshot, value: TaskGraphCurrentState): StepContextSnapshot {
  const state = record(value)
  if (!state || !Number.isSafeInteger(state.revision) || Number(state.revision) < 0 || !Array.isArray(state.nodes) || state.nodes.length > MAX_NODES) throw new Error("task_graph_current_state_invalid")
  let projectedBytes = 0
  let projectedItems = 0
  let verificationBytes = 0
  const nodes = state.nodes.map(value => {
    const item = node(value)
    const bytes = projectionBytes(item.resultProjection!)
    const count = projectionItems(item.resultProjection!)
    verificationBytes += Buffer.byteLength(JSON.stringify({ verificationCriterionIds: item.verificationCriterionIds, verificationReport: item.verificationReport, repairOf: item.repairOf, repairReceipt: item.repairReceipt }), "utf8")
    if (verificationBytes > MAX_VERIFICATION_CONTEXT_BYTES) throw new Error("task_graph_current_verification_too_large")
    if (projectedBytes + bytes > MAX_RESULT_PROJECTION_TOTAL_BYTES
      || projectedItems + count > MAX_RESULT_PROJECTION_TOTAL_ITEMS) {
      return { ...item, resultProjection: UNAVAILABLE_PROJECTION }
    }
    projectedBytes += bytes
    projectedItems += count
    return item
  })
  const keys = new Set(nodes.map(item => item.key))
  if (keys.size !== nodes.length || nodes.some(item => item.dependsOn.some(key => !keys.has(key)))) throw new Error("task_graph_current_state_invalid:dependencies")
  const content = { kind: "task_graph_current", revision: Number(state.revision), nodes }
  if (JSON.stringify(content).length > MAX_TEXT) throw new Error("task_graph_current_state_too_large")
  return {
    ...snapshot,
    toolObservations: [
      ...snapshot.toolObservations.filter(observation => observation.id !== OBSERVATION_ID),
      { id: OBSERVATION_ID, content },
    ],
  }
}

export async function loadTaskGraphCurrentObservation(
  snapshot: StepContextSnapshot,
  commandPort: TaskGraphCommandPort | undefined,
  lease: TurnLease,
  root: Pick<SubagentTaskRecord, "id" | "attemptCount">,
): Promise<StepContextSnapshot> {
  if (!commandPort) throw new Error("task_graph_runtime_dependencies_unavailable")
  const scope: TaskGraphReadScope = {
    userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: root.id, parentTaskId: root.id,
    turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
  }
  return mergeTaskGraphCurrentObservation(snapshot, await commandPort.readCurrent(scope))
}
