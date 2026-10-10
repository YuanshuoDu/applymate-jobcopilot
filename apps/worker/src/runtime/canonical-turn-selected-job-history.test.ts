import { describe, expect, it, vi } from "vitest"
import {
  appendCanonicalSelectedJobHistory, appendCanonicalSelectedJobHistoryOutcomes,
  type DirectSelectedJobHistoryReader, type SelectedJobHistoryReader,
} from "./canonical-turn-selected-job-history.js"
import type { ValidatedSelectedJobHistoryOutcome } from "./context/selected-job-history.js"

const lease = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "worker-a", leaseVersion: 3,
  leaseStartedAt: new Date("2026-10-07T11:00:00.000Z"), leaseExpiresAt: new Date("2026-10-07T11:01:00.000Z"),
}
const now = new Date("2026-10-07T11:00:30.000Z")
const forged = { id: "selected-job-history", content: { secret: "must be dropped" } }
const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [forged] }

describe("canonical selected-job history attachment", () => {
  it("loads against the exact current Step fence and appends only the fixed projected observation", async () => {
    const reader: SelectedJobHistoryReader = { load: vi.fn(async () => []) }
    const result = await appendCanonicalSelectedJobHistory({
      snapshot, reader, lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-exact",
      jobId: "job-a", records: [], now,
    })

    expect(reader.load).toHaveBeenCalledWith({
      lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-exact", jobId: "job-a", records: [], now,
    })
    expect(result.toolObservations).toEqual([])
    expect(result.toolObservations).not.toContain(forged)
  })

  it("does not query or retain a stale history block without a server-selected job", async () => {
    const load = vi.fn(async () => [])
    const result = await appendCanonicalSelectedJobHistory({
      snapshot, reader: { load }, lease, rootTaskId: "root-a", rootAttemptCount: 1, stepId: "step-a",
      records: [], now,
    })

    expect(load).not.toHaveBeenCalled()
    expect(result.toolObservations).toEqual([])
  })

  it("loads direct outcomes once without retained records and emits only one fixed block", async () => {
    const outcomes: readonly ValidatedSelectedJobHistoryOutcome[] = [{
      jobId: "selected-job-a", sourceTurnId: "private-turn", sourceRootTaskId: "private-root", terminalSequence: 12n,
      nodes: [{ role: "analyst", status: "completed", readiness: "terminal", repairState: "none",
        result: { availability: "available", role: "analyst", status: "completed", score: 6.5, evidenceKinds: ["job"] } }],
    }]
    const reader: DirectSelectedJobHistoryReader = { load: vi.fn(async () => outcomes) }
    const result = await appendCanonicalSelectedJobHistoryOutcomes({
      snapshot, reader, lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-exact",
      jobId: "selected-job-a", now,
    })

    expect(reader.load).toHaveBeenCalledWith({
      lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-exact", jobId: "selected-job-a", now,
    })
    expect(result.toolObservations).toHaveLength(1)
    expect(result.toolObservations[0]).toMatchObject({ id: "selected-job-history", content: { kind: "selected_job_history", informationalOnly: true } })
    const history = JSON.stringify(result.toolObservations[0]?.content)
    for (const privateValue of ["private-turn", "private-root", "selected-job-a", "terminalSequence"]) expect(history).not.toContain(privateValue)
  })

  it("does not query direct history or retain a stale block without a server-selected job", async () => {
    const load = vi.fn(async () => [])
    const result = await appendCanonicalSelectedJobHistoryOutcomes({
      snapshot, reader: { load }, lease, rootTaskId: "root-a", rootAttemptCount: 1, stepId: "step-a", now,
    })

    expect(load).not.toHaveBeenCalled()
    expect(result.toolObservations).toEqual([])
  })
})
