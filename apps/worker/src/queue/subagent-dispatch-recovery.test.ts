import { describe, expect, it, vi } from "vitest"

import type pg from "pg"
import { repairStaleSubagentDispatches } from "./subagent-dispatch-recovery.js"
import type { SubagentJobPayload } from "../runtime/subagents/types.js"

const payload: SubagentJobPayload = { taskId: "task-1", sessionId: "session-1", rootTaskId: "root-1", ownerId: "worker-1" }

type RepairCandidate = {
  id: string
  sessionId: string
  rootTaskId: string
  status?: string
  rootStatus?: string
  turnStatus?: string
  sessionStatus?: string
  interruptRequestedAt?: string | null
  attemptCount?: number
  maxAttempts?: number
  scopeValid?: boolean
}
type StaleCandidate = RepairCandidate & {
  userId?: string
  startedAt?: boolean
  leaseOwner?: string | null
  leaseExpiresAt?: string | null
  updatedAt?: Date
  publishedAt?: Date | null
  topic?: string
  aggregateId?: string
  key?: string
  payload?: unknown
}
type StaleRepairOptions = { candidate?: StaleCandidate | null; candidates?: StaleCandidate[]; failReset?: Error }
type StaleDispatch = { id: string; taskId: string; sessionId: string; key: string; topic: string; aggregateId: string; payload: unknown; publishedAt: Date | null; attemptCount: number; lastError: string | null }

function staleCandidate(overrides: Partial<StaleCandidate> = {}): StaleCandidate {
  return {
    id: "task-1", sessionId: "session-1", rootTaskId: "root-1", userId: "user-1", status: "queued", startedAt: true,
    leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date("2026-09-14T00:00:00.000Z"), publishedAt: new Date("2026-09-13T00:00:00.000Z"),
    topic: "agent.subagent.dispatch", aggregateId: "session-1", key: "subagent-dispatch:task-1", payload: { ...payload, ownerId: "old-owner" },
    ...overrides,
  }
}

function staleCandidateEligible(candidate: StaleCandidate): boolean {
  const terminal = new Set(["completed", "failed", "interrupted", "cancelled", "closed"])
  return (candidate.status === "queued" || candidate.status === "retrying")
    && candidate.startedAt !== false && candidate.leaseOwner == null && candidate.leaseExpiresAt == null
    && candidate.interruptRequestedAt == null && (candidate.attemptCount ?? 0) < (candidate.maxAttempts ?? 3)
    && !terminal.has(candidate.rootStatus ?? "running") && !terminal.has(candidate.turnStatus ?? "in_progress")
    && candidate.sessionStatus !== "aborted" && candidate.sessionStatus !== "archived" && candidate.publishedAt !== null
    && candidate.publishedAt !== undefined && candidate.updatedAt !== undefined && candidate.publishedAt < candidate.updatedAt
    && candidate.scopeValid !== false
    && candidate.topic === "agent.subagent.dispatch" && candidate.aggregateId === candidate.sessionId
    && candidate.key === `subagent-dispatch:${candidate.id}`
}

