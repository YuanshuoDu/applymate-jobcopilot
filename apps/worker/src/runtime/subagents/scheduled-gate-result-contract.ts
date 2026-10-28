import { createHash } from "node:crypto"

export type ScheduledGateQuestionKind = "borderline_match" | "weak_cover_letter"
export type ScheduledGateChoiceId = "add_to_pending" | "skip" | "lower_threshold" | "continue" | "review"
export type ScheduledGateQuestion = Readonly<{
  status: "question_required"
  kind: ScheduledGateQuestionKind
  jobIds: readonly string[]
  candidateSetDigest: string
  allowedChoiceIds: readonly ScheduledGateChoiceId[]
}>
export type ScheduledGateCompletion = Readonly<{
  status: "completed"
  nextStage: "execute"
  approvedJobIds: readonly string[]
  pendingJobIds: readonly string[]
  skippedJobIds: readonly string[]
  counts: Readonly<{ approved: number; pending: number; skipped: number }>
}>
export type ScheduledGateResult = ScheduledGateQuestion | ScheduledGateCompletion
export type ScheduledGateTaskEnvelope = Readonly<{
  finalItemId: null
  finalText: ""
  status: "waiting_for_user" | "completed"
  stepCount: 0
  toolCallCount: 0
  taskGraphVerificationReport: null
  structuredResult: ScheduledGateResult
}>

const MAX_JOBS = 50
const CHOICES: Readonly<Record<ScheduledGateQuestionKind, readonly ScheduledGateChoiceId[]>> = Object.freeze({
  borderline_match: Object.freeze(["add_to_pending", "skip", "lower_threshold"] as const),
  weak_cover_letter: Object.freeze(["continue", "review", "skip"] as const),
})

/** Parses only the bounded public Gate DTO; private question bindings and material text are not part of this contract. */
export function parseScheduledGateResult(value: unknown, expectedJobIds: readonly string[]): ScheduledGateResult | null {
  if (!validIds(expectedJobIds)) return null
  const row = exactRecord(value)
  if (!row) return null
  if (row.status === "question_required") {
    const question = exactRecord(value, ["status", "kind", "jobIds", "candidateSetDigest", "allowedChoiceIds"])
    const kind = question?.kind
    const ids = question && idsOrNull(question.jobIds)
    if (!question || !isQuestionKind(kind) || !ids || ids.length === 0
      || (kind === "weak_cover_letter" && ids.length !== 1)
      || ids.some(id => !expectedJobIds.includes(id))
      || question.candidateSetDigest !== scheduledGateCandidateSetDigest(kind, ids)
      || !sameStrings(question.allowedChoiceIds, CHOICES[kind])) return null
    return { status: "question_required", kind, jobIds: ids, candidateSetDigest: question.candidateSetDigest as string,
      allowedChoiceIds: [...CHOICES[kind]] }
  }
  const completion = exactRecord(value, ["status", "nextStage", "approvedJobIds", "pendingJobIds", "skippedJobIds", "counts"])
  const approved = completion && idsOrNull(completion.approvedJobIds), pending = completion && idsOrNull(completion.pendingJobIds)
  const skipped = completion && idsOrNull(completion.skippedJobIds), counts = completion && exactRecord(completion.counts, ["approved", "pending", "skipped"])
  if (!completion || completion.status !== "completed" || completion.nextStage !== "execute"
    || !approved || !pending || !skipped || !counts || approved.length !== 0 || counts.approved !== 0
    || !sameSet([...approved, ...pending, ...skipped], expectedJobIds)
    || new Set([...approved, ...pending, ...skipped]).size !== expectedJobIds.length
    || counts.approved !== approved.length || counts.pending !== pending.length || counts.skipped !== skipped.length) return null
  return { status: "completed", nextStage: "execute", approvedJobIds: approved, pendingJobIds: pending, skippedJobIds: skipped,
    counts: { approved: approved.length, pending: pending.length, skipped: skipped.length } }
}

/** Correlates the fixed invocation envelope with its row status and strict inner DTO. */
export function parseScheduledGateTaskEnvelope(value: unknown, taskStatus: unknown,
  expectedJobIds: readonly string[]): ScheduledGateTaskEnvelope | null {
  const row = exactRecord(parseJson(value), ["finalItemId", "finalText", "status", "stepCount", "toolCallCount", "taskGraphVerificationReport", "structuredResult"])
  const structuredResult = row && parseScheduledGateResult(row.structuredResult, expectedJobIds)
  const status = structuredResult?.status === "question_required" ? "waiting_for_user"
    : structuredResult?.status === "completed" ? "completed" : null
  if (!row || !structuredResult || !status || row.status !== status || taskStatus !== status
    || row.finalItemId !== null || row.finalText !== "" || row.stepCount !== 0 || row.toolCallCount !== 0
    || row.taskGraphVerificationReport !== null) return null
  return { finalItemId: null, finalText: "", status, stepCount: 0, toolCallCount: 0,
    taskGraphVerificationReport: null, structuredResult }
}

/** Validates a private fixed choice against the freshly recomputed public question. */
export function parseScheduledGateChoice(value: unknown, question: ScheduledGateQuestion): ScheduledGateChoiceId | null {
  const choice = exactRecord(value, ["kind", "jobIds", "choiceId"]), ids = choice && idsOrNull(choice.jobIds)
  return !choice || choice.kind !== question.kind || !ids || !sameSet(ids, question.jobIds)
    || !CHOICES[question.kind].includes(choice.choiceId as ScheduledGateChoiceId) ? null : choice.choiceId as ScheduledGateChoiceId
}

/** Digest input matches the Web projection: [kind, sorted job IDs]. */
export function scheduledGateCandidateSetDigest(kind: ScheduledGateQuestionKind, jobIds: readonly string[]): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify([kind, [...jobIds].sort()]), "utf8").digest("hex")
}

function parseJson(value: unknown): unknown { if (typeof value !== "string") return value; try { return JSON.parse(value) as unknown } catch { return null } }
function isQuestionKind(value: unknown): value is ScheduledGateQuestionKind { return value === "borderline_match" || value === "weak_cover_letter" }
function validIds(value: readonly string[]): boolean { return Array.isArray(value) && value.length <= MAX_JOBS && dense(value) && value.every(validId) && new Set(value).size === value.length }
function idsOrNull(value: unknown): string[] | null { return Array.isArray(value) && value.length <= MAX_JOBS && dense(value)
  && value.every(validId) && new Set(value).size === value.length ? [...value] : null }
function dense(value: readonly unknown[]): boolean { return Reflect.ownKeys(value).length === value.length + 1
  && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length) }
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function exactRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value), ownKeys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys && (ownKeys.length !== keys.length
      || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)))) return null
    for (const key of ownKeys) { if (typeof key !== "string") return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return null }
    return value as Record<string, unknown>
  } catch { return null }
}
function sameStrings(value: unknown, expected: readonly string[]): boolean { return Array.isArray(value) && dense(value)
  && value.length === expected.length && value.every((entry, index) => entry === expected[index]) }
function sameSet(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length
  && new Set(left).size === left.length && right.every(id => left.includes(id)) }
