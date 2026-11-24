import { randomUUID } from "node:crypto"
import { parseObjectiveApplicationReviewIntent, type ObjectiveApplicationReviewIntent, type RepositoryJsonValue, type TenantScope, type TurnIntent } from "@jobcopilot/agent-protocol"
import type { Pool, PoolClient } from "pg"
import { executionOwnerFence } from "./execution-owner.js"
import type { TurnLease } from "./turns/lease.js"
import { loadReviewedApplicationRootInputCheckpoint } from "./canonical-reviewed-application-review-turn.js"
import { issueOrReplayObjectiveApplicationReview, type ObjectiveApplicationReviewIssueResult } from "./objective-application-review-issuance.js"
import { objectiveApplicationReviewIntentHash, objectiveApplicationReviewSetId, readObjectiveApplicationReviewSetState,
  type ObjectiveApplicationReviewSetMember, type ObjectiveApplicationReviewSetState } from "./objective-application-review-set-state.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import type { TurnEngineOptions, TurnEngineResult, TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { toRepositoryJson } from "./turns/turn-engine-types.js"
import { finalizeTurn, serializeFinalResponse } from "./finalizer.js"
import { verifyCandidateFinal } from "./verifier.js"
import { objectiveApplicationApprovalSetItemId } from "@jobcopilot/agent-protocol"

type Intent = Extract<TurnIntent, { kind: "objective_application_review" }>
type Owner = Extract<ReturnType<typeof executionOwnerFence>, { kind: "turn" }>
type Reader = (client: PoolClient, input: { userId: string; sessionId: string; turnId: string; selection: ObjectiveApplicationReviewIntent }) => Promise<ObjectiveApplicationReviewSetState | undefined>
type Issuer = (input: { pool: Pool; lease: TurnLease; rootTaskId: string; selection: unknown; now?: Date }) => Promise<ObjectiveApplicationReviewIssueResult>
type StoreFactory = (pool: Pool, guard?: TurnEngineTerminalGuard) => TurnEngineStore
type Row = Record<string, unknown>

export type CanonicalObjectiveApplicationReviewTurnInput = Readonly<{
  pool: Pool; lease: TurnLease; rootTaskId: string; scope: TenantScope; intent: Intent; goal: string
  snapshot: TurnEngineOptions["snapshot"]; contextBuilder: TurnEngineOptions["contextBuilder"]
  modelProfileSnapshot: RepositoryJsonValue; rootInputId: string; rootContextInputId?: string; signal: AbortSignal
  issue?: Issuer; readSetState?: Reader; now?: () => Date; storeFactory?: StoreFactory
}>

const STEP_PREFIX = "objective-application-review:terminal:"
const EVIDENCE_REF = "objective_application_review_set_verified"

