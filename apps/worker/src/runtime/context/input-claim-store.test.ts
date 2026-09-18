import { readFileSync } from "node:fs"

import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { createPgInputClaimStore, type InputClaimTransaction } from "./input-claim-store.js"
import { buildObservedSteeringMarker } from "./steering-marker-store.js"

const scope = { userId: "user-a" }
const createdAt = new Date("2026-09-01T16:00:00.000Z")

type FakeOptions = { sessionStatus?: string; sessionVisible?: boolean; sessionUserId?: string; turnVisible?: boolean; leaseValid?: boolean; failOn?: string; activeRow?: Record<string, unknown> | null }

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "input-1", sessionId: "session-a", targetTurnId: "turn-a", userId: "user-a", clientMessageId: "client-1",
    delivery: "steer", status: "consumed", content: [{ type: "text", text: "Dublin only" }], acceptedSequence: "4",
    consumedByStepId: "step-a", consumedAt: createdAt, createdAt, ...overrides,
  }
}

function makeClient(options: FakeOptions = {}) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = []
  const sessionStatus = options.sessionStatus ?? "running"
  const sessionVisible = options.sessionVisible ?? true
  const sessionUserId = options.sessionUserId ?? scope.userId
  const turnVisible = options.turnVisible ?? true
  const client = {
    query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
      const text = String(sql); calls.push({ text, values })
      if (options.failOn && text.includes(options.failOn)) throw new Error("fixture query failure")
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text) || text.includes("set_config")) return { rows: [] }
      if (text.includes('FROM "agent_sessions"') && text.includes('"status" NOT IN') && text.includes("FOR UPDATE")) {
        const matched = sessionVisible && values[0] === "session-a" && values[1] === sessionUserId && !["aborted", "archived"].includes(sessionStatus)
        return { rows: matched ? [{ id: "session-a" }] : [] }
      }
      if (text.includes('FROM "agent_turns"') && text.includes("FOR UPDATE")) {
        return { rows: turnVisible && (options.leaseValid ?? true) ? [{ id: "turn-a" }] : [] }
      }
      if (text.includes('FROM "sub_agent_tasks"')) return { rows: values[0] === "task-a" ? [{ id: "task-a" }] : [] }
      if (text.startsWith('SELECT "id", "turnId", "taskId", "type", "actor", "correlationId", "payload", "sequence" FROM "agent_events"')) return { rows: [] }
      if (text.includes('FROM "agent_inputs"') && text.includes("FOR SHARE")) return { rows: options.activeRow === null ? [] : [row(options.activeRow ?? {})] }
      if (text.startsWith("UPDATE \"agent_sessions\"")) return { rows: [{ eventSequence: "9" }] }
      if (text.startsWith('INSERT INTO "agent_events"')) return { rowCount: 1, rows: [] }
      if (text.startsWith('INSERT INTO "agent_outbox"')) return { rowCount: 1, rows: [] }
      if (text.includes('FROM "agent_steps"')) return { rows: [{ inputThroughSequence: "0", consumedInputIds: [] }] }
      if (text.includes("WITH candidates")) return { rows: [row({ id: "input-2", acceptedSequence: "5" })] }
      if (text.includes('FROM "agent_inputs"') && text.includes("FOR UPDATE")) return { rows: [] }
      if (text.includes('UPDATE "agent_steps"')) return { rowCount: 1, rows: [] }
      throw new Error(`unexpected SQL: ${text}`)
    }),
    release: vi.fn(),
  }
  return { client, calls, pool: { connect: vi.fn(async () => client) } as unknown as pg.Pool }
}

