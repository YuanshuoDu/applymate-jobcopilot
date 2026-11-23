import { describe, expect, it, vi } from "vitest"

import { assertSessionTerminalAdmission, assertSessionWorkAdmission, OPEN_SESSION, RUNNABLE_SESSION, SESSION_WORK_ADMISSION, SessionPauseRequestedError, isSessionPauseRequestedError, revokeSessionTerminalAdmissionsForClient, sessionTerminalAdmissionKindFor } from "./session-gate.js"

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

  it("admits only the exact owned canonical Fill terminal receipt for a submission uncertainty wait", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => ({
      rows: sql.includes('JOIN "application_tasks" AS fill_task') ? [{ id: "session-1" }] : [],
    }))
    const input = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: "canonical_task_graph" }

    const client = { query } as never
    const admission = await assertSessionTerminalAdmission(client, input)
    expect(sessionTerminalAdmissionKindFor(admission, client, input)).toBe("derived_fill")

    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[0]).toContain(SESSION_WORK_ADMISSION)
    const terminal = query.mock.calls[1]?.[0] ?? ""
    expect(terminal).toContain(`session."status" = 'waiting_for_user'`)
    expect(terminal).toContain(`fill_task."fillTurnId" = $3`)
    expect(terminal).toContain(`fill_task."fillTurnSessionId" = $1`)
    expect(terminal).toContain(`fill_task."fillTurnUserId" = $2`)
    expect(terminal).toContain(`fill_task."status" = 'waiting_for_user' AND fill_task."checkpoint" = 'submission_uncertain'`)
    expect(terminal).toContain(`filler."turnId" = fill_task."fillTurnId"`)
    expect(terminal).toContain(`filler."rootTaskId" = $4 AND filler."parentTaskId" = $4`)
    expect(terminal).toContain(`filler."role" = 'application_filler'`)
    expect(terminal).toContain(`filler."taskType" = 'application_fill_for_review' AND filler."status" = 'completed'`)
    expect(terminal).toContain(`pause_request."type" = 'session.pause_requested'`)
    expect(query.mock.calls[1]?.[1]).toEqual(["session-1", "user-1", "turn-1", "root-1"])
  })

  it("revokes terminal admission receipts when their transaction client is released", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: "session-1" }] }))
    const client = { query } as never
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: "canonical_task_graph" }
    const admission = await assertSessionTerminalAdmission(client, scope)
    revokeSessionTerminalAdmissionsForClient(client)
    expect(() => sessionTerminalAdmissionKindFor(admission, client, scope)).toThrow("session_terminal_admission_mismatch")
  })

  it("admits the production null-mode Fill Turn only with the exact completed Fill child and wait", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('JOIN "application_tasks" AS fill_task') ? [{ id: "session-1" }] : [] }))

    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: null,
    })).resolves.toBeDefined()
    expect(query.mock.calls[1]?.[0]).toContain(`filler."status" = 'completed'`)
  })

  it.each([
    ["foreign source", "automation", "canonical_task_graph"],
    ["noncanonical mode", "user", "legacy_pipeline_adapter"],
  ])("does not use the derived wait exception for a %s", async (_case, source, executionMode) => {
    const query = vi.fn(async () => ({ rows: [] }))
    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source, executionMode,
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("does not accept nullable mode without the exact Fill child receipt", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))

    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: null,
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[1]?.[0]).toContain(`filler."rootTaskId" = $4 AND filler."parentTaskId" = $4`)
    expect(query.mock.calls[1]?.[1]).toEqual(["session-1", "user-1", "turn-1", "root-1"])
  })

  it("does not admit a Fill child rooted in a different Root", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))

    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: null,
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    const terminal = query.mock.calls[1]?.[0] ?? ""
    expect(terminal).toContain(`filler."turnId" = fill_task."fillTurnId"`)
    expect(terminal).toContain(`filler."rootTaskId" = $4 AND filler."parentTaskId" = $4`)
    expect(query.mock.calls[1]?.[1]).toEqual(["session-1", "user-1", "turn-1", "root-1"])
  })

  it("does not admit a same-Turn child with a noncanonical role or task type", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))

    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: null,
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    const terminal = query.mock.calls[1]?.[0] ?? ""
    expect(terminal).toContain(`filler."role" = 'application_filler'`)
    expect(terminal).toContain(`filler."taskType" = 'application_fill_for_review'`)
  })

  it("does not use a still-waiting filler as completed terminal evidence", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))

    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: null,
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(query.mock.calls[1]?.[0]).toContain(`filler."status" = 'completed'`)
  })

  it.each([0, 2])("rejects a derived wait with %i eligible application bindings", async count => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('JOIN "application_tasks" AS fill_task') ? Array.from({ length: count }, (_, index) => ({ id: `session-${index}` })) : [],
    }))
    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: "canonical_task_graph",
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it("keeps an unresolved explicit pause outside terminal admission even with matching application evidence", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('JOIN "application_tasks" AS fill_task') && !sql.includes("pause_request") ? [{ id: "session-1" }] : [],
    }))
    await expect(assertSessionTerminalAdmission({ query } as never, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", source: "user", executionMode: "canonical_task_graph",
    })).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(query.mock.calls[1]?.[0]).toContain(`fill_task."checkpoint" = 'submission_uncertain'`)
    expect(query.mock.calls[1]?.[0]).toContain(`pause_request."type" = 'session.pause_requested'`)
    expect(query.mock.calls[1]?.[0]).toContain(`resumed."sequence" > pause_request."sequence"`)
  })
})
