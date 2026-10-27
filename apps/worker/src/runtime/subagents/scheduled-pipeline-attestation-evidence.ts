import { createHash } from 'node:crypto'
import { SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA,
  type ScheduledPipelineAttestation, type ScheduledPipelineAttestationV1, type ScheduledPipelineAttestationV2,
  type ScheduledPipelineDiscoveryReceipt, type ScheduledPipelineScoutProofV2 } from '@jobcopilot/agent-protocol'
import { canonicalTaskGraphJson, type TaskGraphSnapshot } from './task-graph-snapshot.js'
import { publicTaskGraphVerificationReport, type TaskGraphStoredVerificationReport } from './task-graph-verification-report.js'
import { parseDiscoveryAttemptSidecar } from './child-discovery-attempt.js'
import { parseScheduledPipelineRoleResult, type ScheduledPipelineNodeEvidence } from './scheduled-pipeline-node-evidence.js'
import type { ScheduledAnalyzePrefix } from './scheduled-analyze-prefix.js'
import type { ScheduledAutomationPipelineBridgeDependencies, ScheduledAutomationPipelineBridgeScope,
  ScheduledAutomationPipelineBlockReason, ScheduledDiscoveryCompletionReceipt } from './scheduled-automation-pipeline-bridge.js'
import type { TaskGraphPgVerificationResult, TaskGraphVerificationScope } from './task-graph-pg-verification.js'
import type { ScheduledAutomationSnapshot } from './scheduled-automation-snapshot.js'
import type { TaskGraphVerificationEvidenceProjection } from '../planning/task-graph-verification.js'

type Proof = TaskGraphPgVerificationResult
type Ready = Readonly<{ status: 'ready'; attestation: ScheduledPipelineAttestation }>
type Blocked = Readonly<{ status: 'blocked'; reasonCode: ScheduledAutomationPipelineBlockReason }>
const digest = (value: unknown): string => createHash('sha256').update(canonicalTaskGraphJson(value), 'utf8').digest('hex')
const compareCodepoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** Shared, deterministic V2 DTO and digest projection for Analyze production and persisted readback. */
export function projectScheduledPipelineV2Attestation(input: Readonly<{
  owner: ScheduledPipelineAttestationV2['owner']
  snapshotDigest: string
  graphDigest: string
  graphRevision: number
  scouts: readonly ScheduledPipelineScoutProofV2[]
  analyst: Omit<ScheduledPipelineAttestationV2['analyst'], 'dependsOnTaskIds'>
  bindings: NonNullable<TaskGraphStoredVerificationReport['dependencyBindings']>
}>): ScheduledPipelineAttestationV2 {
  const scouts = [...input.scouts].sort((left, right) => compareCodepoint(left.nodeKey, right.nodeKey))
  const candidateUnionJobIds = [...new Set(scouts.flatMap(source => source.candidateJobIds))].sort(compareCodepoint)
  const analyst = { ...input.analyst, dependsOnTaskIds: scouts.map(source => source.taskId).sort(compareCodepoint) }
  const evidenceDigest = digest({ schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA,
    owner: stableOwnerProjection(input.owner), snapshotDigest: input.snapshotDigest, graphDigest: input.graphDigest,
    graphRevision: input.graphRevision, scouts, candidateUnionJobIds, analyst, bindings: input.bindings })
  return { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA, owner: input.owner, snapshotDigest: input.snapshotDigest,
    graphRevision: input.graphRevision, scouts, candidateUnionJobIds, analyst, evidenceDigest }
}

