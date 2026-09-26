import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import { answerLegacyQuestion } from "./legacy-question-answer"

type Json = Record<string, unknown>

interface QuestionRow extends Json {
  id: string
  userId: string
  runId: string
  stage: string
  question: string
  options: unknown
  answer: string | null
  answeredAt?: Date | null
}

interface TurnRow extends Json {
  id: string
  sessionId: string
  userId: string
  status: string
  revision: number
  input?: unknown
}

interface ItemRow extends Json {
  id: string
  sessionId: string
  turnId: string
  type: string
  status: string
  revision: number
  content: unknown
  completedAt?: Date | null
}

interface FixtureState {
  session: { id: string; userId: string } | null
  question: QuestionRow | null
  turns: TurnRow[]
  item: ItemRow | null
  events: Json[]
  outbox: Json[]
  sequence: bigint
  failOutbox: boolean
  execution: { id: string; sessionId: string; userId: string; status: string; attemptCount: number; workerTaskId: string | null }
}

function value(row: Json, key: string): unknown {
  return row[key]
}

function serialized(valueToSerialize: unknown): string {
  return JSON.stringify(valueToSerialize, (_key, value) => typeof value === "bigint" ? value.toString() : value)
}

function matchesString(row: Json, key: string, expected: unknown): boolean {
  return typeof expected !== "undefined" && value(row, key) === expected
}

function baseState(): FixtureState {
  const options = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]
  return {
    session: { id: "session_1", userId: "user_1" },
    question: {
      id: "question_1", userId: "user_1", runId: "session_1", stage: "profile",
      question: "Work authorisation?", options, answer: null, answeredAt: null,
    },
    turns: [{ id: "turn_1", sessionId: "session_1", userId: "user_1", status: "waiting_for_user", revision: 5 }],
    item: {
      id: "agent-wait:question:question_1", sessionId: "session_1", turnId: "turn_1",
      type: "question", status: "started", revision: 0,
      content: {
        waitKind: "question", questionId: "question_1", stage: "profile", question: "Work authorisation?", options,
        sourceEvent: "orchestrator_question", sourcePayload: { id: "question_1" }, answerAvailable: false,
      },
    },
    events: [], outbox: [], sequence: BigInt(0), failOutbox: false,
    execution: { id: "execution_1", sessionId: "session_1", userId: "user_1", status: "waiting_for_user", attemptCount: 4, workerTaskId: null },
  }
}

