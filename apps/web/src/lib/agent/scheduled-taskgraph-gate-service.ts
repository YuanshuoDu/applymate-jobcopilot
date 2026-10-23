import { createHash } from "node:crypto"
import type { ScheduledTaskGraphGateHandoff } from "./scheduled-taskgraph-gate-checkpoint"
import type { PipelineCtx } from "./pipeline-context"
import type { ApplicationPackage } from "./types"

export type ScheduledTaskGraphGateQuestionKind = "borderline_match" | "weak_cover_letter"
export type ScheduledTaskGraphGateChoiceId = "add_to_pending" | "skip" | "lower_threshold" | "continue" | "review"

export type ScheduledTaskGraphGateQuestion = Readonly<{
  status: "question_required"
  kind: ScheduledTaskGraphGateQuestionKind
  jobIds: readonly string[]
  candidateSetDigest: string
  allowedChoiceIds: readonly ScheduledTaskGraphGateChoiceId[]
}>
export type ScheduledTaskGraphGateQuestionIdentity = Readonly<Pick<ScheduledTaskGraphGateQuestion, "kind" | "jobIds">>
export type ScheduledTaskGraphGateChoice = Readonly<{
  kind: ScheduledTaskGraphGateQuestionKind
  jobIds: readonly string[]
  choiceId: ScheduledTaskGraphGateChoiceId
}>

export type ScheduledTaskGraphGateCompletion = Readonly<{
  status: "completed"
  nextStage: "execute"
  approvedJobIds: readonly string[]
  pendingJobIds: readonly string[]
  skippedJobIds: readonly string[]
  counts: Readonly<{ approved: number; pending: number; skipped: number }>
}>

export type ScheduledTaskGraphGateResult = ScheduledTaskGraphGateQuestion | ScheduledTaskGraphGateCompletion
export type ScheduledTaskGraphGatePolicyPort = (
  packages: readonly ApplicationPackage[],
  context: PipelineCtx,
  validatedChoice?: unknown,
  priorChoices?: readonly unknown[],
) => Promise<ScheduledTaskGraphGateQuestion | ScheduledTaskGraphGateCompletion>

export type ScheduledTaskGraphGateServiceInput = Readonly<{
  /** Built only after exact Prepare proof, live TaskGraph, and owner-scoped material checks pass. */
  handoff: ScheduledTaskGraphGateHandoff
  context: PipelineCtx
  /** Worker-loaded fixed choice whose private binding was validated for this Gate task attempt. */
  validatedChoice?: unknown
  /** Worker-loaded earlier choices bound to this same Gate execution and immutable inputs. */
  priorChoices?: readonly unknown[]
}>

const MAX_JOB_IDS = 50
const MAX_HISTORY_DECISIONS = MAX_JOB_IDS + 1
const CHOICES: Record<ScheduledTaskGraphGateQuestionKind, readonly ScheduledTaskGraphGateChoiceId[]> = {
  borderline_match: ["add_to_pending", "skip", "lower_threshold"],
  weak_cover_letter: ["continue", "review", "skip"],
}

/** Invokes the shared policy only with a verified handoff and projects a bounded Gate result. */
export async function executeScheduledTaskGraphGate(
  input: ScheduledTaskGraphGateServiceInput,
  policy: ScheduledTaskGraphGatePolicyPort,
): Promise<ScheduledTaskGraphGateResult> {
  const packages = input.handoff?.packages
  const expectedJobIds = Array.isArray(packages) ? parseIds(packages.map(pkg => pkg.job?.id)) : null
  if (input.handoff?.checkpoint?.nextStage !== "gate" || !expectedJobIds
    || input.context.askUser !== undefined) throw new Error("scheduled_taskgraph_gate_result_invalid")
  const outcome = await policy(packages, input.context, input.validatedChoice, input.priorChoices)
  const expectedQuestion = outcome?.status === "question_required" && outcome.kind === "borderline_match"
    ? { kind: outcome.kind, jobIds: packages.filter(pkg => pkg.score >= input.context.agentCfg.minMatchScore - 5
      && pkg.score < input.context.agentCfg.minMatchScore).map(pkg => pkg.job.id) }
    : outcome?.status === "question_required" ? { kind: outcome.kind, jobIds: outcome.jobIds } : undefined
  const parsed = parseScheduledTaskGraphGateResult(outcome, expectedJobIds, expectedQuestion)
  if (!parsed) throw new Error("scheduled_taskgraph_gate_result_invalid")
  return parsed
}

