import type pg from "pg"

import { BudgetExceededError } from "../budget.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"

type QueryClient = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type BudgetMetric = "maxSteps" | "maxToolCalls"
const DEFAULT_ROOT_MAX_STEPS = 32

function rootTaskId(owner: ExecutionOwnerFence): string {
  return owner.kind === "turn" ? owner.taskId : owner.rootTaskId
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

async function rootLimit(client: QueryClient, owner: ExecutionOwnerFence, metric: BudgetMetric): Promise<number | undefined> {
  const rootId = rootTaskId(owner)
  const result = await client.query<{ budgetSnapshot: unknown }>(`SELECT root_task."budgetSnapshot"
    FROM "sub_agent_tasks" AS root_task
    JOIN "agent_sessions" AS session ON session."id" = root_task."sessionId" AND session."userId" = $4
    WHERE root_task."id" = $1 AND root_task."sessionId" = $2 AND root_task."turnId" = $3
      AND root_task."rootTaskId" = root_task."id"`, [rootId, owner.sessionId, owner.turnId, owner.userId])
  const snapshot = record(result.rows[0]?.budgetSnapshot)
  const limits = record(snapshot.limits ?? snapshot)
  const value = limits[metric]
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  return metric === "maxSteps" ? DEFAULT_ROOT_MAX_STEPS : undefined
}

async function usageCount(client: QueryClient, owner: ExecutionOwnerFence, metric: "steps" | "tool_calls"): Promise<number> {
  const rootId = rootTaskId(owner)
  const table = metric === "steps" ? `"agent_steps" AS usage_row` : `"agent_items" AS usage_row`
  const typeFilter = metric === "steps" ? "" : ` AND usage_row."type" = 'tool_call'`
  const result = await client.query<{ used: number | string }>(`SELECT COUNT(*)::bigint AS "used"
    FROM ${table}
    JOIN "agent_sessions" AS session ON session."id" = usage_row."sessionId" AND session."userId" = $4
    LEFT JOIN "sub_agent_tasks" AS task ON task."id" = usage_row."taskId"
      AND task."sessionId" = usage_row."sessionId" AND task."turnId" = usage_row."turnId"
    WHERE usage_row."sessionId" = $1 AND usage_row."turnId" = $2
      AND (usage_row."taskId" IS NULL OR task."rootTaskId" = $3)${typeFilter}`,
  [owner.sessionId, owner.turnId, rootId, owner.userId])
  const used = Number(result.rows[0]?.used ?? 0)
  if (!Number.isSafeInteger(used) || used < 0) throw new Error("turn_budget_usage_invalid")
  return used
}

export async function enforceRootStepBudget(client: QueryClient, owner: ExecutionOwnerFence): Promise<void> {
  const limit = await rootLimit(client, owner, "maxSteps")
  if (limit === undefined) return
  const used = await usageCount(client, owner, "steps")
  if (used + 1 > limit) throw new BudgetExceededError("steps", limit, used + 1, used)
}

export async function enforceRootToolCallBudget(client: QueryClient, owner: ExecutionOwnerFence, itemId: string): Promise<void> {
  const existing = await client.query<{ id: string }>(`SELECT "id" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [itemId, owner.sessionId, owner.turnId])
  if (existing.rows[0]) return
  const limit = await rootLimit(client, owner, "maxToolCalls")
  if (limit === undefined) return
  const used = await usageCount(client, owner, "tool_calls")
  if (used + 1 > limit) throw new BudgetExceededError("tool_calls", limit, used + 1, used)
}
