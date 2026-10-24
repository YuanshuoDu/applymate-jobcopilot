import { Pool } from "pg"
import { Redis } from "ioredis"
import { Worker } from "bullmq"
import { AgentTreeManager } from "./manager.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { parseSubagentDispatchJobId } from "./dispatch-identity.ts"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.ts"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.ts"
import { scheduledGatePreparedJobIds, parseScheduledGateResult, parseScheduledGateChoice,
  scheduledGateCandidateSetDigest } from "./scheduled-gate-contract.ts"

const [, , mode, queueName, expectedTaskId, rawPlan] = process.argv
const FIXTURE_WEB_URL = "http://scheduled-gate-fixture.invalid"
const FIXTURE_WORKER_SECRET = "fixture-only-secret"
const MAX_PLAN_BYTES = 64_000

function emit(marker, value) {
  process.stdout.write(`${marker} ${JSON.stringify(value)}\n`)
}

function fixtureError(code) {
  emit("ERROR", { code })
}

function validId(value) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256
}

function parsePlan(value) {
  if (typeof value !== "string" || value.length > MAX_PLAN_BYTES) throw new Error("response_plan_invalid")
  const plan = JSON.parse(value)
  if (!plan || typeof plan !== "object" || Array.isArray(plan) || Object.getPrototypeOf(plan) !== Object.prototype) {
    throw new Error("response_plan_invalid")
  }
  const entries = Object.entries(plan)
  if (entries.length < 1 || entries.length > 51 || entries.some(([attempt, response]) =>
    !/^[1-9][0-9]*$/.test(attempt) || !Number.isSafeInteger(Number(attempt)) || Number(attempt) > 51
    || !response || typeof response !== "object" || Array.isArray(response))) throw new Error("response_plan_invalid")
  return plan
}

function disposableUrls() {
  const databaseUrl = process.env.AGENT_RUNTIME_PG_TEST_URL
  const redisUrl = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!databaseUrl || !redisUrl || process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") throw new Error("disposable_services_required")
  const database = new URL(databaseUrl), redis = new URL(redisUrl)
  if (database.protocol !== "postgresql:" || database.hostname !== "127.0.0.1" || database.port !== "5432"
    || database.username !== "postgres" || database.password !== "postgres" || database.pathname !== "/applymate_agent_brain_ci"
    || database.search || database.hash || redis.protocol !== "redis:" || !["127.0.0.1", "localhost", "::1"].includes(redis.hostname)
    || redis.port !== "6379" || redis.pathname !== "/15" || redis.username || redis.password || redis.search || redis.hash) {
    throw new Error("disposable_services_required")
  }
  return { databaseUrl, redisUrl }
}

function createFixtureFetcher(plan, onAttempt) {
  return async (input, init = {}) => {
    const url = new URL(String(input))
    if (url.toString() !== `${FIXTURE_WEB_URL}/api/internal/agent-runtime/scheduled-pipeline`
      || init.method !== "POST" || init.cache !== "no-store" || init.redirect !== "error"
      || new Headers(init.headers).get("x-agent-worker-secret") !== FIXTURE_WORKER_SECRET) {
      throw new Error("unexpected_gate_boundary_request")
    }
    let body
    try { body = JSON.parse(String(init.body)) } catch { throw new Error("gate_boundary_body_invalid") }
    const keys = Object.keys(body ?? {}).sort().join(",")
    const baseKeys = "action,attestation,gateAttemptCount,gateLeaseOwnerId,gateTaskId,owner,prepareProof,priorChoices"
    const optionalKeys = [
      ...(Object.hasOwn(body ?? {}, "scheduledWaitId") ? ["scheduledWaitId"] : []),
      ...(Object.hasOwn(body ?? {}, "validatedChoice") ? ["validatedChoice"] : []),
    ]
    const expectedKeys = [...baseKeys.split(","), ...optionalKeys].sort().join(",")
    if (!body || body.action !== "gate" || body.gateTaskId !== expectedTaskId
      || !Number.isSafeInteger(body.gateAttemptCount) || body.gateAttemptCount < 1
      || keys !== expectedKeys || !Array.isArray(body.priorChoices)
      || Object.hasOwn(body, "scheduledWaitId") && !validId(body.scheduledWaitId)) throw new Error("gate_boundary_request_invalid")
    onAttempt(body.gateAttemptCount)
    const expectedJobIds = scheduledGatePreparedJobIds(body.prepareProof)
    if (!expectedJobIds || body.priorChoices.some(choice => !validChoice(choice, expectedJobIds))
      || Object.hasOwn(body, "validatedChoice") && !validChoice(body.validatedChoice, expectedJobIds)) {
      throw new Error("gate_boundary_choice_invalid")
    }
    assertPlannedSkipHistory(plan, body, expectedJobIds)
    const planned = plan[String(body.gateAttemptCount)]
    const result = expectedJobIds && parseScheduledGateResult(planned, expectedJobIds)
    if (!result) throw new Error("response_plan_invalid_for_attempt")
    return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } })
  }
}

