import { createHash } from "node:crypto"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { parseDiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import { validateRoleResult, type AnalystResult, type ScoutResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { taskGraphVerificationDependencyNodeKeys, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseStoredTaskGraphVerificationReport, publicTaskGraphVerificationReport, type TaskGraphStoredVerificationReport } from "./task-graph-verification-report.js"
import type { TaskGraphCurrentNode, TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { TaskGraphPgVerificationResult, TaskGraphVerificationScope } from "./task-graph-pg-verification.js"
import { projectScheduledAnalyzePrefix } from "./scheduled-automation-prepare-bridge.js"

export const SCHEDULED_PIPELINE_ATTESTATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-attestation.v1" as const
export type ScheduledAutomationPipelineOwner = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  turnLeaseOwnerId: string; turnLeaseVersion: number
}>
export type ScheduledDiscoveryCompletionReceipt = Readonly<{
  status: "complete"; taskId: string; attemptCount: number
  completedCalls: number; candidateCount: number; providerFailures: 0; materializationFailures: 0; hasMore: false; receiptDigest: string
}>
export type ScheduledAutomationPipelineAttestation = Readonly<{
  schemaVersion: typeof SCHEDULED_PIPELINE_ATTESTATION_SCHEMA
  owner: ScheduledAutomationPipelineOwner
  snapshotDigest: string
  graphRevision: number
  scout: Readonly<{
    taskId: string; attemptCount: number; status: "completed"; verification: "passed"; resultDigest: string
    candidateJobIds: readonly string[]; discoveryReceipt: ScheduledDiscoveryCompletionReceipt
  }>
  analyst: Readonly<{
    taskId: string; attemptCount: number; status: "completed"; verification: "passed"; resultDigest: string
    dependsOnTaskIds: readonly string[]; jobIds: readonly string[]
  }>
  evidenceDigest: string
}>
export type ScheduledAutomationPipelineBlockReason =
  | "scheduled_canonical_turn_required" | "scheduled_snapshot_invalid" | "root_lineage_invalid"
  | "task_graph_incomplete" | "task_graph_node_invalid" | "task_graph_result_invalid"
  | "task_graph_evidence_unverified" | "discovery_receipt_missing" | "discovery_receipt_incomplete"
  | "discovery_result_mismatch" | "canonical_evidence_unavailable"
export type ScheduledAutomationPipelineBridgeResult =
  | Readonly<{ status: "blocked"; reasonCode: ScheduledAutomationPipelineBlockReason }>
  | Readonly<{ status: "ready"; attestation: ScheduledAutomationPipelineAttestation }>
export type ScheduledAutomationPipelineBridgeScope = ScheduledAutomationPipelineOwner; type ScheduledAutomationPipelineScope = ScheduledAutomationPipelineBridgeScope

export type ScheduledAutomationPersistedTurn = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; source: unknown; executionMode: unknown; input: unknown
  status: string; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | string | null
}>
export type ScheduledAutomationPersistedRoot = Readonly<{
  id: string; userId: string; sessionId: string; turnId: string; status: string; attemptCount: number
}>
export type ScheduledAutomationPersistedTask = Readonly<{
  id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string
  role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null; expectedOutputSchema: unknown; allowedActions: unknown; result: unknown
}>
export type ScheduledAutomationPipelineBridgeState = Readonly<{
  turn: ScheduledAutomationPersistedTurn
  root: ScheduledAutomationPersistedRoot
  snapshot: unknown
  current: TaskGraphCurrentState
  tasks: readonly ScheduledAutomationPersistedTask[]
}>
export type ScheduledAutomationPipelineBridgeDependencies = Readonly<{
  /** Must read the persisted Turn, pinned mode, current root, graph item/read model, and task rows under owner scope. */
  load(scope: ScheduledAutomationPipelineScope): Promise<ScheduledAutomationPipelineBridgeState>
  /** Must run the canonical PG verifier against persisted tool receipts for the exact task attempt. */
  verifyCompletedNode(input: Readonly<{
    scope: TaskGraphVerificationScope
    snapshot: TaskGraphSnapshot
    node: StoredTaskGraphNode
    structuredResult: unknown
    dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>
  }>): Promise<TaskGraphPgVerificationResult>
}>

type Row = Record<string, unknown>; type NodeEvidence = { node: StoredTaskGraphNode; current: TaskGraphCurrentNode; task: ScheduledAutomationPersistedTask; envelope: Row; report: TaskGraphStoredVerificationReport }

/** Builds the JSON-safe bridge for the Web continuation; no model-supplied Job objects or legacy scores cross this boundary. */
export function createScheduledAutomationPipelineBridge(dependencies: ScheduledAutomationPipelineBridgeDependencies) {
  return async (scope: ScheduledAutomationPipelineScope): Promise<ScheduledAutomationPipelineBridgeResult> => {
    try {
      if (!validOwner(scope)) return blocked("root_lineage_invalid")
      const state = await dependencies.load(scope)
      if (!persistedRootMatches(scope, state)) return blocked("root_lineage_invalid")
      const scheduledSnapshot = scheduledTurnSnapshot(state.turn)
      if (!scheduledSnapshot) return blocked("scheduled_canonical_turn_required")
      const snapshot = parseSnapshot(state.snapshot)
      if (!snapshot) return blocked("scheduled_snapshot_invalid")
      const prefix = projectScheduledAnalyzePrefix(snapshot, state.current, state.tasks)
      if (!prefix) return blocked("task_graph_incomplete")
      const graph = graphNodes(prefix.snapshot, prefix.current, prefix.tasks, scope)
      if (!graph) return blocked("task_graph_incomplete")
      const scout = graph.find(item => item.node.templateId === "scout")
      const analyst = graph.find(item => item.node.templateId === "analyst")
      if (!scout || !analyst || graph.some(item => item.node.templateId !== "scout" && item.node.templateId !== "analyst")) return blocked("task_graph_node_invalid")
      if (!validScoutNode(scout) || !validAnalystNode(analyst, scout)) return blocked("task_graph_node_invalid")
      const scoutResult = parseResult(scout.envelope.structuredResult, "scout")
      const analystResult = parseResult(analyst.envelope.structuredResult, "analyst")
      if (!scoutResult || scoutResult.status !== "completed" || !analystResult || analystResult.status !== "completed") return blocked("task_graph_result_invalid")
      const receipt = discoveryReceipt(scout, scope)
      if (!receipt) return blocked(Object.hasOwn(scout.envelope, "discoveryAttempt") ? "discovery_receipt_incomplete" : "discovery_receipt_missing")
      const candidateJobIds = uniqueIds(scoutResult.candidates.map(item => item.jobId))
      const analystJobIds = uniqueIds(analystResult.findings.map(item => item.jobId))
      if (!candidateJobIds || !analystJobIds || !consistentDiscoveryCount(receipt.candidateCount, candidateJobIds.length)
        || analystJobIds.some(id => !candidateJobIds.includes(id))) return blocked("discovery_result_mismatch")
      const scoutProof = await verify(dependencies, scope, snapshot, scout)
      if (!scoutProof || scoutProof.projection?.role !== "scout") return blocked("task_graph_evidence_unverified")
      const analystProof = await verify(dependencies, scope, snapshot, analyst, new Map([[scout.node.key, scoutProof.projection]]))
      if (!analystProof || analystProof.projection?.role !== "analyst") return blocked("task_graph_evidence_unverified")
      if (!validDependencyBinding(analyst.report, scout, scoutProof.report)) return blocked("task_graph_evidence_unverified")
      const owner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, rootAttemptCount: scope.rootAttemptCount, turnLeaseOwnerId: scope.turnLeaseOwnerId, turnLeaseVersion: scope.turnLeaseVersion }
      const snapshotDigest = `sha256:${createHash("sha256").update(JSON.stringify([
        scheduledSnapshot.schemaVersion, scheduledSnapshot.targetRoles, scheduledSnapshot.targetLocations,
        scheduledSnapshot.minScore, scheduledSnapshot.dailyCap, scheduledSnapshot.requireApproval, scheduledSnapshot.autoApply,
      ])).digest("hex")}`
      const graphDigest = digest(snapshot)
      const stable = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount }
      const publicScout = publicTaskGraphVerificationReport(scout.report), publicAnalyst = publicTaskGraphVerificationReport(analyst.report)
      const evidenceDigest = digest({ owner: stable, snapshotDigest, graphDigest, graphRevision: prefix.current.revision, receipt: receipt.receiptDigest,
        scout: { taskId: scout.task.id, attemptCount: scout.task.attemptCount, report: publicScout },
        analyst: { taskId: analyst.task.id, attemptCount: analyst.task.attemptCount, report: publicAnalyst, bindings: analyst.report.dependencyBindings } })
      return { status: "ready", attestation: {
        schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_SCHEMA, owner, snapshotDigest, graphRevision: prefix.current.revision,
        scout: { taskId: scout.task.id, attemptCount: scout.task.attemptCount, status: "completed", verification: "passed",
          resultDigest: scout.report.resultDigest!, candidateJobIds, discoveryReceipt: receipt },
        analyst: { taskId: analyst.task.id, attemptCount: analyst.task.attemptCount, status: "completed", verification: "passed",
          resultDigest: analyst.report.resultDigest!, dependsOnTaskIds: [scout.task.id], jobIds: analystJobIds }, evidenceDigest,
      } }
    } catch { return blocked("canonical_evidence_unavailable") }
  }
}

