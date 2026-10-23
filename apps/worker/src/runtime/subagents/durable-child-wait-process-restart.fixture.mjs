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
  "worker-b": "WORKER_B_READY",
}
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 6 })
const redis = new Redis(process.env.AGENT_TURN_REDIS_TEST_URL, { maxRetriesPerRequest: null })
const store = new PgSubagentTaskStore(pool, 30_000)
const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
const turnStore = createPgTurnEngineStore(pool)
const resolver = mode.startsWith("worker-b") ? startDurableWaitResolver(pool, { intervalMs: 100, ownerId: "restart-fixture-worker-b" }) : undefined
let stopped = false

function say(value) { process.stdout.write(`${value}\n`) }

async function waitForChild(lease, crashAfterRegistration = false) {
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `child-wait-step:${lease.id}:attempt:${lease.attemptCount}`
  const toolCallId = `child-wait-call:${lease.id}:attempt:${lease.attemptCount}`
  const input = { taskIds: [ids.targetTaskId], mode: "any", timeoutMs: 60_000, idempotencyKey: `child-wait:${lease.id}:attempt:${lease.attemptCount}` }
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

async function resumeChild(lease, crashBeforeWaitAck = false) {
  const wait = await loadDurableSubagentWaitResume(pool, lease)
  if (!wait) throw new Error("durable_child_wait_not_ready")
  const restored = await loadChildAttemptResume(pool, lease, new Date(), wait)
  if (!restored?.durableWait || restored.durableWait.waitId !== wait.waitId
    || restored.resume.nextOrdinal !== wait.ordinal + 1 || wait.attempt !== lease.attemptCount) {
    throw new Error("durable_child_wait_resume_projection_invalid")
  }
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `child-resume-step:${lease.id}:attempt:${lease.attemptCount}`
  const nextOrdinal = wait.ordinal + 1
  const now = new Date()
  await turnStore.startStep({ owner, stepId, ordinal: nextOrdinal, attempt: lease.attemptCount,
    inputThroughSequence: restored.resume.inputThroughSequence, consumedInputIds: restored.resume.consumedInputIds,
    modelProfileSnapshot: {}, now })
  if (crashBeforeWaitAck) {
    say(`WORKER_B_RESUME_STEP_STARTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: nextOrdinal })}`)
    return new Promise(() => {})
  }
  await turnStore.createItem({ owner, itemId: `child-resume-final:${wait.sourceItemId}`, stepId, type: "agent_message", status: "completed",
    phase: "final_answer", content: { text: "parent-resumed-from-durable-child-result", wait: restored.durableWait.output }, now })
  await turnStore.updateStep({ owner, stepId, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })
  await commitDurableSubagentWaitResume(pool, lease, { waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal: nextOrdinal, now })
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
  const execute = mode === "worker-a" ? waitForChild
    : mode === "worker-a-crash" ? lease => waitForChild(lease, true)
      : mode === "worker-b-crash-before-resume" ? lease => {
        say(`WORKER_B_RESUME_NOT_STARTED ${JSON.stringify({ taskId: lease.id, attemptCount: lease.attemptCount })}`)
        return new Promise(() => {})
      }
      : mode === "worker-b-crash-resume" ? lease => resumeChild(lease, true)
      : mode === "worker-b" ? resumeChild : undefined
  if (!execute) throw new Error("invalid_fixture_mode")
  return runSubagentQueueJob(pool, manager, execute, job.data, identity)
}, { connection: redis, concurrency: 1, lockDuration: 15_000, skipVersionCheck: true })

worker.on("completed", (job, result) => {
  if (job.data.taskId !== ids.waiterTaskId) return
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
    const recovered = await manager.recover()
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
