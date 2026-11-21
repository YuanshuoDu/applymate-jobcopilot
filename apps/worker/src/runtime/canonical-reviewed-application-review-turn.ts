import { randomUUID } from "node:crypto"
import type { RepositoryJsonValue, TenantScope, TurnIntent } from "@jobcopilot/agent-protocol"
import type { Pool, PoolClient } from "pg"
import { readReviewedApplicationReviewBinding } from "./reviewed-application-review-task.js"
import { createPgInputClaimStore } from "./context/input-claim-store.js"
import { executionOwnerFence } from "./execution-owner.js"
import type { TurnLease } from "./turns/lease.js"
import { createPgTurnEngineStore } from "./turns/turn-engine-store.js"
import type { TurnEngineOptions, TurnEngineResult, TurnEngineStore } from "./turns/turn-engine-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { toRepositoryJson } from "./turns/turn-engine-types.js"
import { verifyCandidateFinal } from "./verifier.js"
import { finalizeTurn, serializeFinalResponse } from "./finalizer.js"

type ReviewIntent = Extract<TurnIntent, { kind: "reviewed_application_review" }>
type ReviewOwner = Extract<ReturnType<typeof executionOwnerFence>, { kind: "turn" }>
type IssueResult = Readonly<{ status: "issued" | "waiting" | "approved" | "rejected"; approvalId: string; waitItemId: string }>
  | Readonly<{ status: "denied" }>
type IssueReview = (input: { pool: Pool; lease: TurnLease; rootTaskId: string; intent: ReviewIntent; now?: Date }) => Promise<IssueResult>
type Decision = Readonly<{ status: "approved" | "rejected"; approvalId: string; waitItemId: string }>
type RecordValue = Record<string, unknown>
type StoreFactory = (pool: Pool, guard?: TurnEngineTerminalGuard) => TurnEngineStore

export type CanonicalReviewedApplicationReviewTurnInput = Readonly<{
  pool: Pool; lease: TurnLease; rootTaskId: string; scope: TenantScope; intent: ReviewIntent; goal: string
  snapshot: TurnEngineOptions["snapshot"]; contextBuilder: TurnEngineOptions["contextBuilder"]
  modelProfileSnapshot: RepositoryJsonValue; rootInputId: string; rootContextInputId?: string
  signal: AbortSignal; issue: IssueReview; now?: () => Date
  storeFactory?: StoreFactory
}>

const WAIT_ID_PREFIX = "reviewed-application-review:"
const STEP_PREFIX = "reviewed-application-review:terminal:"
const REVIEW_TITLE = "Review selected application"
const REVIEW_BODY = "Approve these reviewed materials for a later form fill. This approval does not authorize submission."