function graphNodes(snapshot: TaskGraphSnapshot, current: TaskGraphCurrentState, tasks: readonly ScheduledAutomationPersistedTask[], scope: ScheduledAutomationPipelineScope): NodeEvidence[] | null {
  if (!Number.isSafeInteger(current.revision) || current.revision < 0 || snapshot.nodes.length !== 2 || current.nodes.length !== 2 || tasks.length !== 2) return null
  const rows: NodeEvidence[] = []
  for (const node of snapshot.nodes) {
    const currentNode = current.nodes.find(value => value.key === node.key)
    const task = tasks.find(value => value.id === node.taskId)
    if (!currentNode || !task || currentNode.taskId !== node.taskId || currentNode.templateId !== node.templateId
      || !sameJson(currentNode.dependsOn, node.dependsOn) || currentNode.status !== "completed" || currentNode.failureReason !== null
      || !taskIdentityMatches(task, scope) || task.status !== "completed" || task.failureReason !== null || !validAttempt(task.attemptCount)) return null
    const envelope = parseEnvelope(task.result, node.templateId === "scout")
    if (!envelope) return null
    const dependencyKeys = node.verification ? taskGraphVerificationDependencyNodeKeys(node.verification) : []
    const report = node.verification && parseStoredTaskGraphVerificationReport(envelope.taskGraphVerificationReport,
      node.verification.criteria.map(item => item.id), dependencyKeys)
    if (!report || report.status !== "passed" || !report.resultDigest || !report.evidenceDigest
      || !sameJson(currentNode.verificationReport, publicTaskGraphVerificationReport(report))) return null
    rows.push({ node, current: currentNode, task, envelope, report })
  }
  return rows
}

