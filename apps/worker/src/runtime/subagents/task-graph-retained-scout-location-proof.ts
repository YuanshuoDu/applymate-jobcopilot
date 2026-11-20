import type pg from "pg"
import { normalizeAgentLocation } from "@jobcopilot/shared"
import type { RootTaskVerificationRequirement } from "../context/root-task-objective.js"
import {
  evaluateTaskGraphVerification, TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION,
  TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, validateTaskGraphVerificationContract,
  type TaskGraphVerificationEvidenceProjection,
} from "../planning/task-graph-verification.js"
import { parseTaskGraphVerificationReport } from "./task-graph-command-port.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import { verifyCompletedTaskGraphNodeEvidence, taskGraphResultDigest, type TaskGraphVerificationScope } from "./task-graph-pg-verification.js"
import { canonicalTaskGraphJson, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { validateRoleResult } from "./role-results.js"

type LocationRequirement = Extract<RootTaskVerificationRequirement, { kind: "candidate_location_in" }>
type Client = Pick<pg.PoolClient, "query">
export type TaskGraphRetainedScoutLocationDecision = Readonly<{
  status: "compatible" | "incompatible" | "unavailable"
}>
export type TaskGraphRetainedScoutLocationProofInput = Readonly<{
  client: Client
  scope: TaskGraphVerificationScope
  snapshot: TaskGraphSnapshot
  node: StoredTaskGraphNode
  task: GraphTaskRow
  requirement: LocationRequirement
}>

const UNAVAILABLE: TaskGraphRetainedScoutLocationDecision = Object.freeze({ status: "unavailable" })

/** Rebinds a completed original Scout's current receipts before testing a successor location requirement. */
export async function verifyTaskGraphRetainedScoutLocationProof(
  input: TaskGraphRetainedScoutLocationProofInput,
): Promise<TaskGraphRetainedScoutLocationDecision> {
  try {
    if (!input || typeof input !== "object") return UNAVAILABLE
    const { client, scope, snapshot, node, task, requirement } = input
    if (!client || !snapshot || !Array.isArray(snapshot.nodes) || !node || !task || !scope || !requirement
      || !validScope(scope)
      || node.templateId !== "scout" || node.verificationDisposition !== "typed" || node.verification?.role !== "scout"
      || node.taskId !== scope.taskId || task.id !== scope.taskId || task.role !== "scout" || task.status !== "completed"
      || task.taskType !== "job_discovery" || task.failureReason !== null
      || task.attemptCount !== scope.attemptCount || node.repairOf || node.nativeDelegation
      || !snapshot.nodes.some(candidate => candidate.taskId === node.taskId
        && canonicalTaskGraphJson(candidate) === canonicalTaskGraphJson(node))) return UNAVAILABLE
    const envelope = record(task.result)
    if (!envelope || envelope.status !== "completed" || !Object.hasOwn(envelope, "structuredResult")
      || !Object.hasOwn(envelope, "taskGraphVerificationReport")) return UNAVAILABLE

    const successor = validateTaskGraphVerificationContract({
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION_V2, role: "scout",
      criteria: [{ id: requirement.id, check: { kind: requirement.kind, locations: requirement.locations } }],
    }, "scout")
    if (!successor.ok) return UNAVAILABLE

    const proof = await verifyCompletedTaskGraphNodeEvidence(client, {
      scope, snapshot, node, structuredResult: envelope.structuredResult, includeObservedLocation: true,
    })
    const originalIds = node.verification.criteria.map(criterion => criterion.id)
    const storedReport = parseTaskGraphVerificationReport(envelope.taskGraphVerificationReport, originalIds)
    if (!proof.verified || proof.report.status !== "passed" || proof.report.reasonCode !== "criteria_met"
      || !proof.report.evidenceDigest || !proof.report.resultDigest || !storedReport
      || canonicalTaskGraphJson(storedReport) !== canonicalTaskGraphJson(proof.report)) return UNAVAILABLE

    const result = validateRoleResult(proof.structuredResult, "scout")
    const projection = proof.projection
    if (result.candidates.length === 0
      || !locationProjection(projection) || projection.candidates.length !== result.candidates.length) return UNAVAILABLE
    const resultIds = new Set(result.candidates.map(candidate => candidate.jobId))
    const projectionIds = new Set(projection.candidates.map(candidate => candidate.jobId))
    const evidenceIds = new Set(projection.evidenceIds)
    if (resultIds.size !== result.candidates.length || projectionIds.size !== projection.candidates.length
      || [...resultIds].some(id => !projectionIds.has(id))) return UNAVAILABLE
    for (const candidate of projection.candidates) {
      if (!resultIds.has(candidate.jobId) || candidate.locationEvidenceStatus !== "verified"
        || typeof candidate.observedLocation !== "string" || !candidate.observedLocation
        || normalizeAgentLocation(candidate.observedLocation) !== candidate.observedLocation
        || candidate.evidenceIds.length === 0
        || !candidate.evidenceIds.includes("read:job:" + candidate.jobId)
        || candidate.evidenceIds.some(id => !evidenceIds.has(id))) return UNAVAILABLE
    }
    if (taskGraphResultDigest(result) !== proof.report.resultDigest) return UNAVAILABLE

    const compatible = evaluateTaskGraphVerification(successor.contract, projection)
    if (compatible.status === "passed" && compatible.reasonCode === "criteria_met") return { status: "compatible" }
    if (compatible.status === "failed" && compatible.reasonCode === "criterion_not_met") return { status: "incompatible" }
    return UNAVAILABLE
  } catch {
    return UNAVAILABLE
  }
}

function locationProjection(
  value: TaskGraphVerificationEvidenceProjection | undefined,
): value is Extract<TaskGraphVerificationEvidenceProjection, { role: "scout"; schemaVersion: typeof TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION }> {
  return value?.role === "scout" && value.schemaVersion === TASK_GRAPH_VERIFICATION_EVIDENCE_V2_SCHEMA_VERSION
}

function validScope(scope: TaskGraphVerificationScope): boolean {
  const identities = [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.taskId]
  return identities.every(value => typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value))
    && scope.rootTaskId === scope.parentTaskId && Number.isSafeInteger(scope.attemptCount) && scope.attemptCount >= 1
}

function record(value: unknown): Record<string, unknown> | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}
