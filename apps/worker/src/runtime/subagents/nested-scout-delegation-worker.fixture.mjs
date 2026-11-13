import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.ts"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.ts"
import { createProductionChildExecutor } from "./production-child-runtime.ts"
import { createProductionWorkerBootstrap } from "../../queue/production-bootstrap.ts"
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
const { rootModelRuntime, discoveryClient, childModelRuntime } = createNestedScoutFixtureScripts({ mode, profile, ids, pool, say, pauseSubagentClaims })
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
  const markerState = { blocked: new Set(), closedStepRejected: false, parallelObserved: false }
  const executeChild = createProductionChildExecutor({ pool, subagentManager: () => runtime.manager,
    authorizeUsage: async () => ({ settle: async () => undefined }), jobDiscoveryClient: discoveryClient(),
    modelRuntimeFactory: input => childModelRuntime({ ...input, runtime, markerState }) })
  bootstrap = await createProductionWorkerBootstrap({ pool, runtime, ownerId, turnRecoveryIntervalMs: 100,
    waitResolver: { intervalMs: 20, ownerId: `${ownerId}-wait-resolver` },
    subagents: { intervalMs: 20, execute: executeChild } })
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
    if (turn.rows[0]?.status !== "completed") { await sleep(100); continue }
    const latest = await pool.query(`SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
      AND "type" = 'task_graph' ORDER BY "revision" DESC LIMIT 1`, [ids.sessionId, ids.turnId])
    const graph = latest.rows[0]?.content
    const nodes = graph && typeof graph === "object" && !Array.isArray(graph) ? graph.nodes : null
    const node = Array.isArray(nodes) && nodes.length === 1 ? nodes[0] : null
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
  const code = error instanceof Error && /^p1143_[a-z_]+$/.test(error.message) ? error.message : "redacted"
  say(`P1143_FIXTURE_FAILURE:${code}`)
  process.exitCode = 1
} finally {
  try { if (bootstrap) await bootstrap.close() } catch { process.exitCode = 1 }
  await pool.end().catch(() => { process.exitCode = 1 })
}
