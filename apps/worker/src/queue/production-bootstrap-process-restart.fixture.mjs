import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../runtime/canonical-turn-runtime.ts"
import { createProductionWorkerBootstrap } from "./production-bootstrap.ts"

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
      if (waiters.length === 0) commandWaiters.delete(command)
      resolve()
    } else queuedCommands.push(command)
  }
}
process.stdin.on("data", onStdinData)

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
  process.stdin.off("data", onStdinData)
  process.stdin.pause()
  process.stdin.destroy()
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function runShutdownStage(name, action) {
  say(`SHUTDOWN_STAGE ${name}:start`)
  try {
    await action()
    say(`SHUTDOWN_STAGE ${name}:complete`)
  } catch (error) {
    say(`SHUTDOWN_STAGE ${name}:failed`)
    const message = error instanceof Error ? error.stack ?? error.message : String(error)
    process.stderr.write(`${name}: ${message}\n`)
    process.exitCode = 1
  }
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

async function restartDiagnostics() {
  const [turns, tasks, waits, dispatches, steps, items] = await Promise.all([
    pool.query(`SELECT "status", "leaseOwnerId", "leaseVersion", "rootTaskId" FROM "agent_turns" WHERE "id" = $1`, [ids.turnId]),
    pool.query(`SELECT "id", "parentTaskId", "rootTaskId", "role", "status", "attemptCount", "leaseOwner", "failureReason", "result"
      FROM "sub_agent_tasks" WHERE "turnId" = $1 ORDER BY "createdAt", "id"`, [ids.turnId]),
    pool.query(`SELECT "id", "parentTaskId", "status", "suspendedAt", "consumedAt", "targetTaskIds", "matchedTaskIds", "result"
      FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt", "id"`, [ids.turnId]),
    pool.query(`SELECT "topic", "idempotencyKey", "publishedAt", "attemptCount", "lastError", "payload"
      FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" IN ('agent.turn.dispatch', 'agent.subagent.dispatch')
      ORDER BY "createdAt", "id"`, [ids.sessionId]),
    pool.query(`SELECT "ordinal", "status", "attempt" FROM "agent_steps" WHERE "turnId" = $1 ORDER BY "ordinal"`, [ids.turnId]),
    pool.query(`SELECT "type", "content" FROM "agent_items" WHERE "turnId" = $1 AND "sessionId" = $2
      ORDER BY "createdAt", "id"`, [ids.turnId, ids.sessionId]),
  ])
  return {
    turn: turns.rows,
    tasks: tasks.rows,
    waits: waits.rows,
    dispatches: dispatches.rows,
    steps: steps.rows,
    items: items.rows,
  }
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
        say("CHILD_EXECUTOR_STARTED")
        await waitForSuspendedParent(lease.turnId)
        say("PARENT_SUSPENDED")
        await waitForCommand("persist-child-result")
        return { status: "completed", result: { proof: resultMarker, taskId: lease.id } }
      },
    },
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
  if (!stopping) throw new Error(`restart_fixture_timeout:${JSON.stringify(await restartDiagnostics())}`)
}

async function acceptActiveFollowUp() {
  const databaseUrl = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!databaseUrl) throw new Error("active_follow_up_requires_disposable_postgres")
  process.env.DATABASE_URL = databaseUrl
  const [{ db }, { AgentCommandService }] = await Promise.all([
    import("../../../web/src/lib/db.ts"),
    import("../../../web/src/lib/agent/control-plane/commands/agent-command-service.ts"),
  ])
  const command = {
    sessionId: ids.sessionId,
    userId: ids.userId,
    clientMessageId: "active-follow-up:" + ids.suffix,
    source: "user",
    delivery: "follow_up",
    content: [{ type: "text", text: "Durable active-Turn follow-up " + ids.suffix }],
  }
  try {
    const service = new AgentCommandService(db)
    const accepted = await service.message(command)
    const duplicate = await service.message(command)
    say("COMMAND_ACCEPTED " + JSON.stringify({ accepted, duplicate }))
  } finally {
    await db.$disconnect()
  }
}

async function makeActiveFollowUpWorker() {
  const runtime = await createCanonicalTurnRuntime(pool, {
    workerId: "active-follow-up-worker-" + process.pid,
    coordinationEnabled: false,
    authorizeUsage: async () => ({ settle() {} }),
    modelRuntimeFactory() {
      return {
        adapter: {
          id: "active-follow-up-first-worker-fixture-model",
          profile: modelProfile(),
          async *stream(request) {
            say("FIRST_PROVIDER_ACTIVE")
            await Promise.race([
              waitForCommand("release-first-provider"),
              new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("fixture_provider_aborted")), { once: true })),
            ])
            yield { type: "text_delta", text: "This result must be interrupted by the test process." }
            yield { type: "completed", finishReason: "stop" }
          },
        },
        registry: {}, candidates: [],
      }
    },
  })
  bootstrap = await createProductionWorkerBootstrap({
    pool, runtime, ownerId: "active-follow-up-worker-" + process.pid, turnRecoveryIntervalMs: 10,
  })
  say("FIRST_WORKER_READY")
  await waitForStop()
}

