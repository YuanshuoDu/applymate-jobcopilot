import { describe, expect, it } from "vitest"

import { isSessionControlGate, OPEN_SESSION, RUNNABLE_SESSION, SESSION_CONTROL_GATES } from "./session-gate.js"

describe("Worker session gates", () => {
  it("keeps the open-session fence independent from the runnable gate", () => {
    expect(OPEN_SESSION).toBe(`session."status" NOT IN ('aborted', 'archived')`)
    expect(RUNNABLE_SESSION).toBe(`${OPEN_SESSION} AND session."controlGate" = 'open'`)
    expect(RUNNABLE_SESSION).toContain(OPEN_SESSION)
  })

  it("accepts only the protocol control gate values", () => {
    expect(SESSION_CONTROL_GATES).toEqual(["open", "user_paused"])
    expect(isSessionControlGate("open")).toBe(true)
    expect(isSessionControlGate("user_paused")).toBe(true)
    for (const value of ["running", "paused", "aborted", "", null, undefined, 1, {}]) {
      expect(isSessionControlGate(value)).toBe(false)
    }
  })
})
