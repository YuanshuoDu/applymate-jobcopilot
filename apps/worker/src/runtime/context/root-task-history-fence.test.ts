import type pg from "pg"
import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { readRootTaskHistoryFence, rootTaskHistoryOrigin, type RootTaskHistoryFenceInput } from "./root-task-history-fence.js"
import { rootTaskObjectiveDigest } from "./root-task-objective.js"

type Row = Record<string, unknown>
type Options = Readonly<{
  turnInput?: unknown
  rootGoal?: string
  rootCriteria?: readonly string[]
  stepAttempt?: number
  startRows?: readonly Row[]
  rootStatus?: string
}>

function start(sequence = "20"): Row {
  return {
    sessionId: "session-1", turnId: "turn-current", taskId: "root-current", itemId: null, sequence,
    type: "turn.started", actor: "orchestrator", correlationId: "turn-current",
    idempotencyKey: "turn:turn-current:event:turn-started", payload: { taskId: "root-current", rootTaskId: "root-current" },
    createdAt: new Date("2026-10-07T12:00:00.000Z"), startEventCount: 1,
  }
}

function fixture(options: Options = {}) {
  const queries: string[] = []
  const client = {
    async query(sql: string) {
      queries.push(sql)
      if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }] }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-current" }] }
      if (sql.includes("FOR UPDATE OF task")) return { rows: [{
        id: "root-current", userId: "user-1", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current",
        parentTaskId: null, role: "orchestrator", taskType: "root", status: options.rootStatus ?? "running",
        leaseOwner: "worker", attemptCount: 2, interruptRequestedAt: null,
        goal: options.rootGoal ?? "Plan a role", successCriteria: options.rootCriteria ?? ["Compare roles"],
      }] }
      if (sql.includes('SELECT "id" FROM "agent_steps"')) return { rows: [{ id: "step-current" }] }
      if (sql.includes("WITH wall_clock")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
      if (sql.includes('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"')) return { rows: [{
        id: "step-current", sessionId: "session-1", turnId: "turn-current", taskId: "root-current",
        attempt: options.stepAttempt ?? 1, status: "streaming",
      }] }
      if (sql.includes('SELECT "id", "sessionId", "userId", "rootTaskId", "status", "source", "input"')) return { rows: [{
        id: "turn-current", sessionId: "session-1", userId: "user-1", rootTaskId: "root-current", status: "in_progress",
        source: "user", input: options.turnInput ?? { goal: " Plan a role " },
      }] }
      if (sql.includes("event.\"type\" = 'turn.started'")) return { rows: options.startRows ?? [start()] }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  const input: RootTaskHistoryFenceInput = {
    lease: { turnId: "turn-current", sessionId: "session-1", ownerId: "worker", userId: "user-1", leaseVersion: 3,
      leaseStartedAt: new Date(1), leaseExpiresAt: new Date(10_000) },
    rootTaskId: "root-current", rootAttemptCount: 2, stepId: "step-current", now: new Date(2_000),
  }
  return { client: client as unknown as pg.PoolClient, input, queries }
}