/** Completes only after the exact selected approval set has a terminal durable wake. */
export async function runCanonicalObjectiveApplicationReviewTurn(input: CanonicalObjectiveApplicationReviewTurnInput): Promise<TurnEngineResult> {
  const now = input.now ?? (() => new Date()), owner = executionOwnerFence({ kind: "turn", taskId: input.rootTaskId, lease: input.lease })
  const selection = parseObjectiveApplicationReviewIntent(input.intent.selection)
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || input.scope.userId !== owner.userId
    || input.intent.kind !== "objective_application_review" || input.intent.version !== 1 || !selection
    || !sameSelection(selection, input.intent.selection)) throw new Error("objective_application_review_scope_invalid")

  let completion: Parameters<typeof verifySetAtCommit>[2] | undefined
  const guard: TurnEngineTerminalGuard = (client, terminal) => completion
    ? verifySetAtCommit(client, terminal, completion)
    : Promise.resolve({ ok: false, blocker: "objective_application_review_decision_missing", feedback: "The matching review decision set was unavailable." })
  const store = (input.storeFactory ?? createPgTurnEngineStore)(input.pool, guard)
  const start = await store.appendEvent({ owner, id: eventId(owner.turnId, "turn-started"), itemId: null, type: "turn.started",
    correlationId: owner.turnId, causationId: null, idempotencyKey: `turn:${owner.turnId}:event:turn-started`,
    payload: { goal: input.goal, taskId: owner.taskId, rootTaskId: owner.rootTaskId } })
  if (input.signal.aborted) return { status: "interrupted", stepCount: 0, toolCallCount: 0, errorCode: "turn_cancelled" }
  const issue = input.issue ?? issueOrReplayObjectiveApplicationReview
  const issued = await issue({ pool: input.pool, lease: input.lease, rootTaskId: input.rootTaskId, selection, now: now() })
  if (issued.status === "denied") return { status: input.signal.aborted ? "interrupted" : "failed", stepCount: 0, toolCallCount: 0,
    errorCode: input.signal.aborted ? "turn_cancelled" : "objective_application_review_denied" }
  const expectedSetId = objectiveApplicationReviewSetId(owner.sessionId, owner.turnId), expectedItemId = objectiveApplicationApprovalSetItemId(expectedSetId)
  const intentHash = objectiveApplicationReviewIntentHash(selection)
  if (issued.setId !== expectedSetId || issued.itemId !== expectedItemId || issued.intentHash !== intentHash
    || !sameMembers(issued.members, selection.slotOrdinals)) throw new Error("objective_application_review_set_identity_invalid")
  if (input.signal.aborted) return { status: "interrupted", stepCount: 0, toolCallCount: 0, errorCode: "turn_cancelled" }
  if (issued.status === "issued" || issued.status === "waiting") return { status: "waiting_for_approval", waitId: issued.setId, stepCount: 0, toolCallCount: 0 }
  if (issued.status !== "resolved" || !terminalMembers(issued.members, selection.slotOrdinals)) throw new Error("objective_application_review_set_incomplete")

  const message = decisionSummary(issued.members), stepId = `${STEP_PREFIX}${owner.turnId}`
  completion = {
    owner, selection, setId: issued.setId, itemId: issued.itemId, intentHash, members: issued.members,
    message, read: input.readSetState ?? readObjectiveApplicationReviewSetState,
  }
  const checkpoint = await loadReviewedApplicationRootInputCheckpoint({ pool: input.pool, scope: input.scope, rootInputId: input.rootInputId }, owner, stepId, now())
  if (input.signal.aborted) return { status: "interrupted", stepCount: 0, toolCallCount: 0, errorCode: "turn_cancelled" }
  const step = await store.startStep({ owner, stepId, ordinal: 0, attempt: 1, inputThroughSequence: checkpoint.inputThroughSequence,
    consumedInputIds: checkpoint.consumedInputIds, modelProfileSnapshot: toRepositoryJson(input.modelProfileSnapshot), now: now() })
  const started = await store.appendEvent({ owner, id: eventId(owner.turnId, `step-started:${step.id}`), itemId: null,
    type: "step.started", correlationId: step.id, causationId: start.id,
    idempotencyKey: `turn:${owner.turnId}:event:step-started:${step.id}`, payload: { stepId: step.id, ordinal: 0, taskId: owner.taskId } })
  const context = await input.contextBuilder.build({ scope: input.scope, sessionId: owner.sessionId, turnId: owner.turnId, stepId: step.id,
    snapshot: input.snapshot, rootInputId: input.rootInputId, ...(input.rootContextInputId ? { rootContextInputId: input.rootContextInputId } : {}),
    taskId: owner.taskId, mode: checkpoint.mode, lease: { ownerId: owner.ownerId, leaseVersion: owner.leaseVersion, now: now() }, now: now() })
  if (!context.consumedInputIds.includes(input.rootInputId) || context.inputThroughSequence < checkpoint.inputThroughSequence) throw new Error("objective_application_review_root_input_unclaimed")
  await store.updateStep({ owner, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: now() })
  await store.appendEvent({ owner, id: eventId(owner.turnId, `step-completed:${step.id}`), itemId: null, type: "step.completed",
    correlationId: step.id, causationId: started.id, idempotencyKey: `turn:${owner.turnId}:event:step-completed:${step.id}`,
    payload: { stepId: step.id, status: "completed", taskId: owner.taskId } })
  const verification = verifyCandidateFinal({ goal: input.goal, candidate: { text: message, finishReason: "stop", evidenceRefs: [EVIDENCE_REF] },
    evidence: [{ id: EVIDENCE_REF, status: "verified" }] })
  if (!verification.ok) throw new Error("objective_application_review_verification_failed")
  const final = finalizeTurn({ goal: input.goal, verification, terminalReason: "goal_satisfied", response: message, summaryOverride: message,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, stepCount: 1, toolCallCount: 0 })
  const finalItemId = `turn:${owner.turnId}:item:final:${step.id}`
  const terminal = await store.recordFinalResponse({ owner, response: serializeFinalResponse(final), now: now(), terminal: {
    stepId: step.id, finalItemId, finalContent: toRepositoryJson({ text: message, final: toRepositoryJson(final) }),
    stepCount: 1, toolCallCount: 0, usage: final.usage,
  } })
  if (!terminal || terminal.status !== "completed" || terminal.finalItemId !== finalItemId) throw new Error("objective_application_review_terminal_missing")
  return { status: "completed", finalItemId, finalText: message, stepCount: 1, toolCallCount: 0 }
}

