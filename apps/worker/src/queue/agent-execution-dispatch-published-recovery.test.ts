import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { AgentRunTaskPayload } from "./agent-run-queue.js"
import type { DispatchJobQueue } from "./agent-execution-dispatch-job-recovery.js"
import { agentExecutionDispatchJobId, AGENT_EXECUTION_DISPATCH_TOPIC } from "./agent-execution-dispatch-recovery.js"
import { reconcilePublishedAgentExecutionDispatches } from "./agent-execution-dispatch-published-recovery.js"
import { failTurnScopedLegacyResume, legacyResumeTerminalizationFailure } from "./agent-run-legacy-terminal-failure.js"

vi.mock("./agent-run-legacy-terminal-failure.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-run-legacy-terminal-failure.js")>("./agent-run-legacy-terminal-failure.js")
  return { ...actual, failTurnScopedLegacyResume: vi.fn() }
})

const payload = {
  userId: "user_1", sessionId: "session_1", executionId: "execution_1", attemptCount: 4,
  questionId: "agent-question:turn_1:legacy:question_1",
}
const idempotencyKey = `legacy-execution-dispatch:${payload.executionId}:${payload.attemptCount}:${payload.questionId}`
const jobId = agentExecutionDispatchJobId(idempotencyKey)
type Outbox = { id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: unknown; publishedAt: Date | null }
type Execution = { id: string; sessionId: string; userId: string; status: string; attemptCount: number; workerTaskId: string | null; updatedAt: Date }
type State = {
  outbox: Outbox[]
  sessions: Array<{ id: string; userId: string; status: string }>
  turns: Array<{ id: string; sessionId: string; userId: string; status: string }>
  questions: Array<{ id: string; userId: string; runId: string; answer: string | null }>
  executions: Execution[]
}

function fixtures(options: {
  status?: string
  attemptCount?: number
  workerTaskId?: string | null
  updatedAt?: Date
  beforeExecutionUpdate?: (execution: Execution | undefined) => void
} = {}) {
  const state: State = {
    outbox: [{ id: "intent_001", topic: AGENT_EXECUTION_DISPATCH_TOPIC, aggregateId: payload.sessionId, idempotencyKey, payload: { ...payload }, publishedAt: new Date(0) }],
    sessions: [{ id: payload.sessionId, userId: payload.userId, status: "running" }],
    turns: [{ id: "turn_1", sessionId: payload.sessionId, userId: payload.userId, status: "waiting_for_user" }],
    questions: [{ id: payload.questionId, userId: payload.userId, runId: payload.sessionId, answer: "keep_resume" }],
    executions: [{ id: payload.executionId, sessionId: payload.sessionId, userId: payload.userId,
      status: options.status ?? "queued", attemptCount: options.attemptCount ?? payload.attemptCount,
      workerTaskId: options.workerTaskId === undefined ? jobId : options.workerTaskId, updatedAt: options.updatedAt ?? new Date(0) }],
  }
  let snapshot: State | null = null
  const calls: Array<{ sql: string; values: unknown[] }> = []
  const client = {
    async query<Row extends Record<string, unknown>>(sqlValue: string, values: unknown[] = []) {
      const sql = sqlValue.replace(/\s+/g, " ").trim()
      calls.push({ sql, values })
      if (sql === "BEGIN") { snapshot = structuredClone(state); return result<Row>([]) }
      if (sql === "COMMIT" || sql.includes("set_config")) { snapshot = null; return result<Row>([]) }
      if (sql === "ROLLBACK") { if (snapshot) Object.assign(state, snapshot); snapshot = null; return result<Row>([]) }
      if (sql.includes('FROM "agent_outbox"') && sql.includes('"publishedAt" IS NOT NULL')) {
        const after = values[1] as string | null
        const rows = state.outbox.filter(row => row.topic === values[0] && row.publishedAt && (after === null || row.id > after))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(values[2]))
        return result<Row>(rows)
      }
      if (sql.includes('FROM "agent_sessions"')) return result<Row>(state.sessions.filter(row => row.id === values[0]))
      if (sql.includes('FROM "agent_turns"') && sql.includes("ANY($3::text[])")) {
        return result<Row>(state.turns.filter(row => row.sessionId === values[0] && row.userId === values[1] && (values[2] as string[]).includes(row.status)))
      }
      if (sql.includes('FROM "agent_turns"')) return result<Row>(state.turns.filter(row => row.id === values[0] && row.sessionId === values[1] && row.userId === values[2]))
      if (sql.includes('FROM "AgentRunQuestion"')) return result<Row>(state.questions.filter(row => row.id === values[0] && row.userId === values[1] && row.runId === values[2]))
      if (sql.includes('FROM "agent_executions"')) return result<Row>(state.executions.filter(row => row.id === values[0] && row.sessionId === values[1] && row.userId === values[2]))
      if (sql.startsWith('UPDATE "agent_executions"')) {
        const execution = state.executions.find(row => row.id === values[0] && ((row.userId === values[1] && row.sessionId === values[2]) || (row.sessionId === values[1] && row.userId === values[2])))
        options.beforeExecutionUpdate?.(execution)
        const staleRunning = sql.includes('"status" = \'running\'')
        const staleBefore = staleRunning ? values[5] as Date : undefined
        const match = execution?.status === (staleRunning ? "running" : "queued") &&
          execution.attemptCount === values[3] && execution.workerTaskId === values[4] &&
          (!staleRunning || (staleBefore instanceof Date && execution.updatedAt.getTime() < staleBefore.getTime()))
        if (match && execution) { execution.status = "failed"; execution.updatedAt = new Date() }
        return { rows: [], rowCount: match ? 1 : 0 }
      }
      throw new Error(`Unhandled SQL: ${sql}`)
    },
    release() {},
  }
  return { state, calls, pool: { connect: async () => client as unknown as pg.PoolClient } }
}

