import { normalizeSubagentPolicy, type SubagentPolicy, type SubagentTaskRecord } from "./types.js"

export function policyFromTask(task: Pick<SubagentTaskRecord, "budgetSnapshot">): SubagentPolicy {
  const budget = task.budgetSnapshot
  const raw = budget && typeof budget === "object" && !Array.isArray(budget)
    ? (budget as Record<string, unknown>).subagentPolicy : undefined
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return normalizeSubagentPolicy()
  return normalizeSubagentPolicy(raw as Partial<SubagentPolicy>)
}

export function normalizeTaskPath(path: string): string | null {
  return /^\/[^/%_\\]+(?:\/[^/%_\\]+)*$/.test(path) ? path : null
}

export function isTaskPathWithin(path: string, targetPath: string): boolean {
  return path === targetPath || path.startsWith(`${targetPath}/`)
}
