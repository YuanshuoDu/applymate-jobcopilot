import { describe, expect, it, vi } from "vitest"

import { SessionPauseRequestedError } from "../session-gate.js"
import { finishInterrupted, runClaimedSubagent } from "./manager-run-outcome.js"
import { SubagentLeaseError, type SubagentExecutionResult, type SubagentJobPayload, type SubagentLease, type SubagentStore } from "./types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }
const lease = { id: "task-1", attemptCount: 2 } as SubagentLease
const runLease = { id: "task-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 2, signal: new AbortController().signal } as SubagentLease
const interrupted = new SubagentLeaseError("lost", "Parent was interrupted")
const runNow = new Date("2026-09-23T00:00:00Z")

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

  it("continues with the same lease and cumulatively acknowledges only observed mailbox ids", async () => {
    const finish = vi.fn()
      .mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-2"] })
      .mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-3"] })
      .mockResolvedValueOnce("completed")
    const execute = vi.fn(async ({ continuation }: { lease: SubagentLease; continuation?: { kind: "mailbox_input_pending"; missingMessageIds: readonly string[]; observedMessageIds: readonly string[] } }) => {
      if (!continuation) return { status: "completed", mailboxMessageIds: ["message-1"] } satisfies SubagentExecutionResult
      return { status: "completed", mailboxMessageIds: continuation.missingMessageIds } satisfies SubagentExecutionResult
    })
    const dispose = vi.fn()

    await expect(runClaimedSubagent({ finish }, payload, runLease, { lost: new Promise(() => undefined), interrupted: false }, execute, () => runNow, dispose))
      .resolves.toEqual({ taskId: "task-1", status: "completed" })

    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls.map(([input]) => input.lease)).toEqual([runLease, runLease, runLease])
    expect(execute.mock.calls[1]?.[0].continuation).toEqual({ kind: "mailbox_input_pending", missingMessageIds: ["message-2"], observedMessageIds: ["message-1"] })
    expect(execute.mock.calls[2]?.[0].continuation).toEqual({ kind: "mailbox_input_pending", missingMessageIds: ["message-3"], observedMessageIds: ["message-1", "message-2"] })
    expect(finish.mock.calls.map(([input]) => input.mailboxMessageIds)).toEqual([
      ["message-1"], ["message-1", "message-2"], ["message-1", "message-2", "message-3"],
    ])
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("fails terminally instead of claiming success when a continuation does not present a required id", async () => {
    const finish = vi.fn().mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-required"] }).mockResolvedValueOnce("failed")
    const execute = vi.fn()
      .mockResolvedValueOnce({ status: "completed", mailboxMessageIds: ["message-old"] } satisfies SubagentExecutionResult)
      .mockResolvedValueOnce({ status: "completed", mailboxMessageIds: [] } satisfies SubagentExecutionResult)

    await expect(runClaimedSubagent({ finish }, payload, runLease, { lost: new Promise(() => undefined), interrupted: false }, execute, () => runNow, vi.fn()))
      .resolves.toEqual({ taskId: "task-1", status: "failed" })
    expect(finish.mock.calls[1]?.[0]).toMatchObject({ status: "failed", failureReason: "subagent_mailbox_input_unavailable", retryDisposition: "terminal" })
    expect(finish.mock.calls[1]?.[0].mailboxMessageIds).toBeUndefined()
  })

  it("bounds repeated input-pending responses and persists an explicit terminal failure", async () => {
    const finish = vi.fn()
      .mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-1"] })
      .mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-2"] })
      .mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-3"] })
      .mockResolvedValueOnce({ status: "input_pending", messageIds: ["message-4"] })
      .mockResolvedValueOnce("failed")
    const execute = vi.fn(async ({ continuation }: { continuation?: { missingMessageIds: readonly string[] } }) => ({
      status: "completed" as const, mailboxMessageIds: continuation?.missingMessageIds ?? [],
    }))

    await expect(runClaimedSubagent({ finish }, payload, runLease, { lost: new Promise(() => undefined), interrupted: false }, execute, () => runNow, vi.fn()))
      .resolves.toEqual({ taskId: "task-1", status: "failed", reason: "subagent_mailbox_continuation_limit" })
    expect(execute).toHaveBeenCalledTimes(4)
    expect(finish).toHaveBeenCalledTimes(5)
    expect(finish.mock.calls[4]?.[0]).toMatchObject({ status: "failed", retryDisposition: "terminal", failureReason: "subagent_mailbox_continuation_limit" })
  })

  it("races each same-attempt continuation against active lease loss", async () => {
    let signalLeaseLoss!: (error: SubagentLeaseError) => void
    const lost = new Promise<SubagentLeaseError>(resolve => { signalLeaseLoss = resolve })
    const finish = vi.fn().mockResolvedValue({ status: "input_pending", messageIds: ["message-2"] })
    const execute = vi.fn(async ({ continuation }: { continuation?: { kind: "mailbox_input_pending" } }) => {
      if (!continuation) return { status: "completed", mailboxMessageIds: ["message-1"] } satisfies SubagentExecutionResult
      signalLeaseLoss(new SubagentLeaseError("lost", "lease expired"))
      return await new Promise<SubagentExecutionResult>(() => undefined)
    })

    await expect(runClaimedSubagent({ finish }, payload, runLease, { lost, interrupted: false }, execute, () => runNow, vi.fn()))
      .resolves.toEqual({ taskId: "task-1", status: "lease_lost", reason: "lease expired" })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(finish).toHaveBeenCalledOnce()
  })

  it("does not start a continuation after the lease is lost during finish", async () => {
    let signalLeaseLoss!: (error: SubagentLeaseError) => void
    const lost = new Promise<SubagentLeaseError>(resolve => { signalLeaseLoss = resolve })
    const controller = new AbortController()
    const ownedLease = { ...runLease, signal: controller.signal }
    const finish = vi.fn(async () => {
      controller.abort()
      signalLeaseLoss(new SubagentLeaseError("lost", "lease expired during finish"))
      return { status: "input_pending" as const, messageIds: ["message-2"] }
    })
    const execute = vi.fn(async (): Promise<SubagentExecutionResult> => ({ status: "completed", mailboxMessageIds: ["message-1"] }))

    await expect(runClaimedSubagent({ finish }, payload, ownedLease, { lost, interrupted: false }, execute, () => runNow, vi.fn()))
      .resolves.toEqual({ taskId: "task-1", status: "lease_lost", reason: "Subagent lease was lost" })

    expect(execute).toHaveBeenCalledOnce()
    expect(finish).toHaveBeenCalledOnce()
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
