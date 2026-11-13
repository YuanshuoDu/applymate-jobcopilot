import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, type InputContentPart } from "@jobcopilot/agent-protocol"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { setAgentSearchFootprintMemoryConsent } from "@/lib/agent-search-footprint-memory-consent"
import { reconcileIdempotentAgentSession } from "@/lib/agent/session/agent-session-create-idempotency"
import { createAgentSession } from "@/lib/agent/session/repository"
import { AgentCommandError } from "./errors"
import { ObjectiveStartCommandService } from "./objective-start"
import {
  abandonObjectiveStartAttempt,
  getObjectiveStartAttempt,
  listObjectiveStartAttempts,
} from "./objective-start-attempt-ledger"
import { acceptInputFacts, createRootTurn } from "./transaction"
import type { ObjectiveStartCommand } from "./types"

const expectedUrl = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_custom_agent_role_ci"

function guardedDatabaseUrl(): string | null {
  const url = process.env.CUSTOM_AGENT_ROLE_PG_TEST_URL
  const requested = url !== undefined
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE !== undefined
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED !== undefined
  if (!requested) return null
  if (process.env.CI !== "true"
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_DISPOSABLE !== "true"
    || process.env.CUSTOM_AGENT_ROLE_PG_TEST_REQUIRED !== "true"
    || url !== expectedUrl
    || process.env.DATABASE_URL !== expectedUrl) {
    throw new Error("Task start recovery PostgreSQL tests require the fixed disposable CustomAgentRole CI database")
  }
  return url
}

const databaseUrl = guardedDatabaseUrl()
const describeWithDatabase = databaseUrl ? describe : describe.skip
let firstClient: PrismaClient
let secondClient: PrismaClient
const testUserIds = new Set<string>()

function idOf(value: unknown): string {
  if (typeof value !== "object" || value === null || !("id" in value) || typeof value.id !== "string") {
    throw new Error("Session creation returned no ID")
  }
  return value.id
}

async function createUser(client: PrismaClient): Promise<string> {
  const userId = `task-start-recovery-${randomUUID()}`
  testUserIds.add(userId)
  await client.user.create({ data: { id: userId, email: `${userId}@example.invalid` } })
  return userId
}

async function createSession(client: PrismaClient, userId: string, createKey = `create-${randomUUID()}`): Promise<string> {
  return idOf(await createAgentSession(client, {
    userId, goal: "Private objective", source: "chat", idempotencyKey: createKey,
  }))
}

function startCommand(userId: string, sessionId: string, clientMessageId: string, objective = "Find Dublin roles"): ObjectiveStartCommand {
  const content: InputContentPart[] = [{ type: "text", text: "Reference context" }]
  return { userId, sessionId, clientMessageId, source: "user", objective, content }
}

async function outcomeCounts(client: PrismaClient, userId: string, sessionId: string) {
  const [attempts, sessions, turns, inputs, events, outbox] = await Promise.all([
    client.agentObjectiveStartAttempt.count({ where: { userId } }),
    client.agentSession.count({ where: { id: sessionId, userId } }),
    client.agentTurn.count({ where: { sessionId, userId } }),
    client.agentInput.count({ where: { sessionId, userId } }),
    client.agentEvent.count({ where: { sessionId } }),
    client.agentOutbox.count({ where: { aggregateId: sessionId } }),
  ])
  return { attempts, sessions, turns, inputs, events, outbox }
}

