import { afterEach, describe, expect, it, vi } from "vitest"
import {
  expireObjectiveWaveRateLimitWindow,
  installObjectiveJobProjectionBarrier,
} from "./application-task-full-loop.objective-wave-support"

const runId = "0123456789abcdef0123456789abcdef"
const userId = `full-loop-user-${runId}`
const domainKey = `ratelimit:domain:${userId}:boards.greenhouse.io`
const userKey = `ratelimit:user:${userId}`
const jobId = "11111111-1111-4111-8111-111111111111"
const environment = {
  CI: "true",
  AGENT_RUNTIME_PG_TEST_REQUIRED: "true",
  AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci",
  AGENT_RUNTIME_PG_TEST_URL: "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci",
  RUN_AGENT_TURN_REDIS_INTEGRATION: "1",
  AGENT_TURN_REDIS_TEST_DISPOSABLE: "true",
  REDIS_URL: "redis://127.0.0.1:6379/15",
  AGENT_TURN_REDIS_TEST_URL: "redis://127.0.0.1:6379/15",
  APPLICATION_TASK_FULL_LOOP_EGRESS_ISOLATED: "true",
  CLOAK_PROXY_URL: "http://127.0.0.1:9443",
}

function proof(count = 2) {
  return {
    phase: "between_completed_applications",
    activeAttemptCount: 0,
    pendingAttemptCount: 0,
    applications: Array.from({ length: count }, (_, index) => ({
      applicationTaskId: `application-${index + 1}`,
      fillTurnId: `fill-turn-${index + 1}`,
      applicationStatus: "submitted",
      checkpoint: "submission_verified",
      fillTurnStatus: "completed",
      jobStatus: "applied",
      jobWorkflowState: "submitted",
      fillAttemptCount: 1,
      submitAttemptCount: 1,
      resultReceiptCount: 1,
      executionSettlementCount: 1,
    })),
  }
}

function input(client: ReturnType<typeof redisClient>, overrides: Record<string, unknown> = {}) {
  return { client, environment, runId, userId, phaseProof: proof(), ...overrides }
}

function redisClient(options: { domainCount?: string | null; userCounts?: readonly string[]; expireAfterReads?: number } = {}) {
  let domainReads = 0, userReads = 0
  const get = vi.fn(async (key: string): Promise<string | null> => {
    if (key === userKey) {
      const values = options.userCounts ?? ["7"]
      const value = values[Math.min(userReads, values.length - 1)] ?? null
      userReads += 1
      return value
    }
    if (key === domainKey) {
      domainReads += 1
      if (options.expireAfterReads !== undefined && domainReads > options.expireAfterReads) return null
      return options.domainCount ?? "4"
    }
    return null
  })
  return { get, pexpire: vi.fn(async (_key: string, _ttl: number) => 1), pttl: vi.fn(async (_key: string) => 900) }
}

function pgClient(options: { jobPresent?: boolean; waiters?: number[]; failDropOnce?: boolean } = {}) {
  const waiterCounts = [...(options.waiters ?? [0, 1])]
  let dropFailed = false
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT hashtextextended")) return { rows: [{ key: "391827361" }] }
    if (sql.includes('FROM public."Job"')) {
      return { rows: options.jobPresent === false ? [] : [{ id: values?.[0] }] }
    }
    if (sql.startsWith("SELECT count(*)::int AS waiters")) {
      return { rows: [{ waiters: waiterCounts.shift() ?? 0 }] }
    }
    if (sql.startsWith("DROP TRIGGER") && options.failDropOnce && !dropFailed) {
      dropFailed = true
      throw new Error("trigger drop failed")
    }
    if (sql.includes("pg_advisory_unlock") && sql.includes("AS released")) return { rows: [{ released: true }] }
    return { rows: [] }
  })
  return { query }
}

function projectionInput(client: ReturnType<typeof pgClient>, overrides: Record<string, unknown> = {}) {
  return { client, environment, runId, userId, jobId, ...overrides }
}

afterEach(() => vi.useRealTimers())

