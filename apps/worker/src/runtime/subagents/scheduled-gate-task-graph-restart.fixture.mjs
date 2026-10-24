import { Pool } from "pg"
import { Redis } from "ioredis"
import { Worker } from "bullmq"
import { AgentTreeManager } from "./manager.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { parseSubagentDispatchJobId } from "./dispatch-identity.ts"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.ts"
import { createScheduledGateChildExecutor } from "./scheduled-gate-child-runtime.ts"
import { loadScheduledGateChoiceHistory } from "./pg-scheduled-task-graph-gate-choices.ts"
import { scheduledGatePreparedJobIds, parseScheduledGateResult, parseScheduledGateChoice,
  scheduledGateCandidateSetDigest } from "./scheduled-gate-contract.ts"
import { createScheduledGateFinishDiagnosticPool, isScheduledGateFailureReason, isScheduledGateFinishStage,
  scheduledGateRuntimeDiagnostic, withScheduledGateChoiceTrace, withScheduledGateFinishTrace } from "./scheduled-gate-task-graph-diagnostics.fixture.ts"

const [, , mode, queueName, expectedTaskId, rawPlan] = process.argv
const FIXTURE_WEB_URL = "http://scheduled-gate-fixture.invalid"
const FIXTURE_WORKER_SECRET = "fixture-only-secret"
const MAX_PLAN_BYTES = 64_000
const FIXTURE_FAILURE_CODES = new Set([
  "unexpected_subagent_task", "dispatch_identity_invalid", "gate_task_outcome_invalid", "gate_task_persistence_invalid",
])
const FIXTURE_STARTUP_CODES = new Set(["fixture_arguments_invalid", "response_plan_invalid", "disposable_services_required"])
const PG_FAILURE_CODES = new Set([
  "23503", "23505", "23514", "40001", "40P01", "42501", "42703", "42P01", "55P03", "57014", "22P02",
])
const TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const OUTCOME_STATUSES = new Set([...TASK_STATUSES, "skipped", "lease_lost"])
function emit(marker, value) {
  process.stdout.write(`${marker} ${JSON.stringify(value)}\n`)
}

function fixtureError(code) {
  emit("ERROR", { code })
}

function failedJobCode(error, outcomeDiagnostic, finishStage, runtimeDiagnostic) {
  let cause = "unknown"
  if (error && typeof error === "object") {
    if (typeof error.message === "string" && FIXTURE_FAILURE_CODES.has(error.message)) {
      cause = error.message
    }
    else if (error.name === "SubagentLeaseError" && ["lost", "not_available"].includes(error.code)) {
      cause = `lease_${error.code}`
    }
    else if (error.name === "SubagentLimitError" && ["attempts", "concurrency", "depth", "fan_out"].includes(error.code)) {
      cause = `limit_${error.code}`
    }
    else if (typeof error.code === "string" && PG_FAILURE_CODES.has(error.code)) {
      cause = `pg_${error.code}`
    }
    else if (error.name === "DatabaseError") cause = "database_error"
    else if (error.name === "ReplyError") cause = "redis_reply_error"
    else if (["ReferenceError", "SyntaxError", "TypeError", "RangeError"].includes(error.name)) cause = error.name.toLowerCase()
  }
  const diagnostic = typeof outcomeDiagnostic === "string" && /^[a-z0-9_]{1,180}$/.test(outcomeDiagnostic)
    ? outcomeDiagnostic : "outcome_unavailable"
  const stage = isScheduledGateFinishStage(finishStage) ? finishStage : "not_observed"
  const runtime = typeof runtimeDiagnostic === "string" && /^[a-z0-9_]{1,120}$/.test(runtimeDiagnostic)
    ? runtimeDiagnostic : "runtime_unknown"
  return `bullmq_job_failed_${cause}_${diagnostic}_${stage}_${runtime}`
}

