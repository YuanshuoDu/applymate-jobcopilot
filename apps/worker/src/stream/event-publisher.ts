import { randomUUID } from "node:crypto"

import type { Redis } from "ioredis"
import {
  AGENT_DELTA_STREAM_MAX_LENGTH,
  agentDeltaChannel,
  agentDeltaStream,
  agentEventChannel,
  createDeltaEnvelope,
  createDurableEnvelope,
  type AgentDeltaEnvelope,
  type AgentEventRecord,
} from "@jobcopilot/agent-protocol"

export type StreamPublisherRedis = Pick<Redis, "publish" | "xadd">

export interface AgentItemSnapshotUpdate {
  id?: string
  sessionId: string
  turnId: string
  itemId: string
  taskId: string | null
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  baseRevision: number
  revision: number
  payload: unknown
}

export async function publishAgentEvent(redis: StreamPublisherRedis, event: AgentEventRecord): Promise<void> {
  const envelope = createDurableEnvelope({
    id: event.id,
    sessionId: event.sessionId,
    turnId: event.turnId,
    itemId: event.itemId,
    taskId: event.taskId,
    type: event.type,
    actor: event.actor,
    correlationId: event.correlationId,
    causationId: event.causationId,
    idempotencyKey: event.idempotencyKey,
    sequence: event.sequence.toString(),
    payload: event.payload,
  })
  await redis.publish(agentEventChannel(event.sessionId), JSON.stringify(envelope))
}

export async function publishAgentItemSnapshot(
  redis: StreamPublisherRedis,
  update: AgentItemSnapshotUpdate,
): Promise<{ streamId: string; envelope: AgentDeltaEnvelope }> {
  return publishTransientUpdate(redis, update, "snapshot")
}

export async function publishAgentDelta(
  redis: StreamPublisherRedis,
  update: AgentItemSnapshotUpdate,
): Promise<{ streamId: string; envelope: AgentDeltaEnvelope }> {
  return publishTransientUpdate(redis, update, "delta")
}

async function publishTransientUpdate(
  redis: StreamPublisherRedis,
  update: AgentItemSnapshotUpdate,
  kind: AgentDeltaEnvelope["kind"],
): Promise<{ streamId: string; envelope: AgentDeltaEnvelope }> {
  const envelope = createDeltaEnvelope({
    id: update.id ?? randomUUID(),
    sessionId: update.sessionId,
    turnId: update.turnId,
    itemId: update.itemId,
    taskId: update.taskId,
    type: update.type,
    actor: update.actor,
    correlationId: update.correlationId,
    causationId: update.causationId,
    idempotencyKey: update.idempotencyKey,
    sequence: null,
    payload: update.payload,
    kind,
    baseRevision: update.baseRevision,
    revision: update.revision,
  })
  const streamId = await redis.xadd(
    agentDeltaStream(update.sessionId),
    "MAXLEN", "~", String(AGENT_DELTA_STREAM_MAX_LENGTH), "*",
    "payload", JSON.stringify(envelope),
  )
  if (!streamId) throw new Error("Redis did not return an agent delta stream ID")
  await redis.publish(agentDeltaChannel(update.sessionId), streamId)
  return { streamId, envelope }
}

type PendingSnapshot = AgentItemSnapshotUpdate

export interface SnapshotCoalescerOptions {
  flushIntervalMs?: number
  maxPayloadBytes?: number
  onError?: (error: unknown) => void
}

export class ItemSnapshotCoalescer {
  private readonly pending = new Map<string, PendingSnapshot>()
  private readonly flushIntervalMs: number
  private readonly maxPayloadBytes: number
  private readonly onError: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly publish: (update: AgentItemSnapshotUpdate) => Promise<unknown>,
    options: SnapshotCoalescerOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? 500
    this.maxPayloadBytes = options.maxPayloadBytes ?? 4 * 1024
    this.onError = options.onError ?? (() => undefined)
  }

  enqueue(update: AgentItemSnapshotUpdate): void {
    const previous = this.pending.get(update.itemId)
    if (previous && previous.revision >= update.revision) return
    this.pending.set(update.itemId, previous
      ? { ...update, baseRevision: previous.baseRevision }
      : update)
    if (Buffer.byteLength(JSON.stringify(update.payload), "utf8") >= this.maxPayloadBytes) {
      void this.flush().catch(this.onError)
      return
    }
    this.schedule()
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const updates = [...this.pending.values()]
    this.pending.clear()
    await Promise.all(updates.map((update) => this.publish(update)))
  }

  async close(): Promise<void> {
    await this.flush()
  }

  private schedule(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush().catch(this.onError)
    }, this.flushIntervalMs)
  }
}