describe("Objective wave test rate-limit window", () => {
  it("expires only the exact domain key after two completed applications and preserves the user counter", async () => {
    const redis = redisClient({ domainCount: "4", expireAfterReads: 2 })
    const result = await expireObjectiveWaveRateLimitWindow(input(redis))
    expect(result).toEqual({ expired: true, completedApplications: 2, expectedCounter: 4, userCounterPreserved: true })
    expect(redis.pexpire).toHaveBeenCalledOnce()
    expect(redis.pexpire).toHaveBeenCalledWith(domainKey, 1_000)
    expect(redis.get).toHaveBeenCalledWith(userKey)
    expect(redis.pttl).toHaveBeenCalledWith(domainKey)
    expect(redis.pexpire.mock.calls.map(([key]) => key)).toEqual([domainKey])
  })

  it("derives the exact counter from one completed application", async () => {
    const redis = redisClient({ domainCount: "2", expireAfterReads: 1 })
    await expect(expireObjectiveWaveRateLimitWindow(input(redis, { phaseProof: proof(1) })))
      .resolves.toMatchObject({ completedApplications: 1, expectedCounter: 2, expired: true })
    expect(redis.pexpire).toHaveBeenCalledWith(domainKey, 1_000)
  })

  it("accepts a retried fill attempt when submission evidence remains unique", async () => {
    const phaseProof = proof(1)
    phaseProof.applications[0].fillAttemptCount = 2
    const redis = redisClient({ domainCount: "2", expireAfterReads: 1 })
    await expect(expireObjectiveWaveRateLimitWindow(input(redis, { phaseProof })))
      .resolves.toMatchObject({ completedApplications: 1, expectedCounter: 2, expired: true })
    expect(redis.pexpire).toHaveBeenCalledExactlyOnceWith(domainKey, 1_000)
  })

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid fill attempt count (%s) before Redis access",
    async count => {
      const phaseProof = proof(1)
      phaseProof.applications[0].fillAttemptCount = count
      const redis = redisClient()
      await expect(expireObjectiveWaveRateLimitWindow(input(redis, { phaseProof })))
        .rejects.toThrow("objective_wave_rate_limit_phase_invalid")
      expect(redis.get).not.toHaveBeenCalled()
    },
  )

  it.each([
    ["wrong Redis service", { ...environment, REDIS_URL: "redis://127.0.0.1:6379/0" }, {}],
    ["non-run owner", environment, { userId: "ordinary-user" }],
    ["active attempt", environment, { phaseProof: { ...proof(), activeAttemptCount: 1 } }],
    ["pending attempt", environment, { phaseProof: { ...proof(), pendingAttemptCount: 1 } }],
    ["more than two applications", environment, { phaseProof: proof(3) }],
    ["duplicate task identity", environment, { phaseProof: { ...proof(), applications: [proof(1).applications[0], proof(1).applications[0]] } }],
  ])("does not touch Redis for %s", async (_name, env, overrides) => {
    const redis = redisClient()
    await expect(expireObjectiveWaveRateLimitWindow(input(redis, { environment: env, ...overrides }))).rejects.toThrow()
    expect(redis.get).not.toHaveBeenCalled()
    expect(redis.pexpire).not.toHaveBeenCalled()
  })

  it("does not expire a key whose actual count differs from completed work", async () => {
    const redis = redisClient({ domainCount: "3" })
    await expect(expireObjectiveWaveRateLimitWindow(input(redis))).rejects.toThrow("objective_wave_rate_limit_counter_unexpected")
    expect(redis.pexpire).not.toHaveBeenCalled()
  })

  it("requires the domain key to expire within the fixed bound", async () => {
    vi.useFakeTimers()
    const redis = redisClient({ domainCount: "4" })
    const pending = expect(expireObjectiveWaveRateLimitWindow(input(redis)))
      .rejects.toThrow("objective_wave_rate_limit_expiry_timeout")
    await vi.runAllTimersAsync()
    await pending
    expect(redis.get.mock.calls.filter(([key]) => key === domainKey).length).toBeLessThan(110)
  })

  it("fails if the independent user counter changes while the window expires", async () => {
    const redis = redisClient({ domainCount: "2", expireAfterReads: 1, userCounts: ["7", "8"] })
    await expect(expireObjectiveWaveRateLimitWindow(input(redis, { phaseProof: proof(1) })))
      .rejects.toThrow("objective_wave_user_counter_changed")
    expect(redis.pexpire.mock.calls.map(([key]) => key)).toEqual([domainKey])
  })
})

