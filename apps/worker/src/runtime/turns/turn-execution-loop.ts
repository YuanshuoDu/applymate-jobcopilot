import type { ModelContinuation } from "@jobcopilot/agent-model"
import { Buffer } from "node:buffer"

import { signalWasInterrupted } from "../interrupt/registry.js"
import { BudgetExceededError, createTurnBudgetLedger, type TurnBudgetLimits } from "../budget.js"
import { finalizeTurn, serializeFinalResponse } from "../finalizer.js"
import { NoProgressError, createProgressDetector } from "../progress.js"
import { snapshotEvidence, verifyCandidateFinal } from "../verifier.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import { findToolObservation, findToolResultObservation, stableJson } from "./turn-engine-replay.js"
import { canonicalQuestionId, TurnEngineError, toRepositoryJson, type TurnEngineQuestionWait, type TurnEngineResult, type TurnEngineStep, type TurnEngineStore, type TurnEngineToolCall, type TurnEngineToolResult } from "./turn-engine-types.js"
import { executeToolWithItems, publishCommentary, publishFinalResponse, publishReasoningSummary, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { assertExecutionAlive, assertModelAllowance, canEmitTurnCompleted, canPersistFinalResponse, makeExecutionId, resumedBudgetLimits, totalTurnUsage, turnErrorCode, updateExecutionStep } from "./turn-engine-helpers.js"
import { isQuestionText, parseQuestionOptions, QUESTION_MAX_TEXT_BYTES } from "./turn-question-wait-store.js"
import { parsePlanRevisionEvent, parsePlanRevisionReceipt, planRevisionObservation, type PlanRevisionReceipt } from "../planning/plan-revision-receipt.js"
import { goalRevisionObservation, parseGoalRevisionOutput, type GoalRevisionReceipt } from "../planning/goal-revision-receipt.js"
import { verifyPlanCompletion } from "../planning/plan-completion-verifier.js"
import { buildPlanCompletionFeedback, buildPlanCompletionFeedbackEvent, currentPlanId, MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS, planCompletionFeedbackIdempotencyKey, PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, planCompletionRecoveryCount } from "../planning/plan-completion-feedback.js"
import { buildReplanFeedback, deriveReplanObligation, MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS, replanFeedbackAttempts, type ReplanObligation } from "../planning/plan-replan-obligation.js"
import { runContextCompaction } from "../context/context-compaction-runtime.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"
import { appliedSteeringMarkerEntries } from "../context/steering-marker-store.js"
import { STEERING_MARKER_EVENT_TYPE, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { buildCognitiveActionAgenda } from "./cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE, cognitiveAgendaReceiptIdempotencyKey } from "./cognitive-agenda-receipt.js"

const DEFAULT_MAX_STEPS = 32
const PLAN_OBSERVATION_MAX_BYTES = 8 * 1024

export async function runTurnExecutionLoop(options: TurnExecutionOptions): Promise<TurnEngineResult> {
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? (() => new Date())
  const writer = new TurnExecutionEventWriter({ ...options, signal, now })
  const baseBudget: TurnBudgetLimits = {
    ...options.budget,
    maxSteps: options.budget?.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS,
  }
  const budget = createTurnBudgetLedger(resumedBudgetLimits(baseBudget, options.resume) ?? {})
  const executionOptions: TurnExecutionOptions = options.executePlan ? {
    ...options,
    executePlan: async input => {
      let admitted = 0
      try {
        return await options.executePlan!({
          ...input,
          admitPlanCommands: count => {
            budget.reserveToolCalls(count)
            admitted += count
          },
        })
      } finally {
        budget.accountToolCalls(admitted)
      }
    },
  } : options
  const progress = createProgressDetector(options.noProgressRepeatLimit ?? 2)
  let snapshot = options.snapshot
  let inputThroughSequence = options.resume?.inputThroughSequence ?? 0n
  let consumedInputIds: readonly string[] = options.resume?.consumedInputIds ?? []
  let steps = options.resume?.stepCount ?? 0
  let toolCalls = options.resume?.toolCallCount ?? 0
  let continuation: ModelContinuation | undefined
  let steeringMarkerState = options.steeringMarkerState
  const seenCallIds = new Set<string>()
  let lastStep: TurnEngineStep | null = null
  try {
    const planCompletionRecoveryLimit = resolvePlanCompletionRecoveryLimit(options)
    await writer.append(
      "turn.started", options.identity.turnId, null,
      { goal: options.goal, taskId: options.identity.taskId, rootTaskId: options.identity.rootTaskId },
      "turn-started",
    )
    for (let ordinal = options.resume?.nextOrdinal ?? 0; ; ordinal += 1) {
      assertExecutionAlive(options, signal)
      budget.reserveStep()
      steps += 1
      const stepId = makeExecutionId(options, `step:${ordinal}`)
      const attempt = options.identity.kind === "task" ? options.identity.attemptCount ?? 1 : 1
      const step = await options.store.startStep({
        identity: options.identity, stepId, ordinal, attempt, inputThroughSequence, consumedInputIds: [],
        modelProfileSnapshot: toRepositoryJson(options.model.profile), now: now(),
      })
      lastStep = step
      await writer.append(
        "step.started", step.id, null, { stepId: step.id, ordinal: step.ordinal, taskId: options.identity.taskId },
        `step-started:${step.id}`,
      )
      let stepOutput: ModelStepResult | null = null
      try {
        const obligationBeforeCompaction = activeReplanObligation(options, snapshot)
        const questionReplanBeforeCompaction = questionAnswerReplanPresent(options, snapshot)
        snapshot = (await runContextCompaction({
          hook: options.contextCompaction, loadSnapshot: options.contextCompactionLoadSnapshot, identity: options.identity, scope: options.scope,
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, stepId: step.id,
          signal, now: now(), snapshot,
          append: (payload, key) => writer.append("context.compaction", step.id, null, payload, key),
        })).snapshot
        const obligationAfterCompaction = activeReplanObligation(options, snapshot)
        const questionReplanAfterCompaction = questionAnswerReplanPresent(options, snapshot)
        if (obligationBeforeCompaction && (!obligationAfterCompaction || stableJson(obligationBeforeCompaction) !== stableJson(obligationAfterCompaction))) throw new TurnEngineError("invalid_output", "Context compaction dropped the active replan obligation")
        if (questionReplanBeforeCompaction && !questionReplanAfterCompaction) throw new TurnEngineError("invalid_output", "Context compaction dropped the answered question")
        const context = await options.contextBuilder.build({
          scope: options.scope, identity: options.identity, stepId: step.id, snapshot,
          rootInputId: ordinal === 0 ? options.rootInputId : undefined, now: now(),
          taskId: options.identity.taskId,
          steeringMarkerState: markerStateFor(options.identity.taskId, obligationAfterCompaction, steeringMarkerState),
          steeringMarkerContext: obligationAfterCompaction ? {
            sessionId: options.identity.sessionId, turnId: options.identity.turnId,
            taskId: options.identity.taskId, obligationId: obligationAfterCompaction.id,
            goalRevision: obligationAfterCompaction.goalRevision, planRevision: obligationAfterCompaction.planRevision,
          } : undefined,
        })
        const freshSteering = hasFreshSteering(context, consumedInputIds)
        const newlyObservedMarkers = context.steeringMarkerControl?.newlyObservedMarkers ?? []
        if (newlyObservedMarkers.length > 0) steeringMarkerState = rememberSteeringMarkers(steeringMarkerState, newlyObservedMarkers)
        inputThroughSequence = context.inputThroughSequence
        consumedInputIds = context.consumedInputIds
        const replanRequired = obligationAfterCompaction !== undefined || questionReplanAfterCompaction
        const receipt = buildCognitiveAgendaReceipt({
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, taskId: options.identity.taskId, stepId: step.id,
          inputThroughSequence, consumedInputIds,
          agenda: buildCognitiveActionAgenda(context, { replanRequired, freshSteering: replanRequired && freshSteering }),
        })
        const receiptKey = cognitiveAgendaReceiptIdempotencyKey(step.id)
        if (!receipt || !receiptKey) throw new TurnEngineError("invalid_output", "Cognitive agenda receipt could not be built")
        try {
          await writer.append(COGNITIVE_AGENDA_EVENT_TYPE, step.id, null, receipt, receiptKey)
        } catch {
          throw new TurnEngineError("persistence_conflict", "Cognitive agenda receipt could not be persisted")
        }
        const request = buildModelRequest({
          context, model: options.model, tools: options.tools,
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, stepId: step.id,
          taskId: options.identity.taskId, userId: options.identity.userId, signal, continuation,
          replanRequired,
          freshSteering,
        })
          assertModelAllowance(budget.snapshot())
        const reservation = budget.reserveModel()
        const output = await runModelStep(options.model, request, options.validateToolArguments)
        stepOutput = output; reservation.settle(output.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }); continuation = output.continuation ?? undefined
        const obligation = activeReplanObligation(options, snapshot)
        const questionReplanRequired = questionAnswerReplanPresent(options, snapshot)
        const replanBatchAllowed = replanToolBatchAllowed(output.toolCalls, obligation, freshSteering, questionReplanRequired)
        await writer.append(
          "model.usage", step.id, null,
          { provider: output.provider, model: output.model, usage: output.usage, taskId: options.identity.taskId },
          `model-usage:${step.id}`,
        )
        if (!replanBatchAllowed) {
          if (obligation) snapshot = await rejectReplanOutput(options, writer, step, output, snapshot, obligation, now)
          else await rejectForcedReplanOutput(options, writer, step, output, now)
          continuation = undefined
          continue
        }
        await publishReasoningSummary(writer, options, step, output.reasoningSummary, now)
        if (output.toolCalls.length > 0) {
          progress.observe({ snapshot, toolCalls: output.toolCalls })
          budget.reserveToolCalls(output.toolCalls.length)
          if (output.text) await publishCommentary(writer, options, step, output.text, now)
          let outcome: { wait: TurnEngineResult | null; snapshot: typeof options.snapshot; steeringMarkerState: typeof steeringMarkerState }
          try {
            outcome = await executeTools(executionOptions, writer, step, output, snapshot, seenCallIds, signal, now, steeringMarkerState)
          } finally {
            budget.accountToolCalls(output.toolCalls.length)
          }
          toolCalls += output.toolCalls.length
          snapshot = outcome.snapshot
          steeringMarkerState = outcome.steeringMarkerState
          // Tool results and plan observations are server-owned context; do not reuse a provider cursor across this boundary.
          continuation = undefined
          assertExecutionAlive(options, signal)
          const wait = outcome.wait
          const stepStatus = wait?.status === "waiting_for_dependency"
            ? "waiting_for_tool"
            : wait?.status === "waiting_for_approval" || wait?.status === "waiting_for_user" ? wait.status : "completed"
          await updateExecutionStep(options, {
            stepId: step.id, status: stepStatus, finishReason: output.finishReason, errorCode: wait?.errorCode ?? null,
            inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
            estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(),
          })
          await writer.append(
            "step.completed", step.id, null,
            { stepId: step.id, status: wait?.status ?? "completed", toolCallCount: output.toolCalls.length, taskId: options.identity.taskId },
            `step-completed:${step.id}`,
          )
          if (wait) {
            if (wait.status === "waiting_for_user") {
              const questionStore = options.store as TurnExecutionOptions["store"] & Pick<TurnEngineStore, "createQuestionWait">
              if (wait.question && questionStore.createQuestionWait) await questionStore.createQuestionWait({ owner: options.identity, stepId: step.id, now: now(), question: wait.question })
              else await options.store.waitForUser?.({ identity: options.identity, now: now() })
            }
            return { ...wait, stepCount: steps, toolCallCount: toolCalls }
          }
          continue
        }
        if (replanRequired) {
          const currentObligation = activeReplanObligation(options, snapshot)
          if (currentObligation) snapshot = await rejectReplanOutput(options, writer, step, output, snapshot, currentObligation, now)
          else await rejectForcedReplanOutput(options, writer, step, output, now)
          continuation = undefined
          continue
        }
        await updateExecutionStep(options, {
          stepId: step.id, status: "completed", finishReason: output.finishReason, errorCode: null,
          inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
          estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(),
        })
        await writer.append(
          "step.completed", step.id, null, { stepId: step.id, status: "completed", taskId: options.identity.taskId },
          `step-completed:${step.id}`,
        )
        const verification = verifyCandidateFinal({
          goal: options.goalRef?.get().objective ?? options.goal, candidate: { text: output.text, finishReason: output.finishReason },
          evidence: snapshotEvidence(snapshot), expectedEvidence: options.expectedEvidence, businessChecks: options.businessChecks,
        })
        if (!verification.ok) {
          await writer.append(
            "final.rejected", step.id, null,
            { code: verification.code, blocker: verification.blocker, feedback: verification.feedback, taskId: options.identity.taskId },
            `final-rejected:${step.id}`,
          )
          throw new TurnEngineError(verification.code, verification.blocker)
        }
        const planCompletion = verifyPlanCompletion({ snapshot, required: options.planCompletionRequired === true, expectedGoalRevision: options.goalRef?.get().revision })
        if (!planCompletion.ok) {
          const planId = currentPlanId(snapshot.toolObservations)
          const usedRecoveryAttempts = planCompletionRecoveryCount(snapshot.toolObservations, options.identity.turnId, planId)
          if (usedRecoveryAttempts < planCompletionRecoveryLimit) {
            const feedback = buildPlanCompletionFeedback(step.id, usedRecoveryAttempts + 1, planId)
            if (!feedback) throw new TurnEngineError("invalid_output", "Plan completion feedback could not be built")
            const event = buildPlanCompletionFeedbackEvent({ turnId: options.identity.turnId, stepId: step.id, attempt: feedback.content.attempt, planId })
            const idempotencyKey = planCompletionFeedbackIdempotencyKey(step.id)
            if (!event || !idempotencyKey) throw new TurnEngineError("invalid_output", "Plan completion feedback identity could not be built")
            try {
              await writer.append(PLAN_COMPLETION_FEEDBACK_EVENT_TYPE, step.id, null, event, idempotencyKey)
            } catch {
              throw new TurnEngineError("invalid_output", "Plan completion feedback could not be persisted")
            }
            snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, feedback] }
            continuation = undefined
            continue
          }
          await writer.append(
            "final.rejected", step.id, null,
            { code: "final_unverified", blocker: planCompletion.blocker, feedback: planCompletion.feedback, taskId: options.identity.taskId },
            `final-rejected:${step.id}:plan-completion`,
          )
          throw new TurnEngineError("final_unverified", planCompletion.blocker)
        }
        await assertCompletionAllowed(options, writer, step, signal, now)
        const finalResponse = finalizeTurn({
          goal: options.goalRef?.get().objective ?? options.goal, verification, terminalReason: "goal_satisfied", response: output.text,
          usage: totalTurnUsage(options.resume?.usage, budget.usage()), stepCount: steps, toolCallCount: toolCalls,
        })
        const finalItem = await publishFinalResponse(writer, options, step, finalResponse, now)
        if (canPersistFinalResponse(options)) {
          await options.store.recordFinalResponse?.({ identity: options.identity, response: serializeFinalResponse(finalResponse), now: now() })
        }
        if (canEmitTurnCompleted(options)) {
          await writer.append(
            "turn.completed", step.id, finalItem.id,
            { turnId: options.identity.turnId, taskId: options.identity.taskId, finalItemId: finalItem.id, usage: finalResponse.usage },
            "turn-completed",
          )
        }
        return { status: "completed", stepCount: steps, toolCallCount: toolCalls, finalItemId: finalItem.id, finalText: output.text }
      } catch (error: unknown) {
        const status = signalWasInterrupted(signal) ? "interrupted" : "failed"
        await updateExecutionStep(options, {
          stepId: step.id, status, finishReason: stepOutput?.finishReason ?? null, errorCode: turnErrorCode(error),
          inputTokens: stepOutput?.usage?.inputTokens ?? 0, outputTokens: stepOutput?.usage?.outputTokens ?? 0,
          estimatedCostUsd: stepOutput?.usage?.estimatedCostUsd ?? 0, now: now(),
        }).catch(() => undefined)
        await writer.append(
          "step.completed", step.id, null,
          { stepId: step.id, status, errorCode: turnErrorCode(error), taskId: options.identity.taskId },
          `step-failed:${step.id}`,
        ).catch(() => undefined)
        throw error
      }
    }
  } catch (error: unknown) {
    if (signalWasInterrupted(signal)) {
      const code = turnErrorCode(error)
      await writer.append(
        "turn.interrupted", options.identity.turnId, null,
        { turnId: options.identity.turnId, taskId: options.identity.taskId, errorCode: code },
        "turn-interrupted",
      ).catch(() => undefined)
      return { status: "interrupted", stepCount: steps, toolCallCount: toolCalls, errorCode: code }
    }
    if (signal.aborted) throw error
    const code = turnErrorCode(error)
    if (error instanceof NoProgressError) await writer.append("turn.no_progress", options.identity.turnId, null, { reasonCode: error.reasonCode, signature: error.observation.signature, stateFingerprint: error.observation.stateFingerprint, taskId: options.identity.taskId }, "turn-no-progress").catch(() => undefined)
    if (error instanceof BudgetExceededError) await writer.append("turn.budget_exhausted", options.identity.turnId, null, { reasonCode: error.code, metric: error.metric, limit: error.limit, attempted: error.attempted, used: error.used, taskId: options.identity.taskId }, "turn-budget-exhausted").catch(() => undefined)
    const terminalReason = error instanceof BudgetExceededError
      ? "budget_exhausted"
      : error instanceof NoProgressError
        ? "no_progress"
        : code === "final_unverified" || code.startsWith("evidence_") || code === "business_precondition_failed"
          ? "final_unverified"
          : "unrecoverable_error"
    const finalResponse = finalizeTurn({
      goal: options.goalRef?.get().objective ?? options.goal, terminalReason, blocker: error instanceof Error ? error.message : code,
      usage: totalTurnUsage(options.resume?.usage, budget.usage()), stepCount: steps, toolCallCount: toolCalls,
      next: ["Review the blocker and resume the Turn"],
    })
    if (options.isOwnershipLost?.(error, signal)) throw error
    const finalItem = await publishFinalResponse(writer, options, lastStep, finalResponse, now).catch(() => null)
    if (finalItem && canPersistFinalResponse(options)) {
      await options.store.recordFinalResponse?.({ identity: options.identity, response: serializeFinalResponse(finalResponse), now: now() }).catch(() => undefined)
    }
    await writer.append(
      "turn.failed", options.identity.turnId, finalItem?.id ?? null,
      { turnId: options.identity.turnId, taskId: options.identity.taskId, errorCode: code, finalItemId: finalItem?.id ?? null, final: finalResponse },
      `turn-failed:${code}`,
    ).catch(() => undefined)
    return { status: "failed", stepCount: steps, toolCallCount: toolCalls, errorCode: code, ...(finalItem ? { finalItemId: finalItem.id } : {}) }
  }
}

