import { Buffer } from "node:buffer"
import type pg from "pg"
import { describe, expect, it } from "vitest"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-pg-verification.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { resolveRootTaskObjective } from "./root-task-objective.js"
import { createPgDirectRootTaskHistoryStore, type DirectRootTaskHistoryLoadInput } from "./root-task-history-direct-store.js"

type Row = Record<string, unknown>
type Options = Readonly<{
  candidates?: readonly Row[]
  currentGoal?: string | null
  currentCriteria?: readonly string[]
  currentInput?: unknown
  startRows?: readonly Row[]
  candidateError?: Error
  graphError?: Error
  badGraph?: boolean
  typedFailure?: boolean
  reportedOutput?: boolean
  sourceSessionStatusAtGraphLoad?: "archived" | "aborted"
  sourceSessionLockedAtGraphLoad?: boolean
  tenantScope?: string | null
}>

function candidate(index: number, terminalSequence = String(index * 2 + 2), status: "completed" | "failed" | "interrupted" = "completed"): Row {
  const turnId = `turn-source-${index}`, rootTaskId = `root-source-${index}`
  const startSequence = String(Number(terminalSequence) - 2)
  const input = { input: { goal: "Explore roles", successCriteria: ["Respect location"] } }
  const common = {
    turnId, sessionId: "session-1", userId: "user-1", rootTaskId, turnStatus: status, input,
    taskId: rootTaskId, taskTurnId: turnId, taskRootTaskId: rootTaskId, parentTaskId: null,
    taskRole: "orchestrator", taskType: "root", taskStatus: status, goal: "Explore roles", successCriteria: ["Respect location"],
    startTurnId: turnId, startTaskId: rootTaskId, startItemId: null, startSequence, startType: "turn.started",
    startActor: "orchestrator", startCorrelationId: turnId, startIdempotencyKey: `turn:${turnId}:event:turn-started`,
    startPayload: { taskId: rootTaskId, rootTaskId }, startEventCount: 1,
    terminalCreatedAt: new Date(`2026-10-07T11:${String(index).padStart(2, "0")}:00.000Z`),
    turnSource: "user", sourceSessionUserId: "user-1", sourceSessionStatus: "running",
  }
  if (status === "completed") return {
    ...common, terminalTurnId: turnId, terminalTaskId: rootTaskId, terminalItemId: `final-${index}`,
    terminalSequence, terminalType: "turn.completed", terminalActor: "orchestrator", terminalCorrelationId: `step-${index}`,
    terminalStepId: `step-${index}`, terminalStepSessionId: "session-1",
    terminalStepTurnId: turnId, terminalStepTaskId: rootTaskId, terminalStepStatus: "completed",
    terminalStepEventSessionId: "session-1", terminalStepEventTurnId: turnId, terminalStepEventTaskId: rootTaskId,
    terminalStepEventItemId: null, terminalStepEventSequence: String(Number(terminalSequence) - 1),
    terminalStepEventType: "step.completed", terminalStepEventActor: "orchestrator",
    terminalStepEventCorrelationId: `step-${index}`,
    terminalStepEventIdempotencyKey: `turn:${turnId}:event:step-completed:step-${index}`,
    terminalStepEventPayload: { stepId: `step-${index}`, status: "completed", taskId: rootTaskId }, terminalStepEventCount: 1,
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
    idempotencyKey: "turn:turn-current:event:turn-started", payload: { taskId: "root-current", rootTaskId: "root-current" },
    createdAt: new Date("2026-10-07T12:00:00.000Z"), startEventCount: 1,
  }
}

