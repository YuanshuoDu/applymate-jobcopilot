let resolveShutdown
const shutdown = new Promise(resolve => { resolveShutdown = resolve })
const queuedCommands = []
const commandWaiters = new Map()
let stdinBuffer = ""
let shutdownRequested = false
function say(value) { process.stdout.write(`${value}\n`) }
function required(name) {
  const value = process.env[name]
  if (!value) throw new Error("fixture_environment_incomplete")
  return value
}
function guardedServices() {
  const db = required("AGENT_RUNTIME_PG_TEST_URL"), dbUrl = new URL(db)
  const redis = required("AGENT_TURN_REDIS_TEST_URL"), redisUrl = new URL(redis)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || db !== process.env.DATABASE_URL
    || dbUrl.protocol !== "postgresql:" || dbUrl.hostname !== "127.0.0.1" || dbUrl.port !== "5432"
    || dbUrl.username !== "postgres" || dbUrl.password !== "postgres" || dbUrl.pathname !== "/applymate_agent_brain_ci"
    || dbUrl.search || dbUrl.hash || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || process.env.RUN_AGENT_TURN_REDIS_INTEGRATION !== "1" || redis !== process.env.REDIS_URL
    || redisUrl.protocol !== "redis:" || redisUrl.hostname !== "127.0.0.1" || redisUrl.port !== "6379"
    || redisUrl.pathname !== "/15" || redisUrl.username || redisUrl.password || redisUrl.search || redisUrl.hash) {
    throw new Error("fixture_disposable_service_guard_failed")
  }
  const userId = required("SELECTED_JOB_BATCH_FULL_LOOP_USER_ID")
  if (!userId.startsWith("batch-full-loop-user-") || userId.length > 128) throw new Error("fixture_user_guard_failed")
  return { db, userId }
}
function onInput(chunk) {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const command of lines.map(value => value.trim())) {
    if (command === "shutdown") { shutdownRequested = true; resolveShutdown(); continue }
    const waiters = commandWaiters.get(command), resolve = waiters?.shift()
    if (resolve) { if (!waiters.length) commandWaiters.delete(command); resolve() }
    else queuedCommands.push(command)
  }
}
function waitForCommand(command, timeoutMs = 120_000) {
  if (shutdownRequested) return Promise.reject(new Error("fixture_shutdown_requested"))
  if (queuedCommands.includes(command)) {
    queuedCommands.splice(queuedCommands.indexOf(command), 1)
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = error => {
      if (settled) return
      settled = true; clearTimeout(timer)
      const waiters = commandWaiters.get(command), index = waiters?.indexOf(resolveCommand) ?? -1
      if (index >= 0) waiters.splice(index, 1)
      if (!waiters?.length) commandWaiters.delete(command)
      error ? reject(error) : resolve()
    }
    const resolveCommand = () => finish()
    const timer = setTimeout(() => finish(new Error("fixture_command_timeout")), timeoutMs)
    const waiters = commandWaiters.get(command) ?? []
    waiters.push(resolveCommand); commandWaiters.set(command, waiters)
    void shutdown.then(() => finish(new Error("fixture_shutdown_requested")))
  })
}
async function run() {
  const { db, userId } = guardedServices(), redis = await import("../redis.ts")
  let bootstrap, pool, deps
  try {
  deps = { closeSharedRedisConnections: redis.closeSharedRedisConnections }
  const [pg, execution, session, runtime, roles, artifacts, dependency, reviewFeedback, child, protocol, graph, templates, flagsModule, bootstrapModule, worker, fixtureSupport] = await Promise.all([
    import("pg"), import("../runtime/canonical-execution-projection.ts"), import("../runtime/canonical-session-projection.ts"),
    import("../runtime/canonical-turn-runtime.ts"), import("../runtime/subagents/role-results.ts"), import("../runtime/subagents/artifact-adapters.ts"),
    import("../runtime/subagents/task-graph-dependency-context.ts"), import("../runtime/subagents/task-graph-writer-review-feedback.ts"),
    import("../runtime/subagents/production-child-runtime.ts"),
    import("@jobcopilot/agent-protocol"), import("../runtime/subagents/pg-task-graph-command-port.ts"),
    import("../runtime/subagents/task-graph-templates.ts"), import("../runtime/production-agent-flags.ts"),
    import("./production-bootstrap.ts"), import("./production-worker-runtime.ts"),
    import("./selected-job-batch-correction.fixture-support.mjs"),
  ])
  deps = { ...deps, Pool: pg.Pool,
    createCanonicalExecutionProjection: execution.createCanonicalExecutionProjection, createCanonicalSessionProjection: session.createCanonicalSessionProjection,
    createCanonicalTurnRuntime: runtime.createCanonicalTurnRuntime, ROLE_RESULT_SCHEMA: roles.ROLE_RESULT_SCHEMA,
    hashArtifactContent: artifacts.hashArtifactContent, writerArtifactReferenceFromTaskContext: dependency.writerArtifactReferenceFromTaskContext,
    writerReviewDependencyFromTaskContext: reviewFeedback.writerReviewDependencyFromTaskContext,
    createOptionalProductionChildExecutor: child.createOptionalProductionChildExecutor,
    selectedJobBatchTemplatesForSlot: protocol.selectedJobBatchTemplatesForSlot, createPgTaskGraphCommandPort: graph.createPgTaskGraphCommandPort,
    taskGraphRuntimeOptions: templates.taskGraphRuntimeOptions, resolveProductionAgentFlags: flagsModule.resolveProductionAgentFlags,
    startProductionAgentRuntime: bootstrapModule.startProductionAgentRuntime, startProductionWorkerRuntime: worker.startProductionWorkerRuntime }
  pool = new deps.Pool({ connectionString: db, max: 8 })
  const flags = { ...deps.resolveProductionAgentFlags(), taskGraphPlanningEnabled: true, childExecutionEnabled: true,
    coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false }
  const commandPort = deps.createPgTaskGraphCommandPort(pool)
  const authorizeUsage = async () => ({ outputReservationRequired: false, maxOutputTokens: null, settle: async () => undefined, settleUnknown: async () => undefined })
  const models = fixtureSupport.createSelectedJobBatchCorrectionModels({ deps, userId, say, waitForCommand })
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", onInput)
    bootstrap = await deps.startProductionWorkerRuntime({ pool, workerId: `selected-job-batch-${process.pid}`, productionFlags: flags,
      onBootstrapReady: value => { bootstrap = value }, startAgentRunWorker() {} }, {
      createOptionalProductionChildExecutor: options => options.enabled ? deps.createOptionalProductionChildExecutor({ ...options,
        authorizeUsage, modelRuntimeFactory: models.childModel }) : undefined,
      createCanonicalTurnRuntime: (runtimePool, productionOptions) => deps.createCanonicalTurnRuntime(runtimePool, {
        ...productionOptions, ...deps.taskGraphRuntimeOptions(commandPort), modelRuntimeFactory: models.rootModel, authorizeUsage,
      }),
      createWorkerUsageAuthorizer: () => authorizeUsage,
      createCanonicalExecutionProjection: deps.createCanonicalExecutionProjection,
      createCanonicalSessionProjection: deps.createCanonicalSessionProjection,
      startProductionAgentRuntime: options => deps.startProductionAgentRuntime({ ...options,
        bootstrapOptions: runtime => {
          const original = typeof options.bootstrapOptions === "function" ? options.bootstrapOptions(runtime) : options.bootstrapOptions
          return { ...original, ownerId: `selected-job-batch-${process.pid}`, turnRecoveryIntervalMs: 200,
            ...(original?.subagents ? { subagents: { ...original.subagents, intervalMs: 200 } } : {}) }
        },
      }),
    })
    if (!bootstrap?.turns || !bootstrap?.subagents) throw new Error("fixture_canonical_consumers_unavailable")
    say("BATCH_WORKER_READY")
    await shutdown
  } finally {
    process.stdin.off("data", onInput)
    process.stdin.pause()
    await bootstrap?.close().catch(() => undefined)
    await pool?.end().catch(() => undefined)
    await deps?.closeSharedRedisConnections?.().catch(() => undefined)
  }
}
run().catch(() => { process.stderr.write("BATCH_WORKER_FAILED\n"); process.exitCode = 1 })
