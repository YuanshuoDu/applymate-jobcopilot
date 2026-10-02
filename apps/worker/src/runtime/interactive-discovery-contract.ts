import type { DiscoveryShortlistFailureCode, DiscoveryShortlistResult } from "./subagents/discovery-shortlist.js"
import { TASK_GRAPH_TEMPLATES } from "./subagents/task-graph-templates.js"

export type InteractiveDiscoveryShortlistProjection = Readonly<{
  schemaVersion: 1
  status: "completed" | "partial" | "failed"
  items: readonly Readonly<{ jobId: string; score: number; evidenceIds: readonly string[] }>[]
  failures: readonly DiscoveryShortlistFailureCode[]
}>

export const INTERACTIVE_DISCOVERY_ROOT_TOOLS = Object.freeze([
  "agent.plan", "agent.wait", "agent.list", "list_subagents",
] as const)
export const INTERACTIVE_DISCOVERY_TEMPLATES = Object.freeze({ scout: TASK_GRAPH_TEMPLATES.scout, analyst: TASK_GRAPH_TEMPLATES.analyst })

const FAILURE_ORDER: readonly DiscoveryShortlistFailureCode[] = [
  "owner_scope_missing", "observed_evidence_invalid", "invalid_scout_result", "invalid_analyst_result",
  "scout_task_missing", "analyst_task_missing", "scout_task_failed", "analyst_task_failed", "scout_task_incomplete", "analyst_task_incomplete",
  "scout_result_partial", "analyst_result_partial", "evidence_conflict", "evidence_unverified",
  "invalid_job_id", "duplicate_scout_job", "duplicate_analyst_finding", "conflicting_analyst_score",
  "no_common_candidates", "discovery_runtime_unavailable", "discovery_runtime_failed",
]
const SAFE_FAILURE_CODES: ReadonlySet<string> = new Set(FAILURE_ORDER)
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Canonicalizes and validates the only shortlist shape that may cross persistence or API boundaries. */
export function parseInteractiveDiscoveryShortlist(value: unknown): InteractiveDiscoveryShortlistProjection | undefined {
  const result = object(value)
  const rawFailures = result.failures, rawItems = result.items
  if (Object.keys(result).sort().join(",") !== "failures,items,schemaVersion,status" || result.schemaVersion !== 1
    || !Array.isArray(rawFailures) || rawFailures.length > FAILURE_ORDER.length
    || rawFailures.some(code => typeof code !== "string" || !SAFE_FAILURE_CODES.has(code))
    || new Set(rawFailures).size !== rawFailures.length
    || !Array.isArray(rawItems) || rawItems.length > 3) return undefined
  const failures = FAILURE_ORDER.filter(code => rawFailures.includes(code))
  const items = rawItems.map(item => {
    const candidate = object(item)
    if (Object.keys(candidate).sort().join(",") !== "evidenceIds,jobId,score"
      || typeof candidate.jobId !== "string" || !SAFE_JOB_ID.test(candidate.jobId)
      || typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 10
      || !Array.isArray(candidate.evidenceIds) || candidate.evidenceIds.length < 1 || candidate.evidenceIds.length > 50
      || candidate.evidenceIds.some(id => typeof id !== "string" || id.length < 1 || id.length > 256)
      || new Set(candidate.evidenceIds).size !== candidate.evidenceIds.length) return null
    return { jobId: candidate.jobId, score: candidate.score, evidenceIds: [...candidate.evidenceIds] as string[] }
  })
  if (items.some(item => item === null)) return undefined
  const candidates = items as { jobId: string; score: number; evidenceIds: string[] }[]
  if (new Set(candidates.map(item => item.jobId)).size !== candidates.length
    || candidates.some((item, index) => index > 0 && (candidates[index - 1]!.score < item.score
      || (candidates[index - 1]!.score === item.score && candidates[index - 1]!.jobId >= item.jobId)))) return undefined
  if ((result.status === "failed" && (candidates.length !== 0 || failures.length === 0))
    || (result.status === "completed" && (candidates.length === 0 || failures.length !== 0))
    || (result.status === "partial" && (candidates.length === 0 || failures.length === 0))
    || (result.status !== "failed" && result.status !== "completed" && result.status !== "partial")) return undefined
  const parsed: InteractiveDiscoveryShortlistProjection = { schemaVersion: 1, status: result.status, items: candidates, failures }
  return Buffer.byteLength(JSON.stringify(parsed), "utf8") <= 8 * 1024 ? parsed : undefined
}

export function validInteractiveDiscoveryShortlist(value: unknown): value is DiscoveryShortlistResult {
  const parsed = parseInteractiveDiscoveryShortlist(value)
  return Boolean(parsed && parsed.status !== "failed" && parsed.items.length > 0)
}

export function validTerminalInteractiveDiscoveryShortlist(value: unknown): value is InteractiveDiscoveryShortlistProjection {
  return parseInteractiveDiscoveryShortlist(value) !== undefined
}

export function interactiveDiscoveryRootToolAllowed(name: string): boolean {
  return (INTERACTIVE_DISCOVERY_ROOT_TOOLS as readonly string[]).includes(name)
}

export function rootToolSurface<T>(definitions: readonly T[], selectedJobMode: boolean, discoveryMode: boolean, selectedJobTool: (value: T) => boolean): T[] {
  return definitions.filter(value => (!selectedJobMode || selectedJobTool(value)) && (!discoveryMode || interactiveDiscoveryRootToolAllowed(String(object(value).name ?? ""))))
}

export function rootToolNames(definitions: readonly unknown[]): string[] {
  return definitions.flatMap(value => typeof object(value).name === "string" ? [object(value).name as string] : [])
}

export function rootTaskAllowedActions(
  rootTools: readonly unknown[],
  templates: Readonly<Record<string, { readonly allowedActions: readonly string[] }>> | undefined,
  taskGraphPlanningEnabled: boolean,
): string[] {
  const templateActions = taskGraphPlanningEnabled ? Object.values(templates ?? {}).flatMap(template => template.allowedActions) : []
  return [...new Set([...rootToolNames(rootTools), ...templateActions])]
}

export function failedInteractiveDiscoveryShortlist(code: "discovery_runtime_unavailable" | "discovery_runtime_failed"): InteractiveDiscoveryShortlistProjection {
  return { schemaVersion: 1, status: "failed", items: [], failures: [code] }
}

export function terminalInteractiveDiscoveryShortlist(status: string, accepted?: unknown, failureCode: "discovery_runtime_unavailable" | "discovery_runtime_failed" = "discovery_runtime_failed"): InteractiveDiscoveryShortlistProjection | undefined {
  if (status === "waiting_for_dependency" || status === "waiting_for_approval" || status === "waiting_for_user") return undefined
  const parsed = parseInteractiveDiscoveryShortlist(accepted)
  if (status === "completed") {
    if (!validInteractiveDiscoveryShortlist(parsed)) throw new Error("interactive_discovery_shortlist_missing")
    return parsed
  }
  if (status === "failed" || status === "interrupted") {
    if (parsed?.status === "failed") return parsed
    if (parsed && parsed.items.length > 0) {
      const failures = FAILURE_ORDER.filter(code => new Set([...parsed.failures, "discovery_runtime_failed" as const]).has(code))
      return { ...parsed, status: "partial", failures }
    }
    return failedInteractiveDiscoveryShortlist(failureCode)
  }
  return undefined
}
