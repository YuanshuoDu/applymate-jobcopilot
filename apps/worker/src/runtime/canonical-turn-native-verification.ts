import { Buffer } from "node:buffer"
import { digestNativeVerificationValue, type NativeVerificationDisposition, type NativeVerificationReasonCode } from "./subagents/native-verification-contract.js"
import type { NativeVerificationEnsureResult, NativeVerificationFeedback, NativeVerificationPort, NativeVerificationRootGoalWitness } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitResult } from "./tools/coordination-types.js"
import { NATIVE_SEMANTIC_NO_PROGRESS, type TurnEngineCompletionGateResult } from "./turns/turn-execution-types.js"

const HASH = /^[a-f0-9]{64}$/
const REASONS: readonly NativeVerificationReasonCode[] = ["meets_criterion", "does_not_meet_criterion", "evidence_missing", "evidence_conflict", "ambiguous", "unsupported_claim"]
const DISPOSITIONS: readonly NativeVerificationDisposition[] = ["passed", "failed", "uncertain"]
export type NativeVerificationDecision =
  | Readonly<{ kind: "passed"; witness: NativeVerificationRootGoalWitness }>
  | Readonly<{ kind: "pending"; waitId: string }>
  | Readonly<{ kind: "blocked"; feedback: string; semanticRejectionControlTaskId?: string }>
