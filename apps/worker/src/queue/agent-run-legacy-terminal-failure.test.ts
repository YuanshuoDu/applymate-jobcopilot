import { describe, expect, it, vi } from "vitest"
import type pg from "pg"

import { failStaleUnnamespacedLegacyResume, failTurnScopedLegacyResume, type LegacyResumeFailureInput, type UnnamespacedLegacyResumeFailureInput } from "./agent-run-legacy-terminal-failure.js"

const input: LegacyResumeFailureInput = {
  userId: "user_1",
  sessionId: "session_1",
  executionId: "execution_1",
  attemptCount: 4,
  workerTaskId: "dispatch-job-1",
  questionId: "agent-question:turn_1:legacy:question_1",
  legacyTurnId: "turn_1",
  reason: "authorization_revoked",
}

type Call = { sql: string; values?: readonly unknown[] }
type StoredEvent = Record<string, unknown>
type StoredOutbox = Record<string, unknown>
type State = {
  sessionStatus: string
  eventSequence: bigint
  turnStatus: string
  turnRevision: number
  turnError: string | null
  turnCompletedAt: boolean
  executionStatus: string
  executionAttempt: number
  executionTaskId: string | null
  executionUpdatedAt: Date
  executionCheckpoint: string
  executionError: string | null
  executionCompletedAt: boolean
  questionId: string
  questionAnswer: string | null
  events: StoredEvent[]
  outbox: StoredOutbox[]
}
type Options = Partial<Pick<State,
  "sessionStatus" | "turnStatus" | "executionStatus" | "executionAttempt" | "executionTaskId" | "executionUpdatedAt" | "questionId" | "questionAnswer"
>>

class FakeClient {
  readonly calls: Call[] = []
  readonly client = this as unknown as pg.PoolClient
  readonly state: State
  failOn: string | null = null
  executionFenceMiss = false
  private snapshot: State | null = null

  constructor(options: Options = {}) {
    this.state = {
      sessionStatus: options.sessionStatus ?? "running",
      eventSequence: 7n,
      turnStatus: options.turnStatus ?? "waiting_for_user",
      turnRevision: 2,
      turnError: null,
      turnCompletedAt: false,
      executionStatus: options.executionStatus ?? "queued",
      executionAttempt: options.executionAttempt ?? input.attemptCount,
      executionTaskId: options.executionTaskId === undefined ? input.workerTaskId : options.executionTaskId,
      executionUpdatedAt: options.executionUpdatedAt ?? new Date(0),
      executionCheckpoint: "prepare",
      executionError: null,
      executionCompletedAt: false,
      questionId: options.questionId ?? input.questionId,
      questionAnswer: options.questionAnswer === undefined ? "keep_resume" : options.questionAnswer,
      events: [],
      outbox: [],
    }
  }