function staleRepairPool(options: StaleRepairOptions = {}) {
  const candidates = options.candidates ?? [options.candidate === undefined ? staleCandidate() : options.candidate].filter((row): row is StaleCandidate => row !== null)
  const dispatches: StaleDispatch[] = candidates.map(candidate => ({
    id: `dispatch-${candidate.id}`, taskId: candidate.id, sessionId: candidate.sessionId, key: candidate.key ?? `subagent-dispatch:${candidate.id}`,
    topic: candidate.topic ?? "agent.subagent.dispatch", aggregateId: candidate.aggregateId ?? candidate.sessionId,
    payload: candidate.payload ?? { ...payload, taskId: candidate.id, sessionId: candidate.sessionId, rootTaskId: candidate.rootTaskId, ownerId: "old-owner" },
    publishedAt: candidate.publishedAt ?? null, attemptCount: 4, lastError: "old-error",
  }))
  const calls: Array<[string, unknown[]?]> = []
  let snapshot: StaleDispatch[] | null = null
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push([sql, params])
      if (sql === "BEGIN") {
        snapshot = dispatches.map(row => ({ ...row, payload: JSON.parse(JSON.stringify(row.payload)) as unknown }))
        return { rows: [], rowCount: 0 }
      }
      if (sql === "COMMIT") return { rows: [], rowCount: 0 }
      if (sql === "ROLLBACK") {
        if (snapshot) dispatches.splice(0, dispatches.length, ...snapshot)
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes("set_config('app.user_id'")) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions" AS session') && sql.includes('dispatch."publishedAt" IS NOT NULL') && sql.includes("LIMIT $2 FOR UPDATE SKIP LOCKED")) {
        const limit = Number(params?.[1] ?? 50)
        const rows = candidates.filter(staleCandidateEligible).sort((a, b) => {
          const time = (a.updatedAt?.getTime() ?? 0) - (b.updatedAt?.getTime() ?? 0)
          return time || a.id.localeCompare(b.id)
        }).slice(0, limit).map(row => ({ id: row.sessionId }))
        return { rows, rowCount: rows.length }
      }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task, dispatch")) {
        const sessionIds = (params?.[0] as string[] | undefined) ?? []
        const limit = Number(params?.[2] ?? 50)
        const rows = candidates.filter(row => sessionIds.includes(row.sessionId) && staleCandidateEligible(row)).sort((a, b) => {
          const time = (a.updatedAt?.getTime() ?? 0) - (b.updatedAt?.getTime() ?? 0)
          return time || a.id.localeCompare(b.id)
        }).slice(0, limit).map(row => ({ taskId: row.id, sessionId: row.sessionId, rootTaskId: row.rootTaskId, userId: row.userId, dispatchId: `dispatch-${row.id}`, payload: row.payload }))
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('UPDATE "agent_outbox" AS dispatch')) {
        if (options.failReset) throw options.failReset
        const id = String(params?.[1])
        const row = dispatches.find(item => item.id === id)
        const candidate = candidates.find(item => `dispatch-${item.id}` === id)
        if (!row || !candidate || !staleCandidateEligible(candidate)) return { rows: [], rowCount: 0 }
        row.payload = JSON.parse(String(params?.[0])) as unknown
        row.publishedAt = null
        row.lastError = null
        row.attemptCount += 1
        candidate.publishedAt = null
        return { rows: [], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool, calls, client, candidates, dispatches }
}