/** Builds the bounded question identity from Gate-derived candidate IDs; text and private bindings stay elsewhere. */
export function createScheduledTaskGraphGateQuestion(
  kind: ScheduledTaskGraphGateQuestionKind,
  jobIds: readonly string[],
): ScheduledTaskGraphGateQuestion | null {
  if ((kind !== "borderline_match" && kind !== "weak_cover_letter") || !validCandidateIds(jobIds)
    || (kind === "weak_cover_letter" && jobIds.length !== 1)) return null
  return { status: "question_required", kind, jobIds: [...jobIds], candidateSetDigest: candidateSetDigest(kind, jobIds),
    allowedChoiceIds: [...CHOICES[kind]] }
}

/** Accepts only a strict Gate projection that partitions the exact verified package set. */
export function parseScheduledTaskGraphGateResult(
  value: unknown,
  expectedJobIds: readonly string[],
  expectedQuestion?: ScheduledTaskGraphGateQuestionIdentity,
): ScheduledTaskGraphGateResult | null {
  if (!validJobIds(expectedJobIds)) return null
  const row = exactRecord(value)
  if (!row) return null
  if (row.status === "question_required") {
    const question = exactRecord(value, ["status", "kind", "jobIds", "candidateSetDigest", "allowedChoiceIds"])
    const kind = question?.kind
    const ids = question && parseIds(question.jobIds)
    if (!question || (kind !== "borderline_match" && kind !== "weak_cover_letter") || !ids || !validCandidateIds(ids)
      || kind === "weak_cover_letter" && ids.length !== 1
      || ids.some(id => !expectedJobIds.includes(id)) || !expectedQuestion || expectedQuestion.kind !== kind
      || !validCandidateIds(expectedQuestion.jobIds) || !sameSet(ids, expectedQuestion.jobIds)
      || question.candidateSetDigest !== candidateSetDigest(kind, ids)
      || !sameStrings(question.allowedChoiceIds, CHOICES[kind])) return null
    return { status: "question_required", kind, jobIds: ids,
      candidateSetDigest: question.candidateSetDigest as string, allowedChoiceIds: [...CHOICES[kind]] }
  }
  const completion = exactRecord(value, ["status", "nextStage", "approvedJobIds", "pendingJobIds", "skippedJobIds", "counts"])
  const approved = completion && parseIds(completion.approvedJobIds)
  const pending = completion && parseIds(completion.pendingJobIds)
  const skipped = completion && parseIds(completion.skippedJobIds)
  const counts = completion && exactRecord(completion.counts, ["approved", "pending", "skipped"])
  if (!completion || completion.status !== "completed" || completion.nextStage !== "execute"
    || !approved || !pending || !skipped || !counts
    || !sameSet([...approved, ...pending, ...skipped], expectedJobIds)
    || new Set([...approved, ...pending, ...skipped]).size !== expectedJobIds.length
    || approved.length !== 0 || counts.approved !== 0
    || counts.pending !== pending.length || counts.skipped !== skipped.length) return null
  return { status: "completed", nextStage: "execute", approvedJobIds: approved, pendingJobIds: pending,
    skippedJobIds: skipped, counts: { approved: approved.length, pending: pending.length, skipped: skipped.length } }
}

