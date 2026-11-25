import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA } from "@jobcopilot/shared"
import type { LeasePool } from "./lease.js"
import { OBJECTIVE_FILL_PRESTART_FAILURE_BODY, recoverObjectiveFillPrestartFailures } from "./recovery-scanner-objective-fill-failure.js"

const userId = "user-fill", sessionId = "session-fill", turnId = "fill-turn", taskId = "application-task", jobId = "job-fill"
const approvalId = `objective-review:objective-review-${"a".repeat(40)}:2`
const commandKey = `agent-objective-reviewed-fill:${approvalId}`
const goal = "Fill the server-bound application form for user review. Never submit it."
const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId, reviewTurnId: "review-turn", materialProofHash: "b".repeat(64) }
const turnInput = { clientMessageId: commandKey, content: [{ type: "text", text: goal }], goal, reviewedApplicationMaterialSource: source }
const now = new Date("2026-11-25T10:00:00.000Z")

type Options = { candidates?: Array<{ userId: string; sessionId: string; turnId: string; updatedAt: Date }>; turn?: Record<string, unknown>;
  task?: Record<string, unknown>; children?: unknown[]; evidence?: unknown[]; approvals?: unknown[]; attempts?: unknown[]; insertCount?: number;
  discoveryError?: boolean }