async function makeFollowUpResumeWorker() {
  if (typeof ids.followUpInputId !== "string" || !ids.followUpInputId) throw new Error("follow_up_input_id_missing")
  const followUpText = "Durable active-Turn follow-up " + ids.suffix
  const runtime = await createCanonicalTurnRuntime(pool, {
    workerId: "active-follow-up-recovery-" + process.pid,
    coordinationEnabled: false,
    authorizeUsage: async () => ({ settle() {} }),
    toolRuntimeFactory() {
      return {
        registry: {
          list: () => [{ name: "jobs.search", version: "1" }],
          resolve: () => ({ idempotency: "read_only" }),
          validateArguments: () => true,
        },
        router: {
          async execute(_context, call) {
            return {
              id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed",
              output: { jobs: [{
                id: "fixture-job-" + ids.suffix, company: "Fixture Employer", role: "Software Engineer", location: "Dublin",
                status: "active", score: null, url: null, source: "fixture", salary: null, description: null, keywords: null,
              }], page: 1, hasMore: false }, errorCode: null,
            }
          },
        },
      }
    },
    modelRuntimeFactory() {
      let modelCalls = 0
      return {
        adapter: {
          id: "active-follow-up-recovery-fixture-model",
          profile: modelProfile(),
          async *stream(request) {
            modelCalls += 1
            if (modelCalls === 1) {
              const matchingParts = request.messages
                .filter(message => message.role === "user" && Array.isArray(message.content))
                .flatMap(message => message.content)
                .filter(part => part.type === "text" && part.text.includes(ids.followUpInputId) && part.text.includes(followUpText))
              if (matchingParts.length !== 1) throw new Error("recovered_provider_request_did_not_contain_exactly_one_original_follow_up_id_text_in_user_role")
              say("FOLLOW_UP_CONTEXT_OK")
              yield { type: "tool_call_completed", callId: "follow-up-evidence-" + ids.suffix, name: "jobs.search", arguments: { location: "Dublin" } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (modelCalls !== 2) throw new Error("unexpected_follow_up_provider_round")
            yield { type: "text_delta", text: finalMarker }
            yield { type: "completed", finishReason: "stop" }
          },
        },
        registry: {}, candidates: [],
      }
    },
  })
  bootstrap = await createProductionWorkerBootstrap({
    pool, runtime, ownerId: "active-follow-up-recovery-" + process.pid, turnRecoveryIntervalMs: 10,
  })
  say("RECOVERY_WORKER_READY")
  await waitForStop()
}

function modelProfile() {
  return {
    provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
  }
}

async function acceptMessage() {
  const databaseUrl = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!databaseUrl) throw new Error("command_acceptance_requires_disposable_postgres")
  process.env.DATABASE_URL = databaseUrl
  const [{ db }, { AgentCommandService }] = await Promise.all([
    import("../../../web/src/lib/db.ts"),
    import("../../../web/src/lib/agent/control-plane/commands/agent-command-service.ts"),
  ])
  const command = {
    sessionId: ids.sessionId,
    userId: ids.userId,
    clientMessageId: `process-restart-message:${ids.suffix}`,
    source: "user",
    delivery: "follow_up",
    content: [{ type: "text", text: "Resume and report the persisted child result" }],
  }
  try {
    const service = new AgentCommandService(db)
    const accepted = await service.message(command)
    const duplicate = await service.message(command)
    say(`COMMAND_ACCEPTED ${JSON.stringify({ accepted, duplicate })}`)
  } finally {
    await db.$disconnect()
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
  if (mode === "accept-message") await acceptMessage()
  else if (mode === "park-parent") await makeFirstWorker()
  else if (mode === "resume-parent") await makeSecondWorker()
  else if (mode === "park-active-follow-up") await makeActiveFollowUpWorker()
  else if (mode === "accept-active-follow-up") await acceptActiveFollowUp()
  else if (mode === "resume-active-follow-up") await makeFollowUpResumeWorker()
  else throw new Error("unknown_restart_fixture_mode")
}

try {
  await run()
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
} finally {
  if (mode === "accept-message" || mode === "accept-active-follow-up") {
    process.stdin.off("data", onStdinData)
    process.stdin.pause()
    process.stdin.destroy()
  }
  await runShutdownStage("bootstrap_close", async () => { if (bootstrap) await bootstrap.close() })
  await runShutdownStage("pool_end", async () => { await pool.end() })
  await runShutdownStage("shared_redis_connections_close", async () => {
    const { closeSharedRedisConnections } = await import("../redis.ts")
    await closeSharedRedisConnections()
  })
}
