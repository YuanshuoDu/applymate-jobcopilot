import type { TaskGraphVerificationCheck } from "./task-graph-verification-contract.js"
import type { TaskGraphVerificationParsedProjection } from "./task-graph-verification-cross-node.js"

const MAX_SELECTED_SCOUTS = 8

/** Returns only the direct Scout selectors owned by a cross-node criterion. */
export function taskGraphVerificationCheckDependencyNodeKeys(check: TaskGraphVerificationCheck): readonly string[] {
  switch (check.kind) {
    case "findings_from_scout_dependency":
    case "findings_cover_scout_candidates_gte": return [check.dependencyNodeKey]
    case "findings_from_scout_union":
    case "findings_cover_scout_candidate_union_gte": return check.dependencyNodeKeys
    default: return []
  }
}

/** Remaps internal selectors while retaining external references and authored order. */
export function remapTaskGraphVerificationCheckDependencies(
  check: TaskGraphVerificationCheck,
  mapping: ReadonlyMap<string, string>,
): TaskGraphVerificationCheck {
  if (check.kind === "findings_from_scout_dependency" || check.kind === "findings_cover_scout_candidates_gte") {
    return { ...check, dependencyNodeKey: mapping.get(check.dependencyNodeKey) ?? check.dependencyNodeKey }
  }
  if (check.kind === "findings_from_scout_union" || check.kind === "findings_cover_scout_candidate_union_gte") {
    return { ...check, dependencyNodeKeys: check.dependencyNodeKeys.map(key => mapping.get(key) ?? key) }
  }
  return check
}

export function evaluateFindingsFromScoutUnion(
  keys: readonly string[],
  findings: readonly string[],
  parsedDeps: ReadonlyMap<string, TaskGraphVerificationParsedProjection>,
): "passed" | "criterion_not_met" {
  const candidates = unionCandidates(keys, parsedDeps)
  if (!candidates || candidates.size === 0 || !uniqueFindings(findings)) return "criterion_not_met"
  return findings.every(jobId => candidates.has(jobId)) ? "passed" : "criterion_not_met"
}

export function evaluateFindingsCoverScoutCandidateUnion(
  keys: readonly string[],
  findings: readonly string[],
  parsedDeps: ReadonlyMap<string, TaskGraphVerificationParsedProjection>,
  minimumPercent: number,
): "passed" | "criterion_not_met" {
  const candidates = unionCandidates(keys, parsedDeps)
  if (!candidates || candidates.size === 0 || !uniqueFindings(findings)
    || !Number.isSafeInteger(minimumPercent) || minimumPercent < 1 || minimumPercent > 100
    || findings.some(jobId => !candidates.has(jobId))) return "criterion_not_met"
  return findings.length * 100 >= candidates.size * minimumPercent ? "passed" : "criterion_not_met"
}

function unionCandidates(
  keys: readonly string[],
  parsedDeps: ReadonlyMap<string, TaskGraphVerificationParsedProjection>,
): Set<string> | undefined {
  if (keys.length < 2 || keys.length > MAX_SELECTED_SCOUTS
    || keys.some(key => typeof key !== "string" || key.length < 1 || key.length > 128 || key.trim() !== key)
    || new Set(keys).size !== keys.length) return undefined
  const candidates = new Set<string>()
  for (const key of keys) {
    const source = parsedDeps.get(key)
    if (!source || source.role !== "scout") return undefined
    for (const item of source.items) candidates.add(item.jobId)
  }
  return candidates
}

function uniqueFindings(findings: readonly string[]): boolean {
  return findings.length > 0 && findings.every(jobId => typeof jobId === "string" && jobId.trim() === jobId && jobId.length > 0)
    && new Set(findings).size === findings.length
}
