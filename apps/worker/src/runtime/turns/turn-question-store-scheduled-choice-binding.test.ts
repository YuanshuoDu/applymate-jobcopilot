import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { SCHEDULED_PIPELINE_CANDIDATE_EVENT, SCHEDULED_PIPELINE_CANDIDATE_SCHEMA } from "../subagents/scheduled-pipeline-candidate-store.js"
import { loadScheduledChoiceBinding } from "./turn-question-store-scheduled-choice-binding.js"
import type { TurnQuestionQueryClient } from "./turn-question-store-guards.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
}

describe("scheduled choice binding store", () => {
  it("uses the same owner-scoped shared locks for candidate and execution readback", async () => {
    const calls: Array<{ sql: string; values?: readonly unknown[] }> = []
    const payload = { schemaVersion: SCHEDULED_PIPELINE_CANDIDATE_SCHEMA, sessionId: owner.sessionId, turnId: owner.turnId,
      rootTaskId: owner.rootTaskId, rootAttemptCount: 2, finalStepId: "step-final", finalStepOrdinal: 4, stepAttempt: 1,
      candidateText: "Exact final.", finishReason: "stop", usage: { inputTokens: 7, outputTokens: 3, estimatedCostUsd: 0.02 } }
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('FROM "agent_events" AS event JOIN "agent_sessions" AS session')) return { rows: [{ itemId: null,
        taskId: owner.rootTaskId, actor: "orchestrator", correlationId: "step-final",
        idempotencyKey: "scheduled-candidate:root-1:2:step-final", payload, stepTaskId: owner.rootTaskId, ordinal: 4, attempt: 1,
        stepStatus: "streaming", attemptCount: 2, rootStatus: "running" }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn JOIN "agent_executions" AS execution')) return { rows: [], rowCount: 0 }
      throw new Error("unexpected_scheduled_choice_query")
    }) }

    await expect(loadScheduledChoiceBinding(client as unknown as TurnQuestionQueryClient, { owner }))
      .rejects.toMatchObject({ code: "question_conflict", message: "Question persistence conflict: scheduled_execution" })

    expect(calls).toHaveLength(2)
    expect(calls[0]?.sql).toContain('event."type" = $4')
    expect(calls[0]?.sql).toContain("FOR SHARE OF event, step, root")
    expect(calls[0]?.values).toEqual([owner.sessionId, owner.turnId, owner.rootTaskId, SCHEDULED_PIPELINE_CANDIDATE_EVENT, owner.userId])
    expect(calls[1]?.sql).toContain("FOR SHARE OF execution")
    expect(calls[1]?.values).toEqual([owner.turnId, owner.sessionId, owner.userId])
  })
})
