import type { Prisma } from "@prisma/client"
import {
  validateActiveMaterialDriftRecoveryChain,
  parseMaterialDriftRecoveryIntent,
  validateMaterialDriftSourceMarker,
  type RecoveryLineageTurn,
} from "./material-drift-recovery-lineage"
import { parseScheduledAutomationSnapshot, type ScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"

const MAX_RECOVERY_TURNS = 64
const CURRENT_ROOT_STATUSES = new Set(["running", "waiting"])
const GATE_WAITING_TURN_STATUSES = new Set(["waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "waiting_for_tool"])

export type ScheduledTaskGraphRecoveryAdmissionCaller = "analyze_prepare" | "gate"

type AdmissionClient = Pick<Prisma.TransactionClient, "$queryRaw">
type SessionRow = { id: string; userId: string; source: string; status: string }
type TurnRow = RecoveryLineageTurn & { leaseOwnerId: string | null; leaseExpiresAt: Date | string | null }
type TaskRow = { id: string; userId: string; sessionId: string; turnId: string | null; rootTaskId: string | null;
  parentTaskId: string | null; depth: number; role: string; taskType: string; status: string; attemptCount: number;
  interruptRequestedAt: Date | null; closedAt: Date | null }
type AutomationRow = { id: string; userId: string; sessionId: string | null }
type ExecutionRow = { id: string; userId: string; sessionId: string; attemptCount: number }
type RecoveryHistory = { predecessors: RecoveryLineageTurn[]; sourceTurn: RecoveryLineageTurn }

/**
 * Admits only a persisted, current material-drift recovery Turn from the worker-secret private API.
 * Call inside the caller's transaction after its normal Session → Turn → Root/child → execution locks.
 * This resolver takes no row locks and deliberately leaves stage-specific Gate lease/wait checks to callers.
 */
export type ScheduledTaskGraphRecoveryAdmission = Readonly<{
  snapshot: ScheduledAutomationSnapshot
  automationId: string
  owner: ScheduledTaskGraphPipelineOwner
}>

export async function resolveScheduledTaskGraphRecoveryAdmission(input: {
  client: AdmissionClient
  request: Request
  owner: ScheduledTaskGraphPipelineOwner
  caller: ScheduledTaskGraphRecoveryAdmissionCaller
}): Promise<ScheduledTaskGraphRecoveryAdmission | null> {
  const { client, request, owner, caller } = input
  if (!hasWorkerSecret(request) || !validOwner(owner) || !validCaller(caller)) return null

  try {
    const sessions = await client.$queryRaw<SessionRow[]>`
      SELECT "id", "userId", "source", "status" FROM "agent_sessions"
      WHERE "id" = ${owner.sessionId} AND "userId" = ${owner.userId}
    `
    const session = sessions[0]
    if (!session || session.source !== "automation" || ["aborted", "archived"].includes(session.status)) return null

    const turns = await client.$queryRaw<TurnRow[]>`
      SELECT turn."id", turn."userId", turn."sessionId", turn."status", turn."source", turn."executionMode", turn."input",
        turn."rootTaskId", turn."leaseVersion", turn."leaseOwnerId", turn."leaseExpiresAt", turn."createdAt"
      FROM "agent_turns" AS turn WHERE turn."id" = ${owner.turnId} AND turn."userId" = ${owner.userId}
        AND turn."sessionId" = ${owner.sessionId}
    `
    const turn = turns[0]
    if (!turn || turn.source !== "automation" || turn.executionMode !== "canonical_task_graph"
      || !turnLeaseIsAdmissible(turn, owner, caller) || turn.rootTaskId !== owner.rootTaskId) return null

    const rootRows = await client.$queryRaw<TaskRow[]>`
      SELECT task."id", session."userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        task."depth", task."role", task."taskType", task."status", task."attemptCount", task."interruptRequestedAt", task."closedAt"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = ${owner.rootTaskId} AND task."sessionId" = ${owner.sessionId}
        AND task."turnId" = ${owner.turnId} AND session."userId" = ${owner.userId}
    `
    const root = rootRows[0]
    if (!root || root.id !== owner.rootTaskId || root.turnId !== turn.id || root.sessionId !== turn.sessionId
      || root.rootTaskId !== root.id || root.parentTaskId !== null || root.depth !== 0 || root.role !== "orchestrator"
      || root.taskType !== "root" || !CURRENT_ROOT_STATUSES.has(root.status) || root.attemptCount !== owner.rootAttemptCount
      || root.interruptRequestedAt || root.closedAt) return null

    const turnInput = record(turn.input), rawIntent = record(turnInput?.materialDriftRecovery)
    const automationId = rawIntent?.automationId
    if (turnInput?.automationRunMode !== "manual" || !validId(automationId)) return null
    const scope = { userId: owner.userId, sessionId: owner.sessionId, automationId }
    const intent = parseMaterialDriftRecoveryIntent(rawIntent, turn, scope)
    if (!intent || intent.turnId !== owner.turnId || intent.reservedExecutionAttemptCount !== owner.executionAttemptCount) return null

    const automationRows = await client.$queryRaw<AutomationRow[]>`
      SELECT "id", "userId", "sessionId" FROM "agent_automations"
      WHERE "id" = ${automationId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
    `
    const automation = automationRows[0]
    if (!automation || automation.id !== intent.automationId || automation.userId !== owner.userId || automation.sessionId !== owner.sessionId) return null
    const snapshot = parseScheduledAutomationSnapshot(turnInput?.scheduledAutomationSnapshot)
    if (intent.currentSnapshotDigest !== scheduledAutomationSnapshotDigest(snapshot)) return null

    const history = await loadRecoveryHistory(client, intent, scope)
    const chain = history && validateActiveMaterialDriftRecoveryChain(turn, history.predecessors, history.sourceTurn, scope)
    if (!chain) return null

    const [sourceRoots, sourceGates] = await Promise.all([
      client.$queryRaw<TaskRow[]>`
        SELECT task."id", session."userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
          task."depth", task."role", task."taskType", task."status", task."attemptCount", task."interruptRequestedAt", task."closedAt"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = ${chain.sourceTurn.rootTaskId} AND task."sessionId" = ${owner.sessionId}
          AND task."turnId" = ${chain.sourceTurn.id} AND session."userId" = ${owner.userId}
      `,
      client.$queryRaw<TaskRow[]>`
        SELECT task."id", session."userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
          task."depth", task."role", task."taskType", task."status", task."attemptCount", task."interruptRequestedAt", task."closedAt"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."id" = ${chain.latestIntent.previousGateTaskId} AND task."sessionId" = ${owner.sessionId}
          AND task."turnId" = ${chain.sourceTurn.id} AND task."rootTaskId" = ${chain.latestIntent.previousRootTaskId}
          AND session."userId" = ${owner.userId}
      `,
    ])

    const executions = await client.$queryRaw<ExecutionRow[]>`
      SELECT "id", "userId", "sessionId", "attemptCount" FROM "agent_executions"
      WHERE "id" = ${owner.executionId} AND "userId" = ${owner.userId} AND "sessionId" = ${owner.sessionId}
    `
    const execution = executions[0]
    const sourceRoot = sourceRoots[0], sourceGate = sourceGates[0]
    if (!sourceRoot || !sourceGate || !execution || execution.id !== owner.executionId || execution.attemptCount !== owner.executionAttemptCount
      || execution.attemptCount !== chain.latestIntent.reservedExecutionAttemptCount
      || !validateMaterialDriftSourceMarker({ sourceTurn: chain.sourceTurn, root: sourceRoot, gate: sourceGate, execution, intent: chain.latestIntent })) return null

    return Object.freeze({ snapshot, automationId: automation.id, owner: Object.freeze({ ...owner }) })
  } catch {
    return null
  }
}

async function loadRecoveryHistory(client: AdmissionClient, currentIntent: NonNullable<ReturnType<typeof parseMaterialDriftRecoveryIntent>>,
  scope: { userId: string; sessionId: string; automationId: string }): Promise<RecoveryHistory | null> {
  const predecessors: RecoveryLineageTurn[] = []
  let nextId = currentIntent.previousRecoveryTurnId, lastIntent = currentIntent
  while (nextId !== null) {
    if (predecessors.length >= MAX_RECOVERY_TURNS - 1) return null
    const rows = await client.$queryRaw<RecoveryLineageTurn[]>`
      SELECT turn."id", turn."userId", turn."sessionId", turn."status", turn."source", turn."executionMode", turn."input",
        turn."rootTaskId", turn."leaseVersion", turn."createdAt"
      FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
      WHERE turn."id" = ${nextId} AND turn."userId" = ${scope.userId} AND turn."sessionId" = ${scope.sessionId}
        AND session."userId" = ${scope.userId} AND session."status" NOT IN ('aborted', 'archived')
    `
    const predecessor = rows[0]
    if (!predecessor) return null
    const predecessorIntent = parseMaterialDriftRecoveryIntent(record(record(predecessor.input)?.materialDriftRecovery), predecessor, scope)
    if (!predecessorIntent) return null
    predecessors.push(predecessor)
    lastIntent = predecessorIntent
    nextId = predecessorIntent.previousRecoveryTurnId
  }
  const sources = await client.$queryRaw<RecoveryLineageTurn[]>`
    SELECT turn."id", turn."userId", turn."sessionId", turn."status", turn."source", turn."executionMode", turn."input",
      turn."rootTaskId", turn."leaseVersion", turn."createdAt"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = ${lastIntent.previousTurnId} AND turn."userId" = ${scope.userId} AND turn."sessionId" = ${scope.sessionId}
      AND session."userId" = ${scope.userId} AND session."status" NOT IN ('aborted', 'archived')
  `
  return sources[0] ? { predecessors, sourceTurn: sources[0] } : null
}

function hasWorkerSecret(request: Request): boolean {
  const expected = process.env.AGENT_WORKER_SECRET
  return Boolean(expected && request.headers.get("x-agent-worker-secret") === expected)
}
function validCaller(value: unknown): value is ScheduledTaskGraphRecoveryAdmissionCaller {
  return value === "analyze_prepare" || value === "gate"
}
function turnLeaseIsAdmissible(turn: TurnRow, owner: ScheduledTaskGraphPipelineOwner,
  caller: ScheduledTaskGraphRecoveryAdmissionCaller): boolean {
  if (caller === "analyze_prepare") return turn.status === "in_progress" && turn.leaseOwnerId === owner.turnLeaseOwnerId
    && turn.leaseVersion === owner.turnLeaseVersion && leaseIsUnexpired(turn.leaseExpiresAt)
  if (turn.status === "in_progress") {
    return turn.leaseOwnerId === owner.turnLeaseOwnerId && turn.leaseVersion === owner.turnLeaseVersion
      && validId(turn.leaseOwnerId) && positive(turn.leaseVersion) && leaseIsUnexpired(turn.leaseExpiresAt)
  }
  return GATE_WAITING_TURN_STATUSES.has(turn.status) && turn.leaseOwnerId === null && turn.leaseExpiresAt === null
}
function leaseIsUnexpired(value: Date | string | null): boolean {
  const expiresAt = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}
function validOwner(owner: ScheduledTaskGraphPipelineOwner): boolean {
  return Boolean(owner && [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId]
    .every(validId) && positive(owner.rootAttemptCount) && positive(owner.turnLeaseVersion) && nonNegative(owner.executionAttemptCount))
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
