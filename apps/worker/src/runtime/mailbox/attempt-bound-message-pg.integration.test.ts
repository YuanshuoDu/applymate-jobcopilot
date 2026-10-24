import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"
import type pg from "pg"

import { hydrateChildMailbox } from "./hydration.js"
import { drainSubagentMailboxOutbox } from "./outbox-consumer.js"
import { PgCoordinationStore } from "./store.js"
import { PgSubagentTaskStore } from "../subagents/pg-store.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}` || url.search !== "" || url.hash !== "") {
    throw new Error("Attempt-bound mailbox integration requires the dedicated disposable CI PostgreSQL service")
  }
  return value
}

const databaseUrl = disposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const suffix = randomUUID().replaceAll("-", "")
const fixture = {
  userId: `mailbox-attempt-user-${suffix}`,
  sessionId: `mailbox-attempt-session-${suffix}`,
  turnId: `mailbox-attempt-turn-${suffix}`,
  rootTaskId: `mailbox-attempt-root-${suffix}`,
  ancestorTaskId: `mailbox-attempt-ancestor-${suffix}`,
  taskId: `mailbox-attempt-child-${suffix}`,
  stepId: `mailbox-attempt-step-${suffix}`,
  nextStepId: `mailbox-attempt-next-step-${suffix}`,
  oldMessageId: `mailbox-attempt-old-${suffix}`,
  currentMessageId: `mailbox-attempt-current-${suffix}`,
  legacyMessageId: `mailbox-attempt-legacy-${suffix}`,
  staleOutboxId: `mailbox-attempt-stale-outbox-${suffix}`,
  terminalRootMessageId: `mailbox-attempt-terminal-root-${suffix}`,
  terminalRootOutboxId: `mailbox-attempt-terminal-root-outbox-${suffix}`,
  terminalTurnMessageId: `mailbox-attempt-terminal-turn-${suffix}`,
  terminalTurnOutboxId: `mailbox-attempt-terminal-turn-outbox-${suffix}`,
  pendingInterruptMessageId: `mailbox-attempt-pending-interrupt-${suffix}`,
  pendingInterruptOutboxId: `mailbox-attempt-pending-interrupt-outbox-${suffix}`,
  oldKey: `mailbox-attempt-old-key-${suffix}`,
  currentKey: `mailbox-attempt-current-key-${suffix}`,
  legacyKey: `mailbox-attempt-legacy-key-${suffix}`,
}

