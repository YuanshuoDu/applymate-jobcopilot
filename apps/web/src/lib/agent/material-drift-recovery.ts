import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import type { AutomationSessionRow } from "./automation-session"
import { buildScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { scheduledAutomationSnapshotDigest } from "./scheduled-taskgraph-pipeline-checkpoint"
import { scheduledMaterialDriftGateTaskId, scheduledMaterialDriftRecoveryReason } from "./scheduled-taskgraph-gate-material-drift-projection"
import { parseMaterialDriftRecoveryIntent, validateMaterialDriftRecoveryChain, validateMaterialDriftSourceMarker,
  type MaterialDriftRecoveryIntent, type RecoveryLineageTurn } from "./material-drift-recovery-lineage"
import { nextRunAfterCurrent } from "./automation-schedule"

const MATERIAL_DRIFT_RECOVERY_SCHEMA = "agent-harness.v2.material-drift-recovery.v2"
const MATERIAL_DRIFT_ERROR = "scheduled_prepare_material_source_changed"
const MAX_EXECUTION_ATTEMPT = 2_147_483_647
const ACTIVE_RECOVERY_TURN_STATUSES = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])
const RECOVERY_TERMINAL_TURN_STATUSES = new Set(["interrupted", "failed", "cancelled"])
const RECOVERY_TERMINAL_EXECUTION_STATUSES = new Set(["paused", "failed", "cancelled"])
type MaterialDriftRecoveryAutomation = { id: string; name: string; enabled: boolean; cron: string | null; timezone: string; triggerType: string;
  targetRoles: string[]; targetLocations: string[]; minScore: number; dailyCap: number; requireApproval: boolean; autoApply: boolean; sessionId: string | null }
type RecoveryDispatch = { automation: MaterialDriftRecoveryAutomation; session: AutomationSessionRow; turnId: string;
  executionId: string; dispatchId: string; turnStatus: string }
type RecoveryRun = RecoveryDispatch & { kind: "created"; snapshot: ReturnType<typeof buildScheduledAutomationSnapshot> }
type ExistingRecovery = RecoveryDispatch & { kind: "already_started" }
type TaskRow = { id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null;
  depth: number; role: string; taskType: string; status: string; attemptCount: number }
type ExecutionRow = { id: string; userId: string; sessionId: string; status: string; error: string | null; attemptCount: number; state: unknown }

export type MaterialDriftRecoveryStart = RecoveryRun | ExistingRecovery | { kind: "rejected" } | null

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function hasMaterialDriftIndication(stateValue: unknown, error: string | null | undefined): boolean {
  const state = record(stateValue)
  return error === MATERIAL_DRIFT_ERROR
    || Boolean(state && Object.prototype.hasOwnProperty.call(state, "scheduledTaskGraphMaterialDriftTerminal"))
}

async function lockTurn(tx: Prisma.TransactionClient, id: string, userId: string, sessionId: string): Promise<RecoveryLineageTurn | null> {
  const rows = await tx.$queryRaw<RecoveryLineageTurn[]>(Prisma.sql`
    SELECT "id", "userId", "sessionId", "status", "source", "executionMode", "input", "rootTaskId", "leaseVersion", "createdAt"
    FROM "agent_turns" WHERE "id" = ${id} AND "userId" = ${userId} AND "sessionId" = ${sessionId} FOR UPDATE
  `)
  return rows[0] ?? null
}

