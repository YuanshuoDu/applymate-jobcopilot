import { describe, expect, it, vi } from "vitest"

vi.mock("./role-policy.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./role-policy.js")>()
  const scout = actual.getSubagentRolePolicy("scout")!
  return { ...actual, getSubagentRolePolicy: (role: string) => role === "wait-enabled" ? { ...scout, canManageChildren: true } : actual.getSubagentRolePolicy(role) }
})
import { projectDurableSubagentWait, recoverExpiredWaitRegistration, registerDurableSubagentWait, safeSubagentWaitJson, waitResult } from "./durable-subagent-wait-store.js"
import type { SubagentLease } from "./types.js"

const now = new Date("2026-10-22T10:00:00.000Z")
const targetIds = ["child-1", "child-2"]

function lease(): SubagentLease {
  return {
    id: "parent-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    parentTaskId: "root-1", path: "root/1", depth: 1, role: "researcher", taskType: "research", status: "running",
    goal: "goal", constraints: [], successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: null,
    result: null, failureReason: null, attemptCount: 3, maxAttempts: 4, leaseOwner: "worker-1",
    leaseExpiresAt: new Date(now.getTime() + 60_000), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
    ownerId: "worker-1", signal: new AbortController().signal,
  }
}

function fixture() {
  const calls: { sql: string; params: unknown[] }[] = []
  const state: { existing?: Record<string, unknown>; inserted?: Record<string, unknown>; insertCount: number; leaseExpiresAt?: Date; leaseOwner?: string; attemptCount?: number;
    recovery?: boolean; recoveryRole?: string; recoveryInput?: Record<string, unknown>; recoveryEventKey?: string;
    recoveryRows?: Record<string, unknown>[]; startedAt?: Date | null; targetParentId?: string } = { insertCount: 0 }
  const targets = targetIds.map((id, index) => ({
    id, parentTaskId: state.targetParentId ?? "parent-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1",
    status: index === 0 ? "completed" : "running", role: `role-${index + 1}`,
    result: index === 0 ? { summary: "safe result", apiKey: "super-secret", detail: "Bearer hidden-token" } : null,
    failureReason: null,
  }))
  const client = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params })
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
      if (sql.includes('started."createdAt"') && sql.includes("FOR UPDATE OF task, step, call")) {
        if (!state.recovery) return { rows: [], rowCount: 0 }
        const rows = state.recoveryRows ?? [{
          eventId: "start-event-1", eventIdempotencyKey: state.recoveryEventKey ?? "task:parent-1:event:tool-started:wait-call-1",
          createdAt: state.startedAt === undefined ? new Date(now.getTime() - 10_000) : state.startedAt,
          role: state.recoveryRole ?? "wait-enabled", allowedActions: ["wait_subagents"], stepId: "step-1",
          content: { toolCallId: "wait-call-1", toolName: "wait_subagents", toolVersion: "1", input: state.recoveryInput ?? {
            idempotencyKey: "recovered-wait", mode: "any", taskIds: targetIds, timeoutMs: 5_000,
          } },
        }]
        return { rows, rowCount: rows.length }
      }
      if (sql.startsWith('SELECT "id", "userId", "status" FROM "agent_sessions"')) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && !sql.includes("ANY($1::text[])")) return { rows: [{
        id: "parent-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", status: "running",
        attemptCount: state.attemptCount ?? 3, leaseOwner: state.leaseOwner ?? "worker-1", leaseExpiresAt: state.leaseExpiresAt ?? lease().leaseExpiresAt, interruptRequestedAt: null,
        userId: "user-1", turnStatus: "in_progress", rootStatus: "running",
      }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "parent-1", attempt: 3, ordinal: 4, latestOrdinal: 4, status: "streaming" }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])")) return { rows: targets.map(target => ({ ...target, parentTaskId: state.targetParentId ?? target.parentTaskId })), rowCount: targets.length }
      if (sql.includes('FROM "agent_wait_conditions"') && !sql.includes("INSERT")) return { rows: state.existing ? [state.existing] : [], rowCount: state.existing ? 1 : 0 }
      if (sql.includes('INSERT INTO "agent_wait_conditions"')) {
        state.insertCount += 1
        const values = params
        const inserted = {
          id: values[0], userId: values[1], sessionId: values[2], turnId: values[3], parentTaskId: values[4], stepId: values[5],
          idempotencyKey: values[6], targetTaskIds: JSON.parse(String(values[7])), mode: values[8], status: values[9],
          deadlineAt: values[10], matchedTaskIds: JSON.parse(String(values[11])), result: JSON.parse(String(values[12])), createdAt: values[13],
        }
        state.inserted = inserted; state.existing = inserted
        return { rows: [inserted], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {},
  }
  return { pool: { connect: async () => client }, client, calls, state }
}

