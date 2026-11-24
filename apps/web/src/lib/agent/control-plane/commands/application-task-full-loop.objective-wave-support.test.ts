import { afterEach, describe, expect, it, vi } from "vitest"
import { expireObjectiveWaveRateLimitWindow } from "./application-task-full-loop.objective-wave-support"

const runId = "0123456789abcdef0123456789abcdef"
const userId = `full-loop-user-${runId}`
const domainKey = `ratelimit:domain:${userId}:boards.greenhouse.io`
const userKey = `ratelimit:user:${userId}`
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
