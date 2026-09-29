import { describe, expect, it, vi } from "vitest"
import type { Pool } from "pg"

import { artifactTaskFenceIsCurrent, artifactTaskLeaseIsLive, type AgentArtifactTaskFence } from "./agent-artifact-repo-helpers.js"

const fence: AgentArtifactTaskFence = {
  taskId: "task-a", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a",
  parentTaskId: "parent-a", leaseOwner: "worker-a", attemptCount: 2,
}

function clientWith(rows: Array<{ readonly id: string } | { readonly live: boolean }>) {
  let index = 0
  return { query: vi.fn(async (_sql: string, _values?: unknown[]) => {
    const row = rows[index++]
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 }
  }) }
}

describe("selected-job artifact task fence helpers", () => {
  it("locks the task lineage and permits legitimate waiting Turn and parent states", async () => {
    const client = clientWith([{ id: "task-a" }, { id: "parent-a" }])
    await expect(artifactTaskFenceIsCurrent(client as unknown as Pick<Pool, "query">, fence, "job-a")).resolves.toBe(true)
    const [taskSql, taskValues] = client.query.mock.calls[0] as unknown as [string, unknown[]]
    expect(taskSql).toContain("FOR UPDATE OF session, turn, root, task")
    expect(taskSql).toContain('task."context"->\'selectedJobPreparation\'->>\'jobId\' = $9')
    expect(taskSql).toContain('root."interruptRequestedAt" IS NULL')
    expect(taskValues).toEqual(["task-a", "user-a", "session-a", "turn-a", "root-a", "parent-a", "worker-a", 2, "job-a"])
    expect(client.query.mock.calls[1]?.[0]).toContain('parent."interruptRequestedAt" IS NULL FOR UPDATE')
  })

  it("fails closed for invalid fences and missing or interrupted parent lineage", async () => {
    const invalid = clientWith([])
    await expect(artifactTaskFenceIsCurrent(invalid as unknown as Pick<Pool, "query">, { ...fence, attemptCount: 0 }, "job-a")).resolves.toBe(false)
    expect(invalid.query).not.toHaveBeenCalled()

    const stoppedParent = clientWith([{ id: "task-a" }])
    await expect(artifactTaskFenceIsCurrent(stoppedParent as unknown as Pick<Pool, "query">, fence, "job-a")).resolves.toBe(false)
  })

  it("rechecks lease expiry against wall clock before commit", async () => {
    const live = clientWith([{ live: true }])
    await expect(artifactTaskLeaseIsLive(live as unknown as Pick<Pool, "query">, fence)).resolves.toBe(true)
    expect(live.query.mock.calls[0]?.[0]).toContain("clock_timestamp()")
    const expired = clientWith([{ live: false }])
    await expect(artifactTaskLeaseIsLive(expired as unknown as Pick<Pool, "query">, fence)).resolves.toBe(false)
  })
})