describe("registerDurableSubagentWait", () => {
  it("redacts UUID-shaped values in arbitrary waitId fields and other strings", () => {
    const waitId = "00000000-0000-4000-8000-000000000000"
    expect(safeSubagentWaitJson({ outcome: { waitId, note: waitId, nested: { waitId: "+353 87 123 4567" } } })).toEqual({
      outcome: { waitId: "[REDACTED_PHONE]", note: "[REDACTED_PHONE]", nested: { waitId: "[REDACTED_PHONE]" } },
    })
  })

  it("preserves only the row-bound canonical waitId and redacts nested child-result UUIDs", () => {
    const waitId = "00000000-0000-4000-8000-000000000000"
    const row = { id: waitId, targetTaskIds: ["child-1"], deadlineAt: now }
    const outcome = projectDurableSubagentWait(row, [{ id: "child-1", status: "completed", role: "writer",
      result: { nested: { waitId } }, failureReason: null }], "ready", ["child-1"])
    const request = { targetTaskIds: ["child-1"], mode: "any", timeoutMs: 5_000 }
    const persisted = safeSubagentWaitJson({ request, outcome }, 16_384) as {
      outcome: { waitId: string; tasks: Array<{ result: unknown }> }
    }

    expect(outcome.waitId).toBe(row.id)
    expect(persisted.outcome.waitId).toBe(row.id)
    expect(persisted.outcome.tasks[0]?.result).toEqual({ nested: { waitId: "[REDACTED_PHONE]" } })

    const mismatched = projectDurableSubagentWait(row, [], "ready", ["child-1"])
    Object.assign(mismatched, { waitId: "11111111-1111-4111-8111-111111111111" })
    const rejected = safeSubagentWaitJson({ request, outcome: mismatched }, 16_384) as { outcome: { waitId: string } }
    expect(rejected.outcome.waitId).toBe("[REDACTED_PHONE]")
  })

  it("preserves target IDs from an exact persisted wait projection without trusting result text", () => {
    const targetId = "subagent-00000000-0000-4000-8000-000000000000"
    const waitId = "00000000-0000-4000-8000-000000000000"
    const projected = waitResult({ id: waitId, targetTaskIds: [targetId], matchedTaskIds: [targetId], status: "ready", deadlineAt: now,
      result: { outcome: { waitId, status: "ready", taskIds: [targetId], matchedTaskIds: [targetId], deadlineAt: now.toISOString(),
        tasks: [{ taskId: targetId, status: "completed", role: "writer", result: { finalText: targetId }, failureReason: null }] } } })
    const safe = safeSubagentWaitJson(projected, 16_384) as typeof projected
    expect(safe.taskIds).toEqual([targetId])
    expect(safe.matchedTaskIds).toEqual([targetId])
    expect(safe.tasks[0]?.taskId).toBe(targetId)
    expect(safe.tasks[0]?.result).toEqual({ finalText: "subagent-[REDACTED_PHONE]" })
  })

  it("reconstructs only the exact persisted, admitted pre-insert wait and preserves its original deadline", async () => {
    const fake = fixture(), startedAt = new Date(now.getTime() - 10_000), expiredLease = new Date(now.getTime() - 1_000)
    const oldLease = { ...lease(), leaseExpiresAt: expiredLease }
    fake.state.recovery = true; fake.state.leaseExpiresAt = expiredLease; fake.state.startedAt = startedAt
    await expect(recoverExpiredWaitRegistration(fake.client as never, oldLease, now)).resolves.toEqual({ registered: true })
    expect(fake.state.insertCount).toBe(1)
    expect(fake.state.inserted?.deadlineAt).toEqual(new Date(startedAt.getTime() + 5_000))
    const query = fake.calls.find(call => call.sql.includes('started."createdAt"'))
    expect(query?.sql).toContain('started."type" = \'tool_call.started\'')
    expect(query?.sql).toContain('started."correlationId" = call."content"->>\'toolCallId\'')
    expect(query?.sql).toContain('started."idempotencyKey" AS "eventIdempotencyKey"')
    expect(query?.sql).toContain('task."leaseExpiresAt" = $8 AND task."leaseExpiresAt" <= $9')
    expect(query?.sql).toContain('step."ordinal" = (SELECT MAX(current."ordinal")')
    expect(query?.params).toEqual([oldLease.id, oldLease.userId, oldLease.sessionId, oldLease.turnId, oldLease.rootTaskId, oldLease.ownerId, oldLease.attemptCount, expiredLease, now])
  })

  it("fails closed for an unadmitted role, absent event timestamp, or non-direct target", async () => {
    for (const change of [
      { recoveryRole: "scout" }, { startedAt: null }, { targetParentId: "other-parent" },
    ]) {
      const fake = fixture(), expiredLease = new Date(now.getTime() - 1_000)
      Object.assign(fake.state, { recovery: true, leaseExpiresAt: expiredLease, ...change })
      await expect(recoverExpiredWaitRegistration(fake.client as never, { ...lease(), leaseExpiresAt: expiredLease }, now))
        .resolves.toEqual({ rejectedCallId: "start-event-1" })
      expect(fake.state.insertCount).toBe(0)
    }
  })

  it("leaves a canonical continuation claim for strict blocker checks without registering or rejecting it", async () => {
    const fake = fixture(), expiredLease = new Date(now.getTime() - 1_000)
    fake.state.recovery = true; fake.state.leaseExpiresAt = expiredLease
    fake.state.recoveryEventKey = `task:${lease().id}:event:child-wait-claim:${lease().attemptCount}:step-1`
    await expect(recoverExpiredWaitRegistration(fake.client as never, { ...lease(), leaseExpiresAt: expiredLease }, now)).resolves.toBeUndefined()
    expect(fake.state.insertCount).toBe(0)
    expect(fake.calls).toHaveLength(1)
  })

  it("fails closed for noncanonical or forged child-wait claim markers", async () => {
    const expiredLease = new Date(now.getTime() - 1_000)
    for (const eventKey of [
      "task:other-parent:event:child-wait-claim:3:step-1",
      "task:parent-1:event:child-wait-claim:2:step-1",
      "task:parent-1:event:child-wait-claim:3:wrong-step",
      "malformed:event:child-wait-claim:3:step-1",
    ]) {
      const fake = fixture()
      fake.state.recovery = true; fake.state.leaseExpiresAt = expiredLease; fake.state.recoveryEventKey = eventKey
      await expect(recoverExpiredWaitRegistration(fake.client as never, { ...lease(), leaseExpiresAt: expiredLease }, now)).resolves.toBeUndefined()
      expect(fake.state.insertCount).toBe(0)
      expect(fake.calls).toHaveLength(1)
    }
  })

  it("fails closed on ambiguous started-wait candidates without registering or rejecting either", async () => {
    const fake = fixture(), expiredLease = new Date(now.getTime() - 1_000)
    fake.state.recovery = true; fake.state.leaseExpiresAt = expiredLease
    fake.state.recoveryRows = [
      { eventId: "start-event-1", eventIdempotencyKey: "task:parent-1:event:tool-started:wait-call-1" },
      { eventId: "start-event-2", eventIdempotencyKey: "task:parent-1:event:tool-started:wait-call-2" },
    ]
    await expect(recoverExpiredWaitRegistration(fake.client as never, { ...lease(), leaseExpiresAt: expiredLease }, now)).resolves.toBeUndefined()
    expect(fake.state.insertCount).toBe(0)
    expect(fake.calls).toHaveLength(1)
  })

  it("validates bounded unique direct targets before opening a transaction", async () => {
    const fake = fixture()
    const input = { lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: ["child-1", "child-1"], mode: "any" as const, timeoutMs: 5_000, now }
    await expect(registerDurableSubagentWait(fake.pool as never, input)).rejects.toMatchObject({ code: "wait_invalid" })
    expect(fake.calls).toHaveLength(0)
  })

  it("registers when a heartbeat extended the database lease beyond its stale snapshot", async () => {
    const fake = fixture()
    const heartbeatNow = new Date(now.getTime() + 70_000)
    fake.state.leaseExpiresAt = new Date(heartbeatNow.getTime() + 60_000)
    const result = await registerDurableSubagentWait(fake.pool as never, {
      lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any", timeoutMs: 5_000, now: heartbeatNow,
    })
    expect(fake.state.insertCount).toBe(1)
    expect(result.status).toBe("waiting")
  })

  it("rejects an expired database lease even when the snapshot expiry is still future", async () => {
    const fake = fixture()
    fake.state.leaseExpiresAt = new Date(now.getTime() - 1)
    await expect(registerDurableSubagentWait(fake.pool as never, {
      lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any", timeoutMs: 5_000, now,
    })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state.insertCount).toBe(0)
  })

  it("rejects a database lease with a different owner", async () => {
    const fake = fixture()
    fake.state.leaseOwner = "worker-2"
    await expect(registerDurableSubagentWait(fake.pool as never, {
      lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any", timeoutMs: 5_000, now,
    })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state.insertCount).toBe(0)
  })

  it("rejects a database lease with a different attempt", async () => {
    const fake = fixture()
    fake.state.attemptCount = 4
    await expect(registerDurableSubagentWait(fake.pool as never, {
      lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any", timeoutMs: 5_000, now,
    })).rejects.toMatchObject({ code: "wait_scope_error" })
    expect(fake.state.insertCount).toBe(0)
  })

  it("persists a scoped sanitized result and replays the same idempotency key", async () => {
    const fake = fixture()
    const input = { lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any" as const, timeoutMs: 5_000, now }
    const first = await registerDurableSubagentWait(fake.pool as never, input)
    const replay = await registerDurableSubagentWait(fake.pool as never, input)
    expect(fake.state.insertCount).toBe(1)
    expect(first).toEqual(replay)
    expect(first).toMatchObject({ status: "waiting", taskIds: targetIds, matchedTaskIds: [] })
    expect(JSON.stringify(first.tasks[0].result)).not.toContain("super-secret")
    expect(JSON.stringify(first.tasks[0].result)).not.toContain("hidden-token")
    expect(Buffer.byteLength(JSON.stringify(first.tasks[0].result), "utf8")).toBeLessThanOrEqual(512)
    const insert = fake.calls.find(call => call.sql.includes('INSERT INTO "agent_wait_conditions"'))
    expect(insert?.sql).toContain('ON CONFLICT ("parentTaskId", "idempotencyKey") DO NOTHING')
    expect(insert?.params[6]).toBe("wait-key")
  })

  it("rejects a replay with a changed payload", async () => {
    const fake = fixture()
    const input = { lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any" as const, timeoutMs: 5_000, now }
    await registerDurableSubagentWait(fake.pool as never, input)
    await expect(registerDurableSubagentWait(fake.pool as never, { ...input, mode: "all" })).rejects.toMatchObject({ code: "wait_conflict" })
    expect(fake.state.insertCount).toBe(1)
  })

  it("rejects a second idempotency key for the same step", async () => {
    const fake = fixture()
    const input = { lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any" as const, timeoutMs: 5_000, now }
    await registerDurableSubagentWait(fake.pool as never, input)
    await expect(registerDurableSubagentWait(fake.pool as never, { ...input, idempotencyKey: "another-key" }))
      .rejects.toMatchObject({ code: "wait_conflict" })
    expect(fake.state.insertCount).toBe(1)
  })

  it("rejects a second idempotency key for the same step", async () => {
    const fake = fixture()
    const input = { lease: lease(), stepId: "step-1", idempotencyKey: "wait-key", targetTaskIds: targetIds, mode: "any" as const, timeoutMs: 5_000, now }
    await registerDurableSubagentWait(fake.pool as never, input)
    await expect(registerDurableSubagentWait(fake.pool as never, { ...input, idempotencyKey: "another-key" }))
      .rejects.toMatchObject({ code: "wait_conflict" })
    expect(fake.state.insertCount).toBe(1)
  })
})