function fixture(options: Options = {}) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  let connects = 0
  let tenantScope = options.tenantScope === undefined ? "user-1" : options.tenantScope
  const sourceRows = options.candidates ?? [candidate(1)]
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 1 }
      if (sql.includes("set_config")) { tenantScope = String(values?.[1]); return { rows: [], rowCount: 1 } }
      if (sql.includes("current_setting('app.user_id'")) return { rows: [{ userId: tenantScope }] }
      if (sql.includes("FOR SHARE")) return { rows: options.sourceSessionStatusAtGraphLoad || options.sourceSessionLockedAtGraphLoad ? [] : [{ id: values?.[0] }] }
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-current" }] }
      if (sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "root-current", userId: "user-1", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current",
        parentTaskId: null, role: "orchestrator", taskType: "root", status: "running", leaseOwner: "worker",
        attemptCount: 2, interruptRequestedAt: null, goal: options.currentGoal === undefined ? "Explore roles" : options.currentGoal,
        successCriteria: options.currentCriteria ?? ["Respect location"],
      }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-current" }] }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')) return { rows: [{
        id: "step-current", sessionId: "session-1", turnId: "turn-current", taskId: "root-current", attempt: 1, status: "streaming",
      }] }
      if (sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "source", "input"')) return { rows: [{
        id: "turn-current", sessionId: "session-1", userId: "user-1", rootTaskId: "root-current", status: "in_progress",
        source: "user",
        input: options.currentInput ?? { goal: " Explore roles ", successCriteria: ["Respect location"] },
      }] }
      if (sql.includes("WITH terminal_window AS MATERIALIZED")) {
        if (options.candidateError) throw options.candidateError
        const limit = Number(values?.[values.length - 1] ?? 0)
        const rows = [...sourceRows].sort((left, right) => sql.includes('ORDER BY terminal."createdAt" DESC')
          ? (right.terminalCreatedAt instanceof Date && left.terminalCreatedAt instanceof Date
            ? right.terminalCreatedAt.getTime() - left.terminalCreatedAt.getTime() : 0) || String(right.turnId).localeCompare(String(left.turnId))
          : Number(BigInt(String(right.terminalSequence)) - BigInt(String(left.terminalSequence))))
        return { rows: rows.slice(0, limit) }
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
            ...(options.typedFailure ? { verificationDisposition: "typed", verification: {
              schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
              criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
            } } : {}),
            dependsOn: [], depth: 1, taskId: childId }],
        }, source }] }
      }
      if (sql.includes("ANY($1::text[])")) return { rows: (values?.[0] as string[]).map(id => ({
        id, status: options.typedFailure ? "failed" : "completed", role: "scout", taskType: "scout", expectedOutputSchema: {},
        failureReason: options.typedFailure ? "task_graph_verification_failed" : null,
        result: options.typedFailure ? { taskGraphVerificationReport: {
          verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
          criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }],
          evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
        } } : options.reportedOutput ? {
          finalItemId: "final-scout", finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
          structuredResult: {
            schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "partial", summary: "private summary",
            evidence: [{ id: "e1", kind: "job", ref: "job-1", source: "greenhouse" },
              { id: "e2", kind: "job", ref: "job-2", source: "greenhouse" }, { id: "e3", kind: "job", ref: "job-3", source: "greenhouse" }],
            candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://private.example/1", evidenceIds: ["e1"] },
              { jobId: "job-1", source: "greenhouse", url: "https://private.example/1", evidenceIds: ["e1"] },
              { jobId: "job-2", source: "greenhouse", url: "https://private.example/2", evidenceIds: ["e2"] },
              { jobId: "job-3", source: "greenhouse", url: "https://private.example/3", evidenceIds: ["e3"] }],
          },
        } : null,
      })) }
      if (sql.includes('FROM "agent_events" AS event')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() { /* test client */ },
  }
  const pool = { connect: async () => { connects += 1; return client } } as unknown as Pick<pg.Pool, "connect">
  const input: DirectRootTaskHistoryLoadInput = {
    lease: { turnId: "turn-current", sessionId: "session-1", ownerId: "worker", userId: "user-1", leaseVersion: 3,
      leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
    rootTaskId: "root-current", rootAttemptCount: 2, stepId: "step-current", now: new Date(2_000),
  }
  return { store: createPgDirectRootTaskHistoryStore(pool), input, queries, client: client as unknown as pg.PoolClient,
    get tenantScope() { return tenantScope },
    get connects() { return connects } }
}

