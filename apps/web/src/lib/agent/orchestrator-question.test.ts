import { describe, expect, it, vi } from "vitest"

import type { Prisma, PrismaClient } from "@prisma/client"

import { AgentExecutionCancelledError } from "./execution-control"
import { cancelUnansweredTurnQuestionsInTransaction, findOrCreateOrchestratorQuestion } from "./orchestrator-question"

function makeDb(turnStatuses: Record<string, string> = {}, turnInputs: Record<string, unknown> = {}) {
  const rows: Array<{ id: string; userId: string; runId: string; stage: string; question: string; answer: string | null; options: object[] }> = []
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = (query as { strings?: readonly string[] }).strings?.join(" ") ?? ""
      if (sql.includes('FROM "agent_sessions"')) return [{ id: "session_1" }]
      const turnId = (query as { values?: readonly unknown[] }).values?.[0] === "turn_2" ? "turn_2" : "turn_1"
      const status = turnStatuses[turnId] ?? "in_progress"
      return status === "missing" ? [] : [{ id: turnId, status, input: turnInputs[turnId] ?? {} }]
    }),
    agentExecution: { updateMany: vi.fn(async () => ({ count: 1 })) },
    agentRunQuestion: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => [...rows].reverse().find(row => row.userId === where.userId
        && row.runId === where.runId
        && (where.stage === undefined || row.stage === where.stage)
        && (where.question === undefined || row.question === where.question)
        && (typeof where.id === "string" ? row.id === where.id
          : !where.id || row.id.startsWith((where.id as { startsWith: string }).startsWith))) ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...data, answer: null } as (typeof rows)[number]
        rows.push(row)
        return row
      }),
      deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const prefix = (where.id as { startsWith: string }).startsWith
        const before = rows.length
        for (let index = rows.length - 1; index >= 0; index -= 1) {
          const row = rows[index]!
          if (row.userId === where.userId && row.runId === where.runId && (where.stage === undefined || row.stage === where.stage)
            && (where.question === undefined || row.question === where.question)
            && row.answer === where.answer && row.id.startsWith(prefix)) rows.splice(index, 1)
        }
        return { count: before - rows.length }
      }),
    },
  }
  const db = {
    ...tx,
    $transaction: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx)),
  } as unknown as PrismaClient
  return { db, tx, rows }
}

const owner = {
  userId: "user_1",
  runId: "session_1",
  sessionId: "session_1",
  turnId: "turn_1",
  executionAttempt: { id: "execution_1", attemptCount: 4 },
  stage: "writer",
  question: "Tailor resume?",
  options: [{ label: "Keep", value: "keep_resume" }],
  questionProjectionMode: "canonical" as const,
}

