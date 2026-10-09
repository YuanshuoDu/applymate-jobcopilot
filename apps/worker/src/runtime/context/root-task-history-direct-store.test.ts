import { Buffer } from "node:buffer"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { resolveRootTaskObjective } from "./root-task-objective.js"
import { createPgDirectRootTaskHistoryStore, type DirectRootTaskHistoryLoadInput } from "./root-task-history-direct-store.js"

type Row = Record<string, unknown>
type Options = Readonly<{
  candidates?: readonly Row[]
  currentGoal?: string
  currentCriteria?: readonly string[]
  currentInput?: unknown
  startRows?: readonly Row[]
  candidateError?: Error
  graphError?: Error
  badGraph?: boolean
}>

function candidate(index: number, terminalSequence = String(index * 2 + 2), status: "completed" | "failed" | "interrupted" = "completed"): Row {
  const turnId = `turn-source-${index}`, rootTaskId = `root-source-${index}`
  const startSequence = String(Number(terminalSequence) - 1)
  const input = { input: { goal: "Explore roles", successCriteria: ["Respect location"] } }
  const common = {
    turnId, sessionId: "session-1", userId: "user-1", rootTaskId, turnStatus: status, input,
    taskId: rootTaskId, taskTurnId: turnId, taskRootTaskId: rootTaskId, parentTaskId: null,
    taskRole: "orchestrator", taskType: "root", taskStatus: status, goal: "Explore roles", successCriteria: ["Respect location"],
    startTurnId: turnId, startTaskId: rootTaskId, startItemId: null, startSequence, startType: "turn.started",
    startActor: "orchestrator", startCorrelationId: turnId, startIdempotencyKey: `turn:${turnId}:event:turn-started`,
    startPayload: { taskId: rootTaskId, rootTaskId }, startEventCount: 1,
  }
  if (status === "completed") return {
    ...common, terminalTurnId: turnId, terminalTaskId: rootTaskId, terminalItemId: `final-${index}`,
    terminalSequence, terminalType: "turn.completed", terminalActor: "orchestrator", terminalCorrelationId: `step-${index}`,
    terminalStepId: `step-${index}`, terminalStepSessionId: "session-1",
    terminalStepTurnId: turnId, terminalStepTaskId: rootTaskId, terminalStepStatus: "completed",
    terminalIdempotencyKey: `turn:${turnId}:event:turn-completed`,
    terminalPayload: { turnId, taskId: rootTaskId, finalItemId: `final-${index}` }, terminalEventCount: 1,
  }
  const errorCode = status === "failed" ? "task_failed" : "interrupted"
  return {
    ...common, terminalTurnId: turnId, terminalTaskId: rootTaskId, terminalItemId: null,
    terminalSequence, terminalType: `turn.${status}`, terminalActor: "orchestrator", terminalCorrelationId: turnId,
    terminalIdempotencyKey: `turn:${turnId}:event:turn-${status === "failed" ? `failed:${errorCode}` : "interrupted"}`,
    terminalPayload: status === "failed" ? { turnId, taskId: rootTaskId, errorCode, finalItemId: null }
      : { turnId, taskId: rootTaskId, errorCode }, terminalEventCount: 1,
  }
}

function currentStart(sequence = "1000"): Row {
  return {
    sessionId: "session-1", turnId: "turn-current", taskId: "root-current", itemId: null, sequence,
    type: "turn.started", actor: "orchestrator", correlationId: "turn-current",
    idempotencyKey: "turn:turn-current:event:turn-started", payload: { taskId: "root-current", rootTaskId: "root-current" }, startEventCount: 1,
  }
}

