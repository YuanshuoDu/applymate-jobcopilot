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

const [, , mode, queueName, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const readyMarkerByMode = {
  "worker-a": "WORKER_A_READY",
  "worker-a-crash": "WORKER_A_READY",
  "worker-b-crash-before-resume": "WORKER_B_READY",
  "worker-b-crash-resume": "WORKER_B_READY",
  "worker-b-crash-after-wait-ack": "WORKER_B_READY",
  "worker-b": "WORKER_B_READY",
}
const crashCutModes = new Set([
  "worker-a-crash",
  "worker-b-crash-before-resume",
  "worker-b-crash-resume",
  "worker-b-crash-after-wait-ack",
])
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 6 })
const redis = new Redis(process.env.AGENT_TURN_REDIS_TEST_URL, { maxRetriesPerRequest: null })
const store = new PgSubagentTaskStore(pool, 30_000)
const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
const turnStore = createPgTurnEngineStore(pool)
const resolver = mode.startsWith("worker-b") ? startDurableWaitResolver(pool, { intervalMs: 100, ownerId: "restart-fixture-worker-b" }) : undefined
let stopped = false

function say(value) { process.stdout.write(`${value}\n`) }

async function recoveryStateSnapshot() {
  try {
    const result = await pool.query(`SELECT clock_timestamp() AS "databaseClock", session."status" AS "sessionStatus",
        turn."status" AS "turnStatus", root."status" AS "rootStatus", root."interruptRequestedAt" AS "rootInterruptRequestedAt",
        task."status" AS "taskStatus", task."attemptCount", task."maxAttempts", task."leaseOwner" IS NOT NULL AS "leaseOwnerPresent", task."leaseExpiresAt",
        task."nextAttemptAt", task."interruptRequestedAt", task."status" = 'running' AND task."leaseExpiresAt" <= clock_timestamp() AS "expiredRunning",
        task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp() AS "retryDue",
        wait."id" IS NOT NULL AS "waitPresent", wait."status" AS "waitStatus", wait."deadlineAt", wait."suspendedAt", wait."resolvedAt", wait."consumedAt",
        jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS "waitTargetCount",
        wait."deadlineAt" IS NOT NULL AND wait."deadlineAt" <= clock_timestamp() AS "waitDeadlineDue",
        step."id" IS NOT NULL AS "stepPresent", step."status" AS "stepStatus", step."attempt" AS "stepAttempt", step."ordinal" AS "stepOrdinal",
        step."ordinal" = (SELECT MAX(latest."ordinal") FROM "agent_steps" AS latest WHERE latest."taskId" = task."id"
          AND latest."sessionId" = task."sessionId" AND latest."turnId" = task."turnId" AND latest."attempt" = task."attemptCount") AS "stepIsLatest",
        call."id" IS NOT NULL AS "callPresent", call."status" AS "callStatus", call."content"->>'toolName' AS "callName",
        call."content"->>'toolVersion' AS "callVersion",
        (SELECT COUNT(*)::int = 1 FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
          AND started."itemId" = call."id" AND started."turnId" = task."turnId" AND started."type" = 'tool_call.started'
          AND started."correlationId" = call."content"->>'toolCallId' AND call."status" IN ('started', 'streaming', 'completed')
          AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
            AND settled."correlationId" = started."correlationId" AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))) AS "unsettledWaitCallMatches",
        COALESCE((call."content"->>'toolVersion' = '1' AND (call."content"->'input') - 'taskIds'::text = jsonb_build_object(
          'idempotencyKey', wait."idempotencyKey", 'mode', wait."mode", 'timeoutMs', wait."result"->'request'->'timeoutMs')
          AND (SELECT jsonb_agg(target."id" ORDER BY target."id") FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(call."content"->'input'->'taskIds') = 'array' THEN call."content"->'input'->'taskIds' ELSE '[]'::jsonb END
          ) AS target("id")) = wait."targetTaskIds"), FALSE) AS "waitCallRequestMatches",
        COALESCE(wait."result"->'request' = jsonb_build_object('targetTaskIds', wait."targetTaskIds", 'mode', wait."mode",
          'timeoutMs', wait."result"->'request'->'timeoutMs'), FALSE) AS "waitRequestMatches",
        COALESCE(wait."result"->'outcome'->>'waitId' = wait."id" AND wait."result"->'outcome'->>'status' = wait."status"
          AND wait."result"->'outcome'->'taskIds' = wait."targetTaskIds"
          AND wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds", FALSE) AS "waitOutcomeMatches",
        wait."result" IS NOT NULL AS "waitResultPresent", jsonb_typeof(wait."result") AS "waitResultType",
        octet_length(wait."result"::text) AS "waitResultByteLength",
        COALESCE(wait."result"->>'truncated' = 'true', FALSE) AS "waitResultTruncated",
        jsonb_typeof(wait."result"->'request') AS "waitRequestType",
        (SELECT COUNT(*)::int FROM jsonb_object_keys(CASE WHEN jsonb_typeof(wait."result"->'request') = 'object'
          THEN wait."result"->'request' ELSE '{}'::jsonb END)) AS "waitRequestKeyCount",
        CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (wait."result"->'request') ? 'targetTaskIds' ELSE FALSE END AS "waitRequestHasTargetTaskIds",
        CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (wait."result"->'request') ? 'mode' ELSE FALSE END AS "waitRequestHasMode",
        CASE WHEN jsonb_typeof(wait."result"->'request') = 'object' THEN (wait."result"->'request') ? 'timeoutMs' ELSE FALSE END AS "waitRequestHasTimeoutMs",
        jsonb_typeof(wait."result"->'request'->'targetTaskIds') AS "waitRequestTargetTaskIdsType",
        CASE WHEN jsonb_typeof(wait."result"->'request'->'targetTaskIds') = 'array'
          THEN jsonb_array_length(wait."result"->'request'->'targetTaskIds') ELSE NULL END AS "waitRequestTargetTaskIdsCount",
        jsonb_typeof(wait."result"->'request'->'mode') AS "waitRequestModeType",
        jsonb_typeof(wait."result"->'request'->'timeoutMs') AS "waitRequestTimeoutMsType",
        COALESCE(wait."result"->'request'->'targetTaskIds' = wait."targetTaskIds", FALSE) AS "waitRequestTargetTaskIdsMatch",
        COALESCE(wait."result"->'request'->>'mode' = wait."mode", FALSE) AS "waitRequestModeMatch",
        COALESCE(wait."result"->'request'->'timeoutMs' = call."content"->'input'->'timeoutMs', FALSE) AS "waitRequestTimeoutMsMatchCall",
        jsonb_typeof(wait."result"->'outcome') AS "waitOutcomeType",
        (SELECT COUNT(*)::int FROM jsonb_object_keys(CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object'
          THEN wait."result"->'outcome' ELSE '{}'::jsonb END)) AS "waitOutcomeKeyCount",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'waitId' ELSE FALSE END AS "waitOutcomeHasWaitId",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'status' ELSE FALSE END AS "waitOutcomeHasStatus",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'taskIds' ELSE FALSE END AS "waitOutcomeHasTaskIds",
        CASE WHEN jsonb_typeof(wait."result"->'outcome') = 'object' THEN (wait."result"->'outcome') ? 'matchedTaskIds' ELSE FALSE END AS "waitOutcomeHasMatchedTaskIds",
        jsonb_typeof(wait."result"->'outcome'->'waitId') AS "waitOutcomeWaitIdType",
        jsonb_typeof(wait."result"->'outcome'->'status') AS "waitOutcomeStatusType",
        jsonb_typeof(wait."result"->'outcome'->'taskIds') AS "waitOutcomeTaskIdsType",
        CASE WHEN jsonb_typeof(wait."result"->'outcome'->'taskIds') = 'array'
          THEN jsonb_array_length(wait."result"->'outcome'->'taskIds') ELSE NULL END AS "waitOutcomeTaskIdsCount",
        jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') AS "waitOutcomeMatchedTaskIdsType",
        CASE WHEN jsonb_typeof(wait."result"->'outcome'->'matchedTaskIds') = 'array'
          THEN jsonb_array_length(wait."result"->'outcome'->'matchedTaskIds') ELSE NULL END AS "waitOutcomeMatchedTaskIdsCount",
        COALESCE(wait."result"->'outcome'->>'waitId' = wait."id", FALSE) AS "waitOutcomeWaitIdMatch",
        COALESCE(wait."result"->'outcome'->>'status' = wait."status", FALSE) AS "waitOutcomeStatusMatch",
        COALESCE(wait."result"->'outcome'->'taskIds' = wait."targetTaskIds", FALSE) AS "waitOutcomeTaskIdsMatch",
        COALESCE(wait."result"->'outcome'->'matchedTaskIds' = wait."matchedTaskIds", FALSE) AS "waitOutcomeMatchedTaskIdsMatch",
        COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) BETWEEN 1 AND 8
          AND jsonb_array_length(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END)
            = (SELECT COUNT(DISTINCT target."id") FROM jsonb_array_elements(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id") WHERE jsonb_typeof(target."id") = 'string')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END) AS target("id")
            WHERE NOT EXISTS (SELECT 1 FROM "sub_agent_tasks" AS child WHERE child."id" = target."id" AND child."id" <> task."id" AND child."parentTaskId" = task."id"
              AND child."rootTaskId" = task."rootTaskId" AND child."sessionId" = task."sessionId" AND child."turnId" = task."turnId")), FALSE) AS "waitTargetsMatchScope",
        (SELECT COUNT(*)::int FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
          AND started."itemId" = call."id" AND started."type" = 'tool_call.started') AS "startedEventCount",
        (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
          AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledEventCount",
        dispatch."attemptCount" AS "dispatchAttemptCount", dispatch."publishedAt" IS NOT NULL AS "dispatchPublished"
      FROM "agent_sessions" AS session
      LEFT JOIN "agent_turns" AS turn ON turn."id" = $2 AND turn."sessionId" = session."id"
      LEFT JOIN "sub_agent_tasks" AS task ON task."id" = $4 AND task."sessionId" = session."id"
        AND task."turnId" = turn."id" AND task."rootTaskId" = $3
      LEFT JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
      LEFT JOIN LATERAL (SELECT currentWait.* FROM "agent_wait_conditions" AS currentWait
        WHERE currentWait."parentTaskId" = task."id" AND currentWait."sessionId" = task."sessionId" AND currentWait."turnId" = task."turnId"
        ORDER BY currentWait."createdAt" DESC, currentWait."id" DESC LIMIT 1) AS wait ON TRUE
      LEFT JOIN "agent_steps" AS step ON step."id" = wait."stepId" AND step."sessionId" = task."sessionId"
        AND step."turnId" = task."turnId" AND step."taskId" = task."id"
      LEFT JOIN LATERAL (SELECT currentCall.* FROM "agent_items" AS currentCall
        WHERE currentCall."sessionId" = task."sessionId" AND currentCall."turnId" = task."turnId" AND currentCall."taskId" = task."id"
          AND currentCall."stepId" = step."id" AND currentCall."type" = 'tool_call' AND currentCall."content"->>'toolName' = 'wait_subagents'
        ORDER BY currentCall."id" DESC LIMIT 1) AS call ON TRUE
      LEFT JOIN LATERAL (SELECT currentDispatch."attemptCount", currentDispatch."publishedAt" FROM "agent_outbox" AS currentDispatch
        WHERE currentDispatch."topic" = 'agent.subagent.dispatch' AND currentDispatch."aggregateId" = session."id"
          AND currentDispatch."idempotencyKey" = 'subagent-dispatch:' || task."id" LIMIT 1) AS dispatch ON TRUE
      WHERE session."id" = $1`, [ids.sessionId, ids.turnId, ids.rootTaskId, ids.waiterTaskId])
    return result.rows[0] ?? { diagnostic: "fixture_state_missing" }
  } catch (error) {
    const code = typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null
    return { diagnostic: "query_failed", code }
  }
}

