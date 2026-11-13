import { Prisma } from "@prisma/client"

import {
  lockRootUsageAdmissionScope,
  lockRootUsageReservation,
  releaseRootOutputReservation,
  RootUsageReservationError,
  type RootUsageQuery,
  type RootUsageReservationRef,
} from "./agent-root-usage-reservations"

export type AgentUsageReconciliationScope = { userId: string; sessionId: string; turnId: string; rootTaskId: string }

function owner(row: RootUsageReservationRef) {
  return row.executionOwnerKind === "turn"
    ? { kind: "turn" as const, leaseOwnerId: row.executionOwnerId, leaseVersion: row.executionOwnerVersion }
    : { kind: "task" as const, taskId: row.taskId, rootTaskId: row.rootTaskId, ownerId: row.executionOwnerId, attemptCount: row.executionOwnerVersion }
}

function creditMonth(errorCode: string | null): string | null {
  return /^credit_reserved_(\d{4}-(?:0[1-9]|1[0-2]))$/.exec(errorCode ?? "")?.[1] ?? null
}

function sameReservation(a: RootUsageReservationRef, b: RootUsageReservationRef): boolean {
  return a.id === b.id && a.userId === b.userId && a.sessionId === b.sessionId && a.turnId === b.turnId &&
    a.rootTaskId === b.rootTaskId && a.taskId === b.taskId && a.stepId === b.stepId && a.attempt === b.attempt &&
    a.executionOwnerKind === b.executionOwnerKind && a.executionOwnerId === b.executionOwnerId &&
    a.executionOwnerVersion === b.executionOwnerVersion && a.provider === b.provider && a.model === b.model &&
    a.outputReservationRequired === b.outputReservationRequired
}

export async function reconcileAbandonedAgentUsage(
  tx: RootUsageQuery,
  scope: AgentUsageReconciliationScope,
): Promise<number> {
  const candidates = await tx.$queryRaw<RootUsageReservationRef[]>(Prisma.sql`
    SELECT r."id", r."userId", r."sessionId", r."turnId", r."rootTaskId", r."taskId", r."stepId",
      r."executionOwnerKind", r."executionOwnerId", r."executionOwnerVersion", r."attempt", r."attemptId", r."provider", r."model",
      r."outputReservationRequired", r."reservedOutputTokens", r."status", r."actualOutputTokens", r."outcomeStatus", r."errorCode"
    FROM "agent_root_usage_reservations" AS r
    JOIN ai_usage_events AS e ON e.id = r."id" AND e.user_id = r."userId"
    WHERE r."userId" = ${scope.userId} AND r."sessionId" = ${scope.sessionId} AND r."turnId" = ${scope.turnId}
      AND r."rootTaskId" = ${scope.rootTaskId} AND r."status" = 'reserved'
      AND e.status = 'reserved' AND e.provider_started_at IS NULL AND e.usage_start_protocol_version = 1
    ORDER BY r."createdAt", r."id" LIMIT 32`)
  let released = 0
  for (const candidate of candidates) {
    const input = { userId: candidate.userId, sessionId: candidate.sessionId, turnId: candidate.turnId, stepId: candidate.stepId }
    try {
      await lockRootUsageAdmissionScope(tx, input, owner(candidate), candidate)
      continue
    } catch (error: unknown) {
      if (!(error instanceof RootUsageReservationError) || error.code !== "usage_fence_rejected") throw error
    }
    const row = await lockRootUsageReservation(tx, candidate)
    if (row.status !== "reserved" || !sameReservation(row, candidate)) continue
    const events = await tx.$queryRaw<Array<{
      status: string; provider: string; model: string; outputReservationRequired: boolean
      startProtocolVersion: number; providerStartedAt: Date | null; errorCode: string | null
    }>>(Prisma.sql`
      SELECT status, provider, model, output_reservation_required AS "outputReservationRequired",
        usage_start_protocol_version AS "startProtocolVersion", provider_started_at AS "providerStartedAt", error_code AS "errorCode"
      FROM ai_usage_events WHERE id = ${row.id} AND user_id = ${row.userId} FOR UPDATE`)
    const event = events[0]
    if (!event || event.status !== "reserved" || event.providerStartedAt !== null || event.startProtocolVersion !== 1 ||
        event.provider !== row.provider || event.model !== row.model || event.outputReservationRequired !== row.outputReservationRequired) continue
    await releaseRootOutputReservation(tx, row)
    const eventReleased = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      UPDATE ai_usage_events SET status = 'released', input_tokens = 0, output_tokens = 0, estimated_cost_usd = 0,
        error_code = 'cancelled_before_provider'
      WHERE id = ${row.id} AND user_id = ${row.userId} AND status = 'reserved' AND provider_started_at IS NULL
        AND usage_start_protocol_version = 1 RETURNING id`)
    if (!eventReleased[0]) throw new RootUsageReservationError("usage_reconciliation_conflict", 503)
    const month = creditMonth(event.errorCode)
    if (month) {
      const refunded = await tx.$queryRaw<Array<{ userId: string }>>(Prisma.sql`
        UPDATE ai_budgets SET used = GREATEST(used - 1, 0), updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ${row.userId} AND month = ${month} RETURNING user_id AS "userId"`)
      if (!refunded[0]) throw new RootUsageReservationError("usage_credit_refund_unavailable", 503)
    }
    released++
  }
  return released
}