async function verify(deps: ScheduledAutomationPipelineBridgeDependencies, owner: ScheduledAutomationPipelineScope, snapshot: TaskGraphSnapshot, item: NodeEvidence,
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>) {
  const role = item.node.templateId
  if (role !== "scout" && role !== "analyst") return null
  const scope: TaskGraphVerificationScope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, taskId: item.task.id, attemptCount: item.task.attemptCount }
  const proof = await deps.verifyCompletedNode({ scope,
    snapshot, node: item.node, structuredResult: item.envelope.structuredResult, dependencies })
  const verifiedResult = proof.structuredResult ? role === "scout"
    ? parseResult(proof.structuredResult, "scout") : parseResult(proof.structuredResult, "analyst") : null
  if (!proof.verified || proof.report.status !== "passed" || !proof.projection || !verifiedResult
    || digest(verifiedResult) !== item.report.resultDigest || proof.report.resultDigest !== item.report.resultDigest
    || proof.report.evidenceDigest !== item.report.evidenceDigest
    || !sameJson(publicTaskGraphVerificationReport(item.report), proof.report)
    || !validEmptyDiscoveryProjection(role, verifiedResult, proof.projection, dependencies)) return null
  return proof
}

function validEmptyDiscoveryProjection(
  role: "scout" | "analyst",
  result: ScoutResult | AnalystResult,
  projection: TaskGraphVerificationEvidenceProjection,
  dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>,
): boolean {
  const marker = projection.emptyDiscoveryReceipt
  if (role === "scout") {
    const candidates = (result as ScoutResult).candidates
    if (candidates.length > 0) return marker === undefined
    return projection.role === "scout" && projection.candidates.length === 0 && validEmptyReceipt(marker)
      && projection.evidenceIds.length === 1
      && projection.evidenceIds[0] === `read:source:jobs.discover:${marker.digest}`
  }
  const findings = (result as AnalystResult).findings
  if (findings.length > 0) return marker === undefined
  if (projection.role !== "analyst" || projection.findings.length !== 0 || projection.evidenceIds.length !== 0
    || !validEmptyReceipt(marker) || !dependencies || dependencies.size !== 1) return false
  const source = dependencies.values().next().value as TaskGraphVerificationEvidenceProjection | undefined
  return source?.role === "scout" && source.candidates.length === 0 && validEmptyReceipt(source.emptyDiscoveryReceipt)
    && source.emptyDiscoveryReceipt.digest === marker.digest && source.evidenceIds.length === 1
    && source.evidenceIds[0] === `read:source:jobs.discover:${marker.digest}`
}

