import { Pool } from "pg"
import { createCanonicalTurnRuntime } from "../runtime/canonical-turn-runtime.ts"
import { startProductionAgentRuntime as startProductionAgentRuntimeHelper } from "./production-bootstrap.ts"
import { startProductionWorkerRuntime } from "./production-worker-runtime.ts"

const [, , mode, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const resultMarker = "durable-child-result-after-process-restart"
const finalMarker = "parent-resumed-from-durable-child-result"
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 5 })
let bootstrap
let wakeupConsumer
let stopping = false
let stdinBuffer = ""
const queuedCommands = []
const commandWaiters = new Map()
const noOpProjection = { start: async () => undefined, finish: async () => undefined }

async function startFixtureProductionRuntime({
  workerId,
  productionFlags,
  runtimeOptions = {},
  childExecutor,
  bootstrapOptions = {},
}) {
  return startProductionWorkerRuntime({
    pool,
    workerId,
    productionFlags,
    onBootstrapReady(ready) { bootstrap = ready },
    startAgentRunWorker() {},
  }, {
    createOptionalProductionChildExecutor({ enabled }) {
      return enabled ? childExecutor : undefined
    },
    createCanonicalTurnRuntime(runtimePool, productionOptions) {
      return createCanonicalTurnRuntime(runtimePool, { ...runtimeOptions, ...productionOptions })
    },
    createWorkerUsageAuthorizer() {
      return async () => ({ settle() {} })
    },
    createCanonicalExecutionProjection() { return noOpProjection },
    createCanonicalSessionProjection() { return noOpProjection },
    startProductionAgentRuntime(startupOptions) {
      return startProductionAgentRuntimeHelper({
        ...startupOptions,
        bootstrapOptions: runtime => {
          const composed = typeof startupOptions.bootstrapOptions === "function"
            ? startupOptions.bootstrapOptions(runtime)
            : startupOptions.bootstrapOptions
          const merged = { ...composed, ...bootstrapOptions }
          if (composed?.subagents || bootstrapOptions.subagents) {
            merged.subagents = { ...composed?.subagents, ...bootstrapOptions.subagents }
          }
          if (composed?.waitResolver || bootstrapOptions.waitResolver) {
            merged.waitResolver = { ...composed?.waitResolver, ...bootstrapOptions.waitResolver }
          }
          return merged
        },
      })
    },
  })
}

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
  await startFixtureProductionRuntime({
    workerId: `restart-worker-${process.pid}`,
    productionFlags: {
      childExecutionEnabled: true,
      coordinationEnabled: true,
      // Preserve the pre-composition restart fixture's runtime behavior; it
      // supplies its wait resolver explicitly below.
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    },
    runtimeOptions: {
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
    },
    childExecutor: async ({ lease }) => {
      say("CHILD_EXECUTOR_STARTED")
      await waitForSuspendedParent(lease.turnId)
      say("PARENT_SUSPENDED")
      await waitForCommand("persist-child-result")
      return { status: "completed", result: { proof: resultMarker, taskId: lease.id } }
    },
    bootstrapOptions: {
      ownerId: `restart-worker-${process.pid}`,
      turnRecoveryIntervalMs: 10,
      waitResolver: { intervalMs: 10, ownerId: `restart-wait-resolver-${process.pid}` },
      subagents: { intervalMs: 10 },
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
  const input = ids.followUpCommand ?? {
    clientMessageId: "active-follow-up:" + ids.suffix,
    text: "Durable active-Turn follow-up " + ids.suffix,
  }
  const command = {
    sessionId: input.sessionId ?? ids.sessionId,
    userId: input.userId ?? ids.userId,
    clientMessageId: input.clientMessageId,
    source: "user",
    delivery: "follow_up",
    content: [{ type: "text", text: input.text }],
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
  const followUps = Array.isArray(ids.followUps) ? ids.followUps : []
  function assertPendingFollowUpsHidden(request) {
    const pending = followUps.filter(followUp => request.messages
      .filter(message => message.role === "user" && Array.isArray(message.content))
      .flatMap(message => message.content)
      .some(part => part.type === "text" && part.text.includes(followUp.text)))
    if (pending.length !== 0) throw new Error("pending_follow_up_exposed_during_active_turn")
  }
  await startFixtureProductionRuntime({
    workerId: "active-follow-up-worker-" + process.pid,
    productionFlags: {
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    },
    runtimeOptions: {
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
                  id: "active-follow-up-fixture-job-" + ids.suffix, company: "Fixture Employer", role: "Software Engineer", location: "Dublin",
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
            id: "active-follow-up-first-worker-fixture-model",
            profile: modelProfile(),
            async *stream(request) {
              modelCalls += 1
              if (modelCalls === 1) {
                say("FIRST_PROVIDER_ACTIVE")
                await Promise.race([
                  waitForCommand("release-first-provider"),
                  new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("fixture_provider_aborted")), { once: true })),
                ])
                yield { type: "tool_call_completed", callId: "active-follow-up-search-" + ids.suffix, name: "jobs.search", arguments: { location: "Dublin" } }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              if (modelCalls === 2) {
                assertPendingFollowUpsHidden(request)
                say("FINAL_PROVIDER_ACTIVE")
                await Promise.race([
                  waitForCommand("release-pending-follow-up-provider"),
                  new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("fixture_provider_aborted")), { once: true })),
                ])
                yield { type: "text_delta", text: finalMarker }
                yield { type: "completed", finishReason: "stop" }
                return
              }
              throw new Error("unexpected_active_follow_up_provider_round")
            },
          },
          registry: {}, candidates: [],
        }
      },
    },
    bootstrapOptions: {
      ownerId: "active-follow-up-worker-" + process.pid,
      turnRecoveryIntervalMs: 10,
    },
  })
  say("FIRST_WORKER_READY")
  await waitForStop()
}

