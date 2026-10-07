import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { questionId, questionItemId } from "../turns/turn-question-store-guards.js"
import { TURN_QUESTION_INTENT_SCHEMA } from "../turns/turn-question-contract.js"
import { canonicalNativeVerificationJson, type NativeVerificationEvidence } from "./native-verification-contract.js"
import { readNativeVerificationQuestionSource, type NativeVerificationQuestionIdentity } from "./native-verification-question-source.js"

type Row = Record<string, unknown>
const identity: NativeVerificationQuestionIdentity = {
  userId: "history-user", sessionId: "history-session", turnId: "history-turn", rootTaskId: "history-root",
}
const question = "Which city should I prioritize?"
const options = [{ label: "Dublin", value: "dublin" }, { label: "Cork", value: "cork" }]

function answeredSource(answer = "Cork is my preference; café & <research> 🙂"): {
  item: Row; start: Row; answered: Row; step: Row; call: Row; result: Row; evidence: NativeVerificationEvidence
} {
  const stepId = "history-step", toolCallId = "history-call"
  const waitId = questionId(identity, stepId, toolCallId), itemId = questionItemId(waitId)
  const intent = { schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input",
    question, options }
  const content = { waitKind: "question", questionId: waitId, toolCallId, stage: "user_input", question,
    options, answer, answerAvailable: true }
  const item = { id: itemId, revision: 3, sessionId: identity.sessionId, turnId: identity.turnId, stepId,
    taskId: identity.rootTaskId, type: "question", status: "completed", userId: identity.userId,
    turnUserId: identity.userId, content }
  const start = { id: "history-start", sessionId: identity.sessionId, turnId: identity.turnId,
    taskId: identity.rootTaskId, itemId, actor: "orchestrator", sequence: "11", type: "item.started",
    correlationId: itemId, causationId: waitId, idempotencyKey: `agent-wait:${itemId}:started`,
    userId: identity.userId, turnUserId: identity.userId,
    payload: { itemId, waitKind: "question", questionId: waitId, toolCallId } }
  const answered = { id: "history-answered", sessionId: identity.sessionId, turnId: identity.turnId,
    taskId: null, itemId, actor: "user", sequence: "12", type: "question.answered", correlationId: waitId,
    causationId: itemId, idempotencyKey: "agent-wait-command:history-answer:wakeup", userId: identity.userId,
    turnUserId: identity.userId,
    payload: { waitKind: "question", waitId, itemId, turnId: identity.turnId, toolCallId, status: "answered",
      nextTurnRevision: 7, answerAvailable: true } }
  const step = { id: stepId, taskId: identity.rootTaskId, status: "waiting_for_user", attempt: 1,
    finishReason: "tool_calls", errorCode: null, inputTokens: 43, outputTokens: 17, estimatedCostUsd: 0.006 }
  const callContent = { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "completed",
    errorCode: null, input: { question, choices: options } }
  const call = { id: "history-call-item", revision: 1, sessionId: identity.sessionId, turnId: identity.turnId,
    stepId, taskId: identity.rootTaskId, type: "tool_call", status: "completed", content: callContent }
  const result = { id: "history-result-item", revision: 1, sessionId: identity.sessionId, turnId: identity.turnId,
    stepId, taskId: identity.rootTaskId, type: "tool_result", status: "completed",
    content: { toolCallId, output: intent, errorCode: null } }
  return { item, start, answered, step, call, result,
    evidence: { referenceId: "", kind: "user_self_attestation", summary: canonicalNativeVerificationJson({
      kind: "user_self_attestation", stage: "user_input", question, options, answer,
    }) } }
}

function clientFor(source: ReturnType<typeof answeredSource>, options: { queryError?: Error; duplicatePair?: boolean } = {}) {
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (options.queryError && sql.includes('FROM "agent_events" AS event')) throw options.queryError
    const scoped = values?.[0] === identity.sessionId && values?.[1] === identity.turnId
      && values?.[2] === identity.userId && values?.[3] === identity.rootTaskId
    if (sql.includes('FROM "agent_items" AS item')) {
      if (!scoped) return { rows: [] }
      if (sql.includes('AS "toolCallId"')) return { rows: [{ id: source.item.id, toolCallId: (source.item.content as Row).toolCallId }] }
      if (sql.includes('item."taskId" = $4')) return { rows: [source.item] }
      return { rows: [source.item] }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes('"type" IN')) {
      return { rows: options.duplicatePair ? [source.call, source.result, source.result] : [source.call, source.result] }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_call'")) {
      if (sql.includes("= ANY($4::text[])")) return { rows: [source.call] }
      return { rows: [source.call] }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_result'")) return { rows: [source.result] }
    if (sql.includes('FROM "agent_steps"')) {
      if (sql.includes("= ANY($4::text[])")) return { rows: [{ id: source.step.id, taskId: source.step.taskId }] }
      return { rows: [source.step] }
    }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: [source.start, source.answered] }
    return { rows: [] }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

describe("native verification question source", () => {
  it("rederives one complete root answer with the whole original UTF-8 bytes", async () => {
    const source = answeredSource(), fixture = clientFor(source)
    const evidence = await readNativeVerificationQuestionSource(fixture.client, identity, 16)
    expect(evidence).toHaveLength(1)
    expect(evidence?.[0]).toMatchObject({ kind: "user_self_attestation", summary: source.evidence.summary })
    expect(evidence?.[0]?.referenceId).toMatch(/^user-self-attestation:[a-f0-9]{64}$/)
    expect(evidence?.[0]?.summary).toContain("café & <research> 🙂")
    expect(fixture.query).toHaveBeenCalled()
  })

  it("returns an empty result for a source identity outside the owned session", async () => {
    const source = answeredSource(), fixture = clientFor(source)
    await expect(readNativeVerificationQuestionSource(fixture.client, { ...identity, sessionId: "other-session" }, 16))
      .resolves.toEqual([])
  })

  it("fails closed on duplicate pairs and propagates DB errors carrying lineage-like messages", async () => {
    const source = answeredSource()
    await expect(readNativeVerificationQuestionSource(clientFor(source, { duplicatePair: true }).client, identity, 16))
      .resolves.toBeNull()

    const failures = [
      Object.assign(new Error("question_recovery_event_scope_invalid"), { code: "XX000" }),
      Object.assign(new Error("question_recovery_event_scope_invalid"), { severity: "ERROR" }),
      Object.assign(new Error("question_recovery_event_scope_invalid"), { detail: "database detail" }),
    ]
    for (const failure of failures) {
      await expect(readNativeVerificationQuestionSource(clientFor(source, { queryError: failure }).client, identity, 16))
        .rejects.toBe(failure)
    }

    const validatorError = new Error("question_recovery_event_scope_invalid")
    await expect(readNativeVerificationQuestionSource(clientFor(source, { queryError: validatorError }).client, identity, 16))
      .resolves.toBeNull()
  })
})
