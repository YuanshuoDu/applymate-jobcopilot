import { Pool } from "pg"
import { Redis } from "ioredis"
import { Worker } from "bullmq"
import { AgentTreeManager } from "./manager.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { parseSubagentDispatchJobId } from "./dispatch-identity.ts"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.ts"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.ts"
import { executionOwnerFence } from "../execution-owner.ts"
import { registerDurableSubagentWait } from "./durable-subagent-wait-store.ts"
import { startDurableWaitResolver } from "./durable-wait-resolver.ts"
import { loadDurableSubagentWaitResume, commitDurableSubagentWaitResume } from "./durable-subagent-wait-resume.ts"
import { loadChildAttemptResume } from "./child-resume.ts"
import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.ts"
import { loadChildWaitCallRecovery } from "./child-resume-wait-call-recovery.ts"
import { createProductionChildResumeLoaders } from "./production-child-resume-loaders.ts"
import { acknowledgeDurableWaitAtContinuationStart, childResultStatus } from "./child-executor-admission.ts"
import { createChildDurableWaitReplay } from "./child-durable-wait-replay.ts"
import { TurnExecutionEventWriter, executeToolWithItems } from "../turns/turn-execution-events.ts"
import { recoverPersistedToolCalls } from "../turns/turn-execution-tools.ts"
import { childWaitClaimEventKey } from "./child-durable-wait-replay.ts"
import { canonicalJson, redactSensitiveText } from "@jobcopilot/shared"
import { contextToModelMessages } from "../turns/turn-engine-messages.ts"
import { runTurnExecutionLoop } from "../turns/turn-execution-loop.ts"
import { projectChildToolCallIdsForModelContext } from "../turns/turn-tool-call-id-projection.ts"
import { readRecoveryStateSnapshot } from "./durable-child-wait-recovery-diagnostics.fixture.mjs"