type Job = {
  data: AgentRunTaskPayload
  attemptsMade: number
  failedReason: string
  opts: { attempts: number }
  state: string
  getState: ReturnType<typeof vi.fn>
  retry: ReturnType<typeof vi.fn>
}
function job(options: { state?: string; attemptsMade?: number; failedReason?: string; attempts?: number; data?: AgentRunTaskPayload } = {}): Job {
  const item: Job = {
    data: options.data ?? { ...payload, legacyTurnId: "turn_1" },
    attemptsMade: options.attemptsMade ?? 0,
    failedReason: options.failedReason ?? "",
    opts: { attempts: options.attempts ?? 3 },
    state: options.state ?? "waiting",
    getState: vi.fn(async () => item.state),
    retry: vi.fn(async () => { item.state = "waiting" }),
  }
  return item
}
function queue(existing: Job | undefined) {
  const calls: string[] = []
  return {
    calls,
    add: vi.fn(async (_name: string, _data: AgentRunTaskPayload, options: { jobId?: string }) => { calls.push(options.jobId ?? "") }),
    getJob: vi.fn(async () => existing),
  }
}
function result<T>(rows: unknown[]) { return { rows: rows as T[], rowCount: rows.length } }

describe("published legacy dispatch recovery", () => {
  beforeEach(() => vi.mocked(failTurnScopedLegacyResume).mockReset())

  it("re-adds a missing exact job with the same stable ID", async () => {
    const fake = fixtures()
    const q = queue(undefined)
    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 50, Date.now())).resolves.toBe(1)
    expect(q.add).toHaveBeenCalledWith("run", { ...payload, legacyTurnId: "turn_1" }, expect.objectContaining({ jobId }))
  })

  it("terminalizes an exhausted queued Turn attempt and retries terminalization after a DB failure", async () => {
    const fake = fixtures()
    const retained = job({ state: "failed", attemptsMade: 3 })
    const q = queue(retained)
    const now = Date.now()
    vi.mocked(failTurnScopedLegacyResume).mockRejectedValueOnce(new Error("temporary DB failure")).mockResolvedValueOnce(true)

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 50, now)).rejects.toThrow("temporary DB failure")
    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 50, now + 16_000)).resolves.toBe(1)
    expect(failTurnScopedLegacyResume).toHaveBeenCalledTimes(2)
    expect(failTurnScopedLegacyResume).toHaveBeenLastCalledWith(fake.pool, expect.objectContaining({
      attemptCount: payload.attemptCount, workerTaskId: jobId, legacyTurnId: "turn_1", reason: "retry_exhausted",
    }))
    expect(retained.retry).not.toHaveBeenCalled()
  })

  it("replays authorization reason from the exact Bull failure marker", async () => {
    const fake = fixtures()
    const marker = legacyResumeTerminalizationFailure("authorization_revoked", new Error("temporary DB failure")).message
    const retained = job({ state: "failed", attemptsMade: 3, failedReason: marker })
    vi.mocked(failTurnScopedLegacyResume).mockResolvedValue(true)

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, queue(retained) as unknown as DispatchJobQueue, 50, Date.now()))
      .resolves.toBe(1)

    expect(failTurnScopedLegacyResume).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      attemptCount: payload.attemptCount, workerTaskId: jobId, legacyTurnId: "turn_1", reason: "authorization_revoked",
    }))
    expect(retained.retry).not.toHaveBeenCalled()
  })

  it("fails an exhausted unnamespaced legacy execution only while no active Turn owns the session", async () => {
    const fake = fixtures()
    const rawPayload = { ...payload, questionId: "legacy-question_1" }
    const rawKey = `legacy-execution-dispatch:${rawPayload.executionId}:${rawPayload.attemptCount}:${rawPayload.questionId}`
    const rawJobId = agentExecutionDispatchJobId(rawKey)
    fake.state.outbox[0]!.payload = rawPayload
    fake.state.outbox[0]!.idempotencyKey = rawKey
    fake.state.questions[0]!.id = rawPayload.questionId
    fake.state.turns = []
    fake.state.executions[0]!.workerTaskId = rawJobId
    const retained = job({ state: "failed", attemptsMade: 3, data: rawPayload })

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, queue(retained) as unknown as DispatchJobQueue, 50, Date.now())).resolves.toBe(1)
    expect(fake.state.executions[0]?.status).toBe("failed")
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()
  })

  it("does not recover another worker-task owner", async () => {
    const fake = fixtures({ workerTaskId: "other-task" })
    const retained = job({ state: "failed", attemptsMade: 3 })

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, queue(retained) as unknown as DispatchJobQueue, 50, Date.now())).resolves.toBe(0)
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()
    expect(retained.retry).not.toHaveBeenCalled()
  })

  it("terminalizes an exhausted stale-running Turn attempt with its retained authorization reason", async () => {
    const now = Date.now()
    const staleMs = Number(process.env.AGENT_EXECUTION_STALE_MS ?? 15_000)
    const currentAttemptCount = payload.attemptCount + 3
    const fake = fixtures({ status: "running", attemptCount: currentAttemptCount, updatedAt: new Date(0) })
    const marker = legacyResumeTerminalizationFailure("authorization_revoked", new Error("temporary DB failure")).message
    const retained = job({ state: "failed", attemptsMade: 3, failedReason: marker })
    vi.mocked(failTurnScopedLegacyResume).mockResolvedValue(true)

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, queue(retained) as unknown as DispatchJobQueue, 50, now)).resolves.toBe(1)
    expect(failTurnScopedLegacyResume).toHaveBeenCalledWith(fake.pool, expect.objectContaining({
      attemptCount: payload.attemptCount,
      workerTaskId: jobId,
      legacyTurnId: "turn_1",
      reason: "authorization_revoked",
      staleRunning: { attemptCount: currentAttemptCount, staleBefore: new Date(now - staleMs) },
    }))
    expect(retained.retry).not.toHaveBeenCalled()
  })

  it("terminalizes an exhausted stale unnamespaced execution only with no active Turn", async () => {
    const fake = fixtures({ status: "running", attemptCount: payload.attemptCount + 2, updatedAt: new Date(0) })
    const rawPayload = { ...payload, questionId: "legacy-question_1" }
    const rawKey = `legacy-execution-dispatch:${rawPayload.executionId}:${rawPayload.attemptCount}:${rawPayload.questionId}`
    const rawJobId = agentExecutionDispatchJobId(rawKey)
    fake.state.outbox[0]!.payload = rawPayload
    fake.state.outbox[0]!.idempotencyKey = rawKey
    fake.state.questions[0]!.id = rawPayload.questionId
    fake.state.turns = []
    fake.state.executions[0]!.workerTaskId = rawJobId
    const retained = job({ state: "failed", attemptsMade: 3, data: rawPayload })

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, queue(retained) as unknown as DispatchJobQueue, 50, Date.now())).resolves.toBe(1)
    expect(fake.state.executions[0]?.status).toBe("failed")
    expect(retained.retry).not.toHaveBeenCalled()
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()

    const active = fixtures({ status: "running", attemptCount: payload.attemptCount + 2, updatedAt: new Date(0) })
    active.state.outbox[0]!.payload = rawPayload
    active.state.outbox[0]!.idempotencyKey = rawKey
    active.state.questions[0]!.id = rawPayload.questionId
    active.state.executions[0]!.workerTaskId = rawJobId
    const activeJob = job({ state: "failed", attemptsMade: 3, data: rawPayload })
    await expect(reconcilePublishedAgentExecutionDispatches(active.pool as never,
      queue(activeJob) as unknown as DispatchJobQueue, 50, Date.now())).resolves.toBe(0)
    expect(active.state.executions[0]?.status).toBe("running")
    expect(activeJob.retry).not.toHaveBeenCalled()

    const changedAttempt = fixtures({
      status: "running",
      attemptCount: payload.attemptCount + 2,
      updatedAt: new Date(0),
      beforeExecutionUpdate: execution => { if (execution) execution.attemptCount += 1 },
    })
    changedAttempt.state.outbox[0]!.payload = rawPayload
    changedAttempt.state.outbox[0]!.idempotencyKey = rawKey
    changedAttempt.state.questions[0]!.id = rawPayload.questionId
    changedAttempt.state.turns = []
    changedAttempt.state.executions[0]!.workerTaskId = rawJobId
    const changedAttemptJob = job({ state: "failed", attemptsMade: 3, data: rawPayload })
    await expect(reconcilePublishedAgentExecutionDispatches(changedAttempt.pool as never,
      queue(changedAttemptJob) as unknown as DispatchJobQueue, 50, Date.now())).resolves.toBe(0)
    expect(changedAttempt.state.executions[0]?.status).toBe("running")
    expect(changedAttempt.state.executions[0]?.attemptCount).toBe(payload.attemptCount + 3)
    expect(changedAttemptJob.retry).not.toHaveBeenCalled()
  })

  it("recovers stale unnamespaced authorization revocation after a transient failure and unrelated Turn start", async () => {
    const now = Date.now()
    const rawPayload = { ...payload, questionId: "legacy-question_1" }
    const rawKey = `legacy-execution-dispatch:${rawPayload.executionId}:${rawPayload.attemptCount}:${rawPayload.questionId}`
    const rawJobId = agentExecutionDispatchJobId(rawKey)
    let failTerminalization = true
    const fake = fixtures({
      status: "running",
      attemptCount: payload.attemptCount + 2,
      updatedAt: new Date(0),
      beforeExecutionUpdate: () => {
        if (failTerminalization) {
          failTerminalization = false
          throw new Error("temporary DB failure")
        }
      },
    })
    fake.state.outbox[0]!.payload = rawPayload
    fake.state.outbox[0]!.idempotencyKey = rawKey
    fake.state.questions[0]!.id = rawPayload.questionId
    fake.state.turns = []
    fake.state.executions[0]!.workerTaskId = rawJobId
    const marker = legacyResumeTerminalizationFailure("authorization_revoked", new Error("temporary DB failure")).message
    const retained = job({ state: "failed", attemptsMade: 3, failedReason: marker, data: rawPayload })
    const q = queue(retained)

    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 50, now))
      .rejects.toThrow("temporary DB failure")
    expect(fake.state.executions[0]?.status).toBe("running")

    fake.state.turns.push({
      id: "unrelated_turn",
      sessionId: payload.sessionId,
      userId: payload.userId,
      status: "in_progress",
    })
    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 50, now + 16_000))
      .resolves.toBe(1)

    expect(fake.state.executions[0]?.status).toBe("failed")
    expect(fake.state.outbox[0]?.publishedAt).toBeInstanceOf(Date)
    expect(retained.retry).not.toHaveBeenCalled()
    await expect(reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 50, now + 32_000))
      .resolves.toBe(0)
    expect(q.getJob).toHaveBeenCalledTimes(2)
  })
  it("does not terminalize stale-running legacy work when its attempt or Turn is mismatched", async () => {
    const now = Date.now()
    const wrongAttempt = fixtures({ status: "running", attemptCount: payload.attemptCount, updatedAt: new Date(0) })
    const wrongAttemptJob = job({ state: "failed", attemptsMade: 3 })
    await expect(reconcilePublishedAgentExecutionDispatches(wrongAttempt.pool as never,
      queue(wrongAttemptJob) as unknown as DispatchJobQueue, 50, now)).resolves.toBe(0)
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()
    expect(wrongAttemptJob.retry).not.toHaveBeenCalled()

    const wrongTurn = fixtures({ status: "running", attemptCount: payload.attemptCount + 2, updatedAt: new Date(0) })
    wrongTurn.state.turns[0]!.status = "in_progress"
    const wrongTurnJob = job({ state: "failed", attemptsMade: 3 })
    vi.mocked(failTurnScopedLegacyResume).mockResolvedValue(false)
    await expect(reconcilePublishedAgentExecutionDispatches(wrongTurn.pool as never,
      queue(wrongTurnJob) as unknown as DispatchJobQueue, 50, now)).resolves.toBe(0)
    expect(failTurnScopedLegacyResume).toHaveBeenCalledWith(wrongTurn.pool, expect.objectContaining({
      staleRunning: expect.objectContaining({ attemptCount: payload.attemptCount + 2 }),
    }))
    expect(wrongTurnJob.retry).not.toHaveBeenCalled()
  })

  it("defers a fresh running job and retries completed stale work through the same task ID", async () => {
    const now = Date.now()
    const fresh = fixtures({ status: "running", attemptCount: payload.attemptCount + 3, updatedAt: new Date(now) })
    const exhausted = job({ state: "failed", attemptsMade: 3 })
    vi.mocked(failTurnScopedLegacyResume).mockResolvedValue(false)

    await expect(reconcilePublishedAgentExecutionDispatches(fresh.pool as never, queue(exhausted) as unknown as DispatchJobQueue, 50, now)).resolves.toBe(0)
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()
    expect(exhausted.retry).not.toHaveBeenCalled()

    const unsafe = fixtures({ status: "running", attemptCount: Number.MAX_SAFE_INTEGER, updatedAt: new Date(0) })
    const unsafeJob = job({ state: "failed", attemptsMade: 3 })
    await expect(reconcilePublishedAgentExecutionDispatches(unsafe.pool as never, queue(unsafeJob) as unknown as DispatchJobQueue, 50, now)).resolves.toBe(0)
    expect(unsafeJob.retry).not.toHaveBeenCalled()

    const stale = fixtures({ status: "running", attemptCount: payload.attemptCount + 3, updatedAt: new Date(0) })
    const staleJob = job({ state: "completed", attemptsMade: 3 })
    const staleQueue = queue(staleJob)
    await expect(reconcilePublishedAgentExecutionDispatches(stale.pool as never, staleQueue as unknown as DispatchJobQueue, 50, now)).resolves.toBe(1)
    expect(failTurnScopedLegacyResume).not.toHaveBeenCalled()
    expect(staleJob.retry).toHaveBeenCalledWith("completed", expect.objectContaining({ resetAttemptsMade: true, resetAttemptsStarted: true }))
    await expect(reconcilePublishedAgentExecutionDispatches(stale.pool as never, staleQueue as unknown as DispatchJobQueue, 50, now + 1_000)).resolves.toBe(0)
    expect(staleQueue.getJob).toHaveBeenCalledTimes(2)
  })

  it("rotates through published rows in bounded batches", async () => {
    const fake = fixtures()
    const original = fake.state.outbox[0]!
    original.idempotencyKey = "invalid"
    for (let index = 2; index <= 55; index += 1) fake.state.outbox.push({
      ...original, id: `intent_${String(index).padStart(3, "0")}`,
      idempotencyKey: `key_${index}`,
    })
    const q = queue(undefined)
    const first = await reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 500, Date.now())
    expect(first).toBe(0)
    const secondCall = await reconcilePublishedAgentExecutionDispatches(fake.pool as never, q as unknown as DispatchJobQueue, 500, Date.now())
    expect(secondCall).toBe(0)
    expect(q.getJob).toHaveBeenCalledTimes(0)
    const scans = fake.calls.filter(call => call.sql.includes('FROM "agent_outbox"'))
    expect(scans[0]?.values).toEqual([AGENT_EXECUTION_DISPATCH_TOPIC, null, 50])
    expect(scans[1]?.values).toEqual([AGENT_EXECUTION_DISPATCH_TOPIC, "intent_050", 50])
  })
})
