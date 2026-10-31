import { describe, expect, it } from "vitest"
import { advanceChildWaitSchedule, childWaitParentDeadlineElapsed, lockDueChildWaitForSession, lockDueChildWaitSessions } from "./durable-subagent-wait-fair-scheduling.js"

const checkedAt = new Date("2026-10-30T12:00:00.000Z")
const wait = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "child-parent-1",
  stepId: "step-1", rootTaskId: "root-1", parentAttempt: 2 }

function client(rowCount = 1, rows: Record<string, unknown>[] = [{ id: "session-1", userId: "user-1" }]) {
  const calls: { sql: string; params: unknown[] }[] = []
  return {
    calls,
    pool: { async query(sql: string, params: unknown[] = []) { calls.push({ sql, params }); return { rows, rowCount } } },
  }
}

describe("durable child wait fair scheduling", () => {
  it("locks the session page ordered by minimum effective due before applying its bound", async () => {
    const fake = client()
    await expect(lockDueChildWaitSessions(fake.pool as never, 25, checkedAt)).resolves.toEqual([{ id: "session-1", userId: "user-1" }])
    const query = fake.calls[0]!
    expect(query.sql).toContain('MIN(COALESCE(wait."nextReconcileAt", wait."suspendedAt"))')
    expect(query.sql).toContain('ORDER BY due."firstDue" ASC, session."id" ASC')
    expect(query.sql).toContain("LIMIT $1 FOR UPDATE OF session SKIP LOCKED")
    expect(query.sql).toContain("AT TIME ZONE 'UTC'")
    expect(query.params).toEqual([25, checkedAt])
  })

  it("locks at most one due wait per selected session in stable due order", async () => {
    const candidate = { ...wait, mode: "all", status: "waiting" }
    const fake = client(1, [candidate])
    const rows = await lockDueChildWaitForSession(fake.pool as never, { id: "session-1", userId: "user-1" }, checkedAt)
    const query = fake.calls[0]!
    expect(rows).toEqual([candidate])
    expect(query.sql).toContain('wait."parentTaskId", wait."stepId"')
    expect(query.sql).toContain('to_char(wait."deadlineAt", \'YYYY-MM-DD"T"HH24:MI:SS.MS\') || \'Z\' AS "deadlineAtUtc"')
    await advanceChildWaitSchedule(fake.pool as never, rows[0]!, "waiting")
    expect(fake.calls[1]?.params[5]).toBe("step-1")
    expect(query.sql).toContain('COALESCE(wait."nextReconcileAt", wait."suspendedAt") <= ($2::timestamptz AT TIME ZONE \'UTC\')')
    expect(query.sql).toContain('ORDER BY COALESCE(wait."nextReconcileAt", wait."suspendedAt") ASC, wait."createdAt" ASC, wait."id" ASC')
    expect(query.sql).toContain('LIMIT 1 FOR UPDATE OF parent, step, wait SKIP LOCKED')
    expect(query.sql).toContain('wait."stepId"')
    expect(query.sql).not.toContain('AS "deadlineElapsed"')
    expect(query.params).toEqual(["session-1", checkedAt, "user-1"])
  })

  it("advances a valid unresolved wait only to the earlier of DB-now plus five seconds and its deadline", async () => {
    const fake = client()
    await expect(advanceChildWaitSchedule(fake.pool as never, wait, "waiting")).resolves.toBe(true)
    const query = fake.calls[0]!
    expect(query.sql).toContain('SET "nextReconcileAt" = LEAST(timezone(\'UTC\', clock_timestamp()) + INTERVAL \'5 seconds\', wait."deadlineAt")')
    expect(query.sql).toContain('COALESCE(wait."nextReconcileAt", wait."suspendedAt") <= timezone(\'UTC\', clock_timestamp())')
    expect(query.sql).toContain('parent."attemptCount" = $8')
    expect(query.sql).toContain('step."ordinal" = (SELECT MAX(current."ordinal")')
    expect(query.sql).not.toContain('"status" = $')
    expect(query.sql).not.toContain('"result" =')
    expect(query.sql).not.toContain('"updatedAt" =')
    expect(query.params).toEqual(["wait-1", "user-1", "session-1", "turn-1", "child-parent-1", "step-1", "root-1", 2])
  })

  it("backs off only the scheduler field for ignored owner-scoped rows", async () => {
    const fake = client()
    await advanceChildWaitSchedule(fake.pool as never, wait, "ignored")
    expect(fake.calls[0]?.sql).toContain('SET "nextReconcileAt" = timezone(\'UTC\', clock_timestamp()) + INTERVAL \'5 seconds\'')
    expect(fake.calls[0]?.sql).not.toContain('wait."deadlineAt")')
  })

  it("returns a lost scheduler fence instead of claiming the wait advanced", async () => {
    const fake = client(0)
    await expect(advanceChildWaitSchedule(fake.pool as never, wait, "ignored")).resolves.toBe(false)
  })

  it("confirms only an exact current wait lineage before skipping an elapsed parent deadline", async () => {
    const fake = client(1, [{ expired: true }])
    await expect(childWaitParentDeadlineElapsed(fake.pool as never, wait)).resolves.toBe(true)
    const query = fake.calls[0]!
    expect(query.sql).toContain('parent."absoluteDeadlineAt" <= timezone(\'UTC\', clock_timestamp())')
    expect(query.sql).toContain('parent."attemptCount" = $8')
    expect(query.sql).toContain('wait."stepId" = $6')
    expect(query.sql).toContain("step.\"ordinal\" = (SELECT MAX(current.\"ordinal\")")
    expect(query.params).toEqual(["wait-1", "user-1", "session-1", "turn-1", "child-parent-1", "step-1", "root-1", 2])
  })

  it("fails closed when the parent deadline scope is missing or ambiguous", async () => {
    await expect(childWaitParentDeadlineElapsed(client(0).pool as never, wait)).rejects.toThrow("scope could not be revalidated")
    await expect(childWaitParentDeadlineElapsed(client(2, [{ expired: true }, { expired: true }]).pool as never, wait))
      .rejects.toThrow("scope could not be revalidated")
  })
})
