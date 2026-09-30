import { describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import type { PrismaClient } from "@prisma/client"

import {
  answerLegacyQuestionWithoutTurnInTransaction,
  answerLegacyResumableQuestionInTransaction,
  lockNamespacedQuestionTurn,
} from "./legacy-turn-question-answer"

type Outbox = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }
type State = {
  session: { id: string; userId: string; status: string } | null
  turn: { id: string; sessionId: string; userId: string; status: string; revision: number; input?: unknown } | null
  execution: { id: string; sessionId: string; userId: string; status: string; attemptCount: number; workerTaskId: string | null } | null
  question: { id: string; userId: string; runId: string; options: unknown; answer: string | null; answeredAt: Date | null }
  outbox: Outbox[]
  failOutbox: boolean
  failTurnPause: boolean
}

function makeFixture() {
  const state: State = {
    session: { id: "session_1", userId: "user_1", status: "waiting_for_user" },
    turn: { id: "turn_1", sessionId: "session_1", userId: "user_1", status: "waiting_for_user", revision: 3 },
    execution: { id: "execution_1", sessionId: "session_1", userId: "user_1", status: "waiting_for_user", attemptCount: 7, workerTaskId: null },
    question: {
      id: "agent-question:turn_1:legacy:q1", userId: "user_1", runId: "session_1",
      options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }],
      answer: null, answeredAt: null,
    },
    outbox: [],
    failOutbox: false,
    failTurnPause: false,
  }
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes('FROM "agent_sessions"')) return state.session ? [{ id: state.session.id }] : []
      if (sql.includes('FROM "agent_turns"')) {
        return state.turn && ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(state.turn.status) ? [{ ...state.turn }] : []
      }
      if (sql.includes('FROM "agent_executions"')) {
        return state.execution ? [{ id: state.execution.id, status: state.execution.status, attemptCount: state.execution.attemptCount, workerTaskId: state.execution.workerTaskId }] : []
      }
      return []
    }),
    agentRunQuestion: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (where.id !== state.question.id || where.userId !== state.question.userId || where.runId !== state.question.runId) return { count: 0 }
        if (where.answer !== state.question.answer) return { count: 0 }
        if (typeof data.answer === "string" || data.answer === null) state.question.answer = data.answer
        state.question.answeredAt = data.answeredAt instanceof Date ? data.answeredAt : null
        return { count: 1 }
      }),
    },
    agentTurn: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const turn = state.turn
        if (state.failTurnPause || !turn || where.id !== turn.id || where.sessionId !== turn.sessionId
          || where.userId !== turn.userId || where.status !== turn.status || where.revision !== turn.revision) return { count: 0 }
        turn.status = String(data.status)
        if (typeof data.revision === "object" && data.revision !== null) turn.revision += Number((data.revision as { increment?: unknown }).increment ?? 0)
        return { count: 1 }
      }),
    },
    agentSession: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const session = state.session
        const statusFilter = where.status as { notIn?: string[] } | undefined
        if (!session || where.id !== session.id || where.userId !== session.userId
          || statusFilter?.notIn?.includes(session.status)) return { count: 0 }
        session.status = String(data.status)
        return { count: 1 }
      }),
    },
    agentExecution: {
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const execution = state.execution
        if (!execution || where.id !== execution.id || where.userId !== execution.userId || where.sessionId !== execution.sessionId
          || where.status !== execution.status || where.attemptCount !== execution.attemptCount
          || ("workerTaskId" in where && where.workerTaskId !== execution.workerTaskId)) return { count: 0 }
        execution.status = String(data.status)
        if ("workerTaskId" in data) execution.workerTaskId = typeof data.workerTaskId === "string" ? data.workerTaskId : null
        return { count: 1 }
      }),
    },
    agentOutbox: {
      create: vi.fn(async ({ data }: { data: Outbox }) => {
        if (state.failOutbox) throw new Error("outbox unavailable")
        state.outbox.push(data)
        return data
      }),
      findUnique: vi.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        state.outbox.find(row => row.idempotencyKey === where.idempotencyKey) ?? null),
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

