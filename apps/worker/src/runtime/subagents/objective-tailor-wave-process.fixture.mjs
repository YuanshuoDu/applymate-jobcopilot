let bootstrap, pool, wakeupConsumer, closeRedisConnections, stop
let stdinBuffer = ""
const waitingCommands = new Map(), queuedCommands = new Set()
const shutdown = new Promise(resolve => { stop = resolve })
const [, , mode, rawScope] = process.argv

function say(value) { process.stdout.write(`${value}\n`) }
function scopeFromArgs() {
  if (mode !== "first" && mode !== "resume") throw new Error("fixture_mode_invalid")
  let scope
  try { scope = JSON.parse(rawScope) } catch { throw new Error("fixture_scope_invalid") }
  if (!scope || Object.keys(scope).sort().join(",") !== "sessionId,turnId,userId"
    || [scope.userId, scope.sessionId, scope.turnId].some(value => typeof value !== "string" || !value.trim())) {
    throw new Error("fixture_scope_invalid")
  }
  return scope
}
function guardedServices() {
  const db = process.env.AGENT_RUNTIME_PG_TEST_URL, redis = process.env.AGENT_TURN_REDIS_TEST_URL
  let pgUrl, redisUrl
  try { pgUrl = new URL(db); redisUrl = new URL(redis) } catch { throw new Error("fixture_service_guard_failed") }
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || db !== process.env.DATABASE_URL
    || pgUrl.protocol !== "postgresql:" || pgUrl.hostname !== "127.0.0.1" || pgUrl.port !== "5432"
    || pgUrl.username !== "postgres" || pgUrl.password !== "postgres" || pgUrl.pathname !== "/applymate_agent_brain_ci"
    || pgUrl.search || pgUrl.hash || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || process.env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1" || redis !== process.env.REDIS_URL
    || redisUrl.protocol !== "redis:" || redisUrl.hostname !== "127.0.0.1" || redisUrl.port !== "6379"
    || redisUrl.pathname !== "/15" || redisUrl.username || redisUrl.password || redisUrl.search || redisUrl.hash) {
    throw new Error("fixture_service_guard_failed")
  }
  return { db }
}
function onInput(chunk) {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const command of lines.map(value => value.trim()).filter(Boolean)) {
    if (command === "shutdown") { stop(); continue }
    const waiters = waitingCommands.get(command), resolve = waiters?.shift()
    if (resolve) { if (!waiters.length) waitingCommands.delete(command); resolve() }
    else queuedCommands.add(command)
  }
}
function waitForCommand(command) {
  if (queuedCommands.delete(command)) return Promise.resolve()
  return Promise.race([new Promise(resolve => {
    const waiters = waitingCommands.get(command) ?? []
    waiters.push(resolve); waitingCommands.set(command, waiters)
  }), shutdown.then(() => { throw new Error("fixture_shutdown_requested") })])
}

