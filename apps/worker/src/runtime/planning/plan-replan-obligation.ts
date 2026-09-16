import { parsePlanRevisionEvent } from "./plan-revision-receipt.js"
import { inspectJoinFailureEvidence } from "./plan-replan-signal.js"
import { isPlainJsonObject } from "./goal-plan-contract.js"
import {
  buildReplanFeedback,
  MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS,
  PLAN_REPLAN_FEEDBACK_TEXT,
  replanFeedbackAttempts,
} from "./plan-replan-feedback.js"

const MAX_OBSERVATIONS = 256
const MAX_LOCAL_ID = 128
const MAX_ID = 256
const MAX_TASKS = 8
const SIGNAL_KEYS = ["kind", "localId", "status", "dependsOn", "reason", "failedTaskIds"]
const PROJECTION_KEYS = ["kind", "planCallId", "goalRevision", "planRevision", "basedOnPlanRevision", "proposalHash"]
const PROJECTION_KEYS_WITHOUT_HASH = PROJECTION_KEYS.filter(key => key !== "proposalHash")
const RESULT_KEYS = ["kind", "localId", "commandKind", "dependsOn", "status", "errorCode", "output"]
const WAIT_KEYS = ["waitId", "status", "taskIds", "matchedTaskIds", "tasks"]
const WAIT_KEYS_WITH_TARGETS = [...WAIT_KEYS.slice(0, 1), "status", "taskIds", "targetTaskIds", "matchedTaskIds", "tasks"]
const WAIT_KEYS_TARGET_ONLY = ["waitId", "status", "targetTaskIds", "matchedTaskIds", "tasks"]
const WAITING_KEYS = ["waitId", "status", "taskIds", "matchedTaskIds"]
const WAITING_KEYS_WITH_TARGETS = ["waitId", "status", "taskIds", "targetTaskIds", "matchedTaskIds"]
const WAITING_KEYS_TARGET_ONLY = ["waitId", "status", "targetTaskIds", "matchedTaskIds"]
const WAIT_RESULT_KEYS = ["toolCallId", "toolName", "input", "status", "output", "errorCode"]
const WAIT_INPUT_KEYS = ["taskIds", "mode"]
const FORBIDDEN_KEYS = new Set(["userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities", "budgetLimit", "maxBudget"])
const CANONICAL_WAIT_TOOL_NAME = "agent.wait" as const
const LEGACY_WAIT_TOOL_NAME = "wait_subagents" as const
const WAIT_TOOL_NAMES = [CANONICAL_WAIT_TOOL_NAME, LEGACY_WAIT_TOOL_NAME] as const
type WaitToolName = typeof WAIT_TOOL_NAMES[number]

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

type Observation = { readonly id: string; readonly content: unknown }
type Projection = ReturnType<typeof parsePlanRevisionEvent>
type SignalValue = { readonly callId: string; readonly joinLocalId: string; readonly failedTaskIds: readonly string[]; readonly dependsOn: readonly string[] }
type SignalEntry = SignalValue & { readonly observationId: string }
type WaitRecord = { readonly status: "waiting" | "ready" | "timed_out"; readonly waitId: string; readonly taskIds: readonly string[]; readonly matchedTaskIds: readonly string[]; readonly failedTaskIds: readonly string[] }
type WaitLookup = { readonly kind: "missing" } | { readonly kind: "invalid" } | { readonly kind: "valid"; readonly record: WaitRecord }

function isWaitToolName(value: unknown): value is WaitToolName {
  return typeof value === "string" && WAIT_TOOL_NAMES.includes(value as WaitToolName)
}

function row(value: unknown): Record<string, unknown> | null { return isPlainJsonObject(value) ? value : null }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)) }
function id(value: unknown, limit = MAX_ID): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit }
function integer(value: unknown, minimum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum }
function strings(value: unknown, limit: number, unique = true, allowEmpty = false): value is readonly string[] {
  return Array.isArray(value) && (allowEmpty || value.length > 0) && value.length <= MAX_TASKS && value.every(item => id(item, limit)) && (!unique || new Set(value).size === value.length)
}
function same(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]) }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
function sorted(value: readonly string[]): boolean { return value.every((item, index) => index === 0 || compare(value[index - 1]!, item) < 0) }
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

function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && [...left].sort(compare).every((value, index) => value === [...right].sort(compare)[index]) }