export async function buildScheduledPipelineAttestationEvidence(input: Readonly<{
  dependencies: Pick<ScheduledAutomationPipelineBridgeDependencies, 'verifyCompletedNode'>
  scope: ScheduledAutomationPipelineBridgeScope
  schedule: ScheduledAutomationSnapshot
  prefix: ScheduledAnalyzePrefix
  graph: readonly ScheduledPipelineNodeEvidence[]
}>): Promise<Ready | Blocked> {
  const sources = input.graph.filter(item => item.node.templateId === 'scout'), analyst = input.graph.find(item => item.node.templateId === 'analyst')
  if (!analyst || (sources.length !== 1 && (sources.length < 2 || sources.length > 4))) return blocked('task_graph_node_invalid')
  const v2 = sources.length > 1, scoutResults = sources.map(item => parseScheduledPipelineRoleResult(item.envelope.structuredResult, 'scout'))
  const analystResult = parseScheduledPipelineRoleResult(analyst.envelope.structuredResult, 'analyst')
  if (scoutResults.some(value => !value || value.status !== 'completed') || !analystResult || analystResult.status !== 'completed') return blocked('task_graph_result_invalid')
  const receipts: ScheduledDiscoveryCompletionReceipt[] = [], candidateLists: string[][] = []
  for (const [index, source] of sources.entries()) {
    const receipt = discoveryReceipt(source, input.scope)
    if (!receipt) return blocked(Object.hasOwn(source.envelope, 'discoveryAttempt') ? 'discovery_receipt_incomplete' : 'discovery_receipt_missing')
    const candidates = uniqueIds((scoutResults[index] as NonNullable<typeof scoutResults[number]>).candidates.map(item => item.jobId))
    if (!candidates || candidates.length > 50 || receipt.candidateCount !== candidates.length) return blocked('discovery_result_mismatch')
    receipts.push(receipt); candidateLists.push(candidates)
  }
  const candidateUnionJobIds = [...new Set(candidateLists.flat())].sort(compareCodepoint)
  const analystJobIds = uniqueIds(analystResult.findings.map(item => item.jobId))
  if (!analystJobIds || analystJobIds.some(id => !candidateUnionJobIds.includes(id))) return blocked('discovery_result_mismatch')
  if (v2 && (!candidateUnionJobIds.length || candidateUnionJobIds.length > 200 || !analystJobIds.length || analystJobIds.length > 50)) {
    return blocked('discovery_result_mismatch')
  }
  const sourceProofs: Proof[] = []
  for (const source of sources) {
    const proof = await verify(input.dependencies, input.scope, input.prefix.snapshot, source)
    if (!proof || proof.projection?.role !== 'scout') return blocked('task_graph_evidence_unverified')
    sourceProofs.push(proof)
  }
  const dependencyProjection = new Map<string, TaskGraphVerificationEvidenceProjection>(sources.map((source, index) => [source.node.key, sourceProofs[index]!.projection!]))
  const analystProof = await verify(input.dependencies, input.scope, input.prefix.snapshot, analyst, dependencyProjection)
  if (!analystProof || analystProof.projection?.role !== 'analyst' || !validDependencyBindings(analyst.report, sources, sourceProofs)) {
    return blocked('task_graph_evidence_unverified')
  }
  const owner = { ...input.scope }, snapshotDigest = scheduleDigest(input.schedule), graphDigest = digest(input.prefix.snapshot)
  if (!v2) return { status: 'ready', attestation: buildV1(owner, input.prefix, snapshotDigest, graphDigest, sources[0]!, receipts[0]!, candidateLists[0]!, analyst, analystJobIds) }
  const scouts: ScheduledPipelineScoutProofV2[] = sources.map((source, index) => ({ nodeKey: source.node.key, taskId: source.task.id,
    attemptCount: source.task.attemptCount, status: 'completed', verification: 'passed', resultDigest: source.report.resultDigest!,
    nodeDigest: digest(source.node), evidenceDigest: source.report.evidenceDigest!, reportDigest: digest(publicTaskGraphVerificationReport(source.report)),
    candidateJobIds: candidateLists[index]!, discoveryReceipt: receipts[index]! }))
  const analystAttestation: Omit<ScheduledPipelineAttestationV2['analyst'], 'dependsOnTaskIds'> = { nodeKey: analyst.node.key, taskId: analyst.task.id, attemptCount: analyst.task.attemptCount,
    status: 'completed' as const, verification: 'passed' as const, resultDigest: analyst.report.resultDigest!, nodeDigest: digest(analyst.node),
    evidenceDigest: analyst.report.evidenceDigest!, reportDigest: digest(publicTaskGraphVerificationReport(analyst.report)), jobIds: analystJobIds }
  const bindings = analyst.report.dependencyBindings
  if (!bindings) return blocked('task_graph_evidence_unverified')
  return { status: 'ready', attestation: projectScheduledPipelineV2Attestation({ owner, snapshotDigest, graphDigest,
    graphRevision: input.prefix.current.revision, scouts, analyst: analystAttestation, bindings }) }
}