function fixture(options: Options = {}) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  const sourceRows = options.candidates ?? [candidate(1)]
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-current" }] }
      if (sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "root-current", userId: "user-1", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current",
        parentTaskId: null, role: "orchestrator", taskType: "root", status: "running", leaseOwner: "worker",
        attemptCount: 2, interruptRequestedAt: null, goal: options.currentGoal ?? "Explore roles",
        successCriteria: options.currentCriteria ?? ["Respect location"],
      }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-current" }] }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')) return { rows: [{
        id: "step-current", sessionId: "session-1", turnId: "turn-current", taskId: "root-current", attempt: 1, status: "streaming",
      }] }
      if (sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "input"')) return { rows: [{
        id: "turn-current", sessionId: "session-1", userId: "user-1", rootTaskId: "root-current", status: "in_progress",
        input: options.currentInput ?? { goal: " Explore roles ", successCriteria: ["Respect location"] },
      }] }
      if (sql.includes("WITH terminal_window AS MATERIALIZED")) {
        if (options.candidateError) throw options.candidateError
        const limit = Number(values?.[4] ?? 0)
        return { rows: [...sourceRows].sort((left, right) => Number(BigInt(String(right.terminalSequence)) - BigInt(String(left.terminalSequence)))).slice(0, limit) }
      }
      if (sql.includes("event.\"type\" = 'turn.started'")) return { rows: options.startRows ?? [currentStart()] }
      if (sql.includes('FROM "agent_items" AS item')) {
        if (options.graphError) throw options.graphError
        const rootTaskId = String(values?.[3])
        const source = sourceRows.find(row => row.taskRootTaskId === rootTaskId)
        const childId = `child-${rootTaskId}`
        return { rows: [{ id: values?.[0], revision: 1, content: options.badGraph ? { schemaVersion: "bad", nodes: [] } : {
          schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
          nodes: [{ key: "scout", templateId: "scout", goal: "Find roles", successCriteria: ["Find one role"],
            dependsOn: [], depth: 1, taskId: childId }],
        }, source }] }
      }
      if (sql.includes("ANY($1::text[])")) return { rows: (values?.[0] as string[]).map(id => ({
        id, status: "completed", role: "scout", taskType: "scout", expectedOutputSchema: {}, failureReason: null, result: null,
      })) }
      if (sql.includes('FROM "agent_events" AS event')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() { /* test client */ },
  }
  const pool = { connect: async () => client } as unknown as Pick<pg.Pool, "connect">
  const input: DirectRootTaskHistoryLoadInput = {
    lease: { turnId: "turn-current", sessionId: "session-1", ownerId: "worker", userId: "user-1", leaseVersion: 3,
      leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
    rootTaskId: "root-current", rootAttemptCount: 2, stepId: "step-current", now: new Date(2_000),
  }
  return { store: createPgDirectRootTaskHistoryStore(pool), input, queries }
}

