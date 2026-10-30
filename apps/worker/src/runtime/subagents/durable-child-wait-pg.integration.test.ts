import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue } from "bullmq"
import { Pool, type PoolClient } from "pg"
import { Redis } from "ioredis"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { AgentTreeManager } from "./manager.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy } from "./types.js"
import { subagentDispatchJobId } from "./dispatch-identity.js"
import { CHILD_WAIT_RESUMABLE_SQL } from "../../queue/subagent-dispatch-eligibility.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { executionOwnerFence } from "../execution-owner.js"
import { registerDurableSubagentWait } from "./durable-subagent-wait-store.js"
import { reconcileDurableSubagentWaits } from "./durable-subagent-wait-resolver.js"
import { commitDurableSubagentWaitResume, loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.js"
import { createProductionChildResumeLoaders } from "./production-child-resume-loaders.js"
import { actionList, asObject, INSERT_TASK, json } from "./pg-store-persistence.js"
import type { SubagentLease } from "./types.js"
import { hasBlockingExternalCall } from "./pg-store-expiry-recovery-predicates.js"
import { safeSubagentWaitJson } from "./subagent-wait-structural-ids.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const FINAL_MARKER = "parent-resumed-from-durable-child-result"
const FIXED_WAIT_TARGET_TASK_ID = "subagent-00000000-0000-4000-8000-000000000001"
const PHONE_SHAPED_WAIT_TOOL_CALL_ID = "child-wait-call:415-555-0134"
const SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY = (taskId: string) => `api_key=source-wait-secret-${taskId}-attempt-1`
const HIGH_PRECISION_WAIT_MODEL_COST_USD = 0.123456789
const LOOP_FIXTURE_MODEL_PROFILE_SNAPSHOT = {
  provider: "fixture", model: "durable-child-wait-fixture", nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: true, supportsStreamingToolArgs: true,
  supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
}
const REISSUED_WAIT_TOOL_CALL_PREFIX = "child-wait-reissue:"
const TARGET_RESULT_TEXT = "durable-child-result-after-process-restart; phone +1 (415) 555-0134; email child-wait@example.invalid"
const REDACTED_TARGET_RESULT_TEXT = "durable-child-result-after-process-restart; phone [REDACTED_PHONE]; email [REDACTED_EMAIL]"
const RESTORED_WAIT_OBSERVATION_MARKER = "WORKER_B_RESTORED_WAIT_OBSERVATION "
const SOURCE_LIFECYCLE_CRASH_STAGES = [
  "after-call-item-update",
  "after-result-item-insert",
  "after-result-item-update",
  "after-event-sequence-1", "after-event-insert-1", "after-event-outbox-1",
  "after-event-sequence-2", "after-event-insert-2", "after-event-outbox-2",
  "after-event-sequence-3", "after-event-insert-3", "after-event-outbox-3",
  "after-event-sequence-4", "after-event-insert-4", "after-event-outbox-4",
  "after-provenance-update",
  "after-consumed-update",
] as const
const fixturePath = fileURLToPath(new URL("./durable-child-wait-process-restart.fixture.mjs", import.meta.url))
const workerCwd = fileURLToPath(new URL("../../..", import.meta.url))

function safeProjectedWaitKey(input: { taskIds: readonly string[]; mode: "any" | "all"; timeoutMs: number; idempotencyKey: string }): string {
  const projected = asObject(safeSubagentWaitJson(input, 1_024))
  if (typeof projected.idempotencyKey !== "string") throw new Error("fixture_wait_key_projection_invalid")
  return projected.idempotencyKey
}

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== "" || url.hash !== "") throw new Error("Child-wait integration requires the disposable PostgreSQL service URL")
  return value
}

function disposableRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379" || url.pathname !== "/15" || url.username !== "" || url.password !== ""
    || url.search !== "" || url.hash !== "") throw new Error("Child-wait integration accepts only disposable Redis DB 15")
  return value
}

const databaseUrl = disposableDatabaseUrl()
const redisUrl = disposableRedisUrl()
const withServices = databaseUrl && redisUrl && process.env.RUN_AGENT_TURN_REDIS_INTEGRATION === "1" ? describe : describe.skip
type FixtureIds = { userId: string; sessionId: string; turnId: string; rootTaskId: string; waiterTaskId: string; targetTaskId: string;
  finalText?: string; loopCallPrefix?: string; recoveryTargetPageRank?: number; recoveryCandidateCount?: number;
  recoveryFixtureBlockerCount?: number; recoveryCandidateObservedAt?: string;
  sourceLifecycleCrashStage?: (typeof SOURCE_LIFECYCLE_CRASH_STAGES)[number] }
type FixedWaitTargetParent = {
  id: string; sessionId: string; turnId: string; rootTaskId: string; path: string; depth: number;
  allowedActions: unknown; modelProfileSnapshot: unknown; toolPolicySnapshot: unknown
}
type WorkerProcess = ChildProcess & {
  stdoutText: string
  stderrText: string
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}
const WORKER_RESULT_STATUSES = ["completed", "failed", "interrupted", "lease_lost", "retrying", "skipped", "waiting", "waiting_for_user"] as const
type WorkerResultStatus = typeof WORKER_RESULT_STATUSES[number]
const WORKER_FAILURE_REASON_CATEGORIES = [
  "wait_checkpoint_invalid", "wait_scope_error", "wait_invalid", "wait_conflict",
  "child_resume_wait_tool_call_conflict", "child_resume_wait_step_lineage", "child_resume_wait_lineage",
  "child_resume_wait_owner_mismatch", "child_resume_wait_commit_unavailable", "child_resume_wait_commit_pending",
  "unsettled_external_call_rejected", "durable_wait_graph_blocked", "task_graph_transition_blocked",
  "turn_execution_failed", "fixture_source_wait_call_receipt_invalid", "missing", "other",
] as const
type WorkerFailureReasonCategory = typeof WORKER_FAILURE_REASON_CATEGORIES[number]
const DIAGNOSTIC_TASK_STATUSES = new Set(["queued", "running", "waiting", "waiting_for_user", "retrying",
  "completed", "failed", "interrupted", "cancelled", "closed"])
type RestoredWaitObservationSummary = {
  state: "unconsumed" | "consumed"
  canonicalCallIdPreserved: boolean
  modelContextSafe: boolean
  modelToolPairBound: boolean
  deterministicProjection: boolean
  providerInvoked: boolean
  inputTaskIds: Array<string | null> | null
  outputTaskIds: Array<string | null> | null
  matchedTaskIds: Array<string | null> | null
  outputTaskIdsFromTasks: Array<string | null> | null
  targetFinalText: string | null
}

function launchWorker(mode: "worker-a" | "worker-a-crash" | "worker-b-crash-before-resume" | "worker-b-crash-resume" | "worker-b-crash-source-lifecycle" | "worker-b-crash-after-wait-ack" | "worker-b-crash-before-claim" | "worker-b-crash-after-orphan-reissue" | "worker-b-crash-after-claim-result" | "worker-b-loop-preclaim" | "worker-b-loop-claim-recovery-cut" | "worker-b-loop-claim-item-completed-cut" | "worker-b-loop-usage-lineage-cut" | "worker-b-loop-usage-lineage-reject" | "worker-b-loop-final" | "worker-b-loop-multi-preclaim" | "worker-b-loop-multi-reject" | "worker-b-legacy-consumed-seed" | "worker-b-legacy-consumed-source-only" | "worker-b-legacy-consumed-recovery" | "worker-b-legacy-consumed-final" | "worker-b", queueName: string, ids: FixtureIds): WorkerProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode, queueName, JSON.stringify(ids)], {
    cwd: workerCwd,
    env: { ...process.env, DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      ...(mode === "worker-b-crash-resume" || mode === "worker-b-loop-claim-item-completed-cut"
        ? { AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID: ids.waiterTaskId } : {}) },
    stdio: ["ignore", "pipe", "pipe"],
  }) as WorkerProcess
  child.stdoutText = ""
  child.stderrText = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => { child.stdoutText += chunk })
  child.stderr?.on("data", (chunk: string) => { child.stderrText += chunk })
  child.exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })))
  child.closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })))
  return child
}

function workerStartGateKey(ids: FixtureIds): string {
  return `fixture:durable-child-wait:start:${ids.waiterTaskId}`
}

async function waitForMarker(child: WorkerProcess, marker: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.stdoutText.includes(marker)) return
    if (child.exitCode !== null || child.signalCode !== null) {
      const exit = await child.closed
      throw new Error(`Worker exited before ${marker} (code=${exit.code}, signal=${exit.signal}); stdout: ${child.stdoutText}; stderr: ${child.stderrText}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Timed out waiting for ${marker}; stdout: ${child.stdoutText}; stderr: ${child.stderrText}`)
}

function workerResultStatus(child: WorkerProcess, marker: "WORKER_A_WAITING"): WorkerResultStatus | null {
  const prefix = `${marker} `
  const line = child.stdoutText.split(/\r?\n/).find(value => value.startsWith(prefix))
  if (!line) return null
  try {
    const envelope = asObject(JSON.parse(line.slice(prefix.length)) as unknown)
    const status = asObject(envelope.result).status
    return typeof status === "string" && WORKER_RESULT_STATUSES.includes(status as WorkerResultStatus)
      ? status as WorkerResultStatus : null
  } catch { return null }
}

function workerFailureReasonCategory(child: WorkerProcess, marker: "WORKER_A_WAITING"): WorkerFailureReasonCategory | null {
  const prefix = `${marker} `
  const line = child.stdoutText.split(/\r?\n/).find(value => value.startsWith(prefix))
  if (!line) return null
  try {
    const envelope = asObject(JSON.parse(line.slice(prefix.length)) as unknown)
    const result = asObject(envelope.result)
    const category = result.failureReasonCategory
    return typeof category === "string" && WORKER_FAILURE_REASON_CATEGORIES.includes(category as WorkerFailureReasonCategory)
      ? category as WorkerFailureReasonCategory : null
  } catch { return null }
}

function workerFailureDiagnostic(child: WorkerProcess): string {
  const status = workerResultStatus(child, "WORKER_A_WAITING")
  return JSON.stringify({ status, failureReasonCategory: status === "failed"
    ? workerFailureReasonCategory(child, "WORKER_A_WAITING") : null })
}

function diagnosticTaskStatus(value: unknown): string | null {
  if (typeof value !== "string") return null
  return DIAGNOSTIC_TASK_STATUSES.has(value) ? value : "other"
}

function boundedRecoveryTrace(child: WorkerProcess): Record<string, unknown> | null {
  const prefix = "WORKER_B_RECOVERY_PREDICATE_TRACE "
  const line = [...child.stdoutText.split(/\r?\n/), ...child.stderrText.split(/\r?\n/)]
    .find(candidate => candidate.startsWith(prefix))
  if (!line) return null
  let parsed: unknown
  try { parsed = JSON.parse(line.slice(prefix.length)) as unknown }
  catch { return { traceParseFailed: true } }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { traceParseFailed: true }
  const trace = parsed as Record<string, unknown>
  const safeInteger = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : null
  const dispatch = trace.dispatch && typeof trace.dispatch === "object" && !Array.isArray(trace.dispatch)
    ? trace.dispatch as Record<string, unknown> : null
  const flags = dispatch ? Object.fromEntries(["present", "payloadValid", "task", "session", "root", "owner", "generation", "published"]
    .filter(key => typeof dispatch[key] === "boolean").map(key => [key, dispatch[key]])) : null
  return {
    pageCount: safeInteger(trace.pageCount),
    pages: Array.isArray(trace.pages) ? trace.pages.slice(0, 16).map(value => {
      const page = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
      return { page: safeInteger(page.page),
        candidates: safeInteger(page.candidates),
        targetSeen: typeof page.targetSeen === "boolean" ? page.targetSeen : null,
        cursorUsed: typeof page.cursorUsed === "boolean" ? page.cursorUsed : null }
    }) : null,
    pagesTruncated: typeof trace.pagesTruncated === "boolean" ? trace.pagesTruncated : null,
    rejectionStage: typeof trace.rejectionStage === "string" ? trace.rejectionStage.slice(0, 64) : null,
    waitProjectionDisposition: typeof trace.waitProjectionDisposition === "string" ? trace.waitProjectionDisposition.slice(0, 32) : null,
    waitProjectionStage: typeof trace.waitProjectionStage === "string" ? trace.waitProjectionStage.slice(0, 64) : null,
    childWaitResumable: typeof trace.childWaitResumable === "boolean" ? trace.childWaitResumable : null,
    waitRegistrationFound: typeof trace.waitRegistrationFound === "boolean" ? trace.waitRegistrationFound : null,
    waitRegistrationRejected: typeof trace.waitRegistrationRejected === "boolean" ? trace.waitRegistrationRejected : null,
    blockingExternalCall: typeof trace.blockingExternalCall === "boolean" ? trace.blockingExternalCall : null,
    dispatch: flags,
  }
}

async function diagnoseWorkerFBlocker(
  pool: Pool, ids: FixtureIds, continuationStepId: string, sourceCallId: string, claimCallId: string,
): Promise<Record<string, unknown>> {
  let client: PoolClient | undefined
  let transactionStarted = false
  try {
    client = await pool.connect()
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    transactionStarted = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
    const taskResult = await client.query<{ status: string; attemptCount: number; leaseOwner: string | null;
      leaseExpiresAt: Date | null; userId: string }>(
      `SELECT task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", session."userId"
       FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId],
    )
    const row = taskResult.rows[0]
    if (!row || !row.leaseOwner || !(row.leaseExpiresAt instanceof Date)) {
      return { snapshot: "post_recovery_attempt_read_committed", taskRowCount: taskResult.rows.length,
        taskStatus: row ? diagnosticTaskStatus(row.status) : null, predicateProbe: "unavailable" }
    }
    const task: BlockingTaskSnapshot = { id: ids.waiterTaskId, userId: row.userId, sessionId: ids.sessionId,
      turnId: ids.turnId, rootTaskId: ids.rootTaskId, leaseOwner: row.leaseOwner,
      attemptCount: row.attemptCount, leaseExpiresAt: row.leaseExpiresAt }
    const blocker = await hasBlockingExternalCall(client, task as unknown as Record<string, unknown>, undefined, continuationStepId)
    const starts = await client.query<{ id: string; type: string; correlationId: string }>(
      `SELECT "id", "type", "correlationId" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
         AND "type" IN ('tool_call.started', 'model.started')
         AND ("correlationId" = $4 OR "correlationId" = $5 OR "correlationId" = $6)
       ORDER BY "sequence" DESC LIMIT 16`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceCallId, claimCallId, continuationStepId],
    )
    const classified = []
    for (const start of starts.rows) {
      const blockedWhenOmitted = await hasBlockingExternalCall(client,
        task as unknown as Record<string, unknown>, start.id, continuationStepId)
      const lane = start.correlationId === sourceCallId ? "source_wait"
        : start.correlationId === claimCallId ? "continuation_claim"
          : start.correlationId === continuationStepId ? "continuation_model" : "other"
      classified.push({ lane, kind: start.type === "tool_call.started" ? "tool_call" : "model_call",
        blockedWhenOmitted })
    }
    return { snapshot: "post_recovery_attempt_read_committed", taskRowCount: taskResult.rows.length,
      taskStatus: diagnosticTaskStatus(row.status), attemptCount: row.attemptCount,
      leaseOwnerPresent: true, leaseExpired: row.leaseExpiresAt.getTime() <= Date.now(),
      blocker, examinedStartCount: starts.rows.length, starts: classified }
  } catch {
    return { snapshot: "post_recovery_attempt_read_committed", predicateProbe: "unavailable" }
  } finally {
    if (client) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
}

function parseRecoveryMarker(child: WorkerProcess): { reclaimed?: number; terminal?: number; rows?: Array<{ id?: unknown; status?: unknown }> } {
  const prefix = "WORKER_B_RECOVERED "
  const line = child.stdoutText.split(/\r?\n/).find(candidate => candidate.startsWith(prefix))
  if (!line) return {}
  try {
    const marker = JSON.parse(line.slice(prefix.length)) as { reclaimed?: unknown; terminal?: unknown; rows?: unknown }
    if (!Array.isArray(marker.rows)) return {}
    const rows = marker.rows.slice(0, 50).map(value => {
      const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
      return { id: typeof row.id === "string" ? row.id.slice(0, 256) : undefined,
        status: typeof row.status === "string" ? row.status.slice(0, 32) : undefined }
    })
    return { reclaimed: typeof marker.reclaimed === "number" && Number.isSafeInteger(marker.reclaimed) ? marker.reclaimed : undefined,
      terminal: typeof marker.terminal === "number" && Number.isSafeInteger(marker.terminal) ? marker.terminal : undefined, rows }
  } catch { return {} }
}

function expectRestoredWaitObservation(child: WorkerProcess, state: RestoredWaitObservationSummary["state"]): void {
  const lines = child.stdoutText.split(/\r?\n/).filter(line => line.startsWith(RESTORED_WAIT_OBSERVATION_MARKER))
  expect(lines).toHaveLength(1)
  const summary = JSON.parse(lines[0]!.slice(RESTORED_WAIT_OBSERVATION_MARKER.length)) as RestoredWaitObservationSummary
  expect(summary).toEqual({ state, canonicalCallIdPreserved: true, modelContextSafe: true, modelToolPairBound: true,
    deterministicProjection: true, providerInvoked: false,
    inputTaskIds: [FIXED_WAIT_TARGET_TASK_ID], outputTaskIds: [FIXED_WAIT_TARGET_TASK_ID],
    matchedTaskIds: [FIXED_WAIT_TARGET_TASK_ID], outputTaskIdsFromTasks: [FIXED_WAIT_TARGET_TASK_ID],
    targetFinalText: REDACTED_TARGET_RESULT_TEXT })
}

async function waitFor<T>(read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error("Timed out waiting for durable child-wait state")
}

async function readWaitClaimState(pool: Pool, ids: FixtureIds, stepId: string, callId: string, attempt: number) {
  const callResult = await pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown>; stepId: string }>(
    `SELECT "id", "status", "revision", "content", "stepId" FROM "agent_items"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_call'
       AND "content"->>'toolName' = 'wait_subagents' AND "content"->>'toolCallId' = $5`,
    [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId, callId],
  )
  const call = callResult.rows[0]
  if (!call) return { call: undefined, callCount: callResult.rows.length, claim: undefined, claimCount: 0,
    itemStarted: undefined, itemStartedCount: 0, result: undefined, resultCount: 0, lifecycle: [], claimOutboxCount: 0 }
  const claimKey = `task:${ids.waiterTaskId}:event:child-wait-claim:${attempt}:${stepId}`
  const [claimResult, itemStartedResult, resultResult] = await Promise.all([
    pool.query<{ id: string; type: string; itemId: string | null; actor: string; correlationId: string; causationId: string | null; idempotencyKey: string; payload: Record<string, unknown> }>(
      `SELECT "id", "type", "itemId", "actor", "correlationId", "causationId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, claimKey],
    ),
    pool.query<{ id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null; idempotencyKey: string }>(
      `SELECT "id", "type", "itemId", "correlationId", "causationId", "idempotencyKey" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "itemId" = $4 AND "type" = 'item.started'`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, call.id],
    ),
    pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
      `SELECT "id", "status", "revision", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
       AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $5`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId, callId],
    ),
  ])
  const claim = claimResult.rows[0], itemStarted = itemStartedResult.rows[0], result = resultResult.rows[0]
  const lifecycleResult = await pool.query<{ id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null; idempotencyKey: string }>(
    `SELECT "id", "type", "itemId", "correlationId", "causationId", "idempotencyKey" FROM "agent_events"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND ("itemId" = $4 OR "itemId" = $5)
     ORDER BY "sequence"`,
    [ids.sessionId, ids.turnId, ids.waiterTaskId, call.id, result?.id ?? ""],
  )
  const claimOutbox = claim ? await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS "count" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events' AND "idempotencyKey" = $2`,
    [ids.sessionId, `agent-event:${claim.id}`],
  ) : { rows: [{ count: 0 }] }
  return { call, callCount: callResult.rows.length, claim, claimCount: claimResult.rows.length,
    itemStarted, itemStartedCount: itemStartedResult.rows.length, result, resultCount: resultResult.rows.length,
    lifecycle: lifecycleResult.rows, claimOutboxCount: claimOutbox.rows[0]?.count ?? 0 }
}

