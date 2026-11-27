import type { Pool } from "pg"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ write: vi.fn(), finish: vi.fn(), query: vi.fn() }))
vi.mock("./submission-guard.js", () => ({ withExactSubmissionWrite: mocks.write }))
vi.mock("./application-task-state.js", () => ({ finishApplicationTaskWithClient: mocks.finish }))
import { markExactStartedObjectiveSubmissionUncertain } from "./objective-submission-uncertain.js"

const scope = { applicationTaskId: "task", userId: "user", jobId: "job", sessionId: "session", fillTurnId: "turn",
  approvalId: "approval", constraintHash: "a".repeat(64), workerTaskId: "worker", executionId: "execution" }
const pool = {} as Pool
const client = { query: mocks.query, connect: vi.fn(), release: vi.fn() }
const started = () => ({ id: "evt_execution", taskId: "task", type: "submission_execution_started", actor: "worker",
  body: "Submit execution started", data: { ...scope } })
function rows(task: Record<string, unknown> | null, events: Record<string, unknown>[]) {
  mocks.query.mockReset().mockResolvedValueOnce({ rows: task ? [task] : [] }).mockResolvedValueOnce({ rows: events })
}

describe("exact started Objective submission uncertainty", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.write.mockImplementation(async (_pool, _scope, _phase, work) => ({ kind: "current", value: await work(client) }))
    mocks.finish.mockResolvedValue("current")
    rows({ workerTaskId: "worker", status: "filling", checkpoint: "submission_request_started" }, [started()])
  })

  it("writes under the same locked client after proving the task and exact marker", async () => {
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("written")
    expect(mocks.write).toHaveBeenCalledWith(pool, scope, "objective_started_uncertain", expect.any(Function))
    expect(mocks.query.mock.calls[1]?.[0]).toContain('"data"->>\'approvalId\'=$4')
    expect(mocks.query.mock.calls[1]?.[1]).toEqual(["task", "evt_execution", "worker", "approval"])
    expect(mocks.finish).toHaveBeenCalledWith(client, "task", "waiting_for_user", "submission_uncertain", "uncertain", scope)
    expect(client.connect).not.toHaveBeenCalled()
    expect(client.release).not.toHaveBeenCalled()
    expect(mocks.query.mock.calls.every(([sql]) => sql !== "BEGIN")).toBe(true)
  })

  it("does not change a successor worker on the same task", async () => {
    rows({ workerTaskId: "successor", status: "filling", checkpoint: "submission_request_started" }, [started()])
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("superseded")
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it.each([
    ["other execution", { ...started(), id: "evt_other", data: { ...scope, executionId: "other" } }],
    ["forged actor", { ...started(), actor: "user" }],
    ["forged body", { ...started(), body: "other" }],
    ["extra field", { ...started(), data: { ...scope, extra: true } }],
    ["other approval", { ...started(), data: { ...scope, approvalId: "other" } }],
  ])("fails closed for %s", async (_label, event) => {
    rows({ workerTaskId: "worker", status: "filling", checkpoint: "submission_request_started" }, [event])
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("unverified")
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it.each([{ events: [] }, { events: [started(), started()] }])("rejects missing or ambiguous markers", async ({ events }) => {
    rows({ workerTaskId: "worker", status: "filling", checkpoint: "submission_request_started" }, events)
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("unverified")
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it("limits history lookup to this approval, worker, or execution", async () => {
    await markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")
    const sql = String(mocks.query.mock.calls[1]?.[0])
    expect(sql).toContain('"id"=$2 OR "data"->>\'workerTaskId\'=$3 OR "data"->>\'approvalId\'=$4')
    expect(mocks.finish).toHaveBeenCalledOnce()
  })

  it("is idempotent for the already uncertain exact execution", async () => {
    rows({ workerTaskId: "worker", status: "waiting_for_user", checkpoint: "submission_uncertain" }, [started()])
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("written")
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it("repairs a cancelled pre-submit stop only for the exact started execution", async () => {
    rows({ workerTaskId: "worker", status: "cancelled", checkpoint: "turn_stopped_before_submit" }, [started()])
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("written")
    expect(mocks.finish).toHaveBeenCalledOnce()
  })

  it("never overwrites a final task or reports missing evidence as superseded", async () => {
    rows({ workerTaskId: "worker", status: "submitted", checkpoint: "submission_verified" }, [started()])
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("unverified")
    expect(mocks.finish).not.toHaveBeenCalled()
  })

  it("propagates database errors and preserves the outer superseded result", async () => {
    mocks.query.mockReset().mockRejectedValueOnce(new Error("db unavailable"))
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).rejects.toThrow("db unavailable")
    mocks.write.mockResolvedValueOnce({ kind: "superseded" })
    await expect(markExactStartedObjectiveSubmissionUncertain(pool, scope, "uncertain")).resolves.toBe("superseded")
    expect(mocks.finish).not.toHaveBeenCalled()
  })
})
