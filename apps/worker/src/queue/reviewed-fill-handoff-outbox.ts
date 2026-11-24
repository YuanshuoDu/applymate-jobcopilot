import type { Pool, QueryConfig, QueryResult, QueryResultRow } from "pg"
import {
  OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC,
  parseObjectiveReviewedFillHandoffOutboxRow,
  parseReviewedFillHandoffOutboxRow,
  REVIEWED_FILL_HANDOFF_TOPIC,
  type ObjectiveReviewedFillHandoffOutboxRow,
  type ReviewedFillHandoffOutboxRow,
} from "@jobcopilot/shared"

const PATH = "/api/internal/agent-runtime/reviewed-fill"
const DEFAULT_POLL_MS = 1_000
const DEFAULT_TIMEOUT_MS = 10_000
const QUERY_TIMEOUT_MS = 5_000
const MAX_BATCH_SIZE = 25
const MAX_RESPONSE_BYTES = 1_024
const HANDOFF_TOPICS = [REVIEWED_FILL_HANDOFF_TOPIC, OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC] as const
const cursors = new WeakMap<Pool, { createdAt: string; id: string }>()

type SelectedRow = QueryResultRow & { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown; createdAtCursor: string }
type Ack = "queued" | "duplicate" | "terminal" | "deferred"
type HandoffRow = ReviewedFillHandoffOutboxRow | ObjectiveReviewedFillHandoffOutboxRow
export type ReviewedFillHandoffOutboxOptions = {
  endpointUrl?: string
  secret?: string
  fetch?: typeof fetch
  timeoutMs?: number
  batchSize?: number
}
type StartOptions = ReviewedFillHandoffOutboxOptions & {
  pollMs?: number
  drain?: (pool: Pool, signal: AbortSignal) => Promise<number>
}
type Bridge = { url: string; secret: string; fetcher: typeof fetch; timeoutMs: number }

function query<T extends QueryResultRow>(pool: Pool, text: string, values: unknown[]): Promise<QueryResult<T>> {
  const config: QueryConfig<unknown[]> & { query_timeout: number } = { text, values, query_timeout: QUERY_TIMEOUT_MS }
  return pool.query<T>(config)
}

function bridge(options: ReviewedFillHandoffOutboxOptions): Bridge | null {
  const secret = options.secret?.trim() || process.env.AGENT_WORKER_SECRET?.trim()
  const direct = options.endpointUrl?.trim()
  const base = process.env.AGENT_WEB_URL?.trim() || process.env.WEB_APP_URL?.trim() || process.env.APPLYMATE_WEB_URL?.trim()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new RangeError("Reviewed fill handoff timeout is invalid")
  if (!secret || (!direct && !base) || typeof (options.fetch ?? globalThis.fetch) !== "function") return null
  try {
    const url = new URL(direct || `${base!.replace(/\/$/, "")}${PATH}`)
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.search || url.hash) return null
    return { url: url.toString(), secret, fetcher: options.fetch ?? globalThis.fetch, timeoutMs }
  } catch {
    return null
  }
}

function exactAck(value: unknown): Ack | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    const descriptor = Object.getOwnPropertyDescriptor(value, "status")
    if (keys.length !== 1 || keys[0] !== "status" || !descriptor?.enumerable || !("value" in descriptor)) return null
    return descriptor.value === "queued" || descriptor.value === "duplicate" || descriptor.value === "terminal" || descriptor.value === "deferred"
      ? descriptor.value : null
  } catch { return null }
}

async function requestAck(row: HandoffRow, config: Bridge, shutdown: AbortSignal): Promise<Ack | null> {
  try {
    const signal = AbortSignal.any([shutdown, AbortSignal.timeout(config.timeoutMs)])
    const response = await config.fetcher(config.url, {
      method: "POST", headers: { "content-type": "application/json", "x-agent-worker-secret": config.secret },
      body: JSON.stringify({ outboxId: row.id }), cache: "no-store", redirect: "error", signal,
    })
    if (response.status !== 200 || response.redirected) return null
    const length = Number(response.headers.get("content-length"))
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) return null
    const text = await readBoundedText(response)
    if (text === null) return null
    return exactAck(JSON.parse(text) as unknown)
  } catch { return null }
}

async function readBoundedText(response: Response): Promise<string | null> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > MAX_RESPONSE_BYTES) { await reader.cancel().catch(() => undefined); return null }
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } finally { reader.releaseLock() }
}

