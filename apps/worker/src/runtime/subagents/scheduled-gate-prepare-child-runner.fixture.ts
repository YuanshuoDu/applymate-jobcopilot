import { randomUUID } from "node:crypto"
import { Queue, Worker } from "bullmq"
import Redis from "ioredis"
import type { Pool } from "pg"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { WorkerUsageAuthorizationInput, WorkerUsageSettlementInput } from "../../queue/ai-usage-bridge.js"
import type { SubagentJobPayload } from "./types.js"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.js"
import { parseSubagentDispatchJobId } from "./dispatch-identity.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { seedScheduledGatePrepareFixture, type ScheduledGatePrepareSeedFixture } from "./scheduled-gate-prepare-pg.fixture.js"
import { SCHEDULED_GATE_BASE_RESUME } from "./scheduled-gate-prepare-pg-resume.fixture.js"

const WAIT_MS = 30_000
const LETTER = "Fixture cover letter prepared for the scheduled Gate integration test."

const SAFE_TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
const SAFE_FAILURE_CODES = new Set([
  "child_turn_missing", "subagent_role_unknown", "selected_job_context_unavailable", "writer_dependency_unavailable",
  "selected_job_sources_unavailable", "selected_job_output_contract_unavailable", "child_resume_evidence_unavailable",
  "child_resume_unavailable", "invalid_structured_result", "task_graph_child_deadline_exceeded",
  "task_graph_verification_failed", "task_graph_verification_unverified", "task_graph_other",
  "execution_setup_unavailable", "resume_state_unavailable", "structured_output_invalid", "lease_lost",
  "scheduled_gate_role_task_type_mismatch", "usage_authorization_unavailable", "usage_broker_unavailable",
  "usage_context_unavailable", "usage_denied", "usage_settlement_unknown", "usage_start_unavailable",
  "usage_start_conflict", "usage_start_replayed", "output_reservation_unknown",
])