/** Issues or resumes the canonical approval, then records only its verified human decision. */
export async function runCanonicalReviewedApplicationReviewTurn(input: CanonicalReviewedApplicationReviewTurnInput): Promise<TurnEngineResult> {
  const now = input.now ?? (() => new Date()), owner = executionOwnerFence({ kind: "turn", taskId: input.rootTaskId, lease: input.lease })
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || input.scope.userId !== owner.userId
    || input.intent.kind !== "reviewed_application_review" || input.intent.version !== 1
    || !validId(input.intent.sourceTurnId) || !validId(input.intent.jobId)) throw new Error("reviewed_application_review_scope_invalid")

  let decision: Decision | undefined
  const guard: TurnEngineTerminalGuard = (client, terminal) => decision
    ? verifyDecisionAtCommit(client, terminal, { owner, intent: input.intent, decision })
    : Promise.resolve({ ok: false, blocker: "reviewed_application_decision_missing", feedback: "The approval decision was not verified." })
  const store = (input.storeFactory ?? createPgTurnEngineStore)(input.pool, guard)
  const start = await store.appendEvent({ owner, id: eventId(owner.turnId, "turn-started"), itemId: null, type: "turn.started",
    correlationId: owner.turnId, causationId: null, idempotencyKey: `turn:${owner.turnId}:event:turn-started`,
    payload: { goal: input.goal, taskId: owner.taskId, rootTaskId: owner.rootTaskId } })
  if (input.signal.aborted) return { status: "interrupted", stepCount: 0, toolCallCount: 0, errorCode: "turn_cancelled" }

  const result = await input.issue({ pool: input.pool, lease: input.lease, rootTaskId: input.rootTaskId, intent: input.intent, now: now() })
  if (result.status === "denied") return { status: input.signal.aborted ? "interrupted" : "failed", stepCount: 0, toolCallCount: 0,
    errorCode: input.signal.aborted ? "turn_cancelled" : "reviewed_application_review_denied" }
  const expectedApprovalId = `${WAIT_ID_PREFIX}${owner.turnId}`
  if (result.approvalId !== expectedApprovalId || result.waitItemId !== `agent-wait:approval:${expectedApprovalId}`) throw new Error("reviewed_application_wait_identity_invalid")
  if (result.status === "issued" || result.status === "waiting") return { status: "waiting_for_approval", waitId: result.approvalId, stepCount: 0, toolCallCount: 0 }
  if (result.status !== "approved" && result.status !== "rejected") throw new Error("reviewed_application_decision_invalid")
  if (input.signal.aborted) return { status: "interrupted", stepCount: 0, toolCallCount: 0, errorCode: "turn_cancelled" }
  decision = { status: result.status, approvalId: result.approvalId, waitItemId: result.waitItemId }

  const rootCheckpoint = await rootInputCheckpoint(input, owner, stepIdFor(owner.turnId), now())
  if (input.signal.aborted) return { status: "interrupted", stepCount: 0, toolCallCount: 0, errorCode: "turn_cancelled" }
  const stepId = `${STEP_PREFIX}${owner.turnId}`, step = await store.startStep({ owner, stepId, ordinal: 0, attempt: 1,
    inputThroughSequence: rootCheckpoint.inputThroughSequence, consumedInputIds: rootCheckpoint.consumedInputIds,
    modelProfileSnapshot: toRepositoryJson(input.modelProfileSnapshot), now: now() })
  const stepStarted = await store.appendEvent({ owner, id: eventId(owner.turnId, `step-started:${step.id}`), itemId: null,
    type: "step.started", correlationId: step.id, causationId: start.id, idempotencyKey: `turn:${owner.turnId}:event:step-started:${step.id}`,
    payload: { stepId: step.id, ordinal: step.ordinal, taskId: owner.taskId } })
  const context = await input.contextBuilder.build({ scope: input.scope, sessionId: owner.sessionId, turnId: owner.turnId, stepId: step.id,
    snapshot: input.snapshot, ...(input.rootInputId ? { rootInputId: input.rootInputId } : {}),
    ...(input.rootContextInputId ? { rootContextInputId: input.rootContextInputId } : {}), taskId: owner.taskId,
    mode: rootCheckpoint.mode, lease: { ownerId: owner.ownerId, leaseVersion: owner.leaseVersion, now: now() }, now: now() })
  if (!context.consumedInputIds.includes(input.rootInputId) || context.inputThroughSequence < rootCheckpoint.inputThroughSequence) throw new Error("reviewed_application_root_input_unclaimed")
  const stepCount = step.ordinal + 1, toolCallCount = 0
  const message = decision.status === "approved"
    ? "The user approved the reviewed application materials for a later form fill."
    : "The user rejected approval to use the reviewed application materials for a later form fill."
  await store.updateStep({ owner, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: now() })
  await store.appendEvent({ owner, id: eventId(owner.turnId, `step-completed:${step.id}`), itemId: null, type: "step.completed",
    correlationId: step.id, causationId: stepStarted.id, idempotencyKey: `turn:${owner.turnId}:event:step-completed:${step.id}`,
    payload: { stepId: step.id, status: "completed", taskId: owner.taskId } })
  const evidenceRef = `approval:${decision.approvalId}`
  const verification = verifyCandidateFinal({ goal: input.goal, candidate: { text: message, finishReason: "stop", evidenceRefs: [evidenceRef] },
    evidence: [{ id: evidenceRef, status: "verified" }] })
  if (!verification.ok) throw new Error("reviewed_application_decision_verification_failed")
  const final = finalizeTurn({ goal: input.goal, verification, terminalReason: "goal_satisfied", response: message, summaryOverride: message,
    usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }, stepCount, toolCallCount })
  const finalItemId = `turn:${owner.turnId}:item:final:${step.id}`
  const terminal = await store.recordFinalResponse({ owner, response: serializeFinalResponse(final), now: now(), terminal: {
    stepId: step.id, finalItemId, finalContent: toRepositoryJson({ text: message, final: toRepositoryJson(final) }), stepCount, toolCallCount, usage: final.usage,
  } })
  if (!terminal || terminal.status !== "completed" || terminal.finalItemId !== finalItemId) throw new Error("reviewed_application_terminal_receipt_missing")
  return { status: "completed", finalItemId, finalText: message, stepCount, toolCallCount }
}

