import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { scheduledPipelineContinuationKeyVersion } from "@jobcopilot/agent-protocol"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "../subagents/scheduled-taskgraph-continuation-receipt.js"

export const TURN_SCHEDULED_PREPARE_CHOICE_SCHEMA = "agent-harness.v2.scheduled-prepare-choice-wait.v1" as const
export const TURN_SCHEDULED_PREPARE_CHOICE_STAGE = "scheduled_prepare" as const
export const TURN_SCHEDULED_PREPARE_CHOICE_QUESTION = "How should ApplyMate tailor your resume for this role?"
export const TURN_SCHEDULED_PREPARE_CHOICE_OPTIONS = [
  { label: "Apply AI changes", value: "apply_ai_changes" },
  { label: "Keep my current resume", value: "keep_resume" },
] as const

export type TurnScheduledPrepareChoice = "apply_ai_changes" | "keep_resume"
export type TurnQuestionScheduledChoiceOwner = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  executionId: string; executionAttemptCount: number
}>
export type TurnQuestionScheduledChoiceBinding = Readonly<{
  schemaVersion: typeof TURN_SCHEDULED_PREPARE_CHOICE_SCHEMA
  owner: TurnQuestionScheduledChoiceOwner
  continuationKey: string
  snapshotDigest: string
  evidenceDigest: string
  checkpointDigest: string
  analyzeGraphRevision: number
  prepareScheduleRevision: number
  finalStepId: string
  finalStepOrdinal: number
  finalStepAttempt: 1
}>
export type TurnQuestionScheduledChoiceContent = Readonly<{
  waitKind: "question"; questionId: string; toolCallId: null; stage: typeof TURN_SCHEDULED_PREPARE_CHOICE_STAGE
  question: typeof TURN_SCHEDULED_PREPARE_CHOICE_QUESTION; options: typeof TURN_SCHEDULED_PREPARE_CHOICE_OPTIONS
  answer: TurnScheduledPrepareChoice | null; answerAvailable: boolean; scheduledPrepareChoiceBinding: TurnQuestionScheduledChoiceBinding
}>
export type TurnQuestionScheduledChoiceReadInput = Readonly<{ owner: TurnExecutionOwnerFence; now: Date; receipt: unknown }>
export type TurnQuestionScheduledChoiceRecovery =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "waiting"; waitId: string; itemId: string; binding: TurnQuestionScheduledChoiceBinding }>
  | Readonly<{ status: "answered"; waitId: string; itemId: string; answer: TurnScheduledPrepareChoice; binding: TurnQuestionScheduledChoiceBinding }>

type Row = Record<string, unknown>

/** Recomputes a bounded scheduled Analyze checkpoint from persisted server-owned state. */
export function scheduledAnalyzeCheckpointEvidence(value: unknown): Readonly<{
  checkpointDigest: string; owner: TurnQuestionScheduledChoiceOwner; continuationKey: string
  snapshotDigest: string; evidenceDigest: string; analyzeGraphRevision: number
}> | null {
  const state = record(value), marker = record(state?.scheduledTaskGraphContinuation), owner = record(marker?.owner)
  const ownerKeys = ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion", "executionId", "executionAttemptCount"]
  const scouted = dense(state?.scoutedJobs), scored = dense(state?.scoredJobs)
  if (!state || state.nextStage !== "prepare" || !marker || !owner || !exactKeys(owner, ownerKeys)
    || ![owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.turnLeaseOwnerId, owner.executionId].every(validId)
    || !positive(owner.rootAttemptCount) || !positive(owner.turnLeaseVersion) || !Number.isSafeInteger(owner.executionAttemptCount)
    || Number(owner.executionAttemptCount) < 0 || !exactKeys(marker, ["schemaVersion", "key", "owner", "snapshotDigest", "graphRevision", "evidenceDigest"])
    || marker.schemaVersion !== "agent-harness.v2.scheduled-pipeline-continuation.v1"
    || scheduledPipelineContinuationKeyVersion(marker.key) === null || typeof marker.snapshotDigest !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(marker.snapshotDigest) || typeof marker.evidenceDigest !== "string"
    || !/^[a-f0-9]{64}$/.test(marker.evidenceDigest) || !positive(marker.graphRevision)
    || !safeInteger(state.analysisFailed) || state.analysisFailed < 0 || !scouted || !scored) return null
  const ids = new Set<string>()
  for (const raw of scouted) { const job = record(raw); if (!job || !validId(job.id) || job.userId !== owner.userId || ids.has(job.id)) return null; ids.add(job.id) }
  if (state.analysisFailed + scored.length !== ids.size) return null
  const seen = new Set<string>(), rows: Row[] = []
  for (const raw of scored) {
    const row = record(raw), job = record(row?.job), hasFence = !!row && Object.hasOwn(row, "analysisFenceAt")
    if (!row || !job || !validId(job.id) || job.userId !== owner.userId || !ids.has(job.id) || seen.has(job.id)
      || !safeInteger(row.score) || row.score < 0 || row.score > 100 || !stringArray(row.matchedKeywords) || !stringArray(row.missingKeywords)
      || typeof row.recommendation !== "string" || row.recommendation.length > 8192
      || !exactKeys(row, hasFence ? ["job", "score", "matchedKeywords", "missingKeywords", "recommendation", "analysisFenceAt"] : ["job", "score", "matchedKeywords", "missingKeywords", "recommendation"])
      || hasFence && !validIso(row.analysisFenceAt)) return null
    seen.add(job.id); rows.push({ jobId: job.id, score: row.score, matchedKeywords: [...row.matchedKeywords as string[]],
      missingKeywords: [...row.missingKeywords as string[]], recommendation: row.recommendation, ...(hasFence ? { analysisFenceAt: row.analysisFenceAt } : {}) })
  }
  const projection = { owner: [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount, owner.executionId,
    owner.executionAttemptCount], snapshotDigest: marker.snapshotDigest, evidenceDigest: marker.evidenceDigest,
      analyzeGraphRevision: marker.graphRevision, analysisFailed: state.analysisFailed, scoredJobs: rows }
  try {
    const checkpointDigest = createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")
    const continuationKey = scheduledTaskGraphStableContinuationKey({ owner, continuationKey: marker.key,
      snapshotDigest: marker.snapshotDigest, evidenceDigest: marker.evidenceDigest, checkpointDigest,
      analyzeGraphRevision: marker.graphRevision, prepareScheduleRevision: marker.graphRevision + 1 })
    return continuationKey ? { checkpointDigest, owner: stableChoiceOwner(owner), continuationKey,
      snapshotDigest: marker.snapshotDigest, evidenceDigest: marker.evidenceDigest, analyzeGraphRevision: marker.graphRevision } : null
  } catch { return null }
}

