import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../runtime/canonical-turn-runtime.ts"
import { createProductionWorkerBootstrap } from "./production-bootstrap.ts"
import { enqueueTurn } from "../runtime/turns/turn-queue.ts"

const [, , mode, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const resultMarker = "durable-child-result-after-process-restart"
const finalMarker = "parent-resumed-from-durable-child-result"
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 5 })
let bootstrap
let stopping = false
let stdinBuffer = ""
const queuedCommands = []
const commandWaiters = new Map()

process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const line of lines) {
    const command = line.trim()
    if (!command) continue
    const waiters = commandWaiters.get(command)
    const resolve = waiters?.shift()
    if (resolve) {
      if (waiters.length === 0) commandWaiters.delete(command)
      resolve()
    } else queuedCommands.push(command)
  }
})

function say(value) {
  process.stdout.write(`${value}\n`)
}

function waitForCommand(command) {
  const queuedIndex = queuedCommands.indexOf(command)
  if (queuedIndex >= 0) {
    queuedCommands.splice(queuedIndex, 1)
    return Promise.resolve()
  }
  return new Promise(resolve => {
    const waiters = commandWaiters.get(command) ?? []
    waiters.push(resolve)
    commandWaiters.set(command, waiters)
  })
}

async function waitForStop() {
  await waitForCommand("shutdown")
  stopping = true
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForSuspendedParent(turnId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query(`SELECT wait."suspendedAt", turn."status"
      FROM "agent_wait_conditions" AS wait JOIN "agent_turns" AS turn ON turn."id" = wait."turnId"
      WHERE wait."turnId" = $1 AND wait."status" = 'waiting'`, [turnId])
    if (result.rows[0]?.suspendedAt && result.rows[0]?.status === "waiting_for_dependency") return
    await sleep(20)
  }
  throw new Error("parent_wait_not_suspended")
}

function spawnedTaskId(request, spawnCallId) {
  for (const message of request.messages) {
    for (const part of message.content) {
      if (part.type !== "tool_result" || part.toolUseId !== spawnCallId || typeof part.content !== "string") continue
      const output = JSON.parse(part.content)
      if (typeof output.taskId === "string" && output.taskId.length > 0) return output.taskId
    }
  }
  throw new Error("canonical_spawn_result_missing_from_next_model_request")
}

function assertCoordinationToolsVisible(request) {
  const names = request.tools.flatMap(tool => tool && typeof tool === "object" && typeof tool.name === "string" ? [tool.name] : [])
  if (!names.includes("agent.spawn") || !names.includes("agent.wait")) throw new Error("canonical_coordination_tools_not_visible")
}

