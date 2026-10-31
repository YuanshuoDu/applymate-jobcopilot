import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { emptyAnalystCoverageDigest, hasNoCurrentAttemptTaskGraphToolReceipts } from "./task-graph-empty-analyst-proof.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import type { TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"

const scope: TaskGraphVerificationScope = {
  userId: "user-private", sessionId: "session-private", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", taskId: "analyst-task-private", attemptCount: 2,
}
const digest = "a".repeat(64)
const binding = (nodeKey: string): TaskGraphVerificationDependencyBinding => ({
  nodeKey, taskId: `${nodeKey}-private`, attemptCount: 1,
  nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest,
})
const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
  { key: "scout-a", templateId: "scout", goal: "Find A", successCriteria: ["Find"], dependsOn: [], depth: 1,
    taskId: "scout-a-private", verificationDisposition: "typed", verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }],
    } },
  { key: "scout-b", templateId: "scout", goal: "Find B", successCriteria: ["Find"], dependsOn: [], depth: 1,
    taskId: "scout-b-private", verificationDisposition: "typed", verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }],
    } },
  { key: "analyst", templateId: "analyst", goal: "Analyze", successCriteria: ["Analyze"], dependsOn: ["scout-a", "scout-b"], depth: 2,
    taskId: scope.taskId, verificationDisposition: "typed", verification: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "coverage", check: {
        kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 50,
      } }],
    } },
] })

describe("empty Analyst coverage proof", () => {
  it("domain-separates and binds the stable Analyst node, result, scope, no-receipt assertion, and every source", () => {
    const input = {
      scope, node: snapshot.nodes[2]!, resultDigest: digest,
      dependencyNodeKeys: ["scout-b", "scout-a"], dependencyBindings: [binding("scout-b"), binding("scout-a")],
    }
    const first = emptyAnalystCoverageDigest(input)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(emptyAnalystCoverageDigest({ ...input, dependencyBindings: [...input.dependencyBindings].reverse() })).toBe(first)
    expect(emptyAnalystCoverageDigest({ ...input, node: { ...input.node, goal: "Changed Analyst contract" } })).not.toBe(first)
    expect(emptyAnalystCoverageDigest({ ...input, resultDigest: "b".repeat(64) })).not.toBe(first)
    expect(emptyAnalystCoverageDigest({ ...input, scope: { ...scope, attemptCount: 3 } })).not.toBe(first)
    expect(emptyAnalystCoverageDigest({ ...input, dependencyBindings: [binding("scout-a")] })).toBeUndefined()
    expect(emptyAnalystCoverageDigest({ ...input, dependencyNodeKeys: ["scout-a", "scout-a"] })).toBeUndefined()
  })

  it("attributes tool events through exact current-attempt item and call IDs without claiming unrelated turn events", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(values?.[0]).toBe(scope.taskId)
      expect(values?.[6]).toBe(scope.attemptCount)
      if (sql.startsWith('SELECT item."id" FROM "agent_steps" AS step')) {
        expect(sql).toContain('step."taskId" = $1')
        expect(sql).toContain('step."attempt" = $7')
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_items" AS item')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_events" AS event')) {
        expect(sql).toContain("task_attempt_items AS")
        expect(sql).toContain("WITH task_attempt_steps AS")
        expect(sql).toContain("task_attempt_items AS")
        expect(sql).toContain("current_attempt_items AS")
        expect(sql).toContain('step."taskId" = $1')
        expect(sql).toContain('item."attempt" = $7')
        expect(sql).toContain('item."attempt" < $7')
        expect(sql).toContain("prior_step_boundaries AS")
        expect(sql).toContain("step-started:' || step.\"id\"")
        expect(sql).toContain("step-completed:' || step.\"id\"")
        expect(sql).toContain('event."sequence" > boundary."startSequence" AND event."sequence" < boundary."closeSequence"')
        expect(sql).toContain("tool-lifecycle:' || prior.\"toolCallId\"")
        expect(sql).toContain('event."correlationId" IN')
        expect(sql).toContain('event."payload"->>\'toolCallId\' IN')
        expect(sql).toContain('event."taskId" = $1 AND NOT EXISTS')
        expect(sql).toContain('event."itemId" = prior."id"')
        expect(sql).not.toContain('event."itemId" IS NULL OR')
        return { rows: [], rowCount: 0 }
      }
      throw new Error("unexpected_empty_analyst_receipt_query")
    })
    expect(await hasNoCurrentAttemptTaskGraphToolReceipts({ query } as unknown as Pick<pg.PoolClient, "query">, scope)).toBe(true)
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls[2]?.[0]).toContain('event."itemId" IN')

    const withCurrentNullTaskItem = vi.fn(async (sql: string) => sql.includes('FROM "agent_steps" AS step')
      ? { rows: [{ id: "current-attempt-item-with-null-task" }], rowCount: 1 } : { rows: [], rowCount: 0 })
    expect(await hasNoCurrentAttemptTaskGraphToolReceipts({ query: withCurrentNullTaskItem } as unknown as Pick<pg.PoolClient, "query">, scope)).toBe(false)

    const withCurrentNullTaskEvent = vi.fn(async (sql: string) => sql.includes('FROM "agent_events" AS event') && sql.includes('event."correlationId" IN')
      ? { rows: [{ id: "current-attempt-event-with-null-task" }], rowCount: 1 } : { rows: [], rowCount: 0 })
    expect(await hasNoCurrentAttemptTaskGraphToolReceipts({ query: withCurrentNullTaskEvent } as unknown as Pick<pg.PoolClient, "query">, scope)).toBe(false)

    const withUnrelatedTaskEvent = vi.fn(async (sql: string) => sql.includes('FROM "agent_events" AS event')
      ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 0 })
    expect(await hasNoCurrentAttemptTaskGraphToolReceipts({ query: withUnrelatedTaskEvent } as unknown as Pick<pg.PoolClient, "query">, scope)).toBe(true)

    const withCurrentEvent = vi.fn(async (sql: string) => sql.includes('FROM "agent_events" AS event') && sql.includes('event."payload"->>\'toolCallId\' IN')
      ? { rows: [{ id: "current-attempt-event" }], rowCount: 1 } : { rows: [], rowCount: 0 })
    expect(await hasNoCurrentAttemptTaskGraphToolReceipts({ query: withCurrentEvent } as unknown as Pick<pg.PoolClient, "query">, scope)).toBe(false)

    const withTaskScopedOrphan = vi.fn(async (sql: string) => sql.includes('FROM "agent_events" AS event') && sql.includes('event."taskId" = $1 AND NOT EXISTS')
      ? { rows: [{ id: "task-scoped-orphan-event" }], rowCount: 1 } : { rows: [], rowCount: 0 })
    expect(await hasNoCurrentAttemptTaskGraphToolReceipts({ query: withTaskScopedOrphan } as unknown as Pick<pg.PoolClient, "query">, scope)).toBe(false)
  })
})
