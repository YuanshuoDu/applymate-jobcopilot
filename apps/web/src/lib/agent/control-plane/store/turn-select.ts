import type { Prisma } from "@prisma/client"

export const agentTurnProjectionSelect = {
  id: true,
  sessionId: true,
  userId: true,
  source: true,
  status: true,
  revision: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AgentTurnSelect

export const agentForkTurnSelect = {
  id: true,
  source: true,
  status: true,
  input: true,
  finalResponse: true,
  error: true,
  modelProfileSnapshot: true,
  inputTokens: true,
  outputTokens: true,
  estimatedCostUsd: true,
  durationMs: true,
  startedAt: true,
  completedAt: true,
} satisfies Prisma.AgentTurnSelect
