import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { createPgTaskGraphCommandPort } from "../subagents/pg-task-graph-command-port.ts"
import { taskGraphRuntimeOptions } from "../subagents/task-graph-templates.ts"
import { startProductionAgentRuntime as startProductionAgentRuntimeHelper } from "../../queue/production-bootstrap.ts"
import { startProductionWorkerRuntime } from "../../queue/production-worker-runtime.ts"
const [, , mode, rawInput] = process.argv
const input = JSON.parse(rawInput)
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 5 })
let bootstrap
let stdinBuffer = ""
let stopping = false
let modelStreamCalls = 0
let crossSessionSourceQueries = 0
const commandWaiters = new Map()
const queuedCommands = []
const noOpProjection = { start: async () => undefined, finish: async () => undefined }
function say(line) { process.stdout.write(`${line}\n`) }
function waitForCommand(command) {
  const queued = queuedCommands.indexOf(command)
  if (queued >= 0) { queuedCommands.splice(queued, 1); return Promise.resolve() }
  return new Promise(resolve => {
    const waiters = commandWaiters.get(command) ?? []
    waiters.push(resolve)
    commandWaiters.set(command, waiters)
  })
}
function onStdinData(chunk) {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const line of lines) {
    const command = line.trim()
    if (!command) continue
    const waiters = commandWaiters.get(command)
    const resolve = waiters?.shift()
    if (resolve) {
      if (!waiters.length) commandWaiters.delete(command)
      resolve()
    } else queuedCommands.push(command)
  }
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", onStdinData)
function instrumentCandidateWindowQueries() {
  const connect = pool.connect.bind(pool)
  const instrument = client => {
    const query = client.query.bind(client)
    client.query = (statement, ...args) => {
      const sql = typeof statement === "string" ? statement : statement?.text
      if (typeof sql === "string" && sql.includes("WITH terminal_window AS MATERIALIZED") && sql.includes("AS source_session")) crossSessionSourceQueries += 1
      return query(statement, ...args)
    }
    return client
  }
  pool.connect = (...args) => {
    const callback = args[0]
    if (typeof callback === "function") {
      return connect((error, client, release) => callback(error, client ? instrument(client) : client, release))
    }
    return connect().then(instrument)
  }
}
function modelProfile() {
  return {
    provider: "fixture", model: "objective-snapshot-fixture", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
  }
}
function historyProjection(request) {
  const matches = []
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.type !== "text" || typeof part.text !== "string") continue
      for (const line of part.text.split("\n")) {
        if (!line.startsWith("{")) continue
        try {
          const value = JSON.parse(line)
          if (value?.historical === true) matches.push(value)
        } catch { /* Other context blocks are not JSON projections. */ }
      }
    }
  }
  const privateText = JSON.stringify(request.messages)
  const snapshot = matches[0]
  if (matches.length !== 1 || !Array.isArray(snapshot?.turns) || snapshot.turns.length !== 1
    || !snapshot.turns[0]?.nodes?.some(node => node.taskKind === "analyst" && node.status === "completed")
    || ["PRIVATE_SOURCE_NODE_GOAL", "PRIVATE_SOURCE_CRITERION", "PRIVATE_SOURCE_RESULT"].some(value => privateText.includes(value))) {
    throw new Error("objective_snapshot_context_invalid")
  }
}
function spawnedTaskId(request, callId) {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool_result" || part.toolUseId !== callId || typeof part.content !== "string") continue
      const result = JSON.parse(part.content)
      if (typeof result.taskId === "string" && result.taskId.length) return result.taskId
    }
  }
  throw new Error("objective_snapshot_spawn_result_missing")
}
function waitForHistorySuspension(turnId) {
  return (async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const result = await pool.query(`SELECT turn."status", wait."status" AS "waitStatus", wait."suspendedAt"
        FROM "agent_turns" turn JOIN "agent_wait_conditions" wait ON wait."turnId"=turn."id"
        WHERE turn."id"=$1 AND wait."idempotencyKey"=$2`, [turnId, `objective-snapshot-wait:${turnId}`])
      if (result.rows[0]?.status === "waiting_for_dependency" && result.rows[0]?.waitStatus === "waiting"
        && result.rows[0]?.suspendedAt) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error("objective_snapshot_parent_did_not_suspend")
  })()
}
async function waitForRestartReady(turnId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !stopping) {
    const result = await pool.query(`SELECT turn."status", wait."status" AS "waitStatus", wait."consumedAt",
        dispatch."publishedAt", dispatch."attemptCount"
      FROM "agent_turns" turn JOIN "agent_wait_conditions" wait ON wait."turnId"=turn."id"
      JOIN "agent_outbox" dispatch ON dispatch."aggregateId"=turn."sessionId" AND dispatch."topic"='agent.turn.dispatch'
        AND dispatch."idempotencyKey"='turn-dispatch:'||turn."id"
      WHERE turn."id"=$1 AND wait."idempotencyKey"=$2`, [turnId, `objective-snapshot-wait:${turnId}`])
    const row = result.rows[0]
    if (row?.status === "queued" && row.waitStatus === "ready" && !row.consumedAt && row.publishedAt && Number(row.attemptCount) >= 2) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("objective_snapshot_restart_boundary_missing")
}
async function startRuntime(firstWorker) {
  const workerId = `objective-snapshot-${firstWorker ? "worker-a" : "worker-b"}-${process.pid}`
  const childExecutor = async ({ lease }) => {
    say("FIXTURE_CHILD_EXECUTOR_STARTED")
    await waitForHistorySuspension(lease.turnId)
    say("FIXTURE_PARENT_SUSPENDED")
    await waitForCommand("complete-child")
    return { status: "completed", result: { proof: "objective-snapshot-child-completed", taskId: lease.id } }
  }
  const runtimeOptions = {
    authorizeUsage: async () => ({ settle() {} }),
    modelRuntimeFactory() {
      let calls = 0
      return { adapter: { id: "objective-snapshot-fixture-model", profile: modelProfile(), async *stream(request) {
        modelStreamCalls += 1; if (firstWorker) {
          say("FIXTURE_MODEL_STREAM_ENTERED_A")
          try { historyProjection(request) } catch { say("FIXTURE_MODEL_CONTEXT_A_INVALID"); throw new Error("objective_snapshot_context_invalid") }
          calls += 1
          if (calls === 1) {
            say("FIXTURE_MODEL_CONTEXT_A_OK"); await waitForCommand("continue-turn")
            yield { type: "tool_call_completed", callId: "objective-snapshot-spawn", name: "agent.spawn", arguments: {
              idempotencyKey: `objective-snapshot-spawn:${input.turnId}`, role: "analyst", taskType: "research",
              goal: "Return the deterministic restart result", successCriteria: ["Persist the restart result"],
              context: { fixture: "objective-snapshot-process-restart" },
            } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          if (calls === 2) {
            const taskId = spawnedTaskId(request, "objective-snapshot-spawn")
            yield { type: "tool_call_completed", callId: "objective-snapshot-wait", name: "agent.wait", arguments: {
              idempotencyKey: `objective-snapshot-wait:${input.turnId}`, taskIds: [taskId], mode: "all", timeoutMs: 30_000,
            } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          throw new Error("objective_snapshot_worker_a_unexpected_stream")
        }
        if (mode === "worker-b-corrupt") { say("FIXTURE_MODEL_STREAM_ENTERED_B"); throw new Error("objective_snapshot_corrupt_snapshot_reached_stream") }
        say("FIXTURE_MODEL_STREAM_ENTERED_B")
        historyProjection(request)
        say("FIXTURE_MODEL_CONTEXT_B_OK")
        say(`FIXTURE_CROSS_SESSION_SOURCE_QUERY_COUNT_B ${crossSessionSourceQueries}`)
        await waitForCommand("release-model")
        yield { type: "text_delta", text: "objective-snapshot-worker-restart-fixture-complete" }
        yield { type: "completed", finishReason: "stop" }
      } }, registry: {}, candidates: [] }
    },
  }
  const flags = {
    taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: true,
    canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false, crossSessionRootTaskHistoryEnabled: true,
    objectiveHistoryIndexEnabled: false,
  }
  await startProductionWorkerRuntime({ pool, workerId, productionFlags: flags, onBootstrapReady(value) { bootstrap = value },
    startAgentRunWorker() {} }, {
    createOptionalProductionChildExecutor({ enabled }) { return enabled ? childExecutor : undefined },
    createCanonicalTurnRuntime(runtimePool, productionOptions) {
      const commandPort = productionOptions.productionFlags?.taskGraphPlanningEnabled
        ? createPgTaskGraphCommandPort(runtimePool) : undefined
      return createCanonicalTurnRuntime(runtimePool, { ...runtimeOptions, ...productionOptions, ...taskGraphRuntimeOptions(commandPort) })
    },
    createWorkerUsageAuthorizer() { return async () => ({ settle() {} }) },
    createCanonicalExecutionProjection() { return noOpProjection }, createCanonicalSessionProjection() { return noOpProjection },
    startProductionAgentRuntime(startupOptions) {
      return startProductionAgentRuntimeHelper({ ...startupOptions, bootstrapOptions: runtime => {
        const base = typeof startupOptions.bootstrapOptions === "function" ? startupOptions.bootstrapOptions(runtime) : startupOptions.bootstrapOptions
        return { ...base, ownerId: workerId, turnRecoveryIntervalMs: 10,
          waitResolver: { ...base?.waitResolver, intervalMs: 10, ownerId: `objective-snapshot-wait-${process.pid}` },
          subagents: { ...base?.subagents, intervalMs: 10 } }
      } })
    },
  })
}
async function waitForStop() {
  await waitForCommand("shutdown"); stopping = true
  process.stdin.off("data", onStdinData); process.stdin.pause(); process.stdin.destroy()
}
async function run() {
  if (!process.env.AGENT_RUNTIME_PG_TEST_URL || !process.env.AGENT_TURN_REDIS_TEST_URL) throw new Error("fixture_services_missing")
  instrumentCandidateWindowQueries()
  if (mode === "worker-a") {
    await startRuntime(true)
    say("FIXTURE_WORKER_READY_A")
    await waitForRestartReady(input.turnId)
    say(`FIXTURE_CROSS_SESSION_SOURCE_QUERY_COUNT_A ${crossSessionSourceQueries}`)
    say("FIXTURE_RESTART_BOUNDARY_READY")
  } else {
    await startRuntime(false)
    say("FIXTURE_WORKER_READY_B")
    if (mode === "worker-b-corrupt") {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT "status" FROM "agent_turns" WHERE "id"=$1`, [input.turnId])
        if (result.rows[0]?.status === "failed") break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (modelStreamCalls !== 0) throw new Error("objective_snapshot_stream_was_entered")
      const failed = await pool.query(`SELECT event."payload" FROM "agent_events" event
        WHERE event."turnId"=$1 AND event."type"='turn.failed' ORDER BY event."sequence" DESC LIMIT 1`, [input.turnId])
      if (failed.rows[0]?.payload?.errorCode !== "persistence_conflict") throw new Error("objective_snapshot_conflict_not_terminalized")
      say(`FIXTURE_CROSS_SESSION_SOURCE_QUERY_COUNT_B ${crossSessionSourceQueries}`)
      say("FIXTURE_MODEL_STREAM_NOT_ENTERED_B")
      say("FIXTURE_CORRUPTION_FAILED_CLOSED")
    }
  }
  await waitForStop()
}

try {
  await run()
} catch (error) {
  process.stderr.write(`OBJECTIVE_SNAPSHOT_RESTART_FIXTURE_FAILED_${error instanceof Error && error.message === "objective_snapshot_restart_boundary_missing" ? "RESTART_BOUNDARY_MISSING" : "UNCLASSIFIED"}\n`)
  process.exitCode = 1
} finally {
  process.stdin.off("data", onStdinData)
  process.stdin.pause()
  if (bootstrap) await bootstrap.close().catch(() => undefined)
  await pool.end().catch(() => undefined)
  const { closeSharedRedisConnections } = await import("../../redis.ts")
  await closeSharedRedisConnections().catch(() => undefined)
}
