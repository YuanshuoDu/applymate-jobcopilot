const MAX_WAIT_CALLS = 8
const WAIT_TIMEOUT_MS = 30_000
const PLAN_MARKERS = { rejected: "BATCH_CROSS_SLOT_REJECTED", persisted: "BATCH_PLAN_PERSISTED" }
const slots = ["slot-1", "slot-2"]
let resolveShutdown
const shutdown = new Promise(resolve => { resolveShutdown = resolve })
const queuedCommands = []
const commandWaiters = new Map()
let stdinBuffer = ""
let planPersistedAnnounced = false
let crossSlotRejectedAnnounced = false
let shutdownRequested = false
let deps
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
function isRecord(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function toolCalls(request, name) {
  const calls = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role === "assistant" && part?.type === "tool_use" && part.name === name) calls.push(part)
  }
  return calls
}
function toolResult(request, call) {
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role !== "tool" || part?.type !== "tool_result" || part.toolUseId !== call.id) continue
    if (typeof part.content !== "string") return { error: true }
    try { return { error: part.isError === true, value: JSON.parse(part.content) } } catch { return { error: true } }
  }
  return undefined
}
function emitTool(callId, name, args) { return [{ type: "tool_call_completed", callId, name, arguments: args }, { type: "completed", finishReason: "tool_calls" }] }
function profile() {
  return { provider: "fixture", model: "selected-job-batch-fixture", nativeTools: true, structuredOutput: true,
    streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" }
}
function selectedJobId(task) {
  const selection = task?.context?.selectedJobPreparation
  if (!isRecord(selection) || typeof selection.jobId !== "string" || !selection.jobId.trim()) throw new Error("fixture_selected_job_context_missing")
  return selection.jobId
}
function planNodes(crossSlot) {
  const writers = slots.map(slot => {
    const entry = deps.selectedJobBatchTemplatesForSlot(slot)
    if (!entry) throw new Error("fixture_slot_template_missing")
    const writer = `writer-${slot}`
    return { key: writer, templateId: entry.writerTemplateId, goal: "Write the synthetic job-specific draft", successCriteria: ["Persist one scoped draft"], dependsOn: [] }
  })
  const reviewers = slots.map((slot, index) => {
    const entry = deps.selectedJobBatchTemplatesForSlot(slot), writer = `writer-${slot}`
    if (!entry) throw new Error("fixture_slot_template_missing")
    return { key: `reviewer-${slot}`, templateId: entry.reviewerTemplateId, goal: "Review only the paired Writer draft",
      successCriteria: ["Persist one scoped review"], dependsOn: [crossSlot ? `writer-${slots[1 - index]}` : writer] }
  })
  return [...writers, ...reviewers]
}
function acceptedPlan(request) {
  const plans = toolCalls(request, "agent.plan"), call = plans.at(-1), result = call && toolResult(request, call)
  if (!result || result.error || !isRecord(result.value) || result.value.status !== "accepted"
    || result.value.revision !== 1 || !Array.isArray(result.value.nodes) || result.value.nodes.length !== 4
    || !Array.isArray(result.value.readyTaskIds) || result.value.readyTaskIds.length !== 2) throw new Error("fixture_plan_receipt_invalid")
  const ids = result.value.nodes.map(node => node?.taskId)
  const ready = result.value.nodes.filter(node => node?.status === "queued").map(node => node.taskId)
  if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== 4
    || ready.some((id, index) => result.value.readyTaskIds[index] !== id)) throw new Error("fixture_plan_receipt_invalid")
  return { ids, ready }
}
function allTasksCompleted(output, ids) {
  return isRecord(output) && output.status === "ready" && Array.isArray(output.tasks) && output.tasks.length === ids.length
    && output.tasks.every(task => ids.includes(task?.taskId) && task?.status === "completed")
    && Array.isArray(output.matchedTaskIds) && ids.every(id => output.matchedTaskIds.includes(id))
}
function rootModel({ userId }) {
  if (userId !== process.env.SELECTED_JOB_BATCH_FULL_LOOP_USER_ID) throw new Error("fixture_turn_owner_mismatch")
  return { adapter: { id: "selected-job-batch-root-fixture", profile: profile(), async *stream(request) {
    const plans = toolCalls(request, "agent.plan")
    if (!plans.length) { yield* emitTool("batch-plan-cross-slot", "agent.plan", { expectedRevision: 0, nodes: planNodes(true) }); return }
    const rejected = toolResult(request, plans[0])
    if (!rejected?.error || rejected.value?.code !== "selected_job_batch_plan_invalid") throw new Error("fixture_cross_slot_plan_not_rejected")
    if (!crossSlotRejectedAnnounced) { say(PLAN_MARKERS.rejected); crossSlotRejectedAnnounced = true }
    if (plans.length === 1) { yield* emitTool("batch-plan-valid", "agent.plan", { expectedRevision: 0, nodes: planNodes(false) }); return }
    const persisted = acceptedPlan(request)
    if (!planPersistedAnnounced) {
      planPersistedAnnounced = true
      say(PLAN_MARKERS.persisted)
      await waitForCommand("continue-batch")
    }
    const waits = toolCalls(request, "agent.wait")
    const previous = waits.at(-1), receipt = previous && toolResult(request, previous)
    if (receipt?.error) throw new Error("fixture_wait_receipt_invalid")
    if (receipt && allTasksCompleted(receipt.value, persisted.ids)) {
      yield { type: "text_delta", text: "Both synthetic job materials were drafted and independently reviewed." }
      yield { type: "completed", finishReason: "stop" }
      return
    }
    if (waits.length >= MAX_WAIT_CALLS) throw new Error("fixture_wait_limit_exceeded")
    yield* emitTool(`batch-wait-${waits.length + 1}`, "agent.wait", { idempotencyKey: `selected-job-batch-full-loop:wait:${waits.length + 1}`,
      taskIds: persisted.ids, mode: "all", timeoutMs: WAIT_TIMEOUT_MS })
  } }, registry: {}, candidates: [] }
}
function childModel({ task }) {
  if (task?.userId !== process.env.SELECTED_JOB_BATCH_FULL_LOOP_USER_ID) throw new Error("fixture_child_owner_mismatch")
  const role = task?.role, jobId = selectedJobId(task)
  if (role === "writer") {
    const baseArtifactId = `cover-letter-base:${deps.hashArtifactContent({ userId: task.userId, jobId }).slice(7)}`
    const baseHash = deps.hashArtifactContent({ kind: "cover_letter_base", jobId })
    return { id: "selected-job-batch-writer-fixture", profile: profile(), async *stream(request) {
      const drafts = toolCalls(request, "cover_letter.draft"), prior = drafts.at(-1)
      if (!prior) { yield* emitTool(`draft-${task.id}`, "cover_letter.draft", { baseArtifactId, baseHash,
        content: "Synthetic job-specific cover letter for isolated integration verification.", constraints: { maxWords: 160 } }); return }
      const result = toolResult(request, prior)
      if (!result || result.error || !isRecord(result.value?.artifactRef)) throw new Error("fixture_writer_tool_receipt_invalid")
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.ROLE_RESULT_SCHEMA, role, status: "completed", artifactRef: result.value.artifactRef }) }
      yield { type: "completed", finishReason: "stop" }
    } }
  }
  if (role === "reviewer") {
    const artifactRef = deps.writerArtifactReferenceFromTaskContext(task.context, jobId)
    return { id: "selected-job-batch-reviewer-fixture", profile: profile(), async *stream(request) {
      const reads = toolCalls(request, "artifact.version.read")
      if (!reads.length) { yield* emitTool(`read-${task.id}`, "artifact.version.read", { artifactRef }); return }
      const read = toolResult(request, reads.at(-1))
      if (!read || read.error) throw new Error("fixture_reviewer_read_receipt_invalid")
      const reviews = toolCalls(request, "artifact.review"), previous = reviews.at(-1)
      if (!previous) { yield* emitTool(`review-${task.id}`, "artifact.review", { artifactRef, decision: "passed", findings: [] }); return }
      const result = toolResult(request, previous), value = result?.value
      if (!result || result.error || value?.status !== "passed" || typeof value.reviewHash !== "string") throw new Error("fixture_reviewer_tool_receipt_invalid")
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.ROLE_RESULT_SCHEMA, role, status: "completed",
        artifactRef: value.artifactRef, reviewStatus: value.status, reviewHash: value.reviewHash }) }
      yield { type: "completed", finishReason: "stop" }
    } }
  }
  throw new Error("fixture_child_role_unsupported")
}
async function run() {
  const { db } = guardedServices(), redis = await import("../redis.ts")
  let bootstrap, pool
  try {
  deps = { closeSharedRedisConnections: redis.closeSharedRedisConnections }
  const [pg, execution, session, runtime, roles, artifacts, dependency, child, protocol, graph, templates, flagsModule, bootstrapModule, worker] = await Promise.all([
    import("pg"), import("../runtime/canonical-execution-projection.ts"), import("../runtime/canonical-session-projection.ts"),
    import("../runtime/canonical-turn-runtime.ts"), import("../runtime/subagents/role-results.ts"), import("../runtime/subagents/artifact-adapters.ts"),
    import("../runtime/subagents/task-graph-dependency-context.ts"), import("../runtime/subagents/production-child-runtime.ts"),
    import("@jobcopilot/agent-protocol"), import("../runtime/subagents/pg-task-graph-command-port.ts"),
    import("../runtime/subagents/task-graph-templates.ts"), import("../runtime/production-agent-flags.ts"),
    import("./production-bootstrap.ts"), import("./production-worker-runtime.ts"),
  ])
  deps = { ...deps, Pool: pg.Pool,
    createCanonicalExecutionProjection: execution.createCanonicalExecutionProjection, createCanonicalSessionProjection: session.createCanonicalSessionProjection,
    createCanonicalTurnRuntime: runtime.createCanonicalTurnRuntime, ROLE_RESULT_SCHEMA: roles.ROLE_RESULT_SCHEMA,
    hashArtifactContent: artifacts.hashArtifactContent, writerArtifactReferenceFromTaskContext: dependency.writerArtifactReferenceFromTaskContext,
    createOptionalProductionChildExecutor: child.createOptionalProductionChildExecutor,
    selectedJobBatchTemplatesForSlot: protocol.selectedJobBatchTemplatesForSlot, createPgTaskGraphCommandPort: graph.createPgTaskGraphCommandPort,
    taskGraphRuntimeOptions: templates.taskGraphRuntimeOptions, resolveProductionAgentFlags: flagsModule.resolveProductionAgentFlags,
    startProductionAgentRuntime: bootstrapModule.startProductionAgentRuntime, startProductionWorkerRuntime: worker.startProductionWorkerRuntime }
  pool = new deps.Pool({ connectionString: db, max: 8 })
  const flags = { ...deps.resolveProductionAgentFlags(), taskGraphPlanningEnabled: true, childExecutionEnabled: true,
    coordinationEnabled: true, consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false }
  const commandPort = deps.createPgTaskGraphCommandPort(pool)
  const authorizeUsage = async () => ({ outputReservationRequired: false, maxOutputTokens: null, settle: async () => undefined, settleUnknown: async () => undefined })
  process.stdin.setEncoding("utf8")
  process.stdin.on("data", onInput)
    bootstrap = await deps.startProductionWorkerRuntime({ pool, workerId: `selected-job-batch-${process.pid}`, productionFlags: flags,
      onBootstrapReady: value => { bootstrap = value }, startAgentRunWorker() {} }, {
      createOptionalProductionChildExecutor: options => options.enabled ? deps.createOptionalProductionChildExecutor({ ...options,
        authorizeUsage, modelRuntimeFactory: childModel }) : undefined,
      createCanonicalTurnRuntime: (runtimePool, productionOptions) => deps.createCanonicalTurnRuntime(runtimePool, {
        ...productionOptions, ...deps.taskGraphRuntimeOptions(commandPort), modelRuntimeFactory: rootModel, authorizeUsage,
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
