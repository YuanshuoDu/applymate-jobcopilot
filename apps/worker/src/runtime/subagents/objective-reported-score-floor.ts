import type { TaskGraphVerificationCheck } from "../planning/task-graph-verification-contract.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import type { TaskGraphFinalSummary } from "./task-graph-final-summary.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { currentTaskGraph } from "./task-graph-pg-current-node.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { ObjectiveTailorWaveSlotStatus } from "../canonical-objective-tailor-wave-completion.js"

export const OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA = "agent-harness.v2.objective-tailor-final-outcome.v1" as const
const FINAL_SLOT_STATUSES = ["ready", "needs_revision", "rejected", "stale", "failed"] as const
type FinalSlotStatus = Exclude<ObjectiveTailorWaveSlotStatus, "pending">

export type ObjectiveReportedScoreFloor = Readonly<{ status: "not_requested" | "unavailable" }>
  | Readonly<{ status: "complete"; source: "turn_input"; minimumScore: number; qualifyingJobCount: number }>
  | Readonly<{ status: "complete"; source: "analyst_verification"; minimumScore: number; minimumFindings: number; aggregation: "any" | "all"; qualifyingJobCount: number }>
export type ObjectiveTailorFinalOutcomeProjection = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA
  graphRevision: number
  rootAttemptCount: number
  graphDigest: string
  sourceNodeCount: number
  sourceGraphDigest: string
  sourceStatusDigest: string
  reportedScoreFloor?: ObjectiveReportedScoreFloor
  slots: readonly Readonly<{ ordinal: number; status: FinalSlotStatus; evidenceDigest: string }>[]
}>
type ScoreCheck = Extract<TaskGraphVerificationCheck, { kind: "reported_score_gte" }>
const UNAVAILABLE: ObjectiveReportedScoreFloor = { status: "unavailable" }

/** Counts distinct analyzed Jobs only when every effective typed Analyst supports the same passed floor. */
export function deriveObjectiveReportedScoreFloor(input: Readonly<{
  sourceNodes: readonly StoredTaskGraphNode[]
  currentGraph?: TaskGraphCurrentState
  effectiveAnalystTaskIds: readonly string[]
  summary: TaskGraphFinalSummary
  requestedFloor?: number
}>): ObjectiveReportedScoreFloor {
  try { return derive(input) } catch { return UNAVAILABLE }
}

export function deriveObjectiveReportedScoreFloorFromLoaded(input: Readonly<{
  loaded: LoadedGraph; sourceNodes: readonly StoredTaskGraphNode[]
  effectiveAnalystTaskIds: readonly string[]; summary: TaskGraphFinalSummary
  requestedFloor?: number
}>): ObjectiveReportedScoreFloor {
  let currentGraph: TaskGraphCurrentState | undefined
  try { currentGraph = currentTaskGraph(input.loaded) } catch { /* Invalid verification projection means unavailable. */ }
  return deriveObjectiveReportedScoreFloor({ sourceNodes: input.sourceNodes,
    effectiveAnalystTaskIds: input.effectiveAnalystTaskIds, summary: input.summary, currentGraph, requestedFloor: input.requestedFloor })
}

export function parseObjectiveReportedScoreFloor(value: unknown): ObjectiveReportedScoreFloor | null {
  const row = exactRecord(value)
  if (!row) return null
  if (row.status === "not_requested" || row.status === "unavailable") return exactKeys(row, "status") ? { status: row.status } : null
  const old = exactKeys(row, "aggregation,minimumFindings,minimumScore,qualifyingJobCount,status") && row.status === "complete"
  const derived = exactKeys(row, "aggregation,minimumFindings,minimumScore,qualifyingJobCount,source,status")
    && row.status === "complete" && row.source === "analyst_verification"
  if (derived || old) return typeof row.minimumScore === "number" && Number.isFinite(row.minimumScore) && row.minimumScore >= 0 && row.minimumScore <= 10
    && Number.isSafeInteger(row.minimumFindings) && Number(row.minimumFindings) > 0
    && (row.aggregation === "any" || row.aggregation === "all")
    && Number.isSafeInteger(row.qualifyingJobCount) && Number(row.qualifyingJobCount) >= 0
    ? { status: "complete", source: "analyst_verification", minimumScore: row.minimumScore, minimumFindings: Number(row.minimumFindings),
      aggregation: row.aggregation, qualifyingJobCount: Number(row.qualifyingJobCount) } : null
  return exactKeys(row, "minimumScore,qualifyingJobCount,source,status") && row.status === "complete" && row.source === "turn_input"
    && typeof row.minimumScore === "number" && Number.isFinite(row.minimumScore) && row.minimumScore >= 0 && row.minimumScore <= 10
    && Number.isSafeInteger(row.qualifyingJobCount) && Number(row.qualifyingJobCount) >= 0
    ? { status: "complete", source: "turn_input", minimumScore: row.minimumScore,
      qualifyingJobCount: Number(row.qualifyingJobCount) } : null
}

