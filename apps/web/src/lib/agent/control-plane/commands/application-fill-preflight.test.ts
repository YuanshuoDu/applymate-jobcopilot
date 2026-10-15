import { describe, expect, it, vi } from "vitest"
import { assertApplicationFillPreflight, assertApplicationFillRetryReady, lockApplicationFillTask } from "./application-fill-preflight"

type Query = { strings?: readonly string[]; values?: readonly unknown[] }
type Row = Record<string, unknown>
type Filler = { id: string; status: string; leaseOwner: string | null; leaseExpiresAt: Date | null; role?: string; taskType?: string }

function fixture(materialRows: Array<{ jobId: string; resumeId: string | null; coverLetterId: string | null }>, coverRows: Array<{ id: string }> = []) {
  const query = vi.fn(async (input: unknown) => {
    const sql = ((input as Query).strings ?? []).join(" ")
    if (sql.includes('FROM "application_tasks" AS app')) return materialRows
    if (sql.includes('FROM "CoverLetter" AS cover')) return coverRows
    throw new Error(`unexpected preflight query: ${sql}`)
  })
  return { query, tx: { $queryRaw: query } as never }
}

function retryFixture(fillers: Filler[], turn: Row | null = { id: "turn-1", status: "interrupted" }) {
  const query = vi.fn(async (input: unknown) => {
    const sql = ((input as Query).strings ?? []).join(" ")
    if (sql.includes('FROM "agent_turns"')) return turn ? [{ leaseOwnerId: null, leaseExpiresAt: null, ...turn }] : []
    if (sql.includes('FROM "sub_agent_tasks"')) return fillers.map((filler) => ({ role: "application_filler", taskType: "application_fill_for_review", ...filler }))
    throw new Error(`unexpected retry query: ${sql}`)
  })
  const findTurn = vi.fn(async () => turn)
  return { query, findTurn, tx: { $queryRaw: query, agentTurn: { findFirst: findTurn } } as never }
}

function cancelledTaskLockFixture(
  candidate: Row,
  lockedTask: Row,
  fillers: Filler[],
  turn: Row | null = { id: "turn-1", status: "interrupted" },
) {
  const query = vi.fn(async (input: unknown) => {
    const sql = ((input as Query).strings ?? []).join(" ")
    if (sql.includes('FROM "application_tasks"') && sql.includes("FOR UPDATE")) return [lockedTask]
    if (sql.includes('FROM "application_tasks"')) return [candidate]
    if (sql.includes('FROM "agent_turns"')) return turn ? [{ leaseOwnerId: null, leaseExpiresAt: null, ...turn }] : []
    if (sql.includes('FROM "sub_agent_tasks"')) return fillers.map((filler) => ({ role: "application_filler", taskType: "application_fill_for_review", ...filler }))
    throw new Error(`unexpected retry query: ${sql}`)
  })
  return { query, tx: { $queryRaw: query } as never }
}

const stoppedTask = { fillTurnId: "turn-1", fillTurnSessionId: "session-1", fillTurnUserId: "user-1", status: "cancelled", checkpoint: "turn_stopped_before_submit" }
const userCancelledTask = { ...stoppedTask, checkpoint: "cancelled_by_user" }
const failedTask = { ...stoppedTask, status: "failed", checkpoint: "fill_prestart_failed" }
const retryIdentity = { userId: "user-1", sessionId: "session-1" }
const explicitUserRetry = { explicitUserRetry: true }
const terminalLeaseFreeFiller = { id: "filler-1", status: "interrupted", leaseOwner: null, leaseExpiresAt: null }

