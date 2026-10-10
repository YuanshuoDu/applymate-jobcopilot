import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import { AgentForkService } from "./agent-fork-service"
import { agentForkTurnSelect } from "../store/turn-select"

describe("AgentForkService Turn projection", () => {
  it("loads only the historical Turn fields copied into a fork", async () => {
    const completedAt = new Date("2026-10-01T00:00:00.000Z")
    const source = {
      id: "source-session", userId: "owner", goal: "Goal", source: "user", memorySummary: null,
      turns: [{ id: "turn-1", source: "user", status: "completed", input: { goal: "Goal" }, finalResponse: "Done",
        error: null, modelProfileSnapshot: {}, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0,
        durationMs: 10, startedAt: completedAt, completedAt, createdAt: completedAt }],
      items: [], events: [], contextSnapshots: [],
    }
    const findFirst = vi.fn(async (args: { where: { id: string } }) => args.where.id === source.id ? source : null)
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: source.id }]),
      agentSession: { findFirst, create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      agentTurn: { createMany: vi.fn(async () => ({ count: 1 })) },
      agentItem: { createMany: vi.fn(async () => ({ count: 0 })) },
    }
    const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient

    const result = await new AgentForkService(db).fork({
      sessionId: source.id, userId: source.userId, clientMessageId: "fork-request", source: "user", lastTurnId: "turn-1",
    })

    expect(result.disposition).toBe("forked")
    const sourceRead = findFirst.mock.calls[1]?.[0] as unknown as { select: { turns: { select: unknown } } }
    expect(sourceRead.select.turns.select).toEqual(agentForkTurnSelect)
    expect(Object.keys(agentForkTurnSelect)).not.toContain("nativeSemanticProgressMode")
  })
})
