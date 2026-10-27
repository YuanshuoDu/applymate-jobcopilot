import { describe, expect, it, vi } from "vitest"
import { scheduledGateRegistrationReceiptKey } from "./scheduled-gate-registration-receipt.js"
import { lockScheduledGateFinish } from "./pg-store-gate-finish.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 0 }
const continuationKey = `scheduled-taskgraph:sha256:${"a".repeat(64)}`
const receipt = { schemaVersion: "agent-harness.v2.scheduled-taskgraph-gate-binding.v1", owner, continuationKey,
  snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
  analyzeGraphRevision: 10, prepareScheduleRevision: 11, prepareWaitId: "prepare-wait", gateTaskId: "gate-1", gateAppendRevision: 12 }

function database() {
  const calls: string[] = []
  const client = { query: vi.fn(async (sql: string) => {
    calls.push(sql)
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
    if (sql.includes('"parentTaskId" IS NULL')) return { rows: [{ id: "root-1" }], rowCount: 1 }
    if (sql.includes('"taskType" = $6')) return { rows: [{ id: "gate-1" }], rowCount: 1 }
    if (sql.includes('SELECT "payload" FROM "agent_events"')) return { rows: [{ payload: receipt }], rowCount: 1 }
    if (sql.includes('SELECT event."itemId"')) return { rows: [{ itemId: null, taskId: null, actor: "system",
      idempotencyKey: scheduledGateRegistrationReceiptKey(continuationKey, "gate-1"), payload: receipt, hasOutbox: false }], rowCount: 1 }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: "execution-1" }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }) }
  return { calls, client }
}

describe("lockScheduledGateFinish", () => {
  it("rejects a non-child Gate before issuing queries", async () => {
    const { calls, client } = database()
    await expect(lockScheduledGateFinish(client as never, { userId: "user-1", turnId: "turn-1", rootTaskId: "root-1",
      parentTaskId: null, role: "prepare" }, { taskId: "gate-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1 }))
      .resolves.toBe(false)
    expect(calls).toHaveLength(0)
  })

  it("locks and validates the registered Gate with a database-clock deadline fence", async () => {
    const { calls, client } = database()
    await expect(lockScheduledGateFinish(client as never, { userId: "user-1", turnId: "turn-1", rootTaskId: "root-1",
      parentTaskId: "root-1", role: "prepare" }, { taskId: "gate-1", sessionId: "session-1", ownerId: "worker-1", attemptCount: 1 }))
      .resolves.toBe(true)
    const gate = calls.find(sql => sql.includes('"taskType" = $6')) ?? ""
    expect(gate).toContain('"absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp()')
    expect(gate).toContain('"leaseExpiresAt" > clock_timestamp()')
  })
})
