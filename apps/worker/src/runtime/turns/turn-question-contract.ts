import { Buffer } from "node:buffer"
import type { TurnUsage } from "../budget.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

export const TURN_QUESTION_INTENT_SCHEMA = "agent-harness.v2.ask-user-intent.v1" as const
export const TURN_QUESTION_MAX_CHOICES = 6
export const TURN_QUESTION_MAX_TEXT_BYTES = 2_000
export const TURN_QUESTION_MAX_CHOICE_BYTES = 200

export type TurnQuestionChoice = { readonly label: string; readonly value: string }
export type TurnQuestionIntentEnvelope = {
  readonly schemaVersion: typeof TURN_QUESTION_INTENT_SCHEMA
  readonly kind: "user_question"
  readonly stage: "user_input"
  readonly question: string
  readonly options: readonly TurnQuestionChoice[]
}

export type TurnQuestionStore = {
  stageQuestionUsage(input: TurnQuestionUsageInput): Promise<void>
  cancelPausedQuestion(input: TurnQuestionPauseInput): Promise<"cancelled" | "prepared">
  waitForQuestion(input: TurnQuestionWaitInput): Promise<TurnQuestionWaitReceipt>
  readPendingQuestion(input: TurnQuestionOwnerInput): Promise<TurnQuestionRecovery>
}

export type TurnQuestionUsageInput = {
  readonly owner: TurnExecutionOwnerFence
  readonly stepId: string
  readonly toolCallId: string
  readonly finishReason: string
  readonly usage: TurnUsage
  readonly now: Date
}
export type TurnQuestionPauseInput = TurnQuestionUsageInput & {
  readonly callArguments: unknown
}

export type TurnQuestionOwnerInput = { readonly owner: TurnExecutionOwnerFence; readonly now: Date }
export type TurnQuestionWaitInput = TurnQuestionOwnerInput & { readonly stepId: string; readonly toolCallId: string }
export type TurnQuestionWaitReceipt = {
  readonly status: "waiting_for_user" | "answered"
  readonly disposition: "created" | "replayed"
  readonly waitId: string
  readonly itemId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly nextTurnRevision: number
}

export type TurnQuestionStoreErrorCode = "question_invalid_owner" | "question_not_current" | "question_receipt_missing"
  | "question_receipt_malformed" | "question_usage_unavailable" | "question_conflict"

export class TurnQuestionStoreError extends Error {
  constructor(readonly code: TurnQuestionStoreErrorCode, message: string) {
    super(message)
    this.name = "TurnQuestionStoreError"
  }
}

export type TurnQuestionRecovery =
  | { readonly status: "none" }
  | { readonly status: "replayable"; readonly stepId: string; readonly toolCallId: string; readonly callItemId: string; readonly intent: TurnQuestionIntentEnvelope }
  | { readonly status: "prepared"; readonly stepId: string; readonly toolCallId: string; readonly waitId: string; readonly itemId: string }
  | { readonly status: "waiting"; readonly stepId: string; readonly toolCallId: string; readonly waitId: string; readonly itemId: string; readonly turnId: string }
  | { readonly status: "answered"; readonly stepId: string; readonly toolCallId: string; readonly waitId: string; readonly itemId: string; readonly turnId: string }
  | { readonly status: "closed"; readonly stepId: string; readonly toolCallId: string; readonly waitId: string; readonly itemId: string; readonly turnId: string }
  | { readonly status: "not_current" }

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...expected].sort().join(",")
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim()
    && Buffer.byteLength(value, "utf8") <= maxBytes
}

function choices(value: unknown): TurnQuestionChoice[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > TURN_QUESTION_MAX_CHOICES) return null
  const result: TurnQuestionChoice[] = []
  const labels = new Set<string>(), values = new Set<string>()
  for (const raw of value) {
    const choice = record(raw)
    if (!choice || !exactKeys(choice, ["label", "value"]) || typeof choice.label !== "string" || typeof choice.value !== "string") return null
    const label = choice.label.trim(), answer = choice.value.trim()
    if (!boundedText(label, TURN_QUESTION_MAX_CHOICE_BYTES) || !boundedText(answer, TURN_QUESTION_MAX_CHOICE_BYTES)
      || labels.has(label) || values.has(answer)) return null
    labels.add(label); values.add(answer); result.push({ label, value: answer })
  }
  return result
}

/** Normalize only the model-facing question and optional choice list. */
export function parseTurnQuestionArguments(value: unknown): TurnQuestionIntentEnvelope | null {
  const row = record(value)
  if (!row || !(exactKeys(row, ["question", "choices"]) || exactKeys(row, ["question"])) || typeof row.question !== "string") return null
  const question = row.question.trim(), options = choices(row.choices)
  if (!boundedText(question, TURN_QUESTION_MAX_TEXT_BYTES) || !options) return null
  return { schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input", question, options }
}

/** Strict parser for the durable, server-generated ask_user tool-result receipt. */
export function parseTurnQuestionIntentEnvelope(value: unknown): TurnQuestionIntentEnvelope | null {
  const row = record(value)
  if (!row || !exactKeys(row, ["schemaVersion", "kind", "stage", "question", "options"])) return null
  if (row.schemaVersion !== TURN_QUESTION_INTENT_SCHEMA || row.kind !== "user_question" || row.stage !== "user_input"
    || !boundedText(row.question, TURN_QUESTION_MAX_TEXT_BYTES) || !Array.isArray(row.options)
    || row.options.length > TURN_QUESTION_MAX_CHOICES) return null
  const options = choices(row.options)
  if (!options) return null
  return { schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input", question: row.question, options }
}