function resolvePlanCompletionRecoveryLimit(options: TurnExecutionOptions): number {
  if (options.planCompletionRequired !== true) return 0
  const limit = options.planCompletionRecoveryLimit ?? 1
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_PLAN_COMPLETION_RECOVERY_ATTEMPTS) {
    throw new TurnEngineError("invalid_output", "Plan completion recovery limit is outside the server-owned bound")
  }
  return limit
}

function replanSignalPresent(snapshot: StepContextSnapshot): boolean {
  return snapshot.toolObservations.some(observation => {
    const content = observation.content
    return content !== null && typeof content === "object" && !Array.isArray(content) && "kind" in content && content.kind === "plan_control" && "status" in content && content.status === "replan_required"
  })
}

function waitingJoinPresent(snapshot: StepContextSnapshot): boolean {
  return snapshot.toolObservations.some(observation => {
    if (!observation.id.startsWith("plan-result:")) return false
    const content = observation.content
    if (!content || typeof content !== "object" || Array.isArray(content)) return false
    return "commandKind" in content && content.commandKind === "join" && "status" in content && content.status === "completed" && "output" in content &&
      content.output !== null && typeof content.output === "object" && !Array.isArray(content.output) && "status" in content.output && content.output.status === "waiting"
  })
}

type QuestionAnswerLineage = { readonly questionId: string; readonly planCallId: string; readonly localId: string; readonly question: string; readonly goalRevision: number; readonly planRevision: number }

