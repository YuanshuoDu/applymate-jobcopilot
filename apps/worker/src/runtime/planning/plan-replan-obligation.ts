import { Buffer } from "node:buffer"

import { parsePlanRevisionEvent } from "./plan-revision-receipt.js"
import { inspectJoinFailureEvidence } from "./plan-replan-signal.js"
import { isPlainJsonObject } from "./goal-plan-contract.js"

const MAX_OBSERVATIONS = 256
const MAX_LOCAL_ID = 128
const MAX_ID = 256
const MAX_TASKS = 8
const MAX_FEEDBACK_ATTEMPTS = 2
const FEEDBACK_PREFIX = "plan-replan-feedback:"
const FEEDBACK_TEXT = "Propose exactly one new accepted plan based on the failed plan revision before continuing."
const SIGNAL_KEYS = ["kind", "localId", "status", "dependsOn", "reason", "failedTaskIds"]
const PROJECTION_KEYS = ["kind", "planCallId", "goalRevision", "planRevision", "basedOnPlanRevision", "proposalHash"]
const PROJECTION_KEYS_WITHOUT_HASH = PROJECTION_KEYS.filter(key => key !== "proposalHash")
const RESULT_KEYS = ["kind", "localId", "commandKind", "dependsOn", "status", "errorCode", "output"]
const FORBIDDEN_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])

export type ReplanObligation = {
  readonly id: string
  readonly sourceObservationId: string
  readonly planCallId: string
  readonly goalRevision: number
  readonly planRevision: number
  readonly joinLocalId: string
  readonly failedTaskIds: readonly string[]
}

export type ReplanObligationResult =
  | { readonly kind: "none" }
  | { readonly kind: "active"; readonly obligation: ReplanObligation }
  | { readonly kind: "invalid"; readonly reason: string }

export type ReplanFeedbackObservation = { readonly id: string; readonly content: Record<string, unknown> }

type Observation = { readonly id: string; readonly content: unknown }
type Projection = ReturnType<typeof parsePlanRevisionEvent>
type SignalValue = { readonly callId: string; readonly joinLocalId: string; readonly failedTaskIds: readonly string[]; readonly dependsOn: readonly string[] }

