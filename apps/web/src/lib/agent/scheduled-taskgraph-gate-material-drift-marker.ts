import type { ScheduledTaskGraphPipelineOwner } from './scheduled-taskgraph-pipeline-checkpoint'

export const SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_ERROR_CODE = 'scheduled_prepare_material_source_changed' as const
export const SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_MARKER_SCHEMA = 'agent-harness.v2.scheduled-prepare-material-drift-terminal.v1' as const
export const SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_MARKER_REASON = SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_ERROR_CODE

const OWNER_KEYS = ['userId', 'sessionId', 'turnId', 'rootTaskId', 'rootAttemptCount', 'turnLeaseOwnerId', 'turnLeaseVersion', 'executionId', 'executionAttemptCount'] as const
const GATE_KEYS = ['taskId', 'leaseOwnerId', 'attemptCount'] as const
const MARKER_KEYS = ['schemaVersion', 'reason', 'owner', 'gate', 'analyzeFingerprintDigest', 'prepareProofDigest', 'artifactDigest', 'currentMaterialDigest', 'proofDigest'] as const

type GateOwner = Readonly<{ taskId: string; leaseOwnerId: string; attemptCount: number }>

/** Validates the durable marker and compares its complete identity to independently reconstructed row facts. */
export function isScheduledTaskGraphGateMaterialDriftMarker(input: Readonly<{
  owner: ScheduledTaskGraphPipelineOwner
  gate: GateOwner
  state: unknown
}>): boolean {
  const owner = parseOwner(input.owner), gate = parseGate(input.gate), state = record(input.state)
  const marker = record(state?.scheduledTaskGraphMaterialDriftTerminal)
  const markerOwner = parseOwner(marker?.owner), markerGate = parseGate(marker?.gate)
  return Boolean(owner && gate && marker && exactKeys(marker, MARKER_KEYS)
    && marker.schemaVersion === SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_MARKER_SCHEMA
    && marker.reason === SCHEDULED_TASKGRAPH_GATE_MATERIAL_DRIFT_MARKER_REASON
    && markerOwner && sameOwner(owner, markerOwner) && markerGate && sameGate(gate, markerGate)
    && isDigest(marker.analyzeFingerprintDigest) && isDigest(marker.prepareProofDigest)
    && isDigest(marker.artifactDigest) && isDigest(marker.currentMaterialDigest) && isDigest(marker.proofDigest))
}

function parseOwner(value: unknown): ScheduledTaskGraphPipelineOwner | null {
  const row = record(value)
  if (!row || !exactKeys(row, OWNER_KEYS) || ![row.userId, row.sessionId, row.turnId, row.rootTaskId, row.turnLeaseOwnerId, row.executionId].every(validId)
    || !positive(row.rootAttemptCount) || !positive(row.turnLeaseVersion) || !nonNegative(row.executionAttemptCount)) return null
  return Object.fromEntries(OWNER_KEYS.map(key => [key, row[key]])) as unknown as ScheduledTaskGraphPipelineOwner
}
function parseGate(value: unknown): GateOwner | null {
  const row = record(value)
  if (!row || !exactKeys(row, GATE_KEYS) || !validId(row.taskId) || !validId(row.leaseOwnerId) || !positive(row.attemptCount)) return null
  return { taskId: row.taskId, leaseOwnerId: row.leaseOwnerId, attemptCount: row.attemptCount as number }
}
function sameOwner(a: ScheduledTaskGraphPipelineOwner, b: ScheduledTaskGraphPipelineOwner): boolean {
  return OWNER_KEYS.every(key => a[key] === b[key])
}
function sameGate(a: GateOwner, b: GateOwner): boolean { return GATE_KEYS.every(key => a[key] === b[key]) }
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === 'string' && keys.includes(key))
}
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value }
function isDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
