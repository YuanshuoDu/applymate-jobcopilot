import { describe, expect, it, vi } from "vitest"
import { assertApplicationFillPreflight } from "./application-fill-preflight"

type Query = { strings?: readonly string[]; values?: readonly unknown[] }

function fixture(materialRows: Array<{ jobId: string; resumeId: string | null; coverLetterId: string | null }>, coverRows: Array<{ id: string }> = []) {
  const query = vi.fn(async (input: unknown) => {
    const sql = ((input as Query).strings ?? []).join(" ")
    if (sql.includes('FROM "application_tasks" AS app')) return materialRows
    if (sql.includes('FROM "CoverLetter" AS cover')) return coverRows
    throw new Error(`unexpected preflight query: ${sql}`)
  })
  return { query, tx: { $queryRaw: query } as never }
}

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
})
