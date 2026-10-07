import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { Buffer } from "node:buffer"

import { questionId, questionItemId } from "../turns/turn-question-store-guards.js"
import { TURN_QUESTION_INTENT_SCHEMA } from "../turns/turn-question-contract.js"
import { canonicalNativeVerificationJson, type NativeVerificationEvidence } from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import { appendNativePriorQuestionSelfAttestations } from "./native-verification-prior-question-evidence.js"
import type { NativeVerificationLiveQuestionTurn, NativeVerificationQuestionIdentity } from "./native-verification-question-source.js"

type Row = Record<string, unknown>
const userId = "history-user", sessionId = "history-session"
const now = new Date("2026-10-07T12:00:00.000Z")
const currentIdentity: NativeVerificationQuestionIdentity = { userId, sessionId, turnId: "current-turn", rootTaskId: "current-root" }
const current: NativeVerificationLiveQuestionTurn = {
  identity: currentIdentity,
  owner: { kind: "turn", ...currentIdentity, taskId: currentIdentity.rootTaskId,
    ownerId: "current-worker", leaseVersion: 4, leaseExpiresAt: new Date("2026-10-07T12:05:00.000Z") },
  createdAt: now,
}
const question = "Which city should I prioritize?"
const choices = [{ label: "Dublin", value: "dublin" }, { label: "Cork", value: "cork" }]

type Turn = {
  id: string; userId: string; sessionId: string; createdAt: Date; status: string; completedAt: Date | null
  leaseOwnerId: string | null; leaseStartedAt: Date | null; leaseExpiresAt: Date | null
  rootTaskId: string; parentTaskId: string | null
}
type Source = { identity: NativeVerificationQuestionIdentity; item: Row; start: Row; answered: Row; step: Row; call: Row; result: Row; evidence: NativeVerificationEvidence }

function priorTurn(index: number, patch: Partial<Turn> = {}): Turn {
  const id = `prior-turn-${index}`
  return { id, userId, sessionId, createdAt: new Date(now.getTime() - index * 60_000), status: "completed",
    completedAt: new Date(now.getTime() - index * 60_000 + 30_000), leaseOwnerId: null, leaseStartedAt: null,
    leaseExpiresAt: null, rootTaskId: id, parentTaskId: null, ...patch }
}

function sourceFor(turn: Turn, index: number, answer = `Answer ${turn.id}-${index}`): Source {
  const identity: NativeVerificationQuestionIdentity = { userId: turn.userId, sessionId: turn.sessionId,
    turnId: turn.id, rootTaskId: turn.rootTaskId }
  const stepId = `${turn.id}-step-${index}`, toolCallId = `${turn.id}-call-${index}`
  const waitId = questionId(identity, stepId, toolCallId), itemId = questionItemId(waitId)
  const intent = { schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input",
    question, options: choices }
  const content = { waitKind: "question", questionId: waitId, toolCallId, stage: "user_input", question,
    options: choices, answer, answerAvailable: true }
  const item = { id: itemId, revision: 2, sessionId, turnId: turn.id, stepId, taskId: turn.rootTaskId,
    type: "question", status: "completed", userId, turnUserId: userId,
    createdAt: new Date(turn.createdAt.getTime() + index), content }
  const start = { id: `${turn.id}-start-${index}`, sessionId, turnId: turn.id, taskId: turn.rootTaskId, itemId,
    actor: "orchestrator", sequence: String(index * 2 + 1), type: "item.started", correlationId: itemId,
    causationId: waitId, idempotencyKey: `agent-wait:${itemId}:started`, userId, turnUserId: userId,
    payload: { itemId, waitKind: "question", questionId: waitId, toolCallId } }
  const answered = { id: `${turn.id}-answered-${index}`, sessionId, turnId: turn.id, taskId: null, itemId,
    actor: "user", sequence: String(index * 2 + 2), type: "question.answered", correlationId: waitId,
    causationId: itemId, idempotencyKey: `answer:${turn.id}:${index}`, userId, turnUserId: userId,
    payload: { waitKind: "question", waitId, itemId, turnId: turn.id, toolCallId,
      status: "answered", nextTurnRevision: index + 2, answerAvailable: true } }
  const step = { id: stepId, taskId: turn.rootTaskId, status: "waiting_for_user", attempt: 1,
    finishReason: "tool_calls", errorCode: null, inputTokens: 17, outputTokens: 8, estimatedCostUsd: 0.001 }
  const call = { id: `${turn.id}-call-item-${index}`, revision: 1, sessionId, turnId: turn.id, stepId,
    taskId: turn.rootTaskId, type: "tool_call", status: "completed",
    content: { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null,
      input: { question, choices } } }
  const result = { id: `${turn.id}-result-item-${index}`, revision: 1, sessionId, turnId: turn.id, stepId,
    taskId: turn.rootTaskId, type: "tool_result", status: "completed",
    content: { toolCallId, output: intent, errorCode: null } }
  const evidence: NativeVerificationEvidence = { referenceId: `user-self-attestation:${"a".repeat(64)}`,
    kind: "user_self_attestation", summary: canonicalNativeVerificationJson({ kind: "user_self_attestation",
      stage: "user_input", question, options: choices, answer }) }
  return { identity, item, start, answered, step, call, result, evidence }
}

