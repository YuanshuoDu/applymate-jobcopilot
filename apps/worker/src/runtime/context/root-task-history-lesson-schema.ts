import { TASK_GRAPH_VERIFICATION_LIMITS, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot } from "../subagents/task-graph-snapshot.js"
import type { TaskGraphExecutionFailureCategory } from "../subagents/task-graph-failure-category.js"
import { filterRootTaskHistoryPassedCriteriaForEmittedNodes, parseRootTaskHistoryPassedCriteria, type RootTaskHistoryPassedCriterion } from "./root-task-history-passed-criteria.js"

export type RootTaskHistoryCheckDescriptor =
  | Readonly<{ role: "scout"; kind: "candidate_count_gte"; minimum: number }>
  | Readonly<{ role: "analyst"; kind: "finding_count_gte"; minimum: number }>
  | Readonly<{ role: "scout" | "analyst"; kind: "evidence_count_gte"; minimum: number }>
  | Readonly<{ role: "scout"; kind: "all_candidates_have_evidence"; minimumItems: number }>
  | Readonly<{ role: "analyst"; kind: "all_findings_have_evidence"; minimumItems: number }>
  | Readonly<{ role: "analyst"; kind: "reported_score_gte"; minimumScore: number; minimumFindings: number; aggregation: "any" | "all" }>
  | Readonly<{ role: "analyst"; kind: "findings_from_scout_dependency"; dependencyNodeOrdinal: number }>
  | Readonly<{ role: "analyst"; kind: "findings_cover_scout_candidates_gte"; dependencyNodeOrdinal: number; minimumPercent: number }>

type CriterionFailure = Readonly<{
  criterionOrdinal: number
  status: "failed" | "unverified"
  reasonCode: TaskGraphVerificationReasonCode
  check?: RootTaskHistoryCheckDescriptor
}>
type SuccessfulRepair = Readonly<{ targetNodeOrdinal: number; targetCriterionOrdinals: readonly number[]; status: "passed" }>
type FailedRepairOf = Readonly<{ targetNodeOrdinal: number; targetCriterionOrdinals: readonly number[]; outcome: "verified_failed" }>

export type RootTaskHistoryNodeLesson = Readonly<{
  ordinalScope: "source_graph_local"
  advisoryOnly: true
  notCurrentEvidence: true
  nodeOrdinal: number
  criterionFailures: readonly CriterionFailure[]
  passedCriteria?: readonly RootTaskHistoryPassedCriterion[]
  successfulRepairs?: readonly SuccessfulRepair[]
  failedRepairOf?: FailedRepairOf
  executionFailureCategory?: TaskGraphExecutionFailureCategory
}>

type RootTaskHistoryCheckMatrix = readonly (readonly (RootTaskHistoryCheckDescriptor | undefined)[] | undefined)[]

const MAX_NODES = 8
const EXECUTION_FAILURE_CATEGORIES: ReadonlySet<string> = new Set([
  "execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid",
])
const REASONS = new Set<TaskGraphVerificationReasonCode>([
  "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid", "role_mismatch",
  "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous", "result_invalid",
  "result_ambiguous", "result_evidence_unbound",
])

function exactDataRecord(value: unknown, keys: string): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value), own = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || own.some(key => typeof key !== "string") || [...own].sort().join(",") !== keys) return undefined
    const descriptors = Object.getOwnPropertyDescriptors(value), result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of own as string[]) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result[key] = descriptor.value
    }
    return result
  } catch { return undefined }
}

function safeArray(value: unknown, maximum: number, allowEmpty: boolean): unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined
    const own = Reflect.ownKeys(value), length = Object.getOwnPropertyDescriptor(value, "length")?.value
    if (!Number.isSafeInteger(length) || Number(length) < (allowEmpty ? 0 : 1) || Number(length) > maximum || own.length !== Number(length) + 1) return undefined
    const result: unknown[] = []
    for (let index = 0; index < Number(length); index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined
      result.push(descriptor.value)
    }
    return result
  } catch { return undefined }
}

function ordinal(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_NODES }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= TASK_GRAPH_VERIFICATION_LIMITS.maxItems }
function percent(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 100 }
function executionFailureCategory(value: unknown): value is TaskGraphExecutionFailureCategory {
  return typeof value === "string" && EXECUTION_FAILURE_CATEGORIES.has(value)
}

