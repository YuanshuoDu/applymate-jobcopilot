import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgQuestionWait } from "./turn-question-wait-store.js"

const owner = {
  kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-22T03:00:00.000Z"),
}
const question = {
  turnId: "turn-1", questionId: "question:turn-1:plan-1:1:ask", toolCallId: "plan-1", question: "Where?", options: [],
  planCallId: "plan-1", localId: "ask", goalRevision: 1, planRevision: 1,
} as const
const now = new Date("2026-09-22T02:00:00.000Z")

function clientFixture(overrides: { turnStatus?: string; turnRevision?: number; itemExists?: boolean; eventExists?: boolean } = {}) {
  const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('SELECT turn."status"')) return { rows: [{ status: overrides.turnStatus ?? "in_progress", revision: overrides.turnRevision ?? 4 }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1" }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_items"')) return overrides.itemExists ? { rows: [], rowCount: 0 } : { rows: [{ id: `agent-wait:question:${question.questionId}`, revision: 0 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items"')) return { rows: overrides.itemExists ? [{ id: `agent-wait:question:${question.questionId}`, sessionId: owner.sessionId, turnId: owner.turnId, stepId: "step-1", taskId: null, type: "question", status: "started", phase: "commentary", revision: 0, content: { waitKind: "question", questionId: question.questionId, stage: "plan", question: question.question, options: [], toolCallId: question.toolCallId, pending: true, answerAvailable: false } }] : [], rowCount: overrides.itemExists ? 1 : 0 }
      if (sql.includes('FROM "agent_events"')) return { rows: overrides.eventExists ? [{ id: "agent-event-existing", taskId: null, turnId: owner.turnId, itemId: `agent-wait:question:${question.questionId}`, type: "item.started", correlationId: `agent-wait:question:${question.questionId}`, causationId: question.questionId, sequence: 7n, actor: "orchestrator", payload: { itemId: `agent-wait:question:${question.questionId}`, waitKind: "question", questionId: question.questionId, toolCallId: question.toolCallId } }] : [], rowCount: overrides.eventExists ? 1 : 0 }
      if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE "agent_sessions"')) return { rows: [{ eventSequence: 8n }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { client, pool: { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect"> }
}

describe("createPgQuestionWait", () => {
  it("writes the item, waiting Turn, item.started event, and outbox in one transaction", async () => {
    const fake = clientFixture()
    await expect(createPgQuestionWait(fake.pool, { owner, stepId: "step-1", now, question })).resolves.toEqual({ itemId: `agent-wait:question:${question.questionId}`, turnRevision: 5 })
    const sql = fake.client.query.mock.calls.map(([text]) => text)
    expect(sql[0]).toBe("BEGIN")
    expect(sql.indexOf("COMMIT")).toBeGreaterThan(sql.findIndex(text => text.includes('INSERT INTO "agent_items"')))
    expect(sql.some(text => text.includes("UPDATE \"agent_turns\""))).toBe(true)
    expect(sql.some(text => text.includes("INSERT INTO \"agent_events\"") && text.includes("'item.started'"))).toBe(true)
    expect(sql.some(text => text.includes("INSERT INTO \"agent_outbox\"") && text.includes("'agent.session.event'"))).toBe(true)
    const itemInsert = fake.client.query.mock.calls.find(([text]) => text.includes('INSERT INTO "agent_items"'))
    expect(JSON.parse(String(itemInsert?.[1]?.[5]))).toEqual({
      waitKind: "question", questionId: question.questionId, stage: "plan", question: question.question,
      options: [], toolCallId: question.toolCallId, pending: true, answerAvailable: false,
    })
    expect(itemInsert?.[1]?.[4]).toBeNull()
    const eventInsert = fake.client.query.mock.calls.find(([text]) => text.includes('INSERT INTO "agent_events"') && text.includes("'item.started'"))
    expect(eventInsert?.[1]?.[4]).toBeNull()
  })

  it("replays the same started question without incrementing a waiting Turn", async () => {
    const fake = clientFixture({ turnStatus: "waiting_for_user", turnRevision: 5, itemExists: true, eventExists: true })
    await expect(createPgQuestionWait(fake.pool, { owner, stepId: "step-1", now, question })).resolves.toEqual({ itemId: `agent-wait:question:${question.questionId}`, turnRevision: 5 })
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('UPDATE "agent_turns"'))).toBe(false)
  })

  it("fails closed when a waiting Turn has no matching question item", async () => {
    const fake = clientFixture({ turnStatus: "waiting_for_user", turnRevision: 5 })
    await expect(createPgQuestionWait(fake.pool, { owner, stepId: "step-1", now, question })).rejects.toThrow(/stale wait/)
  })

  it("fails closed for child owners before opening a transaction", async () => {
    const fake = clientFixture()
    const child = {
      kind: "task" as const,
      userId: owner.userId,
      sessionId: owner.sessionId,
      turnId: owner.turnId,
      taskId: "child-1",
      rootTaskId: owner.rootTaskId,
      attemptCount: 1,
      ownerId: owner.ownerId,
      leaseExpiresAt: owner.leaseExpiresAt,
    }
    await expect(createPgQuestionWait(fake.pool, { owner: child, stepId: "step-1", now, question })).rejects.toThrow(/child question wait/)
    expect(fake.pool.connect).not.toHaveBeenCalled()
  })
})
