import { describe, expect, it, vi } from "vitest"
import { failSelectedJobPreparationUnavailable } from "./selected-job-preparation-gate.js"

describe("failSelectedJobPreparationUnavailable", () => {
  it("durably records and projects a stable terminal failure", async () => {
    const calls: string[] = []
    const lease = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" } as never
    const state = { goal: "Prepare selected job", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} } as never
    const rootTasks = {
      ensure: vi.fn(async () => { calls.push("ensure"); return { id: "root-1" } as never }),
      finish: vi.fn(async () => { calls.push("finish-root") }),
    }
    const executionProjection = { start: vi.fn(), finish: vi.fn(async () => { calls.push("finish-execution") }) }
    const sessionProjection = { start: vi.fn(), finish: vi.fn(async () => { calls.push("finish-session") }) }

    const result = await failSelectedJobPreparationUnavailable({ lease, state, rootTasks: rootTasks as never, executionProjection: executionProjection as never, sessionProjection: sessionProjection as never, now: () => new Date("2026-09-30T00:00:00.000Z") })

    expect(result).toEqual({ status: "failed", summary: "selected_job_preparation_unavailable" })
    expect(rootTasks.ensure).toHaveBeenCalledWith(expect.objectContaining({ lease, allowedActions: [] }))
    expect(rootTasks.finish).toHaveBeenCalledWith(expect.objectContaining({
      rootTaskId: "root-1", result: { status: "failed", errorCode: "selected_job_preparation_unavailable", stepCount: 0, toolCallCount: 0 },
    }))
    expect(executionProjection.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: "failed", errorCode: "selected_job_preparation_unavailable", stepCount: 0, toolCallCount: 0 },
    }))
    expect(sessionProjection.finish).toHaveBeenCalledWith(expect.objectContaining({
      result: { status: "failed", errorCode: "selected_job_preparation_unavailable", stepCount: 0, toolCallCount: 0 },
    }))
    expect(calls).toEqual(["ensure", "finish-root", "finish-execution", "finish-session"])
  })
})