function persistedGateOutcomeDiagnostic(task, payload, leaseScope, requestedAttempt, outcome) {
  const outcomeStatus = OUTCOME_STATUSES.has(outcome?.status) ? outcome.status : "unlisted"
  const persistedStatus = outcome?.status === "retrying" ? "queued" : outcome?.status
  const attemptMatches = Number.isSafeInteger(task?.attemptCount) && task.attemptCount > 0
    && task.attemptCount === leaseScope?.attemptCount
    && (requestedAttempt === null || requestedAttempt === leaseScope.attemptCount)
  const matches = !!task && !!leaseScope && payload.taskId === expectedTaskId && leaseScope.taskId === expectedTaskId
    && task.id === expectedTaskId && task.id === leaseScope.taskId
    && task.userId === leaseScope.userId && task.sessionId === payload.sessionId && task.sessionId === leaseScope.sessionId
    && task.rootTaskId === payload.rootTaskId && task.rootTaskId === leaseScope.rootTaskId
    && task.parentTaskId === payload.rootTaskId && task.turnId === leaseScope.turnId
    && task.role === "prepare" && task.taskType === "scheduled_taskgraph_gate" && leaseScope.role === "prepare"
    && leaseScope.taskType === "scheduled_taskgraph_gate" && TASK_STATUSES.has(task.status)
    && attemptMatches && task.status === persistedStatus
  if (!matches) return `${outcomeStatus}_task_unbound`
  const reason = task.failureReason == null ? "none"
    : isScheduledGateFailureReason(task.failureReason) ? task.failureReason : "unlisted"
  return `${outcomeStatus}_${task.status}_${reason}`
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
  return parseScheduledGateChoice(value, question) === "skip"
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
  const store = new PgSubagentTaskStore(createScheduledGateFinishDiagnosticPool(pool), 30_000)
  const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
  let requestedAttempt = null
  let leaseScope = null
  let outcomeDiagnostic = null
  let choicePhase = "not_started"
  let candidateFinishSeen = false
  let candidateFinishStage = "not_observed"
  const originalFinish = store.finish.bind(store)
  store.finish = async input => {
    if (candidateFinishSeen || input.taskId !== expectedTaskId || !["waiting_for_user", "completed"].includes(input.status)) {
      return originalFinish(input)
    }
    candidateFinishSeen = true
    const traced = await withScheduledGateFinishTrace(() => originalFinish(input))
    candidateFinishStage = traced.stage
    if (!traced.ok) throw traced.error
    return traced.value
  }
  const loadChoices = lease => withScheduledGateChoiceTrace(
    () => loadScheduledGateChoiceHistory(pool, lease), phase => { choicePhase = phase })
  const runGate = createScheduledGateChildExecutor({ pool, loadChoices,
    fetcher: createFixtureFetcher(plan, attempt => { requestedAttempt = attempt }) })
  const executeGate = async ({ lease }) => {
    leaseScope = { taskId: lease.id, userId: lease.userId, sessionId: lease.sessionId, rootTaskId: lease.rootTaskId,
      turnId: lease.turnId, role: lease.role, taskType: lease.taskType, attemptCount: lease.attemptCount }
    return runGate({ lease })
  }
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
    requestedAttempt = null; leaseScope = null; outcomeDiagnostic = null; choicePhase = "not_started"
    candidateFinishSeen = false; candidateFinishStage = "not_observed"
    const outcome = await runSubagentQueueJob(pool, manager, executeGate, job.data, identity)
    if (outcome.taskId !== expectedTaskId) throw new Error("unexpected_subagent_task")
    if (!["waiting_for_user", "completed"].includes(outcome.status)) {
      const task = await store.get(expectedTaskId, job.data.sessionId).catch(() => null)
      outcomeDiagnostic = persistedGateOutcomeDiagnostic(task, job.data, leaseScope, requestedAttempt, outcome)
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
  worker.on("failed", (job, error) => {
    if (job?.data?.taskId !== expectedTaskId) return
    const runtimeDiagnostic = scheduledGateRuntimeDiagnostic(choicePhase, leaseScope?.attemptCount, requestedAttempt)
    reportError(failedJobCode(error, outcomeDiagnostic, candidateFinishStage, runtimeDiagnostic))
  })
  worker.on("error", () => reportError("bullmq_worker_error"))

  await worker.waitUntilReady()
  emit("READY", { queueName })
  void worker.run().catch(() => reportError("bullmq_worker_run_failed"))
  await new Promise(() => {})
}

main().catch(error => {
  const code = error instanceof Error && FIXTURE_STARTUP_CODES.has(error.message) ? error.message : "fixture_failed"
  fixtureError(code)
  process.exitCode = 1
})
