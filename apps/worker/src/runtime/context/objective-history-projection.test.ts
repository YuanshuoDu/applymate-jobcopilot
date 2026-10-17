import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { rootTaskHistoryObjectiveDigest, rootTaskHistoryOrigin } from "./root-task-history-fence.js"
import { updateRootObjectiveHistoryProjection, type RootObjectiveHistoryIdentity } from "./objective-history-projection.js"

const identity: RootObjectiveHistoryIdentity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const goal = "Find senior platform roles"
const criteria = ["Use the saved EU locations"]
const requirements = { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [
  { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
] }

type Call = Readonly<{ sql: string; values?: unknown[] }>
function clientWith(...responses: { rows?: Record<string, unknown>[]; rowCount: number }[]) {
  const calls: Call[] = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    const response = responses.shift()
    if (!response) throw new Error("unexpected projection query")
    return { rows: response.rows ?? [], rowCount: response.rowCount }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, calls, query }
}

function turnRow(input: unknown, overrides: Record<string, unknown> = {}) {
  return { input, source: "user", goal, successCriteria: criteria, ...overrides }
}

function terminalRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: identity.sessionId, turnId: identity.turnId, turnStatus: "in_progress", rootStatus: "running",
    terminalTaskId: identity.rootTaskId, terminalItemId: null, terminalSequence: "99", terminalType: "turn.failed",
    terminalActor: "orchestrator", terminalCorrelationId: identity.turnId,
    terminalIdempotencyKey: "turn:" + identity.turnId + ":event:turn-failed:provider_error",
    terminalPayload: { turnId: identity.turnId, taskId: identity.rootTaskId, errorCode: "provider_error", finalItemId: null },
    terminalAt: new Date("2026-10-16T12:00:00.123Z"), terminalCount: "1",
    startTurnId: identity.turnId, startTaskId: identity.rootTaskId, startItemId: null, startSequence: "80",
    startType: "turn.started", startActor: "orchestrator", startCorrelationId: identity.turnId,
    startIdempotencyKey: "turn:" + identity.turnId + ":event:turn-started", startPayload: { taskId: identity.rootTaskId, rootTaskId: identity.rootTaskId }, startCount: "1",
    ...overrides,
  }
}

describe("objective history projection", () => {
  it("stores the same-session digest and versioned cross-session objective plus canonical origin", async () => {
    const input = { input: { goal, successCriteria: criteria, verificationRequirements: requirements,
      intent: { kind: "interactive_discovery_shortlist", version: 1 } } }
    const root = { goal, successCriteria: criteria }
    const origin = rootTaskHistoryOrigin("user", input)!
    const crossSessionDigest = rootTaskHistoryObjectiveDigest(input, root, true)!
    const expectedOriginDigest = createHash("sha256")
      .update(JSON.stringify({ objectiveDigest: crossSessionDigest, canonicalOrigin: origin })).digest("hex")
    const { client, calls } = clientWith({ rows: [turnRow(input)], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[0]?.sql).toContain("FOR UPDATE OF turn, root")
    expect(calls[1]?.values).toEqual([
      rootTaskHistoryObjectiveDigest(input, root, false), expectedOriginDigest, 1,
      identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId,
    ])
    expect(calls[1]?.sql).not.toContain("terminalEvent")
  })

  it("keeps the same-session key but leaves cross-session indexing unavailable for invalid verification requirements", async () => {
    const input = { goal, successCriteria: criteria, verificationRequirements: { schemaVersion: "unknown", requirements: [] } }
    const { client, calls } = clientWith({ rows: [turnRow(input)], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[1]?.values).toEqual([rootTaskHistoryObjectiveDigest(input, { goal, successCriteria: criteria }), null, 1,
      identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId])
  })

  it("clears all objective keys when the persisted Turn and Root objectives conflict", async () => {
    const input = { goal, successCriteria: criteria }
    const { client, calls } = clientWith({ rows: [turnRow(input, { goal: "A conflicting root goal" })], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[1]?.values?.slice(0, 3)).toEqual([null, null, null])
  })

  it("stores the exact eligible Root-owned failed receipt sequence and time", async () => {
    const at = new Date("2026-10-16T12:00:00.123Z")
    const { client, calls } = clientWith({ rows: [terminalRow({ terminalAt: at })], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: "event-failed" })).resolves.toBe(true)

    expect(calls[0]?.sql).toContain('event."taskId" = turn."rootTaskId"')
    expect(calls[1]?.values).toEqual(["99", at, identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId, "in_progress"])
  })

  it("validates a completed receipt against its persisted start and completed-step receipt", async () => {
    const stepId = "step-1"
    const completed = terminalRow({
      turnStatus: "completed", rootStatus: "completed", terminalItemId: "final-1", terminalSequence: "110",
      terminalType: "turn.completed", terminalCorrelationId: stepId,
      terminalIdempotencyKey: "turn:" + identity.turnId + ":event:turn-completed",
      terminalPayload: { turnId: identity.turnId, taskId: identity.rootTaskId, finalItemId: "final-1" },
      startSequence: "100", stepId, stepSessionId: identity.sessionId, stepTurnId: identity.turnId,
      stepTaskId: identity.rootTaskId, stepStatus: "completed", stepEventSessionId: identity.sessionId,
      stepEventTurnId: identity.turnId, stepEventTaskId: identity.rootTaskId, stepEventItemId: null,
      stepEventSequence: "105", stepEventType: "step.completed", stepEventActor: "orchestrator",
      stepEventCorrelationId: stepId, stepEventIdempotencyKey: "turn:" + identity.turnId + ":event:step-completed:" + stepId,
      stepPayload: { stepId, status: "completed", taskId: identity.rootTaskId }, stepEventCount: "1",
    })
    const { client, calls } = clientWith({ rows: [completed], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: "event-completed" })).resolves.toBe(true)

    expect(calls[1]?.values?.slice(0, 2)).toEqual(["110", completed.terminalAt])
  })

  it("rejects a completed event while the linked Root and Turn are still active", async () => {
    const activeCompletion = terminalRow({ terminalType: "turn.completed", terminalSequence: "110" })
    const { client, calls } = clientWith({ rows: [activeCompletion], rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: "premature-completion" })).resolves.toBe(false)

    expect(calls).toHaveLength(1)
  })

  it("excludes taskId-null interruption receipts and never writes a locator for them", async () => {
    const { client, calls } = clientWith({ rowCount: 0 })

    await expect(updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: "null-task-interruption" })).resolves.toBe(false)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.sql).toContain('event."taskId" = turn."rootTaskId"')
  })

  it("rejects ambiguous terminal receipts and malformed identities", async () => {
    const { client, calls } = clientWith({ rows: [terminalRow({ terminalCount: "2" })], rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: "duplicate" })).resolves.toBe(false)
    await expect(updateRootObjectiveHistoryProjection(client, null as never)).resolves.toBe(false)

    expect(calls).toHaveLength(1)
  })
})
