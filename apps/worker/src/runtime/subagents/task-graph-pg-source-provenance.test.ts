import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, taskGraphProposalKey } from "./task-graph-snapshot.js"
import {
  loadTaskGraphSourceProvenance, parseTaskGraphSourceCheckpoint, taskGraphCurrentStepCheckpoint,
  taskGraphInputRelation, taskGraphProposalCausationByNodeKey, taskGraphSourceStepCheckpoint,
  type TaskGraphSourceStepExpectation,
} from "./task-graph-pg-source-provenance.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const graphItem = { id: taskGraphItemId(scope.rootTaskId), revision: 1 }
const node = { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Analyze the match", successCriteria: ["Report evidence"], dependsOn: [], depth: 1 }
const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [node] })
const expected: TaskGraphSourceStepExpectation = { ...scope, stepId: "source-step", attempt: 1 }

function proposalEvent(overrides: Record<string, unknown> = {}) {
  const payload = {
    kind: "proposal", fingerprint: "a".repeat(64), revision: 1,
    receipt: { status: "accepted", revision: 1, nodes: [{ key: node.key, taskId: node.taskId, status: "queued" }], readyTaskIds: [node.taskId] },
    item: { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: graphItem.id, sessionId: scope.sessionId, turnId: scope.turnId,
      stepId: "source-step", taskId: scope.parentTaskId, type: "task_graph", status: "streaming", phase: null,
      revision: 1, content: snapshot, startedAt: "2026-10-19T00:00:00.000Z", completedAt: null,
      createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" },
  }
  return { type: "item.started", itemId: graphItem.id, taskId: scope.parentTaskId,
    idempotencyKey: taskGraphProposalKey(scope.parentTaskId, 0), actor: "orchestrator",
    correlationId: scope.turnId, causationId: "source-step", payload, ...overrides }
}

function stepRow(id: string, overrides: Record<string, unknown> = {}) {
  return { id, userId: scope.userId, turnUserId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, taskId: scope.parentTaskId, status: "completed", attempt: 1,
    inputThroughSequence: "4", consumedInputIds: [], sessionEventSequence: "5", checkpointInputsValid: true, hasPendingAcceptedInputs: false,
    isDiscoveredCurrent: false, isExplicitCurrent: false, activeCount: 1, ...overrides }
}

describe("TaskGraph persisted source provenance", () => {
  it("accepts only bounded, canonical input checkpoints", () => {
    expect(parseTaskGraphSourceCheckpoint("7", ["input-1"])).toEqual({ inputThroughSequence: 7n })
    expect(parseTaskGraphSourceCheckpoint(0, [])).toEqual({ inputThroughSequence: 0n })
    for (const value of ["-1", "01", "1.0", "9223372036854775808", Number.MAX_SAFE_INTEGER + 1, null]) {
      expect(parseTaskGraphSourceCheckpoint(value, [])).toBeNull()
    }
    expect(parseTaskGraphSourceCheckpoint("4", ["same", "same"])).toBeNull()
    expect(parseTaskGraphSourceCheckpoint("4", [{ id: "not-an-id" }])).toBeNull()
    expect(parseTaskGraphSourceCheckpoint("4", Array.from({ length: 257 }, (_, index) => `input-${index}`))).toBeNull()
    const sparse = new Array(1)
    expect(parseTaskGraphSourceCheckpoint("4", sparse)).toBeNull()
  })

  it("classifies only exact persisted cursor order and leaves missing or impossible cursors unknown", () => {
    const source = { inputThroughSequence: 4n }, current = { inputThroughSequence: 5n }
    expect(taskGraphInputRelation(source, current)).toBe("predates_current_inputs")
    expect(taskGraphInputRelation(current, current)).toBe("covers_current_inputs")
    expect(taskGraphInputRelation({ inputThroughSequence: 6n }, current)).toBe("unknown")
    expect(taskGraphInputRelation(source, null)).toBe("unknown")
  })

  it("binds accepted proposal receipts to their server-owned causation Step only", () => {
    const event = proposalEvent()
    expect(taskGraphProposalCausationByNodeKey([event], graphItem, snapshot, scope).get(node.key)).toBe("source-step")
    expect(taskGraphProposalCausationByNodeKey([proposalEvent({ actor: "model" })], graphItem, snapshot, scope).get(node.key)).toBeNull()
    expect(taskGraphProposalCausationByNodeKey([proposalEvent({ correlationId: "other-turn" })], graphItem, snapshot, scope).get(node.key)).toBeNull()
    expect(taskGraphProposalCausationByNodeKey([proposalEvent({ causationId: "other-step" })], graphItem, snapshot, scope).get(node.key)).toBeNull()
    const malformed = proposalEvent()
    ;(malformed.payload as { receipt: { status: string } }).receipt.status = "bad"
    expect(taskGraphProposalCausationByNodeKey([malformed], graphItem, snapshot, scope).get(node.key)).toBeUndefined()
    expect(taskGraphProposalCausationByNodeKey([event, event], graphItem, snapshot, scope).get(node.key)).toBeNull()
  })

  it("rejects Step checkpoint rows that fail scope, durable-input, status, attempt, or pending-input checks", () => {
    const valid = stepRow(expected.stepId)
    expect(taskGraphSourceStepCheckpoint(valid, expected)).toEqual({ inputThroughSequence: 4n })
    for (const invalid of [
      stepRow("other-step"),
      stepRow(expected.stepId, { userId: "other-user" }),
      stepRow(expected.stepId, { turnUserId: "other-turn-user" }),
      stepRow(expected.stepId, { sessionId: "other-session" }),
      stepRow(expected.stepId, { turnId: "other-turn" }),
      stepRow(expected.stepId, { rootTaskId: "other-root" }),
      stepRow(expected.stepId, { taskId: "other-parent" }),
      stepRow(expected.stepId, { attempt: 2 }),
    ]) expect(taskGraphSourceStepCheckpoint(invalid, expected)).toBeNull()
    expect(taskGraphSourceStepCheckpoint(stepRow(expected.stepId, { checkpointInputsValid: false }), expected)).toBeNull()
    expect(taskGraphSourceStepCheckpoint(stepRow(expected.stepId, { sessionEventSequence: "3" }), expected)).toBeNull()
    expect(taskGraphCurrentStepCheckpoint({ ...valid, status: "completed" }, { ...expected, attempt: 1 })).toBeNull()
    expect(taskGraphCurrentStepCheckpoint({ ...valid, attempt: 2 }, { ...expected, attempt: 1 })).toBeNull()
    expect(taskGraphCurrentStepCheckpoint({ ...valid, hasPendingAcceptedInputs: true, status: "streaming" }, { ...expected, attempt: 1 })).toBeNull()
    expect(taskGraphCurrentStepCheckpoint({ ...valid, status: "streaming" }, { ...expected, attempt: 1 })).toEqual({ inputThroughSequence: 4n })
    expect(taskGraphCurrentStepCheckpoint({ ...valid, status: "streaming", inputThroughSequence: "6" }, { ...expected, attempt: 1 })).toBeNull()
  })

  it("loads source and unique current Step checkpoints in one exact-scope batch query", async () => {
    const current = stepRow("current-step", { status: "streaming", inputThroughSequence: "5", isDiscoveredCurrent: true })
    const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({ rows: [stepRow("source-step"), current], rowCount: 2 }))
    const loaded = await loadTaskGraphSourceProvenance({ query } as unknown as Pick<pg.PoolClient, "query">, scope, graphItem, snapshot, [proposalEvent()], { discoverCurrentStep: true })

    expect(query).toHaveBeenCalledTimes(1)
    const [sql, values] = query.mock.calls[0] as unknown as [string, readonly unknown[]]
    expect(sql).toContain('step."taskId" = $4')
    expect(sql).toContain('turn."rootTaskId" = $5')
    expect(sql).toContain('session."eventSequence" AS "sessionEventSequence"')
    expect(sql).toContain('session."userId" = $6 AND turn."userId" = $6')
    expect(sql).toContain('input."status" IN (\'accepted\', \'queued\')')
    expect(sql).toContain('input."consumedByStepId" = step."id"')
    expect(sql).toContain('input."cancelledAt" IS NULL')
    expect(sql).not.toContain("input.\"delivery\" = 'follow_up' OR input.\"consumedByStepId\"")
    expect(sql).toContain('input."acceptedSequence" > step."inputThroughSequence" OR NOT EXISTS')
    expect(sql).toContain('checkpoint_id."value" = input."id"')
    expect(sql).toContain('input."consumedByStepId" IS DISTINCT FROM step."id"')
    expect(sql).toContain('input."delivery" <> \'follow_up\' OR NOT EXISTS')
    expect(sql).toContain('prior_step."id" = input."consumedByStepId"')
    expect(sql).toContain('prior_step."ordinal" < step."ordinal"')
    expect(sql).toContain('prior_step."inputThroughSequence" <= session."eventSequence"')
    expect(sql).toContain('prior_id."value" #>> \'{}\' = input."id"')
    expect(sql).toContain("WHERE $8::boolean")
    expect(sql).not.toMatch(/\$9::/)
    const pendingInputStart = sql.indexOf('input."status" IN (\'accepted\', \'queued\')')
    const pendingInputQuery = sql.slice(sql.lastIndexOf("EXISTS (", pendingInputStart), sql.indexOf(') AS "hasPendingAcceptedInputs"', pendingInputStart))
    expect(pendingInputQuery).not.toMatch(/consumedByStepId|consumedAt/)
    expect(sql).not.toContain('input."content"')
    expect(values).toEqual([["source-step"], scope.sessionId, scope.turnId, scope.parentTaskId, scope.rootTaskId, scope.userId, null, true])
    expect(loaded.sourceInputCheckpointByNodeKey.get(node.key)).toEqual({ inputThroughSequence: 4n })
    expect(loaded.currentInputCheckpoint).toEqual({ inputThroughSequence: 5n })
    expect(loaded.sourceInputRelationByNodeKey.get(node.key)).toBe("predates_current_inputs")
  })

  it("uses the explicitly supplied root Step attempt and leaves checkpoint ownership exact", async () => {
    const currentStepId = "current-step"
    const current = stepRow(currentStepId, { status: "streaming", attempt: 1, isExplicitCurrent: true })
    const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>>(
      async () => ({ rows: [stepRow("source-step"), current], rowCount: 2 }),
    )
    const loaded = await loadTaskGraphSourceProvenance({ query } as unknown as Pick<pg.PoolClient, "query">, scope, graphItem, snapshot, [proposalEvent()], {
      currentStepId, currentStepAttempt: 1,
    })
    const values = query.mock.calls[0]?.[1]
    expect(values?.slice(6)).toEqual([currentStepId, false])
    expect(loaded.currentInputCheckpoint).toEqual({ inputThroughSequence: 4n })
    expect(loaded.sourceInputRelationByNodeKey.get(node.key)).toBe("covers_current_inputs")
  })

  it("keeps relation unknown when the active Step is ambiguous or accepted inputs remain unclaimed", async () => {
    for (const currentRows of [
      [stepRow("current-a", { status: "streaming", isDiscoveredCurrent: true, activeCount: 2 }), stepRow("current-b", { status: "streaming", isDiscoveredCurrent: true, activeCount: 2 })],
      [stepRow("current-step", { status: "streaming", isDiscoveredCurrent: true, hasPendingAcceptedInputs: true })],
    ]) {
      const query = vi.fn(async () => ({ rows: [stepRow("source-step"), ...currentRows], rowCount: 1 + currentRows.length }))
      const loaded = await loadTaskGraphSourceProvenance({ query } as unknown as Pick<pg.PoolClient, "query">, scope, graphItem, snapshot, [proposalEvent()], { discoverCurrentStep: true })
      expect(loaded.currentInputCheckpoint).toBeNull()
      expect(loaded.sourceInputRelationByNodeKey.get(node.key)).toBe("unknown")
    }
  })
})
