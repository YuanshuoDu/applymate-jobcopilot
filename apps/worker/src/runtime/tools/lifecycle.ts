import {
  schemaVersion,
  type ToolCallItem,
  type ToolResultItem,
} from "@jobcopilot/agent-protocol"

import type { ExecutionOwner } from "../execution-owner.js"
import { MAX_TOOL_RESULT_BYTES, MAX_TOOL_RESULT_READ_BYTES, type ToolResultChunk, type ToolResultReferenceRepository } from "./tool-result-reference-types.js"
import { prepareDurableWaitOutput, prepareLifecycleValue, prepareSafeValue, prepareSubagentSpawnReceipt, prepareTaskGraphPlanReceipt, sanitizeLifecyclePreview, type PreparedLifecycleValue, type ToolResultReferenceStore } from "./redaction.js"
import { redactJobReadOutput } from "./job-read-output-redaction.js"
import { isVerifiedToolResultChunk } from "./tool-result-reference-repo.js"
import { ToolExecutionError, type ToolLifecyclePayload } from "./types.js"
import { isTaskGraphResultPageLike, prepareAgentListLifecycleInput, prepareTaskGraphResultPageOutput } from "./task-graph-result-page-redaction.js"
export type ToolLifecyclePhase = "started" | "progress" | "completed" | "failed" | "cancelled"
export interface ToolLifecycleEvent {
  readonly phase: ToolLifecyclePhase
  readonly eventType: string
  readonly item: ToolCallItem | ToolResultItem
  readonly payload: ToolLifecyclePayload
}
export interface ToolLifecycleSink {
  append(event: ToolLifecycleEvent): Promise<void>
}
export type ToolLifecycleOwnerContext = {
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly taskId?: string
  readonly rootTaskId?: string
  readonly toolCallId?: string
}
export type ToolLifecycleOwnerResolver = (context: ToolLifecycleOwnerContext) => ExecutionOwner
export class InMemoryToolLifecycleSink implements ToolLifecycleSink {
  readonly events: ToolLifecycleEvent[] = []

  async append(event: ToolLifecycleEvent): Promise<void> {
    this.events.push(event)
  }

  replay(): ToolLifecycleEvent[] {
    return this.events.map((event) => ({ ...event, item: { ...event.item }, payload: { ...event.payload } }))
  }
}

export interface ToolLifecycleOptions {
  readonly sink: ToolLifecycleSink
  /** Legacy test seam; oversized values never fall back to this store. */
  readonly references?: ToolResultReferenceStore
  readonly durableResults?: ToolResultReferenceRepository
  readonly resolveOwner?: ToolLifecycleOwnerResolver
  readonly maxEventBytes?: number
  readonly now?: () => string
}

export class ToolLifecycle {
  private readonly now: () => string
  private readonly maxEventBytes: number
  private readonly inputs = new Map<string, unknown>()
  private readonly pageCalls = new Set<string>()

  constructor(private readonly options: ToolLifecycleOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024
  }

  async started(call: LifecycleCall, input: unknown): Promise<void> {
    const timestamp = this.now()
    const listInput = call.toolName === "agent.list" ? prepareAgentListLifecycleInput(input, this.maxEventBytes) : null
    if (listInput?.pageRequest) this.pageCalls.add(call.id)
    else this.pageCalls.delete(call.id)
    const safeInput = listInput?.safeInput ?? sanitizeLifecyclePreview(input, this.maxEventBytes)
    this.inputs.set(call.id, safeInput)
    const item: ToolCallItem = {
      schemaVersion,
      id: `tool-item:${call.id}`,
      sessionId: call.sessionId,
      turnId: call.turnId,
      stepId: call.stepId,
      status: "started",
      createdAt: timestamp,
      updatedAt: timestamp,
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.toolName,
      input: safeInput,
    }
    await this.append({ phase: "started", eventType: "tool_call.started", item, payload: this.payload(call, "started", { input: safeInput }) })
  }

