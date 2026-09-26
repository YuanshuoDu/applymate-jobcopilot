import { describe, expect, it } from "vitest"

import { OPEN_SESSION, RUNNABLE_SESSION } from "./session-gate.js"

describe("Worker session gates", () => {
  it("keeps runnable work fenced to open sessions", () => {
    expect(OPEN_SESSION).toBe(`session."status" NOT IN ('aborted', 'archived')`)
    expect(RUNNABLE_SESSION).toBe(OPEN_SESSION)
    expect(RUNNABLE_SESSION).toContain(OPEN_SESSION)
  })
})