function assertPlannedSkipHistory(plan, body, expectedJobIds) {
  const attempt = body.gateAttemptCount
  if (attempt === 1) {
    if (Object.hasOwn(body, "validatedChoice") || body.priorChoices.length !== 0) {
      throw new Error("gate_boundary_initial_history_invalid")
    }
    return
  }

  const currentQuestion = plannedQuestion(plan, attempt - 1, expectedJobIds)
  if (!matchesPlannedSkip(body.validatedChoice, currentQuestion)) throw new Error("gate_boundary_current_choice_mismatch")

  const expectedPriorCount = attempt - 2
  if (body.priorChoices.length !== expectedPriorCount) throw new Error("gate_boundary_prior_choice_count_mismatch")
  for (let index = 0; index < expectedPriorCount; index += 1) {
    const question = plannedQuestion(plan, index + 1, expectedJobIds)
    if (!matchesPlannedSkip(body.priorChoices[index], question)) throw new Error("gate_boundary_prior_choice_mismatch")
  }
}

function plannedQuestion(plan, attempt, expectedJobIds) {
  const result = parseScheduledGateResult(plan[String(attempt)], expectedJobIds)
  if (!result || result.status !== "question_required") throw new Error("response_plan_question_invalid")
  return result
}

function matchesPlannedSkip(value, question) {
  const parsed = parseScheduledGateChoice(value, question)
  return !!parsed && parsed.choiceId === "skip" && parsed.kind === question.kind
    && parsed.jobIds.length === question.jobIds.length
    && parsed.jobIds.every((jobId, index) => jobId === question.jobIds[index])
}

function validChoice(value, expectedJobIds) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Reflect.ownKeys(value)
  if (keys.length !== 3 || keys.some(key => typeof key !== "string" || !["choiceId", "jobIds", "kind"].includes(key))) return false
  const { kind, jobIds } = value
  if ((kind !== "borderline_match" && kind !== "weak_cover_letter") || !Array.isArray(jobIds)
    || jobIds.length < 1 || jobIds.length > 50 || jobIds.some(id => !validId(id) || !expectedJobIds.includes(id))
    || new Set(jobIds).size !== jobIds.length || kind === "weak_cover_letter" && jobIds.length !== 1) return false
  const allowedChoiceIds = kind === "weak_cover_letter" ? ["continue", "review", "skip"] : ["add_to_pending", "skip", "lower_threshold"]
  const question = { status: "question_required", kind, jobIds,
    candidateSetDigest: scheduledGateCandidateSetDigest(kind, jobIds), allowedChoiceIds }
  return parseScheduledGateChoice(value, question) !== null
}

async function main() {
  if (mode !== "gate-worker" || !validId(queueName) || !validId(expectedTaskId)) throw new Error("fixture_arguments_invalid")
  const plan = parsePlan(rawPlan)
  const { databaseUrl, redisUrl } = disposableUrls()
  process.env.AGENT_WEB_URL = FIXTURE_WEB_URL
  process.env.AGENT_WORKER_SECRET = FIXTURE_WORKER_SECRET
  const pool = new Pool({ connectionString: databaseUrl, max: 6 })
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null })
  const store = new PgSubagentTaskStore(pool, 30_000)
  const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
  let requestedAttempt = null
  const executeGate = createScheduledGateChildExecutor({ pool, fetcher: createFixtureFetcher(plan, attempt => { requestedAttempt = attempt }) })
  const finished = new Map()
  let reportedError = false
  let worker

  const reportError = code => {
    if (reportedError) return
    reportedError = true
    fixtureError(code)
    void worker?.close().catch(() => undefined)
    redis.disconnect()
    void pool.end()
    process.exitCode = 1
  }

  worker = new Worker(queueName, async job => {
    if (job.data?.taskId !== expectedTaskId) throw new Error("unexpected_subagent_task")
    const identity = parseSubagentDispatchJobId(job.id, expectedTaskId)
    if (!identity) throw new Error("dispatch_identity_invalid")
    requestedAttempt = null
    const outcome = await runSubagentQueueJob(pool, manager, executeGate, job.data, identity)
    if (outcome.taskId !== expectedTaskId || !["waiting_for_user", "completed"].includes(outcome.status)) {
      throw new Error("gate_task_outcome_invalid")
    }
    const task = await store.get(expectedTaskId, job.data.sessionId)
    if (!task || task.status !== outcome.status || task.attemptCount !== requestedAttempt
      || !Number.isSafeInteger(task.attemptCount) || task.attemptCount < 1) throw new Error("gate_task_persistence_invalid")
    finished.set(job.id, { taskId: expectedTaskId, attempt: task.attemptCount, status: task.status, generation: identity.generation })
    return finished.get(job.id)
  }, { connection: redis, concurrency: 1, lockDuration: 15_000, skipVersionCheck: true, autorun: false })

  worker.on("completed", (job, result) => {
    if (job.data?.taskId !== expectedTaskId) return reportError("unexpected_completed_task")
    const expected = finished.get(job.id)
    if (!expected || !result || JSON.stringify(result) !== JSON.stringify(expected)) return reportError("completed_marker_mismatch")
    void worker.pause(false).catch(() => undefined)
    emit("TASK_FINISHED", expected)
  })
  worker.on("failed", job => {
    if (job?.data?.taskId === expectedTaskId) reportError("bullmq_job_failed")
  })
  worker.on("error", () => reportError("bullmq_worker_error"))

  await worker.waitUntilReady()
  emit("READY", { queueName })
  void worker.run().catch(() => reportError("bullmq_worker_run_failed"))
  await new Promise(() => {})
}

main().catch(error => {
  const code = error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message) ? error.message : "fixture_failed"
  fixtureError(code)
  process.exitCode = 1
})
