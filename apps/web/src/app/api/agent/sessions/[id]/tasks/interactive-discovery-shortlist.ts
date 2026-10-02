const FAILURE_CODES = new Set([
  "owner_scope_missing", "observed_evidence_invalid", "invalid_scout_result", "invalid_analyst_result",
  "scout_task_missing", "analyst_task_missing", "scout_task_failed", "analyst_task_failed", "scout_task_incomplete", "analyst_task_incomplete",
  "scout_result_partial", "analyst_result_partial", "evidence_conflict", "evidence_unverified",
  "invalid_job_id", "duplicate_scout_job", "duplicate_analyst_finding", "conflicting_analyst_score", "no_common_candidates",
  "discovery_runtime_unavailable", "discovery_runtime_failed",
])

export interface SafeDiscoveryShortlist {
  readonly schemaVersion: 1
  readonly status: "completed" | "partial" | "failed"
  readonly items: readonly { readonly jobId: string; readonly score: number; readonly evidenceIds: readonly string[] }[]
  readonly failures: readonly string[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

/** Projects only the Workbench-safe terminal result written by the discovery root task. */
export function projectInteractiveDiscoveryShortlist(rootResult: unknown): SafeDiscoveryShortlist | null {
  const result = record(record(record(rootResult)?.structuredResult)?.interactiveDiscoveryShortlist)
  if (!result || !exactKeys(result, ["schemaVersion", "status", "items", "failures"]) || result.schemaVersion !== 1
    || (result.status !== "completed" && result.status !== "partial" && result.status !== "failed")
    || !Array.isArray(result.items) || result.items.length > 3 || !Array.isArray(result.failures) || result.failures.length > FAILURE_CODES.size) return null

  const failures: string[] = []
  for (const failure of result.failures) {
    if (typeof failure !== "string" || !FAILURE_CODES.has(failure) || failures.includes(failure)) return null
    failures.push(failure)
  }
  const items: Array<{ jobId: string; score: number; evidenceIds: string[] }> = []
  const jobIds = new Set<string>()
  for (const value of result.items) {
    const item = record(value)
    if (!item || !exactKeys(item, ["jobId", "score", "evidenceIds"])
      || typeof item.jobId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(item.jobId)
      || jobIds.has(item.jobId) || typeof item.score !== "number" || !Number.isFinite(item.score) || item.score < 0 || item.score > 10
      || !Array.isArray(item.evidenceIds) || item.evidenceIds.length !== 1 || item.evidenceIds[0] !== `read:job:${item.jobId}`) return null
    jobIds.add(item.jobId)
    items.push({ jobId: item.jobId, score: item.score, evidenceIds: [`read:job:${item.jobId}`] })
  }

  const validState = result.status === "completed" ? items.length > 0 && failures.length === 0
    : result.status === "partial" ? items.length > 0 && failures.length > 0
      : items.length === 0 && failures.length > 0
  return validState ? { schemaVersion: 1, status: result.status, items, failures } : null
}
