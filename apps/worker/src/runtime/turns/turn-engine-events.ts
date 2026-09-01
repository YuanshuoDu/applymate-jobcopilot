import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import { randomUUID } from "node:crypto"

import {
  toRepositoryJson,
  type TurnEngineEvent,
  type TurnEngineItemPhase,
  type TurnEngineItemStatus,
  type TurnEngineItemType,
  type TurnEngineOptions,
} from "./turn-engine-types.js"

export type TurnItemHandle = {
  readonly id: string
  readonly type: TurnEngineItemType
  readonly phase: TurnEngineItemPhase
  revision: number
}

export class TurnEventWriter {
  private causationId: string | null = null

  constructor(private readonly options: TurnEngineOptions) {}

  async append(type: string, correlationId: string, itemId: string | null, payload: unknown, key: string): Promise<string> {
    const id = this.id(`event:${key}`)
    const causationId = this.causationId
    const event = await this.options.store.appendEvent({
      lease: this.options.lease,
      id,
      itemId,
      type,
      correlationId,
      causationId,
      idempotencyKey: `turn:${this.options.lease.turnId}:event:${key}`,
      payload: toRepositoryJson(payload),
    })
    this.causationId = event.id
    await this.notify({
      id: event.id,
      type,
      itemId,
      correlationId,
      causationId,
      payload: toRepositoryJson(payload),
    })
    return event.id
  }

  async startItem(input: {
    id: string
    stepId: string | null
    type: TurnEngineItemType
    phase: TurnEngineItemPhase
    content: unknown
    now: Date
  }): Promise<TurnItemHandle> {
    const item = await this.options.store.createItem({
      lease: this.options.lease,
      itemId: input.id,
      stepId: input.stepId,
      type: input.type,
      status: "started",
      phase: input.phase,
      content: toRepositoryJson(input.content),
      now: input.now,
    })
    await this.append("item.started", input.stepId ?? this.options.lease.turnId, item.id, { itemId: item.id, type: input.type, phase: input.phase }, `item-started:${item.id}`)
    return { id: item.id, type: input.type, phase: input.phase, revision: item.revision }
  }

  async updateItem(handle: TurnItemHandle, status: TurnEngineItemStatus, content: unknown, now: Date, key: string): Promise<void> {
    const item = await this.options.store.updateItem({
      lease: this.options.lease,
      itemId: handle.id,
      expectedRevision: handle.revision,
      status,
      phase: handle.phase,
      content: toRepositoryJson(content),
      startedAt: now,
      completedAt: status === "completed" || status === "failed" || status === "interrupted" ? now : null,
      now,
    })
    handle.revision = item.revision
    await this.append(status === "completed" ? "item.completed" : "item.delta", handle.id, handle.id, { itemId: handle.id, status, content: toRepositoryJson(content) }, `${key}:${handle.id}:${handle.revision}`)
  }

  async completeItem(handle: TurnItemHandle, content: unknown, now: Date, key: string): Promise<void> {
    await this.updateItem(handle, "completed", content, now, key)
  }

  async failItem(handle: TurnItemHandle, errorCode: string, now: Date, key: string): Promise<void> {
    const item = await this.options.store.updateItem({
      lease: this.options.lease,
      itemId: handle.id,
      expectedRevision: handle.revision,
      status: "failed",
      phase: handle.phase,
      content: { errorCode },
      startedAt: now,
      completedAt: now,
      now,
    })
    handle.revision = item.revision
    await this.append("item.failed", handle.id, handle.id, { itemId: handle.id, errorCode }, `${key}:${handle.id}:${handle.revision}`)
  }

  private id(prefix: string): string {
    return this.options.idFactory?.(prefix) ?? `${prefix}:${randomUUID()}`
  }

  private async notify(event: TurnEngineEvent): Promise<void> {
    if (this.options.subscribe) await Promise.resolve(this.options.subscribe(event)).catch(() => undefined)
  }
}

export function itemContent(text: string): RepositoryJsonValue {
  return { text }
}