export async function executeScheduledGatePrepareChild(pool: Pool, redisUrl: string,
  seed: ScheduledGatePrepareSeedFixture, taskId: string): Promise<void> {
  if (!taskId.trim() || taskId.length > 256) throw new Error("scheduled_prepare_task_id_invalid")
  const { dispatchPendingSubagentOutbox, subagentJobId } = await import("../../queue/subagent-queue.js")
  const [runtime, store, managerModule] = await Promise.all([import("./production-child-runtime.js"), import("./pg-store.js"), import("./manager.js")])
  const profile: ModelAdapter["profile"] = { provider: "fixture", model: "scheduled-gate-prepare", nativeTools: true,
    structuredOutput: true, streaming: true, continuationCursor: false, supportsParallelTools: false,
    supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false,
    supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null,
    maxOutputTokens: 2200, costClass: "low" }
  const modelRuntimeFactory = (): ModelAdapter => ({ id: "scheduled-gate-prepare-fixture", profile,
    async *stream(request) {
      const parts = request.messages.flatMap(message => message.content), result = parts.find(part => part.type === "tool_result")
      if (request.tools.some(tool => (tool as { name?: unknown }).name === "scheduled.application.prepare")) {
        if (!result || result.type !== "tool_result") {
          yield { type: "tool_call_completed", callId: `scheduled-prepare-tool-${taskId}`, name: "scheduled.application.prepare", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }; return
        }
        if (result.isError) throw new Error("scheduled Prepare tool returned an error")
        yield { type: "text_delta", text: result.content }; yield { type: "completed", finishReason: "stop" }; return
      }
      const prompt = parts.filter(part => part.type === "text").map(part => part.text).join("\n")
      const text = prompt.includes("Tailor this resume") ? JSON.stringify(SCHEDULED_GATE_BASE_RESUME)
        : prompt.includes("Write a concise, professional European application cover letter") ? LETTER : null
      if (!text) throw new Error("scheduled Prepare fixture received an unexpected material prompt")
      yield { type: "text_delta", text }; yield { type: "completed", finishReason: "stop" }
    } })
  const authorizeUsage = async (_input: WorkerUsageAuthorizationInput) => ({
    outputReservationRequired: false,
    maxOutputTokens: null,
    settle: async (_value: WorkerUsageSettlementInput) => undefined,
    settleUnknown: async (_value: WorkerUsageSettlementInput) => undefined,
  })
  const executor = runtime.createProductionChildExecutor({ pool: pool as never, authorizeUsage, modelRuntimeFactory })
  const manager = new managerModule.AgentTreeManager(new store.PgSubagentTaskStore(pool as never))
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null, connectTimeout: 2_000, retryStrategy: attempt => attempt > 3 ? null : 100 })
  const connection = redis.duplicate(), queueName = `scheduled-gate-prepare-${randomUUID()}`
  const queue = new Queue<SubagentJobPayload>(queueName, { connection, skipVersionCheck: true })
  let worker: Worker<SubagentJobPayload, unknown> | undefined
  try {
    await redis.ping(); await queue.waitUntilReady()
    await dispatchPendingSubagentOutbox(pool as never, queue, 10, seed.ids.sessionId)
    worker = new Worker<SubagentJobPayload, unknown>(queueName, async job => {
      const identity = parseSubagentDispatchJobId(job.id, job.data.taskId)
      if (!identity) throw new Error("scheduled Prepare dispatch identity invalid")
      return runSubagentQueueJob(pool as never, manager, executor, job.data, identity)
    }, { connection: redis.duplicate(), skipVersionCheck: true, concurrency: 1 })
    const completed = waitForChild(worker, subagentJobId(taskId))
    await worker.waitUntilReady()
    const outcome = await completed
    const outcomeStatus = outcome && typeof outcome === "object" ? ownData(outcome, "status") : undefined
    if (!outcome || typeof outcome !== "object" || outcomeStatus !== "completed") {
      const returnedStatus = safeStatus(outcomeStatus)
      const returnedFailure = safeFailureCode(outcome && typeof outcome === "object"
        ? ownData(outcome, "failureReason") ?? ownData(outcome, "errorCode") : undefined)
      const persisted = await readPrepareFailure(pool, seed, taskId)
      throw new Error(`scheduled Prepare child did not complete: returnedStatus=${returnedStatus}; returnedFailure=${returnedFailure}; persistedStatus=${persisted.status}; persistedFailure=${persisted.failure}`)
    }
  } finally {
    await worker?.close().catch(() => undefined)
    const job = await queue.getJob(subagentJobId(taskId)).catch(() => undefined)
    await job?.remove().catch(() => undefined)
    await queue.close().catch(() => undefined)
    await connection.quit().catch(() => connection.disconnect())
    await redis.quit().catch(() => redis.disconnect())
  }
}

function ownData(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor?.enumerable && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch { return undefined }
}
function safeStatus(value: unknown): string {
  return typeof value === "string" && SAFE_TASK_STATUSES.has(value) ? value : value === undefined ? "missing" : "other"
}
function safeFailureCode(value: unknown): string {
  return value === null ? "none" : typeof value === "string" && SAFE_FAILURE_CODES.has(value)
    ? value : value === undefined ? "missing" : "other"
}
async function readPrepareFailure(pool: Pool, seed: ScheduledGatePrepareSeedFixture, taskId: string): Promise<{ status: string; failure: string }> {
  try {
    const row = (await pool.query<{ status: string; failureReason: string | null }>(
      `SELECT "status", "failureReason" FROM "sub_agent_tasks"
        WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "rootTaskId"=$4 AND "parentTaskId"=$4 AND "role"=$5 AND "taskType"=$6`,
      [taskId, seed.ids.sessionId, seed.ids.turnId, seed.ids.rootTaskId, TASK_GRAPH_TEMPLATES.prepare.role,
        TASK_GRAPH_TEMPLATES.prepare.taskType])).rows[0]
    return row ? { status: safeStatus(row.status), failure: safeFailureCode(row.failureReason) }
      : { status: "missing", failure: "missing" }
  } catch { return { status: "read_failed", failure: "read_failed" } }
}
function waitForChild(worker: Worker<SubagentJobPayload, unknown>, jobId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`scheduled Prepare child timed out: ${jobId}`)), WAIT_MS)
    worker.on("completed", job => { if (job.id === jobId) { clearTimeout(timer); resolve(job.returnvalue) } })
    worker.on("failed", (job, error) => { if (job?.id === jobId) { clearTimeout(timer); reject(error) } })
  })
}