function currentPacket(evidence: NativeVerificationEvidence[] = []): NativeVerificationPacketContent {
  return { goal: "Use the current user objective", criteria: [{ criterionId: "criterion-1", requirement: "Use current facts" }],
    target: { kind: "root_goal", candidateDigest: "a".repeat(64), referenceId: "current-candidate",
      candidateText: "Current candidate" }, evidence }
}

function mockClient(turns: readonly Turn[], sources: readonly Source[], options: {
  turnQueryError?: Error; sourceEventError?: Error; sourceEventErrorTurnId?: string
} = {}) {
  const matchingSources = (values?: readonly unknown[]) => sources.filter(source => values?.includes(source.identity.sessionId)
    && values.includes(source.identity.turnId) && values.includes(source.identity.rootTaskId))
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (options.turnQueryError && sql.includes('JOIN "sub_agent_tasks" AS root')) throw options.turnQueryError
    if (sql.includes('FROM "agent_turns" AS turn') && sql.includes('JOIN "sub_agent_tasks" AS root')) {
      const [requestedSession, requestedUser, currentTurnId, currentCreatedAt, windowLimit, sourceLimit] = values ?? []
      const window = turns.filter(turn => turn.userId === requestedUser && turn.sessionId === requestedSession
        && turn.id !== currentTurnId && currentCreatedAt instanceof Date && turn.createdAt < currentCreatedAt
        && turn.status === "completed" && turn.completedAt instanceof Date && turn.leaseOwnerId === null
        && turn.leaseStartedAt === null && turn.leaseExpiresAt === null && turn.rootTaskId === turn.id && turn.parentTaskId === null)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
        .slice(0, Number(windowLimit))
      const candidateIds = new Set(sources.filter(source => source.identity.userId === requestedUser
        && source.identity.sessionId === requestedSession && source.item.status === "completed"
        && (source.item.content as Row).stage === "user_input" && (source.item.content as Row).answerAvailable === true
        && (source.call.content as Row).toolName === "agent.ask_user" && (source.call.content as Row).toolVersion === "1"
        && (source.call.content as Row).status === "completed" && (source.call.content as Row).errorCode === null)
        .map(source => source.identity.turnId))
      const candidates = window.filter(turn => candidateIds.has(turn.id)).slice(0, Number(sourceLimit))
      return { rows: candidates.map(({ id, createdAt, rootTaskId }) => ({ id, createdAt, rootTaskId })) }
    }
    if (sql.includes('FROM "agent_items" AS item')) {
      const matched = matchingSources(values).filter(source => source.item.taskId === source.identity.rootTaskId)
        .sort((left, right) => (left.item.createdAt as Date).getTime() - (right.item.createdAt as Date).getTime())
      if (sql.includes('AS "toolCallId"')) return { rows: matched.map(source => ({
        id: source.item.id, toolCallId: (source.item.content as Row).toolCallId,
      })).slice(0, Number(values?.[4])) }
      return { rows: matched.map(source => source.item) }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes('"type" IN')) {
      const matched = matchingSources(values).filter(source => source.call.stepId === values?.[2]
        && (source.call.content as Row).toolCallId === values?.[4])
      return { rows: matched.flatMap(source => [source.call, source.result]) }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_call'")) {
      const matched = matchingSources(values)
      if (sql.includes('= ANY($4::text[])')) return { rows: matched.map(source => source.call).slice(0, Number(values?.[4])) }
      return { rows: matched.map(source => source.call).filter(row => row.stepId === values?.[2]
        && (row.content as Row).toolCallId === values?.[4]) }
    }
    if (sql.includes('FROM "agent_items"') && sql.includes("'tool_result'")) {
      return { rows: matchingSources(values).map(source => source.result).filter(row => row.stepId === values?.[2]
        && (row.content as Row).toolCallId === values?.[4]) }
    }
    if (sql.includes('FROM "agent_steps"')) {
      const matched = matchingSources(values)
      if (sql.includes('= ANY($4::text[])')) return { rows: matched.map(source => ({ id: source.step.id, taskId: source.step.taskId })) }
      return { rows: matched.map(source => source.step).filter(row => row.id === values?.[0]) }
    }
    if (sql.includes('FROM "agent_events" AS event')) {
      if (options.sourceEventError && values?.[1] === options.sourceEventErrorTurnId) throw options.sourceEventError
      return { rows: matchingSources(values).flatMap(source => [source.start, source.answered]) }
    }
    if (sql.includes('FROM "agent_events"')) return { rows: [] }
    return { rows: [] }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

function attestedAnswers(content: NativeVerificationPacketContent): string[] {
  return content.evidence.filter(item => item.kind === "user_self_attestation")
    .map(item => JSON.parse(item.summary) as { answer: string }).map(item => item.answer)
}

describe("native prior question evidence", () => {
  it("appends the complete prior answer after protected current evidence without changing the current objective", async () => {
    const turn = priorTurn(1), source = sourceFor(turn, 1, "Cork is my preference; café & <research> 🙂")
    const content = currentPacket([{ referenceId: "current-fact", kind: "tool_result", summary: "Owned fact" }])
    const result = await appendNativePriorQuestionSelfAttestations(mockClient([turn], [source]).client, current, content)
    expect(result?.goal).toBe(content.goal)
    expect(result?.criteria).toEqual(content.criteria)
    expect(result?.evidence[0]).toEqual(content.evidence[0])
    expect(result?.evidence[1]).toMatchObject({ kind: "user_self_attestation", summary: canonicalNativeVerificationJson({
      kind: "user_self_attestation", stage: "user_input", question, options: choices, answer: "Cork is my preference; café & <research> 🙂",
    }) })
    expect(result?.evidence[1]?.referenceId).toMatch(/^user-self-attestation:[a-f0-9]{64}$/)
    expect(attestedAnswers(result!)).toEqual(["Cork is my preference; café & <research> 🙂"])
  })

  it("uses only strictly earlier completed lease-cleared same-owner self-root Turns", async () => {
    const valid = priorTurn(1)
    const foreign = priorTurn(2, { userId: "other-user" })
    const otherSession = priorTurn(3, { sessionId: "other-session" })
    const future = priorTurn(4, { createdAt: new Date(now.getTime() + 1) })
    const active = priorTurn(5, { status: "in_progress", completedAt: null })
    const leased = priorTurn(6, { leaseOwnerId: "old-worker", leaseStartedAt: new Date(now.getTime() - 60_000), leaseExpiresAt: new Date(now.getTime() - 1) })
    const childRoot = priorTurn(7, { rootTaskId: "not-self-root", parentTaskId: "parent" })
    const sources = [sourceFor(valid, 1), sourceFor(foreign, 1), sourceFor(otherSession, 1), sourceFor(future, 1),
      sourceFor(active, 1), sourceFor(leased, 1), sourceFor(childRoot, 1)]
    const f = mockClient([valid, foreign, otherSession, future, active, leased, childRoot], sources)
    const result = await appendNativePriorQuestionSelfAttestations(f.client, current, currentPacket())
    expect(attestedAnswers(result!)).toEqual(["Answer prior-turn-1-1"])
    const enumeration = f.query.mock.calls.find(([sql]) => sql.includes('JOIN "sub_agent_tasks" AS root'))?.[0]
    expect(enumeration).toContain('turn."createdAt" < $4')
    expect(enumeration).toContain('turn."status" = \'completed\'')
    expect(enumeration).toContain('turn."completedAt" IS NOT NULL')
    expect(enumeration).toContain('turn."leaseOwnerId" IS NULL')
    expect(enumeration).toContain('turn."leaseStartedAt" IS NULL')
    expect(enumeration).toContain('turn."leaseExpiresAt" IS NULL')
    expect(enumeration).toContain('root."rootTaskId" = root."id"')
    expect(enumeration).toContain('root."parentTaskId" IS NULL')
  })

  it("omits a malformed recent source whole and still selects an older valid source", async () => {
    const newest = priorTurn(1), older = priorTurn(2)
    const malformed = sourceFor(newest, 1)
    const valid = sourceFor(older, 1)
    const validatorError = new Error("question_recovery_event_scope_invalid")
    const result = await appendNativePriorQuestionSelfAttestations(mockClient([newest, older], [malformed, valid], {
      sourceEventError: validatorError, sourceEventErrorTurnId: newest.id,
    }).client, current, currentPacket())
    expect(attestedAnswers(result!)).toEqual(["Answer prior-turn-2-1"])

    const failure = Object.assign(new Error("question_recovery_event_scan_failed"), { code: "XX000" })
    for (const metadata of [{ code: "XX000" }, { severity: "ERROR" }, { detail: "database detail" }]) {
      const databaseFailure = Object.assign(new Error("question_recovery_event_scope_invalid"), metadata)
      await expect(appendNativePriorQuestionSelfAttestations(mockClient([older], [valid], {
        sourceEventError: databaseFailure, sourceEventErrorTurnId: older.id,
      }).client, current, currentPacket())).rejects.toBe(databaseFailure)
    }
    await expect(appendNativePriorQuestionSelfAttestations(mockClient([older], [valid], { turnQueryError: failure }).client,
      current, currentPacket())).rejects.toBe(failure)
  })

  it("caps each source at 16 complete questions and never retains a partial overflowing source", async () => {
    const newest = priorTurn(1), older = priorTurn(2)
    const overflow = Array.from({ length: 17 }, (_, index) => sourceFor(newest, index + 1))
    const valid = sourceFor(older, 1)
    const result = await appendNativePriorQuestionSelfAttestations(mockClient([newest, older], [...overflow, valid]).client,
      current, currentPacket())
    expect(attestedAnswers(result!)).toEqual(["Answer prior-turn-2-1"])
  })

  it("prefers the newest sources, caps at eight roots and sixteen whole pairs, and preserves current evidence first", async () => {
    const turns = Array.from({ length: 9 }, (_, index) => priorTurn(index + 1))
    const sources = turns.flatMap(turn => [sourceFor(turn, 1), sourceFor(turn, 2)])
    const currentEvidence = Array.from({ length: 31 }, (_, index) => ({ referenceId: `current-${index}`, kind: "artifact", summary: "protected" }))
    const f = mockClient(turns, sources)
    const result = await appendNativePriorQuestionSelfAttestations(f.client, current, currentPacket(currentEvidence))
    expect(result?.evidence.slice(0, currentEvidence.length)).toEqual(currentEvidence)
    expect(result?.evidence).toHaveLength(32)
    expect(attestedAnswers(result!)).toHaveLength(1)
    expect(attestedAnswers(result!)[0]).toBe("Answer prior-turn-1-2")

    const rootBound = await appendNativePriorQuestionSelfAttestations(mockClient(turns, turns.map(turn => sourceFor(turn, 1))).client,
      current, currentPacket())
    expect(attestedAnswers(rootBound!)).toEqual(turns.slice(0, 8).map(turn => `Answer ${turn.id}-1`))

    const pairBound = await appendNativePriorQuestionSelfAttestations(mockClient(turns, sources).client, current, currentPacket())
    expect(attestedAnswers(pairBound!)).toHaveLength(16)
  })

  it("bounds the 64-Turn scan and skips whole pairs that exceed UTF-8 or aggregate packet limits", async () => {
    const turns = Array.from({ length: 65 }, (_, index) => priorTurn(index + 1))
    const oldest = turns[64]!
    const f = mockClient(turns, [sourceFor(oldest, 1)])
    const unchanged = await appendNativePriorQuestionSelfAttestations(f.client, current, currentPacket())
    expect(unchanged).toEqual(currentPacket())
    const turnScan = f.query.mock.calls.find(([sql]) => sql.includes('JOIN "sub_agent_tasks" AS root'))
    expect(turnScan?.[1]?.[4]).toBe(64)
    expect(turnScan?.[1]?.[5]).toBe(8)

    const largeTurn = priorTurn(1)
    const large = [sourceFor(largeTurn, 1, "🙂".repeat(10_000)), sourceFor(largeTurn, 2, "🙂".repeat(10_000))]
    const byteBound = await appendNativePriorQuestionSelfAttestations(mockClient([largeTurn], large).client, current, currentPacket())
    expect(attestedAnswers(byteBound!)).toEqual(["🙂".repeat(10_000)])
    expect(Buffer.byteLength(canonicalNativeVerificationJson(byteBound), "utf8")).toBeLessThanOrEqual(256 * 1024)

    const packetTurn = priorTurn(2), packetSource = sourceFor(packetTurn, 1, "x".repeat(8_000))
    const nearLimit = currentPacket(Array.from({ length: 31 }, (_, index) => ({ referenceId: `fact-${index}`,
      kind: "artifact", summary: "y".repeat(8_150) })))
    expect(Buffer.byteLength(canonicalNativeVerificationJson(nearLimit), "utf8")).toBeLessThanOrEqual(256 * 1024)
    expect(Buffer.byteLength(JSON.stringify({ ...nearLimit, evidence: [...nearLimit.evidence,
      { ...packetSource.evidence, referenceId: "probe" }] }), "utf8")).toBeGreaterThan(256 * 1024)
    const packetBound = await appendNativePriorQuestionSelfAttestations(mockClient([packetTurn], [packetSource]).client,
      current, nearLimit)
    expect(packetBound).toEqual(nearLimit)
    expect(packetBound?.evidence).toHaveLength(31)
  })

  it("does not read beyond eight root candidates and checks oversized full packets before the entry-count fast path", async () => {
    const turns = Array.from({ length: 65 }, (_, index) => priorTurn(index + 1))
    const invalidRecent = turns.slice(0, 8).map((turn, index) => {
      const source = sourceFor(turn, index + 1)
      source.result = { ...source.result, content: { ...(source.result.content as Row),
        output: { ...(source.result.content as Row).output as Row, question: "not the original question" } } }
      return source
    })
    const oldest = sourceFor(turns[64]!, 1)
    const f = mockClient(turns, [...invalidRecent, oldest])
    const none = await appendNativePriorQuestionSelfAttestations(f.client, current, currentPacket())
    expect(none).toEqual(currentPacket())
    const sourceReads = f.query.mock.calls.filter(([sql]) => sql.includes('FROM "agent_items" AS item')
      && sql.includes('AS "toolCallId"'))
    expect(sourceReads).toHaveLength(8)
    expect(attestedAnswers(none!)).toEqual([])

    const oversizedFullPacket = currentPacket(Array.from({ length: 32 }, (_, index) => ({ referenceId: `full-${index}`,
      kind: "artifact", summary: "z".repeat(8_150) })))
    expect(Buffer.byteLength(JSON.stringify(oversizedFullPacket), "utf8")).toBeGreaterThan(256 * 1024)
    const rejected = await appendNativePriorQuestionSelfAttestations(mockClient([turns[0]!], [sourceFor(turns[0]!, 1)]).client,
      current, oversizedFullPacket)
    expect(rejected).toBeNull()

    const fullButValid = currentPacket(Array.from({ length: 32 }, (_, index) => ({ referenceId: `full-valid-${index}`,
      kind: "artifact", summary: "bounded" })))
    const noRead = mockClient([turns[0]!], [sourceFor(turns[0]!, 1)])
    expect(await appendNativePriorQuestionSelfAttestations(noRead.client, current, fullButValid)).toEqual(fullButValid)
    expect(noRead.query).not.toHaveBeenCalled()
  })
})
