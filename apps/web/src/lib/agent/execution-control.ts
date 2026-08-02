import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import type { PipelineCheckpointState } from "@/lib/agent/types"

export const EXECUTION_STATUSES = ["queued", "running", "waiting_for_user", "paused", "completed", "failed", "cancelled"] as const
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]
const EXECUTION_STALE_MS = Number(process.env.AGENT_EXECUTION_STALE_MS ?? 15_000)

export type { PipelineCheckpointState } from "@/lib/agent/types"

/** Raised in the runner when the control plane revoked an in-flight run. */
export class AgentExecutionCancelledError extends Error {
  constructor() {
    super("Agent execution was cancelled")
    this.name = "AgentExecutionCancelledError"
  }
}

export async function ensureAgentExecution(input: { userId: string; sessionId: string; autonomous?: boolean }) {
  return db.agentExecution.upsert({
    where: { sessionId: input.sessionId },
    create: { userId: input.userId, sessionId: input.sessionId, status: "queued", checkpoint: "scout", state: { nextStage: "scout", startedAt: new Date().toISOString(), autonomous: input.autonomous ?? false } },
    update: {},
  })
}

/** Atomically claims an execution. A duplicate worker or cancelled job cannot run. */
export async function claimAgentExecution(input: { id: string; userId: string }) {
  // BullMQ reclaims a worker's stalled lock after a short delay. A checkpoint
  // heartbeat may be older than that while an LLM call is active, but a second
  // delivery is only possible after the original worker lost its lock.
  const staleBefore = new Date(Date.now() - EXECUTION_STALE_MS)
  const result = await db.agentExecution.updateMany({
    where: {
      id: input.id,
      userId: input.userId,
      OR: [
        { status: { in: ["queued", "paused"] } },
        { status: "running", updatedAt: { lt: staleBefore } },
      ],
    },
    data: { status: "running", error: null, startedAt: new Date(), attemptCount: { increment: 1 } },
  })
  return result.count === 1
}

export async function saveExecutionCheckpoint(input: {
  id: string
  userId: string
  state: PipelineCheckpointState
}) {
  const result = await db.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: "running" },
    data: { checkpoint: input.state.nextStage, state: input.state as unknown as Prisma.InputJsonValue },
  })
  return result.count === 1
}

export async function finishAgentExecution(input: { id: string; userId: string; status: "completed" | "failed" | "waiting_for_user" | "cancelled"; error?: string | null }) {
  const result = await db.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: { not: "cancelled" } },
    data: {
      status: input.status,
      error: input.error ?? null,
      completedAt: input.status === "completed" || input.status === "failed" || input.status === "cancelled" ? new Date() : null,
    },
  })
  return result.count === 1
}

export async function cancelAgentExecution(input: { id: string; userId: string }) {
  const result = await db.agentExecution.updateMany({
    where: { id: input.id, userId: input.userId, status: { notIn: ["completed", "failed", "cancelled"] } },
    data: { status: "cancelled", checkpoint: "cancelled", cancelledAt: new Date(), completedAt: new Date() },
  })
  return result.count === 1
}