describe("direct Root-task history PostgreSQL store", () => {
  it("binds exact canonical objectives across distinct source Root IDs and reloads only their scoped graphs", async () => {
    const first = candidate(1), second = candidate(2, "8", "failed")
    const mismatch = { ...candidate(3), goal: "Different goal" }
    const changedRootCriteria = { ...candidate(4), successCriteria: ["Different criterion"] }
    const changedTurnCriteria = { ...candidate(5),
      input: { input: { goal: "Explore roles", successCriteria: ["Different criterion"] } },
      successCriteria: ["Different criterion"],
    }
    const test = fixture({ candidates: [first, second, mismatch, changedRootCriteria, changedTurnCriteria] })

    const outcomes = await test.store.load(test.input)
    expect(outcomes.map(value => value.sourceTurnId)).toEqual(["turn-source-2", "turn-source-1"])
    expect(outcomes.map(value => value.sourceRootTaskId)).toEqual(["root-source-2", "root-source-1"])
    expect(outcomes[0]?.terminalSequence).toBe(8n)
    expect(outcomes.every(value => value.taskGraph.nodes.length === 1)).toBe(true)
    const scan = test.queries.find(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))
    expect(scan?.sql).toContain("LIMIT $5")
    expect(scan?.values?.[4]).toBe(64)
    const graphReads = test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))
    expect(graphReads).toHaveLength(2)
    expect(graphReads.every(query => !["root-source-4", "root-source-5"].includes(String(query.values?.[3])))).toBe(true)
    expect(graphReads.every(query => query.values?.[1] === "session-1" && query.values?.[2] !== "turn-current"
      && query.values?.[0] === taskGraphItemId(String(query.values?.[3])))).toBe(true)
    expect(scan?.sql).not.toContain("turnInputDigest")
  })

  it("caps the prior terminal scan and graph loads independently", async () => {
    const test = fixture({ candidates: Array.from({ length: 80 }, (_, index) => candidate(index + 1, String(index * 2 + 2))) })

    const outcomes = await test.store.load(test.input)

    expect(outcomes).toHaveLength(8)
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(8)
    const scan = test.queries.find(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))
    const windowLimit = scan?.sql.indexOf("LIMIT $5") ?? -1
    const rootsJoin = scan?.sql.indexOf("), roots AS (") ?? -1
    expect(scan?.values?.[4]).toBe(64)
    expect(scan?.sql).toContain('WHERE event."sessionId" = $1 AND event."sequence" < $4::bigint')
    expect(scan?.sql.indexOf('ORDER BY event."sequence" DESC')).toBeLessThan(windowLimit)
    expect(windowLimit).toBeGreaterThanOrEqual(0)
    expect(windowLimit).toBeLessThan(rootsJoin)
    expect(scan?.sql.slice(rootsJoin)).not.toContain("LIMIT $5")
  })

  it("omits candidates with mismatched status, duplicate receipts, or nonprior sequence ordering", async () => {
    const valid = candidate(1)
    const invalid: Row[] = [
      { ...valid, taskStatus: "failed" },
      { ...valid, terminalEventCount: 2 },
      { ...valid, startEventCount: 2 },
      { ...valid, startSequence: valid.terminalSequence },
      { ...valid, terminalSequence: "1000" },
      { ...valid, terminalActor: "system" },
    ]
    const test = fixture({ candidates: invalid })

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
  })

  it("requires a completed receipt correlation target in the same session, Turn, and Root task", async () => {
    const valid = candidate(12)
    const missingStep = { ...candidate(13), terminalStepId: null }
    const otherTurn = { ...candidate(14), terminalStepTurnId: "turn-elsewhere" }
    const otherRoot = { ...candidate(15), terminalStepTaskId: "root-elsewhere" }
    const otherSession = { ...candidate(16), terminalStepSessionId: "session-elsewhere" }
    const streamingStep = { ...candidate(17), terminalStepStatus: "streaming" }
    const failedStep = { ...candidate(18), terminalStepStatus: "failed" }
    const test = fixture({ candidates: [valid, missingStep, otherTurn, otherRoot, otherSession, streamingStep, failedStep] })

    const outcomes = await test.store.load(test.input)

    expect(outcomes.map(value => value.sourceTurnId)).toEqual(["turn-source-12"])
    const graphReads = test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))
    expect(graphReads).toHaveLength(1)
    expect(graphReads[0]?.values?.[2]).toBe("turn-source-12")
    const scan = test.queries.find(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))
    expect(scan?.sql).toContain('FROM "agent_steps" AS step')
    expect(scan?.sql).toContain('step."id" = terminal."correlationId"')
    expect(scan?.sql).toContain('step."sessionId" = roots."sessionId"')
    expect(scan?.sql).toContain('step."turnId" = roots."turnId"')
    expect(scan?.sql).toContain('step."taskId" = roots."rootTaskId"')
    expect(scan?.sql).toContain('terminal_step."status" AS "terminalStepStatus"')
    expect(scan?.sql).toContain('terminal_step."id" = terminal."correlationId"')
  })

  it("rejects a nonterminal source Turn before loading its terminal Root graph", async () => {
    const terminalRootWithRunningTurn = { ...candidate(1), turnStatus: "running" }
    const test = fixture({ candidates: [terminalRootWithRunningTurn] })

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
  })

  it("does not scan history for an invalid current objective or a missing current start receipt", async () => {
    const conflict = fixture({ currentGoal: "A conflicting persisted Root objective" })
    await expect(conflict.store.load(conflict.input)).resolves.toEqual([])
    expect(conflict.queries.some(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))).toBe(false)

    const missingStart = fixture({ startRows: [] })
    await expect(missingStart.store.load(missingStart.input)).resolves.toEqual([])
    expect(missingStart.queries.some(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))).toBe(false)
  })

  it("omits an otherwise valid historical objective with a 2,500-byte fallback requirement", async () => {
    const goal = `${"€".repeat(833)}a`
    expect(Buffer.byteLength(goal, "utf8")).toBe(2_500)
    const resolved = resolveRootTaskObjective({ input: { goal, successCriteria: [] } }, { goal, successCriteria: [] })
    expect(resolved).toMatchObject({ criteria: [goal], criteriaValid: false, turnGoalConflict: false })

    const longSource = { ...candidate(6), input: { input: { goal, successCriteria: [] } }, goal, successCriteria: [] }
    const test = fixture({ candidates: [longSource] })

    const outcomes = await test.store.load(test.input)

    expect(outcomes).toEqual([])
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
  })

  it("keeps matching current and historical fallback requirements at the 2,000-byte boundary", async () => {
    const goal = `${"€".repeat(666)}aa`
    expect(Buffer.byteLength(goal, "utf8")).toBe(2_000)
    const source = { ...candidate(8), input: { input: { goal, successCriteria: [] } }, goal, successCriteria: [] }
    const test = fixture({
      candidates: [source], currentGoal: goal, currentCriteria: [],
      currentInput: { input: { goal, successCriteria: [] } },
    })

    const outcomes = await test.store.load(test.input)

    expect(outcomes.map(value => value.sourceTurnId)).toEqual(["turn-source-8"])
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(1)
  })

  it("excludes source Turns with selected-job context even when the selection value is malformed", async () => {
    const topLevel = { ...candidate(1), input: { goal: "Explore roles", selectedJobPreparation: null } }
    const nested = { ...candidate(2), input: { input: { goal: "Explore roles", successCriteria: ["Respect location"], selectedJobPreparation: "bad" } } }
    const test = fixture({ candidates: [topLevel, nested] })

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
  })

  it("omits malformed graph evidence but propagates database and graph-scope failures", async () => {
    const malformed = fixture({ badGraph: true })
    await expect(malformed.store.load(malformed.input)).resolves.toEqual([])

    const dbFailure = Object.assign(new Error("candidate query denied"), { code: "42501" })
    const db = fixture({ candidateError: dbFailure })
    await expect(db.store.load(db.input)).rejects.toBe(dbFailure)
    expect(db.queries.some(query => query.sql === "ROLLBACK")).toBe(true)

    const scopeFailure = new Error("task_graph_task_scope_invalid")
    const scoped = fixture({ graphError: scopeFailure })
    await expect(scoped.store.load(scoped.input)).rejects.toBe(scopeFailure)
  })
})