describe("application fill persisted-material preflight", () => {
  it("uses only the owned task's job, resume, and optional cover-letter references", async () => {
    const test = fixture([{ jobId: "job-1", resumeId: "resume-1", coverLetterId: "cover-1" }], [{ id: "cover-1" }])

    await expect(assertApplicationFillPreflight(test.tx, "task-1", { userId: "user-1", sessionId: "session-1" })).resolves.toBeUndefined()

    const application = ((test.query.mock.calls[0]?.[0] as Query).strings ?? []).join(" ")
    expect(application).toContain('app."id" =')
    expect(application).toContain('app."userId" =')
    expect(application).toContain('app."sessionId" =')
    expect(application).toContain('job."userId" = app."userId"')
    expect(application).toContain('resume."userId" = app."userId"')
    expect(application).toContain('(resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")')
    expect(application).toContain("FOR SHARE OF app, job, resume")
    const cover = ((test.query.mock.calls[1]?.[0] as Query).strings ?? []).join(" ")
    expect(cover).toContain('cover."userId" =')
    expect(cover).toContain('cover."jobId" =')
    expect(cover).toContain("FOR SHARE OF cover")
  })

  it("fails closed when a required job or resume association is absent", async () => {
    const test = fixture([])

    await expect(assertApplicationFillPreflight(test.tx, "task-1", { userId: "user-1", sessionId: "session-1" }))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledOnce()
  })

  it("fails closed when the persisted cover letter is unavailable for this user and job", async () => {
    const test = fixture([{ jobId: "job-1", resumeId: "resume-1", coverLetterId: "foreign-cover" }])

    await expect(assertApplicationFillPreflight(test.tx, "task-1", { userId: "user-1", sessionId: "session-1" }))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledTimes(2)
  })

  it("allows a stopped retry only after its exact filler is terminal and lease-free", async () => {
    const test = retryFixture([terminalLeaseFreeFiller])

    await expect(assertApplicationFillRetryReady(test.tx, stoppedTask, retryIdentity)).resolves.toBeUndefined()

    expect(test.findTurn).not.toHaveBeenCalled()
    const turnSql = ((test.query.mock.calls[0]?.[0] as Query).strings ?? []).join(" ")
    expect(turnSql).toContain('FROM "agent_turns"')
    expect(turnSql).toContain('"sessionId" =')
    expect(turnSql).toContain('"userId" =')
    expect(turnSql).toContain('"leaseOwnerId"')
    expect(turnSql).toContain('"leaseExpiresAt"')
    expect(turnSql).toContain("FOR UPDATE")
    const sql = ((test.query.mock.calls[1]?.[0] as Query).strings ?? []).join(" ")
    expect(sql).toContain('task."sessionId" =')
    expect(sql).toContain('task."turnId" =')
    expect(sql).toContain("task.\"role\" = 'application_filler'")
    expect(sql).toContain("task.\"taskType\" = 'application_fill_for_review'")
    expect(sql).toContain('session."userId" =')
    expect(sql).toContain('turn."userId" =')
    expect(sql).toContain("FOR UPDATE OF task")
  })

  it.each(["fill_prestart_failed", "taskgraph_fill_failed"])("allows a %s retry only after its exact old filler is terminal and lease-free", async checkpoint => {
    const test = retryFixture([terminalLeaseFreeFiller])

    await expect(assertApplicationFillRetryReady(test.tx, { ...failedTask, checkpoint }, retryIdentity)).resolves.toBeUndefined()

    expect(test.findTurn).not.toHaveBeenCalled()
    const turnSql = ((test.query.mock.calls[0]?.[0] as Query).strings ?? []).join(" ")
    expect(turnSql).toContain('"id" =')
    expect(turnSql).toContain('"sessionId" =')
    expect(turnSql).toContain('"userId" =')
    expect(turnSql).toContain('"leaseOwnerId"')
    expect(turnSql).toContain('"leaseExpiresAt"')
    expect(turnSql).toContain("FOR UPDATE")
    const fillerSql = ((test.query.mock.calls[1]?.[0] as Query).strings ?? []).join(" ")
    expect(fillerSql).toContain('task."turnId" =')
    expect(fillerSql).toContain("task.\"role\" = 'application_filler' OR task.\"taskType\" = 'application_fill_for_review'")
    expect(fillerSql).toContain("FOR UPDATE OF task")
  })

  it.each([
    ["nonterminal Turn", { id: "turn-1", status: "in_progress" }],
    ["terminal Turn with an owner lease", { id: "turn-1", status: "interrupted", leaseOwnerId: "worker-1" }],
    ["terminal Turn with an expiry lease", { id: "turn-1", status: "interrupted", leaseExpiresAt: new Date() }],
  ] as const)("rejects a failed retry with a %s", async (_reason, turn) => {
    const test = retryFixture([terminalLeaseFreeFiller], turn)

    await expect(assertApplicationFillRetryReady(test.tx, failedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledOnce()
  })

  it.each([
    ["running with a live lease", [{ id: "filler-1", status: "running", leaseOwner: "worker-1", leaseExpiresAt: new Date() }]],
    ["terminal while still leased", [{ id: "filler-1", status: "failed", leaseOwner: "worker-1", leaseExpiresAt: null }]],
    ["missing the exact filler", []],
    ["using a different role", [{ ...terminalLeaseFreeFiller, role: "analyst" }]],
    ["using a different task type", [{ ...terminalLeaseFreeFiller, taskType: "application_submit" }]],
    ["ambiguous duplicate fillers", [terminalLeaseFreeFiller, { ...terminalLeaseFreeFiller, id: "filler-2" }]],
  ] as const)("rejects a failed retry when its exact filler is %s", async (_reason, fillers) => {
    const test = retryFixture([...fillers])

    await expect(assertApplicationFillRetryReady(test.tx, failedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledTimes(2)
  })

  it("locks a failed retry Turn and filler before locking the application task", async () => {
    const candidate = { id: "task-1", ...failedTask, confirmedAnswers: null }
    const test = cancelledTaskLockFixture(candidate, candidate, [terminalLeaseFreeFiller])

    await expect(lockApplicationFillTask(test.tx, "task-1", retryIdentity, true))
      .resolves.toMatchObject({ task: candidate, stoppedRetryReady: false })

    const queries = test.query.mock.calls.map(([input]) => ((input as Query).strings ?? []).join(" "))
    expect(queries[1]).toContain('FROM "agent_turns"')
    expect(queries[2]).toContain('FROM "sub_agent_tasks"')
    expect(queries[3]).toContain("FOR UPDATE")
    expect(queries[1]).not.toContain("FOR UPDATE OF task")
  })

  it.each(["fill_prestart_failed", "taskgraph_fill_failed", "fill_outcome_uncertain", null])(
    "does not treat cancelled state with checkpoint %s as a stopped retry",
    async (checkpoint) => {
      const test = retryFixture([terminalLeaseFreeFiller])

      await expect(assertApplicationFillRetryReady(test.tx, { ...stoppedTask, checkpoint }, retryIdentity))
        .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
      expect(test.findTurn).not.toHaveBeenCalled()
      expect(test.query).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["running with a live lease", [{ id: "filler-1", status: "running", leaseOwner: "worker-1", leaseExpiresAt: new Date() }]],
    ["running without a reported owner", [{ id: "filler-1", status: "running", leaseOwner: null, leaseExpiresAt: null }]],
    ["terminal while still holding a lease", [{ id: "filler-1", status: "interrupted", leaseOwner: "worker-1", leaseExpiresAt: new Date() }]],
    ["missing the bound filler", []],
    ["duplicated bound fillers", [
      { id: "filler-1", status: "interrupted", leaseOwner: null, leaseExpiresAt: null },
      { id: "filler-2", status: "interrupted", leaseOwner: null, leaseExpiresAt: null },
    ]],
  ] as const)("rejects a stopped retry when its filler is %s", async (_reason, fillers) => {
    const test = retryFixture([...fillers])

    await expect(assertApplicationFillRetryReady(test.tx, stoppedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
  })

  it("rejects stopped retries whose application or Turn binding crosses the user/session", async () => {
    const test = retryFixture([terminalLeaseFreeFiller])

    await expect(assertApplicationFillRetryReady(test.tx, { ...stoppedTask, fillTurnUserId: "other-user" }, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.findTurn).not.toHaveBeenCalled()

    const foreignTurn = retryFixture([], null)
    await expect(assertApplicationFillRetryReady(foreignTurn.tx, stoppedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(foreignTurn.query).toHaveBeenCalledOnce()
  })

  it("requires exactly one exact filler for an explicit user-cancelled retry", async () => {
    const test = retryFixture([terminalLeaseFreeFiller])

    await expect(assertApplicationFillRetryReady(test.tx, userCancelledTask, retryIdentity, explicitUserRetry)).resolves.toBeUndefined()

    expect(test.findTurn).not.toHaveBeenCalled()
    const turnSql = ((test.query.mock.calls[0]?.[0] as Query).strings ?? []).join(" ")
    expect(turnSql).toContain('"id" =')
    expect(turnSql).toContain('"sessionId" =')
    expect(turnSql).toContain('"userId" =')
    expect(turnSql).toContain('"leaseOwnerId"')
    expect(turnSql).toContain('"leaseExpiresAt"')
    expect(turnSql).toContain("FOR UPDATE")
    const fillerSql = ((test.query.mock.calls[1]?.[0] as Query).strings ?? []).join(" ")
    expect(fillerSql).toContain('task."sessionId" =')
    expect(fillerSql).toContain('task."turnId" =')
    expect(fillerSql).toContain("task.\"role\" = 'application_filler'")
    expect(fillerSql).toContain("task.\"taskType\" = 'application_fill_for_review'")
    expect(fillerSql).toContain("task.\"role\" = 'application_filler' OR task.\"taskType\" = 'application_fill_for_review'")
    expect(fillerSql).toContain("FOR UPDATE OF task")
  })

  it("rejects cancelled_by_user when cancellation happened before a filler existed", async () => {
    const test = retryFixture([])

    await expect(assertApplicationFillRetryReady(test.tx, userCancelledTask, retryIdentity, explicitUserRetry))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledTimes(2)
  })

  it.each([undefined, false])("fails closed for cancelled_by_user without explicit user retry (option=%s)", async (explicitUserRetryFlag) => {
    const test = retryFixture([terminalLeaseFreeFiller])
    const options = explicitUserRetryFlag === undefined ? {} : { explicitUserRetry: explicitUserRetryFlag }

    await expect(assertApplicationFillRetryReady(test.tx, userCancelledTask, retryIdentity, options))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).not.toHaveBeenCalled()
  })

  it.each([
    ["missing Turn", null],
    ["nonterminal Turn", { id: "turn-1", status: "in_progress" }],
    ["terminal Turn with an owner lease", { id: "turn-1", status: "interrupted", leaseOwnerId: "worker-1" }],
    ["terminal Turn with an expiry lease", { id: "turn-1", status: "interrupted", leaseExpiresAt: new Date() }],
  ] as const)("rejects cancelled_by_user when its %s is not terminal and lease-free", async (_reason, turn) => {
    const test = retryFixture([terminalLeaseFreeFiller], turn)

    await expect(assertApplicationFillRetryReady(test.tx, userCancelledTask, retryIdentity, explicitUserRetry))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledOnce()
  })

  it.each([
    ["running with a live lease", [{ id: "filler-1", status: "running", leaseOwner: "worker-1", leaseExpiresAt: new Date() }]],
    ["running without a reported owner", [{ id: "filler-1", status: "running", leaseOwner: null, leaseExpiresAt: null }]],
    ["terminal with an owner lease", [{ id: "filler-1", status: "interrupted", leaseOwner: "worker-1", leaseExpiresAt: null }]],
    ["terminal with an expiry lease", [{ id: "filler-1", status: "interrupted", leaseOwner: null, leaseExpiresAt: new Date() }]],
    ["wrong role", [{ id: "filler-1", role: "analyst", status: "interrupted", leaseOwner: null, leaseExpiresAt: null }]],
    ["wrong task type", [{ id: "filler-1", taskType: "application_submit", status: "interrupted", leaseOwner: null, leaseExpiresAt: null }]],
    ["ambiguous duplicate fillers", [terminalLeaseFreeFiller, { ...terminalLeaseFreeFiller, id: "filler-2" }]],
  ] as const)("rejects cancelled_by_user when the exact filler is %s", async (_reason, fillers) => {
    const test = retryFixture([...fillers])

    await expect(assertApplicationFillRetryReady(test.tx, userCancelledTask, retryIdentity, explicitUserRetry))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
  })

  it("locks a user-cancelled retry against the exact bound Turn and rejects stale task bindings", async () => {
    const candidate = { id: "task-1", ...userCancelledTask, confirmedAnswers: null }
    const test = cancelledTaskLockFixture(candidate, candidate, [terminalLeaseFreeFiller])

    await expect(lockApplicationFillTask(test.tx, "task-1", retryIdentity, true, explicitUserRetry))
      .resolves.toMatchObject({ task: candidate, stoppedRetryReady: false })

    const queries = test.query.mock.calls.map(([input]) => ((input as Query).strings ?? []).join(" "))
    expect(queries[0]).toContain('"id" =')
    expect(queries[0]).toContain('"userId" =')
    expect(queries[0]).toContain('"sessionId" =')
    expect(queries.map((sql) => sql.includes("FOR UPDATE"))).toEqual([false, true, true, true])

    const stale = cancelledTaskLockFixture(candidate, { ...candidate, fillTurnId: "turn-2" }, [terminalLeaseFreeFiller])
    await expect(lockApplicationFillTask(stale.tx, "task-1", retryIdentity, true, explicitUserRetry))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
  })

  it("does not pre-lock or accept an automatic retry of cancelled_by_user", async () => {
    const candidate = { id: "task-1", ...userCancelledTask, confirmedAnswers: null }
    const test = cancelledTaskLockFixture(candidate, candidate, [terminalLeaseFreeFiller])

    await expect(lockApplicationFillTask(test.tx, "task-1", retryIdentity, true))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.query).toHaveBeenCalledOnce()
  })

  it("requires exactly one filler for a Turn-stopped retry", async () => {
    const test = retryFixture([])

    await expect(assertApplicationFillRetryReady(test.tx, stoppedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
  })
})