describeWithPostgres("attempt-bound mailbox messages in PostgreSQL", () => {
  let pool: PgPool

  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 4 })
    try {
      await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [fixture.userId, `${fixture.userId}@example.invalid`])
      await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt") VALUES ($1, $2, 'Attempt fence', 'running', 'test', CURRENT_TIMESTAMP)`, [fixture.sessionId, fixture.userId])
      await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [fixture.turnId, fixture.sessionId, fixture.userId])
      await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
        VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Attempt fence', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP)`, [fixture.rootTaskId, fixture.sessionId, fixture.turnId])
      await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [fixture.rootTaskId])
      await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [fixture.rootTaskId, fixture.turnId])
      await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
        VALUES ($1, $2, $3, $4, $4, '/root/ancestor', 1, 'analyst', 'inspect', 'running', 'Ancestor interrupt target', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP)`, [fixture.ancestorTaskId, fixture.sessionId, fixture.turnId, fixture.rootTaskId])
      await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, '/root/ancestor/child', 2, 'analyst', 'inspect', 'running', 'Inspect attempt-bound messages', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, 'worker-current', CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [fixture.taskId, fixture.sessionId, fixture.turnId, fixture.rootTaskId, fixture.ancestorTaskId])
      await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 1, 2, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [fixture.stepId, fixture.sessionId, fixture.turnId, fixture.taskId])
      await insertMessage(pool, fixture.oldMessageId, fixture.oldKey, "human_follow_up", 1)
      await insertMessage(pool, fixture.currentMessageId, fixture.currentKey, "human_follow_up", 2)
      await insertMessage(pool, fixture.legacyMessageId, fixture.legacyKey, "result", null)
      await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, '{}'::jsonb)`, [`mailbox-attempt-dispatch-${suffix}`, fixture.sessionId, `subagent-dispatch:${fixture.taskId}`])
      await pool.query(`UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = 4, "lastError" = 'prior_failure'
        WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`])
    } catch (error: unknown) {
      await cleanup(pool)
      throw error
    }
  })

  afterAll(async () => {
    if (pool) { await cleanup(pool); await pool.end() }
  })

  it("blocks K after the task advances to K+1, while matching and NULL legacy messages remain readable", async () => {
    const store = new PgCoordinationStore(pool)
    const pending = await store.listPendingMessages({ userId: fixture.userId, sessionId: fixture.sessionId, toTaskId: fixture.taskId })
    expect(pending.map(message => message.id)).toEqual([fixture.currentMessageId, fixture.legacyMessageId])

    const hydrated = await hydrateChildMailbox(pool, {
      userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId,
      toTaskId: fixture.taskId, ownerId: "worker-current", attemptCount: 2, stepId: fixture.stepId, limit: 20,
    })
    expect(hydrated.map(message => message.id)).toEqual([fixture.currentMessageId, fixture.legacyMessageId])
  })

  it("stales a waiting follow-up and excludes it from the next attempt hydration", async () => {
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'waiting', "leaseOwner" = NULL, "leaseExpiresAt" = NULL WHERE "id" = $1`, [fixture.taskId])
    await insertMailboxOutbox(pool, fixture.staleOutboxId, fixture.currentMessageId, fixture.currentKey, 2)

    await expect(drainSubagentMailboxOutbox(pool)).resolves.toBe(1)
    await expect(pool.query(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [fixture.taskId]))
      .resolves.toMatchObject({ rows: [{ status: "waiting" }] })
    await expect(pool.query(`SELECT "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`agent.subagent.mailbox:${fixture.currentKey}`]))
      .resolves.toMatchObject({ rows: [{ publishedAt: expect.any(Date), attemptCount: 1, lastError: "mailbox_attempt_stale" }] })
    await expect(pool.query(`SELECT "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`]))
      .resolves.toMatchObject({ rows: [{ publishedAt: expect.any(Date), attemptCount: 4, lastError: "prior_failure" }] })
    await expect(pool.query(`SELECT "deliveredAt" FROM "agent_mailbox_messages" WHERE "id" = $1`, [fixture.currentMessageId]))
      .resolves.toMatchObject({ rows: [{ deliveredAt: null }] })

    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "attemptCount" = 3, "leaseOwner" = 'worker-next', "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [fixture.taskId])
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 2, 3, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [fixture.nextStepId, fixture.sessionId, fixture.turnId, fixture.taskId])
    const nextAttemptMailbox = await hydrateChildMailbox(pool, {
      userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId,
      toTaskId: fixture.taskId, ownerId: "worker-next", attemptCount: 3, stepId: fixture.nextStepId, limit: 20,
    })
    expect(nextAttemptMailbox.map(message => message.id)).toEqual([fixture.legacyMessageId])
    expect(nextAttemptMailbox.map(message => message.id)).not.toContain(fixture.currentMessageId)
  })

  it.each([
    ["root", "completed", "in_progress", fixture.terminalRootMessageId, fixture.terminalRootOutboxId],
    ["Turn", "running", "interrupted", fixture.terminalTurnMessageId, fixture.terminalTurnOutboxId],
  ] as const)("does not deliver or hydrate an attempt-bound follow-up when its %s is terminal", async (_label, rootStatus, turnStatus, messageId, outboxId) => {
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = $2 WHERE "id" = $1`, [fixture.rootTaskId, rootStatus])
    await pool.query(`UPDATE "agent_turns" SET "status" = $2 WHERE "id" = $1`, [fixture.turnId, turnStatus])
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "attemptCount" = 2, "leaseOwner" = 'worker-current', "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [fixture.taskId])
    const key = `${messageId}-key`
    await insertMessage(pool, messageId, key, "human_follow_up", 2)
    await insertMailboxOutbox(pool, outboxId, messageId, key, 2)

    await expect(drainSubagentMailboxOutbox(pool)).resolves.toBe(1)
    await expect(pool.query(`SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1`, [fixture.taskId]))
      .resolves.toMatchObject({ rows: [{ status: "running", attemptCount: 2, leaseOwner: "worker-current" }] })
    await expect(pool.query(`SELECT "publishedAt", "lastError" FROM "agent_outbox" WHERE "id" = $1`, [outboxId]))
      .resolves.toMatchObject({ rows: [{ publishedAt: expect.any(Date), lastError: "mailbox_attempt_stale" }] })
    await expect(pool.query(`SELECT "deliveredAt", "consumedAt" FROM "agent_mailbox_messages" WHERE "id" = $1`, [messageId]))
      .resolves.toMatchObject({ rows: [{ deliveredAt: null, consumedAt: null }] })
    await expect(hydrateChildMailbox(pool, {
      userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, rootTaskId: fixture.rootTaskId,
      toTaskId: fixture.taskId, ownerId: "worker-current", attemptCount: 2, stepId: fixture.stepId, limit: 20,
    })).rejects.toMatchObject({ code: "coordination_scope_error" })
  })

  it("stales an attempt-bound follow-up while an accepted interrupt for an ancestor is pending", async () => {
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1`, [fixture.rootTaskId])
    await pool.query(`UPDATE "agent_turns" SET "status" = 'in_progress' WHERE "id" = $1`, [fixture.turnId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1`, [fixture.ancestorTaskId])
    await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "attemptCount" = 2, "leaseOwner" = 'worker-current', "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [fixture.taskId])
    const key = `${fixture.pendingInterruptMessageId}-key`
    await insertMessage(pool, fixture.pendingInterruptMessageId, key, "human_follow_up", 2)
    await insertMailboxOutbox(pool, fixture.pendingInterruptOutboxId, fixture.pendingInterruptMessageId, key, 2)
    await insertAcceptedInterrupt(pool, fixture.ancestorTaskId)

    await expect(drainSubagentMailboxOutbox(pool)).resolves.toBe(1)
    await expect(pool.query(`SELECT "publishedAt", "lastError" FROM "agent_outbox" WHERE "id" = $1`, [fixture.pendingInterruptOutboxId]))
      .resolves.toMatchObject({ rows: [{ publishedAt: expect.any(Date), lastError: "mailbox_attempt_stale" }] })
    await expect(pool.query(`SELECT "deliveredAt", "consumedAt" FROM "agent_mailbox_messages" WHERE "id" = $1`, [fixture.pendingInterruptMessageId]))
      .resolves.toMatchObject({ rows: [{ deliveredAt: null, consumedAt: null }] })
    await expect(pool.query(`SELECT "publishedAt", "attemptCount", "lastError" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [`subagent-dispatch:${fixture.taskId}`]))
      .resolves.toMatchObject({ rows: [{ publishedAt: expect.any(Date), attemptCount: 4, lastError: "prior_failure" }] })
  })

  it("returns actionable pending input when a send commits before finish, then completes only after same-attempt observation", async () => {
    await restoreFixtureOwners(pool)
    const task = await insertRunningRaceTask(pool, "send-first")
    const seededCurrentId = `mailbox-attempt-send-first-current-${randomUUID()}`
    const seededLegacyId = `mailbox-attempt-send-first-legacy-${randomUUID()}`
    const oldAttemptId = `mailbox-attempt-send-first-old-${randomUUID()}`
    await insertMessage(pool, seededCurrentId, `${seededCurrentId}-key`, "human_follow_up", 2, task.taskId)
    await insertMessage(pool, seededLegacyId, `${seededLegacyId}-key`, "result", null, task.taskId)
    await insertMessage(pool, oldAttemptId, `${oldAttemptId}-key`, "human_follow_up", 1, task.taskId)

    const senderGate = createSessionLockBarrier()
    const finishGate = createSessionLockBarrier()
    const coordination = new PgCoordinationStore(poolWithSessionLockBarrier(pool, senderGate))
    const taskStore = new PgSubagentTaskStore(poolWithSessionLockBarrier(pool, finishGate))
    const sendInput = raceSendInput(task, `send-first-${randomUUID()}`)
    let sendPromise: ReturnType<PgCoordinationStore["sendMessage"]> | undefined
    let finishPromise: ReturnType<PgSubagentTaskStore["finish"]> | undefined
    try {
      sendPromise = coordination.sendMessage(sendInput)
      await withDeadline(senderGate.acquired, "sender session-lock acquisition")
      finishPromise = taskStore.finish(raceFinishInput(task, [seededCurrentId, seededLegacyId]))
      await withDeadline(finishGate.attempted, "finish session-lock attempt")

      senderGate.release()
      const sent = await withDeadline(sendPromise, "sender commit")
      expect(sent.duplicate).toBe(false)
      const sentMessageId = sent.message.id
      await withDeadline(finishGate.acquired, "finish session-lock acquisition")
      const beforePending = await taskAndSideEffectSnapshot(pool, task.taskId)
      finishGate.release()

      await expect(withDeadline(finishPromise, "pending finish result"))
        .resolves.toEqual({ status: "input_pending", messageIds: [sentMessageId] })
      const afterPending = await taskAndSideEffectSnapshot(pool, task.taskId)
      expect(afterPending.effects).toEqual(beforePending.effects)
      expect(afterPending.task).toMatchObject({ status: "running", attemptCount: 2, leaseOwner: task.ownerId, result: null, failureReason: null, completedAt: null })
      await expect(pool.query(`SELECT "id", "consumedAt" FROM "agent_mailbox_messages" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
        [[seededCurrentId, seededLegacyId, sentMessageId, oldAttemptId]])).resolves.toMatchObject({
        rows: [seededCurrentId, seededLegacyId, sentMessageId, oldAttemptId].sort().map(id => ({ id, consumedAt: null })),
      })

      const final = await taskStore.finish(raceFinishInput(task, [seededCurrentId, seededLegacyId, sentMessageId]))
      expect(final).toBe("completed")
      const consumed = await pool.query<{ id: string }>(`SELECT "id" FROM "agent_mailbox_messages" WHERE "id" = ANY($1::text[]) AND "consumedAt" IS NOT NULL ORDER BY "id"`,
        [[seededCurrentId, seededLegacyId, sentMessageId, oldAttemptId]])
      expect(consumed.rows.map(row => row.id)).toEqual([seededCurrentId, seededLegacyId, sentMessageId].sort())
      await expect(pool.query(`SELECT "status", "attemptCount", "leaseOwner", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [task.taskId]))
        .resolves.toMatchObject({ rows: [{ status: "completed", attemptCount: 2, leaseOwner: null, result: { finished: true } }] })
    } finally {
      senderGate.release()
      finishGate.release()
      await settleRacePromise(sendPromise)
      await settleRacePromise(finishPromise)
    }
  })

  it("linearizes finish before a competing send, rejects that new message, and still accepts an exact terminal replay", async () => {
    await restoreFixtureOwners(pool)
    const task = await insertRunningRaceTask(pool, "finish-first")
    const coordination = new PgCoordinationStore(pool)
    const originalInput = raceSendInput(task, `finish-first-replay-${randomUUID()}`)
    const original = await coordination.sendMessage(originalInput)
    expect(original.duplicate).toBe(false)

    const finishGate = createSessionLockBarrier()
    const senderGate = createSessionLockBarrier()
    const taskStore = new PgSubagentTaskStore(poolWithSessionLockBarrier(pool, finishGate))
    const competingSender = new PgCoordinationStore(poolWithSessionLockBarrier(pool, senderGate))
    const freshInput = raceSendInput(task, `finish-first-fresh-${randomUUID()}`)
    let finishPromise: ReturnType<PgSubagentTaskStore["finish"]> | undefined
    let freshSendPromise: ReturnType<PgCoordinationStore["sendMessage"]> | undefined
    try {
      finishPromise = taskStore.finish(raceFinishInput(task, [original.message.id]))
      await withDeadline(finishGate.acquired, "finish session-lock acquisition")
      const beforeFinish = await taskAndSideEffectSnapshot(pool, task.taskId)
      freshSendPromise = competingSender.sendMessage(freshInput)
      await withDeadline(senderGate.attempted, "competing sender session-lock attempt")

      finishGate.release()
      await expect(withDeadline(finishPromise, "terminal finish result")).resolves.toBe("completed")
      await withDeadline(senderGate.acquired, "competing sender session-lock acquisition")
      senderGate.release()
      await expect(withDeadline(freshSendPromise, "rejected fresh send"))
        .rejects.toMatchObject({ code: "coordination_task_not_found" })

      const afterReject = await taskAndSideEffectSnapshot(pool, task.taskId)
      expect(afterReject.task).toMatchObject({ status: "completed", attemptCount: 2, leaseOwner: null, result: { finished: true } })
      expect(afterReject.effects.outbox).toBe(beforeFinish.effects.outbox)
      expect(afterReject.effects.events).toBe(beforeFinish.effects.events)
      expect(afterReject.effects.eventSequence).toBe(beforeFinish.effects.eventSequence)
      expect(afterReject.effects.mailbox).toBe(beforeFinish.effects.mailbox)
      const replay = await coordination.sendMessage(originalInput)
      expect(replay).toMatchObject({ duplicate: true, message: { id: original.message.id } })
      const afterReplay = await taskAndSideEffectSnapshot(pool, task.taskId)
      expect(afterReplay.effects).toEqual(afterReject.effects)
      await expect(pool.query(`SELECT "consumedAt" FROM "agent_mailbox_messages" WHERE "id" = $1`, [original.message.id]))
        .resolves.toMatchObject({ rows: [{ consumedAt: expect.any(Date) }] })
      await expect(pool.query(`SELECT COUNT(*)::int AS count FROM "agent_mailbox_messages" WHERE "toTaskId" = $1 AND "idempotencyKey" = $2`,
        [task.taskId, freshInput.idempotencyKey])).resolves.toMatchObject({ rows: [{ count: 0 }] })
    } finally {
      finishGate.release()
      senderGate.release()
      await settleRacePromise(finishPromise)
      await settleRacePromise(freshSendPromise)
    }
  })

  it.each(["owner", "attempt"] as const)("does not terminalize or acknowledge input with a stale %s fence", async fence => {
    await restoreFixtureOwners(pool)
    const task = await insertRunningRaceTask(pool, `stale-${fence}`)
    const messageId = `mailbox-attempt-stale-${fence}-${randomUUID()}`
    await insertMessage(pool, messageId, `${messageId}-key`, "result", null, task.taskId)
    const before = await taskAndSideEffectSnapshot(pool, task.taskId)
    const input = raceFinishInput(task, [messageId], {
      ownerId: fence === "owner" ? `${task.ownerId}-stale` : task.ownerId,
      attemptCount: fence === "attempt" ? 1 : 2,
    })

    await expect(new PgSubagentTaskStore(pool).finish(input)).resolves.toBeNull()
    const after = await taskAndSideEffectSnapshot(pool, task.taskId)
    expect(after.task).toEqual(before.task)
    expect(after.effects).toEqual(before.effects)
    await expect(pool.query(`SELECT "consumedAt" FROM "agent_mailbox_messages" WHERE "id" = $1`, [messageId]))
      .resolves.toMatchObject({ rows: [{ consumedAt: null }] })
  })
})

