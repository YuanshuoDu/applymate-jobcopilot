import { describe, expect, it, vi } from "vitest"

import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { issueNativeQuestionControlReceipt } from "./native-question-attestation.js"
import { recoverIncompleteQuestionCall } from "./turn-question-store-recovery.js"

const owner: TurnExecutionOwnerFence = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "lease-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-09-01T00:01:00Z"),
}

function recoveryFixture(resultContent: unknown) {
  const stepId = "step-1", toolCallId = "call-1"
  const callInput = { question: "Where should the search focus?", choices: [{ label: "Dublin", value: "dublin" }] }
  const completionPayload = { taskId: owner.taskId, provider: "fixture", model: "test" }
  const events = [
    { id: "model-start", sequence: "1", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null,
      type: "model.started", actor: "orchestrator", correlationId: stepId, causationId: null,
      idempotencyKey: `turn:${owner.turnId}:event:model-started:${stepId}`, payload: { taskId: owner.taskId, provider: "fixture", model: "test" } },
    { id: "model-done", sequence: "2", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null,
      type: "model.completed", actor: "orchestrator", correlationId: stepId, causationId: "model-start",
      idempotencyKey: `turn:${owner.turnId}:event:model-completed:${stepId}`, payload: completionPayload },
    { id: "model-usage", sequence: "3", sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: null,
      type: "model.usage", actor: "orchestrator", correlationId: stepId, causationId: "model-done",
      idempotencyKey: `turn:${owner.turnId}:event:model-usage:${stepId}`,
      payload: { taskId: owner.taskId, provider: "fixture", model: "test", usage: { inputTokens: 12, outputTokens: 3, estimatedCostUsd: 0.001 } } },
  ]
  const query = vi.fn(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql.trim()) || sql.includes("set_config")) return { rows: [], rowCount: 1 }
    if (sql.includes('FROM "agent_sessions" AS session')) return { rows: [{ id: owner.sessionId }], rowCount: 1 }
    if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: owner.turnId, status: "in_progress", revision: 4 }], rowCount: 1 }
    if (sql.includes('FROM "agent_items" AS callItem')) return { rows: [{
      callItemId: "call-item", stepId, callStatus: "completed", callContent: { toolCallId, toolName: "agent.ask_user", toolVersion: "1",
        status: "completed", errorCode: null, input: callInput }, stepStatus: "streaming", stepErrorCode: null, finishReason: null,
      inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, resultItemId: "result-item", resultStatus: "started", resultCount: "1", resultContent,
    }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps" WHERE')) return { rows: [{ id: stepId, status: "streaming", taskId: owner.taskId, attempt: 1,
      finishReason: null, errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }], rowCount: 1 }
    if (sql.includes('FROM "agent_events"') && sql.includes("ANY($5::text[])")) return { rows: events, rowCount: events.length }
    if (sql.includes("session.pause_requested")) return { rows: [], rowCount: 0 }
    if (sql.includes('SELECT "id" FROM "agent_items"')) return { rows: [], rowCount: 0 }
    if (sql.includes("UPDATE \"agent_steps\"")) return { rows: [], rowCount: 1 }
    throw new Error("unexpected_question_recovery_query")
  })
  const client = { query, release: vi.fn() }
  return { pool: { connect: vi.fn(async () => client) }, query, stepId, toolCallId, callInput }
}

describe("native question store recovery", () => {
  it("recovers a started redacted result only with its exact private server attestation", async () => {
    const intent = { schemaVersion: "agent-harness.v2.ask-user-intent.v1", kind: "user_question", stage: "user_input",
      question: "Where should the search focus?", options: [{ label: "Dublin", value: "dublin" }] }
    const trusted = issueNativeQuestionControlReceipt({
      identity: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, stepId: "step-1", taskId: owner.taskId, rootTaskId: owner.rootTaskId },
      actorRole: "orchestrator", capabilities: ["canManageChildren"], toolCallId: "call-1", toolName: "agent.ask_user", toolVersion: "1",
      requestInput: { question: intent.question, choices: intent.options }, effectiveInput: { question: intent.question, choices: intent.options }, toolOutput: intent,
    })!
    const resultContent = { toolCallId: "call-1", output: { question: "[REDACTED]", choices: [] }, errorCode: null,
      nativeQuestionAttestation: trusted.attestation }
    const valid = recoveryFixture(resultContent)

    await expect(recoverIncompleteQuestionCall(valid.pool as never, owner, new Date("2026-09-01T00:00:10Z")))
      .resolves.toMatchObject({ status: "replayable", stepId: valid.stepId, toolCallId: valid.toolCallId, intent })
    expect(valid.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE \"agent_steps\""))).toBe(true)

    const stale = recoveryFixture({ ...resultContent, nativeQuestionAttestation: { ...trusted.attestation, turnId: "other-turn" } })
    await expect(recoverIncompleteQuestionCall(stale.pool as never, owner, new Date("2026-09-01T00:00:10Z"))).resolves.toBeNull()
    expect(stale.query.mock.calls.some(([sql]) => String(sql).includes("UPDATE \"agent_steps\""))).toBe(false)
  })
})
