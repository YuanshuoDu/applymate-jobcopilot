import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { CompactionPgClient, CompactionPgPool } from "./context-compaction-pg-store.js"
import { createPgCompactionSource } from "./context-compaction-pg-source.js"
import { sha256Hex } from "./context-compaction-canonical.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-a", sessionId: "session-a", turnId: "turn-a", taskId: "root-a", rootTaskId: "root-a",
  ownerId: "worker-a", leaseVersion: 4, leaseExpiresAt: new Date(Date.now() + 60_000),
}
const priorState = {
  ownerId: owner.userId, sessionId: owner.sessionId, throughSequence: "7", goal: "Find a role", userConstraints: ["EU"],
  approvals: [{ id: "approval-1", status: "pending" }], answers: [{ id: "answer-1", question: "Permit", answer: "yes" }],
  artifacts: [{ id: "artifact-v1", type: "resume", hash: "hash-v1" }], openTasks: [], doNotRepeat: ["old failed path"],
  facts: [{ factId: "fact-1", key: "role", source: "user" }],
}
const priorSummary = "prior summary"
const priorTokenMeasurement = { beforeInputTokens: 100, afterInputTokens: 40, reductionTokens: 60, reductionRatio: 0.6 }
const priorSourceItemIds = ["item-prior"]
const priorItemId = "old-compaction"
const priorContent = {
  schemaVersion: "agent-harness.context.v1", ownerId: owner.userId, sessionId: owner.sessionId, throughSequence: "7", goal: "Find a role",
  userConstraints: ["EU"], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [{ id: "artifact-v1", type: "resume", hash: "hash-v1" }],
  facts: [{ factId: "fact-1", key: "role", source: "user" }], failedAttempts: [{ taskId: "task-old", reason: "failed", doNotRepeat: ["old failed path"] }], references: [], consumedInputIds: [],
  context: { system: [], profile: [], steerHistory: [], toolObservations: [] }, tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
  compaction: {
    itemId: priorItemId, digest: sha256Hex({ state: priorState, summary: priorSummary, measurement: priorTokenMeasurement, sourceItemIds: priorSourceItemIds, itemId: priorItemId }),
    state: priorState, narrativeSummary: priorSummary, tokenMeasurement: priorTokenMeasurement, sourceItemIds: priorSourceItemIds,
  },
}

function fakePool(options: { readonly contextSnapshotId?: string | null } = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: owner.turnId, contextSnapshotId: options.contextSnapshotId ?? null }], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions" WHERE')) return { rows: [{ goal: "Find a role" }], rowCount: 1 }
    if (sql.includes('FROM "agent_context_snapshots"')) return { rows: [{ id: "snapshot-7", sessionId: owner.sessionId, throughSequence: "7", version: 2, content: priorContent, checksum: "checksum" }], rowCount: 1 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: [{ id: "approval-1", status: "approved", scopeHash: "scope", answersHash: "answers" }], rowCount: 1 }
    if (sql.includes('FROM "agent_artifact_version"')) return { rows: [{ id: "artifact-v2", type: "resume", hash: "hash-v2" }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "task-open", status: "running", failureReason: null }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"')) return { rows: [
      { id: "input-old", targetTurnId: "turn-old", acceptedSequence: "4", content: { text: "old input" } },
      { id: "input-new", targetTurnId: null, acceptedSequence: "8", content: { text: "new input" } },
    ], rowCount: 2 }
    if (sql.includes('FROM "agent_items"')) {
      const candidates: Array<{ id: string; sessionId: string; turnId: string; taskId: string | null; type: string; status: string; content: unknown; sequence: string }> = [
        { id: "item-at-cursor", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, type: "agent_message", status: "completed", content: { text: "already compacted" }, sequence: "7" },
        { id: "item-new", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, type: "agent_message", status: "completed", content: { text: "tail item" }, sequence: "9" },
        { id: "child-item", sessionId: owner.sessionId, turnId: owner.turnId, taskId: "child-task", type: "agent_message", status: "completed", content: { text: "child output" }, sequence: "10" },
      ]
      const rows = candidates.filter(row => (row.taskId === null || row.taskId === values[2]) && BigInt(row.sequence) > BigInt(String(values[1])))
      return { rows, rowCount: rows.length }
    }
    return { rows: [], rowCount: 0 }
  })
  const client = { query, release: vi.fn() } as unknown as CompactionPgClient
  const pool = { connect: vi.fn(async () => client) } as unknown as CompactionPgPool
  return { pool, calls, query }
}

