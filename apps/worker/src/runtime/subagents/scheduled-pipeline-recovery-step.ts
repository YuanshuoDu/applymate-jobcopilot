import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

export const SCHEDULED_PIPELINE_RECOVERY_STEP_SCHEMA = "agent-harness.v2.scheduled-pipeline-recovery-step.v1" as const
export const SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY = "scheduledPipelineRecoveryStep" as const

export type ScheduledPipelineRecoveryOwner = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  rootTaskId: string
}>

/** Immutable pointer to the model candidate; it never changes as recovery Steps are appended. */
export type ScheduledPipelineRecoverySource = Readonly<{
  owner: ScheduledPipelineRecoveryOwner
  sourceEventId: string
  sourceStepId: string
  sourceStepOrdinal: number
  rootAttemptCount: number
  inputThroughSequence: string
  consumedInputIds?: readonly string[]
}>

/** Server-created marker for a non-model operational Step in one candidate's recovery chain. */
export type ScheduledPipelineRecoveryStepMarker = Readonly<{
  schemaVersion: typeof SCHEDULED_PIPELINE_RECOVERY_STEP_SCHEMA
  kind: "scheduled_pipeline_recovery"
  owner: ScheduledPipelineRecoveryOwner
  rootAttemptCount: number
  sourceEventId: string
  sourceStepId: string
  sourceStepOrdinal: number
  sourceInputThroughSequence: string
  recoveryStepId: string
  recoveryCursor: number
  predecessorStepId: string
  inputThroughSequence: string
}>

export type ScheduledPipelineRecoveryTail = Readonly<{
  marker: ScheduledPipelineRecoveryStepMarker
  ordinal: number
  status: string
  errorCode: string | null
  modelProfileSnapshot: RepositoryJsonValue
}>

export type ScheduledPipelineRecoveryStepEvidence = Readonly<{
  id: string
  taskId: string | null
  ordinal: number
  attempt: number
  status: string
  errorCode: string | null
  inputThroughSequence: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  consumedInputIds: readonly string[]
  modelProfileSnapshot: RepositoryJsonValue
  startedEvents: readonly unknown[]
  completedEvents: readonly unknown[]
  waitId: string | null
  hasModelActivity: boolean
  hasToolActivity: boolean
  hasFinalRejection: boolean
  receipt: "none" | "scheduled_wait" | "scheduled_gate_choice" | "scheduled_blocker" | "invalid"
}>

export function scheduledPipelineRecoveryStepMarker(input: Readonly<{
  owner: ScheduledPipelineRecoveryOwner
  source: ScheduledPipelineRecoverySource
  recoveryStepId: string
  recoveryCursor: number
  inputThroughSequence: string
  previous?: ScheduledPipelineRecoveryStepMarker
}>): ScheduledPipelineRecoveryStepMarker {
  const source = input.source, owner = stableOwner(input.owner)
  if (!sourceMatchesOwner(source, owner) || !validId(input.recoveryStepId) || !positive(input.recoveryCursor)
    || !validCursor(input.inputThroughSequence)) throw new Error("scheduled_recovery_step_identity_invalid")
  const previous = input.previous === undefined ? undefined : parseScheduledPipelineRecoveryStepMarker(input.previous)
  if (input.previous !== undefined && !previous) throw new Error("scheduled_recovery_step_chain_invalid")
  const predecessorStepId = previous?.recoveryStepId ?? source.sourceStepId
  const predecessorCursor = previous?.inputThroughSequence ?? source.inputThroughSequence
  const expectedCursor = (previous?.recoveryCursor ?? 0) + 1
  if (input.recoveryCursor !== expectedCursor || !validId(predecessorStepId)
    || BigInt(input.inputThroughSequence) < BigInt(predecessorCursor)
    || previous && !markerContinuesSource(previous, source, owner)) {
    throw new Error("scheduled_recovery_step_chain_invalid")
  }
  const marker: ScheduledPipelineRecoveryStepMarker = {
    schemaVersion: SCHEDULED_PIPELINE_RECOVERY_STEP_SCHEMA,
    kind: "scheduled_pipeline_recovery",
    owner,
    rootAttemptCount: source.rootAttemptCount,
    sourceEventId: source.sourceEventId,
    sourceStepId: source.sourceStepId,
    sourceStepOrdinal: source.sourceStepOrdinal,
    sourceInputThroughSequence: source.inputThroughSequence,
    recoveryStepId: input.recoveryStepId,
    recoveryCursor: input.recoveryCursor,
    predecessorStepId,
    inputThroughSequence: input.inputThroughSequence,
  }
  return marker
}

