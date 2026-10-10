import type pg from "pg"
import { describe, expect, it } from "vitest"
import { taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { createPgDirectSelectedJobHistoryStore, type DirectSelectedJobHistoryLoadInput } from "./selected-job-history-direct-store.js"

type Row = Record<string, unknown>
type Options = Readonly<{ currentJobId?: string; startSequences?: readonly string[]; candidates?: readonly Row[]; candidateError?: Error }>

function candidate(index: number, sequence = String(index * 2 + 2)): Row {
  const turnId = `turn-source-${index}`, rootTaskId = `root-source-${index}`, childId = `child-source-${index}`
  return {
    turnId, sessionId: "session-1", userId: "user-1", rootTaskId, turnStatus: "completed",
    input: { selectedJobPreparation: { jobId: "job-1" } }, taskId: rootTaskId, taskTurnId: turnId,
    taskRootTaskId: rootTaskId, parentTaskId: null, taskRole: "orchestrator", taskType: "root", taskStatus: "completed",
    eventTurnId: turnId, eventTaskId: rootTaskId, itemId: `final-${index}`, sequence,
    type: "turn.completed", actor: "orchestrator", correlationId: `step-${index}`,
    correlationStepId: `step-${index}`, correlationStepSessionId: "session-1",
    correlationStepTurnId: turnId, correlationStepTaskId: rootTaskId,
    idempotencyKey: `turn:${turnId}:event:turn-completed`,
    payload: { turnId, taskId: rootTaskId, finalItemId: `final-${index}` }, terminalEventCount: 1, childId,
  }
}

function noncompletedCandidate(index: number, status: "failed" | "interrupted"): Row {
  const source = candidate(index)
  if (status === "failed") return { ...source, turnStatus: status, taskStatus: status, type: "turn.failed", itemId: null,
    correlationId: source.turnId, idempotencyKey: `turn:${source.turnId}:event:turn-failed:task_failed`,
    payload: { turnId: source.turnId, taskId: source.rootTaskId, errorCode: "task_failed", finalItemId: null } }
  return { ...source, turnStatus: status, taskStatus: status, type: "turn.interrupted", itemId: null,
    correlationId: source.turnId, idempotencyKey: `turn:${source.turnId}:event:turn-interrupted`,
    payload: { turnId: source.turnId, taskId: source.rootTaskId, errorCode: "interrupted" } }
}

function fixture(options: Options = {}) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  const connections = { count: 0 }
  const rows = options.candidates ?? [candidate(1)]
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-current" }] }
      if (sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "root-current", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current", parentTaskId: null,
        role: "orchestrator", taskType: "root", status: "running", leaseOwner: "worker", attemptCount: 2,
        interruptRequestedAt: null,
      }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-current" }] }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')) return { rows: [{
        id: "step-current", sessionId: "session-1", turnId: "turn-current", taskId: "root-current", attempt: 1, status: "streaming",
      }] }
      if (sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"')) return { rows: [{
        id: "turn-current", sessionId: "session-1", userId: "user-1", rootTaskId: "root-current", status: "in_progress",
        input: { selectedJobPreparation: { jobId: options.currentJobId ?? "job-1" } },
      }] }
      if (sql.includes("event.\"type\" = 'turn.started'")) return { rows: (options.startSequences ?? ["100"]).map(sequence => ({ sequence })) }
      if (sql.includes("WITH terminal AS")) {
        if (options.candidateError) throw options.candidateError
        const limit = Number(values?.[5] ?? 0)
        return { rows: [...rows].sort((left, right) => Number(BigInt(String(right.sequence)) - BigInt(String(left.sequence))))
          .slice(0, limit) }
      }
      if (sql.includes('FROM "agent_items" AS item')) {
        const rootTaskId = String(values?.[3]), source = rows.find(row => row.taskRootTaskId === rootTaskId)
        const childId = source?.childId ?? `child-for-${rootTaskId}`
        return { rows: [{ id: values?.[0], revision: 1, content: {
          schemaVersion: "agent-harness.v2.task-graph",
          nodes: [{ key: "scout", templateId: "scout", goal: "Find roles", successCriteria: ["Find one role"],
            dependsOn: [], depth: 1, taskId: childId }],
        } }] }
      }
      if (sql.includes("ANY($1::text[])")) return { rows: (values?.[0] as string[]).map(id => ({
        id, status: "completed", role: "scout", taskType: "scout", expectedOutputSchema: {}, failureReason: null, result: null,
      })) }
      if (sql.includes('FROM "agent_events" AS event')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() { /* test client */ },
  }
  const pool = { connect: async () => { connections.count += 1; return client } } as unknown as Pick<pg.Pool, "connect">
  const input: DirectSelectedJobHistoryLoadInput = {
    lease: { turnId: "turn-current", sessionId: "session-1", ownerId: "worker", userId: "user-1", leaseVersion: 3,
      leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
    rootTaskId: "root-current", rootAttemptCount: 2, stepId: "step-current", jobId: "job-1", now: new Date(2_000),
  }
  return { store: createPgDirectSelectedJobHistoryStore(pool), input, queries, connections }
}