async function rootInputCheckpoint(input: CanonicalReviewedApplicationReviewTurnInput, owner: ReviewOwner, stepId: string, now: Date) {
  return createPgInputClaimStore(input.pool, input.scope).withTransaction(async transaction => {
    const lease = { ownerId: owner.ownerId, leaseVersion: owner.leaseVersion, now }
    const found = await transaction.loadRootInputContext?.({ sessionId: owner.sessionId, turnId: owner.turnId, inputId: input.rootInputId, lease })
    if (!found || found.id !== input.rootInputId || found.userId !== owner.userId || found.sessionId !== owner.sessionId
      || found.targetTurnId !== owner.turnId || found.delivery !== "follow_up") throw new Error("reviewed_application_root_input_unavailable")
    if (found.status !== "consumed") {
      if ((found.status !== "accepted" && found.status !== "queued") || found.consumedByStepId !== null || found.consumedAt !== null) {
        throw new Error("reviewed_application_root_input_unavailable")
      }
      return { inputThroughSequence: found.acceptedSequence, consumedInputIds: [] as readonly string[], mode: "new" as const }
    }
    if (found.consumedByStepId !== stepId || found.consumedAt === null) throw new Error("reviewed_application_root_input_unavailable")
    const checkpoint = await transaction.getCheckpoint({ sessionId: owner.sessionId, turnId: owner.turnId, stepId, lease })
    if (checkpoint.inputThroughSequence < found.acceptedSequence || !checkpoint.consumedInputIds.includes(input.rootInputId)) {
      throw new Error("reviewed_application_root_checkpoint_invalid")
    }
    return { ...checkpoint, mode: "retry" as const }
  })
}
function stepIdFor(turnId: string): string { return `${STEP_PREFIX}${turnId}` }

async function verifyDecisionAtCommit(client: PoolClient, terminal: Parameters<TurnEngineTerminalGuard>[1], input: {
  owner: ReviewOwner; intent: ReviewIntent; decision: Decision
}): Promise<{ ok: true } | { ok: false; blocker: string; feedback: string }> {
  const { owner, intent, decision } = input, denied = { ok: false as const, blocker: "reviewed_application_decision_unverified", feedback: "The matching user decision receipt was unavailable." }
  if (terminal.owner.turnId !== owner.turnId || terminal.owner.sessionId !== owner.sessionId || terminal.owner.userId !== owner.userId
    || terminal.stepId !== `${STEP_PREFIX}${owner.turnId}` || terminal.finalItemId !== `turn:${owner.turnId}:item:final:${terminal.stepId}`
    || terminal.stepCount !== 1 || terminal.toolCallCount !== 0) return denied
  const message = decision.status === "approved"
    ? "The user approved the reviewed application materials for a later form fill."
    : "The user rejected approval to use the reviewed application materials for a later form fill."
  if (!finalCopiesMatch(terminal.response, terminal.finalContent, message, `approval:${decision.approvalId}`)) return denied
  const receipt = await client.query<RecordValue>(`SELECT approval."id", approval."userId", approval."sessionId", approval."turnId", approval."taskId", approval."jobId",
      approval."type", approval."status", approval."toolCallId", approval."payload", approval."resourceHash", approval."materialHash", approval."answersHash",
      approval."scopeHash", approval."revision", approval."expiresAt", approval."decidedAt", approval."consumedAt",
      item."id" AS "waitItemId", item."stepId" AS "waitStepId", item."taskId" AS "waitTaskId", item."type" AS "waitType", item."status" AS "waitStatus", item."phase" AS "waitPhase",
      item."revision" AS "waitRevision", item."content" AS "waitContent", resolved."actor" AS "resolvedActor",
      resolved."taskId" AS "resolvedTaskId", resolved."itemId" AS "resolvedItemId", resolved."payload" AS "resolvedPayload"
    FROM "agent_approvals" AS approval JOIN "application_tasks" AS app ON app."id" = approval."taskId"
      AND app."userId" = approval."userId" AND app."sessionId" = approval."sessionId" AND app."jobId" = approval."jobId"
    JOIN "agent_items" AS item ON item."id" = $2 AND item."sessionId" = approval."sessionId" AND item."turnId" = approval."turnId"
    JOIN "agent_events" AS resolved ON resolved."sessionId" = approval."sessionId" AND resolved."turnId" = approval."turnId"
      AND resolved."itemId" = item."id" AND resolved."type" = 'approval.resolved' AND resolved."actor" = 'user' AND resolved."correlationId" = approval."id"
    WHERE approval."id" = $1 AND approval."userId" = $3 AND approval."sessionId" = $4 AND approval."turnId" = $5
      AND approval."jobId" = $6 AND approval."type" = 'review_application' LIMIT 2`,
  [decision.approvalId, `agent-wait:approval:${decision.approvalId}`, owner.userId, owner.sessionId, owner.turnId, intent.jobId])
  if (receipt.rows.length !== 1 || !approvalWaitMatches(receipt.rows[0]!, owner, intent, decision)) return denied
  const receiptRow = receipt.rows[0]!, taskId = receiptRow.taskId
  if (!validId(taskId)) return denied
  const binding = await readReviewedApplicationReviewBinding(client, taskId, owner.turnId)
  if (!bindingMatches(binding, receiptRow, owner, intent, decision)) return denied
  return { ok: true }
}

