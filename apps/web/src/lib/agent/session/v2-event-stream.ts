import type { PrismaClient } from "@prisma/client"
import { Redis } from "ioredis"
import {
  AGENT_STREAM_SCHEMA_VERSION,
  agentDeltaStream,
  type AgentDeltaEnvelope,
  type AgentStreamEnvelope,
} from "@jobcopilot/agent-protocol"

import { BoundedStreamBuffer, type StreamFrame } from "./stream-buffer"
import { redactStreamValue } from "./stream-redaction"

const DEFAULT_DB_POLL_MS = 750
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_BUFFER_CAPACITY = 128
const DURABLE_BATCH_SIZE = 100
const DELTA_BATCH_SIZE = 64
const MAX_DELTA_ENTRY_BYTES = 128 * 1024

type DurableEventRow = {
  id: string
  sessionId: string
  turnId: string
  itemId: string | null
  taskId: string | null
  sequence: bigint
  type: string
  actor: string
  correlationId: string
  causationId: string | null
  idempotencyKey: string | null
  payload: unknown
}

export interface AgentStreamRedis {
  xread(...args: string[]): Promise<unknown>
  disconnect(): void
}

export interface V2EventStreamOptions {
  sessionId: string
  afterSequence: bigint
  signal?: AbortSignal
  dbPollMs?: number
  heartbeatMs?: number
  bufferCapacity?: number
  redisFactory?: () => AgentStreamRedis | null
}

export function parseAfterSequence(request: Request): bigint | Response {
  const url = new URL(request.url)
  const queryValue = url.searchParams.get("afterSequence")
  const headerValue = queryValue === null ? request.headers.get("last-event-id") : null
  const value = queryValue ?? headerValue
  if (value === null || value === "") return BigInt(0)
  if (!/^\d{1,39}$/.test(value)) return Response.json({ error: {
    code: "invalid_after_sequence", message: "afterSequence must be a non-negative integer", details: {},
  } }, { status: 400 })
  return BigInt(value)
}

const EVENT_SELECT = {
  id: true, sessionId: true, turnId: true, itemId: true, taskId: true, sequence: true,
  type: true, actor: true, correlationId: true, causationId: true, idempotencyKey: true, payload: true,
} as const

export function createV2EventStream(db: PrismaClient, options: V2EventStreamOptions): ReadableStream<Uint8Array> {
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const encoder = new TextEncoder()
  const buffer = new BoundedStreamBuffer(
    (droppedCount) => ({ kind: "durable", body: sseFrame("stream.overflow", null, {
      schemaVersion: AGENT_STREAM_SCHEMA_VERSION, sessionId: options.sessionId, reason: "transient_delta_dropped",
      droppedCount, snapshotRequired: true,
    }) }),
    options.bufferCapacity ?? DEFAULT_BUFFER_CAPACITY,
  )
  const onRequestAbort = () => lifetime.abort()
  if (options.signal?.aborted) lifetime.abort()
  else options.signal?.addEventListener("abort", onRequestAbort, { once: true })

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const producers = [
        durableEventLoop(db, options, buffer, signal),
        deltaLoop(options, buffer, signal),
        heartbeatLoop(options, buffer, signal),
      ]
      void pump(controller, buffer, signal, producers, options, onRequestAbort, encoder)
    },
    cancel() {
      lifetime.abort()
    },
  })
  return stream
}

async function pump(
  controller: ReadableStreamDefaultController<Uint8Array>,
  buffer: BoundedStreamBuffer,
  signal: AbortSignal,
  producers: Promise<void>[],
  options: V2EventStreamOptions,
  onRequestAbort: () => void,
  encoder: TextEncoder,
): Promise<void> {
  try {
    while (!signal.aborted) {
      const frame = await buffer.next(signal)
      if (!frame) break
      controller.enqueue(encoder.encode(frame.body))
    }
  } finally {
    options.signal?.removeEventListener("abort", onRequestAbort)
    buffer.close()
    await Promise.allSettled(producers)
    try { controller.close() } catch { /* The consumer may have cancelled the stream. */ }
  }
}

