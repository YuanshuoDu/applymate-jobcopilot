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
import { TurnEngineError, toRepositoryJson, type TurnEngineResult, type TurnEngineStep, type TurnEngineToolCall, type TurnEngineToolResult } from "./turn-engine-types.js"
import { executeToolWithItems, publishCommentary, publishFinalResponse, publishReasoningSummary, TurnExecutionEventWriter } from "./turn-execution-events.js"
import type { TurnExecutionOptions } from "./turn-execution-types.js"
import { assertExecutionAlive, assertModelAllowance, canEmitTurnCompleted, canPersistFinalResponse, makeExecutionId, resumedBudgetLimits, totalTurnUsage, turnErrorCode, updateExecutionStep } from "./turn-engine-helpers.js"
import { parsePlanRevisionReceipt, planRevisionObservation } from "../planning/plan-revision-receipt.js"
import { goalRevisionObservation, parseGoalRevisionOutput } from "../planning/goal-revision-receipt.js"

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
): Promise<{ wait: TurnEngineResult | null; snapshot: typeof options.snapshot }> {
  let snapshot = initial
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
          if (!hasProjection) {
            await writer.append("goal.revision", call.id, null, revision, `goal-revision:${call.id}`)
          }
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
        try {
          options.recoveryDispatcher?.recover({ goalRevision: revision.goalRevision, planRevision: revision.planRevision, basedOnPlanRevision: revision.basedOnPlanRevision, ...(revision.proposalHash === undefined ? {} : { proposalHash: revision.proposalHash }) })
        } catch {
          throw new TurnEngineError("invalid_output", "Plan proposal replay recovery failed closed")
        }
        const projection = planRevisionObservation(revision)
        const existingProjection = snapshot.toolObservations.find(observation => observation.id === projection.id)
        if (existingProjection && stableJson(existingProjection.content) !== stableJson(projection.content)) throw new TurnEngineError("invalid_output", "Plan proposal replay has a conflicting revision projection")
        const hasProjection = existingProjection !== undefined
        if (!hasProjection) {
          await writer.append("plan.revision", call.id, null, revision, `plan-revision:${call.id}`)
          snapshot = { ...snapshot, toolObservations: [...snapshot.toolObservations, projection] }
        }
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
          if (plan.wait) return { wait: plan.wait, snapshot }
        }
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
    if (result.status === "completed") {
      completedToolResults.push(result)
      if (call.name === "agent.plan.propose") {
        const revision = parsePlanRevisionReceipt(result.output, call.id, { requireProposalHash: true })
        if (revision) {
          await writer.append("plan.revision", call.id, null, revision, `plan-revision:${call.id}`)
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
        if (plan.wait) return { wait: plan.wait, snapshot }
      }
      if (call.name === "agent.goal.update") {
        const revision = parseGoalRevisionOutput(result.output)
        if (!revision) throw new TurnEngineError("invalid_output", "Goal update returned an invalid receipt")
        await writer.append("goal.revision", call.id, null, revision, `goal-revision:${call.id}`)
        options.goalRef?.update(revision.goalContract)
        const projection = goalRevisionObservation(revision)
        snapshot = {
          ...snapshot,
          goal: { id: `turn-goal:${options.identity.turnId}`, content: revision.goalContract.objective },
          toolObservations: snapshot.toolObservations.some(observation => observation.id === projection.id) ? snapshot.toolObservations : [...snapshot.toolObservations, projection],
        }
      }
    }
    const dependencyWait = result.status === "completed" ? dependencyWaitReceipt(result.output) : null
    if (dependencyWait) {
      return { wait: { status: "waiting_for_dependency", waitId: dependencyWait.waitId, stepCount: 0, toolCallCount: 0 }, snapshot }
    }
  }
  return { wait: null, snapshot }
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
    wait = { status: value.wait.status, stepCount: 0, toolCallCount: 0, ...(value.wait.waitId ? { waitId: value.wait.waitId } : {}), ...(value.wait.errorCode ? { errorCode: value.wait.errorCode } : {}) }
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
