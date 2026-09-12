import { Buffer } from "node:buffer"
import type { StepContextSnapshot } from "../context/step-context-builder.js"

export const PLAN_COMPLETION_FEEDBACK_KIND = "plan_completion_feedback" as const
export const PLAN_COMPLETION_FEEDBACK_STATUS = "blocked" as const
export const PLAN_COMPLETION_FEEDBACK_BLOCKER = "plan_completion_unverified" as const
export const PLAN_COMPLETION_FEEDBACK_TEXT = "Re-propose or correct the server-owned plan and complete its completion control before answering."
export const MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS = 2

const FEEDBACK_ID_PREFIX = "plan-completion-feedback:"
const MAX_ID_LENGTH = 512
const MAX_PAYLOAD_BYTES = 8 * 1024
const FEEDBACK_KEYS = ["kind", "status", "attempt", "blocker", "feedback"] as const

export type PlanCompletionFeedback = {
  readonly kind: typeof PLAN_COMPLETION_FEEDBACK_KIND
  readonly status: typeof PLAN_COMPLETION_FEEDBACK_STATUS
  readonly attempt: number
  readonly blocker: typeof PLAN_COMPLETION_FEEDBACK_BLOCKER
  readonly feedback: typeof PLAN_COMPLETION_FEEDBACK_TEXT
}

export type PlanCompletionFeedbackObservation = {
  readonly id: string
  readonly content: PlanCompletionFeedback
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function belongsToTurn(stepId: string, turnId: string | undefined): boolean {
  if (turnId === undefined) return true
  if (turnId.trim().length === 0 || turnId !== turnId.trim()) return false
  return stepId.startsWith(`turn:${turnId}:`)
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
export function buildPlanCompletionFeedback(stepId: string, attempt: number): PlanCompletionFeedbackObservation | null {
  if (typeof stepId !== "string" || stepId.trim() !== stepId || stepId.length === 0 || stepId.length > MAX_ID_LENGTH) return null
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS) return null
  const content: PlanCompletionFeedback = {
    kind: PLAN_COMPLETION_FEEDBACK_KIND,
    status: PLAN_COMPLETION_FEEDBACK_STATUS,
    attempt,
    blocker: PLAN_COMPLETION_FEEDBACK_BLOCKER,
    feedback: PLAN_COMPLETION_FEEDBACK_TEXT,
  }
  return boundedPayload(content) ? { id: `${FEEDBACK_ID_PREFIX}${stepId}`, content } : null
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
  if (!content || Object.keys(content).some(key => !(FEEDBACK_KEYS as readonly string[]).includes(key)) || FEEDBACK_KEYS.some(key => !Object.prototype.hasOwnProperty.call(content, key))) return null
  if (content.kind !== PLAN_COMPLETION_FEEDBACK_KIND || content.status !== PLAN_COMPLETION_FEEDBACK_STATUS || content.blocker !== PLAN_COMPLETION_FEEDBACK_BLOCKER || content.feedback !== PLAN_COMPLETION_FEEDBACK_TEXT) return null
  if (!Number.isInteger(content.attempt) || Number(content.attempt) < 1 || Number(content.attempt) > MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS) return null
  if (!belongsToTurn(stepId, expectedTurnId)) return null
  const parsed = buildPlanCompletionFeedback(stepId, Number(content.attempt))
  return parsed && parsed.id === row.id ? parsed : null
}

/** Derive the bounded recovery count from current snapshot observations. */
export function planCompletionRecoveryCount(
  observations: StepContextSnapshot["toolObservations"],
  turnId: string,
): number {
  if (!Array.isArray(observations)) return 0
  let highestAttempt = 0
  for (const observation of observations) {
    const parsed = parsePlanCompletionFeedback(observation, turnId)
    if (parsed) highestAttempt = Math.max(highestAttempt, parsed.content.attempt)
  }
  return highestAttempt
}