/** Accepts the exact historical private projection without a floor as unavailable. */
export function parseObjectiveReportedScoreFloorProjection(
  row: Record<string, unknown>, legacyKeys: string,
): ObjectiveReportedScoreFloor | null {
  if (exactKeys(row, legacyKeys)) return { status: "unavailable" }
  return exactKeys(row, `${legacyKeys},reportedScoreFloor`)
    ? parseObjectiveReportedScoreFloor(row.reportedScoreFloor) : null
}

export function parseObjectiveTailorFinalOutcome(value: unknown): ObjectiveTailorFinalOutcomeProjection | null {
  try { return parseFinalOutcome(value) } catch { return null }
}

function parseFinalOutcome(value: unknown): ObjectiveTailorFinalOutcomeProjection | null {
  const row = exactRecord(value)
  const legacyKeys = "graphDigest,graphRevision,rootAttemptCount,schemaVersion,slots,sourceGraphDigest,sourceNodeCount,sourceStatusDigest"
  const scoreFloor = row ? parseObjectiveReportedScoreFloorProjection(row, legacyKeys) : null
  if (!row || !scoreFloor || row.schemaVersion !== OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA
    || !integer(row.graphRevision, 1, 2_147_483_646) || !integer(row.rootAttemptCount, 1, 2_147_483_646)
    || !digest(row.graphDigest) || !integer(row.sourceNodeCount, 2, 8) || !digest(row.sourceGraphDigest)
    || !digest(row.sourceStatusDigest) || !dense(row.slots, 8) || row.slots.length < 1) return null
  const slots: ObjectiveTailorFinalOutcomeProjection["slots"][number][] = []
  for (let index = 0; index < row.slots.length; index += 1) {
    const slot = exactRecord(row.slots[index])
    if (!slot || !exactKeys(slot, "evidenceDigest,ordinal,status") || slot.ordinal !== index + 1
      || typeof slot.status !== "string" || !FINAL_SLOT_STATUSES.includes(slot.status as FinalSlotStatus)
      || !digest(slot.evidenceDigest)) return null
    slots.push({ ordinal: index + 1, status: slot.status as FinalSlotStatus, evidenceDigest: slot.evidenceDigest })
  }
  return {
    schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
    graphRevision: row.graphRevision as number,
    rootAttemptCount: row.rootAttemptCount as number,
    graphDigest: row.graphDigest,
    sourceNodeCount: row.sourceNodeCount as number,
    sourceGraphDigest: row.sourceGraphDigest,
    sourceStatusDigest: row.sourceStatusDigest,
    reportedScoreFloor: scoreFloor,
    slots,
  }
}

