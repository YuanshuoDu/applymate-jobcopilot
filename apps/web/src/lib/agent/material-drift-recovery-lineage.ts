import { isScheduledTaskGraphGateMaterialDriftMarker } from "./scheduled-taskgraph-gate-material-drift-marker"
import { scheduledAutomationSnapshotDigest } from "./scheduled-taskgraph-pipeline-checkpoint"

const SCHEMA = "agent-harness.v2.material-drift-recovery.v2"
const INTENT_KEYS = ["schemaVersion", "turnId", "userId", "sessionId", "automationId", "previousTurnId",
  "previousExecutionId", "previousGateTaskId", "previousGateAttemptCount", "previousRootTaskId", "previousRootAttemptCount",
  "previousTurnLeaseVersion", "previousExecutionAttemptCount", "previousRecoveryTurnId", "reservedExecutionAttemptCount",
  "currentSnapshotDigest", "sourceMarker"] as const
const LINEAGE_KEYS = ["userId", "sessionId", "automationId", "previousTurnId", "previousExecutionId", "previousGateTaskId",
  "previousGateAttemptCount", "previousRootTaskId", "previousRootAttemptCount", "previousTurnLeaseVersion",
  "previousExecutionAttemptCount", "sourceMarker"] as const
const RECOVERY_TERMINAL = new Set(["interrupted", "failed", "cancelled"])
const ACTIVE_RECOVERY = new Set(["in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "waiting_for_tool"])
const SOURCE_ROOT_TERMINAL = new Set(["running", "waiting", "waiting_for_user", "failed", "interrupted"])
const SOURCE_GATE_TERMINAL = new Set(["failed", "interrupted"])
const MAX_ATTEMPT = 2_147_483_647
const MAX_CHAIN_DEPTH = 64

export type RecoveryLineageTurn = Readonly<{
  id: string; userId: string; sessionId: string; status: string; source: string; executionMode: string | null
  input: unknown; rootTaskId: string | null; leaseVersion: number; createdAt: Date
}>

export type MaterialDriftRecoveryIntent = Readonly<{
  schemaVersion: typeof SCHEMA; turnId: string; userId: string; sessionId: string; automationId: string
  previousTurnId: string; previousExecutionId: string; previousGateTaskId: string; previousGateAttemptCount: number
  previousRootTaskId: string; previousRootAttemptCount: number; previousTurnLeaseVersion: number
  previousExecutionAttemptCount: number; previousRecoveryTurnId: string | null; reservedExecutionAttemptCount: number
  currentSnapshotDigest: string; sourceMarker: Record<string, unknown>
}>

export type ValidatedRecoveryChain = Readonly<{
  sourceTurn: RecoveryLineageTurn; initialIntent: MaterialDriftRecoveryIntent; latestIntent: MaterialDriftRecoveryIntent
}>

export function validateMaterialDriftSourceMarker(input: Readonly<{
  sourceTurn: RecoveryLineageTurn
  root: { id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null;
    depth: number; role: string; taskType: string; status: string; attemptCount: number }
  gate: { id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null;
    depth: number; role: string; taskType: string; status: string; attemptCount: number }
  execution: { id: string; userId: string; sessionId: string; attemptCount: number }
  intent: MaterialDriftRecoveryIntent
}>): boolean {
  const { sourceTurn, root, gate, execution, intent } = input
  const marker = record(intent.sourceMarker), owner = record(marker?.owner), gateOwner = record(marker?.gate)
  if (!marker || !owner || !gateOwner || sourceTurn.id !== intent.previousTurnId
    || sourceTurn.userId !== intent.userId || sourceTurn.sessionId !== intent.sessionId
    || sourceTurn.rootTaskId !== intent.previousRootTaskId || sourceTurn.leaseVersion !== intent.previousTurnLeaseVersion
    || root.id !== intent.previousRootTaskId || root.sessionId !== intent.sessionId || root.turnId !== sourceTurn.id
    || root.rootTaskId !== root.id || root.parentTaskId !== null || root.depth !== 0 || root.role !== "orchestrator"
    || root.taskType !== "root" || !SOURCE_ROOT_TERMINAL.has(root.status) || root.attemptCount !== intent.previousRootAttemptCount
    || gate.id !== intent.previousGateTaskId || gate.sessionId !== intent.sessionId || gate.turnId !== sourceTurn.id
    || gate.rootTaskId !== root.id || gate.parentTaskId !== root.id || gate.depth !== 1 || gate.role !== "prepare"
    || gate.taskType !== "scheduled_taskgraph_gate" || !SOURCE_GATE_TERMINAL.has(gate.status)
    || gate.attemptCount !== intent.previousGateAttemptCount || execution.id !== intent.previousExecutionId
    || execution.userId !== intent.userId || execution.sessionId !== intent.sessionId
    || execution.attemptCount !== intent.reservedExecutionAttemptCount || owner.executionAttemptCount !== intent.previousExecutionAttemptCount) return false
  return isScheduledTaskGraphGateMaterialDriftMarker({
    owner: { userId: sourceTurn.userId, sessionId: sourceTurn.sessionId, turnId: sourceTurn.id, rootTaskId: root.id,
      rootAttemptCount: root.attemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId as string,
      turnLeaseVersion: sourceTurn.leaseVersion, executionId: execution.id, executionAttemptCount: intent.previousExecutionAttemptCount },
    gate: { taskId: gate.id, leaseOwnerId: gateOwner.leaseOwnerId as string, attemptCount: gate.attemptCount },
    state: { scheduledTaskGraphMaterialDriftTerminal: marker },
  })
}

export function parseMaterialDriftRecoveryIntent(
  value: unknown, turn: RecoveryLineageTurn, scope: { userId: string; sessionId: string; automationId: string },
): MaterialDriftRecoveryIntent | null {
  const input = record(turn.input), intent = record(value)
  let snapshotDigest: string
  try { snapshotDigest = scheduledAutomationSnapshotDigest(input?.scheduledAutomationSnapshot) }
  catch { return null }
  if (!input || !intent || !exactKeys(intent, INTENT_KEYS) || input.automationRunMode !== "manual"
    || turn.userId !== scope.userId || turn.sessionId !== scope.sessionId
    || turn.source !== "automation" || turn.executionMode !== "canonical_task_graph"
    || intent.schemaVersion !== SCHEMA || intent.turnId !== turn.id || intent.userId !== scope.userId
    || intent.sessionId !== scope.sessionId || intent.automationId !== scope.automationId
    || ![intent.turnId, intent.userId, intent.sessionId, intent.automationId, intent.previousTurnId,
      intent.previousExecutionId, intent.previousGateTaskId, intent.previousRootTaskId].every(validId)
    || !positive(intent.previousGateAttemptCount) || !positive(intent.previousRootAttemptCount)
    || !positive(intent.previousTurnLeaseVersion) || !nonNegative(intent.previousExecutionAttemptCount)
    || !(intent.previousRecoveryTurnId === null || validId(intent.previousRecoveryTurnId))
    || !positive(intent.reservedExecutionAttemptCount) || intent.reservedExecutionAttemptCount > MAX_ATTEMPT
    || intent.reservedExecutionAttemptCount <= intent.previousExecutionAttemptCount
    || !isDigest(intent.currentSnapshotDigest) || intent.currentSnapshotDigest !== snapshotDigest || !record(intent.sourceMarker)) return null
  return intent as unknown as MaterialDriftRecoveryIntent
}

/** Validates every stored recovery predecessor back to its original scheduled source Turn. */
export function validateMaterialDriftRecoveryChain(
  turns: readonly RecoveryLineageTurn[], scope: { userId: string; sessionId: string; automationId: string },
): ValidatedRecoveryChain | null {
  if (turns.length < 2 || turns.length > MAX_CHAIN_DEPTH + 1) return null
  const latestTurn = turns[0]
  const latestIntent = parseMaterialDriftRecoveryIntent(record(latestTurn.input)?.materialDriftRecovery, latestTurn, scope)
  if (!latestIntent || !RECOVERY_TERMINAL.has(latestTurn.status)) return null
  const seen = new Set([latestTurn.id])
  let childTurn = latestTurn, childIntent = latestIntent, index = 1, depth = 1

  while (childIntent.previousRecoveryTurnId !== null) {
    if (depth >= MAX_CHAIN_DEPTH || index >= turns.length) return null
    const predecessor = turns[index]
    if (predecessor.id !== childIntent.previousRecoveryTurnId || seen.has(predecessor.id)
      || !RECOVERY_TERMINAL.has(predecessor.status) || !strictlyEarlier(predecessor.createdAt, childTurn.createdAt)) return null
    const predecessorIntent = parseMaterialDriftRecoveryIntent(record(predecessor.input)?.materialDriftRecovery, predecessor, scope)
    if (!predecessorIntent || !sameLineage(predecessorIntent, latestIntent)
      || predecessorIntent.reservedExecutionAttemptCount !== childIntent.reservedExecutionAttemptCount - 1) return null
    seen.add(predecessor.id)
    childTurn = predecessor
    childIntent = predecessorIntent
    index += 1
    depth += 1
  }

  if (childIntent.reservedExecutionAttemptCount !== childIntent.previousExecutionAttemptCount + 1
    || index !== turns.length - 1) return null
  const sourceTurn = turns[index]
  if (sourceTurn.id !== childIntent.previousTurnId || seen.has(sourceTurn.id)
    || sourceTurn.userId !== scope.userId || sourceTurn.sessionId !== scope.sessionId
    || sourceTurn.source !== "automation" || sourceTurn.executionMode !== "canonical_task_graph"
    || record(sourceTurn.input)?.automationRunMode !== "scheduled" || sourceTurn.status !== "interrupted"
    || sourceTurn.rootTaskId !== childIntent.previousRootTaskId
    || sourceTurn.leaseVersion !== childIntent.previousTurnLeaseVersion
    || !strictlyEarlier(sourceTurn.createdAt, childTurn.createdAt)) return null
  return { sourceTurn, initialIntent: childIntent, latestIntent }
}

/** Validates one active current recovery Turn over only terminal predecessors; Run Now keeps the terminal-only validator above. */
export function validateActiveMaterialDriftRecoveryChain(
  currentTurn: RecoveryLineageTurn, terminalPredecessors: readonly RecoveryLineageTurn[], sourceTurn: RecoveryLineageTurn,
  scope: { userId: string; sessionId: string; automationId: string },
): ValidatedRecoveryChain | null {
  if (!ACTIVE_RECOVERY.has(currentTurn.status)) return null
  const currentIntent = parseMaterialDriftRecoveryIntent(record(currentTurn.input)?.materialDriftRecovery, currentTurn, scope)
  if (!currentIntent) return null
  if (currentIntent.previousRecoveryTurnId === null) {
    if (terminalPredecessors.length !== 0 || currentIntent.reservedExecutionAttemptCount !== currentIntent.previousExecutionAttemptCount + 1
      || sourceTurn.id !== currentIntent.previousTurnId || sourceTurn.userId !== scope.userId || sourceTurn.sessionId !== scope.sessionId
      || sourceTurn.source !== "automation" || sourceTurn.executionMode !== "canonical_task_graph"
      || record(sourceTurn.input)?.automationRunMode !== "scheduled" || sourceTurn.status !== "interrupted"
      || sourceTurn.rootTaskId !== currentIntent.previousRootTaskId || sourceTurn.leaseVersion !== currentIntent.previousTurnLeaseVersion
      || !strictlyEarlier(sourceTurn.createdAt, currentTurn.createdAt)) return null
    return { sourceTurn, initialIntent: currentIntent, latestIntent: currentIntent }
  }
  const previous = terminalPredecessors[0]
  const chain = validateMaterialDriftRecoveryChain([...terminalPredecessors, sourceTurn], scope)
  if (!previous || previous.id !== currentIntent.previousRecoveryTurnId || !chain
    || !sameLineage(currentIntent, chain.latestIntent)
    || currentIntent.reservedExecutionAttemptCount !== chain.latestIntent.reservedExecutionAttemptCount + 1
    || !strictlyEarlier(previous.createdAt, currentTurn.createdAt)) return null
  return { sourceTurn, initialIntent: chain.initialIntent, latestIntent: currentIntent }
}

function sameLineage(a: MaterialDriftRecoveryIntent, b: MaterialDriftRecoveryIntent): boolean {
  return LINEAGE_KEYS.every(key => stableJson(a[key]) === stableJson(b[key]))
}
function strictlyEarlier(a: Date, b: Date): boolean {
  return a instanceof Date && b instanceof Date && Number.isFinite(a.getTime()) && Number.isFinite(b.getTime()) && a.getTime() < b.getTime()
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value)
  return own.length === keys.length && own.every(key => typeof key === "string" && keys.includes(key))
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function stableJson(value: unknown): string | null {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : null
  if (Array.isArray(value)) {
    const items = value.map(stableJson)
    return items.some(item => item === null) ? null : `[${items.join(",")}]`
  }
  const row = record(value)
  if (!row) return null
  const entries = Object.keys(row).sort().map(key => {
    const item = stableJson(row[key])
    return item === null ? null : `${JSON.stringify(key)}:${item}`
  })
  return entries.some(item => item === null) ? null : `{${entries.join(",")}}`
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }
