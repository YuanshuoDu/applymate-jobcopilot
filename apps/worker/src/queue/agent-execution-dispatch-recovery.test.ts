import { describe, expect, it, vi } from "vitest"

import type pg from "pg"
import type { AgentRunTaskPayload } from "./agent-run-queue.js"
import { failTurnScopedLegacyResume } from "./agent-run-legacy-terminal-failure.js"
import {
  agentExecutionDispatchJobId,
  AGENT_EXECUTION_DISPATCH_TOPIC,
  dispatchPendingAgentExecutionOutbox,
} from "./agent-execution-dispatch-recovery.js"
import type { LeasePool } from "../runtime/turns/lease.js"

vi.mock("./agent-run-legacy-terminal-failure.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-run-legacy-terminal-failure.js")>("./agent-run-legacy-terminal-failure.js")
  return { ...actual, failTurnScopedLegacyResume: vi.fn() }
})

const questionId = "agent-question:turn_1:legacy:question_1"
const payload = {
  userId: "user_1",
  sessionId: "session_1",
  executionId: "execution_1",
  attemptCount: 4,
  questionId,
}
const idempotencyKey = `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:${questionId}`

type OutboxFixture = { id: string; aggregateId: string; idempotencyKey: string; payload: unknown; attemptCount: number; publishedAt: Date | null; lastError: string | null }
type TurnFixture = { id: string; sessionId: string; userId: string; status: string }
type ExecutionFixture = { id: string; userId: string; sessionId: string; status: string; attemptCount: number; workerTaskId: string | null; error?: string | null; completedAt?: Date | null }
type QuestionFixture = { id: string; userId: string; runId: string; answer: string | null }
type QueueJobFixture = {
  data: AgentRunTaskPayload
  state: string
  attemptsMade: number
  opts: { attempts: number }
  failedReason: string
  getState: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}
type FixtureState = {
  outbox: OutboxFixture
  additionalOutbox?: OutboxFixture
  extraOutboxes?: OutboxFixture[]
  session: { id: string; userId: string; status: string } | null
  turn: TurnFixture | null
  additionalTurn?: TurnFixture
  extraTurns?: TurnFixture[]
  execution: ExecutionFixture | null
  additionalExecution?: ExecutionFixture
  extraExecutions?: ExecutionFixture[]
  question: QuestionFixture | null
  additionalQuestion?: QuestionFixture
  extraQuestions?: QuestionFixture[]
}

