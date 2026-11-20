import { Pool } from "pg"
import { Redis } from "ioredis"
import { Worker } from "bullmq"
import { AgentTreeManager } from "./manager.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { parseSubagentDispatchJobId } from "./dispatch-identity.ts"
import { parseSubagentJobPayload } from "./types.ts"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.ts"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.ts"

const BRIDGE_PATH = "/api/internal/agent-runtime/scheduled-pipeline"
const CONFIG_KEYS = ["mode", "queueName", "userId", "sessionId", "turnId", "rootTaskId", "taskId", "prepareTaskId", "webUrl"]
const STATUSES = new Set(["completed", "retrying", "failed", "waiting", "waiting_for_user", "interrupted", "skipped", "lease_lost"])
const SAFE_ERRORS = new Set(["fixture_arguments_invalid", "fixture_config_invalid", "disposable_services_required",
  "worker_secret_unavailable", "worker_task_scope_invalid", "dispatch_identity_invalid", "root_scope_invalid",
  "gate_lease_scope_invalid", "gate_request_invalid", "gate_proof_scope_invalid", "gate_attempt_invalid",
  "fixture_ack_invalid", "fixture_ack_timeout", "gate_route_failed", "gate_outcome_invalid", "fixture_failed"])

class FixtureError extends Error { constructor(code) { super(code); this.name = "FixtureError"; this.code = code } }
function emit(marker, value) { process.stdout.write(`${marker} ${JSON.stringify(value)}\n`) }
function record(value) { return value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) ? value : null }
function validId(value) { return typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) }
function exactKeys(value, keys) { const row = record(value); return !!row && Reflect.ownKeys(row).length === keys.length
  && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key)) }
