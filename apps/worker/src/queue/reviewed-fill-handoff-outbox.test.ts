import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildObjectiveReviewedFillHandoffOutboxData, buildReviewedFillHandoffOutboxData } from "@jobcopilot/shared"
import { drainReviewedFillHandoffOutbox, startReviewedFillHandoffOutboxPublisher } from "./reviewed-fill-handoff-outbox.js"

type Entry = {
  id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown
  createdAt: Date; publishedAt: Date | null; attemptCount: number
}
const identity = { userId: "user_1", sessionId: "session_1", applicationTaskId: "application_1", approvalId: "approval_1", predecessorTurnId: "turn_1" }
const data = buildReviewedFillHandoffOutboxData(identity)!
const objectiveSetId = `objective-review-${"a".repeat(40)}`
const objectiveApprovalId = `objective-review:${objectiveSetId}:3`
const objectiveIdentity = { ...identity, approvalId: objectiveApprovalId }
const objectiveData = buildObjectiveReviewedFillHandoffOutboxData(objectiveIdentity)!
const endpointUrl = "https://web.example/api/internal/agent-runtime/reviewed-fill"
const options = { endpointUrl, secret: "worker-secret", fetch: vi.fn(), batchSize: 10 }
afterEach(() => vi.unstubAllEnvs())

function entry(id: string, createdAt: string, payload: unknown = data.payload,
  handoff: Pick<Entry, "topic" | "aggregateId" | "idempotencyKey"> = data): Entry {
  return { id, ...handoff, payload, createdAt: new Date(createdAt), publishedAt: null, attemptCount: 0 }
}

function fixture(rows: Entry[]) {
  const statements: string[] = []
  const query = vi.fn(async (input: string | { text: string; values?: unknown[]; query_timeout?: number }, passedValues: unknown[] = []) => {
    const sql = typeof input === "string" ? input : input.text
    const values = typeof input === "string" ? passedValues : input.values ?? []
    statements.push(sql)
    if (sql.startsWith("SELECT")) {
      const after = sql.includes('("createdAt", "id") >')
        ? { createdAt: String(values[1]), id: String(values[2]) } : null
      const limit = Number(values[after ? 3 : 1])
      const topics = Array.isArray(values[0]) ? values[0] as string[] : []
      const found = rows.filter(row => topics.includes(row.topic) && row.publishedAt === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .filter(row => !after || dateCursor(row.createdAt) > after.createdAt || dateCursor(row.createdAt) === after.createdAt && row.id > after.id)
        .slice(0, limit).map(row => ({ ...row, createdAtCursor: dateCursor(row.createdAt) }))
      return { rows: found, rowCount: found.length }
    }
    if (sql.startsWith("UPDATE")) {
      const [id, topic, aggregate, key, payload] = values
      const found = rows.find(row => row.id === id && row.topic === topic && row.aggregateId === aggregate
        && row.idempotencyKey === key && JSON.stringify(row.payload) === payload && row.publishedAt === null)
      if (!found) return { rows: [], rowCount: 0 }
      found.publishedAt = new Date("2026-11-20T00:00:00.000Z")
      found.attemptCount += 1
      return { rows: [], rowCount: 1 }
    }
    throw new Error("unexpected query")
  })
  return { rows, statements, query, pool: { query } as unknown as Pool }
}

function dateCursor(date: Date): string { return date.toISOString().slice(0, -1) }

function response(status: number, body: string | object, redirected = false, contentLength = true): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body)
  const bytes = new TextEncoder().encode(text)
  const headers = new Headers()
  if (contentLength) headers.set("content-length", String(bytes.byteLength))
  return { status, redirected, headers,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } }) } as Response
}

