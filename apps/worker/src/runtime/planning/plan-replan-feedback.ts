import { Buffer } from "node:buffer"

import { isPlainJsonObject } from "./goal-plan-contract.js"

const MAX_OBSERVATIONS = 256
const MAX_ID = 256
const MAX_TASKS = 8
export const MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS = 2
const FEEDBACK_PREFIX = "plan-replan-feedback:"
const FEEDBACK_TEXT = "Propose exactly one new accepted plan based on the failed plan revision before continuing."

export type ReplanFeedbackObligation = {
  readonly id: string
  readonly sourceObservationId: string
  readonly planCallId: string
  readonly goalRevision: number
  readonly planRevision: number
  readonly joinLocalId: string
  readonly failedTaskIds: readonly string[]
}

type Observation = { readonly id: string; readonly content: unknown }

function id(value: unknown, limit = MAX_ID): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= limit
}

function integer(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_TASKS && value.every(item => id(item)) && new Set(value).size === value.length
}

function sorted(value: readonly string[]): boolean {
  return value.every((item, index) => index === 0 || value[index - 1]! < item)
}

function validObligation(value: ReplanFeedbackObligation): boolean {
  return Boolean(value) && typeof value === "object" && id(value.id) && id(value.sourceObservationId) && id(value.planCallId) && id(value.joinLocalId, 128) && integer(value.goalRevision, 1) && integer(value.planRevision, 1) && strings(value.failedTaskIds) && sorted(value.failedTaskIds)
}

function feedbackId(turnId: string, obligation: ReplanFeedbackObligation, attempt: number): string {
  return `${FEEDBACK_PREFIX}${turnId}:${obligation.planCallId}:${obligation.planRevision}:${attempt}`
}

export type ReplanFeedbackObservation = { readonly id: string; readonly content: Record<string, unknown> }

export function buildReplanFeedback(turnId: string, obligation: ReplanFeedbackObligation, attempt: number): ReplanFeedbackObservation | null {
  if (!id(turnId) || !validObligation(obligation) || !integer(attempt, 1) || attempt > MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS) return null
  const observation = { id: feedbackId(turnId, obligation, attempt), content: { kind: "plan_replan_feedback", status: "replan_required", attempt, obligationId: obligation.id, planCallId: obligation.planCallId, goalRevision: obligation.goalRevision, planRevision: obligation.planRevision, failedTaskIds: [...obligation.failedTaskIds], feedback: FEEDBACK_TEXT } }
  return id(observation.id) && Buffer.byteLength(JSON.stringify(observation), "utf8") <= 8 * 1024 ? observation : null
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (isPlainJsonObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
  return JSON.stringify(value) ?? "null"
}

export function replanFeedbackAttempts(observations: readonly Observation[], turnId: string, obligation: ReplanFeedbackObligation): { readonly valid: true; readonly highest: number } | { readonly valid: false } {
  if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS || observations.some(observation => !observation || typeof observation.id !== "string" || !id(observation.id))) return { valid: false }
  if (!id(turnId) || !validObligation(obligation)) return { valid: false }
  const prefix = `${FEEDBACK_PREFIX}${turnId}:${obligation.planCallId}:${obligation.planRevision}:`
  const matched = observations.filter(observation => observation.id.startsWith(prefix))
  const attempts = new Set<number>()
  for (const observation of matched) {
    const parsedAttempt = Number(observation.id.slice(prefix.length))
    if (!integer(parsedAttempt, 1) || parsedAttempt > MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS || attempts.has(parsedAttempt)) return { valid: false }
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

export { FEEDBACK_TEXT as PLAN_REPLAN_FEEDBACK_TEXT }