/** Reconstructs only the closed public check descriptor; IDs and unknown fields are rejected. */
function parseRootTaskHistoryCheckDescriptor(value: unknown, expectedRole?: string): RootTaskHistoryCheckDescriptor | undefined {
  for (const kind of ["candidate_count_gte", "finding_count_gte", "evidence_count_gte"] as const) {
    const row = exactDataRecord(value, "kind,minimum,role")
    if (row?.kind !== kind || !count(row.minimum) || (expectedRole !== undefined && row.role !== expectedRole)) continue
    if (kind === "candidate_count_gte" && row.role === "scout") return { kind, role: "scout", minimum: row.minimum }
    if (kind === "finding_count_gte" && row.role === "analyst") return { kind, role: "analyst", minimum: row.minimum }
    if (kind === "evidence_count_gte" && (row.role === "scout" || row.role === "analyst")) {
      return { kind, role: row.role, minimum: row.minimum }
    }
  }
  for (const kind of ["all_candidates_have_evidence", "all_findings_have_evidence"] as const) {
    const row = exactDataRecord(value, "kind,minimumItems,role")
    if (row?.kind !== kind || !count(row.minimumItems) || (expectedRole !== undefined && row.role !== expectedRole)) continue
    if (kind === "all_candidates_have_evidence" && row.role === "scout") return { kind, role: "scout", minimumItems: row.minimumItems }
    if (kind === "all_findings_have_evidence" && row.role === "analyst") return { kind, role: "analyst", minimumItems: row.minimumItems }
  }
  const score = exactDataRecord(value, "aggregation,kind,minimumFindings,minimumScore,role")
  if (score?.kind === "reported_score_gte" && count(score.minimumFindings)
    && typeof score.minimumScore === "number" && Number.isFinite(score.minimumScore)
    && score.minimumScore >= 0 && score.minimumScore <= TASK_GRAPH_VERIFICATION_LIMITS.maxScore
    && (score.aggregation === "any" || score.aggregation === "all") && score.role === "analyst"
    && (expectedRole === undefined || score.role === expectedRole)) {
    return { kind: "reported_score_gte", role: "analyst", minimumScore: score.minimumScore,
      minimumFindings: score.minimumFindings, aggregation: score.aggregation }
  }
  const dependency = exactDataRecord(value, "dependencyNodeOrdinal,kind,role")
  if (dependency?.kind === "findings_from_scout_dependency" && ordinal(dependency.dependencyNodeOrdinal)
    && dependency.role === "analyst" && (expectedRole === undefined || dependency.role === expectedRole)) {
    return { kind: "findings_from_scout_dependency", role: "analyst", dependencyNodeOrdinal: dependency.dependencyNodeOrdinal }
  }
  const coverage = exactDataRecord(value, "dependencyNodeOrdinal,kind,minimumPercent,role")
  if (coverage?.kind === "findings_cover_scout_candidates_gte" && ordinal(coverage.dependencyNodeOrdinal)
    && percent(coverage.minimumPercent) && coverage.role === "analyst" && (expectedRole === undefined || expectedRole === coverage.role)) {
    return { kind: "findings_cover_scout_candidates_gte", role: "analyst", dependencyNodeOrdinal: coverage.dependencyNodeOrdinal, minimumPercent: coverage.minimumPercent }
  }
  return undefined
}

/** Parses the whole bounded graph before emitting checks with source-local dependency ordinals. */
export function describeValidatedRootTaskHistoryChecks(snapshotValue: unknown): RootTaskHistoryCheckMatrix | undefined {
  let snapshot
  try { snapshot = parseTaskGraphSnapshot(snapshotValue) } catch { return undefined }
  const ordinalByKey = new Map(snapshot.nodes.map((node, index) => [node.key, index + 1] as const))
  return snapshot.nodes.map(node => {
    const verification = node.verification
    if (node.verificationDisposition !== "typed" || !verification) return undefined
    return verification.criteria.map(criterion => {
      if (criterion.check.kind === "findings_from_scout_dependency" || criterion.check.kind === "findings_cover_scout_candidates_gte") {
        const sourceOrdinal = ordinalByKey.get(criterion.check.dependencyNodeKey)
        if (sourceOrdinal === undefined) return undefined
        return parseRootTaskHistoryCheckDescriptor(criterion.check.kind === "findings_from_scout_dependency"
          ? { kind: criterion.check.kind, role: verification.role, dependencyNodeOrdinal: sourceOrdinal }
          : { kind: criterion.check.kind, role: verification.role, dependencyNodeOrdinal: sourceOrdinal, minimumPercent: criterion.check.minimumPercent }, verification.role)
      }
      return parseRootTaskHistoryCheckDescriptor({ ...criterion.check, role: verification.role }, verification.role)
    })
  })
}

