import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"

import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "./execution-control"
import { lockOpenSession } from "./session/v2-turn"
import type { AgentQuestionOption } from "./types"

const ACTIVE_TURN_STATUSES = ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"] as const
const turnQuestionPrefix = (turnId: string) => `agent-question:${turnId}:`

type QuestionRow = { id: string; answer: string | null }
type QuestionInput = {
  userId: string
  runId: string
  sessionId?: string
  turnId?: string
  executionAttempt?: { id: string; attemptCount: number }
  signal?: AbortSignal
  stage: string
  question: string
  options: AgentQuestionOption[]
  questionProjectionMode: "legacy" | "canonical"
  expectedQuestionId?: string
}
const turnQuestionModePrefix = (turnId: string, mode: QuestionInput["questionProjectionMode"]) => `${turnQuestionPrefix(turnId)}${mode}:`

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

function optionsCompatible(stored: unknown, current: AgentQuestionOption[]): boolean {
  if (!Array.isArray(stored) || stored.length !== current.length) return false
  return stored.every((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false
    const option = candidate as Record<string, unknown>
    const expected = current[index]!
    return option.label === expected.label
      && option.value === expected.value
      && stableJson(option.action) === stableJson(expected.action)
  })
}

export async function findOrCreateOrchestratorQuestion(db: PrismaClient, input: QuestionInput): Promise<QuestionRow> {
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  if (!input.turnId && !input.executionAttempt) return findOrCreateLegacyQuestion(db, input)
  if (!input.sessionId || input.runId !== input.sessionId || !input.turnId || !input.executionAttempt) throw new AgentExecutionCancelledError()

  return db.$transaction(async tx => {
    await lockOpenSession(tx, { sessionId: input.sessionId!, userId: input.userId })
    const rows = await tx.$queryRaw<Array<{ id: string; status: string; input: unknown }>>(Prisma.sql`
      SELECT "id", "status", "input" FROM "agent_turns"
      WHERE "id" = ${input.turnId!} AND "sessionId" = ${input.sessionId!} AND "userId" = ${input.userId}
      FOR UPDATE
    `)
    const turn = rows[0]
    if (!turn || !ACTIVE_TURN_STATUSES.includes(turn.status as (typeof ACTIVE_TURN_STATUSES)[number])) {
      throw new AgentExecutionCancelledError()
    }
    if (input.signal?.aborted) throw new AgentExecutionCancelledError()
    const current = await refreshAgentExecutionAttempt(tx, { ...input.executionAttempt!, userId: input.userId })
    if (!current || input.signal?.aborted) throw new AgentExecutionCancelledError()

    const where = {
      userId: input.userId,
      runId: input.runId,
      stage: input.stage,
      question: input.question,
      id: { startsWith: turnQuestionModePrefix(input.turnId!, input.questionProjectionMode) },
    }
    if (input.expectedQuestionId) {
      const expected = await tx.agentRunQuestion.findFirst({
        where: { id: input.expectedQuestionId, userId: input.userId, runId: input.runId },
      })
      const modePrefix = turnQuestionModePrefix(input.turnId!, input.questionProjectionMode)
      const legacyRawId = input.questionProjectionMode === "legacy"
        && !input.expectedQuestionId.startsWith("agent-question:")
      const ownsRawLegacyResume = !legacyRawId
        || (typeof turn.input === "object" && turn.input !== null && !Array.isArray(turn.input)
          && (turn.input as Record<string, unknown>).legacyResumeQuestionId === input.expectedQuestionId)
      if (expected && (input.expectedQuestionId.startsWith(modePrefix) || legacyRawId)
        && ownsRawLegacyResume
        && expected.stage === input.stage && expected.question === input.question
        && optionsCompatible(expected.options, input.options) && expected.answer !== null) return expected
      // A dispatched answer authorizes only its exact question. If the prompt,
      // options, Turn, or projection mode changed, start a fresh wait instead
      // of borrowing another historical answer with similar content.
      await tx.agentRunQuestion.deleteMany({ where: { ...where, answer: null } })
    } else {
      const existing = await tx.agentRunQuestion.findFirst({ where, orderBy: { createdAt: "desc" } })
      if (existing) {
        if (optionsCompatible(existing.options, input.options)) return existing
        await tx.agentRunQuestion.deleteMany({ where: { ...where, answer: null } })
      }
    }
    return tx.agentRunQuestion.create({
      data: {
        id: `${turnQuestionModePrefix(input.turnId!, input.questionProjectionMode)}${randomUUID()}`,
        userId: input.userId,
        runId: input.runId,
        stage: input.stage,
        question: input.question,
        options: input.options as object[],
        autonomous: false,
      },
    })
  })
}

async function findOrCreateLegacyQuestion(db: PrismaClient, input: QuestionInput): Promise<QuestionRow> {
  const where = { userId: input.userId, runId: input.runId, stage: input.stage, question: input.question }
  const existing = await db.agentRunQuestion.findFirst({ where, orderBy: { createdAt: "desc" } })
  if (input.signal?.aborted) throw new AgentExecutionCancelledError()
  if (existing) return existing
  return db.agentRunQuestion.create({ data: { ...where, options: input.options as object[], autonomous: false } })
}

/** Call inside the session/Turn-locked Stop transaction; legacy rows lack a turnId column. */
export async function cancelUnansweredTurnQuestionsInTransaction(
  tx: Prisma.TransactionClient,
  input: { userId: string; sessionId: string; turnId: string },
): Promise<void> {
  await tx.agentRunQuestion.deleteMany({
    where: {
      userId: input.userId,
      runId: input.sessionId,
      answer: null,
      id: { startsWith: turnQuestionPrefix(input.turnId) },
    },
  })
}