async function readSourceWaitLifecycle(pool: Pool, ids: FixtureIds) {
  const stepId = `task:${ids.waiterTaskId}:step:0:attempt:1`
  const callId = PHONE_SHAPED_WAIT_TOOL_CALL_ID
  const [waitResult, callResult, sessionResult] = await Promise.all([
    pool.query<{ id: string; status: string; consumedAt: Date | null; idempotencyKey: string; result: Record<string, unknown> }>(
      `SELECT "id", "status", "consumedAt", "idempotencyKey", "result" FROM "agent_wait_conditions"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "stepId" = $4`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId]),
    pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
      `SELECT "id", "status", "revision", "content" FROM "agent_items"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_call'
         AND "content"->>'toolCallId' = $5`, [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId, callId]),
    pool.query<{ eventSequence: string }>(`SELECT "eventSequence"::text AS "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]),
  ])
  const wait = waitResult.rows[0], call = callResult.rows[0]
  if (!wait || !call) return { wait, call, eventSequence: sessionResult.rows[0]?.eventSequence ?? null, results: [], events: [], outboxes: [] }
  const resultItems = await pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
    `SELECT "id", "status", "revision", "content" FROM "agent_items"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_result'
       AND "content"->>'toolCallId' = $5 ORDER BY "id"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId, callId])
  const events = await pool.query<{ id: string; sequence: string; type: string; itemId: string | null; correlationId: string; causationId: string | null;
    idempotencyKey: string; payload: Record<string, unknown> }>(
    `SELECT "id", "sequence", "type", "itemId", "correlationId", "causationId", "idempotencyKey", "payload"
     FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
       AND ("itemId" = $4 OR "correlationId" = $5 OR "itemId" = ANY($6::text[]) OR "correlationId" = ANY($6::text[]))
     ORDER BY "sequence"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, call.id, callId,
      resultItems.rows.map(item => item.id)])
  const eventKeys = events.rows.map(event => `agent-event:${event.id}`)
  const outboxes = eventKeys.length === 0 ? [] : (await pool.query<{ id: string; idempotencyKey: string; payload: Record<string, unknown> }>(
    `SELECT "id", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events'
       AND "idempotencyKey" = ANY($2::text[]) ORDER BY "idempotencyKey"`, [ids.sessionId, eventKeys])).rows
  return { wait, call, eventSequence: sessionResult.rows[0]?.eventSequence ?? null, results: resultItems.rows, events: events.rows, outboxes }
}

function expectReconciledSourceWait(snapshot: Awaited<ReturnType<typeof readSourceWaitLifecycle>>, ids: FixtureIds, ownerId?: string | null): void {
  expect(snapshot.wait).toMatchObject({ status: "ready", consumedAt: expect.any(Date),
    idempotencyKey: SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId) })
  expect(snapshot.wait?.result).toHaveProperty("sourceLifecycleRecovery.schemaVersion", "child-wait-source-lifecycle.v1")
  expect(asObject(snapshot.wait?.result.sourceLifecycleRecovery)).toMatchObject({
    schemaVersion: "child-wait-source-lifecycle.v1", userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
    rootTaskId: ids.rootTaskId, taskId: ids.waiterTaskId, ownerId: ownerId ?? expect.any(String), attempt: 1,
    stepId: `task:${ids.waiterTaskId}:step:0:attempt:1`, waitId: snapshot.wait?.id,
    toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, callItemId: snapshot.call?.id, resultItemId: snapshot.results[0]?.id,
  })
  expect(snapshot.call).toMatchObject({ status: "completed", revision: 1, content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
    status: "completed", input: { idempotencyKey: SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId), taskIds: [FIXED_WAIT_TARGET_TASK_ID] } } })
  expect(snapshot.results).toHaveLength(1)
  expect(snapshot.results[0]).toMatchObject({ status: "completed", revision: 1,
    content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, errorCode: null,
      output: { waitId: snapshot.wait?.id, status: "ready", taskIds: [FIXED_WAIT_TARGET_TASK_ID], matchedTaskIds: [FIXED_WAIT_TARGET_TASK_ID] } } })
  expect(snapshot.events.map(event => event.type)).toEqual([
    "item.started", "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed",
  ])
  expect(snapshot.events).toHaveLength(6)
  expect(snapshot.outboxes).toHaveLength(6)
  expect(new Set(snapshot.outboxes.map(row => row.idempotencyKey)).size).toBe(6)
  const completion = asObject(snapshot.events[2]?.payload.content)
  const completionInput = asObject(completion.input)
  expect(completionInput.idempotencyKey).toBe("[REDACTED]")
  expect(completionInput.taskIds).toEqual(["[REDACTED]"])
  const resultCompletion = asObject(snapshot.events[5]?.payload.content)
  const eventResultOutput = asObject(resultCompletion.output)
  const resultTasks = Array.isArray(eventResultOutput.tasks) ? eventResultOutput.tasks.map(asObject) : []
  expect(eventResultOutput.taskIds).toEqual([FIXED_WAIT_TARGET_TASK_ID])
  expect(resultTasks.map(task => task.taskId)).toEqual([FIXED_WAIT_TARGET_TASK_ID])
  for (const event of snapshot.events) {
    const matches = snapshot.outboxes.filter(row => row.payload.eventId === event.id)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.payload).toMatchObject({ eventId: event.id, taskId: ids.waiterTaskId, payload: event.payload })
  }
  const eventAndOutboxJson = JSON.stringify({ events: snapshot.events.map(event => event.payload), outboxes: snapshot.outboxes.map(row => row.payload) })
  expect(eventAndOutboxJson).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
  expect(eventAndOutboxJson).not.toContain("sourceLifecycleRecovery")
  expect(eventAndOutboxJson).toContain(FIXED_WAIT_TARGET_TASK_ID)
  const resultOutput = asObject(asObject(snapshot.results[0]?.content).output)
  expect(resultOutput).not.toHaveProperty("sourceLifecycleRecovery")
  expect(JSON.stringify(resultOutput)).not.toContain(TARGET_RESULT_TEXT)
  expect(JSON.stringify(resultOutput)).toContain(REDACTED_TARGET_RESULT_TEXT)
}

type BlockingTaskSnapshot = {
  id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string;
  leaseOwner: string | null; attemptCount: number; leaseExpiresAt: Date | null
}
type BlockingTaskRow = Omit<BlockingTaskSnapshot, "userId">

async function expectAbsentSourceResultClaimSafety(pool: Pool, ids: FixtureIds, continuationStepId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
    // Match recovery/heartbeat lock order so the lease snapshot cannot go stale
    // between reading the waiter and evaluating the claim predicate.
    const sessionResult = await client.query<{ id: string; userId: string }>(
      `SELECT "id", "userId" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
      [ids.sessionId, ids.userId],
    )
    expect(sessionResult.rows).toHaveLength(1)
    const session = sessionResult.rows[0]
    if (!session) throw new Error("fixture_absent_source_session_missing")
    const taskResult = await client.query<BlockingTaskRow>(
      `SELECT "id", "sessionId", "turnId", "rootTaskId", "leaseOwner", "attemptCount", "leaseExpiresAt"
       FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId],
    )
    expect(taskResult.rows).toHaveLength(1)
    const taskRow = taskResult.rows[0]
    const task: BlockingTaskSnapshot | undefined = taskRow ? { ...taskRow, userId: session.userId } : undefined
    expect(task).toBeDefined()
    if (!task || !task.leaseOwner || !task.leaseExpiresAt) throw new Error("fixture_absent_source_live_task_missing")

    const sourceStepId = `task:${ids.waiterTaskId}:step:0:attempt:1`
    const sourceCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
    const sourceResultItemId = `task:${ids.waiterTaskId}:item:tool-result:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
    const [sourceCallResult, sourceEventsResult, sourceResultItems, sourceResultEvents, sourceUsageResult] = await Promise.all([
      client.query<{ status: string; revision: number; content: Record<string, unknown> }>(
        `SELECT "status", "revision", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
         AND "taskId" = $3 AND "stepId" = $4 AND "id" = $5 AND "type" = 'tool_call'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, sourceCallItemId],
      ),
      client.query<{ id: string; sequence: string; type: string; actor: string; itemId: string | null; correlationId: string;
        causationId: string | null; idempotencyKey: string; payload: Record<string, unknown> }>(
        `SELECT "id", "sequence"::text AS "sequence", "type", "actor", "itemId", "correlationId", "causationId", "idempotencyKey", "payload"
         FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND ("itemId" = $4 OR "correlationId" = $5) ORDER BY "sequence"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceCallItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID],
      ),
      client.query<{ id: string }>(
        `SELECT "id" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "stepId" = $4 AND "type" = 'tool_result'
          AND ("id" = $5 OR "content"->>'toolCallId' = $6) ORDER BY "id"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, sourceResultItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID],
      ),
      client.query<{ id: string }>(
        `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND ("itemId" = $4 OR "correlationId" = $4 OR ("correlationId" = $5
            AND "type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))) ORDER BY "sequence"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceResultItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID],
      ),
      client.query<{ id: string; sequence: string; type: string; actor: string; correlationId: string; idempotencyKey: string }>(
        `SELECT "id", "sequence"::text AS "sequence", "type", "actor", "correlationId", "idempotencyKey"
         FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND "type" = 'model.usage' AND "correlationId" = $4 AND "idempotencyKey" = $5`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, `task:${ids.waiterTaskId}:event:model-usage:${sourceStepId}`],
      ),
    ])
    const sourceCall = sourceCallResult.rows[0]
    const sourceUsage = sourceUsageResult.rows[0]
    const itemStarted = sourceEventsResult.rows.find(event => event.type === "item.started" && event.itemId === sourceCallItemId)
    const callStarted = sourceEventsResult.rows.find(event => event.type === "tool_call.started" && event.itemId === sourceCallItemId)
    expect(sourceCallResult.rows).toHaveLength(1)
    expect(sourceCall).toMatchObject({ status: "started", revision: 0,
      content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", toolVersion: "1",
        input: { taskIds: [FIXED_WAIT_TARGET_TASK_ID], mode: "any", timeoutMs: 30_000,
          idempotencyKey: SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId) } } })
    expect(sourceEventsResult.rows).toHaveLength(2)
    expect(sourceEventsResult.rows.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
    expect(sourceUsageResult.rows).toHaveLength(1)
    expect(sourceUsage).toMatchObject({ type: "model.usage", actor: "subagent", correlationId: sourceStepId,
      idempotencyKey: `task:${ids.waiterTaskId}:event:model-usage:${sourceStepId}` })
    expect(itemStarted).toMatchObject({ actor: "subagent", itemId: sourceCallItemId, correlationId: sourceStepId,
      causationId: sourceUsage?.id, idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${sourceCallItemId}`,
      payload: { itemId: sourceCallItemId, type: "tool_call", phase: null } })
    expect(BigInt(sourceUsage!.sequence)).toBeLessThan(BigInt(itemStarted!.sequence))
    expect(callStarted).toMatchObject({ actor: "subagent", itemId: sourceCallItemId,
      correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, causationId: itemStarted?.id,
      idempotencyKey: `task:${ids.waiterTaskId}:event:tool-started:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}`,
      payload: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", taskId: ids.waiterTaskId } })
    expect(sourceResultItems.rows).toHaveLength(0)
    expect(sourceResultEvents.rows).toHaveLength(0)

    const blocking = (snapshot: BlockingTaskSnapshot) => hasBlockingExternalCall(
      client, snapshot as unknown as Record<string, unknown>, undefined, continuationStepId,
    )
    const waitRows = await client.query<{ id: string }>(
      `SELECT "id" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "stepId" = $4`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId, sourceStepId],
    )
    const continuationCalls = await client.query<{ id: string }>(
      `SELECT "id" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
        AND "type" = 'tool_call' AND "content"->>'toolName' = 'wait_subagents' ORDER BY "id" LIMIT 2`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId],
    )
    expect(waitRows.rows).toHaveLength(1)
    expect(continuationCalls.rows).toHaveLength(1)
    const claimItemResult = await client.query<{ id: string; content: Record<string, unknown> }>(
      `SELECT "id", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "stepId" = $5 AND "type" = 'tool_call'`,
      [continuationCalls.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId],
    )
    expect(claimItemResult.rows).toHaveLength(1)
    const claimItem = claimItemResult.rows[0]
    const claimCallId = claimItem?.content.toolCallId
    if (!claimItem || typeof claimCallId !== "string" || !claimCallId) throw new Error("fixture_claim_call_identity_missing")
    const claimEventsResult = await client.query<{ id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null }>(
      `SELECT "id", "type", "itemId", "correlationId", "causationId" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
       AND "taskId" = $3 AND ("itemId" = $4 OR "correlationId" = $5) ORDER BY "sequence"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, claimItem.id, claimCallId],
    )
    expect(claimEventsResult.rows.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
    const claimItemStarted = claimEventsResult.rows[0]!
    const claimStarted = claimEventsResult.rows[1]!
    const phoneWaitKey = `child-wait:415-555-0134:${ids.waiterTaskId}:attempt:1`
    const projectedPhoneWaitKey = safeProjectedWaitKey({ taskIds: [FIXED_WAIT_TARGET_TASK_ID], mode: "any", timeoutMs: 30_000,
      idempotencyKey: phoneWaitKey })
    expect(projectedPhoneWaitKey.includes("[REDACTED_PHONE]")).toBe(true)
    await client.query("SAVEPOINT fixed_phone_wait_key_projection")
    try {
      const changedWait = await client.query(`UPDATE "agent_wait_conditions" SET "idempotencyKey" = $2
        WHERE "id" = $1 AND "parentTaskId" = $3 AND "sessionId" = $4 AND "turnId" = $5`,
      [waitRows.rows[0]!.id, phoneWaitKey, ids.waiterTaskId, ids.sessionId, ids.turnId])
      const changedSource = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,idempotencyKey}', to_jsonb($5::text), true)
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
      [sourceCallItemId, ids.sessionId, ids.turnId, ids.waiterTaskId, phoneWaitKey])
      const changedContinuation = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,idempotencyKey}', to_jsonb($5::text), true)
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
      [continuationCalls.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, projectedPhoneWaitKey])
      expect([changedWait.rowCount, changedSource.rowCount, changedContinuation.rowCount]).toEqual([1, 1, 1])
      const rawSourceIdentity = await client.query<{ matches: boolean }>(
        `SELECT sourceCall."content"->'input'->>'idempotencyKey' = wait."idempotencyKey" AS "matches"
          FROM "agent_items" AS sourceCall JOIN "agent_wait_conditions" AS wait ON wait."stepId" = sourceCall."stepId"
            AND wait."parentTaskId" = sourceCall."taskId" AND wait."sessionId" = sourceCall."sessionId" AND wait."turnId" = sourceCall."turnId"
          WHERE sourceCall."id" = $1 AND wait."id" = $2 AND sourceCall."sessionId" = $3 AND sourceCall."turnId" = $4 AND sourceCall."taskId" = $5`,
        [sourceCallItemId, waitRows.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId],
      )
      expect(rawSourceIdentity.rows).toEqual([{ matches: true }])
      expect(await blocking(task), "phone-shaped source key and its safe continuation projection should be accepted by PostgreSQL recovery").toBe(false)
      const changedWrongKey = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,idempotencyKey}', to_jsonb($2::text), true)
        WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5`,
      [continuationCalls.rows[0]!.id, `${projectedPhoneWaitKey}:wrong`, ids.sessionId, ids.turnId, ids.waiterTaskId])
      expect(changedWrongKey.rowCount).toBe(1)
      expect(await blocking(task), "a mismatched continuation projection must remain blocked").toBe(true)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT fixed_phone_wait_key_projection").catch(() => undefined)
      await client.query("RELEASE SAVEPOINT fixed_phone_wait_key_projection").catch(() => undefined)
    }
    expect(await blocking(task), "valid continuation claim with started/rev0 source and no source result should be recoverable").toBe(false)

    let savepoint = 0
    const remainsBlocked = async (
      label: string, mutate: () => Promise<void>, snapshot: BlockingTaskSnapshot = task,
    ): Promise<void> => {
      const name = `absent_source_case_${savepoint++}`
      await client.query(`SAVEPOINT ${name}`)
      try {
        await mutate()
        expect(await blocking(snapshot), label).toBe(true)
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
        await client.query(`RELEASE SAVEPOINT ${name}`)
      }
    }
    const insertClaimEvent = async (input: { type: string; itemId: string | null; correlationId: string; causationId: string | null;
      idempotencyKey: string; payload: Record<string, unknown> }): Promise<void> => {
      const sequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"::text AS "eventSequence"`,
        [ids.sessionId],
      )
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'subagent', $8, $9, $10, $11::jsonb)`, [
        `fixture-claim-extra-${randomUUID()}`, ids.sessionId, ids.turnId, input.itemId, ids.waiterTaskId, sequence.rows[0]!.eventSequence,
        input.type, input.correlationId, input.causationId, input.idempotencyKey, JSON.stringify(input.payload),
      ])
    }
    await remainsBlocked("stale lease owner", async () => {}, { ...task, leaseOwner: `${task.leaseOwner}:stale` })
    await remainsBlocked("stale attempt", async () => {}, { ...task, attemptCount: task.attemptCount + 1 })
    await remainsBlocked("stale lease expiry", async () => {}, { ...task, leaseExpiresAt: new Date(task.leaseExpiresAt.getTime() + 1_000) })
    await remainsBlocked("malformed terminal with provider call ID but wrong item, causation, and payload", () => insertClaimEvent({
      type: "tool_call.completed", itemId: null, correlationId: claimCallId, causationId: null,
      idempotencyKey: `fixture-claim-malformed-terminal:${randomUUID()}`,
      payload: { toolCallId: claimCallId, toolName: "jobs.search", status: "completed", errorCode: null, taskId: ids.waiterTaskId },
    }))
    await remainsBlocked("item.failed event associated by the claim item correlation", () => insertClaimEvent({
      type: "item.failed", itemId: null, correlationId: claimItem.id, causationId: null,
      idempotencyKey: `fixture-claim-item-failed:${randomUUID()}`, payload: { itemId: claimItem.id, errorCode: "fixture" },
    }))
    await remainsBlocked("extra event causally attached to item.started", () => insertClaimEvent({
      type: "item.delta", itemId: null, correlationId: `fixture-correlation-${randomUUID()}`, causationId: claimItemStarted.id,
      idempotencyKey: `fixture-claim-item-start-cause:${randomUUID()}`, payload: { text: "fixture" },
    }))
    await remainsBlocked("extra event causally attached to tool_call.started", () => insertClaimEvent({
      type: "item.delta", itemId: null, correlationId: `fixture-correlation-${randomUUID()}`, causationId: claimStarted.id,
      idempotencyKey: `fixture-claim-call-start-cause:${randomUUID()}`, payload: { text: "fixture" },
    }))
    await remainsBlocked("completion idempotency key without its lifecycle event", () => insertClaimEvent({
      type: "item.delta", itemId: null, correlationId: `fixture-correlation-${randomUUID()}`, causationId: null,
      idempotencyKey: `task:${ids.waiterTaskId}:event:tool-call-completed:${claimCallId}:${claimItem.id}:1`, payload: { text: "fixture" },
    }))
    await remainsBlocked("source call start with wrong item.started causation", async () => {
      if (!callStarted) throw new Error("fixture_source_call_start_event_missing")
      await client.query(`UPDATE "agent_events" SET "causationId" = $2 WHERE "id" = $1`, [callStarted.id, "wrong-source-item-start"])
    })
    await remainsBlocked("terminal event on source call", async () => {
      if (!callStarted) throw new Error("fixture_source_call_start_event_missing")
      const sequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`,
        [ids.sessionId],
      )
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'tool_call.completed', 'subagent', $7, $8, $9, $10::jsonb)`, [
        `fixture-source-terminal-${randomUUID()}`, ids.sessionId, ids.turnId, sourceCallItemId, ids.waiterTaskId,
        sequence.rows[0]!.eventSequence, PHONE_SHAPED_WAIT_TOOL_CALL_ID, callStarted.id,
        `fixture-source-terminal:${randomUUID()}`,
        JSON.stringify({ toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: ids.waiterTaskId }),
      ])
    })
    await remainsBlocked("second source wait call", async () => {
      const originalContent = sourceCall!.content
      const duplicateCallId = `fixture-duplicate-wait:${randomUUID()}`
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        `task:${ids.waiterTaskId}:item:tool-call:${duplicateCallId}:attempt:1`, ids.sessionId, ids.turnId, sourceStepId, ids.waiterTaskId,
        JSON.stringify({ ...originalContent, toolCallId: duplicateCallId }),
      ])
    })
    await remainsBlocked("competing tool call in the claimed continuation step", async () => {
      const duplicateCallId = `fixture-competing-claim:${randomUUID()}`
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        `task:${ids.waiterTaskId}:item:tool-call:${duplicateCallId}:attempt:${task.attemptCount}`, ids.sessionId, ids.turnId,
        continuationStepId, ids.waiterTaskId, JSON.stringify({ toolCallId: duplicateCallId, toolName: "jobs.search", toolVersion: "1", input: {} }),
      ])
    })
    const expectedResultItemId = `task:${ids.waiterTaskId}:item:tool-result:${claimCallId}:attempt:${task.attemptCount}`
    await remainsBlocked("deterministic result item ID is blocking even with a changed toolCallId", async () => {
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "startedAt", "completedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        expectedResultItemId, ids.sessionId, ids.turnId, continuationStepId, ids.waiterTaskId,
        JSON.stringify({ toolCallId: `tampered-${claimCallId}`, output: null, errorCode: null }),
      ])
    })
    await remainsBlocked("tool result row matching the provider call ID", async () => {
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "startedAt", "completedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        `fixture-result-row-${randomUUID()}`, ids.sessionId, ids.turnId, continuationStepId, ids.waiterTaskId,
        JSON.stringify({ toolCallId: claimCallId, output: null, errorCode: null }),
      ])
    })
    await remainsBlocked("result item-start idempotency key blocks a misidentified event", () => insertClaimEvent({
      type: "item.started", itemId: null, correlationId: `fixture-result-correlation-${randomUUID()}`, causationId: null,
      idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${expectedResultItemId}`,
      payload: { itemId: expectedResultItemId, type: "tool_result", phase: null },
    }))
    await remainsBlocked("result item-completion idempotency key blocks a misidentified event", () => insertClaimEvent({
      type: "item.completed", itemId: null, correlationId: `fixture-result-correlation-${randomUUID()}`, causationId: null,
      idempotencyKey: `task:${ids.waiterTaskId}:event:tool-result-completed:${claimCallId}:${expectedResultItemId}:1`,
      payload: { itemId: expectedResultItemId, status: "completed", content: { toolCallId: claimCallId } },
    }))
    await remainsBlocked("duplicate result items for source call", async () => {
      const duplicateA = `fixture-source-result-a-${randomUUID()}`
      const duplicateB = `fixture-source-result-b-${randomUUID()}`
      const content = JSON.stringify({ toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, output: null, errorCode: null })
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "startedAt", "completedAt", "updatedAt")
        VALUES ($1, $3, $4, $5, $6, 'tool_result', 'completed', 1, $7::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ($2, $3, $4, $5, $6, 'tool_result', 'completed', 1, $7::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        duplicateA, duplicateB, ids.sessionId, ids.turnId, sourceStepId, ids.waiterTaskId, content,
      ])
    })
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
}

