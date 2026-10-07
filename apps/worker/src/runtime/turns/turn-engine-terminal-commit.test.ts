import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

import { commitTurnTerminal } from "./turn-engine-terminal-commit.js"
import { SessionPauseRequestedError } from "../session-gate.js"

const { assertNoUnresolvedSteeringMock } = vi.hoisted(() => ({ assertNoUnresolvedSteeringMock: vi.fn() }))
vi.mock("../subagents/steering-reconciliation-ledger.js", async importOriginal => ({
  ...await importOriginal<typeof import("../subagents/steering-reconciliation-ledger.js")>(),
  assertNoUnresolvedSteering: assertNoUnresolvedSteeringMock,
}))

const now = new Date("2026-09-25T10:00:00.000Z")
const owner = {
  kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 7,
  leaseExpiresAt: new Date("2026-09-25T10:01:00.000Z"),
}
const input = {
  owner, response: "Final answer", now, stepId: "step-2", finalItemId: "final-1",
  finalContent: { parts: [{ type: "text", text: "Final answer" }] }, stepCount: 2, toolCallCount: 1,
  usage: { inputTokens: 12, outputTokens: 4, estimatedCostUsd: 0.001 },
}
type Row = Record<string, unknown>
type Call = { sql: string; values?: readonly unknown[] }

