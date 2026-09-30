import { describe, expect, it, vi } from "vitest"

import type { AgentRunTaskPayload } from "./agent-run-queue.js"
import type { LeasePool } from "../runtime/turns/lease.js"
import { failTurnScopedLegacyResume } from "./agent-run-legacy-terminal-failure.js"
import {
  enqueueOrRecoverAgentRunJob,
  terminalizeExhaustedAgentRunDispatch,
} from "./agent-execution-dispatch-job-recovery.js"

vi.mock("./agent-run-legacy-terminal-failure.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-run-legacy-terminal-failure.js")>("./agent-run-legacy-terminal-failure.js")
  return { ...actual, failTurnScopedLegacyResume: vi.fn() }
})

const payload = {
  userId: "user_1",
  sessionId: "session_1",
  executionId: "execution_1",
  attemptCount: 4,
  questionId: "agent-question:turn_1:legacy:question_1",
  legacyTurnId: "turn_1",
} satisfies AgentRunTaskPayload & { executionId: string; attemptCount: number }
const jobId = "agent-execution-dispatch-abc123"

function makeQueue(
  state: string | null,
  data = payload,
  options: { attemptsMade?: number; attempts?: number; failedReason?: string } = {},
) {
  let currentState = state
  const job = {
    data,
    attemptsMade: options.attemptsMade ?? 0,
    opts: { attempts: options.attempts ?? 3 },
    failedReason: options.failedReason ?? "",
    getState: vi.fn(async () => currentState ?? "unknown"),
    retry: vi.fn(async () => { currentState = "waiting"; job.attemptsMade = 0 }),
  }
  const queue = {
    getJob: vi.fn(async () => currentState === null ? undefined : job),
    add: vi.fn(async () => job),
  }
  return { queue, job }
}