const [, , mode, queueName, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const phoneShapedToolCallId = "child-wait-call:415-555-0134"
const highPrecisionWaitModelCostUsd = 0.123456789
const loopFixtureModelProfile = Object.freeze({ provider: "fixture", model: "durable-child-wait-fixture", nativeTools: true,
  structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: true, supportsStreamingToolArgs: true,
  supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" })
const readyMarkerByMode = {
  "worker-a": "WORKER_A_READY",
  "worker-a-crash": "WORKER_A_READY",
  "worker-b-crash-before-resume": "WORKER_B_READY",
  "worker-b-crash-resume": "WORKER_B_READY",
  "worker-b-crash-source-lifecycle": "WORKER_B_READY",
  "worker-b-crash-after-wait-ack": "WORKER_B_READY",
  "worker-b-crash-before-claim": "WORKER_B_READY",
  "worker-b-crash-after-orphan-reissue": "WORKER_B_READY",
  "worker-b-crash-after-claim-result": "WORKER_B_READY",
  "worker-b-loop-preclaim": "WORKER_B_READY",
  "worker-b-loop-claim-recovery-cut": "WORKER_B_READY",
  "worker-b-loop-final": "WORKER_B_READY",
  "worker-b-loop-claim-item-completed-cut": "WORKER_B_READY",
  "worker-b-loop-usage-lineage-cut": "WORKER_B_READY",
  "worker-b-loop-usage-lineage-reject": "WORKER_B_READY",
  "worker-b-loop-multi-preclaim": "WORKER_B_READY",
  "worker-b-loop-multi-reject": "WORKER_B_READY",
  "worker-b-legacy-consumed-seed": "WORKER_B_READY",
  "worker-b-legacy-consumed-source-only": "WORKER_B_READY",
  "worker-b-legacy-consumed-recovery": "WORKER_B_READY",
  "worker-b-legacy-consumed-final": "WORKER_B_READY",
  "worker-b": "WORKER_B_READY",
}
const workerStartGateKey = `fixture:durable-child-wait:start:${ids.waiterTaskId}`
const crashCutModes = new Set([
  "worker-a-crash",
  "worker-b-crash-before-resume",
  "worker-b-crash-resume",
  "worker-b-crash-source-lifecycle",
  "worker-b-crash-after-wait-ack",
  "worker-b-crash-before-claim",
  "worker-b-crash-after-orphan-reissue",
  "worker-b-crash-after-claim-result",
  "worker-b-loop-preclaim",
  "worker-b-loop-claim-recovery-cut",
  "worker-b-loop-claim-item-completed-cut",
  "worker-b-loop-usage-lineage-cut",
  "worker-b-loop-multi-preclaim",
  "worker-b-legacy-consumed-seed",
  "worker-b-legacy-consumed-source-only",
  "worker-b-legacy-consumed-recovery",
])
const sourceLifecycleCrashStages = new Set([
  "after-call-item-update",
  "after-result-item-insert",
  "after-result-item-update",
  "after-event-sequence-1", "after-event-insert-1", "after-event-outbox-1",
  "after-event-sequence-2", "after-event-insert-2", "after-event-outbox-2",
  "after-event-sequence-3", "after-event-insert-3", "after-event-outbox-3",
  "after-event-sequence-4", "after-event-insert-4", "after-event-outbox-4",
  "after-provenance-update",
  "after-consumed-update",
])
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 6 })
const redis = new Redis(process.env.AGENT_TURN_REDIS_TEST_URL, { maxRetriesPerRequest: null })
const store = new PgSubagentTaskStore(pool, 30_000)
const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
const turnStore = createPgTurnEngineStore(pool)
const resolver = mode.startsWith("worker-b") ? startDurableWaitResolver(pool, { intervalMs: 100, ownerId: "restart-fixture-worker-b" }) : undefined
let stopped = false

function poolWithSourceLifecycleCrashBarrier(stage) {
  if (!sourceLifecycleCrashStages.has(stage)) throw new Error("invalid_source_lifecycle_crash_stage")
  let completedItemUpdates = 0
  let sequenceWrites = 0
  let eventWrites = 0
  let eventOutboxWrites = 0
  return {
    connect: async () => {
      const client = await pool.connect()
      return {
        query: async (...args) => {
          const result = await client.query(...args)
          const statement = typeof args[0] === "string" ? args[0].replace(/\s+/g, " ").trim() : ""
          const values = Array.isArray(args[1]) ? args[1] : []
          let reachedStage
          if (statement.startsWith('UPDATE "agent_items" SET "status" = \'completed\'')) {
            completedItemUpdates += 1
            reachedStage = completedItemUpdates === 1 ? "after-call-item-update"
              : completedItemUpdates === 2 ? "after-result-item-update" : undefined
          } else if (statement.startsWith('INSERT INTO "agent_items"')) {
            reachedStage = "after-result-item-insert"
          } else if (statement.startsWith('UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1')) {
            sequenceWrites += 1
            reachedStage = `after-event-sequence-${sequenceWrites}`
          } else if (statement.startsWith('INSERT INTO "agent_events"')) {
            eventWrites += 1
            reachedStage = `after-event-insert-${eventWrites}`
          } else if (statement.startsWith('INSERT INTO "agent_outbox"') && String(values[2]).startsWith("agent-event:")) {
            eventOutboxWrites += 1
            reachedStage = `after-event-outbox-${eventOutboxWrites}`
          } else if (statement.startsWith('UPDATE "agent_wait_conditions" SET "result"')) {
            reachedStage = "after-provenance-update"
          } else if (statement.startsWith('UPDATE "agent_wait_conditions" SET "consumedAt"')) {
            reachedStage = "after-consumed-update"
          }
          if (reachedStage === stage && result.rowCount === 1) {
            say(`WORKER_B_SOURCE_LIFECYCLE_CRASH_CUT ${JSON.stringify({ stage, writeApplied: true })}`)
            return new Promise(() => {})
          }
          return result
        },
        release: () => client.release(),
      }
    },
  }
}

function say(value) { process.stdout.write(`${value}\n`) }
function boundedIds(value) {
  return Array.isArray(value) && value.length <= 8
    ? value.map(id => typeof id === "string" ? id.slice(0, 256) : null)
    : null
}

function restoredWaitObservationSummary(restored, wait, pendingWait, owner, stepId) {
  const matches = restored.observations.filter(item => item?.content?.toolCallId === wait.toolCallId
    && item.content.toolName === "wait_subagents")
  if (matches.length !== 1) throw new Error("durable_child_wait_restored_observation_missing")
  const content = matches[0].content
  const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: restored.observations }
  const projection = projectChildToolCallIdsForModelContext(snapshot, owner, stepId)
  const projectedMatches = projection.snapshot.toolObservations.filter(item => item?.content?.toolName === "wait_subagents")
  if (projectedMatches.length !== 1) throw new Error("durable_child_wait_projected_observation_missing")
  const projectedId = projectedMatches[0].content.toolCallId
  const blocks = projection.snapshot.toolObservations.map(item => ({ ...item,
    layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" }))
  const messages = contextToModelMessages({ blocks })
  const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  const toolUse = parts.find(part => part?.type === "tool_use" && part.name === "wait_subagents")
  const toolResult = parts.find(part => part?.type === "tool_result" && part.toolUseId === projectedId)
  const repeated = projectChildToolCallIdsForModelContext(snapshot, owner, stepId)
  const repeatedId = repeated.snapshot.toolObservations.find(item => item?.content?.toolName === "wait_subagents")?.content?.toolCallId
  const serializedMessages = JSON.stringify(messages)
  if (projectedId === wait.toolCallId || projection.aliasToCanonical.get(projectedId) !== wait.toolCallId
    || redactSensitiveText(projectedId) !== projectedId || !toolUse || !toolResult || toolUse.id !== toolResult.toolUseId
    || toolUse.id !== projectedId || serializedMessages.includes(wait.toolCallId) || repeatedId !== projectedId) {
    throw new Error("durable_child_wait_model_projection_invalid")
  }
  const output = content.output
  const tasks = Array.isArray(output?.tasks) && output.tasks.length <= 8 ? output.tasks : null
  const targetTask = tasks?.find(task => task?.taskId === ids.targetTaskId)
  const targetFinalText = typeof targetTask?.result?.finalText === "string" ? targetTask.result.finalText.slice(0, 512) : null
  return {
    state: pendingWait ? "unconsumed" : "consumed",
    canonicalCallIdPreserved: content.toolCallId === wait.toolCallId,
    modelContextSafe: !serializedMessages.includes(wait.toolCallId),
    modelToolPairBound: toolUse.id === toolResult.toolUseId,
    deterministicProjection: repeatedId === projectedId,
    providerInvoked: false,
    inputTaskIds: boundedIds(content.input?.taskIds),
    outputTaskIds: boundedIds(output?.taskIds),
    matchedTaskIds: boundedIds(output?.matchedTaskIds),
    outputTaskIdsFromTasks: tasks ? tasks.map(task => typeof task?.taskId === "string" ? task.taskId.slice(0, 256) : null) : null,
    targetFinalText,
  }
}


function boundedErrorDetails(error) {
  if (error instanceof Error) return { name: String(error.name).slice(0, 128), message: error.message.slice(0, 1_000), stack: error.stack?.slice(0, 3_000) ?? null }
  return { name: typeof error, message: String(error).slice(0, 1_000), stack: null }
}

function executionStore(owner, hooks = {}) {
  const bind = method => input => {
    const { identity, ...rest } = input
    const write = () => turnStore[method]({ ...rest, owner: identity })
    const before = method === "appendEvent" ? hooks.beforeAppendEvent
      : method === "updateItem" ? hooks.beforeUpdateItem : undefined
    return before ? Promise.resolve(before(input)).then(write) : write()
  }
  return {
    startStep: bind("startStep"), updateStep: bind("updateStep"),
    createItem: bind("createItem"), updateItem: bind("updateItem"), appendEvent: bind("appendEvent"),
    appendEvents: inputs => turnStore.appendEvents(inputs.map(({ identity, ...rest }) => ({ ...rest, owner: identity }))),
    recordFinalResponse: bind("recordFinalResponse"),
  }
}

function turnExecutionOptions(lease, owner, executeTool, additions = {}) {
  return {
    identity: owner,
    scope: { userId: lease.userId },
    goal: lease.goal,
    snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: additions.observations ?? [] },
    contextBuilder: additions.contextBuilder ?? { build: async () => { throw new Error("fixture_context_builder_not_used") } },
    store: executionStore(owner, additions),
    model: additions.model ?? {},
    tools: additions.tools ?? [],
    executeTool,
    idFactory: prefix => `${prefix}:attempt:${lease.attemptCount}`,
    validateToolArguments: () => true,
    publishReasoningSummary: false,
    ...(additions.resume ? { resume: additions.resume } : {}),
    ...(additions.budget ? { budget: additions.budget } : {}),
    ...(additions.lifecycle ? { lifecycle: additions.lifecycle } : {}),
    ...(additions.childWaitCallStartKey ? { childWaitCallStartKey: additions.childWaitCallStartKey } : {}),
    ...(additions.childWaitCallStarted ? { childWaitCallStarted: additions.childWaitCallStarted } : {}),
    ...(additions.childWaitClaimRecovery ? { childWaitClaimRecovery: additions.childWaitClaimRecovery } : {}),
    ...(additions.childWaitOrphanRecovery ? { childWaitOrphanRecovery: additions.childWaitOrphanRecovery } : {}),
  }
}

function loopContextBuilder() {
  return { build: async ({ identity, stepId, snapshot }) => ({
    schemaVersion: "agent-harness.v2", sessionId: identity.sessionId, turnId: identity.turnId, stepId,
    inputThroughSequence: 0n, consumedInputIds: [],
    blocks: snapshot.toolObservations.map((item, index) => ({
      id: `fixture-tool-observation:${index}:${item.id}`, layer: "tool_observation", role: "data",
      trust: "external_untrusted", source: "tool_or_subagent", content: item.content,
    })),
    canonicalJson: canonicalJson(snapshot.toolObservations),
  }) }
}

function loopFixtureModel(reply) {
  const invocations = []
  const model = {
    id: "durable-child-wait-fixture-model",
    profile: loopFixtureModelProfile,
    async *stream(request) {
      const stepId = request.metadata?.stepId
      if (typeof stepId !== "string" || !stepId) throw new Error("fixture_model_step_id_missing")
      invocations.push(stepId)
      const response = await reply({ request, stepId, invocation: invocations.length })
      const usage = response.usage ?? { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      yield { type: "usage", ...usage, provider: "fixture", model: "durable-child-wait-fixture" }
      for (const call of response.toolCalls ?? []) {
        yield { type: "tool_call_completed", callId: call.id, name: call.name, arguments: call.arguments }
      }
      if (response.text) yield { type: "text_delta", text: response.text }
      yield { type: "completed", finishReason: response.toolCalls?.length ? "tool_calls" : "stop" }
    },
  }
  return { model, invocations }
}

async function runChildWaitLoop(lease, restored, responseForStep, hooks = {}) {
  const owner = executionOwnerFence({ kind: "task", lease })
  const wait = restored?.durableWait
  if (!wait) throw new Error("fixture_child_wait_loop_resume_missing")
  const replay = createChildDurableWaitReplay(lease, wait, restored.observations, restored.childWaitClaimRecovery)
  let executorCalls = 0, dispatcherCalls = 0
  const fixtureModel = loopFixtureModel(responseForStep)
  const options = turnExecutionOptions(lease, owner, async input => {
    executorCalls += 1
    if (hooks.beforeReplayExecution) await hooks.beforeReplayExecution(input)
    const result = replay.execute(input)
    if (!result) {
      dispatcherCalls += 1
      throw new Error("fixture_child_wait_loop_dispatcher_reached")
    }
    return { id: result.id, toolName: result.toolName, toolVersion: result.toolVersion,
      status: result.status, output: result.output, errorCode: result.errorCode }
  }, {
    observations: restored.observations, contextBuilder: loopContextBuilder(), model: fixtureModel.model,
    tools: [{ name: "wait_subagents", version: "1", inputSchema: { type: "object" } }],
    resume: restored.resume, beforeAppendEvent: hooks.beforeAppendEvent, beforeUpdateItem: hooks.beforeUpdateItem,
    childWaitCallStartKey: (stepId, call) => replay.childWaitCallStartKey(stepId, call),
    childWaitCallStarted: (stepId, call, eventId) => {
      replay.childWaitCallStarted(stepId, call, eventId)
      hooks.childWaitCallStarted?.(stepId, call, eventId)
    },
    ...(restored.childWaitClaimRecovery ? { childWaitClaimRecovery: restored.childWaitClaimRecovery } : {}),
    ...(restored.childWaitOrphanRecovery ? { childWaitOrphanRecovery: restored.childWaitOrphanRecovery } : {}),
  })
  if (hooks.legacyConsumedSeed) {
    const store = options.store
    options.store = { ...store, startStep: async input => {
      const step = await store.startStep(input)
      if (step.id === `task:${lease.id}:step:${wait.ordinal + 1}:attempt:${lease.attemptCount}`) replay.acknowledgeContinuation(step)
      return step
    } }
  } else {
    options.store = acknowledgeDurableWaitAtContinuationStart(options.store, lease, wait,
      async (currentLease, durableWait, nextStepOrdinal) => commitDurableSubagentWaitResume(pool, currentLease, {
        waitId: durableWait.waitId, stepId: durableWait.stepId, nextStepOrdinal, now: new Date(),
      }), step => replay.acknowledgeContinuation(step))
  }
  const result = await runTurnExecutionLoop(options)
  return { result, invocations: fixtureModel.invocations, executorCalls, dispatcherCalls }
}

async function seedLegacyConsumedWait(lease, stopBeforeModel = false) {
  const now = new Date()
  const wait = await loadDurableSubagentWaitResume(pool, lease, now)
  const restored = await loadChildAttemptResume(pool, lease, now, wait)
  if (!wait || !restored?.durableWait || restored.durableWait.waitId !== wait.waitId || wait.attempt !== lease.attemptCount) {
    throw new Error("fixture_legacy_consumed_wait_seed_missing")
  }
  const owner = executionOwnerFence({ kind: "task", lease })
  const logicalNextOrdinal = restored.resume.nextOrdinal
  const stepId = `task:${lease.id}:step:${logicalNextOrdinal}:attempt:${lease.attemptCount}`
  const continuation = await turnStore.startStep({ owner, stepId, ordinal: logicalNextOrdinal, attempt: lease.attemptCount,
    inputThroughSequence: restored.resume.inputThroughSequence, consumedInputIds: restored.resume.consumedInputIds,
    modelProfileSnapshot: loopFixtureModelProfile, now })
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2
      AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [lease.sessionId, lease.userId])
    if (session.rowCount !== 1) throw new Error("fixture_legacy_ack_session_fence_failed")
    const current = await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3
      AND "rootTaskId" = $4 AND "status" = 'running' AND "leaseOwner" = $5 AND "attemptCount" = $6
      AND "leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NULL FOR UPDATE`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.ownerId, lease.attemptCount])
    if (current.rowCount !== 1) throw new Error("fixture_legacy_ack_owner_fence_failed")
    const changed = await client.query(`UPDATE "agent_wait_conditions" SET "consumedAt" = $1, "updatedAt" = $1
      WHERE "id" = $2 AND "userId" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "parentTaskId" = $6
        AND "stepId" = $7 AND "status" IN ('ready', 'timed_out') AND "suspendedAt" IS NOT NULL AND "consumedAt" IS NULL`,
    [now, wait.waitId, lease.userId, lease.sessionId, lease.turnId, lease.id, wait.stepId])
    if (changed.rowCount !== 1) throw new Error("fixture_legacy_ack_wait_update_failed")
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
  const persistedContinuation = await pool.query(`SELECT "id", "ordinal", "attempt", "status" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5`,
  [stepId, lease.sessionId, lease.turnId, lease.id, lease.attemptCount])
  if (continuation.id !== stepId || persistedContinuation.rowCount !== 1
    || persistedContinuation.rows[0]?.id !== stepId || Number(persistedContinuation.rows[0]?.ordinal) !== continuation.ordinal
    || !Number.isSafeInteger(wait.ordinal) || !Number.isSafeInteger(continuation.ordinal) || continuation.ordinal <= wait.ordinal
    || Number(persistedContinuation.rows[0]?.attempt) !== lease.attemptCount || persistedContinuation.rows[0]?.status !== "streaming") {
    throw new Error("fixture_legacy_ack_step_identity_invalid")
  }
  if (stopBeforeModel) {
    say(`WORKER_B_LEGACY_CONSUMED_SOURCE_ONLY ${JSON.stringify({ waitId: wait.waitId, sourceStepId: wait.stepId,
      sourceAttempt: wait.attempt, continuationStepId: continuation.id, logicalNextOrdinal, sourcePhysicalOrdinal: wait.ordinal,
      continuationOrdinal: continuation.ordinal,
      attemptCount: lease.attemptCount, sourceLifecycleRepaired: false, continuationCallCreated: false })}`)
    return new Promise(() => {})
  }
  const callId = `legacy-consumed-reissue:${lease.id}:attempt:${lease.attemptCount}`
  let claimedCall
  const modelResponse = ({ stepId: actualStepId }) => {
    if (actualStepId !== stepId) throw new Error("fixture_legacy_reissue_wrong_step")
    return { usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: highPrecisionWaitModelCostUsd },
      toolCalls: [{ id: callId, name: "wait_subagents", arguments: wait.input }] }
  }
  const childWaitCallStarted = (actualStepId, call, eventId) => {
    if (actualStepId !== stepId || call.id !== callId || !eventId) return
    claimedCall = { stepId: actualStepId, callId: call.id, eventId }
  }
  const beforeReplayExecution = async input => {
    if (input.stepId !== stepId || input.call.id !== callId || input.call.toolName !== "wait_subagents"
      || JSON.stringify(input.call.input) !== JSON.stringify(wait.input)
      || claimedCall?.stepId !== stepId || claimedCall.callId !== callId || !claimedCall.eventId) {
      throw new Error("fixture_legacy_claim_adapter_mismatch")
    }
    const marker = `WORKER_B_LEGACY_CONSUMED_CLAIMED ${JSON.stringify({ waitId: wait.waitId, sourceStepId: wait.stepId,
      sourceAttempt: wait.attempt, continuationStepId: stepId, logicalNextOrdinal, sourcePhysicalOrdinal: wait.ordinal,
      continuationOrdinal: continuation.ordinal, attemptCount: lease.attemptCount, callId,
      sourceLifecycleRepaired: false, claimPresent: true })}`
    say(marker)
    await new Promise(() => {})
  }
  const loop = await runChildWaitLoop(lease, restored, modelResponse, {
    childWaitCallStarted, beforeReplayExecution, legacyConsumedSeed: true,
  })
  throw new Error(`fixture_legacy_preclaim_barrier_returned:${loop.result.status}`)
}

async function resumeChildThroughLoop(lease, phase, preloadedRestored) {
  const now = new Date()
  const pendingWait = preloadedRestored ? undefined : await loadDurableSubagentWaitResume(pool, lease, now)
  let restored
  try { restored = preloadedRestored ?? await loadChildAttemptResume(pool, lease, now, pendingWait) }
  catch (error) {
    if (phase === "multi-reject") {
      say(`WORKER_B_LOOP_MULTI_REJECTED ${JSON.stringify({ error: error?.message ?? String(error), modelCalls: 0, executorCalls: 0, dispatcherCalls: 0 })}`)
      return { status: "failed", failureReason: error?.message ?? "child_resume_wait_tool_call_conflict", retryDisposition: "terminal" }
    }
    if (phase === "usage-lineage-reject" && error?.message === "child_resume_wait_step_lineage") {
      say(`WORKER_B_LOOP_USAGE_LINEAGE_REJECTED ${JSON.stringify({ error: error.message, modelCalls: 0, executorCalls: 0, dispatcherCalls: 0 })}`)
      return { status: "failed", failureReason: error.message, retryDisposition: "terminal" }
    }
    throw error
  }
  if (!restored?.durableWait) throw new Error("fixture_child_wait_loop_durable_wait_missing")
  const wait = restored.durableWait
  const owner = executionOwnerFence({ kind: "task", lease })
  const recovery = restored.childWaitOrphanRecovery ?? restored.childWaitClaimRecovery
  const continuationStepId = recovery?.stepId ?? wait.continuationStepId ?? `task:${lease.id}:step:${restored.resume.nextOrdinal}:attempt:${lease.attemptCount}`
  const logicalStepOrdinal = recovery?.stepOrdinal ?? restored.resume.nextOrdinal
  const callId = recovery?.call.id ?? `${ids.loopCallPrefix ?? "child-wait-loop"}:${lease.id}:attempt:${lease.attemptCount}`
  const callItemId = `task:${lease.id}:item:tool-call:${callId}:attempt:${lease.attemptCount}`
  say(`WORKER_B_RESTORED_WAIT_OBSERVATION ${JSON.stringify(restoredWaitObservationSummary(restored, wait, pendingWait, owner, continuationStepId))}`)
  if (phase === "multi-reject" && (restored.childWaitOrphanRecovery || restored.childWaitClaimRecovery)) {
    throw new Error("fixture_multi_tool_receipt_was_not_rejected")
  }
  if (phase === "claim-recovery-cut" && !restored.childWaitOrphanRecovery) throw new Error("fixture_child_wait_orphan_recovery_missing")
  if (phase === "claim-item-completed-cut" && !restored.childWaitClaimRecovery) throw new Error("fixture_child_wait_claim_recovery_missing")
  if (phase === "final" && !restored.childWaitClaimRecovery) throw new Error("fixture_child_wait_claim_recovery_missing")
  if (phase === "claim-recovery-cut" || phase === "claim-item-completed-cut" || phase === "final") {
    say(`WORKER_B_LOOP_RESTORED ${JSON.stringify({ phase, waitId: wait.waitId, recoveryCallId: recovery?.call.id ?? null,
      recoveryStepId: recovery?.stepId ?? null, logicalStepOrdinal: recovery?.stepOrdinal ?? null,
      physicalContinuationOrdinal: wait.continuationOrdinal ?? null, resumeNextOrdinal: restored.resume.nextOrdinal,
      modelUsage: recovery?.modelUsage ?? null, orphanCallIds: restored.childWaitOrphanCallIds ?? [] })}`)
  }
  const expectedClaimKey = `task:${lease.id}:event:child-wait-claim:${lease.attemptCount}:${continuationStepId}`
  const expectedStepId = `task:${lease.id}:step:${restored.resume.nextOrdinal}:attempt:${lease.attemptCount}`
  const modelResponse = ({ stepId }) => {
    if (phase === "preclaim" || phase === "multi-preclaim") {
      if (stepId !== expectedStepId) throw new Error("fixture_unexpected_preclaim_step_id")
      const calls = [{ id: callId, name: "wait_subagents", arguments: wait.input }]
      if (phase === "multi-preclaim") calls.push({ id: `${callId}:second`, name: "fixture_noop", arguments: {} })
      return { usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: highPrecisionWaitModelCostUsd }, toolCalls: calls }
    }
    if (stepId === continuationStepId) {
      throw new Error("fixture_orphan_step_model_reinvoked")
    }
    const expectedNextLogicalStepId = `task:${lease.id}:step:${logicalStepOrdinal + 1}:attempt:${lease.attemptCount}`
    if (stepId !== expectedNextLogicalStepId) throw new Error("fixture_child_wait_loop_next_logical_step_mismatch")
    return { text: ids.finalText ?? "continued-after-durable-child-wait", usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }
  }
  const beforeAppendEvent = async event => {
    if ((phase === "preclaim" || phase === "multi-preclaim") && event.type === "tool_call.started"
      && event.idempotencyKey === expectedClaimKey && event.correlationId === callId) {
      say(`WORKER_B_LOOP_PRE_CLAIM_ORPHAN ${JSON.stringify({ phase, callId, stepId: continuationStepId,
        waitId: wait.waitId, exactInput: canonicalJson(event.payload?.toolName) === canonicalJson("wait_subagents"),
        modelCalls: 1, executorCalls: 0, dispatcherCalls: 0 })}`)
      await new Promise(() => {})
    }
    if (phase === "usage-lineage-cut" && event.type === "model.started"
      && event.correlationId === `task:${lease.id}:step:${logicalStepOrdinal + 1}:attempt:${lease.attemptCount}`) {
      const completedStepId = recovery.stepId
      const nextStepId = event.correlationId
      const claimClient = await pool.connect()
      let claimRecovery
      try {
        await claimClient.query("BEGIN")
        await claimClient.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
        claimRecovery = await loadChildWaitCallRecovery(claimClient, lease, wait)
        await claimClient.query("COMMIT")
      } catch (error) {
        await claimClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { claimClient.release() }
      if (!claimRecovery?.claim || claimRecovery.claim.stepStatus !== "completed"
        || claimRecovery.claim.modelUsage.estimatedCostUsd !== highPrecisionWaitModelCostUsd) {
        throw new Error("fixture_pg_claim_loader_did_not_accept_rounded_usage")
      }
      let liveResumeError = null
      try { await loadChildAttemptResume(pool, lease, new Date(), wait) }
      catch (error) { liveResumeError = error?.message ?? String(error) }
      if (liveResumeError !== "child_resume_wait_step_lineage") {
        throw new Error(`fixture_live_step2_lineage_not_rejected:${liveResumeError ?? "no_error"}`)
      }
      const [stepState, usageState, callState] = await Promise.all([
        pool.query(`SELECT "status", "ordinal", "inputTokens", "outputTokens", "estimatedCostUsd"::text AS "estimatedCostUsd"
          FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = $4`,
        [lease.sessionId, lease.turnId, lease.id, completedStepId]),
        pool.query(`SELECT "payload"->'usage'->>'estimatedCostUsd' AS "receiptCost" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "correlationId" = $4 AND "type" = 'model.usage'`,
        [lease.sessionId, lease.turnId, lease.id, completedStepId]),
        pool.query(`SELECT
            (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "idempotencyKey" = $4) AS "claimCount",
            (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "stepId" = $5 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $6) AS "resultCount",
            (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "correlationId" = $7 AND "type" = 'model.started') AS "nextModelStartCount"`,
        [lease.sessionId, lease.turnId, lease.id, expectedClaimKey, completedStepId, recovery.call.id, nextStepId]),
      ])
      const completed = stepState.rows[0]
      const receipt = usageState.rows[0]
      const lifecycle = callState.rows[0]
      if (!completed || completed.status !== "completed" || completed.inputTokens !== 37 || completed.outputTokens !== 13
        || completed.estimatedCostUsd !== "0.12345679" || receipt?.receiptCost !== "0.123456789"
        || lifecycle?.claimCount !== 1 || lifecycle?.resultCount !== 1 || lifecycle?.nextModelStartCount !== 0) {
        throw new Error("fixture_rounded_usage_lineage_cut_state_invalid")
      }
      const nextStep = await pool.query(`SELECT "status", "ordinal" FROM "agent_steps"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = $4`,
      [lease.sessionId, lease.turnId, lease.id, nextStepId])
      if (nextStep.rows[0]?.status !== "streaming" || nextStep.rows[0]?.ordinal !== 3) {
        throw new Error("fixture_rounded_usage_next_step_not_streaming")
      }
      say(`WORKER_B_LOOP_ROUNDED_USAGE_LINEAGE_CUT ${JSON.stringify({ callId: recovery.call.id,
        completedStepId, completedStepStatus: completed.status, physicalStepOrdinal: completed.ordinal,
        persistedCostUsd: completed.estimatedCostUsd, receiptCostUsd: receipt.receiptCost,
        claimLoaderAccepted: true, claimLoaderStepStatus: claimRecovery.claim.stepStatus,
        claimLoaderUsageCost: claimRecovery.claim.modelUsage.estimatedCostUsd,
        nextStepId, nextStepStatus: nextStep.rows[0].status, nextPhysicalStepOrdinal: nextStep.rows[0].ordinal,
        claimCount: lifecycle.claimCount, resultCount: lifecycle.resultCount, nextModelStartCount: lifecycle.nextModelStartCount,
        liveResumeError, modelCalls: 0, executorCalls: 0, dispatcherCalls: 0 })}`)
      await new Promise(() => {})
    }
    if (phase === "claim-item-completed-cut" && event.type === "item.completed" && event.itemId === callItemId
      && event.correlationId === callItemId
      && event.idempotencyKey === `task:${lease.id}:event:tool-call-completed:${callId}:${callItemId}:1`) {
      const state = await pool.query(`SELECT item."status", item."revision",
          (SELECT COUNT(*)::int FROM "agent_events" AS claim WHERE claim."sessionId" = item."sessionId"
            AND claim."turnId" = item."turnId" AND claim."taskId" = item."taskId" AND claim."idempotencyKey" = $5) AS "claimCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS completed WHERE completed."sessionId" = item."sessionId"
            AND completed."turnId" = item."turnId" AND completed."taskId" = item."taskId" AND completed."itemId" = item."id"
            AND completed."type" = 'item.completed') AS "itemCompletedEventCount",
          (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = item."sessionId"
            AND result."turnId" = item."turnId" AND result."taskId" = item."taskId" AND result."stepId" = item."stepId"
            AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = $6) AS "resultCount"
        FROM "agent_items" AS item WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4`,
      [callItemId, lease.sessionId, lease.turnId, lease.id, expectedClaimKey, recovery.call.id])
      if (state.rows[0]?.status !== "completed" || state.rows[0]?.revision !== 1
        || state.rows[0]?.claimCount !== 1 || state.rows[0]?.itemCompletedEventCount !== 0 || state.rows[0]?.resultCount !== 0) {
        throw new Error("fixture_claim_completed_item_cut_state_invalid")
      }
      say(`WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT ${JSON.stringify({ callId: recovery.call.id, stepId: recovery.stepId,
        waitId: wait.waitId, modelCalls: 0, executorCalls: 0, dispatcherCalls: 0, callStatus: state.rows[0].status,
        callRevision: state.rows[0].revision, claimCount: state.rows[0].claimCount,
        itemCompletedEventCount: state.rows[0].itemCompletedEventCount, resultCount: state.rows[0].resultCount })}`)
      await new Promise(() => {})
    }
  }
  const beforeUpdateItem = async input => {
    if (phase !== "claim-recovery-cut" || input.itemId !== callItemId || input.status !== "completed") return
    const state = await pool.query(`SELECT item."status", item."revision",
        (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = item."sessionId"
          AND event."turnId" = item."turnId" AND event."taskId" = item."taskId" AND event."idempotencyKey" = $5) AS "claimCount",
        (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = item."sessionId"
          AND result."turnId" = item."turnId" AND result."taskId" = item."taskId" AND result."stepId" = item."stepId"
          AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = $6) AS "resultCount"
      FROM "agent_items" AS item WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4`,
    [callItemId, lease.sessionId, lease.turnId, lease.id, expectedClaimKey, recovery.call.id])
    if (state.rows[0]?.claimCount !== 1 || state.rows[0]?.resultCount !== 0 || state.rows[0]?.status !== "started") {
      throw new Error("fixture_claim_recovery_cut_state_invalid")
    }
    say(`WORKER_B_LOOP_CLAIM_BEFORE_RESULT ${JSON.stringify({ callId: recovery.call.id, stepId: recovery.stepId,
      waitId: wait.waitId, modelCalls: 0, executorCalls: 0, dispatcherCalls: 0,
      callStatus: state.rows[0].status, callRevision: state.rows[0].revision,
      claimCount: state.rows[0].claimCount, resultCount: state.rows[0].resultCount })}`)
    await new Promise(() => {})
  }
  const loop = await runChildWaitLoop(lease, restored, modelResponse, { beforeAppendEvent, beforeUpdateItem })
  say(`WORKER_B_LOOP_RESUMED ${JSON.stringify({ phase, status: loop.result.status, stepCount: loop.result.stepCount,
    toolCallCount: loop.result.toolCallCount, finalText: loop.result.finalText ?? null,
    invocations: loop.invocations, executorCalls: loop.executorCalls, dispatcherCalls: loop.dispatcherCalls,
    continuationStepId, logicalStepOrdinal, physicalContinuationOrdinal: wait.continuationOrdinal ?? null })}`)
  if (phase !== "final" || loop.result.status !== "completed" || loop.dispatcherCalls !== 0) {
    throw new Error("fixture_child_wait_loop_unexpected_completion")
  }
  return { status: "completed", result: { finalText: loop.result.finalText ?? "continued-after-durable-child-wait" } }
}

async function resumeLegacyConsumedWait(lease, phase) {
  const loaders = createProductionChildResumeLoaders(pool)
  if (!loaders.resumeLoader) throw new Error("fixture_production_resume_loader_unavailable")
  const restored = await loaders.resumeLoader(lease)
  if (!restored?.durableWait || !(restored.childWaitOrphanRecovery || restored.childWaitClaimRecovery)) {
    throw new Error("fixture_legacy_consumed_wait_repair_resume_missing")
  }
  const repeatRepairCount = await repairConsumedChildWaitSources(pool, lease, new Date())
  if (repeatRepairCount !== 0) throw new Error("fixture_legacy_consumed_wait_repair_not_idempotent")
  say(`WORKER_B_LEGACY_SOURCE_REPAIRED ${JSON.stringify({ waitId: restored.durableWait.waitId,
    sourceStepId: restored.durableWait.stepId, sourceAttempt: restored.durableWait.attempt,
    currentAttempt: lease.attemptCount, continuationStepId: restored.durableWait.continuationStepId ?? null,
    orphanCallId: restored.childWaitOrphanRecovery?.call.id ?? null,
    claimCallId: restored.childWaitClaimRecovery?.call.id ?? null, repeatedRepairCount,
    executorCalls: 0, dispatcherCalls: 0 })}`)
  return resumeChildThroughLoop(lease, phase, restored)
}

async function claimExactWaitReissue(lease, owner, wait, continuation, now, optionsForCut = {}) {
  let restored = optionsForCut.restored
  if (!restored && optionsForCut.checkStaleLeaseSnapshot) {
    if (!(lease.leaseExpiresAt instanceof Date)) throw new Error("durable_child_wait_original_lease_snapshot_missing")
    const snapshotExpiresAt = lease.leaseExpiresAt
    // Keep the immutable claim snapshot while the owner-fenced store heartbeat advances the DB lease.
    await new Promise(resolve => setTimeout(resolve, 10))
    const heartbeat = await store.heartbeat({ taskId: lease.id, sessionId: lease.sessionId, ownerId: lease.ownerId,
      attemptCount: lease.attemptCount, now: new Date() })
    if (heartbeat !== "renewed") throw new Error("durable_child_wait_lease_heartbeat_not_renewed")
    const logicalNow = new Date(snapshotExpiresAt.getTime() + 1)
    const liveTask = await store.get(lease.id, lease.sessionId)
    if (!(liveTask?.leaseExpiresAt instanceof Date) || liveTask.leaseExpiresAt.getTime() <= logicalNow.getTime()) {
      throw new Error("durable_child_wait_db_lease_not_past_snapshot")
    }
    restored = await loadChildAttemptResume(pool, lease, logicalNow, wait)
    if (!restored) throw new Error("durable_child_wait_stale_snapshot_resume_missing")
    say(`WORKER_B_STALE_LEASE_SNAPSHOT_ACCEPTED ${JSON.stringify({ snapshotExpiresAt: snapshotExpiresAt.toISOString(),
      logicalNow: logicalNow.toISOString(), liveDbLeaseExpiresAt: liveTask.leaseExpiresAt.toISOString(), loaded: true })}`)
  } else if (!restored) restored = await loadChildAttemptResume(pool, lease, new Date(), wait)
  const orphanCallIds = Array.isArray(restored?.childWaitOrphanCallIds) ? restored.childWaitOrphanCallIds : []
  if (optionsForCut.expectedOrphanCallId && !orphanCallIds.includes(optionsForCut.expectedOrphanCallId)) {
    throw new Error("durable_child_wait_orphan_not_classified")
  }
  if (optionsForCut.expectedOrphanCallId && (restored.resume.toolCallCount !== 1
    || restored.observations.some(item => item?.content?.toolCallId === optionsForCut.expectedOrphanCallId))) {
    throw new Error("durable_child_wait_orphan_counted_or_observed")
  }
  let staleOwnerRejected = false, staleAttemptRejected = false
  try { await loadChildAttemptResume(pool, { ...lease, ownerId: `${lease.ownerId}:stale` }, new Date(), wait) }
  catch (error) { staleOwnerRejected = error?.message === "child_resume_owner_mismatch" }
  try { await loadChildAttemptResume(pool, { ...lease, attemptCount: lease.attemptCount + 1 }, new Date(), wait) }
  catch (error) { staleAttemptRejected = error?.message === "child_resume_owner_mismatch" }
  if (!staleOwnerRejected || !staleAttemptRejected) throw new Error("durable_child_wait_stale_owner_or_attempt_not_fenced")

  const restoredWait = restored?.durableWait
  if (!restoredWait || restoredWait.continuationStepId !== continuation.id || restoredWait.continuationOrdinal !== continuation.ordinal) {
    throw new Error("durable_child_wait_claim_continuation_not_restored")
  }
  const call = { id: optionsForCut.expectedOrphanCallId ?? (optionsForCut.crashBeforeClaim
    ? `child-wait-reissue:${lease.id}:attempt:${lease.attemptCount}:orphan`
    : `child-wait-reissue:${lease.id}:attempt:${lease.attemptCount}`), name: "wait_subagents", arguments: restoredWait.input }
  if (restored.childWaitClaimRecovery) throw new Error("durable_child_wait_claimed_before_reissue")
  if (optionsForCut.loopPhase) {
    if (optionsForCut.loopPhase === "claim-recovery-cut" && restored.childWaitOrphanRecovery?.call.id !== call.id) {
      throw new Error("durable_child_wait_orphan_original_id_not_restored")
    }
    const modelResponse = ({ stepId }) => {
      if (optionsForCut.loopPhase === "preclaim" || optionsForCut.loopPhase === "multi-preclaim") {
        if (stepId !== continuation.id) throw new Error("fixture_unexpected_preclaim_step_id")
        const toolCalls = [{ id: call.id, name: "wait_subagents", arguments: restoredWait.input }]
        if (optionsForCut.loopPhase === "multi-preclaim") toolCalls.push({ id: `${call.id}:second`, name: "fixture_noop", arguments: {} })
        return { usage: { inputTokens: 37, outputTokens: 13, estimatedCostUsd: highPrecisionWaitModelCostUsd }, toolCalls }
      }
      throw new Error("fixture_orphan_step_model_reinvoked")
    }
    let preclaimStartObserved = false
    let preclaimClaimStartMatched = false
    const hooks = optionsForCut.loopPhase === "preclaim" || optionsForCut.loopPhase === "multi-preclaim"
      ? { beforeAppendEvent: async event => {
          const expectedKey = `task:${lease.id}:event:${childWaitClaimEventKey(lease.attemptCount, continuation.id)}`
          if (event.type === "tool_call.started") {
            preclaimStartObserved = true
            const itemMatches = event.itemId === `task:${lease.id}:item:tool-call:${call.id}:attempt:${lease.attemptCount}`
            const keyMatches = event.idempotencyKey === expectedKey
            const correlationMatches = event.correlationId === call.id
            if (!itemMatches || !keyMatches || !correlationMatches) {
              say(`WORKER_B_LOOP_PRE_CLAIM_START_MISMATCH ${JSON.stringify({ phase: optionsForCut.loopPhase,
                itemMatches, keyMatches, correlationMatches })}`)
            }
            if (itemMatches && keyMatches && correlationMatches) {
              preclaimClaimStartMatched = true
              say(`WORKER_B_LOOP_PRE_CLAIM_ORPHAN ${JSON.stringify({ phase: optionsForCut.loopPhase, callId: call.id,
                stepId: continuation.id, waitId: restoredWait.waitId, exactInput: true, modelCalls: 1,
                executorCalls: 0, dispatcherCalls: 0 })}`)
              await new Promise(() => {})
            }
          }
        } }
      : { beforeUpdateItem: async input => {
          const expectedItem = `task:${lease.id}:item:tool-call:${call.id}:attempt:${lease.attemptCount}`
          const expectedKey = `task:${lease.id}:event:${childWaitClaimEventKey(lease.attemptCount, continuation.id)}`
          if (input.itemId !== expectedItem || input.status !== "completed") return
          const state = await pool.query(`SELECT item."status", item."revision",
              (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = item."sessionId"
                AND event."turnId" = item."turnId" AND event."taskId" = item."taskId" AND event."idempotencyKey" = $5) AS "claimCount",
              (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = item."sessionId"
                AND result."turnId" = item."turnId" AND result."taskId" = item."taskId" AND result."stepId" = item."stepId"
                AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = $6) AS "resultCount"
            FROM "agent_items" AS item WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4`,
          [expectedItem, lease.sessionId, lease.turnId, lease.id, expectedKey, call.id])
          if (state.rows[0]?.claimCount !== 1 || state.rows[0]?.resultCount !== 0 || state.rows[0]?.status !== "started") {
            throw new Error("fixture_claim_recovery_cut_state_invalid")
          }
          say(`WORKER_B_LOOP_CLAIM_BEFORE_RESULT ${JSON.stringify({ callId: call.id, stepId: continuation.id,
            waitId: restoredWait.waitId, modelCalls: 0, executorCalls: 0, dispatcherCalls: 0,
            callStatus: state.rows[0].status, callRevision: state.rows[0].revision,
            claimCount: state.rows[0].claimCount, resultCount: state.rows[0].resultCount })}`)
          await new Promise(() => {})
        } }
    const loop = await runChildWaitLoop(lease, restored, modelResponse, hooks)
    if ((optionsForCut.loopPhase === "preclaim" || optionsForCut.loopPhase === "multi-preclaim") && !preclaimClaimStartMatched) {
      say(`WORKER_B_LOOP_PRE_CLAIM_BARRIER_MISSED ${JSON.stringify({ phase: optionsForCut.loopPhase, callId: call.id,
        stepId: continuation.id, loopStatus: loop.result.status, loopErrorCode: loop.result.errorCode ?? null,
        modelCalls: loop.invocations.length, toolCallStartObserved: preclaimStartObserved,
        executorCalls: loop.executorCalls, dispatcherCalls: loop.dispatcherCalls })}`)
      throw new Error("fixture_child_wait_preclaim_barrier_not_reached")
    }
    const status = childResultStatus(loop.result.status)
    const result = loop.result.finalText !== undefined ? { finalText: loop.result.finalText }
      : loop.result.waitId ? { waitId: loop.result.waitId } : undefined
    return { status, ...(result ? { result } : {}), ...(loop.result.errorCode ? { failureReason: loop.result.errorCode } : {}),
      ...(status === "failed" ? { retryDisposition: "terminal" } : {}) }
  }
  const replay = createChildDurableWaitReplay(lease, restoredWait, restored.observations)
  replay.acknowledgeContinuation({ id: continuation.id, ordinal: continuation.ordinal })
  const wrongStepRejected = replay.childWaitCallStartKey(`${continuation.id}:wrong`, call) === undefined
  if (!wrongStepRejected) throw new Error("durable_child_wait_wrong_step_claimed")
  let dispatcherCalls = 0
  const options = turnExecutionOptions(lease, owner, async input => {
    const result = replay.execute(input)
    if (!result) {
      dispatcherCalls += 1
      throw new Error("durable_child_wait_exact_reissue_dispatched_wait")
    }
    if (result.status !== "completed" || canonicalJson(result.output) !== canonicalJson(restoredWait.output)) {
      throw new Error("durable_child_wait_exact_reissue_not_replayed")
    }
    const competingCallId = `${call.id}:competitor`
    const competingCall = { ...input.call, id: competingCallId }
    const repeatedStartKeyRejected = replay.childWaitCallStartKey(input.stepId, competingCall) === undefined
    const competingReplay = replay.execute({ ...input, call: competingCall })
    const competingReplayRejected = competingReplay.status === "failed" && competingReplay.errorCode === "wait_conflict"
    if (!repeatedStartKeyRejected || !competingReplayRejected) throw new Error("durable_child_wait_one_use_guard_missing")
    const competitor = new TurnExecutionEventWriter(options)
    const competingItemId = `task:${lease.id}:item:tool-call:${competingCallId}:attempt:${lease.attemptCount}`
    await turnStore.createItem({ owner, itemId: competingItemId, stepId: continuation.id, type: "tool_call", status: "started", phase: null,
      content: { toolCallId: competingCallId, toolName: "wait_subagents", toolVersion: "1", input: call.arguments }, now: new Date() })
    let competingFreshIdRejected = false
    try {
      await competitor.append("tool_call.started", competingCallId, competingItemId,
        { toolCallId: competingCallId, toolName: "wait_subagents", taskId: lease.id },
        childWaitClaimEventKey(lease.attemptCount, continuation.id))
    } catch { competingFreshIdRejected = true }
    if (!competingFreshIdRejected) throw new Error("durable_child_wait_competing_fresh_id_claimed")
    let competingOrphanRejected = false
    try { await loadChildAttemptResume(pool, lease, new Date(), restoredWait) }
    catch (error) { competingOrphanRejected = error?.message === "child_resume_wait_tool_call_conflict" }
    const competingItemDeleted = await pool.query(`DELETE FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2
      AND "turnId" = $3 AND "taskId" = $4 RETURNING "id"`, [competingItemId, lease.sessionId, lease.turnId, lease.id])
    const claimAfterCompetition = await pool.query(`SELECT "correlationId" FROM "agent_events" WHERE "sessionId" = $1
      AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4`,
    [lease.sessionId, lease.turnId, lease.id, `task:${lease.id}:event:${childWaitClaimEventKey(lease.attemptCount, continuation.id)}`])
    if (!competingOrphanRejected || competingItemDeleted.rowCount !== 1 || claimAfterCompetition.rowCount !== 1
      || claimAfterCompetition.rows[0]?.correlationId !== call.id) throw new Error("durable_child_wait_competing_call_not_fenced")
    const claimForRecovery = (await loadChildAttemptResume(pool, lease, new Date(), restoredWait))?.childWaitClaimRecovery
    if (!claimForRecovery) throw new Error("durable_child_wait_claim_not_restored_after_competition")
    const staleOwner = { ...owner, ownerId: `${owner.ownerId}:stale` }
    const wrongOwnerOptions = turnExecutionOptions(lease, staleOwner, async () => { throw new Error("stale_claim_recovery_dispatched") },
      { childWaitClaimRecovery: claimForRecovery })
    let staleRecoveryOwnerRejected = false
    try { await recoverPersistedToolCalls(wrongOwnerOptions, new TurnExecutionEventWriter(wrongOwnerOptions), () => new Date()) }
    catch (error) { staleRecoveryOwnerRejected = error?.message === "child_wait_claim_recovery_owner_mismatch" }
    const staleAttempt = { ...owner, attemptCount: lease.attemptCount + 1 }
    const wrongAttemptOptions = turnExecutionOptions(lease, staleAttempt, async () => { throw new Error("stale_attempt_recovery_dispatched") },
      { childWaitClaimRecovery: claimForRecovery })
    let staleRecoveryAttemptRejected = false
    try { await recoverPersistedToolCalls(wrongAttemptOptions, new TurnExecutionEventWriter(wrongAttemptOptions), () => new Date()) }
    catch (error) { staleRecoveryAttemptRejected = error?.message === "child_wait_claim_recovery_owner_mismatch" }
    if (!staleRecoveryOwnerRejected || !staleRecoveryAttemptRejected) throw new Error("durable_child_wait_claim_recovery_fence_missing")
    say(`WORKER_B_REISSUE_CLAIMED ${JSON.stringify({ callId: call.id, stepId: continuation.id, waitId: restoredWait.waitId,
      exactInput: true, storedOutputMatched: true, wrongStepRejected, repeatedStartKeyRejected, competingReplayRejected,
      competingFreshIdRejected, competingOrphanRejected,
      orphanCallIds, staleOwnerRejected, staleAttemptRejected, staleRecoveryOwnerRejected, staleRecoveryAttemptRejected, dispatcherCalls })}`)
    return new Promise(() => {})
  }, {
    observations: restored.observations,
    childWaitCallStartKey: (stepId, candidate) => replay.childWaitCallStartKey(stepId, candidate),
    ...(optionsForCut.crashBeforeClaim ? { beforeAppendEvent: async event => {
      const expectedClaimKey = `task:${lease.id}:event:${childWaitClaimEventKey(lease.attemptCount, continuation.id)}`
      const expectedItemId = `task:${lease.id}:item:tool-call:${call.id}:attempt:${lease.attemptCount}`
      if (event.type === "tool_call.started" && event.itemId === expectedItemId && event.idempotencyKey === expectedClaimKey) {
        say(`WORKER_B_PRE_CLAIM_ORPHAN ${JSON.stringify({ callId: call.id, stepId: continuation.id,
          waitId: restoredWait.waitId, exactInput: true, executorCalls: dispatcherCalls })}`)
        await new Promise(() => {})
      }
    } } : {}),
  })
  const writer = new TurnExecutionEventWriter(options)
  if (optionsForCut.crashBeforeClaim) {
    await executeToolWithItems(options, writer, continuation, call, () => new Date())
    throw new Error("durable_child_wait_preclaim_barrier_returned")
  }
  await executeToolWithItems(options, writer, continuation, call, () => new Date())
  throw new Error("durable_child_wait_claim_barrier_returned")
}

async function recoverClaimedWait(lease, owner, restored, crashAfterResult) {
  const claim = restored?.childWaitClaimRecovery
  if (!claim) throw new Error("durable_child_wait_claim_recovery_missing")
  let executorCalls = 0
  const options = turnExecutionOptions(lease, owner, async () => {
    executorCalls += 1
    throw new Error("durable_child_wait_claim_recovery_dispatched_wait")
  }, { observations: restored.observations, childWaitClaimRecovery: claim })
  const observations = await recoverPersistedToolCalls(options, new TurnExecutionEventWriter(options), () => new Date())
  const recovered = observations.filter(item => item.id === `tool-result:${claim.call.id}`)
  const content = recovered[0]?.content
  if (recovered.length !== 1 || content?.toolCallId !== claim.call.id || content?.toolName !== "wait_subagents"
    || content?.status !== "completed" || content?.errorCode !== null || canonicalJson(content?.output) !== canonicalJson(claim.output)
    || executorCalls !== 0) throw new Error("durable_child_wait_claim_recovery_result_invalid")
  const summary = { callId: claim.call.id, stepId: claim.stepId, waitId: claim.output.waitId, outputMatched: true,
    orphanCallIds: restored.childWaitOrphanCallIds ?? [], restoredToolCallCount: restored.resume.toolCallCount,
    executorCalls, sameCallRecovered: true, resultItemStatus: claim.resultItem?.status ?? "created" }
  if (crashAfterResult) {
    say(`WORKER_B_REISSUE_RESULT_RECOVERED ${JSON.stringify(summary)}`)
    return new Promise(() => {})
  }
  say(`WORKER_B_REISSUE_RECOVERY_REUSED ${JSON.stringify(summary)}`)
  return content
}

async function waitForChild(lease, crashAfterRegistration = false) {
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `task:${lease.id}:step:0:attempt:${lease.attemptCount}`
  const toolCallId = phoneShapedToolCallId
  if (redactSensitiveText(toolCallId) === toolCallId) throw new Error("fixture_tool_call_id_is_not_phone_shaped")
  const input = { taskIds: [ids.targetTaskId], mode: "any", timeoutMs: 30_000, idempotencyKey: `api_key=source-wait-secret-${lease.id}-attempt-${lease.attemptCount}` }
  const now = new Date()
  let wait
  const fixtureModel = loopFixtureModel(async ({ stepId: actualStepId }) => {
    if (actualStepId !== stepId) throw new Error("fixture_source_wait_step_id_mismatch")
    return { toolCalls: [{ id: toolCallId, name: "wait_subagents", arguments: input }],
      usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } }
  })
  const options = turnExecutionOptions(lease, owner, async ({ call }) => {
    wait = await registerDurableSubagentWait(pool, { lease, stepId, targetTaskIds: call.input.taskIds, mode: call.input.mode,
      timeoutMs: call.input.timeoutMs, idempotencyKey: call.input.idempotencyKey, now })
    if (crashAfterRegistration) {
      say(`WORKER_A_REGISTERED ${JSON.stringify({ waitId: wait.waitId, stepId, callStatus: "started", receiptPersisted: false })}`)
      return new Promise(() => {})
    }
    return { id: toolCallId, toolName: "wait_subagents", toolVersion: "1", status: "completed", output: wait, errorCode: null }
  }, {
    contextBuilder: loopContextBuilder(),
    model: fixtureModel.model,
    tools: [{ name: "wait_subagents", version: "1", inputSchema: { type: "object" } }],
  })
  const result = await runTurnExecutionLoop(options)
  if (!wait || result.status !== "waiting_for_dependency" || result.waitId !== wait.waitId || fixtureModel.invocations.length !== 1) {
    throw new Error("fixture_source_wait_call_receipt_invalid")
  }
  return { status: "waiting", result: { waitId: wait.waitId } }
}