export function parseScheduledPipelineRecoveryStepMarker(value: unknown): ScheduledPipelineRecoveryStepMarker | null {
  const row = record(value), owner = record(row?.owner)
  const keys = ["schemaVersion", "kind", "owner", "rootAttemptCount", "sourceEventId", "sourceStepId", "sourceStepOrdinal",
    "sourceInputThroughSequence", "recoveryStepId", "recoveryCursor", "predecessorStepId", "inputThroughSequence"]
  if (!row || !owner || !exactKeys(row, keys) || !exactKeys(owner, ["userId", "sessionId", "turnId", "rootTaskId"])
    || row.schemaVersion !== SCHEDULED_PIPELINE_RECOVERY_STEP_SCHEMA || row.kind !== "scheduled_pipeline_recovery"
    || !validOwner(owner) || !positive(row.rootAttemptCount) || !validId(row.sourceEventId) || !validId(row.sourceStepId)
    || !nonNegative(row.sourceStepOrdinal) || !validCursor(row.sourceInputThroughSequence)
    || !validId(row.recoveryStepId) || !positive(row.recoveryCursor) || !validId(row.predecessorStepId)
    || !validCursor(row.inputThroughSequence)
    || BigInt(row.inputThroughSequence) < BigInt(row.sourceInputThroughSequence)
    || Number(row.rootAttemptCount) < 1) return null
  return Object.freeze({
    schemaVersion: SCHEDULED_PIPELINE_RECOVERY_STEP_SCHEMA,
    kind: "scheduled_pipeline_recovery",
    owner: stableOwner(owner),
    rootAttemptCount: Number(row.rootAttemptCount),
    sourceEventId: row.sourceEventId,
    sourceStepId: row.sourceStepId,
    sourceStepOrdinal: Number(row.sourceStepOrdinal),
    sourceInputThroughSequence: row.sourceInputThroughSequence,
    recoveryStepId: row.recoveryStepId,
    recoveryCursor: Number(row.recoveryCursor),
    predecessorStepId: row.predecessorStepId,
    inputThroughSequence: row.inputThroughSequence,
  })
}

