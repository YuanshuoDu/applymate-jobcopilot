import type pg from "pg"
import type { TurnQuestionStore } from "../turns/turn-question-contract.js"
import { scheduledGateQuestionText } from "../turns/turn-execution-types.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { DurableWaitPort, DurableWaitScheduledGatePort, DurableWaitResult } from "../tools/coordination-types.js"
import type { TaskGraphCommandPort, TaskGraphExecutionScope, TaskGraphReadScope, TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { scheduledGateProposal, type ScheduledGateCompletionProof, type ScheduledAnalyzeCheckpointHandoff } from "./scheduled-gate-contract.js"
import { SCHEDULED_AUDIT_TEMPLATE_ID, type ScheduledAuditAppendReceipt, type ScheduledAuditOwner } from "./scheduled-audit-contract.js"
import type { ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import { readScheduledGateQuestionCandidate } from "./scheduled-gate-wait-match.js"
import { selectScheduledGateResumeWaitAttempt } from "./scheduled-gate-resume-wait.js"
import { turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import { createHash } from "node:crypto"
import { resumeScheduledAudit, scheduledAuditCompletionProofMatches, scheduledAuditWaitKey,
  validScheduledAuditWait } from "./scheduled-audit-resume.js"

const WAIT_TIMEOUT_MS = 24 * 60 * 60 * 1_000
export type ScheduledPipelineGateContinuationResult = Readonly<{ status: "waiting_for_dependency"; waitId: string }>
  | Readonly<{ status: "waiting_for_choice"; waitId: string; question: string; binding: TurnQuestionGateChoiceBinding }>
  | Readonly<{ status: "waiting_for_external_user"; waitId: string }>
  | Readonly<{ status: "gate_continuation"; handoff: ScheduledAnalyzeCheckpointHandoff;
      prepareProof: ScheduledPrepareTaskGraphProof; scheduledWaitId?: string }>
  | Readonly<{ status: "not_registered" }>
  | Readonly<{ status: "completed" }>
  | Readonly<{ status: "blocked"; errorCode: string }>
type ScheduledPipelineGateContinuationBase = Readonly<{
  owner: ScheduledAutomationPipelineBridgeScope
  executionOwner: TurnExecutionOwnerFence
  /** Candidate source identity; retained for existing Prepare choice derivation. */
  finalStepId: string
  /** Active operational Step that owns new TaskGraph scopes and durable waits. */
  recoveryStepId: string
  signal: AbortSignal
}>
export type ScheduledPipelineGateContinuationInput = ScheduledPipelineGateContinuationBase & (
  | Readonly<{ mode: "resume_audit" }>
  | Readonly<{ attestation: ScheduledAutomationPipelineAttestation; handoff: ScheduledAnalyzeCheckpointHandoff;
      prepareProof: ScheduledPrepareTaskGraphProof; scheduledWaitId?: string }>
)

function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }

function scopes(owner: ScheduledAutomationPipelineBridgeScope, stepId: string, executionOwner: TurnExecutionOwnerFence) {
  if (!validId(stepId) || executionOwner.kind !== "turn" || executionOwner.userId !== owner.userId
    || executionOwner.sessionId !== owner.sessionId || executionOwner.turnId !== owner.turnId
    || executionOwner.rootTaskId !== owner.rootTaskId || executionOwner.taskId !== owner.rootTaskId
    || executionOwner.ownerId !== owner.turnLeaseOwnerId || executionOwner.leaseVersion !== owner.turnLeaseVersion) return null
  const readScope: TaskGraphReadScope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId, turnLeaseOwner: owner.turnLeaseOwnerId,
    turnLeaseVersion: owner.turnLeaseVersion, parentLeaseOwner: owner.turnLeaseOwnerId, parentAttemptCount: owner.rootAttemptCount }
  const executionScope: TaskGraphExecutionScope = { ...readScope, stepId }
  return { readScope, executionScope }
}

function gateId(receipt: TaskGraphScheduleReceipt): string | null {
  const node = receipt.nodes[0]
  return (receipt.status === "accepted" || receipt.status === "duplicate") && positive(receipt.revision)
    && receipt.nodes.length === 1 && node?.key === "gate" && validId(node.taskId)
    && (receipt.readyTaskIds.length === 0 || receipt.readyTaskIds.length === 1 && receipt.readyTaskIds[0] === node.taskId)
    ? node.taskId : null
}

function auditTarget(receipt: ScheduledAuditAppendReceipt): { taskId: string; attemptCount: number } | null {
  try {
    const row = record(receipt), nodes = row?.nodes, ready = row?.readyTaskIds
    const node = Array.isArray(nodes) ? record(nodes[0]) : null
    return row && Array.isArray(nodes) && Array.isArray(ready) && nodes.length === 1
      && (row.status === "accepted" || row.status === "duplicate") && positive(row.revision)
      && node?.key === SCHEDULED_AUDIT_TEMPLATE_ID && validId(node.taskId)
      && row.auditTaskId === node.taskId && positive(row.expectedAttemptCount)
      && (ready.length === 0 || ready.length === 1 && ready[0] === node.taskId)
      ? { taskId: node.taskId, attemptCount: row.expectedAttemptCount } : null
  } catch { return null }
}

function waitKey(taskId: string, stepId: string, requestAttemptCount: number): string {
  const digest = createHash("sha256").update(JSON.stringify([taskId, stepId, requestAttemptCount]), "utf8").digest("hex")
  return `scheduled-gate-wait:${digest}`
}

function validWait(value: DurableWaitResult, taskId: string): boolean {
  return validId(value.waitId) && ["waiting", "ready", "timed_out", "interrupted", "closed"].includes(value.status)
    && (value.status === "ready" ? value.matchedTaskIds.length === 1 && value.matchedTaskIds[0] === taskId
      : value.status === "waiting" ? value.matchedTaskIds.length === 0 : true)
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}

async function withRead<T>(pool: Pick<pg.Pool, "connect">, userId: string, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect(); let committed = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const value = await work(client)
    await client.query("COMMIT"); committed = true
    return value
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

/** Appends the fixed Gate child, waits on its server-only matcher, and routes only private questions through the existing Turn wait. */
export function createScheduledAutomationGateContinuation(input: Readonly<{
  pool: Pick<pg.Pool, "connect">
  commandPort: TaskGraphCommandPort
  waitPort: DurableWaitPort
  questionStore?: Pick<TurnQuestionStore, "readScheduledGateChoice">
  nativeQuestionWaitEnabled: boolean
  fetcher?: typeof fetch
  now?: () => Date
}>): (continuation: ScheduledPipelineGateContinuationInput) => Promise<ScheduledPipelineGateContinuationResult> {
  return async continuation => {
    const { owner, executionOwner, recoveryStepId, signal } = continuation
    if (signal.aborted) throw signal.reason ?? new Error("scheduled_gate_cancelled")
    const scope = scopes(owner, recoveryStepId, executionOwner)
    if (!scope) return { status: "blocked", errorCode: "scheduled_gate_owner_invalid" }
    const command = input.commandPort, waitPort = input.waitPort as DurableWaitPort & Partial<DurableWaitScheduledGatePort>
    if ("mode" in continuation) return resumeScheduledAudit({ command, waitPort, scope: scope.readScope, recoveryStepId, signal })
    const gateWait = waitPort.waitScheduledGate
    if (!command.appendScheduledGate || typeof gateWait !== "function"
      || !command.resumeScheduledGateChoice || !command.verifyScheduledGateCompletion
      || !command.appendScheduledAudit || !command.verifyScheduledAuditCompletion || typeof waitPort.wait !== "function") {
      return { status: "blocked", errorCode: "scheduled_gate_runtime_unavailable" }
    }
    const gatePort: DurableWaitScheduledGatePort = { waitScheduledGate: invocation => gateWait.call(waitPort, invocation) }
    const handoff: ScheduledAnalyzeCheckpointHandoff = continuation.handoff
    const scheduledOwner = { executionId: handoff.executionId, executionAttemptCount: handoff.executionAttemptCount }
    const appended = await command.appendScheduledGate({ scope: scope.executionScope, executionOwner: scheduledOwner,
      handoff, attestation: continuation.attestation, prepareProof: continuation.prepareProof,
      proposal: scheduledGateProposal(continuation.prepareProof.completion.graphRevision) })
    const taskId = gateId(appended)
    if (!taskId) return { status: "blocked", errorCode: "scheduled_gate_schedule_invalid" }
    const firstRequest = await withRead(input.pool, owner.userId, client => selectScheduledGateResumeWaitAttempt(client, {
      ...scope.executionScope, gateTaskId: taskId, owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        rootTaskId: owner.rootTaskId, rootAttemptCount: owner.rootAttemptCount, executionId: handoff.executionId,
        executionAttemptCount: handoff.executionAttemptCount } }))
    if (firstRequest.status === "invalid") return { status: "blocked", errorCode: "scheduled_gate_resume_wait_invalid" }
    const firstWait = await waitFor(gatePort, continuation, taskId,
      firstRequest.status === "initial" ? 0 : firstRequest.requestAttemptCount)
    if (firstWait.status === "waiting") return { status: "waiting_for_dependency", waitId: firstWait.waitId }
    if (firstWait.status !== "ready") return { status: "blocked", errorCode: `scheduled_gate_wait_${firstWait.status}` }

    const candidate = await withRead(input.pool, owner.userId, client => readScheduledGateQuestionCandidate(client, {
      userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
      stepId: recoveryStepId, gateTaskId: taskId, requestAttemptCount: firstWait.requestAttemptCount }))
    if (candidate) {
      const question = scheduledGateQuestionText(candidate.binding.kind), readChoice = input.questionStore?.readScheduledGateChoice
      if (!input.nativeQuestionWaitEnabled || !question || !readChoice) return { status: "blocked", errorCode: "scheduled_gate_question_wait_unavailable" }
      const waitId = turnScheduledGateChoiceWaitId(candidate.binding)
      if (!waitId) return { status: "blocked", errorCode: "scheduled_gate_question_invalid" }
      const answer = await readChoice({ owner: executionOwner, binding: candidate.binding, now: input.now?.() ?? new Date() })
      if (answer.status !== "answered") return { status: "waiting_for_choice", waitId, question, binding: candidate.binding }
      const resumed = await command.resumeScheduledGateChoice({ scope: scope.executionScope, executionOwner: scheduledOwner,
        gateTaskId: taskId, requestAttemptCount: candidate.binding.gateAttempt, waitId: answer.waitId, now: input.now?.() ?? new Date() })
      if (resumed.taskId !== taskId || resumed.requestAttemptCount !== candidate.binding.gateAttempt
        || resumed.resumedAttemptCount !== candidate.binding.gateAttempt + 1 || !positive(resumed.revision)
        || !["accepted", "duplicate"].includes(resumed.status)
        || resumed.readyTaskIds.length !== 1 || resumed.readyTaskIds[0] !== taskId) {
        return { status: "blocked", errorCode: "scheduled_gate_resume_invalid" }
      }
      const resumedWait = await waitFor(gatePort, continuation, taskId, candidate.binding.gateAttempt)
      if (resumedWait.status === "waiting") return { status: "waiting_for_dependency", waitId: resumedWait.waitId }
      if (resumedWait.status !== "ready") return { status: "blocked", errorCode: `scheduled_gate_wait_${resumedWait.status}` }
      const next = await withRead(input.pool, owner.userId, client => readScheduledGateQuestionCandidate(client, {
        userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        stepId: recoveryStepId, gateTaskId: taskId, requestAttemptCount: candidate.binding.gateAttempt }))
      if (next) {
        const nextQuestion = scheduledGateQuestionText(next.binding.kind), nextWaitId = turnScheduledGateChoiceWaitId(next.binding)
        return nextQuestion && nextWaitId ? { status: "waiting_for_choice", waitId: nextWaitId, question: nextQuestion, binding: next.binding }
          : { status: "blocked", errorCode: "scheduled_gate_question_invalid" }
      }
    }
    const gateCompletionProof: ScheduledGateCompletionProof | null = await command.verifyScheduledGateCompletion({
      scope: scope.readScope, executionOwner: scheduledOwner, prepareProof: continuation.prepareProof })
    if (!gateCompletionProof || gateCompletionProof.schemaVersion !== "agent-harness.v2.scheduled-taskgraph-gate-completion.v1"
      || gateCompletionProof.gate.taskId !== taskId || !positive(gateCompletionProof.gate.attemptCount)
      || gateCompletionProof.prepareProof.receipt.continuationKey !== continuation.prepareProof.receipt.continuationKey) {
      return { status: "blocked", errorCode: "scheduled_gate_completion_unverified" }
    }
    const appendedAudit = await command.appendScheduledAudit({ scope: scope.executionScope, executionOwner: scheduledOwner,
      handoff, attestation: continuation.attestation, gateProof: gateCompletionProof,
      ...(continuation.scheduledWaitId !== undefined ? { scheduledWaitId: continuation.scheduledWaitId } : {}) })
    const audit = auditTarget(appendedAudit)
    if (!audit) return { status: "blocked", errorCode: "scheduled_audit_schedule_invalid" }
    const auditWait = await waitPort.wait({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
      stepId: recoveryStepId, taskId: owner.rootTaskId, rootTaskId: owner.rootTaskId, targetTaskIds: [audit.taskId], mode: "all",
      timeoutMs: WAIT_TIMEOUT_MS, idempotencyKey: scheduledAuditWaitKey(audit.taskId, recoveryStepId, audit.attemptCount) })
    if (!validScheduledAuditWait(auditWait, audit.taskId)) return { status: "blocked", errorCode: "scheduled_audit_wait_invalid" }
    if (auditWait.status === "waiting") return { status: "waiting_for_dependency", waitId: auditWait.waitId }
    if (auditWait.status !== "ready") return { status: "blocked", errorCode: `scheduled_audit_wait_${auditWait.status}` }
    const auditProof = await command.verifyScheduledAuditCompletion({ scope: scope.readScope, executionOwner: scheduledOwner,
      gateProof: gateCompletionProof, auditTaskId: audit.taskId, attemptCount: audit.attemptCount })
    const auditOwner: ScheduledAuditOwner = { userId: continuation.owner.userId, sessionId: continuation.owner.sessionId,
      turnId: continuation.owner.turnId, rootTaskId: continuation.owner.rootTaskId,
      rootAttemptCount: continuation.owner.rootAttemptCount, executionId: handoff.executionId,
      executionAttemptCount: handoff.executionAttemptCount }
    if (!scheduledAuditCompletionProofMatches(auditProof, { owner: auditOwner, snapshotDigest: continuation.attestation.snapshotDigest,
      gateProof: gateCompletionProof, auditTaskId: audit.taskId, attemptCount: audit.attemptCount })) {
      return { status: "blocked", errorCode: "scheduled_audit_completion_unverified" }
    }
    return { status: "completed" }
  }
}

type ScheduledGateWaitOutcome = Readonly<{ status: "waiting"; waitId: string; requestAttemptCount: number }>
  | Readonly<{ status: "ready"; waitId: string; requestAttemptCount: number }>
  | Readonly<{ status: "timed_out" | "interrupted" | "closed"; waitId: string; requestAttemptCount: number }>

async function waitFor(gatePort: DurableWaitScheduledGatePort, continuation: ScheduledPipelineGateContinuationInput,
  gateTaskId: string, requestAttemptCount: number): Promise<ScheduledGateWaitOutcome> {
  const result = await gatePort.waitScheduledGate({ userId: continuation.owner.userId, sessionId: continuation.owner.sessionId,
    turnId: continuation.owner.turnId, stepId: continuation.recoveryStepId, taskId: continuation.owner.rootTaskId,
    rootTaskId: continuation.owner.rootTaskId, gateTaskId, requestAttemptCount, timeoutMs: WAIT_TIMEOUT_MS,
    idempotencyKey: waitKey(gateTaskId, continuation.recoveryStepId, requestAttemptCount) })
  if (!validWait(result, gateTaskId)) throw new Error("scheduled_gate_wait_invalid")
  return { status: result.status, waitId: result.waitId, requestAttemptCount } as ScheduledGateWaitOutcome
}