async function insertMessage(pool: PgPool, id: string, key: string, kind: string, targetAttemptCount: number | null, toTaskId = fixture.taskId): Promise<void> {
  await pool.query(`INSERT INTO "agent_mailbox_messages" ("id", "sessionId", "turnId", "toTaskId", "kind", "targetAttemptCount", "payload", "idempotencyKey")
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`, [id, fixture.sessionId, fixture.turnId, toTaskId, kind, targetAttemptCount, JSON.stringify(kind === "human_follow_up" ? { text: `follow-up attempt ${targetAttemptCount}` } : { legacy: true }), key])
}

type RaceTask = { taskId: string; ownerId: string }

async function restoreFixtureOwners(pool: PgPool): Promise<void> {
  await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1`, [fixture.rootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "status" = 'in_progress' WHERE "id" = $1`, [fixture.turnId])
  await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1`, [fixture.ancestorTaskId])
}

async function insertRunningRaceTask(pool: PgPool, label: string): Promise<RaceTask> {
  const id = `mailbox-attempt-${label}-${randomUUID()}`
  const ownerId = `worker-${label}-${randomUUID()}`
  const path = `/root/ancestor/${label}-${randomUUID()}`
  await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 2, 'analyst', 'inspect', 'running', $7, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, $8, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
  [id, fixture.sessionId, fixture.turnId, fixture.rootTaskId, fixture.ancestorTaskId, path, `Mailbox race ${label}`, ownerId])
  return { taskId: id, ownerId }
}

function raceSendInput(task: RaceTask, idempotencyKey: string) {
  return {
    userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.turnId, fromTaskId: fixture.rootTaskId,
    toTaskId: task.taskId, kind: "result", payload: { source: "controlled-mailbox-race" }, idempotencyKey,
  }
}

function raceFinishInput(task: RaceTask, mailboxMessageIds: readonly string[], overrides: { ownerId?: string; attemptCount?: number } = {}) {
  return {
    taskId: task.taskId, sessionId: fixture.sessionId, ownerId: overrides.ownerId ?? task.ownerId,
    attemptCount: overrides.attemptCount ?? 2, status: "completed" as const, result: { finished: true },
    mailboxMessageIds, now: new Date(),
  }
}

type SessionLockBarrier = {
  attempted: Promise<void>
  acquired: Promise<void>
  attemptedNow(): void
  asyncAcquiredAndHold(): Promise<void>
  release(): void
}

function createSessionLockBarrier(): SessionLockBarrier {
  let resolveAttempted!: () => void
  let resolveAcquired!: () => void
  let resolveReleased!: () => void
  const attempted = new Promise<void>(resolve => { resolveAttempted = resolve })
  const acquired = new Promise<void>(resolve => { resolveAcquired = resolve })
  const released = new Promise<void>(resolve => { resolveReleased = resolve })
  let didAttempt = false
  let didAcquire = false
  let didRelease = false
  return {
    attempted,
    acquired,
    attemptedNow() { if (!didAttempt) { didAttempt = true; resolveAttempted() } },
    asyncAcquiredAndHold() {
      if (!didAcquire) { didAcquire = true; resolveAcquired() }
      return released
    },
    release() { if (!didRelease) { didRelease = true; resolveReleased() } },
  }
}

function isSessionLockQuery(input: unknown): boolean {
  const query = typeof input === "string" ? input
    : typeof input === "object" && input !== null && "text" in input && typeof input.text === "string" ? input.text : ""
  return /FROM\s+"agent_sessions"[\s\S]*\bFOR\s+UPDATE\b/i.test(query)
}

function poolWithSessionLockBarrier(pool: PgPool, barrier: SessionLockBarrier): PgPool {
  return {
    connect: async () => {
      const client = await pool.connect()
      const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<{ rows?: unknown[] }>
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            const intercepted = async (queryInput: unknown, ...args: unknown[]): Promise<{ rows?: unknown[] }> => {
              const isLock = isSessionLockQuery(queryInput)
              if (isLock) barrier.attemptedNow()
              const result = await query(queryInput, ...args)
              if (isLock && result.rows?.length) await barrier.asyncAcquiredAndHold()
              return result
            }
            return intercepted as unknown as pg.PoolClient["query"]
          }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === "function" ? value.bind(target) : value
        },
      })
    },
  } as unknown as PgPool
}

async function withDeadline<T>(promise: Promise<T>, label: string, milliseconds = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds)
    })
    return await Promise.race([promise, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function settleRacePromise(promise: Promise<unknown> | undefined): Promise<void> {
  if (promise) await withDeadline(promise.then(() => undefined, () => undefined), "race cleanup", 8_000).catch(() => undefined)
}

async function taskAndSideEffectSnapshot(pool: PgPool, taskId: string): Promise<{
  task: { status: string; attemptCount: number; leaseOwner: string | null; result: unknown; failureReason: string | null; completedAt: Date | null }
  effects: { eventSequence: string; events: number; outbox: number; mailbox: number }
}> {
  const task = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; result: unknown; failureReason: string | null; completedAt: Date | null }>(
    `SELECT "status", "attemptCount", "leaseOwner", "result", "failureReason", "completedAt" FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])
  const effects = await pool.query<{ eventSequence: string; events: number; outbox: number; mailbox: number }>(`SELECT session."eventSequence"::text AS "eventSequence",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1) AS "events",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1) AS "outbox",
      (SELECT COUNT(*)::int FROM "agent_mailbox_messages" WHERE "sessionId" = $1 AND "toTaskId" = $2) AS "mailbox"
    FROM "agent_sessions" AS session WHERE session."id" = $1`, [fixture.sessionId, taskId])
  const taskRow = task.rows[0]
  const effectRow = effects.rows[0]
  if (!taskRow || !effectRow) throw new Error("Mailbox race snapshot could not read its task and side effects")
  return { task: taskRow, effects: effectRow }
}