/** A Worker-loaded answer is usable only for the freshly recomputed Gate question and fixed choices. */
export function parseScheduledTaskGraphGateChoice(value: unknown, question: ScheduledTaskGraphGateQuestion): ScheduledTaskGraphGateChoiceId | null {
  const choice = exactRecord(value, ["kind", "jobIds", "choiceId"])
  const ids = choice && parseIds(choice.jobIds)
  if (!choice || choice.kind !== question.kind || !ids || !sameSet(ids, question.jobIds)
    || !CHOICES[question.kind].includes(choice.choiceId as ScheduledTaskGraphGateChoiceId)) return null
  return choice.choiceId as ScheduledTaskGraphGateChoiceId
}

/** Validates prior private decisions and the single current answer against this recomputed candidate set. */
export function parseScheduledTaskGraphGateChoiceHistory(
  priorValues: unknown,
  currentValue: unknown,
  expectedJobIds: readonly string[],
  borderline: ScheduledTaskGraphGateQuestionIdentity | null,
): { priorChoices: readonly ScheduledTaskGraphGateChoice[]; currentChoice: ScheduledTaskGraphGateChoice | null } | null {
  if (!validJobIds(expectedJobIds) || !Array.isArray(priorValues) || priorValues.length > MAX_HISTORY_DECISIONS) return null
  const parse = (value: unknown) => {
    const row = exactRecord(value, ["kind", "jobIds", "choiceId"])
    const ids = row && parseIds(row.jobIds)
    if (!row || !ids || (row.kind !== "borderline_match" && row.kind !== "weak_cover_letter")) return null
    const identity: ScheduledTaskGraphGateQuestionIdentity | null = row.kind === "borderline_match" ? borderline
      : ids.length === 1 && expectedJobIds.includes(ids[0]!) ? { kind: "weak_cover_letter", jobIds: ids } : null
    if (!identity || identity.kind !== row.kind || !sameSet(ids, identity.jobIds)) return null
    const question = createScheduledTaskGraphGateQuestion(identity.kind, identity.jobIds)
    if (!question) return null
    const choiceId = parseScheduledTaskGraphGateChoice(value, question)
    return choiceId ? { kind: identity.kind, jobIds: [...identity.jobIds], choiceId } : null
  }
  const priorChoices = priorValues.map(parse)
  const currentChoice = currentValue === undefined ? null : parse(currentValue)
  if (priorChoices.some(choice => !choice) || (currentValue !== undefined && !currentChoice)) return null
  const decisions = [...priorChoices, ...(currentChoice ? [currentChoice] : [])] as ScheduledTaskGraphGateChoice[]
  if (decisions.length > MAX_HISTORY_DECISIONS) return null
  const keys = decisions.map(choice => JSON.stringify([choice.kind, [...choice.jobIds].sort()]))
  if (new Set(keys).size !== keys.length) return null
  return { priorChoices: priorChoices as ScheduledTaskGraphGateChoice[], currentChoice }
}

export function scheduledTaskGraphGateChoiceKey(choice: ScheduledTaskGraphGateChoice): string {
  return JSON.stringify([choice.kind, [...choice.jobIds].sort()])
}

function candidateSetDigest(kind: ScheduledTaskGraphGateQuestionKind, ids: readonly string[]): string {
  const canonical = [...ids].sort()
  return `sha256:${createHash("sha256").update(JSON.stringify([kind, canonical]), "utf8").digest("hex")}`
}

function validCandidateIds(value: readonly string[]): boolean {
  return validJobIds(value) && value.length > 0
}
function validJobIds(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length <= MAX_JOB_IDS
    && value.every(validId) && new Set(value).size === value.length
}
function parseIds(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= MAX_JOB_IDS && value.every(validId) && new Set(value).size === value.length
    ? [...value] : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function exactRecord(value: unknown, keys?: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  const ownKeys = Reflect.ownKeys(value)
  if (keys && (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)))) return null
  return value as Record<string, unknown>
}
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && right.every(id => left.includes(id))
}
function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index])
}
