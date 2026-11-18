import { createHash } from "node:crypto"
import type pg from "pg"
import type { CanonicalExecutionProjection } from "../canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "../canonical-session-projection.js"
import type { CanonicalTurnState } from "../canonical-turn-state.js"
import type { TurnLease } from "../turns/lease.js"
import type { TurnExecutionResult } from "../turns/turn-queue.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { projectScheduledPipelineGraphAtCurrentStage, type ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"
import type { RootTaskStore } from "./root-task-store.js"
export const MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA = "agent-harness.v2.material-drift-recovery.v2" as const
const MARKER_SCHEMA = "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1"
const MARKER_REASON = "scheduled_prepare_material_source_changed"
const MAX_RECOVERY_CHAIN_DEPTH = 64
const MAX_EXECUTION_ATTEMPT = 2_147_483_647
const INTENT_KEYS = ["schemaVersion", "turnId", "userId", "sessionId", "automationId", "previousTurnId", "previousExecutionId",
  "previousRecoveryTurnId", "previousGateTaskId", "previousGateAttemptCount", "previousRootTaskId", "previousRootAttemptCount", "previousTurnLeaseVersion",
  "previousExecutionAttemptCount", "reservedExecutionAttemptCount", "currentSnapshotDigest", "sourceMarker"] as const
const MARKER_KEYS = ["schemaVersion", "reason", "owner", "gate", "analyzeFingerprintDigest", "prepareProofDigest", "artifactDigest",
  "currentMaterialDigest", "proofDigest"] as const
const OWNER_KEYS = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion",
  "executionId", "executionAttemptCount"] as const
