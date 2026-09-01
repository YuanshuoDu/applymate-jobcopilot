import { randomUUID } from "node:crypto"
import type { ModelContinuation } from "@jobcopilot/agent-model"
import type { ToolCallRequest, ToolExecutionResult, ToolRouterContext } from "../tools/types.js"
import { TurnLeaseError, type TurnLease } from "./lease.js"
import { buildModelRequest } from "./turn-engine-messages.js"
import { runModelStep, type ModelStepResult } from "./turn-engine-model.js"
import { TurnEventWriter, itemContent, type TurnItemHandle } from "./turn-engine-events.js"
import { findToolObservation, stableJson } from "./turn-engine-replay.js"
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
    let snapshot = this.options.snapshot
    let inputThroughSequence = 0n
    let consumedInputIds: readonly string[] = []
    let steps = 0
    let toolCalls = 0
    let continuation: ModelContinuation | undefined
    const seenCallIds = new Set<string>()
    try {
      await writer.append("turn.started", this.options.lease.turnId, null, { goal: this.options.goal }, "turn-started")
      for (let ordinal = 0; ordinal < (this.options.maxSteps ?? DEFAULT_MAX_STEPS); ordinal += 1) {
        this.assertAlive()
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
        await writer.append("step.started", step.id, null, { stepId: step.id, ordinal }, `step-started:${step.id}`)
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
          const output = await runModelStep(this.options.model, request, this.options.validateToolArguments)
          continuation = output.continuation ?? undefined
          await writer.append("model.usage", step.id, null, {
            provider: output.provider,
            model: output.model,
            usage: output.usage,
          }, `model-usage:${step.id}`)
          await this.publishReasoning(writer, step, output.reasoningSummary)
          if (output.toolCalls.length > 0) {
            if (output.text) await this.publishCommentary(writer, step, output.text)
            const toolOutcome = await this.executeTools(writer, step, output, snapshot, seenCallIds)
            snapshot = toolOutcome.snapshot
            const wait = toolOutcome.wait
            toolCalls += output.toolCalls.length
            await this.options.store.updateStep({ ...stepUpdate(this.options.lease, step.id, output, wait?.status === "waiting_for_approval" || wait?.status === "waiting_for_user" ? wait.status : "completed", this.now()), errorCode: wait?.errorCode ?? null })
            await writer.append("step.completed", step.id, null, { stepId: step.id, status: wait?.status ?? "completed", toolCallCount: output.toolCalls.length }, `step-completed:${step.id}`)
            if (wait) return { ...wait, stepCount: steps, toolCallCount: toolCalls }
            continue
          }

          await this.options.store.updateStep(stepUpdate(this.options.lease, step.id, output, "completed", this.now()))
          await writer.append("step.completed", step.id, null, { stepId: step.id, status: "completed" }, `step-completed:${step.id}`)
          const finalText = verifyFinal(output)
          const finalItem = await this.publishFinal(writer, step, finalText)
          await this.options.store.recordFinalResponse({ lease: this.options.lease, response: finalText, now: this.now() })
          await writer.append("turn.completed", step.id, finalItem.id, { turnId: this.options.lease.turnId, finalItemId: finalItem.id }, "turn-completed")
          return { status: "completed", stepCount: steps, toolCallCount: toolCalls, finalItemId: finalItem.id }
        } catch (error: unknown) {
          await this.options.store.updateStep(stepUpdate(this.options.lease, step.id, null, "failed", this.now(), errorCode(error))).catch(() => undefined)
          await writer.append("step.completed", step.id, null, { stepId: step.id, status: "failed", errorCode: errorCode(error) }, `step-failed:${step.id}`).catch(() => undefined)
          throw error
        }
      }
      throw new TurnEngineError("step_limit", `Turn exceeded the ${this.options.maxSteps ?? DEFAULT_MAX_STEPS} step limit`)
    } catch (error: unknown) {
      if (this.isLeaseLoss(error)) throw error instanceof TurnLeaseError ? error : new TurnLeaseError("lease_lost", "Turn execution lease was lost")
      const code = errorCode(error)
      await writer.append("turn.failed", this.options.lease.turnId, null, { turnId: this.options.lease.turnId, errorCode: code }, `turn-failed:${code}`).catch(() => undefined)
      return { status: "failed", stepCount: steps, toolCallCount: toolCalls, errorCode: code }
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
      if (result.status === "failed" && result.errorCode === "policy_requires_approval") return { wait: { status: "waiting_for_approval", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
      if (result.status === "failed" && result.errorCode === "policy_requires_user_input") return { wait: { status: "waiting_for_user", stepCount: 0, toolCallCount: 0, errorCode: result.errorCode }, snapshot }
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
    } catch {
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

  private async publishFinal(writer: TurnEventWriter, step: TurnEngineStep, text: string): Promise<TurnItemHandle> {
    const item = await writer.startItem({ id: this.makeId(`item:final:${step.id}`), stepId: step.id, type: "agent_message", phase: "final_answer", content: itemContent(""), now: this.now() })
    await writer.completeItem(item, itemContent(text), this.now(), "final-completed")
    return item
  }

  private assertAlive(): void {
    if (this.signal.aborted) throw new TurnLeaseError("lease_lost", "Turn execution stopped after lease loss")
  }

  private isLeaseLoss(error: unknown): boolean {
    return error instanceof TurnLeaseError || this.signal.aborted
  }

}

function verifyFinal(output: ModelStepResult): string {
  if (output.finishReason !== "stop" || output.text.trim().length === 0) throw new TurnEngineError("final_unverified", "Model did not produce a verifiable final answer")
  return output.text
}

function errorCode(error: unknown): string {
  if (error instanceof TurnEngineError) return error.code
  if (error instanceof TurnLeaseError) return error.code
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code
  return "turn_execution_failed"
}

function stepUpdate(lease: TurnLease, stepId: string, output: ModelStepResult | null, status: "completed" | "failed" | "waiting_for_tool" | "waiting_for_approval" | "waiting_for_user", now: Date, errorCodeValue: string | null = null) {
  return {
    lease,
    stepId,
    status,
    finishReason: output?.finishReason ?? null,
    errorCode: errorCodeValue,
    inputTokens: output?.usage?.inputTokens ?? 0,
    outputTokens: output?.usage?.outputTokens ?? 0,
    estimatedCostUsd: output?.usage?.estimatedCostUsd ?? 0,
    now,
  }
}

export function createTurnEngineExecutor(base: Omit<TurnEngineOptions, "lease" | "signal">) {
  return (input: { lease: TurnLease; signal: AbortSignal }): Promise<TurnEngineResult> => new TurnEngine({ ...base, ...input }).run()
}

export function createToolRouterExecutor(router: {
  execute(context: ToolRouterContext, request: ToolCallRequest): Promise<ToolExecutionResult>
}): TurnEngineToolExecutor {
  return (input) => router.execute({
    scope: input.scope,
    sessionId: input.sessionId,
    turnId: input.turnId,
    stepId: input.stepId,
    signal: input.signal,
    capabilities: input.capabilities,
    actorRole: "orchestrator",
  }, input.call)
}