function plainRow(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.has(key))
}

function questionAnswerLineage(options: TurnExecutionOptions, content: Record<string, unknown>): QuestionAnswerLineage {
  const goalRevision = options.goalRef?.get()?.revision ?? 1
  if (content.kind !== "question_answer" || !exactKeys(content, ["kind", "questionId", "toolCallId", "question", "answer", "answerAvailable", "planCallId", "localId", "goalRevision", "planRevision"]) ||
    content.answerAvailable !== true || !isQuestionText(content.questionId, 256) || !isQuestionText(content.toolCallId, 256) ||
    !isQuestionText(content.question, QUESTION_MAX_TEXT_BYTES) || !isQuestionText(content.answer, 20 * 1024) ||
    !isQuestionText(content.planCallId, 256) || !isQuestionText(content.localId, 128) ||
    !Number.isSafeInteger(content.goalRevision) || Number(content.goalRevision) < 1 || !Number.isSafeInteger(content.planRevision) || Number(content.planRevision) < 1 ||
    content.toolCallId !== content.planCallId || content.goalRevision !== goalRevision ||
    content.questionId !== canonicalQuestionId(options.identity.turnId, content.planCallId, Number(content.planRevision), content.localId)) throw new TurnEngineError("invalid_output", "Answered question has invalid server lineage")
  return { questionId: content.questionId, planCallId: content.planCallId, localId: content.localId, question: content.question, goalRevision: Number(content.goalRevision), planRevision: Number(content.planRevision) }
}

