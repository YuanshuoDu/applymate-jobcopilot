import type pg from "pg"
import { describe, expect, it } from "vitest"
import { projectSelectedJobMemory, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import { createPgSelectedJobHistoryStore, type SelectedJobHistoryLoadInput } from "./selected-job-history-store.js"

const selectedJobId = "job-1"
const sourceTurnId = "turn-old"
const sourceRootTaskId = "root-old"
const graphSnapshot = {
  schemaVersion: "agent-harness.v2.task-graph",
  nodes: [{ key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find one role"], dependsOn: [], depth: 1, taskId: "child-scout" }],
}
const record = projectSelectedJobMemory({ jobId: selectedJobId, sourceTurnId, sourceRootTaskId, throughSequence: "70",
  graph: { revision: 1, nodes: [{ key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find one role"], dependsOn: [],
    taskId: "child-scout", status: "completed", readiness: "terminal",
    resultProjection: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "unavailable" } }] } })
if (!record) throw new Error("history fixture record was not projected")

type FixtureOptions = Readonly<{
  stepAttempt?: number; currentJobId?: string; startSequence?: string; terminalSequence?: string
  terminalEventCount?: number; sourceRows?: readonly Record<string, unknown>[]
  graphRevision?: number; graphContent?: unknown; graphError?: Error
}>

function fixture(options: FixtureOptions = {}) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  const connections = { count: 0 }
  const validSource = {
    turnId: sourceTurnId, sessionId: "session-1", userId: "user-1", rootTaskId: sourceRootTaskId,
    turnStatus: "completed", input: { selectedJobPreparation: { jobId: selectedJobId } }, taskId: sourceRootTaskId,
    taskTurnId: sourceTurnId, taskRootTaskId: sourceRootTaskId, parentTaskId: null,
    role: "orchestrator", taskType: "root", taskStatus: "completed",
  }
  const terminal = {
    turnId: sourceTurnId, taskId: sourceRootTaskId, itemId: "final-old", sequence: options.terminalSequence ?? "80",
    type: "turn.completed", actor: "orchestrator", correlationId: "step-old",
    idempotencyKey: `turn:${sourceTurnId}:event:turn-completed`,
    payload: { turnId: sourceTurnId, taskId: sourceRootTaskId, finalItemId: "final-old" },
    eventCount: options.terminalEventCount ?? 1,
  }
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-current" }] }
      if (sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "root-current", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current", parentTaskId: null,
        role: "orchestrator", taskType: "root", status: "running", leaseOwner: "worker", attemptCount: 2,
        interruptRequestedAt: null,
      }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-current" }] }
      if (sql.includes('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')) return { rows: [{
        id: "step-current", sessionId: "session-1", turnId: "turn-current", taskId: "root-current",
        attempt: options.stepAttempt ?? 1, status: "streaming",
      }] }
      if (sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"')) return { rows: [{
        id: "turn-current", sessionId: "session-1", userId: "user-1", rootTaskId: "root-current", status: "in_progress",
        input: { selectedJobPreparation: { jobId: options.currentJobId ?? selectedJobId } },
      }] }
      if (sql.includes("event.\"type\" = 'turn.started'")) return { rows: [{ sequence: options.startSequence ?? "200" }] }
      if (sql.includes("WITH expected AS")) return { rows: (options.terminalEventCount ?? 1) === 1 ? [terminal] : [] }
      if (sql.includes("FROM unnest($1::text[], $2::text[])")) return { rows: options.sourceRows ? [...options.sourceRows] : [validSource] }
      if (sql.includes('FROM "agent_items" AS item')) {
        if (options.graphError) throw options.graphError
        return { rows: [{ id: "graph-old", revision: options.graphRevision ?? 1, content: options.graphContent ?? graphSnapshot }] }
      }
      if (sql.includes("ANY($1::text[])")) return { rows: [{ id: "child-scout", status: "completed", role: "scout", taskType: "scout", expectedOutputSchema: {}, failureReason: null, result: null }] }
      if (sql.includes('FROM "agent_events" AS event') && sql.includes('event."itemId" = $3')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() { /* test client */ },
  }
  const pool = { connect: async () => { connections.count += 1; return client } } as unknown as Pick<pg.Pool, "connect">
  const input: SelectedJobHistoryLoadInput = {
    lease: { turnId: "turn-current", sessionId: "session-1", ownerId: "worker", userId: "user-1", leaseVersion: 3,
      leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
    rootTaskId: "root-current", rootAttemptCount: 2, stepId: "step-current", jobId: selectedJobId,
    records: [record as SelectedJobMemoryRecord], now: new Date(2_000),
  }
  return { store: createPgSelectedJobHistoryStore(pool), input, queries, connections }
}