async function insertMailboxOutbox(pool: PgPool, id: string, messageId: string, key: string, targetAttemptCount: number): Promise<void> {
  await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.subagent.mailbox', $2, $3, $4::jsonb)`, [id, fixture.sessionId, `agent.subagent.mailbox:${key}`, JSON.stringify({
    messageId, sessionId: fixture.sessionId, turnId: fixture.turnId, toTaskId: fixture.taskId, targetAttemptCount,
  })])
}

async function insertAcceptedInterrupt(pool: PgPool, taskId: string): Promise<void> {
  const client = await pool.connect()
  const intentId = randomUUID()
  try {
    await client.query("BEGIN")
    const sequence = await client.query<{ eventSequence: string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 RETURNING "eventSequence"`, [fixture.sessionId])
    await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, $4, $5, 'task.interrupt.accepted', 'user', $3, $6, $7::jsonb)`, [randomUUID(), fixture.sessionId, fixture.turnId, taskId,
      sequence.rows[0]?.eventSequence, `test-accepted-interrupt:${intentId}`, JSON.stringify({ intentId, taskId, status: "accepted" })])
    await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.subagent.task-interrupt', $2, $3, $4::jsonb)`, [randomUUID(), fixture.sessionId,
      `test-pending-interrupt:${intentId}`, JSON.stringify({ intentId, sessionId: fixture.sessionId, turnId: fixture.turnId, taskId })])
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function cleanup(pool: PgPool): Promise<void> {
  await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [fixture.sessionId]).catch(() => undefined)
  await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [fixture.userId]).catch(() => undefined)
}