  async query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    this.calls.push({ sql, values })
    if (this.failOn && sql.includes(this.failOn)) throw new Error("injected database failure")
    if (sql === "BEGIN") {
      this.snapshot = structuredClone(this.state)
      return { rows: [], rowCount: 0 }
    }
    if (sql === "COMMIT" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
    if (sql === "ROLLBACK") {
      if (this.snapshot) Object.assign(this.state, structuredClone(this.snapshot))
      this.snapshot = null
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === input.sessionId && values?.[1] === input.userId
      const open = !["aborted", "archived"].includes(this.state.sessionStatus)
      return result<T>(owned && open ? [{ id: input.sessionId, status: this.state.sessionStatus }] : [])
    }
    if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === input.legacyTurnId && values?.[1] === input.sessionId && values?.[2] === input.userId
      return result<T>(owned ? [{ id: input.legacyTurnId, status: this.state.turnStatus }] : [])
    }
    if (sql.includes('FROM "AgentRunQuestion"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === this.state.questionId && values?.[0] === input.questionId &&
        values?.[1] === input.userId && values?.[2] === input.sessionId
      return result<T>(owned ? [{ id: this.state.questionId, answer: this.state.questionAnswer }] : [])
    }
    if (sql.includes('FROM "agent_executions"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === input.executionId && values?.[1] === input.sessionId && values?.[2] === input.userId
      return result<T>(owned ? [{ id: input.executionId, status: this.state.executionStatus, attemptCount: this.state.executionAttempt,
        workerTaskId: this.state.executionTaskId, updatedAt: this.state.executionUpdatedAt }] : [])
    }
    if (sql.startsWith('UPDATE "agent_executions"')) {
      const staleRunning = sql.includes('"status" = \'running\'')
      const staleBefore = staleRunning ? values?.[6] as Date : undefined
      const expectedAttempt = values?.[3]
      const matches = values?.[0] === input.executionId && values?.[1] === input.sessionId && values?.[2] === input.userId &&
        this.state.executionAttempt === expectedAttempt && values?.[5] === input.workerTaskId && this.state.executionTaskId === input.workerTaskId &&
        !this.executionFenceMiss &&
        (staleRunning
          ? this.state.executionStatus === "running" && staleBefore instanceof Date && this.state.executionUpdatedAt.getTime() < staleBefore.getTime()
          : expectedAttempt === input.attemptCount && this.state.executionStatus === "queued")
      if (matches) {
        this.state.executionStatus = "failed"
        this.state.executionCheckpoint = "failed"
        this.state.executionError = String(values?.[4])
        this.state.executionCompletedAt = true
      }
      return { rows: [], rowCount: matches ? 1 : 0 }
    }
    if (sql.startsWith('UPDATE "agent_turns"')) {
      const matches = values?.[0] === input.legacyTurnId && values?.[1] === input.sessionId && values?.[2] === input.userId &&
        this.state.turnStatus === values?.[4]
      if (matches) {
        this.state.turnStatus = "failed"
        this.state.turnError = String(values?.[3])
        this.state.turnRevision += 1
        this.state.turnCompletedAt = true
      }
      return { rows: [], rowCount: matches ? 1 : 0 }
    }
    if (sql.startsWith('UPDATE "agent_sessions"')) {
      this.state.eventSequence += 1n
      return { rows: [{ eventSequence: this.state.eventSequence } as T], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_events"')) {
      this.state.events.push({
        id: values?.[0], sessionId: values?.[1], turnId: values?.[2], sequence: values?.[3],
        type: "turn.failed", actor: "orchestrator", correlationId: values?.[2], causationId: null,
        idempotencyKey: values?.[4], payload: JSON.parse(String(values?.[5])) as unknown,
      })
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) {
      const duplicate = this.state.outbox.some(row => row.idempotencyKey === values?.[3])
      if (!duplicate) this.state.outbox.push({
        id: values?.[0], topic: values?.[1], aggregateId: values?.[2], idempotencyKey: values?.[3],
        payload: JSON.parse(String(values?.[4])) as unknown,
      })
      return { rows: [], rowCount: duplicate ? 0 : 1 }
    }
    if (sql.includes('FROM "agent_outbox"') && sql.includes("FOR UPDATE")) {
      return result<T>(this.state.outbox.filter(row => row.idempotencyKey === values?.[0]))
    }
    throw new Error(`Unhandled SQL: ${sql}`)
  }

  release(): void {}
}

function result<T>(rows: unknown[]) {
  return { rows: rows as T[], rowCount: rows.length }
}

function poolFor(client: FakeClient): Pick<pg.Pool, "connect"> {
  return { connect: vi.fn(async () => client.client) }
}

describe("Worker legacy Turn terminal failure", () => {
  it("fails the exact queued attempt and waiting Turn with one sequenced event/outbox", async () => {
    const client = new FakeClient()
    const queuedAuthorization = { ...input, staleRunning: { staleBefore: new Date(1_000) } }
    const failed = await failTurnScopedLegacyResume(poolFor(client), queuedAuthorization)

    expect(failed).toBe(true)
    expect(client.state.executionStatus).toBe("failed")
    expect(client.state.executionCheckpoint).toBe("failed")
    expect(client.state.executionTaskId).toBe(input.workerTaskId)
    expect(client.state.executionError).toBe("Authorization was revoked before this agent run started.")
    expect(client.state.turnStatus).toBe("failed")
    expect(client.state.turnRevision).toBe(3)
    expect(client.state.turnError).toBe(client.state.executionError)
    expect(client.state.eventSequence).toBe(8n)
    expect(client.state.events).toHaveLength(1)
    expect(client.state.events[0]).toMatchObject({
      sessionId: input.sessionId, turnId: input.legacyTurnId, sequence: "8",
      type: "turn.failed", actor: "orchestrator",
      idempotencyKey: `legacy-turn-worker-terminal-failed:${input.workerTaskId}:authorization_revoked`,
      payload: { turnId: input.legacyTurnId, reason: "worker_authorization_revoked", message: client.state.executionError },
    })
    expect(client.state.outbox).toHaveLength(1)
    expect(client.state.outbox[0]).toMatchObject({
      topic: "agent.session.event", aggregateId: input.sessionId, idempotencyKey: `agent-event:${client.state.events[0]?.id}`,
      payload: { eventId: client.state.events[0]?.id, type: "turn.failed", sequence: "8" },
    })
    const lockOrder = [
      client.calls.findIndex(call => call.sql.includes('FROM "agent_sessions"') && call.sql.includes("FOR UPDATE")),
      client.calls.findIndex(call => call.sql.includes('FROM "agent_turns"') && call.sql.includes("FOR UPDATE")),
      client.calls.findIndex(call => call.sql.includes('FROM "AgentRunQuestion"') && call.sql.includes("FOR UPDATE")),
      client.calls.findIndex(call => call.sql.includes('FROM "agent_executions"') && call.sql.includes("FOR UPDATE")),
    ]
    expect(lockOrder.every(index => index >= 0)).toBe(true)
    expect(lockOrder).toEqual([...lockOrder].sort((a, b) => a - b))
    expect(client.calls.some(call => call.sql === "COMMIT")).toBe(true)
  })

  it("uses a stable retry-exhaustion key and a safe visible failure", async () => {
    const client = new FakeClient()
    await expect(failTurnScopedLegacyResume(poolFor(client), { ...input, reason: "retry_exhausted" })).resolves.toBe(true)

    expect(client.state.executionError).toBe("This agent run could not start after retrying. Please try again.")
    expect(client.state.events[0]).toMatchObject({
      idempotencyKey: `legacy-turn-worker-terminal-failed:${input.workerTaskId}:retry_exhausted`,
      payload: { reason: "worker_retry_exhausted" },
    })
  })

  it("terminalizes only the exact stale-running reclaim below the configured cutoff", async () => {
    const staleRunning = { staleBefore: new Date(1_000) }
    const claimedAttempt = input.attemptCount + 2
    const stale = new FakeClient({
      turnStatus: "in_progress", executionStatus: "running", executionAttempt: claimedAttempt, executionUpdatedAt: new Date(0),
    })
    const failure = { ...input, staleRunning }
    await expect(failTurnScopedLegacyResume(poolFor(stale), failure)).resolves.toBe(true)
    expect(stale.state.executionStatus).toBe("failed")
    expect(stale.state.turnStatus).toBe("failed")
    expect(stale.state.events[0]).toMatchObject({
      idempotencyKey: `legacy-turn-worker-terminal-failed:${input.workerTaskId}:authorization_revoked`,
      payload: { reason: "worker_authorization_revoked" },
    })
    expect(stale.state.outbox).toHaveLength(1)
    const eventCount = stale.state.events.length
    const outboxCount = stale.state.outbox.length
    await expect(failTurnScopedLegacyResume(poolFor(stale), failure)).resolves.toBe(false)
    expect(stale.state.events).toHaveLength(eventCount)
    expect(stale.state.outbox).toHaveLength(outboxCount)
    expect(stale.calls.find(call => call.sql.startsWith('UPDATE "agent_turns"'))?.values?.[4]).toBe("in_progress")
    const executionUpdate = stale.calls.find(call => call.sql.startsWith('UPDATE "agent_executions"'))
    expect(executionUpdate?.sql).toContain('"status" = \'running\' AND "updatedAt" < $7')
    expect(executionUpdate?.values).toEqual([
      input.executionId, input.sessionId, input.userId, claimedAttempt,
      "Authorization was revoked before this agent run started.", input.workerTaskId, staleRunning.staleBefore,
    ])

    const mismatched: Array<{ client: FakeClient; failure: LegacyResumeFailureInput }> = [
      { client: new FakeClient({ turnStatus: "in_progress", executionStatus: "running", executionAttempt: claimedAttempt, executionUpdatedAt: staleRunning.staleBefore }), failure: { ...input, staleRunning } },
      { client: new FakeClient({ turnStatus: "in_progress", executionStatus: "running", executionAttempt: input.attemptCount, executionUpdatedAt: new Date(0) }), failure: { ...input, staleRunning } },
      { client: new FakeClient({ turnStatus: "in_progress", executionStatus: "running", executionAttempt: input.attemptCount - 1, executionUpdatedAt: new Date(0) }), failure: { ...input, staleRunning } },
      { client: new FakeClient({ turnStatus: "in_progress", executionStatus: "running", executionAttempt: claimedAttempt, executionTaskId: "other-job", executionUpdatedAt: new Date(0) }), failure: { ...input, staleRunning } },
      { client: new FakeClient({ turnStatus: "waiting_for_user", executionStatus: "running", executionAttempt: claimedAttempt, executionUpdatedAt: new Date(0) }), failure: { ...input, staleRunning } },
      { client: new FakeClient({ turnStatus: "in_progress", executionStatus: "running", executionAttempt: claimedAttempt, executionUpdatedAt: new Date(1_001) }), failure: { ...input, staleRunning } },
      { client: new FakeClient({ turnStatus: "in_progress", executionStatus: "queued", executionAttempt: input.attemptCount, executionUpdatedAt: new Date(0) }), failure: { ...input, staleRunning } },
      { client: new FakeClient(), failure: { ...input, userId: "other_user", staleRunning } },
      { client: new FakeClient(), failure: { ...input, sessionId: "other_session", staleRunning } },
      { client: new FakeClient(), failure: { ...input, questionId: "agent-question:turn_1:legacy:other", staleRunning } },
      { client: new FakeClient({ turnStatus: "waiting_for_user", executionStatus: "queued", executionAttempt: input.attemptCount }), failure: { ...input, reason: "retry_exhausted", staleRunning } },
    ]
    for (const { client, failure } of mismatched) {
      await expect(failTurnScopedLegacyResume(poolFor(client), failure)).resolves.toBe(false)
      expect(client.state.executionStatus).not.toBe("failed")
      expect(client.state.turnStatus).not.toBe("failed")
      expect(client.state.events).toHaveLength(0)
      expect(client.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
    }

    const raced = new FakeClient({
      turnStatus: "in_progress", executionStatus: "running", executionAttempt: claimedAttempt, executionUpdatedAt: new Date(0),
    })
    raced.executionFenceMiss = true
    await expect(failTurnScopedLegacyResume(poolFor(raced), failure)).resolves.toBe(false)
    expect(raced.state.executionStatus).toBe("running")
    expect(raced.state.turnStatus).toBe("in_progress")
    expect(raced.state.events).toHaveLength(0)
    expect(raced.state.outbox).toHaveLength(0)
  })

  it("terminalizes the exact stale-running linked Turn when retries are exhausted", async () => {
    const staleRunning = { staleBefore: new Date(1_000) }
    const currentAttempt = input.attemptCount + 2
    const client = new FakeClient({
      turnStatus: "in_progress", executionStatus: "running", executionAttempt: currentAttempt, executionUpdatedAt: new Date(0),
    })

    await expect(failTurnScopedLegacyResume(poolFor(client), { ...input, reason: "retry_exhausted", staleRunning })).resolves.toBe(true)

    expect(client.state.executionStatus).toBe("failed")
    expect(client.state.executionError).toBe("This agent run could not start after retrying. Please try again.")
    expect(client.state.turnStatus).toBe("failed")
    expect(client.state.events).toHaveLength(1)
    expect(client.state.events[0]).toMatchObject({
      idempotencyKey: "legacy-turn-worker-terminal-failed:" + input.workerTaskId + ":retry_exhausted",
      payload: { turnId: input.legacyTurnId, reason: "worker_retry_exhausted" },
    })
    expect(client.state.outbox).toHaveLength(1)
    expect(client.calls.find(call => call.sql.startsWith('UPDATE "agent_turns"'))?.values?.[4]).toBe("in_progress")
    expect(client.calls.find(call => call.sql.startsWith('UPDATE "agent_executions"'))?.values).toEqual([
      input.executionId, input.sessionId, input.userId, currentAttempt,
      "This agent run could not start after retrying. Please try again.", input.workerTaskId, staleRunning.staleBefore,
    ])
  })
  it("closes third and later stale reclaims using the dispatch attempt as a lower bound", async () => {
    const staleRunning = { staleBefore: new Date(1_000) }
    const currentAttempt = input.attemptCount + 3
    const client = new FakeClient({
      turnStatus: "in_progress", executionStatus: "running", executionAttempt: currentAttempt, executionUpdatedAt: new Date(0),
    })

    await expect(failTurnScopedLegacyResume(poolFor(client), { ...input, staleRunning })).resolves.toBe(true)

    expect(client.state.executionStatus).toBe("failed")
    expect(client.state.turnStatus).toBe("failed")
    expect(client.state.events).toHaveLength(1)
    expect(client.state.outbox).toHaveLength(1)
    expect(client.calls.find(call => call.sql.startsWith('UPDATE "agent_executions"'))?.values?.[3]).toBe(currentAttempt)
  })
  it("does not touch a Turn that Stop already interrupted", async () => {
    const client = new FakeClient({ turnStatus: "interrupted" })
    await expect(failTurnScopedLegacyResume(poolFor(client), input)).resolves.toBe(false)

    expect(client.state.executionStatus).toBe("queued")
    expect(client.state.events).toHaveLength(0)
    expect(client.state.outbox).toHaveLength(0)
    expect(client.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })

  it("does not touch a claimed or different execution attempt/task", async () => {
    for (const options of [
      { executionStatus: "running" },
      { executionStatus: "running", executionAttempt: input.attemptCount + 3 },
      { executionAttempt: input.attemptCount + 1 },
      { executionStatus: "running", executionAttempt: input.attemptCount + 3, executionTaskId: "other-job" },
      { executionTaskId: "other-job" },
    ]) {
      const client = new FakeClient(options)
      await expect(failTurnScopedLegacyResume(poolFor(client), input)).resolves.toBe(false)
      expect(client.state.turnStatus).toBe("waiting_for_user")
      expect(client.state.events).toHaveLength(0)
      expect(client.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
    }
  })

  it("rejects an unanswered, mismatched, or non-namespaced legacy question without writes", async () => {
    const cases = [
      { options: { questionAnswer: null }, questionId: input.questionId, legacyTurnId: input.legacyTurnId },
      { options: { questionId: "another-question" }, questionId: input.questionId, legacyTurnId: input.legacyTurnId },
      { options: {}, questionId: "agent-question:turn_1:canonical:question_1", legacyTurnId: input.legacyTurnId },
      { options: {}, questionId: input.questionId, legacyTurnId: "turn_other" },
    ]
    for (const testCase of cases) {
      const client = new FakeClient(testCase.options)
      await expect(failTurnScopedLegacyResume(poolFor(client), {
        ...input, questionId: testCase.questionId, legacyTurnId: testCase.legacyTurnId,
      })).resolves.toBe(false)
      expect(client.state.executionStatus).toBe("queued")
      expect(client.state.events).toHaveLength(0)
      expect(client.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
    }
  })

  it("is a no-op on repeat after terminalization", async () => {
    const client = new FakeClient()
    await expect(failTurnScopedLegacyResume(poolFor(client), input)).resolves.toBe(true)
    const eventCount = client.state.events.length
    const outboxCount = client.state.outbox.length

    await expect(failTurnScopedLegacyResume(poolFor(client), input)).resolves.toBe(false)

    expect(client.state.events).toHaveLength(eventCount)
    expect(client.state.outbox).toHaveLength(outboxCount)
  })

  it("rolls back execution and Turn terminalization if event outbox persistence fails", async () => {
    const client = new FakeClient()
    client.failOn = 'INSERT INTO "agent_outbox"'

    await expect(failTurnScopedLegacyResume(poolFor(client), input)).rejects.toThrow("injected database failure")

    expect(client.state.executionStatus).toBe("queued")
    expect(client.state.turnStatus).toBe("waiting_for_user")
    expect(client.state.eventSequence).toBe(7n)
    expect(client.state.events).toHaveLength(0)
    expect(client.state.outbox).toHaveLength(0)
    expect(client.calls.some(call => call.sql === "ROLLBACK")).toBe(true)
  })
})

const unnamespacedInput: UnnamespacedLegacyResumeFailureInput = {
  userId: "user_1",
  sessionId: "session_1",
  executionId: "execution_1",
  attemptCount: 4,
  workerTaskId: "dispatch-job-1",
  questionId: "legacy-question-1",
  reason: "authorization_revoked",
  staleBefore: new Date(1_000),
}

type RawExecutionState = {
  sessionStatus: string
  activeTurn: boolean
  questionId: string
  questionAnswer: string | null
  executionStatus: string
  executionAttempt: number
  executionTaskId: string | null
  executionUpdatedAt: Date
}

type RawExecutionOptions = Partial<RawExecutionState> & {
  beforeExecutionUpdate?: (state: RawExecutionState) => void
}

class RawResumeFailureClient {
  readonly calls: Call[] = []
  readonly client = this as unknown as pg.PoolClient
  readonly state: RawExecutionState
  private readonly beforeExecutionUpdate?: (state: RawExecutionState) => void

  constructor(options: RawExecutionOptions = {}) {
    this.state = {
      sessionStatus: options.sessionStatus ?? "running",
      activeTurn: options.activeTurn ?? false,
      questionId: options.questionId ?? unnamespacedInput.questionId,
      questionAnswer: options.questionAnswer === undefined ? "keep_resume" : options.questionAnswer,
      executionStatus: options.executionStatus ?? "running",
      executionAttempt: options.executionAttempt ?? unnamespacedInput.attemptCount + 3,
      executionTaskId: options.executionTaskId === undefined ? unnamespacedInput.workerTaskId : options.executionTaskId,
      executionUpdatedAt: options.executionUpdatedAt ?? new Date(0),
    }
    this.beforeExecutionUpdate = options.beforeExecutionUpdate
  }

  async query<T>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[]; rowCount: number | null }> {
    this.calls.push({ sql, values })
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return result<T>([])
    if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === unnamespacedInput.sessionId && values?.[1] === unnamespacedInput.userId
      const open = !["aborted", "archived"].includes(this.state.sessionStatus)
      return result<T>(owned && open ? [{ id: unnamespacedInput.sessionId, status: this.state.sessionStatus }] : [])
    }
    if (sql.includes('FROM "agent_turns"') && sql.includes('= ANY($3::text[])')) {
      return result<T>(this.state.activeTurn ? [{ id: "active_turn" }] : [])
    }
    if (sql.includes('FROM "AgentRunQuestion"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === this.state.questionId && values?.[1] === unnamespacedInput.userId &&
        values?.[2] === unnamespacedInput.sessionId
      return result<T>(owned ? [{ id: this.state.questionId, answer: this.state.questionAnswer }] : [])
    }
    if (sql.includes('FROM "agent_executions"') && sql.includes("FOR UPDATE")) {
      const owned = values?.[0] === unnamespacedInput.executionId && values?.[1] === unnamespacedInput.sessionId &&
        values?.[2] === unnamespacedInput.userId
      return result<T>(owned ? [{ id: unnamespacedInput.executionId, status: this.state.executionStatus,
        attemptCount: this.state.executionAttempt, workerTaskId: this.state.executionTaskId,
        updatedAt: this.state.executionUpdatedAt }] : [])
    }
    if (sql.startsWith('UPDATE "agent_executions"')) {
      this.beforeExecutionUpdate?.(this.state)
      const staleBefore = values?.[5] as Date
      const matches = values?.[0] === unnamespacedInput.executionId && values?.[1] === unnamespacedInput.sessionId &&
        values?.[2] === unnamespacedInput.userId && values?.[3] === this.state.executionAttempt &&
        values?.[4] === this.state.executionTaskId && values?.[4] === unnamespacedInput.workerTaskId &&
        this.state.executionStatus === "running" && staleBefore instanceof Date &&
        this.state.executionUpdatedAt.getTime() < staleBefore.getTime()
      if (matches) this.state.executionStatus = "failed"
      return result<T>(matches ? [{ id: unnamespacedInput.executionId }] : [])
    }
    throw new Error(`Unhandled raw resume SQL: ${sql}`)
  }

  release(): void {}
}

function rawPoolFor(client: RawResumeFailureClient): Pick<pg.Pool, "connect"> {
  return { connect: vi.fn(async () => client.client) }
}

describe("Worker unnamespaced stale legacy resume failure", () => {
  it("fails the exact stale-running attempt after authorization is revoked", async () => {
    const client = new RawResumeFailureClient()

    await expect(failStaleUnnamespacedLegacyResume(rawPoolFor(client), unnamespacedInput)).resolves.toBe(true)

    expect(client.state.executionStatus).toBe("failed")
    const update = client.calls.find(call => call.sql.startsWith('UPDATE "agent_executions"'))
    expect(update?.sql).toContain('"attemptCount" = $4')
    expect(update?.sql).toContain('"workerTaskId" = $5 AND "status" = \'running\' AND "updatedAt" < $6')
    expect(update?.values).toEqual([
      unnamespacedInput.executionId, unnamespacedInput.sessionId, unnamespacedInput.userId,
      unnamespacedInput.attemptCount + 3, unnamespacedInput.workerTaskId, unnamespacedInput.staleBefore,
      "Authorization was revoked before this agent run started.",
    ])
    expect(client.calls.some(call => call.sql.includes('FROM "AgentRunQuestion"') && call.sql.includes("FOR UPDATE"))).toBe(true)
  })

  it.each([
    ["fresh updatedAt", { executionUpdatedAt: unnamespacedInput.staleBefore }],
    ["base attempt instead of a claimed attempt", { executionAttempt: unnamespacedInput.attemptCount }],
    ["different worker task", { executionTaskId: "other-job" }],
    ["non-running execution", { executionStatus: "queued" }],
    ["unanswered question", { questionAnswer: null }],
    ["namespaced question", { questionId: "agent-question:turn_1:legacy:q1" }],
  ] as const)("does not terminalize %s", async (_case, options) => {
    const client = new RawResumeFailureClient(options)

    await expect(failStaleUnnamespacedLegacyResume(rawPoolFor(client), unnamespacedInput)).resolves.toBe(false)

    expect(client.state.executionStatus).not.toBe("failed")
    expect(client.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })

  it("terminalizes the exact stale legacy execution even if an unrelated Turn is active", async () => {
    const client = new RawResumeFailureClient({ activeTurn: true })

    await expect(failStaleUnnamespacedLegacyResume(rawPoolFor(client), unnamespacedInput)).resolves.toBe(true)

    expect(client.state.executionStatus).toBe("failed")
    expect(client.calls.some(call => call.sql.includes('FROM "agent_turns"'))).toBe(false)
  })

  it("keeps the no-active-Turn guard for non-authorization terminalization", async () => {
    const client = new RawResumeFailureClient({ activeTurn: true })

    await expect(failStaleUnnamespacedLegacyResume(rawPoolFor(client), {
      ...unnamespacedInput, reason: "retry_exhausted",
    })).resolves.toBe(false)

    expect(client.state.executionStatus).toBe("running")
  })

  it("CAS-protects the selected current attempt against an intervening attempt change", async () => {
    const client = new RawResumeFailureClient({
      beforeExecutionUpdate: state => { state.executionAttempt += 1 },
    })

    await expect(failStaleUnnamespacedLegacyResume(rawPoolFor(client), unnamespacedInput)).resolves.toBe(false)

    expect(client.state.executionStatus).toBe("running")
  })

  it.each([
    ["different user", { userId: "other_user" }],
    ["different session", { sessionId: "other_session" }],
    ["different execution", { executionId: "other_execution" }],
    ["different question", { questionId: "other_question" }],
  ] as const)("does not cross the %s fence", async (_case, mismatch) => {
    const client = new RawResumeFailureClient()

    await expect(failStaleUnnamespacedLegacyResume(rawPoolFor(client), { ...unnamespacedInput, ...mismatch })).resolves.toBe(false)

    expect(client.state.executionStatus).toBe("running")
    expect(client.calls.some(call => call.sql.startsWith("UPDATE "))).toBe(false)
  })
})