describe("orchestrator question ownership", () => {
  it("namespaces questions by projection mode and never reuses another mode's answer", async () => {
    const { db, rows } = makeDb()
    const canonical = await findOrCreateOrchestratorQuestion(db, owner)
    rows[0]!.answer = "keep_resume"

    const legacy = await findOrCreateOrchestratorQuestion(db, { ...owner, questionProjectionMode: "legacy" })

    expect(canonical.id).toMatch(/^agent-question:turn_1:canonical:/)
    expect(legacy.id).toMatch(/^agent-question:turn_1:legacy:/)
    expect(legacy.id).not.toBe(canonical.id)
    expect(legacy.answer).toBeNull()
  })

  it("reuses an answered Turn question when its options are unchanged", async () => {
    const { db, tx, rows } = makeDb()
    const original = await findOrCreateOrchestratorQuestion(db, owner)
    rows[0]!.answer = "keep_resume"

    const resumed = await findOrCreateOrchestratorQuestion(db, { ...owner, options: [{ ...owner.options[0]! }] })

    expect(resumed.id).toBe(original.id)
    expect(resumed.answer).toBe("keep_resume")
    expect(tx.agentRunQuestion.create).toHaveBeenCalledTimes(1)
  })

  it("resumes only the exact dispatched answered legacy question", async () => {
    const { db, tx, rows } = makeDb()
    const legacyOwner = { ...owner, questionProjectionMode: "legacy" as const }
    const original = await findOrCreateOrchestratorQuestion(db, legacyOwner)
    rows[0]!.answer = "keep_resume"

    const resumed = await findOrCreateOrchestratorQuestion(db, {
      ...legacyOwner,
      expectedQuestionId: original.id,
    })

    expect(resumed.id).toBe(original.id)
    expect(resumed.answer).toBe("keep_resume")
    expect(tx.agentRunQuestion.create).toHaveBeenCalledTimes(1)
  })

  it("consumes a raw pre-Turn answer only from the exact provenance-marked continuation Turn", async () => {
    const rawQuestion = {
      id: "legacy_question_1", userId: "user_1", runId: "session_1", stage: "writer",
      question: "Tailor resume?", answer: "keep_resume", options: [{ label: "Keep", value: "keep_resume" }],
    }
    const { db, rows } = makeDb({}, { turn_1: { legacyResumeQuestionId: rawQuestion.id } })
    rows.push(rawQuestion)

    const resumed = await findOrCreateOrchestratorQuestion(db, {
      ...owner, questionProjectionMode: "legacy", expectedQuestionId: rawQuestion.id,
    })

    expect(resumed.id).toBe(rawQuestion.id)
    expect(resumed.answer).toBe("keep_resume")
  })

  it("does not attach a raw pre-Turn answer to an unrelated later Turn", async () => {
    const rawQuestion = {
      id: "legacy_question_1", userId: "user_1", runId: "session_1", stage: "writer",
      question: "Tailor resume?", answer: "keep_resume", options: [{ label: "Keep", value: "keep_resume" }],
    }
    const { db, rows } = makeDb({}, { turn_1: { legacyResumeQuestionId: "different_question" } })
    rows.push(rawQuestion)

    const replacement = await findOrCreateOrchestratorQuestion(db, {
      ...owner, questionProjectionMode: "legacy", expectedQuestionId: rawQuestion.id,
    })

    expect(replacement.id).not.toBe(rawQuestion.id)
    expect(replacement.id).toMatch(/^agent-question:turn_1:legacy:/)
    expect(replacement.answer).toBeNull()
    expect(rows.find(row => row.id === rawQuestion.id)?.answer).toBe("keep_resume")
  })

  it("never applies the dispatched answer when the resumed prompt changes", async () => {
    const { db, tx, rows } = makeDb()
    const legacyOwner = { ...owner, questionProjectionMode: "legacy" as const }
    const original = await findOrCreateOrchestratorQuestion(db, legacyOwner)
    rows[0]!.answer = "keep_resume"

    const replacement = await findOrCreateOrchestratorQuestion(db, {
      ...legacyOwner,
      expectedQuestionId: original.id,
      question: "Choose a different resume?",
    })

    expect(replacement.id).not.toBe(original.id)
    expect(replacement.answer).toBeNull()
    expect(tx.agentRunQuestion.create).toHaveBeenCalledTimes(2)
    expect(rows.find(row => row.id === original.id)?.answer).toBe("keep_resume")
  })

  it("never applies the dispatched answer when the exact question options change", async () => {
    const { db, tx, rows } = makeDb()
    const legacyOwner = { ...owner, questionProjectionMode: "legacy" as const }
    const original = await findOrCreateOrchestratorQuestion(db, {
      ...legacyOwner,
      options: [{ label: "Keep", value: "keep_resume", action: { field: "resume", value: "keep" } }],
    })
    rows[0]!.answer = "keep_resume"

    const replacement = await findOrCreateOrchestratorQuestion(db, {
      ...legacyOwner,
      expectedQuestionId: original.id,
      options: [{ label: "Replace", value: "replace_resume", action: { field: "resume", value: "replace" } }],
    })

    expect(replacement.id).not.toBe(original.id)
    expect(replacement.answer).toBeNull()
    expect(tx.agentRunQuestion.create).toHaveBeenCalledTimes(2)
    expect(rows.find(row => row.id === original.id)?.answer).toBe("keep_resume")
  })

  it.each([
    ["value", { label: "Keep", value: "replace_resume", action: { field: "resume", value: "keep" } }],
    ["action", { label: "Keep", value: "keep_resume", action: { field: "resume", value: "replace" } }],
  ])("creates a fresh question when the %s option payload changes", async (_change, changedOption) => {
    const { db, tx, rows } = makeDb()
    const original = await findOrCreateOrchestratorQuestion(db, {
      ...owner,
      options: [{ label: "Keep", value: "keep_resume", action: { field: "resume", value: "keep" } }],
    })
    rows[0]!.answer = "keep_resume"

    const fresh = await findOrCreateOrchestratorQuestion(db, { ...owner, options: [changedOption] })

    expect(fresh.id).not.toBe(original.id)
    expect(fresh.answer).toBeNull()
    expect(tx.agentRunQuestion.create).toHaveBeenCalledTimes(2)
  })

  it("removes stale unanswered duplicates while preserving answered history and other question scopes", async () => {
    const { db, rows } = makeDb()
    const original = await findOrCreateOrchestratorQuestion(db, {
      ...owner,
      options: [{ label: "Keep", value: "keep_resume", action: { field: "resume", value: "keep" } }],
    })
    rows[0]!.answer = "keep_resume"
    rows.push(
      { id: "agent-question:turn_1:canonical:stale", userId: "user_1", runId: "session_1", stage: "writer", question: "Tailor resume?", answer: null, options: [{ label: "Keep", value: "keep_resume" }] },
      { id: "agent-question:turn_1:canonical:other-stage", userId: "user_1", runId: "session_1", stage: "analyst", question: "Tailor resume?", answer: null, options: [] },
      { id: "agent-question:turn_1:canonical:other-question", userId: "user_1", runId: "session_1", stage: "writer", question: "Different question?", answer: null, options: [] },
      { id: "agent-question:turn_2:canonical:other-turn", userId: "user_1", runId: "session_1", stage: "writer", question: "Tailor resume?", answer: null, options: [] },
      { id: "agent-question:turn_1:canonical:other-user", userId: "user_2", runId: "session_1", stage: "writer", question: "Tailor resume?", answer: null, options: [] },
    )

    const fresh = await findOrCreateOrchestratorQuestion(db, {
      ...owner,
      options: [{ label: "Replace", value: "replace_resume", action: { field: "resume", value: "replace" } }],
    })

    expect(rows.map(row => row.id)).toEqual([
      original.id,
      "agent-question:turn_1:canonical:other-stage",
      "agent-question:turn_1:canonical:other-question",
      "agent-question:turn_2:canonical:other-turn",
      "agent-question:turn_1:canonical:other-user",
      fresh.id,
    ])
    expect(rows.find(row => row.id === original.id)?.answer).toBe("keep_resume")
    expect(rows.filter(row => row.userId === owner.userId && row.runId === owner.runId && row.stage === owner.stage
      && row.question === owner.question && row.answer === null && row.id.startsWith("agent-question:turn_1:")).map(row => row.id)).toEqual([fresh.id])
  })

  it("cleans stale unanswered rows only within the current projection mode", async () => {
    const { db, rows } = makeDb()
    const staleCanonical = await findOrCreateOrchestratorQuestion(db, owner)
    const pendingLegacy = await findOrCreateOrchestratorQuestion(db, { ...owner, questionProjectionMode: "legacy" })

    const freshCanonical = await findOrCreateOrchestratorQuestion(db, {
      ...owner,
      options: [{ label: "Replace", value: "replace_resume" }],
    })

    expect(staleCanonical.id).toMatch(/^agent-question:turn_1:canonical:/)
    expect(pendingLegacy.id).toMatch(/^agent-question:turn_1:legacy:/)
    expect(rows.map(row => row.id)).toEqual([pendingLegacy.id, freshCanonical.id])
  })

  it("locks Session, Turn, and exact execution before creating a Turn-namespaced question", async () => {
    const { db, tx } = makeDb()

    const question = await findOrCreateOrchestratorQuestion(db, owner)

    expect(question.id).toMatch(/^agent-question:turn_1:canonical:/)
    const locks = tx.$queryRaw.mock.calls.map(([query]) => (query as { strings?: readonly string[] }).strings?.join(" ") ?? "")
    expect(locks[0]).toContain('FROM "agent_sessions"')
    expect(locks[1]).toContain('FROM "agent_turns"')
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(tx.agentExecution.updateMany.mock.invocationCallOrder[0]!)
  })

  it("does not create a question when Stop already interrupted its Turn", async () => {
    const { db, tx } = makeDb({ turn_1: "interrupted" })

    await expect(findOrCreateOrchestratorQuestion(db, owner)).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(tx.agentRunQuestion.create).not.toHaveBeenCalled()
    expect(tx.agentExecution.updateMany).not.toHaveBeenCalled()
  })

  it("does not create a legacy question after its signal was aborted", async () => {
    const { db, tx } = makeDb()
    const controller = new AbortController()
    controller.abort()

    await expect(findOrCreateOrchestratorQuestion(db, {
      ...owner, turnId: undefined, executionAttempt: undefined, signal: controller.signal,
    })).rejects.toBeInstanceOf(AgentExecutionCancelledError)
    expect(tx.agentRunQuestion.findFirst).not.toHaveBeenCalled()
    expect(tx.agentRunQuestion.create).not.toHaveBeenCalled()
  })

  it("deletes only unanswered questions for the stopped Turn and allows a later Turn", async () => {
    const { db, tx, rows } = makeDb()
    const stoppedQuestion = await findOrCreateOrchestratorQuestion(db, owner)
    rows.push({ id: "agent-question:turn_1:canonical:answered", userId: "user_1", runId: "session_1", stage: "writer", question: "Old answer", answer: "yes", options: [] })
    rows.push({ id: "agent-question:turn_1:legacy:pending", userId: "user_1", runId: "session_1", stage: "writer", question: "Legacy question", answer: null, options: [] })
    rows.push({ id: "agent-question:turn_2:legacy:older", userId: "user_1", runId: "session_1", stage: "writer", question: "Other Turn", answer: null, options: [] })

    await cancelUnansweredTurnQuestionsInTransaction(tx as unknown as Prisma.TransactionClient, {
      userId: "user_1", sessionId: "session_1", turnId: "turn_1",
    })

    expect(rows.map(row => row.id)).toEqual(["agent-question:turn_1:canonical:answered", "agent-question:turn_2:legacy:older"])
    const later = await findOrCreateOrchestratorQuestion(db, { ...owner, turnId: "turn_2", question: "Later Turn question?" })
    expect(later.id).toMatch(/^agent-question:turn_2:canonical:/)
    expect(rows.some(row => row.id === stoppedQuestion.id)).toBe(false)
    expect(rows.some(row => row.id === "agent-question:turn_1:legacy:pending")).toBe(false)
    expect(rows.some(row => row.id === "agent-question:turn_2:legacy:older")).toBe(true)
  })
})