function boundedErrorDetails(error) {
  if (error instanceof Error) return { name: String(error.name).slice(0, 128), message: error.message.slice(0, 1_000), stack: error.stack?.slice(0, 3_000) ?? null }
  return { name: typeof error, message: String(error).slice(0, 1_000), stack: null }
}

async function waitForChild(lease, crashAfterRegistration = false) {
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `child-wait-step:${lease.id}:attempt:${lease.attemptCount}`
  const toolCallId = `child-wait-call:${lease.id}:attempt:${lease.attemptCount}`
  const input = { taskIds: [ids.targetTaskId], mode: "any", timeoutMs: 30_000, idempotencyKey: `child-wait:${lease.id}:attempt:${lease.attemptCount}` }
  const now = new Date()
  await turnStore.startStep({ owner, stepId, ordinal: 0, attempt: lease.attemptCount, inputThroughSequence: 0n,
    consumedInputIds: [], modelProfileSnapshot: {}, now })
  const callItemId = `child-wait-call-item:${lease.id}`
  await turnStore.createItem({ owner, itemId: callItemId, stepId, type: "tool_call", status: "started", phase: null,
    content: { toolCallId, toolName: "wait_subagents", toolVersion: "1", input }, now })
  await turnStore.appendEvent({ owner, id: `task:${lease.id}:event:tool-started:${toolCallId}`, itemId: callItemId, type: "tool_call.started",
    correlationId: toolCallId, causationId: null, idempotencyKey: `task:${lease.id}:event:tool-started:${toolCallId}`,
    payload: { toolCallId, toolName: "wait_subagents", taskId: lease.id } })
  const wait = await registerDurableSubagentWait(pool, { lease, stepId, targetTaskIds: input.taskIds, mode: input.mode,
    timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey, now })
  if (crashAfterRegistration) {
    say(`WORKER_A_REGISTERED ${JSON.stringify({ waitId: wait.waitId, stepId, toolCallId })}`)
    return new Promise(() => {})
  }
  await turnStore.createItem({ owner, itemId: `child-wait-result-item:${lease.id}`, stepId, type: "tool_result", status: "completed", phase: null,
    content: { toolCallId, output: wait, errorCode: null }, now })
  await turnStore.updateStep({ owner, stepId, status: "waiting_for_tool", finishReason: "tool_calls", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })
  return { status: "waiting", result: { waitId: wait.waitId } }
}

