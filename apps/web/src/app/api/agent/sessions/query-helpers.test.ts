import { describe, expect, it } from "vitest"

import { afterCursor, pageResult, parsePageRequest, type QueryCursor } from "./query-helpers"

function request(path: string) {
  return new Request(`http://localhost${path}`)
}

describe("agent query pagination helpers", () => {
  it("round-trips a scoped cursor and rejects cross-collection reuse", () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({ id: `item_${index}`, createdAt: new Date(`2026-08-31T00:0${index}:00.000Z`) }))
    const first = pageResult(rows, { limit: 2, cursor: null }, "timeline", "session_1")
    expect(first.page.hasMore).toBe(true)
    expect(first.page.nextCursor).toBeTruthy()
    const parsed = parsePageRequest(request(`/api/agent/sessions/session_1/timeline?cursor=${first.page.nextCursor}`), "timeline", "session_1")
    expect(parsed).toMatchObject({ limit: 50, cursor: { collection: "timeline", sessionId: "session_1", id: "item_1" } })
    const rejected = parsePageRequest(request(`/api/agent/sessions/session_2/timeline?cursor=${first.page.nextCursor}`), "timeline", "session_2")
    expect(rejected).toBeInstanceOf(Response)
    expect(afterCursor((parsed as { cursor: QueryCursor | null }).cursor)).toMatchObject({ OR: expect.any(Array) })
  })

  it("enforces a bounded page size", async () => {
    const result = parsePageRequest(request("/api/agent/sessions/session_1/tasks?limit=101"), "tasks", "session_1")
    expect(result).toBeInstanceOf(Response)
    await expect((result as Response).json()).resolves.toMatchObject({ error: { code: "invalid_page_size" } })
  })

  it("uses id as a deterministic tie-breaker when new rows share a timestamp", () => {
    const timestamp = new Date("2026-08-31T00:00:00.000Z")
    const first = pageResult([
      { id: "item_a", createdAt: timestamp },
      { id: "item_b", createdAt: timestamp },
    ], { limit: 1, cursor: null }, "timeline", "session_1")
    const parsed = parsePageRequest(request(`/api/agent/sessions/session_1/timeline?cursor=${first.page.nextCursor}`), "timeline", "session_1")
    expect(afterCursor((parsed as { cursor: QueryCursor | null }).cursor)).toEqual({
      OR: [
        { createdAt: { gt: timestamp } },
        { createdAt: timestamp, id: { gt: "item_a" } },
      ],
    })
    const afterNewRow = afterCursor((parsed as { cursor: QueryCursor | null }).cursor)
    expect(afterNewRow).not.toMatchObject({ id: { gt: "item_b" } })
  })

})