/** Strictly reconstructs the current and legacy privacy-safe lesson shapes. */
export function parseRootTaskHistoryNodeLesson(value: unknown, expectedRole?: string, expectedStatus?: string): RootTaskHistoryNodeLesson | undefined {
  const categoryShape = exactDataRecord(value, "advisoryOnly,criterionFailures,executionFailureCategory,nodeOrdinal,notCurrentEvidence,ordinalScope")
  const hasRepairs = exactDataRecord(value, "advisoryOnly,criterionFailures,nodeOrdinal,notCurrentEvidence,ordinalScope,successfulRepairs")
  const failedRepairShape = exactDataRecord(value, "advisoryOnly,criterionFailures,failedRepairOf,nodeOrdinal,notCurrentEvidence,ordinalScope")
  const passedShape = exactDataRecord(value, "advisoryOnly,criterionFailures,nodeOrdinal,notCurrentEvidence,ordinalScope,passedCriteria")
  const row = categoryShape ?? hasRepairs ?? failedRepairShape ?? passedShape ?? exactDataRecord(value, "advisoryOnly,criterionFailures,nodeOrdinal,notCurrentEvidence,ordinalScope")
  if (!row || row.ordinalScope !== "source_graph_local" || row.advisoryOnly !== true || row.notCurrentEvidence !== true || !ordinal(row.nodeOrdinal)) return undefined
  const hasExecutionFailureCategory = categoryShape !== undefined, hasPassedCriteria = passedShape !== undefined
  const category = hasExecutionFailureCategory && executionFailureCategory(row.executionFailureCategory)
    ? row.executionFailureCategory : undefined
  if (hasExecutionFailureCategory && (!category || (expectedStatus !== undefined && expectedStatus !== "failed"))) return undefined
  const failures = safeArray(row.criterionFailures, MAX_NODES, true)
  if (!failures || hasExecutionFailureCategory && failures.length !== 0) return undefined
  const criterionFailures: CriterionFailure[] = []
  const seenCriteria = new Set<number>()
  for (const failure of failures) {
    const item = exactDataRecord(failure, "criterionOrdinal,reasonCode,status")
      ?? exactDataRecord(failure, "check,criterionOrdinal,reasonCode,status")
    const previous = criterionFailures.at(-1), hasCheck = item !== undefined && Object.hasOwn(item, "check")
    const check = hasCheck ? parseRootTaskHistoryCheckDescriptor(item!.check, expectedRole) : undefined
    if (!item || !ordinal(item.criterionOrdinal) || (item.status !== "failed" && item.status !== "unverified")
      || typeof item.reasonCode !== "string" || !REASONS.has(item.reasonCode as TaskGraphVerificationReasonCode)
      || seenCriteria.has(item.criterionOrdinal) || (previous && previous.criterionOrdinal >= item.criterionOrdinal)
      || (hasCheck && !check)) return undefined
    seenCriteria.add(item.criterionOrdinal)
    criterionFailures.push({ criterionOrdinal: item.criterionOrdinal, status: item.status,
      reasonCode: item.reasonCode as TaskGraphVerificationReasonCode, ...(check ? { check } : {}) })
  }
  const passedCriteria = hasPassedCriteria
    ? parseRootTaskHistoryPassedCriteria(row.passedCriteria, expectedRole, parseRootTaskHistoryCheckDescriptor) : undefined
  if (hasPassedCriteria && (expectedStatus !== undefined && expectedStatus !== "completed" || failures.length !== 0 || !passedCriteria)) return undefined
  const successfulRepairs: SuccessfulRepair[] = []
  if (hasRepairs) {
    const repairs = safeArray(row.successfulRepairs, 1, false)
    if (!repairs) return undefined
    for (const repair of repairs) {
      const item = exactDataRecord(repair, "status,targetCriterionOrdinals,targetNodeOrdinal")
      const targets = item && safeArray(item.targetCriterionOrdinals, MAX_NODES, false)
      if (!item || item.status !== "passed" || !ordinal(item.targetNodeOrdinal) || item.targetNodeOrdinal >= row.nodeOrdinal
        || !targets || targets.some((target, index) => !ordinal(target) || (index > 0 && Number(target) <= Number(targets[index - 1])))) return undefined
      successfulRepairs.push({ targetNodeOrdinal: item.targetNodeOrdinal, targetCriterionOrdinals: targets as number[], status: "passed" })
    }
  }
  let failedRepairOf: FailedRepairOf | undefined
  if (failedRepairShape) {
    const item = exactDataRecord(row.failedRepairOf, "outcome,targetCriterionOrdinals,targetNodeOrdinal")
    const targets = item && safeArray(item.targetCriterionOrdinals, MAX_NODES, false)
    if (expectedStatus !== undefined && expectedStatus !== "failed" || !criterionFailures.some(item => item.status === "failed")
      || !item || item.outcome !== "verified_failed" || !ordinal(item.targetNodeOrdinal) || item.targetNodeOrdinal >= row.nodeOrdinal
      || !targets || targets.some((target, index) => !ordinal(target) || (index > 0 && Number(target) <= Number(targets[index - 1])))) return undefined
    failedRepairOf = { targetNodeOrdinal: item.targetNodeOrdinal, targetCriterionOrdinals: targets as number[], outcome: "verified_failed" }
  }
  if (!criterionFailures.length && !successfulRepairs.length && !failedRepairOf && !category && !passedCriteria?.length) return undefined
  return { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true, nodeOrdinal: row.nodeOrdinal,
    criterionFailures, ...(passedCriteria?.length ? { passedCriteria } : {}), ...(successfulRepairs.length ? { successfulRepairs } : {}),
    ...(failedRepairOf ? { failedRepairOf } : {}),
    ...(category ? { executionFailureCategory: category } : {}) }
}