async function durableEventLoop(
  db: PrismaClient,
  options: V2EventStreamOptions,
  buffer: BoundedStreamBuffer,
  signal: AbortSignal,
): Promise<void> {
  let lastSequence = options.afterSequence
  while (!signal.aborted) {
    try {
      const rows = await db.agentEvent.findMany({
        where: { sessionId: options.sessionId, sequence: { gt: lastSequence } },
        orderBy: { sequence: "asc" }, take: DURABLE_BATCH_SIZE, select: EVENT_SELECT,
      }) as DurableEventRow[]
      for (const row of rows) {
        const sequence = BigInt(row.sequence)
        if (sequence <= lastSequence) continue
        const result = buffer.push({ kind: "durable", body: durableFrame(row) })
        if (!result.accepted) {
          buffer.close()
          return
        }
        lastSequence = sequence
      }
    } catch {
      // The next poll retries a transient database error without cancelling the Turn.
    }
    await delay(options.dbPollMs ?? DEFAULT_DB_POLL_MS, signal)
  }
}

async function deltaLoop(
  options: V2EventStreamOptions,
  buffer: BoundedStreamBuffer,
  signal: AbortSignal,
): Promise<void> {
  const redis = (options.redisFactory ?? defaultRedisFactory)()
  if (!redis) return
  try {
    let streamId = "$"
    const revisions = new Map<string, number>()
    while (!signal.aborted) {
      const result = await redis.xread(
        "COUNT", String(DELTA_BATCH_SIZE), "BLOCK", String(options.dbPollMs ?? DEFAULT_DB_POLL_MS),
        "STREAMS", agentDeltaStream(options.sessionId), streamId,
      )
      for (const entry of readDeltaEntries(result, options.sessionId)) {
        streamId = entry.streamId
        const itemId = entry.envelope.itemId
        if (!itemId) continue
        const previousRevision = revisions.get(itemId)
        if (previousRevision !== undefined && entry.envelope.revision <= previousRevision) continue
        revisions.set(itemId, entry.envelope.revision)
        buffer.push({ kind: "transient", body: deltaFrame(entry.streamId, entry.envelope) })
      }
    }
  } catch {
    // Redis is an acceleration channel. Durable PostgreSQL polling remains authoritative.
  } finally {
    redis.disconnect()
  }
}

async function heartbeatLoop(options: V2EventStreamOptions, buffer: BoundedStreamBuffer, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    await delay(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, signal)
    if (!signal.aborted) buffer.push({ kind: "transient", body: ": heartbeat\n\n" })
  }
}

function durableFrame(row: DurableEventRow): string {
  const payload: AgentStreamEnvelope = {
    schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: row.id, sessionId: row.sessionId, turnId: row.turnId,
    itemId: row.itemId, taskId: row.taskId, type: row.type, actor: row.actor,
    correlationId: row.correlationId, causationId: row.causationId, idempotencyKey: row.idempotencyKey,
    sequence: row.sequence.toString(), payload: redactStreamValue(row.payload),
  }
  return sseFrame(row.type, row.sequence.toString(), payload)
}

function deltaFrame(streamId: string, envelope: AgentDeltaEnvelope): string {
  return sseFrame(envelope.type, null, { ...envelope, payload: redactStreamValue(envelope.payload), streamId })
}

function sseFrame(event: string, id: string | null, data: unknown): string {
  return `${event ? `event: ${event}\n` : ""}${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`
}

function readDeltaEntries(value: unknown, sessionId: string): Array<{ streamId: string; envelope: AgentDeltaEnvelope }> {
  if (!Array.isArray(value)) return []
  const entries: Array<{ streamId: string; envelope: AgentDeltaEnvelope }> = []
  for (const stream of value) {
    if (!Array.isArray(stream) || !Array.isArray(stream[1])) continue
    for (const entry of stream[1]) {
      if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Array.isArray(entry[1])) continue
      const fields = entry[1]
      const payloadIndex = fields.findIndex((field) => field === "payload")
      const raw = payloadIndex >= 0 ? fields[payloadIndex + 1] : null
      if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_DELTA_ENTRY_BYTES) continue
      try {
        const parsed = JSON.parse(raw) as Partial<AgentDeltaEnvelope>
        if (parsed.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || parsed.sessionId !== sessionId ||
          (parsed.kind !== "delta" && parsed.kind !== "snapshot") || typeof parsed.type !== "string" ||
          typeof parsed.itemId !== "string" || typeof parsed.revision !== "number") continue
        entries.push({ streamId: entry[0], envelope: parsed as AgentDeltaEnvelope })
      } catch {
        continue
      }
    }
  }
  return entries
}

function defaultRedisFactory(): AgentStreamRedis | null {
  const url = process.env.REDIS_URL?.trim()
  if (!url) return null
  return new Redis(url, { lazyConnect: true, connectTimeout: 1_000, maxRetriesPerRequest: 1, retryStrategy: () => null })
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    const onAbort = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