describe("Objective wave Job projection barrier", () => {
  it("locks only the exact synthetic Job transition and observes its blocked projection", async () => {
    const client = pgClient()
    const barrier = await installObjectiveJobProjectionBarrier(projectionInput(client))
    const calls = client.query.mock.calls
    const precheck = calls.findIndex(([sql]) => sql.includes('FROM public."Job"'))
    const lock = calls.findIndex(([sql]) => sql.includes("SELECT pg_advisory_lock"))
    const jobCheck = calls.find(([sql]) => sql.includes('FROM public."Job"'))
    const functionCall = calls.find(([sql]) => sql.startsWith('CREATE FUNCTION public."amojpf_'))
    const triggerCall = calls.find(([sql]) => sql.startsWith('CREATE TRIGGER "amojpt_'))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(precheck).toBeGreaterThan(lock)
    expect(jobCheck?.[0]).toContain('"status"=\'saved\' AND "workflowState"=\'draft\' AND "appliedAt" IS NULL')
    expect(jobCheck?.[0]).not.toContain("::uuid")
    expect(jobCheck?.[1]).toEqual([jobId, userId])
    expect(functionCall?.[0]).toContain(`OLD."id"='${jobId}'`)
    expect(functionCall?.[0]).not.toContain("::uuid")
    expect(functionCall?.[0]).toContain(`OLD."userId"='${userId}'`)
    expect(functionCall?.[0]).toContain(`OLD."workflowState"='submitting'`)
    expect(functionCall?.[0]).toContain(`NEW."workflowState"='submitted'`)
    expect(functionCall?.[0]).toMatch(/END; \$body\$$/)
    expect(triggerCall?.[0]).toContain("BEFORE UPDATE OF \"status\",\"workflowState\",\"appliedAt\"")
    expect(triggerCall?.[0]).toContain(`OLD."workflowState"='submitting'`)
    expect(triggerCall?.[0]).toContain(`NEW."status"='applied'`)
    expect(triggerCall?.[1]).toBeUndefined()
    await barrier.waitUntilBlocked()
    await barrier.waitUntilUnblocked()
    await barrier.release()
    await barrier.release()
    await barrier.cleanup()
    await barrier.cleanup()
    expect(client.query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_unlock"))).toHaveLength(1)
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("DROP TRIGGER"))).toHaveLength(1)
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("DROP FUNCTION"))).toHaveLength(1)
  })

  it("rejects a noncanonical Job identity before database access", async () => {
    const client = pgClient()
    await expect(installObjectiveJobProjectionBarrier(projectionInput(client, { jobId: "synthetic-job" })))
      .rejects.toThrow("objective_wave_projection_barrier_identity_invalid")
    expect(client.query).not.toHaveBeenCalled()
  })

  it("does not install DDL unless the exact owner Job is saved and draft", async () => {
    const client = pgClient({ jobPresent: false })
    await expect(installObjectiveJobProjectionBarrier(projectionInput(client)))
      .rejects.toThrow("objective_wave_projection_barrier_job_not_preapproval")
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("CREATE "))).toBe(false)
    expect(client.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true)
  })

  it("fails closed if more than one transaction is blocked on the key", async () => {
    const client = pgClient({ waiters: [2] })
    const barrier = await installObjectiveJobProjectionBarrier(projectionInput(client))
    await expect(barrier.waitUntilBlocked()).rejects.toThrow("objective_wave_projection_barrier_waiter_count_invalid")
    await barrier.cleanup()
  })

  it("retries DDL cleanup without unlocking an already released barrier twice", async () => {
    const client = pgClient({ failDropOnce: true })
    const barrier = await installObjectiveJobProjectionBarrier(projectionInput(client))
    await expect(barrier.cleanup()).rejects.toThrow("trigger drop failed")
    await barrier.cleanup()
    expect(client.query.mock.calls.filter(([sql]) => sql.includes("pg_advisory_unlock"))).toHaveLength(1)
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("DROP TRIGGER"))).toHaveLength(2)
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("DROP FUNCTION"))).toHaveLength(1)
  })

  it("accepts the exact separate wave owner while rejecting other suffixes before database access", async () => {
    const client = pgClient()
    const barrier = await installObjectiveJobProjectionBarrier(projectionInput(client, { userId: `${userId}-objective-wave` }))
    await barrier.cleanup()
    const rejected = pgClient()
    await expect(installObjectiveJobProjectionBarrier(projectionInput(rejected, { userId: `${userId}-other` })))
      .rejects.toThrow("objective_wave_projection_barrier_identity_invalid")
    expect(rejected.query).not.toHaveBeenCalled()
  })
})