describe("selected-job history PostgreSQL store", () => {
  it("accepts a same-job terminal source ordered before the current owned start and rederives its graph", async () => {
    const test = fixture()

    const history = await test.store.load(test.input)

    expect(history, JSON.stringify(test.queries.map(query => query.sql))).toEqual([{ record, terminalSequence: 80n }])
    const sql = test.queries.map(query => query.sql)
    const index = (fragment: string) => sql.findIndex(value => value.includes(fragment))
    expect(index('SELECT "id" FROM "agent_sessions"')).toBeLessThan(index('SELECT "id" FROM "agent_turns"'))
    expect(index('SELECT "id" FROM "agent_turns"')).toBeLessThan(index("FOR UPDATE OF task"))
    expect(index("FOR UPDATE OF task")).toBeLessThan(index('SELECT "id" FROM "agent_steps"'))
    expect(index('SELECT "id" FROM "agent_steps"')).toBeLessThan(index('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"'))
    expect(test.queries.find(query => query.sql.includes('SELECT "id" FROM "agent_steps"'))?.values).toContain("root-current")
  })

  it("requires the canonical Root Step attempt 1 even when the Root lease is on attempt 2", async () => {
    const test = fixture({ stepAttempt: 2 })

    await expect(test.store.load(test.input)).rejects.toThrow("selected_job_history_current_step_fenced")
    expect(test.queries.some(query => query.sql.includes("FROM unnest"))).toBe(false)
  })

  it("fails closed for ambiguous terminal events after PostgreSQL aggregates their count", async () => {
    const test = fixture({ terminalEventCount: 2 })

    await expect(test.store.load(test.input)).resolves.toEqual([])
    const query = test.queries.find(value => value.sql.includes("WITH expected AS"))?.sql
    expect(query).toContain('COUNT(*) AS "eventCount"')
    expect(query).toContain('MIN(event."id") AS "eventId"')
    expect(query).toContain('counts."eventCount" = 1')
    expect(query).not.toContain("COUNT(*) OVER")
  })

  it("skips same-Turn and other-job retained records before acquiring a database connection", async () => {
    const sameTurn = fixture()
    const sameTurnInput: SelectedJobHistoryLoadInput = {
      ...sameTurn.input,
      lease: { ...sameTurn.input.lease, turnId: sourceTurnId },
      rootTaskId: sourceRootTaskId,
    }
    await expect(sameTurn.store.load(sameTurnInput)).resolves.toEqual([])
    expect(sameTurn.connections.count).toBe(0)

    const otherJobRecord = projectSelectedJobMemory({ jobId: "job-2", sourceTurnId, sourceRootTaskId, throughSequence: "70",
      graph: { revision: 1, nodes: [{ key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find one role"],
        dependsOn: [], taskId: "child-scout", status: "completed", readiness: "terminal",
        resultProjection: { schemaVersion: "agent-harness.v2.task-graph.result-projection", trust: "untrusted", availability: "unavailable" } }] } })
    if (!otherJobRecord) throw new Error("other-job fixture record was not projected")
    const otherJob = fixture()
    await expect(otherJob.store.load({ ...otherJob.input, records: [otherJobRecord] })).resolves.toEqual([])
    expect(otherJob.connections.count).toBe(0)
  })

  it("omits foreign sources, another server-selected job, stale graph projections, and nonprior terminal events", async () => {
    const foreign = fixture({ sourceRows: [{ turnId: sourceTurnId, sessionId: "other-session", userId: "user-1",
      rootTaskId: sourceRootTaskId, turnStatus: "completed", input: { selectedJobPreparation: { jobId: selectedJobId } },
      taskId: sourceRootTaskId, taskTurnId: sourceTurnId, taskRootTaskId: sourceRootTaskId, parentTaskId: null,
      role: "orchestrator", taskType: "root", taskStatus: "completed" }] })
    await expect(foreign.store.load(foreign.input)).resolves.toEqual([])

    const anotherJob = fixture({ currentJobId: "job-2" })
    await expect(anotherJob.store.load(anotherJob.input)).resolves.toEqual([])
    expect(anotherJob.queries.some(query => query.sql.includes("FROM unnest"))).toBe(false)

    const changedGraph = fixture({ graphRevision: 2 })
    await expect(changedGraph.store.load(changedGraph.input)).resolves.toEqual([])

    const futureTerminal = fixture({ terminalSequence: "200" })
    await expect(futureTerminal.store.load(futureTerminal.input)).resolves.toEqual([])
  })

  it("rolls back and propagates database read failures instead of treating them as absent history", async () => {
    const databaseError = Object.assign(new Error("permission denied"), { code: "42501" })
    const test = fixture({ graphError: databaseError })

    await expect(test.store.load(test.input)).rejects.toBe(databaseError)
    expect(test.queries.some(query => query.sql === "ROLLBACK")).toBe(true)
  })
})