function makeFixture(overrides: Partial<FixtureState> = {}) {
  const state: FixtureState = {
    outbox: { id: "outbox_1", aggregateId: payload.sessionId, idempotencyKey, payload: { ...payload }, attemptCount: 0, publishedAt: null, lastError: null },
    session: { id: payload.sessionId, userId: payload.userId, status: "waiting_for_user" },
    turn: { id: "turn_1", sessionId: payload.sessionId, userId: payload.userId, status: "waiting_for_user" },
    execution: { id: payload.executionId, userId: payload.userId, sessionId: payload.sessionId, status: "queued", attemptCount: payload.attemptCount, workerTaskId: null },
    question: { id: questionId, userId: payload.userId, runId: payload.sessionId, answer: "keep_resume" },
    ...overrides,
  }
  const allOutboxes = () => [state.outbox, state.additionalOutbox, ...(state.extraOutboxes ?? [])].filter((row): row is OutboxFixture => row !== undefined)
  const allTurns = () => [state.turn, state.additionalTurn, ...(state.extraTurns ?? [])].filter((row): row is TurnFixture => row !== null && row !== undefined)
  const allExecutions = () => [state.execution, state.additionalExecution, ...(state.extraExecutions ?? [])].filter((row): row is ExecutionFixture => row !== null && row !== undefined)
  const allQuestions = () => [state.question, state.additionalQuestion, ...(state.extraQuestions ?? [])].filter((row): row is QuestionFixture => row !== null && row !== undefined)
  let transactionSnapshot: FixtureState | null = null
  let failPublishedMarkOnce = false
  const client = {
    async query<Row extends Record<string, unknown>>(sqlValue: string, values: unknown[] = []) {
      const sql = sqlValue.replace(/\s+/g, " ").trim()
      if (sql === "BEGIN") { transactionSnapshot = structuredClone(state); return result<Row>([], 0) }
      if (sql === "COMMIT") { transactionSnapshot = null; return result<Row>([], 0) }
      if (sql === "ROLLBACK") {
        if (transactionSnapshot) Object.assign(state, structuredClone(transactionSnapshot))
        transactionSnapshot = null
        return result<Row>([], 0)
      }
      if (sql.startsWith("SELECT set_config(")) return result<Row>([], 1)
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes("LIMIT $2 FOR UPDATE SKIP LOCKED")) {
        const cursor = typeof values[2] === "string" ? values[2] : undefined
        const rows = allOutboxes().filter(row => row.publishedAt === null && (cursor === undefined || row.id > cursor))
        rows.sort((a, b) => a.id.localeCompare(b.id))
        return result<Row>(values[0] === AGENT_EXECUTION_DISPATCH_TOPIC ? rows.slice(0, Number(values[1])) : [])
      }
      if (sql.includes('FROM "agent_sessions" AS session')) return result<Row>(state.session?.id === values[0] ? [state.session] : [])
      if (sql.includes('FROM "agent_outbox" AS dispatch') && sql.includes('WHERE dispatch."id" = $1')) {
        const row = allOutboxes().find(item => item.id === values[0])
        const match = row !== undefined && row.aggregateId === values[1] && values[2] === AGENT_EXECUTION_DISPATCH_TOPIC && row.publishedAt === null
        return result<Row>(match ? [row] : [])
      }
      if (sql.includes('FROM "agent_turns" AS turn') && sql.includes("ANY($3::text[])")) {
        const rows = allTurns().filter(turn => turn.sessionId === values[0] && turn.userId === values[1]
          && (values[2] as string[]).includes(turn.status))
        return result<Row>(rows)
      }
      if (sql.includes('FROM "agent_turns" AS turn')) {
        const turn = allTurns().find(item => item.id === values[0])
        const match = turn !== undefined && turn.sessionId === values[1] && turn.userId === values[2]
        return result<Row>(match ? [turn] : [])
      }
      if (sql.includes('FROM "agent_executions" AS execution')) {
        const execution = allExecutions().find(item => item.id === values[0])
        const match = execution !== undefined && execution.sessionId === values[1] && execution.userId === values[2]
        return result<Row>(match ? [execution] : [])
      }
      if (sql.includes('FROM "AgentRunQuestion" AS question')) {
        const question = allQuestions().find(item => item.id === values[0])
        const match = question !== undefined && question.userId === values[1] && question.runId === values[2]
        return result<Row>(match ? [question] : [])
      }
      if (sql.startsWith('UPDATE "agent_executions"') && sql.includes("SET \"status\" = 'failed'")) {
        const execution = allExecutions().find(item => item.id === values[0])
        const match = execution !== undefined && execution.userId === values[1] && execution.sessionId === values[2]
          && execution.attemptCount === values[3] && execution.status === "queued"
          && (execution.workerTaskId === null || execution.workerTaskId === values[4])
        if (match) {
          execution!.status = "failed"
          execution!.workerTaskId ??= String(values[4])
          execution!.error = String(values[5])
          execution!.completedAt = new Date("2026-09-26T12:00:00.000Z")
        }
        return result<Row>([], match ? 1 : 0)
      }
      if (sql.startsWith('UPDATE "agent_executions"')) {
        const execution = allExecutions().find(item => item.id === values[0])
        const match = execution !== undefined && execution.userId === values[1] && execution.sessionId === values[2]
          && execution.status === "queued" && execution.attemptCount === values[4]
          && (execution.workerTaskId === null || execution.workerTaskId === values[3])
        if (match) execution!.workerTaskId = String(values[3])
        return result<Row>([], match ? 1 : 0)
      }
      if (sql.startsWith('UPDATE "agent_outbox"') && sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
        if (failPublishedMarkOnce) { failPublishedMarkOnce = false; throw new Error("outbox mark failed") }
        const outbox = allOutboxes().find(item => item.id === values[0])
        const match = outbox !== undefined && outbox.aggregateId === values[1] && values[2] === AGENT_EXECUTION_DISPATCH_TOPIC && outbox.publishedAt === null
        if (match) {
          outbox!.publishedAt = new Date("2026-09-26T12:00:00.000Z")
          outbox!.attemptCount += 1
          outbox!.lastError = typeof values[3] === "string" ? values[3] : null
        }
        return result<Row>([], match ? 1 : 0)
      }
      if (sql.startsWith('UPDATE "agent_outbox"')) {
        const outbox = allOutboxes().find(item => item.id === values[0])
        const match = outbox !== undefined && outbox.aggregateId === values[1] && values[2] === AGENT_EXECUTION_DISPATCH_TOPIC && outbox.publishedAt === null
        if (match) { outbox!.attemptCount += 1; outbox!.lastError = String(values[3]) }
        return result<Row>([], match ? 1 : 0)
      }
      throw new Error(`Unhandled recovery SQL: ${sql}`)
    },
    release: vi.fn(),
  }
  const pool = { connect: vi.fn(async () => client) } as unknown as LeasePool
  const queueJobs = new Map<string, QueueJobFixture>()
  const queue = {
    getJob: vi.fn(async (jobId: string) => queueJobs.get(jobId)),
    add: vi.fn(async (_name: string, data: AgentRunTaskPayload, options: { jobId?: string }) => {
      const jobId = options.jobId ?? "missing_job_id"
      if (!queueJobs.has(jobId)) {
        let state = "waiting"
        queueJobs.set(jobId, {
          data,
          getState: vi.fn(async () => state),
          retry: vi.fn(async () => { state = "waiting" }),
          attemptsMade: 0,
          opts: { attempts: 3 },
          failedReason: "",
          get state() { return state },
          set state(next: string) { state = next },
        })
      }
      return { id: jobId }
    }),
  }
  return {
    state,
    pool,
    client: client as unknown as pg.PoolClient,
    queue,
    queueJobs,
    failPublishedMark() { failPublishedMarkOnce = true },
  }
}