function makeFixture() {
  const state = baseState()
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      const sql = strings.join(" ")
      if (sql.includes('FROM "agent_sessions"')) return state.session ? [{ ...state.session }] : []
      if (sql.includes('FROM "agent_turns"')) {
        const active = state.turns.filter(row => row.sessionId === "session_1" && row.userId === "user_1"
          && ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(row.status))
        if (sql.includes('SELECT "id", "input" FROM "agent_turns"')) {
          return active.map(row => ({ id: row.id, input: row.input ?? {} }))
        }
        if (sql.includes('SELECT "id" FROM "agent_turns"')) return active.map(row => ({ id: row.id }))
        const turnId = String((query as { values?: readonly unknown[] }).values?.[0] ?? "")
        const turn = state.turns.find(row => row.id === turnId && ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(row.status))
        return turn ? [{ ...turn }] : []
      }
      if (sql.includes('FROM "agent_executions"')) {
        return [{ id: state.execution.id, status: state.execution.status, attemptCount: state.execution.attemptCount, workerTaskId: state.execution.workerTaskId }]
      }
      state.sequence += BigInt(1)
      return [{ eventSequence: state.sequence }]
    }),
    agentRunQuestion: {
      findFirst: vi.fn(async ({ where }: { where: Json }) => {
        const question = state.question
        if (!question || !matchesString(question, "id", where.id) || !matchesString(question, "userId", where.userId)) return null
        if (typeof where.runId !== "undefined" && !matchesString(question, "runId", where.runId)) return null
        return structuredClone(question)
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Json; data: Json }) => {
        const question = state.question
        if (!question || !matchesString(question, "id", where.id) || !matchesString(question, "userId", where.userId) ||
          !matchesString(question, "runId", where.runId) || (where.answer === null && question.answer !== null)) return { count: 0 }
        question.answer = typeof data.answer === "string" ? data.answer : null
        question.answeredAt = data.answeredAt instanceof Date ? data.answeredAt : null
        return { count: 1 }
      }),
    },
    agentExecution: {
      updateMany: vi.fn(async ({ where, data }: { where: Json; data: Json }) => {
        if (where.id !== state.execution.id || where.userId !== state.execution.userId || where.sessionId !== state.execution.sessionId
          || where.status !== state.execution.status || where.attemptCount !== state.execution.attemptCount
          || ("workerTaskId" in where && where.workerTaskId !== state.execution.workerTaskId)) return { count: 0 }
        state.execution.status = String(data.status)
        if ("workerTaskId" in data) state.execution.workerTaskId = typeof data.workerTaskId === "string" ? data.workerTaskId : null
        return { count: 1 }
      }),
    },
    agentTurn: {
      findMany: vi.fn(async ({ where }: { where: Json }) => {
        const status = (where.status as Json | undefined)?.in
        const statuses = Array.isArray(status) ? status : []
        return state.turns.filter((turn) => turn.sessionId === where.sessionId && turn.userId === where.userId && statuses.includes(turn.status)).slice(0, 2).map((turn) => structuredClone(turn))
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Json; data: Json }) => {
        const turn = state.turns.find((candidate) => candidate.id === where.id)
        if (!turn || !matchesString(turn, "sessionId", where.sessionId) || !matchesString(turn, "userId", where.userId) ||
          !matchesString(turn, "status", where.status) || turn.revision !== where.revision) return { count: 0 }
        if (typeof data.revision === "object" && data.revision !== null && "increment" in data.revision) {
          const increment = (data.revision as { increment?: unknown }).increment
          if (typeof increment === "number") turn.revision += increment
        }
        return { count: 1 }
      }),
    },
    agentItem: {
      findFirst: vi.fn(async ({ where }: { where: Json }) => state.item && state.item.id === where.id ? structuredClone(state.item) : null),
      updateMany: vi.fn(async ({ where, data }: { where: Json; data: Json }) => {
        const item = state.item
        if (!item || !matchesString(item, "id", where.id) || !matchesString(item, "sessionId", where.sessionId) ||
          !matchesString(item, "turnId", where.turnId) || !matchesString(item, "type", where.type) || !matchesString(item, "status", where.status) || item.revision !== where.revision) return { count: 0 }
        item.status = typeof data.status === "string" ? data.status : item.status
        item.content = data.content
        item.completedAt = data.completedAt instanceof Date ? data.completedAt : null
        if (typeof data.revision === "object" && data.revision !== null && "increment" in data.revision) {
          const increment = (data.revision as { increment?: unknown }).increment
          if (typeof increment === "number") item.revision += increment
        }
        return { count: 1 }
      }),
    },
    agentEvent: {
      findFirst: vi.fn(async ({ where }: { where: Json }) => state.events.find((event) => event.idempotencyKey === where.idempotencyKey) ?? null),
      create: vi.fn(async ({ data }: { data: Json }) => {
        const event = { ...data, id: `event_${state.events.length + 1}` }
        state.events.push(event)
        return event
      }),
    },
    agentOutbox: {
      create: vi.fn(async ({ data }: { data: Json }) => {
        if (state.failOutbox) throw new Error("outbox write failed")
        state.outbox.push(data)
        return data
      }),
      findUnique: vi.fn(async ({ where }: { where: Json }) => state.outbox.find(row => row.idempotencyKey === where.idempotencyKey) ?? null),
    },
  }
  const db = {
    $transaction: vi.fn(async <T>(work: (transaction: typeof tx) => Promise<T>) => {
      const snapshot = structuredClone(state)
      try {
        return await work(tx)
      } catch (error: unknown) {
        Object.assign(state, snapshot)
        throw error
      }
    }),
  } as unknown as PrismaClient
  return { db, tx, state }
}