function makePool(pending: readonly Row[] = [], currentTurnInput?: unknown, options: { pause?: boolean; planningRoot?: boolean } = {}) {
  const calls: Call[] = []
  const events = new Map<string, Row>()
  const outboxes = new Map<string, Row>()
  const items = new Map<string, Row>()
  const successors = new Map<string, Row>()
  const followUps: Row[] = pending.map((row, index) => ({
    ...row, targetTurnId: row.targetTurnId === undefined ? row.turnId : row.targetTurnId, clientMessageId: row.clientMessageId ?? `client-${row.id}`,
    content: row.content ?? [{ type: "text", text: `text:${row.id}` }], acceptedSequence: row.acceptedSequence ?? index + 1,
    delivery: row.delivery ?? "follow_up", status: row.status ?? "accepted", consumedByStepId: row.consumedByStepId ?? null,
    consumedAt: row.consumedAt ?? null, cancelledAt: row.cancelledAt ?? null,
  }))
  let sequence = 10n
  let turn: Row = { id: owner.turnId, status: "in_progress", finalResponse: null, source: "user", ...(currentTurnInput === undefined ? {} : { input: currentTurnInput }) }
  let root: Row = { id: owner.taskId, status: "running", leaseOwner: owner.ownerId, attemptCount: 1, result: null, interruptRequestedAt: null,
    allowedActions: options.planningRoot ? ["agent.plan"] : [] }
  const client = {
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (/^BEGIN(?: ISOLATION LEVEL READ COMMITTED)?$/.test(sql) || ["COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "eventSequence" FROM "agent_sessions"')) return { rows: [{ eventSequence: sequence }], rowCount: 1 }
      if (sql.includes('SELECT session."id" FROM "agent_sessions" AS session')) return options.pause ? { rows: [], rowCount: 0 } : { rows: [{ id: owner.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: values?.[0] === owner.sessionId && values?.[1] === owner.userId ? [{ id: owner.sessionId }] : [], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn')) {
        if (values?.[0] !== owner.turnId || values[1] !== owner.sessionId || values[2] !== owner.userId || values[5] !== owner.taskId) return { rows: [], rowCount: 0 }
        if (turn.status === "completed") return { rows: [{ ...turn }], rowCount: 1 }
        if (values[3] !== owner.ownerId || values[4] !== owner.leaseVersion) return { rows: [], rowCount: 0 }
        return { rows: [{ ...turn }], rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"')) {
        if (values?.[0] !== owner.taskId || values[1] !== owner.sessionId || values[2] !== owner.turnId) return { rows: [], rowCount: 0 }
        return { rows: [{ ...root }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_inputs"')) {
        const found = followUps.filter(row => row.sessionId === values?.[0] && row.userId === values?.[1] && row.targetTurnId !== null
          && row.delivery === "follow_up" && ["accepted", "queued"].includes(String(row.status)) && !row.consumedByStepId && !row.consumedAt && !row.cancelledAt)
          .sort((left, right) => Number(left.acceptedSequence) - Number(right.acceptedSequence) || String(left.id).localeCompare(String(right.id)))
        return { rows: found.slice(0, 1), rowCount: Math.min(found.length, 1) }
      }
      if (sql.includes('INSERT INTO "agent_turns"')) {
        const [id, sessionId, userId, source, value, updatedAt] = values ?? []
        successors.set(String(id), { id, sessionId, userId, source, status: "queued", input: JSON.parse(String(value)), updatedAt })
        return { rows: [{ id }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_inputs"')) {
        const [targetTurnId, id, sessionId, userId, oldTargetTurnId] = values ?? []
        const row = followUps.find(value => value.id === id && value.sessionId === sessionId && value.userId === userId && value.targetTurnId === oldTargetTurnId)
        if (!row) return { rows: [], rowCount: 0 }
        row.targetTurnId = targetTurnId
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_events"')) {
        const key = String(values?.length === 3 ? values[2] : values?.[1] ?? "")
        const event = events.get(key)
        if (event) return { rows: [{ ...event }], rowCount: 1 }
        if (key === `turn:${owner.turnId}:event:step-completed:${input.stepId}`) return { rows: [{ id: "step-completed-event" }], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }
      if (sql.includes('INSERT INTO "agent_items"')) {
        const id = String(values?.[0]);
        if (items.has(id)) return { rows: [], rowCount: 0 }
        const row = { id, sessionId: values?.[1], turnId: values?.[2], stepId: values?.[3], taskId: values?.[4], type: "agent_message", status: "completed", phase: "final_answer", revision: 1, content: JSON.parse(String(values?.[5])) }
        items.set(id, row)
        return { rows: [{ id, revision: 1 }], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_items" AS item')) {
        const row = items.get(String(values?.[0]))
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('UPDATE "agent_sessions"')) {
        sequence += 1n
        return { rows: [{ eventSequence: sequence }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_events"')) {
        const [id, sessionId, turnId, itemId, taskId, seq, type, correlationId, causationId, key, payload] = values ?? []
        const row = { id, sessionId, turnId, itemId, taskId, sequence: seq, type, actor: "orchestrator", correlationId, causationId, payload: JSON.parse(String(payload)) }
        events.set(String(key), row)
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"')) {
        const [id, aggregateId, key, payload] = values ?? []
        if (outboxes.has(String(key))) return { rows: [], rowCount: 0 }
        outboxes.set(String(key), { id, topic: sql.includes("'agent.turn.dispatch'") ? "agent.turn.dispatch" : "agent.events", aggregateId, idempotencyKey: key, payload: JSON.parse(String(payload)) })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('FROM "agent_outbox"')) {
        const row = outboxes.get(String(values?.[0]))
        return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 }
      }
      if (sql.includes('UPDATE "sub_agent_tasks"')) {
        root = { ...root, status: "completed", result: JSON.parse(String(values?.[0])), leaseOwner: null }
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_turns"')) {
        turn = { ...turn, status: "completed", finalResponse: values?.[0] }
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected query in terminal commit fixture: ${sql}`)
    }),
    release: vi.fn(),
  }
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">,
    calls, events, outboxes, items, successors, followUps, client,
    get state() { return { turn: { ...turn }, root: { ...root } } },
  }
}

describe("atomic Turn terminal commit", () => {
  it("blocks native planning Root completion while steering remains unresolved", async () => {
    const fake = makePool([], undefined, { planningRoot: true })
    assertNoUnresolvedSteeringMock.mockReset().mockRejectedValueOnce(new Error("steering_reconciliation_pending"))
    await expect(commitTurnTerminal(fake.pool, input)).rejects.toThrow("steering_reconciliation_pending")
    expect(assertNoUnresolvedSteeringMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.taskId, parentTaskId: owner.taskId,
      turnLeaseOwner: owner.ownerId, turnLeaseVersion: owner.leaseVersion, parentLeaseOwner: owner.ownerId, parentAttemptCount: 1,
    }))
    expect(fake.state.turn.status).toBe("in_progress")
    expect(fake.state.root.status).toBe("running")
    expect(fake.items.size).toBe(0)
    expect(fake.events.size).toBe(0)
    expect(fake.outboxes.size).toBe(0)
  })

  it("completes the Turn and promotes only the oldest pending session follow-up atomically", async () => {
    const fake = makePool([
      { id: "later", sessionId: owner.sessionId, userId: owner.userId, turnId: owner.turnId, acceptedSequence: 8 },
      { id: "first", sessionId: owner.sessionId, userId: owner.userId, turnId: "older-turn", acceptedSequence: 4, clientMessageId: "message-first", content: [{ type: "text", text: "First request" }] },
      { id: "cancelled", sessionId: owner.sessionId, userId: owner.userId, turnId: owner.turnId, acceptedSequence: 1, cancelledAt: now },
      { id: "unattached", sessionId: owner.sessionId, userId: owner.userId, turnId: owner.turnId, targetTurnId: null, acceptedSequence: 2 },
    ])
    const guard = vi.fn(async () => ({ ok: true as const }))

    const first = await commitTurnTerminal(fake.pool, input, guard)
    const replay = await commitTurnTerminal(fake.pool, input, guard)
    expect(first).toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    expect(replay).toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    expect(guard).toHaveBeenCalledTimes(1)

    const lockOrder = [
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")),
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "agent_turns" AS turn') && sql.includes("FOR UPDATE")),
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "sub_agent_tasks"') && sql.includes("FOR UPDATE")),
      fake.calls.findIndex(({ sql }) => sql.includes('FROM "agent_inputs"') && sql.includes("FOR UPDATE")),
    ]
    expect(lockOrder.every(index => index >= 0)).toBe(true)
    expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b))
    const selection = fake.calls.find(({ sql }) => sql.includes('FROM "agent_inputs"') && sql.includes("LIMIT 1 FOR UPDATE"))
    expect(selection?.sql).toContain('"sessionId" = $1 AND "userId" = $2 AND "targetTurnId" IS NOT NULL')
    expect(selection?.sql).toContain('ORDER BY "acceptedSequence" ASC, "id" ASC LIMIT 1 FOR UPDATE')
    expect(selection?.sql).toContain('"delivery" = \'follow_up\'')
    expect(selection?.sql).toContain('"status" IN (\'accepted\', \'queued\')')
    expect(selection?.sql).toContain('"consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL')
    expect(selection?.values).toEqual([owner.sessionId, owner.userId])
    const successor = [...fake.successors.values()][0]
    const successorId = String(successor?.id)
    const successorInsert = fake.calls.find(({ sql }) => sql.includes('INSERT INTO "agent_turns"'))
    expect(fake.successors.size).toBe(1)
    expect(successorInsert?.sql).toContain('"updatedAt"')
    expect(successorInsert?.values?.[5]).toBe(input.now)
    expect(successor?.updatedAt).toEqual(input.now)
    expect(successor?.updatedAt).toBeInstanceOf(Date)
    expect(successor).toMatchObject({ status: "queued", sessionId: owner.sessionId, userId: owner.userId, source: "user", input: { goal: "First request", clientMessageId: "message-first" } })
    expect(successor?.input).not.toHaveProperty("intent")
    expect(fake.followUps.find(row => row.id === "first")).toMatchObject({ targetTurnId: successorId, status: "accepted", consumedByStepId: null })
    expect(fake.followUps.find(row => row.id === "later")).toMatchObject({ targetTurnId: owner.turnId, status: "accepted", consumedByStepId: null })
    expect(fake.outboxes.get(`turn-dispatch:${successorId}`)).toMatchObject({ topic: "agent.turn.dispatch", aggregateId: owner.sessionId, payload: { turnId: successorId, sessionId: owner.sessionId, ownerId: `web:${successorId}` } })
    expect([...fake.outboxes.values()].filter(row => row.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fake.items.size).toBe(1)
    expect(fake.events.size).toBe(3)
    expect(fake.state.turn.status).toBe("completed")
    expect(fake.state.root.status).toBe("completed")
    expect(fake.calls.filter(({ sql }) => sql.includes('INSERT INTO "agent_turns"'))).toHaveLength(1)
    expect(fake.calls.filter(({ sql }) => sql.includes('UPDATE "agent_inputs"'))).toHaveLength(1)
    expect(fake.calls.some(({ sql }) => /(?:UPDATE|DELETE) "(?:agent_items|agent_events)"/.test(sql))).toBe(false)
  })

  it("retains the exact server discovery intent on an atomically promoted follow-up Turn", async () => {
    const fake = makePool([{
      id: "discovery-follow-up", sessionId: owner.sessionId, userId: owner.userId, turnId: owner.turnId,
      content: [{ type: "text", text: "Continue discovery" }],
    }], { goal: "Discover jobs", intent: { kind: "interactive_discovery_shortlist", version: 1 } })

    await commitTurnTerminal(fake.pool, input)

    expect([...fake.successors.values()][0]?.input).toMatchObject({
      goal: "Continue discovery", clientMessageId: "client-discovery-follow-up",
      intent: { kind: "interactive_discovery_shortlist", version: 1 },
    })
  })

  it("commits the final item, event outboxes, root Task and Turn as one idempotent receipt", async () => {
    const fake = makePool()

    const first = await commitTurnTerminal(fake.pool, input)
    const second = await commitTurnTerminal(fake.pool, input)

    expect(first).toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    expect(second).toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    expect(fake.items.size).toBe(1)
    expect(fake.events.size).toBe(3) // the three terminal events; the prerequisite step receipt is fixture-owned
    expect(fake.outboxes.size).toBe(3)
    expect(fake.state.turn).toMatchObject({ status: "completed", finalResponse: input.response })
    expect(fake.state.root).toMatchObject({ status: "completed", leaseOwner: null, result: { finalItemId: input.finalItemId, stepCount: 2, toolCallCount: 1 } })
    expect(fake.calls.filter(({ sql }) => sql.includes('INSERT INTO "agent_events"'))).toHaveLength(3)
    expect(fake.calls.filter(({ sql }) => sql.includes('UPDATE "agent_turns"'))).toHaveLength(1)
    expect(fake.calls.filter(({ sql }) => sql.includes('UPDATE "sub_agent_tasks"'))).toHaveLength(1)
    expect(fake.calls.filter(({ sql }) => sql.startsWith("BEGIN"))).toEqual([{ sql: "BEGIN" }, { sql: "BEGIN" }])
    const rootUpdate = fake.calls.find(({ sql }) => sql.includes('UPDATE "sub_agent_tasks"'))?.sql ?? ""
    const turnUpdate = fake.calls.find(({ sql }) => sql.includes('UPDATE "agent_turns"'))?.sql ?? ""
    expect(rootUpdate).not.toMatch(/clock_timestamp|interruptRequestedAt/)
    expect(turnUpdate).toContain('AND "leaseExpiresAt" > $5')
    expect(turnUpdate).not.toContain("clock_timestamp")
  })

  it("does not promote malformed or unknown server intent fields", async () => {
    for (const intent of [
      { kind: "interactive_discovery_shortlist", version: 2 },
      { kind: "interactive_discovery_shortlist", version: 1, userControlled: true },
    ]) {
      const fake = makePool([{
        id: "follow-up", sessionId: owner.sessionId, userId: owner.userId, turnId: owner.turnId,
        content: [{ type: "text", text: "Continue" }],
      }], { goal: "Discover jobs", intent })

      await commitTurnTerminal(fake.pool, input)

      expect([...fake.successors.values()][0]?.input).not.toHaveProperty("intent")
    }
  })

  it("commits the validated discovery shortlist in the root receipt and accepts only identical replay", async () => {
    const fake = makePool()
    const shortlist: RepositoryJsonValue = {
      schemaVersion: 1,
      status: "completed",
      items: [{ jobId: "job-1", score: 8.5, evidenceIds: ["read:job:job-1"] }],
      failures: [],
    }
    const discoveryInput = { ...input, interactiveDiscoveryShortlist: shortlist }

    await expect(commitTurnTerminal(fake.pool, discoveryInput)).resolves.toMatchObject({ status: "completed", finalItemId: input.finalItemId })
    await expect(commitTurnTerminal(fake.pool, discoveryInput)).resolves.toMatchObject({ status: "completed", finalItemId: input.finalItemId })

    expect(fake.state.root.result).toEqual({
      status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: input.finalItemId, waitId: null,
      structuredResult: { interactiveDiscoveryShortlist: shortlist },
    })
    expect(fake.calls.filter(({ sql }) => sql.includes('UPDATE "sub_agent_tasks"'))).toHaveLength(1)
    const changedShortlist: RepositoryJsonValue = {
      schemaVersion: 1,
      status: "completed",
      items: [{ jobId: "job-1", score: 9, evidenceIds: ["read:job:job-1"] }],
      failures: [],
    }
    await expect(commitTurnTerminal(fake.pool, {
      ...discoveryInput,
      interactiveDiscoveryShortlist: changedShortlist,
    })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
  })

  it("validates before terminal writes and bypasses the guard on committed replay after source changes", async () => {
    const fake = makePool()
    let sourceCurrent = true
    const guard = vi.fn(async (client: pg.PoolClient) => {
      fake.calls.push({ sql: "GUARD" })
      expect(client).toBe(fake.client)
      return sourceCurrent ? { ok: true as const } : {
        ok: false as const,
        blocker: "selected_job_draft_review_required",
        feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
      }
    })

    await expect(commitTurnTerminal(fake.pool, input, guard)).resolves.toMatchObject({ status: "completed" })
    expect(guard).toHaveBeenCalledTimes(1)
    sourceCurrent = false

    await expect(commitTurnTerminal(fake.pool, input, guard)).resolves.toMatchObject({ status: "completed" })
    expect(guard).toHaveBeenCalledTimes(1)
    expect(fake.items.size).toBe(1)
    expect(fake.events.size).toBe(3)
    expect(fake.outboxes.size).toBe(3)
    const guardIndex = fake.calls.findIndex(({ sql }) => sql === "GUARD")
    const itemIndex = fake.calls.findIndex(({ sql }) => sql.includes('INSERT INTO "agent_items"'))
    expect(guardIndex).toBeLessThan(itemIndex)
  })

  it("rolls back a blocked finalization before creating any terminal record", async () => {
    const fake = makePool()
    const guard = vi.fn(async () => ({
      ok: false as const,
      blocker: "selected_job_draft_review_required",
      feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
    }))

    await expect(commitTurnTerminal(fake.pool, input, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })

    expect(guard).toHaveBeenCalledTimes(1)
    expect(fake.calls[0]?.sql).toBe("BEGIN ISOLATION LEVEL READ COMMITTED")
    expect(fake.calls.some(({ sql }) => /INSERT INTO "agent_(items|events|outbox)"|UPDATE "(sub_agent_tasks|agent_turns)"/.test(sql))).toBe(false)
    expect(fake.items.size).toBe(0)
    expect(fake.events.size).toBe(0)
    expect(fake.outboxes.size).toBe(0)
    expect(fake.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true)
  })

  it("does not terminalize a Turn after durable pause admission is denied", async () => {
    const fake = makePool([], undefined, { pause: true })

    await expect(commitTurnTerminal(fake.pool, input)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(fake.calls.some(({ sql }) => /INSERT INTO "agent_(items|events|outbox)"|UPDATE "(sub_agent_tasks|agent_turns)"/.test(sql))).toBe(false)
    expect(fake.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true)
    expect(fake.state.turn.status).toBe("in_progress")
    expect(fake.state.root.status).toBe("running")
  })

  it("surfaces a TaskGraph race denial as a same-Turn recovery receipt", async () => {
    const fake = makePool()
    const guard = vi.fn(async () => ({ ok: false as const, blocker: "task_graph_verification_unverified", feedback: "TaskGraph criteria remain unresolved." }))
    await expect(commitTurnTerminal(fake.pool, input, guard)).rejects.toMatchObject({
      name: "TaskGraphVerificationRecovery", blocker: "task_graph_verification_unverified", feedback: "TaskGraph criteria remain unresolved.",
    })
    expect(fake.calls.some(({ sql }) => /INSERT INTO "agent_(items|events|outbox)"|UPDATE "(sub_agent_tasks|agent_turns)"/.test(sql))).toBe(false)
    expect(fake.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true)
  })

  it("does not let another user's session follow-up gate or cross the owner fence", async () => {
    const otherSession = makePool([{ id: "foreign-input", sessionId: "session-other", userId: "user-other", turnId: "turn-other" }])
    await expect(commitTurnTerminal(otherSession.pool, input)).resolves.toMatchObject({ status: "completed", finalItemId: input.finalItemId })

    const wrongOwner = makePool()
    await expect(commitTurnTerminal(wrongOwner.pool, { ...input, owner: { ...owner, userId: "user-other" } })).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
    expect(wrongOwner.calls.some(({ sql }) => /INSERT INTO "agent_(items|events|outbox)"|UPDATE "(sub_agent_tasks|agent_turns)"/.test(sql))).toBe(false)
  })
})