function row(value: unknown): Record<string, unknown> | null { return isPlainJsonObject(value) ? value : null }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) }
function id(value: unknown, limit = MAX_ID): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit }
function integer(value: unknown, minimum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum }
function strings(value: unknown, limit: number, unique = true): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_TASKS && value.every(item => id(item, limit)) && (!unique || new Set(value).size === value.length)
}
function same(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function sorted(value: readonly string[]): boolean { return value.every((item, index) => index === 0 || compare(value[index - 1]!, item) < 0) }
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isPlainJsonObject(value)) return `{${Object.keys(value).sort(compare).map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}
function foreign(value: unknown, allowed = new Set<string>(), seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false
  if (Array.isArray(value)) { seen.add(value); const found = value.some(item => foreign(item, allowed, seen)); seen.delete(value); return found }
  if (!isPlainJsonObject(value)) return true
  if (Object.keys(value).some(key => FORBIDDEN_KEYS.has(key) && !allowed.has(key))) return true
  seen.add(value); const found = Object.values(value).some(item => foreign(item, allowed, seen)); seen.delete(value); return found
}

function projection(observation: Observation): { readonly value: NonNullable<Projection>; readonly invalid: boolean } | null {
  const content = row(observation.content)
  if (content?.kind !== "plan_revision") return null
  if ((!exact(content, PROJECTION_KEYS) && !exact(content, PROJECTION_KEYS_WITHOUT_HASH)) || !id(observation.id) || !observation.id.startsWith("plan-revision:")) return { value: undefined as never, invalid: true }
  const { kind: _kind, ...metadata } = content
  const parsed = parsePlanRevisionEvent(metadata)
  if (!parsed || observation.id !== `plan-revision:${parsed.planCallId}`) return { value: undefined as never, invalid: true }
  return { value: parsed, invalid: false }
}

function signal(observation: Observation): { readonly value: { callId: string; joinLocalId: string; failedTaskIds: readonly string[]; dependsOn: readonly string[] }; readonly invalid: boolean } | null {
  const content = row(observation.content)
  if (content?.kind !== "plan_control" || content.status !== "replan_required") return null
  if (!exact(content, SIGNAL_KEYS) || !id(observation.id) || !observation.id.startsWith("plan-control:") || content.reason !== "child_failure" || !strings(content.dependsOn, MAX_LOCAL_ID) || !strings(content.failedTaskIds, MAX_ID) || !sorted(content.failedTaskIds)) return { value: undefined as never, invalid: true }
  if (typeof content.localId !== "string" || !content.localId.endsWith(":replan") || !id(content.localId, MAX_LOCAL_ID)) return { value: undefined as never, invalid: true }
  const suffix = `:${content.localId}`
  const callId = observation.id.slice("plan-control:".length, observation.id.length - suffix.length)
  const joinLocalId = content.localId.slice(0, -":replan".length)
  if (!id(callId) || !id(joinLocalId, MAX_LOCAL_ID) || observation.id !== `plan-control:${callId}:${content.localId}`) return { value: undefined as never, invalid: true }
  return { value: { callId, joinLocalId, failedTaskIds: content.failedTaskIds, dependsOn: content.dependsOn }, invalid: false }
}

function joinMatches(observations: readonly Observation[], item: SignalValue): boolean {
  const matches = observations.filter(observation => observation.id === `plan-result:${item.callId}:${item.joinLocalId}`)
  if (matches.length !== 1) return false
  const content = row(matches[0]!.content)
  if (!content || !exact(content, RESULT_KEYS) || content.kind !== "plan_command" || content.localId !== item.joinLocalId || content.commandKind !== "join" || content.status !== "completed" || content.errorCode !== null || !strings(content.dependsOn, MAX_LOCAL_ID) || !same(content.dependsOn, item.dependsOn)) return false
  const output = row(content.output)
  if (!output || foreign(output, new Set(["taskId"]))) return false
  const taskIds = output.taskIds
  const targetIds = output.targetTaskIds
  if (taskIds !== undefined && targetIds !== undefined && (!strings(taskIds, MAX_ID) || !strings(targetIds, MAX_ID) || !same([...taskIds].sort(compare), [...targetIds].sort(compare))) || (!strings(taskIds ?? targetIds, MAX_ID))) return false
  const expected = (taskIds ?? targetIds) as readonly string[]
  if (!Array.isArray(output.matchedTaskIds) || !output.matchedTaskIds.every(value => id(value, MAX_ID)) || new Set(output.matchedTaskIds).size !== output.matchedTaskIds.length || !output.matchedTaskIds.every(value => expected.includes(value))) return false
  if (output.status === "ready" && !same([...output.matchedTaskIds].sort(compare), [...expected].sort(compare))) return false
  const inspection = inspectJoinFailureEvidence(output, expected)
  return inspection.valid && same(inspection.failedTaskIds, item.failedTaskIds)
}

function feedbackId(turnId: string, obligation: ReplanObligation, attempt: number): string { return `${FEEDBACK_PREFIX}${turnId}:${obligation.planCallId}:${obligation.planRevision}:${attempt}` }

function validObligation(value: ReplanObligation): boolean {
  return Boolean(value) && typeof value === "object" && id(value.id) && id(value.sourceObservationId) && id(value.planCallId) && id(value.joinLocalId, MAX_LOCAL_ID) && integer(value.goalRevision, 1) && integer(value.planRevision, 1) && strings(value.failedTaskIds, MAX_ID) && sorted(value.failedTaskIds)
}

export function buildReplanFeedback(turnId: string, obligation: ReplanObligation, attempt: number): ReplanFeedbackObservation | null {
  if (!id(turnId) || !validObligation(obligation) || !integer(attempt, 1) || attempt > MAX_FEEDBACK_ATTEMPTS) return null
  const observation = { id: feedbackId(turnId, obligation, attempt), content: { kind: "plan_replan_feedback", status: "replan_required", attempt, obligationId: obligation.id, planCallId: obligation.planCallId, goalRevision: obligation.goalRevision, planRevision: obligation.planRevision, failedTaskIds: [...obligation.failedTaskIds], feedback: FEEDBACK_TEXT } }
  return id(observation.id) && Buffer.byteLength(JSON.stringify(observation), "utf8") <= 8 * 1024 ? observation : null
}

export function replanFeedbackAttempts(observations: readonly Observation[], turnId: string, obligation: ReplanObligation): { readonly valid: true; readonly highest: number } | { readonly valid: false } {
  if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS || observations.some(observation => !observation || typeof observation.id !== "string" || !id(observation.id))) return { valid: false }
  if (!id(turnId) || !validObligation(obligation)) return { valid: false }
  const prefix = `${FEEDBACK_PREFIX}${turnId}:${obligation.planCallId}:${obligation.planRevision}:`
  const matched = observations.filter(observation => observation.id.startsWith(prefix))
  const attempts = new Set<number>()
  for (const observation of matched) {
    const parsedAttempt = Number(observation.id.slice(prefix.length))
    if (!integer(parsedAttempt, 1) || parsedAttempt > MAX_FEEDBACK_ATTEMPTS || attempts.has(parsedAttempt)) return { valid: false }
    const expected = buildReplanFeedback(turnId, obligation, parsedAttempt)
    try {
      if (!expected || stable(expected.content) !== stable(observation.content)) return { valid: false }
    } catch {
      return { valid: false }
    }
    attempts.add(parsedAttempt)
  }
  return { valid: true, highest: Math.max(0, ...attempts) }
}

export function deriveReplanObligation(input: { readonly observations: readonly Observation[]; readonly expectedGoalRevision: number }): ReplanObligationResult {
  if (!input || typeof input !== "object" || !Array.isArray(input.observations) || input.observations.length > MAX_OBSERVATIONS || input.observations.some(observation => !observation || typeof observation.id !== "string" || !id(observation.id)) || !integer(input.expectedGoalRevision, 1)) return { kind: "invalid", reason: "invalid_replan_scope" }
  const projections = new Map<string, NonNullable<Projection>>()
  const signals: Array<{ observationId: string; callId: string; joinLocalId: string; failedTaskIds: readonly string[]; dependsOn: readonly string[] }> = []
  for (const observation of input.observations) {
    const parsedProjection = projection(observation)
    if (parsedProjection?.invalid) return { kind: "invalid", reason: "invalid_plan_projection" }
    if (parsedProjection && projections.has(parsedProjection.value.planCallId)) return { kind: "invalid", reason: "duplicate_plan_projection" }
    if (parsedProjection) projections.set(parsedProjection.value.planCallId, parsedProjection.value)
    const parsedSignal = signal(observation)
    if (parsedSignal?.invalid) return { kind: "invalid", reason: "invalid_replan_signal" }
    if (parsedSignal) signals.push({ observationId: observation.id, ...parsedSignal.value })
  }
  if (signals.length === 0) return { kind: "none" }
  const revisions = new Set<string>()
  for (const plan of projections.values()) {
    if (plan.goalRevision !== input.expectedGoalRevision) continue
    const key = `${plan.goalRevision}:${plan.planRevision}`
    if (revisions.has(key)) return { kind: "invalid", reason: "conflicting_plan_revision" }
    revisions.add(key)
  }
  const orderedPlans = [...projections.values()].filter(plan => plan.goalRevision === input.expectedGoalRevision).sort((left, right) => left.planRevision - right.planRevision)
  let previousRevision: number | null = null
  for (const plan of orderedPlans) {
    if (plan.planRevision !== (previousRevision === null ? 1 : previousRevision + 1) || plan.basedOnPlanRevision !== previousRevision) return { kind: "invalid", reason: "non_contiguous_plan_revision" }
    previousRevision = plan.planRevision
  }
  const active: ReplanObligation[] = []
  for (const item of signals) {
    if (signals.filter(candidate => candidate.observationId === item.observationId).length !== 1) return { kind: "invalid", reason: "duplicate_replan_signal" }
    const plan = projections.get(item.callId)
    if (!plan || plan.goalRevision !== input.expectedGoalRevision || !joinMatches(input.observations, item)) return { kind: "invalid", reason: "orphan_replan_signal" }
    const current = [...projections.values()].filter(candidate => candidate.goalRevision === input.expectedGoalRevision).sort((left, right) => left.planRevision - right.planRevision).at(-1)
    if (!current || current.planRevision < plan.planRevision) return { kind: "invalid", reason: "invalid_replan_revision" }
    if (current.planRevision === plan.planRevision) {
      active.push({ id: `plan-replan:${plan.planCallId}:${plan.planRevision}`, sourceObservationId: item.observationId, planCallId: plan.planCallId, goalRevision: plan.goalRevision, planRevision: plan.planRevision, joinLocalId: item.joinLocalId, failedTaskIds: [...item.failedTaskIds] })
      continue
    }
    const next = [...projections.values()].find(candidate => candidate.goalRevision === input.expectedGoalRevision && candidate.planRevision === plan.planRevision + 1 && candidate.basedOnPlanRevision === plan.planRevision)
    if (!next) return { kind: "invalid", reason: "replan_not_based_on_failure" }
  }
  if (active.length > 1) return { kind: "invalid", reason: "multiple_replan_obligations" }
  return active.length === 1 ? { kind: "active", obligation: active[0]! } : { kind: "none" }
}

export { FEEDBACK_TEXT as PLAN_REPLAN_FEEDBACK_TEXT, MAX_FEEDBACK_ATTEMPTS as MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS }
