import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { Buffer } from "node:buffer"

import { questionId, questionItemId } from "../turns/turn-question-store-guards.js"
import { TURN_QUESTION_INTENT_SCHEMA } from "../turns/turn-question-contract.js"
import { canonicalNativeVerificationJson, digestNativeVerificationValue } from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { appendNativeQuestionSelfAttestations } from "./native-verification-question-evidence.js"

type Row = Record<string, unknown>
const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const scope: TaskGraphReadScope = {
  ...identity, parentTaskId: identity.rootTaskId, turnLeaseOwner: "turn-worker", turnLeaseVersion: 3,
  parentLeaseOwner: "parent-worker", parentAttemptCount: 1,
}
const questionText = "Where should the search focus?"
const options = [{ label: "Dublin", value: "dublin" }, { label: "Cork", value: "cork" }]
const clientMessageId = "answer-command-1"

function lineage(index = 1, answer = "dublin", patch: {
  item?: Row; content?: Row; start?: Row; answered?: Row; step?: Row; call?: Row; result?: Row | null; owner?: Row
} = {}) {
  const stepId = `step-${index}`, toolCallId = `call-${index}`
  const owner = {
    kind: "turn" as const, ...identity, taskId: identity.rootTaskId, parentTaskId: identity.rootTaskId,
    ownerId: "turn-worker", leaseVersion: 3, leaseExpiresAt: new Date("2026-10-06T12:01:00.000Z"),
  }
  const waitId = questionId(owner, stepId, toolCallId), itemId = questionItemId(waitId)
  const intent = { schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input",
    question: questionText, options }
  const content = { waitKind: "question", questionId: waitId, toolCallId, stage: "user_input", question: questionText,
    options, answer, answerAvailable: true }
  const itemRow: Row = {
    id: itemId, revision: 2, sessionId: identity.sessionId, turnId: identity.turnId, stepId, taskId: identity.rootTaskId,
    type: "question", status: "completed", userId: identity.userId, turnUserId: identity.userId, content, ...patch.item,
    ...(patch.content ? { content: { ...content, ...patch.content } } : {}),
  }
  const startEvent: Row = {
    id: `start-event-${index}`, sessionId: identity.sessionId, turnId: identity.turnId, taskId: identity.rootTaskId,
    itemId, actor: "orchestrator", sequence: String(index * 2 + 1), type: "item.started", correlationId: itemId,
    causationId: waitId, idempotencyKey: `agent-wait:${itemId}:started`, userId: identity.userId, turnUserId: identity.userId,
    payload: { itemId, waitKind: "question", questionId: waitId, toolCallId }, ...patch.start,
  }
  const answerEvent: Row = {
    id: `answer-event-${index}`, sessionId: identity.sessionId, turnId: identity.turnId, taskId: null,
    itemId, actor: "user", sequence: String(index * 2 + 2), type: "question.answered", correlationId: waitId,
    causationId: itemId, idempotencyKey: `agent-wait-command:${clientMessageId}:wakeup`, userId: identity.userId,
    turnUserId: identity.userId, payload: { waitKind: "question", waitId, itemId, turnId: identity.turnId,
      toolCallId, status: "answered", nextTurnRevision: 9, answerAvailable: true }, ...patch.answered,
  }
  const fullStep: Row = {
    id: stepId, taskId: identity.rootTaskId, status: "waiting_for_user", attempt: 1, finishReason: "tool_calls",
    errorCode: null, inputTokens: 31, outputTokens: 12, estimatedCostUsd: 0.004,
  }
  const callContent = { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null,
    input: { question: questionText, choices: options } }
  const callRow: Row = {
    id: `call-item-${index}`, revision: 1, sessionId: identity.sessionId, turnId: identity.turnId, stepId,
    taskId: identity.rootTaskId, type: "tool_call", status: "completed", content: callContent,
  }
  const resultRow: Row = {
    id: `result-item-${index}`, revision: 1, sessionId: identity.sessionId, turnId: identity.turnId, stepId,
    taskId: identity.rootTaskId, type: "tool_result", status: "completed", content: { toolCallId, output: intent, errorCode: null },
  }
  return {
    owner: { ...owner, ...patch.owner }, item: itemRow, start: startEvent, answered: answerEvent,
    step: { ...fullStep, ...patch.step }, call: { ...callRow, ...patch.call },
    result: patch.result === null ? null : { ...resultRow, ...patch.result },
    questionId: waitId, itemId, stepId, toolCallId, intent,
    toolItem: { id: callRow.id, stepId, taskId: identity.rootTaskId, type: "tool_call", content: { toolCallId } },
  }
}

