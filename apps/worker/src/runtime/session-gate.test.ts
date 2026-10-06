import { describe, expect, it, vi } from "vitest"

import { assertSessionWorkAdmission, OPEN_SESSION, RUNNABLE_SESSION, SESSION_WORK_ADMISSION, SessionPauseRequestedError, isSessionPauseRequestedError } from "./session-gate.js"

describe("Worker session gates", () => {
  it("keeps runnable work fenced to open sessions", () => {
    expect(OPEN_SESSION).toBe(`session."status" NOT IN ('aborted', 'archived')`)
    expect(RUNNABLE_SESSION).toBe(OPEN_SESSION)
    expect(RUNNABLE_SESSION).toContain(OPEN_SESSION)
  })

  it("keeps admission separate and fences only an unresumed pause request", () => {
    expect(SESSION_WORK_ADMISSION).toContain(OPEN_SESSION)
    expect(SESSION_WORK_ADMISSION).toContain(`session."status" = 'running'`)
    expect(SESSION_WORK_ADMISSION).toContain(`pause_request."type" = 'session.pause_requested'`)
    expect(SESSION_WORK_ADMISSION).toContain(`pause_request."turnId" = $3`)
    expect(SESSION_WORK_ADMISSION).toContain(`resumed."type" = 'session.resume_requested'`)
    expect(SESSION_WORK_ADMISSION).toContain(`resumed."turnId" = pause_request."turnId"`)
    expect(SESSION_WORK_ADMISSION).toContain(`resumed."sequence" > pause_request."sequence"`)
  })

  it("recognizes only the typed pause-fence error", () => {
    const error = new SessionPauseRequestedError()
    expect(isSessionPauseRequestedError(error)).toBe(true)
    expect(isSessionPauseRequestedError(new Error("session_pause_requested"))).toBe(false)
  })

  it("checks fresh admission state only for the locked session owner", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: "session-1" }] }))
    await expect(assertSessionWorkAdmission({ query } as never, { userId: "user-1", sessionId: "session-1", turnId: "turn-1" })).resolves.toBeUndefined()
    expect(query.mock.calls[0]?.[0]).toContain(SESSION_WORK_ADMISSION)
    expect(query.mock.calls[0]?.[1]).toEqual(["session-1", "user-1", "turn-1"])
  })

  it("fails closed after a pause is durable", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))
    await expect(assertSessionWorkAdmission({ query } as never, { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }))
      .rejects.toBeInstanceOf(SessionPauseRequestedError)
  })
})