function fixture(options: Options = {}) {
  const turn = { id: turnId, userId, sessionId, rootTaskId: null, source: "user", executionMode: "canonical_task_graph",
    input: turnInput, status: "failed", completedAt: now, leaseOwnerId: null, leaseExpiresAt: null, leaseStartedAt: null, ...options.turn }
  const task = { id: taskId, userId, sessionId, jobId, fillTurnId: turnId, fillTurnSessionId: sessionId, fillTurnUserId: userId,
    workerTaskId: null, status: "filling", checkpoint: "taskgraph_fill_queued", error: null, completedAt: null, ...options.task }
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  let beforeTask: Record<string, unknown> | null = null
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values })
    if (sql === "BEGIN") { beforeTask = { ...task }; return { rows: [], rowCount: 0 } }
    if (sql === "COMMIT") { beforeTask = null; return { rows: [], rowCount: 0 } }
    if (sql === "ROLLBACK") { if (beforeTask) Object.assign(task, beforeTask); return { rows: [], rowCount: 0 } }
    if (sql.includes("set_config")) return { rows: [{ set_config: userId }], rowCount: 1 }
    if (sql.includes('JOIN "application_tasks" AS task')) {
      if (options.discoveryError) throw new Error("private discovery detail")
      return { rows: options.candidates ?? [{ userId, sessionId, turnId, updatedAt: now }], rowCount: 1 }
    }
    if (sql.includes('FROM "agent_sessions" WHERE')) return { rows: [{ id: sessionId, userId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" WHERE "id"=$1')) return { rows: [turn], rowCount: 1 }
    if (sql.includes('FROM "application_tasks"') && sql.includes('WHERE "fillTurnId"')) return { rows: [task], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: options.children ?? [], rowCount: options.children?.length ?? 0 }
    if (sql.includes('FROM "application_task_events"')) return { rows: options.evidence ?? [], rowCount: options.evidence?.length ?? 0 }
    if (sql.includes('FROM "agent_approvals"')) return { rows: options.approvals ?? [], rowCount: options.approvals?.length ?? 0 }
    if (sql.includes('FROM "submission_attempt"')) return { rows: options.attempts ?? [], rowCount: options.attempts?.length ?? 0 }
    if (sql.includes('UPDATE "application_tasks"')) {
      Object.assign(task, { status: "failed", checkpoint: "fill_prestart_failed", error: OBJECTIVE_FILL_PRESTART_FAILURE_BODY })
      return { rows: [{ id: taskId }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "application_task_events"')) return options.insertCount === 0
      ? { rows: [], rowCount: 0 } : { rows: [{ id: values?.[0] }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  }), release: vi.fn() }
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool
  return { pool, client, calls, task, turn }
}

describe("Objective rootless Fill failure recovery", () => {
  it("settles the exact failed Turn and queued Task under owner, Session, Turn, then Task locks", async () => {
    const test = fixture()
    await expect(recoverObjectiveFillPrestartFailures(test.pool, 50, now)).resolves.toBe(1)

    expect(test.task).toMatchObject({ status: "failed", checkpoint: "fill_prestart_failed", error: OBJECTIVE_FILL_PRESTART_FAILURE_BODY })
    const lockOrder = ["set_config", 'FROM "agent_sessions" WHERE', 'FROM "agent_turns" WHERE "id"=$1',
      'WHERE "fillTurnId"=$1', 'FROM "sub_agent_tasks"', 'FROM "application_task_events"',
      'UPDATE "application_tasks"', 'INSERT INTO "application_task_events"']
    const positions = lockOrder.map(needle => test.calls.findIndex(call => call.sql.includes(needle)))
    expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!))).toBe(true)
    expect(test.calls.find(call => call.sql.includes("set_config"))?.values).toEqual(["app.user_id", userId])
    const sessionLock = test.calls.find(call => call.sql.includes('FROM "agent_sessions" WHERE'))
    const turnLock = test.calls.find(call => call.sql.includes('FROM "agent_turns" WHERE "id"=$1'))
    const taskLock = test.calls.find(call => call.sql.includes('FROM "application_tasks"') && call.sql.includes('WHERE "fillTurnId"'))
    expect(sessionLock?.sql).toContain("FOR UPDATE NOWAIT")
    expect(turnLock?.sql).toContain("FOR UPDATE NOWAIT")
    expect(taskLock?.sql).toContain('"fillTurnId"=$1 AND "userId"=$2 AND "sessionId"=$3')
    expect(taskLock?.sql).toContain("FOR UPDATE NOWAIT")
    expect(taskLock?.values).toEqual([turnId, userId, sessionId])
    const childCheck = test.calls.find(call => call.sql.includes('FROM "sub_agent_tasks"'))
    expect(childCheck?.sql).toContain('JOIN "agent_turns" AS turn')
    expect(childCheck?.sql).toContain('JOIN "agent_sessions" AS session')
    expect(childCheck?.sql).not.toContain('child."userId"')
    expect(childCheck?.values).toEqual([userId, sessionId, turnId])
    const approvalCheck = test.calls.find(call => call.sql.includes('FROM "agent_approvals"'))
    expect(approvalCheck?.sql).not.toContain('"toolCallId"')
    const writes = test.calls.filter(call => /^(UPDATE|INSERT)/.test(call.sql.trim()))
    expect(writes).toHaveLength(2)
    expect(writes[0]?.sql).toContain('"status"=\'failed\'')
    const event = writes[1]
    expect(event?.values?.[0]).toMatch(/^objective-fill-prestart-failure:[a-f0-9]{64}$/)
    expect(event?.values?.slice(2, 5)).toEqual(["fill_prestart_failed", OBJECTIVE_FILL_PRESTART_FAILURE_BODY,
      JSON.stringify({ schemaVersion: "agent-harness.v2.objective-fill-prestart-failure.v1", applicationTaskId: taskId,
        userId, sessionId, fillTurnId: turnId, approvalId, clientMessageId: commandKey })])
    expect(test.calls.some(call => call.sql.includes('UPDATE "agent_turns"') || call.sql.includes('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  const invalidOptions: Array<[string, Options]> = [
    ["a noncanonical command key", { turn: { input: { ...turnInput, clientMessageId: "other-command" } } }],
    ["an open marker shape", { turn: { input: { ...turnInput, reviewedApplicationMaterialSource: { ...source, extra: true } } } }],
    ["a nonfailed Turn", { turn: { status: "completed" } }],
    ["a leased Turn", { turn: { leaseOwnerId: "owner" } }],
    ["a different task owner", { task: { userId: "foreign-user" } }],
    ["a task outside the queued checkpoint", { task: { checkpoint: "browser_active" } }],
    ["an attached child", { children: [{ id: "child" }] }],
    ["browser-start evidence", { evidence: [{ id: "browser-event" }] }],
    ["an existing submission approval", { approvals: [{ id: "approval" }] }],
    ["an existing submission attempt", { attempts: [{ id: "attempt" }] }],
  ]
  it.each(invalidOptions)("leaves state unchanged for %s", async (_label, options) => {
    const test = fixture(options)
    await expect(recoverObjectiveFillPrestartFailures(test.pool, 50, now)).resolves.toBe(0)
    expect(test.task).toMatchObject({ status: "filling", checkpoint: options.task?.checkpoint ?? "taskgraph_fill_queued" })
    expect(test.calls.some(call => call.sql.includes('UPDATE "application_tasks"'))).toBe(false)
  })

  it("blocks an exact submit approval even when its tool-call identity is malformed", async () => {
    const test = fixture({ approvals: [{ id: "approval", toolCallId: "wrong" }] })
    await expect(recoverObjectiveFillPrestartFailures(test.pool, 50, now)).resolves.toBe(0)
    expect(test.calls.find(call => call.sql.includes('FROM "agent_approvals"'))?.values).toEqual([userId, sessionId, taskId, turnId])
    expect(test.calls.some(call => call.sql.includes('UPDATE "application_tasks"'))).toBe(false)
  })

  it("contains discovery errors and proceeds past an invalid candidate", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await expect(recoverObjectiveFillPrestartFailures(fixture({ discoveryError: true }).pool, 50, now)).resolves.toBe(0)
    expect(log).toHaveBeenCalledWith("[turn-recovery] objective fill failure discovery failed")
    log.mockRestore()

    const good = { userId, sessionId, turnId: "good-turn", updatedAt: now }
    const test = fixture({ candidates: [{ ...good, turnId: "bad-turn" }, good], turn: { id: "good-turn" }, task: { fillTurnId: "good-turn" } })
    await expect(recoverObjectiveFillPrestartFailures(test.pool, 50, now)).resolves.toBe(1)
  })

  it("rolls back the Task transition when its deterministic event cannot be inserted", async () => {
    const test = fixture({ insertCount: 0 })
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(recoverObjectiveFillPrestartFailures(test.pool, 50, now)).resolves.toBe(0)

    expect(test.task).toMatchObject({ status: "filling", checkpoint: "taskgraph_fill_queued" })
    expect(test.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
    expect(log).toHaveBeenCalledWith("[turn-recovery] objective fill failure candidate failed")
    log.mockRestore()
  })
})
