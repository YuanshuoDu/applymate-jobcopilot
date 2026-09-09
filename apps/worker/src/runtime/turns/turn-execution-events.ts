import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { randomUUID } from "node:crypto"

import { signalWasInterrupted } from "../interrupt/registry.js"
import type { FinalResponse } from "../finalizer.js"
import { toRepositoryJson, type TurnEngineItemPhase, type TurnEngineItemStatus, type TurnEngineItemType } from "./turn-engine-types.js"
import { executionId, executionKey, type ExecutionItemHandle, type TurnExecutionOptions } from "./turn-execution-types.js"
import type { TurnEngineStep, TurnEngineToolCall, TurnEngineToolResult } from "./turn-engine-types.js"

type BatchAppendEntry = { type: string; correlationId: string; itemId: string | null; payload: unknown; key: string }

export class TurnExecutionEventWriter {
  private causationId: string | null = null
  private readonly key: string

  constructor(private readonly options: TurnExecutionOptions) {
    this.key = executionKey(options.identity)
  }

  async append(type: string, correlationId: string, itemId: string | null, payload: unknown, key: string): Promise<string> {
    const id = this.id(`event:${key}`)
    const causationId = this.causationId
    const mappedType = this.options.lifecycle?.mapEventType?.(type) ?? ownerEventType(this.options.identity.kind, type)
    const event = await this.options.store.appendEvent({
      identity: this.options.identity, id, itemId, type: mappedType, correlationId, causationId,
      idempotencyKey: `${this.key}:event:${key}`, payload: toRepositoryJson(payload),
    })
    this.causationId = event.id
    await this.notify({ id: event.id, type: mappedType, itemId, correlationId, causationId, payload: toRepositoryJson(payload) })
    return event.id
  }

  async appendBatch(entries: readonly BatchAppendEntry[]): Promise<readonly string[]> {
    if (entries.length === 0) return []
    const appendEvents = this.options.store.appendEvents
    if (!appendEvents) throw new Error("plan_observation_batch_unavailable")
    let causationId = this.causationId
    const pending = entries.map(entry => {
      const id = this.id(`event:${entry.key}`)
      const mappedType = this.options.lifecycle?.mapEventType?.(entry.type) ?? ownerEventType(this.options.identity.kind, entry.type)
      const payload = toRepositoryJson(entry.payload)
      const event = { identity: this.options.identity, id, itemId: entry.itemId, type: mappedType, correlationId: entry.correlationId, causationId, idempotencyKey: `${this.key}:event:${entry.key}`, payload }
      causationId = id
      return { ...entry, id, mappedType, payload, event, causationId: event.causationId }
    })
    const saved = await appendEvents(pending.map(entry => entry.event))
    if (saved.length !== pending.length || saved.some(event => typeof event.id !== "string" || !event.id.trim())) throw new Error("plan_observation_batch_result_mismatch")
    const ids = saved.map(event => event.id)
    this.causationId = ids[ids.length - 1] ?? this.causationId
    for (let index = 0; index < pending.length; index += 1) {
      const entry = pending[index]!
      await this.notify({ id: ids[index]!, type: entry.mappedType, itemId: entry.itemId, correlationId: entry.correlationId, causationId: index === 0 ? entry.causationId : ids[index - 1]!, payload: entry.payload })
    }
    return ids
  }

  async startItem(input: { id: string; stepId: string | null; type: TurnEngineItemType; phase: TurnEngineItemPhase; content: unknown; now: Date }): Promise<ExecutionItemHandle> {
    const item = await this.options.store.createItem({ identity: this.options.identity, itemId: input.id, stepId: input.stepId, type: input.type, status: "started", phase: input.phase, content: toRepositoryJson(input.content), now: input.now })
    await this.append("item.started", input.stepId ?? this.options.identity.turnId, item.id, { itemId: item.id, type: input.type, phase: input.phase }, `item-started:${item.id}`)
    return { id: item.id, type: input.type, phase: input.phase, revision: item.revision }
  }

  async updateItem(handle: ExecutionItemHandle, status: TurnEngineItemStatus, content: unknown, now: Date, key: string): Promise<void> {
    const item = await this.options.store.updateItem({
      identity: this.options.identity, itemId: handle.id, expectedRevision: handle.revision, status, phase: handle.phase,
      content: toRepositoryJson(content), startedAt: now, completedAt: status === "completed" || status === "failed" || status === "interrupted" ? now : null, now,
    })
    handle.revision = item.revision
    await this.append(status === "completed" ? "item.completed" : "item.delta", handle.id, handle.id, { itemId: handle.id, status, content: toRepositoryJson(content) }, `${key}:${handle.id}:${handle.revision}`)
  }

  async completeItem(handle: ExecutionItemHandle, content: unknown, now: Date, key: string): Promise<void> {
    await this.updateItem(handle, "completed", content, now, key)
  }

  async failItem(handle: ExecutionItemHandle, errorCode: string, now: Date, key: string): Promise<void> {
    const item = await this.options.store.updateItem({
      identity: this.options.identity, itemId: handle.id, expectedRevision: handle.revision, status: "failed", phase: handle.phase,
      content: { errorCode }, startedAt: now, completedAt: now, now,
    })
    handle.revision = item.revision
    await this.append("item.failed", handle.id, handle.id, { itemId: handle.id, errorCode }, `${key}:${handle.id}:${handle.revision}`)
  }

