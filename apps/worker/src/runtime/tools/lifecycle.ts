import {
  schemaVersion,
  type ToolCallItem,
  type ToolResultItem,
} from "@jobcopilot/agent-protocol"

import { sanitizeForLifecycle, type ToolResultReferenceStore } from "./redaction.js"
import type { ToolLifecyclePayload } from "./types.js"

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
  readonly references: ToolResultReferenceStore
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
    const safeInput = await sanitizeForLifecycle(input, this.options.references, this.maxEventBytes)
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
    const safeProgress = await sanitizeForLifecycle(progress, this.options.references, this.maxEventBytes)
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

  async failed(call: LifecycleCall, phase: "failed" | "cancelled", errorCode: string, detail?: unknown): Promise<void> {
    await this.result(call, phase, errorCode, detail)
  }

  private async result(call: LifecycleCall, phase: "completed" | "failed" | "cancelled", errorCode: string | null, output: unknown): Promise<unknown> {
    const timestamp = this.now()
    const safeOutput = await sanitizeForLifecycle(output ?? null, this.options.references, this.maxEventBytes)
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
}
