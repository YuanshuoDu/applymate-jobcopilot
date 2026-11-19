import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.ts"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.ts"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.ts"
import { createProductionChildExecutor } from "./production-child-runtime.ts"
import { createProductionChildResumeLoaders } from "./production-child-resume-loaders.ts"
import { AgentTreeManager } from "./manager.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { commitDurableSubagentWaitResume } from "./durable-subagent-wait-resume.ts"
import { createProductionWorkerBootstrap } from "../../queue/production-bootstrap.ts"
import { createSubagentQueue } from "../../queue/subagent-queue.ts"
import { enqueueTurn } from "../turns/turn-queue.ts"
import { createCrashFixtureExecutor, createNestedScoutFixtureScripts } from "./nested-scout-delegation-worker-fixture-scripts.mjs"
import { installWaitResolverDiagnostics } from "./nested-scout-wait-resolver-logging.mjs"
const [, , mode, rawIds, leaseProfile] = process.argv, ids = JSON.parse(rawIds)
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 10 })
const restartRecovery = leaseProfile === "restart-recovery"
const fixtureLeaseMs = restartRecovery ? 30_000 : 3_000
const fixtureHeartbeatMs = restartRecovery ? 10_000 : 500
const SAFE_RECOVERY_ERROR_CODES = new Set([
  "subagent_dispatch_delivery_uncertain", "lost", "40001", "40P01", "55P03", "57014", "08000", "08003", "08006", "57P01",
  "ECONNRESET", "ETIMEDOUT", "wait_invalid", "wait_scope_error", "wait_conflict",
  ...`owner_mismatch lease_expired wait_tool_call_conflict wait_step_lineage wait_lineage invalid_wait_result step_lineage item_lineage step_limit item_limit usage_overflow
    observation_limit invalid_tool_call invalid_wait_input tool_item_conflict invalid_item_status tool_call_conflict tool_result_conflict invalid_errorCode
    invalid_id invalid_sessionId invalid_turnId invalid_taskId invalid_rootTaskId invalid_stepId invalid_ordinal invalid_attempt invalid_inputThroughSequence invalid_inputTokens invalid_outputTokens invalid_estimatedCostUsd invalid_consumedInputIds`.split(/\s+/).map(code => `child_resume_${code}`),
])
const SAFE_WAIT_RESUME_DIAGNOSTIC_STAGES = new Set(`required_value resume_scope source_step source_call_count source_call_input source_item_set wait_record_shape provenance_marker source_receipt_missing source_marker_without_result source_recovered_receipt_mismatch source_waiting_content source_waiting_output_shape source_waiting_identity source_waiting_targets source_waiting_matched_ids source_waiting_tasks source_waiting_task_ids source_waiting_deadline source_initial_call_shape source_call_completion_state source_result_completion_state source_call_completion_content source_result_completion_content source_waiting_output_missing source_event_chain reconciliation safe_result_shape source_start_event lease_fence source_ordinal wait_state wait_result_shape target_scope resolved_outcome tool_call call_binding receipt_pair receipt_identity receipt_ids receipt_deadline input_target_ids output_target_ids other`.split(" "))
let bootstrap
async function pauseSubagentClaims() {
  if (!bootstrap?.subagents) throw new Error("p1143_subagent_queue_unavailable")
  await bootstrap.subagents.queue.worker.pause(true)
}
const profile = { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
  continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
  supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 256, costClass: "low" }
const flags = { cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true, taskGraphPlanningEnabled: true, childExecutionEnabled: true,
  coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false }
