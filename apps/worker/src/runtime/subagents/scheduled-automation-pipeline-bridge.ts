import { SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA, type ScheduledPipelineAttestation,
  type ScheduledPipelineAttestationOwner, type ScheduledPipelineDiscoveryReceipt, parseScheduledPipelineAttestation } from '@jobcopilot/agent-protocol'
import { parseScheduledAutomationSnapshot, type ScheduledAutomationSnapshot } from './scheduled-automation-snapshot.js'
import { parseTaskGraphSnapshot, type StoredTaskGraphNode, type TaskGraphSnapshot } from './task-graph-snapshot.js'
import type { TaskGraphCurrentState } from './task-graph-command-port.js'
import type { TaskGraphPgVerificationResult, TaskGraphVerificationScope } from './task-graph-pg-verification.js'
import type { TaskGraphVerificationEvidenceProjection } from '../planning/task-graph-verification.js'
import { readScheduledPipelineNodeEvidence, isScheduledScoutNode, isScheduledAnalystNode } from './scheduled-pipeline-node-evidence.js'
import { projectScheduledAnalyzePrefix } from './scheduled-analyze-prefix.js'
import { buildScheduledPipelineAttestationEvidence } from './scheduled-pipeline-attestation-evidence.js'

export const SCHEDULED_PIPELINE_ATTESTATION_SCHEMA = SCHEDULED_PIPELINE_ATTESTATION_V1_SCHEMA
export type ScheduledAutomationPipelineOwner = ScheduledPipelineAttestationOwner
export type ScheduledDiscoveryCompletionReceipt = ScheduledPipelineDiscoveryReceipt
export type ScheduledAutomationPipelineAttestation = ScheduledPipelineAttestation
export type ScheduledAutomationPipelineBlockReason =
  | 'scheduled_canonical_turn_required' | 'scheduled_snapshot_invalid' | 'root_lineage_invalid'
  | 'task_graph_incomplete' | 'task_graph_node_invalid' | 'task_graph_result_invalid'
  | 'task_graph_evidence_unverified' | 'discovery_receipt_missing' | 'discovery_receipt_incomplete'
  | 'discovery_result_mismatch' | 'canonical_evidence_unavailable'
export type ScheduledAutomationPipelineBridgeResult =
  | Readonly<{ status: 'blocked'; reasonCode: ScheduledAutomationPipelineBlockReason }>
  | Readonly<{ status: 'ready'; attestation: ScheduledAutomationPipelineAttestation }>
export type ScheduledAutomationPipelineBridgeScope = ScheduledAutomationPipelineOwner
type ScheduledAutomationPipelineScope = ScheduledAutomationPipelineBridgeScope

export type ScheduledAutomationPersistedTurn = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; source: unknown; executionMode: unknown; input: unknown
  status: string; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | string | null
}>
export type ScheduledAutomationPersistedRoot = Readonly<{ id: string; userId: string; sessionId: string; turnId: string; status: string; attemptCount: number }>
export type ScheduledAutomationPersistedTask = Readonly<{
  id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string
  role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null
  expectedOutputSchema: unknown; allowedActions: unknown; result: unknown
}>
export type ScheduledAutomationPipelineBridgeState = Readonly<{
  turn: ScheduledAutomationPersistedTurn; root: ScheduledAutomationPersistedRoot; snapshot: unknown
  current: TaskGraphCurrentState; tasks: readonly ScheduledAutomationPersistedTask[]
}>
export type ScheduledAutomationPipelineBridgeDependencies = Readonly<{
  /** Must read the persisted Turn, pinned mode, current root, graph item/read model, and task rows under owner scope. */
  load(scope: ScheduledAutomationPipelineScope): Promise<ScheduledAutomationPipelineBridgeState>
  /** Must run the canonical PG verifier against persisted tool receipts for the exact task attempt. */
  verifyCompletedNode(input: Readonly<{ scope: TaskGraphVerificationScope; snapshot: TaskGraphSnapshot; node: StoredTaskGraphNode;
    structuredResult: unknown; dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection> }>): Promise<TaskGraphPgVerificationResult>
}>

/** Builds the JSON-safe bridge for continuation after rechecking current owner-scoped source proofs. */
export function createScheduledAutomationPipelineBridge(dependencies: ScheduledAutomationPipelineBridgeDependencies) {
  return async (scope: ScheduledAutomationPipelineScope): Promise<ScheduledAutomationPipelineBridgeResult> => {
    try {
      if (!validOwner(scope)) return blocked('root_lineage_invalid')
      const state = await dependencies.load(scope)
      if (!persistedRootMatches(scope, state)) return blocked('root_lineage_invalid')
      const schedule = scheduledTurnSnapshot(state.turn)
      if (!schedule) return blocked('scheduled_canonical_turn_required')
      return buildScheduledAutomationPipelineCurrentAttestation({ scope, schedule, snapshot: state.snapshot,
        current: state.current, tasks: state.tasks, dependencies })
    } catch { return blocked('canonical_evidence_unavailable') }
  }
}

