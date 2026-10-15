import { describe, expect, it, vi } from "vitest"
import { assertApplicationFillPreflight, assertApplicationFillRetryReady } from "./application-fill-preflight"

type Query = { strings?: readonly string[]; values?: readonly unknown[] }
type Row = Record<string, unknown>

function fixture(materialRows: Array<{ jobId: string; resumeId: string | null; coverLetterId: string | null }>, coverRows: Array<{ id: string }> = []) {
  const query = vi.fn(async (input: unknown) => {
    const sql = ((input as Query).strings ?? []).join(" ")
    if (sql.includes('FROM "application_tasks" AS app')) return materialRows
    if (sql.includes('FROM "CoverLetter" AS cover')) return coverRows
    throw new Error(`unexpected preflight query: ${sql}`)
  })
  return { query, tx: { $queryRaw: query } as never }
}

function stoppedRetryFixture(fillers: Array<{ id: string; status: string; leaseOwner: string | null; leaseExpiresAt: Date | null }>, turn: Row | null = { id: "turn-1", status: "interrupted" }) {
  const query = vi.fn(async (input: unknown) => {
    const sql = ((input as Query).strings ?? []).join(" ")
    if (sql.includes('FROM "agent_turns"')) return turn ? [turn] : []
    if (sql.includes('FROM "sub_agent_tasks"')) return fillers
    throw new Error(`unexpected retry query: ${sql}`)
  })
  const findTurn = vi.fn(async () => turn)
  return { query, findTurn, tx: { $queryRaw: query, agentTurn: { findFirst: findTurn } } as never }
}

const stoppedTask = { fillTurnId: "turn-1", fillTurnSessionId: "session-1", fillTurnUserId: "user-1", status: "cancelled", checkpoint: "turn_stopped_before_submit" }
const retryIdentity = { userId: "user-1", sessionId: "session-1" }

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
    const test = stoppedRetryFixture([{ id: "filler-1", status: "interrupted", leaseOwner: null, leaseExpiresAt: null }])

    await expect(assertApplicationFillRetryReady(test.tx, stoppedTask, retryIdentity)).resolves.toBeUndefined()

    expect(test.findTurn).not.toHaveBeenCalled()
    const turnSql = ((test.query.mock.calls[0]?.[0] as Query).strings ?? []).join(" ")
    expect(turnSql).toContain('FROM "agent_turns"')
    expect(turnSql).toContain('"sessionId" =')
    expect(turnSql).toContain('"userId" =')
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

  it.each(["fill_prestart_failed", "taskgraph_fill_failed", "fill_outcome_uncertain", null])(
    "does not treat cancelled state with checkpoint %s as a stopped retry",
    async (checkpoint) => {
      const test = stoppedRetryFixture([{ id: "filler-1", status: "interrupted", leaseOwner: null, leaseExpiresAt: null }])

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
    const test = stoppedRetryFixture([...fillers])

    await expect(assertApplicationFillRetryReady(test.tx, stoppedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
  })

  it("rejects stopped retries whose application or Turn binding crosses the user/session", async () => {
    const test = stoppedRetryFixture([{ id: "filler-1", status: "interrupted", leaseOwner: null, leaseExpiresAt: null }])

    await expect(assertApplicationFillRetryReady(test.tx, { ...stoppedTask, fillTurnUserId: "other-user" }, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(test.findTurn).not.toHaveBeenCalled()

    const foreignTurn = stoppedRetryFixture([], null)
    await expect(assertApplicationFillRetryReady(foreignTurn.tx, stoppedTask, retryIdentity))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(foreignTurn.query).toHaveBeenCalledOnce()
  })
})