async function expectCompletedClaimBeforeItemEventSafety(
  pool: Pool, ids: FixtureIds, continuationStepId: string, callId: string, attempt: number,
): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
    const session = await client.query<{ userId: string }>(
      `SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [ids.sessionId, ids.userId],
    )
    expect(session.rows).toHaveLength(1)
    const taskResult = await client.query<BlockingTaskRow>(
      `SELECT "id", "sessionId", "turnId", "rootTaskId", "leaseOwner", "attemptCount", "leaseExpiresAt"
       FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId],
    )
    expect(taskResult.rows).toHaveLength(1)
    const row = taskResult.rows[0]
    if (!row || !row.leaseOwner || !row.leaseExpiresAt) throw new Error("completed_claim_live_task_missing")
    const task: BlockingTaskSnapshot = { ...row, userId: session.rows[0]!.userId }
    const callItemId = `task:${ids.waiterTaskId}:item:tool-call:${callId}:attempt:${attempt}`
    const sourceCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
    const callResult = await client.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
      `SELECT "id", "status", "revision", "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2
       AND "taskId" = $3 AND "stepId" = $4 AND "id" = $5 AND "type" = 'tool_call'`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId, callItemId],
    )
    expect(callResult.rows).toHaveLength(1)
    expect(callResult.rows[0]).toMatchObject({ status: "completed", revision: 1,
      content: { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", status: "completed", errorCode: null } })
    const lifecycle = await client.query<{ id: string; type: string; itemId: string | null; correlationId: string; causationId: string | null }>(
      `SELECT "id", "type", "itemId", "correlationId", "causationId" FROM "agent_events" WHERE "sessionId" = $1
       AND "turnId" = $2 AND "taskId" = $3 AND ("itemId" = $4 OR "correlationId" = $5) ORDER BY "sequence"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, callItemId, callId],
    )
    expect(lifecycle.rows.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
    const itemStarted = lifecycle.rows[0]
    const callStarted = lifecycle.rows[1]
    const itemStartedAnchor = await client.query<{ id: string }>(
      `SELECT prior."id" FROM "agent_events" AS prior
       JOIN "agent_events" AS itemStart ON itemStart."id" = $4 AND itemStart."causationId" = prior."id"
       WHERE prior."sessionId" = $1 AND prior."turnId" = $2 AND prior."taskId" = $3
         AND prior."sequence" < itemStart."sequence"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, itemStarted?.id ?? ""],
    )
    expect(itemStartedAnchor.rows, "real item.started causation must resolve to a preceding same-owner event").toHaveLength(1)
    expect(callStarted).toMatchObject({ itemId: callItemId, correlationId: callId, causationId: itemStarted?.id })

    const blocking = (snapshot: BlockingTaskSnapshot) => hasBlockingExternalCall(
      client, snapshot as unknown as Record<string, unknown>, undefined, continuationStepId,
    )
    expect(await blocking(task), "exact completed/rev1 claim with its sole causal start and no item.completed should be recoverable").toBe(false)

    let savepoint = 0
    const remainsBlocked = async (label: string, mutate: () => Promise<void>, snapshot: BlockingTaskSnapshot = task): Promise<void> => {
      const name = `completed_claim_case_${savepoint++}`
      await client.query(`SAVEPOINT ${name}`)
      try {
        await mutate()
        expect(await blocking(snapshot), label).toBe(true)
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
        await client.query(`RELEASE SAVEPOINT ${name}`)
      }
    }
    await remainsBlocked("completed claim with non-null errorCode", async () => {
      await client.query(`UPDATE "agent_items" SET "content" = "content" || '{"errorCode":"invalid"}'::jsonb WHERE "id" = $1`, [callItemId])
    })
    await remainsBlocked("completed claim with wrong revision", async () => {
      await client.query(`UPDATE "agent_items" SET "revision" = 2 WHERE "id" = $1`, [callItemId])
    })
    await remainsBlocked("wrong causal item.started", async () => {
      if (!callStarted) throw new Error("completed_claim_start_event_missing")
      await client.query(`UPDATE "agent_events" SET "causationId" = $2 WHERE "id" = $1`, [callStarted.id, "wrong-item-start"])
    })
    await remainsBlocked("claim tool_call.started must follow its exact item.started event", async () => {
      if (!itemStarted) throw new Error("completed_claim_item_start_event_missing")
      const sequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"::text AS "eventSequence"`,
        [ids.sessionId],
      )
      await client.query(`UPDATE "agent_events" SET "sequence" = $2 WHERE "id" = $1 AND "sessionId" = $3`,
        [itemStarted.id, sequence.rows[0]!.eventSequence, ids.sessionId])
    })
    await remainsBlocked("completed claim item.completed must follow its tool_call.started event", async () => {
      if (!callStarted) throw new Error("completed_claim_start_event_missing")
      const completeSequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"::text AS "eventSequence"`,
        [ids.sessionId],
      )
      const eventId = `fixture-claim-item-completed-before-start-${randomUUID()}`
      const eventKey = `task:${ids.waiterTaskId}:event:tool-call-completed:${callId}:${callItemId}:1`
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'subagent', $4, $7, $8, $9::jsonb)`, [
        eventId, ids.sessionId, ids.turnId, callItemId, ids.waiterTaskId, completeSequence.rows[0]!.eventSequence, callStarted.id,
        eventKey, JSON.stringify({ itemId: callItemId, status: "completed", content: callResult.rows[0]!.content }),
      ])
      const startSequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"::text AS "eventSequence"`,
        [ids.sessionId],
      )
      await client.query(`UPDATE "agent_events" SET "sequence" = $2 WHERE "id" = $1 AND "sessionId" = $3`,
        [callStarted.id, startSequence.rows[0]!.eventSequence, ids.sessionId])
    })
    const insertValidAndMalformedCompletion = async (malformedItemId: string, malformedCorrelationId: string): Promise<void> => {
      const sequence = await client.query<{ firstSequence: string; eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 2 WHERE "id" = $1
         RETURNING ("eventSequence" - 1)::text AS "firstSequence", "eventSequence"::text AS "eventSequence"`, [ids.sessionId],
      )
      if (!callStarted) throw new Error("completed_claim_start_event_missing")
      const exactEventKey = `task:${ids.waiterTaskId}:event:tool-call-completed:${callId}:${callItemId}:1`
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'subagent', $7, $8, $9, $10::jsonb),
          ($11, $2, $3, $16, $5, $12, 'item.completed', 'subagent', $17, $13, $14, $15::jsonb)`, [
        `fixture-claim-item-completed-exact-${randomUUID()}`, ids.sessionId, ids.turnId, callItemId, ids.waiterTaskId,
        sequence.rows[0]!.firstSequence, callItemId, callStarted.id, exactEventKey,
        JSON.stringify({ itemId: callItemId, status: "completed", content: callResult.rows[0]!.content }),
        `fixture-claim-item-completed-malformed-${randomUUID()}`, sequence.rows[0]!.eventSequence, callStarted.id,
        `fixture-claim-item-completed-malformed:${randomUUID()}`,
        JSON.stringify({ itemId: callItemId, status: "failed", content: { errorCode: "wrong" } }),
        malformedItemId, malformedCorrelationId,
      ])
    }
    await remainsBlocked("valid completion plus malformed event correlated to the claim item", () =>
      insertValidAndMalformedCompletion(sourceCallItemId, callItemId))
    await remainsBlocked("valid completion plus malformed event correlated to the provider call", () =>
      insertValidAndMalformedCompletion(sourceCallItemId, callId))
    await remainsBlocked("unrelated terminal item event on the claimed call", async () => {
      const sequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [ids.sessionId],
      )
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'item.failed', 'subagent', $7, $8, $9, $10::jsonb)`, [
        `fixture-claim-item-failed-${randomUUID()}`, ids.sessionId, ids.turnId, callItemId, ids.waiterTaskId,
        sequence.rows[0]!.eventSequence, callItemId, callStarted?.id ?? null, `fixture-claim-item-failed:${randomUUID()}`,
        JSON.stringify({ itemId: callItemId, status: "failed", errorCode: "fixture" }),
      ])
    })
    await remainsBlocked("competing tool call in the continuation step", async () => {
      const competitorId = `fixture-competing-call:${randomUUID()}`
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        `task:${ids.waiterTaskId}:item:tool-call:${competitorId}:attempt:${attempt}`, ids.sessionId, ids.turnId, continuationStepId,
        ids.waiterTaskId, JSON.stringify({ toolCallId: competitorId, toolName: "wait_subagents", toolVersion: "1", input: {} }),
      ])
    })
    await remainsBlocked("tool result row on the continuation", async () => {
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "startedAt", "completedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
        `task:${ids.waiterTaskId}:item:tool-result:${callId}:attempt:${attempt}`, ids.sessionId, ids.turnId, continuationStepId,
        ids.waiterTaskId, JSON.stringify({ toolCallId: callId, output: null, errorCode: null }),
      ])
    })
    await remainsBlocked("result lifecycle event without its result row uses an unrelated existing itemId", async () => {
      const resultItemId = `task:${ids.waiterTaskId}:item:tool-result:${callId}:attempt:${attempt}`
      const unrelatedItem = await client.query<{ id: string; stepId: string; type: string }>(
        `SELECT "id", "stepId", "type" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2
         AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'tool_call' AND "stepId" <> $5`,
        [sourceCallItemId, ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId],
      )
      expect(unrelatedItem.rows).toHaveLength(1)
      expect(unrelatedItem.rows[0]).toMatchObject({ id: sourceCallItemId, type: "tool_call" })
      const sequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`, [ids.sessionId],
      )
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'subagent', $7, $8, $9, $10::jsonb)`, [
        `fixture-claim-result-event-${randomUUID()}`, ids.sessionId, ids.turnId, sourceCallItemId, ids.waiterTaskId,
        sequence.rows[0]!.eventSequence, resultItemId, callStarted?.id ?? null, `fixture-claim-result-event:${randomUUID()}`,
        JSON.stringify({ itemId: resultItemId, status: "completed", content: { toolCallId: callId } }),
      ])
    })
    const insertSettledLifecycle = async (
      status: "completed" | "failed",
      malformed?: "item_id" | "causation" | "payload" | "sequence",
    ): Promise<void> => {
      if (!callStarted) throw new Error("completed_claim_start_event_missing")
      if (status === "failed") await client.query(
        `UPDATE "agent_items" SET "content" = "content" || '{"status":"failed","errorCode":"fixture_failure"}'::jsonb WHERE "id" = $1`,
        [callItemId],
      )
      const savedCall = await client.query<{ content: Record<string, unknown> }>(
        `SELECT "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
        [callItemId, ids.sessionId, ids.turnId, ids.waiterTaskId],
      )
      const content = savedCall.rows[0]?.content
      if (!content) throw new Error("completed_claim_call_content_missing")
      const itemCompletedId = `fixture-claim-terminal-item-completed-${randomUUID()}`
      const terminalId = `fixture-claim-terminal-${randomUUID()}`
      const itemCompletedKey = `task:${ids.waiterTaskId}:event:tool-call-completed:${callId}:${callItemId}:1`
      const itemCompletedCausation = callStarted.id
      const terminalKey = `task:${ids.waiterTaskId}:event:tool-finished:${callId}`
      const terminalPayload = {
        toolCallId: callId, toolName: "wait_subagents",
        status, errorCode: status === "completed" ? null : "fixture_failure", taskId: ids.waiterTaskId,
      }
      const sequence = await client.query<{ firstSequence: string; eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 2 WHERE "id" = $1
         RETURNING ("eventSequence" - 1)::text AS "firstSequence", "eventSequence"::text AS "eventSequence"`, [ids.sessionId],
      )
      const terminalItemId = malformed === "item_id" ? sourceCallItemId : callItemId
      const terminalCausation = malformed === "causation" ? "wrong-terminal-cause" : itemCompletedId
      const payload = malformed === "payload" ? { ...terminalPayload, toolName: "jobs.search" } : terminalPayload
      const itemCompletedSequence = malformed === "sequence" ? sequence.rows[0]!.eventSequence : sequence.rows[0]!.firstSequence
      const terminalSequence = malformed === "sequence" ? sequence.rows[0]!.firstSequence : sequence.rows[0]!.eventSequence
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'item.completed', 'subagent', $7, $8, $9, $10::jsonb),
          ($11, $2, $3, $12, $5, $13, $14, 'subagent', $18, $15, $16, $17::jsonb)`, [
        itemCompletedId, ids.sessionId, ids.turnId, callItemId, ids.waiterTaskId, itemCompletedSequence,
        callItemId, itemCompletedCausation, itemCompletedKey, JSON.stringify({ itemId: callItemId, status: "completed", content }),
        terminalId, terminalItemId, terminalSequence, status === "completed" ? "tool_call.completed" : "tool_call.failed",
        terminalCausation, terminalKey, JSON.stringify(payload), callId,
      ])
    }
    const allowsSettlement = async (label: string, mutate: () => Promise<void>): Promise<void> => {
      const name = `claim_terminal_positive_${savepoint++}`
      await client.query(`SAVEPOINT ${name}`)
      try {
        await mutate()
        expect(await blocking(task), label).toBe(false)
      } finally {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
        await client.query(`RELEASE SAVEPOINT ${name}`)
      }
    }
    await allowsSettlement("exact child claim recovery lifecycle settles its start", () =>
      insertSettledLifecycle("completed"))
    await allowsSettlement("exact failed child claim lifecycle settles its start", () =>
      insertSettledLifecycle("failed"))
    await remainsBlocked("terminal with correct provider call ID but wrong item ID", () =>
      insertSettledLifecycle("completed", "item_id"))
    await remainsBlocked("terminal with correct provider call ID but wrong causation", () =>
      insertSettledLifecycle("completed", "causation"))
    await remainsBlocked("terminal with correct provider call ID but wrong payload", () =>
      insertSettledLifecycle("completed", "payload"))
    await remainsBlocked("terminal sequence before its item.completed cause", () =>
      insertSettledLifecycle("completed", "sequence"))
    await remainsBlocked("wait call item references a foreign-scope step", async () => {
      await insertSettledLifecycle("completed")
      const foreignStepId = `fixture-foreign-step:${randomUUID()}`
      await client.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
          "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 999, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`,
        [foreignStepId, ids.sessionId, ids.turnId, ids.rootTaskId],
      )
      await client.query(`UPDATE "agent_items" SET "stepId" = $2 WHERE "id" = $1`, [callItemId, foreignStepId])
    })
    await remainsBlocked("extra failed terminal with wrong item ID but call-item correlation", async () => {
      await insertSettledLifecycle("completed")
      const sequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 RETURNING "eventSequence"`,
        [ids.sessionId],
      )
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
          "correlationId", "causationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'tool_call.failed', 'subagent', $7, $8, $9, $10::jsonb)`, [
        `fixture-claim-item-correlation-terminal-${randomUUID()}`, ids.sessionId, ids.turnId, sourceCallItemId, ids.waiterTaskId,
        sequence.rows[0]!.eventSequence, callItemId, callStarted?.id ?? null,
        `fixture-claim-item-correlation-terminal:${randomUUID()}`,
        JSON.stringify({ toolCallId: callId, toolName: "wait_subagents", status: "failed", errorCode: "forged", taskId: ids.waiterTaskId }),
      ])
    })
    await remainsBlocked("stale lease owner", async () => {}, { ...task, leaseOwner: `${task.leaseOwner}:stale` })
  } finally {
    await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
}

async function expectCompletedSourceWaitLifecycle(pool: Pool, ids: FixtureIds): Promise<void> {
  const stepId = `task:${ids.waiterTaskId}:step:0:attempt:1`
  const callItemId = `task:${ids.waiterTaskId}:item:tool-call:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
  const resultItemId = `task:${ids.waiterTaskId}:item:tool-result:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
  const [items, events, waits] = await Promise.all([
    pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
      `SELECT "id", "status", "revision", "content" FROM "agent_items"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[]) ORDER BY "id"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, [callItemId, resultItemId]],
    ),
    pool.query<{ id: string; sequence: string; type: string; itemId: string; correlationId: string; causationId: string | null; payload: Record<string, unknown> }>(
      `SELECT "id", "sequence", "type", "itemId", "correlationId", "causationId", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "itemId" = ANY($4::text[]) ORDER BY "sequence"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, [callItemId, resultItemId]],
    ),
    pool.query<{ id: string; idempotencyKey: string; mode: string; targetTaskIds: unknown; deadlineAt: Date; result: unknown }>(
      `SELECT "id", "idempotencyKey", "mode", "targetTaskIds", "deadlineAt", "result" FROM "agent_wait_conditions"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "stepId" = $4`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId],
    ),
  ])
  const call = items.rows.find(item => item.id === callItemId)
  const result = items.rows.find(item => item.id === resultItemId)
  const sourceWait = waits.rows[0]
  const callContent = asObject(call?.content)
  const callInput = asObject(callContent.input)
  const waitRecord = asObject(sourceWait?.result)
  const request = asObject(waitRecord.request)
  const resultContent = asObject(result?.content)
  const receipt = asObject(resultContent.output)
  const modelUsage = await pool.query<{ id: string; sequence: string; type: string; actor: string; correlationId: string; idempotencyKey: string }>(
    `SELECT "id", "sequence", "type", "actor", "correlationId", "idempotencyKey" FROM "agent_events"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'model.usage' AND "correlationId" = $4
       AND "idempotencyKey" = $5`,
    [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId, `task:${ids.waiterTaskId}:event:model-usage:${stepId}`],
  )
  const receiptTaskIds = Array.isArray(receipt.tasks) ? receipt.tasks.map(task => asObject(task).taskId) : null
  const sameIds = (left: unknown, right: unknown): boolean => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.some(id => typeof id !== "string")
      || right.some(id => typeof id !== "string")) return false
    const leftIds = left as string[], rightIds = right as string[]
    const sortedLeft = [...leftIds].sort(), sortedRight = [...rightIds].sort()
    return leftIds.length === rightIds.length && new Set(leftIds).size === leftIds.length
      && new Set(rightIds).size === rightIds.length
      && sortedLeft.every((id, index) => id === sortedRight[index])
  }
  const timestamp = (value: unknown): number | undefined => {
    const parsed = value instanceof Date ? value : new Date(String(value))
    return Number.isFinite(parsed.getTime()) ? parsed.getTime() : undefined
  }
  expect({
    waitCount: waits.rows.length,
    callToolNameMatches: callContent.toolName === "wait_subagents",
    callToolCallIdMatches: callContent.toolCallId === PHONE_SHAPED_WAIT_TOOL_CALL_ID,
    inputIdempotencyKeyMatches: callInput.idempotencyKey === sourceWait?.idempotencyKey,
    inputModeMatchesWait: callInput.mode === sourceWait?.mode,
    requestModeMatchesWait: request.mode === sourceWait?.mode,
    inputTimeoutMatchesRequest: Number(callInput.timeoutMs) === Number(request.timeoutMs),
    waitTargetsMatchExpected: sameIds(sourceWait?.targetTaskIds, [ids.targetTaskId]),
    inputTargetsMatchWait: sameIds(callInput.taskIds, sourceWait?.targetTaskIds),
    requestTargetsMatchWait: sameIds(request.targetTaskIds, sourceWait?.targetTaskIds),
    receiptToolCallIdMatches: resultContent.toolCallId === PHONE_SHAPED_WAIT_TOOL_CALL_ID,
    receiptErrorCodeIsClear: resultContent.errorCode === null || resultContent.errorCode === undefined,
    receiptWaitIdMatches: receipt.waitId === sourceWait?.id,
    receiptStatusIsWaiting: receipt.status === "waiting",
    receiptTargetsMatchWait: sameIds(receipt.taskIds, sourceWait?.targetTaskIds),
    receiptMatchedIdsAreEmpty: Array.isArray(receipt.matchedTaskIds) && receipt.matchedTaskIds.length === 0,
    receiptTaskCountMatches: receiptTaskIds !== null && receiptTaskIds.length === 1,
    receiptTaskIdsMatchWait: sameIds(receiptTaskIds, sourceWait?.targetTaskIds),
    receiptDeadlineMatchesWait: timestamp(receipt.deadlineAt) !== undefined
      && timestamp(receipt.deadlineAt) === timestamp(sourceWait?.deadlineAt),
  }).toEqual({
    waitCount: 1, callToolNameMatches: true, callToolCallIdMatches: true, inputIdempotencyKeyMatches: true, inputModeMatchesWait: true,
    requestModeMatchesWait: true, inputTimeoutMatchesRequest: true, waitTargetsMatchExpected: true,
    inputTargetsMatchWait: true, requestTargetsMatchWait: true, receiptToolCallIdMatches: true,
    receiptErrorCodeIsClear: true, receiptWaitIdMatches: true, receiptStatusIsWaiting: true,
    receiptTargetsMatchWait: true, receiptMatchedIdsAreEmpty: true, receiptTaskCountMatches: true,
    receiptTaskIdsMatchWait: true, receiptDeadlineMatchesWait: true,
  })
  expect(call).toMatchObject({ status: "completed", revision: 1,
    content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", status: "completed", errorCode: null } })
  expect(callInput.idempotencyKey).toBe(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
  expect(callInput.taskIds).toEqual([FIXED_WAIT_TARGET_TASK_ID])
  expect(result).toMatchObject({ status: "completed", revision: 1,
    content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, errorCode: null,
      output: { status: "waiting", taskIds: [FIXED_WAIT_TARGET_TASK_ID] } } })
  expect(events.rows.map(event => event.type)).toEqual([
    "item.started", "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed",
  ])
  expect(modelUsage.rows).toHaveLength(1)
  expect(modelUsage.rows[0]).toMatchObject({ type: "model.usage", actor: "subagent", correlationId: stepId,
    idempotencyKey: `task:${ids.waiterTaskId}:event:model-usage:${stepId}` })
  expect(events.rows[0]).toMatchObject({ itemId: callItemId, correlationId: stepId, causationId: modelUsage.rows[0]!.id })
  expect(BigInt(modelUsage.rows[0]!.sequence)).toBeLessThan(BigInt(events.rows[0]!.sequence))
  expect(events.rows[1]).toMatchObject({ itemId: callItemId, correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
    causationId: events.rows[0]!.id })
  expect(events.rows[2]).toMatchObject({ itemId: callItemId, correlationId: callItemId, causationId: events.rows[1]!.id })
  expect(events.rows[3]).toMatchObject({ itemId: callItemId, correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, causationId: events.rows[2]!.id })
  expect(events.rows[4]).toMatchObject({ itemId: resultItemId, correlationId: stepId, causationId: events.rows[3]!.id })
  expect(events.rows[5]).toMatchObject({ itemId: resultItemId, correlationId: resultItemId, causationId: events.rows[4]!.id })
  const completedInput = asObject(asObject(events.rows[2]?.payload).content)
  expect(asObject(completedInput.input)).toMatchObject({
    idempotencyKey: "[REDACTED]",
    taskIds: ["[REDACTED]"],
  })
  expect(asObject(completedInput.input).idempotencyKey).toBe("[REDACTED]")
  expect(asObject(completedInput.input).taskIds).not.toEqual([FIXED_WAIT_TARGET_TASK_ID])
  expect(JSON.stringify(events.rows[2]?.payload)).not.toContain(FIXED_WAIT_TARGET_TASK_ID)
  const eventPayloads = JSON.stringify(events.rows.map(event => event.payload))
  expect(eventPayloads).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
  expect(eventPayloads).toContain(FIXED_WAIT_TARGET_TASK_ID)
  const resultEventContent = asObject(asObject(events.rows[5]?.payload).content)
  expect(asObject(resultEventContent.output).taskIds).toEqual([FIXED_WAIT_TARGET_TASK_ID])
  const eventOutboxes = await pool.query<{ idempotencyKey: string; payload: Record<string, unknown> }>(
    `SELECT "idempotencyKey", "payload" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events'
       AND "idempotencyKey" = ANY($2::text[])`,
    [ids.sessionId, events.rows.map(event => `agent-event:${event.id}`)],
  )
  expect(eventOutboxes.rows).toHaveLength(6)
  const eventOutboxPayload = JSON.stringify(eventOutboxes.rows.map(row => row.payload))
  expect(eventOutboxPayload).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
  expect(eventOutboxPayload).toContain(FIXED_WAIT_TARGET_TASK_ID)
  const callCompletionOutbox = eventOutboxes.rows.find(row => row.payload.eventId === events.rows[2]?.id)
  expect(callCompletionOutbox).toBeDefined()
  expect(JSON.stringify(callCompletionOutbox?.payload)).not.toContain(FIXED_WAIT_TARGET_TASK_ID)
}

async function expectMalformedClaimOutcomeRejected(
  pool: Pool, taskStore: PgSubagentTaskStore, ids: FixtureIds, waitId: string,
  validResult: Record<string, unknown>, label: string, corrupt: (outcome: Record<string, unknown>) => void,
): Promise<void> {
  const malformedResult = structuredClone(validResult)
  const malformedOutcome = asObject(malformedResult.outcome)
  corrupt(malformedOutcome)
  const updated = await pool.query(`UPDATE "agent_wait_conditions" SET "result" = $2::jsonb
    WHERE "id" = $1 AND "parentTaskId" = $3 AND "sessionId" = $4 AND "consumedAt" IS NOT NULL RETURNING "id"`,
  [waitId, JSON.stringify(malformedResult), ids.waiterTaskId, ids.sessionId])
  expect(updated.rowCount, `${label}: malformed wait receipt was not installed`).toBe(1)
  const beforeTask = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpired: boolean }>(
    `SELECT "status", "attemptCount", "leaseOwner", "leaseExpiresAt" <= clock_timestamp() AS "leaseExpired"
      FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
  const beforeDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null; payload: unknown }>(
    `SELECT "attemptCount", "publishedAt", "payload" FROM "agent_outbox"
      WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
    [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`])
  const beforeWaitCounts = await pool.query<{ rowCount: string; sourceCount: string; consumedCount: string }>(
    `SELECT COUNT(*)::text AS "rowCount",
       COUNT(*) FILTER (WHERE "id" = $4)::text AS "sourceCount",
       COUNT(*) FILTER (WHERE "consumedAt" IS NOT NULL)::text AS "consumedCount"
     FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3`,
    [ids.sessionId, ids.turnId, ids.waiterTaskId, waitId])
  expect(beforeTask.rows, `${label}: expected exactly one persisted waiter`).toHaveLength(1)
  expect(beforeDispatch.rows, `${label}: expected the dispatch generation row`).toHaveLength(1)
  expect(beforeWaitCounts.rows).toEqual([{ rowCount: "1", sourceCount: "1", consumedCount: "1" }])
  const previousTraceTaskId = process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
  const traceLog = vi.spyOn(console, "info").mockImplementation(() => undefined)
  try {
    process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID = ids.waiterTaskId
    const recovery = await new AgentTreeManager(taskStore, { heartbeatMs: 2_000 }).recover(50)
    expect(recovery.rows.some(row => row.id === ids.waiterTaskId), `${label}: manager.recover requeued the malformed wait`).toBe(false)
    const traceLine = traceLog.mock.calls.map(([value]) => String(value))
      .find(value => value.startsWith("WORKER_B_RECOVERY_PREDICATE_TRACE "))
    expect(traceLine, `${label}: expiry recovery did not emit its real predicate trace`).toBeDefined()
    expect(JSON.parse(traceLine!.slice("WORKER_B_RECOVERY_PREDICATE_TRACE ".length))).toMatchObject({
      waitRegistrationFound: false, waitRegistrationRejected: false,
      rejectionStage: "unsettled_external_call_rejected", blockingExternalCall: true,
    })
    const afterTask = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpired: boolean }>(
      `SELECT "status", "attemptCount", "leaseOwner", "leaseExpiresAt" <= clock_timestamp() AS "leaseExpired"
        FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
    const afterDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null; payload: unknown }>(
      `SELECT "attemptCount", "publishedAt", "payload" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
      [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`])
    const afterWaitCounts = await pool.query<{ rowCount: string; sourceCount: string; consumedCount: string }>(
      `SELECT COUNT(*)::text AS "rowCount",
         COUNT(*) FILTER (WHERE "id" = $4)::text AS "sourceCount",
         COUNT(*) FILTER (WHERE "consumedAt" IS NOT NULL)::text AS "consumedCount"
       FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, waitId])
    expect(beforeTask.rows[0]).toMatchObject({ status: "running", attemptCount: 1, leaseExpired: true })
    expect(afterTask.rows).toEqual(beforeTask.rows)
    expect(afterDispatch.rows).toEqual(beforeDispatch.rows)
    expect(afterWaitCounts.rows).toEqual(beforeWaitCounts.rows)
  } finally {
    if (previousTraceTaskId === undefined) delete process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID
    else process.env.AGENT_RUNTIME_PG_TEST_RECOVERY_TRACE_TASK_ID = previousTraceTaskId
    traceLog.mockRestore()
    await pool.query(`UPDATE "agent_wait_conditions" SET "result" = $2::jsonb
      WHERE "id" = $1 AND "parentTaskId" = $3 AND "sessionId" = $4`,
    [waitId, JSON.stringify(validResult), ids.waiterTaskId, ids.sessionId])
  }
}

async function seedFixedWaitTarget(pool: Pool, input: {
  userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string;
  policy: ReturnType<typeof defaultSubagentPolicy>;
}): Promise<string> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    const binding = await client.query<FixedWaitTargetParent>([
      "SELECT parent.\"id\", parent.\"sessionId\", parent.\"turnId\", parent.\"rootTaskId\", parent.\"path\", parent.\"depth\",",
      "parent.\"allowedActions\", parent.\"modelProfileSnapshot\", parent.\"toolPolicySnapshot\"",
      "FROM \"agent_sessions\" AS session",
      "JOIN \"agent_turns\" AS turn ON turn.\"id\" = $3 AND turn.\"sessionId\" = session.\"id\" AND turn.\"userId\" = session.\"userId\"",
      "JOIN \"sub_agent_tasks\" AS root ON root.\"id\" = $4 AND root.\"sessionId\" = session.\"id\" AND root.\"turnId\" = turn.\"id\"",
      "JOIN \"sub_agent_tasks\" AS parent ON parent.\"id\" = $5 AND parent.\"sessionId\" = session.\"id\"",
      "AND parent.\"turnId\" = turn.\"id\" AND parent.\"rootTaskId\" = root.\"id\" AND parent.\"parentTaskId\" = root.\"id\"",
      "WHERE session.\"id\" = $2 AND session.\"userId\" = $1 AND session.\"status\" = 'running'",
      "AND turn.\"status\" = 'in_progress' AND turn.\"rootTaskId\" = root.\"id\"",
      "AND root.\"rootTaskId\" = root.\"id\" AND root.\"parentTaskId\" IS NULL AND root.\"status\" = 'running'",
      "AND root.\"interruptRequestedAt\" IS NULL AND parent.\"status\" = 'queued'",
      "FOR UPDATE OF session, turn, root, parent",
    ].join("\n"), [input.userId, input.sessionId, input.turnId, input.rootTaskId, input.parentTaskId])
    const parent = binding.rows[0]
    if (!parent) throw new Error("Fixed child-wait target owner binding is unavailable")
    const depth = Number(parent.depth) + 1
    if (!Number.isSafeInteger(depth) || depth > input.policy.maxDepth) throw new Error("Fixed child-wait target exceeds the parent depth policy")
    const activeChildren = await client.query<{ count: number }>([
      "SELECT COUNT(*)::int AS \"count\" FROM \"sub_agent_tasks\"",
      "WHERE \"sessionId\" = $1 AND \"parentTaskId\" = $2",
      "AND \"status\" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')",
    ].join("\n"), [input.sessionId, input.parentTaskId])
    if (Number(activeChildren.rows[0]?.count ?? 0) >= input.policy.maxFanOut) throw new Error("Fixed child-wait target exceeds the parent fan-out policy")
    const inheritedActions = actionList(parent.allowedActions)
    if (!inheritedActions.includes("wait_subagents")) throw new Error("Fixed child-wait target parent cannot authorize the wait tool")
    const id = FIXED_WAIT_TARGET_TASK_ID
    const inserted = await client.query<{ id: string }>(INSERT_TASK + " RETURNING \"id\"", [
      id, parent.sessionId, parent.turnId, parent.rootTaskId, input.parentTaskId,
      parent.path.replace(/\/$/, "") + "/" + id, depth, "scout", "research",
      "produce a direct-child result", json([], []), json([], []), json(inheritedActions, []),
      json({}, {}), json({}, {}), json(parent.modelProfileSnapshot ?? {}, {}, "model_profile"),
      json(asObject(parent.toolPolicySnapshot), {}, "tool_policy"), json({ subagentPolicy: input.policy }, {}, "budget"),
      input.policy.maxAttempts, false,
    ])
    if (inserted.rowCount !== 1 || inserted.rows[0]?.id !== id) throw new Error("Fixed child-wait target did not retain its owner-bound identity")
    await client.query("COMMIT")
    return id
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function seedLoopWaitScenario(pool: Pool, taskStore: PgSubagentTaskStore, ids: FixtureIds, suffix: string,
  policy: ReturnType<typeof defaultSubagentPolicy>): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [ids.userId, `${ids.userId}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Run the real child wait continuation loop', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [ids.turnId, ids.sessionId, ids.userId])
  const root = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
    role: "orchestrator", taskType: "root", goal: "real child wait loop fixture", allowedActions: ["wait_subagents"], policy })
  ids.rootTaskId = root.id
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`, [ids.turnId, root.id, ids.sessionId])
  const activated = await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1 AND "sessionId" = $2 RETURNING "id"`,
    [root.id, ids.sessionId])
  if (activated.rowCount !== 1) throw new Error("Loop fixture root activation failed")
  const waiter = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, parentTaskId: root.id,
    role: "analyst", taskType: "research", goal: "wait for one direct child", allowedActions: ["wait_subagents"], policy })
  ids.waiterTaskId = waiter.id
  ids.targetTaskId = await seedFixedWaitTarget(pool, { userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
    rootTaskId: root.id, parentTaskId: waiter.id, policy })
  const payload = { taskId: waiter.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: `loop-fixture-${suffix}` }
  await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb)`, [
    `durable-child-wait-loop-dispatch-${suffix}`, ids.sessionId, `subagent-dispatch:${waiter.id}`, JSON.stringify(payload),
  ])
}

async function finishLoopWaitTarget(pool: Pool, taskStore: PgSubagentTaskStore, ids: FixtureIds,
  policy: ReturnType<typeof defaultSubagentPolicy>): Promise<void> {
  const targetLease = await taskStore.claim({ taskId: ids.targetTaskId, sessionId: ids.sessionId,
    ownerId: "loop-fixture-child-finisher", policy, now: new Date() })
  if (!targetLease?.leaseExpiresAt || !targetLease.turnId) throw new Error("Loop fixture target lease is unavailable")
  const lease: SubagentLease = { ...targetLease, ownerId: "loop-fixture-child-finisher",
    leaseExpiresAt: targetLease.leaseExpiresAt, signal: new AbortController().signal }
  const owner = executionOwnerFence({ kind: "task", lease })
  const turnStore = createPgTurnEngineStore(pool)
  const step = await turnStore.startStep({ owner, stepId: `loop-child-target-step:${ids.targetTaskId}`, ordinal: 0,
    attempt: lease.attemptCount, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
  if (step.ordinal !== 1) throw new Error("Loop fixture target did not create the Turn-global ordinal gap")
  await turnStore.updateStep({ owner, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
  const finished = await taskStore.finish({ taskId: ids.targetTaskId, sessionId: ids.sessionId, ownerId: lease.ownerId,
    attemptCount: lease.attemptCount, status: "completed", result: { finalText: TARGET_RESULT_TEXT }, now: new Date() })
  if (finished !== "completed") throw new Error("Loop fixture target did not complete")
}

async function seedExpiredUnsettledRecoveryBlockers(input: {
  pool: Pool; taskStore: PgSubagentTaskStore; turnStore: ReturnType<typeof createPgTurnEngineStore>;
  userId: string; suffix: string; policy: ReturnType<typeof defaultSubagentPolicy>;
  sessionIds: string[]; taskIds: string[]; count: number;
}): Promise<void> {
  for (let index = 0; index < input.count; index++) {
    const order = String(index).padStart(2, "0")
    const sessionId = `durable-child-wait-backlog-${input.suffix}-${order}`
    const turnId = `durable-child-wait-backlog-turn-${input.suffix}-${order}`
    await input.pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'unsettled recovery pagination blocker', 'running', 'test', CURRENT_TIMESTAMP)`, [sessionId, input.userId])
    input.sessionIds.push(sessionId)
    await input.pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
      "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
    [turnId, sessionId, input.userId])
    const root = await input.taskStore.create({ userId: input.userId, sessionId, turnId, role: "orchestrator",
      taskType: "root", goal: "recovery pagination blocker root", allowedActions: ["external_action"], policy: input.policy })
    await input.pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`, [turnId, root.id, sessionId])
    const activatedRoot = await input.pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running'
      WHERE "id" = $1 AND "sessionId" = $2 RETURNING "id"`, [root.id, sessionId])
    if (activatedRoot.rowCount !== 1) throw new Error("Recovery blocker root activation lost its fixture identity")
    const task = await input.taskStore.create({ userId: input.userId, sessionId, turnId, parentTaskId: root.id,
      role: "analyst", taskType: "research", goal: "leave one real external call unsettled", allowedActions: ["external_action"], policy: input.policy })
    input.taskIds.push(task.id)
    const ownerId = `recovery-blocker-owner-${input.suffix}-${order}`
    const claimed = await input.taskStore.claim({ taskId: task.id, sessionId, ownerId, policy: input.policy, now: new Date() })
    if (!claimed?.leaseExpiresAt || !claimed.turnId) throw new Error("Recovery blocker did not receive a running lease")
    const lease: SubagentLease = { ...claimed, ownerId, leaseExpiresAt: claimed.leaseExpiresAt, signal: new AbortController().signal }
    const owner = executionOwnerFence({ kind: "task", lease })
    const now = new Date()
    const stepId = `recovery-blocker-step-${input.suffix}-${order}`
    await input.turnStore.startStep({ owner, stepId, ordinal: 0, attempt: claimed.attemptCount, inputThroughSequence: 0n,
      consumedInputIds: [], modelProfileSnapshot: {}, now })
    const callId = `recovery-blocker-call-${input.suffix}-${order}`
    const callItemId = `recovery-blocker-call-item-${input.suffix}-${order}`
    await input.turnStore.createItem({ owner, itemId: callItemId, stepId, type: "tool_call", status: "started", phase: null,
      content: { toolCallId: callId, toolName: "external_action", toolVersion: "1", input: {} }, now })
    await input.turnStore.appendEvent({ owner, id: `task:${task.id}:event:tool-started:${callId}`, itemId: callItemId,
      type: "tool_call.started", correlationId: callId, causationId: null,
      idempotencyKey: `task:${task.id}:event:tool-started:${callId}`,
      payload: { toolCallId: callId, toolName: "external_action", taskId: task.id } })
    const expired = await input.pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
      WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
    [task.id, sessionId, ownerId])
    if (expired.rowCount !== 1) throw new Error("Recovery blocker lease expiry lost its owner fence")
  }
}

