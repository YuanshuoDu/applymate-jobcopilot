import { Buffer } from "node:buffer"
import type { StepContextSnapshot } from "../context/step-context-builder.js"
import { parsePlanRevisionEvent } from "./plan-revision-receipt.js"

export const PLAN_COMPLETION_FEEDBACK_KIND = "plan_completion_feedback" as const
export const PLAN_COMPLETION_FEEDBACK_EVENT_TYPE = "plan.completion_feedback" as const
export const PLAN_COMPLETION_FEEDBACK_STATUS = "blocked" as const
export const PLAN_COMPLETION_FEEDBACK_BLOCKER = "plan_completion_unverified" as const
export const PLAN_COMPLETION_FEEDBACK_TEXT = "Re-propose or correct the server-owned plan and complete its completion control before answering."
export const MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS = 2

const FEEDBACK_ID_PREFIX = "plan-completion-feedback:"
const MAX_ID_LENGTH = 512
const MAX_PLAN_ID_LENGTH = 240
const MAX_PAYLOAD_BYTES = 8 * 1024
const FEEDBACK_KEYS = ["kind", "status", "attempt", "blocker", "feedback", "planId"] as const
const REQUIRED_FEEDBACK_KEYS = FEEDBACK_KEYS.filter(key => key !== "planId")
const EVENT_KEYS = ["observationId", "turnId", "stepId", "attempt", "status", "blocker", "feedback", "planId"] as const

export type PlanCompletionFeedback = {
  readonly kind: typeof PLAN_COMPLETION_FEEDBACK_KIND
  readonly status: typeof PLAN_COMPLETION_FEEDBACK_STATUS
  readonly attempt: number
  readonly blocker: typeof PLAN_COMPLETION_FEEDBACK_BLOCKER
  readonly feedback: typeof PLAN_COMPLETION_FEEDBACK_TEXT
  readonly planId?: string
}

export type PlanCompletionFeedbackObservation = {
  readonly id: string
  readonly content: PlanCompletionFeedback
}

export type PlanCompletionFeedbackEvent = {
  readonly observationId: string
  readonly turnId: string
  readonly stepId: string
  readonly attempt: number
  readonly status: typeof PLAN_COMPLETION_FEEDBACK_STATUS
  readonly blocker: typeof PLAN_COMPLETION_FEEDBACK_BLOCKER
  readonly feedback: typeof PLAN_COMPLETION_FEEDBACK_TEXT
  readonly planId: string | null
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validId(value: unknown, maxLength = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= maxLength
}

function belongsToTurn(stepId: string, turnId: string | undefined): boolean {
  if (turnId === undefined) return true
  if (turnId.trim().length === 0 || turnId !== turnId.trim()) return false
  return stepId.startsWith(`turn:${turnId}:`)
}

function sameEvent(left: PlanCompletionFeedbackEvent, right: PlanCompletionFeedbackEvent): boolean {
  return left.observationId === right.observationId && left.turnId === right.turnId && left.stepId === right.stepId
    && left.attempt === right.attempt && left.status === right.status && left.blocker === right.blocker
    && left.feedback === right.feedback && left.planId === right.planId
}

function validPlanId(value: unknown): value is string {
  return validId(value, MAX_PLAN_ID_LENGTH)
}

function matchesPlan(planId: string | undefined, expectedPlanId: string | null): boolean {
  return expectedPlanId === null ? planId === undefined : planId === expectedPlanId
}

function boundedPayload(value: PlanCompletionFeedback): boolean {
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_PAYLOAD_BYTES
  } catch {
    return false
  }
}

/** Build server-owned feedback for the current step. P3-27A keeps this in-memory. */
export function buildPlanCompletionFeedback(stepId: string, attempt: number, planId?: string | null): PlanCompletionFeedbackObservation | null {
  if (typeof stepId !== "string" || stepId.trim() !== stepId || stepId.length === 0 || stepId.length > MAX_ID_LENGTH) return null
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS) return null
  if (planId !== undefined && planId !== null && !validPlanId(planId)) return null
  const content: PlanCompletionFeedback = {
    kind: PLAN_COMPLETION_FEEDBACK_KIND,
    status: PLAN_COMPLETION_FEEDBACK_STATUS,
    attempt,
    blocker: PLAN_COMPLETION_FEEDBACK_BLOCKER,
    feedback: PLAN_COMPLETION_FEEDBACK_TEXT,
    ...(planId === undefined || planId === null ? {} : { planId }),
  }
  return boundedPayload(content) ? { id: `${FEEDBACK_ID_PREFIX}${stepId}`, content } : null
}