async function run() {
  const scope = scopeFromArgs(), { db } = guardedServices()
  Object.assign(process.env, {
    ENABLE_AGENT_TASK_GRAPH_PLANNING: "1", ENABLE_AGENT_CHILD_EXECUTION: "1", ENABLE_AGENT_WAIT_RESOLVER: "1",
    ENABLE_AGENT_OBJECTIVE_TAILOR: "0", ENABLE_AGENT_OBJECTIVE_TAILOR_WAVES: "1",
    ENABLE_AGENT_CANONICAL_AUTOMATION: "0", ENABLE_AGENT_TURN_BOUNDARY_COMPACTION: "0",
  })
  process.stdin.setEncoding("utf8"); process.stdin.on("data", onInput)
  const [pg, redis, execution, session, runtime, roles, artifacts, dependency, reviewFeedback, child,
    graph, templates, flags, startRuntime, worker, modelFixture] = await Promise.all([
    import("pg"), import("../../redis.ts"), import("../canonical-execution-projection.ts"),
    import("../canonical-session-projection.ts"), import("../canonical-turn-runtime.ts"), import("./role-results.ts"),
    import("./artifact-adapters.ts"), import("./task-graph-dependency-context.ts"), import("./task-graph-writer-review-feedback.ts"),
    import("./production-child-runtime.ts"), import("./pg-task-graph-command-port.ts"), import("./task-graph-templates.ts"),
    import("../production-agent-flags.ts"), import("../../queue/production-bootstrap.ts"),
    import("../../queue/production-worker-runtime.ts"), import("./objective-tailor-wave-model.fixture.mjs"),
  ])
  closeRedisConnections = redis.closeSharedRedisConnections
  pool = new pg.Pool({ connectionString: db, max: 16 })
  const deps = { roleResultSchema: roles.ROLE_RESULT_SCHEMA, writerArtifactReferenceFromTaskContext: dependency.writerArtifactReferenceFromTaskContext,
    writerReviewDependencyFromTaskContext: reviewFeedback.writerReviewDependencyFromTaskContext }
  const models = modelFixture.createObjectiveTailorWaveModels({ deps, ...scope, mode, say, waitForCommand })
  const rootModelFactory = async input => {
    const stateScope = input?.state?.scope
    if (input?.userId !== scope.userId || stateScope?.userId !== scope.userId
      || stateScope?.sessionId !== scope.sessionId || stateScope?.turnId !== scope.turnId) return models.rootModel(input)
    say("TAILOR_ROOT_FACTORY_ENTERED")
    let roots
    try {
      roots = await pool.query(`SELECT root."id" AS "rootTaskId" FROM "agent_turns" AS turn
        JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
        JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
          AND root."turnId" = turn."id" AND root."rootTaskId" = root."id"
        WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
          AND turn."executionMode" = 'canonical_task_graph' AND turn."status" = 'in_progress'
          AND turn."leaseOwnerId" IS NOT NULL AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP
          AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root' AND root."status" = 'running'
          AND root."leaseOwner" = turn."leaseOwnerId" AND root."leaseExpiresAt" > CURRENT_TIMESTAMP`,
      [scope.turnId, scope.sessionId, scope.userId])
    } catch {
      say("TAILOR_ROOT_FACTORY_ROOT_UNAVAILABLE")
      throw new Error("fixture_root_binding_unavailable")
    }
    const rootTaskId = roots.rows.length === 1 ? roots.rows[0]?.rootTaskId : undefined
    if (typeof rootTaskId !== "string" || !rootTaskId
      || (typeof input.state.rootTaskId === "string" && input.state.rootTaskId !== rootTaskId)) {
      say("TAILOR_ROOT_FACTORY_ROOT_UNAVAILABLE")
      throw new Error("fixture_root_binding_unavailable")
    }
    say("TAILOR_ROOT_FACTORY_BOUND")
    return models.rootModel({ ...input, state: { ...input.state, rootTaskId } })
  }
  const commandPort = graph.createPgTaskGraphCommandPort(pool)
  const authorizeUsage = async () => ({ outputReservationRequired: false, maxOutputTokens: null,
    settle: async () => undefined, settleUnknown: async () => undefined })
  const productionFlags = flags.resolveProductionAgentFlags()
  if (!productionFlags.taskGraphPlanningEnabled || !productionFlags.objectiveTailorWavesEnabled
    || !productionFlags.childExecutionEnabled || !productionFlags.coordinationEnabled) throw new Error("fixture_wave_flags_unavailable")
  bootstrap = await worker.startProductionWorkerRuntime({ pool, workerId: `objective-tailor-wave-${mode}-${process.pid}`,
    productionFlags, onBootstrapReady(value) { bootstrap = value }, startAgentRunWorker() {} }, {
    createOptionalProductionChildExecutor: options => options.enabled ? child.createOptionalProductionChildExecutor({ ...options,
      authorizeUsage, modelRuntimeFactory: models.childModel }) : undefined,
    createCanonicalTurnRuntime: (runtimePool, productionOptions) => runtime.createCanonicalTurnRuntime(runtimePool, {
      ...productionOptions, ...templates.taskGraphRuntimeOptions(commandPort), modelRuntimeFactory: rootModelFactory, authorizeUsage,
    }),
    createWorkerUsageAuthorizer: () => authorizeUsage,
    createCanonicalExecutionProjection: execution.createCanonicalExecutionProjection,
    createCanonicalSessionProjection: session.createCanonicalSessionProjection,
    startProductionAgentRuntime: options => startRuntime.startProductionAgentRuntime({ ...options,
      bootstrapOptions: current => {
        const original = typeof options.bootstrapOptions === "function" ? options.bootstrapOptions(current) : options.bootstrapOptions
        return { ...original, ownerId: `objective-tailor-wave-${mode}-${process.pid}`, turnRecoveryIntervalMs: 100,
          ...(original?.waitResolver ? { waitResolver: { ...original.waitResolver, intervalMs: 100 } } : {}),
          ...(original?.subagents ? { subagents: { ...original.subagents, intervalMs: 100 } } : {}) }
      },
    }),
  })
  if (!bootstrap?.turns || !bootstrap?.subagents) throw new Error("fixture_runtime_consumers_unavailable")
  if (mode === "resume") {
    const { startAgentWakeupConsumer } = await import("../wakeup/consumer.ts")
    wakeupConsumer = startAgentWakeupConsumer(pool)
  }
  say(`TAILOR_WAVE_WORKER_READY ${mode}`)
  await shutdown
}

run().catch(async () => {
  process.stderr.write("TAILOR_WAVE_WORKER_FAILED\n")
  process.exitCode = 1
}).finally(async () => {
  await wakeupConsumer?.close?.().catch(() => undefined)
  await bootstrap?.close().catch(() => undefined)
  await pool?.end().catch(() => undefined)
  await closeRedisConnections?.().catch(() => undefined)
  process.stdin.off("data", onInput); process.stdin.pause()
})