function result<Row>(rows: unknown[], rowCount = rows.length) {
  return { rows: rows as Row[], rowCount }
}

function makeUnnamespacedLegacyFixture() {
  const fixture = makeFixture({ turn: null })
  const questionId = "question_1"
  fixture.state.outbox.payload = { ...payload, questionId }
  fixture.state.outbox.idempotencyKey = `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:${questionId}`
  fixture.state.question!.id = questionId
  return fixture
}

describe("agent execution dispatch recovery", () => {
  it("publishes a validated intent with a stable job ID and records the same execution owner", async () => {
    const fixture = makeFixture()
    const count = await dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)

    expect(count).toBe(1)
    expect(fixture.queue.add).toHaveBeenCalledWith("run", {
      userId: payload.userId, sessionId: payload.sessionId, executionId: payload.executionId, attemptCount: payload.attemptCount,
      questionId,
      legacyTurnId: "turn_1",
    }, expect.objectContaining({
      jobId: agentExecutionDispatchJobId(idempotencyKey), attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
    }))
    expect(fixture.state.execution?.workerTaskId).toBe(agentExecutionDispatchJobId(idempotencyKey))
    expect(fixture.state.outbox.publishedAt).toEqual(expect.any(Date))
    expect(agentExecutionDispatchJobId(idempotencyKey)).not.toContain(":")
  })

  it("dispatches an unnamespaced legacy question only when the session has no active Turn", async () => {
    const fixture = makeUnnamespacedLegacyFixture()
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)
    expect(fixture.queue.add).toHaveBeenCalledOnce()
    expect(fixture.queue.add.mock.calls[0]?.[1]).toMatchObject({ questionId: "question_1" })
    expect(fixture.queue.add.mock.calls[0]?.[1]).not.toHaveProperty("legacyTurnId")
    expect(fixture.state.execution?.workerTaskId).toBe(agentExecutionDispatchJobId(fixture.state.outbox.idempotencyKey))
  })

  it("fails the exact still-queued execution if an active Turn appears before retry", async () => {
    const fixture = makeUnnamespacedLegacyFixture()
    fixture.queue.add.mockRejectedValueOnce(new Error("Redis unavailable"))
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("Redis unavailable")
    const jobId = agentExecutionDispatchJobId(fixture.state.outbox.idempotencyKey)
    fixture.state.turn = { id: "turn_later", sessionId: payload.sessionId, userId: payload.userId, status: "in_progress" }

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.queue.add).toHaveBeenCalledOnce()
    expect(fixture.state.execution?.status).toBe("failed")
    expect(fixture.state.execution?.workerTaskId).toBe(jobId)
    expect(fixture.state.execution?.error).toEqual(expect.any(String))
    expect(fixture.state.execution?.completedAt).toEqual(expect.any(Date))
    expect(fixture.state.outbox.lastError).toBe("canonical_turn_active")
  })

  it("terminally marks an unnamespaced legacy question when a canonical Turn is active", async () => {
    const fixture = makeFixture()
    fixture.state.outbox.payload = { ...payload, questionId: "question_1" }
    fixture.state.outbox.idempotencyKey = `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:question_1`
    fixture.state.question!.id = "question_1"
    fixture.state.turn!.status = "in_progress"

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.lastError).toBe("canonical_turn_active")
  })

  it("reuses the same pending Bull job after queue add but before publishedAt", async () => {
    const fixture = makeFixture()
    fixture.failPublishedMark()

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never))
      .rejects.toThrow("agent_execution_dispatch_delivery_uncertain")
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.queueJobs.size).toBe(1)

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)
    expect(fixture.queue.add).toHaveBeenCalledOnce()
    expect(fixture.queue.getJob).toHaveBeenCalledWith(fixture.queue.add.mock.calls[0]?.[2]?.jobId)
    expect(fixture.queueJobs.size).toBe(1)
    expect(fixture.state.outbox.publishedAt).toEqual(expect.any(Date))
  })

  it("recovers a fresh retained failed Bull job when publishedAt was lost", async () => {
    const fixture = makeFixture()
    fixture.failPublishedMark()

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never))
      .rejects.toThrow("agent_execution_dispatch_delivery_uncertain")
    const jobId = agentExecutionDispatchJobId(idempotencyKey)
    const retainedJob = fixture.queueJobs.get(jobId)
    expect(retainedJob).toBeDefined()
    retainedJob!.state = "failed"
    retainedJob!.attemptsMade = 2
    // Simulate markQueuedExecutionFailed failing: the exact execution remains queued.
    expect(fixture.state.execution).toMatchObject({ status: "queued", workerTaskId: jobId, attemptCount: payload.attemptCount })

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)

    expect(fixture.queue.add).toHaveBeenCalledOnce()
    expect(retainedJob!.retry).toHaveBeenCalledWith("failed", {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    })
    expect(fixture.state.outbox.publishedAt).toEqual(expect.any(Date))
    expect(fixture.state.execution).toMatchObject({ status: "queued", workerTaskId: jobId, attemptCount: payload.attemptCount })
  })

  it("terminalizes an exhausted pending Turn dispatch and preserves its retained failure reason", async () => {
    const fixture = makeFixture()
    fixture.failPublishedMark()
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never))
      .rejects.toThrow("agent_execution_dispatch_delivery_uncertain")
    const jobId = agentExecutionDispatchJobId(idempotencyKey)
    const retainedJob = fixture.queueJobs.get(jobId)!
    retainedJob.state = "failed"
    retainedJob.attemptsMade = 3
    retainedJob.failedReason = "legacy_resume_terminalization_failed:authorization_revoked"
    vi.mocked(failTurnScopedLegacyResume).mockReset().mockResolvedValueOnce(true)

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(failTurnScopedLegacyResume).toHaveBeenCalledWith(fixture.pool, expect.objectContaining({
      userId: payload.userId, sessionId: payload.sessionId, executionId: payload.executionId,
      attemptCount: payload.attemptCount, workerTaskId: jobId, questionId,
      legacyTurnId: "turn_1", reason: "authorization_revoked",
    }))
    expect(retainedJob.retry).not.toHaveBeenCalled()
    expect(fixture.state.outbox).toMatchObject({ publishedAt: expect.any(Date), lastError: "authorization_revoked" })
  })

  it("leaves an exhausted pending Turn job untouched when exact terminalization loses a race", async () => {
    const fixture = makeFixture()
    fixture.failPublishedMark()
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never))
      .rejects.toThrow("agent_execution_dispatch_delivery_uncertain")
    const jobId = agentExecutionDispatchJobId(idempotencyKey)
    const retainedJob = fixture.queueJobs.get(jobId)!
    retainedJob.state = "failed"
    retainedJob.attemptsMade = 3
    vi.mocked(failTurnScopedLegacyResume).mockReset().mockResolvedValueOnce(false)

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(failTurnScopedLegacyResume).toHaveBeenCalledWith(fixture.pool, expect.objectContaining({
      attemptCount: payload.attemptCount, workerTaskId: jobId, legacyTurnId: "turn_1",
    }))
    expect(retainedJob.retry).not.toHaveBeenCalled()
    expect(fixture.state.outbox.publishedAt).toBeNull()
  })

  it("terminalizes an exhausted unnamespaced legacy execution under exact ownership", async () => {
    const fixture = makeUnnamespacedLegacyFixture()
    fixture.failPublishedMark()
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never))
      .rejects.toThrow("agent_execution_dispatch_delivery_uncertain")
    const jobId = agentExecutionDispatchJobId(fixture.state.outbox.idempotencyKey)
    const retainedJob = fixture.queueJobs.get(jobId)!
    retainedJob.state = "failed"
    retainedJob.attemptsMade = 3
    vi.mocked(failTurnScopedLegacyResume).mockReset()

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.state.execution).toMatchObject({
      status: "failed", workerTaskId: jobId, error: "This agent run could not start after retrying. Please try again.",
    })
    expect(fixture.state.outbox).toMatchObject({ publishedAt: expect.any(Date), lastError: "retry_exhausted" })
    expect(retainedJob.retry).not.toHaveBeenCalled()
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()
  })

  it("marks the intent delivered when the same task is claimed before publishedAt", async () => {
    const fixture = makeFixture()
    fixture.failPublishedMark()

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never))
      .rejects.toThrow("agent_execution_dispatch_delivery_uncertain")
    const stableJobId = agentExecutionDispatchJobId(idempotencyKey)
    expect(fixture.state.execution?.workerTaskId).toBe(stableJobId)

    fixture.state.execution!.status = "running"
    fixture.state.execution!.attemptCount += 1
    fixture.state.turn!.status = "running"
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)

    expect(fixture.queue.add).toHaveBeenCalledOnce()
    expect(fixture.state.outbox.publishedAt).toEqual(expect.any(Date))
  })

  it.each([
    ["malformed payload", (fixture: ReturnType<typeof makeFixture>) => { fixture.state.outbox.payload = { ...payload, unexpected: true } }, "schema_invalid_payload"],
    ["non-legacy question ID", (fixture: ReturnType<typeof makeFixture>) => {
      const questionId = "agent-question:turn_1:canonical:question_1"
      fixture.state.outbox.payload = { ...payload, questionId }
      fixture.state.outbox.idempotencyKey = `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:${questionId}`
    }, "question_turn_invalid"],
    ["stale Turn", (fixture: ReturnType<typeof makeFixture>) => { fixture.state.turn!.status = "interrupted" }, "turn_not_waiting"],
    ["stale execution attempt", (fixture: ReturnType<typeof makeFixture>) => { fixture.state.execution!.attemptCount += 1 }, "execution_attempt_stale"],
  ])("terminally marks %s without queueing", async (_case, mutate, reason) => {
    const fixture = makeFixture()
    mutate(fixture)

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(0)
    expect(fixture.queue.add).not.toHaveBeenCalled()
    expect(fixture.state.outbox.publishedAt).toEqual(expect.any(Date))
    expect(fixture.state.outbox.lastError).toBe(reason)
  })

  it("leaves a queue-add failure unpublished for transient retry with the same job ID", async () => {
    const fixture = makeFixture()
    fixture.queue.add.mockRejectedValueOnce(new Error("Redis unavailable"))

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("Redis unavailable")
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.state.outbox.lastError).toBe("queue_add_failed")
    const firstJobId = fixture.queue.add.mock.calls[0]?.[2]?.jobId

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).resolves.toBe(1)
    expect(fixture.queue.add.mock.calls[1]?.[2]?.jobId).toBe(firstJobId)
  })

  it("continues a batch after the oldest enqueue fails so a later intent progresses", async () => {
    const fixture = makeFixture()
    const secondPayload = {
      ...payload,
      executionId: "execution_2",
      questionId: "agent-question:turn_2:legacy:question_2",
    }
    const secondKey = `legacy-execution-dispatch:${secondPayload.executionId}:${secondPayload.attemptCount}:${secondPayload.questionId}`
    fixture.state.additionalOutbox = {
      id: "outbox_2", aggregateId: payload.sessionId, idempotencyKey: secondKey, payload: secondPayload,
      attemptCount: 0, publishedAt: null, lastError: null,
    }
    fixture.state.additionalTurn = { id: "turn_2", sessionId: payload.sessionId, userId: payload.userId, status: "waiting_for_user" }
    fixture.state.additionalExecution = {
      id: secondPayload.executionId, userId: payload.userId, sessionId: payload.sessionId,
      status: "queued", attemptCount: payload.attemptCount, workerTaskId: null,
    }
    fixture.state.additionalQuestion = {
      id: secondPayload.questionId, userId: payload.userId, runId: payload.sessionId, answer: "keep_resume",
    }
    fixture.queue.add.mockRejectedValueOnce(new Error("Redis unavailable"))

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("Redis unavailable")

    expect(fixture.queue.add).toHaveBeenCalledTimes(2)
    expect(fixture.state.outbox.lastError).toBe("queue_add_failed")
    expect(fixture.state.outbox.publishedAt).toBeNull()
    expect(fixture.state.additionalOutbox.publishedAt).toEqual(expect.any(Date))
    expect(fixture.state.additionalExecution.workerTaskId).toBe(agentExecutionDispatchJobId(secondKey))
  })

  it("advances past a failing page then wraps to retry its first row", async () => {
    const fixture = makeFixture()
    const rows = Array.from({ length: 60 }, (_, index) => {
      const turnId = index === 0 ? "turn_1" : `turn_${String(index).padStart(3, "0")}`
      const executionId = index === 0 ? payload.executionId : `execution_${String(index).padStart(3, "0")}`
      const questionId = index === 0 ? payload.questionId : `agent-question:${turnId}:legacy:question_${index}`
      const rowPayload = { ...payload, executionId, questionId }
      return {
        row: {
          id: `outbox_${String(index).padStart(3, "0")}`,
          aggregateId: payload.sessionId,
          idempotencyKey: `legacy-execution-dispatch:${executionId}:${payload.attemptCount}:${questionId}`,
          payload: rowPayload,
          attemptCount: 0,
          publishedAt: null,
          lastError: null,
        } satisfies OutboxFixture,
        turn: { id: turnId, sessionId: payload.sessionId, userId: payload.userId, status: "waiting_for_user" } satisfies TurnFixture,
        execution: {
          id: executionId, userId: payload.userId, sessionId: payload.sessionId,
          status: "queued", attemptCount: payload.attemptCount, workerTaskId: null,
        } satisfies ExecutionFixture,
        question: { id: questionId, userId: payload.userId, runId: payload.sessionId, answer: "keep_resume" } satisfies QuestionFixture,
      }
    })
    fixture.state.outbox = rows[0]!.row
    fixture.state.extraOutboxes = rows.slice(1).map(item => item.row)
    fixture.state.extraTurns = rows.slice(1).map(item => item.turn)
    fixture.state.extraExecutions = rows.slice(1).map(item => item.execution)
    fixture.state.extraQuestions = rows.slice(1).map(item => item.question)
    fixture.queue.add.mockRejectedValue(new Error("Redis unavailable"))

    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("Redis unavailable")
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("Redis unavailable")
    await expect(dispatchPendingAgentExecutionOutbox(fixture.pool, fixture.queue as never)).rejects.toThrow("Redis unavailable")

    expect(fixture.queue.add).toHaveBeenCalledTimes(110)
    expect(fixture.queue.add.mock.calls[0]?.[1].executionId).toBe("execution_1")
    expect(fixture.queue.add.mock.calls[50]?.[1].executionId).toBe("execution_050")
    expect(fixture.queue.add.mock.calls[60]?.[1].executionId).toBe("execution_1")
  })
})
