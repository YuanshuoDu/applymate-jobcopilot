import { isScheduledTaskGraphGateMaterialDriftMarker, SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_ERROR_CODE } from './scheduled-taskgraph-gate-material-drift-marker'

export const SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON = 'scheduled_prepare_material_source_changed' as const

const TURN_STATUSES = new Set(['waiting_for_dependency', 'interrupted'])
const ROOT_STATUSES = new Set(['running', 'waiting', 'waiting_for_user', 'failed', 'interrupted'])
const GATE_TERMINAL_STATUSES = new Set(['failed', 'interrupted'])

type Turn = Readonly<{
  id: string; userId: string; sessionId: string; status: string; source: string; executionMode: string | null
  rootTaskId: string | null; input: unknown; leaseVersion: number
}>
type Task = Readonly<{
  id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
  depth: number; role: string; taskType: string; status: string; attemptCount: number
}>
type Execution = Readonly<{
  id: string; userId: string; sessionId: string; status: string; error: string | null; attemptCount: number; state: unknown
}>

export type ScheduledMaterialDriftProjectionFacts = Readonly<{
  userId: string
  sessionId: string
  activeTurnId: string | null
  newestTurnId: string | null
  turn: Turn | null
  root: Task | null
  gate: Task | null
  execution: Execution | null
}>

/** Returns a private Gate-task lookup hint. The caller must scope its query to the DB-derived Turn/Root. */
export function scheduledMaterialDriftGateTaskId(stateValue: unknown): string | null {
  const marker = record(record(stateValue)?.scheduledTaskGraphMaterialDriftTerminal)
  const gate = record(marker?.gate)
  return validId(gate?.taskId) ? gate.taskId : null
}

/** The historical lease owners are checked only as part of the trusted terminal record, never against current lease columns. */
export function scheduledMaterialDriftRecoveryReason(
  facts: ScheduledMaterialDriftProjectionFacts,
): typeof SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON | null {
  const { userId, sessionId, activeTurnId, newestTurnId, turn, root, gate, execution } = facts
  if (!turn || !root || !gate || !execution || turn.id !== newestTurnId
    || activeTurnId !== null && activeTurnId !== turn.id
    || turn.userId !== userId || turn.sessionId !== sessionId || !TURN_STATUSES.has(turn.status)
    || turn.source !== 'automation' || turn.executionMode !== 'canonical_task_graph'
    || record(turn.input)?.automationRunMode !== 'scheduled' || !turn.rootTaskId
    || turn.leaseVersion < 1 || !Number.isSafeInteger(turn.leaseVersion)) return null
  if (root.id !== turn.rootTaskId || root.sessionId !== sessionId || root.turnId !== turn.id
    || root.rootTaskId !== root.id || root.parentTaskId !== null || root.depth !== 0
    || root.role !== 'orchestrator' || root.taskType !== 'root' || !ROOT_STATUSES.has(root.status)
    || !positive(root.attemptCount)) return null
  if (gate.sessionId !== sessionId || gate.turnId !== turn.id || gate.rootTaskId !== root.id
    || gate.parentTaskId !== root.id || gate.depth !== 1 || gate.role !== 'prepare'
    || gate.taskType !== 'scheduled_taskgraph_gate' || !GATE_TERMINAL_STATUSES.has(gate.status)
    || !positive(gate.attemptCount)) return null
  if (execution.userId !== userId || execution.sessionId !== sessionId
    || !Number.isSafeInteger(execution.attemptCount) || execution.attemptCount < 0) return null

  const state = record(execution.state), marker = record(state?.scheduledTaskGraphMaterialDriftTerminal)
  const markerOwner = record(marker?.owner), markerGate = record(marker?.gate)
  if (!validId(markerOwner?.turnLeaseOwnerId) || !validId(markerGate?.leaseOwnerId)) return null
  const owner = {
    userId: turn.userId, sessionId: turn.sessionId, turnId: turn.id, rootTaskId: root.id,
    rootAttemptCount: root.attemptCount, turnLeaseOwnerId: markerOwner.turnLeaseOwnerId,
    turnLeaseVersion: turn.leaseVersion, executionId: execution.id, executionAttemptCount: execution.attemptCount,
  }
  const gateOwner = { taskId: gate.id, leaseOwnerId: markerGate.leaseOwnerId, attemptCount: gate.attemptCount }
  if (execution.status !== 'failed' || execution.error !== SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_ERROR_CODE
    || state?.scheduledTaskGraphSourceChangeTerminal !== undefined) return null
  return isScheduledTaskGraphGateMaterialDriftMarker({ owner, gate: gateOwner, state: execution.state })
    ? SCHEDULED_PREPARE_MATERIAL_DRIFT_RECOVERY_REASON : null
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