/** Build the canonical event payload from runtime-owned identity and fixed feedback. */
export function buildPlanCompletionFeedbackEvent(input: {
  readonly turnId: string
  readonly stepId: string
  readonly attempt: number
  readonly planId?: string | null
}): PlanCompletionFeedbackEvent | null {
  if (!validId(input.turnId) || !validId(input.stepId) || !belongsToTurn(input.stepId, input.turnId)) return null
  const observation = buildPlanCompletionFeedback(input.stepId, input.attempt)
  if (!observation) return null
  const planId = input.planId ?? null
  if (planId !== null && !validId(planId, MAX_PLAN_ID_LENGTH)) return null
  const event: PlanCompletionFeedbackEvent = {
    observationId: observation.id, turnId: input.turnId, stepId: input.stepId,
    attempt: observation.content.attempt, status: observation.content.status,
    blocker: observation.content.blocker, feedback: observation.content.feedback, planId,
  }
  return boundedEvent(event) ? event : null
}

function boundedEvent(value: PlanCompletionFeedbackEvent): boolean {
  try {
    const encoded = JSON.stringify(value)
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_PAYLOAD_BYTES
  } catch {
    return false
  }
}

/** The stable key is derived from the server-owned step identity, never model text. */
export function planCompletionFeedbackIdempotencyKey(stepId: string): string | null {
  return validId(stepId) && stepId.length <= MAX_ID_LENGTH ? `plan-completion-feedback:${stepId}` : null
}

/** Parse only the exact fixed feedback shape; model text is never accepted. */
export function parsePlanCompletionFeedback(
  observation: unknown,
  expectedTurnId?: string,
): PlanCompletionFeedbackObservation | null {
  const row = object(observation)
  if (!row || typeof row.id !== "string" || row.id.trim() !== row.id || row.id.length <= FEEDBACK_ID_PREFIX.length || row.id.length > MAX_ID_LENGTH + FEEDBACK_ID_PREFIX.length || !row.id.startsWith(FEEDBACK_ID_PREFIX)) return null
  const stepId = row.id.slice(FEEDBACK_ID_PREFIX.length)
  const content = object(row.content)
  if (!content || Object.keys(content).some(key => !(FEEDBACK_KEYS as readonly string[]).includes(key)) || REQUIRED_FEEDBACK_KEYS.some(key => !Object.prototype.hasOwnProperty.call(content, key))) return null
  if (content.kind !== PLAN_COMPLETION_FEEDBACK_KIND || content.status !== PLAN_COMPLETION_FEEDBACK_STATUS || content.blocker !== PLAN_COMPLETION_FEEDBACK_BLOCKER || content.feedback !== PLAN_COMPLETION_FEEDBACK_TEXT) return null
  if (!Number.isInteger(content.attempt) || Number(content.attempt) < 1 || Number(content.attempt) > MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS) return null
  if (content.planId !== undefined && !validPlanId(content.planId)) return null
  if (!belongsToTurn(stepId, expectedTurnId)) return null
  const parsed = buildPlanCompletionFeedback(stepId, Number(content.attempt), content.planId as string | undefined)
  return parsed && parsed.id === row.id ? parsed : null
}

/** Parse a durable feedback payload and enforce the current turn and plan identity. */
export function parsePlanCompletionFeedbackEvent(
  value: unknown,
  expectedTurnId?: string,
  expectedPlanId?: string | null,
): PlanCompletionFeedbackEvent | null {
  const row = object(value)
  if (!row || Object.keys(row).some(key => !(EVENT_KEYS as readonly string[]).includes(key)) || EVENT_KEYS.some(key => !Object.prototype.hasOwnProperty.call(row, key))) return null
  if (!validId(row.turnId) || !validId(row.stepId) || !belongsToTurn(row.stepId, expectedTurnId ?? row.turnId)) return null
  if (expectedTurnId !== undefined && row.turnId !== expectedTurnId) return null
  if (!validId(row.observationId) || row.observationId !== `${FEEDBACK_ID_PREFIX}${row.stepId}`) return null
  if (!Number.isInteger(row.attempt) || Number(row.attempt) < 1 || Number(row.attempt) > MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS) return null
  if (row.status !== PLAN_COMPLETION_FEEDBACK_STATUS || row.blocker !== PLAN_COMPLETION_FEEDBACK_BLOCKER || row.feedback !== PLAN_COMPLETION_FEEDBACK_TEXT) return null
  if (row.planId !== null && !validId(row.planId, MAX_PLAN_ID_LENGTH)) return null
  if (expectedPlanId !== undefined && row.planId !== expectedPlanId) return null
  const event = {
    observationId: row.observationId, turnId: row.turnId, stepId: row.stepId,
    attempt: Number(row.attempt), status: row.status, blocker: row.blocker, feedback: row.feedback, planId: row.planId,
  } as PlanCompletionFeedbackEvent
  return boundedEvent(event) ? event : null
}

function planIdFromObservation(observation: { readonly id: string; readonly content: unknown }): string | null {
  const content = object(observation.content)
  if (!content) return null
  if (content.kind === "plan_revision") {
    const { kind: _kind, ...metadata } = content
    const revision = parsePlanRevisionEvent(metadata)
    return revision?.planCallId ?? null
  }
  if (content.kind !== "plan_control" && content.kind !== "plan_command") return null
  if (!validId(content.localId, 128)) return null
  const prefix = content.kind === "plan_control" ? "plan-control:" : "plan-result:"
  const suffix = `:${content.localId}`
  if (!observation.id.startsWith(prefix) || !observation.id.endsWith(suffix)) return null
  const planId = observation.id.slice(prefix.length, observation.id.length - suffix.length)
  return validId(planId, MAX_PLAN_ID_LENGTH) ? planId : null
}

