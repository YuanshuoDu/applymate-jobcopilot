import { hashArtifactContent } from "./artifact-adapters.js"
import { SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE } from "./scheduled-gate-contract.js"
import { parseScheduledGateRegistrationReceipt, readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"
import { scheduledTaskGraphContinuationKeyVersion, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import type { Queryable } from "./pg-store-persistence.js"

const MATERIAL_DRIFT_REASON = "scheduled_prepare_material_source_changed"
const MATERIAL_DRIFT_MARKER_SCHEMA = "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1"
const MATERIAL_DRIFT_PROOF_SCHEMA = "agent-harness.v2.scheduled-prepare-material-drift-proof.v1"
const CONTINUATION_SCHEMA = "agent-harness.v2.scheduled-pipeline-continuation.v1"
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"] as const
const MARKER_KEYS = ["schemaVersion", "reason", "owner", "gate", "analyzeFingerprintDigest", "prepareProofDigest", "artifactDigest", "currentMaterialDigest", "proofDigest"] as const
const CONTINUATION_KEYS = ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"] as const
const GATE_KEYS = ["taskId", "leaseOwnerId", "attemptCount"] as const
const DIGEST = /^sha256:[a-f0-9]{64}$/

export async function lockScheduledGateFinish(client: Queryable, task: Record<string, unknown>, input: {
  taskId: string; sessionId: string; ownerId: string; attemptCount: number
  status?: string; failureReason?: string; retryDisposition?: string
}): Promise<boolean> {
  const userId = String(task.userId), turnId = String(task.turnId), rootTaskId = String(task.rootTaskId)
  if (task.parentTaskId !== rootTaskId || task.role !== SCHEDULED_GATE_ROLE) return false
  const materialDriftFailure = input.failureReason === MATERIAL_DRIFT_REASON
  if (materialDriftFailure && (input.status !== "failed" || input.retryDisposition !== "terminal")) return false
  const turn = await client.query(`SELECT "id", "rootTaskId", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt",
      "leaseExpiresAt" > clock_timestamp() AS "leaseLive"
    FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`, [turnId, input.sessionId, userId])
  const root = await client.query(`SELECT "id", "status", "attemptCount", "interruptRequestedAt", "closedAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
    AND "rootTaskId" = $1 AND "parentTaskId" IS NULL FOR UPDATE`, [rootTaskId, input.sessionId, turnId])
  const gate = await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
    AND "rootTaskId" = $4 AND "parentTaskId" = $4 AND "role" = $5 AND "taskType" = $6
    AND "depth" = 1 AND "expectedOutputSchema" = $7::jsonb AND "allowedActions" = '[]'::jsonb AND "closedAt" IS NULL
    AND "status" = 'running' AND "leaseOwner" = $8 AND "attemptCount" = $9
    AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())
    AND "leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NULL FOR UPDATE`,
  [input.taskId, input.sessionId, turnId, rootTaskId, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, JSON.stringify(SCHEDULED_GATE_OUTPUT_SCHEMA), input.ownerId, input.attemptCount])
  if (turn.rows.length !== 1 || root.rows.length !== 1 || gate.rows.length !== 1) return false
  const event = await client.query(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
    AND "type" = 'agent.plan.scheduled_gate_binding' AND "payload"->>'gateTaskId' = $3`, [input.sessionId, turnId, input.taskId])
  const receipt = event.rows.length === 1 && parseScheduledGateRegistrationReceipt(event.rows[0]?.payload)
  if (!receipt || receipt.gateTaskId !== input.taskId) return false
  const registered = await readScheduledGateRegistrationReceipt(client, { userId, sessionId: input.sessionId, turnId,
    owner: receipt.owner, gateTaskId: input.taskId })
  if (!registered) return false
  const execution = await client.query(`SELECT "id", "status", "error", "state", "attemptCount" FROM "agent_executions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3
    AND "attemptCount" = $4 FOR UPDATE`,
  [registered.owner.executionId, userId, input.sessionId, registered.owner.executionAttemptCount])
  if (execution.rows.length !== 1) return false
  const row = execution.rows[0] as Record<string, unknown>
  if (row.status === "running") return !materialDriftFailure
  if (!materialDriftFailure || row.status !== "failed" || row.error !== MATERIAL_DRIFT_REASON) return false
  return trustedMaterialDriftTerminal({ execution: row, turn: turn.rows[0] as Record<string, unknown>,
    root: root.rows[0] as Record<string, unknown>, receipt: registered, gate: {
      taskId: input.taskId, leaseOwnerId: input.ownerId, attemptCount: input.attemptCount,
    } })
}

function trustedMaterialDriftTerminal(input: Readonly<{
  execution: Record<string, unknown>; turn: Record<string, unknown>; root: Record<string, unknown>
  receipt: Awaited<ReturnType<typeof readScheduledGateRegistrationReceipt>> & {}; gate: { taskId: string; leaseOwnerId: string; attemptCount: number }
}>): boolean {
  const { execution, turn, root, receipt, gate } = input
  const state = record(execution.state), marker = exactRecord(state?.scheduledTaskGraphMaterialDriftTerminal, MARKER_KEYS)
  const continuation = exactRecord(state?.scheduledTaskGraphContinuation, CONTINUATION_KEYS)
  const owner = parseMaterialOwner(marker?.owner), continuationOwner = parseMaterialOwner(continuation?.owner)
  const markerGate = exactRecord(marker?.gate, GATE_KEYS)
  if (!state || !marker || !continuation || !owner || !continuationOwner || !markerGate || !receipt
    || state.scheduledTaskGraphSourceChangeTerminal !== undefined
    || marker.schemaVersion !== MATERIAL_DRIFT_MARKER_SCHEMA || marker.reason !== MATERIAL_DRIFT_REASON
    || markerGate.taskId !== gate.taskId || markerGate.leaseOwnerId !== gate.leaseOwnerId || markerGate.attemptCount !== gate.attemptCount) return false
  if (!sameOwner(owner, continuationOwner) || !sameRegisteredOwner(owner, receipt.owner)
    || continuation.schemaVersion !== CONTINUATION_SCHEMA) return false
  const derivedContinuationKey = scheduledTaskGraphStableContinuationKey({ owner,
    continuationKey: continuation.key, snapshotDigest: continuation.snapshotDigest,
    evidenceDigest: continuation.evidenceDigest, checkpointDigest: receipt.checkpointDigest,
    analyzeGraphRevision: continuation.graphRevision, prepareScheduleRevision: receipt.prepareScheduleRevision })
  if (!derivedContinuationKey || derivedContinuationKey !== receipt.continuationKey
    || scheduledTaskGraphContinuationKeyVersion(continuation.key) === null
    || scheduledTaskGraphContinuationKeyVersion(continuation.key) !== scheduledTaskGraphContinuationKeyVersion(receipt.continuationKey)
    || continuation.snapshotDigest !== receipt.snapshotDigest
    || continuation.evidenceDigest !== receipt.evidenceDigest || continuation.graphRevision !== receipt.analyzeGraphRevision) return false
  if (!isDigest(marker.analyzeFingerprintDigest) || !isDigest(marker.prepareProofDigest)
    || !isDigest(marker.artifactDigest) || !isDigest(marker.currentMaterialDigest) || !isDigest(marker.proofDigest)) return false
  if (execution.id !== receipt.owner.executionId || execution.attemptCount !== receipt.owner.executionAttemptCount
    || root.id !== receipt.owner.rootTaskId || root.attemptCount !== receipt.owner.rootAttemptCount
    || isTerminal(root.status) || root.interruptRequestedAt != null || root.closedAt != null
    || turn.id !== receipt.owner.turnId || turn.rootTaskId !== receipt.owner.rootTaskId || !currentGateChildTurn(turn, owner)) return false
  try {
    return hashArtifactContent({ schemaVersion: MATERIAL_DRIFT_PROOF_SCHEMA, owner, gate: markerGate,
      snapshotDigest: continuation.snapshotDigest, analyzeFingerprintDigest: marker.analyzeFingerprintDigest,
      prepareProofDigest: marker.prepareProofDigest, artifactDigest: marker.artifactDigest,
      currentMaterialDigest: marker.currentMaterialDigest }) === marker.proofDigest
  } catch { return false }
}

function currentGateChildTurn(turn: Record<string, unknown>, owner: MaterialOwner): boolean {
  if (turn.status === "in_progress") return turn.leaseOwnerId === owner.turnLeaseOwnerId
    && turn.leaseVersion === owner.turnLeaseVersion && turn.leaseLive === true
  return ["waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "waiting_for_tool"].includes(String(turn.status))
    && turn.leaseOwnerId === null && turn.leaseExpiresAt === null
}

type MaterialOwner = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number;
  turnLeaseOwnerId: string; turnLeaseVersion: number; executionId: string; executionAttemptCount: number }>
function parseMaterialOwner(value: unknown): MaterialOwner | null {
  const row = exactRecord(value, OWNER_KEYS)
  if (!row || !OWNER_KEYS.filter(key => key !== "rootAttemptCount" && key !== "turnLeaseVersion" && key !== "executionAttemptCount")
    .every(key => validId(row[key])) || !positive(row.rootAttemptCount) || !positive(row.turnLeaseVersion)
    || !nonNegative(row.executionAttemptCount)) return null
  return row as unknown as MaterialOwner
}
function sameOwner(left: MaterialOwner, right: MaterialOwner): boolean { return OWNER_KEYS.every(key => left[key] === right[key]) }
function sameRegisteredOwner(owner: MaterialOwner, registered: { userId: string; sessionId: string; turnId: string; rootTaskId: string;
  rootAttemptCount: number; executionId: string; executionAttemptCount: number }): boolean {
  return owner.userId === registered.userId && owner.sessionId === registered.sessionId && owner.turnId === registered.turnId
    && owner.rootTaskId === registered.rootTaskId && owner.rootAttemptCount === registered.rootAttemptCount
    && owner.executionId === registered.executionId && owner.executionAttemptCount === registered.executionAttemptCount
}
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const row = record(value), actual = row && Reflect.ownKeys(row)
  return row && actual && actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key))
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return descriptor?.enumerable && "value" in descriptor }) ? row : null
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isDigest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function isTerminal(value: unknown): boolean { return ["completed", "failed", "interrupted", "cancelled", "closed"].includes(String(value)) }
