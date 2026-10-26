import { parseTaskGraphVerificationReport, type TaskGraphVerificationReport } from "../subagents/task-graph-command-port.js"
import { taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { validateRoleResult } from "../subagents/role-results.js"
import type { RootTaskHistoryCheckDescriptor } from "./root-task-history-lesson-schema.js"

export type RootTaskHistoryPassedCriterion = Readonly<{
  criterionOrdinal: number
  status: "passed"
  check: RootTaskHistoryCheckDescriptor
}>

type CheckParser = (value: unknown, expectedRole?: string) => RootTaskHistoryCheckDescriptor | undefined
type Row = Record<string, unknown>

function exactDataRecord(value: unknown, keys: readonly string[]): Row | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const own = Reflect.ownKeys(value), prototype = Object.getPrototypeOf(value)
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== "string")
      || [...own].sort().join("\0") !== [...keys].sort().join("\0")) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value), row: Row = Object.create(null) as Row
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined
      row[key] = descriptor.value
    }
    return row
  } catch { return undefined }
}

function safeArray(value: unknown): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value, own = Reflect.ownKeys(value)
    if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 8 || own.length !== Number(length) + 1) return undefined
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}

function cloneCheck(check: RootTaskHistoryCheckDescriptor): RootTaskHistoryCheckDescriptor {
  switch (check.kind) {
    case "candidate_count_gte": return { role: "scout", kind: check.kind, minimum: check.minimum }
    case "finding_count_gte": return { role: "analyst", kind: check.kind, minimum: check.minimum }
    case "evidence_count_gte": return { role: check.role, kind: check.kind, minimum: check.minimum }
    case "all_candidates_have_evidence": return { role: "scout", kind: check.kind, minimumItems: check.minimumItems }
    case "all_findings_have_evidence": return { role: "analyst", kind: check.kind, minimumItems: check.minimumItems }
    case "reported_score_gte": return { role: "analyst", kind: check.kind, minimumScore: check.minimumScore,
      minimumFindings: check.minimumFindings, aggregation: check.aggregation }
    case "findings_from_scout_dependency": return { role: "analyst", kind: check.kind, dependencyNodeOrdinal: check.dependencyNodeOrdinal }
    case "findings_cover_scout_candidates_gte": return { role: "analyst", kind: check.kind,
      dependencyNodeOrdinal: check.dependencyNodeOrdinal, minimumPercent: check.minimumPercent }
  }
}

/** Parses only ordered, nonempty passed facts with the existing closed role-bound check parser. */
export function parseRootTaskHistoryPassedCriteria(
  value: unknown,
  expectedRole: string | undefined,
  parseCheck: CheckParser,
): readonly RootTaskHistoryPassedCriterion[] | undefined {
  const rows = safeArray(value)
  if (!rows) return undefined
  const output: RootTaskHistoryPassedCriterion[] = []
  let previous = 0, role: string | undefined
  for (const value of rows) {
    const row = exactDataRecord(value, ["check", "criterionOrdinal", "status"])
    const check = row?.status === "passed" ? parseCheck(row.check, expectedRole) : undefined
    if (!row || !Number.isSafeInteger(row.criterionOrdinal) || Number(row.criterionOrdinal) < 1
      || Number(row.criterionOrdinal) > 8 || Number(row.criterionOrdinal) <= previous || !check
      || (check.role !== "scout" && check.role !== "analyst") || (role !== undefined && role !== check.role)
      || (expectedRole !== undefined && expectedRole !== check.role)) return undefined
    previous = Number(row.criterionOrdinal)
    role = check.role
    output.push({ criterionOrdinal: previous, status: "passed", check })
  }
  return output
}

/** Validates a completed ordinary typed result against both report views and its canonical result digest. */
export function deriveRootTaskHistoryPassedCriteria(input: Readonly<{
  role: string
  templateId: string
  taskRole: unknown
  verificationRole: unknown
  verificationDisposition: string
  status: string
  failureReason: unknown
  attemptCount: unknown
  isRepair: boolean
  isNative: boolean
  criterionIds: readonly string[]
  currentReport: TaskGraphVerificationReport | undefined
  persistedReport: unknown
  structuredResult: unknown
  checkDescriptors: readonly (RootTaskHistoryCheckDescriptor | undefined)[]
}>): readonly RootTaskHistoryPassedCriterion[] | undefined {
  try {
    const { role, criterionIds, currentReport } = input
    if ((role !== "scout" && role !== "analyst") || input.templateId !== role || input.taskRole !== role
      || input.verificationRole !== role || input.verificationDisposition !== "typed" || input.status !== "completed"
      || input.failureReason !== null || typeof input.attemptCount !== "number" || !Number.isSafeInteger(input.attemptCount)
      || input.attemptCount < 1 || input.isRepair || input.isNative
      || !Array.isArray(criterionIds) || criterionIds.length < 1 || criterionIds.length > 8
      || !Array.isArray(input.checkDescriptors) || input.checkDescriptors.length !== criterionIds.length
      || !currentReport || currentReport.status !== "passed" || currentReport.reasonCode !== "criteria_met"
      || typeof currentReport.resultDigest !== "string") return undefined
    const persisted = parseTaskGraphVerificationReport(input.persistedReport, criterionIds)
    if (!persisted || JSON.stringify(persisted) !== JSON.stringify(currentReport)
      || currentReport.criteria.length !== criterionIds.length
      || currentReport.criteria.some((item, index) => item.criterionId !== criterionIds[index]
        || item.status !== "passed" || item.reasonCode !== "criteria_met")) return undefined
    const result = validateRoleResult(input.structuredResult, role)
    if (taskGraphResultDigest(result) !== currentReport.resultDigest) return undefined
    const facts: RootTaskHistoryPassedCriterion[] = []
    for (let index = 0; index < input.checkDescriptors.length; index++) {
      const check = input.checkDescriptors[index]
      if (!check) continue
      if (check.role !== role) return undefined
      facts.push({ criterionOrdinal: index + 1, status: "passed", check })
    }
    return facts.length ? facts : undefined
  } catch { return undefined }
}

/** Drops dependent pass facts when their source ordinal was removed from the emitted history. */
export function filterRootTaskHistoryPassedCriteriaForEmittedNodes(
  criteria: readonly RootTaskHistoryPassedCriterion[] | undefined,
  emittedNodeOrdinals: ReadonlySet<number>,
): readonly RootTaskHistoryPassedCriterion[] | undefined {
  if (!criteria) return undefined
  const kept = criteria.filter(({ check }) =>
    (check.kind !== "findings_from_scout_dependency" && check.kind !== "findings_cover_scout_candidates_gte")
    || emittedNodeOrdinals.has(check.dependencyNodeOrdinal))
  return kept.length ? kept : undefined
}

/** Reconstructs only the safe source-local ordinal, fixed status, and closed descriptor. */
export function copyRootTaskHistoryPassedCriteria(
  criteria: readonly RootTaskHistoryPassedCriterion[] | undefined,
): readonly RootTaskHistoryPassedCriterion[] | undefined {
  return criteria?.map(({ criterionOrdinal, check }) => ({
    criterionOrdinal, status: "passed", check: cloneCheck(check),
  }))
}