function assertQuestionAnswerLineage(options: TurnExecutionOptions, snapshot: StepContextSnapshot, content: Record<string, unknown>): QuestionAnswerLineage {
  const lineage = questionAnswerLineage(options, content)
  const controlId = `plan-control:${lineage.planCallId}:${lineage.localId}`
  const controls = snapshot.toolObservations.filter(observation => observation.id === controlId)
  const conflictingControls = snapshot.toolObservations.filter(observation => observation.id.startsWith(`${controlId}:`))
  if (controls.length !== 1 || conflictingControls.length > 0) throw new TurnEngineError("invalid_output", "Answered question plan control lineage is missing or ambiguous")
  const control = plainRow(controls[0]!.content)
  if (!control || !exactKeys(control, ["kind", "localId", "status", "question"], ["approvalBoundary"]) || control.kind !== "plan_control" ||
    control.localId !== lineage.localId || control.status !== "waiting_for_user" || control.question !== lineage.question ||
    (Object.hasOwn(control, "approvalBoundary") && !isQuestionText(control.approvalBoundary, 1_000))) throw new TurnEngineError("invalid_output", "Answered question plan control is conflicting")
  const revisionId = `plan-revision:${lineage.planCallId}`
  const revisions = snapshot.toolObservations.filter(observation => {
    const row = plainRow(observation.content)
    return observation.id === revisionId || row?.kind === "plan_revision" && row.planCallId === lineage.planCallId
  })
  const matchingRevisions = revisions.filter(observation => {
    const row = plainRow(observation.content)
    return observation.id === revisionId && row?.goalRevision === lineage.goalRevision && row.planRevision === lineage.planRevision &&
      exactKeys(row, ["kind", "planCallId", "goalRevision", "planRevision", "basedOnPlanRevision"], ["proposalHash"])
  })
  if (revisions.length !== 1 || matchingRevisions.length !== 1) throw new TurnEngineError("invalid_output", "Answered question plan revision lineage is missing or ambiguous")
  return lineage
}

function currentServerPlan(options: TurnExecutionOptions, snapshot: StepContextSnapshot, planCallId: string): PlanRevisionReceipt {
  const expectedGoalRevision = options.goalRef?.get()?.revision ?? 1
  if (!Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1) throw new TurnEngineError("invalid_output", "Answered question has no current server plan")
  const revisionId = `plan-revision:${planCallId}`
  const revisions = snapshot.toolObservations.filter(observation => {
    const row = plainRow(observation.content)
    return observation.id === revisionId || row?.kind === "plan_revision" && row.planCallId === planCallId
  })
  if (revisions.length !== 1) throw new TurnEngineError("invalid_output", "Current server plan revision is missing or ambiguous")
  const observation = revisions[0]!
  const row = plainRow(observation.content)
  if (!row || observation.id !== revisionId || row.kind !== "plan_revision" || row.planCallId !== planCallId) throw new TurnEngineError("invalid_output", "Current server plan revision is conflicting")
  const { kind: _kind, ...metadata } = row
  const revision = parsePlanRevisionEvent(metadata)
  if (!revision || revision.planCallId !== planCallId || revision.goalRevision !== expectedGoalRevision) throw new TurnEngineError("invalid_output", "Current server plan revision is invalid")
  return revision
}

function questionAnswerReplanPresent(options: TurnExecutionOptions, snapshot: StepContextSnapshot): boolean {
  let found = false
  const seenQuestionIds = new Set<string>()
  const activePlanCallId = currentPlanId(snapshot.toolObservations)
  const currentGoalRevision = options.goalRef?.get()?.revision ?? 1
  const hasQuestionAnswer = snapshot.toolObservations.some(observation => plainRow(observation.content)?.kind === "question_answer")
  const currentPlan = activePlanCallId !== null && hasQuestionAnswer ? currentServerPlan(options, snapshot, activePlanCallId) : null
  for (const observation of snapshot.toolObservations) {
    const content = plainRow(observation.content)
    if (!content) continue
    if (content.kind !== "question_answer") {
      if (Object.hasOwn(content, "questionId") || Object.hasOwn(content, "answerAvailable")) throw new TurnEngineError("invalid_output", "Answered question context has an invalid kind")
      continue
    }
    if (!isQuestionText(content.questionId, 256) || !isQuestionText(content.planCallId, 256) || content.answerAvailable !== true ||
      !Number.isSafeInteger(content.goalRevision) || Number(content.goalRevision) < 1) throw new TurnEngineError("invalid_output", "Answered question has invalid basic shape")
    if (currentPlan === null || content.planCallId !== currentPlan.planCallId) {
      if (currentPlan === null && Number(content.goalRevision) >= currentGoalRevision) throw new TurnEngineError("invalid_output", "Current-goal question answer has no active server plan")
      if (seenQuestionIds.has(content.questionId)) throw new TurnEngineError("invalid_output", "Answered question context is duplicated")
      seenQuestionIds.add(content.questionId)
      continue
    }
    const lineage = assertQuestionAnswerLineage(options, snapshot, content)
    const questionId = typeof content.questionId === "string" ? content.questionId : null
    if (questionId !== null && seenQuestionIds.has(questionId)) throw new TurnEngineError("invalid_output", "Answered question context is duplicated")
    if (questionId !== null) seenQuestionIds.add(questionId)
    if (lineage.planCallId === currentPlan.planCallId && lineage.planRevision === currentPlan.planRevision) found = true
  }
  return found
}

function activeReplanObligation(options: TurnExecutionOptions, snapshot: typeof options.snapshot): ReplanObligation | undefined {
  if (!replanSignalPresent(snapshot) && !waitingJoinPresent(snapshot)) return undefined
  const expectedGoalRevision = options.goalRef?.get()?.revision
  if (typeof expectedGoalRevision !== "number" || !Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1) throw new TurnEngineError("invalid_output", "Active replan obligation has no server-owned goal revision")
  return activeReplanObligationForGoalRevision(snapshot, expectedGoalRevision)
}

