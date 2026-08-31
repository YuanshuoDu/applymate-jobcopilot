import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { readPgProjection } from "./pg-projection.js"

describe("worker projection reader", () => {
  it("keeps projection SQL parameterized", () => {
    const source = readFileSync(new URL("./pg-projection.ts", import.meta.url), "utf8")
    expect(source).not.toMatch(/`[^`]*\$\{/s)
    expect(source).toContain("WHERE \"id\" = $1")
  })

  it("returns null when the requested turn is not owned", async () => {
    const client = {
      query: async () => ({ rows: [] }),
    }
    await expect(readPgProjection(client as never, { userId: "user_2" }, { sessionId: "session_1", turnId: "turn_1" })).resolves.toBeNull()
  })
})