async function makeFollowUpResumeWorker() {
  const followUps = Array.isArray(ids.followUps) ? ids.followUps : []
  if (followUps.length === 0) throw new Error("follow_up_inputs_missing")
  function matchingFollowUps(request) {
    const userTexts = request.messages
      .filter(message => message.role === "user" && Array.isArray(message.content))
      .flatMap(message => message.content)
      .filter(part => part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
    return followUps.flatMap((followUp, index) => {
      const occurrences = userTexts.filter(text => text.includes(followUp.text)).length
      return occurrences ? [{ followUp, index, occurrences }] : []
    })
  }
  function assertNoFollowUps(request, phase) {
    const matches = matchingFollowUps(request)
    if (matches.length !== 0) throw new Error(`${phase}_exposed_pending_follow_ups:${JSON.stringify(matches)}`)
  }
  function assertCurrentFollowUpOnly(request, currentIndex, phase) {
    const matches = matchingFollowUps(request)
    const current = matches.find(match => match.index === currentIndex)
    const later = matches.filter(match => match.index > currentIndex)
    if (!current || current.occurrences !== 1 || later.length > 0) {
      throw new Error(`${phase}_successor_follow_up_context_invalid:${JSON.stringify({ currentIndex, matches, later })}`)
    }
    return current
  }
  await startFixtureProductionRuntime({
    workerId: "active-follow-up-recovery-" + process.pid,
    productionFlags: {
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: false,
      canonicalAutomationEnabled: false,
    },
    runtimeOptions: {
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
      modelRuntimeFactory({ state }) {
        let modelCalls = 0
        const successorFollowUpIndex = followUps.findIndex(followUp => followUp.text === state.goal)
        return {
          adapter: {
            id: "active-follow-up-recovery-fixture-model",
            profile: modelProfile(),
            async *stream(request) {
              modelCalls += 1
              if (successorFollowUpIndex >= 0) {
                const match = assertCurrentFollowUpOnly(request, successorFollowUpIndex, `successor_provider_round_${modelCalls}`)
                if (modelCalls === 1) {
                  say("SUCCESSOR_PROVIDER_ACTIVE " + (match.index + 1))
                  await waitForCommand("release-successor-" + (match.index + 1))
                  yield { type: "tool_call_completed", callId: "successor-evidence-" + ids.suffix + "-" + (match.index + 1), name: "jobs.search", arguments: { location: "Dublin" } }
                  yield { type: "completed", finishReason: "tool_calls" }
                  return
                }
                if (modelCalls === 2) {
                  yield { type: "text_delta", text: finalMarker + " successor-" + (match.index + 1) }
                  yield { type: "completed", finishReason: "stop" }
                  return
                }
                throw new Error("unexpected_successor_provider_round")
              }
              if (modelCalls === 1) {
                assertNoFollowUps(request, "active_turn_recovery")
                say("ACTIVE_TURN_CONTEXT_CLEAN")
                yield { type: "tool_call_completed", callId: "follow-up-evidence-" + ids.suffix, name: "jobs.search", arguments: { location: "Dublin" } }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              if (modelCalls !== 2) throw new Error("unexpected_active_turn_provider_round")
              assertNoFollowUps(request, "active_turn_finalization")
              say("ACTIVE_FINAL_CONTEXT_CLEAN")
              await waitForCommand("release-active-final")
              yield { type: "text_delta", text: finalMarker }
              yield { type: "completed", finishReason: "stop" }
            },
          },
          registry: {}, candidates: [],
        }
      },
    },
    bootstrapOptions: {
      ownerId: "active-follow-up-recovery-" + process.pid,
      turnRecoveryIntervalMs: 10,
    },
  })
  say("RECOVERY_WORKER_READY")
  await waitForStop()
}

async function replayActiveTerminal() {
  const { commitTurnTerminal } = await import("../runtime/turns/turn-engine-terminal-commit.ts")
  const result = await pool.query(`SELECT turn."id" AS "turnId", turn."sessionId", turn."userId", turn."leaseVersion", turn."finalResponse",
      root."id" AS "taskId", root."result" AS "rootResult", item."id" AS "finalItemId", item."stepId", item."content" AS "finalContent",
      completed."payload"->'usage' AS "usage"
    FROM "agent_turns" AS turn
    JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."turnId" = turn."id"
    JOIN "agent_items" AS item ON item."turnId" = turn."id" AND item."sessionId" = turn."sessionId" AND item."type" = 'agent_message'
    JOIN "agent_events" AS completed ON completed."turnId" = turn."id" AND completed."sessionId" = turn."sessionId"
      AND completed."idempotencyKey" = 'turn:' || turn."id" || ':event:turn-completed'
    WHERE turn."id" = $1 AND turn."status" = 'completed'`, [ids.turnId])
  const row = result.rows[0]
  if (!row || !row.stepId || !row.finalItemId || !row.finalResponse || !row.usage || !row.rootResult) {
    throw new Error("completed_turn_receipt_missing_for_idempotency_replay")
  }
  await commitTurnTerminal(pool, {
    owner: {
      kind: "turn", userId: row.userId, sessionId: row.sessionId, turnId: row.turnId,
      taskId: row.taskId, rootTaskId: row.taskId, ownerId: "terminal-replay-" + process.pid,
      leaseVersion: Number(row.leaseVersion), leaseExpiresAt: new Date(Date.now() + 60_000),
    },
    response: row.finalResponse,
    now: new Date(),
    stepId: row.stepId,
    finalItemId: row.finalItemId,
    finalContent: row.finalContent,
    stepCount: Number(row.rootResult.stepCount),
    toolCallCount: Number(row.rootResult.toolCallCount),
    usage: row.usage,
  })
  say("TERMINAL_REPLAY_OK")
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
  await startFixtureProductionRuntime({
    workerId: `restart-worker-${process.pid}`,
    productionFlags: {
      childExecutionEnabled: false,
      coordinationEnabled: false,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
    },
    runtimeOptions: {
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
    },
    bootstrapOptions: {
      ownerId: `restart-worker-${process.pid}`,
      turnRecoveryIntervalMs: 10,
      waitResolver: { intervalMs: 10, ownerId: `restart-wait-resolver-${process.pid}` },
    },
  })
  say("SECOND_WORKER_READY")
  await waitForStop()
}

function checkpointInputs() {
  if (!ids.checkpointKind || !ids.checkpointWaitId || !ids.readCallId) throw new Error("checkpoint_fixture_ids_missing")
  return ids
}

async function persistCheckpointWait() {
  const checkpoint = checkpointInputs()
  const turnResult = await pool.query(`SELECT "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [ids.turnId, ids.sessionId, ids.userId])
  const revision = Number(turnResult.rows[0]?.revision)
  if (!Number.isInteger(revision)) throw new Error("checkpoint_turn_revision_missing")
  process.env.DATABASE_URL = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (checkpoint.checkpointKind === "approval") {
    if (!checkpoint.checkpointJobId) throw new Error("checkpoint_approval_job_missing")
    const { createPgApprovalStore } = await import("../runtime/approval/pg-store.ts")
    await createPgApprovalStore(pool, { userId: ids.userId }).issue({
      approvalId: checkpoint.checkpointWaitId,
      scope: {
        userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, jobId: checkpoint.checkpointJobId,
        toolCallId: checkpoint.readCallId, action: "submit_application",
        resourceHash: "a".repeat(64), materialHash: "b".repeat(64), answersHash: "c".repeat(64),
        revision, expiresAt: new Date(Date.now() + 60_000),
      },
      title: "Fixture approval checkpoint", body: "No application is submitted by this fixture.",
      payload: { fixture: true }, projectWait: true,
    })
    return
  }
  if (checkpoint.checkpointKind === "question") {
    const [{ db }, broker] = await Promise.all([
      import("../../../web/src/lib/db.ts"),
      import("../../../web/src/lib/agent/broker/store.ts"),
    ])
    try {
      await broker.createQuestionWait(db, {
        questionId: checkpoint.checkpointWaitId, sessionId: ids.sessionId, userId: ids.userId, turnId: ids.turnId,
        toolCallId: checkpoint.readCallId, stage: "fixture_checkpoint", question: "Provide the deterministic recovery answer.",
        options: [{ label: "Use the fixture answer", value: checkpoint.checkpointAnswer }], expectedTurnRevision: revision,
      })
    } finally { await db.$disconnect() }
  }
}

async function resolveCheckpointWait() {
  const checkpoint = checkpointInputs()
  if (checkpoint.checkpointKind === "tool-result") throw new Error("tool_result_checkpoint_has_no_wait_to_resolve")
  const [{ db }, broker] = await Promise.all([
    import("../../../web/src/lib/db.ts"),
    import("../../../web/src/lib/agent/broker/store.ts"),
  ])
  try {
    const turn = await db.agentTurn.findUniqueOrThrow({ where: { id: ids.turnId }, select: { revision: true } })
    const command = {
      sessionId: ids.sessionId, userId: ids.userId, waitId: checkpoint.checkpointWaitId,
      clientMessageId: "checkpoint-command:" + ids.suffix, expectedTurnId: ids.turnId, expectedRevision: turn.revision,
    }
    const resolved = checkpoint.checkpointKind === "approval"
      ? await broker.decideApproval(db, { ...command, decision: "approved" })
      : await broker.answerQuestion(db, { ...command, answer: checkpoint.checkpointAnswer })
    const expectedStatus = checkpoint.checkpointKind === "approval" ? "approved" : "answered"
    if (resolved.disposition !== "resolved" || resolved.status !== expectedStatus || resolved.turnId !== ids.turnId) {
      throw new Error("checkpoint_wait_resolution_scope_invalid")
    }
    say("CHECKPOINT_WAIT_RESOLVED " + checkpoint.checkpointKind)
  } finally { await db.$disconnect() }
}

function checkpointToolRuntime() {
  return {
    registry: {
      list: () => [{ name: "jobs.search", version: "1" }],
      resolve: () => ({ idempotency: "read_only" }),
      validateArguments: () => true,
    },
    router: {
      async execute(_context, call) {
        if (call.toolName !== "jobs.search") throw new Error("unexpected_checkpoint_fixture_tool")
        if (mode === "checkpoint-worker2") throw new Error("persisted_fixture_read_tool_was_executed_twice")
        say("CHECKPOINT_READ_TOOL_EXECUTED " + ids.readCallId)
        return {
          id: call.id, toolName: call.toolName, toolVersion: call.toolVersion, status: "completed",
          output: { proof: "durable-read-result:" + ids.suffix }, errorCode: null,
        }
      },
    },
  }
}

async function checkpointResumeEvidence(state, request) {
  const checkpoint = checkpointInputs()
  const observations = JSON.stringify(state.snapshot.toolObservations)
  if (observations.split(checkpoint.readCallId).length - 1 !== 1
    || observations.split("durable-read-result:" + ids.suffix).length - 1 !== 1) {
    throw new Error("checkpoint_resume_missing_unique_durable_read_result")
  }
  if (checkpoint.checkpointKind === "question") {
    const item = await pool.query(`SELECT "status", "content" FROM "agent_items" WHERE "id" = $1 AND "turnId" = $2 AND "type" = 'question'`, ["agent-wait:question:" + checkpoint.checkpointWaitId, ids.turnId])
    const content = item.rows[0]?.content
    if (item.rows[0]?.status !== "completed" || content?.answer !== checkpoint.checkpointAnswer) throw new Error("checkpoint_question_answer_not_restored")
    const history = state.snapshot.steerHistory.filter(entry => entry.id.startsWith("agent-question:agent-wait:question:" + checkpoint.checkpointWaitId + ":"))
    if (history.length !== 2 || !history[0].id.endsWith(":question") || !history[1].id.endsWith(":answer")) {
      throw new Error("checkpoint_question_history_pair_missing_or_unordered")
    }
    const texts = request.messages.flatMap(message => Array.isArray(message.content)
      ? message.content.filter(part => part.type === "text").map(part => part.text) : [])
    const questionText = "Provide the deterministic recovery answer."
    const option = content.options?.[0]
    const optionMarker = option ? JSON.stringify({ label: option.label, value: option.value }) : ""
    const questionEntries = texts.filter(text => text.includes('"type":"question"') && text.includes(questionText) && text.includes(optionMarker))
    const answerEntries = texts.filter(text => text.includes('"type":"answer"')
      && text.includes('"questionId":"' + checkpoint.checkpointWaitId + '"')
      && text.includes('"text":"' + checkpoint.checkpointAnswer + '"'))
    if (!optionMarker || questionEntries.length !== 1 || answerEntries.length !== 1 || questionEntries[0] === answerEntries[0]
      || !questionEntries[0].includes("trust=UNTRUSTED_DATA") || !answerEntries[0].includes("trust=UNTRUSTED_DATA")
      || texts.indexOf(questionEntries[0]) >= texts.indexOf(answerEntries[0])) {
      throw new Error("checkpoint_question_answer_model_context_not_unique_ordered_untrusted")
    }
    say("CHECKPOINT_QUESTION_CONTEXT_COUNT 1 OPTION_COUNT 1 ANSWER_COUNT 1")
    return "answer:" + checkpoint.checkpointAnswer
  }
  if (checkpoint.checkpointKind === "approval") {
    const approval = await pool.query(`SELECT "status", "userId", "sessionId", "turnId", "taskId", "jobId", "toolCallId" FROM "agent_approvals" WHERE "id" = $1 AND "userId" = $2`, [checkpoint.checkpointWaitId, ids.userId])
    if (approval.rows[0]?.status !== "approved" || approval.rows[0]?.turnId !== ids.turnId
      || approval.rows[0]?.userId !== ids.userId || approval.rows[0]?.sessionId !== ids.sessionId
      || approval.rows[0]?.taskId !== null || approval.rows[0]?.jobId !== checkpoint.checkpointJobId
      || approval.rows[0]?.toolCallId !== checkpoint.readCallId) {
      throw new Error("checkpoint_approval_receipt_scope_not_restored")
    }
    return "approval:approved"
  }
  return "tool-result:restored"
}

async function makeCheckpointWorker(firstWorker) {
  const checkpoint = checkpointInputs()
  await startFixtureProductionRuntime({
    workerId: `checkpoint-${firstWorker ? "worker1" : "worker2"}-${process.pid}`,
    productionFlags: {
      childExecutionEnabled: false, coordinationEnabled: false, consumeWaitOutcomes: false, canonicalAutomationEnabled: false,
    },
    runtimeOptions: {
      toolRuntimeFactory: checkpointToolRuntime,
      ...(firstWorker ? {
        modelRuntimeFactory() {
          let modelCalls = 0
          return {
            adapter: {
              id: "checkpoint-worker1-fixture-model", profile: modelProfile(),
              async *stream() {
                modelCalls += 1
                say("CHECKPOINT_MODEL_REQUEST " + modelCalls)
                if (modelCalls === 1) {
                  if (checkpoint.checkpointKind === "tool-result") {
                    say("CHECKPOINT_TOOL_STEP_READY " + checkpoint.readCallId)
                    await waitForCommand("release-checkpoint-tool-call")
                  }
                  yield { type: "tool_call_completed", callId: checkpoint.readCallId, name: "jobs.search", arguments: { fixture: ids.suffix } }
                  yield { type: "completed", finishReason: "tool_calls" }
                  return
                }
                if (modelCalls === 2) {
                  if (checkpoint.checkpointKind === "tool-result") {
                    say("CHECKPOINT_NEXT_MODEL_REQUEST_STARTED")
                    throw new Error("tool-result checkpoint advanced to another provider request before restart")
                  }
                  await persistCheckpointWait()
                  say("CHECKPOINT_WAIT_DURABLE " + checkpoint.checkpointKind)
                  await waitForCommand("release-checkpoint-provider")
                  say("CHECKPOINT_POST_WAIT_MODEL_PROGRESS")
                  yield { type: "text_delta", text: "must-not-be-observed-after-worker1-kill" }
                  yield { type: "completed", finishReason: "stop" }
                  return
                }
                throw new Error("unexpected_checkpoint_worker1_model_round")
              },
            },
            registry: {}, candidates: [],
          }
        },
      } : {}),
      ...(!firstWorker ? {
        modelRuntimeFactory({ state }) {
          let modelCalls = 0
          return {
            adapter: {
              id: "checkpoint-worker2-fixture-model", profile: modelProfile(),
              async *stream(request) {
                modelCalls += 1
                if (modelCalls !== 1) throw new Error("unexpected_checkpoint_worker2_model_round")
                const proof = await checkpointResumeEvidence(state, request)
                say("CHECKPOINT_RESUME_CONTEXT_OK " + checkpoint.checkpointKind + " " + proof)
                yield { type: "text_delta", text: "Recovered durable checkpoint after Worker restart for request: Resume and report the persisted child result. CHECKPOINT_FINAL_" + checkpoint.checkpointKind + "_" + ids.suffix + "_" + proof }
                yield { type: "completed", finishReason: "stop" }
              },
            },
            registry: {}, candidates: [],
          }
        },
      } : {}),
    },
    bootstrapOptions: {
      ownerId: `checkpoint-${firstWorker ? "worker1" : "worker2"}-${process.pid}`,
      turnRecoveryIntervalMs: 10,
      waitResolver: { intervalMs: 10, ownerId: `checkpoint-wait-resolver-${process.pid}` },
    },
  })
  if (!firstWorker) {
    const { startAgentWakeupConsumer } = await import("../runtime/wakeup/consumer.ts")
    wakeupConsumer = startAgentWakeupConsumer(pool)
  }
  say(`CHECKPOINT_WORKER_READY ${firstWorker ? "worker1" : "worker2"}`)
  await waitForStop()
}

async function run() {
  if (mode === "accept-message") await acceptMessage()
  else if (mode === "park-parent") await makeFirstWorker()
  else if (mode === "resume-parent") await makeSecondWorker()
  else if (mode === "park-active-follow-up") await makeActiveFollowUpWorker()
  else if (mode === "accept-active-follow-up") await acceptActiveFollowUp()
  else if (mode === "resume-active-follow-up") await makeFollowUpResumeWorker()
  else if (mode === "replay-active-terminal") await replayActiveTerminal()
  else if (mode === "checkpoint-worker1") await makeCheckpointWorker(true)
  else if (mode === "checkpoint-worker2") await makeCheckpointWorker(false)
  else if (mode === "resolve-checkpoint") await resolveCheckpointWait()
  else throw new Error("unknown_restart_fixture_mode")
}

try {
  await run()
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
} finally {
  if (mode === "accept-message" || mode === "accept-active-follow-up" || mode === "replay-active-terminal") {
    process.stdin.off("data", onStdinData)
    process.stdin.pause()
    process.stdin.destroy()
  }
  if (wakeupConsumer) await runShutdownStage("wakeup_consumer_close", async () => { await wakeupConsumer.close(); wakeupConsumer = undefined })
  await runShutdownStage("bootstrap_close", async () => { if (bootstrap) await bootstrap.close() })
  await runShutdownStage("pool_end", async () => { await pool.end() })
  await runShutdownStage("shared_redis_connections_close", async () => {
    const { closeSharedRedisConnections } = await import("../redis.ts")
    await closeSharedRedisConnections()
  })
}
