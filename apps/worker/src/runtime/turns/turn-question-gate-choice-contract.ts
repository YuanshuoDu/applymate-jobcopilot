import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

export const TURN_SCHEDULED_GATE_CHOICE_SCHEMA = "agent-harness.v2.scheduled-gate-choice-wait.v1" as const
export const TURN_SCHEDULED_GATE_CHOICE_MAX_JOBS = 50
export const TURN_SCHEDULED_GATE_CHOICE_MAX_QUESTION_BYTES = 2_000
export type TurnQuestionGateChoiceKind = "borderline_match" | "weak_cover_letter"
export type TurnQuestionGateChoiceAnswer = "add_to_pending" | "lower_threshold" | "continue" | "review" | "skip"
export type TurnQuestionGateChoiceOwner = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  executionId: string; executionAttemptCount: number
}>
export type TurnQuestionGateChoiceBinding = Readonly<{
  schemaVersion: typeof TURN_SCHEDULED_GATE_CHOICE_SCHEMA
  owner: TurnQuestionGateChoiceOwner
  continuationKey: string
  snapshotDigest: string
  evidenceDigest: string
  checkpointDigest: string
  analyzeGraphRevision: number
  graphRevision: number
  gateTaskId: string
  gateAttempt: number
  kind: TurnQuestionGateChoiceKind
  jobIds: readonly string[]
  allowedChoiceIds: readonly TurnQuestionGateChoiceAnswer[]
}>
export type TurnQuestionGateChoiceContent = Readonly<{
  waitKind: "question"; questionId: string; toolCallId: null; stage: "scheduled_gate"
  question: string; options: readonly Readonly<{ label: string; value: TurnQuestionGateChoiceAnswer }>[]
  answer: TurnQuestionGateChoiceAnswer | null; answerAvailable: boolean
  scheduledGateChoiceBinding: TurnQuestionGateChoiceBinding
  scheduledGateChoiceResumeAcknowledgement?: TurnQuestionGateChoiceResumeAcknowledgement
}>
export type TurnQuestionGateChoiceResumeAcknowledgement = Readonly<{
  gateTaskId: string; requestAttemptCount: number; waitId: string; itemId: string; resumedAttemptCount: number
}>
export type TurnQuestionGateChoiceItemState = Readonly<{
  answer: TurnQuestionGateChoiceAnswer | null; resumeAcknowledgement: TurnQuestionGateChoiceResumeAcknowledgement | null
}>
export type TurnQuestionGateChoiceRecovery =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "waiting"; waitId: string; itemId: string; binding: TurnQuestionGateChoiceBinding }>
  | Readonly<{ status: "answered"; waitId: string; itemId: string; validatedChoice: Readonly<{
    kind: TurnQuestionGateChoiceKind; jobIds: readonly string[]; choiceId: TurnQuestionGateChoiceAnswer
  }>; binding: TurnQuestionGateChoiceBinding }>

const choices = {
  borderline_match: [
    { label: "Include for review", value: "add_to_pending" },
    { label: "Skip", value: "skip" },
    { label: "Lower threshold 5%", value: "lower_threshold" },
  ],
  weak_cover_letter: [
    { label: "Continue with current materials", value: "continue" },
    { label: "Place for review", value: "review" },
    { label: "Skip", value: "skip" },
  ],
} as const

