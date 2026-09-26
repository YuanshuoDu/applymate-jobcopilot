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
  }
}

function makeFixture() {
  const state = baseState()
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const strings = (query as { strings?: readonly string[] }).strings ?? []
      if (strings.join(" ").includes("SELECT")) {
        return state.session ? [{ ...state.session }] : []
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

  it.each([
    ["missing session", (state: FixtureState) => { state.session = null }, { disposition: "legacy_only", reason: "session_unmapped" }],
    ["missing active turn", (state: FixtureState) => { state.turns = [] }, { disposition: "legacy_only", reason: "no_active_turn" }],
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