describeWithDatabase("objective start attempt recovery on disposable PostgreSQL", () => {
  beforeAll(async () => {
    const url = new URL(databaseUrl!)
    url.searchParams.set("connection_limit", "5")
    firstClient = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    secondClient = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    await Promise.all([firstClient.$connect(), secondClient.$connect()])
  })

  afterAll(async () => {
    if (testUserIds.size > 0 && firstClient) {
      const ids = [...testUserIds]
      await firstClient.agentObjectiveStartAttempt.deleteMany({ where: { userId: { in: ids } } })
      await firstClient.agentSession.deleteMany({ where: { userId: { in: ids } } })
      await firstClient.user.deleteMany({ where: { id: { in: ids } } })
    }
    await Promise.all([firstClient?.$disconnect(), secondClient?.$disconnect()])
  })

  it("accepts concurrent same-key requests exactly once and replays the receipt", async () => {
    const userId = await createUser(firstClient)
    const sessionId = await createSession(firstClient, userId)
    const command = startCommand(userId, sessionId, "same-key")
    const [first, second] = await Promise.all([
      new ObjectiveStartCommandService(firstClient).start(command),
      new ObjectiveStartCommandService(secondClient).start(command),
    ])

    expect([first.disposition, second.disposition].sort()).toEqual(["duplicate", "started"])
    expect(first.turnId).toBe(second.turnId)
    await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toEqual({
      attempts: 1, sessions: 1, turns: 1, inputs: 1, events: 2, outbox: 3,
    })
    await expect(firstClient.agentObjectiveStartAttempt.findUnique({
      where: { userId_clientMessageId: { userId, clientMessageId: "same-key" } },
      select: { status: true, inputId: true, turnId: true, acceptedSequence: true },
    })).resolves.toMatchObject({ status: "accepted", inputId: first.inputId, turnId: first.turnId })
  })

  it("rejects accepted rows without a request hash while keeping null-payload tombstones valid", async () => {
    const userId = await createUser(firstClient)
    const invalidKey = `invalid-null-hash-${randomUUID()}`
    await expect(firstClient.agentObjectiveStartAttempt.create({ data: {
      userId,
      clientMessageId: invalidKey,
      status: "accepted",
      sessionId: "not-a-session",
      requestHash: null,
      inputId: "not-an-input",
      turnId: "not-a-turn",
      acceptedSequence: BigInt(1),
    } })).rejects.toThrow()
    await expect(firstClient.agentObjectiveStartAttempt.count({ where: { userId, clientMessageId: invalidKey } })).resolves.toBe(0)

    const tombstoneKey = `null-payload-tombstone-${randomUUID()}`
    await expect(abandonObjectiveStartAttempt(secondClient, userId, tombstoneKey)).resolves.toEqual({ state: "abandoned" })
    await expect(firstClient.agentObjectiveStartAttempt.findUnique({
      where: { userId_clientMessageId: { userId, clientMessageId: tombstoneKey } },
      select: { status: true, requestHash: true, sessionId: true },
    })).resolves.toEqual({ status: "abandoned", requestHash: null, sessionId: null })
  })

  it("keeps the accepted fence after target deletion and reports the old receipt unavailable", async () => {
    const userId = await createUser(firstClient)
    const sessionId = await createSession(firstClient, userId)
    const command = startCommand(userId, sessionId, "deleted-target")
    const started = await new ObjectiveStartCommandService(firstClient).start(command)
    expect(started.disposition).toBe("started")

    await firstClient.agentSession.deleteMany({ where: { id: sessionId, userId } })

    await expect(getObjectiveStartAttempt(secondClient, userId, command.clientMessageId)).resolves.toEqual({ state: "unavailable" })
    await expect(abandonObjectiveStartAttempt(secondClient, userId, command.clientMessageId)).resolves.toEqual({ state: "unavailable" })
    await expect(firstClient.agentObjectiveStartAttempt.findUnique({
      where: { userId_clientMessageId: { userId, clientMessageId: command.clientMessageId } },
      select: { status: true, sessionId: true, turnId: true },
    })).resolves.toEqual({ status: "accepted", sessionId, turnId: started.turnId })

    const replay = await new ObjectiveStartCommandService(secondClient).start(command)
    expect(replay).toMatchObject({ disposition: "duplicate", turnId: started.turnId })
    await expect(firstClient.agentTurn.count({ where: { userId } })).resolves.toBe(0)
  })

  it("serializes concurrent same-key different-payload starts to one winner and one conflict", async () => {
    const userId = await createUser(firstClient)
    const sessionId = await createSession(firstClient, userId)
    const outcomes = await Promise.allSettled([
      new ObjectiveStartCommandService(firstClient).start(startCommand(userId, sessionId, "different-payload", "Find Dublin roles")),
      new ObjectiveStartCommandService(secondClient).start(startCommand(userId, sessionId, "different-payload", "Find Berlin roles")),
    ])

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1)
    const winner = outcomes.find((outcome) => outcome.status === "fulfilled")
    if (!winner || winner.status !== "fulfilled") throw new Error("No objective start won its idempotency key")
    const conflict = outcomes.find((outcome) => outcome.status === "rejected")
    expect(conflict).toMatchObject({ status: "rejected", reason: expect.objectContaining({
      code: "objective_start_idempotency_conflict", status: 409,
    }) })
    await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toMatchObject({ attempts: 1, turns: 1, inputs: 1 })

    const secondSessionId = await createSession(secondClient, userId)
    await expect(new ObjectiveStartCommandService(secondClient).start(startCommand(
      userId, secondSessionId, "different-payload", winner.value.disposition === "started" ? "Find Dublin roles" : "Find Berlin roles",
    ))).rejects.toMatchObject({ code: "objective_start_idempotency_conflict", status: 409 })
    await expect(firstClient.agentTurn.count({ where: { sessionId: secondSessionId, userId } })).resolves.toBe(0)
  })

  it("makes accept-versus-abandon a single-winner transaction race", async () => {
    const userId = await createUser(firstClient)
    const sessionId = await createSession(firstClient, userId)
    const command = startCommand(userId, sessionId, "accept-abandon-race")
    const outcomes = await Promise.allSettled([
      new ObjectiveStartCommandService(firstClient).start(command),
      abandonObjectiveStartAttempt(secondClient, userId, command.clientMessageId),
    ])
    const start = outcomes[0]
    const abandon = outcomes[1]
    expect(abandon.status).toBe("fulfilled")
    if (abandon.status !== "fulfilled") throw new Error("Abandon transaction failed")

    if (abandon.value.state === "accepted") {
      expect(start.status).toBe("fulfilled")
      if (start.status !== "fulfilled") throw new Error("Accepted attempt has no start receipt")
      expect(abandon.value.receipt).toMatchObject({ inputId: start.value.inputId, turnId: start.value.turnId })
      await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toMatchObject({
        attempts: 1, turns: 1, inputs: 1, events: 2, outbox: 3,
      })
    } else {
      expect(abandon.value).toEqual({ state: "abandoned" })
      expect(start).toMatchObject({ status: "rejected", reason: expect.objectContaining({
        code: "objective_start_idempotency_conflict", status: 409,
      }) })
      await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toEqual({
        attempts: 1, sessions: 1, turns: 0, inputs: 0, events: 0, outbox: 0,
      })
    }
  })

  it("keeps acceptance when the start transaction acquires the key before abandonment", async () => {
    const userId = await createUser(firstClient)
    const sessionId = await createSession(firstClient, userId)
    const command = startCommand(userId, sessionId, "accept-first")
    const started = await new ObjectiveStartCommandService(firstClient).start(command)

    expect(started.disposition).toBe("started")
    await expect(abandonObjectiveStartAttempt(secondClient, userId, command.clientMessageId)).resolves.toEqual({
      state: "accepted",
      receipt: { sessionId, inputId: started.inputId, turnId: started.turnId, sequence: started.sequence },
    })
    await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toMatchObject({ attempts: 1, turns: 1, inputs: 1 })
  })

  it("keeps the abandonment tombstone when abandonment acquires the key before start", async () => {
    const userId = await createUser(firstClient)
    const sessionId = await createSession(firstClient, userId)
    const command = startCommand(userId, sessionId, "abandon-first")

    await expect(abandonObjectiveStartAttempt(firstClient, userId, command.clientMessageId)).resolves.toEqual({ state: "abandoned" })
    await expect(new ObjectiveStartCommandService(secondClient).start(command)).rejects.toMatchObject({
      code: "objective_start_idempotency_conflict", status: 409,
    })
    await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toEqual({
      attempts: 1, sessions: 1, turns: 0, inputs: 0, events: 0, outbox: 0,
    })
  })

  it("reads legacy accepted receipts without mutation, then adopts them only in a start mutation", async () => {
    const userId = await createUser(firstClient)
    const sessionId = idOf(await createAgentSession(firstClient, { userId, goal: "Private objective", source: "chat" }))
    const command = startCommand(userId, sessionId, "legacy-receipt")
    const facts = await firstClient.$transaction(async (tx) => {
      const turn = await createRootTurn(tx, command, command.content, command.objective, undefined, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)
      return acceptInputFacts(tx, command, command.content, turn, "follow_up", "started", true)
    })

    await expect(getObjectiveStartAttempt(secondClient, userId, command.clientMessageId)).resolves.toEqual({
      state: "accepted", receipt: { sessionId, ...facts },
    })
    await expect(firstClient.agentObjectiveStartAttempt.count({ where: { userId } })).resolves.toBe(0)
    const replay = await new ObjectiveStartCommandService(secondClient).start(command)
    expect(replay).toMatchObject({ ...facts, disposition: "duplicate" })
    await expect(firstClient.agentObjectiveStartAttempt.count({ where: { userId } })).resolves.toBe(1)
    await expect(new ObjectiveStartCommandService(secondClient).start({ ...command, objective: "Changed after acceptance" }))
      .rejects.toBeInstanceOf(AgentCommandError)
    await expect(outcomeCounts(firstClient, userId, sessionId)).resolves.toEqual({
      attempts: 1, sessions: 1, turns: 1, inputs: 1, events: 2, outbox: 3,
    })
  })

  it("reconciles consumed completed and cancelled stopped legacy inputs without creating another Turn", async () => {
    const userId = await createUser(firstClient)
    const consumedSessionId = idOf(await createAgentSession(firstClient, { userId, goal: "Private objective", source: "chat" }))
    const consumedCommand = startCommand(userId, consumedSessionId, "legacy-consumed")
    const consumedFacts = await firstClient.$transaction(async (tx) => {
      const turn = await createRootTurn(tx, consumedCommand, consumedCommand.content, consumedCommand.objective, undefined, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)
      return acceptInputFacts(tx, consumedCommand, consumedCommand.content, turn, "follow_up", "started", true)
    })
    const step = await firstClient.agentStep.create({ data: {
      id: `legacy-step-${randomUUID()}`, sessionId: consumedSessionId, turnId: consumedFacts.turnId,
      ordinal: 0, status: "completed", inputThroughSequence: BigInt(consumedFacts.sequence),
      consumedInputIds: [consumedFacts.inputId], modelProfileSnapshot: {},
    }, select: { id: true } })
    await firstClient.agentInput.update({ where: { id: consumedFacts.inputId }, data: {
      status: "consumed", consumedByStepId: step.id, consumedAt: new Date(),
    } })
    await firstClient.agentTurn.update({ where: { id: consumedFacts.turnId }, data: { status: "completed", completedAt: new Date() } })

    await expect(getObjectiveStartAttempt(secondClient, userId, consumedCommand.clientMessageId)).resolves.toEqual({
      state: "accepted", receipt: { sessionId: consumedSessionId, ...consumedFacts },
    })
    await expect(firstClient.agentObjectiveStartAttempt.count({ where: { userId } })).resolves.toBe(0)
    const completedReplay = await new ObjectiveStartCommandService(secondClient).start(consumedCommand)
    expect(completedReplay).toMatchObject({ ...consumedFacts, disposition: "duplicate" })
    await expect(outcomeCounts(firstClient, userId, consumedSessionId)).resolves.toEqual({
      attempts: 1, sessions: 1, turns: 1, inputs: 1, events: 2, outbox: 3,
    })

    const cancelledSessionId = idOf(await createAgentSession(firstClient, { userId, goal: "Private objective", source: "chat" }))
    const cancelledCommand = startCommand(userId, cancelledSessionId, "legacy-cancelled")
    const cancelledFacts = await firstClient.$transaction(async (tx) => {
      const turn = await createRootTurn(tx, cancelledCommand, cancelledCommand.content, cancelledCommand.objective, undefined, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT)
      return acceptInputFacts(tx, cancelledCommand, cancelledCommand.content, turn, "follow_up", "started", true)
    })
    await firstClient.agentInput.update({ where: { id: cancelledFacts.inputId }, data: { status: "cancelled", cancelledAt: new Date() } })
    await firstClient.agentTurn.update({ where: { id: cancelledFacts.turnId }, data: { status: "interrupted", completedAt: new Date() } })

    await expect(getObjectiveStartAttempt(secondClient, userId, cancelledCommand.clientMessageId)).resolves.toEqual({
      state: "accepted", receipt: { sessionId: cancelledSessionId, ...cancelledFacts },
    })
    const stoppedReplay = await new ObjectiveStartCommandService(secondClient).start(cancelledCommand)
    expect(stoppedReplay).toMatchObject({ ...cancelledFacts, disposition: "duplicate" })
    // This count is user-wide; the consumed legacy case above already adopted one attempt.
    await expect(outcomeCounts(firstClient, userId, cancelledSessionId)).resolves.toEqual({
      attempts: 2, sessions: 1, turns: 1, inputs: 1, events: 2, outbox: 3,
    })
  })

  it("scopes the same key to authenticated owners and keeps unknown reads side-effect free", async () => {
    const firstUserId = await createUser(firstClient)
    const secondUserId = await createUser(firstClient)
    const firstSessionId = await createSession(firstClient, firstUserId, "same-create-key")
    await createSession(secondClient, secondUserId, "same-create-key")
    const command = startCommand(firstUserId, firstSessionId, "tenant-key")
    await new ObjectiveStartCommandService(firstClient).start(command)

    await expect(getObjectiveStartAttempt(secondClient, secondUserId, command.clientMessageId)).resolves.toEqual({ state: "unknown" })
    const firstList = await listObjectiveStartAttempts(firstClient, firstUserId, 20)
    const secondList = await listObjectiveStartAttempts(secondClient, secondUserId, 20)
    expect(firstList.accountScope).not.toBe(secondList.accountScope)
    expect(firstList.attempts).toHaveLength(1)
    expect(secondList.attempts).toHaveLength(0)
    expect(JSON.stringify(secondList)).not.toContain(firstUserId)
  })

  it("reconciles a keyed Session under the consent lock without returning private goal or changing its snapshot", async () => {
    const userId = await createUser(firstClient)
    const createKey = "consent-reconcile"
    const sessionId = await createSession(firstClient, userId, createKey)
    const selector = { userId_creationIdempotencyKey: { userId, creationIdempotencyKey: createKey } }
    const before = await firstClient.agentSession.findUnique({
      where: selector,
      select: { id: true, goal: true, updatedAt: true, searchFootprintMemoryEnabledAtCreation: true, searchFootprintMemoryConsentVersionAtCreation: true },
    })
    const [consent, reconciliation] = await Promise.all([
      setAgentSearchFootprintMemoryConsent(userId, { enabled: true, expectedVersion: 0 }, secondClient),
      reconcileIdempotentAgentSession(firstClient, userId, createKey),
    ])
    const after = await firstClient.agentSession.findUnique({ where: selector, select: {
      id: true, goal: true, updatedAt: true, searchFootprintMemoryEnabledAtCreation: true, searchFootprintMemoryConsentVersionAtCreation: true,
    } })

    expect(consent.kind).toBe("updated")
    expect(reconciliation).toEqual({ state: "found", sessionId })
    expect(after).toEqual(before)
    expect(JSON.stringify(reconciliation)).not.toContain("Private objective")
  })
})
