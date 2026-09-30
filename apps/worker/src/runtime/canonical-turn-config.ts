import type { TurnBudgetLimits } from "./budget.js"

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function capabilities(value: unknown): readonly string[] {
  const list = record(value).capabilities
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : ["read"]
}

export function limits(value: unknown): TurnBudgetLimits | undefined {
  const raw = record(value).limits ?? value
  const source = record(raw)
  const names = { maxSteps: "maxSteps", maxToolCalls: "maxToolCalls", maxInputTokens: "maxInputTokens", maxOutputTokens: "maxOutputTokens", maxCostUsd: "maxCostUsd" } as const
  const result: Partial<TurnBudgetLimits> = {}
  for (const [name, key] of Object.entries(names) as Array<[keyof TurnBudgetLimits, string]>) if (typeof source[key] === "number" && Number.isFinite(source[key]) && source[key] >= 0) (result as Record<string, number>)[name] = source[key]
  return Object.keys(result).length > 0 ? result : undefined
}