export type NativeVerificationWaiter = (scope: TaskGraphExecutionScope, targetTaskIds: readonly string[]) => Promise<DurableWaitResult>

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length || Object.values(descriptors).some(item => !item.enumerable || !("value" in item))) return null
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: string): boolean { return Object.keys(value).sort().join(",") === keys }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 128 }
function denseStrings(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && Reflect.ownKeys(value).length === value.length + 1
    && value.every((item, index) => Object.hasOwn(value, index) && id(item)) && new Set(value).size === value.length
}
export function parseNativeVerificationWitness(value: unknown, candidateText: string): NativeVerificationRootGoalWitness | undefined {
  const row = record(value)
  if (!row || !exact(row, "candidateDigest,childBindingSetDigest,controlOperationId,controlTaskId,criteriaDigest,currentControlAttempt,evidencePacketDigest,goalDigest,reportDigest")
    || !id(row.controlTaskId) || !id(row.controlOperationId) || !Number.isSafeInteger(row.currentControlAttempt) || Number(row.currentControlAttempt) < 1
    || ![row.candidateDigest, row.childBindingSetDigest, row.criteriaDigest, row.evidencePacketDigest, row.goalDigest, row.reportDigest].every(item => typeof item === "string" && HASH.test(item))
    || row.candidateDigest !== digestNativeVerificationValue(candidateText)) return undefined
  return row as NativeVerificationRootGoalWitness
}
export function parseNativeVerificationFeedback(value: unknown): readonly NativeVerificationFeedback[] | undefined {
  if (!Array.isArray(value) || value.length > 32 || Reflect.ownKeys(value).length !== value.length + 1) return undefined
  const parsed: NativeVerificationFeedback[] = []
  for (let index = 0; index < value.length; index += 1) {
    const row = record(value[index])
    if (!row || !exact(row, "controlTaskId,criteria,disposition,targetTaskId") || !id(row.controlTaskId) || !id(row.targetTaskId)
      || !DISPOSITIONS.includes(row.disposition as NativeVerificationDisposition) || !Array.isArray(row.criteria) || row.criteria.length > 32
      || Reflect.ownKeys(row.criteria).length !== row.criteria.length + 1) return undefined
    const criteria: NativeVerificationFeedback["criteria"][number][] = []
    for (let child = 0; child < row.criteria.length; child += 1) {
      const criterion = record(row.criteria[child])
      if (!criterion || !exact(criterion, "criterionId,disposition,evidenceReferenceIds,reasonCode") || !id(criterion.criterionId)
        || !DISPOSITIONS.includes(criterion.disposition as NativeVerificationDisposition) || !REASONS.includes(criterion.reasonCode as NativeVerificationReasonCode)
        || !denseStrings(criterion.evidenceReferenceIds, 8)) return undefined
      criteria.push({ criterionId: criterion.criterionId, disposition: criterion.disposition as NativeVerificationDisposition,
        reasonCode: criterion.reasonCode as NativeVerificationReasonCode, evidenceReferenceIds: [...criterion.evidenceReferenceIds] })
    }
    parsed.push({ controlTaskId: row.controlTaskId, targetTaskId: row.targetTaskId, disposition: row.disposition as NativeVerificationDisposition, criteria })
  }
  return parsed
}
function ensureResult(value: unknown, candidateText: string, isRoot: boolean): NativeVerificationEnsureResult | undefined {
  const row = record(value)
  if (!row) return undefined
  const keys = Object.hasOwn(row, "rootGoalWitness")
    ? "controlTaskIds,feedback,pendingControlTaskIds,pendingTaskIds,rootGoalWitness,status"
    : "controlTaskIds,feedback,pendingControlTaskIds,pendingTaskIds,status"
  const controlTaskIds = row.controlTaskIds, pendingControlTaskIds = row.pendingControlTaskIds, pendingTaskIds = row.pendingTaskIds
  if (!exact(row, keys) || !["passed", "failed", "uncertain", "pending", "unavailable"].includes(String(row.status))
    || !denseStrings(controlTaskIds, 9) || !denseStrings(pendingControlTaskIds, 9) || !denseStrings(pendingTaskIds, 8)) return undefined
  const reports = parseNativeVerificationFeedback(row.feedback)
  if (!reports || pendingControlTaskIds.some(id => !controlTaskIds.includes(id)) || pendingTaskIds.some(id => id === "")) return undefined
  if (row.status === "pending" && pendingTaskIds.length === 0
    || row.status === "passed" && (pendingControlTaskIds.length > 0 || pendingTaskIds.length > 0)) return undefined
  if (isRoot && row.status === "passed" && !Object.hasOwn(row, "rootGoalWitness")
    || !isRoot && Object.hasOwn(row, "rootGoalWitness")) return undefined
  const parsedWitness = isRoot && row.status === "passed" ? parseNativeVerificationWitness(row.rootGoalWitness, candidateText) : undefined
  if (isRoot && row.status === "passed" && !parsedWitness || row.status !== "passed" && Object.hasOwn(row, "rootGoalWitness")) return undefined
  return { status: row.status as NativeVerificationEnsureResult["status"], controlTaskIds: [...controlTaskIds],
    pendingControlTaskIds: [...pendingControlTaskIds], pendingTaskIds: [...pendingTaskIds], feedback: reports,
    ...(parsedWitness ? { rootGoalWitness: parsedWitness } : {}) }
}
type RepairReason = Exclude<NativeVerificationReasonCode, "meets_criterion">
const REPAIR_ORDER: readonly RepairReason[] = ["evidence_missing", "evidence_conflict", "does_not_meet_criterion", "unsupported_claim", "ambiguous"]
const REPAIR_ACTION: Readonly<Record<RepairReason, string>> = {
  evidence_missing: "gather current owned evidence",
  evidence_conflict: "reconcile current owned sources and resolve contradictions",
  does_not_meet_criterion: "revise the answer against the criterion",
  unsupported_claim: "remove the claim or support it with current owned evidence",
  ambiguous: "resolve ambiguity from evidence; identify missing user facts and seek clarification when available, otherwise state uncertainty",
}
const VALID_REASON_DISPOSITIONS: Readonly<Record<NativeVerificationDisposition, readonly NativeVerificationReasonCode[]>> = {
  passed: ["meets_criterion"],
  failed: ["does_not_meet_criterion", "evidence_conflict", "unsupported_claim"],
  uncertain: ["evidence_missing", "evidence_conflict", "unsupported_claim", "ambiguous"],
}
export function nativeVerificationFeedbackText(status: string, value: unknown = [], replanFallback = false): string {
  const parsed = parseNativeVerificationFeedback(value)
  const safeStatus = ["passed", "failed", "uncertain", "pending", "unavailable"].includes(status) ? status : "unavailable"
  let output = `Independent native verification is ${safeStatus}.`
  if (!parsed) return output
  if (parsed.some(report => report.criteria.some(item => !VALID_REASON_DISPOSITIONS[item.disposition].includes(item.reasonCode)))) return output
  const rows = parsed.flatMap(report => report.criteria.filter(item => item.disposition !== "passed").map(item =>
    `target=${report.targetTaskId} criterion=${item.criterionId} status=${item.disposition} reason=${item.reasonCode}`))
  const reasons = new Set(parsed.flatMap(report => report.criteria.filter(item => item.disposition !== "passed").map(item => item.reasonCode)))
  const actions = REPAIR_ORDER.filter(reason => reasons.has(reason)).map(reason => `${reason}: ${REPAIR_ACTION[reason]}.`)
  const actionBlock = actions.length ? ` Actions: ${actions.join(" ")}` : ""
  if (actions.length) {
    if (output.length + actionBlock.length > 512) return output
    output += actionBlock
  } else if (replanFallback) output += " Replan against verified criteria using current owned evidence."
  for (const row of rows) if (output.length + row.length + 1 <= 512) output += ` ${row}`
  return output
}

