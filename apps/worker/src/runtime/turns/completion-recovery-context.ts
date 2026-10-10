import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_LIMITS, type TaskGraphVerificationReasonCode } from "../planning/task-graph-verification.js"
import { STEERING_RECONCILIATION_FEEDBACK } from "../subagents/steering-reconciliation-contract.js"

type TaskGraphRepairRecovery = Readonly<{ feedback: string; graphRevision: number | null }>
export const TASK_GRAPH_RECOVERY_REVISION: unique symbol = Symbol("task-graph-recovery-revision")

const TAG = "agent-harness.v2.task-graph-repair-recovery.v1:"
const SEED_PREFIX = "completion-recovery:task-graph:"
const LEGACY_TEXT_PREFIX = "Durable TaskGraph verification blocked completion:"
const VERSIONED_TEXT_PREFIX = "Durable TaskGraph verification blocked completion at graph revision "
const TASK_GRAPH_FEEDBACK = "TaskGraph required evidence is missing, invalid, failed, or unresolved; node and criterion fields are 1-based ordinals in the current TaskGraph. Replan or repair affected criteria before completing."
const GENERIC_FEEDBACK = "Durable TaskGraph verification was denied, but no validated graph revision is available. Inspect the refreshed current TaskGraph; no node or criterion ordinal from this denial is actionable."
const NATIVE_STATUS = /^Independent native verification is (failed|uncertain|pending|unavailable)\./
const NATIVE_ACTIONS = [
  "evidence_missing: gather current owned evidence.",
  "evidence_conflict: reconcile current owned sources and resolve contradictions.",
  "does_not_meet_criterion: revise the answer against the criterion.",
  "unsupported_claim: remove the claim or support it with current owned evidence.",
  "ambiguous: Resolve ambiguity from current owned evidence; identify missing user facts and seek clarification when available, otherwise state uncertainty.",
]
const NATIVE_FIXED = new Set([
  "Native TaskGraph work has no independent verification runtime.",
  "Independent native verification remained pending after immediate wake; resume through the durable wait.",
  "A new steering instruction arrived during verification. Re-read current input and prepare a fresh answer.",
  "Current native proof does not match the final content being persisted.",
  "Current native verification proof is stale or unavailable.",
])
const GENERIC_NATIVE_REPAIR = "Revise the candidate or obtain new current owned evidence before retrying."
const MAX_FEEDBACK = 512
const MAX_ENVELOPE = 2_048
type GateFeedbackCode = "legacy_unverified" | "verification_report" | "repair_receipt" | "repair_criterion"
type RepairFeedbackState = "missing" | "pending" | "terminal" | "unavailable" | "missing_receipt" | "rejected" | "invalid_receipt" | "invalid_report"
const GATE_FEEDBACK_CODES = { legacy_unverified: true, verification_report: true, repair_receipt: true, repair_criterion: true } satisfies Record<GateFeedbackCode, true>
const TASK_GRAPH_REASON_CODES = {
  criteria_met: true, criterion_not_met: true, reported_score_below_minimum: true, contract_invalid: true,
  projection_invalid: true, role_mismatch: true, canonical_evidence_missing: true, canonical_evidence_invalid: true,
  canonical_evidence_ambiguous: true, result_invalid: true, result_ambiguous: true, result_evidence_unbound: true,
  repair_target_unresolved: true,
} satisfies Record<TaskGraphVerificationReasonCode, true>
const REPAIR_FEEDBACK_STATES = {
  missing: true, pending: true, terminal: true, unavailable: true, missing_receipt: true, rejected: true,
  invalid_receipt: true, invalid_report: true,
} satisfies Record<RepairFeedbackState, true>
const TASK_GRAPH_DETAIL = new RegExp(`^ nodeOrdinal=([1-9][0-9]*)(?: criterionOrdinal=([1-9][0-9]*))? status=(?:failed|unverified) reasonCode=(?:${Object.keys(TASK_GRAPH_REASON_CODES).join("|")})(?: repair=(?:${Object.keys(REPAIR_FEEDBACK_STATES).join("|")}))?(?= |$)`)
const TASK_GRAPH_ISSUE = new RegExp(`^ issue=(?:${Object.keys(GATE_FEEDBACK_CODES).join("|")})`)
const TASK_GRAPH_OMISSION = /^ \(([1-9][0-9]*) feedback items omitted; inspect TaskGraph before retrying\.\)$/
const MAX_TASK_GRAPH_FEEDBACK_ITEMS = TASK_GRAPH_LIMITS.maxNodes * TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria * 2 + 1

function validRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function validTaskGraphOrdinal(value: string, maximum: number): boolean {
  const ordinal = Number(value)
  return Number.isSafeInteger(ordinal) && ordinal >= 1 && ordinal <= maximum
}