describe("PostgreSQL context compaction source", () => {
  it("loads preserved state and only the narrative tail after the latest snapshot cursor", async () => {
    const fake = fakePool()
    const source = await createPgCompactionSource(fake.pool).load({ scope: { userId: owner.userId }, owner })
    expect(source?.state).toMatchObject({
      ownerId: owner.userId, sessionId: owner.sessionId, throughSequence: 9n, goal: "Find a role", userConstraints: ["EU"],
      approvals: [{ id: "approval-1", status: "approved", scopeHash: "scope", answersHash: "answers" }],
      answers: expect.arrayContaining([
        expect.objectContaining({ id: "answer-1", question: "Permit", answer: "yes" }),
        expect.objectContaining({ id: "input:input-old", question: "User input", answer: "old input" }),
        expect.objectContaining({ id: "input:input-new", question: "User input", answer: "new input" }),
      ]),
      artifacts: expect.arrayContaining([{ id: "artifact-v1", type: "resume", hash: "hash-v1" }, { id: "artifact-v2", type: "resume", hash: "hash-v2" }]),
      openTasks: [{ taskId: "task-open", status: "running", blocker: null }], doNotRepeat: ["old failed path"], facts: [{ factId: "fact-1", key: "role", source: "user" }],
    })
    expect(source?.items).toEqual([
      { id: "context-compaction-summary:snapshot-7", sessionId: owner.sessionId, turnId: owner.turnId, sequence: 7n, type: "compaction_summary", status: "completed", content: "prior summary" },
      { id: "input:input-new", sessionId: owner.sessionId, turnId: owner.turnId, sequence: 8n, type: "user_input", status: "completed", content: { text: "new input" } },
      { id: "item-new", sessionId: owner.sessionId, turnId: owner.turnId, sequence: 9n, type: "agent_message", status: "completed", content: { text: "tail item" } },
    ])
    const artifactQuery = fake.calls.find(call => call.sql.includes('FROM "agent_artifact_version"'))
    expect(artifactQuery?.sql).toContain('SELECT "id", "artifactType" AS "type", "contentHash" AS "hash"')
    expect(artifactQuery?.values).toEqual([owner.sessionId, owner.userId])
    const ownerQuery = fake.calls.find(call => call.sql.includes('FROM "agent_turns" AS turn'))
    expect(ownerQuery?.sql).toContain('"leaseVersion"')
    expect(ownerQuery?.sql).toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP')
    const tailQuery = fake.calls.find(call => call.sql.includes('FROM "agent_items"'))
    expect(tailQuery?.sql).toContain('(item."taskId" IS NULL OR item."taskId" = $3)')
    expect(tailQuery?.values).toEqual([owner.sessionId, "7", owner.taskId])
    expect(source?.items.some(item => item.id === "child-item")).toBe(false)
    expect(source?.items.some(item => item.id === "item-at-cursor")).toBe(false)
  })

  it("rejects a foreign tenant before opening a database connection", async () => {
    const fake = fakePool()
    await expect(createPgCompactionSource(fake.pool).load({ scope: { userId: "user-b" }, owner })).rejects.toThrow("tenant or owner scope")
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })

  it("fails closed when the locked turn has a pinned context snapshot", async () => {
    const fake = fakePool({ contextSnapshotId: "explicit-snapshot" })
    await expect(createPgCompactionSource(fake.pool).load({ scope: { userId: owner.userId }, owner })).resolves.toBeNull()
    expect(fake.calls.some(call => call.sql.includes('FROM "agent_items"'))).toBe(false)
  })
})
