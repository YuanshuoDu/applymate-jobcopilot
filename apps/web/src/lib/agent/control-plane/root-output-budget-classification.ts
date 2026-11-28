import { Prisma } from "@prisma/client"

import type { RootUsageQuery, RootUsageScope } from "./agent-root-usage-reservations"

export const OUTPUT_BUDGET_CLASSIFICATION_VERSION = 1 as const
export type RootOutputBudgetDisposition = "configured_zero_limit" | "settled_exhausted" | "active_reservation_hold"
export type RootOutputBudgetClassification = { remaining: number; disposition: RootOutputBudgetDisposition | null }

export async function classifyRootOutputBudget(
  tx: RootUsageQuery,
  scope: Pick<RootUsageScope, "userId" | "sessionId" | "turnId" | "rootTaskId">,
  limit: number,
  safeCount: (value: unknown) => number,
): Promise<RootOutputBudgetClassification> {
  if (limit === 0) return { remaining: 0, disposition: "configured_zero_limit" }

  const sums = await tx.$queryRaw<Array<{ settled: number | bigint | string; active: number | bigint | string }>>(Prisma.sql`
    SELECT COALESCE(SUM("actualOutputTokens") FILTER (WHERE "status" = 'settled'), 0)::bigint AS "settled",
      COALESCE(SUM("reservedOutputTokens") FILTER (WHERE "status" IN ('reserved', 'started')), 0)::bigint AS "active"
    FROM "agent_root_usage_reservations"
    WHERE "userId" = ${scope.userId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId}
      AND "rootTaskId" = ${scope.rootTaskId} AND "status" IN ('reserved', 'started', 'settled')`)
  const settled = safeCount(sums[0]?.settled ?? 0), active = safeCount(sums[0]?.active ?? 0)
  const remainingAfterSettled = limit - settled
  if (remainingAfterSettled <= 0) return { remaining: 0, disposition: "settled_exhausted" }
  if (active >= remainingAfterSettled) return { remaining: 0, disposition: "active_reservation_hold" }
  return { remaining: remainingAfterSettled - active, disposition: null }
}

export async function readLegacyRootOutputBudgetRemaining(
  tx: RootUsageQuery,
  scope: Pick<RootUsageScope, "userId" | "sessionId" | "turnId" | "rootTaskId">,
  limit: number,
  safeCount: (value: unknown) => number,
): Promise<number> {
  const sums = await tx.$queryRaw<Array<{ used: number | bigint | string }>>(Prisma.sql`
    SELECT COALESCE(SUM(CASE WHEN "status" = 'settled' THEN "actualOutputTokens" ELSE "reservedOutputTokens" END), 0)::bigint AS "used"
    FROM "agent_root_usage_reservations"
    WHERE "userId" = ${scope.userId} AND "sessionId" = ${scope.sessionId} AND "turnId" = ${scope.turnId}
      AND "rootTaskId" = ${scope.rootTaskId} AND "status" IN ('reserved', 'started', 'settled')`)
  return limit - safeCount(sums[0]?.used ?? 0)
}