async function acceptAnswer(fixture: ReturnType<typeof makeFixture>) {
  return fixture.db.$transaction(async rawTx => {
    const tx = rawTx as unknown as Prisma.TransactionClient
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "agent_sessions" WHERE "id" = 'session_1' FOR UPDATE`)
    const turn = await lockNamespacedQuestionTurn(tx, { turnId: "turn_1", sessionId: "session_1", userId: "user_1" })
    if (!turn) return null
    return answerLegacyResumableQuestionInTransaction(tx, {
      question: fixture.state.question, turn, answer: "yes",
    })
  })
}

async function acceptRawAnswer(fixture: ReturnType<typeof makeFixture>) {
  return fixture.db.$transaction(async rawTx => {
    const tx = rawTx as unknown as Prisma.TransactionClient
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "agent_sessions" WHERE "id" = 'session_1' FOR UPDATE`)
    return answerLegacyQuestionWithoutTurnInTransaction(tx, {
      question: fixture.state.question, userId: "user_1", sessionId: "session_1", answer: "yes",
    })
  })
}

describe("legacy Turn-prefixed question resume", () => {
  it("commits the exact answer, execution claim, and validated dispatch intent atomically", async () => {
    const fixture = makeFixture()
    const result = await acceptAnswer(fixture)

    expect(result).toMatchObject({
      disposition: "legacy_dispatch_accepted", questionId: fixture.state.question.id,
      sessionId: "session_1", turnId: "turn_1", executionId: "execution_1", attemptCount: 7,
      idempotencyKey: "legacy-execution-dispatch:execution_1:7:agent-question:turn_1:legacy:q1",
    })
    expect(fixture.state.question.answer).toBe("yes")
    expect(fixture.state.execution?.status).toBe("queued")
    expect(fixture.state.outbox).toHaveLength(1)
    expect(fixture.state.outbox[0]).toMatchObject({
      id: expect.stringMatching(/^legacy-execution-dispatch-[a-f0-9]{64}$/),
      topic: "agent.execution.dispatch", aggregateId: "session_1",
      idempotencyKey: "legacy-execution-dispatch:execution_1:7:agent-question:turn_1:legacy:q1",
      payload: { userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 7, questionId: fixture.state.question.id },
    })
    expect(Object.keys(fixture.state.outbox[0]!.payload as Record<string, unknown>).sort()).toEqual([
      "attemptCount", "executionId", "questionId", "sessionId", "userId",
    ])
  })

  it("does not create a second intent for a same-answer duplicate while queued", async () => {
    const fixture = makeFixture()
    const first = await acceptAnswer(fixture)
    const duplicate = await acceptAnswer(fixture)

    expect(first).toMatchObject({ disposition: "legacy_dispatch_accepted" })
    expect(duplicate).toMatchObject({
      disposition: "legacy_dispatch_pending",
      outboxId: fixture.state.outbox[0]?.id,
      idempotencyKey: fixture.state.outbox[0]?.idempotencyKey,
    })
    expect(fixture.tx.agentOutbox.create).toHaveBeenCalledTimes(1)
    expect(fixture.tx.agentOutbox.findUnique).toHaveBeenCalledTimes(1)
    expect(fixture.state.outbox).toHaveLength(1)
  })

  it("rolls back the answer and execution claim if the intent insert fails", async () => {
    const fixture = makeFixture()
    fixture.state.failOutbox = true

    await expect(acceptAnswer(fixture)).rejects.toThrow("outbox unavailable")

    expect(fixture.state.question.answer).toBeNull()
    expect(fixture.state.execution?.status).toBe("waiting_for_user")
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("repairs a stranded queued attempt with its one exact durable intent", async () => {
    const fixture = makeFixture()
    fixture.state.question.answer = "yes"
    fixture.state.execution!.status = "queued"

    await expect(acceptAnswer(fixture)).resolves.toMatchObject({
      disposition: "legacy_dispatch_pending",
      idempotencyKey: "legacy-execution-dispatch:execution_1:7:agent-question:turn_1:legacy:q1",
    })
    expect(fixture.tx.agentOutbox.create).toHaveBeenCalledTimes(1)
    expect(fixture.state.outbox).toHaveLength(1)
  })

  it("fails closed when the existing stable key points to a different dispatch payload", async () => {
    const fixture = makeFixture()
    fixture.state.question.answer = "yes"
    fixture.state.execution!.status = "queued"
    fixture.state.outbox.push({
      id: "foreign-intent", topic: "agent.execution.dispatch", aggregateId: "session_1",
      idempotencyKey: "legacy-execution-dispatch:execution_1:7:agent-question:turn_1:legacy:q1",
      payload: { userId: "other_user", sessionId: "session_1", executionId: "execution_1", attemptCount: 7, questionId: fixture.state.question.id },
    })

    await expect(acceptAnswer(fixture)).resolves.toMatchObject({ disposition: "legacy_dispatch_conflict" })
    expect(fixture.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fixture.state.outbox).toHaveLength(1)
  })

  it("fails closed when the namespaced question and locked Turn do not match", async () => {
    const fixture = makeFixture()
    const result = await answerLegacyResumableQuestionInTransaction(
      fixture.tx as unknown as Prisma.TransactionClient,
      {
        question: { ...fixture.state.question, id: "agent-question:turn_2:legacy:q1" },
        turn: fixture.state.turn!, answer: "yes",
      },
    )

    expect(result).toBeNull()
    expect(fixture.tx.$queryRaw).not.toHaveBeenCalled()
    expect(fixture.state.question.answer).toBeNull()
    expect(fixture.state.execution?.status).toBe("waiting_for_user")
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("repairs only an unanswered visible first question and pauses Turn/session before dispatch", async () => {
    const fixture = makeFixture()
    fixture.state.turn!.status = "in_progress"
    fixture.state.execution!.status = "running"
    fixture.state.execution!.workerTaskId = "initial_worker_job"
    expect(fixture.state.question.answer).toBeNull()

    await expect(acceptAnswer(fixture)).resolves.toMatchObject({
      disposition: "legacy_dispatch_accepted", turnId: "turn_1", executionId: "execution_1", attemptCount: 7,
    })

    expect(fixture.state.question.answer).toBe("yes")
    expect(fixture.state.turn?.status).toBe("waiting_for_user")
    expect(fixture.state.session?.status).toBe("waiting_for_user")
    expect(fixture.state.execution).toMatchObject({ status: "queued", workerTaskId: null, attemptCount: 7 })
    expect(fixture.state.outbox).toHaveLength(1)
    const lockOrder = fixture.tx.$queryRaw.mock.calls.map(([query]) => ((query as { strings?: readonly string[] }).strings ?? []).join(" "))
      .map(sql => sql.match(/FROM "agent_(sessions|turns|executions)"/)?.[1])
    expect(lockOrder).toEqual(["sessions", "turns", "executions"])
  })

  it.each([
    ["running", "resumed_worker_job"],
    ["waiting_for_user", "later_stage_worker_job"],
    ["queued", null],
  ] as const)("treats a delayed answer as idempotent during later Turn work (%s)", async (status, workerTaskId) => {
    const fixture = makeFixture()
    fixture.state.turn!.status = "in_progress"
    fixture.state.session!.status = "running"
    fixture.state.execution!.status = status
    fixture.state.execution!.workerTaskId = workerTaskId
    fixture.state.question.answer = "yes"

    await expect(acceptAnswer(fixture)).resolves.toMatchObject({
      disposition: "legacy_already_resuming", questionId: fixture.state.question.id,
      executionId: "execution_1", attemptCount: 7,
    })

    expect(fixture.state.turn?.status).toBe("in_progress")
    expect(fixture.state.session?.status).toBe("running")
    expect(fixture.state.execution).toMatchObject({ status, workerTaskId })
    expect(fixture.tx.agentRunQuestion.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("does not leave an answered question if the pause repair loses its Turn CAS", async () => {
    const fixture = makeFixture()
    fixture.state.turn!.status = "in_progress"
    fixture.state.execution!.status = "running"
    fixture.state.failTurnPause = true

    await expect(acceptAnswer(fixture)).rejects.toThrow()

    expect(fixture.state.question.answer).toBeNull()
    expect(fixture.state.turn?.status).toBe("in_progress")
    expect(fixture.state.session?.status).toBe("waiting_for_user")
    expect(fixture.state.execution?.status).toBe("running")
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("accepts an unnamespaced answer only after rechecking that no active Turn exists", async () => {
    const fixture = makeFixture()
    fixture.state.turn = null
    fixture.state.question.id = "legacy_question_1"
    await fixture.tx.$queryRaw(Prisma.sql`SELECT "id" FROM "agent_sessions" WHERE "id" = 'session_1' FOR UPDATE`)

    const result = await answerLegacyQuestionWithoutTurnInTransaction(
      fixture.tx as unknown as Prisma.TransactionClient,
      { question: fixture.state.question, userId: "user_1", sessionId: "session_1", answer: "yes" },
    )

    expect(result).toMatchObject({ disposition: "legacy_dispatch_accepted", questionId: "legacy_question_1", sessionId: "session_1" })
    expect(fixture.state.question.answer).toBe("yes")
    expect(fixture.state.execution?.status).toBe("queued")
    expect(fixture.state.outbox).toHaveLength(1)
    const sqlOrder = fixture.tx.$queryRaw.mock.calls.map(([query]) => ((query as { strings?: readonly string[] }).strings ?? []).join(" "))
    expect(sqlOrder.map(sql => sql.match(/FROM "agent_(sessions|turns|executions)"/)?.[1])).toEqual(["sessions", "turns", "executions"])
  })

  it.each(["running", "queued"] as const)("keeps a delayed raw answer idempotent when an unrelated active Turn has %s work", async status => {
    const fixture = makeFixture()
    fixture.state.turn!.status = "in_progress"
    fixture.state.session!.status = "running"
    fixture.state.question.id = "legacy_question_1"
    fixture.state.question.answer = "yes"
    fixture.state.execution!.status = status
    fixture.state.execution!.workerTaskId = "later_worker_job"

    await expect(acceptRawAnswer(fixture)).resolves.toMatchObject({
      disposition: "legacy_answered", questionId: "legacy_question_1", sessionId: "session_1", answer: "yes",
    })
    expect(fixture.state.turn?.status).toBe("in_progress")
    expect(fixture.state.question.answer).toBe("yes")
    expect(fixture.tx.agentRunQuestion.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentTurn.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentSession.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("recognizes a raw answer continuation only from the exact active Turn provenance", async () => {
    const fixture = makeFixture()
    fixture.state.turn!.status = "in_progress"
    fixture.state.turn!.input = { legacyResumeQuestionId: "legacy_question_1" }
    fixture.state.session!.status = "running"
    fixture.state.question.id = "legacy_question_1"
    fixture.state.question.answer = "yes"
    fixture.state.execution!.status = "running"
    fixture.state.execution!.workerTaskId = "resumed_worker_job"

    await expect(acceptRawAnswer(fixture)).resolves.toMatchObject({
      disposition: "legacy_already_resuming", questionId: "legacy_question_1", sessionId: "session_1",
      executionId: "execution_1", attemptCount: 7,
    })
    expect(fixture.tx.agentRunQuestion.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    expect(fixture.tx.agentOutbox.create).not.toHaveBeenCalled()
    expect(fixture.state.outbox).toHaveLength(0)
  })

  it("does not accept an unnamespaced answer if an active Turn owns the locked session", async () => {
    const fixture = makeFixture()
    fixture.state.question.id = "legacy_question_1"
    await fixture.tx.$queryRaw(Prisma.sql`SELECT "id" FROM "agent_sessions" WHERE "id" = 'session_1' FOR UPDATE`)

    const result = await answerLegacyQuestionWithoutTurnInTransaction(
      fixture.tx as unknown as Prisma.TransactionClient,
      { question: fixture.state.question, userId: "user_1", sessionId: "session_1", answer: "yes" },
    )

    expect(result).toMatchObject({ disposition: "legacy_only", reason: "active_turn_owns_wait" })
    expect(fixture.state.question.answer).toBeNull()
    expect(fixture.state.execution?.status).toBe("waiting_for_user")
    expect(fixture.state.outbox).toHaveLength(0)
    expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it.each(["agent-question:turn_1:canonical:q1", "agent-question:malformed"])(
    "fails closed for a non-legacy prefixed question without an active Turn: %s",
    async questionId => {
      const fixture = makeFixture()
      fixture.state.turn = null
      fixture.state.question.id = questionId
      await fixture.tx.$queryRaw(Prisma.sql`SELECT "id" FROM "agent_sessions" WHERE "id" = 'session_1' FOR UPDATE`)

      const result = await answerLegacyQuestionWithoutTurnInTransaction(
        fixture.tx as unknown as Prisma.TransactionClient,
        { question: fixture.state.question, userId: "user_1", sessionId: "session_1", answer: "yes" },
      )

      expect(result).toMatchObject({ disposition: "legacy_only", reason: "question_not_waiting" })
      expect(fixture.state.question.answer).toBeNull()
      expect(fixture.state.execution?.status).toBe("waiting_for_user")
      expect(fixture.state.outbox).toHaveLength(0)
      expect(fixture.tx.agentExecution.updateMany).not.toHaveBeenCalled()
    },
  )

  it("preserves answer-only behavior when there is no execution to resume", async () => {
    const fixture = makeFixture()
    fixture.state.turn = null
    fixture.state.execution = null
    fixture.state.question.id = "legacy_question_1"

    const result = await answerLegacyQuestionWithoutTurnInTransaction(
      fixture.tx as unknown as Prisma.TransactionClient,
      { question: fixture.state.question, userId: "user_1", sessionId: "session_1", answer: "yes" },
    )

    expect(result).toMatchObject({ disposition: "legacy_answered", questionId: "legacy_question_1", answer: "yes" })
    expect(fixture.state.question.answer).toBe("yes")
    expect(fixture.state.outbox).toHaveLength(0)
  })
})