async function transaction(store: ReturnType<typeof createPgInputClaimStore>): Promise<void> {
  await store.withTransaction(async (tx: InputClaimTransaction) => {
    const checkpoint = await tx.getCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a" })
    const claimed = await tx.claimInputs({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", checkpoint, rebuild: false, now: createdAt })
    await tx.persistCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", checkpoint: { inputThroughSequence: 5n, consumedInputIds: claimed.inputs.map((item) => item.id) } })
  })
}

describe("PostgreSQL AgentInput claim store", () => {
  it("keeps claim, observed marker, and checkpoint in one ordered transaction", async () => {
    const fake = makeClient()
    const store = createPgInputClaimStore(fake.pool, scope)
    await store.withTransaction(async (tx) => {
      const checkpoint = await tx.getCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a" })
      const claimed = await tx.claimInputs({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", checkpoint, now: createdAt })
      const input = claimed.inputs.find((item) => item.id === "input-2")
      if (!input) throw new Error("fixture input missing")
      const payload = buildObservedSteeringMarker({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", context: { taskId: "task-a", obligationId: "obligation-1", goalRevision: 1, planRevision: 1 }, markerInput: input })
      await tx.appendObservedSteeringMarker?.({ sessionId: "session-a", turnId: "turn-a", taskId: "task-a", stepId: "step-a", payload })
      await tx.persistCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", checkpoint: { inputThroughSequence: 5n, consumedInputIds: claimed.inputs.map((item) => item.id) } })
    })
    const marker = fake.calls.findIndex((call) => call.text.startsWith('INSERT INTO "agent_events"'))
    const checkpoint = fake.calls.findIndex((call) => call.text.includes('UPDATE "agent_steps"'))
    expect(marker).toBeGreaterThan(-1)
    expect(marker).toBeLessThan(checkpoint)
    expect(fake.calls.map((call) => call.text)).toContain("COMMIT")
  })

  it("rolls back claimed input and marker when the marker outbox fails", async () => {
    const fake = makeClient({ failOn: 'INSERT INTO "agent_outbox"' })
    const store = createPgInputClaimStore(fake.pool, scope)
    await expect(store.withTransaction(async (tx) => {
      const checkpoint = await tx.getCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a" })
      const claimed = await tx.claimInputs({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", checkpoint, now: createdAt })
      const input = claimed.inputs.find((item) => item.id === "input-2")
      if (!input) throw new Error("fixture input missing")
      const payload = buildObservedSteeringMarker({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", context: { taskId: "task-a", obligationId: "obligation-1", goalRevision: 1, planRevision: 1 }, markerInput: input })
      await tx.appendObservedSteeringMarker?.({ sessionId: "session-a", turnId: "turn-a", taskId: "task-a", stepId: "step-a", payload })
    })).rejects.toThrow("fixture query failure")
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("rejects a marker for a foreign task before event writes", async () => {
    const fake = makeClient()
    const store = createPgInputClaimStore(fake.pool, scope)
    const payload = buildObservedSteeringMarker({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", context: { taskId: "task-b", obligationId: "obligation-1", goalRevision: 1, planRevision: 1 }, markerInput: { id: "input-2", acceptedSequence: 5n } })
    await expect(store.withTransaction((tx) => tx.appendObservedSteeringMarker!({ sessionId: "session-a", turnId: "turn-a", taskId: "task-b", stepId: "step-a", payload }))).rejects.toMatchObject({ code: "scope_conflict" })
    expect(fake.calls.some((call) => call.text.startsWith('INSERT INTO "agent_events"'))).toBe(false)
  })

  it("rejects an observed marker when the active lease fence is invalid", async () => {
    const fake = makeClient({ leaseValid: false })
    const store = createPgInputClaimStore(fake.pool, scope)
    const payload = buildObservedSteeringMarker({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a", context: { taskId: "task-a", obligationId: "obligation-1", goalRevision: 1, planRevision: 1 }, markerInput: { id: "input-2", acceptedSequence: 5n } })
    await expect(store.withTransaction((tx) => tx.appendObservedSteeringMarker!({ sessionId: "session-a", turnId: "turn-a", taskId: "task-a", stepId: "step-a", payload, lease: { ownerId: "wrong-owner", leaseVersion: 9, now: createdAt } }))).rejects.toMatchObject({ code: "owner_conflict" })
    expect(fake.calls.some((call) => call.text.startsWith('INSERT INTO "agent_events"'))).toBe(false)
  })

  it("rejects an observed marker for a foreign Turn before task validation", async () => {
    const fake = makeClient()
    const store = createPgInputClaimStore(fake.pool, scope)
    const payload = buildObservedSteeringMarker({ sessionId: "session-b", turnId: "turn-a", stepId: "step-a", context: { taskId: "task-a", obligationId: "obligation-1", goalRevision: 1, planRevision: 1 }, markerInput: { id: "input-2", acceptedSequence: 5n } })
    await expect(store.withTransaction((tx) => tx.appendObservedSteeringMarker!({ sessionId: "session-b", turnId: "turn-a", taskId: "task-a", stepId: "step-a", payload }))).rejects.toMatchObject({ code: "owner_conflict" })
    expect(fake.calls.some((call) => call.text.includes('FROM "sub_agent_tasks"'))).toBe(false)
  })

  it("uses tenant-fenced, FIFO row locks and one transaction for claim/checkpoint", async () => {
    const fake = makeClient()
    await transaction(createPgInputClaimStore(fake.pool, scope))
    const claimSql = fake.calls.find((call) => call.text.includes("WITH candidates"))?.text ?? ""
    const ownerSql = fake.calls.find((call) => call.text.includes('FROM "agent_turns"') && call.text.includes("FOR UPDATE"))?.text ?? ""
    expect(claimSql).toContain("ORDER BY \"acceptedSequence\" ASC, \"id\" ASC")
    expect(claimSql).toContain("FOR UPDATE")
    expect(claimSql).toContain('"status" IN (\'accepted\', \'queued\')')
    expect(claimSql).toContain('"consumedByStepId" IS NULL')
    expect(claimSql).toContain('"consumedAt" IS NULL')
    expect(claimSql).toContain('SET "status" = \'consumed\'')
    expect(ownerSql).toContain('turn."status" IN')
    expect(ownerSql).toContain('turn."leaseOwnerId"')
    expect(ownerSql).toContain('turn."leaseVersion"')
    const sessionLocks = fake.calls.filter((call) => call.text.includes('FROM "agent_sessions"') && call.text.includes('"status" NOT IN') && call.text.includes("FOR UPDATE"))
    const turnLocks = fake.calls.filter((call) => call.text.includes('FROM "agent_turns"') && call.text.includes("FOR UPDATE"))
    expect(sessionLocks).toHaveLength(3)
    expect(turnLocks).toHaveLength(3)
    for (let index = 0; index < sessionLocks.length; index += 1) {
      expect(fake.calls.indexOf(sessionLocks[index]!)).toBeLessThan(fake.calls.indexOf(turnLocks[index]!))
    }
    expect(fake.calls.map((call) => call.text)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT", "SELECT set_config($1, $2, true)"]))
    expect(fake.client.query).not.toHaveBeenCalledWith(expect.stringContaining("ROLLBACK"))
  })

  it("hydrates active steering inputs with a tenant, Turn, and steer delivery fence", async () => {
    const fake = makeClient({ activeRow: { id: "input-1" } })
    const store = createPgInputClaimStore(fake.pool, scope)
    const hydrated = await store.withTransaction(tx => tx.loadActiveSteeringInputs!({ sessionId: "session-a", turnId: "turn-a", inputIds: ["input-1"] }))
    expect(hydrated.map(item => item.id)).toEqual(["input-1"])
    const query = fake.calls.find(call => call.text.includes('FROM "agent_inputs"') && call.text.includes("FOR SHARE"))
    expect(query?.text).toContain('"sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3')
    expect(query?.text).toContain('"delivery" = \'steer\'')
    expect(query?.values).toEqual(["session-a", "turn-a", "user-a", ["input-1"]])
  })

  it("rejects a hydrated input whose returned delivery is not steer", async () => {
    const fake = makeClient({ activeRow: { delivery: "follow_up" } })
    const store = createPgInputClaimStore(fake.pool, scope)
    await expect(store.withTransaction(tx => tx.loadActiveSteeringInputs!({ sessionId: "session-a", turnId: "turn-a", inputIds: ["input-1"] }))).rejects.toMatchObject({ code: "owner_conflict" })
  })

  it.each([
    ["aborted", { sessionStatus: "aborted" }],
    ["archived", { sessionStatus: "archived" }],
    ["missing", { sessionVisible: false }],
    ["cross-user", { sessionUserId: "user-b" }],
  ] as const)("fails closed for a %s session before Turn/Input/Step work", async (_label, options) => {
    const fake = makeClient(options)
    const store = createPgInputClaimStore(fake.pool, scope)

    await expect(store.withTransaction((tx) => tx.getCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a" }))).rejects.toMatchObject({ code: "owner_conflict" })
    expect(fake.calls.some((call) => call.text.includes('FROM "agent_turns"'))).toBe(false)
    expect(fake.calls.some((call) => call.text.includes('FROM "agent_inputs"'))).toBe(false)
    expect(fake.calls.some((call) => call.text.includes('FROM "agent_steps"'))).toBe(false)
    expect(fake.calls.some((call) => call.text.startsWith("UPDATE"))).toBe(false)
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("fails closed for a missing Turn after taking the session lock", async () => {
    const fake = makeClient({ turnVisible: false })
    const store = createPgInputClaimStore(fake.pool, scope)

    await expect(store.withTransaction((tx) => tx.claimInputs({
      sessionId: "session-a", turnId: "turn-a", stepId: "step-a",
      checkpoint: { inputThroughSequence: 0n, consumedInputIds: [] }, now: createdAt,
    }))).rejects.toMatchObject({ code: "owner_conflict" })
    const sessionLock = fake.calls.findIndex((call) => call.text.includes('FROM "agent_sessions"') && call.text.includes('"status" NOT IN'))
    const turnLock = fake.calls.findIndex((call) => call.text.includes('FROM "agent_turns"') && call.text.includes("FOR UPDATE"))
    expect(sessionLock).toBeGreaterThan(-1)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(fake.calls.some((call) => call.text.includes('FROM "agent_inputs"'))).toBe(false)
    expect(fake.calls.some((call) => call.text.startsWith("UPDATE"))).toBe(false)
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("rolls back when the session fence query fails", async () => {
    const fake = makeClient({ failOn: 'FROM "agent_sessions"' })
    const store = createPgInputClaimStore(fake.pool, scope)

    await expect(store.withTransaction((tx) => tx.getCheckpoint({ sessionId: "session-a", turnId: "turn-a", stepId: "step-a" }))).rejects.toThrow("fixture query failure")
    expect(fake.calls.some((call) => call.text.includes('FROM "agent_turns"'))).toBe(false)
    expect(fake.calls.some((call) => call.text.startsWith("UPDATE"))).toBe(false)
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("rolls back when an owner or checkpoint operation fails", async () => {
    const fake = makeClient()
    fake.client.query.mockImplementationOnce(async () => ({ rows: [] }))
    await expect(createPgInputClaimStore(fake.pool, scope).withTransaction(async () => { throw new Error("fixture failure") })).rejects.toThrow("fixture failure")
    expect(fake.client.query).toHaveBeenCalledWith("ROLLBACK")
  })

  it("keeps SQL parameterized and source under the file-size limit", () => {
    const source = readFileSync(new URL("./input-claim-store.ts", import.meta.url), "utf8")
    expect(source.split(/\r?\n/).filter((line) => line.length > 0).length).toBeLessThanOrEqual(250)
    expect(source).not.toMatch(/query\s*\(\s*`[^`]*\$\{/s)
  })
})