describe("direct Root-task history PostgreSQL store", () => {
  it("reads only under the caller's matching tenant scope without opening or changing a transaction", async () => {
    const test = fixture()
    const outcomes = await test.store.loadWithClient(test.client, test.input)

    expect(outcomes.map(value => value.sourceTurnId)).toEqual(["turn-source-1"])
    expect(test.connects).toBe(0)
    expect(test.queries.filter(query => query.sql.includes("current_setting('app.user_id'")).length).toBe(1)
    expect(test.queries.some(query => query.sql.includes("set_config"))).toBe(false)
    expect(test.tenantScope).toBe("user-1")
    expect(test.queries.some(query => ["BEGIN", "COMMIT", "ROLLBACK"].includes(query.sql))).toBe(false)
  })

  it.each([
    ["another user's scope", "tenant-a"],
    ["no scope", null],
  ] as const)("rejects %s before reading history and never overwrites it", async (_label, tenantScope) => {
    const test = fixture({ tenantScope })
    await expect(test.store.loadWithClient(test.client, test.input)).rejects.toThrow("root_task_history_scope_mismatch")
    expect(test.connects).toBe(0)
    expect(test.tenantScope).toBe(tenantScope)
    expect(test.queries.some(query => query.sql.includes("set_config"))).toBe(false)
    expect(test.queries.some(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))).toBe(false)
    expect(test.queries.some(query => query.sql.includes('FROM "agent_items" AS item'))).toBe(false)
  })

  it("leaves callback transaction rollback to its owner and preserves the legacy load wrapper", async () => {
    const callback = fixture({ candidateError: Object.assign(new Error("db unavailable"), { code: "42501" }) })
    await expect(callback.store.loadWithClient(callback.client, callback.input)).rejects.toMatchObject({ code: "42501" })
    expect(callback.connects).toBe(0)
    expect(callback.queries.some(query => ["BEGIN", "COMMIT", "ROLLBACK"].includes(query.sql))).toBe(false)

    const legacy = fixture()
    await expect(legacy.store.load(legacy.input)).resolves.toHaveLength(1)
    expect(legacy.connects).toBe(1)
    expect(legacy.queries[0]?.sql).toBe("BEGIN")
    expect(legacy.queries[1]?.sql).toContain("set_config")
    expect(legacy.queries[1]?.values).toEqual(["app.user_id", "user-1"])
    expect(legacy.tenantScope).toBe("user-1")
    expect(legacy.queries.at(-1)?.sql).toBe("COMMIT")
  })

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
    expect(scan?.sql).toContain("LIMIT $6")
    expect(scan?.values?.[5]).toBe(64)
    const graphReads = test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))
    expect(graphReads).toHaveLength(2)
    expect(graphReads.every(query => !["root-source-4", "root-source-5"].includes(String(query.values?.[3])))).toBe(true)
    expect(graphReads.every(query => query.values?.[1] === "session-1" && query.values?.[2] !== "turn-current"
      && query.values?.[0] === taskGraphItemId(String(query.values?.[3])))).toBe(true)
    expect(scan?.sql).not.toContain("turnInputDigest")
  })

  it("passes safe lessons and full counts from the already-loaded graph", async () => {
    const failed = fixture({ typedFailure: true })
    const failedOutcome = (await failed.store.load(failed.input))[0]
    expect(failedOutcome?.sourceNodeOrdinals).toEqual([1])
    expect(failedOutcome?.nodeLessons).toEqual([{ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: 1, criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met",
        check: { kind: "candidate_count_gte", role: "scout", minimum: 1 } }] }])
    expect(failedOutcome?.reportedOutputs).toBeUndefined()

    const reported = fixture({ reportedOutput: true })
    const reportedOutcome = (await reported.store.load(reported.input))[0]
    expect(reportedOutcome?.reportedOutputs).toEqual([{ role: "scout", candidateCount: 4, resultStatus: "partial" }])
    expect(reportedOutcome?.nodeLessons).toBeUndefined()
    const projection = reportedOutcome?.taskGraph.nodes[0]?.resultProjection
    expect(projection).toMatchObject({ candidateCount: 4, candidates: expect.any(Array) })
    if (projection?.availability !== "available" || projection.role !== "scout") throw new Error("scout result projection was unavailable")
    expect(projection.candidates).toHaveLength(3)

    for (const test of [failed, reported]) {
      expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(1)
      expect(test.queries.filter(query => query.sql.includes('SELECT task."id", task."status", task."role", task."taskType"'))).toHaveLength(1)
      expect(test.queries.filter(query => query.sql.includes("'task_graph.lifecycle', 'item.started', 'item.delta'"))).toHaveLength(1)
    }
  })

  it("uses the historical-only projection for cross-session sources and keeps the same-session default intact", async () => {
    const source = { ...candidate(1), sessionId: "session-cross", terminalStepSessionId: "session-cross",
      terminalStepEventSessionId: "session-cross" }
    const failed = fixture({ candidates: [source], typedFailure: true })
    failed.input = { ...failed.input, crossSessionRootTaskHistoryEnabled: true }
    const outcome = (await failed.store.load(failed.input))[0]
    expect(outcome?.sourceSessionDiffers).toBe(true)
    expect(outcome?.nodeLessons).toEqual([{ ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
      nodeOrdinal: 1, criterionFailures: [{ criterionOrdinal: 1, status: "failed", reasonCode: "criterion_not_met" }] }])
    expect(JSON.stringify(outcome?.nodeLessons)).not.toMatch(/check|minimum|executionFailureCategory|Count|count/)

    const reported = fixture({ candidates: [source], reportedOutput: true })
    reported.input = { ...reported.input, crossSessionRootTaskHistoryEnabled: true }
    const historicalOutput = (await reported.store.load(reported.input))[0]
    expect(historicalOutput?.reportedOutputs).toBeUndefined()

    const sameSession = fixture({ typedFailure: true })
    const defaultOutput = (await sameSession.store.load(sameSession.input))[0]
    expect(defaultOutput?.nodeLessons?.[0]?.criterionFailures[0]?.check).toEqual({ kind: "candidate_count_gte", role: "scout", minimum: 1 })
    sameSession.input = { ...sameSession.input, crossSessionRootTaskHistoryEnabled: true }
    const sameSessionCrossMode = (await sameSession.store.load(sameSession.input))[0]
    expect(sameSessionCrossMode?.sourceSessionDiffers).toBe(false)
    expect(sameSessionCrossMode?.nodeLessons?.[0]?.criterionFailures[0]?.check)
      .toEqual({ kind: "candidate_count_gte", role: "scout", minimum: 1 })

    const sameSessionReported = fixture({ reportedOutput: true })
    sameSessionReported.input = { ...sameSessionReported.input, crossSessionRootTaskHistoryEnabled: true }
    const sameSessionOutput = (await sameSessionReported.store.load(sameSessionReported.input))[0]
    expect(sameSessionOutput?.sourceSessionDiffers).toBe(false)
    expect(sameSessionOutput?.reportedOutputs).toEqual([{ role: "scout", candidateCount: 4, resultStatus: "partial" }])
  })

  it("caps the prior terminal scan and graph loads independently", async () => {
    const test = fixture({ candidates: Array.from({ length: 80 }, (_, index) => candidate(index + 1, String(index * 2 + 2))) })

    const outcomes = await test.store.load(test.input)

    expect(outcomes).toHaveLength(8)
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(8)
    const scan = test.queries.find(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))
    const windowLimit = scan?.sql.indexOf("LIMIT $6") ?? -1
    const rootsJoin = scan?.sql.indexOf("), roots AS (") ?? -1
    expect(scan?.values?.[5]).toBe(64)
    expect(scan?.sql).toContain('WHERE event."sessionId" = $1 AND event."sequence" < $4::bigint')
    expect(scan?.sql.indexOf('ORDER BY event."sequence" DESC')).toBeLessThan(windowLimit)
    expect(windowLimit).toBeGreaterThanOrEqual(0)
    expect(windowLimit).toBeLessThan(rootsJoin)
    expect(scan?.sql.slice(rootsJoin)).not.toContain("LIMIT $5")
  })

  it("applies the same 64-candidate and 8-graph bounds to cross-session scans", async () => {
    const candidates = Array.from({ length: 80 }, (_, index) => {
      const source = candidate(index + 1, String(index * 2 + 2))
      const sessionId = `session-cross-${index + 1}`
      return { ...source, sessionId, terminalStepSessionId: sessionId, terminalStepEventSessionId: sessionId,
        terminalCreatedAt: new Date(Date.parse("2026-10-07T12:00:00.000Z") - (index + 1) * 1_000) }
    })
    const test = fixture({ candidates })
    test.input = { ...test.input, crossSessionRootTaskHistoryEnabled: true }

    const outcomes = await test.store.load(test.input)

    expect(outcomes).toHaveLength(8)
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(8)
    const scan = test.queries.find(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))
    const windowLimit = scan?.sql.indexOf("LIMIT $6") ?? -1
    const rootsJoin = scan?.sql.indexOf("), roots AS (") ?? -1
    expect(scan?.values?.[5]).toBe(64)
    expect(scan?.sql).toContain('event."createdAt" < $4::timestamptz')
    expect(scan?.sql).toContain('ORDER BY event."createdAt" DESC, event."turnId" DESC')
    expect(windowLimit).toBeGreaterThanOrEqual(0)
    expect(windowLimit).toBeLessThan(rootsJoin)
    expect(scan?.sql.slice(rootsJoin)).not.toContain("LIMIT $5")
  })

  it("uses DB-time order and source-session graph scope only under the server opt-in", async () => {
    const newer = { ...candidate(3, "2000"), sessionId: "session-other", terminalStepSessionId: "session-other",
      terminalStepEventSessionId: "session-other", terminalCreatedAt: new Date("2026-10-07T11:50:00.000Z") }
    const older = { ...candidate(4, "3000"), sessionId: "session-third", terminalStepSessionId: "session-third",
      terminalStepEventSessionId: "session-third", terminalCreatedAt: new Date("2026-10-07T11:40:00.000Z") }
    const wrongOrigin = { ...candidate(5, "4000"), sessionId: "session-fourth", terminalStepSessionId: "session-fourth",
      terminalStepEventSessionId: "session-fourth", terminalCreatedAt: new Date("2026-10-07T11:55:00.000Z"), turnSource: "automation" }
    const test = fixture({ candidates: [older, newer, wrongOrigin] })
    test.input = { ...test.input, crossSessionRootTaskHistoryEnabled: true }

    const outcomes = await test.store.load(test.input)

    expect(outcomes.map(value => value.sourceTurnId)).toEqual(["turn-source-3", "turn-source-4"])
    const scan = test.queries.find(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))
    expect(scan?.sql).toContain('source_session."status" NOT IN (\'aborted\', \'archived\')')
    expect(scan?.sql).toContain('event."createdAt" < $4::timestamptz')
    expect(scan?.sql).toContain('ORDER BY event."createdAt" DESC, event."turnId" DESC')
    const graphReads = test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))
    expect(graphReads.map(query => query.values?.[1])).toEqual(["session-other", "session-third"])
    expect(test.queries.filter(query => query.sql.includes("FOR SHARE SKIP LOCKED")).map(query => query.values))
      .toEqual([["session-other", "user-1"], ["session-third", "user-1"]])
  })

  it.each(["archived", "aborted"] as const)("skips a source session locked after selection or changed to %s", async status => {
    const source = { ...candidate(1), sessionId: "session-other", terminalStepSessionId: "session-other",
      terminalStepEventSessionId: "session-other" }
    const test = fixture({ candidates: [source], sourceSessionStatusAtGraphLoad: status })
    test.input = { ...test.input, crossSessionRootTaskHistoryEnabled: true }

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.some(query => query.sql.includes("FOR SHARE SKIP LOCKED"))).toBe(true)
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
  })

  it("skips a source session held by another transaction without loading its graph", async () => {
    const source = { ...candidate(1), sessionId: "session-other", terminalStepSessionId: "session-other",
      terminalStepEventSessionId: "session-other" }
    const test = fixture({ candidates: [source], sourceSessionLockedAtGraphLoad: true })
    test.input = { ...test.input, crossSessionRootTaskHistoryEnabled: true }

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.some(query => query.sql.includes("FOR SHARE SKIP LOCKED"))).toBe(true)
    expect(test.queries.filter(query => query.sql.includes('FROM "agent_items" AS item'))).toHaveLength(0)
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

  it("requires one canonical completed-step receipt scoped before the terminal Turn event", async () => {
    const valid = candidate(12)
    const missingStep = { ...candidate(13), terminalStepId: null }
    const otherTurn = { ...candidate(14), terminalStepTurnId: "turn-elsewhere" }
    const otherRoot = { ...candidate(15), terminalStepTaskId: "root-elsewhere" }
    const otherSession = { ...candidate(16), terminalStepSessionId: "session-elsewhere" }
    const streamingStep = { ...candidate(17), terminalStepStatus: "streaming" }
    const failedStep = { ...candidate(18), terminalStepStatus: "failed" }
    const missingReceipt = { ...candidate(19), terminalStepEventCount: 0 }
    const wrongReceiptScope = { ...candidate(20), terminalStepEventTaskId: "root-elsewhere" }
    const wrongReceiptPayload = { ...candidate(21), terminalStepEventPayload: { stepId: "step-other", status: "completed", taskId: "root-source-21" } }
    const duplicateReceipt = { ...candidate(22), terminalStepEventCount: 2 }
    const outOfOrderReceipt = { ...candidate(23), terminalStepEventSequence: candidate(23).startSequence }
    const test = fixture({ candidates: [valid, missingStep, otherTurn, otherRoot, otherSession, streamingStep, failedStep,
      missingReceipt, wrongReceiptScope, wrongReceiptPayload, duplicateReceipt, outOfOrderReceipt] })

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
    expect(scan?.sql).toContain('event."idempotencyKey" = (\'turn:\' || roots."turnId" || \':event:step-completed:\' || terminal_step."id")')
    expect(scan?.sql).toContain('event."type" = \'step.completed\' AND event."correlationId" = terminal_step."id"')
    expect(scan?.sql).toContain('COUNT(*) OVER () AS "stepCompletedEventCount"')
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

  it("does not apply native fresh-root fallback to a missing persisted history Root objective", async () => {
    const test = fixture({ currentGoal: null, currentCriteria: [], currentInput: { input: { goal: "Explore roles", successCriteria: [] } } })

    await expect(test.store.load(test.input)).resolves.toEqual([])
    expect(test.queries.some(query => query.sql.includes("WITH terminal_window AS MATERIALIZED"))).toBe(false)
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
