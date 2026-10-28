import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "./execution-owner.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import { createCanonicalTurnScheduledPipeline } from "./canonical-turn-scheduled-pipeline.js"
import type { ScheduledPipelineCandidateStore } from "./subagents/scheduled-pipeline-candidate-store.js"

const lease = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", ownerId: "worker-1", leaseVersion: 4,
  leaseStartedAt: new Date("2026-10-20T12:00:00.000Z"), leaseExpiresAt: new Date("2026-10-20T12:01:00.000Z"),
}
const executionOwner: TurnExecutionOwnerFence = {
  kind: "turn", userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
  taskId: "root-1", rootTaskId: "root-1", ownerId: lease.ownerId, leaseVersion: lease.leaseVersion,
  leaseExpiresAt: lease.leaseExpiresAt,
}
const scheduledState = { source: "automation", automationRunMode: "scheduled" } as const
const root = { id: "root-1", attemptCount: 2 }
const pool = { connect: vi.fn() } as unknown as pg.Pool

describe("canonical Turn scheduled pipeline assembly", () => {
  it("binds only scheduled TaskGraph turns and recovers candidates under the live Turn owner", async () => {
    const recoveredCandidate = {
      candidateText: "Recovered candidate.", finalStepId: "step-final-4", finalStepOrdinal: 4, finishReason: "stop", usage: null, sourceReceipt: null,
      recoverySource: { owner: { userId: executionOwner.userId, sessionId: executionOwner.sessionId,
        turnId: executionOwner.turnId, rootTaskId: executionOwner.rootTaskId }, sourceEventId: "candidate-event-4",
        sourceStepId: "step-final-4", sourceStepOrdinal: 4, rootAttemptCount: root.attemptCount,
        inputThroughSequence: "10", consumedInputIds: [] },
      recoveryTail: null,
    }
    const candidateStore: ScheduledPipelineCandidateStore = {
      stage: vi.fn(async () => undefined),
      read: vi.fn(async () => recoveredCandidate),
    }
    const candidateStoreFactory = vi.fn(() => candidateStore)
    const eventStore = { appendEvent: vi.fn() } as unknown as Pick<TurnEngineStore, "appendEvent">
    const bridge = vi.fn(async () => ({ status: "blocked" as const, reasonCode: "task_graph_incomplete" as const }))
    const assembly = createCanonicalTurnScheduledPipeline(pool, { bridge, candidateStoreFactory })

    expect(assembly.bridge).toBe(bridge)
    expect(assembly.createCandidateStore(eventStore)).toBe(candidateStore)
    expect(candidateStoreFactory).toHaveBeenCalledWith({ pool, eventStore })
    const owner = assembly.owner({ taskGraphPlanningEnabled: true, state: scheduledState, lease, root })
    expect(owner).toEqual({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: root.id,
      rootAttemptCount: root.attemptCount, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    })
    await expect(assembly.readCandidate({ store: candidateStore, owner, executionOwner })).resolves.toEqual(recoveredCandidate)
    expect(candidateStore.read).toHaveBeenCalledWith({ owner: executionOwner, rootAttemptCount: root.attemptCount })

    expect(assembly.owner({ taskGraphPlanningEnabled: true, state: { ...scheduledState, automationRunMode: "manual" }, lease, root })).toBeUndefined()
    expect(assembly.owner({ taskGraphPlanningEnabled: false, state: scheduledState, lease, root })).toBeUndefined()
  })

  it("keeps persisted bridge reads inside the user-scoped transaction", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values })
        return { rows: [], rowCount: 0 }
      }),
      release: vi.fn(),
    }
    const database = { connect: vi.fn(async () => client) } as unknown as pg.Pool
    const assembly = createCanonicalTurnScheduledPipeline(database)

    await expect(assembly.bridge({
      userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: root.id,
      rootAttemptCount: root.attemptCount, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    })).resolves.toEqual({ status: "blocked", reasonCode: "canonical_evidence_unavailable" })

    expect(calls[0]?.sql).toBe("BEGIN")
    expect(calls[1]).toEqual({ sql: "SELECT set_config($1, $2, true)", values: ["app.user_id", lease.userId] })
    expect(calls.some(call => call.sql.includes('FROM "agent_turns"') && call.values?.join(",") === "turn-1,session-1,user-1")).toBe(true)
    expect(calls.some(call => call.sql.includes('FROM "sub_agent_tasks"') && call.values?.join(",") === "root-1,session-1,turn-1,user-1")).toBe(true)
    expect(calls.at(-1)?.sql).toBe("ROLLBACK")
    expect(client.release).toHaveBeenCalledOnce()
  })
})