function parseConfig(raw) {
  let value
  try { if (typeof raw !== "string" || raw.length > 16_384) throw new Error(); value = JSON.parse(raw) } catch { throw new FixtureError("fixture_arguments_invalid") }
  if (!exactKeys(value, CONFIG_KEYS) || !["crash", "resume"].includes(value.mode)
    || ![value.queueName, value.userId, value.sessionId, value.turnId, value.rootTaskId, value.taskId, value.prepareTaskId].every(validId)
    || typeof value.webUrl !== "string" || value.webUrl.length > 512) throw new FixtureError("fixture_config_invalid")
  let url
  try { url = new URL(value.webUrl) } catch { throw new FixtureError("fixture_config_invalid") }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/"
    || url.username || url.password || url.search || url.hash) throw new FixtureError("fixture_config_invalid")
  return { ...value, webUrl: url.origin }
}
function localPort(name, fallback) {
  const value = process.env[name]
  if (value === undefined) return fallback
  const port = Number(value)
  if (!/^\d{1,5}$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new FixtureError("disposable_services_required")
  }
  return String(port)
}
function disposableUrls() {
  const databaseUrl = process.env.AGENT_RUNTIME_PG_TEST_URL, redisUrl = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!databaseUrl || !redisUrl || process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || process.env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1") {
    throw new FixtureError("disposable_services_required")
  }
  let database, redis
  try { database = new URL(databaseUrl); redis = new URL(redisUrl) } catch { throw new FixtureError("disposable_services_required") }
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1"
    || database.port !== localPort("AGENT_RUNTIME_PG_TEST_LOCAL_PORT", "5432") || database.username !== "postgres"
    || database.password !== "postgres" || database.pathname !== "/applymate_agent_brain_ci" || database.search || database.hash
    || redis.protocol !== "redis:" || redis.hostname !== "127.0.0.1"
    || redis.port !== localPort("AGENT_TURN_REDIS_TEST_LOCAL_PORT", "6379") || redis.pathname !== "/15"
    || redis.username || redis.password || redis.search || redis.hash) throw new FixtureError("disposable_services_required")
  return { databaseUrl, redisUrl }
}
function sameOwner(left, right, config, rootAttemptCount) {
  return exactKeys(left, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"])
    && exactKeys(right, ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"])
    && left.userId === config.userId && left.sessionId === config.sessionId && left.turnId === config.turnId
    && left.rootTaskId === config.rootTaskId && Number.isSafeInteger(left.rootAttemptCount)
    && left.rootAttemptCount === rootAttemptCount && validId(left.turnLeaseOwnerId)
    && Number.isSafeInteger(left.turnLeaseVersion) && left.turnLeaseVersion > 0
    && ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "turnLeaseOwnerId", "turnLeaseVersion"]
      .every(key => left[key] === right[key])
}
function validateGateRequest(input, init, config, currentLease, workerSecret) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input?.url
  const expectedUrl = `${config.webUrl}${BRIDGE_PATH}`
  if (url !== expectedUrl || init?.method !== "POST" || init.cache !== "no-store" || init.redirect !== "error"
    || new Headers(init.headers).get("x-agent-worker-secret") !== workerSecret || typeof init.body !== "string") {
    throw new FixtureError("gate_request_invalid")
  }
  let body
  try { body = JSON.parse(init.body) } catch { throw new FixtureError("gate_request_invalid") }
  const required = ["action", "owner", "attestation", "prepareProof", "gateTaskId", "gateLeaseOwnerId", "gateAttemptCount", "priorChoices"]
  const optional = ["scheduledWaitId", "validatedChoice"]
  const keys = Object.keys(body ?? {}).sort(), allowed = [...required, ...optional].sort()
  if (!record(body) || required.some(key => !Object.hasOwn(body, key)) || keys.some(key => !allowed.includes(key))
    || body.action !== "gate" || body.gateTaskId !== config.taskId || !Array.isArray(body.priorChoices)
    || Object.hasOwn(body, "scheduledWaitId") && !validId(body.scheduledWaitId)) throw new FixtureError("gate_request_invalid")
  const attestation = record(body.attestation), owner = record(body.owner), attestationOwner = record(attestation?.owner)
  if (!sameOwner(owner, attestationOwner, config, currentLease.rootAttemptCount)) throw new FixtureError("gate_proof_scope_invalid")
  const proof = record(body.prepareProof), result = record(proof?.result), completion = record(proof?.completion)
  const nodes = Array.isArray(completion?.nodes) ? completion.nodes.map(record) : []
  const prepare = nodes.at(-1), wait = record(completion?.wait)
  const proofMatches = result?.taskId === config.prepareTaskId && prepare?.taskId === config.prepareTaskId
    && wait?.status === "ready" && wait.mode === "all" && Array.isArray(wait.targetTaskIds)
    && wait.targetTaskIds.length === 1 && wait.targetTaskIds[0] === config.prepareTaskId
    && Array.isArray(wait.matchedTaskIds) && wait.matchedTaskIds.length === 1
    && wait.matchedTaskIds[0] === config.prepareTaskId
  if (!proofMatches) throw new FixtureError("gate_proof_scope_invalid")
  if (body.gateLeaseOwnerId !== currentLease.ownerId || body.gateAttemptCount !== currentLease.attemptCount
    || currentLease.attemptCount < 1) throw new FixtureError("gate_attempt_invalid")
}
function waitForGateAck() {
  return new Promise((resolve, reject) => {
    let buffer = ""
    const cleanup = () => { clearTimeout(timer); process.stdin.off("data", onData); process.stdin.pause() }
    const onData = chunk => {
      buffer += String(chunk)
      if (buffer.length > 128) { cleanup(); reject(new FixtureError("fixture_ack_invalid")); return }
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      const line = buffer.slice(0, newline).replace(/\r$/, ""), tail = buffer.slice(newline + 1)
      cleanup()
      if (line !== "ALLOW_GATE" || tail.trim()) reject(new FixtureError("fixture_ack_invalid"))
      else resolve()
    }
    const timer = setTimeout(() => { cleanup(); reject(new FixtureError("fixture_ack_timeout")) }, 90_000)
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", onData)
    process.stdin.resume()
  })
}
function safeError(error) {
  if (error instanceof FixtureError && SAFE_ERRORS.has(error.code)) return error.code
  if (error && typeof error === "object" && typeof error.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)) return `pg_${error.code}`
  if (error?.name === "ReplyError") return "redis_reply_error"
  return "fixture_failed"
}