/** Keeps only links and dependency descriptors whose source nodes survived final selection. */
export function filterRootTaskHistoryLessonsForEmittedNodes(
  lessons: readonly (RootTaskHistoryNodeLesson | undefined)[], retainedLessonOrdinals: readonly number[],
  emittedNodeOrdinals: readonly number[] = retainedLessonOrdinals,
): readonly (RootTaskHistoryNodeLesson | undefined)[] {
  const input = safeArray(lessons, MAX_NODES, true)
  if (!input) return []
  const omitted = input.map(() => undefined), retained = safeArray(retainedLessonOrdinals, MAX_NODES, true)
  const emitted = safeArray(emittedNodeOrdinals, MAX_NODES, true)
  if (!retained || !emitted || retained.some(value => !ordinal(value)) || emitted.some(value => !ordinal(value))
    || new Set(retained).size !== retained.length || new Set(emitted).size !== emitted.length
    || retained.some(value => !emitted.includes(value))) return omitted
  const selected = new Set(retained as number[]), emittedNodes = new Set(emitted as number[]), parsed = input.map((value, index) => {
    const lesson = value === undefined ? undefined : parseRootTaskHistoryNodeLesson(value)
    return lesson?.nodeOrdinal === index + 1 ? lesson : undefined
  })
  return parsed.map((lesson, index) => {
    if (!lesson || !selected.has(index + 1)) return undefined
    const criterionFailures = lesson.criterionFailures.map(failure => {
      if ((failure.check?.kind !== "findings_from_scout_dependency" && failure.check?.kind !== "findings_cover_scout_candidates_gte")
        || emittedNodes.has(failure.check.dependencyNodeOrdinal)) return failure
      return { criterionOrdinal: failure.criterionOrdinal, status: failure.status, reasonCode: failure.reasonCode }
    })
    const passedCriteria = filterRootTaskHistoryPassedCriteriaForEmittedNodes(lesson.passedCriteria, emittedNodes)
    const links = lesson.successfulRepairs?.filter(link => selected.has(link.targetNodeOrdinal)
      && parsed[link.targetNodeOrdinal - 1]?.criterionFailures && link.targetCriterionOrdinals.every(target =>
        parsed[link.targetNodeOrdinal - 1]!.criterionFailures.some(failure => failure.criterionOrdinal === target))) ?? []
    const failedRepairOf = lesson.failedRepairOf && selected.has(lesson.failedRepairOf.targetNodeOrdinal)
      && lesson.failedRepairOf.targetCriterionOrdinals.every(target =>
        parsed[lesson.failedRepairOf!.targetNodeOrdinal - 1]?.criterionFailures.some(failure => failure.criterionOrdinal === target && failure.status === "failed"))
      ? { ...lesson.failedRepairOf, targetCriterionOrdinals: [...lesson.failedRepairOf.targetCriterionOrdinals] } : undefined
    if (!criterionFailures.length && !passedCriteria?.length && !links.length && !failedRepairOf && !lesson.executionFailureCategory) return undefined
    return { ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: lesson.nodeOrdinal, criterionFailures, ...(passedCriteria?.length ? { passedCriteria } : {}), ...(links.length ? { successfulRepairs: links } : {}),
      ...(failedRepairOf ? { failedRepairOf } : {}),
      ...(lesson.executionFailureCategory ? { executionFailureCategory: lesson.executionFailureCategory } : {}) }
  })
}