function activeReplanObligationForGoalRevision(snapshot: StepContextSnapshot, expectedGoalRevision: number): ReplanObligation | undefined {
  if (!replanSignalPresent(snapshot) && !waitingJoinPresent(snapshot)) return undefined
  if (!Number.isSafeInteger(expectedGoalRevision) || expectedGoalRevision < 1) throw new TurnEngineError("invalid_output", "Active replan obligation has no server-owned goal revision")
  const result = deriveReplanObligation({ observations: snapshot.toolObservations, expectedGoalRevision })
  if (result.kind === "invalid") throw new TurnEngineError("invalid_output", "Active replan obligation is invalid")
  return result.kind === "active" ? result.obligation : undefined
}

async function appendReplanFeedback(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, snapshot: typeof options.snapshot, obligation: ReplanObligation): Promise<typeof options.snapshot> {
  const attempts = replanFeedbackAttempts(snapshot.toolObservations, options.identity.turnId, obligation)
  if (!attempts.valid) throw new TurnEngineError("invalid_output", "Replan feedback history is invalid")
  if (attempts.highest >= MAX_PLAN_REPLAN_FEEDBACK_ATTEMPTS) throw new TurnEngineError("final_unverified", "Replan obligation recovery limit exceeded")
  const feedback = buildReplanFeedback(options.identity.turnId, obligation, attempts.highest + 1)
  if (!feedback) throw new TurnEngineError("invalid_output", "Replan feedback could not be built")
  await writer.append("plan.observation", obligation.planCallId, null, { planCallId: obligation.planCallId, observationId: feedback.id, content: feedback.content }, `plan-replan-feedback:${feedback.id}`)
  return { ...snapshot, toolObservations: [...snapshot.toolObservations, feedback] }
}

async function rejectReplanOutput(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep, output: ModelStepResult, snapshot: typeof options.snapshot, obligation: ReplanObligation, now: () => Date): Promise<typeof options.snapshot> {
  await updateExecutionStep(options, {
    stepId: step.id, status: "completed", finishReason: output.finishReason, errorCode: "replan_required",
    inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
    estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(),
  })
  await writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed", toolCallCount: 0, errorCode: "replan_required", taskId: options.identity.taskId }, `step-completed:${step.id}`)
  return appendReplanFeedback(options, writer, snapshot, obligation)
}

async function rejectForcedReplanOutput(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep, output: ModelStepResult, now: () => Date): Promise<void> {
  await updateExecutionStep(options, {
    stepId: step.id, status: "completed", finishReason: output.finishReason, errorCode: "replan_required",
    inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
    estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(),
  })
  await writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed", toolCallCount: output.toolCalls.length, errorCode: "replan_required", taskId: options.identity.taskId }, `step-completed:${step.id}`)
}

function hasFreshSteering(context: StepContext, consumedInputIds: readonly string[]): boolean {
  if (context.steeringMarkerControl && (context.steeringMarkerControl.activeInputIds.length > 0 || context.steeringMarkerControl.newlyObservedInputIds.length > 0)) return true
  const consumedBeforeBuild = new Set(consumedInputIds)
  const newlyConsumed = new Set(context.consumedInputIds.filter(inputId => !consumedBeforeBuild.has(inputId)))
  return context.blocks.some(block => {
    if (block.layer !== "pending_input" || block.role !== "data" || block.source !== "user_input" || block.trust !== "external_untrusted") return false
    const content = block.content
    if (!content || typeof content !== "object" || Array.isArray(content)) return false
    const inputId = content.inputId
    return typeof inputId === "string" && inputId.trim().length > 0 && newlyConsumed.has(inputId)
  })
}

function replanToolBatchAllowed(toolCalls: readonly TurnEngineToolCall[], obligation: ReplanObligation | undefined, freshSteering: boolean, questionReplanRequired = false): boolean {
  if (obligation === undefined && !questionReplanRequired) return true
  if (toolCalls.length !== 1) return false
  const name = toolCalls[0]?.name
  return name === "agent.plan.propose" || (freshSteering && name === "agent.goal.update")
}

function markerStateFor(taskId: string, obligation: ReplanObligation | undefined, state: { readonly active: readonly SteeringMarkerPayload[] } | undefined): { readonly active: readonly SteeringMarkerPayload[] } | undefined {
  if (!obligation || !state) return undefined
  return { active: state.active.filter(marker => marker.taskId === taskId && marker.obligationId === obligation.id && marker.goalRevision === obligation.goalRevision && marker.planRevision === obligation.planRevision) }
}

function rememberSteeringMarkers(current: { readonly active: readonly SteeringMarkerPayload[] } | undefined, additions: readonly SteeringMarkerPayload[]): { readonly active: readonly SteeringMarkerPayload[] } {
  const byKey = new Map<string, SteeringMarkerPayload>()
  for (const marker of [...current?.active ?? [], ...additions]) byKey.set(marker.idempotencyKey, marker)
  return { active: [...byKey.values()].sort((left, right) => left.idempotencyKey.localeCompare(right.idempotencyKey)) }
}

