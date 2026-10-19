import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Pool } from "pg"
import {
  ensureSubmitQueueJob,
  inspectSubmitDelivery,
  matchesSubmitJobPayload,
  reconcileClaimedTerminalSubmit,
  reconcileTerminalSubmitJob,
  resetExpiredSubmitAuthorization,
} from "./application-submit-outbox-terminal-recovery.js"
import type { SubmitOutboxIntent, SubmitOutboxQueue } from "./application-submit-outbox-terminal-recovery.js"

const mockReconcile = vi.hoisted(() => vi.fn().mockResolvedValue(true))
const mockProofQuery = vi.hoisted(() => vi.fn())
vi.mock("../db/submission-guard.js", () => ({ reconcileClaimedSubmissionUncertain: mockReconcile }))

const identity = {
  applicationTaskId: "task-1", userId: "user-1", jobId: "job-1", sessionId: "session-1",
  fillTurnId: "turn-1", receiptId: "approval-1", constraintHash: "a".repeat(64),
}
const intent: SubmitOutboxIntent = {
  ...identity, workerTaskId: "bull-submit-1",
  submitPayload: { ...identity, operation: "submit", applyUrl: "https://jobs.example/apply", personaId: "server", resumePath: "" },
}
let terminalProofRows: Array<{ data: unknown }> = []
let failTerminalProofInsert = false
let taskState = { status: "filling", checkpoint: "browser_active" as string | null }

function makeJob(state: string, options: { id?: string; data?: unknown; attemptsMade?: number; attempts?: number } = {}) {
  return {
    id: options.id ?? intent.workerTaskId,
    data: options.data ?? intent.submitPayload,
    attemptsMade: options.attemptsMade ?? 3,
    opts: { attempts: options.attempts ?? 3 },
    getState: vi.fn(async () => state),
    remove: vi.fn(async () => undefined),
  }
}

function makeQueue(options: { job?: ReturnType<typeof makeJob>; lock?: string | null; paused?: boolean } = {}) {
  const redis = { get: vi.fn(async () => options.lock ?? null) }
  let retainedJob = options.job
  let addedJob: ReturnType<typeof makeJob> | undefined
  const queue = {
    isPaused: vi.fn(async () => options.paused ?? false),
    getJob: vi.fn(async () => retainedJob ?? addedJob),
    add: vi.fn(async (_name: string, data: unknown, opts: { jobId: string }) => {
      addedJob = makeJob("waiting", { id: opts.jobId, data })
      return addedJob
    }),
    toKey: vi.fn((key: string) => `bull:apply:${key}`),
    client: Promise.resolve(redis),
  }
  return { queue: queue as unknown as SubmitOutboxQueue, redis, prune: () => { retainedJob = undefined; addedJob = undefined } }
}