function matchingFailedRootControl(result: NativeVerificationEnsureResult, rootTaskId: string): string | undefined {
  const matching = result.feedback.filter(report => report.targetTaskId === rootTaskId)
  if (matching.length !== 1) return undefined
  const report = matching[0]
  return report.disposition === "failed" && result.controlTaskIds.includes(report.controlTaskId)
    && report.criteria.some(item => item.disposition === "failed") ? report.controlTaskId : undefined
}
/** Runs child proof before root-candidate proof and durably waits on producer-owned controls. */
export async function verifyNativeRootCandidate(input: Readonly<{
  port: NativeVerificationPort
  scope: TaskGraphExecutionScope
  candidateText: string
  wait: NativeVerificationWaiter
}>): Promise<NativeVerificationDecision> {
  if (Buffer.byteLength(input.candidateText, "utf8") > 16 * 1024 || !input.candidateText.trim()) return { kind: "blocked", feedback: "Independent native verification received an invalid root candidate." }
  for (let immediateWakes = 0; immediateWakes < 3; immediateWakes += 1) {
    const children = ensureResult(await input.port.ensureChildren(input.scope), input.candidateText, false)
    if (!children) return { kind: "blocked", feedback: "Independent native child verification is unavailable or malformed." }
    if (children.status === "pending") {
      const waited: DurableWaitResult = await input.wait(input.scope, children.pendingTaskIds)
      if (waited.status === "waiting") return { kind: "pending", waitId: waited.waitId }
      if (waited.status !== "ready") return { kind: "blocked", feedback: `Native child verification wait ended as ${waited.status}.` }
      continue
    }
    if (children.status !== "passed") return { kind: "blocked", feedback: nativeVerificationFeedbackText(children.status, children.feedback) }
    const goal = ensureResult(await input.port.ensureRootGoal({ scope: input.scope, candidateText: input.candidateText }), input.candidateText, true)
    if (!goal) return { kind: "blocked", feedback: "Independent root-goal verification is unavailable or malformed." }
    if (goal.status === "pending") {
      const waited: DurableWaitResult = await input.wait(input.scope, goal.pendingTaskIds)
      if (waited.status === "waiting") return { kind: "pending", waitId: waited.waitId }
      if (waited.status !== "ready") return { kind: "blocked", feedback: `Root-goal verification wait ended as ${waited.status}.` }
      continue
    }
    if (goal.status !== "passed" || !goal.rootGoalWitness) {
      const semanticRejectionControlTaskId = goal.status === "failed" ? matchingFailedRootControl(goal, input.scope.rootTaskId) : undefined
      const feedback = nativeVerificationFeedbackText(goal.status, goal.feedback, Boolean(semanticRejectionControlTaskId))
      return { kind: "blocked", feedback,
        ...(semanticRejectionControlTaskId ? { semanticRejectionControlTaskId } : {}) }
    }
    return { kind: "passed", witness: goal.rootGoalWitness }
  }
  return { kind: "blocked", feedback: "Independent native verification remained pending after immediate wake; resume through the durable wait." }
}

/** Keeps receipt validation and native review ahead of the generic graph gate. */
export async function nativeVerificationCompletionGate(input: Readonly<{
  candidateText: string
  scope: TaskGraphExecutionScope | (() => TaskGraphExecutionScope)
  port?: NativeVerificationPort
  hasNativeTasks(): Promise<boolean>
  checkReceipt(): Promise<TurnEngineCompletionGateResult | null>
  wait: NativeVerificationWaiter
  observeRootSemanticRejection?(controlTaskId: string): boolean
  accept(witness: NativeVerificationRootGoalWitness, candidateText: string): void
}>): Promise<TurnEngineCompletionGateResult | null> {
  const receipt = await input.checkReceipt()
  if (receipt) return receipt
  if (!await input.hasNativeTasks()) return null
  if (!input.port) return { ok: false, blocker: "task_graph_verification_unverified", feedback: "Native TaskGraph work has no independent verification runtime." }
  const scope = typeof input.scope === "function" ? input.scope() : input.scope
  const result = await verifyNativeRootCandidate({ port: input.port, scope, candidateText: input.candidateText, wait: input.wait })
  if (result.kind === "blocked") {
    const stop = result.semanticRejectionControlTaskId
      ? input.observeRootSemanticRejection?.(result.semanticRejectionControlTaskId) === true
      : false
    return { ok: false, blocker: "task_graph_verification_unverified", feedback: result.feedback,
      ...(stop ? { [NATIVE_SEMANTIC_NO_PROGRESS]: true as const } : {}) }
  }
  if (result.kind === "pending") return { ok: false, blocker: "native_verification_pending", feedback: "Independent native verification is waiting on durable child work.", waitId: result.waitId }
  input.accept(result.witness, input.candidateText)
  return null
}
