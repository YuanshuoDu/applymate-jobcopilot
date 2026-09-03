import { randomUUID } from "node:crypto"
import type { ModelContinuation } from "@jobcopilot/agent-model"
import { TurnLeaseError, type TurnLease } from "./lease.js"
import { signalWasInterrupted } from "../interrupt/registry.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import { TurnEventWriter, itemContent, type TurnItemHandle } from "./turn-engine-events.js"
import { findToolObservation, stableJson } from "./turn-engine-replay.js"
import { BudgetExceededError, createTurnBudgetLedger } from "../budget.js"
import { finalizeTurn, serializeFinalResponse, type FinalResponse } from "../finalizer.js"
import { NoProgressError, createProgressDetector } from "../progress.js"
import { snapshotEvidence, verifyCandidateFinal } from "../verifier.js"
import { isTurnLeaseLoss, makeStepUpdate, turnErrorCode } from "./turn-engine-helpers.js"
import {
  toRepositoryJson,
  TurnEngineError,
  type TurnEngineOptions,
  type TurnEngineResult,
  type TurnEngineStep,
  type TurnEngineToolCall,
  type TurnEngineToolExecutor,
} from "./turn-engine-types.js"

const DEFAULT_MAX_STEPS = 32

export class TurnEngine {
  private readonly signal: AbortSignal
  private readonly now: () => Date
  private readonly makeId: (prefix: string) => string

  constructor(private readonly options: TurnEngineOptions) {
    this.signal = options.signal ?? new AbortController().signal
    this.now = options.now ?? (() => new Date())
    this.makeId = options.idFactory ?? ((prefix) => `${prefix}:${randomUUID()}`)
  }