describe("stale subagent dispatch recovery", () => {
  it.each(["queued", "retrying"] as const)("repairs a %s task only after it has started", async status => {
    const fake = staleRepairPool({ candidate: staleCandidate({ status }) })
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker")).resolves.toBe(1)
  })

  it("resets a stale published dispatch with the recovery owner and fences the SQL", async () => {
    const fake = staleRepairPool()
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker", 1)).resolves.toBe(1)
    expect(fake.dispatches[0]).toMatchObject({ publishedAt: null, lastError: null, attemptCount: 5, payload: { ...payload, ownerId: "recovery-worker" } })
    const sessionIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions" AS session') && sql.includes('dispatch."publishedAt" IS NOT NULL') && sql.includes("FOR UPDATE SKIP LOCKED"))
    const taskIndex = fake.calls.findIndex(([sql]) => sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes("FOR UPDATE OF task, dispatch"))
    const tenantIndex = fake.calls.findIndex(([sql]) => sql.includes("set_config('app.user_id'"))
    const updateIndex = fake.calls.findIndex(([sql]) => sql.startsWith('UPDATE "agent_outbox" AS dispatch'))
    expect(sessionIndex).toBeGreaterThan(-1)
    expect(sessionIndex).toBeLessThan(taskIndex)
    expect(taskIndex).toBeLessThan(tenantIndex)
    expect(tenantIndex).toBeLessThan(updateIndex)
    expect(fake.calls[taskIndex]?.[0]).toMatch(/ORDER BY task\."updatedAt" ASC, task\."id" ASC\s+LIMIT \$3 FOR UPDATE OF task, dispatch SKIP LOCKED/)
    expect(fake.calls[taskIndex]?.[0]).toContain('task."startedAt" IS NOT NULL')
    expect(fake.calls[taskIndex]?.[0]).toContain('task."leaseOwner" IS NULL')
    expect(fake.calls[taskIndex]?.[0]).toContain('task."leaseExpiresAt" IS NULL')
    expect(fake.calls[taskIndex]?.[0]).toContain('task."interruptRequestedAt" IS NULL')
    expect(fake.calls[taskIndex]?.[0]).toContain('dispatch."publishedAt" < task."updatedAt"')
    expect(fake.calls[tenantIndex]?.[1]).toEqual(["user-1"])
    expect(fake.calls[updateIndex]?.[0]).toContain('dispatch."idempotencyKey" = $4')
    expect(fake.calls[updateIndex]?.[0]).toContain('dispatch."aggregateId" = $5')
    expect(fake.calls[updateIndex]?.[0]).toContain('task."rootTaskId" = $7')
    expect(fake.calls[updateIndex]?.[0]).toContain('"attemptCount" = dispatch."attemptCount" + 1')
    expect(fake.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("does not repair the same dispatch on a repeated scan", async () => {
    const fake = staleRepairPool()
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker")).resolves.toBe(1)
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker-2")).resolves.toBe(0)
    expect(fake.calls.filter(([sql]) => sql.startsWith('UPDATE "agent_outbox" AS dispatch'))).toHaveLength(1)
    expect(fake.dispatches[0]?.payload).toEqual({ ...payload, ownerId: "recovery-worker" })
  })

  const staleInvalidCandidates: Array<[string, Partial<StaleCandidate>]> = [
    ["running task", { status: "running" }], ["never-started task", { startedAt: false }], ["leased task", { leaseOwner: "other-worker" }],
    ["expiring lease", { leaseExpiresAt: "2026-09-14T00:00:01.000Z" }], ["interrupted task", { interruptRequestedAt: "2026-09-14T00:00:01.000Z" }],
    ["attempt exhausted", { attemptCount: 3, maxAttempts: 3 }], ["terminal root", { rootStatus: "completed" }],
    ["terminal turn", { turnStatus: "closed" }], ["closed session", { sessionStatus: "archived" }],
    ["fresh dispatch", { publishedAt: new Date("2026-09-15T00:00:00.000Z") }], ["wrong topic", { topic: "agent.other" }],
    ["wrong key", { key: "subagent-dispatch:other-task" }], ["wrong aggregate", { aggregateId: "other-session" }],
    ["cross-scope task lineage", { scopeValid: false }],
    ["cross-scope payload", { payload: { ...payload, sessionId: "other-session", ownerId: "old-owner" } }],
    ["cross-root payload", { payload: { ...payload, rootTaskId: "other-root", ownerId: "old-owner" } }],
  ]
  it.each(staleInvalidCandidates)("fails closed for a %s", async (_label, overrides) => {
    const fake = staleRepairPool({ candidate: staleCandidate(overrides) })
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker")).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox" AS dispatch'))).toBe(false)
    expect(fake.dispatches[0]?.publishedAt).not.toBeNull()
  })

  it("does not reset a dispatch published at the task update time", async () => {
    const fake = staleRepairPool({ candidate: staleCandidate({ publishedAt: new Date("2026-09-14T00:00:00.000Z") }) })
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker")).resolves.toBe(0)
    expect(fake.calls.some(([sql]) => sql.startsWith('UPDATE "agent_outbox" AS dispatch'))).toBe(false)
  })

  it("rolls back the stale reset when the outbox update fails", async () => {
    const fake = staleRepairPool({ failReset: new Error("outbox unavailable") })
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker")).rejects.toThrow("outbox unavailable")
    expect(fake.calls.some(([sql]) => sql === "ROLLBACK")).toBe(true)
    expect(fake.dispatches[0]).toMatchObject({ publishedAt: expect.any(Date), lastError: "old-error", attemptCount: 4, payload: { ownerId: "old-owner" } })
  })

  it("uses updatedAt/id order and clamps work to the requested limit", async () => {
    const early = staleCandidate({ id: "task-early", updatedAt: new Date("2026-09-13T00:00:00.000Z"), publishedAt: new Date("2026-09-12T00:00:00.000Z"), payload: { ...payload, taskId: "task-early", ownerId: "old-owner" }, key: `subagent-dispatch:task-early` })
    const late = staleCandidate({ id: "task-late", updatedAt: new Date("2026-09-14T00:00:00.000Z"), payload: { ...payload, taskId: "task-late", ownerId: "old-owner" }, key: `subagent-dispatch:task-late` })
    const fake = staleRepairPool({ candidates: [late, early] })
    await expect(repairStaleSubagentDispatches(fake.pool, "recovery-worker", 1)).resolves.toBe(1)
    expect(fake.dispatches.find(row => row.taskId === "task-early")?.publishedAt).toBeNull()
    expect(fake.dispatches.find(row => row.taskId === "task-late")?.publishedAt).not.toBeNull()
    const sessionScan = fake.calls.find(([sql]) => sql.includes('dispatch."publishedAt" IS NOT NULL') && sql.includes("LIMIT $2"))
    const taskScan = fake.calls.find(([sql]) => sql.includes("FOR UPDATE OF task, dispatch"))
    expect(sessionScan?.[0]).toMatch(/ORDER BY session\."updatedAt" ASC, session\."id" ASC\s+LIMIT \$2 FOR UPDATE SKIP LOCKED/)
    expect(taskScan?.[1]).toEqual([["session-1"], "agent.subagent.dispatch", 1])
  })
})