async function makeFirstWorker() {
  const runtime = await createCanonicalTurnRuntime(pool, {
    workerId: `restart-worker-${process.pid}`,
    coordinationEnabled: true,
    authorizeUsage: async () => ({ settle() {} }),
    modelRuntimeFactory() {
      let modelCalls = 0
      const spawnCallId = `restart-spawn-${ids.suffix}`
      return {
        adapter: {
          id: "worker-restart-parent-fixture-model",
          profile: modelProfile(),
          async *stream(request) {
            assertCoordinationToolsVisible(request)
            modelCalls += 1
            if (modelCalls === 1) {
              yield {
                type: "tool_call_completed", callId: spawnCallId, name: "agent.spawn",
                arguments: {
                  idempotencyKey: `process-restart-spawn:${ids.turnId}`,
                  role: "analyst", taskType: "research",
                  goal: "Produce a deterministic result for process-restart acceptance",
                  successCriteria: ["Persist the fixture result before the Worker is stopped"],
                  context: { fixture: "process-restart" },
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (modelCalls === 2) {
              const taskId = spawnedTaskId(request, spawnCallId)
              yield {
                type: "tool_call_completed", callId: `restart-wait-${ids.suffix}`, name: "agent.wait",
                arguments: {
                  idempotencyKey: `process-restart-wait:${ids.turnId}`,
                  taskIds: [taskId], mode: "all", timeoutMs: 30_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            throw new Error("unexpected_parent_model_round_before_restart")
          },
        },
        registry: {}, candidates: [],
      }
    },
  })
  bootstrap = await createProductionWorkerBootstrap({
    pool, runtime, ownerId: `restart-worker-${process.pid}`, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: `restart-wait-resolver-${process.pid}` },
    subagents: {
      intervalMs: 10,
      async execute({ lease }) {
        await waitForSuspendedParent(lease.turnId)
        say("PARENT_SUSPENDED")
        await waitForCommand("persist-child-result")
        return { status: "completed", result: { proof: resultMarker, taskId: lease.id } }
      },
    },
  })
  await enqueueTurn(pool, bootstrap.turns.queue, {
    turnId: ids.turnId, sessionId: ids.sessionId, ownerId: `restart-worker-${process.pid}`,
  })
  const deadline = Date.now() + 15_000
  while (!stopping && Date.now() < deadline) {
    const result = await pool.query(`SELECT turn."status" AS "turnStatus", turn."leaseOwnerId", task."status" AS "childStatus",
        wait."status" AS "waitStatus", wait."suspendedAt", dispatch."publishedAt" AS "dispatchPublishedAt"
      FROM "agent_turns" AS turn
      LEFT JOIN "sub_agent_tasks" AS task ON task."turnId" = turn."id" AND task."role" = 'analyst'
      LEFT JOIN "agent_wait_conditions" AS wait ON wait."turnId" = turn."id" AND wait."parentTaskId" = turn."rootTaskId"
      LEFT JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = turn."sessionId"
        AND dispatch."topic" = 'agent.turn.dispatch' AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
      WHERE turn."id" = $1`, [ids.turnId])
    const row = result.rows[0]
    if (row?.turnStatus === "queued" && row?.leaseOwnerId === null && row?.childStatus === "completed"
      && row?.waitStatus === "ready" && row?.suspendedAt && row?.dispatchPublishedAt) {
      say("READY_TO_RESTART")
      await waitForStop()
      return
    }
    await sleep(20)
  }
  if (!stopping) throw new Error("restart_fixture_timeout")
}

function modelProfile() {
  return {
    provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
  }
}

async function makeSecondWorker() {
  const runtime = await createCanonicalTurnRuntime(pool, {
    workerId: `restart-worker-${process.pid}`,
    consumeWaitOutcomes: true,
    coordinationEnabled: false,
    authorizeUsage: async () => ({ settle() {} }),
    modelRuntimeFactory({ state }) {
      const observations = JSON.stringify(state.snapshot.toolObservations)
      if (!observations.includes(resultMarker)) throw new Error("restart_resume_missing_persisted_child_result")
      say("RESUME_CONTEXT_OK")
      return {
        adapter: {
          id: "worker-restart-fixture-model",
          profile: modelProfile(),
          async *stream() {
            yield { type: "text_delta", text: finalMarker }
            yield { type: "completed", finishReason: "stop" }
          },
        },
        registry: {}, candidates: [],
      }
    },
  })
  bootstrap = await createProductionWorkerBootstrap({
    pool, runtime, ownerId: `restart-worker-${process.pid}`, turnRecoveryIntervalMs: 10,
    waitResolver: { intervalMs: 10, ownerId: `restart-wait-resolver-${process.pid}` },
  })
  say("SECOND_WORKER_READY")
  await waitForStop()
}

async function run() {
  if (mode === "park-parent") await makeFirstWorker()
  else if (mode === "resume-parent") await makeSecondWorker()
  else throw new Error("unknown_restart_fixture_mode")
}

try {
  await run()
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
} finally {
  if (bootstrap) await bootstrap.close().catch(error => process.stderr.write(`bootstrap_close: ${String(error)}\n`))
  await pool.end().catch(() => undefined)
  const { closeSharedRedisConnections } = await import("../redis.ts")
  await closeSharedRedisConnections().catch(() => undefined)
}