  async progress(call: LifecycleCall, progress: unknown): Promise<void> {
    const timestamp = this.now()
    const safeProgress = sanitizeLifecyclePreview(progress, this.maxEventBytes)
    const item: ToolCallItem = {
      schemaVersion,
      id: `tool-item:${call.id}`,
      sessionId: call.sessionId,
      turnId: call.turnId,
      stepId: call.stepId,
      status: "streaming",
      createdAt: timestamp,
      updatedAt: timestamp,
      type: "tool_call",
      toolCallId: call.id,
      toolName: call.toolName,
      input: this.inputs.get(call.id) ?? null,
    }
    await this.append({ phase: "progress", eventType: "tool_call.progress", item, payload: this.payload(call, "streaming", { progress: safeProgress }) })
  }

  async completed(call: LifecycleCall, output: unknown): Promise<unknown> {
    return this.result(call, "completed", null, output)
  }

  async failed(call: LifecycleCall, phase: "failed" | "cancelled", errorCode: string, detail?: unknown): Promise<unknown> {
    return this.result(call, phase, errorCode, detail)
  }

  private async result(call: LifecycleCall, phase: "completed" | "failed" | "cancelled", errorCode: string | null, output: unknown): Promise<unknown> {
    const timestamp = this.now()
    const pageCall = this.pageCalls.delete(call.id)
    const safeOutput = phase === "completed"
      ? await this.persistCompletedOutput(call, output ?? null, pageCall)
      : sanitizeLifecyclePreview(output ?? null, this.maxEventBytes)
    const item: ToolResultItem = {
      schemaVersion,
      id: `tool-result-item:${call.id}`,
      sessionId: call.sessionId,
      turnId: call.turnId,
      stepId: call.stepId,
      status: phase === "completed" ? "completed" : phase === "cancelled" ? "interrupted" : "failed",
      createdAt: timestamp,
      updatedAt: timestamp,
      type: "tool_result",
      toolCallId: call.id,
      output: safeOutput,
      errorCode,
    }
    await this.append({ phase, eventType: phase === "completed" ? "tool_call.completed" : "tool_call.failed", item, payload: this.payload(call, phase, { output: safeOutput, errorCode }) })
    this.inputs.delete(call.id)
    return safeOutput
  }

