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

const [, , mode, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 10 })
const CRASH_TEST_LEASE_MS = 3_000
const CRASH_TEST_HEARTBEAT_MS = 500
const SAFE_RECOVERY_ERROR_CODES = new Set([
  "subagent_dispatch_delivery_uncertain", "lost", "40001", "40P01", "55P03", "57014", "08000", "08003", "08006", "57P01",
  "ECONNRESET", "ETIMEDOUT", "child_resume_owner_mismatch", "child_resume_lease_expired",
  "child_resume_wait_tool_call_conflict", "child_resume_wait_step_lineage", "child_resume_wait_lineage", "child_resume_invalid_wait_result",
  "child_resume_step_lineage", "child_resume_item_lineage", "child_resume_step_limit", "child_resume_item_limit", "child_resume_usage_overflow",
])
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
    if (typeof code === "string") return SAFE_RECOVERY_ERROR_CODES.has(code) ? code : "other"
    return error instanceof Error ? "error" : "unknown"
  } catch { return "unknown" }
}
async function start(mode) {
  const ownerId = `p1143-worker-${process.pid}`
  const manager = mode === "park" ? undefined : new AgentTreeManager(
    new PgSubagentTaskStore(pool, CRASH_TEST_LEASE_MS), { heartbeatMs: CRASH_TEST_HEARTBEAT_MS },
  )
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
  const productionResumeLoader = createProductionChildResumeLoaders(pool).resumeLoader
  if (typeof productionResumeLoader !== "function") throw new Error("p1143_resume_loader_unavailable")
  const executeChild = createProductionChildExecutor({ pool, subagentManager: () => runtime.manager,
    authorizeUsage: async () => ({ outputReservationRequired: false, maxOutputTokens: null,
      settle: async () => undefined, settleUnknown: async () => undefined }), jobDiscoveryClient: discoveryClient(),
    resumeLoader: async lease => {
      try { return await productionResumeLoader(lease) }
      catch (error) { say(`P1143_CHILD_RESUME_LOADER_DIAGNOSTIC:${recoveryErrorClass(error, true)}`); throw error }
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
