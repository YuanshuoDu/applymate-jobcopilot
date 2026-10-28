import { SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA, type ScheduledPipelineAttestation,
  type ScheduledPipelineAttestationV1, type ScheduledPipelineScoutProofV2,
  type ScheduledPipelineDiscoveryReceipt } from '@jobcopilot/agent-protocol'
import { parseScheduledPrepareProposal, type TaskGraphScheduledPrepareInput, type TaskGraphCurrentState } from './task-graph-command-port.js'
import { TASK_GRAPH_TEMPLATES } from './task-graph-templates.js'
import { canonicalTaskGraphJson, taskGraphFingerprint, type TaskGraphSnapshot } from './task-graph-snapshot.js'
import type { GraphTaskRow } from './task-graph-pg-state.js'
import { parseDiscoveryAttemptSidecar } from './child-discovery-attempt.js'
import { validateRoleResult, type AnalystResult, type ScoutResult } from './role-results.js'
import { parseStoredTaskGraphVerificationReport, publicTaskGraphVerificationReport, type TaskGraphStoredVerificationReport } from './task-graph-verification-report.js'
import { taskGraphVerificationDependencyNodeKeys, type TaskGraphVerificationEvidenceProjection } from '../planning/task-graph-verification.js'
import { projectScheduledPipelineGraph } from './scheduled-pipeline-graph-shape.js'
import { isScheduledAnalystNode, isScheduledScoutNode, type ScheduledPipelineNodeEvidence } from './scheduled-pipeline-node-evidence.js'
import { projectScheduledPipelineV2Attestation } from './scheduled-pipeline-attestation-evidence.js'

type Verified = Readonly<{ node: TaskGraphSnapshot['nodes'][number]; current: TaskGraphCurrentState['nodes'][number]; task: GraphTaskRow;
  envelope: Record<string, unknown>; result: ScoutResult | AnalystResult; report: TaskGraphStoredVerificationReport; reportPublic: unknown }>
