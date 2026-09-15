import {
  schemaVersion,
  type ToolCallItem,
  type ToolResultItem,
} from "@jobcopilot/agent-protocol"

import type { ExecutionOwner } from "../execution-owner.js"
import { MAX_TOOL_RESULT_BYTES, type ToolResultReferenceRepository } from "./tool-result-reference-types.js"
import { prepareLifecycleValue, sanitizeLifecyclePreview, type ToolResultReferenceStore } from "./redaction.js"
import { ToolExecutionError, type ToolLifecyclePayload } from "./types.js"

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

  constructor(private readonly options: ToolLifecycleOptions) {
    this.now = options.now ?? (() => new Date().toISOString())
    this.maxEventBytes = options.maxEventBytes ?? 8 * 1024
  }

  async started(call: LifecycleCall, input: unknown): Promise<void> {
    const timestamp = this.now()
    const safeInput = sanitizeLifecyclePreview(input, this.maxEventBytes)
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
    const safeOutput = phase === "completed"
      ? await this.persistCompletedOutput(call, output ?? null)
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

  private async persistCompletedOutput(call: LifecycleCall, output: unknown): Promise<unknown> {
    const prepared = prepareLifecycleValue(output)
    if (prepared.sizeBytes > MAX_TOOL_RESULT_BYTES) {
      throw new ToolExecutionError("tool_result_too_large", "Tool result exceeds the 1 MiB limit")
    }
    if (prepared.sizeBytes <= this.maxEventBytes) return prepared.safe
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