const FIXTURE_FAILURE_CODES = new Set([
  "p1143_children_did_not_overlap_in_running_state", "p1143_delegate_tool_missing", "p1143_grandchild_coordination_leaked", "p1143_grandchild_discover_tool_missing",
  "p1143_grandchild_discovery_failed", "p1143_grandchild_source_bound_job_missing", "p1143_grandchild_source_evidence_missing", "p1143_parent_current_reads_missing",
  "p1143_parent_discovery_tool_missing", "p1143_parent_discovery_failed", "p1143_parent_lease_unavailable", "p1143_alpha_delegate_failed",
  "p1143_beta_delegate_failed", "p1143_parent_wait_failed", "p1143_parent_job_read_failed", "p1143_fixture_tool_result_unexpected_error",
  "p1143_fixture_tool_pair_request_invalid", "p1143_fixture_tool_pair_call_invalid", "p1143_fixture_tool_pair_call_ambiguous", "p1143_fixture_tool_pair_result_ambiguous",
  "p1143_fixture_tool_pair_result_invalid", "p1143_fixture_wait_input_invalid", "p1143_root_plan_tool_missing", "p1143_root_scout_task_missing",
  "p1143_root_scout_verification_missing", "p1143_scout_results_not_available_after_wait", "p1143_scout_results_tool_missing", "p1143_second_delegate_tool_missing",
  "p1143_source_escalation_was_not_rejected", "p1143_stale_step_created_child", "p1143_stale_step_was_accepted", "p1143_step_fence_fixture_missing_steps",
  "p1143_fixture_requires_disposable_ci_services", "p1143_parent_did_not_suspend_without_lease", "p1143_root_graph_completion_unverified", "p1143_root_turn_did_not_complete_after_child_join",
  "p1143_root_turn_failed", "p1143_resume_loader_unavailable", "p1143_subagent_queue_unavailable", "p1143_crash_child_did_not_claim",
])
function reportParentJoinState(state) {
  const count = value => value >= 2 ? "BOTH" : value === 1 ? "ONE" : "NONE"
  say(`P1143_PARENT_DELEGATE_RESULTS_${count(state.delegateResultCount)}`)
  say(`P1143_PARENT_DELEGATE_TASK_IDS_${count(state.childIdCount)}`)
  say(state.waitResultPresent ? "P1143_PARENT_WAIT_RESULT_PRESENT" : "P1143_PARENT_WAIT_RESULT_MISSING")
  say(state.terminalWaitMatch ? "P1143_PARENT_WAIT_TERMINAL_MATCH" : "P1143_PARENT_WAIT_TERMINAL_NO_MATCH")
  say(state.scoutResultsIssued ? "P1143_PARENT_SCOUT_RESULTS_ISSUED" : "P1143_PARENT_SCOUT_RESULTS_NOT_ISSUED")
}
let stdin = ""
const commands = []
const waiters = new Map()
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  stdin += chunk
  const lines = stdin.split("\n"); stdin = lines.pop() ?? ""
  for (const line of lines.map(value => value.trim()).filter(Boolean)) {
    const waiter = waiters.get(line)?.shift()
    if (waiter) { if (!waiters.get(line)?.length) waiters.delete(line); waiter() } else commands.push(line)
  }
})
function say(value) { process.stdout.write(value + "\n") }
const ACK_ERROR_CODES = new Set(["wait_invalid", "wait_scope_error", "wait_conflict"])
const ACK_LIFECYCLE_STAGES = new Set([
  "required_value", "resume_scope", "source_step", "source_call_count", "source_call_input", "source_item_set", "wait_record_shape",
  "provenance_marker", "source_receipt_missing", "source_marker_without_result", "source_recovered_receipt_mismatch",
  "source_waiting_content", "source_waiting_output_shape", "source_waiting_identity", "source_waiting_targets",
  "source_waiting_matched_ids", "source_waiting_tasks", "source_waiting_task_ids", "source_waiting_deadline",
  "source_initial_call_shape", "source_call_completion_state", "source_result_completion_state", "source_call_completion_content",
  "source_result_completion_content", "source_waiting_output_missing", "source_event_chain", "reconciliation", "safe_result_shape",
  "source_start_event",
])
function waitResumeCommitter() {
  return async (lease, wait, nextStepOrdinal) => {
    try {
      return await commitDurableSubagentWaitResume(pool, lease, { waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal })
    } catch (error) {
      try {
        const record = error && typeof error === "object" ? error : {}
        const code = ACK_ERROR_CODES.has(record.code) ? record.code : "other"
        const stage = ACK_LIFECYCLE_STAGES.has(record.sourceLifecycleStage) ? record.sourceLifecycleStage : "other"
        say(`P1143_WAIT_RESUME_COMMIT_DIAGNOSTIC:${code}:${stage}`)
      } catch {}
      throw error
    }
  }
}
const { rootModelRuntime, discoveryClient, childModelRuntime } = createNestedScoutFixtureScripts({ mode, profile, ids, pool, say, pauseSubagentClaims, reportParentJoinState })
function command(name) {
  const index = commands.indexOf(name)
  if (index >= 0) { commands.splice(index, 1); return Promise.resolve() }
  return new Promise(resolve => { const values = waiters.get(name) ?? []; values.push(resolve); waiters.set(name, values) })
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function recoveryErrorClass(error, includeMessage = false) {
  try {
    const code = error && typeof error === "object" ? error.code ?? (includeMessage ? error.message : null) : null
    if (typeof code === "string") return code === "task_graph_transition_rejected:idempotency_conflict" ? "idempotency_conflict"
      : code === "task_graph_transition_rejected:revision_mismatch" ? "revision_mismatch" : SAFE_RECOVERY_ERROR_CODES.has(code) ? code : "other"
    return error instanceof Error ? "error" : "unknown"
  } catch { return "unknown" }
}
const SAFE_TASK_ALIASES = new Set(["parent_scout", "depth_two_scout_alpha", "depth_two_scout_beta", "other_scout", "other", "unavailable"])
const MAX_LEASE_DIAGNOSTICS = 12
const MAX_TASK_ALIAS_REFERENCES = 32
const MAX_DIAGNOSTIC_DURATION_MS = 120_000
const SAFE_TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "completed", "failed", "interrupted", "cancelled", "closed"])
function fixtureTaskAlias(task) {
  if (task?.role !== "scout" || task?.taskType !== "job_discovery") return "other"
  if (task.depth === 1) return "parent_scout"
  if (task.depth === 2 && typeof task.goal === "string") {
    if (task.goal.includes("Alpha")) return "depth_two_scout_alpha"
    if (task.goal.includes("Beta")) return "depth_two_scout_beta"
    return "other_scout"
  }
  return "other"
}
function boundedAttempt(value) { return Number.isInteger(value) && value >= 0 && value <= 3 ? value : "other" }
function boundedDurationMs(start, end = performance.now()) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return Math.max(0, Math.min(MAX_DIAGNOSTIC_DURATION_MS, Math.round(end - start)))
}
function boundedExpiryBucket(value, observedAt = Date.now()) {
  const expiry = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(expiry)) return "unavailable"
  const remaining = expiry - observedAt
  if (remaining <= 0) return "expired"
  if (remaining < 1_000) return "lt_1s"
  if (remaining <= 5_000) return "1_to_5s"
  return "gt_5s"
}
function safeLeaseDiagnostic(task, taskAlias = fixtureTaskAlias(task)) {
  const attempt = boundedAttempt(task?.attemptCount)
  return {
    task: SAFE_TASK_ALIASES.has(taskAlias) ? taskAlias : "unavailable",
    attempt,
    leaseVersion: attempt,
    leaseVersionSource: "attemptCount",
    status: "unavailable",
    leaseState: "unavailable",
    ownerFence: "unavailable",
    attemptFence: "unavailable",
    expiryBucket: "unavailable",
  }
}
function rememberTaskAlias(taskAliases, taskId, task) {
  if (typeof taskId !== "string" || !taskId || !Number.isSafeInteger(task?.attemptCount)) return
  let attempts = taskAliases.get(taskId)
  if (!attempts) {
    if (taskAliases.size >= MAX_TASK_ALIAS_REFERENCES) return
    attempts = new Map()
    taskAliases.set(taskId, attempts)
  }
  if (attempts.size < 4 || attempts.has(task.attemptCount)) attempts.set(task.attemptCount, fixtureTaskAlias(task))
}
function installClaimDiagnostics(store, taskAliases) {
  const claim = store.claim.bind(store)
  let emitted = 0
  store.claim = async input => {
    const claimStartedAt = performance.now()
    const task = await claim(input)
    if (!task) return task
    rememberTaskAlias(taskAliases, input.taskId, task)
    if (emitted < MAX_LEASE_DIAGNOSTICS) {
      emitted += 1
      const attempt = boundedAttempt(task.attemptCount)
      const ownerFence = typeof task.leaseOwner !== "string" ? "absent" : task.leaseOwner === input.ownerId ? "match" : "mismatch"
      const expiryBucket = boundedExpiryBucket(task.leaseExpiresAt)
      const leaseState = ownerFence === "absent" ? "owner_absent"
        : expiryBucket === "unavailable" ? "expiry_absent" : expiryBucket === "expired" ? "expired" : "live"
      const payload = {
        ...safeLeaseDiagnostic(task),
        status: SAFE_TASK_STATUSES.has(task.status) ? task.status : "other",
        leaseState, ownerFence, attemptFence: "unavailable", expiryBucket, outcome: "claimed",
        elapsedMs: boundedDurationMs(claimStartedAt),
      }
      try { say(`P1143_TASK_CLAIM_DIAGNOSTIC:${JSON.stringify(payload)}`) } catch {}
    }
    return task
  }
}
function withWaitingFinishDiagnostics(store) { const finish = store.finish.bind(store); store.finish = input => finish(input).catch(error => { if (input.status === "waiting") { const code = recoveryErrorClass(error, true); say(`P1143_WAITING_FINISH_DIAGNOSTIC:${code === "idempotency_conflict" || code === "revision_mismatch" ? code : "other"}`) } throw error }); return store }
function installHeartbeatDiagnostics(store, taskAliases) {
  const heartbeat = store.heartbeat.bind(store)
  let emitted = 0
  const report = (input, outcome, elapsedMs) => {
    if (emitted >= MAX_LEASE_DIAGNOSTICS) return
    emitted += 1
    const alias = taskAliases.get(input.taskId)?.get(input.attemptCount) ?? "unavailable"
    try { say(`P1143_HEARTBEAT_DIAGNOSTIC:${JSON.stringify({ ...safeLeaseDiagnostic(input, alias), outcome, elapsedMs })}`) } catch {}
  }
  store.heartbeat = async input => {
    const heartbeatStartedAt = performance.now()
    try {
      const outcome = await heartbeat(input)
      if (outcome !== "renewed") report(input, outcome === "interrupted" ? "interrupted" : "lost", boundedDurationMs(heartbeatStartedAt))
      return outcome
    } catch (error) {
      report(input, "storage_error", boundedDurationMs(heartbeatStartedAt))
      throw error
    }
  }
}
function createRepairTimingSnapshot() {
  return {
    poolConnectMs: null, beginMs: null, userConfigMs: null, sessionLockQueryMs: null, taskRowQueryMs: null,
    consumedWaitScanMs: null, repairSourceQueryCount: 0, repairSourceQueryTotalMs: 0, repairSourceQueryMaxMs: 0,
    finalLeaseFenceQueryMs: null, commitMs: null, queryCount: 0, totalQueryMs: 0, elapsedMs: null,
  }
}
function recordRepairQueryTiming(snapshot, statement, elapsedMs) {
  snapshot.queryCount = Math.min(4096, snapshot.queryCount + 1)
  snapshot.totalQueryMs = Math.min(MAX_DIAGNOSTIC_DURATION_MS, snapshot.totalQueryMs + (elapsedMs ?? 0))
  const sql = statement.trim().toUpperCase()
  if (sql === "BEGIN") snapshot.beginMs = elapsedMs
  else if (statement.includes("SELECT set_config('app.user_id'")) snapshot.userConfigMs = elapsedMs
  else if (statement.includes('FROM "agent_sessions"') && statement.includes("FOR UPDATE")) snapshot.sessionLockQueryMs = elapsedMs
  else if (statement.includes('FROM "sub_agent_tasks" AS task') && statement.includes("FOR UPDATE OF task")) snapshot.taskRowQueryMs = elapsedMs
  else if (statement.includes('FROM "agent_wait_conditions"') && statement.includes('"consumedAt" IS NOT NULL')) snapshot.consumedWaitScanMs = elapsedMs
  else if (statement.includes('"leaseExpiresAt" > clock_timestamp() FOR UPDATE')) snapshot.finalLeaseFenceQueryMs = elapsedMs
  else if (sql === "COMMIT") snapshot.commitMs = elapsedMs
  const isWaitSourceQuery = ["agent_wait_conditions", "agent_steps", "agent_items", "agent_events"]
    .some(table => statement.includes(`FROM "${table}"`))
  if (isWaitSourceQuery && !statement.includes('"consumedAt" IS NOT NULL') && !statement.includes('"leaseExpiresAt" > clock_timestamp() FOR UPDATE')) {
    snapshot.repairSourceQueryCount = Math.min(4096, snapshot.repairSourceQueryCount + 1)
    snapshot.repairSourceQueryTotalMs = Math.min(MAX_DIAGNOSTIC_DURATION_MS, snapshot.repairSourceQueryTotalMs + (elapsedMs ?? 0))
    snapshot.repairSourceQueryMaxMs = Math.max(snapshot.repairSourceQueryMaxMs, elapsedMs ?? 0)
  }
}
async function start(mode) {
  installWaitResolverDiagnostics(say)
  const ownerId = `p1143-worker-${process.pid}`
  const taskStore = mode === "park" ? undefined : withWaitingFinishDiagnostics(new PgSubagentTaskStore(pool, fixtureLeaseMs))
  const taskAliases = new Map()
  if (taskStore && restartRecovery) {
    installClaimDiagnostics(taskStore, taskAliases)
    installHeartbeatDiagnostics(taskStore, taskAliases)
  }
  const manager = taskStore ? new AgentTreeManager(taskStore, { heartbeatMs: fixtureHeartbeatMs }) : undefined
  let recoveryStage = "manager_recover"
  if (mode === "resume" && manager) {
    const recoveryMarkers = new Set()
    const reportRecoveryMarker = marker => { if (!recoveryMarkers.has(marker)) { recoveryMarkers.add(marker); say(marker) } }
    const recover = manager.recover.bind(manager)
    manager.recover = async (...args) => {
      recoveryStage = "manager_recover"
      try {
        const report = await recover(...args)
        recoveryStage = "dispatch"
        const depthTwo = report.rows.filter(row => row.depth === 2 && row.role === "scout" && row.taskType === "job_discovery")
        reportRecoveryMarker(depthTwo.some(row => row.status === "queued") ? "P1143_RECOVERY_DEPTH2_QUEUED"
          : depthTwo.length ? "P1143_RECOVERY_DEPTH2_NOT_QUEUED" : "P1143_RECOVERY_NO_DEPTH2_ROW")
        return report
      } catch (error) {
        recoveryStage = "manager_recover"
        throw error
      }
    }
    const originalConsoleError = console.error.bind(console)
    console.error = (...args) => {
      if (args[0] === "[subagent-recovery] scan failed:") {
        say(`P1143_RECOVERY_ERROR:${recoveryStage}:${recoveryErrorClass(args[1])}`)
        return
      }
      originalConsoleError(...args)
    }
  }
  const runtime = await createCanonicalTurnRuntime(pool, {
    workerId: ownerId, productionFlags: flags, taskGraphCommandPort: createPgTaskGraphCommandPort(pool),
    taskGraphTemplates: TASK_GRAPH_TEMPLATES, authorizeUsage: async () => { say("P1143_ROOT_USAGE_AUTHORIZER_CALLED"); try { return { outputReservationRequired: false, maxOutputTokens: null, settle: async () => undefined, settleUnknown: async () => undefined } } catch (error) { say(`P1143_ROOT_USAGE_AUTHORIZER_ERROR:${recoveryErrorClass(error, true)}`); throw error } },
    ...(manager ? { manager } : {}),
    modelRuntimeFactory: () => { say("P1143_ROOT_MODEL_RUNTIME_FACTORY_ENTERED"); try { const model = rootModelRuntime(); say("P1143_ROOT_MODEL_RUNTIME_FACTORY_CREATED"); return model } catch (error) { say(`P1143_ROOT_MODEL_RUNTIME_FACTORY_ERROR:${recoveryErrorClass(error, true)}`); throw error } },
  })
  const markerState = { closedStepRejected: false, parallelObserved: false }
  let resumeLoaderDiagnosticCount = 0
  const executeChild = createProductionChildExecutor({ pool, subagentManager: () => runtime.manager,
    authorizeUsage: async () => ({ outputReservationRequired: false, maxOutputTokens: null,
      settle: async () => undefined, settleUnknown: async () => undefined }), jobDiscoveryClient: discoveryClient(),
    resumeLoader: async lease => {
      let stage = "repair_consumed_waits", connection = 0
      const repairStartedAt = Date.now()
      const repairStartedAtMonotonic = performance.now()
      const repairTimings = createRepairTimingSnapshot()
      let repairTaskSnapshot = null
      const loader = createProductionChildResumeLoaders({ connect: async () => {
        const connectionStage = ["repair_consumed_waits", "durable_wait_resume", "child_attempt_resume"][connection++] ?? "other"
        stage = connectionStage
        const connectStartedAt = performance.now()
        const client = await pool.connect()
        if (connectionStage === "repair_consumed_waits") {
          repairTimings.poolConnectMs = boundedDurationMs(connectStartedAt)
          const originalQuery = client.query
          const query = originalQuery.bind(client)
          const originalRelease = client.release
          client.query = (...args) => {
            const statement = typeof args[0] === "string" ? args[0] : args[0]?.text
            const queryStartedAt = performance.now()
            const result = query(...args)
            if (typeof statement !== "string" || !result || typeof result.then !== "function") return result
            return result.then(response => {
              const queryElapsedMs = boundedDurationMs(queryStartedAt)
              recordRepairQueryTiming(repairTimings, statement, queryElapsedMs)
              if (!statement.includes('FROM "sub_agent_tasks" AS task') || !statement.includes("FOR UPDATE OF task")) return response
              const row = response.rows?.[0]
              const observedAt = Date.now()
              if (!row) {
                repairTaskSnapshot = { present: false, status: "missing", rowAttempt: "other", leaseState: "missing",
                  ownerFence: "unavailable", attemptFence: "unavailable", scopeFence: "unavailable",
                  expiryAtRepairStart: "unavailable", expiryAtRowRead: "unavailable", interruptRequested: "unavailable" }
                return response
              }
              const rowAttempt = Number(row.attemptCount)
              const status = SAFE_TASK_STATUSES.has(row.status) ? row.status : "other"
              const expiryAtRepairStart = boundedExpiryBucket(row.leaseExpiresAt, repairStartedAt)
              const expiryAtRowRead = boundedExpiryBucket(row.leaseExpiresAt, observedAt)
              const ownerFence = typeof row.leaseOwner !== "string" ? "absent" : row.leaseOwner === lease.ownerId ? "match" : "mismatch"
              repairTaskSnapshot = {
                present: true, status,
                rowAttempt: boundedAttempt(rowAttempt),
                leaseState: ownerFence === "absent" ? "owner_absent" : expiryAtRowRead === "unavailable" ? "expiry_absent"
                  : expiryAtRowRead === "expired" ? "expired" : "live",
                ownerFence,
                attemptFence: Number.isSafeInteger(rowAttempt) && rowAttempt === lease.attemptCount ? "match" : "mismatch",
                scopeFence: row.id === lease.id && row.userId === lease.userId && row.sessionId === lease.sessionId
                  && row.turnId === lease.turnId && row.rootTaskId === lease.rootTaskId ? "match" : "mismatch",
                expiryAtRepairStart, expiryAtRowRead,
                interruptRequested: row.interruptRequestedAt == null ? "absent" : "present",
              }
              return response
            })
          }
          client.release = (...args) => {
            client.query = originalQuery
            client.release = originalRelease
            return originalRelease.apply(client, args)
          }
        }
        return client
      } }).resumeLoader
      try { return await loader(lease) }
      catch (error) {
        if (resumeLoaderDiagnosticCount < MAX_LEASE_DIAGNOSTICS) {
          resumeLoaderDiagnosticCount += 1
          const validationStage = error && typeof error === "object" && SAFE_WAIT_RESUME_DIAGNOSTIC_STAGES.has(error.sourceLifecycleStage) ? error.sourceLifecycleStage : error && typeof error === "object" && SAFE_WAIT_RESUME_DIAGNOSTIC_STAGES.has(error.resumeValidationStage) ? error.resumeValidationStage : "other"
          try {
            say(`P1143_CHILD_RESUME_LOADER_DIAGNOSTIC:${JSON.stringify({ ...safeLeaseDiagnostic(lease), stage, errorCode: recoveryErrorClass(error, true), validationStage })}`)
            if (stage === "repair_consumed_waits") say(`P1143_REPAIR_LEASE_ROW_DIAGNOSTIC:${JSON.stringify({
              task: fixtureTaskAlias(lease), attempt: boundedAttempt(lease.attemptCount),
              leaseVersion: boundedAttempt(lease.attemptCount), leaseVersionSource: "attemptCount",
              guard: error?.message === "Child task lease is stale" ? "row_lease_stale"
                : error?.message === "Current child lease expired during consumed wait repair" ? "post_query_lease_lost"
                  : error?.message === "Current child lease is unavailable for consumed wait repair" ? "lease_input_unavailable" : "other",
              ...(repairTaskSnapshot ?? { present: false, status: "unavailable", rowAttempt: "other", leaseState: "unavailable",
                ownerFence: "unavailable", attemptFence: "unavailable", scopeFence: "unavailable",
                expiryAtRepairStart: "unavailable", expiryAtRowRead: "unavailable", interruptRequested: "unavailable" }),
            })}`)
            if (stage === "repair_consumed_waits") {
              repairTimings.elapsedMs = boundedDurationMs(repairStartedAtMonotonic)
              say(`P1143_REPAIR_TIMING_DIAGNOSTIC:${JSON.stringify({
                task: fixtureTaskAlias(lease), attempt: boundedAttempt(lease.attemptCount),
                leaseVersion: boundedAttempt(lease.attemptCount), leaseVersionSource: "attemptCount", ...repairTimings,
              })}`)
            }
          } catch {}
        }
        throw error
      }
    }, modelRuntimeFactory: input => childModelRuntime({ ...input, runtime, markerState }), durableWaitResumeCommitter: waitResumeCommitter() })
  const execute = createCrashFixtureExecutor(mode, executeChild, say)
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 100,
    waitResolver: { intervalMs: 20, ownerId: `${ownerId}-wait-resolver` },
    subagents: { intervalMs: 20, execute, queueFactory: options => {
      const consumer = createSubagentQueue(options)
      consumer.worker.concurrency = mode === "park" || mode === "crash-child" ? 1 : 2
      return consumer
    } } })
  if (mode === "park") {
    const { enqueueTurn } = await import("../turns/turn-queue.ts")
    await enqueueTurn(pool, bootstrap.turns.queue, { turnId: ids.turnId, sessionId: ids.sessionId, ownerId })
  }
  return { runtime }
}
async function parentWaiting() {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    const row = await pool.query(`SELECT parent."id" FROM "sub_agent_tasks" parent
      JOIN "agent_wait_conditions" wait ON wait."parentTaskId" = parent."id"
      WHERE parent."sessionId" = $1 AND parent."depth" = 1 AND parent."role" = 'scout'
        AND parent."status" = 'waiting' AND parent."leaseOwner" IS NULL
        AND wait."status" = 'waiting' AND wait."suspendedAt" IS NOT NULL`, [ids.sessionId])
    if (row.rowCount === 1) { say("P1143_PARENT_WAITING"); return }
    await sleep(50)
  }
  throw new Error("p1143_parent_did_not_suspend_without_lease")
}
async function crashChildClaimed() {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT count(*)::int AS count FROM "sub_agent_tasks" AS child
      JOIN "sub_agent_tasks" AS parent ON parent."id" = child."parentTaskId" AND parent."sessionId" = child."sessionId"
      WHERE child."sessionId" = $1 AND child."depth" = 2 AND child."role" = 'scout'
        AND child."taskType" = 'job_discovery' AND child."status" = 'running' AND child."leaseOwner" IS NOT NULL
        AND parent."status" = 'waiting' AND EXISTS (SELECT 1 FROM "agent_wait_conditions" AS wait
          WHERE wait."parentTaskId" = parent."id" AND wait."sessionId" = child."sessionId"
            AND wait."turnId" = child."turnId" AND wait."status" = 'waiting' AND wait."suspendedAt" IS NOT NULL)`, [ids.sessionId])
    if (result.rows[0]?.count === 1) { say("P1143_CHILD_WORKER_CLAIMED_RUNNING"); return }
    await sleep(25)
  }
  throw new Error("p1143_crash_child_did_not_claim")
}
async function rootCompleted() {
  const deadline = Date.now() + 250_000
  while (Date.now() < deadline) {
    const turn = await pool.query(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [ids.turnId, ids.sessionId])
    if (turn.rows[0]?.status === "failed") throw new Error("p1143_root_turn_failed")
    if (turn.rows[0]?.status !== "completed") { await sleep(100); continue }
    const roots = await pool.query(`SELECT "rootTaskId" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [ids.turnId, ids.sessionId, ids.userId])
    const rootTaskId = roots.rows[0]?.rootTaskId
    if (roots.rowCount !== 1 || typeof rootTaskId !== "string" || !rootTaskId) {
      throw new Error("p1143_root_graph_completion_unverified")
    }
    // agent_items stores the plan snapshot; runtime status/readiness/report come from the production read model.
    const loaded = await loadTaskGraph(pool, {
      userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
      rootTaskId, parentTaskId: rootTaskId,
    }, false)
    const state = currentTaskGraph(loaded)
    const node = state.nodes.length === 1 ? state.nodes[0] : null
    if (!node || typeof node !== "object" || Array.isArray(node) || node.status !== "completed"
      || node.readiness !== "terminal" || node.verificationReport?.status !== "passed") {
      throw new Error("p1143_root_graph_completion_unverified")
    }
    say("P1143_ROOT_GRAPH_COMPLETED")
    return
  }
  throw new Error("p1143_root_turn_did_not_complete_after_child_join")
}
try {
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true" || !process.env.AGENT_RUNTIME_PG_TEST_URL
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || process.env.REDIS_URL !== process.env.AGENT_TURN_REDIS_TEST_URL) {
    throw new Error("p1143_fixture_requires_disposable_ci_services")
  }
  const { runtime } = await start(mode)
  if (mode === "park") await parentWaiting()
  else if (mode === "crash-child") await crashChildClaimed()
  else await rootCompleted()
  await command("shutdown")
} catch (error) {
  const code = error instanceof Error && FIXTURE_FAILURE_CODES.has(error.message) ? error.message : "redacted"
  say(`P1143_FIXTURE_FAILURE:${code}`)
  process.exitCode = 1
} finally {
  try { if (bootstrap) await bootstrap.close() } catch { process.exitCode = 1 }
  await pool.end().catch(() => { process.exitCode = 1 })
}