const GATE_KEYS = ["taskId", "leaseOwnerId", "attemptCount"] as const
const DIGEST = /^sha256:[a-f0-9]{64}$/
type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
export type MaterialDriftRecoveryIntent = Readonly<{
  schemaVersion: typeof MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA
  turnId: string; userId: string; sessionId: string; automationId: string; previousRecoveryTurnId: string | null
  previousTurnId: string; previousExecutionId: string; previousGateTaskId: string; previousGateAttemptCount: number
  previousRootTaskId: string; previousRootAttemptCount: number; previousTurnLeaseVersion: number
  previousExecutionAttemptCount: number; reservedExecutionAttemptCount: number; currentSnapshotDigest: string; sourceMarker: Row
}>
export type MaterialDriftRecoveryRead = Readonly<{ status: "absent" | "invalid" }> | Readonly<{ status: "valid"; intent: MaterialDriftRecoveryIntent }>
/** Loads and validates one current Turn before setup can enable the fresh Prepare/Gate path. */
export async function validateMaterialDriftRecoveryTurn(pool: Pick<pg.Pool, "connect">,
  scope: Readonly<{ turnId: string; userId: string; sessionId: string }>, expectedIntent?: MaterialDriftRecoveryIntent): Promise<MaterialDriftRecoveryRead | Readonly<{ status: "unavailable" }>> {
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", scope.userId])
    const turn = await one(client, `SELECT turn."id", turn."userId", turn."sessionId", turn."source", turn."executionMode", turn."input", turn."status", turn."createdAt"
      FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
      WHERE turn."id" = $1 AND turn."userId" = $2 AND turn."sessionId" = $3 AND session."status" NOT IN ('aborted', 'archived')`,
    [scope.turnId, scope.userId, scope.sessionId])
    const read = readMaterialDriftRecoveryIntent(turn)
    const result = read.status === "valid" && await verifyMaterialDriftRecoveryLineage(client, turn, expectedIntent ?? read.intent)
      ? read : read.status === "absent" ? read : { status: "invalid" as const }
    await client.query("COMMIT"); committed = true
    return result
  } catch {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    return { status: "unavailable" }
  } finally { client.release() }
}
export async function failMaterialDriftRecovery(input: { lease: TurnLease; state: CanonicalTurnState; rootTasks: RootTaskStore;
  executionProjection: CanonicalExecutionProjection; sessionProjection: CanonicalSessionProjection; now: () => Date }): Promise<TurnExecutionResult> {
  const result = { status: "failed" as const, errorCode: "material_drift_recovery_invalid", stepCount: 0, toolCallCount: 0 }
  const root = await input.rootTasks.ensure({ lease: input.lease, goal: input.state.goal, modelProfileSnapshot: input.state.modelProfileSnapshot,
    toolPolicySnapshot: input.state.toolPolicySnapshot, budgetSnapshot: input.state.budgetSnapshot, allowedActions: [], now: input.now() })
  await input.rootTasks.finish({ lease: input.lease, rootTaskId: root.id, result, now: input.now() })
  await input.executionProjection.finish({ userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId, result })
  await input.sessionProjection.finish({ userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId, result })
  return { status: "failed", summary: result.errorCode }
}
/** Strictly parses the private, server-authored current Turn intent and all of its source marker. */
export function readMaterialDriftRecoveryIntent(turnValue: unknown): MaterialDriftRecoveryRead {
  const turn = dataRecord(turnValue)
  if (!turn) return { status: "invalid" }
  if (turn.input === undefined || turn.input === null) return { status: "absent" }
  const input = dataRecord(turn.input)
  if (!input) return { status: "invalid" }
  if (!Object.hasOwn(input, "materialDriftRecovery")) return { status: "absent" }
  const raw = exactRecord(input.materialDriftRecovery, INTENT_KEYS)
  const snapshot = parseScheduledAutomationSnapshot(input.scheduledAutomationSnapshot)
  const intent = raw && parseIntent(raw)
  if (!intent || turn.source !== "automation" || turn.executionMode !== "canonical_task_graph"
    || input.automationRunMode !== "manual" || intent.turnId !== turn.id || intent.userId !== turn.userId
    || intent.sessionId !== turn.sessionId || !snapshot || intent.currentSnapshotDigest !== scheduledAutomationSnapshotDigest(snapshot)) {
    return { status: "invalid" }
  }
  return { status: "valid", intent }
}
/** Rechecks the current Automation and exact old Turn/Root/Gate lineage in the caller's tenant-scoped transaction. */
export async function verifyMaterialDriftRecoveryLineage(client: Queryable, turnValue: unknown,
  expectedIntent?: MaterialDriftRecoveryIntent): Promise<boolean> {
  const read = readMaterialDriftRecoveryIntent(turnValue)
  if (read.status !== "valid" || (expectedIntent && !sameIntent(read.intent, expectedIntent))) return false
  const intent = read.intent
  const current = await one(client, `SELECT turn."id", turn."userId", turn."sessionId", turn."source", turn."executionMode", turn."input", turn."status", turn."createdAt"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    WHERE turn."id" = $1 AND turn."userId" = $2 AND turn."sessionId" = $3 AND session."status" NOT IN ('aborted', 'archived')`,
  [intent.turnId, intent.userId, intent.sessionId])
  const currentRead = readMaterialDriftRecoveryIntent(current)
  if (currentRead.status !== "valid" || !sameIntent(intent, currentRead.intent)) return false
  const automation = await one(client, `SELECT "id", "userId", "sessionId" FROM "agent_automations"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3`, [intent.automationId, intent.userId, intent.sessionId])
  const source = await one(client, `SELECT turn."id", turn."userId", turn."sessionId", turn."source", turn."executionMode", turn."input", turn."status", turn."rootTaskId", turn."leaseVersion", turn."createdAt"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
    WHERE turn."id" = $1 AND turn."userId" = $2 AND turn."sessionId" = $3`, [intent.previousTurnId, intent.userId, intent.sessionId])
  const newest = await one(client, `SELECT "id" FROM "agent_turns" WHERE "userId" = $1 AND "sessionId" = $2 AND "id" <> $3
    ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`, [intent.userId, intent.sessionId, intent.turnId])
  const recoveryChainMatches = intent.previousRecoveryTurnId === null
    ? intent.reservedExecutionAttemptCount === intent.previousExecutionAttemptCount + 1
    : await verifyRecoveryPredecessorChain(client, intent, current?.createdAt)
  const root = await one(client, `SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."depth", task."role", task."taskType", task."status", task."attemptCount"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4`,
  [intent.previousRootTaskId, intent.sessionId, intent.previousTurnId, intent.userId])
  const gate = await one(client, `SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."depth", task."role", task."taskType", task."status", task."attemptCount"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND session."userId" = $4`,
  [intent.previousGateTaskId, intent.sessionId, intent.previousTurnId, intent.userId])
  const execution = await one(client, `SELECT "id", "userId", "sessionId", "attemptCount" FROM "agent_executions"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3`, [intent.previousExecutionId, intent.userId, intent.sessionId])
  const sourceInput = dataRecord(source?.input), markerOwner = dataRecord(intent.sourceMarker.owner), markerGate = dataRecord(intent.sourceMarker.gate)
  return Boolean(automation && source && newest?.id === (intent.previousRecoveryTurnId ?? intent.previousTurnId) && current && recoveryChainMatches
    && ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(String(current.status))
    && timestampBefore(source.createdAt, current.createdAt)
    && source.source === "automation" && source.executionMode === "canonical_task_graph" && sourceInput?.automationRunMode === "scheduled"
    && parseScheduledAutomationSnapshot(sourceInput.scheduledAutomationSnapshot)
    && source.status === "interrupted" && source.rootTaskId === intent.previousRootTaskId
    && source.leaseVersion === intent.previousTurnLeaseVersion
    && root?.userId === intent.userId && root.sessionId === intent.sessionId && root.turnId === intent.previousTurnId
    && root.rootTaskId === root.id && root.parentTaskId === null && root.depth === 0 && root.role === "orchestrator" && root.taskType === "root"
    && ["running", "waiting", "waiting_for_user", "failed", "interrupted"].includes(String(root.status))
    && root.attemptCount === intent.previousRootAttemptCount
    && gate?.userId === intent.userId && gate.sessionId === intent.sessionId && gate.turnId === intent.previousTurnId && gate.rootTaskId === intent.previousRootTaskId
    && gate.parentTaskId === intent.previousRootTaskId && gate.depth === 1 && gate.role === "prepare" && gate.taskType === "scheduled_taskgraph_gate"
    && ["failed", "interrupted"].includes(String(gate.status)) && gate.attemptCount === intent.previousGateAttemptCount
    && execution?.id === intent.previousExecutionId && execution.userId === intent.userId && execution.sessionId === intent.sessionId
    && Number.isSafeInteger(execution.attemptCount) && Number(execution.attemptCount) === intent.reservedExecutionAttemptCount
    && markerOwner?.userId === intent.userId && markerOwner.sessionId === intent.sessionId && markerOwner.turnId === intent.previousTurnId
    && markerOwner.rootTaskId === intent.previousRootTaskId && markerOwner.rootAttemptCount === intent.previousRootAttemptCount
    && markerOwner.turnLeaseVersion === intent.previousTurnLeaseVersion && markerOwner.executionId === intent.previousExecutionId
    && markerOwner.executionAttemptCount === intent.previousExecutionAttemptCount
    && markerGate?.taskId === intent.previousGateTaskId && markerGate.attemptCount === intent.previousGateAttemptCount)
}
async function verifyRecoveryPredecessorChain(client: Queryable, intent: MaterialDriftRecoveryIntent, currentCreatedAt: unknown): Promise<boolean> {
  const visited = new Set([intent.turnId, intent.previousTurnId]), currentCreated = currentCreatedAt
  let predecessorId = intent.previousRecoveryTurnId, expectedAttempt = intent.reservedExecutionAttemptCount - 1, successorCreatedAt = currentCreated
  let depth = 1
  while (predecessorId !== null) {
    if (!validId(predecessorId) || visited.has(predecessorId) || depth >= MAX_RECOVERY_CHAIN_DEPTH) return false
    const predecessor = await one(client, `SELECT turn."id", turn."userId", turn."sessionId", turn."source", turn."executionMode", turn."status", turn."createdAt", turn."input"
      FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
      WHERE turn."id" = $1 AND turn."userId" = $2 AND turn."sessionId" = $3 AND session."status" NOT IN ('aborted', 'archived')`,
    [predecessorId, intent.userId, intent.sessionId])
    const read = readMaterialDriftRecoveryIntent(predecessor)
    if (!predecessor || !read || read.status !== "valid" || predecessor.source !== "automation"
      || predecessor.executionMode !== "canonical_task_graph" || !["interrupted", "failed", "cancelled"].includes(String(predecessor.status))
      || !timestampBefore(predecessor.createdAt, successorCreatedAt) || !sameRecoveryOrigin(intent, read.intent)
      || read.intent.reservedExecutionAttemptCount !== expectedAttempt) return false
    visited.add(predecessorId)
    depth++
    predecessorId = read.intent.previousRecoveryTurnId
    expectedAttempt--
    successorCreatedAt = predecessor.createdAt
  }
  return expectedAttempt === intent.previousExecutionAttemptCount
}
/** Revalidates a recovery Turn in the caller transaction before exposing its pinned snapshot to proof code. */
export async function verifiedMaterialDriftRecoverySnapshot(client: Queryable, turnValue: unknown) {
  const turn = dataRecord(turnValue), intent = readMaterialDriftRecoveryIntent(turn)
  if (!turn || intent.status !== "valid" || !await verifyMaterialDriftRecoveryLineage(client, turn, intent.intent)) return undefined
  return parseScheduledAutomationSnapshot(dataRecord(turn.input)?.scheduledAutomationSnapshot)
}
export async function verifiedMaterialDriftRecoveryCriteria(client: Queryable, scope: { turnId: string; userId: string; sessionId: string }, task: Row) {
  const snapshot = await verifiedMaterialDriftRecoverySnapshot(client, { id: scope.turnId, userId: scope.userId, sessionId: scope.sessionId,
    source: task.turnSource, executionMode: task.turnExecutionMode, input: task.turnInput })
  return snapshot ? { targetRoles: snapshot.targetRoles, targetLocations: snapshot.targetLocations, minScore: snapshot.minScore } : undefined
}
/** Selects the persisted Gate-prefix verifier only after a valid Gate or Audit suffix was appended. */
export function scheduledPrepareGateVerifierStage(nodes: readonly ScheduledPipelineGraphNode[]): "gate" | "audit" | null {
  const current = projectScheduledPipelineGraphAtCurrentStage(nodes)
  return current?.projection.stage === "gate" || current?.projection.stage === "audit" ? current.projection.stage : null
}
function parseIntent(value: Row): MaterialDriftRecoveryIntent | null {
  const marker = exactRecord(value.sourceMarker, MARKER_KEYS), owner = exactRecord(marker?.owner, OWNER_KEYS), gate = exactRecord(marker?.gate, GATE_KEYS)
  const ids = [value.turnId, value.userId, value.sessionId, value.automationId, value.previousTurnId, value.previousExecutionId,
    value.previousGateTaskId, value.previousRootTaskId]
  if (value.schemaVersion !== MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA || !ids.every(validId)
    || !(value.previousRecoveryTurnId === null || validId(value.previousRecoveryTurnId))
    || value.previousRecoveryTurnId === value.turnId || value.previousRecoveryTurnId === value.previousTurnId
    || !positive(value.previousGateAttemptCount) || !positive(value.previousRootAttemptCount) || !positive(value.previousTurnLeaseVersion)
    || !nonNegative(value.previousExecutionAttemptCount) || Number(value.previousExecutionAttemptCount) > MAX_EXECUTION_ATTEMPT
    || !positive(value.reservedExecutionAttemptCount) || Number(value.reservedExecutionAttemptCount) > MAX_EXECUTION_ATTEMPT
    || Number(value.reservedExecutionAttemptCount) <= Number(value.previousExecutionAttemptCount)
    || (value.previousRecoveryTurnId === null && Number(value.reservedExecutionAttemptCount) !== Number(value.previousExecutionAttemptCount) + 1)
    || !isDigest(value.currentSnapshotDigest) || !marker || !owner || !gate
    || marker.schemaVersion !== MARKER_SCHEMA || marker.reason !== MARKER_REASON || !MARKER_KEYS.slice(4).every(key => isDigest(marker[key]))
    || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    || !positive(owner.rootAttemptCount) || !positive(owner.turnLeaseVersion) || !nonNegative(owner.executionAttemptCount)
    || !validId(gate.taskId) || !validId(gate.leaseOwnerId) || !positive(gate.attemptCount)) return null
  if (owner.userId !== value.userId || owner.sessionId !== value.sessionId || owner.turnId !== value.previousTurnId
    || owner.rootTaskId !== value.previousRootTaskId || owner.rootAttemptCount !== value.previousRootAttemptCount
    || owner.turnLeaseVersion !== value.previousTurnLeaseVersion || owner.executionId !== value.previousExecutionId
    || owner.executionAttemptCount !== value.previousExecutionAttemptCount || gate.taskId !== value.previousGateTaskId
    || gate.attemptCount !== value.previousGateAttemptCount) return null
  return Object.freeze({ ...value, sourceMarker: marker }) as unknown as MaterialDriftRecoveryIntent
}
function dataRecord(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const result = Object.create(null) as Row
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return null
      result[key] = descriptor.value
    }
    return result
  } catch { return null }
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  const row = dataRecord(value)
  return row && Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) ? row : null
}
async function one<T extends Row>(client: Queryable, sql: string, values: unknown[]): Promise<T | undefined> {
  const result = await client.query<T>(sql, values)
  return result.rows.length === 1 ? result.rows[0] : undefined
}
function sameIntent(left: MaterialDriftRecoveryIntent, right: MaterialDriftRecoveryIntent): boolean {
  return INTENT_KEYS.filter(key => key !== "sourceMarker").every(key => left[key] === right[key])
    && JSON.stringify(MARKER_KEYS.map(key => left.sourceMarker[key])) === JSON.stringify(MARKER_KEYS.map(key => right.sourceMarker[key]))
}
function sameRecoveryOrigin(left: MaterialDriftRecoveryIntent, right: MaterialDriftRecoveryIntent): boolean {
  return ["userId", "sessionId", "automationId", "previousTurnId", "previousExecutionId", "previousGateTaskId", "previousGateAttemptCount",
    "previousRootTaskId", "previousRootAttemptCount", "previousTurnLeaseVersion", "previousExecutionAttemptCount"]
    .every(key => left[key as keyof MaterialDriftRecoveryIntent] === right[key as keyof MaterialDriftRecoveryIntent])
    && JSON.stringify(MARKER_KEYS.map(key => left.sourceMarker[key])) === JSON.stringify(MARKER_KEYS.map(key => right.sourceMarker[key]))
}
export function scheduledAutomationSnapshotDigest(value: unknown): string | undefined {
  const snapshot = parseScheduledAutomationSnapshot(value)
  if (!snapshot) return undefined
  return `sha256:${createHash("sha256").update(JSON.stringify([snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations,
    snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]), "utf8").digest("hex")}`
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function isDigest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function timestampBefore(left: unknown, right: unknown): boolean {
  const a = left instanceof Date ? left.getTime() : typeof left === "string" ? Date.parse(left) : Number.NaN
  const b = right instanceof Date ? right.getTime() : typeof right === "string" ? Date.parse(right) : Number.NaN
  return Number.isFinite(a) && Number.isFinite(b) && a < b
}