function derive(input: Parameters<typeof deriveObjectiveReportedScoreFloor>[0]): ObjectiveReportedScoreFloor {
  const { sourceNodes, currentGraph, effectiveAnalystTaskIds, summary } = input
  const explicit = input.requestedFloor !== undefined
  if (sourceNodes.length < 2 || sourceNodes.length > 8
    || new Set(effectiveAnalystTaskIds).size !== effectiveAnalystTaskIds.length
    || summary.graphRevision < 1 || !Number.isSafeInteger(summary.graphRevision)) return UNAVAILABLE
  const analysts = sourceNodes.filter(node => node.templateId === "analyst" && effectiveAnalystTaskIds.includes(node.taskId))
  if (analysts.length !== effectiveAnalystTaskIds.length || analysts.some(node => node.verificationDisposition !== "typed"
    || node.verification?.role !== "analyst")) return UNAVAILABLE
  const criteriaByAnalyst = analysts.map(node => node.verification!.criteria.filter(item => item.check.kind === "reported_score_gte"))
  let floor: Pick<ScoreCheck, "minimumScore" | "minimumFindings" | "aggregation">
  if (explicit) {
    if (typeof input.requestedFloor !== "number" || !Number.isFinite(input.requestedFloor) || input.requestedFloor < 0 || input.requestedFloor > 10) return UNAVAILABLE
    floor = { minimumScore: input.requestedFloor, minimumFindings: 1, aggregation: "any" }
  } else {
    if (!criteriaByAnalyst.some(criteria => criteria.length > 0)) return { status: "not_requested" }
    if (!analysts.length || criteriaByAnalyst.some(criteria => criteria.length === 0)) return UNAVAILABLE
    const checks = criteriaByAnalyst.flatMap(criteria => criteria.map(item => item.check as ScoreCheck))
    const requested = checks[0]!
    if (!validFloor(requested) || checks.some(check => !validFloor(check) || !sameFloor(requested, check))) return UNAVAILABLE
    floor = requested
  }
  if (!currentGraph || currentGraph.revision !== summary.graphRevision || currentGraph.nodes.length < sourceNodes.length) return UNAVAILABLE
  const currentNodes = currentGraph.nodes.slice(0, sourceNodes.length)
  if (currentNodes.some((node, index) => node.key !== sourceNodes[index]?.key
    || node.taskId !== sourceNodes[index]?.taskId || node.templateId !== sourceNodes[index]?.templateId)) return UNAVAILABLE
  const currentByKey = new Map(currentNodes.map(node => [node.key, node] as const))
  const taskIds = new Set(analysts.map(node => node.taskId))
  const outcomes = summary.taskOutcomes.filter(item => taskIds.has(item.taskId))
  if (outcomes.length !== analysts.length || new Set(outcomes.map(item => item.taskId)).size !== analysts.length
    || outcomes.some(item => item.role !== "analyst" || item.taskStatus !== "completed" || item.resultState !== "valid" || item.roleResultStatus !== "completed")) return UNAVAILABLE
  for (const analyst of analysts) {
    const current = currentByKey.get(analyst.key), report = current?.verificationReport, verification = current?.verification
    if (!current || current.taskId !== analyst.taskId || current.templateId !== "analyst" || current.status !== "completed"
      || JSON.stringify(verification) !== JSON.stringify(analyst.verification) || report?.status !== "passed"
      || report.criteria.length !== analyst.verification!.criteria.length
      || report.criteria.some((item, index) => item.criterionId !== analyst.verification!.criteria[index]?.id || item.status !== "passed")) return UNAVAILABLE
    for (const item of criteriaByAnalyst[analysts.indexOf(analyst)]!) {
      if (!report.criteria.some(result => result.criterionId === item.id && result.status === "passed")) return UNAVAILABLE
    }
  }
  const analyzed = summary.analyzedJobs, knownCount = summary.counts.analyzedJobs
  if (knownCount.coverage !== "complete" || !Number.isSafeInteger(knownCount.knownCount) || knownCount.knownCount! < 0
    || !Array.isArray(analyzed) || analyzed.length !== knownCount.knownCount || !analyzed.every(job => typeof job.jobId === "string" && job.jobId.length > 0
      && Array.isArray(job.findings) && job.findings.length > 0) || new Set(analyzed.map(job => job.jobId)).size !== analyzed.length) return UNAVAILABLE
  const scoresByTask = new Map<string, number[]>()
  const scoresByJob = new Map<string, boolean[]>()
  for (const job of analyzed) for (const finding of job.findings) {
    if (!taskIds.has(finding.taskId) || typeof finding.score !== "number" || !Number.isFinite(finding.score) || finding.score < 0 || finding.score > 10) return UNAVAILABLE
    const taskScores = scoresByTask.get(finding.taskId) ?? []
    taskScores.push(finding.score)
    scoresByTask.set(finding.taskId, taskScores)
    const scores = scoresByJob.get(job.jobId) ?? []
    scores.push(finding.score >= floor.minimumScore)
    scoresByJob.set(job.jobId, scores)
  }
  for (const analyst of analysts) {
    const scores = scoresByTask.get(analyst.taskId) ?? []
    const meets = (score: number) => score >= floor.minimumScore
    if (!explicit && (scores.length < floor.minimumFindings
      || !(floor.aggregation === "any" ? scores.some(meets) : scores.every(meets)))) return UNAVAILABLE
  }
  let qualifyingJobCount = 0
  for (const job of analyzed) {
    const sides = new Set(scoresByJob.get(job.jobId))
    if (sides.size !== 1) return UNAVAILABLE
    if (sides.has(true)) qualifyingJobCount += 1
  }
  return explicit ? { status: "complete", source: "turn_input", minimumScore: floor.minimumScore, qualifyingJobCount }
    : { status: "complete", source: "analyst_verification", minimumScore: floor.minimumScore,
      minimumFindings: floor.minimumFindings, aggregation: floor.aggregation, qualifyingJobCount }
}

function validFloor(value: ScoreCheck): boolean {
  return Number.isFinite(value.minimumScore) && value.minimumScore >= 0 && value.minimumScore <= 10
    && Number.isSafeInteger(value.minimumFindings) && value.minimumFindings > 0
    && (value.aggregation === "any" || value.aggregation === "all")
}
function sameFloor(left: ScoreCheck, right: ScoreCheck): boolean {
  return left.minimumScore === right.minimumScore && left.minimumFindings === right.minimumFindings && left.aggregation === right.aggregation
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function integer(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
function dense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}
function exactRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    if (!([Object.prototype, null].includes(Object.getPrototypeOf(value)) && Reflect.ownKeys(value).every(key => typeof key === "string"))) return null
    for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return null }
    return value as Record<string, unknown>
  } catch { return null }
}
function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  const expected = keys.split(","), actual = Reflect.ownKeys(value)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key))
}