async function selectPending(pool: Pool, limit: number): Promise<SelectedRow[]> {
  const cursor = cursors.get(pool)
  const select = (after?: { createdAt: string; id: string }) => query<SelectedRow>(pool, `SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload",
    to_char("createdAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS "createdAtCursor"
    FROM "agent_outbox" WHERE "topic" = ANY($1::text[]) AND "publishedAt" IS NULL
    ${after ? `AND ("createdAt", "id") > ($2::timestamp, $3::text)` : ""}
    ORDER BY "createdAt" ASC, "id" ASC LIMIT $${after ? 4 : 2}`,
  after ? [HANDOFF_TOPICS, after.createdAt, after.id, limit] : [HANDOFF_TOPICS, limit])
  let rows = (await select(cursor)).rows
  if (!rows.length && cursor) { cursors.delete(pool); rows = (await select()).rows }
  const last = rows.at(-1)
  if (last && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(last.createdAtCursor)) {
    cursors.set(pool, { createdAt: last.createdAtCursor, id: last.id })
  }
  return rows
}

async function markPublished(pool: Pool, row: HandoffRow): Promise<boolean> {
  const result = await query(pool, `UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP,
    "attemptCount" = "attemptCount" + 1, "lastError" = NULL
    WHERE "id" = $1 AND "topic" = $2 AND "aggregateId" = $3 AND "idempotencyKey" = $4
      AND "payload" = $5::jsonb AND "publishedAt" IS NULL`,
  [row.id, row.topic, row.aggregateId, row.idempotencyKey, JSON.stringify(row.payload)])
  return result.rowCount === 1
}

function parsedRow(row: SelectedRow): HandoffRow | null {
  const selected = { id: row.id, topic: row.topic, aggregateId: row.aggregateId,
    idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (row.topic === REVIEWED_FILL_HANDOFF_TOPIC) return parseReviewedFillHandoffOutboxRow(selected)
  if (row.topic === OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC) return parseObjectiveReviewedFillHandoffOutboxRow(selected)
  return null
}

export async function drainReviewedFillHandoffOutbox(
  pool: Pool, options: ReviewedFillHandoffOutboxOptions = {}, shutdown = new AbortController().signal,
): Promise<number> {
  const limit = options.batchSize ?? MAX_BATCH_SIZE
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("Reviewed fill handoff batch size must be positive")
  const config = bridge(options)
  if (!config) return 0
  const rows = await selectPending(pool, Math.min(limit, MAX_BATCH_SIZE))
  let published = 0
  for (const selected of rows) {
    if (shutdown.aborted) break
    const row = parsedRow(selected)
    if (!row) continue
    const ack = await requestAck(row, config, shutdown)
    if (ack !== "queued" && ack !== "duplicate" && ack !== "terminal") continue
    if (await markPublished(pool, row)) published += 1
  }
  return published
}

export function startReviewedFillHandoffOutboxPublisher(pool: Pool, options: StartOptions = {}) {
  const config = bridge(options)
  if (!config) {
    console.error("[reviewed-fill-handoff-outbox] bridge unavailable; publisher disabled")
    return { async close() {} }
  }
  const configuredPoll = Number(options.pollMs ?? process.env.REVIEWED_FILL_HANDOFF_OUTBOX_POLL_MS ?? DEFAULT_POLL_MS)
  const pollMs = Number.isInteger(configuredPoll) && configuredPoll >= 250 && configuredPoll <= 30_000 ? configuredPoll : DEFAULT_POLL_MS
  const controller = new AbortController()
  const drain = options.drain ?? ((target, signal) => drainReviewedFillHandoffOutbox(target, {
    ...options, endpointUrl: config.url, secret: config.secret, fetch: config.fetcher, timeoutMs: config.timeoutMs,
  }, signal))
  let closed = false
  let inFlight: Promise<void> | null = null
  const run = () => {
    if (closed || inFlight) return
    const current = drain(pool, controller.signal).catch(() => { console.error("[reviewed-fill-handoff-outbox] drain failed") })
      .then(() => undefined).finally(() => { if (inFlight === current) inFlight = null })
    inFlight = current
  }
  const timer = setInterval(run, pollMs)
  timer.unref?.()
  run()
  return { async close() { closed = true; clearInterval(timer); controller.abort(); await inFlight } }
}