function buildV1(owner: ScheduledAutomationPipelineBridgeScope, prefix: ScheduledAnalyzePrefix, snapshotDigest: string, graphDigest: string,
  scout: ScheduledPipelineNodeEvidence, receipt: ScheduledDiscoveryCompletionReceipt, candidateJobIds: readonly string[],
  analyst: ScheduledPipelineNodeEvidence, jobIds: readonly string[]): ScheduledPipelineAttestationV1 {
  const stableOwner = stableOwnerProjection(owner), scoutReport = publicTaskGraphVerificationReport(scout.report)
  const analystReport = publicTaskGraphVerificationReport(analyst.report)
  const evidenceDigest = digest({ owner: stableOwner, snapshotDigest, graphDigest, graphRevision: prefix.current.revision, receipt: receipt.receiptDigest,
    scout: { taskId: scout.task.id, attemptCount: scout.task.attemptCount, report: scoutReport },
    analyst: { taskId: analyst.task.id, attemptCount: analyst.task.attemptCount, report: analystReport, bindings: analyst.report.dependencyBindings } })
  return { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, owner, snapshotDigest, graphRevision: prefix.current.revision,
    scout: { taskId: scout.task.id, attemptCount: scout.task.attemptCount, status: 'completed', verification: 'passed',
      resultDigest: scout.report.resultDigest!, candidateJobIds, discoveryReceipt: receipt },
    analyst: { taskId: analyst.task.id, attemptCount: analyst.task.attemptCount, status: 'completed', verification: 'passed',
      resultDigest: analyst.report.resultDigest!, dependsOnTaskIds: [scout.task.id], jobIds }, evidenceDigest }
}

async function verify(deps: Pick<ScheduledAutomationPipelineBridgeDependencies, 'verifyCompletedNode'>, owner: ScheduledAutomationPipelineBridgeScope,
  snapshot: TaskGraphSnapshot, item: ScheduledPipelineNodeEvidence, dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>): Promise<Proof | null> {
  const role = item.node.templateId
  if (role !== 'scout' && role !== 'analyst') return null
  const scope: TaskGraphVerificationScope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, taskId: item.task.id, attemptCount: item.task.attemptCount }
  const proof = await deps.verifyCompletedNode({ scope, snapshot, node: item.node, structuredResult: item.envelope.structuredResult, dependencies })
  const result = proof.structuredResult
    ? role === 'scout' ? parseScheduledPipelineRoleResult(proof.structuredResult, 'scout')
      : parseScheduledPipelineRoleResult(proof.structuredResult, 'analyst')
    : null
  if (!proof.verified || proof.report.status !== 'passed' || !proof.projection || !result
    || digest(result) !== item.report.resultDigest || proof.report.resultDigest !== item.report.resultDigest
    || proof.report.evidenceDigest !== item.report.evidenceDigest
    || !sameJson(publicTaskGraphVerificationReport(item.report), proof.report)
    || !validEmptyDiscoveryProjection(role, result, proof.projection, dependencies)) return null
  return proof
}

