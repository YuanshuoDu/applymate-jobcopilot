import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { rootTaskHistoryObjectiveDigest, rootTaskHistoryOrigin } from "./root-task-history-fence.js"
import {
  OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, projectRootObjectiveHistoryForBackfill,
  isValidRootObjectiveHistoryTerminalReceipt, updateRootObjectiveHistoryProjection, type RootObjectiveHistoryIdentity,
} from "./objective-history-projection.js"

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
    const objectiveDigest = rootTaskHistoryObjectiveDigest(input, root)!
    const expectedOriginDigest = createHash("sha256")
      .update(JSON.stringify({ objectiveDigest, canonicalOrigin: origin })).digest("hex")
    const { client, calls } = clientWith({ rows: [turnRow(input)], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[0]?.sql).toContain("FOR UPDATE OF turn, root")
    expect(calls[1]?.values).toEqual([
      objectiveDigest, expectedOriginDigest, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION,
      identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId,
    ])
    expect(calls[1]?.sql).not.toContain("terminalEvent")
  })

  it("marks selected-job-scoped Turn input evaluated while leaving its objective keys unavailable", async () => {
    const input = { input: { goal, successCriteria: criteria, selectedJobPreparation: { selectedJobId: "job-1" } } }
    expect(rootTaskHistoryObjectiveDigest(input, { goal, successCriteria: criteria })).toBeDefined()
    const { client, calls } = clientWith({ rows: [turnRow(input)], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[1]?.values?.slice(0, 3)).toEqual([null, null, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
  })

  it("returns evaluated-unindexable for unsupported objectives and marks their semantics version", async () => {
    const input = { goal, successCriteria: criteria }
    const expected = { inputJsonbText: JSON.stringify(input), source: "user", goal: "A conflicting root goal",
      successCriteriaJsonbText: JSON.stringify(criteria) }
    const { client, calls } = clientWith({ rows: [turnRow(input, { goal: expected.goal })], rowCount: 1 }, { rowCount: 1 })

    await expect(projectRootObjectiveHistoryForBackfill(client, identity, expected)).resolves.toEqual({
      kind: "evaluated_unindexable", objectiveDigest: null, canonicalOriginDigest: null,
      semanticsVersion: OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION, reason: "unsupported_or_invalid_objective",
    })

    expect(calls[1]?.values?.slice(0, 3)).toEqual([null, null, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
  })

  it("returns retryable conflict when a persisted objective no longer matches the scanned snapshot", async () => {
    const expected = { inputJsonbText: JSON.stringify({ goal }), source: "user", goal,
      successCriteriaJsonbText: JSON.stringify(criteria) }
    const { client, calls } = clientWith({ rowCount: 0 })

    await expect(projectRootObjectiveHistoryForBackfill(client, identity, expected)).resolves.toEqual({
      kind: "retryable_conflict", reason: "persisted_input_changed",
    })

    expect(calls[0]?.sql).toContain('turn."input" IS NOT DISTINCT FROM $5::jsonb')
    expect(calls).toHaveLength(1)
  })

  it("binds raw expected JSONB snapshot text without rounding large numbers", async () => {
    const parsedInput = { input: { goal, successCriteria: criteria, intent: { kind: "interactive_discovery_shortlist", version: 1 } } }
    const inputJsonbText = '{"input":{"goal":"Find senior platform roles","successCriteria":["Use the saved EU locations"],"intent":{"kind":"interactive_discovery_shortlist","version":1},"ignoredNumeric":9007199254740993}}'
    const successCriteriaJsonbText = '["Use the saved EU locations"]'
    const expected = { inputJsonbText, source: "user", goal, successCriteriaJsonbText }
    const { client, calls } = clientWith(
      { rows: [turnRow(parsedInput)], rowCount: 1 },
      { rowCount: 1 },
    )

    await expect(projectRootObjectiveHistoryForBackfill(client, identity, expected)).resolves.toMatchObject({
      kind: "evaluated_indexable",
    })

    expect(calls[0]?.values).toEqual([
      identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId,
      inputJsonbText, expected.source, expected.goal, successCriteriaJsonbText,
    ])
    expect(calls[1]?.values?.slice(7)).toEqual([
      inputJsonbText, expected.source, expected.goal, successCriteriaJsonbText,
    ])
  })

  it("preserves SQL NULL and JSONB null as distinct snapshot binds", async () => {
    const expected = { inputJsonbText: null, source: "user", goal, successCriteriaJsonbText: "null" }
    const input = { input: { goal, successCriteria: criteria } }
    const { client, calls } = clientWith({ rows: [turnRow(input)], rowCount: 1 }, { rowCount: 1 })

    await projectRootObjectiveHistoryForBackfill(client, identity, expected)

    expect(calls[0]?.values).toEqual([
      identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId, null, "user", goal, "null",
    ])
    expect(calls[1]?.values?.slice(7)).toEqual([null, "user", goal, "null"])
  })

  it("reports an unlinked Root/Turn pair as ineligible and preserves the existing boolean writer API", async () => {
    const { client, calls } = clientWith({ rowCount: 0 }, { rowCount: 0 }, { rowCount: 0 })

    await expect(projectRootObjectiveHistoryForBackfill(client, identity, {
      inputJsonbText: "{}", source: "user", goal, successCriteriaJsonbText: JSON.stringify(criteria),
    })).resolves.toEqual({ kind: "retryable_conflict", reason: "persisted_input_changed" })
    await expect(projectRootObjectiveHistoryForBackfill(client, identity)).resolves.toEqual({
      kind: "ineligible", reason: "unlinked_root_turn",
    })
    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(false)

    expect(calls).toHaveLength(3)
  })

  it("leaves both same-session and cross-session indexing unavailable for invalid requirements", async () => {
    const input = { goal, successCriteria: criteria, verificationRequirements: { schemaVersion: "unknown", requirements: [] } }
    const { client, calls } = clientWith({ rows: [turnRow(input)], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[1]?.values).toEqual([null, null, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION,
      identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId])
  })

  it("clears all objective keys when the persisted Turn and Root objectives conflict", async () => {
    const input = { goal, successCriteria: criteria }
    const { client, calls } = clientWith({ rows: [turnRow(input, { goal: "A conflicting root goal" })], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity)).resolves.toBe(true)

    expect(calls[1]?.values?.slice(0, 3)).toEqual([null, null, OBJECTIVE_HISTORY_INDEX_SEMANTICS_VERSION])
  })

  it("stores the exact eligible Root-owned failed receipt sequence and time", async () => {
    const at = new Date("2026-10-16T12:00:00.123Z")
    const { client, calls } = clientWith({ rows: [terminalRow({ terminalAt: at })], rowCount: 1 }, { rowCount: 1 })

    await expect(updateRootObjectiveHistoryProjection(client, identity, { terminalEventId: "event-failed" })).resolves.toBe(true)

    expect(calls[0]?.sql).toContain('event."taskId" = turn."rootTaskId"')
    expect(calls[1]?.values).toEqual(["99", at, identity.turnId, identity.sessionId, identity.userId, identity.rootTaskId, "in_progress"])
  })

  it("validates an existing terminal receipt without rewriting its locator", async () => {
    const { client, calls } = clientWith({ rows: [terminalRow()], rowCount: 1 })

    await expect(isValidRootObjectiveHistoryTerminalReceipt(client, identity, "event-failed")).resolves.toBe(true)
    expect(calls).toHaveLength(1)
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