async function verifySetAtCommit(client: PoolClient, terminal: Parameters<TurnEngineTerminalGuard>[1], expected: {
  owner: Owner; selection: ObjectiveApplicationReviewIntent; setId: string; itemId: string; intentHash: string
  members: readonly ObjectiveApplicationReviewSetMember[]; message: string; read: Reader
}): Promise<{ ok: true } | { ok: false; blocker: string; feedback: string }> {
  const denied = { ok: false as const, blocker: "objective_application_review_unverified", feedback: "The matching review decision set was unavailable." }
  if (terminal.owner.turnId !== expected.owner.turnId || terminal.owner.sessionId !== expected.owner.sessionId
    || terminal.owner.userId !== expected.owner.userId || terminal.stepId !== `${STEP_PREFIX}${expected.owner.turnId}`
    || terminal.finalItemId !== `turn:${expected.owner.turnId}:item:final:${terminal.stepId}` || terminal.stepCount !== 1 || terminal.toolCallCount !== 0
    || !finalCopiesMatch(terminal.response, terminal.finalContent, expected.message)) return denied
  const state = await expected.read(client, { userId: expected.owner.userId, sessionId: expected.owner.sessionId,
    turnId: expected.owner.turnId, selection: expected.selection })
  const wakeup = state?.wakeup
  if (!state || state.status !== "resolved" || state.setId !== expected.setId || state.itemId !== expected.itemId
    || state.intentHash !== expected.intentHash || !sameMembers(state.members, expected.selection.slotOrdinals)
    || !terminalMembers(state.members, expected.selection.slotOrdinals) || !sameMemberIdentity(state.members, expected.members)
    || !wakeup || wakeup.waitKind !== "approval_set" || wakeup.waitId !== expected.setId || wakeup.itemId !== expected.itemId
    || decisionSummary(state.members) !== expected.message) return denied
  return { ok: true }
}

function sameMembers(members: readonly ObjectiveApplicationReviewSetMember[], ordinals: readonly number[]): boolean {
  return members.length === ordinals.length && members.every((member, index) => member.slotOrdinal === ordinals[index]
    && safeId(member.approvalId) && safeId(member.applicationTaskId) && safeId(member.jobId)
    && Number.isSafeInteger(member.receiptRevision) && member.receiptRevision >= 0)
}
function terminalMembers(members: readonly ObjectiveApplicationReviewSetMember[], ordinals: readonly number[]): boolean {
  return sameMembers(members, ordinals) && members.every(member => member.status === "approved" || member.status === "rejected" || member.status === "expired")
}
function sameMemberIdentity(current: readonly ObjectiveApplicationReviewSetMember[], issued: readonly ObjectiveApplicationReviewSetMember[]): boolean {
  return current.length === issued.length && current.every((member, index) => {
    const prior = issued[index]
    return !!prior && member.slotOrdinal === prior.slotOrdinal && member.approvalId === prior.approvalId
      && member.applicationTaskId === prior.applicationTaskId && member.jobId === prior.jobId && member.status === prior.status
      && member.receiptRevision === prior.receiptRevision && member.proof.materialProofHash === prior.proof.materialProofHash
  })
}
function decisionSummary(members: readonly ObjectiveApplicationReviewSetMember[]): string {
  const approved = members.filter(member => member.status === "approved").length
  const rejected = members.filter(member => member.status === "rejected").length
  const expired = members.filter(member => member.status === "expired").length
  return `Review decisions: ${approved} approved for form fill, ${rejected} rejected, ${expired} expired. Final submission requires separate approval.`
}
function finalCopiesMatch(serialized: string, contentValue: unknown, message: string): boolean {
  let final: Row | null, content: Row | null
  try { final = record(JSON.parse(serialized)); content = record(contentValue) } catch { return false }
  const inner = content && record(content.final), refs = final?.evidenceRefs
  return !!final && !!content && !!inner && final.completed === true && final.terminalReason === "goal_satisfied"
    && final.response === message && final.summary === message && Array.isArray(refs) && refs.length === 1 && refs[0] === EVIDENCE_REF
    && content.text === message && inner.completed === true && inner.terminalReason === "goal_satisfied"
    && inner.response === message && inner.summary === message && JSON.stringify(inner.evidenceRefs) === JSON.stringify(refs)
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { return Object.getPrototypeOf(value) === Object.prototype ? value as Row : null } catch { return null }
}
function sameSelection(left: ObjectiveApplicationReviewIntent, right: unknown): boolean {
  const other = parseObjectiveApplicationReviewIntent(right)
  return !!other && left.schema === other.schema && left.sourceTurnId === other.sourceTurnId && left.rootTaskId === other.rootTaskId
    && left.graphItemId === other.graphItemId && left.graphRevision === other.graphRevision
    && left.slotOrdinals.length === other.slotOrdinals.length && left.slotOrdinals.every((value, index) => value === other.slotOrdinals[index])
}
function eventId(turnId: string, key: string): string { return `turn:${turnId}:event:${key}:${randomUUID()}` }
function safeId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
