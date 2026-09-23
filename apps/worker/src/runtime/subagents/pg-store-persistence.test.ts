import { describe, expect, it } from "vitest"

import { actionList, dateValue, json, rowToTask, spawnKey, uniqueMessageIds } from "./pg-store-persistence.js"

describe("subagent PostgreSQL persistence helpers", () => {
  it("rejects credential-shaped keys in persisted JSON and retains safe fallbacks", () => {
    expect(() => json({ nested: { accessToken: "secret" } }, {}, "context")).toThrowError("context_contains_secret")
    expect(json(undefined, { safe: true })).toBe('{"safe":true}')
    expect(json(1n, { fallback: true })).toBe('{"fallback":true}')
  })

  it("maps task rows without losing scoped snapshots or durable retry timestamps", () => {
    const nextAttemptAt = "2026-09-23T12:00:00.000Z"
    expect(rowToTask({ id: "task-1", userId: "user-1", sessionId: "session-1", status: "queued", nextAttemptAt, maxAttempts: 3, attemptCount: 1 }))
      .toMatchObject({ id: "task-1", userId: "user-1", sessionId: "session-1", status: "queued", nextAttemptAt: new Date(nextAttemptAt), maxAttempts: 3, attemptCount: 1 })
    expect(dateValue(1)).toBeNull()
  })

  it("normalizes allowlists and idempotent message identities deterministically", () => {
    expect(actionList(["read", " ", 1, "write"])).toEqual(["read", "write"])
    expect(uniqueMessageIds(["m1", "m1", "", "m2"])).toEqual(["m1", "m2"])
    expect(spawnKey("s1", "request-2")).toBe("coordination-spawn:s1:request-2")
  })
})
