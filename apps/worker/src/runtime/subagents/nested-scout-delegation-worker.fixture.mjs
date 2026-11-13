import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.ts"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.ts"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.ts"
import { createProductionChildExecutor } from "./production-child-runtime.ts"
import { commitDurableSubagentWaitResume } from "./durable-subagent-wait-resume.ts"
import { createProductionWorkerBootstrap } from "../../queue/production-bootstrap.ts"
import { createSubagentQueue } from "../../queue/subagent-queue.ts"
import { enqueueTurn } from "../turns/turn-queue.ts"
import { createNestedScoutFixtureScripts } from "./nested-scout-delegation-worker-fixture-scripts.mjs"

const [, , mode, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 10 })
let bootstrap
async function pauseSubagentClaims() {
  if (!bootstrap?.subagents) throw new Error("p1143_subagent_queue_unavailable")
  await bootstrap.subagents.queue.worker.pause(true)
}
const profile = { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
  continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false,
  supportsResponseContinuation: false, supportsProviderConversation: false, supportsBackgroundResponse: false,
  maxContextTokens: null, maxOutputTokens: 256, costClass: "low" }
const flags = { cognitiveLoopEnabled: false, planningEnabled: true, planningExecutionEnabled: true, taskGraphPlanningEnabled: true,
  childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false }
const FIXTURE_FAILURE_CODES = new Set([
  "p1143_children_did_not_overlap_in_running_state", "p1143_delegate_tool_missing", "p1143_grandchild_coordination_leaked",
  "p1143_grandchild_discover_tool_missing", "p1143_grandchild_discovery_failed", "p1143_grandchild_source_bound_job_missing",
  "p1143_grandchild_source_evidence_missing", "p1143_parent_current_reads_missing", "p1143_parent_discovery_tool_missing",
  "p1143_parent_discovery_failed", "p1143_parent_lease_unavailable", "p1143_alpha_delegate_failed", "p1143_beta_delegate_failed",
  "p1143_parent_wait_failed", "p1143_parent_job_read_failed", "p1143_fixture_tool_result_unexpected_error",
  "p1143_fixture_tool_pair_request_invalid", "p1143_fixture_tool_pair_call_invalid", "p1143_fixture_tool_pair_call_ambiguous",
  "p1143_fixture_tool_pair_result_ambiguous", "p1143_fixture_tool_pair_result_invalid", "p1143_fixture_wait_input_invalid",
  "p1143_root_plan_tool_missing", "p1143_root_scout_task_missing", "p1143_root_scout_verification_missing",
  "p1143_scout_results_not_available_after_wait", "p1143_scout_results_tool_missing", "p1143_second_delegate_tool_missing",
  "p1143_source_escalation_was_not_rejected", "p1143_stale_step_created_child", "p1143_stale_step_was_accepted",
  "p1143_step_fence_fixture_missing_steps", "p1143_fixture_requires_disposable_ci_services", "p1143_parent_did_not_suspend_without_lease",
  "p1143_root_graph_completion_unverified", "p1143_root_turn_did_not_complete_after_child_join", "p1143_root_turn_failed",
  "p1143_subagent_queue_unavailable",
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
      return await commitDurableSubagentWaitResume(pool, lease, {
        waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal,
      })
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
const { rootModelRuntime, discoveryClient, childModelRuntime } = createNestedScoutFixtureScripts({ mode, profile, ids, pool, say,
  pauseSubagentClaims, reportParentJoinState })
function command(name) {
  const index = commands.indexOf(name)
  if (index >= 0) { commands.splice(index, 1); return Promise.resolve() }
  return new Promise(resolve => { const values = waiters.get(name) ?? []; values.push(resolve); waiters.set(name, values) })
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
async function start(mode) {
  const ownerId = `p1143-worker-${process.pid}`
  const runtime = await createCanonicalTurnRuntime(pool, {
    workerId: ownerId, productionFlags: flags, taskGraphCommandPort: createPgTaskGraphCommandPort(pool),
    taskGraphTemplates: TASK_GRAPH_TEMPLATES, authorizeUsage: async () => ({ settle: async () => undefined }),
    modelRuntimeFactory: () => rootModelRuntime(),
  })
  const markerState = { closedStepRejected: false, parallelObserved: false }
  const executeChild = createProductionChildExecutor({ pool, subagentManager: () => runtime.manager,
    authorizeUsage: async () => ({ settle: async () => undefined }), jobDiscoveryClient: discoveryClient(),
    modelRuntimeFactory: input => childModelRuntime({ ...input, runtime, markerState }), durableWaitResumeCommitter: waitResumeCommitter() })
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 100,
    waitResolver: { intervalMs: 20, ownerId: `${ownerId}-wait-resolver` },
    subagents: { intervalMs: 20, execute: executeChild, queueFactory: options => {
      const consumer = createSubagentQueue(options)
      consumer.worker.concurrency = mode === "park" ? 1 : 2
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