async function resumeChild(lease, crashBeforeWaitAck = false, crashAfterWaitAck = false, crashAfterClaimResult = false,
  reissueOrphan = false, sourceLifecycleCrashStage) {
  const now = new Date()
  const pendingWait = await loadDurableSubagentWaitResume(pool, lease, now)
  const restored = await loadChildAttemptResume(pool, lease, now, pendingWait)
  const wait = pendingWait ?? restored?.durableWait
  if (!wait || !restored?.durableWait || restored.durableWait.waitId !== wait.waitId
    || restored.durableWait.stepId !== wait.stepId || restored.durableWait.attempt !== wait.attempt
    || restored.durableWait.ordinal !== wait.ordinal
    || restored.resume.nextOrdinal !== wait.ordinal + 1 || wait.attempt !== lease.attemptCount) {
    throw new Error("durable_child_wait_resume_projection_invalid")
  }
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `task:${lease.id}:step:${restored.resume.nextOrdinal}:attempt:${lease.attemptCount}`
  say(`WORKER_B_RESTORED_WAIT_OBSERVATION ${JSON.stringify(restoredWaitObservationSummary(restored, wait, pendingWait, owner, stepId))}`)
  if (restored.childWaitOrphanCallIds?.length) say(`WORKER_B_ORPHAN_ACCOUNTING ${JSON.stringify({
    orphanCallIds: restored.childWaitOrphanCallIds,
    restoredToolCallCount: restored.resume.toolCallCount,
    orphanObserved: restored.observations.some(item => restored.childWaitOrphanCallIds.includes(item?.content?.toolCallId)),
    claimRecoveryPresent: Boolean(restored.childWaitClaimRecovery),
  })}`)
  if (!pendingWait) say(`WORKER_B_CONSUMED_WAIT_RECOVERED ${JSON.stringify({ waitId: wait.waitId, stepId: wait.stepId, attempt: wait.attempt, ordinal: wait.ordinal })}`)
  const nextOrdinal = wait.ordinal + 1
  const continuation = await turnStore.startStep({ owner, stepId, ordinal: nextOrdinal, attempt: lease.attemptCount,
    inputThroughSequence: restored.resume.inputThroughSequence, consumedInputIds: restored.resume.consumedInputIds,
    modelProfileSnapshot: loopFixtureModelProfile, now })
  if (continuation.id !== stepId || continuation.ordinal <= wait.ordinal) throw new Error("durable_child_wait_continuation_identity_invalid")
  if (!pendingWait) say(`WORKER_B_CONSUMED_WAIT_STEP_REUSED ${JSON.stringify({ waitId: wait.waitId, sourceStepId: wait.stepId,
    attempt: wait.attempt, sourceOrdinal: wait.ordinal, stepId: continuation.id, ordinal: continuation.ordinal })}`)
  if (crashBeforeWaitAck) {
    say(`WORKER_B_RESUME_STEP_STARTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: continuation.ordinal })}`)
    return new Promise(() => {})
  }
  const commitPool = sourceLifecycleCrashStage ? poolWithSourceLifecycleCrashBarrier(sourceLifecycleCrashStage) : pool
  if (!await commitDurableSubagentWaitResume(commitPool, lease, { waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal: continuation.ordinal, now })) {
    throw new Error("durable_child_wait_ack_pending")
  }
  if (crashAfterWaitAck) {
    say(`WORKER_B_RESUME_ACK_COMMITTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: continuation.ordinal })}`)
    return claimExactWaitReissue(lease, owner, wait, continuation, now,
      { crashBeforeClaim: true, checkStaleLeaseSnapshot: true, loopPhase: "preclaim" })
  }
  if (reissueOrphan) {
    const orphanCallIds = restored.childWaitOrphanCallIds ?? []
    if (orphanCallIds.length !== 1) throw new Error("durable_child_wait_restart_orphan_count_invalid")
    say(`WORKER_B_ORPHAN_RESTORED ${JSON.stringify({ waitId: wait.waitId, stepId: continuation.id,
      orphanCallIds, restoredToolCallCount: restored.resume.toolCallCount,
      orphanObserved: restored.observations.some(item => item?.content?.toolCallId === orphanCallIds[0]),
      claimRecoveryPresent: Boolean(restored.childWaitClaimRecovery) })}`)
    return claimExactWaitReissue(lease, owner, wait, continuation, now,
      { restored, expectedOrphanCallId: orphanCallIds[0], loopPhase: "claim-recovery-cut" })
  }
  if (restored.childWaitClaimRecovery) await recoverClaimedWait(lease, owner, restored, crashAfterClaimResult)
  await turnStore.createItem({ owner, itemId: `child-resume-final:${wait.sourceItemId}`, stepId, type: "agent_message", status: "completed",
    phase: "final_answer", content: { text: "parent-resumed-from-durable-child-result", wait: restored.durableWait.output }, now })
  await turnStore.updateStep({ owner, stepId, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })
  return { status: "completed", result: { finalText: "parent-resumed-from-durable-child-result", waitId: wait.waitId } }
}