function validEmptyReceipt(value: unknown): value is Readonly<{ digest: string }> {
  const marker = row(value)
  return Boolean(marker && Object.keys(marker).length === 1 && /^[a-f0-9]{64}$/.test(String(marker.digest)))
}

function validDependencyBinding(analyst: TaskGraphStoredVerificationReport, scout: NodeEvidence, proof: TaskGraphPgVerificationResult["report"]): boolean {
  const binding = analyst.dependencyBindings
  if (!binding || binding.length !== 1 || !proof.evidenceDigest || !proof.resultDigest) return false
  const value = binding[0]!
  return value.nodeKey === scout.node.key && value.taskId === scout.task.id && value.attemptCount === scout.task.attemptCount
    && value.nodeDigest === digest(scout.node) && value.resultDigest === proof.resultDigest
    && value.evidenceDigest === proof.evidenceDigest && value.reportDigest === digest(proof)
}

function validScoutNode(item: NodeEvidence): boolean {
  const { node, task } = item
  return node.templateId === "scout" && node.dependsOn.length === 0 && node.verificationDisposition === "typed"
    && node.verification?.role === "scout" && task.role === "scout" && task.taskType === TASK_GRAPH_TEMPLATES.scout.taskType
    && schemaRole(task.expectedOutputSchema, "scout") && sameJson(task.allowedActions, TASK_GRAPH_TEMPLATES.scout.allowedActions)
}
function validAnalystNode(item: NodeEvidence, scout: NodeEvidence): boolean {
  const keys = item.node.verification ? taskGraphVerificationDependencyNodeKeys(item.node.verification) : []
  return item.node.templateId === "analyst" && item.node.verificationDisposition === "typed" && item.node.verification?.role === "analyst"
    && item.node.dependsOn.length === 1 && item.node.dependsOn[0] === scout.node.key && keys.length === 1 && keys[0] === scout.node.key
    && item.task.role === "analyst" && item.task.taskType === TASK_GRAPH_TEMPLATES.analyst.taskType
    && schemaRole(item.task.expectedOutputSchema, "analyst") && sameJson(item.task.allowedActions, TASK_GRAPH_TEMPLATES.analyst.allowedActions)
}

function discoveryReceipt(scout: NodeEvidence, scope: ScheduledAutomationPipelineScope): ScheduledDiscoveryCompletionReceipt | null {
  const health = parseDiscoveryAttemptSidecar(scout.envelope.discoveryAttempt, scout.task.attemptCount)
  if (!health || health.attemptedCalls < 1 || health.completedCalls !== health.attemptedCalls || health.failedCalls !== 0 || health.unresolvedCalls !== 0
    || health.candidateCount === null || health.providerFailures !== 0 || health.materializationFailures !== 0 || health.hasMore !== false) return null
  const base = { status: "complete" as const, taskId: scout.task.id, attemptCount: scout.task.attemptCount,
    completedCalls: health.completedCalls, candidateCount: health.candidateCount, providerFailures: 0 as const, materializationFailures: 0 as const, hasMore: false as const }
  if (scope.rootTaskId !== scout.task.rootTaskId) return null
  return { ...base, receiptDigest: digest(base) }
}