function mockClient(rows: readonly ReturnType<typeof lineage>[], options: {
  unrelatedCalls?: number; unrelatedSteps?: number; linkedCallOverflow?: boolean; queryError?: Error; ownerLive?: boolean
  currentOwnerId?: string; currentLeaseVersion?: number; currentLeaseExpiresAt?: Date
} = {}) {
  const calls = rows.map(row => row.call), results = rows.map(row => row.result).filter((row): row is Row => row !== null), steps = rows.map(row => row.step)
  const questions = rows.map(row => row.item)
  const events = rows.flatMap(row => [row.start, row.answered])
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (options.queryError) throw options.queryError
    if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('"leaseOwnerId"')) {
      const leaseExpiresAt = options.currentLeaseExpiresAt ?? new Date("2026-10-06T12:01:00.000Z")
      return { rows: [{ leaseOwnerId: options.currentOwnerId ?? scope.turnLeaseOwner,
        leaseVersion: options.currentLeaseVersion ?? scope.turnLeaseVersion, leaseExpiresAt,
        createdAt: new Date("2026-10-06T11:59:00.000Z"), leaseLive: options.ownerLive !== false
          && leaseExpiresAt.getTime() > new Date("2026-10-06T12:00:00.000Z").getTime() }] }
    }
    if (sql.includes('FROM "agent_steps"') && sql.includes('= ANY($4::text[])')) {
      return { rows: steps.filter(row => Array.isArray(values?.[3]) && values[3].includes(row.id)) }
    }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ORDER BY')) {
      return { rows: Array.from({ length: options.unrelatedSteps ?? 0 }, (_, index) => ({
        id: `unrelated-step-${index}`, taskId: identity.rootTaskId,
      })) }
    }
    if (sql.includes('FROM "agent_items" AS item')) {
      if (sql.includes('AS "toolCallId"')) return { rows: questions.filter(row => row.taskId === identity.rootTaskId)
        .map(row => ({ id: row.id, toolCallId: (row.content as Row).toolCallId })) }
      if (sql.includes('item."taskId" = $4')) return { rows: questions.filter(row => row.taskId === identity.rootTaskId) }
      return { rows: questions }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes('"type" IN')) return { rows: [...calls, ...results] }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_call'")) {
      if (sql.includes('= ANY($4::text[])')) {
        if (options.linkedCallOverflow) return { rows: Array.from({ length: 65 }, (_, index) => ({
          id: `linked-call-${index}`, stepId: `step-${index}`, taskId: identity.rootTaskId, type: "tool_call",
          content: { toolCallId: `call-${index}` },
        })) }
        const callIds = Array.isArray(values?.[3]) ? values[3] : []
        return { rows: calls.filter(row => callIds.includes((row.content as Row).toolCallId)) }
      }
      if (values?.length === 4) return { rows: Array.from({ length: options.unrelatedCalls ?? 0 }, (_, index) => ({
        id: `unrelated-call-${index}`, stepId: `unrelated-step-${index}`, taskId: identity.rootTaskId,
        type: "tool_call", content: { toolCallId: `unrelated-id-${index}` },
      })) }
      return { rows: calls.filter(row => row.stepId === values?.[2] && (row.content as Row).toolCallId === values?.[4]) }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_result'")) {
      return { rows: results.filter(row => row.stepId === values?.[2] && (row.content as Row).toolCallId === values?.[4]) }
    }
    if (sql.includes('FROM "agent_steps"')) return { rows: steps.filter(row => row.id === values?.[0]) }
    if (sql.includes('FROM "agent_events" AS event')) return { rows: events }
    if (sql.includes('FROM "agent_events"')) return { rows: [] }
    return { rows: [] }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