async function resumeChild(lease, crashBeforeWaitAck = false, crashAfterWaitAck = false) {
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
  if (!pendingWait) say(`WORKER_B_CONSUMED_WAIT_RECOVERED ${JSON.stringify({ waitId: wait.waitId, stepId: wait.stepId, attempt: wait.attempt, ordinal: wait.ordinal })}`)
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `child-resume-step:${lease.id}:attempt:${lease.attemptCount}`
  const nextOrdinal = wait.ordinal + 1
  const continuation = await turnStore.startStep({ owner, stepId, ordinal: nextOrdinal, attempt: lease.attemptCount,
    inputThroughSequence: restored.resume.inputThroughSequence, consumedInputIds: restored.resume.consumedInputIds,
    modelProfileSnapshot: {}, now })
  if (continuation.id !== stepId || continuation.ordinal <= wait.ordinal) throw new Error("durable_child_wait_continuation_identity_invalid")
  if (!pendingWait) say(`WORKER_B_CONSUMED_WAIT_STEP_REUSED ${JSON.stringify({ waitId: wait.waitId, sourceStepId: wait.stepId,
    attempt: wait.attempt, sourceOrdinal: wait.ordinal, stepId: continuation.id, ordinal: continuation.ordinal })}`)
  if (crashBeforeWaitAck) {
    say(`WORKER_B_RESUME_STEP_STARTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: continuation.ordinal })}`)
    return new Promise(() => {})
  }
  if (!await commitDurableSubagentWaitResume(pool, lease, { waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal: continuation.ordinal, now })) {
    throw new Error("durable_child_wait_ack_pending")
  }
  if (crashAfterWaitAck) {
    say(`WORKER_B_RESUME_ACK_COMMITTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: continuation.ordinal })}`)
    return new Promise(() => {})
  }
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
      : mode === "worker-b-crash-after-wait-ack" ? ({ lease }) => resumeChild(lease, false, true)
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
}, { connection: redis, concurrency: 1, lockDuration: 15_000, skipVersionCheck: true })

worker.on("completed", (job, result) => {
  if (job.data.taskId !== ids.waiterTaskId) return
  if (crashCutModes.has(mode)) {
    process.stderr.write(`UNEXPECTED_CRASH_CUT_COMPLETION ${JSON.stringify({ mode, result, taskId: ids.waiterTaskId })}\n`)
    void stop(1)
    return
  }
  const marker = mode === "worker-a" ? "WORKER_A_WAITING" : "WORKER_B_RESUMED"
  say(`${marker} ${JSON.stringify({ result, taskId: ids.waiterTaskId })}`)
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
    const before = diagnosticsEnabled ? await recoveryStateSnapshot() : undefined
    if (before?.diagnostic === "query_failed") {
      throw new Error(`recovery_pre_snapshot_query_failed:${before.code ?? "unknown"}`)
    }
    const recoveryStartedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    const recovered = await manager.recover()
    const recoveryCompletedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    if (diagnosticsEnabled && !recovered.rows.some(row => row.id === ids.waiterTaskId)) {
      const after = await recoveryStateSnapshot()
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
} catch (error) {
  process.stderr.write(`WORKER_START_FAILED ${String(error)}\n`)
  await stop(1)
}