async function readBlockerDurableState(pool: Pool, taskIds: readonly string[]): Promise<Array<{ dispatchOutbox: unknown[] }>> {
  const result = await pool.query<{ dispatchOutbox: unknown[] }>(`SELECT to_jsonb(session) AS "session", to_jsonb(turn) AS "turn", to_jsonb(root) AS "root",
      to_jsonb(task) AS "task",
      COALESCE((SELECT jsonb_agg(to_jsonb(step) ORDER BY step."id") FROM "agent_steps" AS step
        WHERE step."sessionId" = task."sessionId" AND step."turnId" = task."turnId" AND step."taskId" = task."id"), '[]'::jsonb) AS "steps",
      COALESCE((SELECT jsonb_agg(to_jsonb(item) ORDER BY item."id") FROM "agent_items" AS item
        WHERE item."sessionId" = task."sessionId" AND item."turnId" = task."turnId" AND item."taskId" = task."id"), '[]'::jsonb) AS "items",
      COALESCE((SELECT jsonb_agg(to_jsonb(event) ORDER BY event."sequence") FROM "agent_events" AS event
        WHERE event."sessionId" = task."sessionId" AND event."turnId" = task."turnId" AND event."taskId" = task."id"), '[]'::jsonb) AS "events",
      COALESCE((SELECT jsonb_agg(to_jsonb(outbox) ORDER BY outbox."id") FROM "agent_outbox" AS outbox
        WHERE outbox."aggregateId" = task."sessionId" AND outbox."topic" = 'agent.events'
          AND outbox."payload"->>'taskId' = task."id"), '[]'::jsonb) AS "eventOutbox",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', dispatch."id", 'topic', dispatch."topic",
          'aggregateId', dispatch."aggregateId", 'idempotencyKey', dispatch."idempotencyKey",
          'payload', dispatch."payload", 'attemptCount', dispatch."attemptCount", 'lastError', dispatch."lastError",
          'published', dispatch."publishedAt" IS NOT NULL) ORDER BY dispatch."id")
        FROM "agent_outbox" AS dispatch WHERE dispatch."aggregateId" = task."sessionId"
          AND dispatch."topic" = 'agent.subagent.dispatch'
          AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"), '[]'::jsonb) AS "dispatchOutbox"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) ORDER BY task."sessionId", task."id"`, [taskIds])
  return result.rows
}

async function readRecoveryCandidateRank(pool: Pool, waiterTaskId: string, blockerTaskIds: readonly string[]): Promise<{
  targetPageRank: string; candidateCount: string; fixturePageRank: string; fixtureCandidateCount: string; fixtureBlockerCount: string; observedAt: Date;
}> {
  const result = await pool.query(`WITH horizon AS (SELECT clock_timestamp() AS "at"), eligible AS (
      SELECT task."id", task."sessionId", task."rootTaskId",
        ROW_NUMBER() OVER (ORDER BY task."sessionId", task."rootTaskId" NULLS LAST, task."id") AS "pageRank",
        COUNT(*) OVER () AS "candidateCount"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId" CROSS JOIN horizon
      WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR session."status" NOT IN ('aborted', 'archived'))
        AND task."leaseExpiresAt" <= horizon."at" AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= horizon."at")
        AND (task."id" NOT LIKE 'root-%' OR session."status" IN ('aborted', 'archived') OR task."interruptRequestedAt" IS NOT NULL
          OR (task."taskType" = 'root' AND task."id" = task."rootTaskId" AND task."parentTaskId" IS NULL AND task."turnId" IS NOT NULL
            AND EXISTS (SELECT 1 FROM "agent_turns" AS rootTurn WHERE rootTurn."id" = task."turnId"
              AND rootTurn."sessionId" = task."sessionId" AND rootTurn."userId" = session."userId"
              AND rootTurn."rootTaskId" = task."id" AND rootTurn."status" = 'failed')))
    ), fixture AS (
      SELECT "id", ROW_NUMBER() OVER (ORDER BY "sessionId", "rootTaskId" NULLS LAST, "id") AS "pageRank", COUNT(*) OVER () AS "candidateCount"
      FROM eligible WHERE "id" = $1 OR "id" = ANY($2::text[])
    )
    SELECT eligible."pageRank"::text AS "targetPageRank", eligible."candidateCount"::text AS "candidateCount",
      fixture."pageRank"::text AS "fixturePageRank", fixture."candidateCount"::text AS "fixtureCandidateCount",
      (SELECT COUNT(*)::text FROM eligible AS blocker WHERE blocker."id" = ANY($2::text[])
        AND blocker."sessionId" < eligible."sessionId") AS "fixtureBlockerCount", horizon."at" AS "observedAt"
    FROM eligible JOIN fixture ON fixture."id" = eligible."id" CROSS JOIN horizon WHERE eligible."id" = $1`, [waiterTaskId, blockerTaskIds])
  const row = result.rows[0]
  if (!row) throw new Error("Recovery candidate rank could not be observed")
  return row as { targetPageRank: string; candidateCount: string; fixturePageRank: string; fixtureCandidateCount: string;
    fixtureBlockerCount: string; observedAt: Date }
}

type WaitResolverReport = { scanned: number; resolved: number; woken: number }

function boundedCount(value: unknown): number | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000_000 ? parsed : null
}

async function diagnoseZeroWaitWake(pool: Pool, ids: FixtureIds, report: WaitResolverReport): Promise<void> {
  try {
    const result = await pool.query<{ waitRows: string; waitWaiting: string; waitReady: string; waitTimedOut: string;
      waitSuspended: boolean | null; waitConsumed: boolean | null; parentRows: string; parentWaiting: string; parentRunning: string;
      parentLeaseOwnerPresent: boolean | null; parentLeaseExpiryPresent: boolean | null; parentDeadlinePresent: boolean | null;
      parentDeadlineLive: boolean | null; parentStatus: string | null; waitDeadlineExpired: boolean | null;
      eligibleSessionCount: string; targetRank: string | null }>(
      `WITH horizon AS MATERIALIZED (SELECT clock_timestamp() AS "at"), eligible AS (
        SELECT session."id", ROW_NUMBER() OVER (ORDER BY session."updatedAt" ASC, session."id" ASC)::text AS "rank"
        FROM "agent_sessions" AS session CROSS JOIN horizon
        WHERE session."status" NOT IN ('aborted', 'archived') AND EXISTS (
          SELECT 1 FROM "agent_wait_conditions" AS wait
          JOIN "sub_agent_tasks" AS parent ON parent."id" = wait."parentTaskId"
            AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId"
          JOIN "agent_turns" AS turn ON turn."id" = wait."turnId" AND turn."sessionId" = wait."sessionId"
          JOIN "sub_agent_tasks" AS root ON root."id" = parent."rootTaskId"
            AND root."sessionId" = wait."sessionId" AND root."turnId" = wait."turnId"
          JOIN "agent_steps" AS step ON step."id" = wait."stepId"
            AND step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = parent."id"
          WHERE wait."sessionId" = session."id" AND wait."userId" = session."userId"
            AND wait."status" = 'waiting' AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
            AND parent."parentTaskId" IS NOT NULL AND parent."status" = 'waiting'
            AND (parent."absoluteDeadlineAt" IS NULL OR parent."absoluteDeadlineAt" > horizon."at")
            AND parent."leaseOwner" IS NULL AND parent."leaseExpiresAt" IS NULL
            AND step."attempt" = parent."attemptCount" AND step."status" = 'waiting_for_tool'
            AND step."ordinal" = (SELECT MAX(current."ordinal") FROM "agent_steps" AS current
              WHERE current."sessionId" = step."sessionId" AND current."turnId" = step."turnId"
                AND current."taskId" = step."taskId" AND current."attempt" = step."attempt")
            AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
            AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')
        )
      )
      SELECT
        (SELECT COUNT(*)::text FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3) AS "waitRows",
        (SELECT COUNT(*)::text FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "status" = 'waiting') AS "waitWaiting",
        (SELECT COUNT(*)::text FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "status" = 'ready') AS "waitReady",
        (SELECT COUNT(*)::text FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "status" = 'timed_out') AS "waitTimedOut",
        (SELECT BOOL_OR("suspendedAt" IS NOT NULL) FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3) AS "waitSuspended",
        (SELECT BOOL_OR("consumedAt" IS NOT NULL) FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3) AS "waitConsumed",
        (SELECT BOOL_OR(wait."deadlineAt" <= horizon."at") FROM "agent_wait_conditions" AS wait
          WHERE wait."sessionId" = $1 AND wait."turnId" = $2 AND wait."parentTaskId" = $3) AS "waitDeadlineExpired",
        (SELECT COUNT(*)::text FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2) AS "parentRows",
        (SELECT COUNT(*)::text FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2 AND "status" = 'waiting') AS "parentWaiting",
        (SELECT COUNT(*)::text FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2 AND "status" = 'running') AS "parentRunning",
        (SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2) AS "parentStatus",
        (SELECT BOOL_OR("leaseOwner" IS NOT NULL) FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2) AS "parentLeaseOwnerPresent",
        (SELECT BOOL_OR("leaseExpiresAt" IS NOT NULL) FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2) AS "parentLeaseExpiryPresent",
        (SELECT BOOL_OR("absoluteDeadlineAt" IS NOT NULL) FROM "sub_agent_tasks" WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2) AS "parentDeadlinePresent",
        (SELECT BOOL_OR("absoluteDeadlineAt" > horizon."at") FROM "sub_agent_tasks" CROSS JOIN horizon WHERE "id" = $3 AND "sessionId" = $1 AND "turnId" = $2) AS "parentDeadlineLive",
        (SELECT COUNT(*)::text FROM eligible) AS "eligibleSessionCount",
        (SELECT eligible."rank" FROM eligible WHERE eligible."id" = $1) AS "targetRank"
      FROM horizon`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId],
    )
    const state = result.rows[0]
    if (!state) throw new Error("wait_resolver_diagnostic_row_missing")
    const waitRows = boundedCount(state.waitRows), waitWaiting = boundedCount(state.waitWaiting)
    const waitReady = boundedCount(state.waitReady), waitTimedOut = boundedCount(state.waitTimedOut)
    const parentRows = boundedCount(state.parentRows), parentWaiting = boundedCount(state.parentWaiting)
    const parentRunning = boundedCount(state.parentRunning)
    const targetRank = boundedCount(state.targetRank)
    process.stderr.write(`WAIT_RESOLVER_ZERO_DIAGNOSTIC ${JSON.stringify({
      sample: "post-reconcile-read-committed-unlocked-sample",
      resolver: { scanned: report.scanned, resolved: report.resolved, woken: report.woken, batchLimit: 25 },
      wait: { rows: waitRows, waiting: waitWaiting, ready: waitReady, timedOut: waitTimedOut,
        otherStatus: waitRows === null || waitWaiting === null || waitReady === null || waitTimedOut === null
          ? null : Math.max(0, waitRows - waitWaiting - waitReady - waitTimedOut),
        suspended: state.waitSuspended === true, consumed: state.waitConsumed === true,
        deadlineExpired: state.waitDeadlineExpired },
      parent: { rows: parentRows, waiting: parentWaiting, running: parentRunning,
        otherStatus: parentRows === null || parentWaiting === null || parentRunning === null
          ? null : Math.max(0, parentRows - parentWaiting - parentRunning),
        status: diagnosticTaskStatus(state.parentStatus),
        leaseOwnerPresent: state.parentLeaseOwnerPresent === true, leaseExpiryPresent: state.parentLeaseExpiryPresent === true,
        deadlinePresent: state.parentDeadlinePresent === true, deadlineLive: state.parentDeadlineLive === true },
      eligibleSessions: { count: boundedCount(state.eligibleSessionCount), targetRank,
        postSampleUnlockedRankAtMost25: targetRank !== null && targetRank <= 25, actualSelectionProven: false },
    })}\n`)
  } catch {
    process.stderr.write(`WAIT_RESOLVER_ZERO_DIAGNOSTIC ${JSON.stringify({
      sample: "post-reconcile-read-committed-unlocked-sample", resolver: { scanned: report.scanned, resolved: report.resolved, woken: report.woken },
      diagnosticQueryFailed: true,
    })}\n`)
  }
}

async function stopWorker(child: WorkerProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return
  child.kill("SIGKILL")
  await Promise.race([child.exited, new Promise(resolve => setTimeout(resolve, 5_000))])
}

