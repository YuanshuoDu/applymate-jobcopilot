import { describe, expect, it, vi } from "vitest"

import type { ContextHistoryEntry } from "./context/step-context-builder.js"
import type { RecoveryInput } from "./question-answer-recovery-lineage.js"
import { recoverPriorRootQuestionHistory } from "./question-answer-prior-history.js"

type Row = Record<string, unknown>
type Source = {
  id: string; rootTaskId: string; createdAt: Date; status: string; userId: string; sessionId: string; selfRoot: boolean
  questions: Row[]; calls: Row[]; steps: Row[]; events: Row[]
}
type Trace = { sql: string; values: readonly unknown[] }
const userId = "user-1", sessionId = "session-1", currentTurnId = "turn-current"
const currentCreatedAt = new Date("2026-10-07T00:00:00.000Z")

function makeSource(index: number, questionCount = 1, answer = "Résumé — Dublin\nquoted: \"yes\""): Source {
  const id = `turn-${index}`, rootTaskId = `root-${index}`, createdAt = new Date(Date.UTC(2026, 8, index))
  const questions: Row[] = [], calls: Row[] = [], steps: Row[] = [], events: Row[] = []
  for (let offset = 0; offset < questionCount; offset += 1) {
    const suffix = `${index}-${offset}`, itemId = `question-item-${suffix}`, stepId = `step-${suffix}`
    const questionId = `wait-${suffix}`, toolCallId = `call-${suffix}`
    const content = { stage: "user_input", waitKind: "question", questionId, toolCallId,
      question: `Question ${suffix}?`, options: [{ label: "Keep", value: "keep" }], answer, answerAvailable: true }
    questions.push({ id: itemId, revision: 1, userId, turnUserId: userId, sessionId, turnId: id, taskId: rootTaskId,
      stepId, type: "question", status: "completed", content })
    calls.push({ id: `call-item-${suffix}`, stepId, taskId: rootTaskId, type: "tool_call", status: "completed",
      content: { toolCallId, toolName: "agent.ask_user", toolVersion: "1", status: "completed", errorCode: null } })
    steps.push({ id: stepId, taskId: rootTaskId })
    const startedAt = String(10 + offset * 2), answeredAt = String(11 + offset * 2)
    events.push(
      { id: `start-${suffix}`, userId, turnUserId: userId, sessionId, turnId: id, taskId: rootTaskId,
        itemId, actor: "orchestrator", sequence: startedAt, type: "item.started", correlationId: itemId, causationId: questionId,
        payload: { itemId, waitKind: "question", toolCallId } },
      { id: `answer-${suffix}`, userId, turnUserId: userId, sessionId, turnId: id, taskId: null,
        itemId, actor: "user", sequence: answeredAt, type: "question.answered", correlationId: questionId, causationId: itemId,
        payload: { waitKind: "question", waitId: questionId, itemId, turnId: id, toolCallId, status: "answered" } },
    )
  }
  return { id, rootTaskId, createdAt, status: "completed", userId, sessionId, selfRoot: true, questions, calls, steps, events }
}

function input(existingHistory: readonly ContextHistoryEntry[] = []): RecoveryInput {
  return { lease: { userId, sessionId, turnId: currentTurnId }, rootTaskId: "root-current", steps: [], toolItems: [], existingHistory }
}

function fakeClient(sources: Source[], options: { currentDate?: Date | null; fail?: Error; failLineage?: Error } = {}) {
  const traces: Trace[] = []
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    traces.push({ sql, values })
    if (options.fail) throw options.fail
    if (options.failLineage && sql.includes('FROM "agent_items" AS item')) throw options.failLineage
    if (sql.includes('SELECT active_turn."createdAt"')) {
      return { rows: options.currentDate === null ? [] : [{ createdAt: options.currentDate ?? currentCreatedAt }] }
    }
    if (sql.includes('SELECT prior."id"')) {
      const [session, user, current, cutoff, turnLimit, answerLimit] = values
      const turns = sources.filter(source => source.status === "completed" && source.sessionId === session && source.userId === user
        && source.id !== current && source.createdAt < (cutoff as Date))
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))
        .slice(0, Number(turnLimit))
        .filter(source => source.selfRoot && source.questions.some(question => {
          const content = record(question.content)
          const claimsAnswer = question.status === "completed" || content.answerAvailable === true || typeof content.answer === "string"
          return question.taskId === source.rootTaskId && question.type === "question" && claimsAnswer
            && source.calls.some(call => {
              const callContent = record(call.content)
              return call.taskId === source.rootTaskId && call.type === "tool_call" && call.status === "completed"
                && callContent.toolName === "agent.ask_user" && callContent.toolVersion === "1"
                && callContent.status === "completed" && callContent.errorCode === null
                && callContent.toolCallId === content.toolCallId
            })
        }))
        .slice(0, Number(answerLimit))
      return { rows: turns.map(({ id, rootTaskId, createdAt }) => ({ id, rootTaskId, createdAt })) }
    }
    const turnId = String(values[1] ?? "")
    const source = sources.find(candidate => candidate.id === turnId)
    if (sql.includes('FROM "agent_items" AS question')) {
      const limit = Number(values[3])
      return { rows: (source?.questions ?? []).filter(question => question.taskId === values[2]
        && question.type === "question" && claimsPersisted(question)).slice(0, limit).map(question => ({
          id: question.id, stepId: question.stepId, toolCallId: record(question.content).toolCallId,
        })) }
    }
    if (sql.includes('FROM "agent_items" AS call')) {
      const callIds = values[3] as string[]
      return { rows: (source?.calls ?? []).filter(call => call.taskId === values[2] && call.type === "tool_call"
        && callIds.includes(String(record(call.content).toolCallId))).slice(0, Number(values[4])) }
    }
    if (sql.includes('FROM "agent_steps" AS step')) {
      const ids = values[3] as string[]
      return { rows: (source?.steps ?? []).filter(step => step.taskId === values[2] && ids.includes(String(step.id))).slice(0, Number(values[4])) }
    }
    if (sql.includes('FROM "agent_items" AS item')) {
      return { rows: (source?.questions ?? []).filter(question => question.taskId === values[3] && question.type === "question")
        .slice(0, Number(values[4])) }
    }
    if (sql.includes('FROM "agent_events" AS event')) {
      const ids = values[4] as string[]
      return { rows: (source?.events ?? []).filter(event => ids.includes(String(event.itemId))
        && (event.taskId === null || event.taskId === values[3])).slice(0, Number(values[5])) }
    }
    throw new Error("unexpected query in query-mocked history test")
  })
  return { client: { query } as never, query, traces }
}