export function buildTurnQuestionScheduledChoiceBinding(input: Readonly<{ receipt: unknown; finalStepId: string; finalStepOrdinal: number }>): TurnQuestionScheduledChoiceBinding | null {
  const receipt = parseScheduledTaskGraphContinuationReceipt(input.receipt)
  if (!receipt || !validId(input.finalStepId) || !Number.isSafeInteger(input.finalStepOrdinal) || input.finalStepOrdinal < 0) return null
  return buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence({ owner: stableChoiceOwner(receipt.owner), continuationKey: receipt.continuationKey,
    snapshotDigest: receipt.snapshotDigest, evidenceDigest: receipt.evidenceDigest, checkpointDigest: receipt.checkpointDigest,
    analyzeGraphRevision: receipt.analyzeGraphRevision, finalStepId: input.finalStepId, finalStepOrdinal: input.finalStepOrdinal })
}
export function buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence(input: Readonly<{
  owner: TurnQuestionScheduledChoiceOwner; continuationKey: string; snapshotDigest: string; evidenceDigest: string; checkpointDigest: string
  analyzeGraphRevision: number; finalStepId: string; finalStepOrdinal: number
}>): TurnQuestionScheduledChoiceBinding | null {
  return parseTurnQuestionScheduledChoiceBinding({ schemaVersion: TURN_SCHEDULED_PREPARE_CHOICE_SCHEMA, owner: input.owner,
    continuationKey: input.continuationKey, snapshotDigest: input.snapshotDigest, evidenceDigest: input.evidenceDigest,
    checkpointDigest: input.checkpointDigest, analyzeGraphRevision: input.analyzeGraphRevision,
    prepareScheduleRevision: input.analyzeGraphRevision + 1, finalStepId: input.finalStepId,
    finalStepOrdinal: input.finalStepOrdinal, finalStepAttempt: 1 })
}
export function scheduledPrepareChoiceWaitId(input: Readonly<{ receipt: unknown; finalStepId: string; finalStepOrdinal: number }>): string | null {
  return turnScheduledPrepareChoiceWaitId(buildTurnQuestionScheduledChoiceBinding(input))
}
export function parseTurnQuestionScheduledChoiceBinding(value: unknown): TurnQuestionScheduledChoiceBinding | null {
  const row = record(value), owner = record(row?.owner)
  if (!row || !owner || !exactKeys(row, ["schemaVersion", "owner", "continuationKey", "snapshotDigest", "evidenceDigest", "checkpointDigest",
    "analyzeGraphRevision", "prepareScheduleRevision", "finalStepId", "finalStepOrdinal", "finalStepAttempt"])
    || !exactKeys(owner, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"])
    || row.schemaVersion !== TURN_SCHEDULED_PREPARE_CHOICE_SCHEMA || !validScheduledChoiceOwner(owner)
    || typeof row.continuationKey !== "string" || scheduledPipelineContinuationKeyVersion(row.continuationKey) === null
    || !validText(row.snapshotDigest, /^sha256:[a-f0-9]{64}$/)
    || !validText(row.evidenceDigest, /^[a-f0-9]{64}$/) || !validText(row.checkpointDigest, /^[a-f0-9]{64}$/)
    || !positive(row.analyzeGraphRevision) || !positive(row.prepareScheduleRevision)
    || row.prepareScheduleRevision !== row.analyzeGraphRevision + 1 || !validId(row.finalStepId)
    || !Number.isSafeInteger(row.finalStepOrdinal) || Number(row.finalStepOrdinal) < 0 || row.finalStepAttempt !== 1) return null
  return { schemaVersion: TURN_SCHEDULED_PREPARE_CHOICE_SCHEMA, owner: stableChoiceOwner(owner), continuationKey: row.continuationKey,
    snapshotDigest: row.snapshotDigest, evidenceDigest: row.evidenceDigest, checkpointDigest: row.checkpointDigest,
    analyzeGraphRevision: Number(row.analyzeGraphRevision), prepareScheduleRevision: Number(row.prepareScheduleRevision),
    finalStepId: row.finalStepId, finalStepOrdinal: Number(row.finalStepOrdinal), finalStepAttempt: 1 }
}
export function turnScheduledPrepareChoiceWaitId(value: unknown): string | null {
  const binding = parseTurnQuestionScheduledChoiceBinding(value)
  if (!binding) return null
  const { owner } = binding, projection = [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.rootAttemptCount,
    owner.executionId, owner.executionAttemptCount, binding.continuationKey, binding.snapshotDigest, binding.evidenceDigest,
    binding.checkpointDigest, binding.analyzeGraphRevision, binding.prepareScheduleRevision, binding.finalStepId,
    binding.finalStepOrdinal, binding.finalStepAttempt]
  return `agent-question:${owner.turnId}:canonical:${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`
}
export function createTurnScheduledPrepareChoiceContent(waitId: string, binding: TurnQuestionScheduledChoiceBinding): TurnQuestionScheduledChoiceContent {
  return { waitKind: "question", questionId: waitId, toolCallId: null, stage: TURN_SCHEDULED_PREPARE_CHOICE_STAGE,
    question: TURN_SCHEDULED_PREPARE_CHOICE_QUESTION, options: TURN_SCHEDULED_PREPARE_CHOICE_OPTIONS,
    answer: null, answerAvailable: false, scheduledPrepareChoiceBinding: binding }
}
export function parseTurnScheduledPrepareChoiceItem(value: unknown, status: unknown, bindingValue: unknown): TurnScheduledPrepareChoice | null | undefined {
  const row = record(value), binding = parseTurnQuestionScheduledChoiceBinding(bindingValue)
  if (!row || !binding || !exactKeys(row, status === "completed" ? ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable", "scheduledPrepareChoiceBinding", "answeredAt"]
    : ["waitKind", "questionId", "toolCallId", "stage", "question", "options", "answer", "answerAvailable", "scheduledPrepareChoiceBinding"])
    || row.waitKind !== "question" || row.questionId !== turnScheduledPrepareChoiceWaitId(binding) || row.toolCallId !== null
    || row.stage !== TURN_SCHEDULED_PREPARE_CHOICE_STAGE || row.question !== TURN_SCHEDULED_PREPARE_CHOICE_QUESTION
    || !sameJson(row.options, TURN_SCHEDULED_PREPARE_CHOICE_OPTIONS) || !sameJson(row.scheduledPrepareChoiceBinding, binding)) return undefined
  if (status === "started" && row.answer === null && row.answerAvailable === false) return null
  return status === "completed" && validIso(row.answeredAt) && row.answerAvailable === true
    && (row.answer === "apply_ai_changes" || row.answer === "keep_resume") ? row.answer : undefined
}

function stableChoiceOwner(owner: Row): TurnQuestionScheduledChoiceOwner {
  return { userId: String(owner.userId), sessionId: String(owner.sessionId), turnId: String(owner.turnId), rootTaskId: String(owner.rootTaskId),
    rootAttemptCount: Number(owner.rootAttemptCount), executionId: String(owner.executionId), executionAttemptCount: Number(owner.executionAttemptCount) }
}
function validScheduledChoiceOwner(owner: Row): boolean {
  return [owner.userId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.executionId].every(validId)
    && positive(owner.rootAttemptCount) && Number.isSafeInteger(owner.executionAttemptCount) && Number(owner.executionAttemptCount) >= 0
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function exactKeys(value: Row, expected: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...expected].sort().join(",") }
function sameJson(left: unknown, right: unknown): boolean {
  const sorted = new WeakMap<object, object>(), stable = (value: unknown) => JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    const canonical = sorted.get(item) ?? Object.fromEntries(Object.entries(item).sort())
    sorted.set(item, canonical); sorted.set(canonical, canonical); return canonical
  })
  try { return stable(left) === stable(right) } catch { return false }
}
function validText(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value) }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function safeInteger(value: unknown): value is number { return Number.isSafeInteger(value) }
function dense(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) return null
  for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) return null
  return value
}
function stringArray(value: unknown): value is string[] { const rows = dense(value); return !!rows && rows.every(item => typeof item === "string") }
function validIso(value: unknown): boolean { return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value }