const same = (left: unknown, right: unknown): boolean => { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
const compareCodepoint = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** Rebuilds the exact Analyze proof from persisted rows, including the versioned source union. */
export function scheduledAnalyzeGraphMatches(input: TaskGraphScheduledPrepareInput, snapshot: TaskGraphSnapshot, current: TaskGraphCurrentState,
  tasks: ReadonlyMap<string, GraphTaskRow>, hasPrepare: boolean): string | null {
  try {
    const attestation = input.attestation as ScheduledPipelineAttestation
    const v2 = attestation.schemaVersion === SCHEDULED_PIPELINE_ATTESTATION_V2_SCHEMA
    if (!v2 && attestation.schemaVersion !== SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA) return null
    const sourceCount = v2 ? attestation.scouts.length : 1, baseCount = sourceCount + 1
    const stage = hasPrepare ? 'prepare' : 'analyze', version = v2 ? 'v2' : 'v1'
    const projection = projectScheduledPipelineGraph(snapshot.nodes, version, stage), expectedRevision = attestation.graphRevision + Number(hasPrepare)
    if (!projection || !Number.isSafeInteger(expectedRevision) || !Number.isSafeInteger(current.revision) || current.revision < expectedRevision
      || current.revision > expectedRevision && (!hasPrepare || current.nodes.find(value => value.key === 'prepare')?.status === 'queued')
      || snapshot.nodes.length !== baseCount + Number(hasPrepare) || current.nodes.length !== snapshot.nodes.length) return null
    const analyzeSnapshot: TaskGraphSnapshot = { schemaVersion: snapshot.schemaVersion, nodes: snapshot.nodes.slice(0, baseCount),
      ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}) }
    const sourceNodes = projection.scouts, sourceKeys = sourceNodes.map(node => node.key)
    const sources = sourceNodes.map(node => readVerifiedNode(node, current, tasks, 'scout', []))
    if (sources.some(value => !value) || sources.some(value => !isScheduledScoutNode(asNodeEvidence(value!)))) return null
    const analyst = readVerifiedNode(projection.analyst, current, tasks, 'analyst', taskGraphVerificationDependencyNodeKeys(projection.analyst.verification!))
    if (!analyst || !isScheduledAnalystNode(asNodeEvidence(analyst), sources.map(value => asNodeEvidence(value!)))) return null
    const scoutResults = sources.map(value => value!.result as ScoutResult), analystResult = analyst.result as AnalystResult
    const candidateLists = scoutResults.map(result => uniqueIds(result.candidates.map(value => value.jobId)))
    if (candidateLists.some(value => !value)) return null
    const receipts = sources.map((source, index) => sourceReceipt(source!, candidateLists[index]!))
    if (receipts.some(value => !value)) return null
    const union = [...new Set(candidateLists.flatMap(value => value!))].sort(compareCodepoint), analystJobIds = uniqueIds(analystResult.findings.map(value => value.jobId))
    if (!analystJobIds || analystJobIds.some(id => !union.includes(id))) return null
    const stableOwner = { userId: attestation.owner.userId, sessionId: attestation.owner.sessionId, turnId: attestation.owner.turnId,
      rootTaskId: attestation.owner.rootTaskId, rootAttemptCount: attestation.owner.rootAttemptCount }
    let expected: ScheduledPipelineAttestation
    if (v2) {
      if (!union.length || union.length > 200 || !analystJobIds.length || analystJobIds.length > 50
        || candidateLists.some(value => value!.length > 50)) return null
      const scouts: ScheduledPipelineScoutProofV2[] = sources.map((source, index) => ({ nodeKey: source!.node.key, taskId: source!.task.id,
        attemptCount: source!.task.attemptCount!, status: 'completed', verification: 'passed', resultDigest: source!.report.resultDigest!,
        nodeDigest: taskGraphFingerprint(source!.node), evidenceDigest: source!.report.evidenceDigest!,
        reportDigest: taskGraphFingerprint(source!.reportPublic), candidateJobIds: candidateLists[index]!, discoveryReceipt: receipts[index]! }))
      const analystProof = { nodeKey: analyst.node.key, taskId: analyst.task.id, attemptCount: analyst.task.attemptCount!, status: 'completed' as const,
        verification: 'passed' as const, resultDigest: analyst.report.resultDigest!, nodeDigest: taskGraphFingerprint(analyst.node),
        evidenceDigest: analyst.report.evidenceDigest!, reportDigest: taskGraphFingerprint(analyst.reportPublic), jobIds: analystJobIds }
      const bindings = analyst.report.dependencyBindings
      if (!bindings) return null
      expected = projectScheduledPipelineV2Attestation({ owner: attestation.owner, snapshotDigest: attestation.snapshotDigest,
        graphDigest: taskGraphFingerprint(analyzeSnapshot), graphRevision: attestation.graphRevision, scouts, analyst: analystProof, bindings })
      if (!same(expected.analyst.dependsOnTaskIds,
        sourceKeys.map(key => sourceNodes.find(node => node.key === key)?.taskId).filter((id): id is string => Boolean(id)).sort(compareCodepoint))) return null
    } else {
      if (sourceCount !== 1 || analystJobIds.some(id => !candidateLists[0]!.includes(id))) return null
      const receipt = receipts[0]!, scout = sources[0]!
      const evidenceDigest = taskGraphFingerprint({ owner: stableOwner, snapshotDigest: attestation.snapshotDigest,
        graphDigest: taskGraphFingerprint(analyzeSnapshot), graphRevision: attestation.graphRevision, receipt: receipt.receiptDigest,
        scout: { taskId: scout!.task.id, attemptCount: scout!.task.attemptCount, report: scout!.reportPublic },
        analyst: { taskId: analyst.task.id, attemptCount: analyst.task.attemptCount, report: analyst.reportPublic, bindings: analyst.report.dependencyBindings } })
      expected = { schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, owner: attestation.owner, snapshotDigest: attestation.snapshotDigest,
        graphRevision: attestation.graphRevision, scout: { taskId: scout!.task.id, attemptCount: scout!.task.attemptCount!, status: 'completed',
          verification: 'passed', resultDigest: scout!.report.resultDigest!, candidateJobIds: candidateLists[0]!, discoveryReceipt: receipt },
        analyst: { taskId: analyst.task.id, attemptCount: analyst.task.attemptCount!, status: 'completed', verification: 'passed',
          resultDigest: analyst.report.resultDigest!, dependsOnTaskIds: [scout!.task.id], jobIds: analystJobIds }, evidenceDigest } satisfies ScheduledPipelineAttestationV1
    }
    if (!same(attestation, expected)) return null
    if (hasPrepare) {
      const proposal = parseScheduledPrepareProposal(input.proposal, projection.analyst.key, attestation.graphRevision), node = snapshot.nodes[baseCount]!
      const task = tasks.get(node.taskId), currentNode = current.nodes.find(value => value.key === node.key)
      if (!proposal || !task || !currentNode || node.key !== 'prepare' || node.templateId !== 'prepare'
        || node.depth !== projection.analyst.depth + 1 || node.verificationDisposition !== 'specialized'
        || node.goal !== proposal.nodes[0]!.goal || !same(node.successCriteria, proposal.nodes[0]!.successCriteria)
        || !same(node.dependsOn, proposal.nodes[0]!.dependsOn) || !templateTaskMatches(task, 'prepare')) return null
    }
    return projection.analyst.key
  } catch { return null }
}