/** Resolve the latest server-owned plan call identity in a snapshot. */
export function currentPlanId(observations: StepContextSnapshot["toolObservations"]): string | null {
  if (!Array.isArray(observations)) return null
  let planId: string | null = null
  for (const observation of observations) {
    const content = object(observation?.content)
    if (content?.kind === "goal_revision") planId = null
    const candidate = observation && typeof observation.id === "string" ? planIdFromObservation(observation) : null
    if (candidate) planId = candidate
  }
  return planId
}

type FeedbackEventRow = { readonly type: unknown; readonly payload: unknown }

/** Restore only one canonical projection per valid current-plan feedback event. */
export function restorePlanCompletionFeedback(
  events: readonly FeedbackEventRow[],
  expectedTurnId: string,
  expectedPlanId: string | null,
): readonly PlanCompletionFeedbackObservation[] {
  if (!validId(expectedTurnId)) return []
  const restored = new Map<string, PlanCompletionFeedbackEvent>()
  const conflicting = new Set<string>()
  for (const event of events) {
    if (event.type !== PLAN_COMPLETION_FEEDBACK_EVENT_TYPE) continue
    const parsed = parsePlanCompletionFeedbackEvent(event.payload, expectedTurnId, expectedPlanId)
    if (!parsed || conflicting.has(parsed.observationId)) continue
    const existing = restored.get(parsed.observationId)
    if (existing && !sameEvent(existing, parsed)) {
      restored.delete(parsed.observationId)
      conflicting.add(parsed.observationId)
      continue
    }
    restored.set(parsed.observationId, parsed)
  }
  return [...restored.values()].map(event => ({
    id: event.observationId,
    content: {
      kind: PLAN_COMPLETION_FEEDBACK_KIND, status: PLAN_COMPLETION_FEEDBACK_STATUS,
      attempt: event.attempt, blocker: PLAN_COMPLETION_FEEDBACK_BLOCKER, feedback: PLAN_COMPLETION_FEEDBACK_TEXT,
      ...(event.planId === null ? {} : { planId: event.planId }),
    },
  }))
}

/** Remove malformed or conflicting legacy projections before canonical events merge. */
export function sanitizePlanCompletionFeedbackObservations(
  observations: StepContextSnapshot["toolObservations"],
  expectedTurnId: string,
  expectedPlanId?: string | null,
): StepContextSnapshot["toolObservations"] {
  if (!Array.isArray(observations)) return []
  const result: Array<StepContextSnapshot["toolObservations"][number] | undefined> = []
  const indexes = new Map<string, number>()
  const conflicting = new Set<string>()
  for (const observation of observations) {
    if (!observation || typeof observation.id !== "string" || !observation.id.startsWith(FEEDBACK_ID_PREFIX)) {
      result.push(observation)
      continue
    }
    const parsed = parsePlanCompletionFeedback(observation, expectedTurnId)
    if (!parsed || conflicting.has(parsed.id)) continue
    if (expectedPlanId !== undefined && !matchesPlan(parsed.content.planId, expectedPlanId)) continue
    const index = indexes.get(parsed.id)
    if (index !== undefined) {
      const existing = result[index]
      if (!existing || parsePlanCompletionFeedback(existing, expectedTurnId)?.content.attempt !== parsed.content.attempt) {
        result[index] = undefined as never
        indexes.delete(parsed.id)
        conflicting.add(parsed.id)
      }
      continue
    }
    indexes.set(parsed.id, result.length)
    result.push(observation)
  }
  return result.filter((observation): observation is NonNullable<typeof observation> => observation !== undefined)
}

/** Derive the bounded recovery count from current snapshot observations. */
export function planCompletionRecoveryCount(
  observations: StepContextSnapshot["toolObservations"],
  turnId: string,
  expectedPlanId?: string | null,
): number {
  if (!Array.isArray(observations)) return 0
  const parsed = new Map<string, PlanCompletionFeedbackObservation>()
  const conflicting = new Set<string>()
  for (const observation of observations) {
    const candidate = parsePlanCompletionFeedback(observation, turnId)
    if (!candidate || conflicting.has(candidate.id)) continue
    if (expectedPlanId !== undefined && !matchesPlan(candidate.content.planId, expectedPlanId)) continue
    const existing = parsed.get(candidate.id)
    if (existing && existing.content.attempt !== candidate.content.attempt) {
      parsed.delete(candidate.id)
      conflicting.add(candidate.id)
      continue
    }
    parsed.set(candidate.id, candidate)
  }
  return [...parsed.values()].reduce((highest, observation) => Math.max(highest, observation.content.attempt), 0)
}