describe("answerLegacyQuestion", () => {
  it("answers a Turn-prefixed question without an AgentItem when transcript dual-write is off", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_1:legacy:q1"
    fixture.state.item = null

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({
      disposition: "legacy_dispatch_accepted", sessionId: "session_1", turnId: "turn_1",
      executionId: "execution_1", attemptCount: 4,
    })
    expect(fixture.state.question?.answer).toBe("yes")
    expect(fixture.state.execution.status).toBe("queued")
    expect(fixture.state.outbox).toHaveLength(1)
    expect(fixture.state.outbox[0]).toMatchObject({
      topic: "agent.execution.dispatch", aggregateId: "session_1",
      idempotencyKey: `legacy-execution-dispatch:execution_1:4:${fixture.state.question!.id}`,
      payload: { userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 4, questionId: fixture.state.question!.id },
    })
    expect(fixture.state.events).toHaveLength(0)
    const locks = fixture.tx.$queryRaw.mock.calls.map(([query]) => (query as { strings?: readonly string[] }).strings?.join(" ") ?? "")
    expect(locks[0]).toContain('FROM "agent_sessions"')
    expect(locks[1]).toContain('FROM "agent_turns"')
    expect(locks[2]).toContain('FROM "agent_executions"')
  })

  it("returns already-resuming for the same answered question while its exact Turn is in progress", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_1:legacy:q1"
    fixture.state.question!.answer = "yes"
    fixture.state.item = null
    fixture.state.turns[0]!.status = "in_progress"
    fixture.state.execution.status = "running"

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "legacy_already_resuming", turnId: "turn_1", executionId: "execution_1" })
    expect(fixture.state.question?.answer).toBe("yes")
    expect(fixture.state.execution.status).toBe("running")
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentItem.findFirst).not.toHaveBeenCalled()
  })
  it("returns pending for a duplicate while the exact queued attempt has its durable intent", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_1:legacy:q1"
    fixture.state.item = null

    const first = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })
    const duplicate = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(first).toMatchObject({ disposition: "legacy_dispatch_accepted" })
    expect(duplicate).toMatchObject({
      disposition: "legacy_dispatch_pending",
      outboxId: fixture.state.outbox[0]?.id,
      idempotencyKey: fixture.state.outbox[0]?.idempotencyKey,
    })
    expect(fixture.tx.agentOutbox.create).toHaveBeenCalledTimes(1)
    expect(fixture.state.outbox).toHaveLength(1)
  })
  it("rolls the legacy answer and queued attempt back when outbox insertion fails", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_1:legacy:q1"
    fixture.state.item = null
    fixture.state.failOutbox = true

    await expect(answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })).rejects.toThrow("outbox write failed")

    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.execution.status).toBe("waiting_for_user")
    expect(fixture.state.outbox).toHaveLength(0)
  })
  it("keeps canonical-mode questions bridge-pending when their AgentItem is missing", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_1:canonical:q1"
    fixture.state.item = null

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "bridge_pending", reason: "canonical_item_missing" })
    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.execution.status).toBe("waiting_for_user")
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it("does not answer or queue when Stop interrupted the exact namespaced Turn first", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_1:legacy:q1"
    fixture.state.item = null
    fixture.state.turns[0]!.status = "interrupted"

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "legacy_only", reason: "turn_not_waiting" })
    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.execution.status).toBe("waiting_for_user")
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it("queues an unnamespaced legacy answer through a durable intent when no Turn exists", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "legacy_question_1"
    fixture.state.turns = []
    fixture.state.item = null

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({
      disposition: "legacy_dispatch_accepted", questionId: "legacy_question_1", sessionId: "session_1",
      executionId: "execution_1", attemptCount: 4,
    })
    expect(fixture.state.question?.answer).toBe("yes")
    expect(fixture.state.execution.status).toBe("queued")
    expect(fixture.state.outbox).toHaveLength(1)
    expect(fixture.state.outbox[0]).toMatchObject({
      topic: "agent.execution.dispatch", aggregateId: "session_1",
      idempotencyKey: "legacy-execution-dispatch:execution_1:4:legacy_question_1",
      payload: { userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 4, questionId: "legacy_question_1" },
    })
  })

  it("reuses the outbox intent for an unnamespaced same-answer retry after commit", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "legacy_question_1"
    fixture.state.turns = []
    fixture.state.item = null

    const first = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })
    const retry = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(first).toMatchObject({ disposition: "legacy_dispatch_accepted" })
    expect(retry).toMatchObject({
      disposition: "legacy_dispatch_pending", outboxId: fixture.state.outbox[0]?.id,
      idempotencyKey: fixture.state.outbox[0]?.idempotencyKey,
    })
    expect(fixture.tx.agentOutbox.create).toHaveBeenCalledTimes(1)
    expect(fixture.state.outbox).toHaveLength(1)
  })

  it("reports an unnamespaced same-answer retry as resuming after the Worker creates its Turn", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "legacy_question_1"
    fixture.state.question!.answer = "yes"
    fixture.state.turns[0]!.input = { legacyResumeQuestionId: "legacy_question_1" }
    fixture.state.turns[0]!.status = "in_progress"
    fixture.state.execution.status = "running"
    fixture.state.execution.workerTaskId = "worker_task_1"
    fixture.state.item = null

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "legacy_already_resuming", questionId: "legacy_question_1", executionId: "execution_1" })
    expect(fixture.state.execution.status).toBe("running")
    expect(fixture.state.outbox).toHaveLength(0)
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it("returns legacy_answered for an answered raw duplicate without exact Turn provenance", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "legacy_question_1"
    fixture.state.question!.answer = "yes"
    fixture.state.turns[0]!.status = "in_progress"
    fixture.state.execution.status = "running"
    fixture.state.execution.workerTaskId = "later_worker_task"
    fixture.state.item = null

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: "legacy_question_1", userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({
      disposition: "legacy_answered", questionId: "legacy_question_1", sessionId: "session_1", answer: "yes",
    })
    expect(fixture.state.question?.answer).toBe("yes")
    expect(fixture.state.turns[0]?.status).toBe("in_progress")
    expect(fixture.state.execution).toMatchObject({ status: "running", workerTaskId: "later_worker_task" })
    expect(fixture.tx.agentRunQuestion.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentItem.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fixture.state.events).toHaveLength(0)
    expect(fixture.state.outbox).toHaveLength(0)
  })
  it("rolls back an unnamespaced answer and execution claim when outbox insert fails", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "legacy_question_1"
    fixture.state.turns = []
    fixture.state.item = null
    fixture.state.failOutbox = true

    await expect(answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })).rejects.toThrow("outbox write failed")

    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.execution.status).toBe("waiting_for_user")
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("does not project a legacy answer when an active canonical Turn owns the session", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "legacy_question_1"
    fixture.state.item = null

    const result = await answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id, userId: "user_1", answer: "yes",
    })

    expect(result).toMatchObject({ disposition: "bridge_pending", reason: "canonical_item_missing" })
    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.execution.status).toBe("waiting_for_user")
    expect(fixture.state.outbox).toHaveLength(0)
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it("answers a proven question and emits redacted answer and wakeup facts", async () => {
    const fixture = makeFixture()
    const result = await answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "yes", now: new Date("2026-09-21T12:00:00.000Z") })

    expect(result).toMatchObject({ disposition: "bridged", sessionId: "session_1", turnId: "turn_1", itemId: "agent-wait:question:question_1", nextTurnRevision: 6 })
    expect(fixture.state.question?.answer).toBe("yes")
    expect(fixture.state.item?.status).toBe("completed")
    expect(fixture.state.item?.revision).toBe(1)
    expect(fixture.state.turns[0]?.revision).toBe(6)
    expect(fixture.state.events.map((event) => event.type)).toEqual(["question.answered", "turn.wakeup"])
    expect(serialized(fixture.state.events)).not.toContain("yes")
    expect(serialized(fixture.state.outbox)).not.toContain("yes")
  })

  it("returns a duplicate for the same client message and rejects a second answer", async () => {
    const fixture = makeFixture()
    const first = await answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "yes", clientMessageId: "client_1" })
    const duplicate = await answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "yes", clientMessageId: "client_1" })

    expect(first.disposition).toBe("bridged")
    if (first.disposition !== "bridged") throw new Error("Expected the first answer to bridge")
    expect(duplicate).toMatchObject({ disposition: "duplicate", sequence: first.sequence, turnId: "turn_1" })
    expect(fixture.tx.agentItem.updateMany).toHaveBeenCalledTimes(1)
    await expect(answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "no", clientMessageId: "client_2" })).rejects.toMatchObject({ code: "wait_not_pending", status: 409 })
    expect(fixture.state.item?.revision).toBe(1)
    expect(fixture.state.turns[0]?.revision).toBe(6)
  })

  it("does not bridge a namespaced question when its exact Turn is missing", async () => {
    const fixture = makeFixture()
    fixture.state.question!.id = "agent-question:turn_missing:legacy:q1"
    fixture.state.turns = []

    await expect(answerLegacyQuestion(fixture.db, {
      questionId: fixture.state.question!.id,
      userId: "user_1",
      answer: "yes",
    })).resolves.toMatchObject({ disposition: "legacy_only", reason: "turn_not_waiting" })
    expect(fixture.state.question?.answer).toBeNull()
  })

  it.each([
    ["missing session", (state: FixtureState) => { state.session = null }, { disposition: "legacy_only", reason: "session_unmapped" }],
    ["non-waiting turn", (state: FixtureState) => { state.turns[0]!.status = "in_progress" }, { disposition: "legacy_only", reason: "turn_not_waiting" }],
    ["ambiguous active turns", (state: FixtureState) => { state.turns.push({ ...state.turns[0]!, id: "turn_2" }) }, { disposition: "bridge_pending", reason: "active_turn_ambiguous" }],
    ["missing item", (state: FixtureState) => { state.item = null }, { disposition: "bridge_pending", reason: "canonical_item_missing" }],
    ["missing provenance", (state: FixtureState) => { delete (state.item?.content as Json).sourcePayload }, { disposition: "bridge_pending", reason: "provenance_missing" }],
  ])("fails closed for %s", async (_name, mutate, expected) => {
    const fixture = makeFixture()
    mutate(fixture.state)
    await expect(answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "yes" })).resolves.toMatchObject(expected)
    expect(fixture.state.question?.answer).toBeNull()
  })

  it("rejects foreign or conflicting canonical evidence", async () => {
    const foreign = makeFixture()
    await expect(answerLegacyQuestion(foreign.db, { questionId: "question_1", userId: "user_2", answer: "yes" })).resolves.toMatchObject({ disposition: "legacy_only", reason: "question_not_found" })

    const conflict = makeFixture()
    ;(conflict.state.item?.content as Json).question = "Different question"
    await expect(answerLegacyQuestion(conflict.db, { questionId: "question_1", userId: "user_1", answer: "yes" })).rejects.toMatchObject({ code: "wait_scope_mismatch", status: 409 })
    expect(conflict.state.question?.answer).toBeNull()
  })

  it("rejects an answer outside the canonical option values without mutation", async () => {
    const fixture = makeFixture()
    await expect(answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "maybe" })).rejects.toMatchObject({ code: "wait_invalid_answer", status: 422 })
    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.events).toHaveLength(0)
  })

  it("rolls back all projections when an outbox write fails", async () => {
    const fixture = makeFixture()
    fixture.state.failOutbox = true
    await expect(answerLegacyQuestion(fixture.db, { questionId: "question_1", userId: "user_1", answer: "yes" })).rejects.toThrow("outbox write failed")
    expect(fixture.state.question?.answer).toBeNull()
    expect(fixture.state.item?.status).toBe("started")
    expect(fixture.state.item?.revision).toBe(0)
    expect(fixture.state.turns[0]?.revision).toBe(5)
    expect(fixture.state.events).toHaveLength(0)
    expect(fixture.state.outbox).toHaveLength(0)
  })
})