async function stop(code) {
  if (stopped) return
  stopped = true
  try { await resolver?.close() } catch (error) { process.stderr.write(`resolver_close_failed:${String(error)}\n`) }
  try { await worker.close() } catch (error) { process.stderr.write(`worker_close_failed:${String(error)}\n`) }
  try { await redis.quit() } catch { redis.disconnect() }
  try { await pool.end() } catch (error) { process.stderr.write(`pool_close_failed:${String(error)}\n`) }
  process.exit(code)
}

const worker = new Worker(queueName, async job => {
  if (job.data.taskId !== ids.waiterTaskId) throw new Error("unexpected_subagent_task")
  const identity = parseSubagentDispatchJobId(job.id, job.data.taskId)
  if (!identity) throw new Error("invalid_subagent_dispatch_identity")
  const execute = mode === "worker-a" ? ({ lease }) => waitForChild(lease)
    : mode === "worker-a-crash" ? ({ lease }) => waitForChild(lease, true)
      : mode === "worker-b-crash-before-resume" ? ({ lease }) => {
        say(`WORKER_B_RESUME_NOT_STARTED ${JSON.stringify({ taskId: lease.id, attemptCount: lease.attemptCount })}`)
        return new Promise(() => {})
      }
      : mode === "worker-b-crash-resume" ? ({ lease }) => resumeChild(lease, true)
      : mode === "worker-b-crash-source-lifecycle" ? ({ lease }) => resumeChild(lease, false, false, false, false,
        ids.sourceLifecycleCrashStage ?? "after-consumed-update")
      : mode === "worker-b-crash-after-wait-ack" ? ({ lease }) => resumeChild(lease, false, true)
      : mode === "worker-b-crash-before-claim" ? ({ lease }) => resumeChild(lease, false, true)
        : mode === "worker-b-crash-after-orphan-reissue" ? ({ lease }) => resumeChild(lease, false, false, false, true)
      : mode === "worker-b-crash-after-claim-result" ? ({ lease }) => resumeChild(lease, false, false, true)
      : mode === "worker-b-loop-preclaim" ? ({ lease }) => resumeChildThroughLoop(lease, "preclaim")
      : mode === "worker-b-loop-claim-recovery-cut" ? ({ lease }) => resumeChildThroughLoop(lease, "claim-recovery-cut")
      : mode === "worker-b-loop-claim-item-completed-cut" ? ({ lease }) => resumeChildThroughLoop(lease, "claim-item-completed-cut")
      : mode === "worker-b-loop-usage-lineage-cut" ? ({ lease }) => resumeChildThroughLoop(lease, "usage-lineage-cut")
      : mode === "worker-b-loop-usage-lineage-reject" ? ({ lease }) => resumeChildThroughLoop(lease, "usage-lineage-reject")
      : mode === "worker-b-loop-final" ? ({ lease }) => resumeChildThroughLoop(lease, "final")
      : mode === "worker-b-loop-multi-preclaim" ? ({ lease }) => resumeChildThroughLoop(lease, "multi-preclaim")
      : mode === "worker-b-loop-multi-reject" ? ({ lease }) => resumeChildThroughLoop(lease, "multi-reject")
      : mode === "worker-b-legacy-consumed-seed" ? ({ lease }) => seedLegacyConsumedWait(lease)
      : mode === "worker-b-legacy-consumed-source-only" ? ({ lease }) => seedLegacyConsumedWait(lease, true)
      : mode === "worker-b-legacy-consumed-recovery" ? ({ lease }) => resumeLegacyConsumedWait(lease, "claim-recovery-cut")
      : mode === "worker-b-legacy-consumed-final" ? ({ lease }) => resumeLegacyConsumedWait(lease, "final")
      : mode === "worker-b" ? ({ lease }) => resumeChild(lease) : undefined
  if (!execute) throw new Error("invalid_fixture_mode")
  const executeWithDiagnostics = async input => {
    try { return await execute(input) }
    catch (error) {
      if (crashCutModes.has(mode)) process.stderr.write(`CRASH_CUT_EXECUTOR_ERROR ${JSON.stringify({ mode, ...boundedErrorDetails(error) })}\n`)
      throw error
    }
  }
  return runSubagentQueueJob(pool, manager, executeWithDiagnostics, job.data, identity)
}, { connection: redis, concurrency: 1, lockDuration: 15_000, skipVersionCheck: true,
  autorun: mode !== "worker-b-loop-final" })

