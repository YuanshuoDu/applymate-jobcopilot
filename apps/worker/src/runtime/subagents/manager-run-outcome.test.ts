import { describe, expect, it, vi } from "vitest"

import { finishInterrupted } from "./manager-run-outcome.js"
import { SubagentLeaseError, type SubagentJobPayload, type SubagentLease, type SubagentStore } from "./types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }
const lease = { id: "task-1", attemptCount: 2 } as SubagentLease
const interrupted = new SubagentLeaseError("lost", "Parent was interrupted")

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