/** Atomically consumes a verified stopped material-drift lineage into a fresh manual Turn. */
export async function startMaterialDriftRecovery(
  db: PrismaClient,
  input: { automationId: string; userId: string; sessionId: string | null; now?: Date },
): Promise<MaterialDriftRecoveryStart> {
  return db.$transaction(async tx => {
    const automationRows = await tx.$queryRaw<MaterialDriftRecoveryAutomation[]>(Prisma.sql`
      SELECT "id", "name", "enabled", "cron", "timezone", "triggerType", "targetRoles", "targetLocations",
        "minScore", "dailyCap", "requireApproval", "autoApply", "sessionId"
      FROM "agent_automations" WHERE "id" = ${input.automationId} AND "userId" = ${input.userId} AND "enabled" = TRUE FOR UPDATE
    `)
    const automation = automationRows[0]
    if (!automation || automation.sessionId !== input.sessionId || automation.sessionId === null) return null
    const runAt = input.now ?? new Date()
    const snapshot = buildScheduledAutomationSnapshot(automation)
    const sessions = await tx.$queryRaw<Array<{ id: string; source: string; status: string }>>(Prisma.sql`
      SELECT "id", "source", "status" FROM "agent_sessions" WHERE "id" = ${automation.sessionId} AND "userId" = ${input.userId} FOR UPDATE
    `)
    if (!sessions[0]) return { kind: "rejected" }
    const turns = await tx.$queryRaw<RecoveryLineageTurn[]>(Prisma.sql`
      SELECT "id", "userId", "sessionId", "status", "source", "executionMode", "input", "rootTaskId", "leaseVersion", "createdAt"
      FROM "agent_turns" WHERE "sessionId" = ${automation.sessionId} AND "userId" = ${input.userId}
      ORDER BY "createdAt" DESC, "id" DESC LIMIT 1 FOR UPDATE
    `)
    const turn = turns[0]
    const turnInput = record(turn?.input)
    if (sessions[0].status === "aborted" || sessions[0].status === "archived") {
      const executions = await tx.$queryRaw<Array<{ state: unknown; error: string | null }>>(Prisma.sql`
        SELECT "state", "error" FROM "agent_executions" WHERE "userId" = ${input.userId} AND "sessionId" = ${automation.sessionId} FOR UPDATE
      `)
      if (Object.prototype.hasOwnProperty.call(turnInput ?? {}, "materialDriftRecovery")
        || executions.some(execution => hasMaterialDriftIndication(execution.state, execution.error))) return { kind: "rejected" }
      return null
    }
    if (sessions[0].source !== "automation" || !turn) {
      const executions = await tx.$queryRaw<Array<{ state: unknown; error: string | null }>>(Prisma.sql`
        SELECT "state", "error" FROM "agent_executions" WHERE "userId" = ${input.userId} AND "sessionId" = ${automation.sessionId} FOR UPDATE
      `)
      if (Object.prototype.hasOwnProperty.call(turnInput ?? {}, "materialDriftRecovery")
        || executions.some(execution => hasMaterialDriftIndication(execution.state, execution.error))) return { kind: "rejected" }
      return null
    }
    const scope = { userId: input.userId, sessionId: automation.sessionId, automationId: automation.id }
    const hasRecoveryIntent = Boolean(turnInput && Object.prototype.hasOwnProperty.call(turnInput, "materialDriftRecovery"))
    let sourceTurn: RecoveryLineageTurn = turn
    let sourceMarker: Record<string, unknown> | null = null
    let sourceChain: ReturnType<typeof validateMaterialDriftRecoveryChain> = null
    let executionHint: { id: string; state: unknown; error: string | null } | null = null
    if (hasRecoveryIntent) {
      const intent = parseMaterialDriftRecoveryIntent(turnInput?.materialDriftRecovery, turn, scope)
      if (!intent) return { kind: "rejected" }
      if (ACTIVE_RECOVERY_TURN_STATUSES.has(turn.status)) {
        const executionId = intent.previousExecutionId
        if (typeof executionId !== "string" || !executionId.trim() || executionId.length > 256) return { kind: "rejected" }
        const execution = await tx.agentExecution.findFirst({
          where: { id: executionId, userId: input.userId, sessionId: automation.sessionId }, select: { id: true, attemptCount: true },
        })
        const dispatch = await tx.agentOutbox.findUnique({ where: { idempotencyKey: `turn-dispatch:${turn.id}` },
          select: { id: true, topic: true, aggregateId: true, idempotencyKey: true, payload: true } })
        const session = await tx.agentSession.findFirst({ where: { id: automation.sessionId, userId: input.userId } })
        const payload = record(dispatch?.payload)
        if (!execution || execution.attemptCount !== intent.reservedExecutionAttemptCount || !dispatch || dispatch.topic !== "agent.turn.dispatch" || dispatch.aggregateId !== automation.sessionId
          || dispatch.idempotencyKey !== `turn-dispatch:${turn.id}` || payload?.turnId !== turn.id
          || payload.sessionId !== automation.sessionId || payload.ownerId !== `web:${turn.id}` || !session) return { kind: "rejected" }
        return { kind: "already_started", automation, session, turnId: turn.id, executionId: execution.id,
          dispatchId: dispatch.id, turnStatus: turn.status }
      }
      if (turn.status === "completed") {
        const execution = await tx.agentExecution.findFirst({ where: { id: intent.previousExecutionId, userId: input.userId,
          sessionId: automation.sessionId }, select: { id: true, status: true, attemptCount: true, state: true, error: true } })
        if (!execution || execution.attemptCount !== intent.reservedExecutionAttemptCount || execution.status !== "completed"
          || hasMaterialDriftIndication(execution.state, execution.error)) return { kind: "rejected" }
        return null
      }
      if (!RECOVERY_TERMINAL_TURN_STATUSES.has(turn.status)) return { kind: "rejected" }
      const chainTurns: RecoveryLineageTurn[] = [turn]
      const seen = new Set([turn.id])
      let previousIntent = intent
      while (previousIntent.previousRecoveryTurnId !== null) {
        if (chainTurns.length >= 64 || seen.has(previousIntent.previousRecoveryTurnId)) return { kind: "rejected" }
        const predecessor = await lockTurn(tx, previousIntent.previousRecoveryTurnId, input.userId, automation.sessionId)
        if (!predecessor) return { kind: "rejected" }
        chainTurns.push(predecessor)
        seen.add(predecessor.id)
        const predecessorInput = record(predecessor.input)
        const parsed = parseMaterialDriftRecoveryIntent(predecessorInput?.materialDriftRecovery, predecessor, scope)
        if (!parsed) return { kind: "rejected" }
        previousIntent = parsed
      }
      const source = await lockTurn(tx, previousIntent.previousTurnId, input.userId, automation.sessionId)
      if (!source) return { kind: "rejected" }
      chainTurns.push(source)
      sourceChain = validateMaterialDriftRecoveryChain(chainTurns, scope)
      if (!sourceChain) return { kind: "rejected" }
      sourceTurn = sourceChain.sourceTurn
      sourceMarker = sourceChain.initialIntent.sourceMarker
    } else {
      executionHint = await tx.agentExecution.findFirst({ where: { userId: input.userId, sessionId: automation.sessionId },
        select: { id: true, state: true, error: true } })
      if (!hasMaterialDriftIndication(executionHint?.state, executionHint?.error)) return null
      if (turn.status !== "interrupted" || turn.source !== "automation" || turn.executionMode !== "canonical_task_graph"
        || turnInput?.automationRunMode !== "scheduled" || !turn.rootTaskId) return { kind: "rejected" }
      sourceMarker = record(record(executionHint?.state)?.scheduledTaskGraphMaterialDriftTerminal)
    }
    const activeTurns = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "agent_turns" WHERE "sessionId" = ${automation.sessionId} AND "userId" = ${input.userId}
        AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
      FOR UPDATE
    `)
    if (activeTurns.length > 0) return { kind: "rejected" }
    const roots = await tx.$queryRaw<TaskRow[]>(Prisma.sql`
      SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "depth", "role", "taskType", "status", "attemptCount"
      FROM "sub_agent_tasks" WHERE "id" = ${sourceTurn.rootTaskId} AND "sessionId" = ${automation.sessionId}
        AND "turnId" = ${sourceTurn.id} FOR UPDATE
    `)
    const root = roots[0]
    if (!root) return { kind: "rejected" }
    const gateTaskId = sourceMarker && scheduledMaterialDriftGateTaskId({ scheduledTaskGraphMaterialDriftTerminal: sourceMarker })
    if (!sourceMarker || !gateTaskId) return { kind: "rejected" }
    const gates = await tx.$queryRaw<TaskRow[]>(Prisma.sql`
      SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "depth", "role", "taskType", "status", "attemptCount"
      FROM "sub_agent_tasks" WHERE "id" = ${gateTaskId} AND "sessionId" = ${automation.sessionId}
        AND "turnId" = ${sourceTurn.id} AND "rootTaskId" = ${root.id} AND "parentTaskId" = ${root.id}
        AND "depth" = 1 AND "role" = 'prepare' AND "taskType" = 'scheduled_taskgraph_gate'
        AND "status" IN ('failed', 'interrupted') FOR UPDATE
    `)
    const gate = gates[0]
    if (!gate) return { kind: "rejected" }
    const executionId = sourceChain?.latestIntent.previousExecutionId ?? executionHint?.id
    if (!executionId) return { kind: "rejected" }
    const executions = await tx.$queryRaw<ExecutionRow[]>(Prisma.sql`
      SELECT "id", "userId", "sessionId", "status", "error", "attemptCount", "state"
      FROM "agent_executions" WHERE "id" = ${executionId} AND "userId" = ${input.userId}
        AND "sessionId" = ${automation.sessionId} FOR UPDATE
    `)
    const execution = executions[0]
    if (!execution || execution.attemptCount >= MAX_EXECUTION_ATTEMPT) return { kind: "rejected" }
    if (sourceChain) {
      if (execution.attemptCount !== sourceChain.latestIntent.reservedExecutionAttemptCount
        || !RECOVERY_TERMINAL_EXECUTION_STATUSES.has(execution.status) || hasMaterialDriftIndication(execution.state, execution.error)
        || !validateMaterialDriftSourceMarker({ sourceTurn, root, gate, execution, intent: sourceChain.latestIntent })) return { kind: "rejected" }
    } else {
      if (!scheduledMaterialDriftRecoveryReason({ userId: input.userId, sessionId: automation.sessionId,
        activeTurnId: null, newestTurnId: sourceTurn.id, turn: sourceTurn, root, gate, execution })) return { kind: "rejected" }
      sourceMarker = record(record(execution.state)?.scheduledTaskGraphMaterialDriftTerminal)
      if (!sourceMarker || execution.status !== "failed" || execution.error !== MATERIAL_DRIFT_ERROR) return { kind: "rejected" }
    }

    const claim = await tx.agentAutomation.updateMany({
      where: { id: automation.id, userId: input.userId, enabled: true, sessionId: automation.sessionId },
      data: { lastRunAt: runAt, nextRunAt: nextRunAfterCurrent(automation.cron, runAt, automation.timezone) },
    })
    if (claim.count !== 1) return null
    const sessionUpdate = await tx.agentSession.updateMany({
      where: { id: automation.sessionId, userId: input.userId, status: { notIn: ["aborted", "archived"] } },
      data: { status: "running", completedAt: null, memorySummary: "Automation queued for execution." },
    })
    if (sessionUpdate.count !== 1) throw new Error("material_drift_recovery_session_changed")

    const turnId = randomUUID()
    const original = sourceChain?.initialIntent
    const recoveryIntent = { schemaVersion: MATERIAL_DRIFT_RECOVERY_SCHEMA, turnId, userId: input.userId, sessionId: automation.sessionId,
      automationId: automation.id, previousTurnId: original?.previousTurnId ?? sourceTurn.id, previousExecutionId: execution.id,
      previousGateTaskId: original?.previousGateTaskId ?? gate.id, previousGateAttemptCount: original?.previousGateAttemptCount ?? gate.attemptCount,
      previousRootTaskId: original?.previousRootTaskId ?? root.id, previousRootAttemptCount: original?.previousRootAttemptCount ?? root.attemptCount,
      previousTurnLeaseVersion: original?.previousTurnLeaseVersion ?? sourceTurn.leaseVersion,
      previousExecutionAttemptCount: original?.previousExecutionAttemptCount ?? execution.attemptCount,
      previousRecoveryTurnId: sourceChain ? turn.id : null, reservedExecutionAttemptCount: execution.attemptCount + 1,
      currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshot), sourceMarker }
    await tx.agentTurn.create({ data: {
      id: turnId, sessionId: automation.sessionId, userId: input.userId, source: "automation", status: "queued",
      executionMode: "canonical_task_graph",
      input: { goal: `Run automation: ${automation.name}`, automationRunMode: "manual", scheduledAutomationSnapshot: snapshot,
        materialDriftRecovery: recoveryIntent } as unknown as Prisma.InputJsonValue,
      modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
    } })
    const reset = await tx.agentExecution.updateMany({
      where: { id: execution.id, userId: input.userId, sessionId: automation.sessionId, status: execution.status,
        attemptCount: execution.attemptCount, error: execution.error },
      data: { attemptCount: { increment: 1 }, status: "queued", checkpoint: "scout", state: { nextStage: "scout", startedAt: runAt.toISOString(), autonomous: true },
        error: null, workerTaskId: null, startedAt: null, completedAt: null, cancelledAt: null },
    })
    if (reset.count !== 1) throw new Error("material_drift_recovery_execution_changed")
    const dispatchId = randomUUID()
    await tx.agentOutbox.create({ data: {
      id: dispatchId, topic: "agent.turn.dispatch", aggregateId: automation.sessionId,
      idempotencyKey: `turn-dispatch:${turnId}`,
      payload: { turnId, sessionId: automation.sessionId, ownerId: `web:${turnId}` },
    } })
    const session = await tx.agentSession.findFirst({ where: { id: automation.sessionId, userId: input.userId } })
    if (!session) throw new Error("material_drift_recovery_session_unavailable")
    return { kind: "created", automation, session, turnId, executionId: execution.id, dispatchId, snapshot, turnStatus: "queued" }
  })
}