  async run(): Promise<TurnEngineResult> {
    const writer = new TurnEventWriter(this.options)
    const budget = createTurnBudgetLedger({ ...this.options.budget, maxSteps: this.options.budget?.maxSteps ?? this.options.maxSteps ?? DEFAULT_MAX_STEPS })
    const progress = createProgressDetector(this.options.noProgressRepeatLimit ?? 2)
    let snapshot = this.options.snapshot
    let inputThroughSequence = 0n
    let consumedInputIds: readonly string[] = []
    let steps = 0
    let toolCalls = 0
    let continuation: ModelContinuation | undefined
    const seenCallIds = new Set<string>()
    let lastStep: TurnEngineStep | null = null
    try {
      await writer.append("turn.started", this.options.lease.turnId, null, { goal: this.options.goal }, "turn-started")
      for (let ordinal = 0; ; ordinal += 1) {
        this.assertAlive()
        budget.reserveStep()
        steps += 1
        const stepId = this.makeId(`step:${ordinal}`)
        const step = await this.options.store.startStep({
          lease: this.options.lease,
          stepId,
          ordinal,
          attempt: 1,
          inputThroughSequence,
          consumedInputIds,
          modelProfileSnapshot: toRepositoryJson(this.options.model.profile),
          now: this.now(),
        })
        lastStep = step
        await writer.append("step.started", step.id, null, { stepId: step.id, ordinal }, `step-started:${step.id}`)
        let stepOutput: ModelStepResult | null = null
        try {
          const context = await this.options.contextBuilder.build({
            scope: this.options.scope,
            sessionId: this.options.lease.sessionId,
            turnId: this.options.lease.turnId,
            stepId: step.id,
            snapshot,
            rootInputId: ordinal === 0 ? this.options.rootInputId : undefined,
            lease: { ownerId: this.options.lease.ownerId, leaseVersion: this.options.lease.leaseVersion, now: this.now() },
            now: this.now(),
          })
          inputThroughSequence = context.inputThroughSequence
          consumedInputIds = context.consumedInputIds
          const request = buildModelRequest({
            context,
            model: this.options.model,
            tools: this.options.tools,
            sessionId: this.options.lease.sessionId,
            turnId: this.options.lease.turnId,
            stepId: step.id,
            taskId: this.options.rootTaskId ?? this.options.lease.turnId,
            userId: this.options.scope.userId,
            signal: this.signal,
            continuation,
          })
          const reservation = budget.reserveModel()
          const output = await runModelStep(this.options.model, request, this.options.validateToolArguments)
          stepOutput = output
          reservation.settle(output.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
          continuation = output.continuation ?? undefined
          await writer.append("model.usage", step.id, null, {
            provider: output.provider,
            model: output.model,
            usage: output.usage,
          }, `model-usage:${step.id}`)
          await this.publishReasoning(writer, step, output.reasoningSummary)
          if (output.toolCalls.length > 0) {
            progress.observe({ snapshot, toolCalls: output.toolCalls })
            budget.reserveToolCalls(output.toolCalls.length)
            if (output.text) await this.publishCommentary(writer, step, output.text)
            let toolOutcome: { wait: TurnEngineResult | null; snapshot: TurnEngineOptions["snapshot"] }
            try {
              toolOutcome = await this.executeTools(writer, step, output, snapshot, seenCallIds)
              toolCalls += output.toolCalls.length
            } finally {
              budget.accountToolCalls(output.toolCalls.length)
            }
            snapshot = toolOutcome.snapshot
            const wait = toolOutcome.wait
            this.assertAlive()
            await this.options.store.updateStep({ ...makeStepUpdate(this.options.lease, step.id, output, wait?.status === "waiting_for_approval" || wait?.status === "waiting_for_user" ? wait.status : "completed", this.now()), errorCode: wait?.errorCode ?? null })
            await writer.append("step.completed", step.id, null, { stepId: step.id, status: wait?.status ?? "completed", toolCallCount: output.toolCalls.length }, `step-completed:${step.id}`)
            if (wait) {
              if (wait.status === "waiting_for_user") await this.options.store.waitForUser?.({ lease: this.options.lease, now: this.now() })
              return { ...wait, stepCount: steps, toolCallCount: toolCalls }
            }
            continue
          }

          await this.options.store.updateStep(makeStepUpdate(this.options.lease, step.id, output, "completed", this.now()))
          await writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed" }, `step-completed:${step.id}`)
          const verification = verifyCandidateFinal({
            goal: this.options.goal,
            candidate: { text: output.text, finishReason: output.finishReason },
            evidence: snapshotEvidence(snapshot), expectedEvidence: this.options.expectedEvidence,
            businessChecks: this.options.businessChecks,
          })
          if (!verification.ok) {
            await writer.append("final.rejected", step.id, null, { code: verification.code, blocker: verification.blocker, feedback: verification.feedback }, `final-rejected:${step.id}`)
            throw new TurnEngineError(verification.code, verification.blocker)
          }
          const finalResponse = finalizeTurn({ goal: this.options.goal, verification, terminalReason: "goal_satisfied", response: output.text, usage: budget.usage(), stepCount: steps, toolCallCount: toolCalls })
          const finalItem = await this.publishFinal(writer, step, finalResponse)
          await this.options.store.recordFinalResponse({ lease: this.options.lease, response: serializeFinalResponse(finalResponse), now: this.now() })
          await writer.append("turn.completed", step.id, finalItem.id, { turnId: this.options.lease.turnId, finalItemId: finalItem.id, usage: finalResponse.usage }, "turn-completed")
          return { status: "completed", stepCount: steps, toolCallCount: toolCalls, finalItemId: finalItem.id }
        } catch (error: unknown) {
          const status = signalWasInterrupted(this.signal) ? "interrupted" : "failed"
          await this.options.store.updateStep(makeStepUpdate(this.options.lease, step.id, stepOutput, status, this.now(), turnErrorCode(error))).catch(() => undefined)
          await writer.append("step.completed", step.id, null, { stepId: step.id, status, errorCode: turnErrorCode(error) }, `step-failed:${step.id}`).catch(() => undefined)
          throw error
        }
      }
    } catch (error: unknown) {
      if (signalWasInterrupted(this.signal)) {
        const code = turnErrorCode(error)
        await writer.append("turn.interrupted", this.options.lease.turnId, null, { turnId: this.options.lease.turnId, errorCode: code }, "turn-interrupted").catch(() => undefined)
        return { status: "interrupted", stepCount: steps, toolCallCount: toolCalls, errorCode: code }
      }
      if (isTurnLeaseLoss(error, this.signal)) throw error instanceof TurnLeaseError ? error : new TurnLeaseError("lease_lost", "Turn execution lease was lost")
      const code = turnErrorCode(error)
      if (error instanceof NoProgressError) await writer.append("turn.no_progress", this.options.lease.turnId, null, { reasonCode: error.reasonCode, signature: error.observation.signature, stateFingerprint: error.observation.stateFingerprint }, "turn-no-progress").catch(() => undefined)
      if (error instanceof BudgetExceededError) await writer.append("turn.budget_exhausted", this.options.lease.turnId, null, { reasonCode: error.code, metric: error.metric, limit: error.limit, attempted: error.attempted, used: error.used }, "turn-budget-exhausted").catch(() => undefined)
      const terminalReason = error instanceof BudgetExceededError ? "budget_exhausted" : error instanceof NoProgressError ? "no_progress" : code === "final_unverified" || code.startsWith("evidence_") || code === "business_precondition_failed" ? "final_unverified" : "unrecoverable_error"
      const finalResponse = finalizeTurn({ goal: this.options.goal, terminalReason, blocker: error instanceof Error ? error.message : code, usage: budget.usage(), stepCount: steps, toolCallCount: toolCalls, next: ["Review the blocker and resume the Turn"] })
      const finalItem = await this.publishFinal(writer, lastStep, finalResponse).catch(() => null)
      if (finalItem) await this.options.store.recordFinalResponse({ lease: this.options.lease, response: serializeFinalResponse(finalResponse), now: this.now() }).catch(() => undefined)
      await writer.append("turn.failed", this.options.lease.turnId, finalItem?.id ?? null, { turnId: this.options.lease.turnId, errorCode: code, finalItemId: finalItem?.id ?? null, final: finalResponse }, `turn-failed:${code}`).catch(() => undefined)
      return { status: "failed", stepCount: steps, toolCallCount: toolCalls, errorCode: code, ...(finalItem ? { finalItemId: finalItem.id } : {}) }
    }
  }

  private async executeTools(
    writer: TurnEventWriter,
    step: TurnEngineStep,
    output: ModelStepResult,
    snapshot: TurnEngineOptions["snapshot"],
    seenCallIds: Set<string>,
  ): Promise<{ wait: TurnEngineResult | null; snapshot: TurnEngineOptions["snapshot"] }> {
    for (const call of output.toolCalls) {
      this.assertAlive()
      if (seenCallIds.has(call.id)) throw new TurnEngineError("invalid_output", `Tool call ${call.id} was repeated in the Turn`)
      seenCallIds.add(call.id)
      const replayed = findToolObservation(snapshot, call.id)
      if (replayed) {
        if (replayed.toolName !== call.name || stableJson(replayed.input) !== stableJson(call.arguments)) {
          throw new TurnEngineError("invalid_output", `Tool call ${call.id} does not match its persisted replay record`)
        }
        continue
      }
      const result = await this.executeTool(writer, step, call)
      this.assertAlive()
      if (result.status === "failed" && result.errorCode === "policy_requires_approval") return { wait: { status: "waiting_for_approval", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
      if (result.status === "failed" && result.errorCode === "policy_requires_user_input") return { wait: { status: "waiting_for_user", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
      if (result.status === "failed" && result.errorCode === "gmail_oauth_required") return { wait: { status: "waiting_for_user", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
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

  private async executeTool(writer: TurnEventWriter, step: TurnEngineStep, call: TurnEngineToolCall) {
    const callItem = await writer.startItem({ id: this.makeId(`item:tool-call:${call.id}`), stepId: step.id, type: "tool_call", phase: null, content: { toolCallId: call.id, toolName: call.name, input: toRepositoryJson(call.arguments) }, now: this.now() })
    await writer.append("tool_call.started", call.id, callItem.id, { toolCallId: call.id, toolName: call.name }, `tool-started:${call.id}`)
    let result
    try {
      result = await this.options.executeTool({ scope: this.options.scope, sessionId: this.options.lease.sessionId, turnId: this.options.lease.turnId, stepId: step.id, signal: this.signal, capabilities: this.options.capabilities, call: { id: call.id, toolName: call.name, toolVersion: "1", input: call.arguments } })
    } catch (error: unknown) {
      if (signalWasInterrupted(this.signal)) throw error
      result = { id: call.id, toolName: call.name, toolVersion: "1", status: "failed" as const, errorCode: "tool_execution_failed" }
    }
    await writer.completeItem(callItem, { toolCallId: call.id, toolName: call.name, status: result.status, errorCode: result.errorCode }, this.now(), `tool-call-completed:${call.id}`)
    await writer.append(result.status === "completed" ? "tool_call.completed" : "tool_call.failed", call.id, callItem.id, { toolCallId: call.id, toolName: call.name, status: result.status, errorCode: result.errorCode }, `tool-finished:${call.id}`)
    const resultItem = await writer.startItem({ id: this.makeId(`item:tool-result:${call.id}`), stepId: step.id, type: "tool_result", phase: null, content: { toolCallId: call.id, output: toRepositoryJson(result.output ?? null), errorCode: result.errorCode }, now: this.now() })
    await writer.completeItem(resultItem, { toolCallId: call.id, output: toRepositoryJson(result.output ?? null), errorCode: result.errorCode }, this.now(), `tool-result-completed:${call.id}`)
    return result
  }

  private async publishReasoning(writer: TurnEventWriter, step: TurnEngineStep, text: string): Promise<void> {
    if (!text || this.options.publishReasoningSummary !== true) return
    const item = await writer.startItem({ id: this.makeId(`item:reasoning:${step.id}`), stepId: step.id, type: "reasoning_summary", phase: "commentary", content: { body: "" }, now: this.now() })
    await writer.updateItem(item, "streaming", { body: text }, this.now(), "reasoning-delta")
    await writer.completeItem(item, { body: text }, this.now(), "reasoning-completed")
  }

  private async publishCommentary(writer: TurnEventWriter, step: TurnEngineStep, text: string): Promise<void> {
    const item = await writer.startItem({ id: this.makeId(`item:commentary:${step.id}`), stepId: step.id, type: "agent_message", phase: "commentary", content: itemContent(""), now: this.now() })
    await writer.updateItem(item, "streaming", itemContent(text), this.now(), "commentary-delta")
    await writer.completeItem(item, itemContent(text), this.now(), "commentary-completed")
  }

  private async publishFinal(writer: TurnEventWriter, step: TurnEngineStep | null, response: FinalResponse): Promise<TurnItemHandle> {
    const stepId = step?.id ?? null
    const item = await writer.startItem({ id: this.makeId(`item:final:${stepId ?? "turn"}`), stepId, type: "agent_message", phase: "final_answer", content: itemContent(""), now: this.now() })
    await writer.completeItem(item, { text: response.response, final: toRepositoryJson(response) }, this.now(), "final-completed")
    return item
  }

  private assertAlive(): void {
    if (signalWasInterrupted(this.signal)) {
      throw this.signal.reason instanceof Error ? this.signal.reason : new Error("Turn execution was interrupted")
    }
    if (this.signal.aborted) throw new TurnLeaseError("lease_lost", "Turn execution stopped after lease loss")
  }

}
export function createTurnEngineExecutor(base: Omit<TurnEngineOptions, "lease" | "signal">) {
  return (input: { lease: TurnLease; signal: AbortSignal }): Promise<TurnEngineResult> => new TurnEngine({ ...base, ...input }).run()
}

export { createToolRouterExecutor } from "./turn-engine-helpers.js"