describe("root task history current fence", () => {
  it("locks the live ordinary Root and binds its persisted Turn objective to one canonical start", async () => {
    const test = fixture()

    await expect(readRootTaskHistoryFence(test.client, test.input)).resolves.toEqual({
      currentStartSequence: 20n,
      objectiveDigest: rootTaskObjectiveDigest({ goal: "Plan a role", criteria: [{ criterionId: "criterion-1", requirement: "Compare roles" }] }),
    })
    const index = (part: string) => test.queries.findIndex(sql => sql.includes(part))
    expect(index('SELECT "id" FROM "agent_sessions"')).toBeLessThan(index('SELECT "id" FROM "agent_turns"'))
    expect(index('SELECT "id" FROM "agent_turns"')).toBeLessThan(index("FOR UPDATE OF task"))
    expect(index("FOR UPDATE OF task")).toBeLessThan(index('SELECT "id" FROM "agent_steps"'))
    expect(index('SELECT "id" FROM "agent_steps"')).toBeLessThan(index('SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status"'))
    expect(test.queries[test.queries.length - 1]).toContain("turn.started")
  })

  it("does not read history receipts when the persisted Turn and Root objectives conflict", async () => {
    const test = fixture({ turnInput: { goal: "Different objective" } })

    await expect(readRootTaskHistoryFence(test.client, test.input)).resolves.toBeUndefined()
    expect(test.queries.some(sql => sql.includes("turn.started"))).toBe(false)
  })

  it("rejects a current objective whose valid fallback requirement exceeds 2,000 UTF-8 bytes", async () => {
    const goal = `${"€".repeat(833)}a`
    expect(Buffer.byteLength(goal, "utf8")).toBe(2_500)
    const test = fixture({ turnInput: { goal, successCriteria: [] }, rootGoal: goal, rootCriteria: [] })

    await expect(readRootTaskHistoryFence(test.client, test.input)).resolves.toBeUndefined()
    expect(test.queries.some(sql => sql.includes("turn.started"))).toBe(false)
  })

  it("rejects selected-job context when the selection field is present at either input level", async () => {
    for (const turnInput of [
      { goal: "Plan a role", selectedJobPreparation: null },
      { input: { goal: "Plan a role", selectedJobPreparation: "malformed" } },
    ]) {
      const test = fixture({ turnInput })
      await expect(readRootTaskHistoryFence(test.client, test.input)).resolves.toBeUndefined()
      expect(test.queries.some(sql => sql.includes("turn.started"))).toBe(false)
    }
  })

  it("requires one canonical current Root start receipt", async () => {
    for (const startRows of [[], [start(), { ...start("21"), startEventCount: 2 }], [{ ...start(), actor: "system" }]]) {
      const test = fixture({ startRows })
      await expect(readRootTaskHistoryFence(test.client, test.input)).resolves.toBeUndefined()
    }
  })

  it("derives opt-in source, validated intent, and DB-time cutoff from persisted current rows", async () => {
    const test = fixture({ turnInput: { goal: " Plan a role ", intent: { kind: "interactive_discovery_shortlist", version: 1 } } })
    const input = { ...test.input, crossSessionRootTaskHistoryEnabled: true }

    await expect(readRootTaskHistoryFence(test.client, input)).resolves.toMatchObject({
      currentStartSequence: 20n, currentStartCreatedAt: new Date("2026-10-07T12:00:00.000Z"),
      currentOrigin: JSON.stringify(["user", "interactive_discovery_shortlist", 1]),
    })
    expect(rootTaskHistoryOrigin("automation", { goal: "x" })).toBe(JSON.stringify(["automation", "none"]))
    expect(rootTaskHistoryOrigin("user", { goal: "x", intent: { kind: "other", version: 1 } })).toBeUndefined()
    expect(rootTaskHistoryOrigin("user", { goal: "x", intent: { kind: "interactive_discovery_shortlist", version: 1, extra: true } })).toBeUndefined()
  })

  it("keeps legacy same-session eligibility unchanged for unknown intents when opt-in is absent", async () => {
    const test = fixture({ turnInput: { goal: " Plan a role ", intent: { kind: "future_intent", version: 9 } } })
    await expect(readRootTaskHistoryFence(test.client, test.input)).resolves.toMatchObject({ objectiveDigest: expect.any(String) })
  })

  it("rejects a noncanonical current streaming Step or Root status", async () => {
    const retry = fixture({ stepAttempt: 2 })
    await expect(readRootTaskHistoryFence(retry.client, retry.input)).rejects.toThrow("root_task_history_current_step_fenced")

    const nonrunning = fixture({ rootStatus: "completed" })
    await expect(readRootTaskHistoryFence(nonrunning.client, nonrunning.input)).rejects.toThrow("root_task_history_current_root_fenced")
  })
})