/** Rebuilds current Analyze proof inside a caller-owned, already owner-fenced graph read/transaction. */
export async function buildScheduledAutomationPipelineCurrentAttestation(input: Readonly<{
  scope: ScheduledAutomationPipelineBridgeScope
  schedule: unknown
  snapshot: unknown
  current: TaskGraphCurrentState
  tasks: readonly ScheduledAutomationPersistedTask[]
  dependencies: Pick<ScheduledAutomationPipelineBridgeDependencies, 'verifyCompletedNode'>
}>): Promise<ScheduledAutomationPipelineBridgeResult> {
  try {
    if (!validOwner(input.scope)) return blocked('root_lineage_invalid')
    const schedule = parseScheduledAutomationSnapshot(input.schedule)
    if (!schedule) return blocked('scheduled_snapshot_invalid')
    const snapshot = parseSnapshot(input.snapshot)
    if (!snapshot) return blocked('scheduled_snapshot_invalid')
    const prefix = projectScheduledAnalyzePrefix(snapshot, input.current, input.tasks)
    if (!prefix) return blocked('task_graph_incomplete')
    const sourceCount = prefix.snapshot.nodes.filter(node => node.templateId === 'scout').length
    if (prefix.snapshot.nodes.length !== sourceCount + 1 || sourceCount !== 1 && (sourceCount < 2 || sourceCount > 4)) return blocked('task_graph_node_invalid')
    const graph = readScheduledPipelineNodeEvidence(prefix.snapshot, prefix.current, prefix.tasks, input.scope, prefix.snapshot.nodes.length)
    if (!graph) return blocked('task_graph_incomplete')
    const scouts = graph.filter(item => item.node.templateId === 'scout'), analyst = graph.find(item => item.node.templateId === 'analyst')
    if (scouts.length !== sourceCount || scouts.some(item => !isScheduledScoutNode(item)) || !analyst || !isScheduledAnalystNode(analyst, scouts)) {
      return blocked('task_graph_node_invalid')
    }
    const result = await buildScheduledPipelineAttestationEvidence({ dependencies: input.dependencies, scope: input.scope, schedule, prefix, graph })
    if (result.status === 'blocked') return blocked(result.reasonCode)
    const attestation = parseScheduledPipelineAttestation(result.attestation)
    return attestation ? { status: 'ready', attestation } : blocked('canonical_evidence_unavailable')
  } catch { return blocked('canonical_evidence_unavailable') }
}

function scheduledTurnSnapshot(turn: ScheduledAutomationPersistedTurn): ScheduledAutomationSnapshot | undefined {
  const input = row(turn.input)
  return turn.source === 'automation' && turn.executionMode === 'canonical_task_graph' && input?.automationRunMode === 'scheduled'
    ? parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot) : undefined
}
function persistedRootMatches(scope: ScheduledAutomationPipelineScope, state: ScheduledAutomationPipelineBridgeState): boolean {
  const { turn, root } = state
  return turn.userId === scope.userId && turn.sessionId === scope.sessionId && turn.turnId === scope.turnId && turn.rootTaskId === scope.rootTaskId
    && turnLeaseMatches(scope, turn) && root.id === scope.rootTaskId && root.userId === scope.userId && root.sessionId === scope.sessionId
    && root.turnId === scope.turnId && root.status === 'running' && root.attemptCount === scope.rootAttemptCount && validAttempt(root.attemptCount)
}
function turnLeaseMatches(scope: ScheduledAutomationPipelineScope, turn: ScheduledAutomationPersistedTurn): boolean {
  const expiresAt = turn.leaseExpiresAt instanceof Date ? turn.leaseExpiresAt.getTime()
    : typeof turn.leaseExpiresAt === 'string' ? Date.parse(turn.leaseExpiresAt) : Number.NaN
  return turn.status === 'in_progress' && turn.leaseOwnerId === scope.turnLeaseOwnerId && turn.leaseVersion === scope.turnLeaseVersion
    && validAttempt(turn.leaseVersion) && Number.isFinite(expiresAt) && expiresAt > Date.now()
}
function parseSnapshot(value: unknown): TaskGraphSnapshot | null { try { return parseTaskGraphSnapshot(value) } catch { return null } }
function validOwner(value: ScheduledAutomationPipelineScope): boolean {
  return [value.userId, value.sessionId, value.turnId, value.rootTaskId, value.turnLeaseOwnerId].every(text)
    && validAttempt(value.rootAttemptCount) && validAttempt(value.turnLeaseVersion)
}
function validAttempt(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 }
function row(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Record<string, unknown> : null } catch { return null }
}
function blocked(reasonCode: ScheduledAutomationPipelineBlockReason): ScheduledAutomationPipelineBridgeResult { return { status: 'blocked', reasonCode } }
