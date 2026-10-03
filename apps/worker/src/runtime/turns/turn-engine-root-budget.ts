import type pg from "pg"

import { BudgetExceededError } from "../budget.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"

type QueryClient = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type BudgetMetric = "maxSteps" | "maxToolCalls"
type UsageBudgetLimit = "maxInputTokens" | "maxOutputTokens" | "maxCostUsd"
const DEFAULT_ROOT_MAX_STEPS = 32

const USAGE_BUDGET_METRICS = [
  { limit: "maxInputTokens", column: "inputTokens", metric: "input_tokens", integer: true },
  { limit: "maxOutputTokens", column: "outputTokens", metric: "output_tokens", integer: true },
  { limit: "maxCostUsd", column: "estimatedCostUsd", metric: "cost_usd", integer: false },
] as const
type UsageBudgetMetric = (typeof USAGE_BUDGET_METRICS)[number]
type ConfiguredUsageBudgetMetric = UsageBudgetMetric & { threshold: number }

function rootTaskId(owner: ExecutionOwnerFence): string {
  return owner.kind === "turn" ? owner.taskId : owner.rootTaskId
}

function record(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}
}

async function rootSnapshot(client: QueryClient, owner: ExecutionOwnerFence): Promise<Row> {
  const rootId = rootTaskId(owner)
  const result = await client.query<{ budgetSnapshot: unknown }>(`SELECT root_task."budgetSnapshot"
    FROM "sub_agent_tasks" AS root_task
    JOIN "agent_sessions" AS session ON session."id" = root_task."sessionId" AND session."userId" = $4
    WHERE root_task."id" = $1 AND root_task."sessionId" = $2 AND root_task."turnId" = $3
      AND root_task."rootTaskId" = root_task."id"`, [rootId, owner.sessionId, owner.turnId, owner.userId])
  return record(result.rows[0]?.budgetSnapshot)
}

function rootLimits(snapshot: Row): Row {
  return record(snapshot.limits ?? snapshot)
}

function rootUsageLimits(snapshot: Row): Row {
  if (!Object.prototype.hasOwnProperty.call(snapshot, "limits") || snapshot.limits === null) return record(snapshot)
  if (typeof snapshot.limits !== "object" || Array.isArray(snapshot.limits)) {
    throw new Error("turn_budget_limit_invalid")
  }
  return record(snapshot.limits)
}

function rootLimit(limits: Row, metric: BudgetMetric): number | undefined {
  const value = limits[metric]
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
  return metric === "maxSteps" ? DEFAULT_ROOT_MAX_STEPS : undefined
}

function usageLimit(limits: Row, metric: UsageBudgetLimit): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(limits, metric)) return undefined
  const value = limits[metric]
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error("turn_budget_limit_invalid")
  }
  return value
}

function usageValue(value: unknown, integer: boolean): number {
  if (integer) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
    if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
    if (typeof value === "string" && /^[+-]?\d+$/.test(value)) {
      const parsed = BigInt(value)
      if (parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(parsed)
    }
  } else {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value
    if (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
      const parsed = Number(value)
      if (Number.isFinite(parsed) && parsed >= 0) return parsed
    }
  }
  throw new Error("turn_budget_usage_invalid")
}

async function usageSums(
  client: QueryClient,
  owner: ExecutionOwnerFence,
  metrics: readonly UsageBudgetMetric[],
): Promise<Map<string, number>> {
  const rootId = rootTaskId(owner)
  const selections = metrics.map(({ column }) => `SUM(usage_row."${column}") AS "${column}"`).join(", ")
  const result = await client.query<{ [key: string]: unknown }>(`SELECT ${selections}
    FROM "agent_steps" AS usage_row
    JOIN "agent_sessions" AS session ON session."id" = usage_row."sessionId" AND session."userId" = $4
    LEFT JOIN "sub_agent_tasks" AS task ON task."id" = usage_row."taskId"
      AND task."sessionId" = usage_row."sessionId" AND task."turnId" = usage_row."turnId"
    WHERE usage_row."sessionId" = $1 AND usage_row."turnId" = $2
      AND (usage_row."taskId" IS NULL OR task."rootTaskId" = $3)`,
  [owner.sessionId, owner.turnId, rootId, owner.userId])
  const row = result.rows[0]
  const values = new Map<string, number>()
  for (const { column, integer } of metrics) {
    const value = row?.[column]
    values.set(column, value === null ? 0 : usageValue(value, integer))
  }
  return values
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
  const snapshot = await rootSnapshot(client, owner)
  const limit = rootLimit(rootLimits(snapshot), "maxSteps")
  if (limit === undefined) return
  const used = await usageCount(client, owner, "steps")
  if (used + 1 > limit) throw new BudgetExceededError("steps", limit, used + 1, used)
}

async function enforceRootUsageBudgetForSnapshot(
  client: QueryClient,
  owner: ExecutionOwnerFence,
  snapshot: Row,
): Promise<void> {
  const limits = rootUsageLimits(snapshot)
  const configured: ConfiguredUsageBudgetMetric[] = []
  for (const metric of USAGE_BUDGET_METRICS) {
    const limit = usageLimit(limits, metric.limit)
    if (limit !== undefined) configured.push({ ...metric, threshold: limit })
  }
  if (configured.length === 0) return

  const sums = await usageSums(client, owner, configured)
  for (const { column, metric, threshold } of configured) {
    const used = sums.get(column)!
    // This is a post-commit guard: once committed usage reaches the limit, it stops the next step.
    // It cannot prevent the just-committed step from crossing the limit, so this is not a strict cap.
    if (used >= threshold) throw new BudgetExceededError(metric, threshold, used, used)
  }
}

export async function enforceRootStepAndUsageBudgets(client: QueryClient, owner: ExecutionOwnerFence): Promise<void> {
  const snapshot = await rootSnapshot(client, owner)
  const stepLimit = rootLimit(rootLimits(snapshot), "maxSteps")
  if (stepLimit !== undefined) {
    const used = await usageCount(client, owner, "steps")
    if (used + 1 > stepLimit) throw new BudgetExceededError("steps", stepLimit, used + 1, used)
  }
  await enforceRootUsageBudgetForSnapshot(client, owner, snapshot)
}

export async function enforceRootToolCallBudget(client: QueryClient, owner: ExecutionOwnerFence, itemId: string): Promise<void> {
  const existing = await client.query<{ id: string }>(`SELECT "id" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [itemId, owner.sessionId, owner.turnId])
  if (existing.rows[0]) return
  const limit = rootLimit(rootLimits(await rootSnapshot(client, owner)), "maxToolCalls")
  if (limit === undefined) return
  const used = await usageCount(client, owner, "tool_calls")
  if (used + 1 > limit) throw new BudgetExceededError("tool_calls", limit, used + 1, used)
}

export async function enforceRootUsageBudget(client: QueryClient, owner: ExecutionOwnerFence): Promise<void> {
  await enforceRootUsageBudgetForSnapshot(client, owner, await rootSnapshot(client, owner))
}