function validTaskGraphFeedback(feedback: string): boolean {
  if (!feedback.startsWith(TASK_GRAPH_FEEDBACK)) return false
  let rest = feedback.slice(TASK_GRAPH_FEEDBACK.length), issueCount = 0, detailCount = 0
  const issue = TASK_GRAPH_ISSUE.exec(rest)
  if (issue) { issueCount = 1; rest = rest.slice(issue[0].length) }
  for (;;) {
    const detail = TASK_GRAPH_DETAIL.exec(rest)
    if (!detail) break
    if (!validTaskGraphOrdinal(detail[1]!, TASK_GRAPH_LIMITS.maxNodes)
      || (detail[2] !== undefined && !validTaskGraphOrdinal(detail[2], TASK_GRAPH_VERIFICATION_LIMITS.maxCriteria))) return false
    detailCount += 1
    rest = rest.slice(detail[0].length)
  }
  const presentCount = issueCount + detailCount
  if (presentCount + (rest ? 1 : 0) > MAX_TASK_GRAPH_FEEDBACK_ITEMS) return false
  if (!rest) return true
  const omission = TASK_GRAPH_OMISSION.exec(rest)
  if (!omission || presentCount === 0) return false
  const omittedCount = Number(omission[1])
  return Number.isSafeInteger(omittedCount) && presentCount + omittedCount <= MAX_TASK_GRAPH_FEEDBACK_ITEMS
}

function taskGraphSeed(seed: StepContextSnapshot["system"][number]): boolean {
  return seed.id.startsWith(SEED_PREFIX) || (seed.id.startsWith("completion-recovery:")
    && typeof seed.content === "string" && seed.content.startsWith(LEGACY_TEXT_PREFIX))
}

function safeNativeFeedback(value: string): string | null {
  if (NATIVE_FIXED.has(value)) return value
  const match = NATIVE_STATUS.exec(value)
  if (!match) return null
  let rest = value.slice(match[0].length), actions = ""
  for (let mask = 1; mask < 1 << NATIVE_ACTIONS.length; mask += 1) {
    const expected = ` Actions: ${NATIVE_ACTIONS.filter((_, index) => (mask & (1 << index)) !== 0).join(" ")}`
    if (expected.length > actions.length && rest.startsWith(expected)) actions = expected
  }
  rest = rest.slice(actions.length)
  if (rest && rest !== ` ${GENERIC_NATIVE_REPAIR}`
    && !/^(?: target=[A-Za-z0-9._:-]{1,128} criterion=[A-Za-z0-9._:-]{1,128} status=(?:failed|uncertain) reason=(?:does_not_meet_criterion|evidence_missing|evidence_conflict|unsupported_claim|ambiguous))*$/.test(rest)) return null
  const generic = ` ${GENERIC_NATIVE_REPAIR}`
  if (rest === generic) rest = generic
  return `${match[0]}${actions}${rest === generic ? generic : ""}`
}

function decodeRecovery(value: string): TaskGraphRepairRecovery | null {
  if (!value.startsWith(TAG) || value.length > MAX_ENVELOPE) return null
  try {
    const parsed: unknown = JSON.parse(value.slice(TAG.length))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    if (Object.keys(record).sort().join(",") !== "feedback,graphRevision" || typeof record.feedback !== "string" || record.feedback.length > MAX_FEEDBACK) return null
    if (record.graphRevision !== null && !validRevision(record.graphRevision)) return null
    if (validTaskGraphFeedback(record.feedback)) return { feedback: record.feedback, graphRevision: record.graphRevision }
    const native = record.graphRevision === null ? safeNativeFeedback(record.feedback) : null
    return native ? { feedback: native, graphRevision: null } : null
  } catch {
    return null
  }
}

export function tagTaskGraphRepairRecovery(feedback: string, graphRevision: number | null): string {
  const recovery: TaskGraphRepairRecovery = {
    feedback: typeof feedback === "string" && feedback.length <= MAX_FEEDBACK ? feedback : "",
    graphRevision: graphRevision === null || validRevision(graphRevision) ? graphRevision : null,
  }
  return `${TAG}${JSON.stringify(recovery)}`
}

