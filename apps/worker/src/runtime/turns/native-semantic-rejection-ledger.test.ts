import { describe, expect, it } from "vitest"

import { nativeSemanticCheckpoint, parseNativeSemanticRejectionIdentity, readNativeSemanticRejectionsWithClient } from "./native-semantic-rejection-ledger.js"
import type { TurnEngineQueryClient } from "./turn-engine-owner-sql.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"

const identity = {
  candidateDigest: "a".repeat(64),
  controlTaskId: "control-task",
  controlOperationId: "operation-1",
  controlAttempt: 2,
  controlReportDigest: "b".repeat(64),
}
const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user", sessionId: "session", turnId: "turn", taskId: "root", rootTaskId: "root",
  ownerId: "lease", leaseVersion: 1, leaseExpiresAt: new Date("2030-01-01T00:00:00Z"),
}

function readClient(options: { status?: string; sequence?: unknown; steps?: readonly string[] } = {}) {
  const calls: { sql: string; values?: readonly unknown[] }[] = []
  const query = async (sql: string, values?: readonly unknown[]) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session" }], rowCount: 1 }
    if (sql.startsWith('SELECT turn."id"')) return { rows: [{ id: "turn" }], rowCount: 1 }
    if (sql.includes("to_jsonb(turn)")) return { rows: [{ mode: "durable_v1" }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: [{ taskId: "root", attempt: 1, status: options.status ?? "streaming", inputThroughSequence: options.sequence ?? "9007199254740993" }], rowCount: 1 }
    return { rows: (options.steps ?? ["step-1", "step-2", "step-3"]).map(stepId => ({ stepId })), rowCount: 3 }
  }
  return { calls, client: { query } as unknown as TurnEngineQueryClient }
}

describe("native semantic rejection identity", () => {
  it("accepts only the exact bounded server receipt identity", () => {
    expect(parseNativeSemanticRejectionIdentity(identity)).toEqual(identity)
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlTaskId: "任".repeat(130) })).not.toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, extra: "model field" })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlTaskId: ` ${identity.controlTaskId}` })).toBeNull()
  })

  it("rejects malformed hashes and nonpositive or unsafe control attempts", () => {
    expect(parseNativeSemanticRejectionIdentity({ ...identity, candidateDigest: "A".repeat(64) })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlReportDigest: "short" })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlAttempt: 0 })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlAttempt: Number.MAX_SAFE_INTEGER + 1 })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlTaskId: 123 })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlOperationId: null })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity({ ...identity, controlReportDigest: 5 })).toBeNull()
    expect(parseNativeSemanticRejectionIdentity([])).toBeNull()
    expect(parseNativeSemanticRejectionIdentity(null)).toBeNull()
  })

  it("bounds bigint and decimal-string checkpoints to PostgreSQL int64", () => {
    const maximum = 9_223_372_036_854_775_807n
    expect(nativeSemanticCheckpoint(maximum)).toBe(maximum)
    expect(nativeSemanticCheckpoint(maximum.toString())).toBe(maximum)
    expect(() => nativeSemanticCheckpoint(maximum + 1n)).toThrow(/input checkpoint is invalid/)
    expect(() => nativeSemanticCheckpoint((maximum + 1n).toString())).toThrow(/input checkpoint is invalid/)
  })

  it("reads at most three completed exact-identity rejections without losing bigint checkpoints", async () => {
    const mock = readClient()
    const history = await readNativeSemanticRejectionsWithClient(mock.client, { owner, stepId: "current", identity })
    expect(history).toEqual({ inputThroughSequence: 9007199254740993n, stepIds: ["step-1", "step-2", "step-3"] })
    const lookup = mock.calls.at(-1)!
    expect(lookup.sql).toContain('"status" = \'completed\'')
    expect(lookup.sql).toContain("LIMIT 3")
    expect(lookup.values).toEqual(["user", "session", "turn", "root", "9007199254740993", identity.candidateDigest,
      identity.controlTaskId, identity.controlOperationId, identity.controlAttempt, identity.controlReportDigest])
  })

  it("rejects child, completed, or malformed current Step state", async () => {
    await expect(readNativeSemanticRejectionsWithClient(readClient().client, {
      owner: { ...owner, taskId: "child" }, stepId: "current", identity,
    })).rejects.toMatchObject({ code: "persistence_conflict" })
    await expect(readNativeSemanticRejectionsWithClient(readClient({ status: "completed" }).client, { owner, stepId: "current", identity }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
    await expect(readNativeSemanticRejectionsWithClient(readClient({ sequence: "01" }).client, { owner, stepId: "current", identity }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
  })
})