function packet(evidence: NativeVerificationPacketContent["evidence"] = []): NativeVerificationPacketContent {
  return { goal: "Meet the user's request", criteria: [{ criterionId: "criterion-1", requirement: "Use the answer" }],
    target: { kind: "root_goal", candidateDigest: "a".repeat(64), referenceId: "candidate-1", candidateText: "A response" }, evidence }
}

describe("native question self-attestation evidence", () => {
  it("adds only the complete server-bound root answer and preserves the original bytes as a non-authoritative reference", async () => {
    const source = lineage()
    const f = mockClient([source])
    const content = packet([{ referenceId: "target-fact", kind: "artifact", summary: "Owned candidate" }])
    const first = await appendNativeQuestionSelfAttestations(f.client, scope, content)
    const repeated = await appendNativeQuestionSelfAttestations(mockClient([source]).client, scope, content)
    expect(first).toEqual(repeated)
    expect(first?.evidence).toHaveLength(2)
    expect(first?.evidence[0]).toEqual(content.evidence[0])
    const added = first?.evidence[1]
    expect(added?.referenceId).toMatch(/^user-self-attestation:[a-f0-9]{64}$/)
    expect(added?.kind).toBe("user_self_attestation")
    expect(added?.summary).toBe(canonicalNativeVerificationJson({ kind: "user_self_attestation", stage: "user_input",
      question: questionText, options, answer: "dublin" }))
    expect(JSON.parse(added!.summary)).toEqual({ kind: "user_self_attestation", stage: "user_input",
      question: questionText, options, answer: "dublin" })
    expect(added?.referenceId).toBe(`user-self-attestation:${digestNativeVerificationValue({
      owner: { userId: identity.userId, sessionId: identity.sessionId, turnId: identity.turnId, taskId: identity.rootTaskId },
      item: { id: source.item.id, revision: source.item.revision, status: source.item.status, content: source.item.content },
      step: source.step, startedEvent: source.start, answeredEvent: source.answered, call: source.call, result: source.result,
    })}`)
  })

  it("returns unchanged content when no eligible answer exists and rejects child or foreign-root projections", async () => {
    const content = packet()
    const none = await appendNativeQuestionSelfAttestations(mockClient([]).client, scope, content)
    expect(none).toEqual(content)
    const empty = mockClient([])
    expect(await appendNativeQuestionSelfAttestations(empty.client, { ...scope, parentTaskId: "other-root" }, content)).toBeNull()
    expect(empty.query).not.toHaveBeenCalled()
    const child = packet()
    const childContent = { ...child, target: { ...child.target, kind: "child" as const, taskId: "child-1", attempt: 1,
      resultDigest: "b".repeat(64), referenceId: "result-1", resultText: "{}" } }
    expect(await appendNativeQuestionSelfAttestations(mockClient([]).client, scope, childContent)).toBeNull()
  })

  it("does not let unrelated root tool calls consume the bound for an answer-free packet", async () => {
    const content = packet()
    const f = mockClient([], { unrelatedCalls: 65, unrelatedSteps: 65 })
    expect(await appendNativeQuestionSelfAttestations(f.client, scope, content)).toEqual(content)
    expect(f.query.mock.calls.some(([sql]) => sql.includes("FROM \"agent_items\"") && sql.includes("'tool_call'")
      && !sql.includes("ask_call") && !sql.includes("= ANY"))).toBe(false)
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_steps"') && !sql.includes("= ANY") && !sql.includes('FOR SHARE'))).toBe(false)
  })

  it("keeps the current live-owner fence and propagates unexpected query failures", async () => {
    const source = lineage()
    expect(await appendNativeQuestionSelfAttestations(mockClient([source], { ownerLive: false }).client, scope, packet())).toBeNull()
    expect(await appendNativeQuestionSelfAttestations(mockClient([source], { currentOwnerId: "other-worker" }).client, scope, packet())).toBeNull()
    expect(await appendNativeQuestionSelfAttestations(mockClient([source], { currentLeaseVersion: scope.turnLeaseVersion - 1 }).client, scope, packet())).toBeNull()
    expect(await appendNativeQuestionSelfAttestations(mockClient([source], { currentLeaseExpiresAt: new Date("2020-01-01T00:00:00Z") }).client, scope, packet())).toBeNull()

    const failure = Object.assign(new Error("database unavailable"), { code: "XX000" })
    await expect(appendNativeQuestionSelfAttestations(mockClient([source], { queryError: failure }).client, scope, packet()))
      .rejects.toBe(failure)
  })

  it("fails closed when linked tool-call rows exceed the bounded lineage scan", async () => {
    const f = mockClient([lineage()], { linkedCallOverflow: true })
    expect(await appendNativeQuestionSelfAttestations(f.client, scope, packet())).toBeNull()
  })

  it("does not project child or broker-scoped questions as root self-attestation", async () => {
    for (const taskId of ["child-task", null]) {
      const content = packet()
      expect(await appendNativeQuestionSelfAttestations(mockClient([lineage(1, "dublin", { item: { taskId } })]).client,
        scope, content)).toEqual(content)
    }
  })

  it.each([
    ["foreign question user", { item: { userId: "other-user" } }],
    ["foreign joined Turn owner", { item: { turnUserId: "other-user" } }],
    ["foreign session", { item: { sessionId: "other-session" } }],
    ["foreign Turn", { item: { turnId: "other-turn" } }],
    ["malformed question fields", { content: { answerAvailable: false } }],
    ["extra question authority field", { content: { approved: true } }],
    ["malformed answer event payload", { answered: { payload: { ...lineage().answered.payload as Row, extra: true } } }],
    ["foreign answer actor", { answered: { actor: "system" } }],
    ["foreign answer task", { answered: { taskId: "other-root" } }],
    ["wrong answer sequence", { answered: { sequence: "3" } }],
    ["wrong start idempotency key", { start: { idempotencyKey: "foreign-start" } }],
    ["wrong step attempt", { step: { attempt: 2 } }],
    ["step not waiting for user", { step: { status: "completed" } }],
    ["step without durable usage", { step: { finishReason: null } }],
    ["uncompleted tool call", { call: { status: "started" } }],
    ["malformed original call arguments", { call: { content: { ...lineage().call.content as Row, input: { question: " " } } } }],
    ["result intent differs from original arguments", { result: { content: { ...lineage().result!.content as Row,
      output: { ...lineage().intent, question: "Different question" } } } }],
    ["item question differs from original call", { content: { question: "Different question" } }],
    ["oversized answer", { content: { answer: "x".repeat(20_001) } }],
    ["invalid item revision", { item: { revision: "not-a-revision" } }],
    ["missing paired result", { result: null }],
  ])("omits %s instead of producing native evidence", async (_label, patch) => {
    const source = lineage(1, "dublin", patch)
    const result = await appendNativeQuestionSelfAttestations(mockClient([source]).client, scope, packet())
    expect(result).toBeNull()
  })

  it("rejects duplicate question identity, overfull evidence, scan overflow, and canonical packet overflow", async () => {
    const source = lineage()
    const duplicate = { ...source, item: { ...source.item, id: `${source.itemId}-duplicate` } }
    expect(await appendNativeQuestionSelfAttestations(mockClient([source, duplicate]).client, scope, packet())).toBeNull()
    const fullEvidence = Array.from({ length: 32 }, (_, index) => ({ referenceId: `prior-${index}`, kind: "artifact", summary: "fact" }))
    expect(await appendNativeQuestionSelfAttestations(mockClient([source]).client, scope, packet(fullEvidence))).toBeNull()
    expect(await appendNativeQuestionSelfAttestations(mockClient([lineage()], { linkedCallOverflow: true }).client, scope, packet())).toBeNull()

    const largeRows = [lineage(1, "\0".repeat(20_000)), lineage(2, "\0".repeat(20_000)), lineage(3, "\0".repeat(20_000))]
    expect(await appendNativeQuestionSelfAttestations(mockClient(largeRows).client, scope, packet())).toBeNull()
  })

  it("preserves the full 20,000-character answer while keeping the resulting packet within its byte cap", async () => {
    const answer = "🙂".repeat(10_000)
    const source = lineage(1, answer)
    const result = await appendNativeQuestionSelfAttestations(mockClient([source]).client, scope, packet())
    expect(result?.evidence).toHaveLength(1)
    expect(JSON.parse(result!.evidence[0]!.summary).answer).toBe(answer)
    expect(Buffer.byteLength(canonicalNativeVerificationJson(result), "utf8")).toBeLessThanOrEqual(256 * 1024)
  })
})