  private async persistCompletedOutput(call: LifecycleCall, output: unknown, pageCall: boolean): Promise<unknown> {
    let prepared: ReturnType<typeof prepareLifecycleValue>
    const nativeFollowup = call.toolName === "agent.followup" && hasNativeCoordinationEnvelope(output)
    if (call.toolName === "agent.list" && (pageCall || isTaskGraphResultPageLike(output))) {
      try { prepared = prepareTaskGraphResultPageOutput(output) }
      catch { throw new ToolExecutionError("task_graph_result_page_invalid", "TaskGraph result page is invalid") }
    } else if (call.toolName === "agent.plan") {
      try {
        prepared = prepareTaskGraphPlanReceipt(output)
      } catch {
        throw new ToolExecutionError("task_graph_receipt_invalid", "TaskGraph receipt is invalid")
      }
    } else if (call.toolName === "agent.spawn" || call.toolName === "spawn_subagent") {
      try {
        prepared = prepareSubagentSpawnReceipt(output, call)
      } catch {
        throw new ToolExecutionError("subagent_spawn_receipt_invalid", "Subagent spawn receipt is invalid")
      }
    } else if (nativeFollowup) {
      try {
        prepared = prepareSubagentSpawnReceipt(output, call)
      } catch {
        throw new ToolExecutionError("native_coordination_receipt_invalid", "Native coordination receipt is invalid")
      }
    } else if (call.toolName === "agent.wait" || call.toolName === "wait_subagents") {
      try {
        prepared = prepareDurableWaitOutput(output)
      } catch {
        throw new ToolExecutionError("durable_wait_receipt_invalid", "Durable wait receipt is invalid")
      }
    } else if (call.toolName === "jobs.search" || call.toolName === "jobs.get") {
      prepared = prepareSafeValue(redactJobReadOutput(call.toolName, output))
    } else if (call.toolName === "tool_results.read") {
      let owner: ExecutionOwner | undefined
      try { owner = this.options.resolveOwner?.({ ...call, toolCallId: call.id }) } catch { owner = undefined }
      const verified = owner && isVerifiedToolResultChunk(output, owner, call.id)
        ? prepareVerifiedToolResultChunk(output)
        : null
      prepared = verified ?? prepareLifecycleValue(output)
    } else {
      prepared = prepareLifecycleValue(output)
    }
    if (prepared.sizeBytes > MAX_TOOL_RESULT_BYTES) {
      throw new ToolExecutionError("tool_result_too_large", "Tool result exceeds the 1 MiB limit")
    }
    if (prepared.sizeBytes <= this.maxEventBytes) return prepared.safe
    if (call.toolName === "agent.plan" || call.toolName === "agent.spawn" || call.toolName === "spawn_subagent" || nativeFollowup) {
      throw new ToolExecutionError("tool_result_too_large", "Agent receipt exceeds the lifecycle event limit")
    }
    if (!this.options.durableResults || !this.options.resolveOwner) {
      throw new ToolExecutionError("tool_result_storage_unavailable", "Durable tool result storage is unavailable")
    }
    try {
      const owner = this.options.resolveOwner({ ...call, toolCallId: call.id })
      const record = await this.options.durableResults.put(owner, {
        stepId: call.stepId,
        toolCallId: call.id,
        value: prepared.safe,
      })
      return { $ref: record.id, sizeBytes: record.byteCount, sha256: record.sha256 }
    } catch (error: unknown) {
      if (error instanceof ToolExecutionError) throw error
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "tool_result_storage_failed"
      throw new ToolExecutionError(code, "Durable tool result storage failed")
    }
  }

  private async append(event: ToolLifecycleEvent): Promise<void> {
    await this.options.sink.append(event)
  }

  private payload(call: LifecycleCall, status: string, extra: Record<string, unknown>): ToolLifecyclePayload {
    return { toolCallId: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status, ...extra } as ToolLifecyclePayload
  }
}

const TOOL_RESULT_REF = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
function prepareVerifiedToolResultChunk(value: ToolResultChunk): PreparedLifecycleValue | null {
  const fields = ["ref", "sha256", "byteCount", "chunk", "nextCursor"] as const
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || !Object.isFrozen(value) || Reflect.ownKeys(value).length !== fields.length) return null
    for (const field of fields) { const descriptor = Object.getOwnPropertyDescriptor(value, field); if (!descriptor?.enumerable || !("value" in descriptor)) return null }
    if (!TOOL_RESULT_REF.test(value.ref) || !/^[0-9a-f]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteCount)
      || value.byteCount < 0 || value.byteCount > MAX_TOOL_RESULT_BYTES || typeof value.chunk !== "string"
      || Buffer.byteLength(value.chunk, "utf8") > MAX_TOOL_RESULT_READ_BYTES || Buffer.from(value.chunk, "utf8").toString("utf8") !== value.chunk
      || value.nextCursor !== null && (!/^(0|[1-9]\d*)$/.test(value.nextCursor) || Number(value.nextCursor) > value.byteCount)
      || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_TOOL_RESULT_READ_BYTES) return null
    return prepareSafeValue({ ref: value.ref, sha256: value.sha256, byteCount: value.byteCount, chunk: value.chunk, nextCursor: value.nextCursor })
  } catch { return null }
}

function hasNativeCoordinationEnvelope(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "nativeCoordination")
}

export interface LifecycleCall {
  readonly id: string
  readonly toolName: string
  readonly toolVersion: string
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly taskId?: string
  readonly rootTaskId?: string
}