worker.on("completed", (job, result) => {
  if (job.data.taskId !== ids.waiterTaskId) return
  const dispatchGeneration = parseSubagentDispatchJobId(job.id, ids.waiterTaskId)?.generation ?? null
  if (result?.status === "skipped" && result?.reason === "dispatch_identity_mismatch") {
    say(`WORKER_B_STALE_DISPATCH_SKIPPED ${JSON.stringify({ dispatchGeneration })}`)
    return
  }
  if (crashCutModes.has(mode)) {
    process.stderr.write(`UNEXPECTED_CRASH_CUT_COMPLETION ${JSON.stringify({ mode, result, taskId: ids.waiterTaskId })}\n`)
    void stop(1)
    return
  }
  const marker = mode === "worker-a" ? "WORKER_A_WAITING" : "WORKER_B_RESUMED"
  say(`${marker} ${JSON.stringify({ result, taskId: ids.waiterTaskId, dispatchGeneration })}`)
  void stop(0)
})
worker.on("failed", (job, error) => {
  if (job?.data.taskId !== ids.waiterTaskId) return
  process.stderr.write(`WORKER_FAILED ${error.message}\n`)
  void stop(1)
})

try {
  if (mode.startsWith("worker-b")) {
    const diagnosticsEnabled = mode === "worker-b-crash-resume"
    const processStartedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    const before = diagnosticsEnabled ? await readRecoveryStateSnapshot(pool, ids) : undefined
    if (before?.diagnostic === "query_failed") {
      throw new Error(`recovery_pre_snapshot_query_failed:${before.code ?? "unknown"}`)
    }
    const recoveryStartedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    const recovered = await manager.recover()
    const recoveryCompletedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    if (diagnosticsEnabled && !recovered.rows.some(row => row.id === ids.waiterTaskId)) {
      const after = await readRecoveryStateSnapshot(pool, ids)
      say(`WORKER_B_RECOVERY_DIAGNOSTIC ${JSON.stringify({ processStartedAt, recoveryStartedAt, recoveryCompletedAt,
        candidateScan: { targetPageRank: ids.recoveryTargetPageRank ?? null, candidateCount: ids.recoveryCandidateCount ?? null,
          fixtureBlockerCount: ids.recoveryFixtureBlockerCount ?? null, observedAt: ids.recoveryCandidateObservedAt ?? null },
        recovery: { reclaimed: recovered.reclaimed, terminal: recovered.terminal, targetReclaimed: recovered.rows.some(row => row.id === ids.waiterTaskId) },
        before, after })}`)
    }
    say(`WORKER_B_RECOVERED ${JSON.stringify({ reclaimed: recovered.reclaimed, terminal: recovered.terminal, rows: recovered.rows.map(row => ({ id: row.id, status: row.status })) })}`)
  }
  await worker.waitUntilReady()
  const readyMarker = readyMarkerByMode[mode]
  if (!readyMarker) throw new Error("invalid_fixture_mode")
  say(readyMarker)
  if (mode === "worker-b-loop-final") {
    const gateDeadline = Date.now() + 60_000
    while (Date.now() < gateDeadline && await redis.get(workerStartGateKey) !== "start") {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    if (await redis.get(workerStartGateKey) !== "start") throw new Error("fixture_worker_start_gate_timeout")
    await redis.del(workerStartGateKey)
    const run = worker.run()
    say("WORKER_B_PROCESSING_RELEASED")
    void run.catch(error => {
      process.stderr.write(`WORKER_RUN_FAILED ${String(error)}\n`)
      void stop(1)
    })
  }
} catch (error) {
  process.stderr.write(`WORKER_START_FAILED ${String(error)}\n`)
  await stop(1)
}