beforeEach(() => {
  terminalProofRows = []
  failTerminalProofInsert = false
  taskState = { status: "filling", checkpoint: "browser_active" }
  mockProofQuery.mockReset().mockImplementation(async (sql: unknown, values?: unknown[]) => {
    const query = String(sql)
    if (query.includes('FROM "application_tasks"')) return { rows: [{ id: intent.applicationTaskId, ...taskState }], rowCount: 1 }
    if (query.includes('FROM "application_task_events"')) return { rows: terminalProofRows, rowCount: terminalProofRows.length }
    if (query.includes('INSERT INTO "application_task_events"') && query.includes("submission_terminal_observed")) {
      if (failTerminalProofInsert) { failTerminalProofInsert = false; throw new Error("injected terminal proof write failure") }
      terminalProofRows.push({ data: JSON.parse(String(values?.[1])) as unknown })
      return { rows: [], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })
  mockReconcile.mockReset().mockImplementation(async (
  _pool: unknown,
  _identity: unknown,
  _workerTaskId: string,
  isCurrentTerminalDelivery?: (client: unknown) => Promise<boolean>,
) => isCurrentTerminalDelivery ? isCurrentTerminalDelivery({ query: mockProofQuery }) : true)
})

describe("claimed submit terminal recovery", () => {
  it("reconciles only a matching completed delivery after its exact lock is absent", async () => {
    const job = makeJob("completed")
    const { queue, redis } = makeQueue({ job })

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("reconciled")

    expect(redis.get).toHaveBeenCalledTimes(3)
    expect(redis.get).toHaveBeenCalledWith(`bull:apply:${intent.workerTaskId}:lock`)
    expect(queue.getJob).toHaveBeenCalledTimes(4)
    expect(mockReconcile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approvalId: identity.receiptId }), intent.workerTaskId, expect.any(Function))
    expect(terminalProofRows[0]?.data).toMatchObject({ ...identity, workerTaskId: intent.workerTaskId, terminalState: "completed" })
  })

  it("routes a valid terminal submit event through exact delivery reconciliation", async () => {
    const job = makeJob("completed")
    const { queue } = makeQueue({ job })

    await reconcileTerminalSubmitJob({} as Pool, queue, job as never, "completed")

    expect(mockReconcile).toHaveBeenCalledOnce()
    expect(mockReconcile).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ approvalId: identity.receiptId }), intent.workerTaskId, expect.any(Function))
  })

  it("ignores malformed terminal submit event identities", async () => {
    const job = makeJob("completed", { data: { ...intent.submitPayload, constraintHash: "invalid" } })
    const { queue } = makeQueue({ job })

    await reconcileTerminalSubmitJob({} as Pool, queue, job as never)

    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it("does not recover a missing job without persisted terminal proof", async () => {
    const { queue, redis } = makeQueue()

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("unchanged")

    expect(queue.getJob).toHaveBeenCalledTimes(2)
    expect(redis.get).toHaveBeenCalledTimes(2)
    expect(mockReconcile).toHaveBeenCalledOnce()
  })

  it("persists terminal callback evidence when BullMQ prunes the job before reconciliation", async () => {
    const { queue } = makeQueue()
    const job = makeJob("completed")

    await reconcileTerminalSubmitJob({} as Pool, queue, job as never, "completed")

    expect(mockReconcile).toHaveBeenCalledOnce()
    expect(terminalProofRows).toHaveLength(1)
    expect(terminalProofRows[0]?.data).toMatchObject({ ...identity, workerTaskId: intent.workerTaskId,
      terminalState: "completed", attemptsMade: 3, attempts: 3 })
  })

  it("retains exact terminal evidence through a proof-write failure and removes it only after retry commits", async () => {
    taskState = { status: "waiting_for_user", checkpoint: "submission_uncertain" }
    const job = makeJob("completed")
    const { queue, prune } = makeQueue({ job })
    failTerminalProofInsert = true

    await expect(reconcileTerminalSubmitJob({} as Pool, queue, job as never, "completed"))
      .rejects.toThrow("injected terminal proof write failure")
    expect(await queue.getJob(intent.workerTaskId)).toBe(job)
    expect(job.remove).not.toHaveBeenCalled()
    expect(terminalProofRows).toHaveLength(0)

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("reconciled")
    expect(terminalProofRows).toHaveLength(1)
    expect(job.remove).toHaveBeenCalledOnce()

    prune()
    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("reconciled")
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("defers cleanup when the exact lock appears after proof commits", async () => {
    const job = makeJob("completed")
    const { queue, redis } = makeQueue({ job })
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce("late-lock")

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("deferred")
    expect(terminalProofRows).toHaveLength(1)
    expect(job.remove).not.toHaveBeenCalled()

    redis.get.mockResolvedValue(null)
    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("reconciled")
    expect(terminalProofRows).toHaveLength(1)
    expect(job.remove).toHaveBeenCalledOnce()
  })

  it("cleans a matching terminal delivery after the exact task has a durable final outcome", async () => {
    taskState = { status: "submitted", checkpoint: "submission_verified" }
    const job = makeJob("completed")
    const { queue } = makeQueue({ job })

    await expect(reconcileTerminalSubmitJob({} as Pool, queue, job as never, "completed")).resolves.toBeUndefined()

    expect(job.remove).toHaveBeenCalledOnce()
    expect(terminalProofRows).toHaveLength(0)
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("persists only a final failed callback as terminal evidence", async () => {
    const { queue } = makeQueue()
    const job = makeJob("failed", { attemptsMade: 3, attempts: 3 })
    await reconcileTerminalSubmitJob({} as Pool, queue, job as never, "failed")
    expect(terminalProofRows[0]?.data).toMatchObject({ terminalState: "failed", attemptsMade: 3, attempts: 3 })
    const retryable = makeJob("failed", { attemptsMade: 1, attempts: 3 })
    await reconcileTerminalSubmitJob({} as Pool, queue, retryable as never, "failed")
    expect(terminalProofRows).toHaveLength(1)
    expect(mockReconcile).toHaveBeenCalledOnce()
  })

  it("does not accept mismatched persisted proof for a pruned job", async () => {
    terminalProofRows = [{ data: { ...identity, workerTaskId: "other-job", terminalState: "completed", attemptsMade: 3, attempts: 3 } }]
    const { queue } = makeQueue()
    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("unchanged")
  })

  it("defers if the exact lock appears after the absent-job preflight", async () => {
    const { queue, redis } = makeQueue()
    redis.get.mockImplementationOnce(async () => null).mockImplementationOnce(async () => "retry-lock")

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("deferred")

    expect(mockReconcile).toHaveBeenCalledOnce()
    expect(queue.getJob).toHaveBeenCalledOnce()
    expect(redis.get).toHaveBeenCalledTimes(2)
  })

  it("defers if the queue pauses after the absent-job preflight", async () => {
    const { queue } = makeQueue()
    vi.spyOn(queue, "isPaused").mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("deferred")

    expect(queue.isPaused).toHaveBeenCalledTimes(2)
    expect(mockReconcile).toHaveBeenCalledOnce()
  })

  it.each([
    { name: "active state", lock: null, expectSecondJobRead: true },
    { name: "active Redis lock", lock: "retry-lock", expectSecondJobRead: false },
  ])("does not reconcile when the exact delivery is retried and active after terminal preflight ($name)", async ({ lock, expectSecondJobRead }) => {
    let currentState = "failed"
    let currentLock: string | null = null
    const job = makeJob("failed")
    job.getState = vi.fn(async () => currentState)
    const { queue, redis } = makeQueue({ job })
    redis.get.mockImplementation(async () => currentLock)
    mockReconcile.mockImplementationOnce(async (_pool, _identity, _workerTaskId, isCurrentTerminalDelivery) => {
      expect(job.getState).toHaveBeenCalledOnce()
      currentState = "active"
      currentLock = lock
      return isCurrentTerminalDelivery ? isCurrentTerminalDelivery({ query: mockProofQuery }) : false
    })

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("deferred")

    expect(mockReconcile).toHaveBeenCalledOnce()
    expect(mockReconcile).toHaveBeenCalledWith(expect.anything(), expect.anything(), intent.workerTaskId, expect.any(Function))
    expect(redis.get).toHaveBeenCalledTimes(2)
    expect(queue.getJob).toHaveBeenCalledTimes(expectSecondJobRead ? 2 : 1)
    expect(job.getState).toHaveBeenCalledTimes(expectSecondJobRead ? 2 : 1)
  })

  it("does not reconcile a retryable failed delivery", async () => {
    const job = makeJob("failed", { attemptsMade: 1, attempts: 3 })
    const { queue } = makeQueue({ job })

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("deferred")
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it.each([
    { name: "a live Redis lock", options: { job: makeJob("failed"), lock: "token" } },
    { name: "a missing job with its exact lock", options: { lock: "token" } },
    { name: "a paused queue", options: { job: makeJob("failed"), paused: true } },
    { name: "an active job", options: { job: makeJob("active") } },
  ])("leaves a published claim alone with $name", async ({ options }) => {
    const { queue } = makeQueue(options)

    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.not.toBe("reconciled")
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it("rejects a same-ID job with a different payload", async () => {
    const job = makeJob("completed", { data: { ...intent.submitPayload, applyUrl: "https://other.example/apply" } })
    const { queue } = makeQueue({ job })

    expect(matchesSubmitJobPayload(job.data, intent)).toBe(false)
    expect(matchesSubmitJobPayload({ ...intent.submitPayload, unexpected: "field" }, intent)).toBe(false)
    await expect(inspectSubmitDelivery(queue, intent, false)).resolves.toBe("mismatch")
    await expect(reconcileClaimedTerminalSubmit({} as Pool, queue, intent)).resolves.toBe("mismatch")
    expect(mockReconcile).not.toHaveBeenCalled()
  })

  it("requeues a terminal exact job in place only after its lock is absent", async () => {
    const job = { ...makeJob("failed"), retry: vi.fn().mockResolvedValue(undefined) }
    const { queue } = makeQueue({ job })

    await expect(ensureSubmitQueueJob(queue, intent)).resolves.toBe("ready")

    expect(job.retry).toHaveBeenCalledWith("failed", { resetAttemptsMade: true, resetAttemptsStarted: true })
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("leaves a retryable failed preclaim job alone", async () => {
    const job = { ...makeJob("failed", { attemptsMade: 1, attempts: 3 }), retry: vi.fn() }
    const { queue } = makeQueue({ job })

    await expect(ensureSubmitQueueJob(queue, intent)).resolves.toBe("deferred")
    expect(job.retry).not.toHaveBeenCalled()
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("adds the same stable job when Redis evicted a preclaim delivery", async () => {
    const { queue } = makeQueue()

    await expect(ensureSubmitQueueJob(queue, intent)).resolves.toBe("ready")

    expect(queue.add).toHaveBeenCalledWith("apply", intent.submitPayload, expect.objectContaining({
      jobId: intent.workerTaskId, removeOnComplete: false, removeOnFail: false,
    }))
  })

  it("does not requeue a terminal delivery with a live lock", async () => {
    const job = { ...makeJob("failed"), retry: vi.fn().mockResolvedValue(undefined) }
    const { queue } = makeQueue({ job, lock: "token" })

    await expect(ensureSubmitQueueJob(queue, intent)).resolves.toBe("deferred")
    expect(job.retry).not.toHaveBeenCalled()
    expect(queue.add).not.toHaveBeenCalled()
  })

  it("resets only the exact authorized preclaim task and queued Job on approval expiry", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] }) }

    await resetExpiredSubmitAuthorization(client as never, intent)

    expect(String(client.query.mock.calls[0]?.[0])).toContain("status = 'filling'")
    expect(String(client.query.mock.calls[0]?.[0])).toContain('"checkpoint" = \'submission_authorized\'')
    expect(String(client.query.mock.calls[0]?.[0])).toContain('"workerTaskId" = $6')
    expect(String(client.query.mock.calls[1]?.[0])).toContain('"workflowState" = \'queued\'')
    expect(String(client.query.mock.calls[2]?.[0])).toContain("INSERT INTO application_task_events")
  })
})