function sourceReceipt(source: Verified, candidates: readonly string[]): ScheduledPipelineDiscoveryReceipt | null {
  const health = parseDiscoveryAttemptSidecar(source.envelope.discoveryAttempt, source.task.attemptCount ?? 0)
  if (!health || health.attemptedCalls < 1 || health.completedCalls !== health.attemptedCalls || health.failedCalls !== 0
    || health.unresolvedCalls !== 0 || health.candidateCount !== candidates.length || health.providerFailures !== 0
    || health.materializationFailures !== 0 || health.hasMore !== false) return null
  const base = { status: 'complete' as const, taskId: source.task.id, attemptCount: source.task.attemptCount!,
    completedCalls: health.completedCalls, candidateCount: health.candidateCount!, providerFailures: 0, materializationFailures: 0, hasMore: false }
  return { ...base, receiptDigest: taskGraphFingerprint(base) }
}

function readVerifiedNode(node: TaskGraphSnapshot['nodes'][number], current: TaskGraphCurrentState, tasks: ReadonlyMap<string, GraphTaskRow>,
  role: 'scout' | 'analyst', dependencies: readonly string[]): Verified | null {
  const state = current.nodes.find(value => value.key === node.key), task = tasks.get(node.taskId), envelope = parseEnvelope(task?.result, role === 'scout')
  if (!state || !task || state.taskId !== node.taskId || state.templateId !== node.templateId || state.status !== 'completed'
    || state.failureReason !== null || task.status !== 'completed' || task.failureReason !== null || !Number.isSafeInteger(task.attemptCount)
    || task.attemptCount! < 1 || !envelope || !templateTaskMatches(task, role) || !node.verification) return null
  const result = validateRoleResult(envelope.structuredResult, role)
  if (result.status !== 'completed') return null
  const keys = taskGraphVerificationDependencyNodeKeys(node.verification)
  if (!same(keys, dependencies)) return null
  const report = parseStoredTaskGraphVerificationReport(envelope.taskGraphVerificationReport, node.verification.criteria.map(item => item.id), dependencies)
  if (!report || report.status !== 'passed' || report.resultDigest !== taskGraphFingerprint(result)
    || !same(state.verificationReport, publicTaskGraphVerificationReport(report))) return null
  return { node, current: state, task, envelope, result, report, reportPublic: publicTaskGraphVerificationReport(report) }
}

function asNodeEvidence(value: Verified): ScheduledPipelineNodeEvidence {
  return { node: value.node, current: value.current, task: value.task as ScheduledPipelineNodeEvidence['task'], envelope: value.envelope, report: value.report }
}
function templateTaskMatches(task: GraphTaskRow, id: 'scout' | 'analyst' | 'prepare'): boolean {
  const template = TASK_GRAPH_TEMPLATES[id]
  return task.role === template.role && task.taskType === template.taskType
    && same(task.expectedOutputSchema, template.expectedOutputSchema) && same(task.allowedActions, template.allowedActions)
}
function parseEnvelope(value: unknown, discovery: boolean): Record<string, unknown> | null {
  const row = objectRecord(value), keys = ['finalItemId', 'finalText', 'status', 'stepCount', 'structuredResult', 'taskGraphVerificationReport', 'toolCallCount', ...(discovery ? ['discoveryAttempt'] : [])]
  return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === 'string' && keys.includes(key))
    && row.status === 'completed' && (row.finalItemId === null || typeof row.finalItemId === 'string')
    && typeof row.finalText === 'string' && Number.isSafeInteger(row.stepCount) && Number(row.stepCount) >= 0
    && Number.isSafeInteger(row.toolCallCount) && Number(row.toolCallCount) >= 0 && Object.hasOwn(row, 'structuredResult') ? row : null
}
function objectRecord(value: unknown): Record<string, unknown> | null {
  const row = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const prototype = Object.getPrototypeOf(row); return prototype === Object.prototype || prototype === null ? row as Record<string, unknown> : null
}
function uniqueIds(values: readonly string[]): string[] | null { return new Set(values).size === values.length ? [...values] : null }