function record(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {} }
function claimsPersisted(question: Row): boolean {
  const content = record(question.content)
  return question.status === "completed" || content.answerAvailable === true || typeof content.answer === "string"
}
function pairIds(source: Source): string[] {
  return source.questions.flatMap(question => [`agent-question:${question.id}:question`, `agent-question:${question.id}:answer`])
}

describe("recoverPriorRootQuestionHistory", () => {
  it("reuses strict root lineage and returns complete pairs deterministically after compacted history", async () => {
    const older = makeSource(1), newer = makeSource(2)
    const compacted: ContextHistoryEntry = { id: "compacted-summary", content: { role: "user", text: "Earlier conversation summary" } }
    const first = fakeClient([newer, older])
    const history = await recoverPriorRootQuestionHistory(first.client, input([compacted]))
    const second = fakeClient([older, newer])
    const repeated = await recoverPriorRootQuestionHistory(second.client, input([compacted, ...history]))

    expect(history.map(entry => entry.id)).toEqual([...pairIds(older), ...pairIds(newer)])
    expect(history.find(entry => entry.id === `agent-question:${older.questions[0]?.id}:answer`)?.content)
      .toMatchObject({ role: "user", type: "answer", text: "Résumé — Dublin\nquoted: \"yes\"" })
    expect(repeated).toEqual([])
    const scan = first.traces.find(trace => trace.sql.includes('SELECT prior."id"'))!
    expect(scan.sql).toContain(`candidate."status" = 'completed'`)
    expect(scan.sql).toContain('candidate."createdAt" < $4')
    expect(scan.sql).toContain('ORDER BY candidate."createdAt" DESC, candidate."id" DESC LIMIT $5')
    expect(scan.sql).toContain('ORDER BY prior."createdAt" DESC, prior."id" DESC LIMIT $6')
    expect(scan.sql).toContain('root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL')
    expect(scan.sql).toContain('candidate_session."userId" = $2')
    expect(scan.values).toEqual([sessionId, userId, currentTurnId, currentCreatedAt, 64, 8])
    const lineageQuery = first.traces.find(trace => trace.sql.includes('FROM "agent_items" AS item'))!
    expect(lineageQuery.sql).toContain('item."taskId" = $4 AND item."type" = \'question\'')
    expect(lineageQuery.sql).toContain('turn."userId" = $3')
  })

  it("fails closed on stale, duplicate, or incomplete cached stable-ID pairs", async () => {
    const source = makeSource(1)
    const questionId = `agent-question:${source.questions[0]?.id}:question`
    const answerId = `agent-question:${source.questions[0]?.id}:answer`
    const exact = await recoverPriorRootQuestionHistory(fakeClient([source]).client, input())
    const question = exact[0]!
    const answer = exact[1]!
    const staleAnswer = { ...answer, content: { ...record(answer.content), text: "A different cached answer" } }

    await expect(recoverPriorRootQuestionHistory(fakeClient([source]).client, input([question, staleAnswer])))
      .rejects.toThrow("question_recovery_history_collision")
    await expect(recoverPriorRootQuestionHistory(fakeClient([source]).client, input([answer])))
      .rejects.toThrow("question_recovery_history_pair_incomplete")
    await expect(recoverPriorRootQuestionHistory(fakeClient([source]).client, input([question, question, answer])))
      .rejects.toThrow("question_recovery_history_duplicate")
    expect(question.id).toBe(questionId)
    expect(answer.id).toBe(answerId)
  })

  it("ignores foreign, child-root, future, and nonterminal source Turns", async () => {
    const foreignUser = { ...makeSource(1), userId: "user-2" }
    const foreignSession = { ...makeSource(2), sessionId: "session-2" }
    const childRoot = { ...makeSource(3), selfRoot: false }
    const nonterminal = { ...makeSource(4), status: "in_progress" }
    const future = { ...makeSource(5), createdAt: new Date("2026-11-01T00:00:00.000Z") }
    const { client } = fakeClient([foreignUser, foreignSession, childRoot, nonterminal, future])

    await expect(recoverPriorRootQuestionHistory(client, input())).resolves.toEqual([])
  })

  it("omits malformed historical lineage without leaking it or swallowing database errors", async () => {
    const malformed = makeSource(1)
    const malformedAnswer = "MALFORMED-PRIVATE-ANSWER-MARKER"
    record(malformed.questions[0]?.content).answer = malformedAnswer
    malformed.questions[0]!.status = "started"
    const valid = makeSource(2)
    const { client } = fakeClient([malformed, valid])

    const history = await recoverPriorRootQuestionHistory(client, input())

    expect(history.map(entry => entry.id)).toEqual(pairIds(valid))
    expect(JSON.stringify(history)).not.toContain(malformedAnswer)
    const databaseFailure = new Error("database unavailable")
    await expect(recoverPriorRootQuestionHistory(fakeClient([valid], { fail: databaseFailure }).client, input()))
      .rejects.toBe(databaseFailure)
    const lineageError = Object.assign(new Error("question_recovery_item_malformed"), { code: "XX000" })
    await expect(recoverPriorRootQuestionHistory(fakeClient([valid], { failLineage: lineageError }).client, input()))
      .rejects.toBe(lineageError)
  })

  it("prefers the newest eight eligible completed Turns and never scans past the completed-turn window", async () => {
    const nineTurns = Array.from({ length: 9 }, (_, index) => makeSource(index + 1))
    const newestEight = fakeClient(nineTurns)
    const history = await recoverPriorRootQuestionHistory(newestEight.client, input())
    expect(history.map(entry => entry.id)).toEqual(nineTurns.slice(1).flatMap(pairIds))
    expect(newestEight.traces.find(trace => trace.sql.includes('SELECT prior."id"'))?.values.slice(4)).toEqual([64, 8])

    const noAnswerTurns = Array.from({ length: 64 }, (_, index) => {
      const source = makeSource(index + 1)
      source.createdAt = new Date(Date.UTC(2026, 9, 6) - (index + 1) * 24 * 60 * 60 * 1000)
      source.questions = []; source.calls = []; source.steps = []; source.events = []
      return source
    })
    const olderAnswer = makeSource(0)
    olderAnswer.createdAt = new Date("2026-08-01T00:00:00.000Z")
    const bounded = fakeClient([olderAnswer, ...noAnswerTurns])
    await expect(recoverPriorRootQuestionHistory(bounded.client, input())).resolves.toEqual([])
    expect(bounded.traces.find(trace => trace.sql.includes('SELECT prior."id"'))?.values[4]).toBe(64)
  })

  it("caps complete pairs by count and bytes without clipping an answer", async () => {
    const crowded = [makeSource(1, 9), makeSource(2, 9)]
    const byCount = await recoverPriorRootQuestionHistory(fakeClient(crowded).client, input())
    expect(byCount).toHaveLength(32)
    expect(new Set(byCount.map(entry => entry.id)).size).toBe(32)

    const large = Array.from({ length: 4 }, (_, index) => makeSource(index + 1, 1, "A".repeat(20_000)))
    const byBytes = await recoverPriorRootQuestionHistory(fakeClient(large).client, input())
    expect(byBytes).toHaveLength(6)
    expect(byBytes.map(entry => entry.id)).toEqual(large.slice(1).flatMap(pairIds))
    expect(byBytes.filter(entry => entry.id.endsWith(":answer")).every(entry => record(entry.content).text === "A".repeat(20_000))).toBe(true)
  })

  it("omits per-source question and linked-call overflow rather than returning a partial source", async () => {
    const tooManyQuestions = makeSource(1, 17)
    const questionOverflow = fakeClient([tooManyQuestions])
    await expect(recoverPriorRootQuestionHistory(questionOverflow.client, input())).resolves.toEqual([])
    expect(questionOverflow.traces.some(trace => trace.sql.includes('FROM "agent_items" AS call'))).toBe(false)

    const duplicateCalls = makeSource(2)
    const duplicate = duplicateCalls.calls[0]!
    duplicateCalls.calls = Array.from({ length: 65 }, (_, index) => ({ ...duplicate, id: `duplicate-call-${index}` }))
    const callOverflow = fakeClient([duplicateCalls])
    await expect(recoverPriorRootQuestionHistory(callOverflow.client, input())).resolves.toEqual([])
    expect(callOverflow.traces.some(trace => trace.sql.includes('FROM "agent_items" AS item'))).toBe(false)
  })
})