export function parseTurnQuestionGateChoiceBinding(value: unknown): TurnQuestionGateChoiceBinding | null {
  const row = record(value), owner = record(row?.owner)
  if (!row || !owner || !exactKeys(row, ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest", "checkpointDigest", "analyzeGraphRevision", "graphRevision", "gateTaskId", "gateAttempt", "kind", "jobIds", "allowedChoiceIds"])
    || !exactKeys(owner, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"])
    || row.schemaVersion !== TURN_SCHEDULED_GATE_CHOICE_SCHEMA || !validOwner(owner)
    || !text(row.continuationKey, /^scheduled-taskgraph:sha256:[a-f0-9]{64}$/)
    || !text(row.snapshotDigest, /^sha256:[a-f0-9]{64}$/) || !text(row.evidenceDigest, /^[a-f0-9]{64}$/)
    || !text(row.checkpointDigest, /^[a-f0-9]{64}$/) || !positive(row.analyzeGraphRevision) || !positive(row.graphRevision)
    || !validId(row.gateTaskId) || !positive(row.gateAttempt)
    || row.kind !== "borderline_match" && row.kind !== "weak_cover_letter"
    || !jobIds(row.jobIds, row.kind) || !choiceIds(row.allowedChoiceIds, row.kind)) return null
  return { schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA, owner: stableOwner(owner), continuationKey: row.continuationKey,
    snapshotDigest: row.snapshotDigest, evidenceDigest: row.evidenceDigest, checkpointDigest: row.checkpointDigest,
    analyzeGraphRevision: Number(row.analyzeGraphRevision), graphRevision: Number(row.graphRevision), gateTaskId: row.gateTaskId, gateAttempt: Number(row.gateAttempt),
    kind: row.kind, jobIds: [...row.jobIds as string[]].sort(), allowedChoiceIds: [...choices[row.kind].map(choice => choice.value)] }
}

export function turnScheduledGateChoiceWaitId(value: unknown): string | null {
  const binding = parseTurnQuestionGateChoiceBinding(value)
  if (!binding) return null
  const digest = createHash("sha256").update(JSON.stringify(binding), "utf8").digest("hex")
  return `agent-question:${binding.owner.turnId}:gate:${digest}`
}

export function createTurnScheduledGateChoiceContent(waitId: string, bindingValue: unknown, question: string): TurnQuestionGateChoiceContent | null {
  const binding = parseTurnQuestionGateChoiceBinding(bindingValue)
  if (!binding || waitId !== turnScheduledGateChoiceWaitId(binding) || !boundedText(question, TURN_SCHEDULED_GATE_CHOICE_MAX_QUESTION_BYTES)) return null
  return { waitKind: "question", questionId: waitId, toolCallId: null, stage: "scheduled_gate", question,
    options: choices[binding.kind], answer: null, answerAvailable: false, scheduledGateChoiceBinding: binding }
}

export function parseTurnScheduledGateChoiceItem(value: unknown, status: unknown, expected: unknown): TurnQuestionGateChoiceAnswer | null | undefined {
  const parsed = parseTurnScheduledGateChoiceItemState(value, status, expected)
  return parsed === undefined ? undefined : parsed.answer
}

export function parseTurnScheduledGateChoiceItemState(value: unknown, status: unknown, expected: unknown): TurnQuestionGateChoiceItemState | undefined {
  const row = record(value), binding = parseTurnQuestionGateChoiceBinding(expected), waitId = turnScheduledGateChoiceWaitId(binding)
  const completed = status === "completed"
  const base = ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable", "scheduledGateChoiceBinding"]
  const hasAck = !!row && Object.hasOwn(row, "scheduledGateChoiceResumeAcknowledgement")
  if (!row || !binding || !waitId || !exactKeys(row, completed
    ? [...base, "answeredAt", ...(hasAck ? ["scheduledGateChoiceResumeAcknowledgement"] : [])] : base)
    || row.waitKind !== "question" || row.questionId !== waitId || row.toolCallId !== null || row.stage !== "scheduled_gate"
    || !boundedText(row.question, TURN_SCHEDULED_GATE_CHOICE_MAX_QUESTION_BYTES) || !sameChoiceOptions(row.options, choices[binding.kind])) return undefined
  const storedBinding = parseTurnQuestionGateChoiceBinding(row.scheduledGateChoiceBinding)
  if (!storedBinding || !sameJson(storedBinding, binding)) return undefined
  const resumeAcknowledgement = parseTurnScheduledGateChoiceResumeAcknowledgement(
    hasAck ? row.scheduledGateChoiceResumeAcknowledgement : undefined, binding, waitId, `agent-wait:question:${waitId}`)
  if (resumeAcknowledgement === undefined) return undefined
  if (status === "started" && !hasAck && row.answer === null && row.answerAvailable === false) return { answer: null, resumeAcknowledgement: null }
  return completed && validIso(row.answeredAt) && row.answerAvailable === true && !binding.allowedChoiceIds.includes(row.answer as TurnQuestionGateChoiceAnswer)
    ? undefined : completed && validIso(row.answeredAt) && row.answerAvailable === true
      ? { answer: row.answer as TurnQuestionGateChoiceAnswer, resumeAcknowledgement } : undefined
}

export function createTurnScheduledGateChoiceResumeAcknowledgement(input: Readonly<{
  binding: unknown; gateTaskId: string; requestAttemptCount: number; waitId: string; itemId: string; resumedAttemptCount: number
}>): TurnQuestionGateChoiceResumeAcknowledgement | null {
  const binding = parseTurnQuestionGateChoiceBinding(input.binding)
  if (!binding || input.gateTaskId !== binding.gateTaskId || input.requestAttemptCount !== binding.gateAttempt
    || input.waitId !== turnScheduledGateChoiceWaitId(binding) || input.itemId !== `agent-wait:question:${input.waitId}`
    || !positive(input.requestAttemptCount) || input.resumedAttemptCount !== input.requestAttemptCount + 1) return null
  return { gateTaskId: input.gateTaskId, requestAttemptCount: input.requestAttemptCount, waitId: input.waitId,
    itemId: input.itemId, resumedAttemptCount: input.resumedAttemptCount }
}

export function parseTurnScheduledGateChoiceResumeAcknowledgement(value: unknown, bindingValue: unknown, waitId: string, itemId: string): TurnQuestionGateChoiceResumeAcknowledgement | null | undefined {
  if (value === undefined) return null
  const row = record(value), binding = parseTurnQuestionGateChoiceBinding(bindingValue)
  if (!row || !binding || !exactKeys(row, ["gateTaskId", "requestAttemptCount", "waitId", "itemId", "resumedAttemptCount"])
    || row.gateTaskId !== binding.gateTaskId || row.requestAttemptCount !== binding.gateAttempt || row.waitId !== waitId
    || row.itemId !== itemId || row.resumedAttemptCount !== binding.gateAttempt + 1) return undefined
  return { gateTaskId: binding.gateTaskId, requestAttemptCount: binding.gateAttempt, waitId, itemId,
    resumedAttemptCount: binding.gateAttempt + 1 }
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...expected].sort().join(",") }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function validOwner(owner: Record<string, unknown>): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.executionId].every(validId)
    && positive(owner.rootAttemptCount) && Number.isSafeInteger(owner.executionAttemptCount) && Number(owner.executionAttemptCount) >= 0
}
function stableOwner(owner: Record<string, unknown>): TurnQuestionGateChoiceOwner {
  return { userId: String(owner.userId), sessionId: String(owner.sessionId), turnId: String(owner.turnId), rootTaskId: String(owner.rootTaskId),
    rootAttemptCount: Number(owner.rootAttemptCount), executionId: String(owner.executionId), executionAttemptCount: Number(owner.executionAttemptCount) }
}
function text(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value) }
function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && Buffer.byteLength(value, "utf8") <= maxBytes
}
function jobIds(value: unknown, kind: TurnQuestionGateChoiceKind): value is string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > TURN_SCHEDULED_GATE_CHOICE_MAX_JOBS
    || kind === "weak_cover_letter" && value.length !== 1) return false
  const seen = new Set<string>()
  for (const id of value) { if (!validId(id) || seen.has(id)) return false; seen.add(id) }
  return true
}
function choiceIds(value: unknown, kind: TurnQuestionGateChoiceKind): boolean {
  return Array.isArray(value) && sameJson(value, choices[kind].map(choice => choice.value))
}
function sameChoiceOptions(value: unknown, expected: readonly Readonly<{ label: string; value: TurnQuestionGateChoiceAnswer }>[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => {
    const option = record(entry), expectedOption = expected[index]
    return !!option && !!expectedOption && exactKeys(option, ["label", "value"])
      && option.label === expectedOption.label && option.value === expectedOption.value
  })
}
function sameJson(left: unknown, right: unknown): boolean {
  try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false }
}
function validIso(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
