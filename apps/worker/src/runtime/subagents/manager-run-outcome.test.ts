import { describe, expect, it, vi } from "vitest"

import { SessionPauseRequestedError } from "../session-gate.js"
import { finishInterrupted, runClaimedSubagent } from "./manager-run-outcome.js"
import { SubagentLeaseError, type SubagentExecutionResult, type SubagentJobPayload, type SubagentLease, type SubagentStore } from "./types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }
const lease = { id: "task-1", attemptCount: 2 } as SubagentLease
const runLease = { id: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 2 } as SubagentLease
const interrupted = new SubagentLeaseError("lost", "Parent was interrupted")

describe("runClaimedSubagent", () => {
  it("finishes an ordinary result and always disposes the active lease", async () => {
    const finish = vi.fn().mockResolvedValue("completed")
    const dispose = vi.fn()
    const timestamp = new Date("2026-09-23T00:00:00Z")
    const now = vi.fn(() => timestamp)
    const execute = vi.fn(async (): Promise<SubagentExecutionResult> => ({ status: "completed", result: { ok: true }, mailboxMessageIds: ["message-1"] }))

    await expect(runClaimedSubagent({ finish }, payload, runLease, { lost: new Promise(() => undefined), interrupted: false }, execute, now, dispose))
      .resolves.toEqual({ taskId: "task-1", status: "completed" })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", attemptCount: 2, status: "completed", mailboxMessageIds: ["message-1"], now: timestamp }))
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("releases a claimed attempt on pause without persisting a terminal result", async () => {
    const finish = vi.fn()
    const release = vi.fn().mockResolvedValue(true)
    const dispose = vi.fn()
    const now = vi.fn(() => new Date("2026-09-23T00:00:00Z"))

    await expect(runClaimedSubagent({ finish, release }, payload, runLease, { lost: new Promise(() => undefined), interrupted: false }, async () => {
      throw new SessionPauseRequestedError()
    }, now, dispose)).resolves.toEqual({ taskId: "task-1", status: "retrying", reason: "session_pause_requested" })
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", attemptCount: 2, now: now() }))
    expect(finish).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("terminalizes only an explicitly interrupted active lease", async () => {
    const finish = vi.fn().mockResolvedValue("interrupted")
    const dispose = vi.fn()
    const lost = Promise.resolve(interrupted)

    await expect(runClaimedSubagent({ finish }, payload, runLease, { lost, interrupted: true }, async () => new Promise<SubagentExecutionResult>(() => undefined), () => new Date(), dispose))
      .resolves.toEqual({ taskId: "task-1", status: "interrupted", reason: interrupted.message })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", failureReason: interrupted.message, attemptCount: 2 }))
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe("finishInterrupted", () => {
  it("persists the active attempt as interrupted before reporting it", async () => {
    const finish = vi.fn().mockResolvedValue("interrupted")
    const result = await finishInterrupted({ finish } as unknown as Pick<SubagentStore, "finish">, payload, lease, interrupted, new Date("2026-09-23T00:00:00Z"))
    expect(result).toEqual({ taskId: "task-1", status: "interrupted", reason: interrupted.message })
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", ownerId: "worker-1", attemptCount: 2, status: "failed", failureReason: interrupted.message }))
  })

  it("reports a lost or fenced lease when interruption cannot be committed", async () => {
    const finish = vi.fn().mockResolvedValue(null)
    await expect(finishInterrupted({ finish } as unknown as Pick<SubagentStore, "finish">, payload, lease, interrupted, new Date()))
      .resolves.toEqual({ taskId: "task-1", status: "lease_lost", reason: "Subagent lease was fenced" })
  })
})