function discoveryReceipt(source: ScheduledPipelineNodeEvidence, scope: ScheduledAutomationPipelineBridgeScope): ScheduledDiscoveryCompletionReceipt | null {
  const health = parseDiscoveryAttemptSidecar(source.envelope.discoveryAttempt, source.task.attemptCount)
  if (!health || health.attemptedCalls < 1 || health.completedCalls !== health.attemptedCalls || health.failedCalls !== 0
    || health.unresolvedCalls !== 0 || health.candidateCount === null || health.providerFailures !== 0
    || health.materializationFailures !== 0 || health.hasMore !== false || scope.rootTaskId !== source.task.rootTaskId) return null
  const base = { status: 'complete' as const, taskId: source.task.id, attemptCount: source.task.attemptCount,
    completedCalls: health.completedCalls, candidateCount: health.candidateCount, providerFailures: 0 as const,
    materializationFailures: 0 as const, hasMore: false as const }
  return { ...base, receiptDigest: digest(base) }
}

function validEmptyDiscoveryProjection(role: 'scout' | 'analyst', result: { status: string; candidates?: readonly { jobId: string }[]; findings?: readonly { jobId: string }[] },
  projection: TaskGraphVerificationEvidenceProjection, dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>): boolean {
  const marker = projection.emptyDiscoveryReceipt
  if (role === 'scout') {
    if ((result.candidates ?? []).length > 0) return marker === undefined
    return projection.role === 'scout' && projection.candidates.length === 0 && validEmptyReceipt(marker)
      && projection.evidenceIds.length === 1 && projection.evidenceIds[0] === `read:source:jobs.discover:${marker.digest}`
  }
  if ((result.findings ?? []).length > 0) return marker === undefined
  if (projection.role !== 'analyst' || projection.findings.length !== 0 || projection.evidenceIds.length !== 0
    || !validEmptyReceipt(marker) || !dependencies || dependencies.size !== 1) return false
  const source = dependencies.values().next().value as TaskGraphVerificationEvidenceProjection | undefined
  return source?.role === 'scout' && source.candidates.length === 0 && validEmptyReceipt(source.emptyDiscoveryReceipt)
    && source.emptyDiscoveryReceipt.digest === marker.digest && source.evidenceIds.length === 1
    && source.evidenceIds[0] === `read:source:jobs.discover:${marker.digest}`
}

function validEmptyReceipt(value: unknown): value is Readonly<{ digest: string }> {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  return Boolean(row && Object.keys(row).length === 1 && /^[a-f0-9]{64}$/.test(String(row.digest)))
}
function validDependencyBindings(report: TaskGraphStoredVerificationReport, sources: readonly ScheduledPipelineNodeEvidence[], proofs: readonly Proof[]): boolean {
  const ordered = [...sources].sort((a, b) => compareCodepoint(a.node.key, b.node.key)), bindings = report.dependencyBindings
  if (!bindings || bindings.length !== ordered.length || proofs.length !== ordered.length) return false
  return ordered.every((source, index) => {
    const proof = proofs[sources.indexOf(source)]!, value = bindings[index]!
    return value.nodeKey === source.node.key && value.taskId === source.task.id && value.attemptCount === source.task.attemptCount
      && value.nodeDigest === digest(source.node) && value.resultDigest === proof.report.resultDigest
      && value.evidenceDigest === proof.report.evidenceDigest && value.reportDigest === digest(proof.report)
  })
}
function uniqueIds(values: readonly string[]): string[] | null { return new Set(values).size === values.length ? [...values] : null }
function stableOwnerProjection(owner: ScheduledAutomationPipelineBridgeScope) {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount }
}
function scheduleDigest(snapshot: ScheduledAutomationSnapshot): string {
  return `sha256:${createHash('sha256').update(JSON.stringify([snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations,
    snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]), 'utf8').digest('hex')}`
}
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function blocked(reasonCode: ScheduledAutomationPipelineBlockReason): Blocked { return { status: 'blocked', reasonCode } }