describe("agent execution dispatch job recovery", () => {
  it("adds a missing stable job with the dispatch retry policy", async () => {
    const { queue } = makeQueue(null)
    await enqueueOrRecoverAgentRunJob(queue as never, jobId, payload)

    expect(queue.add).toHaveBeenCalledWith("run", payload, expect.objectContaining({
      jobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 60_000 },
    }))
  })

  it("returns an exhausted retained failed job without resetting its retry budget", async () => {
    const { queue, job } = makeQueue("failed", payload, { attemptsMade: 3, attempts: 3, failedReason: "terminal marker" })
    await expect(enqueueOrRecoverAgentRunJob(queue as never, jobId, payload)).resolves.toEqual({
      kind: "exhausted", failedReason: "terminal marker",
    })

    expect(job.retry).not.toHaveBeenCalled()
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("recovers a fresh failed job while preserving the configured attempt budget", async () => {
    const { queue, job } = makeQueue("failed", payload, { attemptsMade: 2, attempts: 3 })
    await expect(enqueueOrRecoverAgentRunJob(queue as never, jobId, payload)).resolves.toEqual({ kind: "runnable" })

    expect(job.retry).toHaveBeenCalledWith("failed", { resetAttemptsMade: true, resetAttemptsStarted: true })
    expect(job.attemptsMade).toBe(0)
  })

  it("recovers a retained completed job when its exact execution is still queued", async () => {
    const { queue, job } = makeQueue("completed")
    await enqueueOrRecoverAgentRunJob(queue as never, jobId, payload)

    expect(job.retry).toHaveBeenCalledWith("completed", { resetAttemptsMade: true, resetAttemptsStarted: true })
  })

  it("accepts a concurrent retry only after observing a nonterminal BullMQ state", async () => {
    const { queue, job } = makeQueue("failed")
    job.retry.mockImplementationOnce(async () => { throw new Error("already retried") })
    job.getState.mockImplementationOnce(async () => "failed").mockImplementationOnce(async () => "active")

    await expect(enqueueOrRecoverAgentRunJob(queue as never, jobId, payload)).resolves.toEqual({ kind: "runnable" })
  })

  it("leaves the intent retryable if a racing failure remains terminal", async () => {
    const { queue, job } = makeQueue("failed")
    job.retry.mockImplementationOnce(async () => { throw new Error("Redis unavailable") })
    job.getState.mockImplementation(async () => "failed")

    await expect(enqueueOrRecoverAgentRunJob(queue as never, jobId, payload)).rejects.toThrow("Redis unavailable")
  })

  it("refuses a deterministic job ID whose stored payload has different ownership", async () => {
    const { queue, job } = makeQueue("failed", { ...payload, userId: "other_user" })

    await expect(enqueueOrRecoverAgentRunJob(queue as never, jobId, payload))
      .rejects.toThrow("agent_execution_dispatch_job_scope_mismatch")
    expect(job.retry).not.toHaveBeenCalled()
  })

  it("fences retries by exact question and legacy Turn identity", async () => {
    const changedPayloads = [
      { ...payload, questionId: "agent-question:turn_1:legacy:other_question" },
      { ...payload, legacyTurnId: "turn_other" },
    ]
    for (const storedPayload of changedPayloads) {
      const { queue, job } = makeQueue("failed", storedPayload)
      await expect(enqueueOrRecoverAgentRunJob(queue as never, jobId, payload))
        .rejects.toThrow("agent_execution_dispatch_job_scope_mismatch")
      expect(job.retry).not.toHaveBeenCalled()
    }
  })

  it("delegates a Turn-scoped exhausted failure to the event-writing terminalizer", async () => {
    const context = {
      payload: { ...payload },
      jobId,
      legacyTurnId: "turn_1",
    }
    vi.mocked(failTurnScopedLegacyResume).mockReset().mockResolvedValueOnce(false)

    await expect(terminalizeExhaustedAgentRunDispatch({} as LeasePool, context, "authorization_revoked"))
      .resolves.toBe(false)

    expect(failTurnScopedLegacyResume).toHaveBeenCalledWith({}, {
      ...payload, workerTaskId: jobId, legacyTurnId: "turn_1", reason: "authorization_revoked",
    })
  })

  it("terminalizes an unnamespaced failure only while session, question, no-active-Turn and exact execution fences hold", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        calls.push({ sql, values })
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SELECT set_config(")) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_sessions" AS session')) {
          return { rows: [{ id: payload.sessionId, userId: payload.userId, status: "running" }], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_turns" AS turn') && sql.includes("ANY($3::text[])")) {
          return { rows: [], rowCount: 0 }
        }
        if (sql.includes('FROM "AgentRunQuestion" AS question')) {
          return { rows: [{ id: payload.questionId, answer: "keep_resume" }], rowCount: 1 }
        }
        if (sql.startsWith('UPDATE "agent_executions"')) return { rows: [], rowCount: 1 }
        throw new Error(`Unhandled terminalization SQL: ${sql}`)
      }),
      release: vi.fn(),
    }
    const context = {
      row: { id: "outbox_1", aggregateId: payload.sessionId },
      payload: { ...payload, questionId: "question_1" },
      jobId,
    }

    await expect(terminalizeExhaustedAgentRunDispatch(
      { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool,
      context,
      "retry_exhausted",
    )).resolves.toBe(true)

    const update = calls.find(call => call.sql.startsWith('UPDATE "agent_executions"'))
    expect(update?.sql).toContain('"attemptCount" = $4 AND "workerTaskId" = $5 AND "status" = \'queued\'')
    expect(update?.values).toEqual([payload.executionId, payload.userId, payload.sessionId, payload.attemptCount, jobId,
      "This agent run could not start after retrying. Please try again."])
  })

  it("does not fail an unnamespaced execution after a canonical Turn races into the session", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SELECT set_config(")) {
          return { rows: [], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_sessions" AS session')) {
          return { rows: [{ id: payload.sessionId, userId: payload.userId, status: "running" }], rowCount: 1 }
        }
        if (sql.includes('FROM "agent_turns" AS turn') && sql.includes("ANY($3::text[])")) {
          return { rows: [{ id: "turn_new" }], rowCount: 1 }
        }
        throw new Error(`Unexpected terminalization SQL: ${sql}`)
      }),
      release: vi.fn(),
    }

    await expect(terminalizeExhaustedAgentRunDispatch(
      { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool,
      { payload: { ...payload, questionId: "question_1" }, jobId },
      "retry_exhausted",
    )).resolves.toBe(false)

    expect(calls.some(sql => sql.startsWith('UPDATE "agent_executions"'))).toBe(false)
    expect(client.query).toHaveBeenCalledWith("COMMIT")
  })
})