describe("reviewed fill handoff outbox publisher", () => {
  it("publishes the distinct Objective topic through the authenticated handoff bridge", async () => {
    const state = fixture([entry("objective_outbox_1", "2026-01-01T00:00:00.000Z", objectiveData.payload, objectiveData)])
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(200, { status: "queued" }))
    const count = await drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })

    expect(count).toBe(1)
    expect(state.rows[0]?.topic).toBe(objectiveData.topic)
    expect(state.rows[0]?.publishedAt).toBeInstanceOf(Date)
    expect(state.rows[0]?.attemptCount).toBe(1)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(endpointUrl)
    expect(JSON.parse(String(init?.body))).toEqual({ outboxId: "objective_outbox_1" })
    expect(state.statements[0]).toContain('"topic" = ANY($1::text[])')
  })

  it("keeps an Objective row pending when an older Web bridge returns 404", async () => {
    const state = fixture([entry("objective_outbox_404", "2026-01-01T00:00:00.000Z", objectiveData.payload, objectiveData)])
    const fetcher = vi.fn(async () => response(404, { status: "terminal" }))
    await expect(drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })).resolves.toBe(0)

    expect(fetcher).toHaveBeenCalledOnce()
    expect(state.rows[0]?.publishedAt).toBeNull()
    expect(state.rows[0]?.attemptCount).toBe(0)
    expect(state.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false)
  })

  it.each(["queued", "duplicate", "terminal"] as const)("publishes only after exact %s acknowledgement", async status => {
    const state = fixture([entry("outbox_1", "2026-01-01T00:00:00.000Z")])
    const fetcher = vi.fn<typeof fetch>(async (_input, _init) => response(200, { status }))
    const count = await drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })

    expect(count).toBe(1)
    expect(state.rows[0]?.publishedAt).toBeInstanceOf(Date)
    expect(state.rows[0]?.attemptCount).toBe(1)
    expect(fetcher).toHaveBeenCalledOnce()
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(endpointUrl)
    expect(init?.method).toBe("POST")
    expect(init?.headers).toEqual({ "content-type": "application/json", "x-agent-worker-secret": "worker-secret" })
    expect(JSON.parse(String(init?.body))).toEqual({ outboxId: "outbox_1" })
    expect(Object.keys(JSON.parse(String(init?.body)))).toEqual(["outboxId"])
    expect(init?.redirect).toBe("error")
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(state.statements.every(sql => !/BEGIN|FOR UPDATE/i.test(sql))).toBe(true)
    expect(state.query.mock.calls.every(([input]) => typeof input !== "string" && input.query_timeout === 5_000)).toBe(true)
  })

  it.each([
    { label: "deferred", makeResponse: () => response(200, { status: "deferred" }) },
    { label: "extra response fields", makeResponse: () => response(200, { status: "queued", outboxId: "outbox_1" }) },
    { label: "malformed response", makeResponse: () => response(200, "not-json") },
    { label: "oversized response", makeResponse: () => response(200, "x".repeat(2_000)) },
    { label: "redirect", makeResponse: () => response(200, { status: "queued" }, true) },
    { label: "non-200", makeResponse: () => response(503, { status: "queued" }) },
  ])("leaves $label responses pending", async ({ makeResponse }) => {
    const state = fixture([entry("outbox_1", "2026-01-01T00:00:00.000Z")])
    const fetcher = vi.fn(async () => makeResponse())
    await expect(drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })).resolves.toBe(0)
    expect(state.rows[0]?.publishedAt).toBeNull()
    expect(state.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("leaves network and database failures pending", async () => {
    const state = fixture([entry("outbox_1", "2026-01-01T00:00:00.000Z")])
    const fetcher = vi.fn(async () => { throw new Error("private failure") })
    await expect(drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })).resolves.toBe(0)
    expect(state.rows[0]?.publishedAt).toBeNull()
    state.query.mockRejectedValueOnce(new Error("database unavailable"))
    await expect(drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })).rejects.toThrow("database unavailable")
    expect(state.rows[0]?.publishedAt).toBeNull()
  })

  it("caps a chunked response without Content-Length while streaming", async () => {
    const state = fixture([entry("outbox_1", "2026-01-01T00:00:00.000Z")])
    let cancelled = false
    const fetcher = vi.fn(async () => ({
      status: 200, redirected: false, headers: new Headers(),
      body: new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(2_000)) },
        cancel() { cancelled = true },
      }),
    }) as Response)
    await expect(drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })).resolves.toBe(0)
    expect(cancelled).toBe(true)
    expect(state.rows[0]?.publishedAt).toBeNull()
    expect(state.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false)
  })

  it("rejects malformed outbox rows and exact-CASes a row changed during the request", async () => {
    const malformed = entry("bad", "2026-01-01T00:00:00.000Z", { ...data.payload, sourceTurnId: "forged" })
    const changed = entry("changed", "2026-01-02T00:00:00.000Z")
    const state = fixture([malformed, changed])
    const fetcher = vi.fn(async () => {
      changed.payload = { ...data.payload, approvalId: "approval_changed" }
      return response(200, { status: "queued" })
    })
    await expect(drainReviewedFillHandoffOutbox(state.pool, { ...options, fetch: fetcher })).resolves.toBe(0)
    expect(fetcher).toHaveBeenCalledOnce()
    expect(state.rows.every(row => row.publishedAt === null)).toBe(true)
    expect(state.statements.filter(sql => sql.startsWith("UPDATE"))).toHaveLength(1)
  })

  it("advances an oldest-first cursor so a deferred row cannot starve newer handoffs", async () => {
    const secondData = buildReviewedFillHandoffOutboxData({ ...identity, approvalId: "approval_2" })!
    const state = fixture([
      entry("older", "2026-01-01T00:00:00.000Z"),
      entry("newer", "2026-01-02T00:00:00.000Z", secondData.payload, secondData),
    ])
    let calls = 0
    const fetcher = vi.fn(async () => response(200, { status: ++calls === 1 ? "deferred" : "queued" }))
    const one = await drainReviewedFillHandoffOutbox(state.pool, { ...options, batchSize: 1, fetch: fetcher })
    const two = await drainReviewedFillHandoffOutbox(state.pool, { ...options, batchSize: 1, fetch: fetcher })
    expect(one).toBe(0)
    expect(two).toBe(1)
    expect(state.rows.map(row => row.publishedAt !== null)).toEqual([false, true])
  })

  it("aborts the in-flight bounded request and waits for drain completion on close", async () => {
    vi.stubEnv("AGENT_WEB_URL", "https://web.example")
    vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret")
    let observedSignal: AbortSignal | undefined
    const drain = vi.fn((_pool: Pool, signal: AbortSignal) => new Promise<number>(resolve => {
      observedSignal = signal
      signal.addEventListener("abort", () => resolve(0), { once: true })
    }))
    const publisher = startReviewedFillHandoffOutboxPublisher({} as Pool, { pollMs: 30_000, drain })
    expect(observedSignal?.aborted).toBe(false)
    await publisher.close()
    expect(observedSignal?.aborted).toBe(true)
    expect(drain).toHaveBeenCalledOnce()
  })

  it("does not block older optional Worker setups when bridge configuration is absent", async () => {
    vi.stubEnv("AGENT_WEB_URL", "")
    vi.stubEnv("WEB_APP_URL", "")
    vi.stubEnv("APPLYMATE_WEB_URL", "")
    vi.stubEnv("AGENT_WORKER_SECRET", "")
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const drain = vi.fn(async () => 0)
    const publisher = startReviewedFillHandoffOutboxPublisher({} as Pool, { drain })
    await publisher.close()
    expect(drain).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith("[reviewed-fill-handoff-outbox] bridge unavailable; publisher disabled")
    error.mockRestore()
  })
})