function scheduledTurnSnapshot(turn: ScheduledAutomationPersistedTurn) {
  const input = row(turn.input)
  return turn.source === "automation" && turn.executionMode === "canonical_task_graph" && input?.automationRunMode === "scheduled"
    ? parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot) : undefined
}
function persistedRootMatches(scope: ScheduledAutomationPipelineScope, state: ScheduledAutomationPipelineBridgeState): boolean {
  const { turn, root } = state
  return turn.userId === scope.userId && turn.sessionId === scope.sessionId && turn.turnId === scope.turnId && turn.rootTaskId === scope.rootTaskId
    && turnLeaseMatches(scope, turn)
    && root.id === scope.rootTaskId && root.userId === scope.userId && root.sessionId === scope.sessionId && root.turnId === scope.turnId
    && root.status === "running" && root.attemptCount === scope.rootAttemptCount && validAttempt(root.attemptCount)
}
function turnLeaseMatches(scope: ScheduledAutomationPipelineScope, turn: ScheduledAutomationPersistedTurn): boolean {
  const expiresAt = turn.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime()
    : typeof turn.leaseExpiresAt === "string" ? Date.parse(turn.leaseExpiresAt) : Number.NaN
  return turn.status === "in_progress" && turn.leaseOwnerId === scope.turnLeaseOwnerId
    && turn.leaseVersion === scope.turnLeaseVersion && validAttempt(turn.leaseVersion)
    && Number.isFinite(expiresAt) && expiresAt > Date.now()
}
function taskIdentityMatches(task: ScheduledAutomationPersistedTask, scope: ScheduledAutomationPipelineScope): boolean {
  return task.userId === scope.userId && task.sessionId === scope.sessionId && task.turnId === scope.turnId
    && task.rootTaskId === scope.rootTaskId && task.parentTaskId === scope.rootTaskId
}
function parseSnapshot(value: unknown): TaskGraphSnapshot | null { try { return parseTaskGraphSnapshot(value) } catch { return null } }
function parseEnvelope(value: unknown, withDiscovery: boolean): Row | null {
  const parsed = row(value), base = "finalItemId,finalText,status,stepCount,structuredResult,taskGraphVerificationReport,toolCallCount"
  const keys = Object.keys(parsed ?? {}).sort().join(",")
  const expected = base.split(",").sort().join(",")
  if (!parsed || (keys !== expected && (!withDiscovery || keys !== [...base.split(","), "discoveryAttempt"].sort().join(","))) || parsed.status !== "completed"
    || parsed.finalItemId !== null && typeof parsed.finalItemId !== "string" || typeof parsed.finalText !== "string"
    || !Number.isSafeInteger(parsed.stepCount) || Number(parsed.stepCount) < 0 || !Number.isSafeInteger(parsed.toolCallCount)
    || Number(parsed.toolCallCount) < 0 || !Object.hasOwn(parsed, "structuredResult")) return null
  return parsed
}
function parseResult(value: unknown, role: "scout"): ScoutResult | null
function parseResult(value: unknown, role: "analyst"): AnalystResult | null
function parseResult(value: unknown, role: string): ScoutResult | AnalystResult | null {
  if (role !== "scout" && role !== "analyst") return null
  try { return validateRoleResult(value, role) } catch { return null }
}
function schemaRole(value: unknown, role: "scout" | "analyst"): boolean {
  const parsed = row(value)
  return Boolean(parsed && Object.keys(parsed).sort().join(",") === "role,schemaVersion"
    && parsed.role === role && parsed.schemaVersion === "agent-harness.v2.subagent.result")
}
function consistentDiscoveryCount(receiptCount: number, resultCount: number): boolean {
  return receiptCount === resultCount
}
function uniqueIds(values: readonly string[]): string[] | null { return new Set(values).size === values.length ? [...values] : null }
function validOwner(value: ScheduledAutomationPipelineScope): boolean {
  return [value.userId, value.sessionId, value.turnId, value.rootTaskId, value.turnLeaseOwnerId].every(text)
    && validAttempt(value.rootAttemptCount) && validAttempt(value.turnLeaseVersion)
}
function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function text(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 }
function row(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const proto = Object.getPrototypeOf(parsed); return proto === Object.prototype || proto === null ? parsed as Row : null } catch { return null }
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function blocked(reasonCode: ScheduledAutomationPipelineBlockReason): ScheduledAutomationPipelineBridgeResult { return { status: "blocked", reasonCode } }
