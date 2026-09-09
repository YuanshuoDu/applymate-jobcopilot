import type { ModelContinuation } from "@jobcopilot/agent-model"

import { signalWasInterrupted } from "../interrupt/registry.js"
import { BudgetExceededError, createTurnBudgetLedger, type TurnBudgetLimits } from "../budget.js"
import { finalizeTurn, serializeFinalResponse } from "../finalizer.js"
import { NoProgressError, createProgressDetector } from "../progress.js"
import { snapshotEvidence, verifyCandidateFinal } from "../verifier.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import { findToolObservation, stableJson } from "./turn-engine-replay.js"
import { TurnEngineError, toRepositoryJson, type TurnEngineResult, type TurnEngineStep, type TurnEngineToolCall } from "./turn-engine-types.js"
import { executeToolWithItems, publishCommentary, publishFinalResponse, publishReasoningSummary, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { assertExecutionAlive, assertModelAllowance, canEmitTurnCompleted, canPersistFinalResponse, makeExecutionId, resumedBudgetLimits, totalTurnUsage, turnErrorCode, updateExecutionStep } from "./turn-engine-helpers.js"

const DEFAULT_MAX_STEPS = 32

export async function runTurnExecutionLoop(options: TurnExecutionOptions): Promise<TurnEngineResult> {
  const signal = options.signal ?? new AbortController().signal
  const now = options.now ?? (() => new Date())
  const writer = new TurnExecutionEventWriter({ ...options, signal, now })
  const baseBudget: TurnBudgetLimits = {
    ...options.budget,
    maxSteps: options.budget?.maxSteps ?? options.maxSteps ?? DEFAULT_MAX_STEPS,
  }
  const budget = createTurnBudgetLedger(resumedBudgetLimits(baseBudget, options.resume) ?? {})
  const progress = createProgressDetector(options.noProgressRepeatLimit ?? 2)
  let snapshot = options.snapshot
  let inputThroughSequence = options.resume?.inputThroughSequence ?? 0n
  let consumedInputIds: readonly string[] = options.resume?.consumedInputIds ?? []
  let steps = options.resume?.stepCount ?? 0
  let toolCalls = options.resume?.toolCallCount ?? 0
  let continuation: ModelContinuation | undefined
  const seenCallIds = new Set<string>()
  let lastStep: TurnEngineStep | null = null
  try {
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
        identity: options.identity, stepId, ordinal, attempt, inputThroughSequence, consumedInputIds,
        modelProfileSnapshot: toRepositoryJson(options.model.profile), now: now(),
      })
      lastStep = step
      await writer.append(
        "step.started", step.id, null, { stepId: step.id, ordinal: step.ordinal, taskId: options.identity.taskId },
        `step-started:${step.id}`,
      )
      let stepOutput: ModelStepResult | null = null
      try {
        const context = await options.contextBuilder.build({
          scope: options.scope, identity: options.identity, stepId: step.id, snapshot,
          rootInputId: ordinal === 0 ? options.rootInputId : undefined, now: now(),
        })
        inputThroughSequence = context.inputThroughSequence
        consumedInputIds = context.consumedInputIds
        const request = buildModelRequest({
          context, model: options.model, tools: options.tools,
          sessionId: options.identity.sessionId, turnId: options.identity.turnId, stepId: step.id,
          taskId: options.identity.taskId, userId: options.identity.userId, signal, continuation,
        })
          assertModelAllowance(budget.snapshot())
        const reservation = budget.reserveModel()
        const output = await runModelStep(options.model, request, options.validateToolArguments)
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
          let outcome: { wait: TurnEngineResult | null; snapshot: typeof options.snapshot }
          try {
            outcome = await executeTools(options, writer, step, output, snapshot, seenCallIds, signal, now)
          } finally {
            budget.accountToolCalls(output.toolCalls.length)
          }
          toolCalls += output.toolCalls.length
          snapshot = outcome.snapshot
          assertExecutionAlive(options, signal)
          const wait = outcome.wait
          const stepStatus = wait?.status === "waiting_for_approval" || wait?.status === "waiting_for_user" ? wait.status : "completed"
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
        const finalResponse = finalizeTurn({
          goal: options.goal, verification, terminalReason: "goal_satisfied", response: output.text,
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
        return { status: "completed", stepCount: steps, toolCallCount: toolCalls, finalItemId: finalItem.id }
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

async function executeTools(
  options: TurnExecutionOptions,
  writer: TurnExecutionEventWriter,
  step: TurnEngineStep,
  output: ModelStepResult,
  initial: typeof options.snapshot,
  seen: Set<string>,
  signal: AbortSignal,
  now: () => Date,
): Promise<{ wait: TurnEngineResult | null; snapshot: typeof options.snapshot }> {
  let snapshot = initial
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
      continue
    }
    const result = await executeToolWithItems(options, writer, step, call, now)
    assertExecutionAlive(options, signal)
    if (result.status === "failed" && result.errorCode === "policy_requires_approval") {
      return { wait: { status: "waiting_for_approval", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
    }
    if (result.status === "failed" && (result.errorCode === "policy_requires_user_input" || result.errorCode === "gmail_oauth_required")) {
      return { wait: { status: "waiting_for_user", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
    }
    snapshot = {
      ...snapshot,
      toolObservations: [...snapshot.toolObservations, {
        id: `tool-result:${call.id}`,
        content: toRepositoryJson({ toolCallId: call.id, toolName: call.name, input: call.arguments, status: result.status, output: result.output ?? null, errorCode: result.errorCode }),
      }],
    }
  }
  return { wait: null, snapshot }
}