function waitIds(output: Record<string, unknown>): { readonly taskIds: readonly string[]; readonly matchedTaskIds: readonly string[] } | null {
  const taskIds = output.taskIds
  const targetTaskIds = output.targetTaskIds
  if (taskIds !== undefined && targetTaskIds !== undefined && (!strings(taskIds, MAX_ID) || !strings(targetTaskIds, MAX_ID) || !sameSet(taskIds, targetTaskIds))) return null
  const selected = taskIds ?? targetTaskIds
  if (!strings(selected, MAX_ID) || !strings(output.matchedTaskIds, MAX_ID, true, true) || !output.matchedTaskIds.every(value => selected.includes(value))) return null
  return { taskIds: selected, matchedTaskIds: output.matchedTaskIds }
}

function parseWaitOutput(value: unknown, expectedTaskIds?: readonly string[]): WaitRecord | null {
  const output = row(value)
  if (!output || foreign(output, new Set(["taskId"])) || !id(output.waitId) || !["waiting", "ready", "timed_out"].includes(String(output.status))) return null
  const status = output.status as WaitRecord["status"]
  const ids = waitIds(output)
  if (!ids || (expectedTaskIds && !sameSet(ids.taskIds, expectedTaskIds))) return null
  if (status === "waiting") {
    if ((!exact(output, WAITING_KEYS) && !exact(output, WAITING_KEYS_WITH_TARGETS) && !exact(output, WAITING_KEYS_TARGET_ONLY))) return null
    return { status, waitId: output.waitId, ...ids, failedTaskIds: [] }
  }
  if ((!exact(output, WAIT_KEYS) && !exact(output, WAIT_KEYS_WITH_TARGETS) && !exact(output, WAIT_KEYS_TARGET_ONLY)) || !Array.isArray(output.tasks)) return null
  const inspection = inspectJoinFailureEvidence(output, ids.taskIds)
  if (!inspection.valid || (status === "ready" && !sameSet(ids.matchedTaskIds, ids.taskIds))) return null
  return { status, waitId: output.waitId, ...ids, failedTaskIds: inspection.failedTaskIds }
}

function joinRecord(observations: readonly Observation[], callId: string, joinLocalId: string): { readonly record: WaitRecord; readonly dependsOn: readonly string[] } | null {
  const matches = observations.filter(observation => observation.id === `plan-result:${callId}:${joinLocalId}`)
  if (matches.length !== 1) return null
  const content = row(matches[0]!.content)
  if (!content || !exact(content, RESULT_KEYS) || content.kind !== "plan_command" || content.localId !== joinLocalId || content.commandKind !== "join" || content.status !== "completed" || content.errorCode !== null || !strings(content.dependsOn, MAX_LOCAL_ID)) return null
  const record = parseWaitOutput(content.output)
  return record ? { record, dependsOn: content.dependsOn } : null
}

function durableWait(observations: readonly Observation[], join: WaitRecord): WaitLookup {
  const matches = observations.filter(observation => observation.id === `wait-result:${join.waitId}`)
  if (matches.length > 1) return { kind: "invalid" }
  if (matches.length === 0) {
    const claimsExpected = observations.filter(observation => observation.id.startsWith("wait-result:")).some(observation => {
      const content = row(observation.content), output = row(content?.output)
      return content?.toolCallId === `wait:${join.waitId}` || output?.waitId === join.waitId || (output && waitIds(output)?.taskIds && sameSet(waitIds(output)!.taskIds, join.taskIds))
    })
    return claimsExpected ? { kind: "invalid" } : { kind: "missing" }
  }
  const content = row(matches[0]!.content), input = row(content?.input)
  if (!content || !exact(content, WAIT_RESULT_KEYS) || content.toolCallId !== `wait:${join.waitId}` || !isWaitToolName(content.toolName) || content.status !== "completed" || content.errorCode !== null || !input || !exact(input, WAIT_INPUT_KEYS) || foreign(input) || !strings(input.taskIds, MAX_ID) || input.mode !== "any" && input.mode !== "all" || !sameSet(input.taskIds, join.taskIds)) return { kind: "invalid" }
  const record = parseWaitOutput(content.output, join.taskIds)
  return record && record.status !== "waiting" && record.waitId === join.waitId ? { kind: "valid", record } : { kind: "invalid" }
}

