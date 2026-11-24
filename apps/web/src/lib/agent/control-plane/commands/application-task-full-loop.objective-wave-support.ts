const TEST_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const TEST_REDIS_URL = "redis://127.0.0.1:6379/15"
const DOMAIN = "boards.greenhouse.io"
const RATE_LIMIT_TTL_MS = 1_000
const EXPIRY_TIMEOUT_MS = 5_000
const POLL_INTERVAL_MS = 50

type Environment = Readonly<Record<string, string | undefined>>
type RedisCounterClient = Readonly<{
  get(key: string): Promise<string | null>
  pexpire(key: string, ttlMs: number): Promise<number>
  pttl(key: string): Promise<number>
}>

type ObjectiveWavePhaseProof = Readonly<{
  phase: "between_completed_applications"
  activeAttemptCount: 0
  pendingAttemptCount: 0
  applications: readonly Readonly<{
    applicationTaskId: string
    fillTurnId: string
    applicationStatus: "submitted"
    checkpoint: "submission_verified"
    fillTurnStatus: "completed"
    jobStatus: "applied"
    jobWorkflowState: "submitted"
    fillAttemptCount: 1
    submitAttemptCount: 1
    resultReceiptCount: 1
    executionSettlementCount: 1
  }>[]
}>

type Input = Readonly<{
  client: RedisCounterClient
  environment: Environment
  runId: string
  userId: string
  phaseProof: unknown
}>

export async function expireObjectiveWaveRateLimitWindow(input: Input): Promise<Readonly<{
  expired: true
  completedApplications: number
  expectedCounter: number
  userCounterPreserved: true
}>> {
  assertDisposableEnvironment(input.environment)
  if (!/^[a-f0-9]{32}$/.test(input.runId) || input.userId !== `full-loop-user-${input.runId}`) {
    throw new Error("objective_wave_rate_limit_owner_invalid")
  }
  const proof = parsePhaseProof(input.phaseProof)
  const expectedCounter = proof.applications.length * 2
  const domainKey = `ratelimit:domain:${input.userId}:${DOMAIN}`
  const userKey = `ratelimit:user:${input.userId}`
  const userCounterBefore = await input.client.get(userKey)
  const domainCounter = await input.client.get(domainKey)
  if (domainCounter !== String(expectedCounter)) throw new Error("objective_wave_rate_limit_counter_unexpected")
  if (await input.client.pexpire(domainKey, RATE_LIMIT_TTL_MS) !== 1) {
    throw new Error("objective_wave_rate_limit_expiry_not_applied")
  }
  const ttl = await input.client.pttl(domainKey)
  if (ttl !== -2 && (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > RATE_LIMIT_TTL_MS)) {
    throw new Error("objective_wave_rate_limit_ttl_invalid")
  }
  await waitForExpiry(input.client, domainKey, expectedCounter)
  if (await input.client.get(userKey) !== userCounterBefore) {
    throw new Error("objective_wave_user_counter_changed")
  }
  return { expired: true, completedApplications: proof.applications.length, expectedCounter, userCounterPreserved: true }
}

function assertDisposableEnvironment(env: Environment): void {
  if (env.CI !== "true" || env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || env.DATABASE_URL !== TEST_DATABASE_URL
    || env.AGENT_RUNTIME_PG_TEST_URL !== TEST_DATABASE_URL || env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1"
    || env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || env.REDIS_URL !== TEST_REDIS_URL
    || env.AGENT_TURN_REDIS_TEST_URL !== TEST_REDIS_URL || env.APPLICATION_TASK_FULL_LOOP_EGRESS_ISOLATED !== "true"
    || env.CLOAK_PROXY_URL !== "http://127.0.0.1:9443") {
    throw new Error("objective_wave_rate_limit_disposable_services_required")
  }
}

function parsePhaseProof(value: unknown): ObjectiveWavePhaseProof {
  const keys = ["activeAttemptCount", "applications", "pendingAttemptCount", "phase"]
  if (!isRecord(value) || !exactKeys(value, keys) || value.phase !== "between_completed_applications"
    || value.activeAttemptCount !== 0 || value.pendingAttemptCount !== 0 || !Array.isArray(value.applications)
    || value.applications.length < 1 || value.applications.length > 2) {
    throw new Error("objective_wave_rate_limit_phase_invalid")
  }
  const applicationKeys = ["applicationTaskId", "applicationStatus", "checkpoint", "executionSettlementCount",
    "fillAttemptCount", "fillTurnId", "fillTurnStatus", "jobStatus", "jobWorkflowState", "resultReceiptCount",
    "submitAttemptCount"]
  const taskIds = new Set<string>(), turnIds = new Set<string>()
  for (const application of value.applications) {
    if (!isRecord(application) || !exactKeys(application, applicationKeys)
      || !nonEmptyId(application.applicationTaskId) || !nonEmptyId(application.fillTurnId)
      || taskIds.has(application.applicationTaskId) || turnIds.has(application.fillTurnId)
      || application.applicationStatus !== "submitted" || application.checkpoint !== "submission_verified"
      || application.fillTurnStatus !== "completed" || application.jobStatus !== "applied"
      || application.jobWorkflowState !== "submitted" || application.fillAttemptCount !== 1
      || application.submitAttemptCount !== 1 || application.resultReceiptCount !== 1
      || application.executionSettlementCount !== 1) {
      throw new Error("objective_wave_rate_limit_phase_invalid")
    }
    taskIds.add(application.applicationTaskId)
    turnIds.add(application.fillTurnId)
  }
  return value as ObjectiveWavePhaseProof
}

async function waitForExpiry(client: RedisCounterClient, key: string, expectedCounter: number): Promise<void> {
  const deadline = Date.now() + EXPIRY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = await client.get(key)
    if (current === null) return
    if (current !== String(expectedCounter)) throw new Error("objective_wave_rate_limit_counter_changed")
    await delay(Math.min(POLL_INTERVAL_MS, deadline - Date.now()))
  }
  if (await client.get(key) !== null) throw new Error("objective_wave_rate_limit_expiry_timeout")
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(value)
  return ownKeys.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
function nonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
