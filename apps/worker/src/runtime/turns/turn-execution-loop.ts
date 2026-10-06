import type { ModelContinuation } from "@jobcopilot/agent-model"
import { signalWasInterrupted } from "../interrupt/registry.js"
import { isSessionPauseRequestedError } from "../session-gate.js"
import { BudgetExceededError, createTurnBudgetLedger, type TurnBudgetLimits } from "../budget.js"
import { finalizeTurn, serializeFinalResponse } from "../finalizer.js"
import { NoProgressError, createProgressDetector } from "../progress.js"
import { snapshotEvidence, verifyCandidateFinal } from "../verifier.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runAdmittedModelStep } from "./admitted-model-step.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import { TurnEngineError, toRepositoryJson, type AtomicTurnCompletionResult, type TurnEngineResult, type TurnEngineStep } from "./turn-engine-types.js"
import { publishCommentary, publishFinalResponse, publishReasoningSummary, TurnExecutionEventWriter } from "./turn-execution-events.js"
import { executionId, type TurnExecutionOptions } from "./turn-execution-types.js"
import { assertCompletionAllowed, taskGraphGateRecovery } from "./turn-execution-completion-gate.js"
import { assertExecutionAlive, assertModelAllowance, canEmitTurnCompleted, canPersistFinalResponse, makeExecutionId, resumedBudgetLimits, totalTurnUsage, turnErrorCode, updateExecutionStep, withRemainingTurnStepBudget } from "./turn-engine-helpers.js"
import { STEERING_MARKER_EVENT_TYPE } from "../context/steering-marker.js"
import { buildCognitiveActionAgenda } from "./cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE, cognitiveAgendaReceiptIdempotencyKey } from "./cognitive-agenda-receipt.js"
import { executeTools, hasFreshSteering, recoverPersistedToolCalls, rememberSteeringMarkers } from "./turn-execution-tools.js"
const DEFAULT_MAX_STEPS = 32
function taskGraphRecoverySnapshot(snapshot: TurnExecutionOptions["snapshot"], stepId: string, feedback: string): TurnExecutionOptions["snapshot"] { return { ...snapshot, system: [...snapshot.system, { id: `task-graph-recovery:${stepId}`, content: `Durable TaskGraph verification blocked completion: ${feedback} Replan or repair the affected criteria, then verify again.` }] } }
export async function runTurnExecutionLoop(options: TurnExecutionOptions): Promise<TurnEngineResult> {
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? (() => new Date())
  const writer = new TurnExecutionEventWriter({ ...options, signal, now })
  const baseBudget: TurnBudgetLimits = { ...options.budget, maxSteps: options.budget?.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS }
  const budget = createTurnBudgetLedger(resumedBudgetLimits(baseBudget, options.resume) ?? {})
  const executionOptions = withRemainingTurnStepBudget(options, budget)
  const progress = createProgressDetector(options.noProgressRepeatLimit ?? 2)
  let snapshot = options.snapshot
  let inputThroughSequence = options.resume?.inputThroughSequence ?? 0n
  let consumedInputIds: readonly string[] = options.resume?.consumedInputIds ?? []
  let steps = options.resume?.stepCount ?? 0
  let toolCalls = options.resume?.toolCallCount ?? 0
  let continuation: ModelContinuation | undefined
  let steeringMarkerState = options.steeringMarkerState
  const seenCallIds = new Set<string>()
  let lastStep: TurnEngineStep | null = null, closedSteps = new Set<string>()
  try {
    await writer.append(
      "turn.started", options.identity.turnId, null,
      { goal: options.goal, taskId: options.identity.taskId, rootTaskId: options.identity.rootTaskId },
      "turn-started",
    )
    const recoveredToolObservations = await recoverPersistedToolCalls(executionOptions, writer, now)
    if (recoveredToolObservations.length > 0) snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, ...recoveredToolObservations] }
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
      let stepOutput: ModelStepResult | null = null
      try {
        await writer.append("step.started", step.id, null, { stepId: step.id, ordinal: step.ordinal, taskId: options.identity.taskId }, `step-started:${step.id}`)
        const context = await options.contextBuilder.build({
          scope: options.scope, identity: options.identity, stepId: step.id, snapshot,
          rootInputId: ordinal === 0 ? options.rootInputId : undefined, now: now(),
          taskId: options.identity.taskId,
          steeringMarkerState,
        })
        const freshSteering = hasFreshSteering(context, consumedInputIds)
        const newlyObservedMarkers = context.steeringMarkerControl?.newlyObservedMarkers ?? []
        if (newlyObservedMarkers.length > 0) steeringMarkerState = rememberSteeringMarkers(steeringMarkerState, newlyObservedMarkers)
        inputThroughSequence = context.inputThroughSequence
        consumedInputIds = context.consumedInputIds
        const receipt = buildCognitiveAgendaReceipt({
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, taskId: options.identity.taskId, stepId: step.id,
          inputThroughSequence, consumedInputIds,
          agenda: buildCognitiveActionAgenda(context, { freshSteering }),
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
          freshSteering,
          outputSchema: options.outputSchema,
        })
          assertModelAllowance(budget.snapshot())
        const reservation = budget.reserveModel()
        const output = await runAdmittedModelStep({ writer, stepId: step.id, taskId: options.identity.taskId, provider: request.provider, model: request.model, invoke: () => runModelStep(options.model, request, options.validateToolArguments), onStartDenied: () => reservation.settle({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }) })
        stepOutput = output; reservation.settle(output.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }); continuation = output.continuation ?? undefined
        await writer.append(
          "model.usage", step.id, null,
          { provider: output.provider, model: output.model, usage: output.usage, taskId: options.identity.taskId },
          `model-usage:${step.id}`,
        )
        await publishReasoningSummary(writer, options, step, output.reasoningSummary, now)
        if (output.toolCalls.length > 0) {
          progress.observe({ snapshot, toolCalls: output.toolCalls })
          budget.reserveToolCalls(output.toolCalls.length)
          if (output.text) await publishCommentary(writer, options, step, output.text, now)
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
        await updateExecutionStep(options, {
          stepId: step.id, status: "completed", finishReason: output.finishReason, errorCode: null,
          inputTokens: output.usage?.inputTokens ?? 0, outputTokens: output.usage?.outputTokens ?? 0,
          estimatedCostUsd: output.usage?.estimatedCostUsd ?? 0, now: now(),
        })
        await writer.append(
          "step.completed", step.id, null, { stepId: step.id, status: "completed", taskId: options.identity.taskId },
          `step-completed:${step.id}`,
        )
        closedSteps.add(step.id)
        const verification = verifyCandidateFinal({
          goal: options.goal, candidate: { text: output.text, finishReason: output.finishReason },
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
        const gateRecovery = await assertCompletionAllowed(options, writer, step, signal, now)
        if (gateRecovery) { snapshot = taskGraphRecoverySnapshot(snapshot, step.id, gateRecovery.feedback); continuation = undefined; continue }
        const finalResponse = finalizeTurn({
          goal: options.goal, verification, terminalReason: "goal_satisfied", response: output.text,
          usage: totalTurnUsage(options.resume?.usage, budget.usage()), stepCount: steps, toolCallCount: toolCalls,
        })
        if (canPersistFinalResponse(options)) {
          if (!options.store.recordFinalResponse) throw new TurnEngineError("persistence_conflict", "Atomic Turn completion is unavailable")
          const finalItemId = options.idFactory?.(executionId(options.identity, `item:final:${step.id}`)) ?? executionId(options.identity, `item:final:${step.id}`)
          let terminal: void | AtomicTurnCompletionResult
          try {
            terminal = await options.store.recordFinalResponse({
              identity: options.identity, response: serializeFinalResponse(finalResponse), now: now(),
              terminal: { stepId: step.id, finalItemId, finalContent: toRepositoryJson({ text: finalResponse.response, final: toRepositoryJson(finalResponse) }), stepCount: steps, toolCallCount: toolCalls, usage: finalResponse.usage },
            })
          } catch (error: unknown) {
            const recovery = taskGraphGateRecovery(error)
            if (!recovery) throw error
            await writer.append("final.rejected", step.id, null, { code: "business_precondition_failed", blocker: "task_graph_verification_unverified", feedback: recovery.feedback, taskId: options.identity.taskId }, `final-rejected:${step.id}:task-graph-race`)
            snapshot = taskGraphRecoverySnapshot(snapshot, step.id, recovery.feedback); continuation = undefined; continue
          }
          if (!terminal) throw new TurnEngineError("persistence_conflict", "Atomic Turn completion returned no receipt")
          for (const event of terminal.events) await Promise.resolve(options.subscribe?.(event)).catch(() => undefined)
          return { status: "completed", stepCount: steps, toolCallCount: toolCalls, finalItemId: terminal.finalItemId, finalText: output.text }
        }
        const finalItem = await publishFinalResponse(writer, options, step, finalResponse, now)
        if (canEmitTurnCompleted(options)) {
          await writer.append(
            "turn.completed", step.id, finalItem.id,
            { turnId: options.identity.turnId, taskId: options.identity.taskId, finalItemId: finalItem.id, usage: finalResponse.usage },
            "turn-completed",
          )
        }
        return { status: "completed", stepCount: steps, toolCallCount: toolCalls, finalItemId: finalItem.id, finalText: output.text }
      } catch (error: unknown) {
        if (closedSteps.has(step.id) && isSessionPauseRequestedError(error)) throw error
        const status = signalWasInterrupted(signal) || isSessionPauseRequestedError(error) ? "interrupted" : "failed"
        await updateExecutionStep(options, {
          stepId: step.id, status, finishReason: stepOutput?.finishReason ?? null, errorCode: turnErrorCode(error),
          inputTokens: stepOutput?.usage?.inputTokens ?? 0, outputTokens: stepOutput?.usage?.outputTokens ?? 0,
          estimatedCostUsd: stepOutput?.usage?.estimatedCostUsd ?? 0, now: now(),
        }).catch(() => undefined)
        await writer.append(
          "step.completed", step.id, null,
          { stepId: step.id, status, errorCode: turnErrorCode(error), taskId: options.identity.taskId },
          `step-${status === "interrupted" ? "interrupted" : "failed"}:${step.id}`,
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
    if (isSessionPauseRequestedError(error)) throw error
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
      goal: options.goal, terminalReason, blocker: error instanceof Error ? error.message : code,
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
