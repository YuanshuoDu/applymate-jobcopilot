import { Prisma, type PrismaClient } from "@prisma/client"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, REVIEWED_APPLICATION_REVIEW_INTENT } from "@jobcopilot/agent-protocol"

import { duplicateCommandResult } from "./agent-command-service"
import { invalidCommand, isUniqueViolation, retryActiveConflict, turnNotActive } from "./errors"
import {
  acceptInputFacts,
  createRootTurn,
  findActiveTurn,
  findExistingCommand,
  lockOpenSession,
  type CommandTransaction,
} from "./transaction"
import type { CommandIdentity, CommandResult } from "./types"

const GOAL = "Review the selected job's verified materials for application fill."
const CONTENT = [{ type: "text" as const, text: "Review the verified materials for this selected job." }]
export type ReviewedApplicationReviewCommand = Readonly<{
  userId: string
  sessionId: string
  clientMessageId: string
  sourceTurnId: string
}>

type SourceTurnRow = { input: unknown; rootTaskId: unknown }

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function identity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)
}

function parseCommand(value: unknown): ReviewedApplicationReviewCommand {
  const input = record(value)
  try {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype
      || Object.keys(input).sort().join(",") !== "clientMessageId,sessionId,sourceTurnId,userId") {
      throw invalidCommand("Reviewed application review command is invalid")
    }
    const fields = ["userId", "sessionId", "clientMessageId", "sourceTurnId"] as const
    for (const field of fields) {
      const descriptor = Object.getOwnPropertyDescriptor(input, field)
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || !identity(descriptor.value)) {
        throw invalidCommand("Reviewed application review command is invalid")
      }
    }
    return {
      userId: input.userId as string,
      sessionId: input.sessionId as string,
      clientMessageId: input.clientMessageId as string,
      sourceTurnId: input.sourceTurnId as string,
    }
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error) throw error
    throw invalidCommand("Reviewed application review command is invalid")
  }
}

function selectedJobId(value: unknown): string | null {
  const input = record(value)
  const selected = record(input?.selectedJobPreparation)
  const intent = record(input?.intent)
  const validIntent = !input || !Object.hasOwn(input, "intent") || !!intent
    && Object.keys(intent).sort().join(",") === "kind,version"
    && intent.kind === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind
    && intent.version === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version
  if (!input || !validIntent || !selected
    || Object.keys(selected).sort().join(",") !== "jobId" || !identity(selected.jobId)) return null
  return selected.jobId
}

function isDuplicateReviewInput(value: unknown, command: ReviewedApplicationReviewCommand, jobId: string): boolean {
  const input = record(value)
  const intent = record(input?.intent)
  return input?.clientMessageId === command.clientMessageId
    && !Object.hasOwn(input, "selectedJobPreparation")
    && !!intent && Object.keys(intent).sort().join(",") === "jobId,kind,sourceTurnId,version"
    && intent.kind === REVIEWED_APPLICATION_REVIEW_INTENT.kind && intent.version === REVIEWED_APPLICATION_REVIEW_INTENT.version
    && intent.sourceTurnId === command.sourceTurnId && intent.jobId === jobId
}

async function duplicateReviewCommand(
  tx: CommandTransaction,
  command: ReviewedApplicationReviewCommand,
  identity: CommandIdentity,
  existing: NonNullable<Awaited<ReturnType<typeof findExistingCommand>>>,
): Promise<CommandResult> {
  if (!existing.targetTurnId) throw turnNotActive(null)
  const turn = await tx.agentTurn.findFirst({
    where: { id: existing.targetTurnId, sessionId: command.sessionId, userId: command.userId, source: "user" },
    select: { input: true },
  })
  const jobId = selectedJobIdFromReviewInput(turn?.input)
  if (!jobId || !isDuplicateReviewInput(turn?.input, command, jobId)) {
    throw invalidCommand("Client message ID is already bound to a different command")
  }
  return duplicateCommandResult(tx, identity, existing, "follow_up")
}

function selectedJobIdFromReviewInput(value: unknown): string | null {
  const input = record(value)
  const intent = record(input?.intent)
  return !input || Object.hasOwn(input, "selectedJobPreparation") || !intent
    || intent.kind !== REVIEWED_APPLICATION_REVIEW_INTENT.kind || intent.version !== REVIEWED_APPLICATION_REVIEW_INTENT.version
    || Object.keys(intent).sort().join(",") !== "jobId,kind,sourceTurnId,version" || !identity(intent.jobId)
    ? null : intent.jobId
}

async function readSelectedSource(tx: CommandTransaction, command: ReviewedApplicationReviewCommand): Promise<string> {
  const rows = await tx.$queryRaw<SourceTurnRow[]>(Prisma.sql`
    SELECT source."input", source."rootTaskId"
    FROM "agent_turns" AS source
    JOIN "agent_sessions" AS session ON session."id" = source."sessionId" AND session."userId" = source."userId"
    JOIN "sub_agent_tasks" AS root ON root."id" = source."rootTaskId"
      AND root."sessionId" = source."sessionId" AND root."turnId" = source."id"
      AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
      AND root."role" = 'orchestrator' AND root."taskType" = 'root' AND root."depth" = 0
      AND root."status" = 'completed'
    WHERE source."id" = ${command.sourceTurnId} AND source."sessionId" = ${command.sessionId}
      AND source."userId" = ${command.userId} AND session."status" NOT IN ('aborted', 'archived')
      AND source."source" = 'user' AND source."executionMode" = 'canonical_task_graph'
      AND source."status" = 'completed'
  `)
  if (rows.length !== 1) throw invalidCommand("Selected source Turn is not a completed owned selected-job review")
  const jobId = selectedJobId(rows[0]?.input)
  if (!identity(rows[0]?.rootTaskId) || !jobId) throw invalidCommand("Selected source Turn has no exact selected Job")
  const job = await tx.job.findFirst({
    where: { id: jobId, userId: command.userId, status: "saved", workflowState: { in: ["draft", "ready_to_apply"] }, appliedAt: null },
    select: { id: true },
  })
  if (!job) throw invalidCommand("Selected Job is not owned or is no longer available for application review")
  return job.id
}

async function startOnce(command: ReviewedApplicationReviewCommand, db: PrismaClient): Promise<CommandResult> {
  const identity: CommandIdentity = { sessionId: command.sessionId, userId: command.userId,
    clientMessageId: command.clientMessageId, source: "user" }
  return db.$transaction(async (tx) => {
    await lockOpenSession(tx, identity.sessionId, identity.userId)
    const existing = await findExistingCommand(tx, identity.sessionId, identity.clientMessageId)
    if (existing) return duplicateReviewCommand(tx, command, identity, existing)

    const jobId = await readSelectedSource(tx, command)
    const active = await findActiveTurn(tx, identity.sessionId, identity.userId)
    if (active) throw retryActiveConflict(active.id)

    const turn = await createRootTurn(tx, identity, CONTENT, GOAL, undefined, {
      ...REVIEWED_APPLICATION_REVIEW_INTENT, sourceTurnId: command.sourceTurnId, jobId,
    })
    const facts = await acceptInputFacts(tx, identity, CONTENT, turn, "follow_up", "started", true)
    return { ...facts, disposition: "started" }
  })
}

export class ReviewedApplicationReviewCommandService {
  constructor(private readonly db: PrismaClient) {}

  async start(value: ReviewedApplicationReviewCommand): Promise<CommandResult> {
    const command = parseCommand(value)
    try {
      return await startOnce(command, this.db)
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error
      return startOnce(command, this.db)
    }
  }
}
