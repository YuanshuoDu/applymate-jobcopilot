import type { ModelContinuation } from "@jobcopilot/agent-model"
import { createHash } from "node:crypto"
import { createTurnBudgetLedger, type TurnBudgetLimits } from "../budget.js"
import { createProgressDetector, progressCheckpointFromStepContext } from "../progress.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runAdmittedModelStep } from "./admitted-model-step.js"
import { normalizeProjectedToolCallIds, projectChildToolCallIdsForModelContext } from "./turn-tool-call-id-projection.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import { TurnEngineError, toRepositoryJson, type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import { publishCommentary, publishReasoningSummary, TurnExecutionEventWriter } from "./turn-execution-events.js"
import { READ_TASK_GRAPH_DENIAL_CHECKPOINT, RESET_NATIVE_SEMANTIC_PROGRESS, type TurnExecutionOptions } from "./turn-execution-types.js"
import { assertExecutionAlive, assertModelAllowance, makeExecutionId, resumedBudgetLimits, updateExecutionStep, withRemainingTurnStepBudget } from "./turn-engine-helpers.js"
import { buildCognitiveActionAgenda, excludeUnconsumedRootReferenceFromAgenda } from "./cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE, cognitiveAgendaReceiptIdempotencyKey } from "./cognitive-agenda-receipt.js"
import { executeTools, hasFreshSteering, recoverPersistedToolCalls, rememberSteeringMarkers } from "./turn-execution-tools.js"
import { stopForRepeatedTaskGraphDenial } from "./turn-execution-final-candidate.js"
import { nativeQuestionCallId, recoverPendingNativeQuestion } from "./turn-execution-question.js"
import { hasNewlyAcceptedInput } from "../context/step-context-support.js"
import { handoffRecoveredArchivedWait } from "./turn-execution-wait.js"
import { createTaskGraphDenialProgressTracker } from "./task-graph-denial-progress.js"
import { takeRecoveredScheduledPipelineCandidate } from "../subagents/scheduled-pipeline-candidate-store.js"
import { prepareTurnFinalAnswerEvidenceRequest, resolveTurnFinalAnswerMarkers } from "./turn-execution-evidence.js"
import { completeTurnExecutionFinalAnswer, replayScheduledFinalAnswer } from "./turn-execution-final-answer.js"
import { scheduledPipelineRecoveryStepMarker, withScheduledPipelineRecoveryStepProfile } from "../subagents/scheduled-pipeline-recovery-step.js"
import { handleTurnExecutionStepError, matchedTaskGraphDenialCheckpoint, terminalizeTurnExecutionError, withTaskGraphDenialCheckpoint } from "./turn-engine-no-progress-terminalization.js"
const DEFAULT_MAX_STEPS = 32
export async function runTurnExecutionLoop(options: TurnExecutionOptions): Promise<TurnEngineResult> {
  const signal = options.signal ?? new AbortController().signal, now = options.now ?? (() => new Date())
  const writer = new TurnExecutionEventWriter({ ...options, signal, now })
  const baseBudget: TurnBudgetLimits = { ...options.budget, maxSteps: options.budget?.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS }
  const budget = createTurnBudgetLedger(resumedBudgetLimits(baseBudget, options.resume) ?? {})
  const executionOptions = withRemainingTurnStepBudget(options, budget)
  const progress = createProgressDetector(options.noProgressRepeatLimit ?? 2), denialProgress = createTaskGraphDenialProgressTracker(options.identity.kind === "turn" && options.identity.taskId === options.identity.rootTaskId ? options.resume?.taskGraphDenialProgress : undefined)
  let snapshot = options.snapshot
  let inputThroughSequence = options.resume?.inputThroughSequence ?? 0n
  let consumedInputIds: readonly string[] = options.resume?.consumedInputIds ?? []
  let steps = options.resume?.stepCount ?? 0
  let toolCalls = options.resume?.toolCallCount ?? 0
  let continuation: ModelContinuation | undefined
  let recoveredCandidate = options.recoveredFinalCandidate
  let recoveredScheduledCandidate: ReturnType<typeof takeRecoveredScheduledPipelineCandidate> = undefined
  if (options.identity.kind === "turn" && options.identity.taskId === options.identity.rootTaskId && recoveredCandidate !== undefined) {
    recoveredScheduledCandidate = takeRecoveredScheduledPipelineCandidate({ owner: options.identity, candidateText: recoveredCandidate })
  }
  let steeringMarkerState = options.steeringMarkerState
  const seenCallIds = new Set<string>()
  let lastStep: TurnEngineStep | null = null, closedSteps = new Set<string>(), receiptClosedSteps = new Set<string>()
  try {
    await writer.append(
      "turn.started", options.identity.turnId, null,
      { goal: options.goal, taskId: options.identity.taskId, rootTaskId: options.identity.rootTaskId },
      "turn-started",
    )
    if (options.recoveredWaitControl) {
      const recoveredWait = await handoffRecoveredArchivedWait(options, writer, options.recoveredWaitControl, { stepCount: steps, toolCallCount: toolCalls }, now)
      if (recoveredWait) return recoveredWait
    }
    let recoveredToolObservations: Awaited<ReturnType<typeof recoverPersistedToolCalls>>
    try {
      recoveredToolObservations = await recoverPersistedToolCalls(executionOptions, writer, now)
    } catch (error: unknown) {
      const replayStepIds = discoveryReplayOverflowStepIds(error)
      for (const stepId of replayStepIds) {
        try {
          await handleTurnExecutionStepError({ error, options, writer, step: { id: stepId, ordinal: Math.max(0, (options.resume?.nextOrdinal ?? 1) - 1) },
            stepOutput: null, questionIntentCallId: null, executionOptions, signal, now, closedSteps, receiptClosedSteps })
        } catch (stepError: unknown) {
          if (stepError !== error) throw stepError
        }
      }
      throw error
    }
    if (recoveredToolObservations.length > 0) snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, ...recoveredToolObservations] }
    const recoveredQuestion = await recoverPendingNativeQuestion(executionOptions, now, steps, toolCalls)
    if (recoveredQuestion) return recoveredQuestion
    if (recoveredScheduledCandidate && !options.resume) {
      throw new TurnEngineError("persistence_conflict", "Scheduled candidate recovery does not match the next durable step")
    }
    for (let ordinal = options.resume?.nextOrdinal ?? 0; ; ordinal += 1) {
      assertExecutionAlive(options, signal)
      const replayCandidate = recoveredScheduledCandidate && ordinal === options.resume?.nextOrdinal ? recoveredScheduledCandidate : undefined
      const replayScheduled = replayCandidate !== undefined
      const tail = replayCandidate?.recoveryTail
      const existingRecovery = tail?.status === "streaming" ? tail : undefined
      const recoveryStepId = replayCandidate ? existingRecovery?.marker.recoveryStepId
        ?? makeExecutionId(options, `scheduled-recovery:${createHash("sha256").update(replayCandidate.recoverySource.sourceEventId, "utf8").digest("hex")}:${(tail?.marker.recoveryCursor ?? 0) + 1}`) : undefined
      const recoveryMarker = replayCandidate ? existingRecovery?.marker ?? scheduledPipelineRecoveryStepMarker({
        owner: replayCandidate.recoverySource.owner, source: replayCandidate.recoverySource, recoveryStepId: recoveryStepId!,
        recoveryCursor: (tail?.marker.recoveryCursor ?? 0) + 1, inputThroughSequence: inputThroughSequence.toString(),
        ...(tail ? { previous: tail.marker } : {}),
      }) : undefined
      if (!replayScheduled) budget.reserveStep()
      if (!replayScheduled || !existingRecovery) steps += 1
      const stepId = recoveryStepId ?? makeExecutionId(options, `step:${ordinal}`)
      const stepStartOrdinal = existingRecovery?.ordinal ?? ordinal
      const recoveryInputThroughSequence = recoveryMarker ? BigInt(recoveryMarker.inputThroughSequence) : inputThroughSequence
      const modelProfileSnapshot = recoveryMarker
        ? existingRecovery?.modelProfileSnapshot ?? withScheduledPipelineRecoveryStepProfile(toRepositoryJson(options.model.profile), recoveryMarker)
        : toRepositoryJson(options.model.profile)
      const step = await options.store.startStep({
        identity: options.identity, stepId, ordinal: stepStartOrdinal, attempt: options.identity.kind === "task" ? options.identity.attemptCount ?? 1 : 1,
        inputThroughSequence: recoveryInputThroughSequence, consumedInputIds: [], modelProfileSnapshot, now: now(),
      })
      lastStep = step
      let stepOutput: ModelStepResult | null = null
      let questionIntentCallId: string | null = null
      try {
        if (replayCandidate) {
          recoveredCandidate = undefined
          const replay = await replayScheduledFinalAnswer({ options, writer, step, candidate: replayCandidate, recoveryMarker, snapshot,
            stepCount: steps, toolCallCount: toolCalls, usage: budget.usage(), signal, now, inputThroughSequence, consumedInputIds,
            onSnapshot: next => { snapshot = next }, onOutput: output => { stepOutput = output }, onStepClosed: kind => {
              closedSteps.add(step.id)
              if (kind === "native_semantic_receipt") receiptClosedSteps.add(step.id)
            } })
          const { outcome, replayContext } = replay
          if (outcome.kind === "wait" || outcome.kind === "completed") return outcome.result
          snapshot = denialProgress.replan(snapshot, step.id, outcome.feedback, outcome.taskGraphDenialCheckpoint, replayContext)
          continuation = undefined
          continue
        }
        await writer.append("step.started", step.id, null, { stepId: step.id, ordinal: step.ordinal, taskId: options.identity.taskId }, `step-started:${step.id}`)
        if (options.identity.kind === "turn" && options.refreshTaskGraphBeforeStep) snapshot = await options.refreshTaskGraphBeforeStep(snapshot)
        const toolCallProjection = options.identity.kind === "task" && options.identity.taskId !== options.identity.rootTaskId ? projectChildToolCallIdsForModelContext(snapshot, options.identity, step.id) : undefined
        const context = await options.contextBuilder.build({
          scope: options.scope, identity: options.identity, stepId: step.id, snapshot: toolCallProjection?.snapshot ?? snapshot,
          rootInputId: ordinal === 0 ? options.rootInputId : undefined, now: now(),
          rootContextInputId: options.rootContextInputId,
          taskId: options.identity.taskId,
          steeringMarkerState,
        })
        const freshSteering = hasFreshSteering(context, consumedInputIds)
        if (hasNewlyAcceptedInput(context, consumedInputIds)) { options.completionGate?.[RESET_NATIVE_SEMANTIC_PROGRESS]?.(); denialProgress.clear() }
        const newlyObservedMarkers = context.steeringMarkerControl?.newlyObservedMarkers ?? []
        if (newlyObservedMarkers.length > 0) steeringMarkerState = rememberSteeringMarkers(steeringMarkerState, newlyObservedMarkers)
        inputThroughSequence = context.inputThroughSequence
        consumedInputIds = context.consumedInputIds
        // The model sees the durable root background, but later agenda receipts must not turn it into actionable pending input.
        const agendaContext = excludeUnconsumedRootReferenceFromAgenda(context, ordinal > 0 ? options.rootContextInputId : undefined)
        const readCheckpoint = options.completionGate?.[READ_TASK_GRAPH_DENIAL_CHECKPOINT]
        const checkpoint = await matchedTaskGraphDenialCheckpoint(denialProgress.shouldStop, context, options.identity.rootTaskId, readCheckpoint)
        if (checkpoint) {
          const terminal = await stopForRepeatedTaskGraphDenial({ options: withTaskGraphDenialCheckpoint(options, checkpoint, readCheckpoint), writer, step, context, stepCount: steps, toolCallCount: toolCalls, usage: budget.usage(), now })
          closedSteps.add(step.id); return terminal
        }
        const receipt = buildCognitiveAgendaReceipt({
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, taskId: options.identity.taskId, stepId: step.id,
          inputThroughSequence, consumedInputIds,
          agenda: buildCognitiveActionAgenda(agendaContext, { freshSteering }),
        })
        const receiptKey = cognitiveAgendaReceiptIdempotencyKey(step.id)
        if (!receipt || !receiptKey) throw new TurnEngineError("invalid_output", "Cognitive agenda receipt could not be built")
        try {
          await writer.append(COGNITIVE_AGENDA_EVENT_TYPE, step.id, null, receipt, receiptKey)
        } catch {
          throw new TurnEngineError("persistence_conflict", "Cognitive agenda receipt could not be persisted")
        }
        let request = buildModelRequest({
          context, model: options.model, tools: options.tools,
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, stepId: step.id,
          taskId: options.identity.taskId, userId: options.identity.userId, signal, continuation,
          freshSteering: options.identity.kind === "turn" && freshSteering,
          outputSchema: options.outputSchema, cognitiveAgendaReceipt: receipt, rootTaskId: options.identity.kind === "turn" ? options.identity.rootTaskId : undefined,
        })
        if (freshSteering) recoveredCandidate = undefined
        let answerEvidenceBindingMap: ReturnType<typeof prepareTurnFinalAnswerEvidenceRequest>["bindingMap"] = null
        let output: ModelStepResult
        if (recoveredCandidate !== undefined) {
          output = { text: recoveredCandidate, reasoningSummary: "", toolCalls: [], provider: "recovered", model: "recovered", finishReason: "stop", usage: null, continuation: null }
          recoveredCandidate = undefined
        } else {
          assertModelAllowance(budget.snapshot())
          const preparedRequest = prepareTurnFinalAnswerEvidenceRequest(request, snapshot, { userId: options.identity.userId,
            sessionId: options.identity.sessionId, turnId: options.identity.turnId, taskId: options.identity.taskId, stepId: step.id })
          request = preparedRequest.request; answerEvidenceBindingMap = preparedRequest.bindingMap
          const reservation = budget.reserveModel()
          output = await runAdmittedModelStep({ writer, stepId: step.id, taskId: options.identity.taskId, provider: request.provider, model: request.model, invoke: () => runModelStep(options.model, request, options.validateToolArguments), onStartDenied: () => reservation.settle({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }) })
          reservation.settle(output.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
          await writer.append("model.usage", step.id, null,
            { provider: output.provider, model: output.model, usage: output.usage, taskId: options.identity.taskId }, `model-usage:${step.id}`)
        }
        output = toolCallProjection ? { ...output, toolCalls: normalizeProjectedToolCallIds(output.toolCalls, toolCallProjection.aliasToCanonical) } : output; stepOutput = output; continuation = output.continuation ?? undefined
        await publishReasoningSummary(writer, options, step, resolveTurnFinalAnswerMarkers(output.reasoningSummary, null).text, now)
        if (output.toolCalls.length > 0) {
          const questionCallId = nativeQuestionCallId(output, options.identity)
          if (questionCallId && (!executionOptions.store.stageQuestionUsage || !executionOptions.store.cancelPausedQuestion)) throw new TurnEngineError("invalid_output", "Native question store is unavailable")
          questionIntentCallId = questionCallId
          denialProgress.clear(); progress.observe({ snapshot, toolCalls: output.toolCalls }, progressCheckpointFromStepContext(context))
          budget.reserveToolCalls(output.toolCalls.length)
          if (output.text) await publishCommentary(writer, options, step, resolveTurnFinalAnswerMarkers(output.text, null).text, now)
          let outcome: { wait: TurnEngineResult | null; snapshot: typeof options.snapshot; steeringMarkerState: typeof steeringMarkerState }
          let persistedToolCallCount = 0
          try {
            outcome = await executeTools(executionOptions, writer, step, output, snapshot, seenCallIds, signal, now, steeringMarkerState, () => { persistedToolCallCount += 1 })
          } finally {
            budget.accountToolCalls(output.toolCalls.length)
            toolCalls += persistedToolCallCount
          }
          snapshot = outcome.snapshot
          steeringMarkerState = outcome.steeringMarkerState
          if (questionIntentCallId && outcome.wait?.status === "waiting_for_user") {
            closedSteps.add(step.id)
            return { ...outcome.wait, stepCount: steps, toolCallCount: toolCalls }
          }
          // Tool results are server-owned context; do not reuse a provider cursor across this boundary.
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
          closedSteps.add(step.id)
          if (wait) {
            if (wait.status === "waiting_for_user") await options.store.waitForUser?.({ identity: options.identity, now: now() })
            return { ...wait, stepCount: steps, toolCallCount: toolCalls }
          }
          continue
        }
        const outcome = await completeTurnExecutionFinalAnswer({ options, writer, step, output, bindingMap: answerEvidenceBindingMap,
          snapshot, stepCount: steps, toolCallCount: toolCalls, usage: budget.usage(), signal, now, onStepClosed: kind => {
            closedSteps.add(step.id)
            if (kind === "native_semantic_receipt") receiptClosedSteps.add(step.id)
          } })
        if (outcome.kind === "wait" || outcome.kind === "completed") return outcome.result
        snapshot = denialProgress.replan(snapshot, step.id, outcome.feedback, outcome.taskGraphDenialCheckpoint, context); continuation = undefined; continue
      } catch (error: unknown) {
        await handleTurnExecutionStepError({ error, options, writer, step, stepOutput, questionIntentCallId, executionOptions, signal, now, closedSteps, receiptClosedSteps })
      }
    }
  } catch (error: unknown) {
    return terminalizeTurnExecutionError({ error, options, writer, signal, lastStep, stepOpen: !!lastStep && !closedSteps.has(lastStep.id),
      stepCount: steps, toolCallCount: toolCalls, usage: budget.usage(), now, inputThroughSequence, consumedInputIds })
  }
}

function discoveryReplayOverflowStepIds(error: unknown): readonly string[] {
  if (!error || typeof error !== "object" || Array.isArray(error)) return []
  const stepIds = (error as { discoveryReplayStepIds?: unknown }).discoveryReplayStepIds
  return Array.isArray(stepIds) && stepIds.every(stepId => typeof stepId === "string" && stepId.length > 0) ? stepIds : []
}
