import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { BudgetExceededError, type TurnUsage } from "../budget.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { finalizeTurn, serializeFinalResponse } from "../finalizer.js"
import { NoProgressError } from "../progress.js"
import { signalWasInterrupted } from "../interrupt/registry.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { cleanupFailedRootTaskGraph } from "../subagents/task-graph-pg-root-failure-cleanup.js"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { conflict } from "./turn-engine-terminal-commit.js"
import { lockTurnEngineOpenSession, lockTurnEngineOwnedTurn, turnEngineTenantTransaction, type TurnEnginePool, type TurnEngineQueryClient, type TurnEngineRow } from "./turn-engine-owner-sql.js"
import { toRepositoryJson, TurnEngineError, type AtomicTurnNoProgressInput, type AtomicTurnNoProgressResult, type TurnEngineEventInput, type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import { isPreparedQuestionRetryError, isTurnStateRefreshRetryError, PreparedQuestionRetryError, TurnStateRefreshRetryError } from "./turn-execution-question.js"
import { canPersistFinalResponse, totalTurnUsage, turnErrorCode, updateExecutionStep } from "./turn-engine-helpers.js"
import { executionId, type TurnExecutionOptions } from "./turn-execution-types.js"
import { publishFinalResponse, type TurnExecutionEventWriter } from "./turn-execution-events.js"
import { READ_TASK_GRAPH_DENIAL_CHECKPOINT } from "./turn-execution-types.js"
import { parseTaskGraphDenialCheckpoint, type TaskGraphDenialCheckpoint } from "./task-graph-terminal-assessment.js"

type AppendEvents = (pool: TurnEnginePool, inputs: readonly TurnEngineEventInput[], client: TurnEngineQueryClient) => Promise<readonly { id: string }[]>
type CheckpointReader = NonNullable<AtomicTurnNoProgressInput["readTaskGraphDenialCheckpoint"]>
const json = (value: unknown) => JSON.stringify(value)
const sameJson = (left: unknown, right: unknown) => json(toRepositoryJson(left)) === json(toRepositoryJson(right))

export async function matchedTaskGraphDenialCheckpoint<TContext>(
  shouldStop: (context: TContext, expectedTaskId: string, read?: CheckpointReader) => Promise<boolean>,
  context: TContext,
  expectedTaskId: string,
  read?: CheckpointReader,
): Promise<TaskGraphDenialCheckpoint | null> {
  if (!read) return null
  let latest: TaskGraphDenialCheckpoint | null = null
  const matched = await shouldStop(context, expectedTaskId, async () => { latest = await read(); return latest })
  return matched ? latest : null
}

export function withTaskGraphDenialCheckpoint(
  options: TurnExecutionOptions,
  checkpoint: TaskGraphDenialCheckpoint,
  read?: CheckpointReader,
): TurnExecutionOptions {
  const store = options.store, recordFinalResponse = store.recordFinalResponse
  if (!read || !recordFinalResponse) return options
  return { ...options, store: { ...store, recordFinalResponse(input) {
    if (!input.noProgress) return recordFinalResponse.call(store, input)
    const noProgress: AtomicTurnNoProgressInput = { ...input.noProgress, taskGraphDenialCheckpoint: checkpoint, readTaskGraphDenialCheckpoint: read }
    return recordFinalResponse.call(store, { ...input, noProgress })
  } } }
}

export async function terminalizeNoProgressFailure(input: Readonly<{
  error: NoProgressError; options: TurnExecutionOptions; writer: TurnExecutionEventWriter; step: TurnEngineStep | null; stepOpen: boolean
  stepCount: number; toolCallCount: number; usage: import("../budget.js").TurnUsage; now: () => Date
  inputThroughSequence: bigint; consumedInputIds: readonly string[]
}>): Promise<TurnEngineResult | null> {
  const { error, options, step } = input
  if (!isTaskGraphTerminalDenial(error)) return null
  if (!step || !input.stepOpen || options.identity.kind !== "turn" || options.identity.taskId !== options.identity.rootTaskId
    || !canPersistFinalResponse(options) || !options.store.recordFinalResponse) return null
  const readCheckpoint = options.completionGate?.[READ_TASK_GRAPH_DENIAL_CHECKPOINT]
  if (!readCheckpoint) return null
  const checkpoint = await readCheckpoint()
  if (!checkpoint) return null
  const final = finalizeTurn({ goal: options.goal, terminalReason: "no_progress", blocker: error.message,
    usage: totalTurnUsage(options.resume?.usage, input.usage), stepCount: input.stepCount, toolCallCount: input.toolCallCount,
    next: ["Review the blocker and resume the Turn"] })
  const finalItemId = options.idFactory?.(executionId(options.identity, `item:final:${step.id}`)) ?? executionId(options.identity, `item:final:${step.id}`)
  const checkpointedOptions = withTaskGraphDenialCheckpoint(options, checkpoint, readCheckpoint)
  const recordFinalResponse = checkpointedOptions.store.recordFinalResponse
  if (!recordFinalResponse) return null
  const terminal = await recordFinalResponse.call(checkpointedOptions.store, { identity: options.identity, response: serializeFinalResponse(final), now: input.now(), noProgress: {
    stepId: step.id, finalItemId, finalContent: toRepositoryJson({ text: final.response, final: toRepositoryJson(final) }),
    stepCount: input.stepCount, toolCallCount: input.toolCallCount, usage: final.usage,
    inputThroughSequence: input.inputThroughSequence, consumedInputIds: input.consumedInputIds,
    reasonCode: error.reasonCode, signature: error.observation.signature, stateFingerprint: error.observation.stateFingerprint,
  } })
  if (!terminal || terminal.status === "input_changed") throw new TurnStateRefreshRetryError()
  if (terminal.status !== "no_progress") throw new TurnEngineError("persistence_conflict", "Atomic no-progress completion returned an invalid receipt")
  for (const event of terminal.events) await Promise.resolve(options.subscribe?.(event)).catch(() => undefined)
  return { status: "failed", stepCount: input.stepCount, toolCallCount: input.toolCallCount, errorCode: "no_progress", finalItemId: terminal.finalItemId }
}

export async function commitTurnNoProgress(
  pool: TurnEnginePool,
  owner: ExecutionOwnerFence,
  response: string,
  now: Date,
  denial: AtomicTurnNoProgressInput,
  appendEvents: AppendEvents,
): Promise<AtomicTurnNoProgressResult> {
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId) throw conflict("no-progress root identity")
  if (!validDenial(denial)) throw conflict("no-progress receipt identity")
  const checkpoint = parseTaskGraphDenialCheckpoint(denial.taskGraphDenialCheckpoint, owner.rootTaskId)
  const readCheckpoint = denial.readTaskGraphDenialCheckpoint
  if (!checkpoint || !readCheckpoint) return { status: "input_changed" }
  const final = JSON.parse(response) as RepositoryJsonValue
  const result = { status: "failed", stepCount: denial.stepCount, toolCallCount: denial.toolCallCount, finalItemId: denial.finalItemId, waitId: null }

  return turnEngineTenantTransaction(pool, owner.userId, async client => {
    if (!await lockTurnEngineOpenSession(client, owner) || !await lockTurnEngineOwnedTurn(client, owner)) throw conflict(`turn ${owner.turnId}`)
    await lockRootTask(client, owner)
    await assertSessionWorkAdmission(client, owner)

    const step = await client.query<TurnEngineRow>(`SELECT "status", "inputThroughSequence", "consumedInputIds" FROM "agent_steps"
      WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "taskId"=$4 AND "attempt"=1 FOR UPDATE`,
    [denial.stepId, owner.sessionId, owner.turnId, owner.taskId])
    const stepRow = step.rows[0]
    if (!stepRow || stepRow.status !== "streaming") throw conflict(`no-progress Step ${denial.stepId} fence`)
    if (String(stepRow.inputThroughSequence) !== denial.inputThroughSequence.toString()
      || !sameJson(stepRow.consumedInputIds, denial.consumedInputIds)) return { status: "input_changed" }

    const pending = await client.query<TurnEngineRow>(`SELECT "id" FROM "agent_inputs" WHERE "sessionId"=$1 AND "userId"=$2 AND "targetTurnId"=$3
      AND "delivery"='steer' AND "status" IN ('accepted','queued','consumed') AND "cancelledAt" IS NULL
      AND "acceptedSequence">$4 FOR UPDATE`,
    [owner.sessionId, owner.userId, owner.turnId, denial.inputThroughSequence.toString()])
    if (pending.rows.length > 0) return { status: "input_changed" }

    const current = parseTaskGraphDenialCheckpoint(await readCheckpoint(client), owner.rootTaskId)
    if (!sameCheckpoint(checkpoint, current)) return { status: "input_changed" }

    const prefix = `turn:${owner.turnId}:event:`
    const start = await client.query<TurnEngineRow>(`SELECT "id" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "idempotencyKey"=$3`,
      [owner.sessionId, owner.turnId, `${prefix}step-started:${denial.stepId}`])
    if (!start.rows[0]) throw conflict(`no-progress Step start ${denial.stepId}`)

    const item = await client.query(`INSERT INTO "agent_items" ("id","sessionId","turnId","stepId","taskId","type","status","phase","revision","content","startedAt","completedAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,'agent_message','completed','final_answer',1,$6::jsonb,$7,$7,$7) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    [denial.finalItemId, owner.sessionId, owner.turnId, denial.stepId, owner.taskId, json(denial.finalContent), now])
    if (item.rowCount !== 1) throw conflict(`no-progress final item ${denial.finalItemId}`)

    const closed = await client.query(`UPDATE "agent_steps" SET "status"='failed',"finishReason"=NULL,"errorCode"='no_progress',
      "inputTokens"=0,"outputTokens"=0,"estimatedCostUsd"=0,"completedAt"=$1
      WHERE "id"=$2 AND "sessionId"=$3 AND "turnId"=$4 AND "taskId"=$5 AND "status"='streaming'`,
    [now, denial.stepId, owner.sessionId, owner.turnId, owner.taskId])
    if (closed.rowCount !== 1) throw conflict(`no-progress Step ${denial.stepId} close`)

    const entries = terminalEntries(owner, denial, final)
    const inputs = entries.map((entry, index): TurnEngineEventInput => ({ owner, id: `${prefix}${entry.suffix}`, itemId: entry.itemId,
      type: entry.type, correlationId: entry.correlationId, causationId: index ? entry.causationId : String(start.rows[0]!.id),
      idempotencyKey: `${prefix}${entry.suffix}`, payload: toRepositoryJson(entry.payload) }))
    const saved = await appendEvents(pool, inputs, client)
    if (saved.length !== entries.length) throw conflict(`no-progress terminal events ${owner.turnId}`)

    const turn = await client.query(`UPDATE "agent_turns" SET "status"='failed',"leaseOwnerId"=NULL,"leaseExpiresAt"=NULL,
      "leaseStartedAt"=NULL,"completedAt"=$7,"finalResponse"=$8,"error"='no_progress',"revision"="revision"+1,"updatedAt"=$7
      WHERE "id"=$1 AND "sessionId"=$2 AND "userId"=$3 AND "rootTaskId"=$4 AND "leaseOwnerId"=$5 AND "leaseVersion"=$6
        AND "leaseExpiresAt">$7 AND "status"='in_progress'`,
    [owner.turnId, owner.sessionId, owner.userId, owner.taskId, owner.ownerId, owner.leaseVersion, now, response])
    if (turn.rowCount !== 1) throw conflict(`no-progress Turn ${owner.turnId}`)

    const root = await client.query(`UPDATE "sub_agent_tasks" SET "status"='failed',"result"=$6::jsonb,"failureReason"='no_progress',
      "leaseOwner"=NULL,"leaseExpiresAt"=NULL,"completedAt"=$7,"updatedAt"=$7
      WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "rootTaskId"=$1 AND "leaseOwner"=$4
        AND "attemptCount"=1 AND "status"='running' AND "interruptRequestedAt" IS NULL
        AND EXISTS (SELECT 1 FROM "agent_sessions" WHERE "id"=$2 AND "userId"=$5)`,
    [owner.taskId, owner.sessionId, owner.turnId, owner.ownerId, owner.userId, json(result), now])
    if (root.rowCount !== 1) throw conflict(`no-progress root task ${owner.taskId}`)

    await client.query(`UPDATE "agent_inputs" SET "status"='cancelled',"cancelledAt"=$4
      WHERE "sessionId"=$1 AND "userId"=$2 AND "targetTurnId"=$3 AND "delivery"='follow_up'
        AND "status" IN ('accepted','queued','consumed') AND "cancelledAt" IS NULL`,
    [owner.sessionId, owner.userId, owner.turnId, now])
    await cleanupFailedRootTaskGraph(client, { id: owner.taskId, userId: owner.userId, sessionId: owner.sessionId,
      turnId: owner.turnId, rootTaskId: owner.taskId, parentTaskId: null, taskType: "root" }, { kind: "terminal-failed-turn-recovery" }, now)
    return { status: "no_progress", finalItemId: denial.finalItemId, events: entries.map((entry, index) => ({
      id: saved[index]!.id, type: entry.type, itemId: entry.itemId, correlationId: entry.correlationId,
      causationId: index ? saved[index - 1]!.id : String(start.rows[0]!.id), payload: toRepositoryJson(entry.payload),
    })) }
  })
}

export async function handleTurnExecutionStepError(input: Readonly<{
  error: unknown; options: TurnExecutionOptions; writer: TurnExecutionEventWriter; step: TurnEngineStep
  stepOutput: import("./turn-engine-model.js").ModelStepResult | null; questionIntentCallId: string | null
  executionOptions: TurnExecutionOptions; signal: AbortSignal; now: () => Date
  closedSteps: Set<string>; receiptClosedSteps: Set<string>
}>): Promise<never> {
  const { error, options, writer, step, stepOutput, questionIntentCallId, signal, now } = input
  if (input.receiptClosedSteps.has(step.id)) throw error
  if (isPreparedQuestionRetryError(error) || isTurnStateRefreshRetryError(error)) throw error
  if (questionIntentCallId && isSessionPauseRequestedError(error)) {
    const questionCall = stepOutput?.toolCalls.find(call => call.id === questionIntentCallId)
    if (!questionCall || !stepOutput?.usage || !input.executionOptions.store.cancelPausedQuestion) throw error
    let disposition: "cancelled" | "prepared"
    try {
      disposition = await input.executionOptions.store.cancelPausedQuestion({ identity: options.identity, stepId: step.id,
        toolCallId: questionIntentCallId, callArguments: questionCall.arguments, finishReason: stepOutput.finishReason,
        usage: stepOutput.usage, now: now() })
    } catch { throw error }
    if (disposition === "prepared") throw new PreparedQuestionRetryError()
    input.closedSteps.add(step.id)
    throw error
  }
  if (questionIntentCallId && (signal.aborted || options.isOwnershipLost?.(error, signal))) throw error
  if (input.closedSteps.has(step.id) && (isSessionPauseRequestedError(error) || error instanceof NoProgressError)) throw error
  const status = signalWasInterrupted(signal) || isSessionPauseRequestedError(error) ? "interrupted" : "failed"
  await updateExecutionStep(input.executionOptions, { stepId: step.id, status, finishReason: stepOutput?.finishReason ?? null,
    errorCode: turnErrorCode(error), inputTokens: stepOutput?.usage?.inputTokens ?? 0, outputTokens: stepOutput?.usage?.outputTokens ?? 0,
    estimatedCostUsd: stepOutput?.usage?.estimatedCostUsd ?? 0, now: now() }).catch(() => undefined)
  await writer.append("step.completed", step.id, null, { stepId: step.id, status, errorCode: turnErrorCode(error), taskId: options.identity.taskId },
    `step-${status === "interrupted" ? "interrupted" : "failed"}:${step.id}`).catch(() => undefined)
  throw error
}

export async function terminalizeTurnExecutionError(input: Readonly<{
  error: unknown; options: TurnExecutionOptions; writer: TurnExecutionEventWriter; signal: AbortSignal
  lastStep: TurnEngineStep | null; stepOpen: boolean; stepCount: number; toolCallCount: number; usage: TurnUsage
  now: () => Date; inputThroughSequence: bigint; consumedInputIds: readonly string[]
}>): Promise<TurnEngineResult> {
  const { error, options, writer, signal, now } = input
  if (isPreparedQuestionRetryError(error) || isTurnStateRefreshRetryError(error)) throw error
  if (signalWasInterrupted(signal)) {
    const code = turnErrorCode(error)
    await writer.append("turn.interrupted", options.identity.turnId, null,
      { turnId: options.identity.turnId, taskId: options.identity.taskId, errorCode: code }, "turn-interrupted").catch(() => undefined)
    return { status: "interrupted", stepCount: input.stepCount, toolCallCount: input.toolCallCount, errorCode: code }
  }
  if (isSessionPauseRequestedError(error) || signal.aborted) throw error
  const code = turnErrorCode(error)
  if (error instanceof NoProgressError) {
    const result = await terminalizeNoProgressFailure({ error, options, writer, step: input.lastStep, stepOpen: input.stepOpen,
      stepCount: input.stepCount, toolCallCount: input.toolCallCount, usage: input.usage, now,
      inputThroughSequence: input.inputThroughSequence, consumedInputIds: input.consumedInputIds })
    if (result) return result
    await writer.append("turn.no_progress", options.identity.turnId, null,
      { reasonCode: error.reasonCode, signature: error.observation.signature, stateFingerprint: error.observation.stateFingerprint, taskId: options.identity.taskId },
      "turn-no-progress").catch(() => undefined)
  }
  if (error instanceof BudgetExceededError) await writer.append("turn.budget_exhausted", options.identity.turnId, null,
    { reasonCode: error.code, metric: error.metric, limit: error.limit, attempted: error.attempted, used: error.used, taskId: options.identity.taskId },
    "turn-budget-exhausted").catch(() => undefined)
  const terminalReason = error instanceof BudgetExceededError ? "budget_exhausted" : error instanceof NoProgressError ? "no_progress"
    : code === "final_unverified" || code.startsWith("evidence_") || code === "business_precondition_failed" ? "final_unverified" : "unrecoverable_error"
  const finalResponse = finalizeTurn({ goal: options.goal, terminalReason, blocker: error instanceof Error ? error.message : code,
    usage: totalTurnUsage(options.resume?.usage, input.usage), stepCount: input.stepCount, toolCallCount: input.toolCallCount,
    next: ["Review the blocker and resume the Turn"] })
  if (options.isOwnershipLost?.(error, signal)) throw error
  const finalItem = await publishFinalResponse(writer, options, input.lastStep, finalResponse, now).catch(() => null)
  if (finalItem && canPersistFinalResponse(options)) await options.store.recordFinalResponse?.({ identity: options.identity,
    response: serializeFinalResponse(finalResponse), now: now() }).catch(() => undefined)
  await writer.append("turn.failed", options.identity.turnId, finalItem?.id ?? null,
    { turnId: options.identity.turnId, taskId: options.identity.taskId, errorCode: code, finalItemId: finalItem?.id ?? null, final: finalResponse },
    `turn-failed:${code}`).catch(() => undefined)
  return { status: "failed", stepCount: input.stepCount, toolCallCount: input.toolCallCount, errorCode: code,
    ...(finalItem ? { finalItemId: finalItem.id } : {}) }
}

async function lockRootTask(client: TurnEngineQueryClient, owner: Extract<ExecutionOwnerFence, { kind: "turn" }>): Promise<void> {
  const root = await client.query<TurnEngineRow>(`SELECT "id","status","leaseOwner","attemptCount","interruptRequestedAt" FROM "sub_agent_tasks"
    WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "rootTaskId"=$1 FOR UPDATE`, [owner.taskId, owner.sessionId, owner.turnId])
  const row = root.rows[0]
  if (!row || row.status !== "running" || row.leaseOwner !== owner.ownerId || Number(row.attemptCount) !== 1 || row.interruptRequestedAt != null) {
    throw conflict(`no-progress root task ${owner.taskId} fence`)
  }
}

function isTaskGraphTerminalDenial(error: NoProgressError): boolean {
  return error.reasonCode === "repeated_signature" && error.observation.signature === "task_graph_terminal_denial"
    && error.observation.stateFingerprint === error.observation.signature
}

function validDenial(value: AtomicTurnNoProgressInput): boolean {
  return !!value && typeof value === "object" && typeof value.stepId === "string" && value.stepId.length > 0
    && typeof value.finalItemId === "string" && value.finalItemId.length > 0 && typeof value.inputThroughSequence === "bigint"
    && value.inputThroughSequence >= 0n && Array.isArray(value.consumedInputIds)
    && value.consumedInputIds.every(id => typeof id === "string" && id.length > 0)
    && new Set(value.consumedInputIds).size === value.consumedInputIds.length
    && Number.isSafeInteger(value.stepCount) && value.stepCount >= 0 && Number.isSafeInteger(value.toolCallCount) && value.toolCallCount >= 0
    && value.reasonCode === "repeated_signature" && value.signature === "task_graph_terminal_denial"
    && value.stateFingerprint === value.signature && value.signature.length <= 256
    && typeof value.stateFingerprint === "string" && value.stateFingerprint.length > 0 && value.stateFingerprint.length <= 256
}

function sameCheckpoint(left: TaskGraphDenialCheckpoint, right: TaskGraphDenialCheckpoint | null): boolean {
  return !!right && left.taskId === right.taskId && left.graphRevision === right.graphRevision
    && left.verificationDigest === right.verificationDigest
}

function terminalEntries(owner: ExecutionOwnerFence, denial: AtomicTurnNoProgressInput, final: RepositoryJsonValue) {
  const prefix = `turn:${owner.turnId}:event:`
  return [
    { suffix: `step-failed:${denial.stepId}`, type: "step.completed", itemId: null, correlationId: denial.stepId, causationId: null,
      payload: { stepId: denial.stepId, status: "failed", errorCode: "no_progress", taskId: owner.taskId } },
    { suffix: "turn-no-progress", type: "turn.no_progress", itemId: null, correlationId: owner.turnId, causationId: null,
      payload: { reasonCode: denial.reasonCode, signature: denial.signature, stateFingerprint: denial.stateFingerprint, taskId: owner.taskId } },
    { suffix: `item-started:${denial.finalItemId}`, type: "item.started", itemId: denial.finalItemId, correlationId: denial.stepId, causationId: null,
      payload: { itemId: denial.finalItemId, type: "agent_message", phase: "final_answer" } },
    { suffix: `final-completed:${denial.finalItemId}:1`, type: "item.completed", itemId: denial.finalItemId, correlationId: denial.finalItemId, causationId: null,
      payload: { itemId: denial.finalItemId, status: "completed", content: denial.finalContent } },
    { suffix: "turn-failed:no_progress", type: "turn.failed", itemId: denial.finalItemId, correlationId: owner.turnId, causationId: null,
      payload: { turnId: owner.turnId, taskId: owner.taskId, errorCode: "no_progress", finalItemId: denial.finalItemId, final } },
  ] as const
}