export function applyCompletionRecovery(snapshot: StepContextSnapshot, stepId: string, feedback: string): StepContextSnapshot {
  if (feedback === STEERING_RECONCILIATION_FEEDBACK) {
    return { ...snapshot, system: [...snapshot.system, {
      id: `completion-recovery:${stepId}`,
      content: `A server-owned completion requirement blocked this answer: ${feedback} Review the current user instructions and use available tools to resolve the stated blocker before answering again.`,
    }] }
  }
  const recovery = typeof feedback === "string" ? decodeRecovery(feedback) : null
  const content = recovery && recovery.graphRevision !== null
    ? `${VERSIONED_TEXT_PREFIX}${recovery.graphRevision}: ${recovery.feedback} These ordinals apply only to this graph revision. Replan or repair the affected criteria, then verify again.`
    : recovery && recovery.feedback.startsWith("Independent native verification is ")
      ? `Native verification recovery: ${recovery.feedback} Repair against current owned evidence. No prior node or criterion ordinal is actionable.`
    : recovery && NATIVE_FIXED.has(recovery.feedback)
      ? `Native verification recovery: ${recovery.feedback} Inspect the current TaskGraph before retrying; no prior ordinal is actionable.`
    : GENERIC_FEEDBACK
  const suffix = recovery && recovery.graphRevision !== null ? String(recovery.graphRevision)
    : recovery && (recovery.feedback.startsWith("Independent native verification is ") || NATIVE_FIXED.has(recovery.feedback)) ? "native" : "unversioned"
  return {
    ...snapshot,
    system: [...snapshot.system.filter(seed => !taskGraphSeed(seed)), { id: `${SEED_PREFIX}${suffix}`, content }],
  }
}

const VERSIONED_TEXT_SUFFIX = " These ordinals apply only to this graph revision. Replan or repair the affected criteria, then verify again."
const NATIVE_TEXT_PREFIX = "Native verification recovery: "
const NATIVE_TYPED_TEXT_SUFFIX = " Repair against current owned evidence. No prior node or criterion ordinal is actionable."
const NATIVE_FIXED_TEXT_SUFFIX = " Inspect the current TaskGraph before retrying; no prior ordinal is actionable."

function isCurrentTaskGraphRepairSeed(seed: StepContextSnapshot["system"][number], revision: number): boolean {
  if (typeof seed.content !== "string" || seed.content.length > MAX_ENVELOPE || !validRevision(revision)) return false
  const prefix = `${VERSIONED_TEXT_PREFIX}${revision}: `
  if (!seed.content.startsWith(prefix) || !seed.content.endsWith(VERSIONED_TEXT_SUFFIX)) return false
  const feedback = seed.content.slice(prefix.length, -VERSIONED_TEXT_SUFFIX.length)
  return feedback.length <= MAX_FEEDBACK && validTaskGraphFeedback(feedback)
}

function isNativeRepairSeed(content: unknown): boolean {
  if (typeof content !== "string" || content.length > MAX_ENVELOPE || !content.startsWith(NATIVE_TEXT_PREFIX)) return false
  const typedFeedback = content.slice(NATIVE_TEXT_PREFIX.length, -NATIVE_TYPED_TEXT_SUFFIX.length)
  if (content.endsWith(NATIVE_TYPED_TEXT_SUFFIX)
    && typedFeedback.startsWith("Independent native verification is ")
    && safeNativeFeedback(typedFeedback) === typedFeedback) return true
  const fixedFeedback = content.slice(NATIVE_TEXT_PREFIX.length, -NATIVE_FIXED_TEXT_SUFFIX.length)
  return content.endsWith(NATIVE_FIXED_TEXT_SUFFIX) && NATIVE_FIXED.has(fixedFeedback)
}

export function retireStaleTaskGraphRepair(snapshot: StepContextSnapshot, trustedGraphRevision: number): StepContextSnapshot {
  const currentId = `${SEED_PREFIX}${trustedGraphRevision}`
  let latestCurrent = -1, latestNative = -1, latestUnversioned = -1
  snapshot.system.forEach((seed, index) => {
    if (seed.id === currentId && isCurrentTaskGraphRepairSeed(seed, trustedGraphRevision)) latestCurrent = index
    if (seed.id === `${SEED_PREFIX}native` && isNativeRepairSeed(seed.content)) latestNative = index
    if (seed.id === `${SEED_PREFIX}unversioned` && seed.content === GENERIC_FEEDBACK) latestUnversioned = index
  })
  return {
    ...snapshot,
    system: snapshot.system.filter((seed, index) => {
      if (seed.id.startsWith("completion-recovery:") && typeof seed.content === "string" && seed.content.startsWith(LEGACY_TEXT_PREFIX)) return false
      if (!seed.id.startsWith(SEED_PREFIX)) return true
      const suffix = seed.id.slice(SEED_PREFIX.length)
      if (suffix === "native") return isNativeRepairSeed(seed.content) && index === latestNative
      if (suffix === "unversioned") return seed.content === GENERIC_FEEDBACK && index === latestUnversioned
      const revision = suffix === String(trustedGraphRevision) && validRevision(Number(suffix)) ? Number(suffix) : null
      return revision !== null && revision === trustedGraphRevision
        && isCurrentTaskGraphRepairSeed(seed, revision) && index === latestCurrent
    }),
  }
}