function approvalWaitMatches(row: RecordValue, owner: ReturnType<typeof executionOwnerFence>, intent: ReviewIntent, decision: Decision): boolean {
  const payload = exactRecord(row.payload, ["applicationTaskId", "jobId"]), content = exactRecord(row.waitContent,
    ["action", "approvalId", "body", "decision", "expiresAt", "impact", "receiptRevision", "respondedAt", "responseAvailable", "scopeHash", "title", "toolCallId", "waitKind"])
  const impact = exactRecord(content?.impact, ["externalSubmission", "jobId"])
  const decidedAt = timestamp(row.decidedAt), expiresAt = timestamp(row.expiresAt), event = exactRecord(row.resolvedPayload,
    ["waitKind", "waitId", "itemId", "turnId", "toolCallId", "status", "nextTurnRevision", "answerAvailable"])
  return row.id === decision.approvalId && row.userId === owner.userId && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && validId(row.taskId) && row.jobId === intent.jobId && row.type === "review_application" && row.status === decision.status
    && validId(row.toolCallId) && row.consumedAt == null && validId(row.scopeHash) && validId(row.resourceHash) && validId(row.materialHash) && validId(row.answersHash)
    && payload?.applicationTaskId === row.taskId && payload.jobId === intent.jobId && row.waitItemId === `agent-wait:approval:${decision.approvalId}`
    && row.waitStepId === null && row.waitTaskId === null && row.waitType === "approval_request" && row.waitStatus === "completed" && row.waitPhase === "commentary" && Number(row.waitRevision) === 1
    && content?.waitKind === "approval" && content.approvalId === decision.approvalId && content.toolCallId === row.toolCallId
    && content.action === "review_application" && content.title === REVIEW_TITLE && content.body === REVIEW_BODY
    && content.scopeHash === row.scopeHash && content.receiptRevision === row.revision
    && expiresAt !== null && content.expiresAt === expiresAt && impact?.externalSubmission === false && impact.jobId === intent.jobId
    && content.decision === decision.status && content.responseAvailable === true && decidedAt !== null && content.respondedAt === decidedAt
    && row.resolvedActor === "user" && row.resolvedTaskId === row.taskId && row.resolvedItemId === row.waitItemId
    && event?.waitKind === "approval" && event.waitId === decision.approvalId && event.itemId === row.waitItemId
    && event.turnId === owner.turnId && event.toolCallId === row.toolCallId && event.status === decision.status && event.answerAvailable === false
    && Number.isSafeInteger(event.nextTurnRevision) && Number(event.nextTurnRevision) >= 0
}

function bindingMatches(binding: Awaited<ReturnType<typeof readReviewedApplicationReviewBinding>>, approval: RecordValue,
  owner: ReviewOwner, intent: ReviewIntent, decision: Decision): boolean {
  return !!binding && binding.approvalId === decision.approvalId && binding.reviewTurnId === owner.turnId
    && binding.applicationTaskId === approval.taskId && binding.userId === owner.userId && binding.sessionId === owner.sessionId
    && binding.jobId === intent.jobId && binding.proof.sourceTurnId === intent.sourceTurnId && binding.proof.jobId === intent.jobId
    && binding.receiptScope.action === "review_application" && binding.receiptScope.toolCallId === approval.toolCallId
    && binding.receiptScope.resourceHash === approval.resourceHash && binding.receiptScope.materialHash === approval.materialHash
    && binding.receiptScope.answersHash === approval.answersHash && binding.receiptScope.revision === approval.revision
    && binding.receiptScope.expiresAt === timestamp(approval.expiresAt)
}

function finalCopiesMatch(serialized: string, contentValue: unknown, message: string, evidenceRef: string): boolean {
  let final: RecordValue | null, content: RecordValue | null
  try { final = record(JSON.parse(serialized)); content = record(contentValue) } catch { return false }
  if (!final || !content) return false
  const refs = final.evidenceRefs, finalContent = record(content.final)
  if (!finalContent) return false
  return final.completed === true && final.terminalReason === "goal_satisfied" && final.response === message && final.summary === message
    && Array.isArray(refs) && refs.length === 1 && refs[0] === evidenceRef && content.text === message
    && finalContent.completed === true && finalContent.terminalReason === "goal_satisfied" && finalContent.response === message
    && finalContent.summary === message && JSON.stringify(finalContent.evidenceRefs) === JSON.stringify(refs)
}

function exactRecord(value: unknown, keys: readonly string[]): RecordValue | null {
  const parsed = record(value)
  return parsed && Object.keys(parsed).length === keys.length && keys.every(key => Object.hasOwn(parsed, key)) ? parsed : null
}
function record(value: unknown): RecordValue | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RecordValue : null
}
function timestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function eventId(turnId: string, key: string): string { return `turn:${turnId}:event:${key}:${randomUUID()}` }