withServices("durable child wait across PostgreSQL/Redis Worker process restart", () => {
  let pool: Pool
  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 8 }) })
  afterAll(async () => { await pool?.end() })

  it("recovers registered, pre-continuation, and streaming-continuation crash cuts on one attempt", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-user-${suffix}`,
      sessionId: `durable-child-wait-session-${suffix}`,
      turnId: `durable-child-wait-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
      finalText: FINAL_MARKER,
    }
    const queueName = `agent-child-wait-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined
    let workerB: WorkerProcess | undefined
    let workerC: WorkerProcess | undefined
    let workerD: WorkerProcess | undefined
    let workerE: WorkerProcess | undefined
    let workerF: WorkerProcess | undefined
    let workerG: WorkerProcess | undefined
    let workerH: WorkerProcess | undefined
    let queuePaused = false
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined
    const recoveryBlockerSessionIds: string[] = []
    const recoveryBlockerTaskIds: string[] = []

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.userId, `${ids.userId}@example.invalid`])
      await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
        VALUES ($1, $2, 'Wait for a direct child and resume after restart', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
      await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
        "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
        VALUES ($1, $2, $3, 'in_progress', 'system', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`, [ids.turnId, ids.sessionId, ids.userId])

      const root = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
        role: "orchestrator", taskType: "root", goal: "durable child wait fixture", allowedActions: ["wait_subagents"], policy })
      ids.rootTaskId = root.id
      await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2 WHERE "id" = $1 AND "sessionId" = $3`, [ids.turnId, root.id, ids.sessionId])
      await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running' WHERE "id" = $1 AND "sessionId" = $2`, [root.id, ids.sessionId])
      const waiter = await taskStore.create({ userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, parentTaskId: root.id,
        role: "analyst", taskType: "research", goal: "wait for a direct child", allowedActions: ["wait_subagents"], policy })
      ids.waiterTaskId = waiter.id
      const targetId = await seedFixedWaitTarget(pool, { userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
        rootTaskId: root.id, parentTaskId: waiter.id, policy })
      const target = await taskStore.get(targetId, ids.sessionId)
      if (!target) throw new Error("Fixed child-wait target was not readable through the task store")
      expect(target).toMatchObject({ id: FIXED_WAIT_TARGET_TASK_ID, userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
        rootTaskId: root.id, parentTaskId: waiter.id, path: waiter.path.replace(/\/$/, "") + "/" + FIXED_WAIT_TARGET_TASK_ID,
        depth: waiter.depth + 1, status: "queued", attemptCount: 0, maxAttempts: policy.maxAttempts,
        allowedActions: waiter.allowedActions, modelProfileSnapshot: waiter.modelProfileSnapshot,
        toolPolicySnapshot: waiter.toolPolicySnapshot, budgetSnapshot: { subagentPolicy: policy } })
      ids.targetTaskId = target.id

      const firstPayload = { taskId: waiter.id, sessionId: ids.sessionId, rootTaskId: root.id, ownerId: "worker-a-dispatch" }
      await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb)`, [
        `durable-child-wait-dispatch-${suffix}`, ids.sessionId, `subagent-dispatch:${waiter.id}`, JSON.stringify(firstPayload),
      ])

      workerA = launchWorker("worker-a-crash", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const firstOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(firstOutbox.rows[0]).toMatchObject({ attemptCount: 1 })
      expect(firstOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const firstGeneration = firstOutbox.rows[0]!.attemptCount - 1
      expect(firstGeneration).toBe(0)
      const firstJob = await queue.getJob(subagentDispatchJobId(waiter.id, firstGeneration))
      expect(firstJob).toBeDefined()
      await waitForMarker(workerA, "WORKER_A_REGISTERED")
      const cut = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        stepStatus: string; stepAttempt: number; waitStatus: string; suspendedAt: Date | null; consumedAt: Date | null;
        callStatus: string; startedCount: number; settledCount: number; resultCount: number }>(
        `SELECT task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", step."status" AS "stepStatus",
          step."attempt" AS "stepAttempt", wait."status" AS "waitStatus", wait."suspendedAt", wait."consumedAt", call."status" AS "callStatus",
          (SELECT COUNT(*)::int FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
            AND started."type" = 'tool_call.started' AND started."correlationId" = call."content"->>'toolCallId') AS "startedCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
            AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledCount",
          (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = task."sessionId" AND result."taskId" = task."id"
            AND result."stepId" = step."id" AND result."type" = 'tool_result') AS "resultCount"
         FROM "sub_agent_tasks" AS task JOIN "agent_steps" AS step ON step."taskId" = task."id" AND step."sessionId" = task."sessionId"
         JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_items" AS call ON call."stepId" = step."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2 AND step."ordinal" = 0 AND wait."stepId" = step."id"`,
        [waiter.id, ids.sessionId],
      )
      expect(cut.rows[0]).toMatchObject({ status: "running", attemptCount: 1, stepStatus: "streaming", stepAttempt: 1,
        waitStatus: "waiting", suspendedAt: null, consumedAt: null, callStatus: "started", startedCount: 1, settledCount: 0, resultCount: 0 })
      const sourceCallItemId = `task:${waiter.id}:item:tool-call:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
      const sourceLifecycle = await pool.query<{ id: string; sequence: string; type: string; itemId: string; correlationId: string; causationId: string | null }>(
        `SELECT "id", "sequence", "type", "itemId", "correlationId", "causationId" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "itemId" = $4 ORDER BY "sequence"`,
        [ids.sessionId, ids.turnId, waiter.id, sourceCallItemId],
      )
      const sourceModelUsage = await pool.query<{ id: string; sequence: string; type: string; actor: string; correlationId: string; causationId: string | null; idempotencyKey: string }>(
        `SELECT "id", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'model.usage' AND "correlationId" = $4`,
        [ids.sessionId, ids.turnId, waiter.id, `task:${waiter.id}:step:0:attempt:1`],
      )
      const callItems = await pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
        `SELECT "id", "status", "revision", "content" FROM "agent_items"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = $4`,
        [ids.sessionId, ids.turnId, waiter.id, sourceCallItemId],
      )
      const callItem = callItems.rows[0]
      expect(callItem).toMatchObject({ id: sourceCallItemId, status: "started", revision: 0,
        content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", toolVersion: "1",
          input: { taskIds: [FIXED_WAIT_TARGET_TASK_ID], mode: "any", timeoutMs: 30_000,
            idempotencyKey: SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id) } } })
      expect(sourceLifecycle.rows.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
      expect(sourceLifecycle.rows[0]).toMatchObject({ itemId: sourceCallItemId,
        correlationId: `task:${waiter.id}:step:0:attempt:1` })
      expect(sourceLifecycle.rows[1]).toMatchObject({ itemId: sourceCallItemId, correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
        causationId: sourceLifecycle.rows[0]!.id })
      expect(sourceLifecycle.rows[0]?.causationId).toBe(sourceModelUsage.rows[0]?.id)
      expect(sourceModelUsage.rows).toHaveLength(1)
      expect(sourceModelUsage.rows[0]).toMatchObject({ type: "model.usage", actor: "subagent",
        correlationId: `task:${waiter.id}:step:0:attempt:1`,
        idempotencyKey: `task:${waiter.id}:event:model-usage:task:${waiter.id}:step:0:attempt:1` })
      expect(BigInt(sourceModelUsage.rows[0]!.sequence)).toBeLessThan(BigInt(sourceLifecycle.rows[0]!.sequence))
      const firstOwner = cut.rows[0]?.leaseOwner
      expect(firstOwner).toEqual(expect.any(String))
      expect(cut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      expect(await firstJob!.getState()).toBe("active")
      await expect(taskStore.release({ taskId: waiter.id, sessionId: ids.sessionId, ownerId: firstOwner!, attemptCount: 1, now: new Date() })).resolves.toBe(false)
      const afterRelease = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null; dispatchAttemptCount: number; publishedAt: Date | null }>(
        `SELECT task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", dispatch."attemptCount" AS "dispatchAttemptCount", dispatch."publishedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
           AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id" AND dispatch."topic" = 'agent.subagent.dispatch'
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(afterRelease.rows[0]).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: firstOwner,
        leaseExpiresAt: cut.rows[0]!.leaseExpiresAt, dispatchAttemptCount: firstOutbox.rows[0]!.attemptCount, publishedAt: firstOutbox.rows[0]!.publishedAt })
      await stopWorker(workerA)
      const firstExit = await workerA.exited
      expect(firstExit.code).toBeNull()
      expect(firstExit.signal).toBe("SIGKILL")
      const firstExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, firstOwner])
      expect(firstExpiry.rowCount).toBe(1)

      workerB = launchWorker("worker-b-crash-before-resume", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_RECOVERED")
      const recovered = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        stepStatus: string; waitStatus: string; suspendedAt: Date | null; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
          step."status" AS "stepStatus", wait."status" AS "waitStatus", wait."suspendedAt", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_steps" AS step ON step."taskId" = task."id" AND step."sessionId" = task."sessionId"
         JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         WHERE task."id" = $1 AND task."sessionId" = $2 AND step."ordinal" = 0 AND wait."stepId" = step."id"`, [waiter.id, ids.sessionId],
      )
      expect(recovered.rows[0]).toMatchObject({ taskStatus: "waiting", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null,
        stepStatus: "waiting_for_tool", waitStatus: "waiting", consumedAt: null })
      expect(recovered.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const recoveryStart = workerB.stdoutText.indexOf("WORKER_B_RECOVERED")
      const recoveryReady = workerB.stdoutText.indexOf("WORKER_B_READY")
      expect(recoveryStart).toBeGreaterThanOrEqual(0)
      expect(recoveryReady).toBeGreaterThan(recoveryStart)

      const targetLease = await taskStore.claim({ taskId: target.id, sessionId: ids.sessionId, ownerId: "direct-child-finisher", policy, now: new Date() })
      expect(targetLease).not.toBeNull()
      const targetClaim = targetLease!
      const targetLeaseExpiresAt = targetClaim.leaseExpiresAt
      if (!targetLeaseExpiresAt) throw new Error("Direct target task was claimed without a lease expiry")
      const targetExecutionLease: SubagentLease = { ...targetClaim, ownerId: "direct-child-finisher",
        leaseExpiresAt: targetLeaseExpiresAt, signal: new AbortController().signal }
      const targetOwner = executionOwnerFence({ kind: "task", lease: targetExecutionLease })
      const targetStepId = `durable-child-wait-target-step-${suffix}`
      const targetTurnStore = createPgTurnEngineStore(pool)
      const targetStep = await targetTurnStore.startStep({ owner: targetOwner, stepId: targetStepId, ordinal: 0,
        attempt: targetLease!.attemptCount, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
      // AgentStep ordinals are Turn-global: this direct child's real step creates a gap
      // between the wait source (ordinal 0) and the parent's later continuation.
      expect(targetStep.ordinal).toBe(1)
      await targetTurnStore.updateStep({ owner: targetOwner, stepId: targetStepId, status: "completed", finishReason: "stop",
        errorCode: null, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })
      await expect(taskStore.finish({ taskId: target.id, sessionId: ids.sessionId, ownerId: "direct-child-finisher",
        attemptCount: targetLease!.attemptCount, status: "completed", result: { finalText: TARGET_RESULT_TEXT }, now: new Date() })).resolves.toBe("completed")

      const dispatch = await waitFor(async () => {
        const [wait, task, row] = await Promise.all([
          pool.query<{ status: string }>(`SELECT "status" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId]),
          pool.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId]),
          pool.query<{ payload: unknown; attemptCount: number; publishedAt: Date | null }>(`SELECT "payload", "attemptCount", "publishedAt" FROM "agent_outbox"
            WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`]),
        ])
        const current = row.rows[0]
        return wait.rows[0]?.status === "ready" && task.rows[0]?.status === "queued" && current?.publishedAt === null
          ? current : null
      })
      expect(dispatch.attemptCount).toBe(1)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const initialResumeOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(initialResumeOutbox.rows[0]).toMatchObject({ attemptCount: 2 })
      expect(initialResumeOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const initialGeneration = initialResumeOutbox.rows[0]!.attemptCount - 1
      expect(initialGeneration).toBe(firstGeneration + 1)
      const initialResumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, initialGeneration))
      expect(initialResumeJob).toBeDefined()

      await waitForMarker(workerB, "WORKER_B_RESUME_NOT_STARTED")
      expect(await initialResumeJob!.getState()).toBe("active")
      const preContinuationCut = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        leaseExpiresAt: Date | null; sourceStatus: string; sourceIsLatest: boolean; waitStatus: string; suspendedAt: Date | null;
        consumedAt: Date | null; callStatus: string; startedCount: number; settledCount: number; continuationCount: number }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
          source."status" AS "sourceStatus", source."ordinal" = (SELECT MAX(latest."ordinal") FROM "agent_steps" AS latest
            WHERE latest."taskId" = task."id" AND latest."sessionId" = task."sessionId" AND latest."turnId" = task."turnId" AND latest."attempt" = task."attemptCount") AS "sourceIsLatest",
          wait."status" AS "waitStatus", wait."suspendedAt", wait."consumedAt", call."status" AS "callStatus",
          (SELECT COUNT(*)::int FROM "agent_events" AS started WHERE started."sessionId" = task."sessionId" AND started."taskId" = task."id"
            AND started."type" = 'tool_call.started' AND started."correlationId" = call."content"->>'toolCallId') AS "startedCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
            AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledCount",
          (SELECT COUNT(*)::int FROM "agent_steps" AS next WHERE next."taskId" = task."id" AND next."sessionId" = task."sessionId"
            AND next."turnId" = task."turnId" AND next."attempt" = source."attempt" AND next."ordinal" > source."ordinal") AS "continuationCount"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_items" AS call ON call."stepId" = source."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(preContinuationCut.rows[0]).toMatchObject({ taskStatus: "running", attemptCount: 1, sourceStatus: "waiting_for_tool",
        sourceIsLatest: true, waitStatus: "ready", consumedAt: null, callStatus: "started", startedCount: 1, settledCount: 0, continuationCount: 0 })
      expect(preContinuationCut.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect(preContinuationCut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      expect(preContinuationCut.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const preContinuationOwner = preContinuationCut.rows[0]!.leaseOwner
      const preContinuationExpiry = preContinuationCut.rows[0]!.leaseExpiresAt
      if (!(preContinuationExpiry instanceof Date)) throw new Error("Pre-continuation lease has no expiry")
      await stopWorker(workerB)
      const preContinuationExit = await workerB.exited
      expect(preContinuationExit.code).toBeNull()
      expect(preContinuationExit.signal).toBe("SIGKILL")
      const renewedAfterSnapshot = await pool.query<{ leaseExpiresAt: Date }>(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = GREATEST("leaseExpiresAt" + interval '30 seconds', clock_timestamp() + interval '30 seconds')
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3
          AND "leaseExpiresAt" IS NOT NULL RETURNING "leaseExpiresAt"`,
      [waiter.id, ids.sessionId, preContinuationOwner])
      expect(renewedAfterSnapshot.rowCount).toBe(1)
      expect(renewedAfterSnapshot.rows[0]?.leaseExpiresAt.getTime()).toBeGreaterThan(preContinuationExpiry.getTime())
      const preContinuationExpiryUpdate = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, preContinuationOwner])
      expect(preContinuationExpiryUpdate.rowCount).toBe(1)

      await seedExpiredUnsettledRecoveryBlockers({ pool, taskStore, turnStore: createPgTurnEngineStore(pool), userId: ids.userId,
        suffix, policy, sessionIds: recoveryBlockerSessionIds, taskIds: recoveryBlockerTaskIds, count: 50 })
      const blockerStateBeforeRecovery = await readBlockerDurableState(pool, recoveryBlockerTaskIds)
      expect(blockerStateBeforeRecovery).toHaveLength(50)
      expect(blockerStateBeforeRecovery.map(blocker => blocker.dispatchOutbox)).toEqual(Array.from({ length: 50 }, () => []))
      const blockers = await pool.query<{ blockerCount: number; eligibleCount: number; unsettledCount: number }>(
        `SELECT COUNT(DISTINCT task."id")::int AS "blockerCount",
          (COUNT(DISTINCT task."id") FILTER (WHERE task."status" = 'running' AND task."attemptCount" = 1
            AND task."leaseExpiresAt" <= clock_timestamp() AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
            AND step."status" = 'streaming' AND call."type" = 'tool_call' AND call."status" = 'started'
            AND started."type" = 'tool_call.started' AND started."correlationId" = call."content"->>'toolCallId'
            AND NOT EXISTS (SELECT 1 FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId"
              AND settled."taskId" = task."id" AND settled."correlationId" = started."correlationId"
              AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted'))))::int AS "eligibleCount",
          (COUNT(DISTINCT task."id") FILTER (WHERE started."id" IS NOT NULL AND settled."id" IS NULL))::int AS "unsettledCount"
         FROM "sub_agent_tasks" AS task
         JOIN "agent_steps" AS step ON step."sessionId" = task."sessionId" AND step."turnId" = task."turnId" AND step."taskId" = task."id"
         JOIN "agent_items" AS call ON call."sessionId" = task."sessionId" AND call."turnId" = task."turnId"
           AND call."taskId" = task."id" AND call."stepId" = step."id" AND call."type" = 'tool_call'
         LEFT JOIN "agent_events" AS started ON started."sessionId" = task."sessionId" AND started."taskId" = task."id"
           AND started."itemId" = call."id" AND started."type" = 'tool_call.started'
         LEFT JOIN "agent_events" AS settled ON settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
           AND settled."correlationId" = started."correlationId" AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
         WHERE task."id" = ANY($1::text[])`, [recoveryBlockerTaskIds],
      )
      expect(blockers.rows[0]).toMatchObject({ blockerCount: 50, eligibleCount: 50, unsettledCount: 50 })
      const candidateRank = await readRecoveryCandidateRank(pool, waiter.id, recoveryBlockerTaskIds)
      expect(Number(candidateRank.fixtureBlockerCount)).toBe(50)
      expect(Number(candidateRank.fixtureCandidateCount)).toBe(51)
      expect(Number(candidateRank.fixturePageRank)).toBe(51)
      expect(Number(candidateRank.targetPageRank)).toBeGreaterThan(50)
      expect(Number(candidateRank.candidateCount)).toBeGreaterThanOrEqual(Number(candidateRank.targetPageRank))
      ids.recoveryTargetPageRank = Number(candidateRank.targetPageRank)
      ids.recoveryCandidateCount = Number(candidateRank.candidateCount)
      ids.recoveryFixtureBlockerCount = Number(candidateRank.fixtureBlockerCount)
      ids.recoveryCandidateObservedAt = candidateRank.observedAt.toISOString()
      const corruptedMirror = await pool.query(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set(
          jsonb_set("result", '{request,timeoutMs}', to_jsonb(("result"->'request'->>'timeoutMs')::integer + 1), false),
          '{outcome,status}', '"waiting"'::jsonb, false)
        WHERE "id" = (SELECT "id" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2)
          AND "status" = 'ready' AND "suspendedAt" IS NOT NULL AND "consumedAt" IS NULL RETURNING "id"`, [waiter.id, ids.sessionId])
      expect(corruptedMirror.rowCount).toBe(1)
      const staleProjection = await pool.query<{ status: string; result: { request: { timeoutMs: number }; outcome: { status: string } } }>(
        `SELECT "status", "result" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId])
      expect(staleProjection.rows[0]).toMatchObject({ status: "ready", result: { outcome: { status: "waiting" } } })

      queuePaused = true
      await queue.pause()
      workerC = launchWorker("worker-b-crash-resume", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const recoveryDiagnostic = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RECOVERY_DIAGNOSTIC "))
      const predicateTrace = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RECOVERY_PREDICATE_TRACE "))
      expect(workerC.stdoutText, `Worker C missed the waiter; ${recoveryDiagnostic ?? "diagnostic missing"}; ${predicateTrace ?? "predicate trace missing"}`)
        .toContain(`"id":"${waiter.id}","status":"queued"`)
      const repairedProjection = await pool.query<{ status: string; consumedAt: Date | null;
        result: { request: { timeoutMs: number; targetTaskIds: string[] };
        outcome: { waitId: string; status: string; taskIds: string[]; matchedTaskIds: string[] } }; createdAt: Date; deadlineAt: Date;
        callTimeoutMs: string; callTargetTaskIds: string[] }>(
        `SELECT wait."status", wait."consumedAt", wait."result", wait."createdAt", wait."deadlineAt", call."content"->'input'->>'timeoutMs' AS "callTimeoutMs",
          call."content"->'input'->'taskIds' AS "callTargetTaskIds"
         FROM "agent_wait_conditions" AS wait JOIN "agent_items" AS call ON call."stepId" = wait."stepId" AND call."taskId" = wait."parentTaskId"
           AND call."sessionId" = wait."sessionId" AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2`, [waiter.id, ids.sessionId])
      expect(repairedProjection.rows).toHaveLength(1)
      const repaired = repairedProjection.rows[0]!
      expect(repaired.status).toBe("ready")
      expect(repaired.consumedAt).toBeNull()
      expect(repaired.result.request.timeoutMs).toBe(Number(repaired.callTimeoutMs))
      expect(repaired.result.request.timeoutMs).toBe(repaired.deadlineAt.getTime() - repaired.createdAt.getTime())
      expect(repaired.callTargetTaskIds).toEqual([FIXED_WAIT_TARGET_TASK_ID])
      expect(repaired.result.request.targetTaskIds).toEqual([FIXED_WAIT_TARGET_TASK_ID])
      expect(repaired.result.outcome).toMatchObject({ waitId: expect.any(String), status: "ready",
        taskIds: [FIXED_WAIT_TARGET_TASK_ID], matchedTaskIds: [FIXED_WAIT_TARGET_TASK_ID] })
      const blockerStateAfterRecovery = await readBlockerDurableState(pool, recoveryBlockerTaskIds)
      expect(blockerStateAfterRecovery).toEqual(blockerStateBeforeRecovery)
      const blockerJobs = await queue.getJobs(["waiting", "active", "delayed", "completed", "failed"], 0, -1)
      expect(blockerJobs.filter(job => recoveryBlockerTaskIds.includes(String(job.data.taskId)))).toHaveLength(0)
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [recoveryBlockerSessionIds])
      await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [recoveryBlockerSessionIds])
      recoveryBlockerSessionIds.length = 0
      recoveryBlockerTaskIds.length = 0
      const preContinuationRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        sourceStatus: string; waitStatus: string; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", source."status" AS "sourceStatus",
          wait."status" AS "waitStatus", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(preContinuationRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        sourceStatus: "waiting_for_tool", waitStatus: "ready", consumedAt: null })
      const preContinuationDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      // Recovery fences the in-flight generation before publishing its replacement.
      expect(preContinuationDispatch.rows[0]).toMatchObject({ attemptCount: initialGeneration + 2, publishedAt: null })
      const generation = preContinuationDispatch.rows[0]!.attemptCount
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const resumedOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(`SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`])
      expect(resumedOutbox.rows[0]).toMatchObject({ attemptCount: generation + 1 })
      expect(resumedOutbox.rows[0]?.publishedAt).toBeInstanceOf(Date)
      expect(resumedOutbox.rows[0]!.attemptCount - 1).toBe(generation)
      expect(generation).toBeGreaterThan(initialGeneration)
      const resumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, generation))
      expect(resumeJob).toBeDefined()

      expect(workerC.stdoutText).not.toContain("WORKER_B_RESUME_STEP_STARTED")
      await queue.resume()
      queuePaused = false
      await waitForMarker(workerC, "WORKER_B_RESUME_STEP_STARTED")
      expectRestoredWaitObservation(workerC, "unconsumed")
      const secondCut = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        stepOrdinal: number; stepStatus: string; consumedAt: Date | null; callStatus: string; settledCount: number; modelProfileSnapshot: Record<string, unknown> }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt", next."ordinal" AS "stepOrdinal",
          next."status" AS "stepStatus", next."modelProfileSnapshot", wait."consumedAt", call."status" AS "callStatus",
          (SELECT COUNT(*)::int FROM "agent_events" AS settled WHERE settled."sessionId" = task."sessionId" AND settled."taskId" = task."id"
            AND settled."correlationId" = call."content"->>'toolCallId' AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')) AS "settledCount"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = task."id" AND next."sessionId" = task."sessionId" AND next."turnId" = task."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         JOIN "agent_items" AS call ON call."stepId" = source."id" AND call."taskId" = task."id" AND call."sessionId" = task."sessionId"
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
         WHERE task."id" = $1 AND task."sessionId" = $2 AND next."ordinal" = 2`, [waiter.id, ids.sessionId],
      )
      expect(secondCut.rows[0]).toMatchObject({ taskStatus: "running", attemptCount: 1, stepOrdinal: 2, stepStatus: "streaming",
        consumedAt: null, callStatus: "started", settledCount: 0 })
      expect(secondCut.rows[0]?.modelProfileSnapshot).toEqual(LOOP_FIXTURE_MODEL_PROFILE_SNAPSHOT)
      expect(secondCut.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect(secondCut.rows[0]?.leaseExpiresAt).toBeInstanceOf(Date)
      const secondOwner = secondCut.rows[0]!.leaseOwner
      await stopWorker(workerC)
      const secondExit = await workerC.exited
      expect(secondExit.code).toBeNull()
      expect(secondExit.signal).toBe("SIGKILL")
      const secondExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, secondOwner])
      expect(secondExpiry.rowCount).toBe(1)

      // Each statement is followed by a process kill. A fresh process must reclaim
      // the same task, retry the same source wait, and leave no partial lifecycle.
      expect(SOURCE_LIFECYCLE_CRASH_STAGES).toHaveLength(17)
      const lifecycleRollbackBaseline = await readSourceWaitLifecycle(pool, ids)
      expect(lifecycleRollbackBaseline.wait).toMatchObject({ status: "ready", consumedAt: null })
      expect(Object.keys(lifecycleRollbackBaseline.wait!.result).sort()).toEqual(["outcome", "request"])
      expect(lifecycleRollbackBaseline.call).toMatchObject({ status: "started", revision: 0,
        content: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
          input: { idempotencyKey: SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id), taskIds: [FIXED_WAIT_TARGET_TASK_ID] } } })
      expect(lifecycleRollbackBaseline.results).toHaveLength(0)
      expect(lifecycleRollbackBaseline.events.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
      expect(lifecycleRollbackBaseline.outboxes).toHaveLength(2)
      expect(lifecycleRollbackBaseline.eventSequence).toEqual(expect.any(String))
      const previousDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(previousDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)
      let previousPublishedAttemptCount = previousDispatch.rows[0]!.attemptCount
      let rollbackDispatchGeneration = 0
      let rollbackPublishedAttemptCount = 0
      for (const stage of SOURCE_LIFECYCLE_CRASH_STAGES) {
        queuePaused = true
        await queue.pause()
        ids.sourceLifecycleCrashStage = stage
        workerH = launchWorker("worker-b-crash-source-lifecycle", queueName, ids)
        await waitForMarker(workerH, "WORKER_B_RECOVERED")
        const recoveredLine = workerH.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RECOVERED "))
        const recovered = JSON.parse(recoveredLine!.slice("WORKER_B_RECOVERED ".length)) as {
          reclaimed: number; rows: Array<{ id: string; status: string }>
        }
        expect(recovered.reclaimed).toBeGreaterThan(0)
        expect(recovered.rows).toContainEqual({ id: waiter.id, status: "queued" })
        const rollbackCutDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
          `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
            AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
        )
        expect(rollbackCutDispatch.rows[0]).toMatchObject({ attemptCount: previousPublishedAttemptCount + 1, publishedAt: null })
        rollbackDispatchGeneration = rollbackCutDispatch.rows[0]!.attemptCount
        await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
        const rollbackCutPublished = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
          `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
            AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
        )
        expect(rollbackCutPublished.rows[0]).toMatchObject({ attemptCount: rollbackDispatchGeneration + 1 })
        expect(rollbackCutPublished.rows[0]?.publishedAt).toBeInstanceOf(Date)
        rollbackPublishedAttemptCount = rollbackCutPublished.rows[0]!.attemptCount
        previousPublishedAttemptCount = rollbackPublishedAttemptCount
        await queue.resume()
        queuePaused = false
        await waitForMarker(workerH, "WORKER_B_SOURCE_LIFECYCLE_CRASH_CUT")
        const rollbackMarker = workerH.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_SOURCE_LIFECYCLE_CRASH_CUT "))
        expect(JSON.parse(rollbackMarker!.slice("WORKER_B_SOURCE_LIFECYCLE_CRASH_CUT ".length))).toEqual({ stage, writeApplied: true })
        expect(workerH.stdoutText + workerH.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id))
        expect(await readSourceWaitLifecycle(pool, ids)).toEqual(lifecycleRollbackBaseline)
        const rollbackLease = await pool.query<{ leaseOwner: string | null }>(
          `SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
        )
        expect(rollbackLease.rows[0]?.leaseOwner).toEqual(expect.any(String))
        await stopWorker(workerH)
        const rollbackCutExit = await workerH.exited
        expect(rollbackCutExit.code).toBeNull()
        expect(rollbackCutExit.signal).toBe("SIGKILL")
        const rollbackExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
          WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
        [waiter.id, ids.sessionId, rollbackLease.rows[0]!.leaseOwner])
        expect(rollbackExpiry.rowCount).toBe(1)
        expect(await readSourceWaitLifecycle(pool, ids)).toEqual(lifecycleRollbackBaseline)
      }
      const sourceDispatchAfterRollback = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(sourceDispatchAfterRollback.rows[0]).toMatchObject({
        attemptCount: rollbackPublishedAttemptCount, publishedAt: expect.any(Date),
      })

      // Hold a stalled prior generation until recovery and replacement dispatch are asserted.
      queuePaused = true
      await queue.pause()
      workerD = launchWorker("worker-b-crash-before-claim", queueName, ids)
      await waitForMarker(workerD, "WORKER_B_RECOVERED")
      const continuationRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        stepStatus: string; waitStatus: string; consumedAt: Date | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", next."status" AS "stepStatus",
          wait."status" AS "waitStatus", wait."consumedAt"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = task."id" AND next."sessionId" = task."sessionId" AND next."turnId" = task."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         WHERE task."id" = $1 AND task."sessionId" = $2 AND next."ordinal" = 2`, [waiter.id, ids.sessionId],
      )
      expect(continuationRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        stepStatus: "streaming", waitStatus: "ready", consumedAt: null })
      const continuationDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(continuationDispatch.rows[0]).toMatchObject({ attemptCount: rollbackDispatchGeneration + 2, publishedAt: null })
      const finalGeneration = continuationDispatch.rows[0]!.attemptCount
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const ackResumeDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(ackResumeDispatch.rows[0]).toMatchObject({ attemptCount: finalGeneration + 1 })
      expect(ackResumeDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)
      await queue.resume()
      queuePaused = false

      await waitForMarker(workerD, "WORKER_B_RESUME_ACK_COMMITTED")
      const ackCut = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null;
        sourceStepId: string; sourceAttempt: number; sourceOrdinal: number;
        waitId: string; waitStatus: string; consumedAt: Date | null; continuationStepId: string; continuationOrdinal: number;
        continuationStatus: string; modelProfileSnapshot: Record<string, unknown> }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
          source."id" AS "sourceStepId", source."attempt" AS "sourceAttempt", source."ordinal" AS "sourceOrdinal",
          wait."id" AS "waitId", wait."status" AS "waitStatus", wait."consumedAt", next."id" AS "continuationStepId",
          next."ordinal" AS "continuationOrdinal", next."status" AS "continuationStatus", next."modelProfileSnapshot"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = source."taskId" AND next."sessionId" = source."sessionId" AND next."turnId" = source."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      const acknowledged = ackCut.rows[0]
      expect(acknowledged).toMatchObject({ taskStatus: "running", attemptCount: 1, continuationStepId: `task:${waiter.id}:step:1:attempt:1`,
        sourceStepId: `task:${waiter.id}:step:0:attempt:1`, sourceAttempt: 1, sourceOrdinal: 0,
        continuationOrdinal: 2, continuationStatus: "streaming", waitStatus: "ready" })
      expect(acknowledged?.leaseOwner).toEqual(expect.any(String))
      expect(acknowledged?.leaseExpiresAt).toBeInstanceOf(Date)
      expect(acknowledged?.consumedAt).toBeInstanceOf(Date)
      expect(acknowledged?.modelProfileSnapshot).toEqual(LOOP_FIXTURE_MODEL_PROFILE_SNAPSHOT)
      const acknowledgedAt = acknowledged!.consumedAt
      const acknowledgedOwner = acknowledged!.leaseOwner
      const committedSourceLifecycle = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(committedSourceLifecycle, ids, acknowledgedOwner)
      expect(workerD.stdoutText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id))
      await waitForMarker(workerD, "WORKER_B_LOOP_PRE_CLAIM_ORPHAN")
      const orphanCallId = `${REISSUED_WAIT_TOOL_CALL_PREFIX}${waiter.id}:attempt:${acknowledged!.sourceAttempt}:orphan`
      // Reissue uses the already validated projection from the durable wait receipt; the source item keeps its raw private input.
      const projectedWaitKey = safeProjectedWaitKey({ taskIds: [FIXED_WAIT_TARGET_TASK_ID], mode: "any", timeoutMs: 30_000,
        idempotencyKey: SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id) })
      expect(projectedWaitKey).toBe("api_key=[REDACTED]")
      const preClaimState = await readWaitClaimState(pool, ids, acknowledged!.continuationStepId, orphanCallId, acknowledged!.sourceAttempt)
      expect(preClaimState.callCount).toBe(1)
      expect(preClaimState.claimCount).toBe(0)
      expect(preClaimState.itemStartedCount).toBe(1)
      expect(preClaimState.resultCount).toBe(0)
      expect(preClaimState.call).toMatchObject({ status: "started", revision: 0, stepId: acknowledged!.continuationStepId,
        content: { toolCallId: orphanCallId, toolName: "wait_subagents", toolVersion: "1",
          input: { taskIds: [FIXED_WAIT_TARGET_TASK_ID], mode: "any", timeoutMs: 30_000,
            idempotencyKey: projectedWaitKey } } })
      expect(preClaimState.lifecycle.map(event => event.type)).toEqual(["item.started"])
      expect(preClaimState.claimOutboxCount).toBe(0)
      const staleLeaseMarker = workerD.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_STALE_LEASE_SNAPSHOT_ACCEPTED "))
      const staleLeaseEvidence = JSON.parse(staleLeaseMarker!.slice("WORKER_B_STALE_LEASE_SNAPSHOT_ACCEPTED ".length)) as {
        snapshotExpiresAt: string; logicalNow: string; liveDbLeaseExpiresAt: string; loaded: boolean
      }
      expect(staleLeaseEvidence.loaded).toBe(true)
      expect(Date.parse(staleLeaseEvidence.logicalNow)).toBeGreaterThan(Date.parse(staleLeaseEvidence.snapshotExpiresAt))
      expect(Date.parse(staleLeaseEvidence.liveDbLeaseExpiresAt)).toBeGreaterThan(Date.parse(staleLeaseEvidence.logicalNow))
      const preClaimMarker = workerD.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_PRE_CLAIM_ORPHAN "))
      expect(JSON.parse(preClaimMarker!.slice("WORKER_B_LOOP_PRE_CLAIM_ORPHAN ".length))).toMatchObject({
        callId: orphanCallId, stepId: acknowledged!.continuationStepId, waitId: acknowledged!.waitId,
        exactInput: true, executorCalls: 0,
      })
      const claimedWaitCallId = orphanCallId
      await stopWorker(workerD)
      const ackCutExit = await workerD.exited
      expect(ackCutExit.code).toBeNull()
      expect(ackCutExit.signal).toBe("SIGKILL")
      const acknowledgedExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, acknowledgedOwner])
      expect(acknowledgedExpiry.rowCount).toBe(1)
      const staleOwnerTask = await taskStore.get(waiter.id, ids.sessionId)
      const staleOwnerExpiry = acknowledged!.leaseExpiresAt
      if (!staleOwnerTask || !(staleOwnerExpiry instanceof Date)) throw new Error("fixture_stale_source_owner_snapshot_missing")
      const staleOwnerLease: SubagentLease = { ...staleOwnerTask, ownerId: acknowledgedOwner!, leaseExpiresAt: staleOwnerExpiry,
        signal: new AbortController().signal }
      const beforeStaleOwnerWrite = await readSourceWaitLifecycle(pool, ids)
      let staleOwnerWriteAccepted = false
      try {
        staleOwnerWriteAccepted = await commitDurableSubagentWaitResume(pool, staleOwnerLease, {
          waitId: acknowledged!.waitId, stepId: acknowledged!.sourceStepId, nextStepOrdinal: acknowledged!.continuationOrdinal, now: new Date(),
        })
      } catch { /* stale owner is expected to fail its live lease fence */ }
      expect(staleOwnerWriteAccepted).toBe(false)
      expect(await readSourceWaitLifecycle(pool, ids)).toEqual(beforeStaleOwnerWrite)

      workerE = launchWorker("worker-b-loop-claim-recovery-cut", queueName, ids)
      await waitForMarker(workerE, "WORKER_B_RECOVERED")
      const acknowledgedRecovery = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null;
        sourceStepId: string; sourceAttempt: number; sourceOrdinal: number;
        waitStatus: string; consumedAt: Date | null; continuationStepId: string; continuationOrdinal: number; continuationStatus: string }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner", source."id" AS "sourceStepId",
          source."attempt" AS "sourceAttempt", source."ordinal" AS "sourceOrdinal", wait."status" AS "waitStatus", wait."consumedAt",
          next."id" AS "continuationStepId", next."ordinal" AS "continuationOrdinal", next."status" AS "continuationStatus"
         FROM "sub_agent_tasks" AS task JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = task."id" AND wait."sessionId" = task."sessionId"
         JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."taskId" = task."id" AND source."sessionId" = task."sessionId"
         JOIN "agent_steps" AS next ON next."taskId" = source."taskId" AND next."sessionId" = source."sessionId" AND next."turnId" = source."turnId"
           AND next."attempt" = source."attempt" AND next."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later
             WHERE later."taskId" = source."taskId" AND later."sessionId" = source."sessionId" AND later."turnId" = source."turnId"
               AND later."attempt" = source."attempt" AND later."ordinal" > source."ordinal")
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(acknowledgedRecovery.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null,
        sourceStepId: acknowledged!.sourceStepId, sourceAttempt: acknowledged!.sourceAttempt, sourceOrdinal: acknowledged!.sourceOrdinal,
        continuationStepId: acknowledged!.continuationStepId, continuationOrdinal: 2, continuationStatus: "streaming", waitStatus: "ready" })
      expect(acknowledgedRecovery.rows[0]?.consumedAt).toEqual(acknowledgedAt)
      const acknowledgedDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(acknowledgedDispatch.rows[0]).toMatchObject({ attemptCount: finalGeneration + 2, publishedAt: null })
      const postAckGeneration = acknowledgedDispatch.rows[0]!.attemptCount
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const finalDispatch = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(finalDispatch.rows[0]).toMatchObject({ attemptCount: postAckGeneration + 1 })
      expect(finalDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)
      await waitForMarker(workerE, "WORKER_B_LOOP_RESTORED")
      const orphanRestoredMarker = workerE.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESTORED "))
      expect(JSON.parse(orphanRestoredMarker!.slice("WORKER_B_LOOP_RESTORED ".length))).toMatchObject({
        phase: "claim-recovery-cut", waitId: acknowledged!.waitId, recoveryCallId: orphanCallId,
        recoveryStepId: acknowledged!.continuationStepId, logicalStepOrdinal: 1, physicalContinuationOrdinal: 2,
        resumeNextOrdinal: 2, orphanCallIds: [orphanCallId],
      })
      expectRestoredWaitObservation(workerE, "consumed")
      await waitForMarker(workerE, "WORKER_B_LOOP_CLAIM_BEFORE_RESULT")
      const claimState = await readWaitClaimState(pool, ids, acknowledged!.continuationStepId, claimedWaitCallId, acknowledged!.sourceAttempt)
      expect(claimState.callCount).toBe(1)
      expect(claimState.claimCount).toBe(1)
      expect(claimState.itemStartedCount).toBe(1)
      expect(claimState.resultCount).toBe(0)
      expect(claimState.call).toMatchObject({ status: "started", stepId: acknowledged!.continuationStepId,
        content: { toolCallId: claimedWaitCallId, toolName: "wait_subagents", toolVersion: "1",
          input: { taskIds: [FIXED_WAIT_TARGET_TASK_ID], mode: "any", timeoutMs: 30_000,
            idempotencyKey: projectedWaitKey } } })
      expect(claimState.claim).toMatchObject({ type: "tool_call.started", actor: "subagent", itemId: claimState.call!.id,
        correlationId: claimedWaitCallId, causationId: claimState.itemStarted!.id,
        idempotencyKey: `task:${waiter.id}:event:child-wait-claim:${acknowledged!.sourceAttempt}:${acknowledged!.continuationStepId}`,
        payload: { toolCallId: claimedWaitCallId, toolName: "wait_subagents", taskId: waiter.id } })
      expect(claimState.itemStarted).toMatchObject({ type: "item.started", itemId: claimState.call!.id })
      expect(claimState.result).toBeUndefined()
      expect(claimState.claimOutboxCount).toBe(1)
      const waitsAtClaim = await pool.query<{ id: string; status: string; consumedAt: Date | null }>(
        `SELECT "id", "status", "consumedAt" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2`,
        [waiter.id, ids.sessionId],
      )
      expect(waitsAtClaim.rows).toHaveLength(1)
      expect(waitsAtClaim.rows[0]).toMatchObject({ id: acknowledged!.waitId, status: "ready" })
      expect(waitsAtClaim.rows[0]?.consumedAt).toEqual(acknowledgedAt)
      const claimMarker = workerE.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_CLAIM_BEFORE_RESULT "))
      expect(JSON.parse(claimMarker!.slice("WORKER_B_LOOP_CLAIM_BEFORE_RESULT ".length))).toMatchObject({ callId: orphanCallId,
        stepId: acknowledged!.continuationStepId, waitId: acknowledged!.waitId, modelCalls: 0,
        executorCalls: 0, dispatcherCalls: 0, callStatus: "started", callRevision: 0, claimCount: 1, resultCount: 0 })
      const reentryLease = await pool.query<{ leaseOwner: string | null; attemptCount: number }>(
        `SELECT "leaseOwner", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(reentryLease.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect(reentryLease.rows[0]?.leaseOwner).not.toBe(acknowledgedOwner)
      expect(reentryLease.rows[0]?.attemptCount).toBe(acknowledged!.attemptCount)
      const reenteredSourceLifecycle = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(reenteredSourceLifecycle, ids, acknowledgedOwner)
      // eventSequence is session-wide. The continuation model/claim advances it while
      // the source wait's own rows and outboxes must remain byte-for-byte unchanged.
      const firstNewSequence = BigInt(committedSourceLifecycle.eventSequence!)
      const latestSequence = BigInt(reenteredSourceLifecycle.eventSequence!)
      expect(latestSequence - firstNewSequence).toBe(7n)
      const resumedEvents = await pool.query<{ id: string; sequence: string; type: string; itemId: string | null;
        correlationId: string; causationId: string | null; idempotencyKey: string }>(
        `SELECT "id", "sequence"::text AS "sequence", "type", "itemId", "correlationId", "causationId", "idempotencyKey"
         FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND "sequence" > $4::bigint AND "sequence" <= $5::bigint ORDER BY "sequence"`,
        [ids.sessionId, ids.turnId, waiter.id, firstNewSequence.toString(), latestSequence.toString()],
      )
      const continuationItemId = `task:${waiter.id}:item:tool-call:${orphanCallId}:attempt:${acknowledged!.sourceAttempt}`
      const resumedTypes = ["step.started", "cognitive.agenda", "model.started", "model.completed", "model.usage", "item.started", "tool_call.started"]
      expect(resumedEvents.rows.map(event => event.type)).toEqual(resumedTypes)
      expect(resumedEvents.rows.map(event => BigInt(event.sequence))).toEqual(
        resumedTypes.map((_type, index) => firstNewSequence + BigInt(index + 1)),
      )
      expect(resumedEvents.rows.map(({ type, itemId, correlationId, idempotencyKey }) => ({ type, itemId, correlationId, idempotencyKey }))).toEqual([
        { type: "step.started", itemId: null, correlationId: acknowledged!.continuationStepId,
          idempotencyKey: `task:${waiter.id}:event:step-started:${acknowledged!.continuationStepId}` },
        { type: "cognitive.agenda", itemId: null, correlationId: acknowledged!.continuationStepId,
          idempotencyKey: `task:${waiter.id}:event:cognitive.agenda:${acknowledged!.continuationStepId}` },
        { type: "model.started", itemId: null, correlationId: acknowledged!.continuationStepId,
          idempotencyKey: `task:${waiter.id}:event:model-started:${acknowledged!.continuationStepId}` },
        { type: "model.completed", itemId: null, correlationId: acknowledged!.continuationStepId,
          idempotencyKey: `task:${waiter.id}:event:model-completed:${acknowledged!.continuationStepId}` },
        { type: "model.usage", itemId: null, correlationId: acknowledged!.continuationStepId,
          idempotencyKey: `task:${waiter.id}:event:model-usage:${acknowledged!.continuationStepId}` },
        { type: "item.started", itemId: continuationItemId, correlationId: acknowledged!.continuationStepId,
          idempotencyKey: `task:${waiter.id}:event:item-started:${continuationItemId}` },
        { type: "tool_call.started", itemId: continuationItemId, correlationId: orphanCallId,
          idempotencyKey: `task:${waiter.id}:event:child-wait-claim:${acknowledged!.sourceAttempt}:${acknowledged!.continuationStepId}` },
      ])
      const turnStarted = await pool.query<{ id: string; sequence: string }>(
        `SELECT "id", "sequence"::text AS "sequence" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task.started'
           AND "itemId" IS NULL AND "correlationId" = $2 AND "idempotencyKey" = $4`,
        [ids.sessionId, ids.turnId, waiter.id, `task:${waiter.id}:event:turn-started`],
      )
      expect(turnStarted.rows).toHaveLength(1)
      expect(BigInt(turnStarted.rows[0]!.sequence)).toBeLessThan(BigInt(resumedEvents.rows[0]!.sequence))
      expect(resumedEvents.rows[0]?.causationId).toBe(turnStarted.rows[0]!.id)
      for (let index = 1; index < resumedEvents.rows.length; index += 1) {
        expect(resumedEvents.rows[index]?.causationId).toBe(resumedEvents.rows[index - 1]?.id)
      }
      expect({ wait: reenteredSourceLifecycle.wait, call: reenteredSourceLifecycle.call,
        results: reenteredSourceLifecycle.results, events: reenteredSourceLifecycle.events,
        outboxes: reenteredSourceLifecycle.outboxes }).toEqual({ wait: committedSourceLifecycle.wait,
        call: committedSourceLifecycle.call, results: committedSourceLifecycle.results,
        events: committedSourceLifecycle.events, outboxes: committedSourceLifecycle.outboxes })
      let replacedOwnerWriteAccepted = false
      try {
        replacedOwnerWriteAccepted = await commitDurableSubagentWaitResume(pool, staleOwnerLease, {
          waitId: acknowledged!.waitId, stepId: acknowledged!.sourceStepId, nextStepOrdinal: acknowledged!.continuationOrdinal, now: new Date(),
        })
      } catch { /* replacement owner must fence the previous lease */ }
      expect(replacedOwnerWriteAccepted).toBe(false)
      expect(await readSourceWaitLifecycle(pool, ids)).toEqual(reenteredSourceLifecycle)
      expect(workerE.stdoutText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id))
      expect(workerD.stdoutText + workerE.stdoutText).not.toContain("sourceLifecycleRecovery")
      const sessionOutboxPrivacy = await pool.query<{ topic: string; payload: unknown }>(
        `SELECT "topic", "payload" FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.sessionId],
      )
      expect(JSON.stringify(sessionOutboxPrivacy.rows)).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id))
      await stopWorker(workerE)
      const claimCutExit = await workerE.exited
      expect(claimCutExit.code).toBeNull()
      expect(claimCutExit.signal).toBe("SIGKILL")
      const claimCutLease = await pool.query<{ leaseOwner: string | null }>(`SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [waiter.id, ids.sessionId])
      const claimCutOwner = claimCutLease.rows[0]?.leaseOwner
      expect(claimCutOwner).toEqual(expect.any(String))
      const claimCutExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, claimCutOwner])
      expect(claimCutExpiry.rowCount).toBe(1)

      const validReceiptRows = await pool.query<{ id: string; result: Record<string, unknown> }>(
        `SELECT "id", "result" FROM "agent_wait_conditions" WHERE "id" = $1 AND "parentTaskId" = $2
          AND "sessionId" = $3 AND "consumedAt" IS NOT NULL`, [acknowledged!.waitId, waiter.id, ids.sessionId])
      expect(validReceiptRows.rows).toHaveLength(1)
      const validWaitResult = validReceiptRows.rows[0]!.result
      const validOutcome = asObject(validWaitResult.outcome)
      expect(validOutcome.deadlineAt).toEqual(expect.any(String))
      expect(Array.isArray(validOutcome.tasks)).toBe(true)
      const malformedOutcomeCases: Array<{ label: string; corrupt(outcome: Record<string, unknown>): void }> = [
        { label: "missing outcome deadlineAt", corrupt: outcome => { delete outcome.deadlineAt } },
        { label: "missing outcome tasks", corrupt: outcome => { delete outcome.tasks } },
        { label: "invalid outcome task status", corrupt: outcome => {
          const tasks = outcome.tasks
          if (!Array.isArray(tasks) || tasks.length !== 1) throw new Error("valid wait receipt task fixture is unavailable")
          outcome.tasks = [{ ...asObject(tasks[0]), status: "not-a-task-status" }]
        } },
      ]
      for (const malformed of malformedOutcomeCases) {
        await expectMalformedClaimOutcomeRejected(pool, taskStore, ids, acknowledged!.waitId,
          validWaitResult, malformed.label, malformed.corrupt)
      }

      workerF = launchWorker("worker-b-loop-claim-item-completed-cut", queueName, ids)
      await waitForMarker(workerF, "WORKER_B_RECOVERED")
      const workerFRecovery = parseRecoveryMarker(workerF)
      const workerFWaiter = workerFRecovery.rows?.find(row => row.id === waiter.id)
      const workerFTrace = boundedRecoveryTrace(workerF)
      const workerFRecoveryReason = workerFWaiter
        ? workerFWaiter.status === "queued" ? null : "waiter_reclaimed_with_nonqueued_status"
        : typeof workerFTrace?.rejectionStage === "string" ? workerFTrace.rejectionStage
          : workerFRecovery.rows ? "waiter_not_in_reclaimed_rows" : "reclaimed_rows_missing_or_unparseable"
      const workerFBlockerDiagnostic = workerFWaiter?.status === "queued" ? null
        : await diagnoseWorkerFBlocker(pool, ids, acknowledged!.continuationStepId, PHONE_SHAPED_WAIT_TOOL_CALL_ID, orphanCallId)
      expect(workerFWaiter?.status, `WorkerF did not reclaim the waiter: ${JSON.stringify({
        targetReclaimed: Boolean(workerFWaiter), targetStatus: workerFWaiter?.status ?? null,
        reason: workerFRecoveryReason, reclaimedRowCount: workerFRecovery.rows?.length ?? null, trace: workerFTrace,
        blockerDiagnostic: workerFBlockerDiagnostic,
      })}`).toBe("queued")
      const resultCutDispatch = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner" FROM "sub_agent_tasks" AS task
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(resultCutDispatch.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null })
      const resultCutOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      const resultCutGeneration = resultCutOutbox.rows[0]!.attemptCount
      expect(resultCutOutbox.rows[0]?.publishedAt).toBeNull()
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const resultCutDispatchPublished = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(resultCutDispatchPublished.rows[0]).toMatchObject({ attemptCount: resultCutGeneration + 1 })
      expect(resultCutDispatchPublished.rows[0]?.publishedAt).toBeInstanceOf(Date)
      await waitForMarker(workerF, "WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT")
      expectRestoredWaitObservation(workerF, "consumed")
      const callRowCut = await readWaitClaimState(pool, ids, acknowledged!.continuationStepId, orphanCallId, acknowledged!.sourceAttempt)
      expect(callRowCut.call).toMatchObject({ status: "completed", revision: 1, content: { toolCallId: orphanCallId } })
      expect(callRowCut.claimCount).toBe(1)
      expect(callRowCut.itemStartedCount).toBe(1)
      expect(callRowCut.resultCount).toBe(0)
      expect(callRowCut.lifecycle.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
      const callRowCutMarker = workerF.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT "))
      expect(JSON.parse(callRowCutMarker!.slice("WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT ".length))).toMatchObject({
        callId: orphanCallId, stepId: acknowledged!.continuationStepId, waitId: acknowledged!.waitId,
        modelCalls: 0, executorCalls: 0, dispatcherCalls: 0, callStatus: "completed", callRevision: 1,
        claimCount: 1, itemCompletedEventCount: 0, resultCount: 0,
      })
      await expectCompletedClaimBeforeItemEventSafety(pool, ids, acknowledged!.continuationStepId, orphanCallId, acknowledged!.sourceAttempt)
      await stopWorker(workerF)
      const resultCutExit = await workerF.exited
      expect(resultCutExit.code).toBeNull()
      expect(resultCutExit.signal).toBe("SIGKILL")
      const resultCutLease = await pool.query<{ leaseOwner: string | null }>(`SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [waiter.id, ids.sessionId])
      const resultCutOwner = resultCutLease.rows[0]?.leaseOwner
      expect(resultCutOwner).toEqual(expect.any(String))
      const resultExpiry = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [waiter.id, ids.sessionId, resultCutOwner])
      expect(resultExpiry.rowCount).toBe(1)
      const abandonedBullJob = await queue.getJob(subagentDispatchJobId(waiter.id, resultCutGeneration))
      expect(abandonedBullJob).toBeDefined()
      expect(await abandonedBullJob!.getState()).toBe("active")

      workerG = launchWorker("worker-b-loop-final", queueName, ids)
      await waitForMarker(workerG, "WORKER_B_RECOVERED")
      const completedRecoveryDispatch = await pool.query<{ taskStatus: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT task."status" AS "taskStatus", task."attemptCount", task."leaseOwner" FROM "sub_agent_tasks" AS task
         WHERE task."id" = $1 AND task."sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(completedRecoveryDispatch.rows[0]).toMatchObject({ taskStatus: "queued", attemptCount: 1, leaseOwner: null })
      const completedRecoveryOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      const completedRecoveryGeneration = completedRecoveryOutbox.rows[0]!.attemptCount
      expect(completedRecoveryGeneration).toBe(resultCutDispatchPublished.rows[0]!.attemptCount + 1)
      expect(completedRecoveryOutbox.rows[0]?.publishedAt).toBeNull()
      expect(await abandonedBullJob!.getState()).toBe("active")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const completedRecoveryPublished = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${waiter.id}`],
      )
      expect(completedRecoveryPublished.rows[0]).toMatchObject({ attemptCount: completedRecoveryGeneration + 1 })
      expect(completedRecoveryPublished.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const currentDispatchJob = await queue.getJob(subagentDispatchJobId(waiter.id, completedRecoveryGeneration))
      expect(currentDispatchJob).toBeDefined()
      expect(await currentDispatchJob!.getState()).toBe("waiting")
      await queueRedis.set(workerStartGateKey(ids), "start", "EX", 60)
      await waitForMarker(workerG, "WORKER_B_PROCESSING_RELEASED")
      await waitForMarker(workerG, "WORKER_B_LOOP_RESTORED")
      const finalRestoredMarker = workerG.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESTORED "))
      expect(JSON.parse(finalRestoredMarker!.slice("WORKER_B_LOOP_RESTORED ".length))).toMatchObject({
        phase: "final", waitId: acknowledged!.waitId, recoveryCallId: orphanCallId,
        recoveryStepId: acknowledged!.continuationStepId, logicalStepOrdinal: 1, physicalContinuationOrdinal: 2,
        resumeNextOrdinal: 2, orphanCallIds: [],
      })
      expectRestoredWaitObservation(workerG, "consumed")
      await waitForMarker(workerG, "WORKER_B_LOOP_RESUMED")
      const finalLoopMarker = workerG.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESUMED "))
      expect(JSON.parse(finalLoopMarker!.slice("WORKER_B_LOOP_RESUMED ".length))).toMatchObject({
        phase: "final", status: "completed", finalText: FINAL_MARKER,
        invocations: [`task:${waiter.id}:step:2:attempt:1`], executorCalls: 0, dispatcherCalls: 0,
        continuationStepId: acknowledged!.continuationStepId, logicalStepOrdinal: 1, physicalContinuationOrdinal: 2,
      })
      await waitForMarker(workerG, "WORKER_B_RESUMED")
      const resumedLine = workerG.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RESUMED "))
      const resumedOutcome = JSON.parse(resumedLine!.slice("WORKER_B_RESUMED ".length)) as { dispatchGeneration?: number }
      expect(resumedOutcome.dispatchGeneration).toBe(completedRecoveryGeneration)
      const staleDispatchLines = workerG.stdoutText.split(/\r?\n/).filter(line => line.startsWith("WORKER_B_STALE_DISPATCH_SKIPPED "))
      for (const line of staleDispatchLines) {
        const stale = JSON.parse(line.slice("WORKER_B_STALE_DISPATCH_SKIPPED ".length)) as { dispatchGeneration?: number }
        expect(stale.dispatchGeneration).toBe(resultCutGeneration)
      }
      const finalExit = await workerG.exited
      expect(finalExit.code).toBe(0)
      expect(finalExit.signal).toBeNull()
      expect(workerG.stdoutText.match(/WORKER_B_RESUMED/g) ?? []).toHaveLength(1)
      const finished = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; failureReason: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(finished.rows[0], JSON.stringify({ workerOutput: workerG.stdoutText, workerError: workerG.stderrText,
        failureReason: finished.rows[0]?.failureReason }))
        .toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null })
      const durable = await pool.query<{ status: string; consumedAt: Date | null; targetTaskIds: string[];
        result: { request: { targetTaskIds: string[] };
          outcome: { status: string; taskIds: string[]; matchedTaskIds: string[] } } }>(
        `SELECT "status", "consumedAt", "targetTaskIds", "result" FROM "agent_wait_conditions"
         WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [waiter.id, ids.sessionId],
      )
      expect(durable.rows).toHaveLength(1)
      expect(durable.rows[0]).toMatchObject({ status: "ready", targetTaskIds: [FIXED_WAIT_TARGET_TASK_ID],
        result: { request: { targetTaskIds: [FIXED_WAIT_TARGET_TASK_ID] },
          outcome: { status: "ready", taskIds: [FIXED_WAIT_TARGET_TASK_ID], matchedTaskIds: [FIXED_WAIT_TARGET_TASK_ID] } } })
      expect(durable.rows[0]?.result).toHaveProperty("sourceLifecycleRecovery.schemaVersion", "child-wait-source-lifecycle.v1")
      expect(durable.rows[0]?.consumedAt).toBeInstanceOf(Date)
      expect(durable.rows[0]?.consumedAt).toEqual(acknowledgedAt)
      const continuation = await pool.query<{ id: string; ordinal: number; attempt: number; status: string; inputTokens: number;
        outputTokens: number; estimatedCostUsd: number }>(
        `SELECT "id", "ordinal", "attempt", "status", "inputTokens", "outputTokens", "estimatedCostUsd"::float8 AS "estimatedCostUsd"
         FROM "agent_steps" WHERE "taskId" = $1 AND "sessionId" = $2 ORDER BY "ordinal"`, [waiter.id, ids.sessionId],
      )
      expect(continuation.rows).toEqual([
        { id: `task:${waiter.id}:step:0:attempt:1`, ordinal: 0, attempt: 1, status: "waiting_for_tool",
          inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
        { id: `task:${waiter.id}:step:1:attempt:1`, ordinal: 2, attempt: 1, status: "completed",
          inputTokens: 37, outputTokens: 13, estimatedCostUsd: 0.12345679 },
        { id: `task:${waiter.id}:step:2:attempt:1`, ordinal: 3, attempt: 1, status: "completed",
          inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 },
      ])
      const finalItems = await pool.query<{ content: Record<string, unknown> }>(
        `SELECT "content" FROM "agent_items" WHERE "taskId" = $1 AND "sessionId" = $2 AND "content"->>'text' = $3`,
        [waiter.id, ids.sessionId, FINAL_MARKER],
      )
      expect(finalItems.rows).toHaveLength(1)
      expect(finalItems.rows[0]?.content).toMatchObject({ text: FINAL_MARKER })
      const persistedWaitCalls = await pool.query<{ id: string; status: string; revision: number; toolCallId: string }>(
        `SELECT "id", "status", "revision", "content"->>'toolCallId' AS "toolCallId" FROM "agent_items"
         WHERE "taskId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'tool_call'
           AND "content"->>'toolName' = 'wait_subagents'`, [waiter.id, ids.sessionId, ids.turnId],
      )
      expect(persistedWaitCalls.rows).toHaveLength(2)
      expect(persistedWaitCalls.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: sourceCallItemId, toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, status: "completed", revision: 1 }),
        expect.objectContaining({ toolCallId: orphanCallId, status: "completed", revision: 1 }),
      ]))
      const [sourceTerminalEvents, sourceResultItems] = await Promise.all([
        pool.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND ("itemId" = $4 OR "correlationId" = $5)
          AND "type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')`,
        [ids.sessionId, ids.turnId, waiter.id, sourceCallItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID]),
        pool.query(`SELECT "id" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "stepId" = $4 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $5`,
        [ids.sessionId, ids.turnId, waiter.id, `task:${waiter.id}:step:0:attempt:1`, PHONE_SHAPED_WAIT_TOOL_CALL_ID]),
      ])
      expect(sourceTerminalEvents.rows).toHaveLength(1)
      expect(sourceResultItems.rows).toHaveLength(1)
      const finalSourceLifecycle = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(finalSourceLifecycle, ids, acknowledgedOwner)
      expect(BigInt(finalSourceLifecycle.eventSequence!)).toBeGreaterThan(BigInt(reenteredSourceLifecycle.eventSequence!))
      expect({ wait: finalSourceLifecycle.wait, call: finalSourceLifecycle.call,
        results: finalSourceLifecycle.results, events: finalSourceLifecycle.events,
        outboxes: finalSourceLifecycle.outboxes }).toEqual({ wait: committedSourceLifecycle.wait,
        call: committedSourceLifecycle.call, results: committedSourceLifecycle.results,
        events: committedSourceLifecycle.events, outboxes: committedSourceLifecycle.outboxes })
      const recoveredClaimState = await readWaitClaimState(pool, ids, acknowledged!.continuationStepId, orphanCallId, acknowledged!.sourceAttempt)
      expect(recoveredClaimState.callCount).toBe(1)
      expect(recoveredClaimState.claimCount).toBe(1)
      expect(recoveredClaimState.itemStartedCount).toBe(1)
      expect(recoveredClaimState.resultCount).toBe(1)
      expect(recoveredClaimState.claimOutboxCount).toBe(1)
      expect(recoveredClaimState.call).toMatchObject({ status: "completed", content: { toolCallId: orphanCallId } })
      expect(recoveredClaimState.claim).toMatchObject({ type: "tool_call.started", itemId: recoveredClaimState.call!.id,
        correlationId: orphanCallId, causationId: recoveredClaimState.itemStarted!.id,
        idempotencyKey: `task:${waiter.id}:event:child-wait-claim:${acknowledged!.sourceAttempt}:${acknowledged!.continuationStepId}`,
        payload: { toolCallId: orphanCallId, toolName: "wait_subagents", taskId: waiter.id } })
      expect(recoveredClaimState.result).toMatchObject({ status: "completed",
        content: { toolCallId: orphanCallId, output: { waitId: acknowledged!.waitId }, errorCode: null } })
      expect(recoveredClaimState.lifecycle.map(event => event.type)).toEqual([
        "item.started", "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed",
      ])
      const [callCompleted, toolCompleted, resultStarted, resultCompleted] = recoveredClaimState.lifecycle.slice(2)
      expect(callCompleted?.idempotencyKey).toBe(`task:${waiter.id}:event:tool-call-completed:${orphanCallId}:${recoveredClaimState.call!.id}:1`)
      expect(callCompleted?.causationId).toBe(recoveredClaimState.claim!.id)
      expect(toolCompleted?.idempotencyKey).toBe(`task:${waiter.id}:event:tool-finished:${orphanCallId}`)
      expect(toolCompleted?.causationId).toBe(callCompleted?.id)
      expect(resultStarted?.causationId).toBe(toolCompleted?.id)
      expect(resultCompleted?.causationId).toBe(resultStarted?.id)
      const modelEvents = await pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT "type", "payload" FROM "agent_events" WHERE "taskId" = $1 AND "sessionId" = $2 AND "turnId" = $3
         AND "correlationId" = $4 AND "type" IN ('model.started', 'model.completed', 'model.usage') ORDER BY "sequence"`,
        [waiter.id, ids.sessionId, ids.turnId, acknowledged!.continuationStepId],
      )
      expect(modelEvents.rows.map(event => event.type)).toEqual(["model.started", "model.completed", "model.usage"])
      const modelEventJson = JSON.stringify(modelEvents.rows.map(event => event.payload))
      expect(modelEventJson).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(waiter.id))
      expect(modelEventJson).not.toContain("sourceLifecycleRecovery")
      expect(modelEvents.rows[1]?.payload).toMatchObject({ toolCallCount: 1 })
      expect(modelEvents.rows[2]?.payload).toMatchObject({ usage: { inputTokens: 37, outputTokens: 13,
        estimatedCostUsd: HIGH_PRECISION_WAIT_MODEL_COST_USD } })
      const persistedStartEvents = await pool.query<{ correlationId: string; payloadToolCallId: string }>(
        `SELECT "correlationId", "payload"->>'toolCallId' AS "payloadToolCallId" FROM "agent_events"
         WHERE "taskId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'tool_call.started'
           AND "idempotencyKey" = $4`, [waiter.id, ids.sessionId, ids.turnId, `task:${waiter.id}:event:tool-started:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}`],
      )
      expect(persistedStartEvents.rows).toEqual([{
        correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
        payloadToolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
      }])
      expect(finalGeneration).toBeGreaterThan(generation)
      expect(postAckGeneration).toBeGreaterThan(finalGeneration)
      expect(finalDispatch.rows[0]!.attemptCount - 1).toBe(postAckGeneration)
      expect(resultCutDispatchPublished.rows[0]!.attemptCount - 1).toBe(resultCutGeneration)
      expect(completedRecoveryPublished.rows[0]!.attemptCount - 1).toBe(completedRecoveryGeneration)
      const finalResumeJob = await queue.getJob(subagentDispatchJobId(waiter.id, completedRecoveryGeneration))
      expect(finalResumeJob).toBeDefined()
      expect(await finalResumeJob!.getState()).toBe("completed")
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await stopWorker(workerD)
      await stopWorker(workerE)
      await stopWorker(workerF)
      await stopWorker(workerG)
      await stopWorker(workerH)
      await queueRedis.del(workerStartGateKey(ids)).catch(() => undefined)
      if (queuePaused) await queue.resume().catch(() => undefined)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      if (recoveryBlockerSessionIds.length > 0) {
        try { await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [recoveryBlockerSessionIds]) } catch { /* preserve the original failure */ }
        try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = ANY($1::text[])`, [recoveryBlockerSessionIds]) } catch { /* preserve the original failure */ }
      }
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* fixture setup may not have reached the session insert */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 300_000)

  it("repairs a legacy consumed wait before production restart loaders and reenters idempotently", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-legacy-user-${suffix}`,
      sessionId: `durable-child-wait-legacy-session-${suffix}`,
      turnId: `durable-child-wait-legacy-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
      finalText: "legacy-consumed-wait-resumed",
    }
    const queueName = `agent-child-wait-legacy-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined
    let workerB: WorkerProcess | undefined
    let workerC: WorkerProcess | undefined
    let workerD: WorkerProcess | undefined
    let queuePaused = false
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined

    const pauseQueue = async () => {
      if (!queuePaused) { await queue.pause(); queuePaused = true }
    }
    const publishRecovery = async (previousCount: number) => {
      const pending = await waitFor(async () => {
        const row = await pool.query<{ status: string; attemptCount: number; publishedAt: Date | null }>(
          `SELECT task."status", dispatch."attemptCount", dispatch."publishedAt"
           FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
             AND dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
           WHERE task."id" = $1 AND task."sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
        return row.rows[0]?.status === "queued" && row.rows[0]?.publishedAt === null ? row.rows[0] : null
      })
      expect(pending.attemptCount).toBeGreaterThanOrEqual(previousCount)
      const pendingCount = pending.attemptCount
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const published = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`])
      expect(published.rows[0]).toMatchObject({ attemptCount: pendingCount + 1, publishedAt: expect.any(Date) })
      await queue.resume()
      queuePaused = false
      return published.rows[0]!.attemptCount
    }

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await seedLoopWaitScenario(pool, taskStore, ids, suffix, policy)

      workerA = launchWorker("worker-a-crash", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerA, "WORKER_A_REGISTERED")
      const registered = await readSourceWaitLifecycle(pool, ids)
      expect(registered.wait).toMatchObject({ status: "waiting", consumedAt: null })
      expect(registered.call).toMatchObject({ status: "started", revision: 0 })
      expect(registered.results).toHaveLength(0)
      const firstTask = await pool.query<{ attemptCount: number; leaseOwner: string | null; leaseExpiresAt: Date | null }>(
        `SELECT "attemptCount", "leaseOwner", "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])
      expect(firstTask.rows[0]).toMatchObject({ attemptCount: 1, leaseOwner: expect.any(String), leaseExpiresAt: expect.any(Date) })
      const firstOwner = firstTask.rows[0]!.leaseOwner!
      await stopWorker(workerA)
      expect(await workerA.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const firstExpired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, firstOwner])
      expect(firstExpired.rowCount).toBe(1)

      await pauseQueue()
      workerB = launchWorker("worker-b-legacy-consumed-seed", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_RECOVERED")
      const waitingAfterRecovery = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])
      expect(waitingAfterRecovery.rows[0]).toMatchObject({ status: "waiting", attemptCount: 1, leaseOwner: null })
      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      await reconcileDurableSubagentWaits(pool)
      await waitFor(async () => {
        const row = await pool.query<{ status: string; taskStatus: string; publishedAt: Date | null }>(
          `SELECT wait."status", task."status" AS "taskStatus", dispatch."publishedAt"
           FROM "agent_wait_conditions" AS wait JOIN "sub_agent_tasks" AS task ON task."id" = wait."parentTaskId" AND task."sessionId" = wait."sessionId"
           JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = wait."sessionId" AND dispatch."topic" = 'agent.subagent.dispatch'
             AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
           WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
        return row.rows[0]?.status === "ready" && row.rows[0]?.taskStatus === "queued" && row.rows[0]?.publishedAt === null
          ? row.rows[0] : null
      })
      const firstGeneration = await publishRecovery(1)
      await waitForMarker(workerB, "WORKER_B_LEGACY_CONSUMED_CLAIMED")
      await stopWorker(workerB)
      expect(await workerB.exited).toMatchObject({ code: null, signal: "SIGKILL" })

      const preRepair = await readSourceWaitLifecycle(pool, ids)
      expect(preRepair.wait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(preRepair.wait?.result).not.toHaveProperty("sourceLifecycleRecovery")
      expect(preRepair.call).toMatchObject({ status: "started", revision: 0 })
      expect(preRepair.results).toHaveLength(0)
      expect(preRepair.events.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
      expect(preRepair.events[1]?.causationId).toBe(preRepair.events[0]?.id)
      expect(preRepair.outboxes).toHaveLength(2)
      expect(workerB.stdoutText + workerB.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      const legacyMarker = workerB.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LEGACY_CONSUMED_CLAIMED "))
      const legacy = JSON.parse(legacyMarker!.slice("WORKER_B_LEGACY_CONSUMED_CLAIMED ".length)) as {
        waitId: string; sourceStepId: string; sourceAttempt: number; continuationStepId: string; logicalNextOrdinal: number;
        sourcePhysicalOrdinal: number; continuationOrdinal: number; attemptCount: number;
        callId: string; sourceLifecycleRepaired: boolean; claimPresent: boolean
      }
      expect(legacy).toMatchObject({ waitId: preRepair.wait?.id, sourceStepId: `task:${ids.waiterTaskId}:step:0:attempt:1`,
        sourceAttempt: 1, logicalNextOrdinal: 1, sourcePhysicalOrdinal: 0, attemptCount: 1,
        sourceLifecycleRepaired: false, claimPresent: true })
      expect(legacy.continuationStepId).toBe(`task:${ids.waiterTaskId}:step:${legacy.logicalNextOrdinal}:attempt:1`)
      const legacyContinuation = await pool.query<{ id: string; ordinal: number | string; attempt: number; status: string }>(
        `SELECT "id", "ordinal", "attempt", "status" FROM "agent_steps"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5`,
        [legacy.continuationStepId, ids.sessionId, ids.turnId, ids.waiterTaskId, legacy.sourceAttempt],
      )
      expect(legacyContinuation.rows).toHaveLength(1)
      expect(Number(legacyContinuation.rows[0]!.ordinal)).toBe(legacy.continuationOrdinal)
      expect(legacy.continuationOrdinal).toBeGreaterThan(legacy.sourcePhysicalOrdinal)
      expect(legacyContinuation.rows[0]).toMatchObject({ id: legacy.continuationStepId, attempt: 1, status: "streaming" })
      const orphanBeforeRepair = await readWaitClaimState(pool, ids, legacy.continuationStepId, legacy.callId, 1)
      expect(orphanBeforeRepair).toMatchObject({ callCount: 1, claimCount: 1, itemStartedCount: 1, resultCount: 0, claimOutboxCount: 1 })
      expect(orphanBeforeRepair.call).toMatchObject({ status: "started", revision: 0 })
      expect(orphanBeforeRepair.claim).toMatchObject({ type: "tool_call.started", correlationId: legacy.callId,
        itemId: orphanBeforeRepair.call?.id, causationId: orphanBeforeRepair.itemStarted?.id,
        idempotencyKey: `task:${ids.waiterTaskId}:event:child-wait-claim:1:${legacy.continuationStepId}` })
      // Evaluate the absent-source proof against this consumed, claimed, pre-repair legacy cut.
      await expectAbsentSourceResultClaimSafety(pool, ids, legacy.continuationStepId)
      const oldTask = await taskStore.get(ids.waiterTaskId, ids.sessionId)
      if (!oldTask?.leaseOwner || !(oldTask.leaseExpiresAt instanceof Date)) throw new Error("legacy owner snapshot unavailable")
      const staleOwnerLease: SubagentLease = { ...oldTask, ownerId: oldTask.leaseOwner, leaseExpiresAt: oldTask.leaseExpiresAt,
        signal: new AbortController().signal }
      const oldOwner = oldTask.leaseOwner
      const secondExpired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, oldOwner])
      expect(secondExpired.rowCount).toBe(1)
      expect(await readSourceWaitLifecycle(pool, ids)).toEqual(preRepair)

      await pauseQueue()
      workerC = launchWorker("worker-b-legacy-consumed-recovery", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const recoveryCount = await publishRecovery(firstGeneration)
      await waitForMarker(workerC, "WORKER_B_LEGACY_SOURCE_REPAIRED")
      const repairedMarker = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LEGACY_SOURCE_REPAIRED "))
      const repaired = JSON.parse(repairedMarker!.slice("WORKER_B_LEGACY_SOURCE_REPAIRED ".length)) as {
        waitId: string; sourceStepId: string; sourceAttempt: number; currentAttempt: number; continuationStepId: string;
        orphanCallId: string | null; claimCallId: string | null; repeatedRepairCount: number; executorCalls: number; dispatcherCalls: number
      }
      expect(repaired).toMatchObject({ waitId: legacy.waitId, sourceStepId: legacy.sourceStepId, sourceAttempt: 1,
        currentAttempt: 1, continuationStepId: legacy.continuationStepId, orphanCallId: null, claimCallId: legacy.callId,
        repeatedRepairCount: 0, executorCalls: 0, dispatcherCalls: 0 })
      const repairedLifecycle = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(repairedLifecycle, ids)
      expect(repairedLifecycle.wait?.consumedAt).toEqual(preRepair.wait?.consumedAt)
      expect(workerC.stdoutText + workerC.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      await waitForMarker(workerC, "WORKER_B_LOOP_CLAIM_BEFORE_RESULT")
      const claimed = await readWaitClaimState(pool, ids, legacy.continuationStepId, legacy.callId, 1)
      expect(claimed).toMatchObject({ callCount: 1, claimCount: 1, itemStartedCount: 1, resultCount: 0, claimOutboxCount: 1 })
      expect(claimed.claim).toMatchObject({ type: "tool_call.started", correlationId: legacy.callId,
        causationId: claimed.itemStarted?.id,
        idempotencyKey: `task:${ids.waiterTaskId}:event:child-wait-claim:1:${legacy.continuationStepId}` })
      const currentTask = await taskStore.get(ids.waiterTaskId, ids.sessionId)
      expect(currentTask?.leaseOwner).toEqual(expect.any(String))
      expect(currentTask?.leaseOwner).not.toBe(oldOwner)
      const beforeStaleWrite = await readSourceWaitLifecycle(pool, ids)
      let staleWriteError = false
      let staleWriteAccepted = false
      try {
        staleWriteAccepted = await commitDurableSubagentWaitResume(pool, staleOwnerLease, {
          waitId: legacy.waitId, stepId: legacy.sourceStepId, nextStepOrdinal: legacy.continuationOrdinal, now: new Date(),
        })
      } catch { staleWriteError = true }
      expect(staleWriteAccepted).toBe(false)
      expect(staleWriteError).toBe(true)
      expect(await readSourceWaitLifecycle(pool, ids)).toEqual(beforeStaleWrite)

      await stopWorker(workerC)
      expect(await workerC.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const thirdExpired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, currentTask!.leaseOwner])
      expect(thirdExpired.rowCount).toBe(1)

      await pauseQueue()
      workerD = launchWorker("worker-b-legacy-consumed-final", queueName, ids)
      await waitForMarker(workerD, "WORKER_B_RECOVERED")
      await publishRecovery(recoveryCount)
      await waitForMarker(workerD, "WORKER_B_RESUMED")
      const resumedLine = workerD.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RESUMED "))
      const resumed = JSON.parse(resumedLine!.slice("WORKER_B_RESUMED ".length)) as { result?: { finalText?: string } }
      expect(resumed.result?.finalText).toBe(ids.finalText)
      expect(workerD.stdoutText + workerD.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      const finished = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])
      expect(finished.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null })
      const finalSource = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(finalSource, ids)
      expect(BigInt(finalSource.eventSequence!)).toBeGreaterThan(BigInt(repairedLifecycle.eventSequence!))
      expect({ wait: finalSource.wait, call: finalSource.call, results: finalSource.results,
        events: finalSource.events, outboxes: finalSource.outboxes }).toEqual({ wait: repairedLifecycle.wait,
        call: repairedLifecycle.call, results: repairedLifecycle.results, events: repairedLifecycle.events,
        outboxes: repairedLifecycle.outboxes })
      const finalClaim = await readWaitClaimState(pool, ids, legacy.continuationStepId, legacy.callId, 1)
      expect(finalClaim).toMatchObject({ callCount: 1, claimCount: 1, itemStartedCount: 1, resultCount: 1, claimOutboxCount: 1 })
      const loopSummary = workerD.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESUMED "))
      expect(JSON.parse(loopSummary!.slice("WORKER_B_LOOP_RESUMED ".length))).toMatchObject({ phase: "final", status: "completed",
        invocations: [`task:${ids.waiterTaskId}:step:2:attempt:1`], executorCalls: 0, dispatcherCalls: 0,
        continuationStepId: legacy.continuationStepId, logicalStepOrdinal: 1 })
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await stopWorker(workerD)
      await queueRedis.del(workerStartGateKey(ids)).catch(() => undefined)
      if (queuePaused) await queue.resume().catch(() => undefined)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* fixture setup may be incomplete */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 180_000)

  it("repairs an attempt-1 consumed wait under a synthetic attempt-2 lease before the production loader", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-legacy-a2-user-${suffix}`,
      sessionId: `durable-child-wait-legacy-a2-session-${suffix}`,
      turnId: `durable-child-wait-legacy-a2-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
    }
    const queueName = `agent-child-wait-legacy-a2-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 2 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined
    let workerB: WorkerProcess | undefined
    let queuePaused = false
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined

    const pauseQueue = async () => {
      if (!queuePaused) { await queue.pause(); queuePaused = true }
    }
    const dispatchPending = async () => {
      const pending = await waitFor(async () => {
        const row = await pool.query<{ status: string; attemptCount: number; publishedAt: Date | null }>(
          `SELECT task."status", dispatch."attemptCount", dispatch."publishedAt"
           FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
             AND dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
           WHERE task."id" = $1 AND task."sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
        return row.rows[0]?.status === "queued" && row.rows[0]?.publishedAt === null ? row.rows[0] : null
      })
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      const published = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`])
      expect(published.rows[0]).toMatchObject({ attemptCount: pending.attemptCount + 1, publishedAt: expect.any(Date) })
      await queue.resume()
      queuePaused = false
      return published.rows[0]!.attemptCount
    }

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await seedLoopWaitScenario(pool, taskStore, ids, suffix, policy)

      workerA = launchWorker("worker-a-crash", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerA, "WORKER_A_REGISTERED")
      const firstTask = await pool.query<{ leaseOwner: string | null }>(
        `SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
      const firstOwner = firstTask.rows[0]?.leaseOwner
      if (!firstOwner) throw new Error("attempt-1 owner was not persisted")
      await stopWorker(workerA)
      expect(await workerA.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const expired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, firstOwner])
      expect(expired.rowCount).toBe(1)

      await pauseQueue()
      workerB = launchWorker("worker-b-legacy-consumed-source-only", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_RECOVERED")
      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      await reconcileDurableSubagentWaits(pool)
      const dispatchGeneration = await dispatchPending()
      await waitForMarker(workerB, "WORKER_B_LEGACY_CONSUMED_SOURCE_ONLY")

      const preRepair = await readSourceWaitLifecycle(pool, ids)
      expect(preRepair.wait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(preRepair.wait?.result).not.toHaveProperty("sourceLifecycleRecovery")
      expect(preRepair.call).toMatchObject({ status: "started", revision: 0 })
      expect(preRepair.results).toHaveLength(0)
      expect(preRepair.events.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
      expect(preRepair.events[1]?.causationId).toBe(preRepair.events[0]?.id)
      expect(preRepair.outboxes).toHaveLength(2)
      expect(workerB.stdoutText + workerB.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      const sourceOnlyLine = workerB.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LEGACY_CONSUMED_SOURCE_ONLY "))
      if (!sourceOnlyLine) throw new Error("synthetic source-only marker missing")
      const sourceOnly = JSON.parse(sourceOnlyLine.slice("WORKER_B_LEGACY_CONSUMED_SOURCE_ONLY ".length)) as {
        waitId: string; sourceStepId: string; sourceAttempt: number; continuationStepId: string;
        logicalNextOrdinal: number; sourcePhysicalOrdinal: number; continuationOrdinal: number; attemptCount: number;
        sourceLifecycleRepaired: boolean; continuationCallCreated: boolean
      }
      expect(sourceOnly).toMatchObject({ waitId: preRepair.wait?.id, sourceStepId: `task:${ids.waiterTaskId}:step:0:attempt:1`,
        sourceAttempt: 1, continuationStepId: `task:${ids.waiterTaskId}:step:1:attempt:1`, attemptCount: 1,
        sourceLifecycleRepaired: false, continuationCallCreated: false })
      expect(sourceOnly.logicalNextOrdinal).toBe(1)
      expect(sourceOnly.sourcePhysicalOrdinal).toBe(0)
      expect(sourceOnly.continuationOrdinal).toBeGreaterThan(sourceOnly.sourcePhysicalOrdinal)
      const persistedContinuation = await pool.query<{ id: string; ordinal: number | string; attempt: number; status: string }>(
        `SELECT "id", "ordinal", "attempt", "status" FROM "agent_steps"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "attempt" = $5`,
        [sourceOnly.continuationStepId, ids.sessionId, ids.turnId, ids.waiterTaskId, sourceOnly.sourceAttempt],
      )
      expect(persistedContinuation.rows).toHaveLength(1)
      expect(Number(persistedContinuation.rows[0]!.ordinal)).toBe(sourceOnly.continuationOrdinal)
      expect(persistedContinuation.rows[0]).toMatchObject({ id: sourceOnly.continuationStepId, attempt: sourceOnly.sourceAttempt, status: "streaming" })
      const oldLeaseRecord = await taskStore.get(ids.waiterTaskId, ids.sessionId)
      if (!oldLeaseRecord?.leaseOwner || !(oldLeaseRecord.leaseExpiresAt instanceof Date)) throw new Error("attempt-1 lease snapshot unavailable")
      const staleAttemptLease: SubagentLease = { ...oldLeaseRecord, ownerId: oldLeaseRecord.leaseOwner,
        leaseExpiresAt: oldLeaseRecord.leaseExpiresAt, signal: new AbortController().signal }
      await stopWorker(workerB)
      expect(await workerB.exited).toMatchObject({ code: null, signal: "SIGKILL" })

      // This row models a valid later retry lease so the historical source-attempt fence is tested
      // independently from the full same-attempt process-restart scenario above.
      const syntheticOwner = `fixture-synthetic-attempt-2-${suffix}`
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        const session = await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2
          AND "status" NOT IN ('aborted', 'archived') FOR UPDATE`, [ids.sessionId, ids.userId])
        expect(session.rowCount).toBe(1)
        const current = await client.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2
          AND "turnId" = $3 AND "rootTaskId" = $4 AND "status" = 'running' AND "leaseOwner" = $5
          AND "attemptCount" = 1 AND "leaseExpiresAt" > clock_timestamp() AND "interruptRequestedAt" IS NULL FOR UPDATE`,
        [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId, staleAttemptLease.ownerId])
        expect(current.rowCount).toBe(1)
        const changed = await client.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 2, "leaseOwner" = $2,
          "leaseExpiresAt" = clock_timestamp() + interval '2 minutes', "updatedAt" = clock_timestamp()
          WHERE "id" = $1 AND "sessionId" = $3 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $4
          RETURNING "id"`, [ids.waiterTaskId, syntheticOwner, ids.sessionId, staleAttemptLease.ownerId])
        expect(changed.rowCount).toBe(1)
        await client.query("COMMIT")
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { client.release() }

      const currentTask = await taskStore.get(ids.waiterTaskId, ids.sessionId)
      if (!currentTask || currentTask.status !== "running" || currentTask.attemptCount !== 2
        || currentTask.leaseOwner !== syntheticOwner || !(currentTask.leaseExpiresAt instanceof Date)) {
        throw new Error("synthetic current attempt-2 lease did not persist")
      }
      const currentLease: SubagentLease = { ...currentTask, ownerId: syntheticOwner,
        leaseExpiresAt: currentTask.leaseExpiresAt, signal: new AbortController().signal }
      const loaders = createProductionChildResumeLoaders(pool)
      if (!loaders.resumeLoader) throw new Error("production resume loader unavailable")
      const resumed = await loaders.resumeLoader(currentLease)
      expect(resumed).toBeDefined()
      expect(resumed?.resume).toMatchObject({ stepCount: 2, toolCallCount: 1 })
      const sourceObservation = resumed?.observations.find(block => asObject(block.content).toolCallId === PHONE_SHAPED_WAIT_TOOL_CALL_ID)
      expect(asObject(sourceObservation?.content)).toMatchObject({ toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
        toolName: "wait_subagents", status: "completed", input: { idempotencyKey: "api_key=[REDACTED]" },
        output: { waitId: sourceOnly.waitId, taskIds: [FIXED_WAIT_TARGET_TASK_ID] } })
      expect(await repairConsumedChildWaitSources(pool, currentLease, new Date())).toBe(0)
      const repaired = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(repaired, ids, syntheticOwner)
      expect(repaired.wait?.consumedAt).toEqual(preRepair.wait?.consumedAt)
      expect(repaired.eventSequence).not.toBe(preRepair.eventSequence)
      expect(workerB.stdoutText + workerB.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      const [dispatchState, waitCalls] = await Promise.all([
        pool.query<{ attemptCount: number; count: number }>(`SELECT "attemptCount", COUNT(*)::int AS "count"
          FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
            AND "idempotencyKey" = $2 GROUP BY "attemptCount"`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`]),
        pool.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'
            AND "content"->>'toolName' = 'wait_subagents'`, [ids.sessionId, ids.turnId, ids.waiterTaskId]),
      ])
      expect(dispatchState.rows).toEqual([{ attemptCount: dispatchGeneration, count: 1 }])
      expect(waitCalls.rows[0]?.count).toBe(1)

      const beforeStaleRead = await readSourceWaitLifecycle(pool, ids)
      await expect(loaders.resumeLoader(staleAttemptLease)).rejects.toThrow()
      await expect(loaders.resumeLoader({ ...currentLease, attemptCount: 1 })).rejects.toThrow()
      expect(await readSourceWaitLifecycle(pool, ids)).toEqual(beforeStaleRead)
      const finalTask = await taskStore.get(ids.waiterTaskId, ids.sessionId)
      expect(finalTask).toMatchObject({ status: "running", attemptCount: 2, leaseOwner: syntheticOwner })
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      if (queuePaused) await queue.resume().catch(() => undefined)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* preserve the original failure */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 180_000)

  it("fails closed on a multi-call orphan receipt before executor or dispatcher use", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-multi-user-${suffix}`,
      sessionId: `durable-child-wait-multi-session-${suffix}`,
      turnId: `durable-child-wait-multi-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
    }
    const queueName = `agent-child-wait-multi-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined
    let workerB: WorkerProcess | undefined
    let workerC: WorkerProcess | undefined
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await seedLoopWaitScenario(pool, taskStore, ids, suffix, policy)

      workerA = launchWorker("worker-a", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerA, "WORKER_A_WAITING")
      expect(workerResultStatus(workerA, "WORKER_A_WAITING"),
        `WorkerA result was not waiting: ${workerFailureDiagnostic(workerA)}`).toBe("waiting")
      await expectCompletedSourceWaitLifecycle(pool, ids)
      const sourceExit = await workerA.exited
      expect(sourceExit.code).toBe(0)
      expect(sourceExit.signal).toBeNull()

      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      const resolved = await reconcileDurableSubagentWaits(pool)
      if (resolved.woken === 0) await diagnoseZeroWaitWake(pool, ids, resolved)
      expect(resolved.woken).toBeGreaterThan(0)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)

      workerB = launchWorker("worker-b-loop-multi-preclaim", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_READY")
      const preclaimGeneration = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`],
      )
      expect(preclaimGeneration.rows[0]?.publishedAt).toBeInstanceOf(Date)
      await waitForMarker(workerB, "WORKER_B_LOOP_PRE_CLAIM_ORPHAN")
      const callId = `child-wait-loop:${ids.waiterTaskId}:attempt:1`
      const continuationStepId = `task:${ids.waiterTaskId}:step:1:attempt:1`
      const multiCallState = await readWaitClaimState(pool, ids, continuationStepId, callId, 1)
      expect(multiCallState.call).toMatchObject({ status: "started", revision: 0,
        content: { toolCallId: callId, toolName: "wait_subagents" } })
      expect(multiCallState.callCount).toBe(1)
      expect(multiCallState.itemStartedCount).toBe(1)
      expect(multiCallState.claimCount).toBe(0)
      expect(multiCallState.resultCount).toBe(0)
      expect(multiCallState.lifecycle.map(event => event.type)).toEqual(["item.started"])
      const modelReceipt = await pool.query<{ type: string; payload: Record<string, unknown> }>(
        `SELECT "type", "payload" FROM "agent_events" WHERE "taskId" = $1 AND "sessionId" = $2 AND "turnId" = $3
         AND "correlationId" = $4 AND "type" = 'model.completed'`, [ids.waiterTaskId, ids.sessionId, ids.turnId, continuationStepId],
      )
      expect(modelReceipt.rows).toHaveLength(1)
      expect(modelReceipt.rows[0]?.payload).toMatchObject({ taskId: ids.waiterTaskId, toolCallCount: 2 })
      const preclaimMarker = workerB.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_PRE_CLAIM_ORPHAN "))
      expect(JSON.parse(preclaimMarker!.slice("WORKER_B_LOOP_PRE_CLAIM_ORPHAN ".length))).toMatchObject({
        phase: "multi-preclaim", callId, stepId: continuationStepId, modelCalls: 1, executorCalls: 0, dispatcherCalls: 0,
      })

      await stopWorker(workerB)
      const preclaimExit = await workerB.exited
      expect(preclaimExit.code).toBeNull()
      expect(preclaimExit.signal).toBe("SIGKILL")
      const lease = await pool.query<{ leaseOwner: string | null }>(
        `SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId],
      )
      expect(lease.rows[0]?.leaseOwner).toEqual(expect.any(String))
      const expired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, lease.rows[0]!.leaseOwner])
      expect(expired.rowCount).toBe(1)

      workerC = launchWorker("worker-b-loop-multi-reject", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const recoveredTask = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId],
      )
      expect(recoveredTask.rows[0]).toMatchObject({ status: "queued", attemptCount: 1, leaseOwner: null })
      const dispatch = await pool.query<{ publishedAt: Date | null }>(
        `SELECT "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
         AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`],
      )
      expect(dispatch.rows[0]?.publishedAt).toBeNull()
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerC, "WORKER_B_LOOP_MULTI_REJECTED")
      const rejectedMarker = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_MULTI_REJECTED "))
      expect(JSON.parse(rejectedMarker!.slice("WORKER_B_LOOP_MULTI_REJECTED ".length))).toEqual({
        error: "child_resume_wait_tool_call_conflict", modelCalls: 0, executorCalls: 0, dispatcherCalls: 0,
      })
      const afterReject = await readWaitClaimState(pool, ids, continuationStepId, callId, 1)
      expect(afterReject.call).toMatchObject({ status: "started", revision: 0 })
      expect(afterReject.claimCount).toBe(0)
      expect(afterReject.resultCount).toBe(0)
      expect(afterReject.lifecycle.map(event => event.type)).toEqual(["item.started"])
      await waitForMarker(workerC, "WORKER_B_RESUMED")
      const rejectedExit = await workerC.exited
      expect(rejectedExit).toEqual({ code: 0, signal: null })
      const rejectedCompletionLine = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_RESUMED "))
      const rejectedCompletion = JSON.parse(rejectedCompletionLine!.slice("WORKER_B_RESUMED ".length)) as { result?: { status?: string } }
      expect(rejectedCompletion.result?.status).toBe("failed")
      const failed = await pool.query<{ status: string; failureReason: string | null }>(
        `SELECT "status", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId],
      )
      expect(failed.rows[0]?.status).toBe("failed")
      expect(failed.rows[0]?.failureReason).toContain("child_resume_wait_tool_call_conflict")
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* fixture setup may be incomplete */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 60_000)

  it("accepts PG-scale-8 receipt usage before failing closed on a later streaming step", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-round-user-${suffix}`,
      sessionId: `durable-child-wait-round-session-${suffix}`,
      turnId: `durable-child-wait-round-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
      loopCallPrefix: `rounded-wait-call-${suffix}`,
    }
    const queueName = `agent-child-wait-round-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined
    let workerB: WorkerProcess | undefined
    let workerC: WorkerProcess | undefined
    let workerD: WorkerProcess | undefined
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await seedLoopWaitScenario(pool, taskStore, ids, suffix, policy)

      workerA = launchWorker("worker-a", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerA, "WORKER_A_WAITING")
      expect(workerResultStatus(workerA, "WORKER_A_WAITING"),
        `WorkerA result was not waiting: ${workerFailureDiagnostic(workerA)}`).toBe("waiting")
      await expectCompletedSourceWaitLifecycle(pool, ids)
      const sourceExit = await workerA.exited
      expect(sourceExit.code).toBe(0)
      expect(sourceExit.signal).toBeNull()

      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      const resolved = await reconcileDurableSubagentWaits(pool)
      if (resolved.woken === 0) await diagnoseZeroWaitWake(pool, ids, resolved)
      expect(resolved.woken).toBeGreaterThan(0)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)

      workerB = launchWorker("worker-b-loop-preclaim", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_READY")
      await waitForMarker(workerB, "WORKER_B_LOOP_PRE_CLAIM_ORPHAN")
      const orphanCallId = `${ids.loopCallPrefix}:${ids.waiterTaskId}:attempt:1`
      const continuationStepId = `task:${ids.waiterTaskId}:step:1:attempt:1`
      const rawReceipt = await pool.query<{ usage: Record<string, unknown> }>(
        `SELECT "payload"->'usage' AS "usage" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
          AND "taskId" = $3 AND "correlationId" = $4 AND "type" = 'model.usage'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId],
      )
      expect(rawReceipt.rows).toHaveLength(1)
      expect(rawReceipt.rows[0]?.usage).toMatchObject({ inputTokens: 37, outputTokens: 13,
        estimatedCostUsd: HIGH_PRECISION_WAIT_MODEL_COST_USD })
      const orphan = await readWaitClaimState(pool, ids, continuationStepId, orphanCallId, 1)
      expect(orphan.call).toMatchObject({ status: "started", revision: 0,
        content: { toolCallId: orphanCallId, toolName: "wait_subagents" } })
      expect(orphan.claimCount).toBe(0)
      expect(orphan.resultCount).toBe(0)

      await stopWorker(workerB)
      const orphanExit = await workerB.exited
      expect(orphanExit.code).toBeNull()
      expect(orphanExit.signal).toBe("SIGKILL")
      const orphanOwner = await pool.query<{ leaseOwner: string | null }>(
        `SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId],
      )
      expect(orphanOwner.rows[0]?.leaseOwner).toEqual(expect.any(String))
      const orphanExpired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, orphanOwner.rows[0]!.leaseOwner])
      expect(orphanExpired.rowCount).toBe(1)

      workerC = launchWorker("worker-b-loop-usage-lineage-cut", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const claimCutDispatch = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId],
      )
      expect(claimCutDispatch.rows[0]).toMatchObject({ status: "queued", attemptCount: 1, leaseOwner: null })
      const claimCutOutbox = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`],
      )
      expect(claimCutOutbox.rows[0]?.publishedAt).toBeNull()
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerC, "WORKER_B_LOOP_ROUNDED_USAGE_LINEAGE_CUT")
      const cutMarker = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_ROUNDED_USAGE_LINEAGE_CUT "))
      expect(JSON.parse(cutMarker!.slice("WORKER_B_LOOP_ROUNDED_USAGE_LINEAGE_CUT ".length))).toMatchObject({
        callId: orphanCallId, completedStepId: continuationStepId, completedStepStatus: "completed",
        physicalStepOrdinal: 2, persistedCostUsd: "0.12345679", receiptCostUsd: "0.123456789",
        nextStepId: `task:${ids.waiterTaskId}:step:2:attempt:1`,
        nextStepStatus: "streaming", nextPhysicalStepOrdinal: 3, claimCount: 1, resultCount: 1, nextModelStartCount: 0,
        claimLoaderAccepted: true, claimLoaderStepStatus: "completed", claimLoaderUsageCost: 0.123456789,
        liveResumeError: "child_resume_wait_step_lineage", modelCalls: 0, executorCalls: 0, dispatcherCalls: 0,
      })
      const stepOneBeforeCrash = await pool.query<{ status: string; ordinal: number; inputTokens: number; outputTokens: number; cost: string }>(
        `SELECT "status", "ordinal", "inputTokens", "outputTokens", "estimatedCostUsd"::text AS "cost"
          FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = $4`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId],
      )
      expect(stepOneBeforeCrash.rows[0]).toMatchObject({ status: "completed", ordinal: 2, inputTokens: 37,
        outputTokens: 13, cost: "0.12345679" })
      const nextModelStartBeforeCrash = await pool.query(
        `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "correlationId" = $4 AND "type" = 'model.started'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, `task:${ids.waiterTaskId}:step:2:attempt:1`],
      )
      expect(nextModelStartBeforeCrash.rows).toHaveLength(0)

      await stopWorker(workerC)
      const lineageCutExit = await workerC.exited
      expect(lineageCutExit.code).toBeNull()
      expect(lineageCutExit.signal).toBe("SIGKILL")
      const lineageCutOwner = await pool.query<{ leaseOwner: string | null }>(
        `SELECT "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId],
      )
      expect(lineageCutOwner.rows[0]?.leaseOwner).toEqual(expect.any(String))
      const lineageCutExpired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, lineageCutOwner.rows[0]!.leaseOwner])
      expect(lineageCutExpired.rowCount).toBe(1)

      const lineageOutboxBeforeRecovery = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`],
      )
      expect(lineageOutboxBeforeRecovery.rows).toHaveLength(1)
      expect(lineageOutboxBeforeRecovery.rows[0]?.publishedAt).toBeInstanceOf(Date)
      workerD = launchWorker("worker-b-loop-usage-lineage-reject", queueName, ids)
      await waitForMarker(workerD, "WORKER_B_RECOVERED")
      const workerDRecovery = parseRecoveryMarker(workerD)
      expect(workerDRecovery.reclaimed).toBe(0)
      expect(workerDRecovery.terminal).toBe(1)
      expect(workerDRecovery.rows?.find(row => row.id === ids.waiterTaskId)?.status).toBe("failed")
      await stopWorker(workerD)
      const workerDExit = await workerD.exited
      expect(workerDExit.signal).toBe("SIGKILL")

      const terminalizedTask = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; failureReason: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId],
      )
      expect(terminalizedTask.rows[0]).toMatchObject({ status: "failed", attemptCount: 1, leaseOwner: null })
      expect(terminalizedTask.rows[0]?.failureReason).toEqual(expect.any(String))
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(0)
      const lineageOutboxAfterRecovery = await pool.query<{ attemptCount: number; publishedAt: Date | null }>(
        `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
          AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`],
      )
      expect(lineageOutboxAfterRecovery.rows).toEqual(lineageOutboxBeforeRecovery.rows)
      const afterReject = await readWaitClaimState(pool, ids, continuationStepId, orphanCallId, 1)
      expect(afterReject.callCount).toBe(1)
      expect(afterReject.call).toMatchObject({ status: "completed", content: { toolCallId: orphanCallId } })
      expect(afterReject.claimCount).toBe(1)
      expect(afterReject.resultCount).toBe(1)
      expect(afterReject.lifecycle.map(event => event.type)).toEqual([
        "item.started", "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed",
      ])
      const finalUsage = await pool.query<{ count: number; cost: string | null }>(
        `SELECT COUNT(*)::int AS "count", MAX("payload"->'usage'->>'estimatedCostUsd') AS "cost"
          FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
            AND "correlationId" = $4 AND "type" = 'model.usage'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId],
      )
      expect(finalUsage.rows[0]).toEqual({ count: 1, cost: "0.123456789" })
      const forbiddenNextModelEvents = await pool.query(
        `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "correlationId" = $4 AND "type" IN ('model.started', 'model.completed', 'model.usage')`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, `task:${ids.waiterTaskId}:step:2:attempt:1`],
      )
      expect(forbiddenNextModelEvents.rows).toHaveLength(0)
      const forbiddenNextToolItems = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "stepId" = $4 AND "type" IN ('tool_call', 'tool_result')`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, `task:${ids.waiterTaskId}:step:2:attempt:1`],
      )
      expect(forbiddenNextToolItems.rows[0]?.count).toBe(0)
      const finalSteps = await pool.query<{ id: string; ordinal: number; status: string; cost: string }>(
        `SELECT "id", "ordinal", "status", "estimatedCostUsd"::text AS "cost" FROM "agent_steps"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "ordinal"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId],
      )
      expect(finalSteps.rows).toEqual([
        { id: `task:${ids.waiterTaskId}:step:0:attempt:1`, ordinal: 0, status: "waiting_for_tool", cost: "0.00000000" },
        { id: continuationStepId, ordinal: 2, status: "completed", cost: "0.12345679" },
        { id: `task:${ids.waiterTaskId}:step:2:attempt:1`, ordinal: 3, status: "streaming", cost: "0.00000000" },
      ])
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await stopWorker(workerD)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* fixture setup may be incomplete */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 90_000)

  it("selects the latest sequential wait by step ordinal at maxAttempts", async () => {
    const client = await pool.connect()
    try {
      await client.query(`CREATE TEMP TABLE "sub_agent_tasks" (
        "id" text, "parentTaskId" text, "sessionId" text, "turnId" text, "rootTaskId" text,
        "status" text, "attemptCount" integer, "maxAttempts" integer
      );
      CREATE TEMP TABLE "agent_turns" ("id" text, "sessionId" text, "userId" text, "rootTaskId" text);
      CREATE TEMP TABLE "agent_steps" (
        "id" text, "sessionId" text, "turnId" text, "taskId" text, "attempt" integer, "status" text, "ordinal" integer
      );
      CREATE TEMP TABLE "agent_wait_conditions" (
        "id" text, "parentTaskId" text, "sessionId" text, "turnId" text, "userId" text, "stepId" text,
        "status" text, "suspendedAt" timestamptz, "consumedAt" timestamptz, "mode" text,
        "targetTaskIds" jsonb, "createdAt" timestamptz
      );`)
      await client.query(`INSERT INTO "sub_agent_tasks" VALUES
        ('child', 'root', 'session', 'turn', 'root', 'queued', 3, 3),
        ('target', 'child', 'session', 'turn', 'root', 'completed', 1, 3)`)
      await client.query(`INSERT INTO "agent_turns" VALUES ('turn', 'session', 'user', 'root')`)
      await client.query(`INSERT INTO "agent_steps" VALUES
        ('step-w1', 'session', 'turn', 'child', 3, 'completed', 0),
        ('step-w2', 'session', 'turn', 'child', 3, 'waiting_for_tool', 1)`)
      const sameRegistrationTime = new Date("2026-10-23T10:00:00.000Z")
      await client.query(`INSERT INTO "agent_wait_conditions" VALUES
        ('wait-w1', 'child', 'session', 'turn', 'user', 'step-w1', 'ready', $1, $1, 'any', '["target"]'::jsonb, $2),
        ('wait-w2', 'child', 'session', 'turn', 'user', 'step-w2', 'waiting', $1, NULL, 'any', '["target"]'::jsonb, $2)`, [sameRegistrationTime, sameRegistrationTime])

      const readEligibility = () => client.query<{ resumable: boolean }>(
        `SELECT ${CHILD_WAIT_RESUMABLE_SQL} AS "resumable" FROM "sub_agent_tasks" AS task WHERE task."id" = 'child'`,
      )
      await expect(readEligibility()).resolves.toMatchObject({ rows: [{ resumable: false }] })
      await client.query(`UPDATE "agent_wait_conditions" SET "status" = 'ready' WHERE "id" = 'wait-w2'`)
      await expect(readEligibility()).resolves.toMatchObject({ rows: [{ resumable: true }] })
    } finally {
      client.release()
    }
  })
})