async function main() {
  let worker, pool, redis, failed = false, closing = false, taskFinished = false, currentLease = null, boundaryFailure = null, routeCount = 0
  const finished = new Map()
  const close = async exitCode => {
    if (closing) return
    closing = true
    await worker?.close().catch(() => undefined)
    redis?.disconnect()
    await pool?.end().catch(() => undefined)
    process.exitCode = exitCode
  }
  const fail = code => {
    if (failed || closing) return
    failed = true
    emit("ERROR", { code: SAFE_ERRORS.has(code) ? code : "fixture_failed" })
    void close(1)
  }
  process.once("SIGTERM", () => taskFinished ? void close(0) : fail("fixture_failed"))
  try {
    const config = parseConfig(process.argv[2]), { databaseUrl, redisUrl } = disposableUrls()
    const workerSecret = process.env.AGENT_WORKER_SECRET
    if (typeof workerSecret !== "string" || !workerSecret.trim() || workerSecret.length > 2_048) throw new FixtureError("worker_secret_unavailable")
    process.env.AGENT_WEB_URL = config.webUrl
    pool = new Pool({ connectionString: databaseUrl, max: 4 })
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 5 ? null : 200 })
    const store = new PgSubagentTaskStore(pool, config.mode === "crash" ? 10_000 : 60_000)
    const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
    const gateFetcher = async (input, init) => {
      try {
        routeCount += 1
        if (routeCount !== 1 || !currentLease) throw new FixtureError("gate_request_invalid")
        validateGateRequest(input, init, config, currentLease, workerSecret.trim())
        if (config.mode === "crash") {
          if (currentLease.attemptCount !== 1) throw new FixtureError("gate_attempt_invalid")
          emit("CRASH_CUT", { taskScopeMatches: true, freshPrepareProof: true, attemptCount: currentLease.attemptCount })
          await new Promise(() => {})
        }
        if (currentLease.attemptCount < 2) throw new FixtureError("gate_attempt_invalid")
        emit("RECLAIMED", { taskScopeMatches: true, freshPrepareProof: true, attemptCount: currentLease.attemptCount })
        await waitForGateAck()
        let response
        try { response = await fetch(input, init) } catch { throw new FixtureError("gate_route_failed") }
        emit("GATE_HTTP", { status: response.status })
        return response
      } catch (error) { boundaryFailure = safeError(error); throw error }
    }
    const gate = createScheduledGateChildExecutor({ pool, fetcher: gateFetcher })
    const execute = async ({ lease }, payload) => {
      const task = await store.get(config.taskId, config.sessionId), root = await store.get(config.rootTaskId, config.sessionId)
      const validLease = lease.id === config.taskId && lease.userId === config.userId && lease.sessionId === config.sessionId
        && lease.turnId === config.turnId && lease.rootTaskId === config.rootTaskId && lease.parentTaskId === config.rootTaskId
        && lease.role === "prepare" && lease.taskType === "scheduled_taskgraph_gate" && lease.status === "running"
        && lease.leaseOwner === lease.ownerId && lease.ownerId === payload.ownerId && Number.isSafeInteger(lease.attemptCount)
        && lease.attemptCount > 0 && lease.leaseExpiresAt instanceof Date && lease.leaseExpiresAt.getTime() > Date.now()
        && Array.isArray(lease.allowedActions) && lease.allowedActions.length === 0
      const validTask = task && task.id === config.taskId && task.userId === config.userId && task.sessionId === config.sessionId
        && task.turnId === config.turnId && task.rootTaskId === config.rootTaskId && task.parentTaskId === config.rootTaskId
        && task.role === "prepare" && task.taskType === "scheduled_taskgraph_gate" && task.status === "running"
        && task.leaseOwner === lease.ownerId && task.attemptCount === lease.attemptCount
      const validRoot = root && root.id === config.rootTaskId && root.userId === config.userId && root.sessionId === config.sessionId
        && root.turnId === config.turnId && root.rootTaskId === config.rootTaskId && root.parentTaskId === null
        && root.role === "orchestrator" && Number.isSafeInteger(root.attemptCount) && root.attemptCount > 0
        && !["completed", "failed", "interrupted", "cancelled", "closed"].includes(root.status)
      if (!validLease || !validTask) throw new FixtureError("gate_lease_scope_invalid")
      if (!validRoot) throw new FixtureError("root_scope_invalid")
      currentLease = { ownerId: lease.ownerId, attemptCount: lease.attemptCount, rootAttemptCount: root.attemptCount }
      return gate({ lease })
    }
    worker = new Worker(config.queueName, async job => {
      const payload = parseSubagentJobPayload(job.data), identity = parseSubagentDispatchJobId(job.id, config.taskId)
      if (!payload || payload.taskId !== config.taskId || payload.sessionId !== config.sessionId || payload.rootTaskId !== config.rootTaskId
        || !validId(payload.ownerId)) throw new FixtureError("worker_task_scope_invalid")
      if (!identity) throw new FixtureError("dispatch_identity_invalid")
      const outcome = await runSubagentQueueJob(pool, manager, input => execute(input, payload), payload, identity)
      if (boundaryFailure) throw new FixtureError(boundaryFailure)
      if (outcome.taskId !== config.taskId || !STATUSES.has(outcome.status)) throw new FixtureError("gate_outcome_invalid")
      const result = { status: outcome.status }
      finished.set(job.id, result)
      return result
    }, { connection: redis, concurrency: 1, lockDuration: 10_000, stalledInterval: 1_000, skipVersionCheck: true, autorun: false })
    worker.on("completed", (job, result) => {
      const expected = job && finished.get(job.id)
      if (!expected || record(result)?.status !== expected.status) return fail("gate_outcome_invalid")
      taskFinished = true
      emit("TASK_FINISHED", expected)
      setImmediate(() => { void close(0) })
    })
    worker.on("failed", (_job, error) => fail(safeError(error)))
    worker.on("error", () => fail("fixture_failed"))
    await worker.waitUntilReady()
    void worker.run().catch(error => fail(safeError(error)))
    emit("READY", { mode: config.mode })
    await new Promise(() => {})
  } catch (error) {
    if (!failed && !closing) {
      failed = true
      emit("ERROR", { code: safeError(error) })
    }
    await close(1)
  }
}

void main()