function joinMatches(observations: readonly Observation[], item: SignalValue): boolean {
  const join = joinRecord(observations, item.callId, item.joinLocalId)
  if (!join || !strings(item.dependsOn, MAX_LOCAL_ID) || !same(join.dependsOn, item.dependsOn)) return false
  const resolved = durableWait(observations, join.record)
  if (resolved.kind === "invalid") return false
  if (join.record.status !== "waiting" && resolved.kind === "valid" && (resolved.record.status !== join.record.status || !sameSet(resolved.record.taskIds, join.record.taskIds) || !sameSet(resolved.record.matchedTaskIds, join.record.matchedTaskIds))) return false
  const evidence = resolved.kind === "valid" ? resolved.record : join.record
  return evidence.status !== "waiting" && same(evidence.failedTaskIds, item.failedTaskIds)
}

export function deriveReplanObligation(input: { readonly observations: readonly Observation[]; readonly expectedGoalRevision: number }): ReplanObligationResult {
  if (!input || typeof input !== "object" || !Array.isArray(input.observations) || input.observations.length > MAX_OBSERVATIONS || input.observations.some(observation => !observation || typeof observation.id !== "string" || !id(observation.id)) || !integer(input.expectedGoalRevision, 1)) return { kind: "invalid", reason: "invalid_replan_scope" }
  const projections = new Map<string, NonNullable<Projection>>()
  const signals: SignalEntry[] = []
  for (const observation of input.observations) {
    const parsedProjection = projection(observation)
    if (parsedProjection?.invalid) return { kind: "invalid", reason: "invalid_plan_projection" }
    if (parsedProjection && projections.has(parsedProjection.value.planCallId)) return { kind: "invalid", reason: "duplicate_plan_projection" }
    if (parsedProjection) projections.set(parsedProjection.value.planCallId, parsedProjection.value)
    const parsedSignal = signal(observation)
    if (parsedSignal?.invalid) return { kind: "invalid", reason: "invalid_replan_signal" }
    if (parsedSignal) signals.push({ observationId: observation.id, ...parsedSignal.value })
  }
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
  for (const plan of orderedPlans) {
    const joins = input.observations.filter(observation => observation.id.startsWith(`plan-result:${plan.planCallId}:`))
    for (const observation of joins) {
      const content = row(observation.content)
      if (content?.kind !== "plan_command" || content.commandKind !== "join" || content.status !== "completed") continue
      if (!id(content.localId, MAX_LOCAL_ID) || observation.id !== `plan-result:${plan.planCallId}:${content.localId}`) return { kind: "invalid", reason: "invalid_join_projection" }
      const join = joinRecord(input.observations, plan.planCallId, content.localId)
      if (!join) return { kind: "invalid", reason: "invalid_join_projection" }
      if (join.record.status !== "waiting") continue
      const resolved = durableWait(input.observations, join.record)
      if (resolved.kind === "invalid") return { kind: "invalid", reason: "invalid_wait_projection" }
      if (resolved.kind === "missing" || resolved.record.failedTaskIds.length === 0) continue
      const recovered: SignalEntry = { observationId: `plan-control:${plan.planCallId}:${content.localId}:replan`, callId: plan.planCallId, joinLocalId: content.localId, failedTaskIds: resolved.record.failedTaskIds, dependsOn: join.dependsOn }
      const existing = signals.find(candidate => candidate.observationId === recovered.observationId)
      if (existing && (!same(existing.failedTaskIds, recovered.failedTaskIds) || !same(existing.dependsOn, recovered.dependsOn))) return { kind: "invalid", reason: "replan_wait_conflict" }
      if (!existing) signals.push(recovered)
    }
  }
  const currentSignals: SignalEntry[] = []
  const active: ReplanObligation[] = []
  for (const item of signals) {
    if (signals.filter(candidate => candidate.observationId === item.observationId).length !== 1) return { kind: "invalid", reason: "duplicate_replan_signal" }
    const plan = projections.get(item.callId)
    if (!plan || !joinMatches(input.observations, item)) return { kind: "invalid", reason: "orphan_replan_signal" }
    if (plan.goalRevision > input.expectedGoalRevision) return { kind: "invalid", reason: "future_replan_signal" }
    if (plan.goalRevision < input.expectedGoalRevision) continue
    currentSignals.push(item)
  }
  for (const item of currentSignals) {
    const plan = projections.get(item.callId)
    if (!plan) return { kind: "invalid", reason: "orphan_replan_signal" }
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

export { buildReplanFeedback, MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS, PLAN_REPLAN_FEEDBACK_TEXT, replanFeedbackAttempts }