/** Stores the marker atomically with the Step row, before the separately appended step.started event. */
export function withScheduledPipelineRecoveryStepProfile(
  profile: RepositoryJsonValue,
  marker: ScheduledPipelineRecoveryStepMarker,
): RepositoryJsonValue {
  const objectProfile = record(profile)
  return objectProfile
    ? { ...objectProfile, [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: marker }
    : { configuredModelProfile: profile, [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: marker }
}

export function readScheduledPipelineRecoveryStepProfile(value: unknown): ScheduledPipelineRecoveryStepMarker | null {
  const profile = record(value)
  return parseScheduledPipelineRecoveryStepMarker(profile?.[SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY])
}

export function scheduledPipelineRecoverySourceMatches(
  marker: ScheduledPipelineRecoveryStepMarker,
  source: ScheduledPipelineRecoverySource,
): boolean {
  return markerContinuesSource(marker, source, source.owner)
}

/** Validates the complete operational tail without accepting a later model or generic tool Step. */
export function validateScheduledPipelineRecoverySteps(source: ScheduledPipelineRecoverySource,
  steps: readonly ScheduledPipelineRecoveryStepEvidence[]): ScheduledPipelineRecoveryTail | null {
  let previousId = source.sourceStepId, previousOrdinal = source.sourceStepOrdinal
  let previousCursor = BigInt(source.inputThroughSequence), recoveryCursor = 0
  for (const step of steps) {
    const marker = readScheduledPipelineRecoveryStepProfile(step.modelProfileSnapshot)
    if (!marker || !scheduledPipelineRecoverySourceMatches(marker, source) || marker.recoveryStepId !== step.id
      || marker.predecessorStepId !== previousId || marker.recoveryCursor !== recoveryCursor + 1
      || !validId(step.id) || step.taskId !== source.owner.rootTaskId || !positive(step.ordinal)
      || step.ordinal <= previousOrdinal || step.attempt !== 1
      || !validCursor(step.inputThroughSequence) || marker.inputThroughSequence !== step.inputThroughSequence
      || BigInt(step.inputThroughSequence) < previousCursor || !zero(step.inputTokens) || !zero(step.outputTokens)
      || !zero(step.estimatedCostUsd) || step.consumedInputIds.length !== 0
      || step.hasModelActivity || step.hasToolActivity || step.hasFinalRejection
      || !validStepReceipt(step, marker, source.owner.rootTaskId,
        source.owner.turnId)) return null
    previousId = step.id
    previousOrdinal = step.ordinal
    previousCursor = BigInt(step.inputThroughSequence)
    recoveryCursor = marker.recoveryCursor
  }
  if (steps.length === 0) return null
  const tail = steps[steps.length - 1]!
  const marker = readScheduledPipelineRecoveryStepProfile(tail.modelProfileSnapshot)
  return marker ? { marker, ordinal: tail.ordinal, status: tail.status, errorCode: tail.errorCode,
    modelProfileSnapshot: tail.modelProfileSnapshot } : null
}

function markerContinuesSource(marker: ScheduledPipelineRecoveryStepMarker, source: ScheduledPipelineRecoverySource,
  owner: ScheduledPipelineRecoveryOwner): boolean {
  return sameOwner(marker.owner, owner) && marker.rootAttemptCount === source.rootAttemptCount
    && marker.sourceEventId === source.sourceEventId && marker.sourceStepId === source.sourceStepId
    && marker.sourceStepOrdinal === source.sourceStepOrdinal && marker.sourceInputThroughSequence === source.inputThroughSequence
}
function sameOwner(left: ScheduledPipelineRecoveryOwner, right: ScheduledPipelineRecoveryOwner): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId
}
function sourceMatchesOwner(source: ScheduledPipelineRecoverySource, owner: ScheduledPipelineRecoveryOwner): boolean {
  return validOwner(source.owner) && sameOwner(source.owner, owner) && validId(source.sourceEventId)
    && validId(source.sourceStepId) && nonNegative(source.sourceStepOrdinal) && positive(source.rootAttemptCount)
    && validCursor(source.inputThroughSequence) && (source.consumedInputIds === undefined
      || Array.isArray(source.consumedInputIds) && source.consumedInputIds.every(validId)
        && new Set(source.consumedInputIds).size === source.consumedInputIds.length)
}
function stableOwner(value: unknown): ScheduledPipelineRecoveryOwner {
  const row = record(value)
  if (!row || !validOwner(row)) throw new Error("scheduled_recovery_step_owner_invalid")
  return Object.freeze({ userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, rootTaskId: row.rootTaskId })
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null
    }
    return value as Record<string, unknown>
  } catch { return null }
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
function validOwner(value: Record<string, unknown>): value is Record<keyof ScheduledPipelineRecoveryOwner, string> {
  return [value.userId, value.sessionId, value.turnId, value.rootTaskId].every(validId)
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function validCursor(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9]\d{0,18})$/.test(value)
    && BigInt(value) <= 9_223_372_036_854_775_807n
}
function zero(value: number): boolean { return Number.isFinite(value) && value === 0 }
function validStepReceipt(step: ScheduledPipelineRecoveryStepEvidence, marker: ScheduledPipelineRecoveryStepMarker,
  rootTaskId: string, turnId: string): boolean {
  if (step.startedEvents.length > 1 || step.startedEvents.length === 1
    && !startEventMatches(step.startedEvents[0], step, marker, rootTaskId, turnId)) return false
  const completed = step.completedEvents
  if (step.status === "streaming" || step.status === "interrupted") {
    return step.receipt === "none" && completed.length === 0 && step.startedEvents.length <= 1
  }
  if (step.startedEvents.length !== 1) return false
  if (step.status === "waiting_for_tool") {
    if (step.receipt !== "scheduled_wait" && step.receipt !== "scheduled_blocker") return false
    if (step.receipt === "scheduled_wait" && !validId(step.waitId)) return false
    if (step.receipt === "scheduled_blocker" && step.waitId !== null) return false
    return completed.length === 1 && completionMatches(completed[0], step, rootTaskId, turnId,
      "waiting_for_dependency", step.receipt === "scheduled_blocker", step.receipt === "scheduled_wait")
  }
  if (step.status === "waiting_for_user") {
    return step.receipt === "scheduled_gate_choice" && completed.length === 1
      && completionMatches(completed[0], step, rootTaskId, turnId, "waiting_for_user", false, false)
  }
  if (step.status === "completed") {
    return step.receipt === "none" && completed.length === 1
      && completionMatches(completed[0], step, rootTaskId, turnId, "completed", false, false)
  }
  return false
}
function startEventMatches(value: unknown, step: ScheduledPipelineRecoveryStepEvidence, marker: ScheduledPipelineRecoveryStepMarker,
  rootTaskId: string, turnId: string): boolean {
  const event = record(value), payload = record(event?.payload)
  return !!event && !!payload && exactKeys(payload, ["stepId", "ordinal", "taskId", SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY])
    && event.type === "step.started" && event.actor === "orchestrator" && event.taskId === rootTaskId
    && event.itemId === null && event.correlationId === step.id
    && event.idempotencyKey === `turn:${turnId}:event:step-started:${step.id}`
    && payload.stepId === step.id && payload.ordinal === step.ordinal && payload.taskId === rootTaskId
    && sameMarker(payload[SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY], marker)
}
function completionMatches(value: unknown, step: ScheduledPipelineRecoveryStepEvidence, rootTaskId: string,
  turnId: string, status: string, includeError: boolean, includeWaitId: boolean): boolean {
  const event = record(value), payload = record(event?.payload)
  const keys = includeError ? ["stepId", "status", "errorCode", "taskId"]
    : includeWaitId ? ["stepId", "status", "taskId", "waitId"] : ["stepId", "status", "taskId"]
  return !!event && !!payload && exactKeys(payload, keys) && event.type === "step.completed" && event.actor === "orchestrator"
    && event.taskId === rootTaskId && event.itemId === null && event.correlationId === step.id
    && event.idempotencyKey === `turn:${turnId}:event:step-completed:${step.id}`
    && payload.stepId === step.id && payload.status === status && payload.taskId === rootTaskId
    && (!includeWaitId || payload.waitId === step.waitId)
    && (includeError ? step.errorCode !== null && payload.errorCode === step.errorCode : step.errorCode === null)
}
function sameMarker(value: unknown, expected: ScheduledPipelineRecoveryStepMarker): boolean {
  const parsed = parseScheduledPipelineRecoveryStepMarker(value)
  return !!parsed && JSON.stringify(parsed) === JSON.stringify(expected)
}