  private id(prefix: string): string { return this.options.idFactory?.(executionId(this.options.identity, prefix)) ?? `${executionId(this.options.identity, prefix)}:${randomUUID()}` }
  private async notify(event: { id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null; payload: RepositoryJsonValue }): Promise<void> {
    if (this.options.subscribe) await Promise.resolve(this.options.subscribe(event)).catch(() => undefined)
  }
}

export function itemContent(text: string): RepositoryJsonValue { return { text } }

export async function executeToolWithItems(
  options: TurnExecutionOptions,
  writer: TurnExecutionEventWriter,
  step: TurnEngineStep,
  call: TurnEngineToolCall,
  now: () => Date,
): Promise<TurnEngineToolResult> {
  const callItem = await writer.startItem({
    id: itemId(options, `item:tool-call:${call.id}`), stepId: step.id, type: "tool_call", phase: null,
    content: { toolCallId: call.id, toolName: call.name, input: toRepositoryJson(call.arguments) }, now: now(),
  })
  await writer.append("tool_call.started", call.id, callItem.id, { toolCallId: call.id, toolName: call.name, taskId: options.identity.taskId }, `tool-started:${call.id}`)
  let result: TurnEngineToolResult
  try {
    result = await options.executeTool({
      scope: options.scope, sessionId: options.identity.sessionId, turnId: options.identity.turnId, stepId: step.id,
      taskId: options.identity.taskId, rootTaskId: options.identity.rootTaskId, actorRole: options.actorRole,
      signal: options.signal ?? new AbortController().signal, capabilities: options.capabilities,
      call: { id: call.id, toolName: call.name, toolVersion: "1", input: call.arguments },
    })
  } catch (error: unknown) {
    if (signalWasInterrupted(options.signal ?? new AbortController().signal)) throw error
    result = { id: call.id, toolName: call.name, toolVersion: "1", status: "failed", errorCode: "tool_execution_failed" }
  }
  await writer.completeItem(callItem, { toolCallId: call.id, toolName: call.name, status: result.status, errorCode: result.errorCode }, now(), `tool-call-completed:${call.id}`)
  await writer.append(
    result.status === "completed" ? "tool_call.completed" : "tool_call.failed", call.id, callItem.id,
    { toolCallId: call.id, toolName: call.name, status: result.status, errorCode: result.errorCode, taskId: options.identity.taskId },
    `tool-finished:${call.id}`,
  )
  const resultItem = await writer.startItem({
    id: itemId(options, `item:tool-result:${call.id}`), stepId: step.id, type: "tool_result", phase: null,
    content: { toolCallId: call.id, output: toRepositoryJson(result.output ?? null), errorCode: result.errorCode }, now: now(),
  })
  await writer.completeItem(resultItem, { toolCallId: call.id, output: toRepositoryJson(result.output ?? null), errorCode: result.errorCode }, now(), `tool-result-completed:${call.id}`)
  return result
}

export async function publishReasoningSummary(
  writer: TurnExecutionEventWriter, options: TurnExecutionOptions, step: TurnEngineStep, text: string, now: () => Date,
): Promise<void> {
  if (!text || options.publishReasoningSummary !== true) return
  const item = await writer.startItem({ id: itemId(options, `item:reasoning:${step.id}`), stepId: step.id, type: "reasoning_summary", phase: "commentary", content: { body: "" }, now: now() })
  await writer.updateItem(item, "streaming", { body: text }, now(), "reasoning-delta")
  await writer.completeItem(item, { body: text }, now(), "reasoning-completed")
}

export async function publishCommentary(
  writer: TurnExecutionEventWriter, options: TurnExecutionOptions, step: TurnEngineStep, text: string, now: () => Date,
): Promise<void> {
  const item = await writer.startItem({ id: itemId(options, `item:commentary:${step.id}`), stepId: step.id, type: "agent_message", phase: "commentary", content: itemContent(""), now: now() })
  await writer.updateItem(item, "streaming", itemContent(text), now(), "commentary-delta")
  await writer.completeItem(item, itemContent(text), now(), "commentary-completed")
}

export async function publishFinalResponse(
  writer: TurnExecutionEventWriter, options: TurnExecutionOptions, step: TurnEngineStep | null, response: FinalResponse, now: () => Date,
): Promise<ExecutionItemHandle> {
  const item = await writer.startItem({ id: itemId(options, `item:final:${step?.id ?? "turn"}`), stepId: step?.id ?? null, type: "agent_message", phase: "final_answer", content: itemContent(""), now: now() })
  await writer.completeItem(item, { text: response.response, final: toRepositoryJson(response) }, now(), "final-completed")
  return item
}

function itemId(options: TurnExecutionOptions, prefix: string): string {
  const scoped = executionId(options.identity, prefix)
  return options.idFactory?.(scoped) ?? `${scoped}:${randomUUID()}`
}

function ownerEventType(kind: TurnExecutionOptions["identity"]["kind"], type: string): string {
  if (kind === "turn" || !type.startsWith("turn.")) return type
  return `task.${type.slice("turn.".length)}`
}
