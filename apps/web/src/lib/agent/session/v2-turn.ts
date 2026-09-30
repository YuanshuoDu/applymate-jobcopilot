import { randomUUID } from "node:crypto"

import { Prisma, PrismaClient } from "@prisma/client"
import { AgentExecutionCancelledError, refreshAgentExecutionAttempt } from "../execution-control"

export type V2TurnSource = "user" | "automation" | "system"

export interface EnsureV2TurnInput {
  sessionId: string
  userId: string
  goal: string
  source: V2TurnSource
  /** Bind a compatibility recorder to a Turn already created by the queue adapter. */
  turnId?: string
  /** Preserve the provenance of an answered question created before Turns existed. */
  legacyResumeQuestionId?: string
}

export interface V2TurnHandle {
  sessionId: string
  turnId: string
  userId: string
}

const ACTIVE_TURN_STATUSES = [
  "queued",
  "in_progress",
  "waiting_for_dependency",
  "waiting_for_approval",
  "waiting_for_user",
] as const
type TurnCreationOwner = { executionAttempt: { id: string; attemptCount: number }; signal?: AbortSignal }

export class LegacyResumeTurnMismatchError extends Error {
  constructor() {
    super("The answered legacy question is not owned by the active Turn")
    this.name = "LegacyResumeTurnMismatchError"
  }
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "P2002"
}

async function findActiveTurn(tx: Prisma.TransactionClient, input: EnsureV2TurnInput) {
  return tx.agentTurn.findFirst({
    where: { sessionId: input.sessionId, userId: input.userId, status: { in: [...ACTIVE_TURN_STATUSES] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, input: true },
  })
}

async function lockTurn(tx: Prisma.TransactionClient, input: EnsureV2TurnInput, turnId?: string) {
  return tx.$queryRaw<Array<{ id: string; status: string; input: unknown }>>(Prisma.sql`
    SELECT "id", "status", "input" FROM "agent_turns"
    WHERE "sessionId" = ${input.sessionId} AND "userId" = ${input.userId}
      AND ${turnId ? Prisma.sql`"id" = ${turnId}` : Prisma.sql`"status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')`}
    ORDER BY "createdAt" DESC
    LIMIT 1
    FOR UPDATE
  `)
}

function hasLegacyQuestionProvenance(value: unknown, questionId: string): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).legacyResumeQuestionId === questionId
}

async function assertLegacyQuestionAnswered(tx: Prisma.TransactionClient, input: EnsureV2TurnInput) {
  const questionId = input.legacyResumeQuestionId
  if (!questionId) return
  if (questionId.startsWith("agent-question:")) throw new AgentExecutionCancelledError()
  const question = await tx.agentRunQuestion.findFirst({
    where: { id: questionId, userId: input.userId, runId: input.sessionId, answer: { not: null } },
    select: { id: true },
  })
  if (!question) throw new AgentExecutionCancelledError()
}

async function assertCreationOwner(tx: Prisma.TransactionClient, input: EnsureV2TurnInput, owner: TurnCreationOwner) {
  if (owner.signal?.aborted) throw new AgentExecutionCancelledError()
  const current = await refreshAgentExecutionAttempt(tx, {
    id: owner.executionAttempt.id,
    userId: input.userId,
    attemptCount: owner.executionAttempt.attemptCount,
  })
  if (!current || owner.signal?.aborted) throw new AgentExecutionCancelledError()
}

export async function lockOpenSession(
  tx: Prisma.TransactionClient,
  input: Pick<EnsureV2TurnInput, "sessionId" | "userId">,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions"
    WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId}
      AND "status" NOT IN ('aborted', 'archived')
    FOR UPDATE
  `)
  if (!rows[0]) throw new Error(`Agent session ${input.sessionId} does not exist for this user`)
}

/** Session/Turn/Execution lock order helper for callers that also mutate the Session. */
export async function ensureV2TurnInTransaction(
  tx: Prisma.TransactionClient,
  input: EnsureV2TurnInput,
  owner?: TurnCreationOwner,
): Promise<V2TurnHandle> {
  await lockOpenSession(tx, input)
  await assertLegacyQuestionAnswered(tx, input)

  if (input.turnId) {
    const owned = owner
      ? (await lockTurn(tx, input, input.turnId))[0]
      : await tx.agentTurn.findFirst({
        where: { id: input.turnId, sessionId: input.sessionId, userId: input.userId },
        select: { id: true, input: true },
      })
    if (!owned) throw new Error(`Agent turn ${input.turnId} does not belong to this user session`)
    if (input.legacyResumeQuestionId && !hasLegacyQuestionProvenance(owned.input, input.legacyResumeQuestionId)) {
      throw new AgentExecutionCancelledError()
    }
    if (owner) await assertCreationOwner(tx, input, owner)
    return { sessionId: input.sessionId, turnId: owned.id, userId: input.userId }
  }

  const active = owner ? (await lockTurn(tx, input))[0] : await findActiveTurn(tx, input)
  if (input.legacyResumeQuestionId && active
    && !hasLegacyQuestionProvenance(active.input, input.legacyResumeQuestionId)) {
    // A later Turn must never inherit an answer accepted while this session had
    // no active Turn. The exact matching Turn is reusable on same-job retries.
    throw new LegacyResumeTurnMismatchError()
  }
  if (owner) await assertCreationOwner(tx, input, owner)
  if (active) return { sessionId: input.sessionId, turnId: active.id, userId: input.userId }

  const startedAt = new Date()
  const turn = await tx.agentTurn.create({
    data: {
      id: randomUUID(),
      sessionId: input.sessionId,
      userId: input.userId,
      status: "in_progress",
      source: input.source,
      input: {
        goal: input.goal,
        ...(input.legacyResumeQuestionId ? { legacyResumeQuestionId: input.legacyResumeQuestionId } : {}),
      },
      startedAt,
      modelProfileSnapshot: {},
      toolPolicySnapshot: {},
      budgetSnapshot: {},
    },
    select: { id: true },
  })
  if (owner?.signal?.aborted) throw new AgentExecutionCancelledError()
  return { sessionId: input.sessionId, turnId: turn.id, userId: input.userId }
}

/** Reuses the active root and creates a fresh root after terminal history. */
export async function ensureV2Turn(db: PrismaClient, input: EnsureV2TurnInput, owner?: TurnCreationOwner): Promise<V2TurnHandle> {
  try {
    return await db.$transaction(tx => ensureV2TurnInTransaction(tx, input, owner))
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return db.$transaction(async (tx) => {
      try {
        return await ensureV2TurnInTransaction(tx, input, owner)
      } catch (recoveryError) {
        if (recoveryError instanceof AgentExecutionCancelledError || !isUniqueViolation(recoveryError)) {
          throw recoveryError
        }
        throw error
      }
    })
  }
}