async function assertCompletionAllowed(options: TurnExecutionOptions, writer: TurnExecutionEventWriter, step: TurnEngineStep, signal: AbortSignal, now: () => Date): Promise<void> {
  if (!options.completionGate) return
  let decision: Awaited<ReturnType<NonNullable<TurnExecutionOptions["completionGate"]>>>
  try {
    decision = await options.completionGate({ identity: options.identity, scope: options.scope, rootTaskId: options.identity.rootTaskId, stepId: step.id, signal, now: now() })
  } catch {
    throw new TurnEngineError("invalid_output", "Completion gate failed closed")
  }
  if (!decision || typeof decision !== "object" || typeof decision.ok !== "boolean") throw new TurnEngineError("invalid_output", "Completion gate returned an invalid decision")
  if (decision.ok) return
  if (typeof decision.blocker !== "string" || typeof decision.feedback !== "string" || decision.blocker.length === 0 || decision.blocker.length > 256 || decision.feedback.length > 512) {
    throw new TurnEngineError("invalid_output", "Completion gate returned an invalid blocker")
  }
  await writer.append("final.rejected", step.id, null, { code: "business_precondition_failed", blocker: decision.blocker, feedback: decision.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}`)
  throw new TurnEngineError("business_precondition_failed", decision.blocker)
}

async function executeTools(
  options: TurnExecutionOptions,
  writer: TurnExecutionEventWriter,
  step: TurnEngineStep,
  output: ModelStepResult,
  initial: typeof options.snapshot,
  seen: Set<string>,
  signal: AbortSignal,
  now: () => Date,
  markerState: { readonly active: readonly SteeringMarkerPayload[] } | undefined,
): Promise<{ wait: TurnEngineResult | null; snapshot: typeof options.snapshot; steeringMarkerState: typeof markerState }> {
  let snapshot = initial
  let steeringMarkerState = markerState
  const completedToolResults: TurnEngineToolResult[] = []
  for (const call of output.toolCalls) {
    assertExecutionAlive(options, signal)
    if (seen.has(call.id)) {
      throw new TurnEngineError("invalid_output", `Tool call ${call.id} was repeated in the Turn`)
    }
    seen.add(call.id)
    const replayed = findToolObservation(snapshot, call.id)
    if (replayed) {
      if (replayed.toolName !== call.name || stableJson(replayed.input) !== stableJson(call.arguments)) {
        throw new TurnEngineError("invalid_output", `Tool call ${call.id} does not match its persisted replay record`)
      }
      if (call.name === "agent.goal.update") {
        const persisted = findToolResultObservation(snapshot, call.id)
        if (persisted?.status === "completed") {
          const revision = parseGoalRevisionOutput(persisted.output)
          if (!revision) throw new TurnEngineError("invalid_output", "Goal update returned an invalid persisted receipt")
          const projection = goalRevisionObservation(revision)
          const hasProjection = snapshot.toolObservations.some(observation => observation.id === projection.id)
          const obligation = replayReplanObligation(options, snapshot, steeringMarkerState, revision, "goal") ?? activeReplanObligation(options, snapshot)
          if (hasAcceptedMarkerForRevision(options, steeringMarkerState, revision, "goal") && !obligation) throw new TurnEngineError("invalid_output", "Accepted goal replay cannot identify its prior replan obligation")
          assertAcceptedGoalRevision(revision, obligation)
          if (!hasProjection || obligation) steeringMarkerState = await appendAcceptedRevision(options, writer, call.id, "goal.revision", revision, obligation, steeringMarkerState, step.id, !hasProjection)
          const currentGoal = options.goalRef?.get()
          if (!currentGoal || currentGoal.revision <= revision.goalRevision) {
            options.goalRef?.update(revision.goalContract)
            snapshot = {
              ...snapshot,
              goal: { id: `turn-goal:${options.identity.turnId}`, content: revision.goalContract.objective },
              toolObservations: hasProjection ? snapshot.toolObservations : [...snapshot.toolObservations, projection],
            }
          }
        }
      }
      if (call.name === "agent.plan.propose") {
        const persistedResults = snapshot.toolObservations.filter(observation => {
          const content = observation.content
          return content !== null && typeof content === "object" && !Array.isArray(content) && "toolCallId" in content && content.toolCallId === call.id && "toolName" in content && content.toolName === call.name
        })
        if (persistedResults.length > 1) throw new TurnEngineError("invalid_output", "Plan proposal replay has duplicate persisted results")
        const persisted = findToolResultObservation(snapshot, call.id)
        if (!persisted) throw new TurnEngineError("invalid_output", "Plan proposal replay is missing a persisted result")
        if (persisted.status === "failed" || persisted.status === "cancelled") continue
        if (persisted.status !== "completed") throw new TurnEngineError("invalid_output", "Plan proposal replay has an unknown persisted result status")
        const revision = parsePlanRevisionReceipt(persisted.output, call.id, { requireProposalHash: true })
        if (!revision) throw new TurnEngineError("invalid_output", "Plan proposal returned an invalid persisted receipt")
        const currentGoal = options.goalRef?.get()
        if (currentGoal && revision.goalRevision !== currentGoal.revision) throw new TurnEngineError("invalid_output", "Plan proposal replay does not match the current goal revision")
        const projection = planRevisionObservation(revision)
        const existingProjection = snapshot.toolObservations.find(observation => observation.id === projection.id)
        if (existingProjection && stableJson(existingProjection.content) !== stableJson(projection.content)) throw new TurnEngineError("invalid_output", "Plan proposal replay has a conflicting revision projection")
        const hasProjection = existingProjection !== undefined
        const obligation = replayReplanObligation(options, snapshot, steeringMarkerState, revision, "plan") ?? activeReplanObligation(options, snapshot)
        if (hasAcceptedMarkerForRevision(options, steeringMarkerState, revision, "plan") && !obligation) throw new TurnEngineError("invalid_output", "Accepted plan replay cannot identify its prior replan obligation")
        assertAcceptedPlanRevision(revision, obligation)
        if (!hasProjection || obligation) steeringMarkerState = await appendAcceptedRevision(options, writer, call.id, "plan.revision", revision, obligation, steeringMarkerState, step.id, !hasProjection)
        try {
          options.recoveryDispatcher?.recover({ goalRevision: revision.goalRevision, planRevision: revision.planRevision, basedOnPlanRevision: revision.basedOnPlanRevision, ...(revision.proposalHash === undefined ? {} : { proposalHash: revision.proposalHash }) })
        } catch {
          throw new TurnEngineError("invalid_output", "Plan proposal replay recovery failed closed")
        }
        if (!hasProjection) snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, projection] }
        if (options.executePlan) {
          const replayedResult: TurnEngineToolResult = { id: call.id, toolName: call.name, toolVersion: "1", status: "completed", output: persisted.output, errorCode: null }
          const plan = await executePlanHook(options, step, call, replayedResult, [replayedResult], snapshot, signal, true)
          if (plan.observations.some(observation => {
            const content = observation.content
            return content !== null && typeof content === "object" && !Array.isArray(content) && "kind" in content && content.kind === "plan_error"
          })) throw new TurnEngineError("invalid_output", "Replayed plan execution failed validation")
          await writer.appendBatch(plan.observations.map(observation => ({
            type: "plan.observation", correlationId: call.id, itemId: null,
            payload: { planCallId: call.id, observationId: observation.id, content: observation.content },
            key: `plan-observation:${call.id}:${observation.id}`,
          })))
          if (plan.observations.length > 0) snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, ...plan.observations] }
          if (plan.wait) return { wait: plan.wait, snapshot, steeringMarkerState }
        }
      }
      continue
    }
    const goalBeforeExecution = call.name === "agent.goal.update" ? options.goalRef?.get() : undefined
    const restoreGoalBeforePersistence = (): void => { if (goalBeforeExecution) options.goalRef?.update(goalBeforeExecution) }
    let result: TurnEngineToolResult
    try {
      result = await executeToolWithItems(options, writer, step, call, now)
      assertExecutionAlive(options, signal)
    } catch (error: unknown) {
      restoreGoalBeforePersistence()
      throw error
    }
    if (call.name === "agent.goal.update" && result.status !== "completed") restoreGoalBeforePersistence()
    if (result.status === "failed" && result.errorCode === "policy_requires_approval") {
      return { wait: { status: "waiting_for_approval", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot, steeringMarkerState }
    }
    if (result.status === "failed" && (result.errorCode === "policy_requires_user_input" || result.errorCode === "gmail_oauth_required")) {
      return { wait: { status: "waiting_for_user", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot, steeringMarkerState }
    }
    snapshot = {
      ...snapshot,
      toolObservations: [...snapshot.toolObservations, {
        id: `tool-result:${call.id}`,
        content: toRepositoryJson({ toolCallId: call.id, toolName: call.name, input: call.arguments, status: result.status, output: result.output ?? null, errorCode: result.errorCode }),
      }],
    }
    if (result.status === "completed") {
      completedToolResults.push(result)
      if (call.name === "agent.plan.propose") {
        const revision = parsePlanRevisionReceipt(result.output, call.id, { requireProposalHash: true })
        const obligation = activeReplanObligation(options, snapshot)
        if (!revision && obligation) throw new TurnEngineError("invalid_output", "Plan proposal did not return an accepted revision")
        if (revision) {
          assertAcceptedPlanRevision(revision, obligation)
          steeringMarkerState = await appendAcceptedRevision(options, writer, call.id, "plan.revision", revision, obligation, steeringMarkerState, step.id)
          const projection = planRevisionObservation(revision)
          if (!snapshot.toolObservations.some(observation => observation.id === projection.id)) snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, projection] }
        }
      }
      if (call.name === "agent.plan.propose" && options.executePlan) {
        const plan = await executePlanHook(options, step, call, result, completedToolResults, snapshot, signal, false)
        await writer.appendBatch(plan.observations.map(observation => ({
          type: "plan.observation", correlationId: call.id, itemId: null,
          payload: { planCallId: call.id, observationId: observation.id, content: observation.content },
          key: `plan-observation:${call.id}:${observation.id}`,
        })))
        if (plan.observations.length > 0) snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, ...plan.observations] }
        if (plan.wait) return { wait: plan.wait, snapshot, steeringMarkerState }
      }
      if (call.name === "agent.goal.update") {
        try {
          const revision = parseGoalRevisionOutput(result.output)
          if (!revision) throw new TurnEngineError("invalid_output", "Goal update returned an invalid receipt")
          const obligation = activeReplanObligationForGoalRevision(snapshot, revision.basedOnGoalRevision)
          assertAcceptedGoalRevision(revision, obligation)
          steeringMarkerState = await appendAcceptedRevision(options, writer, call.id, "goal.revision", revision, obligation, steeringMarkerState, step.id)
          options.goalRef?.update(revision.goalContract)
          const projection = goalRevisionObservation(revision)
          snapshot = {
            ...snapshot,
            goal: { id: `turn-goal:${options.identity.turnId}`, content: revision.goalContract.objective },
            toolObservations: snapshot.toolObservations.some(observation => observation.id === projection.id) ? snapshot.toolObservations : [...snapshot.toolObservations, projection],
          }
        } catch (error: unknown) {
          restoreGoalBeforePersistence()
          throw error
        }
      }
    }
    const dependencyWait = result.status === "completed" ? dependencyWaitReceipt(result.output) : null
    if (dependencyWait) {
      return { wait: { status: "waiting_for_dependency", waitId: dependencyWait.waitId, stepCount: 0, toolCallCount: 0 }, snapshot, steeringMarkerState }
    }
  }
  return { wait: null, snapshot, steeringMarkerState }
}

function assertAcceptedPlanRevision(revision: PlanRevisionReceipt, obligation: ReplanObligation | undefined): void {
  if (!obligation) return
  if (revision.goalRevision !== obligation.goalRevision || revision.planRevision !== obligation.planRevision + 1 || revision.basedOnPlanRevision !== obligation.planRevision) {
    throw new TurnEngineError("invalid_output", "Accepted plan revision does not release the active replan obligation")
  }
}

function assertAcceptedGoalRevision(revision: GoalRevisionReceipt, obligation: ReplanObligation | undefined): void {
  if (!obligation) return
  if (revision.goalRevision !== obligation.goalRevision + 1 || revision.basedOnGoalRevision !== obligation.goalRevision) {
    throw new TurnEngineError("invalid_output", "Accepted goal revision does not release the active replan obligation")
  }
}

function hasAcceptedMarkerForRevision(options: TurnExecutionOptions, state: { readonly active: readonly SteeringMarkerPayload[] } | undefined, revision: PlanRevisionReceipt | GoalRevisionReceipt, kind: "plan" | "goal"): boolean {
  const goalRevision = kind === "plan" ? (revision as PlanRevisionReceipt).goalRevision : (revision as GoalRevisionReceipt).basedOnGoalRevision
  const planRevision = kind === "plan" ? (revision as PlanRevisionReceipt).basedOnPlanRevision : undefined
  return (state?.active ?? []).some(marker => marker.taskId === options.identity.taskId && marker.obligationId !== null
    && marker.planRevision !== null && marker.goalRevision === goalRevision && (kind === "goal" || marker.planRevision === planRevision))
}

function replayReplanObligation(
  options: TurnExecutionOptions,
  snapshot: typeof options.snapshot,
  state: { readonly active: readonly SteeringMarkerPayload[] } | undefined,
  revision: PlanRevisionReceipt | GoalRevisionReceipt,
  kind: "plan" | "goal",
): ReplanObligation | undefined {
  const goalRevision = kind === "plan" ? (revision as PlanRevisionReceipt).goalRevision : (revision as GoalRevisionReceipt).basedOnGoalRevision
  const planRevision = kind === "plan" ? (revision as PlanRevisionReceipt).basedOnPlanRevision : undefined
  const candidates = (state?.active ?? []).filter(marker => marker.taskId === options.identity.taskId && marker.obligationId !== null
    && marker.planRevision !== null && marker.goalRevision === goalRevision && (kind === "goal" || marker.planRevision === planRevision))
  if (candidates.length === 0) return undefined
  const target = candidates[0]!
  if (target.planRevision === null) throw new TurnEngineError("invalid_output", "Accepted replay marker has no prior plan revision")
  if (candidates.some(marker => marker.obligationId !== target.obligationId)) throw new TurnEngineError("invalid_output", "Accepted replay markers identify conflicting obligations")
  const full = deriveReplanObligation({ observations: snapshot.toolObservations, expectedGoalRevision: target.goalRevision })
  if (full.kind === "invalid") throw new TurnEngineError("invalid_output", "Accepted replay has invalid prior replan evidence")
  const futureCalls = new Set<string>()
  for (const observation of snapshot.toolObservations) {
    if (!observation.id.startsWith("plan-revision:")) continue
    const content = observation.content
    if (!content || typeof content !== "object" || Array.isArray(content) || !("kind" in content) || content.kind !== "plan_revision" || !("planRevision" in content) || typeof content.planRevision !== "number" || content.planRevision <= target.planRevision || !("planCallId" in content) || typeof content.planCallId !== "string") continue
    futureCalls.add(content.planCallId)
  }
  const prior = snapshot.toolObservations.filter(observation => {
    const futureProjection = observation.id.startsWith("plan-revision:") && futureCalls.has(observation.id.slice("plan-revision:".length))
    const futureCommand = [...futureCalls].some(callId => observation.id.startsWith(`plan-result:${callId}:`) || observation.id.startsWith(`plan-control:${callId}:`))
    return !futureProjection && !futureCommand
  })
  const recovered = deriveReplanObligation({ observations: prior, expectedGoalRevision: target.goalRevision })
  if (recovered.kind === "invalid") throw new TurnEngineError("invalid_output", "Accepted replay prior obligation is invalid")
  if (recovered.kind !== "active" || recovered.obligation.id !== target.obligationId || recovered.obligation.planRevision !== target.planRevision) throw new TurnEngineError("invalid_output", "Accepted replay prior obligation is unavailable")
  return recovered.obligation
}

async function appendAcceptedRevision(
  options: TurnExecutionOptions,
  writer: TurnExecutionEventWriter,
  callId: string,
  type: "goal.revision" | "plan.revision",
  revision: unknown,
  obligation: ReplanObligation | undefined,
  markerState: { readonly active: readonly SteeringMarkerPayload[] } | undefined,
  stepId: string,
  includeRevision = true,
): Promise<{ readonly active: readonly SteeringMarkerPayload[] } | undefined> {
  if (!obligation) {
    if (!includeRevision) return markerState
    await writer.append(type, callId, null, revision, `${type === "goal.revision" ? "goal" : "plan"}-revision:${callId}`)
    return markerState
  }
  const markers = appliedSteeringMarkerEntries({
    markers: markerState?.active ?? [], stepId,
    context: { sessionId: options.identity.sessionId, turnId: options.identity.turnId, taskId: options.identity.taskId, obligationId: obligation.id, goalRevision: obligation.goalRevision, planRevision: obligation.planRevision },
  })
  const entries = [
    ...(includeRevision ? [{ type, correlationId: callId, itemId: null, payload: revision, key: `${type === "goal.revision" ? "goal" : "plan"}-revision:${callId}` }] : []),
    ...markers.map(marker => ({ type: STEERING_MARKER_EVENT_TYPE, correlationId: callId, itemId: null, payload: marker.payload, key: marker.key, actor: "system" as const })),
  ]
  if (entries.length === 0) return markerState
  await writer.appendBatch(entries)
  if (markers.length === 0 || !markerState) return markerState
  const applied = new Set(markers.map(marker => marker.payload.idempotencyKey))
  return { active: markerState.active.filter(marker => !applied.has(marker.idempotencyKey)) }
}

type PlanHookResult = {
  readonly observations: readonly { readonly id: string; readonly content: ReturnType<typeof toRepositoryJson> }[]
  readonly wait: TurnEngineResult | null
}

async function executePlanHook(
  options: TurnExecutionOptions,
  step: TurnEngineStep,
  call: TurnEngineToolCall,
  result: TurnEngineToolResult,
  completedToolResults: readonly TurnEngineToolResult[],
  snapshot: typeof options.snapshot,
  signal: AbortSignal,
  replayed: boolean,
): Promise<PlanHookResult> {
  let value: Awaited<ReturnType<NonNullable<TurnExecutionOptions["executePlan"]>>>
  try {
    value = await options.executePlan!({
      identity: options.identity, scope: options.scope, sessionId: options.identity.sessionId, turnId: options.identity.turnId,
      stepId: step.id, signal, call, result, completedToolResults: [...completedToolResults], replayed, snapshot,
    })
  } catch {
    throw new TurnEngineError("invalid_output", "Plan execution hook failed")
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.observations) || value.observations.length > 8) throw new TurnEngineError("invalid_output", "Plan execution hook returned invalid observations")
  const usedIds = new Set(snapshot.toolObservations.map(observation => observation.id))
  usedIds.add(`tool-result:${call.id}`)
  const observations: Array<{ readonly id: string; readonly content: ReturnType<typeof toRepositoryJson> }> = []
  for (const observation of value.observations) {
    if (!observation || typeof observation !== "object" || Array.isArray(observation) || typeof observation.id !== "string" || observation.id.trim().length === 0 || observation.id.length > 256 || usedIds.has(observation.id)) throw new TurnEngineError("invalid_output", "Plan execution hook returned an invalid observation id")
    const id = observation.id.trim()
    if (usedIds.has(id)) throw new TurnEngineError("invalid_output", "Plan execution hook returned a duplicate observation id")
    let content: ReturnType<typeof toRepositoryJson>
    try {
      content = toRepositoryJson(observation.content)
      const serialized = JSON.stringify(content)
      if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > PLAN_OBSERVATION_MAX_BYTES) throw new Error("observation_too_large")
    } catch { throw new TurnEngineError("invalid_output", "Plan execution hook returned invalid observation content") }
    usedIds.add(id)
    observations.push({ id, content })
  }
  let wait: TurnEngineResult | null = null
  if (value.wait !== undefined) {
    if (!value.wait || typeof value.wait !== "object" || Array.isArray(value.wait) || !["waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(value.wait.status)) throw new TurnEngineError("invalid_output", "Plan execution hook returned an invalid wait")
    if (value.wait.waitId !== undefined && (typeof value.wait.waitId !== "string" || value.wait.waitId.trim().length === 0 || value.wait.waitId.length > 256)) throw new TurnEngineError("invalid_output", "Plan execution hook returned an invalid wait id")
    if (value.wait.status === "waiting_for_dependency" && (typeof value.wait.waitId !== "string" || value.wait.waitId.trim().length === 0)) throw new TurnEngineError("invalid_output", "Dependency waits require a wait id")
    if (value.wait.errorCode !== undefined && (typeof value.wait.errorCode !== "string" || value.wait.errorCode.trim().length === 0 || value.wait.errorCode.length > 256)) throw new TurnEngineError("invalid_output", "Plan execution hook returned an invalid wait code")
    const question = value.wait.question === undefined ? undefined : parseQuestionWait(value.wait.question, options.identity.turnId)
    if (value.wait.question !== undefined && (!question || value.wait.status !== "waiting_for_user" || value.wait.waitId !== question.questionId)) throw new TurnEngineError("invalid_output", "Plan execution hook returned an invalid question wait")
    wait = { status: value.wait.status, stepCount: 0, toolCallCount: 0, ...(value.wait.waitId ? { waitId: value.wait.waitId } : {}), ...(value.wait.errorCode ? { errorCode: value.wait.errorCode } : {}), ...(question ? { question } : {}) }
  }
  return { observations, wait }
}

type DependencyWaitReceipt = { readonly waitId: string; readonly deadlineAt: string; readonly matchedTaskIds: readonly string[] }

function dependencyWaitReceipt(value: unknown): DependencyWaitReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.status !== "waiting" || typeof record.waitId !== "string" || record.waitId.trim().length === 0 || typeof record.deadlineAt !== "string" || record.deadlineAt.trim().length === 0 || !Array.isArray(record.matchedTaskIds)) return null
  if (!record.matchedTaskIds.every(item => typeof item === "string" && item.trim().length > 0)) return null
  return { waitId: record.waitId, deadlineAt: record.deadlineAt, matchedTaskIds: record.matchedTaskIds }
}

function parseQuestionWait(value: unknown, expectedTurnId: string): TurnEngineQuestionWait | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  if (!isQuestionText(row.turnId, 256) || row.turnId !== expectedTurnId || !isQuestionText(row.questionId, 256) || !isQuestionText(row.toolCallId, 256)
    || !isQuestionText(row.question, QUESTION_MAX_TEXT_BYTES)
    || !isQuestionText(row.planCallId, 256) || !isQuestionText(row.localId, 128)
    || !Number.isSafeInteger(row.goalRevision) || Number(row.goalRevision) < 1 || !Number.isSafeInteger(row.planRevision) || Number(row.planRevision) < 1
    || !parseQuestionOptions(row.options)) return null
  if (row.questionId !== canonicalQuestionId(expectedTurnId, row.planCallId, Number(row.planRevision), row.localId)) return null
  const options = parseQuestionOptions(row.options)
  if (!options) return null
  return { turnId: expectedTurnId, questionId: row.questionId, toolCallId: row.toolCallId, question: row.question, options, planCallId: row.planCallId, localId: row.localId, goalRevision: Number(row.goalRevision), planRevision: Number(row.planRevision) }
}