describe("direct selected-job history PostgreSQL store", () => {
  it("rebuilds only the eight newest strictly prior same-job Root graphs without retained records", async () => {
    const test = fixture({ candidates: Array.from({ length: 10 }, (_, index) => candidate(index + 1)) })

    const outcomes = await test.store.load(test.input)

    expect(outcomes.map(value => value.terminalSequence)).toEqual([22n, 20n, 18n, 16n, 14n, 12n, 10n, 8n])
    expect(outcomes.every(value => value.jobId === "job-1" && value.nodes.length === 1)).toBe(true)
    expect(outcomes[0]).toMatchObject({ sourceTurnId: "turn-source-10", sourceRootTaskId: "root-source-10" })
    const candidateQuery = test.queries.find(query => query.sql.includes("WITH terminal AS"))
    expect(candidateQuery?.sql).toContain('COUNT(*) AS "terminalEventCount"')
    expect(candidateQuery?.sql).toContain('MIN(event."id") AS "terminalEventId"')
    expect(candidateQuery?.sql).toContain('counts."terminalEventCount" = 1')
    expect(candidateQuery?.sql).toContain('event."id" = counts."terminalEventId"')
    expect(candidateQuery?.sql).not.toContain("COUNT(*) OVER")
    const countsStart = candidateQuery?.sql.indexOf("counts AS (") ?? -1
    const countsEnd = candidateQuery?.sql.indexOf("), terminal_events AS") ?? -1
    expect(countsStart).toBeGreaterThanOrEqual(0)
    expect(countsEnd).toBeGreaterThan(countsStart)
    expect(candidateQuery?.sql.slice(countsStart, countsEnd)).not.toContain('event."payload"')
    expect(candidateQuery?.sql.indexOf('event."payload"')).toBeGreaterThan(countsEnd)
    expect(candidateQuery?.sql).toContain("ORDER BY \"sequence\" DESC LIMIT $6")
    expect(candidateQuery?.values?.[5]).toBe(8)
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(8)
    expect(test.connections.count).toBe(1)
  })

  it("performs no history scan for a changed server selection or missing current start receipt", async () => {
    const otherJob = fixture({ currentJobId: "job-2" })
    await expect(otherJob.store.load(otherJob.input)).resolves.toEqual([])
    expect(otherJob.queries.some(query => query.sql.includes("WITH terminal AS"))).toBe(false)

    const missingStart = fixture({ startSequences: [] })
    await expect(missingStart.store.load(missingStart.input)).resolves.toEqual([])
    expect(missingStart.queries.some(query => query.sql.includes("WITH terminal AS"))).toBe(false)
  })

  it("accepts only matching failed and interrupted Root terminal receipts", async () => {
    const test = fixture({ candidates: [noncompletedCandidate(1, "failed"), noncompletedCandidate(2, "interrupted")] })

    const outcomes = await test.store.load(test.input)

    expect(outcomes.map(value => value.terminalSequence)).toEqual([6n, 4n])
    expect(outcomes.map(value => value.sourceTurnId)).toEqual(["turn-source-2", "turn-source-1"])
  })

  it("omits foreign, mismatched, ambiguous, and future terminal candidates before rebuilding graphs", async () => {
    const valid = candidate(1)
    const invalid: Row[] = [
      { ...valid, sessionId: "foreign-session" },
      { ...valid, input: { selectedJobPreparation: { jobId: "job-2" } } },
      { ...valid, input: { selectedJobPreparation: { jobId: "job-1", source: "model" } } },
      { ...valid, terminalEventCount: 2 },
      { ...valid, sequence: "100" },
      { ...valid, type: "turn.failed" },
      { ...valid, eventTaskId: "child-source-1" },
      { ...valid, correlationStepId: null },
      { ...valid, correlationStepSessionId: "foreign-session" },
      { ...valid, correlationStepTurnId: "foreign-turn" },
      { ...valid, correlationStepTaskId: "foreign-root" },
    ]
    const test = fixture({ candidates: invalid })

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
  })

  it("rolls back and propagates direct-history SQL failures", async () => {
    const failure = Object.assign(new Error("history query denied"), { code: "42501" })
    const test = fixture({ candidateError: failure })

    await expect(test.store.load(test.input)).rejects.toBe(failure)
    expect(test.queries.some(query => query.sql === "ROLLBACK")).toBe(true)
    expect(test.queries.some(query => query.sql === "COMMIT")).toBe(false)
  })
})
