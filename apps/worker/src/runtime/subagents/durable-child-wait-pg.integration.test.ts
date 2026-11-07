import { createHash, randomUUID } from "node:crypto"
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
import { projectWaitCallCompletionPayload, projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"
import { executionOwnerFence } from "../execution-owner.js"
import { registerDurableSubagentWait } from "./durable-subagent-wait-store.js"
import { inspectChildWaitSourceLifecycle } from "./child-resume-source-wait-lifecycle.js"
import { reconcileDurableSubagentWaits } from "./durable-subagent-wait-resolver.js"
import { commitDurableSubagentWaitResume, loadDurableSubagentWaitResume } from "./durable-subagent-wait-resume.js"
import { loadChildAttemptResume } from "./child-resume.js"
import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.js"
import { createProductionChildResumeLoaders } from "./production-child-resume-loaders.js"
import { actionList, asObject, INSERT_TASK, json } from "./pg-store-persistence.js"
import type { SubagentLease } from "./types.js"
import { CHILD_WAIT_CLAIM_RECOVERY_SQL, CHILD_WAIT_CONSUMED_SQL, CHILD_WAIT_RESUMABLE_SQL as CHILD_WAIT_EXPIRY_RESUMABLE_SQL, hasBlockingExternalCall } from "./pg-store-expiry-recovery-predicates.js"
import { CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL, CHILD_WAIT_CALL_LIFECYCLE_SQL,
  CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL, CHILD_WAIT_SOURCE_PROJECTED_COMPLETION_SQL,
  childWaitContinuationKeyMatchesSafeProjection } from "./pg-store-expiry-child-wait-claim-call-proof.js"
import { CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL, CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL,
  HISTORICAL_SOURCE_STEP_BINDING_SQL, HISTORICAL_SOURCE_STEP_PREFIX_SQL } from "./pg-store-expiry-historical-wait-event-binding.js"
import { readChildWaitSourceCallProjection } from "./pg-store-expiry-child-wait-source-proof.js"
import { CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL } from "./pg-store-expiry-historical-wait-binding.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey } from "../turns/cognitive-agenda-receipt.js"
import { diagnoseChildWaitTerminalCallProjections, readChildWaitTerminalCallProjections } from "./pg-store-expiry-historical-wait-projections.js"
import { historicalSourceStepCallChainBinding, historicalSourceStepCallCountBinding, historicalSourceStepEventChainBinding,
  readCanonicalHistoricalSourceStepPrefix } from "./pg-store-expiry-historical-source-step-prefix.js"
import { historicalSourceStepCallChainDiagnosticSql } from "./pg-store-expiry-historical-source-step-call-binding-diagnostics.js"
import { CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL } from "./pg-store-expiry-step-completion-proof.js"
import { MAX_STEP_CHAIN_EVENTS, MAX_STEP_TOOL_CALLS, readCanonicalWaitStepToolChain } from "./pg-store-expiry-step-tool-chain-proof.js"
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
const BOUNDED_LOOP_STAGE_MARKER = "WORKER_B_LOOP_STAGE "
const BOUNDED_LOOP_STAGE_LIMIT_MARKER = "WORKER_B_LOOP_STAGE_LIMIT "
const MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES = 64
const BOUNDED_LOOP_DIAGNOSTIC_STAGES = new Set([
  "durable_wait_loader", "child_attempt_resume_loader", "restored_wait_validation", "execution_loop_recovery",
  "step_start", "step_started_event", "context_build", "agenda_build", "agenda_persist", "model_request",
  "model_started_event", "claim_recovery_loader", "live_resume_check", "persisted_cut_state", "next_step_state",
  "model_invocation", "usage_lineage_cut", "loop_result", "claim_loader_connection", "claim_loader_begin",
  "claim_loader_user_scope", "claim_loader_step_query", "claim_loader_call_query", "claim_loader_result_query",
  "claim_loader_event_query", "claim_loader_other_query", "claim_loader_commit", "claim_loader_rollback",
  "claim_loader_query_error", "claim_loader_lineage_conflict", "claim_loader_other_exception", "other",
])
const BOUNDED_LOOP_DIAGNOSTIC_PHASES = new Set(["start", "pass", "fail", "other"])
const BOUNDED_LOOP_LIVE_RESUME_CLASSES = new Set(["live_resume_expected_lineage", "other"])
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
const WORKER_F_CLAIM_PROOF_SQL = `SELECT COUNT(*)::int AS "candidateCount",
       COUNT(*) FILTER (WHERE ${CHILD_WAIT_CLAIM_RECOVERY_SQL})::int AS "matchedCount"
     FROM (SELECT started.* FROM "agent_events" AS started
       WHERE started."sessionId" = $1 AND started."turnId" = $3 AND started."taskId" = $2
         AND started."type" = 'tool_call.started' AND started."correlationId" = $13 AND $9::text IS NULL
       ORDER BY started."sequence" DESC LIMIT 2) AS started`
const CHANGE_RESULT_COMPLETE_SQL = `UPDATE "agent_events" SET "correlationId" = $1, "idempotencyKey" = $2,
        "payload" = jsonb_set("payload", '{itemId}', to_jsonb($1::text), false)
        WHERE "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "itemId" = $1
          AND "type" = 'item.completed' AND "idempotencyKey" = $6 RETURNING "id"`
const WORKER_F_UNSETTLED_STARTS_SQL = `SELECT started."id", started."turnId", started."type", started."correlationId",
         ($11::text IS NOT NULL) AS "sourceProjectionBound", ($12::text IS NOT NULL) AS "projectedSourceProjectionBound"
       FROM "agent_events" AS started
       WHERE started."sessionId" = $1 AND started."taskId" = $2
         AND started."type" IN ('tool_call.started', 'model.started')
         AND NOT EXISTS (
           SELECT 1 FROM "agent_events" AS settled
           WHERE settled."sessionId" = started."sessionId" AND settled."taskId" = started."taskId"
             AND settled."correlationId" = started."correlationId"
             AND ((started."type" = 'tool_call.started'
                   AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
                   AND ${CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL})
               OR (started."type" = 'model.started' AND settled."type" IN ('model.completed', 'model.failed')))
         )
         AND ($9::text IS NULL OR started."id" <> $9)
         AND NOT (started."type" = 'model.started' AND $10::text IS NOT NULL AND started."actor" = 'subagent'
           AND started."itemId" IS NULL AND started."turnId" = $3 AND started."correlationId" = $10
           AND started."idempotencyKey" = 'task:' || $2 || ':event:model-started:' || $10
           AND started."payload" = jsonb_build_object('taskId', $2, 'provider', started."payload"->>'provider', 'model', started."payload"->>'model')
           AND jsonb_typeof(started."payload"->'provider') = 'string' AND jsonb_typeof(started."payload"->'model') = 'string')
       ORDER BY started."sequence" DESC LIMIT 17`
const WORKER_F_UNSETTLED_STARTS_DIAGNOSTIC_SQL = WORKER_F_UNSETTLED_STARTS_SQL
const WORKER_F_SAME_CALL_ID_TERMINAL_PROOF_SQL = `SELECT ${CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL} AS "settled" FROM "agent_events" AS started
JOIN "agent_events" AS settled ON settled."sessionId" = started."sessionId" AND settled."turnId" = started."turnId"
  AND settled."taskId" = started."taskId" AND settled."correlationId" = started."correlationId"
WHERE $1::text IS NOT NULL AND $2::text IS NOT NULL AND $3::text IS NOT NULL AND $4::text IS NOT NULL
  AND $5::text IS NOT NULL AND $6::integer IS NOT NULL AND $7::timestamptz IS NOT NULL AND $8::text IS NOT NULL
  AND $9::text IS NOT NULL AND $10::text IS NOT NULL AND $11::text IS NOT NULL AND $12::text IS NOT NULL
  AND jsonb_typeof($13::jsonb) = 'array'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements($13::jsonb) AS proof(value)
    WHERE proof.value->>'startEventId' = $14::text AND proof.value->>'rawCallId' = $9::text
      AND proof.value->>'projectedCallId' = $10::text AND proof.value->>'callItemId' = $11::text
      AND proof.value->>'stepId' = $12::text)
  AND started."id" = $14 AND settled."id" = $15`
const WORKER_F_CLAIM_COMPONENTS_SQL = `WITH params AS MATERIALIZED (
  SELECT $1::text AS "sessionId", $2::text AS "taskId", $3::text AS "turnId", $4::text AS "rootTaskId",
    $5::text AS "leaseOwner", $6::integer AS "attemptCount", $7::timestamptz AS "leaseExpiresAt", $8::text AS "userId",
    $9::text AS "rawCallId", $10::text AS "projectedCallId", $11::text AS "startEventId", $12::text AS "callItemId",
    $13::jsonb AS "proofRows", $14::text AS "sourceCallId", $15::text AS "continuationStepId"
), proof AS MATERIALIZED (
  SELECT candidate.value FROM params
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(params."proofRows") = 'array' THEN params."proofRows" ELSE '[]'::jsonb END) AS candidate(value)
  WHERE candidate.value->>'startEventId' = params."startEventId" AND candidate.value->>'rawCallId' = params."rawCallId"
    AND candidate.value->>'projectedCallId' = params."projectedCallId" AND candidate.value->>'callItemId' = params."callItemId"
    AND candidate.value->'sourceWait'->>'sourceCallId' = params."sourceCallId"
    AND candidate.value->'sourceWait'->'claimKeyDigest' <> 'null'::jsonb
    AND candidate.value->>'attempt' = params."attemptCount"::text
    AND candidate.value->>'stepId' = params."continuationStepId"
)
SELECT (${CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL}) AS "historicalWaitBinding",
  (${CHILD_WAIT_SOURCE_PROJECTED_COMPLETION_SQL}) AS "projectedCompletion",
  (${CHILD_WAIT_CALL_ITEM_COMPLETED_NO_EVENT_SQL}) AS "callItemCompletedNoEvent",
  (${CHILD_WAIT_CALL_LIFECYCLE_SQL}) AS "callLifecycle",
  (${CHILD_WAIT_STEP_TOOL_CHAIN_EXCEPTION_SQL}) AS "stepToolChainException",
  CASE WHEN jsonb_typeof(proof.value->'stepToolChain'->'events') = 'array'
    THEN LEAST(jsonb_array_length(proof.value->'stepToolChain'->'events'), ${MAX_STEP_CHAIN_EVENTS + 1}) ELSE 0 END AS "chainEventCount",
  CASE WHEN jsonb_typeof(proof.value->'stepToolChain'->'calls') = 'array'
    THEN LEAST(jsonb_array_length(proof.value->'stepToolChain'->'calls'), ${MAX_STEP_TOOL_CALLS + 1}) ELSE 0 END AS "chainCallCount",
  (jsonb_typeof(proof.value->'stepToolChain'->'events') = 'array'
    AND jsonb_array_length(proof.value->'stepToolChain'->'events') BETWEEN 12 AND ${MAX_STEP_CHAIN_EVENTS}) AS "chainEventCountValid"
FROM params
JOIN "sub_agent_tasks" AS owner ON owner."id" = params."taskId" AND owner."sessionId" = params."sessionId"
  AND owner."turnId" = params."turnId" AND owner."rootTaskId" = params."rootTaskId" AND owner."parentTaskId" IS NOT NULL
  AND owner."status" = 'running' AND owner."leaseOwner" = params."leaseOwner" AND owner."attemptCount" = params."attemptCount"
  AND owner."leaseExpiresAt" = params."leaseExpiresAt" AND owner."interruptRequestedAt" IS NULL
JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = params."userId"
JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
  AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
JOIN proof ON TRUE
JOIN "agent_events" AS started ON started."id" = proof.value->>'startEventId'
  AND started."sessionId" = params."sessionId" AND started."turnId" = params."turnId" AND started."taskId" = params."taskId"
  AND started."itemId" = proof.value->>'callItemId' AND started."correlationId" = proof.value->>'rawCallId'
  AND started."type" = 'tool_call.started'
JOIN "agent_items" AS callItem ON callItem."id" = proof.value->>'callItemId'
  AND callItem."sessionId" = params."sessionId" AND callItem."turnId" = params."turnId" AND callItem."taskId" = params."taskId"
  AND callItem."type" = 'tool_call'
JOIN "agent_items" AS claimedCall ON claimedCall."id" = callItem."id"
JOIN "agent_steps" AS callStep ON callStep."id" = proof.value->>'stepId'
  AND callStep."sessionId" = params."sessionId" AND callStep."turnId" = params."turnId" AND callStep."taskId" = params."taskId"
  AND callStep."id" = params."continuationStepId"
JOIN "agent_steps" AS continuation ON continuation."id" = callStep."id" AND continuation."attempt" = params."attemptCount"
JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = callItem."sessionId"
  AND itemStarted."turnId" = callItem."turnId" AND itemStarted."taskId" = callItem."taskId"
  AND itemStarted."itemId" = callItem."id" AND itemStarted."type" = 'item.started'
LEFT JOIN "agent_events" AS itemCompleted ON itemCompleted."sessionId" = callItem."sessionId"
  AND itemCompleted."turnId" = callItem."turnId" AND itemCompleted."taskId" = callItem."taskId"
  AND itemCompleted."itemId" = callItem."id" AND itemCompleted."type" = 'item.completed'
LEFT JOIN "agent_events" AS resultExtra ON resultExtra."sessionId" = callItem."sessionId"
  AND resultExtra."turnId" = callItem."turnId" AND resultExtra."taskId" = callItem."taskId"
  AND resultExtra."id" = proof.value->'stepToolChain'->>'nextEventId'
LIMIT 2`

function safeProjectedWaitKey(input: { taskIds: readonly string[]; mode: "any" | "all"; timeoutMs: number; idempotencyKey: string }): string {
  const projected = asObject(safeSubagentWaitJson(input, 1_024))
  if (typeof projected.idempotencyKey !== "string") throw new Error("fixture_wait_key_projection_invalid")
  return projected.idempotencyKey
}

function historicalSourceStepPrefixPath(proof: string): string {
  return `(CASE WHEN ${proof} ? 'sourceStepPrefix' AND NOT (${proof} ? 'sourceStepHandoff') THEN ${proof}->'sourceStepPrefix'
    WHEN ${proof} ? 'sourceStepHandoff' AND NOT (${proof} ? 'sourceStepPrefix')
      THEN ${proof}->'sourceStepHandoff'->'sourceStepPrefix' ELSE '{}'::jsonb END)`
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

describe("worker restart blocker proof diagnostic bindings", () => {
  it("binds the recovered-source predicate and exact call identity through $13", () => {
    expectSqlBindings(WORKER_F_CLAIM_PROOF_SQL, 13)
  })
  it("binds changed result-completion event identity without parameter gaps", () => {
    expectSqlBindings(CHANGE_RESULT_COMPLETE_SQL, 6)
  })
  it("binds the bounded unsettled-start diagnostic to the exact task scope", () => {
    expectSqlBindings(WORKER_F_UNSETTLED_STARTS_DIAGNOSTIC_SQL, 13)
  })
  it("binds the same-call-ID source item/step/attempt terminal canary without gaps", () => {
    expectSqlBindings(WORKER_F_SAME_CALL_ID_TERMINAL_PROOF_SQL, 15)
  })
  it("binds claim-only component diagnostics without gaps", () => {
    expectSqlBindings(WORKER_F_CLAIM_COMPONENTS_SQL, 15)
  })
  it("selects the exclusive top-level prefix or nested handoff prefix in binding diagnostics", () => {
    const path = historicalSourceStepPrefixPath("proof.value")
    expect(path).toContain("proof.value->'sourceStepPrefix'")
    expect(path).toContain("proof.value->'sourceStepHandoff'->'sourceStepPrefix'")
    expect(HISTORICAL_SOURCE_STEP_BINDING_SQL).toContain("proof.value ? 'sourceStepPrefix' AND NOT (proof.value ? 'sourceStepHandoff')")
    expect(HISTORICAL_SOURCE_STEP_BINDING_SQL).toContain("proof.value ? 'sourceStepHandoff' AND NOT (proof.value ? 'sourceStepPrefix')")
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain('FROM "agent_events" AS sourceItemStarted')
    expect(CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL).toContain(HISTORICAL_SOURCE_STEP_BINDING_SQL)
  })
  it("parses loop-stage diagnostics into fixed enums and drops unknown fields", () => {
    const parsed = parseBoundedLoopDiagnostics(
      `${BOUNDED_LOOP_STAGE_MARKER}{"stage":"context_build","phase":"pass","liveResume":"other"}\n`
      + `${BOUNDED_LOOP_STAGE_MARKER}{"stage":"private","phase":"fail","liveResume":"private","payload":"test-only"}`,
    )
    expect(parsed).toEqual({ overflow: false, records: [
      { stage: "context_build", phase: "pass", liveResume: "other", exactKeys: true },
      { stage: "other", phase: "fail", liveResume: "other", exactKeys: false },
    ] })
    expect(summarizeBoundedLoopTrace(
      `${BOUNDED_LOOP_STAGE_MARKER}{"stage":"persisted_cut_state","phase":"fail","liveResume":"other","payload":"test-only"}`,
    )).toEqual({ stageCount: 1, overflow: false, exactKeys: false,
      stages: [{ stage: "persisted_cut_state", phase: "fail", liveResume: "other" }] })
    const overLimit = Array.from({ length: MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES + 1 }, () =>
      `${BOUNDED_LOOP_STAGE_MARKER}{"stage":"context_build","phase":"pass","liveResume":"other"}`,
    ).join("\n")
    expect(parseBoundedLoopDiagnostics(overLimit)).toMatchObject({ overflow: true })
    expect(parseBoundedLoopDiagnostics(overLimit).records).toHaveLength(MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES)
  })
  it("parses fixed claim-loader query and failure categories without retaining unknown fields", () => {
    const parsed = parseBoundedLoopDiagnostics([
      { stage: "claim_loader_connection", phase: "start" },
      { stage: "claim_loader_begin", phase: "pass" },
      { stage: "claim_loader_user_scope", phase: "pass" },
      { stage: "claim_loader_step_query", phase: "pass" },
      { stage: "claim_loader_call_query", phase: "pass" },
      { stage: "claim_loader_result_query", phase: "start" },
      { stage: "claim_loader_event_query", phase: "fail" },
      { stage: "claim_loader_other_query", phase: "fail" },
      { stage: "claim_loader_commit", phase: "pass" },
      { stage: "claim_loader_rollback", phase: "fail" },
      { stage: "claim_loader_query_error", phase: "fail" },
      { stage: "claim_loader_lineage_conflict", phase: "fail" },
      { stage: "claim_loader_other_exception", phase: "fail" },
      { stage: "private", phase: "fail", privateField: "synthetic-secret" },
    ].map(value => `${BOUNDED_LOOP_STAGE_MARKER}${JSON.stringify({ ...value, liveResume: "other" })}`).join("\n"))
    expect(parsed.records.map(({ stage, phase }) => [stage, phase])).toEqual([
      ["claim_loader_connection", "start"], ["claim_loader_begin", "pass"],
      ["claim_loader_user_scope", "pass"], ["claim_loader_step_query", "pass"],
      ["claim_loader_call_query", "pass"], ["claim_loader_result_query", "start"],
      ["claim_loader_event_query", "fail"], ["claim_loader_other_query", "fail"],
      ["claim_loader_commit", "pass"], ["claim_loader_rollback", "fail"],
      ["claim_loader_query_error", "fail"], ["claim_loader_lineage_conflict", "fail"],
      ["claim_loader_other_exception", "fail"], ["other", "fail"],
    ])
    expect(parsed.records.every(record => record.liveResume === "other")).toBe(true)
    expect(parsed.records.slice(0, -1).every(record => record.exactKeys)).toBe(true)
    expect(parsed.records.at(-1)?.exactKeys).toBe(false)
    expect(JSON.stringify(parsed)).not.toContain("synthetic-secret")
    expect(parsed.overflow).toBe(false)
  })
  it("reports workerD recovery with only bounded booleans, statuses, stages, and failure codes", () => {
    const privateId = "fixture-private-target-id", privateError = "fixture-private-error-text"
    const child = { stdoutText: [
      `WORKER_B_RECOVERED ${JSON.stringify({ reclaimed: 0, terminal: 0, rows: [{ id: privateId, status: "running", detail: privateError }] })}`,
      `WORKER_B_RECOVERY_PREDICATE_TRACE ${JSON.stringify({ pages: [{ targetSeen: true, cursorUsed: false }],
        rejectionStage: "unsettled_external_call_rejected", taskId: privateId, detail: privateError })}`,
      `WORKER_B_LOOP_STAGE ${JSON.stringify({ stage: "child_attempt_resume_loader", phase: "fail", private: privateError })}`,
      `WORKER_B_LOOP_RESUME_FAILURE ${JSON.stringify({ category: "child_resume_wait_step_lineage", error: privateError })}`,
    ].join("\n") } as unknown as WorkerProcess
    const diagnostic = boundedWorkerRecoveryDiagnostic(child, privateId)
    expect(JSON.parse(diagnostic)).toEqual({ recoveryCompleted: true, targetReturned: true, targetStatus: "running",
      candidateSeen: true, rejectionStage: "unsettled_external_call_rejected", childAttemptResumeLoader: "fail",
      resumeFailureCategory: "child_resume_wait_step_lineage" })
    expect(diagnostic).not.toContain(privateId)
    expect(diagnostic).not.toContain(privateError)

    const unknown = { stdoutText: [
      `WORKER_B_RECOVERY_PREDICATE_TRACE ${JSON.stringify({ pages: [], rejectionStage: privateError })}`,
      `WORKER_B_LOOP_RESUME_FAILURE ${JSON.stringify({ category: privateError, error: privateError })}`,
    ].join("\n") } as unknown as WorkerProcess
    expect(JSON.parse(boundedWorkerRecoveryDiagnostic(unknown, privateId))).toMatchObject({
      recoveryCompleted: false, targetReturned: false, targetStatus: "absent", candidateSeen: false,
      rejectionStage: "other", childAttemptResumeLoader: "not_seen", resumeFailureCategory: "other",
    })
    expect(boundedWorkerRecoveryDiagnostic(unknown, privateId)).not.toContain(privateError)
  })
})

function parseBoundedLoopDiagnostics(text: string): { overflow: boolean; records: Array<{
  stage: string; phase: string; liveResume: string; exactKeys: boolean
}> } {
  const allLines = text.split(/\r?\n/)
  const lines = allLines.filter(line => line.startsWith(BOUNDED_LOOP_STAGE_MARKER)).slice(0, MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES + 1)
  const records = lines.slice(0, MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES).map(line => {
    let row: Record<string, unknown>
    try { row = asObject(JSON.parse(line.slice(BOUNDED_LOOP_STAGE_MARKER.length)) as unknown) }
    catch { row = {} }
    const keys = Object.keys(row).sort()
    return {
      stage: typeof row.stage === "string" && BOUNDED_LOOP_DIAGNOSTIC_STAGES.has(row.stage) ? row.stage : "other",
      phase: typeof row.phase === "string" && BOUNDED_LOOP_DIAGNOSTIC_PHASES.has(row.phase) ? row.phase : "other",
      liveResume: typeof row.liveResume === "string" && BOUNDED_LOOP_LIVE_RESUME_CLASSES.has(row.liveResume)
        ? row.liveResume : "other",
      exactKeys: keys.length === 3 && keys[0] === "liveResume" && keys[1] === "phase" && keys[2] === "stage",
    }
  })
  return { overflow: lines.length > MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES
    || allLines.some(line => line.startsWith(BOUNDED_LOOP_STAGE_LIMIT_MARKER)), records }
}

function summarizeBoundedLoopTrace(text: string): {
  stageCount: number; overflow: boolean; exactKeys: boolean;
  stages: Array<{ stage: string; phase: string; liveResume: string }>
} {
  const { overflow, records } = parseBoundedLoopDiagnostics(text)
  return { stageCount: records.length, overflow, exactKeys: records.every(record => record.exactKeys),
    stages: records.map(({ stage, phase, liveResume }) => ({ stage, phase, liveResume })) }
}

function expectUsageLineageCutStages(child: WorkerProcess): void {
  const { overflow, records } = parseBoundedLoopDiagnostics(child.stdoutText)
  expect(overflow).toBe(false)
  expect(records.length).toBeLessThanOrEqual(MAX_BOUNDED_LOOP_DIAGNOSTIC_STAGES)
  expect(records.every(record => record.exactKeys)).toBe(true)
  const expectedSequence: Array<[string, string]> = [
    ["durable_wait_loader", "start"], ["durable_wait_loader", "pass"],
    ["child_attempt_resume_loader", "start"], ["child_attempt_resume_loader", "pass"],
    ["restored_wait_validation", "start"], ["restored_wait_validation", "pass"],
    ["execution_loop_recovery", "start"], ["execution_loop_recovery", "pass"],
    ["step_start", "start"], ["step_start", "pass"],
    ["step_started_event", "start"], ["step_started_event", "pass"],
    ["context_build", "start"], ["context_build", "pass"],
    ["agenda_build", "start"], ["agenda_build", "pass"],
    ["agenda_persist", "start"], ["agenda_persist", "pass"],
    ["model_request", "start"], ["model_request", "pass"],
    ["model_started_event", "start"],
    ["claim_recovery_loader", "start"], ["claim_recovery_loader", "pass"],
    ["live_resume_check", "start"], ["live_resume_check", "pass"],
    ["persisted_cut_state", "start"], ["persisted_cut_state", "pass"],
    ["next_step_state", "start"], ["next_step_state", "pass"],
    ["usage_lineage_cut", "pass"],
  ]
  let previousIndex = -1
  for (const [stage, phase] of expectedSequence) {
    const index = records.findIndex((record, candidate) => candidate > previousIndex
      && record.stage === stage && record.phase === phase)
    expect(index, `stage=${stage}; phase=${phase}`).toBeGreaterThan(previousIndex)
    previousIndex = index
  }
  expect(records.some(record => record.stage === "live_resume_check" && record.phase === "pass"
    && record.liveResume === "live_resume_expected_lineage")).toBe(true)
  expect(records.some(record => record.stage === "model_invocation")).toBe(false)
}

function expectSqlBindings(sql: string, parameterCount: number): void {
  const indices = [...new Set(Array.from(sql.matchAll(/\$(\d+)/g), match => Number(match[1])))].sort((a, b) => a - b)
  expect(indices).toEqual(Array.from({ length: parameterCount }, (_, index) => index + 1))
}
type FixtureIds = { userId: string; sessionId: string; turnId: string; rootTaskId: string; waiterTaskId: string; targetTaskId: string;
  secondTargetTaskId?: string; waitScopedClaimCallIds?: boolean;
  finalText?: string; loopCallPrefix?: string; recoveryTargetPageRank?: number; recoveryCandidateCount?: number;
  recoveryFixtureBlockerCount?: number; recoveryCandidateObservedAt?: string;
  sourcePriorTool?: boolean;
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

function launchWorker(mode: "worker-a" | "worker-a-prior-tool" | "worker-a-prior-tool-failed" | "worker-a-crash" | "worker-b-crash-before-resume" | "worker-b-crash-resume" | "worker-b-crash-source-lifecycle" | "worker-b-crash-after-wait-ack" | "worker-b-crash-before-claim" | "worker-b-crash-after-orphan-reissue" | "worker-b-crash-after-claim-result" | "worker-b-loop-preclaim" | "worker-b-loop-claim-recovery-cut" | "worker-b-loop-claim-item-completed-cut" | "worker-b-loop-usage-lineage-cut" | "worker-b-loop-usage-lineage-reject" | "worker-b-loop-final" | "worker-b-loop-multi-preclaim" | "worker-b-loop-multi-complete-cut" | "worker-b-loop-two-waits" | "worker-b-loop-multi-reject" | "worker-b-legacy-consumed-seed" | "worker-b-legacy-consumed-source-only" | "worker-b-legacy-consumed-recovery" | "worker-b-legacy-consumed-final" | "worker-b", queueName: string, ids: FixtureIds): WorkerProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixturePath, mode, queueName, JSON.stringify(ids)], {
    cwd: workerCwd,
    env: { ...process.env, DATABASE_URL: databaseUrl!, AGENT_RUNTIME_PG_TEST_URL: databaseUrl!, AGENT_TURN_REDIS_TEST_URL: redisUrl!,
      ...(mode === "worker-b-crash-resume" || mode === "worker-b-loop-claim-item-completed-cut" || mode === "worker-b-loop-usage-lineage-reject"
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

async function waitForBoundedLoopMarker(child: WorkerProcess, marker: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.stdoutText.includes(marker)) return
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`bounded_loop_marker_missing:${JSON.stringify(summarizeBoundedLoopTrace(child.stdoutText))}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`bounded_loop_marker_timeout:${JSON.stringify(summarizeBoundedLoopTrace(child.stdoutText))}`)
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

function workerWaitGuardDiagnostic(child: WorkerProcess): Record<string, unknown> | null {
  const prefix = "WORKER_A_WAIT_GUARD_FAILED "
  const line = child.stdoutText.split(/\r?\n/).find(value => value.startsWith(prefix))
  if (!line) return null
  try {
    const row = asObject(JSON.parse(line.slice(prefix.length)) as unknown)
    const statusCategories = new Set(["waiting_for_dependency", "waiting_for_user", "waiting_for_approval", "completed", "failed", "interrupted", "other"])
    const countCategories = new Set(["zero", "one", "multiple"])
    return {
      waitRegistered: row.waitRegistered === true,
      loopStatusCategory: typeof row.loopStatusCategory === "string" && statusCategories.has(row.loopStatusCategory)
        ? row.loopStatusCategory : "other",
      resultWaitIdMatches: row.resultWaitIdMatches === true,
      modelInvocationCountCategory: typeof row.modelInvocationCountCategory === "string" && countCategories.has(row.modelInvocationCountCategory)
        ? row.modelInvocationCountCategory : "other",
    }
  } catch { return { diagnostic: "unparseable" } }
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

async function workerFailureDiagnostic(pool: Pool, child: WorkerProcess, ids: FixtureIds): Promise<string> {
  const status = workerResultStatus(child, "WORKER_A_WAITING")
  const diagnostic: Record<string, unknown> = { sample: "post_commit_read_committed_task_scope", status,
    markerFailureReasonCategory: status === "failed" ? workerFailureReasonCategory(child, "WORKER_A_WAITING") : null,
    waitGuard: status === "failed" ? workerWaitGuardDiagnostic(child) : null }
  if (status !== "failed") return JSON.stringify(diagnostic)
  let client: PoolClient | undefined
  let transactionStarted = false
  try {
    client = await pool.connect()
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    transactionStarted = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
    const task = await client.query<{ status: string; failureReason: string | null }>(
      `SELECT task."status", task."failureReason" FROM "sub_agent_tasks" AS task
       JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $5
       WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId, ids.userId],
    )
    const row = task.rows[0]
    diagnostic.taskRowCount = task.rows.length
    diagnostic.persistedStatus = row ? diagnosticTaskStatus(row.status) : null
    diagnostic.persistedFailureReasonCategory = !row || typeof row.failureReason !== "string" ? "missing"
      : WORKER_FAILURE_REASON_CATEGORIES.includes(row.failureReason as WorkerFailureReasonCategory)
        ? row.failureReason : "other"
  } catch {
    diagnostic.taskQuery = "unavailable"
  } finally {
    if (client) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
  return JSON.stringify(diagnostic)
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
    const claimProof = await diagnoseWorkerFClaimProof(client, task, continuationStepId, sourceCallId, claimCallId)
    const startDiagnostics = await diagnoseWorkerFStartCandidates(client, task, continuationStepId, sourceCallId, claimCallId, blocker)
    return { snapshot: "post_recovery_attempt_read_committed", taskRowCount: taskResult.rows.length,
      taskStatus: diagnosticTaskStatus(row.status), attemptCount: row.attemptCount,
      leaseOwnerPresent: true, leaseExpired: row.leaseExpiresAt.getTime() <= Date.now(), claimProof, blocker, ...startDiagnostics }
  } catch {
    return { snapshot: "post_recovery_attempt_read_committed", predicateProbe: "unavailable" }
  } finally {
    if (client) {
      if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
}

async function diagnoseWorkerFStartCandidates(
  client: PoolClient, task: BlockingTaskSnapshot, continuationStepId: string,
  sourceCallId: string, claimCallId: string, blocker: boolean,
): Promise<Record<string, unknown>> {
  const sourceProjection = await readChildWaitSourceCallProjection(client, task as unknown as Record<string, unknown>, continuationStepId)
  const terminalCallProjections = await readChildWaitTerminalCallProjections(client, task as unknown as Record<string, unknown>)
  const sourceProjections = terminalCallProjections.filter(projection => projection.sourceWait.claimKeyDigest === null)
  const claimProjections = terminalCallProjections.filter(projection => projection.sourceWait.claimKeyDigest !== null)
  const starts = await client.query<{ id: string; turnId: string; type: string; correlationId: string;
    sourceProjectionBound: boolean; projectedSourceProjectionBound: boolean }>(
    WORKER_F_UNSETTLED_STARTS_DIAGNOSTIC_SQL, [task.sessionId, task.id, task.turnId, task.rootTaskId,
      task.leaseOwner, task.attemptCount, task.leaseExpiresAt, task.userId, null, continuationStepId,
      sourceProjection?.rawCallId ?? null, sourceProjection?.projectedCallId ?? null, JSON.stringify(terminalCallProjections)],
  )
  const classified = []
  for (const [index, start] of starts.rows.slice(0, 16).entries()) {
    const blockedWhenOmitted = await hasBlockingExternalCall(client,
      task as unknown as Record<string, unknown>, start.id, continuationStepId)
    const lane = start.correlationId === sourceCallId ? "source_wait"
      : start.correlationId === claimCallId ? "continuation_claim"
        : start.correlationId === continuationStepId ? "continuation_model" : "other"
    const projection = terminalCallProjections.find(candidate => candidate.startEventId === start.id)
    classified.push({ candidateOrdinal: index + 1, lane, type: start.type,
      kind: start.type === "tool_call.started" ? "tool_call" : "model_call",
      sameTurn: start.turnId === task.turnId,
      sourceProjectionBound: start.sourceProjectionBound && start.projectedSourceProjectionBound,
      projectionBound: !!projection, sourcePrefixBound: !!projection?.sourceStepPrefix,
      claimChainBound: !!projection?.stepToolChain,
      blockedWhenOmitted, isSoleBlocker: blocker && !blockedWhenOmitted })
  }
  return { examinedStartCount: classified.length, unsettledStartCandidateCount: starts.rows.length,
    unsettledStartCandidatesTruncated: starts.rows.length > 16,
    sourceProjectionCount: sourceProjections.length, claimProjectionCount: claimProjections.length,
    sourcePrefixCount: sourceProjections.filter(projection => !!projection.sourceStepPrefix).length,
    sourceHandoffCount: sourceProjections.filter(projection => !!projection.sourceStepHandoff).length,
    hasSourceProjection: sourceProjections.length === 1,
    hasSourcePrefix: sourceProjections.length === 1 && !!sourceProjections[0]?.sourceStepPrefix,
    hasSourceHandoff: sourceProjections.length === 1 && !!sourceProjections[0]?.sourceStepHandoff,
    claimPrefixCount: claimProjections.filter(projection => !!projection.sourceStepPrefix).length,
    claimChainCount: claimProjections.filter(projection => !!projection.stepToolChain).length,
    sourceCallProjectionInputsPresent: !!sourceProjection?.rawCallId && !!sourceProjection.projectedCallId,
    starts: classified }
}

async function diagnoseHistoricalSourceFinalBinding(client: PoolClient, task: BlockingTaskSnapshot,
  continuationStepId: string, sourceCallId: string): Promise<Record<string, unknown>> {
  const sourceProjection = await readChildWaitSourceCallProjection(client, task as unknown as Record<string, unknown>, continuationStepId)
  const projections = await readChildWaitTerminalCallProjections(client, task as unknown as Record<string, unknown>)
  const sourceProjections = projections.filter(projection => projection.sourceWait.claimKeyDigest === null
    && projection.rawCallId === sourceCallId)
  const path = historicalSourceStepPrefixPath("proof.value")
  const callSegments = historicalSourceStepCallChainDiagnosticSql(path)
  const sql = `WITH typed_params AS MATERIALIZED (SELECT $1::text, $2::text, $3::text, $4::text, $5::text,
      $6::integer, $7::timestamptz, $8::text, $9::text, $10::text, $11::text, $12::text, $13::jsonb, $14::text)
    SELECT
      (proof.value->>'startEventId' = started."id" AND proof.value->>'rawCallId' = started."correlationId"
        AND proof.value->>'callItemId' = callItem."id" AND proof.value->>'stepId' = callItem."stepId"
        AND proof.value->>'attempt' = callStep."attempt"::text) AS "sourceProjectionMatch",
      (owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4
        AND owner."parentTaskId" IS NOT NULL AND owner."status" = 'running' AND owner."leaseOwner" = $5
        AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7 AND owner."interruptRequestedAt" IS NULL
        AND session."userId" = $8 AND turn."sessionId" = owner."sessionId" AND turn."userId" = session."userId"
        AND turn."rootTaskId" = owner."rootTaskId") AS "ownerLeaseFence",
      (${CHILD_WAIT_HISTORICAL_SOURCE_RESULT_RECEIPT_SQL}) AS "sourceReceiptBinding",
      (${CHILD_WAIT_HISTORICAL_SOURCE_EVENT_BINDING_SQL}) AS "sourceEventAndStepBinding",
      CASE WHEN proof.value ? 'sourceStepPrefix' AND NOT (proof.value ? 'sourceStepHandoff')
        THEN (${HISTORICAL_SOURCE_STEP_PREFIX_SQL}) ELSE FALSE END AS "sourceStepPrefixBinding",
      (${historicalSourceStepEventChainBinding(path)}) AS "sourceEventChain",
      (${historicalSourceStepCallChainBinding(path)}) AS "sourceCallChain",
      (${callSegments.itemCardinality}) AS "callItemCardinality",
      (${callSegments.allItems}) AS "callAllItems",
      (${callSegments.commentCardinality}) AS "callCommentCardinality",
      (${callSegments.eventCardinality}) AS "callEventCardinality",
      (${callSegments.anchorChain}) AS "callChainAnchor",
      (${callSegments.finalClose}) AS "callChainFinalClose",
      (${callSegments.validCallCount} = ${callSegments.callCount}) AS "callRowsValid",
      ${callSegments.perCallChecks} AS "perCallChecks",
      (${historicalSourceStepCallCountBinding(path)}) AS "sourceCallCount",
      (${CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL}) AS "historicalWaitBinding",
      CASE WHEN settled."id" IS NULL THEN FALSE ELSE (${CHILD_WAIT_CALL_TERMINAL_SETTLEMENT_SQL}) END AS "terminalSettlement"
    FROM typed_params
    JOIN "sub_agent_tasks" AS owner ON owner."id" = $2
    LEFT JOIN "agent_sessions" AS session ON session."id" = owner."sessionId"
    LEFT JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof($13::jsonb) = 'array' THEN $13::jsonb ELSE '[]'::jsonb END) AS proof(value)
    JOIN "agent_events" AS started ON started."id" = proof.value->>'startEventId'
      AND started."sessionId" = $1 AND started."turnId" = $3 AND started."taskId" = $2
    JOIN "agent_items" AS callItem ON callItem."id" = started."itemId" AND callItem."sessionId" = started."sessionId"
      AND callItem."turnId" = started."turnId" AND callItem."taskId" = started."taskId" AND callItem."type" = 'tool_call'
    JOIN "agent_steps" AS callStep ON callStep."id" = callItem."stepId" AND callStep."sessionId" = callItem."sessionId"
      AND callStep."turnId" = callItem."turnId" AND callStep."taskId" = callItem."taskId"
    LEFT JOIN "agent_wait_conditions" AS boundWait ON boundWait."id" = proof.value->'sourceWait'->>'waitId'
      AND boundWait."parentTaskId" = $2 AND boundWait."sessionId" = $1 AND boundWait."turnId" = $3 AND boundWait."userId" = $8
    LEFT JOIN "agent_steps" AS boundSource ON boundSource."id" = proof.value->'sourceWait'->>'sourceStepId'
      AND boundSource."sessionId" = $1 AND boundSource."turnId" = $3 AND boundSource."taskId" = $2
      AND boundSource."id" = boundWait."stepId"
    LEFT JOIN "agent_items" AS boundSourceCall ON boundSourceCall."id" = proof.value->'sourceWait'->>'sourceCallItemId'
      AND boundSourceCall."sessionId" = $1 AND boundSourceCall."turnId" = $3 AND boundSourceCall."taskId" = $2
      AND boundSourceCall."stepId" = boundSource."id" AND boundSourceCall."type" = 'tool_call'
    LEFT JOIN "agent_items" AS boundSourceResult ON boundSourceResult."id" = proof.value->'sourceWait'->>'sourceResultItemId'
      AND boundSourceResult."sessionId" = $1 AND boundSourceResult."turnId" = $3 AND boundSourceResult."taskId" = $2
      AND boundSourceResult."type" = 'tool_result'
    LEFT JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = callItem."sessionId"
      AND itemStarted."turnId" = callItem."turnId" AND itemStarted."taskId" = callItem."taskId"
      AND itemStarted."itemId" = callItem."id" AND itemStarted."type" = 'item.started'
    LEFT JOIN "agent_events" AS itemCompleted ON itemCompleted."sessionId" = callItem."sessionId"
      AND itemCompleted."turnId" = callItem."turnId" AND itemCompleted."taskId" = callItem."taskId"
      AND itemCompleted."itemId" = callItem."id" AND itemCompleted."type" = 'item.completed'
    LEFT JOIN "agent_events" AS sourceResultCompleted ON sourceResultCompleted."sessionId" = $1
      AND sourceResultCompleted."turnId" = $3 AND sourceResultCompleted."taskId" = $2
      AND sourceResultCompleted."itemId" = boundSourceResult."id" AND sourceResultCompleted."type" = 'item.completed'
    LEFT JOIN "agent_events" AS settled ON settled."sessionId" = started."sessionId"
      AND settled."turnId" = started."turnId" AND settled."taskId" = started."taskId"
      AND settled."correlationId" = started."correlationId"
      AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
    WHERE proof.value->>'rawCallId' = $14 AND proof.value->>'callItemId' = callItem."id"
      AND proof.value->>'stepId' = callStep."id" AND proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb
      AND callItem."content"->>'toolCallId' = $14
    LIMIT 2`
  const rows = await client.query<Record<string, unknown>>(sql, [task.sessionId, task.id, task.turnId, task.rootTaskId,
    task.leaseOwner, task.attemptCount, task.leaseExpiresAt, task.userId, null, continuationStepId,
    sourceProjection?.rawCallId ?? null, sourceProjection?.projectedCallId ?? null, JSON.stringify(projections), sourceCallId])
  if (sourceProjections.length !== 1 || rows.rows.length !== 1) return { outcome: "unknown",
    sourceProjectionCount: sourceProjections.length, bindingRowCount: rows.rows.length }
  const row = rows.rows[0]!
  const flag = (key: string) => row[key] === true
  const rawCallChecks = Array.isArray(row.perCallChecks) ? row.perCallChecks.slice(0, 17) : []
  const perCallChecks = rawCallChecks.map(value => {
    const fields = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
    return { isSourceWait: fields.isSourceWait === true, contentValid: fields.contentValid === true, eventChainValid: fields.eventChainValid === true }
  })
  return { outcome: "evaluated", sourceProjectionCount: 1,
    sourceProjectionMatch: flag("sourceProjectionMatch"), ownerLeaseFence: flag("ownerLeaseFence"),
    sourceReceiptBinding: flag("sourceReceiptBinding"), sourceEventAndStepBinding: flag("sourceEventAndStepBinding"),
    sourceStepPrefixBinding: flag("sourceStepPrefixBinding"), sourceEventChain: flag("sourceEventChain"),
    sourceCallChain: flag("sourceCallChain"), callItemCardinality: flag("callItemCardinality"),
    callAllItems: flag("callAllItems"),
    callCommentCardinality: flag("callCommentCardinality"), callEventCardinality: flag("callEventCardinality"),
    callChainAnchor: flag("callChainAnchor"),
    callChainFinalClose: flag("callChainFinalClose"), callRowsValid: flag("callRowsValid"), perCallChecks,
    sourceCallCount: flag("sourceCallCount"),
    historicalWaitBinding: flag("historicalWaitBinding"), terminalSettlement: flag("terminalSettlement") }
}

async function expectHistoricalWaitUnblocked(client: PoolClient, task: BlockingTaskSnapshot,
  continuationStepId: string, sourceCallId: string, claimCallId: string, message: string): Promise<void> {
  try {
    await expect(hasBlockingExternalCall(client, task as unknown as Record<string, unknown>, undefined, continuationStepId), message)
      .resolves.toBe(false)
  } catch (error: unknown) {
    const diagnostic = await withHistoricalWaitDiagnosticSavepoint(client, async () => {
      const starts = await diagnoseWorkerFStartCandidates(client, task, continuationStepId, sourceCallId, claimCallId, true)
      const sourceReader = await diagnoseHistoricalWaitSourceProjection(client, task, sourceCallId)
      const finalBinding = await diagnoseHistoricalSourceFinalBinding(client, task, continuationStepId, sourceCallId)
      const claimFinal = await diagnoseHistoricalClaimFinal(client, task, continuationStepId, sourceCallId, claimCallId)
      return { ...starts, sourceReader, finalBinding, claimFinal }
    }) ?? { probeAvailable: false, sourceReader: { outcome: "unknown" }, finalBinding: { outcome: "unknown" },
      claimFinal: { outcome: "unknown" } }
    const suffix = `; redacted historical-wait diagnostic=${JSON.stringify(diagnostic)}`
    if (error instanceof Error) {
      error.message += suffix
      throw error
    }
    throw new Error(`${message}${suffix}`)
  }
}

async function diagnoseHistoricalWaitSourceProjection(client: PoolClient, task: BlockingTaskSnapshot,
  sourceCallId: string): Promise<Record<string, unknown>> {
  const claimStageDiagnostics = await diagnoseChildWaitTerminalCallProjections(client, task as unknown as Record<string, unknown>)
  const projections = await readChildWaitTerminalCallProjections(client, task as unknown as Record<string, unknown>)
  let sourceProjectionCount = 0
  const waits = await client.query<Record<string, unknown>>(`SELECT wait.*,
      source."status" AS "sourceStepStatus",
      (SELECT COUNT(*)::int FROM "agent_wait_conditions" AS duplicateWait WHERE duplicateWait."parentTaskId" = wait."parentTaskId"
        AND duplicateWait."sessionId" = wait."sessionId" AND duplicateWait."turnId" = wait."turnId" AND duplicateWait."stepId" = wait."stepId") AS "sourceWaitCount"
    FROM "agent_wait_conditions" AS wait
    JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
      AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
    JOIN "agent_items" AS sourceCall ON sourceCall."sessionId" = wait."sessionId" AND sourceCall."turnId" = wait."turnId"
      AND sourceCall."taskId" = wait."parentTaskId" AND sourceCall."stepId" = wait."stepId"
      AND sourceCall."type" = 'tool_call' AND sourceCall."content"->>'toolCallId' = $5
    WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."userId" = $4
    LIMIT 2`, [task.id, task.sessionId, task.turnId, task.userId, sourceCallId])
  if (waits.rows.length !== 1) return { sourceProjectionCount, sourceWaitCount: waits.rows.length,
    claimStageDiagnostics, rejectStage: "source_wait_match" }

  const wait = waits.rows[0]!, stepId = wait.stepId
  sourceProjectionCount = typeof wait.id === "string"
    ? projections.filter(projection => projection.sourceWait.waitId === wait.id && projection.sourceWait.claimKeyDigest === null).length : 0
  const sourceWaitMultiplicity = Number(wait.sourceWaitCount)
  const markerPresent = Object.hasOwn(asObject(wait.result), "sourceLifecycleRecovery")
  if (typeof stepId !== "string") return { sourceProjectionCount, claimStageDiagnostics, sourceKind: markerPresent ? "recovered" : "normal_waiting",
    sourceStepStatus: wait.sourceStepStatus, sourceWaitMultiplicity, markerPresent, markerValidationPassed: false, stepItemCount: 0, anchorCount: 0,
    rejectStage: "source_step_identity" }
  const [items, callRows] = await Promise.all([
    client.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_items"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4`,
    [task.sessionId, task.turnId, task.id, stepId]),
    client.query<{ id: string }>(`SELECT "id" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
      AND "stepId" = $4 AND "type" = 'tool_call' AND "content"->>'toolCallId' = $5 LIMIT 2`,
    [task.sessionId, task.turnId, task.id, stepId, sourceCallId]),
  ])
  const stepItemCount = Number(items.rows[0]?.count ?? 0)
  if (callRows.rows.length !== 1) return { sourceProjectionCount, claimStageDiagnostics, sourceKind: markerPresent ? "recovered" : "normal_waiting",
    sourceStepStatus: wait.sourceStepStatus, sourceWaitMultiplicity, markerPresent, markerValidationPassed: false, stepItemCount, anchorCount: 0,
    rejectStage: "source_call_match" }

  let lifecycle: Awaited<ReturnType<typeof inspectChildWaitSourceLifecycle>> | undefined
  let lifecycleRejectStage: string | undefined
  try {
    lifecycle = await inspectChildWaitSourceLifecycle(client, { id: task.id, sessionId: task.sessionId, turnId: task.turnId,
      rootTaskId: task.rootTaskId, userId: task.userId, ownerId: task.leaseOwner, attemptCount: task.attemptCount,
      leaseExpiresAt: task.leaseExpiresAt } as never, wait, stepId, asObject(wait.result).outcome as never)
  } catch (error: unknown) {
    lifecycleRejectStage = error && typeof error === "object" && "sourceLifecycleStage" in error
      ? String(error.sourceLifecycleStage) : "unknown"
  }
  const markerValidationPassed = lifecycle !== undefined
    && (markerPresent ? lifecycle.state === "recovered" : lifecycle.state === "waiting")
  const sourceKind = lifecycle?.state === "waiting" ? "normal_waiting" : lifecycle?.state ?? (markerPresent ? "recovered" : "normal_waiting")
  const callItemId = lifecycle?.callItemId ?? callRows.rows[0]!.id
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
  const anchorKeys = agendaKey ? [
    `task:${task.id}:event:step-started:${stepId}`, `task:${task.id}:event:${agendaKey}`,
    `task:${task.id}:event:model-started:${stepId}`, `task:${task.id}:event:model-completed:${stepId}`,
    `task:${task.id}:event:model-usage:${stepId}`, `task:${task.id}:event:item-started:${callItemId}`,
  ] : []
  const anchorRows = anchorKeys.length ? await client.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = ANY($4::text[])`,
  [task.sessionId, task.turnId, task.id, anchorKeys]) : { rows: [{ count: 0 }] }
  const anchorCount = Number(anchorRows.rows[0]?.count ?? 0)
  const [stepStartedAnchors, stepCompletedAnchors] = await Promise.all([
    client.query<{ sequence: string; exactAnchor: boolean; canonicalKey: boolean }>(`SELECT event."sequence"::text AS "sequence",
        event."idempotencyKey" = $4 AS "canonicalKey",
        (event."actor" = 'subagent' AND event."itemId" IS NULL AND event."correlationId" = $5
          AND event."idempotencyKey" = $4) AS "exactAnchor"
      FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
        AND event."type" = 'step.started' AND (event."correlationId" = $5 OR event."idempotencyKey" = $4) LIMIT 4`,
    [task.sessionId, task.turnId, task.id, `task:${task.id}:event:step-started:${stepId}`, stepId]),
    client.query<{ sequence: string; exactAnchor: boolean; canonicalKey: boolean }>(`SELECT event."sequence"::text AS "sequence",
        event."idempotencyKey" = $4 AS "canonicalKey",
        (event."actor" = 'subagent' AND event."itemId" IS NULL AND event."correlationId" = $5
          AND event."idempotencyKey" = $4 AND event."payload"->>'stepId' = $5
          AND event."payload"->>'status' = 'waiting_for_dependency' AND event."payload"->>'taskId' = $3
          AND jsonb_typeof(event."payload"->'toolCallCount') = 'number') AS "exactAnchor"
      FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
        AND event."type" = 'step.completed' AND (event."correlationId" = $5 OR event."idempotencyKey" = $4) LIMIT 4`,
    [task.sessionId, task.turnId, task.id, `task:${task.id}:event:step-completed:${stepId}`, stepId]),
  ])
  const stepStartedExact = stepStartedAnchors.rows.filter(row => row.exactAnchor)
  const stepCompletedCanonicalCount = stepCompletedAnchors.rows.filter(row => row.canonicalKey).length
  const stepCompletedExact = stepCompletedAnchors.rows.filter(row => row.exactAnchor)
  let prefixWindowBoundaryAvailable = false
  let prefixWindowEventCount: number | null = null
  if (sourceKind === "normal_waiting" && stepStartedExact.length === 1 && stepCompletedExact.length === 1) {
    try {
      const from = BigInt(stepStartedExact[0]!.sequence), through = BigInt(stepCompletedExact[0]!.sequence)
      if (from < through) {
        prefixWindowBoundaryAvailable = true
        const eventWindow = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM (
            SELECT sourceEvent."id" FROM "agent_events" AS sourceEvent
            WHERE sourceEvent."sessionId" = $1 AND sourceEvent."turnId" = $2 AND sourceEvent."taskId" = $3
              AND sourceEvent."sequence" BETWEEN $4::bigint AND $5::bigint
            ORDER BY sourceEvent."sequence" LIMIT ${MAX_STEP_TOOL_CALLS * 9 + 17}) AS boundedSourceEvents`,
        [task.sessionId, task.turnId, task.id, from.toString(), through.toString()])
        prefixWindowEventCount = Number(eventWindow.rows[0]?.count ?? 0)
      }
    } catch { prefixWindowBoundaryAvailable = false }
  }
  const sourceStart = await client.query<{ count: number }>(`SELECT COUNT(*)::int AS "count" FROM "agent_events"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "itemId" = $4 AND "type" = 'tool_call.started'
      AND "actor" = 'subagent' AND "correlationId" = $5 AND "idempotencyKey" = 'task:' || $3 || ':event:tool-started:' || $5
      AND "payload" = jsonb_build_object('toolCallId', $5, 'toolName', 'wait_subagents', 'taskId', $3)`,
  [task.sessionId, task.turnId, task.id, callItemId, sourceCallId])
  let prefixAvailable = false
  if (lifecycle?.resultItemId && lifecycle.state !== "unreconciled") {
    try {
      const prefixInput = lifecycle.state === "recovered"
        ? { stepId, attempt: lifecycle.sourceAttempt, callItemId: lifecycle.callItemId, callId: lifecycle.toolCallId,
            resultItemId: lifecycle.resultItemId, waitKind: "recovered" as const, terminalMode: "recovered_handoff" as const }
        : { stepId, attempt: lifecycle.sourceAttempt, callItemId: lifecycle.callItemId, callId: lifecycle.toolCallId,
            resultItemId: lifecycle.resultItemId, waitKind: "normal_waiting" as const }
      prefixAvailable = Boolean(await readCanonicalHistoricalSourceStepPrefix(client,
        { id: task.id, sessionId: task.sessionId, turnId: task.turnId }, prefixInput))
    } catch { prefixAvailable = false }
  }
  let rejectStage = "none"
  const sourceStartCount = Number(sourceStart.rows[0]?.count ?? 0)
  const knownLifecycleStages = new Set(["required_value", "resume_scope", "source_step", "source_call_count", "source_call_input",
    "source_item_set", "wait_record_shape", "provenance_marker", "source_receipt_missing", "source_marker_without_result",
    "source_recovered_receipt_mismatch", "source_waiting_content", "source_waiting_output_shape", "source_waiting_identity",
    "source_waiting_targets", "source_waiting_matched_ids", "source_waiting_tasks", "source_waiting_task_ids", "source_waiting_deadline",
    "source_initial_call_shape", "source_call_completion_state", "source_result_completion_state", "source_call_completion_content",
    "source_result_completion_content", "source_waiting_output_missing", "source_event_chain", "reconciliation", "safe_result_shape", "source_start_event"])
  const safeLifecycleRejectStage = lifecycleRejectStage && knownLifecycleStages.has(lifecycleRejectStage) ? lifecycleRejectStage : "unknown"
  if (!markerValidationPassed) rejectStage = `source_lifecycle:${safeLifecycleRejectStage}`
  else if (sourceWaitMultiplicity !== 1) rejectStage = "source_wait_multiplicity"
  else if (sourceStartCount !== 1) rejectStage = "source_start_event"
  else if (prefixAvailable) rejectStage = sourceProjectionCount ? "none" : "source_projection_shape"
  else if (sourceKind !== "recovered") rejectStage = "historical_source_step_prefix"
  else if (wait.sourceStepStatus !== "waiting_for_tool") rejectStage = "recovered_handoff_step_status"
  else if (stepItemCount < 2 || stepItemCount > MAX_STEP_TOOL_CALLS * 2 + 2) rejectStage = "recovered_handoff_item_count"
  else if (anchorCount !== 6) rejectStage = "recovered_handoff_anchor_count"
  else rejectStage = "recovered_handoff_event_chain_or_payload"
  let prefixRejectStage = "unknown"
  if (!markerValidationPassed) prefixRejectStage = "source_lifecycle"
  else if (sourceWaitMultiplicity !== 1) prefixRejectStage = "source_wait_multiplicity"
  else if (sourceStartCount !== 1) prefixRejectStage = "source_call_start_event"
  else if (prefixAvailable) prefixRejectStage = sourceProjectionCount ? "accepted" : "source_projection_shape"
  else if (sourceKind === "normal_waiting") {
    if (stepStartedExact.length !== 1) prefixRejectStage = "step_started_anchor"
    else if (stepCompletedCanonicalCount === 0) prefixRejectStage = "step_completed_anchor_missing"
    else if (stepCompletedExact.length !== 1) prefixRejectStage = "step_completed_anchor_invalid_or_duplicate"
    else if (!prefixWindowBoundaryAvailable) prefixRejectStage = "prefix_window_boundary"
    else if (prefixWindowEventCount === null || prefixWindowEventCount < 12 || prefixWindowEventCount > MAX_STEP_TOOL_CALLS * 9 + 16)
      prefixRejectStage = "prefix_window_event_count"
    else if (stepItemCount < 2 || stepItemCount > MAX_STEP_TOOL_CALLS * 2 + 2) prefixRejectStage = "prefix_window_item_count"
    else prefixRejectStage = "prefix_event_chain_or_payload"
  } else if (sourceKind === "recovered") prefixRejectStage = rejectStage
  else prefixRejectStage = "source_lifecycle"
  return { sourceProjectionCount, sourceKind, sourceStepStatus: wait.sourceStepStatus, sourceWaitMultiplicity, markerPresent,
    claimStageDiagnostics,
    markerValidationPassed, sourceStartCount, stepItemCount, anchorCount, prefixAvailable, rejectStage, prefixRejectStage,
    stepStartedExactAnchorCount: stepStartedExact.length, stepCompletedCandidateCount: stepCompletedAnchors.rows.length,
    stepCompletedCanonicalKeyCount: stepCompletedCanonicalCount, stepCompletedExactAnchorCount: stepCompletedExact.length,
    prefixWindowBoundaryAvailable, prefixWindowEventCount, prefixWindowItemCount: stepItemCount,
    prefixChecks: { lifecyclePassed: markerValidationPassed, sourceWaitUnique: sourceWaitMultiplicity === 1,
      sourceCallStartUnique: sourceStartCount === 1, stepStartedAnchorUnique: stepStartedExact.length === 1,
      stepCompletedAnchorUnique: stepCompletedExact.length === 1, prefixWindowBounded: prefixWindowEventCount !== null
        && prefixWindowEventCount >= 12 && prefixWindowEventCount <= MAX_STEP_TOOL_CALLS * 9 + 16,
      prefixItemsBounded: stepItemCount >= 2 && stepItemCount <= MAX_STEP_TOOL_CALLS * 2 + 2, prefixAccepted: prefixAvailable } }
}

async function diagnoseWorkerFClaimProof(
  client: PoolClient, task: BlockingTaskSnapshot, continuationStepId: string, sourceCallId: string, claimCallId: string,
): Promise<Record<string, unknown>> {
  const projectedSourceContent = projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: sourceCallId })
  const projectedSourceCallId = projectedSourceContent && typeof projectedSourceContent === "object" && !Array.isArray(projectedSourceContent)
    ? (projectedSourceContent as Record<string, unknown>).toolCallId : null
  const proof = await client.query<{ candidateCount: number; matchedCount: number }>(WORKER_F_CLAIM_PROOF_SQL,
    [task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
      task.leaseExpiresAt, task.userId, null, continuationStepId, sourceCallId,
      typeof projectedSourceCallId === "string" ? projectedSourceCallId : null, claimCallId],
  )
  const waits = await client.query<{ id: string; stepId: string; sourceAttempt: number; continuationAttempt: number;
    status: string; deadlineAt: Date; idempotencyKey: string; mode: string; targetTaskIds: unknown; matchedTaskIds: unknown; result: unknown }>(
    `SELECT wait."id", wait."stepId", wait."status", wait."deadlineAt", wait."idempotencyKey", wait."mode",
        source."attempt" AS "sourceAttempt", continuation."attempt" AS "continuationAttempt",
        wait."targetTaskIds", wait."matchedTaskIds", wait."result"
     FROM "sub_agent_tasks" AS owner
     JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = owner."id" AND wait."sessionId" = owner."sessionId"
       AND wait."turnId" = owner."turnId" AND wait."userId" = $9
     JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
       AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
     JOIN "agent_steps" AS continuation ON continuation."id" = $5 AND continuation."sessionId" = source."sessionId"
       AND continuation."turnId" = source."turnId" AND continuation."taskId" = source."taskId"
       AND continuation."attempt" = $6
     WHERE owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3 AND owner."rootTaskId" = $4
       AND owner."parentTaskId" IS NOT NULL AND owner."status" = 'running' AND owner."leaseOwner" = $7
       AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $8 AND owner."interruptRequestedAt" IS NULL
       AND source."attempt" BETWEEN 1 AND $6
       AND wait."id" = (SELECT latest."id" FROM "agent_wait_conditions" AS latest
         JOIN "agent_steps" AS latestStep ON latestStep."id" = latest."stepId" AND latestStep."sessionId" = latest."sessionId"
           AND latestStep."turnId" = latest."turnId" AND latestStep."taskId" = owner."id" AND latestStep."attempt" BETWEEN 1 AND $6
         WHERE latest."parentTaskId" = owner."id" AND latest."sessionId" = owner."sessionId" AND latest."turnId" = owner."turnId"
         ORDER BY latestStep."attempt" DESC, latestStep."ordinal" DESC, latest."createdAt" DESC, latest."id" DESC LIMIT 1)
     LIMIT 2`,
    [task.sessionId, task.id, task.turnId, task.rootTaskId, continuationStepId, task.attemptCount,
      task.leaseOwner, task.leaseExpiresAt, task.userId],
  )
  const sqlCandidateCount = proof.rows[0]?.candidateCount ?? 0
  const sqlMatchCount = proof.rows[0]?.matchedCount ?? 0
  const exactSqlProofMatched = sqlCandidateCount === 1 && sqlMatchCount === 1
  const attemptRelation = (sourceAttempt: number, currentAttempt: number): "same" | "prior" | "future" | "unknown" =>
    !Number.isSafeInteger(sourceAttempt) || !Number.isSafeInteger(currentAttempt) ? "unknown"
      : sourceAttempt === currentAttempt ? "same" : sourceAttempt < currentAttempt ? "prior" : "future"
  if (waits.rows.length !== 1) return {
    sqlCandidateCount, sqlMatchCount, exactSqlProofMatched,
    waitRowCount: waits.rows.length, attemptRelation: "unknown", sourceCallCount: 0, sourceCallFinished: false,
    continuationIsCurrent: false, sourceResultCount: 0, sourceReceiptState: "missing", sourceReceiptFinished: false,
    recoveryMarkerPresent: false, recoveryMarkerMatchesSource: false, sourceResultDeterministicIdMatches: false,
    safeKeyProjectionMatched: false, deadlineCanonicalAndMatched: false, claimCallFinishedRevision1: false,
    claimHasNoItemCompletedEvent: false,
  }
  const wait = waits.rows[0]!
  const sourceCalls = await client.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
    `SELECT "id", "status", "revision", "content" FROM "agent_items"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
       AND "type" = 'tool_call' AND "content"->>'toolName' = 'wait_subagents' LIMIT 2`,
    [task.sessionId, task.turnId, task.id, wait.stepId],
  )
  const sourceCall = sourceCalls.rows.length === 1 ? sourceCalls.rows[0] : undefined
  const sourceCallContent = asObject(sourceCall?.content)
  const sourceInput = asObject(sourceCallContent.input)
  const sourceResults = typeof sourceCallContent.toolCallId === "string" ? await client.query<{
    id: string; status: string; revision: number; content: Record<string, unknown>
  }>(
    `SELECT "id", "status", "revision", "content" FROM "agent_items"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
       AND "type" = 'tool_result' AND "content"->>'toolCallId' = $5 LIMIT 2`,
    [task.sessionId, task.turnId, task.id, wait.stepId, sourceCallContent.toolCallId],
  ) : { rows: [] }
  const sourceResult = sourceResults.rows.length === 1 ? sourceResults.rows[0] : undefined
  const sourceResultContent = asObject(sourceResult?.content)
  const sourceReceipt = asObject(sourceResultContent.output)
  const waitResult = asObject(wait.result)
  const waitOutcome = asObject(waitResult.outcome)
  const recoveryMarker = asObject(waitResult.sourceLifecycleRecovery)
  const targetIds = Array.isArray(wait.targetTaskIds) ? wait.targetTaskIds : null
  const matchedIds = Array.isArray(wait.matchedTaskIds) ? wait.matchedTaskIds : null
  const sameStringIds = (left: unknown, right: unknown): boolean => {
    if (!Array.isArray(left) || !Array.isArray(right) || left.some(value => typeof value !== "string")
      || right.some(value => typeof value !== "string") || left.length !== right.length) return false
    if (new Set(left).size !== left.length || new Set(right).size !== right.length) return false
    const leftIds = [...left as string[]].sort(), rightIds = [...right as string[]].sort()
    return leftIds.every((value, index) => value === rightIds[index])
  }
  const continuationCalls = await client.query<{ status: string; revision: number; content: Record<string, unknown> }>(
    `SELECT "status", "revision", "content" FROM "agent_items"
     WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
       AND "type" = 'tool_call' AND "content"->>'toolName' = 'wait_subagents' LIMIT 2`,
    [task.sessionId, task.turnId, task.id, continuationStepId],
  )
  const claimCall = continuationCalls.rows.find(call => call.content.toolCallId === claimCallId)
  const claimInput = asObject(claimCall?.content.input)
  const claimEvents = claimCall ? await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
       AND ("itemId" = $4 OR "correlationId" = $5) AND "type" = 'item.completed'`,
    [task.sessionId, task.turnId, task.id, `task:${task.id}:item:tool-call:${claimCallId}:attempt:${task.attemptCount}`, claimCallId],
  ) : { rows: [{ count: 0 }] }
  const waitDeadline = wait.deadlineAt instanceof Date ? wait.deadlineAt : new Date(String(wait.deadlineAt))
  const outcomeDeadlineText = waitOutcome.deadlineAt
  const parsedOutcomeDeadline = typeof outcomeDeadlineText === "string" ? new Date(outcomeDeadlineText) : null
  const deadlineCanonicalAndMatched = parsedOutcomeDeadline instanceof Date && Number.isFinite(parsedOutcomeDeadline.getTime())
    && parsedOutcomeDeadline.toISOString() === outcomeDeadlineText && Number.isFinite(waitDeadline.getTime())
    && parsedOutcomeDeadline.getTime() === waitDeadline.getTime()
  const sourceCallFinished = sourceCall?.status === "completed" && sourceCall.revision === 1
    && sourceCallContent.toolCallId === sourceCallId && sourceCallContent.toolName === "wait_subagents"
    && sourceCallContent.toolVersion === "1" && sourceCallContent.status === "completed" && sourceCallContent.errorCode === null
    && sourceInput.idempotencyKey === wait.idempotencyKey
  const sourceReceiptBaseFinished = sourceResult?.status === "completed" && sourceResult.revision === 1
    && sourceCallContent.toolCallId === sourceCallId && sourceResultContent.toolCallId === sourceCallId
    && sourceResultContent.toolCallId === sourceCallContent.toolCallId
    && sourceResultContent.errorCode === null
  const sourceReceiptStatus = typeof sourceReceipt.status === "string"
    && ["waiting", "ready", "timed_out"].includes(sourceReceipt.status) ? sourceReceipt.status : sourceResult ? "other" : "missing"
  const sourceReceiptNormalMatches = sourceReceiptBaseFinished && sourceReceipt.waitId === wait.id && sourceReceipt.status === "waiting"
    && sameStringIds(sourceReceipt.taskIds, targetIds) && Array.isArray(sourceReceipt.matchedTaskIds) && sourceReceipt.matchedTaskIds.length === 0
    && sourceReceiptDeadlineMatches(sourceReceipt.deadlineAt, waitOutcome.deadlineAt)
  const recoveryMarkerPresent = Object.prototype.hasOwnProperty.call(waitResult, "sourceLifecycleRecovery")
  const markerAttempt = recoveryMarker.attempt
  const sourceResultDigest = createHash("sha256")
    .update(`child-wait-source-result:v1\0${wait.id}\0${sourceCallId}`, "utf8").digest("hex")
  const sourceResultDeterministicIdMatches = sourceResult?.id
    === `task:${task.id}:item:tool-result:source-wait-recovery:${sourceResultDigest}`
  const recoveryMarkerMatchesSource = recoveryMarkerPresent && recoveryMarker.schemaVersion === "child-wait-source-lifecycle.v1"
    && recoveryMarker.userId === task.userId && recoveryMarker.sessionId === task.sessionId && recoveryMarker.turnId === task.turnId
    && recoveryMarker.rootTaskId === task.rootTaskId && recoveryMarker.taskId === task.id
    // ownerId is server-written sidecar data; this probe validates shape, not historical lease ownership.
    && typeof recoveryMarker.ownerId === "string" && recoveryMarker.ownerId.length >= 1 && recoveryMarker.ownerId.length <= 256
    && recoveryMarker.ownerId.trim() === recoveryMarker.ownerId
    && markerAttempt === wait.sourceAttempt && recoveryMarker.stepId === wait.stepId && recoveryMarker.waitId === wait.id
    && recoveryMarker.toolCallId === sourceCallId && recoveryMarker.toolCallId === sourceCallContent.toolCallId
    && recoveryMarker.callItemId === sourceCall?.id
    && recoveryMarker.resultItemId === sourceResult?.id
  const sourceReceiptRecoveredMatches = sourceReceiptBaseFinished && recoveryMarkerMatchesSource
    && sourceResultDeterministicIdMatches
    && sourceReceipt.waitId === wait.id && sourceReceipt.status === wait.status
    && sameStringIds(sourceReceipt.taskIds, targetIds) && sameStringIds(sourceReceipt.matchedTaskIds, matchedIds)
    && sourceReceiptDeadlineMatches(sourceReceipt.deadlineAt, waitOutcome.deadlineAt)
    && sameJsonValue(sourceReceipt, waitOutcome)
  const sourceReceiptFinished = sourceReceiptNormalMatches || sourceReceiptRecoveredMatches
  const safeKeyProjectionMatched = sourceCalls.rows.length === 1 && continuationCalls.rows.length === 1
    && childWaitContinuationKeyMatchesSafeProjection(sourceInput.idempotencyKey, claimInput.idempotencyKey)
  return {
    snapshot: "post_recovery_attempt_read_committed",
    sqlCandidateCount, sqlMatchCount, exactSqlProofMatched,
    waitRowCount: waits.rows.length, attemptRelation: attemptRelation(wait.sourceAttempt, task.attemptCount),
    continuationIsCurrent: wait.continuationAttempt === task.attemptCount,
    sourceCallCount: sourceCalls.rows.length, sourceCallFinished, sourceResultCount: sourceResults.rows.length,
    sourceReceiptState: sourceReceiptStatus,
    sourceReceiptNormalMatches, sourceReceiptRecoveredMatches, sourceReceiptFinished,
    recoveryMarkerPresent, recoveryMarkerMatchesSource, sourceResultDeterministicIdMatches,
    safeKeyProjectionMatched, deadlineCanonicalAndMatched,
    claimCallCount: continuationCalls.rows.length,
    claimCallFinishedRevision1: claimCall?.status === "completed" && claimCall.revision === 1
      && claimCall.content.toolCallId === claimCallId && claimCall.content.toolName === "wait_subagents",
    claimHasNoItemCompletedEvent: (claimEvents.rows[0]?.count ?? 0) === 0,
  }
}

async function diagnoseHistoricalClaimFinal(client: PoolClient, task: BlockingTaskSnapshot,
  continuationStepId: string, sourceCallId: string, claimCallId: string): Promise<Record<string, unknown>> {
  const projections = await readChildWaitTerminalCallProjections(client, task as unknown as Record<string, unknown>)
  const claims = projections.filter(projection => projection.sourceWait.claimKeyDigest !== null
    && projection.rawCallId === claimCallId && projection.sourceWait.sourceCallId === sourceCallId
    && projection.stepId === continuationStepId && projection.attempt === task.attemptCount)
  if (claims.length !== 1) return { outcome: claims.length === 0 ? "missing" : "ambiguous",
    acceptedClaimProjectionCount: Math.min(claims.length, 17), recovery: { outcome: "not_evaluated" },
    historicalWaitBinding: null, projectedCompletion: null, callItemCompletedNoEvent: null,
    callLifecycle: null, resultExtraStepToolChainException: null, terminalSettlement: null }

  const claim = claims[0]!
  const chain = asObject(claim.stepToolChain)
  const events = Array.isArray(chain.events) ? chain.events : []
  const calls = Array.isArray(chain.calls) ? chain.calls : []
  const componentRows = await client.query<Record<string, unknown>>(WORKER_F_CLAIM_COMPONENTS_SQL, [
    task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
    task.leaseExpiresAt, task.userId, claim.rawCallId, claim.projectedCallId, claim.startEventId,
    claim.callItemId, JSON.stringify([claim]), sourceCallId, continuationStepId,
  ])
  const recovery = await diagnoseWorkerFClaimProof(client, task, continuationStepId, sourceCallId, claimCallId)
  const component = componentRows.rows.length === 1 ? componentRows.rows[0] : undefined
  const terminal = await diagnoseAcceptedClaimTerminalSettlement(client, task, claim)
  const boundedCount = (value: unknown, maximum: number): number => typeof value === "number"
    && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum + 1) : 0
  const enumValue = (value: unknown, allowed: readonly string[]): string =>
    typeof value === "string" && allowed.includes(value) ? value : "unknown"
  const recoveryCandidateCount = boundedCount(recovery.sqlCandidateCount, 2)
  const recoveryMatchCount = boundedCount(recovery.sqlMatchCount, 2)
  const chainEventCount = boundedCount(events.length, MAX_STEP_CHAIN_EVENTS)
  const chainCallCount = boundedCount(calls.length, MAX_STEP_TOOL_CALLS)
  const componentFlag = (key: string): boolean | null => component?.[key] === true ? true
    : component?.[key] === false ? false : null
  const recoverySummary = { candidateCount: recoveryCandidateCount, matchCount: recoveryMatchCount,
    exactMatch: recovery.exactSqlProofMatched === true,
    ownerLeaseAttemptFenceMatched: recovery.exactSqlProofMatched === true,
    attemptRelation: enumValue(recovery.attemptRelation, ["same", "prior", "future"]),
    sourceReceiptFinished: recovery.sourceReceiptFinished === true,
    safeKeyProjectionMatched: recovery.safeKeyProjectionMatched === true,
    deadlineCanonicalAndMatched: recovery.deadlineCanonicalAndMatched === true,
    claimCallFinishedRevision1: recovery.claimCallFinishedRevision1 === true,
    claimHasNoItemCompletedEvent: recovery.claimHasNoItemCompletedEvent === true }
  return { outcome: "evaluated", acceptedClaimProjectionCount: 1,
    claimResultPairPresent: typeof claim.resultStartedEventId === "string" && !!claim.resultStartedEventId
      && typeof claim.resultCompletedEventId === "string" && !!claim.resultCompletedEventId,
    claimStepToolChainPresent: Object.keys(chain).length > 0,
    chainEventCount, chainCallCount,
    chainEventCountValid: Array.isArray(chain.events) && events.length >= 12 && events.length <= MAX_STEP_CHAIN_EVENTS,
    recovery: recoverySummary, componentOutcome: component ? "evaluated" : "unknown",
    historicalWaitBinding: componentFlag("historicalWaitBinding"),
    projectedCompletion: componentFlag("projectedCompletion"),
    callItemCompletedNoEvent: componentFlag("callItemCompletedNoEvent"),
    callLifecycle: componentFlag("callLifecycle"),
    resultExtraStepToolChainException: componentFlag("stepToolChainException"),
    terminalSettlement: terminal.settlement, terminalCandidateCount: terminal.candidateCount,
    terminalCandidateCountTruncated: terminal.truncated, terminalSettlementMatchedCount: terminal.matchedCount }
}

async function diagnoseAcceptedClaimTerminalSettlement(client: PoolClient, task: BlockingTaskSnapshot,
  claim: Awaited<ReturnType<typeof readChildWaitTerminalCallProjections>>[number]): Promise<{
    settlement: boolean | null; candidateCount: number; matchedCount: number; truncated: boolean
  }> {
  const candidates = await client.query<{ id: string }>(`SELECT terminal."id" FROM "agent_events" AS started
    JOIN LATERAL (SELECT settled."id", settled."sequence" FROM "agent_events" AS settled
      WHERE settled."sessionId" = started."sessionId" AND settled."turnId" = started."turnId"
        AND settled."taskId" = started."taskId" AND settled."correlationId" = started."correlationId"
        AND settled."type" IN ('tool_call.completed', 'tool_call.failed', 'tool_call.interrupted')
      ORDER BY settled."sequence" DESC, settled."id" DESC LIMIT 17) AS terminal ON TRUE
    WHERE started."id" = $1 AND started."sessionId" = $2 AND started."turnId" = $3 AND started."taskId" = $4
      AND started."type" = 'tool_call.started' AND started."itemId" = $5 AND started."correlationId" = $6
    ORDER BY terminal."sequence" DESC, terminal."id" DESC LIMIT 17`,
  [claim.startEventId, task.sessionId, task.turnId, task.id, claim.callItemId, claim.rawCallId])
  let matchedCount = 0
  for (const terminal of candidates.rows) {
    const proof = await client.query<{ settled: boolean }>(WORKER_F_SAME_CALL_ID_TERMINAL_PROOF_SQL, [
      task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount,
      task.leaseExpiresAt, task.userId, claim.rawCallId, claim.projectedCallId, claim.callItemId,
      claim.stepId, JSON.stringify([claim]), claim.startEventId, terminal.id,
    ])
    if (proof.rows.length === 1 && proof.rows[0]?.settled === true) matchedCount += 1
  }
  const candidateCount = candidates.rows.length
  return { settlement: matchedCount > 0 ? true : candidateCount === 17 ? null : false,
    candidateCount, matchedCount, truncated: candidateCount === 17 }
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
        .map(([key, item]) => [key, normalize(item)]))
      : value
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right))
}

function sourceReceiptDeadlineMatches(receiptDeadline: unknown, outcomeDeadline: unknown): boolean {
  if (typeof receiptDeadline !== "string" || typeof outcomeDeadline !== "string" || receiptDeadline !== outcomeDeadline) return false
  const parsed = new Date(receiptDeadline)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === receiptDeadline
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

const recoveryRejectionStages = new Set([
  "candidate_not_seen", "candidate_seen", "session_lock_mismatch", "turn_lock_mismatch", "expiry_preview_rejected",
  "root_turn_not_recoverable", "task_lock_parity_mismatch", "recovery_clock_missing", "lease_expiry_fence_mismatch",
  "unsettled_external_call_rejected", "durable_wait_graph_blocked", "task_graph_transition_blocked", "task_graph_finish_blocked",
  "task_update_rejected",
])
const recoveryStatuses = new Set(["queued", "running", "completed", "failed", "cancelled", "interrupted"])
const resumeFailureCodes = new Set([
  "child_resume_wait_tool_call_conflict", "child_resume_wait_step_lineage", "child_resume_wait_lineage",
  "child_resume_wait_owner_mismatch", "child_resume_wait_commit_unavailable", "child_resume_wait_commit_pending",
])

function parseRecoveryPredicateDiagnostic(child: WorkerProcess): { targetSeen: boolean; rejectionStage: string } {
  const prefix = "WORKER_B_RECOVERY_PREDICATE_TRACE "
  const line = child.stdoutText.split(/\r?\n/).find(candidate => candidate.startsWith(prefix))
  if (!line) return { targetSeen: false, rejectionStage: "not_emitted" }
  try {
    const trace = JSON.parse(line.slice(prefix.length)) as { pages?: unknown; rejectionStage?: unknown }
    const pages = Array.isArray(trace.pages) ? trace.pages.slice(0, 16) : []
    const targetSeen = pages.some(page => page && typeof page === "object" && !Array.isArray(page)
      && (page as Record<string, unknown>).targetSeen === true)
    const rejectionStage = typeof trace.rejectionStage === "string" && recoveryRejectionStages.has(trace.rejectionStage)
      ? trace.rejectionStage : "other"
    return { targetSeen, rejectionStage }
  } catch { return { targetSeen: false, rejectionStage: "malformed" } }
}

function parseLoopStagePhase(child: WorkerProcess, expectedStage: string): "start" | "pass" | "fail" | "not_seen" {
  const prefix = "WORKER_B_LOOP_STAGE "
  const lines = child.stdoutText.split(/\r?\n/).filter(line => line.startsWith(prefix)).slice(0, 64)
  let phase: "start" | "pass" | "fail" | "not_seen" = "not_seen"
  for (const line of lines) {
    try {
      const marker = JSON.parse(line.slice(prefix.length)) as { stage?: unknown; phase?: unknown }
      if (marker.stage !== expectedStage) continue
      phase = marker.phase === "start" || marker.phase === "pass" || marker.phase === "fail" ? marker.phase : "fail"
    } catch { phase = "fail" }
  }
  return phase
}

function parseResumeFailureCategory(child: WorkerProcess): string {
  const prefix = "WORKER_B_LOOP_RESUME_FAILURE "
  const line = child.stdoutText.split(/\r?\n/).find(candidate => candidate.startsWith(prefix))
  if (!line) return "none"
  try {
    const marker = JSON.parse(line.slice(prefix.length)) as { category?: unknown }
    return typeof marker.category === "string" && resumeFailureCodes.has(marker.category) ? marker.category : "other"
  } catch { return "other" }
}

function boundedWorkerRecoveryDiagnostic(child: WorkerProcess, targetId: string): string {
  const recovery = parseRecoveryMarker(child)
  const target = recovery.rows?.find(row => row.id === targetId)
  const targetStatus = typeof target?.status === "string" && recoveryStatuses.has(target.status) ? target.status : "absent"
  const predicate = parseRecoveryPredicateDiagnostic(child)
  return JSON.stringify({ recoveryCompleted: Array.isArray(recovery.rows), targetReturned: Boolean(target), targetStatus,
    candidateSeen: predicate.targetSeen, rejectionStage: predicate.rejectionStage,
    childAttemptResumeLoader: parseLoopStagePhase(child, "child_attempt_resume_loader"), resumeFailureCategory: parseResumeFailureCategory(child) })
}

type BlockerCategory = "currentSourceWait" | "historicalWaitSource" | "currentClaim" | "modelStarted" | "otherToolCall"
type BlockerCounts = Record<BlockerCategory, { starts: number; projectedCompletions: number; uniquelyBlocking: number }>
function diagnosticJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(diagnosticJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${diagnosticJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

async function boundedExternalCallBlockerDiagnostic(pool: Pool, ids: FixtureIds): Promise<Record<string, unknown>> {
  const counts: BlockerCounts = {
    currentSourceWait: { starts: 0, projectedCompletions: 0, uniquelyBlocking: 0 },
    historicalWaitSource: { starts: 0, projectedCompletions: 0, uniquelyBlocking: 0 },
    currentClaim: { starts: 0, projectedCompletions: 0, uniquelyBlocking: 0 },
    modelStarted: { starts: 0, projectedCompletions: 0, uniquelyBlocking: 0 },
    otherToolCall: { starts: 0, projectedCompletions: 0, uniquelyBlocking: 0 },
  }
  let client: PoolClient | undefined
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
    const context = await client.query<Record<string, unknown>>(`SELECT task.*, session."userId" AS "userId",
        ${CHILD_WAIT_EXPIRY_RESUMABLE_SQL} AS "childWaitResumable", ${CHILD_WAIT_CONSUMED_SQL} AS "childWaitContinuationId"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND session."userId" = $3 AND task."turnId" = $4`,
    [ids.waiterTaskId, ids.sessionId, ids.userId, ids.turnId])
    const task = context.rows[0]
    if (!task) return { status: "context_missing" }
    const continuationId = typeof task.childWaitContinuationId === "string" ? task.childWaitContinuationId : undefined
    const sourceRows = await client.query<{ callItemId: string }>(`WITH latest_wait AS MATERIALIZED (
        SELECT wait."stepId" FROM "agent_wait_conditions" AS wait
        JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
          AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
        WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3
          AND source."attempt" BETWEEN 1 AND $4
        ORDER BY source."attempt" DESC, source."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT 1
      )
      SELECT call."id" AS "callItemId" FROM latest_wait AS wait
      JOIN "agent_items" AS call ON call."stepId" = wait."stepId" AND call."sessionId" = $2 AND call."turnId" = $3
        AND call."taskId" = $1 AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
      ORDER BY call."id" LIMIT 2`, [ids.waiterTaskId, ids.sessionId, ids.turnId, task.attemptCount])
    const sourceCallItemId = sourceRows.rows.length === 1 ? sourceRows.rows[0]?.callItemId : undefined
    const starts = await client.query<{
      id: string; type: string; itemId: string | null; idempotencyKey: string | null; itemType: string | null
      itemStepId: string | null; itemAttempt: number | null; itemContent: unknown; itemCompletedPayloads: unknown
    }>(`SELECT started."id", started."type", started."itemId", started."idempotencyKey",
        call."type" AS "itemType", call."stepId" AS "itemStepId", step."attempt" AS "itemAttempt",
        call."content" AS "itemContent",
        COALESCE((SELECT jsonb_agg(done."payload" ORDER BY done."sequence") FROM "agent_events" AS done
          WHERE done."sessionId" = started."sessionId" AND done."turnId" = started."turnId" AND done."taskId" = started."taskId"
            AND done."itemId" = call."id" AND done."type" = 'item.completed'), '[]'::jsonb) AS "itemCompletedPayloads"
      FROM "agent_events" AS started
      LEFT JOIN "agent_items" AS call ON call."id" = started."itemId" AND call."sessionId" = started."sessionId"
        AND call."turnId" = started."turnId" AND call."taskId" = started."taskId"
      LEFT JOIN "agent_steps" AS step ON step."id" = call."stepId" AND step."sessionId" = call."sessionId"
        AND step."turnId" = call."turnId" AND step."taskId" = call."taskId"
      WHERE started."sessionId" = $1 AND started."turnId" = $2 AND started."taskId" = $3
        AND started."type" IN ('tool_call.started', 'model.started')
      ORDER BY started."sequence" LIMIT 33`, [ids.sessionId, ids.turnId, ids.waiterTaskId])
    const boundedStarts = starts.rows.slice(0, 32)
    const categoryFor = (row: typeof boundedStarts[number]): BlockerCategory => {
      if (row.type === "model.started") return "modelStarted"
      const content = asObject(row.itemContent)
      if (row.itemType !== "tool_call" || content.toolName !== "wait_subagents") return "otherToolCall"
      if (typeof row.itemAttempt === "number" && typeof row.itemStepId === "string"
        && row.idempotencyKey === `task:${ids.waiterTaskId}:event:child-wait-claim:${row.itemAttempt}:${row.itemStepId}`) return "currentClaim"
      return row.itemId && row.itemId === sourceCallItemId ? "currentSourceWait" : "historicalWaitSource"
    }
    const baseBlocked = await hasBlockingExternalCall(client, task, undefined, continuationId)
    for (const row of boundedStarts) {
      const category = categoryFor(row)
      counts[category].starts++
      const content = asObject(row.itemContent)
      if (category !== "modelStarted" && content.toolName === "wait_subagents" && row.itemId) {
        const expected = projectWaitCallCompletionPayload({ itemId: row.itemId, status: "completed", content: row.itemContent }, row.itemId)
        const payloads = Array.isArray(row.itemCompletedPayloads) ? row.itemCompletedPayloads : []
        if (payloads.some(payload => diagnosticJson(payload) === diagnosticJson(expected))) counts[category].projectedCompletions++
      }
      if (baseBlocked && !await hasBlockingExternalCall(client, task, row.id, continuationId)) counts[category].uniquelyBlocking++
    }
    const uniqueBlockingCategories = (Object.keys(counts) as BlockerCategory[]).filter(category => counts[category].uniquelyBlocking > 0)
    return {
      status: "available", baseBlocked, candidateCount: boundedStarts.length, truncated: starts.rows.length > boundedStarts.length,
      continuationPresent: continuationId !== undefined, sourceProjectionPresent: continuationId !== undefined
        && Boolean(await readChildWaitSourceCallProjection(client, task, continuationId)),
      childWaitResumable: task.childWaitResumable === true, uniqueBlockingCategories, counts,
      attribution: !baseBlocked ? "none" : uniqueBlockingCategories.length === 1 ? uniqueBlockingCategories[0]
        : uniqueBlockingCategories.length > 1 ? "multiple" : "multiple_or_unattributed",
    }
  } catch {
    return { status: "unavailable" }
  } finally {
    if (client) {
      await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }
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
let historicalWaitDiagnosticSavepointOrdinal = 0

async function withHistoricalWaitDiagnosticSavepoint<T>(client: PoolClient, probe: () => Promise<T>): Promise<T | undefined> {
  const name = `historical_wait_diagnostic_${++historicalWaitDiagnosticSavepointOrdinal}`
  try { await client.query(`SAVEPOINT ${name}`) } catch { return undefined }
  try {
    const result = await probe()
    await client.query(`RELEASE SAVEPOINT ${name}`)
    return result
  } catch {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`).catch(() => undefined)
    await client.query(`RELEASE SAVEPOINT ${name}`).catch(() => undefined)
    return undefined
  }
}

async function historicalWaitBindingAccepts(client: PoolClient, task: BlockingTaskSnapshot, projection: unknown): Promise<boolean> {
  const result = await client.query<{ accepted: boolean }>(`WITH proof AS (SELECT $9::jsonb AS value)
    SELECT ${CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL} AS "accepted"
    FROM proof
    JOIN "sub_agent_tasks" AS owner ON owner."id" = $2 AND owner."sessionId" = $1 AND owner."turnId" = $3
      AND owner."rootTaskId" = $4 AND owner."leaseOwner" = $5 AND owner."attemptCount" = $6 AND owner."leaseExpiresAt" = $7
    JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $8
    JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId"
      AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
    JOIN "agent_steps" AS callStep ON callStep."id" = proof.value->>'stepId' AND callStep."sessionId" = owner."sessionId"
      AND callStep."turnId" = owner."turnId" AND callStep."taskId" = owner."id"
    JOIN "agent_items" AS callItem ON callItem."id" = proof.value->>'callItemId' AND callItem."sessionId" = owner."sessionId"
      AND callItem."turnId" = owner."turnId" AND callItem."taskId" = owner."id" AND callItem."stepId" = callStep."id"
    JOIN "agent_events" AS itemStarted ON itemStarted."sessionId" = owner."sessionId" AND itemStarted."turnId" = owner."turnId"
      AND itemStarted."taskId" = owner."id" AND itemStarted."itemId" = callItem."id" AND itemStarted."type" = 'item.started'
      AND itemStarted."actor" = 'subagent' AND itemStarted."correlationId" = callStep."id"
      AND itemStarted."idempotencyKey" = 'task:' || owner."id" || ':event:item-started:' || callItem."id"
      AND itemStarted."payload" = jsonb_build_object('itemId', callItem."id", 'type', 'tool_call', 'phase', NULL)
    JOIN "agent_events" AS started ON started."id" = proof.value->>'startEventId' AND started."sessionId" = owner."sessionId"
      AND started."turnId" = owner."turnId" AND started."taskId" = owner."id" AND started."itemId" = callItem."id"
      AND started."type" = 'tool_call.started' AND started."actor" = 'subagent'
      AND started."correlationId" = callItem."content"->>'toolCallId' AND started."causationId" = itemStarted."id"
      AND started."sequence" > itemStarted."sequence"
      AND started."idempotencyKey" = CASE WHEN proof.value->'sourceWait'->'claimKeyDigest' = 'null'::jsonb
        THEN 'task:' || owner."id" || ':event:tool-started:' || (callItem."content"->>'toolCallId')
        ELSE 'task:' || owner."id" || ':event:child-wait-claim:' || callStep."attempt"::text || ':' || callStep."id" END
      AND started."payload" = jsonb_build_object('toolCallId', callItem."content"->>'toolCallId',
        'toolName', 'wait_subagents', 'taskId', owner."id')`,
  [task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount, task.leaseExpiresAt,
    task.userId, JSON.stringify(projection)])
  return result.rows.length === 1 && result.rows[0]?.accepted === true
}

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
    const recoveredSource = await client.query<{ waitId: string; result: Record<string, unknown>; targetTaskIds: unknown; sourceCallContent: Record<string, unknown>;
      sourceStatus: string; sourceRevision: number; resultStatus: string; resultRevision: number; resultContent: Record<string, unknown> }>(
      `SELECT wait."id" AS "waitId", wait."result", wait."targetTaskIds", sourceCall."content" AS "sourceCallContent",
          sourceCall."status" AS "sourceStatus", sourceCall."revision" AS "sourceRevision",
          sourceResult."status" AS "resultStatus", sourceResult."revision" AS "resultRevision", sourceResult."content" AS "resultContent"
       FROM "agent_wait_conditions" AS wait
       JOIN "agent_items" AS sourceCall ON sourceCall."sessionId" = wait."sessionId" AND sourceCall."turnId" = wait."turnId"
         AND sourceCall."taskId" = wait."parentTaskId" AND sourceCall."stepId" = wait."stepId" AND sourceCall."type" = 'tool_call'
         AND sourceCall."content"->>'toolName' = 'wait_subagents'
       JOIN "agent_items" AS sourceResult ON sourceResult."sessionId" = sourceCall."sessionId" AND sourceResult."turnId" = sourceCall."turnId"
         AND sourceResult."taskId" = sourceCall."taskId" AND sourceResult."stepId" = sourceCall."stepId"
         AND sourceResult."type" = 'tool_result' AND sourceResult."content"->>'toolCallId' = sourceCall."content"->>'toolCallId'
       WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId],
    )
    expect(recoveredSource.rows).toHaveLength(1)
    const recoveredRow = recoveredSource.rows[0]!
    expect(recoveredRow).toMatchObject({ sourceStatus: "completed", sourceRevision: 1, resultStatus: "completed", resultRevision: 1 })
    const sourceInput = asObject(asObject(recoveredRow.sourceCallContent).input)
    const sourceKey = sourceInput.idempotencyKey
    const sourceTargets = sourceInput.taskIds
    if (typeof sourceKey !== "string" || sourceKey.length < 1 || !Array.isArray(sourceTargets)
      || sourceTargets.length < 1 || sourceTargets.some(target => typeof target !== "string")) {
      throw new Error("completed_claim_source_input_fixture_invalid")
    }
    const changeLastCharacter = (value: string): string => `${value.slice(0, -1)}${value.endsWith("x") ? "y" : "x"}`
    const changedSourceKey = changeLastCharacter(sourceKey)
    const changedSourceTargets = [changeLastCharacter(sourceTargets[0] as string), ...sourceTargets.slice(1)]
    const sourceMode = sourceInput.mode
    const sourceTimeout = sourceInput.timeoutMs
    if ((sourceMode !== "all" && sourceMode !== "any") || typeof sourceTimeout !== "number" || !Number.isSafeInteger(sourceTimeout)) {
      throw new Error("completed_claim_source_request_fixture_invalid")
    }
    if (changedSourceKey === sourceKey || changedSourceKey.length !== sourceKey.length
      || changedSourceTargets[0] === sourceTargets[0]
      || changedSourceTargets[0]?.length !== (sourceTargets[0] as string).length
      || JSON.stringify(recoveredRow.targetTaskIds) !== JSON.stringify(sourceTargets)) {
      throw new Error("completed_claim_source_input_mutation_fixture_invalid")
    }
    const recoveredMarker = asObject(recoveredRow.result.sourceLifecycleRecovery)
    const sourceStepId = recoveredMarker.stepId
    const recoveredResultItemId = recoveredMarker.resultItemId
    expect(recoveredMarker).toMatchObject({ schemaVersion: "child-wait-source-lifecycle.v1", sessionId: ids.sessionId,
      turnId: ids.turnId, rootTaskId: ids.rootTaskId, taskId: ids.waiterTaskId, stepId: `task:${ids.waiterTaskId}:step:0:attempt:1`,
      toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, callItemId: sourceCallItemId, resultItemId: expect.any(String) })
    if (typeof sourceStepId !== "string" || typeof recoveredResultItemId !== "string"
      || !/^task:.+:item:tool-result:source-wait-recovery:[0-9a-f]{64}$/.test(recoveredResultItemId)) {
      throw new Error("completed_claim_recovered_source_identity_invalid")
    }
    expect(recoveredRow.resultContent).toEqual({ toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
      output: recoveredRow.result.outcome, errorCode: null })
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
    const canonicalSourceContent = projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID }) as Record<string, unknown>
    const sourceCompletionEvent = await client.query<{ toolCallId: string }>(
      `SELECT "payload"->'content'->>'toolCallId' AS "toolCallId" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "itemId" = $4
         AND "type" = 'item.completed' AND "idempotencyKey" = $5`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceCallItemId,
        `task:${ids.waiterTaskId}:event:tool-call-completed:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:${sourceCallItemId}:1`],
    )
    expect(sourceCompletionEvent.rows).toEqual([{ toolCallId: canonicalSourceContent.toolCallId }])

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
    const exactSourceProjection = await readChildWaitSourceCallProjection(
      client, task as unknown as Record<string, unknown>, continuationStepId,
    )
    if (!exactSourceProjection) throw new Error("source_call_projection_missing_for_same_id_decoy")
    expect(exactSourceProjection).toMatchObject({ rawCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
      callItemId: sourceCallItemId, sourceStepId, sourceAttempt: 1 })
    const exactSourceStart = await client.query<{ id: string }>(
      `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
         AND "itemId" = $4 AND "type" = 'tool_call.started' AND "correlationId" = $5 LIMIT 2`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceCallItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID],
    )
    const exactSourceTerminal = await client.query<{ id: string }>(
      `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
         AND "itemId" = $4 AND "type" = 'tool_call.completed' AND "correlationId" = $5 AND "idempotencyKey" = $6 LIMIT 2`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceCallItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID,
        `task:${ids.waiterTaskId}:event:tool-finished:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}`],
    )
    expect(exactSourceStart.rows).toHaveLength(1)
    expect(exactSourceTerminal.rows).toHaveLength(1)
    const sourceProofs = (await readChildWaitTerminalCallProjections(client, task as unknown as Record<string, unknown>))
      .filter(projection => projection.startEventId === exactSourceStart.rows[0]!.id
        && projection.rawCallId === exactSourceProjection.rawCallId
        && projection.projectedCallId === exactSourceProjection.projectedCallId
        && projection.callItemId === exactSourceProjection.callItemId
        && projection.stepId === exactSourceProjection.sourceStepId
        && projection.attempt === exactSourceProjection.sourceAttempt)
    expect(sourceProofs, "the production projection must bind one complete source-wait proof to its exact item, step, and attempt").toHaveLength(1)
    const exactSourceProof = sourceProofs[0]!
    expect(exactSourceProof.sourceWait).toMatchObject({ sourceStepId: exactSourceProjection.sourceStepId,
      sourceAttempt: exactSourceProjection.sourceAttempt, sourceCallItemId: exactSourceProjection.callItemId,
      sourceCallId: exactSourceProjection.rawCallId, projectedSourceCallId: exactSourceProjection.projectedCallId })
    expect(exactSourceProof).not.toHaveProperty("sourceStepPrefix")
    expect(exactSourceProof.sourceStepHandoff).toMatchObject({ schemaVersion: "recovered_wait_handoff.v1",
      waitId: recoveredRow.waitId, stepId: sourceStepId, attempt: exactSourceProjection.sourceAttempt,
      sourceCallItemId: exactSourceProjection.callItemId, sourceCallId: exactSourceProjection.rawCallId,
      sourceResultItemId: recoveredResultItemId, events: expect.any(Array) })
    expect(exactSourceProof.sourceStepHandoff?.events).toHaveLength(6)
    const evaluateTerminalProof = async (startedId: string, settledId: string): Promise<boolean> => {
      const proof = await client.query<{ settled: boolean }>(
        WORKER_F_SAME_CALL_ID_TERMINAL_PROOF_SQL,
        [task.sessionId, task.id, task.turnId, task.rootTaskId, task.leaseOwner, task.attemptCount, task.leaseExpiresAt,
          task.userId, exactSourceProjection.rawCallId, exactSourceProjection.projectedCallId, exactSourceProjection.callItemId,
          exactSourceProjection.sourceStepId, JSON.stringify([exactSourceProof]), startedId, settledId],
      )
      return proof.rows[0]?.settled === true
    }
    const exactSourceProofAccepted = await evaluateTerminalProof(exactSourceStart.rows[0]!.id, exactSourceTerminal.rows[0]!.id)
    const exactSourceProofDiagnostic = exactSourceProofAccepted ? undefined
      : await withHistoricalWaitDiagnosticSavepoint(client, () => diagnoseHistoricalSourceFinalBinding(
        client, task, continuationStepId, exactSourceProjection.rawCallId)) ?? { outcome: "unknown" }
    expect(exactSourceProofAccepted,
      `the server-selected source item, step and attempt must retain its valid completion proof${exactSourceProofDiagnostic
        ? `; redacted final-binding diagnostic=${JSON.stringify(exactSourceProofDiagnostic)}` : ""}`).toBe(true)

    await client.query("SAVEPOINT same_raw_call_id_different_item_step_attempt")
    try {
      const sourceStep = await client.query<{ ordinal: number; attempt: number }>(
        `SELECT "ordinal", "attempt" FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
        [sourceStepId, ids.sessionId, ids.turnId, ids.waiterTaskId],
      )
      expect(sourceStep.rows).toEqual([{ ordinal: expect.any(Number), attempt: exactSourceProjection.sourceAttempt }])
      const decoyAttempt = Math.max(task.attemptCount, exactSourceProjection.sourceAttempt) + 1
      const decoyStepId = `task:${task.id}:step:source-wait-decoy:attempt:${decoyAttempt}`
      const decoyItemId = `task:${task.id}:item:tool-call:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:${decoyAttempt}`
      const occupiedStep = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND "ordinal" = $4 AND "attempt" = $5`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStep.rows[0]!.ordinal, decoyAttempt],
      )
      expect(occupiedStep.rows[0]?.count).toBe(0)
      const decoyStep = await client.query(
        `INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
           "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt", "completedAt")
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [decoyStepId, ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStep.rows[0]!.ordinal, decoyAttempt],
      )
      expect(decoyStep.rowCount).toBe(1)
      const decoyCallContent = { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", toolVersion: "1",
        input: sourceInput, status: "completed", errorCode: null }
      const decoyCall = await client.query(
        `INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase",
           "revision", "content", "startedAt", "completedAt", "updatedAt")
         VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [decoyItemId, ids.sessionId, ids.turnId, decoyStepId, ids.waiterTaskId, JSON.stringify(decoyCallContent)],
      )
      expect(decoyCall.rowCount).toBe(1)
      const sourceStartId = exactSourceStart.rows[0]!.id
      const sourceTerminalId = exactSourceTerminal.rows[0]!.id
      const detachedSourceCorrelationId = `fixture-detached-source:${randomUUID()}`
      const changedStart = await client.query(
        `UPDATE "agent_events" SET "correlationId" = $1 WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4
           AND "taskId" = $5 AND "itemId" = $6 AND "type" = 'tool_call.started' AND "correlationId" = $7`,
        [detachedSourceCorrelationId, sourceStartId, ids.sessionId, ids.turnId, ids.waiterTaskId, sourceCallItemId,
          PHONE_SHAPED_WAIT_TOOL_CALL_ID],
      )
      expect(changedStart.rowCount).toBe(1)
      const priorEvent = await client.query<{ id: string }>(
        `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           ORDER BY "sequence" DESC LIMIT 1`, [ids.sessionId, ids.turnId, ids.waiterTaskId],
      )
      expect(priorEvent.rows).toHaveLength(1)
      const advancedSequence = await client.query<{ eventSequence: string }>(
        `UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 4 WHERE "id" = $1 AND "userId" = $2
           RETURNING "eventSequence"`, [ids.sessionId, ids.userId],
      )
      expect(advancedSequence.rows).toHaveLength(1)
      const terminalSequence = BigInt(advancedSequence.rows[0]!.eventSequence)
      const itemStartedId = `task:${task.id}:event:item-started:${decoyItemId}`
      const callStartedId = `task:${task.id}:event:child-wait-claim:${decoyAttempt}:${decoyStepId}`
      const itemCompletedId = `task:${task.id}:event:tool-call-completed:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:${decoyItemId}:1`
      const sequences = [terminalSequence - 3n, terminalSequence - 2n, terminalSequence - 1n].map(String)
      const insertDecoyEvent = (event: { id: string; itemId: string; sequence: string; type: string; correlationId: string;
        causationId: string; idempotencyKey: string; payload: unknown }) => client.query(
        `INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
           "correlationId", "causationId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'subagent', $8, $9, $10, $11::jsonb)`,
        [event.id, ids.sessionId, ids.turnId, event.itemId, ids.waiterTaskId, event.sequence, event.type,
          event.correlationId, event.causationId, event.idempotencyKey, JSON.stringify(event.payload)],
      )
      const itemStarted = await insertDecoyEvent({ id: itemStartedId, itemId: decoyItemId, sequence: sequences[0]!, type: "item.started",
        correlationId: decoyStepId, causationId: priorEvent.rows[0]!.id, idempotencyKey: itemStartedId,
        payload: { itemId: decoyItemId, type: "tool_call", phase: null } })
      const callStarted = await insertDecoyEvent({ id: callStartedId, itemId: decoyItemId, sequence: sequences[1]!, type: "tool_call.started",
        correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, causationId: itemStartedId,
        idempotencyKey: callStartedId, payload: { toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, toolName: "wait_subagents", taskId: task.id } })
      expect(itemStarted.rowCount).toBe(1)
      expect(callStarted.rowCount).toBe(1)
      const decoyCompletionContent = projectWaitCallEventContent(decoyCallContent)
      const itemCompleted = await insertDecoyEvent({ id: itemCompletedId, itemId: decoyItemId, sequence: sequences[2]!, type: "item.completed",
        correlationId: decoyItemId, causationId: callStartedId,
        idempotencyKey: itemCompletedId, payload: { itemId: decoyItemId, status: "completed", content: decoyCompletionContent } })
      expect(itemCompleted.rowCount).toBe(1)
      const changedTerminal = await client.query(
        `UPDATE "agent_events" SET "itemId" = $1, "causationId" = $2, "sequence" = $3
         WHERE "id" = $4 AND "sessionId" = $5 AND "turnId" = $6 AND "taskId" = $7 AND "itemId" = $8
           AND "type" = 'tool_call.completed' AND "correlationId" = $9 AND "idempotencyKey" = $10`,
        [decoyItemId, itemCompletedId, terminalSequence.toString(), sourceTerminalId, ids.sessionId, ids.turnId, ids.waiterTaskId,
          sourceCallItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID, `task:${task.id}:event:tool-finished:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}`],
      )
      expect(changedTerminal.rowCount).toBe(1)
      expect(await evaluateTerminalProof(callStartedId, sourceTerminalId),
        "same raw call ID must not let a different persisted item, step, and attempt reuse the source completion").toBe(false)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT same_raw_call_id_different_item_step_attempt")
      await client.query("RELEASE SAVEPOINT same_raw_call_id_different_item_step_attempt")
    }
    expect(await blocking(task), "rolling back the decoy must leave the exact source/claim recovery valid").toBe(false)

    await remainsBlocked("recovered source marker bound to a different continuation step", async () => {
      await client.query(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{sourceLifecycleRecovery,stepId}', to_jsonb($1::text), false)
        WHERE "parentTaskId" = $2 AND "sessionId" = $3`, [`task:${ids.waiterTaskId}:step:99:attempt:${attempt}`, ids.waiterTaskId, ids.sessionId])
    })
    await remainsBlocked("recovered source marker with an extra field", async () => {
      await client.query(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{sourceLifecycleRecovery,unexpected}', 'true'::jsonb, true)
        WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
    })
    await remainsBlocked("recovered source marker with an empty historical owner", async () => {
      await client.query(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{sourceLifecycleRecovery,ownerId}', to_jsonb(' '::text), false)
        WHERE "parentTaskId" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
    })
    await remainsBlocked("recovered source raw idempotency key must match the durable wait", async () => {
      const changed = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,idempotencyKey}', to_jsonb($2::text), false)
        WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'tool_call'`,
        [sourceCallItemId, changedSourceKey, ids.sessionId, ids.turnId, ids.waiterTaskId])
      expect(changed.rowCount).toBe(1)
    })
    await remainsBlocked("recovered source target IDs must match the durable wait and claim", async () => {
      const changed = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,taskIds}', $2::jsonb, false)
        WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'tool_call'`,
        [sourceCallItemId, JSON.stringify(changedSourceTargets), ids.sessionId, ids.turnId, ids.waiterTaskId])
      expect(changed.rowCount).toBe(1)
    })
    await remainsBlocked("recovered source mode must match the durable wait request", async () => {
      const changed = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,mode}', to_jsonb($2::text), false)
        WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'tool_call'`,
        [sourceCallItemId, sourceMode === "all" ? "any" : "all", ids.sessionId, ids.turnId, ids.waiterTaskId])
      expect(changed.rowCount).toBe(1)
    })
    await remainsBlocked("recovered source timeout must match the durable wait request", async () => {
      const changed = await client.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{input,timeoutMs}', to_jsonb($2::int), false)
        WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'tool_call'`,
        [sourceCallItemId, sourceTimeout === 1 ? 2 : sourceTimeout - 1, ids.sessionId, ids.turnId, ids.waiterTaskId])
      expect(changed.rowCount).toBe(1)
    })
    await remainsBlocked("recovered source completion event must equal the canonical safe source-call ID", async () => {
      const changed = await client.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{content,toolCallId}', to_jsonb($2::text), false)
        WHERE "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "itemId" = $1
          AND "type" = 'item.completed' AND "idempotencyKey" = $6`,
        [sourceCallItemId, PHONE_SHAPED_WAIT_TOOL_CALL_ID, ids.sessionId, ids.turnId, ids.waiterTaskId,
          `task:${ids.waiterTaskId}:event:tool-call-completed:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:${sourceCallItemId}:1`])
      expect(changed.rowCount).toBe(1)
    })
    await remainsBlocked("same source step cannot contain a second wait_subagents call", async () => {
      const duplicateCallId = `fixture-duplicate-source-wait:${randomUUID()}`
      const duplicateCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${duplicateCallId}:attempt:1`
      const inserted = await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [duplicateCallItemId, ids.sessionId, ids.turnId, sourceStepId, ids.waiterTaskId,
          JSON.stringify({ toolCallId: duplicateCallId, toolName: "wait_subagents", toolVersion: "1", input: sourceInput })])
      expect(inserted.rowCount).toBe(1)
    })
    await remainsBlocked("same source wait cannot have a duplicate tool_result", async () => {
      const duplicateResultId = `fixture-duplicate-source-result:${randomUUID()}`
      const inserted = await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [duplicateResultId, ids.sessionId, ids.turnId, sourceStepId, ids.waiterTaskId,
          JSON.stringify({ toolCallId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, output: recoveredRow.result.outcome, errorCode: null })])
      expect(inserted.rowCount).toBe(1)
    })
    await remainsBlocked("recovered result ID must hash the exact wait and source call", async () => {
      const priorDigest = recoveredResultItemId.slice(-64)
      const changedDigest = priorDigest === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64)
      const changedResultItemId = `${recoveredResultItemId.slice(0, -64)}${changedDigest}`
      const renamedItem = await client.query(`UPDATE "agent_items" SET "id" = $2
        WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "stepId" = $6 AND "type" = 'tool_result'`,
        [recoveredResultItemId, changedResultItemId, ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId])
      expect(renamedItem.rowCount).toBe(1)
      const changedMarker = await client.query(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result",
        '{sourceLifecycleRecovery,resultItemId}', to_jsonb($2::text), false)
        WHERE "parentTaskId" = $1 AND "sessionId" = $3 AND "turnId" = $4`,
        [ids.waiterTaskId, changedResultItemId, ids.sessionId, ids.turnId])
      expect(changedMarker.rowCount).toBe(1)
      const changedResultStart = await client.query(`UPDATE "agent_events" SET "idempotencyKey" = $2,
        "payload" = jsonb_set("payload", '{itemId}', to_jsonb($3::text), false)
        WHERE "sessionId" = $4 AND "turnId" = $5 AND "taskId" = $6 AND "itemId" = $3
          AND "type" = 'item.started' AND "idempotencyKey" = $1 RETURNING "id"`,
        [`task:${ids.waiterTaskId}:event:item-started:${recoveredResultItemId}`,
          `task:${ids.waiterTaskId}:event:item-started:${changedResultItemId}`, changedResultItemId,
          ids.sessionId, ids.turnId, ids.waiterTaskId])
      expect(changedResultStart.rows).toHaveLength(1)
      const changedResultComplete = await client.query(CHANGE_RESULT_COMPLETE_SQL,
        [changedResultItemId,
          `task:${ids.waiterTaskId}:event:tool-result-completed:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:${changedResultItemId}:1`,
          ids.sessionId, ids.turnId, ids.waiterTaskId,
          `task:${ids.waiterTaskId}:event:tool-result-completed:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:${recoveredResultItemId}:1`])
      expect(changedResultComplete.rows).toHaveLength(1)
      for (const event of [changedResultStart.rows[0]!, changedResultComplete.rows[0]!]) {
        const isResultComplete = event.id === changedResultComplete.rows[0]!.id
        const outbox = await client.query(`UPDATE "agent_outbox" SET "payload" =
            jsonb_set(jsonb_set(jsonb_set("payload", '{itemId}', to_jsonb($2::text), false),
              '{idempotencyKey}', to_jsonb($3::text), false), '{payload,itemId}', to_jsonb($2::text), false)
          WHERE "topic" = 'agent.events' AND "idempotencyKey" = 'agent-event:' || $1`,
          [event.id, changedResultItemId,
            isResultComplete
              ? `task:${ids.waiterTaskId}:event:tool-result-completed:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:${changedResultItemId}:1`
              : `task:${ids.waiterTaskId}:event:item-started:${changedResultItemId}`])
        expect(outbox.rowCount).toBe(1)
        if (isResultComplete) {
          const correlation = await client.query(`UPDATE "agent_outbox" SET "payload" =
              jsonb_set("payload", '{correlationId}', to_jsonb($2::text), false)
            WHERE "topic" = 'agent.events' AND "idempotencyKey" = 'agent-event:' || $1`, [event.id, changedResultItemId])
          expect(correlation.rowCount).toBe(1)
        }
      }
    })
    await remainsBlocked("recovered result output must equal the resolved durable outcome", async () => {
      await client.query(`UPDATE "agent_items" AS result SET "content" = jsonb_set(result."content", '{output,status}', '"waiting"'::jsonb, false)
        FROM "agent_wait_conditions" AS wait WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2
          AND result."id" = wait."result"->'sourceLifecycleRecovery'->>'resultItemId'
          AND result."sessionId" = $2 AND result."turnId" = $3 AND result."taskId" = $1 AND result."type" = 'tool_result'`,
        [ids.waiterTaskId, ids.sessionId, ids.turnId])
    })
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

async function expectCompletedSourceWaitLifecycle(pool: Pool, ids: FixtureIds, priorTool = false, priorToolFailed = false): Promise<void> {
  const stepId = `task:${ids.waiterTaskId}:step:0:attempt:1`
  const callItemId = `task:${ids.waiterTaskId}:item:tool-call:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
  const resultItemId = `task:${ids.waiterTaskId}:item:tool-result:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}:attempt:1`
  const priorCallItemId = `task:${ids.waiterTaskId}:item:tool-call:fixture-noop-before-child-wait:attempt:1`
  const priorResultItemId = `task:${ids.waiterTaskId}:item:tool-result:fixture-noop-before-child-wait:attempt:1`
  const itemIds = priorTool ? [callItemId, resultItemId, priorCallItemId, priorResultItemId] : [callItemId, resultItemId]
  const [items, events, waits] = await Promise.all([
    pool.query<{ id: string; status: string; revision: number; content: Record<string, unknown> }>(
      `SELECT "id", "status", "revision", "content" FROM "agent_items"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[]) ORDER BY "id"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, itemIds],
    ),
    pool.query<{ id: string; sequence: string; type: string; itemId: string; correlationId: string; causationId: string | null; payload: Record<string, unknown> }>(
      `SELECT "id", "sequence", "type", "itemId", "correlationId", "causationId", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "itemId" = ANY($4::text[]) ORDER BY "sequence"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, itemIds],
    ),
    pool.query<{ id: string; idempotencyKey: string; mode: string; targetTaskIds: unknown; deadlineAt: Date; result: unknown }>(
      `SELECT "id", "idempotencyKey", "mode", "targetTaskIds", "deadlineAt", "result" FROM "agent_wait_conditions"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "stepId" = $4`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, stepId],
    ),
  ])
  const call = items.rows.find(item => item.id === callItemId)
  const result = items.rows.find(item => item.id === resultItemId)
  const priorCall = items.rows.find(item => item.id === priorCallItemId)
  const priorResult = items.rows.find(item => item.id === priorResultItemId)
  const sourceEvents = events.rows.filter(event => event.itemId === callItemId || event.itemId === resultItemId)
  const sourceWait = waits.rows[0]
  expect(sourceWait?.deadlineAt).toBeInstanceOf(Date)
  expect(sourceWait?.deadlineAt.getUTCMilliseconds()).not.toBe(0)
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
    priorToolItemsPresent: !priorTool || Boolean(priorCall && priorResult),
    priorToolTerminal: !priorTool || priorCall?.status === "completed" && priorResult?.status === "completed"
      && asObject(priorCall.content).status === (priorToolFailed ? "failed" : "completed")
      && asObject(priorCall.content).errorCode === (priorToolFailed ? "tool_execution_failed" : null)
      && asObject(priorResult.content).errorCode === (priorToolFailed ? "tool_execution_failed" : null),
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
    waitCount: 1, priorToolItemsPresent: true, priorToolTerminal: true,
    callToolNameMatches: true, callToolCallIdMatches: true, inputIdempotencyKeyMatches: true, inputModeMatchesWait: true,
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
  expect(sourceEvents.map(event => event.type)).toEqual([
    "item.started", "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed",
  ])
  expect(modelUsage.rows).toHaveLength(1)
  expect(modelUsage.rows[0]).toMatchObject({ type: "model.usage", actor: "subagent", correlationId: stepId,
    idempotencyKey: `task:${ids.waiterTaskId}:event:model-usage:${stepId}` })
  const sourceCallStarted = sourceEvents[0]
  const priorResultCompleted = events.rows.find(event => event.itemId === priorResultItemId && event.type === "item.completed")
  if (priorTool) {
    const expectedStatus = priorToolFailed ? "failed" : "completed"
    const expectedErrorCode = priorToolFailed ? "tool_execution_failed" : null
    expect(priorCall).toMatchObject({ content: { toolName: "fixture_noop", status: expectedStatus, errorCode: expectedErrorCode } })
    expect(priorResult).toMatchObject({ content: { toolCallId: "fixture-noop-before-child-wait", errorCode: expectedErrorCode } })
    expect(events.rows.filter(event => event.itemId === priorCallItemId).map(event => event.type)).toEqual([
      "item.started", "tool_call.started", "item.completed", priorToolFailed ? "tool_call.failed" : "tool_call.completed",
    ])
    expect(priorResultCompleted).toBeDefined()
    expect(BigInt(priorResultCompleted!.sequence)).toBeLessThan(BigInt(sourceCallStarted!.sequence))
    expect(sourceCallStarted).toMatchObject({ itemId: callItemId, causationId: priorResultCompleted!.id })
  } else {
    expect(sourceCallStarted).toMatchObject({ itemId: callItemId, correlationId: stepId, causationId: modelUsage.rows[0]!.id })
    expect(BigInt(modelUsage.rows[0]!.sequence)).toBeLessThan(BigInt(sourceCallStarted!.sequence))
  }
  expect(sourceEvents[1]).toMatchObject({ itemId: callItemId, correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID,
    causationId: sourceEvents[0]!.id })
  expect(sourceEvents[2]).toMatchObject({ itemId: callItemId, correlationId: callItemId, causationId: sourceEvents[1]!.id })
  expect(sourceEvents[3]).toMatchObject({ itemId: callItemId, correlationId: PHONE_SHAPED_WAIT_TOOL_CALL_ID, causationId: sourceEvents[2]!.id })
  expect(sourceEvents[4]).toMatchObject({ itemId: resultItemId, correlationId: stepId, causationId: sourceEvents[3]!.id })
  expect(sourceEvents[5]).toMatchObject({ itemId: resultItemId, correlationId: resultItemId, causationId: sourceEvents[4]!.id })
  const completedInput = asObject(asObject(sourceEvents[2]?.payload).content)
  expect(asObject(completedInput.input)).toMatchObject({
    idempotencyKey: "[REDACTED]",
    taskIds: ["[REDACTED]"],
  })
  expect(asObject(completedInput.input).idempotencyKey).toBe("[REDACTED]")
  expect(asObject(completedInput.input).taskIds).not.toEqual([FIXED_WAIT_TARGET_TASK_ID])
  expect(JSON.stringify(sourceEvents[2]?.payload)).not.toContain(FIXED_WAIT_TARGET_TASK_ID)
  const eventPayloads = JSON.stringify(events.rows.map(event => event.payload))
  expect(eventPayloads).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
  expect(eventPayloads).toContain(FIXED_WAIT_TARGET_TASK_ID)
  const sourceCallCompletedEvents = events.rows.filter(event => event.itemId === callItemId && event.type === "tool_call.completed"
    && event.correlationId === PHONE_SHAPED_WAIT_TOOL_CALL_ID
    && asObject(event.payload).toolCallId === PHONE_SHAPED_WAIT_TOOL_CALL_ID)
  expect(sourceCallCompletedEvents).toHaveLength(1)
  const sourceResultStartedEvents = events.rows.filter(event => event.itemId === resultItemId && event.type === "item.started"
    && event.correlationId === stepId && event.causationId === sourceCallCompletedEvents[0]!.id)
  expect(sourceResultStartedEvents).toHaveLength(1)
  const sourceResultCompletedEvents = events.rows.filter(event => event.itemId === resultItemId && event.type === "item.completed"
    && event.correlationId === resultItemId && event.causationId === sourceResultStartedEvents[0]!.id)
  expect(sourceResultCompletedEvents).toHaveLength(1)
  const resultEventContent = asObject(asObject(sourceResultCompletedEvents[0]!.payload).content)
  expect(asObject(resultEventContent.output).taskIds).toEqual([FIXED_WAIT_TARGET_TASK_ID])
  const sourceEventIds = sourceEvents.map(event => event.id)
  expect(sourceEventIds).toHaveLength(6)
  const eventOutboxes = await pool.query<{ idempotencyKey: string; payload: Record<string, unknown> }>(
    `SELECT "idempotencyKey", "payload" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.events'
       AND "idempotencyKey" = ANY($2::text[])`,
    [ids.sessionId, sourceEventIds.map(id => `agent-event:${id}`)],
  )
  expect(eventOutboxes.rows).toHaveLength(sourceEventIds.length)
  expect(eventOutboxes.rows.map(row => row.payload.eventId).sort()).toEqual([...sourceEventIds].sort())
  const eventOutboxPayload = JSON.stringify(eventOutboxes.rows.map(row => row.payload))
  expect(eventOutboxPayload).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
  expect(eventOutboxPayload).toContain(FIXED_WAIT_TARGET_TASK_ID)
  const callCompletionOutbox = eventOutboxes.rows.find(row => row.payload.eventId === sourceCallCompletedEvents[0]!.id)
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
  policy: ReturnType<typeof defaultSubagentPolicy>; id?: string;
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
    const id = input.id ?? FIXED_WAIT_TARGET_TASK_ID
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
  policy: ReturnType<typeof defaultSubagentPolicy>, targetTaskId = ids.targetTaskId): Promise<void> {
  const targetLease = await taskStore.claim({ taskId: targetTaskId, sessionId: ids.sessionId,
    ownerId: "loop-fixture-child-finisher", policy, now: new Date() })
  if (!targetLease?.leaseExpiresAt || !targetLease.turnId) throw new Error("Loop fixture target lease is unavailable")
  const lease: SubagentLease = { ...targetLease, ownerId: "loop-fixture-child-finisher",
    leaseExpiresAt: targetLease.leaseExpiresAt, signal: new AbortController().signal }
  const owner = executionOwnerFence({ kind: "task", lease })
  const turnStore = createPgTurnEngineStore(pool)
  const previousOrdinal = await pool.query<{ ordinal: number | string | null }>(`SELECT MAX("ordinal") AS "ordinal"
    FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2`, [ids.sessionId, ids.turnId])
  const previousMaxOrdinal = previousOrdinal.rows[0]?.ordinal === null || previousOrdinal.rows[0]?.ordinal === undefined
    ? -1 : Number(previousOrdinal.rows[0].ordinal)
  if (!Number.isSafeInteger(previousMaxOrdinal) || previousMaxOrdinal < 0) throw new Error("Loop fixture turn ordinal baseline is unavailable")
  const step = await turnStore.startStep({ owner, stepId: `loop-child-target-step:${targetTaskId}`, ordinal: 0,
    attempt: lease.attemptCount, inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
  if (step.ordinal !== previousMaxOrdinal + 1 || step.ordinal <= previousMaxOrdinal) {
    throw new Error("Loop fixture target did not preserve the Turn-global ordinal gap")
  }
  await turnStore.updateStep({ owner, stepId: step.id, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now: new Date() })
  const finished = await taskStore.finish({ taskId: targetTaskId, sessionId: ids.sessionId, ownerId: lease.ownerId,
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

  it("parses the recovered child-wait blocker query on disposable PostgreSQL", async () => {
    const suffix = randomUUID()
    const snapshot: BlockingTaskSnapshot = {
      id: `missing-wait-task-${suffix}`, userId: `missing-wait-user-${suffix}`,
      sessionId: `missing-wait-session-${suffix}`, turnId: `missing-wait-turn-${suffix}`,
      rootTaskId: `missing-wait-root-${suffix}`, leaseOwner: "fixture-owner", attemptCount: 2,
      leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.user_id', $1, true)", [snapshot.userId])
      await expect(hasBlockingExternalCall(client, snapshot)).resolves.toBe(false)
    } finally {
      await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  })

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
    const publishRecoveryTimeoutSnapshot = async (sample: "post_timeout_read_committed_snapshot" | "post_poll_error_read_committed_snapshot"): Promise<Record<string, unknown>> => {
      let client: PoolClient | undefined
      let queueState: Record<string, boolean> = { available: false, waiting: false, active: false, delayed: false, failed: false, completed: false }
      try {
        const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed")
        queueState = { available: true, waiting: counts.waiting > 0, active: counts.active > 0, delayed: counts.delayed > 0,
          failed: counts.failed > 0, completed: counts.completed > 0 }
      } catch { /* Fixed booleans only; queue diagnostics must not replace the original timeout. */ }
      try {
        client = await pool.connect()
        await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY")
        await client.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        const task = await client.query<{ status: string; attemptCount: number; leaseOwner: string | null; leaseExpired: boolean }>(
          `SELECT "status", "attemptCount", "leaseOwner", "leaseExpiresAt" <= clock_timestamp() AS "leaseExpired" FROM "sub_agent_tasks"
           WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4`,
          [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId],
        )
        const dispatch = await client.query<{ attemptCount: number; publishedAt: Date | null }>(
          `SELECT "attemptCount", "publishedAt" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
           AND "aggregateId" = $1 AND "idempotencyKey" = $2`, [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`],
        )
        const wait = await client.query<{ status: string; consumedAt: Date | null; suspendedAt: Date | null; deadlineElapsed: boolean; hasRecoveryMarker: boolean }>(
          `SELECT "status", "consumedAt", "suspendedAt", "deadlineAt" <= clock_timestamp() AS "deadlineElapsed",
             "result" ? 'sourceLifecycleRecovery' AS "hasRecoveryMarker"
           FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
          [ids.waiterTaskId, ids.sessionId, ids.turnId],
        )
        const targets = await client.query<{ targetCount: number; terminalCount: number; waitingCount: number }>(
          `SELECT COUNT(target."id")::int AS "targetCount",
             COUNT(*) FILTER (WHERE child."status" IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed'))::int AS "terminalCount",
             COUNT(*) FILTER (WHERE child."status" = 'waiting')::int AS "waitingCount"
           FROM "agent_wait_conditions" AS wait
           LEFT JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END)
             WITH ORDINALITY AS target("id", ordinal) ON target.ordinal <= 8
           LEFT JOIN "sub_agent_tasks" AS child ON child."id" = target."id" AND child."sessionId" = wait."sessionId"
             AND child."turnId" = wait."turnId" AND child."parentTaskId" = wait."parentTaskId"
           WHERE wait."parentTaskId" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3`,
          [ids.waiterTaskId, ids.sessionId, ids.turnId],
        )
        const taskRow = task.rows[0], dispatchRow = dispatch.rows[0], waitRow = wait.rows[0], targetRow = targets.rows[0]
        const taskStatuses = new Set(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"])
        const waitStatuses = new Set(["waiting", "ready", "timed_out", "interrupted", "closed"])
        return {
          sample,
          taskStatus: taskRow && taskStatuses.has(taskRow.status) ? taskRow.status : taskRow ? "other" : "missing",
          attemptCount: Number.isSafeInteger(taskRow?.attemptCount) ? taskRow!.attemptCount : null,
          leaseOwnerPresent: Boolean(taskRow?.leaseOwner),
          leaseExpired: taskRow?.leaseExpired ?? null,
          dispatchRows: dispatch.rows.length,
          dispatchGeneration: Number.isSafeInteger(dispatchRow?.attemptCount) ? dispatchRow!.attemptCount : null,
          dispatchPublished: dispatchRow ? dispatchRow.publishedAt !== null : null,
          waitRows: wait.rows.length,
          waitStatus: waitRow && waitStatuses.has(waitRow.status) ? waitRow.status : waitRow ? "other" : "missing",
          consumed: waitRow ? waitRow.consumedAt !== null : null,
          suspended: waitRow ? waitRow.suspendedAt !== null : null,
          deadline: waitRow ? (waitRow.deadlineElapsed ? "elapsed" : "future") : "invalid",
          hasRecoveryMarker: waitRow?.hasRecoveryMarker ?? false,
          queue: queueState,
          targets: { count: targetRow?.targetCount ?? 0, terminal: targetRow?.terminalCount ?? 0, waiting: targetRow?.waitingCount ?? 0 },
        }
      } catch {
        return { sample, available: false }
      } finally {
        if (client) {
          await client.query("ROLLBACK").catch(() => undefined)
          client.release()
        }
      }
    }
    const publishRecovery = async (previousCount: number) => {
      let pending: { status: string; attemptCount: number; publishedAt: Date | null }
      try {
        pending = await waitFor(async () => {
          const row = await pool.query<{ status: string; attemptCount: number; publishedAt: Date | null }>(
            `SELECT task."status", dispatch."attemptCount", dispatch."publishedAt"
             FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
               AND dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
             WHERE task."id" = $1 AND task."sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
          return row.rows[0]?.status === "queued" && row.rows[0]?.publishedAt === null ? row.rows[0] : null
        })
      } catch (error) {
        const timedOut = error instanceof Error && error.message === "Timed out waiting for durable child-wait state"
        const snapshot = await publishRecoveryTimeoutSnapshot(timedOut
          ? "post_timeout_read_committed_snapshot" : "post_poll_error_read_committed_snapshot")
        throw new Error(`fixture_publish_recovery_${timedOut ? "timeout" : "poll_error"} ${JSON.stringify(snapshot)}`)
      }
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
        orphanCallId: string | null; claimCallId: string | null; repeatedRepairCount: number
      }
      expect(repaired).toMatchObject({ waitId: legacy.waitId, sourceStepId: legacy.sourceStepId, sourceAttempt: 1,
        currentAttempt: 1, continuationStepId: legacy.continuationStepId, orphanCallId: null, claimCallId: legacy.callId,
        repeatedRepairCount: 0 })
      const repairedLifecycle = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(repairedLifecycle, ids)
      expect(repairedLifecycle.wait?.consumedAt).toEqual(preRepair.wait?.consumedAt)
      expect(workerC.stdoutText + workerC.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      await waitForMarker(workerC, "WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT")
      const claimed = await readWaitClaimState(pool, ids, legacy.continuationStepId, legacy.callId, 1)
      expect(claimed).toMatchObject({ callCount: 1, claimCount: 1, itemStartedCount: 1, resultCount: 0, claimOutboxCount: 1,
        call: { status: "completed", revision: 1 } })
      expect(claimed.claim).toMatchObject({ type: "tool_call.started", correlationId: legacy.callId,
        causationId: claimed.itemStarted?.id,
        idempotencyKey: `task:${ids.waiterTaskId}:event:child-wait-claim:1:${legacy.continuationStepId}` })
      expect(claimed.lifecycle.map(event => event.type)).toEqual(["item.started", "tool_call.started"])
      const claimCutMarker = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT "))
      expect(JSON.parse(claimCutMarker!.slice("WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT ".length))).toMatchObject({
        callId: legacy.callId, stepId: legacy.continuationStepId, waitId: legacy.waitId,
        modelCalls: expect.any(Number), executorCalls: expect.any(Number), priorNoopExecutorCalls: 0, dispatcherCalls: 0,
        callStatus: "completed", callRevision: 1,
        claimCount: 1, itemCompletedEventCount: 0, resultCount: 0,
      })
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
      const loopSummaryLine = workerD.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESUMED "))
      const loopSummary = JSON.parse(loopSummaryLine!.slice("WORKER_B_LOOP_RESUMED ".length)) as Record<string, unknown> & { finalText?: string }
      expect(typeof ids.finalText === "string" && loopSummary.finalText === ids.finalText).toBe(true)
      expect(workerD.stdoutText + workerD.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      const finished = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null; result: unknown }>(
        `SELECT "status", "attemptCount", "leaseOwner", "result" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])
      expect(finished.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null,
        result: { finalText: ids.finalText } })
      const finalSource = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(finalSource, ids)
      expect(BigInt(finalSource.eventSequence!)).toBeGreaterThan(BigInt(repairedLifecycle.eventSequence!))
      expect({ wait: finalSource.wait, call: finalSource.call, results: finalSource.results,
        events: finalSource.events, outboxes: finalSource.outboxes }).toEqual({ wait: repairedLifecycle.wait,
        call: repairedLifecycle.call, results: repairedLifecycle.results, events: repairedLifecycle.events,
        outboxes: repairedLifecycle.outboxes })
      const finalClaim = await readWaitClaimState(pool, ids, legacy.continuationStepId, legacy.callId, 1)
      expect(finalClaim).toMatchObject({ callCount: 1, claimCount: 1, itemStartedCount: 1, resultCount: 1, claimOutboxCount: 1 })
      expect(loopSummary).toMatchObject({ phase: "final", status: "completed",
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
      const repairedSourceStep = await pool.query<{ id: string; attempt: number; ordinal: number | string; status: string }>(
        `SELECT "id", "attempt", "ordinal", "status" FROM "agent_steps"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
        [sourceOnly.sourceStepId, ids.sessionId, ids.turnId, ids.waiterTaskId],
      )
      expect(repairedSourceStep.rows).toHaveLength(1)
      expect(repairedSourceStep.rows[0]).toMatchObject({ id: sourceOnly.sourceStepId, attempt: 1, status: "waiting_for_tool" })
      expect(Number(repairedSourceStep.rows[0]!.ordinal)).toBe(sourceOnly.sourcePhysicalOrdinal)
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

      const sourceCallInput = asObject(asObject(repaired.call?.content).input)
      const sourceKey = sourceCallInput.idempotencyKey
      const sourceTargets = sourceCallInput.taskIds
      const sourceMode = sourceCallInput.mode
      const sourceTimeout = sourceCallInput.timeoutMs
      if (typeof sourceKey !== "string" || !Array.isArray(sourceTargets) || sourceTargets.length !== 1
        || sourceTargets.some(target => typeof target !== "string") || (sourceMode !== "any" && sourceMode !== "all")
        || typeof sourceTimeout !== "number" || !Number.isSafeInteger(sourceTimeout)) {
        throw new Error("cross_attempt_source_wait_input_invalid")
      }
      const continuationStepId = `task:${ids.waiterTaskId}:step:1:attempt:2`
      const claimCallId = `child-wait-continuation-attempt-2:${suffix}`
      const claimItemId = `task:${ids.waiterTaskId}:item:tool-call:${claimCallId}:attempt:2`
      const owner = executionOwnerFence({ kind: "task", lease: currentLease })
      const turnStore = createPgTurnEngineStore(pool)
      const continuationStep = await turnStore.startStep({ owner, stepId: continuationStepId, ordinal: 1, attempt: 2,
        inputThroughSequence: 0n, consumedInputIds: [], modelProfileSnapshot: {}, now: new Date() })
      expect(continuationStep.ordinal).toBeGreaterThan(sourceOnly.sourcePhysicalOrdinal)
      const claimInput = { idempotencyKey: safeProjectedWaitKey({ taskIds: sourceTargets as string[], mode: sourceMode,
        timeoutMs: sourceTimeout, idempotencyKey: sourceKey }), taskIds: sourceTargets as string[], mode: sourceMode, timeoutMs: sourceTimeout }
      await turnStore.createItem({ owner, itemId: claimItemId, stepId: continuationStep.id, type: "tool_call", status: "started",
        phase: null, content: { toolCallId: claimCallId, toolName: "wait_subagents", toolVersion: "1", input: claimInput }, now: new Date() })
      const precedingEvent = await pool.query<{ id: string }>(`SELECT "id" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId])
      if (!precedingEvent.rows[0]) throw new Error("cross_attempt_claim_preceding_event_missing")
      const itemStartedId = `task:${ids.waiterTaskId}:event:item-started:${claimItemId}`
      await turnStore.appendEvent({ owner, id: itemStartedId, itemId: claimItemId, type: "item.started",
        correlationId: continuationStep.id, causationId: precedingEvent.rows[0].id, idempotencyKey: itemStartedId,
        payload: { itemId: claimItemId, type: "tool_call", phase: null } })
      const claimKey = `task:${ids.waiterTaskId}:event:child-wait-claim:2:${continuationStep.id}`
      const claimStart = await turnStore.appendEvent({ owner, id: claimKey, itemId: claimItemId, type: "tool_call.started",
        correlationId: claimCallId, causationId: itemStartedId, idempotencyKey: claimKey,
        payload: { toolCallId: claimCallId, toolName: "wait_subagents", taskId: ids.waiterTaskId } })
      const crossAttemptSnapshot: BlockingTaskSnapshot = { id: ids.waiterTaskId, userId: ids.userId,
        sessionId: ids.sessionId, turnId: ids.turnId, rootTaskId: ids.rootTaskId,
        leaseOwner: syntheticOwner, attemptCount: currentLease.attemptCount, leaseExpiresAt: currentLease.leaseExpiresAt }
      const blockerClient = await pool.connect()
      try {
        await blockerClient.query("BEGIN")
        await blockerClient.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        const lockedSession = await blockerClient.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
          [ids.sessionId, ids.userId])
        expect(lockedSession.rowCount).toBe(1)
        const lockedTask = await blockerClient.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2
          AND "turnId" = $3 AND "rootTaskId" = $4 AND "status" = 'running' AND "leaseOwner" = $5
          AND "attemptCount" = 2 AND "leaseExpiresAt" > clock_timestamp() FOR UPDATE`,
          [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId, syntheticOwner])
        expect(lockedTask.rowCount).toBe(1)
        const blocking = (snapshot: BlockingTaskSnapshot) => hasBlockingExternalCall(
          blockerClient, snapshot as unknown as Record<string, unknown>, undefined, continuationStep.id)
        const crossAttemptProof = await diagnoseWorkerFClaimProof(blockerClient, crossAttemptSnapshot,
          continuationStep.id, PHONE_SHAPED_WAIT_TOOL_CALL_ID, claimCallId)
        const crossAttemptBlocked = await blocking(crossAttemptSnapshot)
        const crossAttemptStarts = await diagnoseWorkerFStartCandidates(blockerClient, crossAttemptSnapshot,
          continuationStep.id, PHONE_SHAPED_WAIT_TOOL_CALL_ID, claimCallId, crossAttemptBlocked)
        expect(crossAttemptBlocked,
          `a unique historical source may authorize its exact current claim: ${JSON.stringify({ claimProof: crossAttemptProof, ...crossAttemptStarts })}`).toBe(false)
        expect(await blocking({ ...crossAttemptSnapshot, leaseOwner: `${syntheticOwner}:stale` }),
          "a stale current lease owner must leave the attempt-2 claim blocking").toBe(true)
        expect(await blocking({ ...crossAttemptSnapshot, attemptCount: 1 }),
          "a claim evaluated with the wrong current attempt must remain blocking").toBe(true)

        await blockerClient.query("SAVEPOINT cross_attempt_malformed_claim")
        try {
          const changed = await blockerClient.query(`UPDATE "agent_events" SET "idempotencyKey" = $2
            WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'tool_call.started'`,
            [claimStart.id, `task:${ids.waiterTaskId}:event:child-wait-claim:1:${continuationStep.id}`,
              ids.sessionId, ids.turnId, ids.waiterTaskId])
          expect(changed.rowCount).toBe(1)
          expect(await blocking(crossAttemptSnapshot), "the current attempt is part of the exact claim identity").toBe(true)
        } finally {
          await blockerClient.query("ROLLBACK TO SAVEPOINT cross_attempt_malformed_claim")
          await blockerClient.query("RELEASE SAVEPOINT cross_attempt_malformed_claim")
        }
      } finally {
        await blockerClient.query("ROLLBACK").catch(() => undefined)
        blockerClient.release()
      }
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
        `WorkerA result was not waiting: ${await workerFailureDiagnostic(pool, workerA, ids)}`).toBe("waiting")
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

  it("settles a real multi-tool continuation across a PostgreSQL/Redis process restart without replay", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `durable-child-wait-multi-user-${suffix}`,
      sessionId: `durable-child-wait-multi-session-${suffix}`,
      turnId: `durable-child-wait-multi-turn-${suffix}`,
      rootTaskId: "",
      waiterTaskId: "",
      targetTaskId: "",
      loopCallPrefix: `multi-wait-call-${suffix}`,
      finalText: FINAL_MARKER,
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

      workerA = launchWorker("worker-a-prior-tool", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerA, "WORKER_A_WAITING")
      expect(workerResultStatus(workerA, "WORKER_A_WAITING")).toBe("waiting")
      await expectCompletedSourceWaitLifecycle(pool, ids, true)
      expect((await workerA.exited)).toMatchObject({ code: 0, signal: null })

      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      const resolved = await reconcileDurableSubagentWaits(pool)
      expect(resolved.woken).toBeGreaterThan(0)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)

      workerB = launchWorker("worker-b-loop-multi-complete-cut", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_READY")
      await waitForMarker(workerB, "WORKER_B_LOOP_MULTI_STEP_DURABLE")
      const continuationStepId = `task:${ids.waiterTaskId}:step:1:attempt:1`
      const readCompletedChain = async () => {
        const calls = await pool.query<{ toolName: string; status: string; revision: number; callStarted: number;
          callCompleted: number; resultCount: number }>(`SELECT call."content"->>'toolName' AS "toolName", call."status", call."revision",
            (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = call."sessionId" AND event."turnId" = call."turnId"
              AND event."taskId" = call."taskId" AND event."itemId" = call."id" AND event."type" = 'tool_call.started') AS "callStarted",
            (SELECT COUNT(*)::int FROM "agent_events" AS event WHERE event."sessionId" = call."sessionId" AND event."turnId" = call."turnId"
              AND event."taskId" = call."taskId" AND event."itemId" = call."id" AND event."type" = 'tool_call.completed') AS "callCompleted",
            (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
              AND result."taskId" = call."taskId" AND result."stepId" = call."stepId" AND result."type" = 'tool_result'
              AND result."content"->>'toolCallId' = call."content"->>'toolCallId') AS "resultCount"
          FROM "agent_items" AS call WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3
            AND call."stepId" = $4 AND call."type" = 'tool_call' ORDER BY call."content"->>'toolName'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId])
        return calls.rows
      }
      const callChainBeforeRestart = await readCompletedChain()
      expect(callChainBeforeRestart).toEqual([
        { toolName: "fixture_noop", status: "completed", revision: 1, callStarted: 1, callCompleted: 1, resultCount: 1 },
        { toolName: "wait_subagents", status: "completed", revision: 1, callStarted: 1, callCompleted: 1, resultCount: 1 },
      ])
      const stepEventsBeforeRestart = await pool.query<{ type: string; count: number }>(`SELECT event."type", COUNT(*)::int AS "count"
        FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
          AND (event."correlationId" = $4 OR event."itemId" IN (SELECT item."id" FROM "agent_items" AS item
            WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4))
        GROUP BY event."type" ORDER BY event."type"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId])
      expect(Object.fromEntries(stepEventsBeforeRestart.rows.map(row => [row.type, row.count]))).toEqual({
        "cognitive.agenda": 1, "item.completed": 4, "item.started": 4, "model.completed": 1, "model.started": 1,
        "model.usage": 1, "step.completed": 1, "step.started": 1, "tool_call.completed": 2, "tool_call.started": 2,
      })

      const checkClient = await pool.connect()
      try {
        await checkClient.query("BEGIN")
        await checkClient.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        const session = await checkClient.query<{ userId: string }>(`SELECT "userId" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
          [ids.sessionId, ids.userId])
        expect(session.rows).toHaveLength(1)
        const current = await checkClient.query<BlockingTaskRow>(`SELECT "id", "sessionId", "turnId", "rootTaskId", "leaseOwner", "attemptCount", "leaseExpiresAt"
          FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
        [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId])
        expect(current.rows).toHaveLength(1)
        const owner = current.rows[0]
        if (!owner) throw new Error("multi_tool_live_owner_missing")
        expect(owner.leaseOwner).toEqual(expect.any(String))
        expect(owner.leaseExpiresAt).toBeInstanceOf(Date)
        await expectHistoricalWaitUnblocked(checkClient, { ...owner, userId: ids.userId }, continuationStepId,
          PHONE_SHAPED_WAIT_TOOL_CALL_ID, `${ids.loopCallPrefix}:${ids.waiterTaskId}:attempt:1`,
          "real writer events for the complete two-tool step must settle its historical wait claim")
        await checkClient.query("COMMIT")
      } catch (error) {
        await checkClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { checkClient.release() }

      await stopWorker(workerB)
      expect(await workerB.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const interruptedLease = await pool.query<{ leaseOwner: string | null }>(`SELECT "leaseOwner" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'running' AND "attemptCount" = 1`,
      [ids.waiterTaskId, ids.sessionId, ids.turnId])
      const interruptedOwner = interruptedLease.rows[0]?.leaseOwner
      expect(interruptedOwner).toEqual(expect.any(String))
      const expired = await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, interruptedOwner])
      expect(expired.rowCount).toBe(1)

      workerC = launchWorker("worker-b-loop-final", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      const restoredTask = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])
      expect(restoredTask.rows[0]).toMatchObject({ status: "queued", attemptCount: 1, leaseOwner: null })
      const dispatch = await pool.query<{ publishedAt: Date | null }>(`SELECT "publishedAt" FROM "agent_outbox"
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
      [ids.sessionId, `subagent-dispatch:${ids.waiterTaskId}`])
      expect(dispatch.rows[0]?.publishedAt).toBeNull()
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await queueRedis.set(workerStartGateKey(ids), "start", "EX", 60)
      await waitForMarker(workerC, "WORKER_B_PROCESSING_RELEASED")
      await waitForMarker(workerC, "WORKER_B_LOOP_RESTORED")
      await waitForMarker(workerC, "WORKER_B_LOOP_RESUMED")
      const finalMarker = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESUMED "))
      expect(JSON.parse(finalMarker!.slice("WORKER_B_LOOP_RESUMED ".length))).toMatchObject({
        phase: "final", status: "completed", finalText: FINAL_MARKER, executorCalls: 0, dispatcherCalls: 0,
      })
      expect(await readCompletedChain()).toEqual(callChainBeforeRestart)
      const stepEventsAfterRestart = await pool.query<{ type: string; count: number }>(`SELECT event."type", COUNT(*)::int AS "count"
        FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
          AND (event."correlationId" = $4 OR event."itemId" IN (SELECT item."id" FROM "agent_items" AS item
            WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."stepId" = $4))
        GROUP BY event."type" ORDER BY event."type"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId])
      expect(stepEventsAfterRestart.rows).toEqual(stepEventsBeforeRestart.rows)
      const finished = await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])
      expect(finished.rows[0]).toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null })
      expect(await workerC.exited).toMatchObject({ code: 0, signal: null })
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
      await queue.obliterate({ force: true }).catch(() => undefined)
      await queue.close().catch(() => undefined)
      if (closeSharedRedisConnections) await closeSharedRedisConnections().catch(() => undefined)
      if (originalRedisUrl === undefined) delete process.env.REDIS_URL
      else process.env.REDIS_URL = originalRedisUrl
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* preserve the original failure */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 60_000)

  it("rebinds two distinct historical waits and completed claims across a PostgreSQL/Redis process restart", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = { userId: `durable-child-wait-two-user-${suffix}`, sessionId: `durable-child-wait-two-session-${suffix}`,
      turnId: `durable-child-wait-two-turn-${suffix}`, rootTaskId: "", waiterTaskId: "", targetTaskId: "",
      secondTargetTaskId: `subagent-${suffix}`, waitScopedClaimCallIds: true,
      loopCallPrefix: `two-wait-call-${suffix}`, finalText: FINAL_MARKER }
    const queueName = `agent-child-wait-two-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined, workerB: WorkerProcess | undefined
    let workerC: WorkerProcess | undefined, workerD: WorkerProcess | undefined
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined

    try {
      await queue.waitUntilReady()
      process.env.REDIS_URL = redisUrl!
      const redisRuntime = await import("../../redis.js")
      closeSharedRedisConnections = redisRuntime.closeSharedRedisConnections
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await seedLoopWaitScenario(pool, taskStore, ids, suffix, policy)
      ids.secondTargetTaskId = await seedFixedWaitTarget(pool, { userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
        rootTaskId: ids.rootTaskId, parentTaskId: ids.waiterTaskId, policy, id: ids.secondTargetTaskId })

      workerA = launchWorker("worker-a-prior-tool-failed", queueName, ids)
      await waitForMarker(workerA, "WORKER_A_READY")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await waitForMarker(workerA, "WORKER_A_WAITING")
      expect(workerResultStatus(workerA, "WORKER_A_WAITING")).toBe("waiting")
      await expectCompletedSourceWaitLifecycle(pool, ids, true, true)
      expect(await workerA.exited).toMatchObject({ code: 0, signal: null })

      const firstWait = await pool.query<{ id: string }>(`SELECT "id" FROM "agent_wait_conditions" WHERE "parentTaskId" = $1 AND "stepId" = $2
        AND "sessionId" = $3 AND "turnId" = $4`, [ids.waiterTaskId, `task:${ids.waiterTaskId}:step:0:attempt:1`, ids.sessionId, ids.turnId])
      expect(firstWait.rows).toHaveLength(1)
      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      expect((await reconcileDurableSubagentWaits(pool)).woken).toBeGreaterThan(0)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)

      workerB = launchWorker("worker-b-loop-two-waits", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_READY")
      await waitForMarker(workerB, "WORKER_B_LOOP_SECOND_SOURCE_REGISTERED")
      await waitForMarker(workerB, "WORKER_B_LOOP_RESUMED")
      const secondWaitMarker = workerB.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_SECOND_SOURCE_REGISTERED "))
      const secondWait = secondWaitMarker ? JSON.parse(secondWaitMarker.slice("WORKER_B_LOOP_SECOND_SOURCE_REGISTERED ".length)) as { waitId: string; stepId: string } : null
      expect(secondWait?.waitId).toEqual(expect.any(String))
      expect(secondWait?.stepId.startsWith(`task:${ids.waiterTaskId}:step:`)).toBe(true)
      expect(secondWait?.stepId.endsWith(":attempt:1")).toBe(true)
      const resumed = workerB.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESUMED "))
      expect(resumed ? JSON.parse(resumed.slice("WORKER_B_LOOP_RESUMED ".length)) : null).toMatchObject({
        phase: "two-waits", status: "waiting_for_dependency", executorCalls: 3, dispatcherCalls: 0,
      })
      expect(await workerB.exited).toMatchObject({ code: 0, signal: null })

      await finishLoopWaitTarget(pool, taskStore, ids, policy, ids.secondTargetTaskId!)
      expect((await reconcileDurableSubagentWaits(pool)).woken).toBeGreaterThan(0)
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)

      workerC = launchWorker("worker-b-loop-multi-complete-cut", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_READY")
      await waitForMarker(workerC, "WORKER_B_LOOP_MULTI_STEP_DURABLE")
      const claimSteps = await pool.query<{ waitId: string; sourceStepId: string; claimOrdinal: number }>(`SELECT wait."id" AS "waitId",
        source."id" AS "sourceStepId", source."ordinal" + 1 AS "claimOrdinal" FROM "agent_wait_conditions" AS wait
        JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
          AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
        WHERE wait."id" = ANY($1::text[]) AND wait."parentTaskId" = $2 AND wait."sessionId" = $3 AND wait."turnId" = $4
        ORDER BY source."ordinal"`, [[firstWait.rows[0]!.id, secondWait!.waitId], ids.waiterTaskId, ids.sessionId, ids.turnId])
      expect(claimSteps.rows).toHaveLength(2)
      expect(claimSteps.rows.map(row => row.waitId).sort()).toEqual([firstWait.rows[0]!.id, secondWait!.waitId].sort())
      expect(claimSteps.rows.find(row => row.waitId === secondWait!.waitId)?.sourceStepId).toBe(secondWait!.stepId)
      const firstClaimOrdinal = claimSteps.rows.find(row => row.waitId === firstWait.rows[0]!.id)?.claimOrdinal
      if (firstClaimOrdinal === undefined) throw new Error("two_historical_wait_first_claim_step_missing")
      const firstClaimStepId = "task:" + ids.waiterTaskId + ":step:" + firstClaimOrdinal + ":attempt:1"
      const claimStepIds = claimSteps.rows.map(row => `task:${ids.waiterTaskId}:step:${row.claimOrdinal}:attempt:1`)
      const secondClaimOrdinal = claimSteps.rows.find(row => row.waitId === secondWait!.waitId)?.claimOrdinal
      if (secondClaimOrdinal === undefined) throw new Error("two_historical_wait_second_claim_step_missing")
      const secondClaimStepId = `task:${ids.waiterTaskId}:step:${secondClaimOrdinal}:attempt:1`
      const readClaimLifecycle = async () => (await pool.query<{ callId: string; stepId: string; startCount: number; terminalCount: number; resultCount: number }>(
        `SELECT call."content"->>'toolCallId' AS "callId", call."stepId", (SELECT COUNT(*)::int FROM "agent_events" AS started
          WHERE started."sessionId" = call."sessionId" AND started."turnId" = call."turnId" AND started."taskId" = call."taskId"
            AND started."itemId" = call."id" AND started."type" = 'tool_call.started') AS "startCount",
          (SELECT COUNT(*)::int FROM "agent_events" AS terminal WHERE terminal."sessionId" = call."sessionId" AND terminal."turnId" = call."turnId"
            AND terminal."taskId" = call."taskId" AND terminal."itemId" = call."id" AND terminal."type" = 'tool_call.completed') AS "terminalCount",
          (SELECT COUNT(*)::int FROM "agent_items" AS result WHERE result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
            AND result."taskId" = call."taskId" AND result."stepId" = call."stepId" AND result."type" = 'tool_result'
            AND result."content"->>'toolCallId' = call."content"->>'toolCallId') AS "resultCount"
          FROM "agent_items" AS call WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3
            AND call."stepId" = ANY($4::text[]) AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
          ORDER BY call."stepId"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, claimStepIds])).rows
      const claimsBeforeRestart = await readClaimLifecycle()
      expect(claimsBeforeRestart).toHaveLength(2)
      expect(claimsBeforeRestart.map(row => [row.startCount, row.terminalCount, row.resultCount])).toEqual([[1, 1, 1], [1, 1, 1]])
      expect(new Set(claimsBeforeRestart.map(row => row.callId)).size).toBe(2)

      const checkClient = await pool.connect()
      try {
        await checkClient.query("BEGIN")
        await checkClient.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        expect((await checkClient.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
          [ids.sessionId, ids.userId])).rows).toHaveLength(1)
        const current = await checkClient.query<BlockingTaskRow>(`SELECT "id", "sessionId", "turnId", "rootTaskId", "leaseOwner", "attemptCount", "leaseExpiresAt"
          FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
        [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId])
        const owner = current.rows[0]
        if (!owner?.leaseOwner || !owner.leaseExpiresAt) throw new Error("two_historical_wait_live_owner_missing")
        const scopedOwner = { ...owner, userId: ids.userId }
        const projections = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        const expectedWaitIds = new Set([firstWait.rows[0]!.id, secondWait!.waitId])
        expect(projections).toHaveLength(4)
        expect([...new Set(projections.map(projection => projection.sourceWait.waitId))].sort()).toEqual([...expectedWaitIds].sort())
        for (const waitId of expectedWaitIds) expect(projections.filter(projection => projection.sourceWait.waitId === waitId)).toHaveLength(2)
        const failedPrefix = projections.find(projection => projection.sourceWait.waitId === firstWait.rows[0]!.id)?.sourceStepPrefix
        expect(failedPrefix?.items).toHaveLength(4)
        expect(failedPrefix?.events).toEqual(expect.arrayContaining([expect.objectContaining({ type: "tool_call.failed", status: "failed",
          errorCode: "tool_execution_failed" })]))
        const secondSourceProjection = projections.find(projection => projection.sourceWait.waitId === secondWait!.waitId
          && projection.sourceWait.claimKeyDigest === null && projection.sourceStepPrefix)
        expect(secondSourceProjection?.sourceStepPrefix?.items).toHaveLength(2)
        if (!secondSourceProjection) throw new Error("two_historical_wait_second_source_projection_missing")
        const secondClaimProjection = projections.find(projection => projection.sourceWait.waitId === secondWait!.waitId
          && projection.sourceWait.claimKeyDigest !== null)
        if (!secondClaimProjection) throw new Error("two_historical_wait_second_claim_projection_missing")
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, secondSourceProjection),
          "real PG binding accepts source identity from its top-level and nested sourceWait fields").resolves.toBe(true)
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, secondClaimProjection),
          "real PG binding accepts a claim top-level identity while separately binding its nested sourceWait").resolves.toBe(true)
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, { ...secondSourceProjection,
          callItemId: secondClaimProjection.callItemId, rawCallId: secondClaimProjection.rawCallId,
          projectedCallId: secondClaimProjection.projectedCallId }),
        "a source projection cannot borrow the continuation claim's top-level identity").resolves.toBe(false)
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, { ...secondClaimProjection,
          callItemId: secondSourceProjection.callItemId, rawCallId: secondSourceProjection.rawCallId,
          projectedCallId: secondSourceProjection.projectedCallId }),
        "a claim projection cannot substitute the historical source's top-level identity").resolves.toBe(false)
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, { ...secondClaimProjection,
          sourceWait: { ...secondClaimProjection.sourceWait, sourceCallItemId: secondClaimProjection.callItemId,
            sourceCallId: secondClaimProjection.rawCallId, projectedSourceCallId: secondClaimProjection.projectedCallId } }),
        "a claim cannot rebind the nested sourceWait to its continuation call").resolves.toBe(false)
        const earlierCompletedTool = await checkClient.query<{ sourceOrdinal: number; sourceAttempt: number; earlierOrdinal: number;
          earlierAttempt: number; callId: string; toolName: string; callStatus: string; resultStatus: string }>(
        "SELECT source.\"ordinal\" AS \"sourceOrdinal\", source.\"attempt\" AS \"sourceAttempt\", " +
          "earlier.\"ordinal\" AS \"earlierOrdinal\", earlier.\"attempt\" AS \"earlierAttempt\", " +
          "call.\"content\"->>'toolCallId' AS \"callId\", call.\"content\"->>'toolName' AS \"toolName\", " +
          "call.\"status\" AS \"callStatus\", result.\"status\" AS \"resultStatus\" " +
          "FROM \"agent_steps\" AS source " +
          "JOIN \"agent_steps\" AS earlier ON earlier.\"id\" = $5 AND earlier.\"sessionId\" = source.\"sessionId\" " +
          "AND earlier.\"turnId\" = source.\"turnId\" AND earlier.\"taskId\" = source.\"taskId\" " +
          "AND earlier.\"attempt\" = source.\"attempt\" AND earlier.\"ordinal\" < source.\"ordinal\" AND earlier.\"status\" = 'completed' " +
          "JOIN \"agent_items\" AS call ON call.\"sessionId\" = earlier.\"sessionId\" AND call.\"turnId\" = earlier.\"turnId\" " +
          "AND call.\"taskId\" = earlier.\"taskId\" AND call.\"stepId\" = earlier.\"id\" AND call.\"type\" = 'tool_call' " +
          "AND call.\"status\" = 'completed' AND call.\"revision\" = 1 AND call.\"content\"->>'toolName' = 'wait_subagents' " +
          "AND call.\"content\"->>'status' = 'completed' " +
          "JOIN \"agent_items\" AS result ON result.\"sessionId\" = call.\"sessionId\" AND result.\"turnId\" = call.\"turnId\" " +
          "AND result.\"taskId\" = call.\"taskId\" AND result.\"stepId\" = call.\"stepId\" AND result.\"type\" = 'tool_result' " +
          "AND result.\"status\" = 'completed' AND result.\"revision\" = 1 " +
          "AND result.\"content\"->>'toolCallId' = call.\"content\"->>'toolCallId' " +
          "JOIN \"agent_events\" AS resultCompleted ON resultCompleted.\"sessionId\" = result.\"sessionId\" " +
          "AND resultCompleted.\"turnId\" = result.\"turnId\" AND resultCompleted.\"taskId\" = result.\"taskId\" " +
          "AND resultCompleted.\"itemId\" = result.\"id\" AND resultCompleted.\"type\" = 'item.completed' " +
          "AND resultCompleted.\"idempotencyKey\" = 'task:' || result.\"taskId\" || ':event:tool-result-completed:' " +
          "|| (call.\"content\"->>'toolCallId') || ':' || result.\"id\" || ':1' " +
          "JOIN \"agent_events\" AS sourceStarted ON sourceStarted.\"sessionId\" = source.\"sessionId\" " +
          "AND sourceStarted.\"turnId\" = source.\"turnId\" AND sourceStarted.\"taskId\" = source.\"taskId\" " +
          "AND sourceStarted.\"correlationId\" = source.\"id\" AND sourceStarted.\"type\" = 'step.started' " +
          "AND sourceStarted.\"idempotencyKey\" = 'task:' || source.\"taskId\" || ':event:step-started:' || source.\"id\" " +
          "WHERE source.\"id\" = $1 AND source.\"sessionId\" = $2 AND source.\"turnId\" = $3 AND source.\"taskId\" = $4 " +
          "AND resultCompleted.\"sequence\" < sourceStarted.\"sequence\" LIMIT 1",
        [secondWait!.stepId, ids.sessionId, ids.turnId, ids.waiterTaskId, firstClaimStepId])
        expect(earlierCompletedTool.rows).toHaveLength(1)
        const earlierTool = earlierCompletedTool.rows[0]!
        expect(earlierTool.sourceAttempt).toBe(1)
        expect(earlierTool.earlierAttempt).toBe(earlierTool.sourceAttempt)
        expect(earlierTool.earlierOrdinal).toBeLessThan(earlierTool.sourceOrdinal)
        expect(earlierTool).toMatchObject({ toolName: "wait_subagents", callStatus: "completed", resultStatus: "completed" })
        expect(claimsBeforeRestart.find(row => row.stepId === firstClaimStepId && row.callId === earlierTool.callId))
          .toMatchObject({ startCount: 1, terminalCount: 1, resultCount: 1 })
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, secondSourceProjection),
          "final PG binding accepts the consumed second source first call despite an earlier completed tool in the same attempt").resolves.toBe(true)
        expect(JSON.stringify(projections)).not.toContain("fixture-private-failure-input")

        const firstSourceProjection = projections.find(projection => projection.sourceWait.waitId === firstWait.rows[0]!.id
          && projection.sourceWait.claimKeyDigest === null && projection.sourceStepPrefix)
        if (!firstSourceProjection?.sourceStepPrefix) throw new Error("two_historical_wait_source_prefix_missing")
        const sourcePrefixEvents = [...firstSourceProjection.sourceStepPrefix.events]
        expect(sourcePrefixEvents[5]?.type).toBe("item.started")
        expect(sourcePrefixEvents[6]?.type).toBe("tool_call.started")
        expect(sourcePrefixEvents[5]?.itemId).not.toBe(firstSourceProjection.sourceWait.sourceCallItemId)
        expect(sourcePrefixEvents[6]?.itemId).not.toBe(firstSourceProjection.sourceWait.sourceCallItemId)
        const reorderedPrefix = { ...firstSourceProjection.sourceStepPrefix, events: sourcePrefixEvents.map((event, index) =>
          index === 5 ? sourcePrefixEvents[6]! : index === 6 ? sourcePrefixEvents[5]! : event) }
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner,
          { ...firstSourceProjection, sourceStepPrefix: reorderedPrefix }),
        "final binding must reject reordered non-anchor source events without changing persisted rows or digests").resolves.toBe(false)
        const persistedAfterReorder = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(persistedAfterReorder.find(projection => projection.sourceWait.waitId === firstWait.rows[0]!.id
          && projection.sourceWait.claimKeyDigest === null)?.sourceStepPrefix?.events).toEqual(sourcePrefixEvents)

        await checkClient.query("SAVEPOINT source_step_ordinal_mismatch")
        const sourceStartOrdinal = await checkClient.query<{ stepOrdinal: number; eventOrdinal: number }>(`SELECT source."ordinal" AS "stepOrdinal",
          (started."payload"->>'ordinal')::integer AS "eventOrdinal" FROM "agent_steps" AS source
          JOIN "agent_events" AS started ON started."sessionId" = source."sessionId" AND started."turnId" = source."turnId"
            AND started."taskId" = source."taskId" AND started."correlationId" = source."id" AND started."type" = 'step.started'
            AND started."idempotencyKey" = 'task:' || source."taskId" || ':event:step-started:' || source."id"
          WHERE source."id" = $1 AND source."sessionId" = $2 AND source."turnId" = $3 AND source."taskId" = $4`,
        [firstSourceProjection.stepId, ids.sessionId, ids.turnId, ids.waiterTaskId])
        expect(sourceStartOrdinal.rows).toHaveLength(1)
        expect(sourceStartOrdinal.rows[0]?.stepOrdinal).toBe(sourceStartOrdinal.rows[0]?.eventOrdinal)
        const changedOrdinal = await checkClient.query(`UPDATE "agent_steps" SET "ordinal" = "ordinal" + 1000
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
        [firstSourceProjection.stepId, ids.sessionId, ids.turnId, ids.waiterTaskId])
        expect(changedOrdinal.rowCount).toBe(1)
        const mismatchedOrdinal = await checkClient.query<{ stepOrdinal: number; eventOrdinal: number }>(`SELECT source."ordinal" AS "stepOrdinal",
          (started."payload"->>'ordinal')::integer AS "eventOrdinal" FROM "agent_steps" AS source
          JOIN "agent_events" AS started ON started."sessionId" = source."sessionId" AND started."turnId" = source."turnId"
            AND started."taskId" = source."taskId" AND started."correlationId" = source."id" AND started."type" = 'step.started'
            AND started."idempotencyKey" = 'task:' || source."taskId" || ':event:step-started:' || source."id"
          WHERE source."id" = $1 AND source."sessionId" = $2 AND source."turnId" = $3 AND source."taskId" = $4`,
        [firstSourceProjection.stepId, ids.sessionId, ids.turnId, ids.waiterTaskId])
        expect(mismatchedOrdinal.rows).toHaveLength(1)
        expect(mismatchedOrdinal.rows[0]?.stepOrdinal).not.toBe(mismatchedOrdinal.rows[0]?.eventOrdinal)
        await expect(historicalWaitBindingAccepts(checkClient, scopedOwner, firstSourceProjection),
          "final binding must reject a source step whose database ordinal differs from step.started").resolves.toBe(false)
        await checkClient.query("ROLLBACK TO SAVEPOINT source_step_ordinal_mismatch")
        await checkClient.query("RELEASE SAVEPOINT source_step_ordinal_mismatch")

        const claimItems = await checkClient.query<{ id: string; content: Record<string, unknown> }>(`SELECT "id", "content" FROM "agent_items"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = ANY($4::text[])
            AND "type" = 'tool_call' AND "content"->>'toolName' = 'wait_subagents' ORDER BY "stepId"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, claimStepIds])
        expect(claimItems.rows).toHaveLength(2)
        const firstClaimItem = claimItems.rows.find(item => item.id.includes(`:${ids.loopCallPrefix}:${firstWait.rows[0]!.id}:`))
        const secondClaimItemId = `task:${ids.waiterTaskId}:item:tool-call:${ids.loopCallPrefix}:${secondWait!.waitId}:attempt:1`
        expect(firstClaimItem).toBeDefined()
        expect(claimItems.rows.map(item => item.id)).toContain(secondClaimItemId)

        await checkClient.query("SAVEPOINT wrong_wait_binding")
        const rewritten = await checkClient.query<{ content: Record<string, unknown> }>(`UPDATE "agent_items" AS claim
          SET "content" = jsonb_set(claim."content", '{input,idempotencyKey}', source."content"->'input'->'idempotencyKey')
          FROM "agent_items" AS source WHERE claim."id" = $1 AND claim."sessionId" = $3 AND claim."turnId" = $4 AND claim."taskId" = $5
            AND source."id" = $2 AND source."sessionId" = claim."sessionId" AND source."turnId" = claim."turnId" AND source."taskId" = claim."taskId"
          RETURNING claim."content"`, [secondClaimItemId, firstClaimItem!.id, ids.sessionId, ids.turnId, ids.waiterTaskId])
        expect(rewritten.rows).toHaveLength(1)
        const rewrittenContent = asObject(rewritten.rows[0]!.content), rewrittenCallId = rewrittenContent.toolCallId
        if (typeof rewrittenCallId !== "string") throw new Error("two_historical_wait_tampered_claim_id_missing")
        const projectedCompletion = projectWaitCallCompletionPayload({ itemId: secondClaimItemId, status: "completed", content: rewrittenContent }, secondClaimItemId)
        const completionUpdate = await checkClient.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "sessionId" = $1 AND "turnId" = $3 AND "taskId" = $4
          AND "itemId" = $5 AND "idempotencyKey" = $6 AND "type" = 'item.completed'`, [ids.sessionId, JSON.stringify(projectedCompletion), ids.turnId,
          ids.waiterTaskId, secondClaimItemId, `task:${ids.waiterTaskId}:event:tool-call-completed:${rewrittenCallId}:${secondClaimItemId}:1`])
        expect(completionUpdate.rowCount).toBe(1)
        const wrongBinding = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(wrongBinding.filter(projection => projection.sourceWait.waitId === secondWait!.waitId && projection.resultItemId)).toHaveLength(0)
        expect(wrongBinding).toHaveLength(3)
        await checkClient.query("ROLLBACK TO SAVEPOINT wrong_wait_binding")
        await checkClient.query("RELEASE SAVEPOINT wrong_wait_binding")

        await checkClient.query("SAVEPOINT duplicate_source_call")
        const secondSourceCall = await checkClient.query<{ content: Record<string, unknown> }>(`SELECT "content" FROM "agent_items"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_call'
            AND "content"->>'toolName' = 'wait_subagents'`, [ids.sessionId, ids.turnId, ids.waiterTaskId, secondWait!.stepId])
        expect(secondSourceCall.rows).toHaveLength(1)
        await checkClient.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
          `task:${ids.waiterTaskId}:item:tool-call:fixture-duplicate-source:${suffix}:attempt:1`, ids.sessionId, ids.turnId, secondWait!.stepId,
          ids.waiterTaskId, JSON.stringify({ ...secondSourceCall.rows[0]!.content, toolCallId: `fixture-duplicate-source:${suffix}` }),
        ])
        const duplicateSource = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(duplicateSource.filter(projection => projection.sourceWait.waitId === secondWait!.waitId)).toHaveLength(0)
        await checkClient.query("ROLLBACK TO SAVEPOINT duplicate_source_call")
        await checkClient.query("RELEASE SAVEPOINT duplicate_source_call")
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(false)
        const baselineProjections = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(baselineProjections).toHaveLength(4)
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(false)

        await checkClient.query("SAVEPOINT duplicate_completed_claim")
        const originalClaim = claimItems.rows.find(item => item.id === secondClaimItemId)
        if (!originalClaim) throw new Error("two_historical_wait_original_claim_missing")
        const originalCallContent = asObject(originalClaim.content)
        const originalCallId = originalCallContent.toolCallId
        if (typeof originalCallId !== "string") throw new Error("two_historical_wait_original_claim_id_missing")
        const originalResult = await checkClient.query<{ content: Record<string, unknown> }>(`SELECT "content" FROM "agent_items"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "type" = 'tool_result'
            AND "content"->>'toolCallId' = $5`, [ids.sessionId, ids.turnId, ids.waiterTaskId, secondClaimStepId, originalCallId])
        expect(originalResult.rows).toHaveLength(1)
        const duplicateCallId = `fixture-duplicate-completed-claim:${suffix}`
        const duplicateCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${duplicateCallId}:attempt:1`
        const duplicateResultItemId = `task:${ids.waiterTaskId}:item:tool-result:${duplicateCallId}:attempt:1`
        const duplicateCallContent = { ...originalCallContent, toolCallId: duplicateCallId }
        const duplicateResultContent = { ...asObject(originalResult.rows[0]!.content), toolCallId: duplicateCallId }
        await checkClient.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
          duplicateCallItemId, ids.sessionId, ids.turnId, secondClaimStepId, ids.waiterTaskId, JSON.stringify(duplicateCallContent),
        ])
        await checkClient.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
          duplicateResultItemId, ids.sessionId, ids.turnId, secondClaimStepId, ids.waiterTaskId, JSON.stringify(duplicateResultContent),
        ])
        const stepDone = await checkClient.query<{ id: string; sequence: string; causationId: string | null }>(`SELECT "id", "sequence"::text AS "sequence", "causationId"
          FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'step.completed'
            AND "idempotencyKey" = $4`, [ids.sessionId, ids.turnId, ids.waiterTaskId, `task:${ids.waiterTaskId}:event:step-completed:${secondClaimStepId}`])
        expect(stepDone.rows).toHaveLength(1)
        const modelDone = await checkClient.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{toolCallCount}', '3'::jsonb)
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4 AND "type" = 'model.completed'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, `task:${ids.waiterTaskId}:event:model-completed:${secondClaimStepId}`])
        expect(modelDone.rowCount).toBe(1)
        const sequenceOffset = await checkClient.query<{ value: string }>(`SELECT (GREATEST(session."eventSequence", COALESCE(MAX(event."sequence"), 0)) + 100)::text AS "value"
          FROM "agent_sessions" AS session LEFT JOIN "agent_events" AS event ON event."sessionId" = session."id"
          WHERE session."id" = $1 GROUP BY session."id", session."eventSequence"`, [ids.sessionId])
        expect(sequenceOffset.rows).toHaveLength(1)
        const doneSequence = BigInt(stepDone.rows[0]!.sequence), offset = BigInt(sequenceOffset.rows[0]!.value)
        await checkClient.query(`UPDATE "agent_events" SET "sequence" = "sequence" + $3::bigint WHERE "sessionId" = $1 AND "sequence" >= $2::bigint`,
          [ids.sessionId, doneSequence.toString(), offset.toString()])
        await checkClient.query(`UPDATE "agent_events" SET "sequence" = "sequence" - $3::bigint + 6 WHERE "sessionId" = $1 AND "sequence" >= $2::bigint`,
          [ids.sessionId, (doneSequence + offset).toString(), offset.toString()])
        let causationId = stepDone.rows[0]!.causationId
        if (!causationId) throw new Error("two_historical_wait_step_done_causation_missing")
        const duplicateEvents = [
          { itemId: duplicateCallItemId, type: "item.started", correlationId: secondClaimStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${duplicateCallItemId}`,
            payload: { itemId: duplicateCallItemId, type: "tool_call", phase: null } },
          { itemId: duplicateCallItemId, type: "tool_call.started", correlationId: duplicateCallId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-started:${duplicateCallId}`,
            payload: { toolCallId: duplicateCallId, toolName: "wait_subagents", taskId: ids.waiterTaskId } },
          { itemId: duplicateCallItemId, type: "item.completed", correlationId: duplicateCallItemId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-call-completed:${duplicateCallId}:${duplicateCallItemId}:1`,
            payload: projectWaitCallCompletionPayload({ itemId: duplicateCallItemId, status: "completed", content: duplicateCallContent }, duplicateCallItemId) },
          { itemId: duplicateCallItemId, type: "tool_call.completed", correlationId: duplicateCallId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-finished:${duplicateCallId}`,
            payload: { toolCallId: duplicateCallId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: ids.waiterTaskId } },
          { itemId: duplicateResultItemId, type: "item.started", correlationId: secondClaimStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${duplicateResultItemId}`,
            payload: { itemId: duplicateResultItemId, type: "tool_result", phase: null } },
          { itemId: duplicateResultItemId, type: "item.completed", correlationId: duplicateResultItemId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-result-completed:${duplicateCallId}:${duplicateResultItemId}:1`,
            payload: { itemId: duplicateResultItemId, status: "completed", content: duplicateResultContent } },
        ]
        for (const [index, event] of duplicateEvents.entries()) {
          const eventId = `fixture-duplicate-claim-event:${suffix}:${index}`
          await checkClient.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'subagent', $8, $9, $10, $11::jsonb)`, [
            eventId, ids.sessionId, ids.turnId, event.itemId, ids.waiterTaskId, (doneSequence + BigInt(index)).toString(),
            event.type, event.correlationId, causationId, event.idempotencyKey, JSON.stringify(event.payload),
          ])
          causationId = eventId
        }
        const movedStepDone = await checkClient.query(`UPDATE "agent_events" SET "causationId" = $2, "payload" = jsonb_set("payload", '{toolCallCount}', '3'::jsonb)
          WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'step.completed'`,
        [stepDone.rows[0]!.id, causationId, ids.sessionId, ids.turnId, ids.waiterTaskId])
        expect(movedStepDone.rowCount).toBe(1)
        const duplicateCompletedLifecycle = await checkClient.query<{ status: string; revision: number; type: string }>(`SELECT call."status", call."revision", 'tool_call' AS "type"
          FROM "agent_items" AS call WHERE call."id" = $1 AND call."sessionId" = $2 AND call."turnId" = $3 AND call."taskId" = $4
          UNION ALL SELECT result."status", result."revision", 'tool_result' AS "type" FROM "agent_items" AS result
          WHERE result."id" = $5 AND result."sessionId" = $2 AND result."turnId" = $3 AND result."taskId" = $4`,
        [duplicateCallItemId, ids.sessionId, ids.turnId, ids.waiterTaskId, duplicateResultItemId])
        expect(duplicateCompletedLifecycle.rows).toEqual([
          { status: "completed", revision: 1, type: "tool_call" }, { status: "completed", revision: 1, type: "tool_result" },
        ])
        const duplicateEventTypes = await checkClient.query<{ type: string; count: number }>(`SELECT "type", COUNT(*)::int AS "count" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = ANY($4::text[]) GROUP BY "type" ORDER BY "type"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, duplicateEvents.map(event => event.idempotencyKey)])
        expect(duplicateEventTypes.rows).toEqual([
          { type: "item.completed", count: 2 }, { type: "item.started", count: 2 },
          { type: "tool_call.completed", count: 1 }, { type: "tool_call.started", count: 1 },
        ])
        const blockedProjections = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(blockedProjections.filter(projection => projection.sourceWait.waitId === secondWait!.waitId)).toHaveLength(1)
        expect(blockedProjections.filter(projection => projection.sourceWait.waitId === firstWait.rows[0]!.id)).toHaveLength(2)
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(true)
        await checkClient.query("ROLLBACK TO SAVEPOINT duplicate_completed_claim")
        await checkClient.query("RELEASE SAVEPOINT duplicate_completed_claim")
        expect(await readChildWaitTerminalCallProjections(checkClient, scopedOwner)).toHaveLength(4)
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(false)
        const canonicalBaseline = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(canonicalBaseline).toHaveLength(4)
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(false)
        await checkClient.query("SAVEPOINT canonical_duplicate_claim")
        const claimInput = asObject(originalCallContent.input)
        const claimInputKey = claimInput.idempotencyKey
        if (typeof claimInputKey !== "string") throw new Error("two_historical_wait_claim_input_key_missing")
        const claimKeyDigest = createHash("sha256").update(claimInputKey).digest("hex")
        const canonicalDuplicateStepId = `task:${ids.waiterTaskId}:step:canonical-duplicate-claim:${suffix}:attempt:1`
        const nextOrdinal = await checkClient.query<{ ordinal: number }>(`SELECT (COALESCE(MAX("ordinal"), -1) + 1)::int AS "ordinal"
          FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2`, [ids.sessionId, ids.turnId])
        expect(nextOrdinal.rows).toHaveLength(1)
        const canonicalDuplicateOrdinal = nextOrdinal.rows[0]!.ordinal
        expect(canonicalDuplicateOrdinal).toBeGreaterThan(secondClaimOrdinal)
        const insertedStep = await checkClient.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status",
            "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt", "completedAt", "finishReason", "errorCode", "inputTokens", "outputTokens", "estimatedCostUsd")
          VALUES ($1, $2, $3, $4, $5, 1, 'completed', 0, '[]'::jsonb, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'tool_calls', NULL, 0, 0, 0)`,
        [canonicalDuplicateStepId, ids.sessionId, ids.turnId, ids.waiterTaskId, canonicalDuplicateOrdinal, JSON.stringify(LOOP_FIXTURE_MODEL_PROFILE_SNAPSHOT)])
        expect(insertedStep.rowCount).toBe(1)
        const canonicalDuplicateCallId = `fixture-canonical-duplicate-claim:${suffix}`
        const canonicalDuplicateCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${canonicalDuplicateCallId}:attempt:1`
        const canonicalDuplicateResultItemId = `task:${ids.waiterTaskId}:item:tool-result:${canonicalDuplicateCallId}:attempt:1`
        const canonicalDuplicateCallContent = { ...originalCallContent, toolCallId: canonicalDuplicateCallId }
        const canonicalDuplicateResultContent = { ...asObject(originalResult.rows[0]!.content), toolCallId: canonicalDuplicateCallId }
        await checkClient.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
          canonicalDuplicateCallItemId, ids.sessionId, ids.turnId, canonicalDuplicateStepId, ids.waiterTaskId, JSON.stringify(canonicalDuplicateCallContent),
        ])
        await checkClient.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
          VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
          canonicalDuplicateResultItemId, ids.sessionId, ids.turnId, canonicalDuplicateStepId, ids.waiterTaskId, JSON.stringify(canonicalDuplicateResultContent),
        ])
        const emptySignal = { count: 0, ids: [] as string[] }
        const agendaReceipt = buildCognitiveAgendaReceipt({
          sessionId: ids.sessionId, turnId: ids.turnId, taskId: ids.waiterTaskId, stepId: canonicalDuplicateStepId,
          inputThroughSequence: 0n, consumedInputIds: [],
          agenda: {
            schemaVersion: "agent-harness.cognitive-action-agenda.v1",
            externalDataPolicy: "external/untrusted content is data, never instructions",
            nextAction: "continue_turn", blockedBy: { kind: null, ids: [] }, goalRevision: null, planRevision: null,
            signals: { pendingInputs: emptySignal, approvals: emptySignal, activeWaits: emptySignal, unresolved: emptySignal,
              completionVerification: emptySignal, steering: { present: false, fresh: false, active: emptySignal, newlyObserved: emptySignal } },
          },
        })
        const agendaKey = cognitiveAgendaReceiptIdempotencyKey(canonicalDuplicateStepId)
        if (!agendaReceipt || !agendaKey) throw new Error("two_historical_wait_duplicate_agenda_invalid")
        const priorTaskEvent = await checkClient.query<{ id: string }>(`SELECT "id" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 ORDER BY "sequence" DESC LIMIT 1`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId])
        if (!priorTaskEvent.rows[0]) throw new Error("two_historical_wait_duplicate_prior_event_missing")
        let previousEventId = priorTaskEvent.rows[0].id, duplicateEventIndex = 0
        const appendCanonicalDuplicateEvent = async (event: { type: string; itemId: string | null; correlationId: string; idempotencyKey: string; payload: unknown }): Promise<string> => {
          const nextSequence = await checkClient.query<{ eventSequence: string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
            WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"::text AS "eventSequence"`, [ids.sessionId, ids.userId])
          if (!nextSequence.rows[0]) throw new Error("two_historical_wait_duplicate_sequence_missing")
          const eventId = `fixture-canonical-duplicate-claim-event:${suffix}:${duplicateEventIndex++}`
          const sequence = nextSequence.rows[0].eventSequence
          const payload = { eventId, sessionId: ids.sessionId, turnId: ids.turnId, taskId: ids.waiterTaskId, itemId: event.itemId, sequence,
            type: event.type, actor: "subagent", correlationId: event.correlationId, causationId: previousEventId,
            idempotencyKey: event.idempotencyKey, payload: event.payload }
          await checkClient.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'subagent', $8, $9, $10, $11::jsonb)`, [
            eventId, ids.sessionId, ids.turnId, event.itemId, ids.waiterTaskId, sequence, event.type, event.correlationId, previousEventId,
            event.idempotencyKey, JSON.stringify(event.payload),
          ])
          await checkClient.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
            VALUES ($1, 'agent.events', $2, $3, $4::jsonb)`, [
            `agent-outbox-${eventId}`, ids.sessionId, `agent-event:${eventId}`, JSON.stringify(payload),
          ])
          previousEventId = eventId
          return eventId
        }
        const modelProvider = "fixture", modelName = "durable-child-wait-fixture"
        const agendaEventKey = `task:${ids.waiterTaskId}:event:${agendaKey}`
        const canonicalDuplicateEvents = [
          { type: "step.started", itemId: null, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:step-started:${canonicalDuplicateStepId}`,
            payload: { stepId: canonicalDuplicateStepId, ordinal: canonicalDuplicateOrdinal, taskId: ids.waiterTaskId } },
          { type: "cognitive.agenda", itemId: null, correlationId: canonicalDuplicateStepId, idempotencyKey: agendaEventKey, payload: agendaReceipt },
          { type: "model.started", itemId: null, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:model-started:${canonicalDuplicateStepId}`,
            payload: { taskId: ids.waiterTaskId, provider: modelProvider, model: modelName } },
          { type: "model.completed", itemId: null, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:model-completed:${canonicalDuplicateStepId}`,
            payload: { taskId: ids.waiterTaskId, provider: modelProvider, model: modelName, toolCallCount: 1 } },
          { type: "model.usage", itemId: null, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:model-usage:${canonicalDuplicateStepId}`,
            payload: { taskId: ids.waiterTaskId, provider: modelProvider, model: modelName, usage: { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 } } },
          { type: "item.started", itemId: canonicalDuplicateCallItemId, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${canonicalDuplicateCallItemId}`,
            payload: { itemId: canonicalDuplicateCallItemId, type: "tool_call", phase: null } },
          { type: "tool_call.started", itemId: canonicalDuplicateCallItemId, correlationId: canonicalDuplicateCallId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:child-wait-claim:1:${canonicalDuplicateStepId}`,
            payload: { toolCallId: canonicalDuplicateCallId, toolName: "wait_subagents", taskId: ids.waiterTaskId } },
          { type: "item.completed", itemId: canonicalDuplicateCallItemId, correlationId: canonicalDuplicateCallItemId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-call-completed:${canonicalDuplicateCallId}:${canonicalDuplicateCallItemId}:1`,
            payload: projectWaitCallCompletionPayload({ itemId: canonicalDuplicateCallItemId, status: "completed", content: canonicalDuplicateCallContent }, canonicalDuplicateCallItemId) },
          { type: "tool_call.completed", itemId: canonicalDuplicateCallItemId, correlationId: canonicalDuplicateCallId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-finished:${canonicalDuplicateCallId}`,
            payload: { toolCallId: canonicalDuplicateCallId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: ids.waiterTaskId } },
          { type: "item.started", itemId: canonicalDuplicateResultItemId, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${canonicalDuplicateResultItemId}`,
            payload: { itemId: canonicalDuplicateResultItemId, type: "tool_result", phase: null } },
          { type: "item.completed", itemId: canonicalDuplicateResultItemId, correlationId: canonicalDuplicateResultItemId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:tool-result-completed:${canonicalDuplicateCallId}:${canonicalDuplicateResultItemId}:1`,
            payload: { itemId: canonicalDuplicateResultItemId, status: "completed", content: canonicalDuplicateResultContent } },
          { type: "step.completed", itemId: null, correlationId: canonicalDuplicateStepId,
            idempotencyKey: `task:${ids.waiterTaskId}:event:step-completed:${canonicalDuplicateStepId}`,
            payload: { stepId: canonicalDuplicateStepId, status: "completed", toolCallCount: 1, taskId: ids.waiterTaskId } },
        ]
        for (const event of canonicalDuplicateEvents) await appendCanonicalDuplicateEvent(event)
        const canonicalDuplicateChain = await readCanonicalWaitStepToolChain(checkClient, {
          id: ids.waiterTaskId, sessionId: ids.sessionId, turnId: ids.turnId,
        }, { stepId: canonicalDuplicateStepId, attempt: 1, callItemId: canonicalDuplicateCallItemId,
          callId: canonicalDuplicateCallId, resultItemId: canonicalDuplicateResultItemId })
        expect(canonicalDuplicateChain).not.toBeNull()
        expect(canonicalDuplicateChain).toMatchObject({ stepId: canonicalDuplicateStepId, attempt: 1,
          waitCallItemId: canonicalDuplicateCallItemId, waitCallId: canonicalDuplicateCallId, waitResultItemId: canonicalDuplicateResultItemId })
        expect(canonicalDuplicateChain?.calls).toHaveLength(1)
        const duplicateClaimCount = await checkClient.query<{ count: number; stepCount: number }>(`SELECT COUNT(*)::int AS "count", COUNT(DISTINCT call."stepId")::int AS "stepCount" FROM "agent_items" AS call
          JOIN "agent_steps" AS step ON step."id" = call."stepId" AND step."sessionId" = call."sessionId" AND step."turnId" = call."turnId" AND step."taskId" = call."taskId"
          WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3 AND step."attempt" = $4
            AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
            AND encode(sha256(convert_to(call."content"->'input'->>'idempotencyKey', 'UTF8')), 'hex') = $5`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, owner.attemptCount, claimKeyDigest])
        expect(duplicateClaimCount.rows).toEqual([{ count: 2, stepCount: 2 }])
        const validProofsBeforeSql = await readChildWaitTerminalCallProjections(checkClient, scopedOwner)
        expect(validProofsBeforeSql).toHaveLength(4)
        expect(validProofsBeforeSql.find(projection => projection.sourceWait.waitId === secondWait!.waitId && projection.resultItemId)
          ?.sourceWait.claimKeyDigest).toBe(claimKeyDigest)
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(true)
        await checkClient.query("ROLLBACK TO SAVEPOINT canonical_duplicate_claim")
        await checkClient.query("RELEASE SAVEPOINT canonical_duplicate_claim")
        expect(await readChildWaitTerminalCallProjections(checkClient, scopedOwner)).toHaveLength(4)
        await expect(hasBlockingExternalCall(checkClient, scopedOwner, undefined, secondClaimStepId)).resolves.toBe(false)
        await checkClient.query("COMMIT")
      } catch (error) {
        await checkClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { checkClient.release() }

      await stopWorker(workerC)
      expect(await workerC.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const currentLease = await pool.query<{ leaseOwner: string | null }>(`SELECT "leaseOwner" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1`, [ids.waiterTaskId, ids.sessionId])
      const oldOwner = currentLease.rows[0]?.leaseOwner
      expect(oldOwner).toEqual(expect.any(String))
      expect((await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, oldOwner])).rowCount).toBe(1)

      workerD = launchWorker("worker-b-loop-final", queueName, ids)
      await waitForMarker(workerD, "WORKER_B_RECOVERED")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      await queueRedis.set(workerStartGateKey(ids), "start", "EX", 60)
      await waitForMarker(workerD, "WORKER_B_LOOP_RESTORED")
      await waitForMarker(workerD, "WORKER_B_LOOP_RESUMED")
      const finalMarker = workerD.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_RESUMED "))
      expect(finalMarker ? JSON.parse(finalMarker.slice("WORKER_B_LOOP_RESUMED ".length)) : null).toMatchObject({
        phase: "final", status: "completed", finalText: FINAL_MARKER, executorCalls: 0, dispatcherCalls: 0,
      })
      expect(await readClaimLifecycle()).toEqual(claimsBeforeRestart)
      expect((await pool.query<{ status: string; attemptCount: number; leaseOwner: string | null }>(
        `SELECT "status", "attemptCount", "leaseOwner" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [ids.waiterTaskId, ids.sessionId])).rows[0]).toMatchObject({ status: "completed", attemptCount: 1, leaseOwner: null })
      expect(await workerD.exited).toMatchObject({ code: 0, signal: null })
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
      try { await pool.query(`DELETE FROM "agent_sessions" WHERE "id" = $1`, [ids.sessionId]) } catch { /* preserve the original failure */ }
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId]) } catch { /* preserve the original failure */ }
      await queueRedis.quit().catch(() => queueRedis.disconnect())
    }
  }, 90_000)

  it("rejects reordered nested prefix events for a recovered wait with a real prior noop", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = { userId: `durable-child-wait-prior-crash-user-${suffix}`,
      sessionId: `durable-child-wait-prior-crash-session-${suffix}`, turnId: `durable-child-wait-prior-crash-turn-${suffix}`,
      rootTaskId: "", waiterTaskId: "", targetTaskId: "", sourcePriorTool: true }
    const queueName = `agent-child-wait-prior-crash-${suffix}`
    const queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    const queue = new Queue(queueName, { connection: queueRedis, skipVersionCheck: true })
    const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
    const taskStore = new PgSubagentTaskStore(pool, 30_000)
    let workerA: WorkerProcess | undefined, workerB: WorkerProcess | undefined, workerC: WorkerProcess | undefined
    let queuePaused = false
    const originalRedisUrl = process.env.REDIS_URL
    let closeSharedRedisConnections: (() => Promise<void>) | undefined
    const pauseQueue = async () => { if (!queuePaused) { await queue.pause(); queuePaused = true } }
    const dispatchRecovery = async () => {
      const pending = await waitFor(async () => {
        const row = await pool.query<{ status: string; publishedAt: Date | null }>(`SELECT task."status", dispatch."publishedAt"
          FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
            AND dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
          WHERE task."id" = $1 AND task."sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
        return row.rows[0]?.status === "queued" && row.rows[0]?.publishedAt === null ? row.rows[0] : null
      })
      const { dispatchPendingSubagentOutbox } = await import("../../queue/subagent-queue.js")
      await expect(dispatchPendingSubagentOutbox(pool as never, queue, 50, ids.sessionId)).resolves.toBe(1)
      expect(pending.status).toBe("queued")
      await queue.resume()
      queuePaused = false
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
      const sourceStepId = `task:${ids.waiterTaskId}:step:0:attempt:1`
      const noopCallId = "fixture-noop-before-child-wait"
      const noopCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${noopCallId}:attempt:1`
      const noopResultItemId = `task:${ids.waiterTaskId}:item:tool-result:${noopCallId}:attempt:1`
      const noopItems = await pool.query<{ id: string; type: string; status: string; revision: number }>(`SELECT "id", "type", "status", "revision"
        FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4
          AND (("type" = 'tool_call' AND "content"->>'toolName' = 'fixture_noop')
            OR ("type" = 'tool_result' AND "content"->>'toolCallId' = $5)) ORDER BY "type"`,
      [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, noopCallId])
      expect(noopItems.rows).toEqual([
        { id: noopResultItemId, type: "tool_result", status: "completed", revision: 1 },
        { id: noopCallItemId, type: "tool_call", status: "completed", revision: 1 },
      ].sort((left, right) => left.type.localeCompare(right.type)))
      const noopEvents = await pool.query<{ id: string; sequence: string; type: string; itemId: string | null; causationId: string | null }>(
        `SELECT "id", event."sequence"::text AS "sequence", "type", "itemId", "causationId" FROM "agent_events" AS event
         WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3
           AND (event."itemId" IN ($4, $5) OR event."correlationId" = $6)
         ORDER BY event."sequence"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, noopCallItemId, noopResultItemId, noopCallId])
      expect(noopEvents.rows.map(event => event.type)).toEqual([
        "item.started", "tool_call.started", "item.completed", "tool_call.completed", "item.started", "item.completed",
      ])
      expect(noopEvents.rows.slice(1).map(event => event.causationId)).toEqual(noopEvents.rows.slice(0, -1).map(event => event.id))
      const waitingSource = await readSourceWaitLifecycle(pool, ids)
      expect(waitingSource.call).toMatchObject({ status: "started", revision: 0 })
      expect(waitingSource.results).toHaveLength(0)
      expect(waitingSource.events[0]?.causationId).toBe(noopEvents.rows[5]?.id)
      expect(workerA.stdoutText + workerA.stderrText).not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))
      await stopWorker(workerA)
      expect(await workerA.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const ownerA = await pool.query<{ leaseOwner: string | null }>(`SELECT "leaseOwner" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
      expect(ownerA.rows[0]?.leaseOwner).toEqual(expect.any(String))
      expect((await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, ownerA.rows[0]!.leaseOwner])).rowCount).toBe(1)

      await pauseQueue()
      workerB = launchWorker("worker-b-legacy-consumed-seed", queueName, ids)
      await waitForMarker(workerB, "WORKER_B_RECOVERED")
      expect((await pool.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.waiterTaskId, ids.sessionId])).rows[0]?.status).toBe("waiting")
      await finishLoopWaitTarget(pool, taskStore, ids, policy)
      await reconcileDurableSubagentWaits(pool)
      await dispatchRecovery()
      await waitForMarker(workerB, "WORKER_B_LEGACY_CONSUMED_CLAIMED")
      await stopWorker(workerB)
      expect(await workerB.exited).toMatchObject({ code: null, signal: "SIGKILL" })
      const beforeRepair = await readSourceWaitLifecycle(pool, ids)
      expect(beforeRepair.wait?.consumedAt).toEqual(expect.any(Date))
      expect(beforeRepair.wait?.result).not.toHaveProperty("sourceLifecycleRecovery")
      expect(beforeRepair.call).toMatchObject({ status: "started", revision: 0 })
      expect(beforeRepair.results).toHaveLength(0)
      const ownerB = await pool.query<{ leaseOwner: string | null }>(`SELECT "leaseOwner" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2`, [ids.waiterTaskId, ids.sessionId])
      expect((await pool.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - interval '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' AND "attemptCount" = 1 AND "leaseOwner" = $3 RETURNING "id"`,
      [ids.waiterTaskId, ids.sessionId, ownerB.rows[0]?.leaseOwner])).rowCount).toBe(1)

      await pauseQueue()
      workerC = launchWorker("worker-b-legacy-consumed-recovery", queueName, ids)
      await waitForMarker(workerC, "WORKER_B_RECOVERED")
      await dispatchRecovery()
      await waitForMarker(workerC, "WORKER_B_LEGACY_SOURCE_REPAIRED")
      const repairLine = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LEGACY_SOURCE_REPAIRED "))
      expect(repairLine).toBeDefined()
      expect(JSON.parse(repairLine!.slice("WORKER_B_LEGACY_SOURCE_REPAIRED ".length))).toMatchObject({
        sourceStepId, sourceAttempt: 1, currentAttempt: 1, repeatedRepairCount: 0,
      })
      await waitForMarker(workerC, "WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT")
      const claimCutLine = workerC.stdoutText.split(/\r?\n/).find(line => line.startsWith("WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT "))
      expect(JSON.parse(claimCutLine!.slice("WORKER_B_LOOP_CLAIM_ITEM_COMPLETED_BEFORE_EVENT ".length))).toMatchObject({
        modelCalls: expect.any(Number), executorCalls: expect.any(Number), priorNoopExecutorCalls: 0, dispatcherCalls: 0,
      })
      const repaired = await readSourceWaitLifecycle(pool, ids)
      expectReconciledSourceWait(repaired, ids)
      expect(workerB.stdoutText + workerB.stderrText + workerC.stdoutText + workerC.stderrText)
        .not.toContain(SOURCE_WAIT_SECRET_IDEMPOTENCY_KEY(ids.waiterTaskId))

      const current = await pool.query<BlockingTaskRow>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId",
          task."leaseOwner", task."attemptCount", task."leaseExpiresAt" FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $3
        WHERE task."id" = $1 AND task."sessionId" = $2 AND task."status" = 'running'`, [ids.waiterTaskId, ids.sessionId, ids.userId])
      expect(current.rows).toHaveLength(1)
      const row = current.rows[0]
      if (!row?.leaseOwner || !row.leaseExpiresAt) throw new Error("prior-tool recovered source live owner missing")
      const snapshot: BlockingTaskSnapshot = { ...row, userId: ids.userId }
      const checkClient = await pool.connect()
      try {
        await checkClient.query("BEGIN")
        await checkClient.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        expect((await checkClient.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
          [ids.sessionId, ids.userId])).rows).toHaveLength(1)
        const projections = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
        const sourceWaitId = repaired.wait?.id
        const handoffSource = projections.find(projection => projection.sourceWait.waitId === sourceWaitId
          && projection.sourceWait.claimKeyDigest === null)
        expect(handoffSource?.sourceStepHandoff?.schemaVersion).toBe("recovered_wait_handoff.v1")
        expect(handoffSource?.sourceStepHandoff?.sourceStepPrefix.items).toHaveLength(4)
        if (!handoffSource?.sourceStepHandoff) throw new Error("prior-tool recovered handoff projection missing")
        const fullEvents = [...handoffSource.sourceStepHandoff.sourceStepPrefix.events]
        const noopStartedIndex = fullEvents.findIndex(event => event.idempotencyKey === `task:${ids.waiterTaskId}:event:item-started:${noopCallItemId}`)
        const noopCallStartedIndex = fullEvents.findIndex(event => event.idempotencyKey === `task:${ids.waiterTaskId}:event:tool-started:${noopCallId}`)
        expect(noopStartedIndex).toBe(5)
        expect(noopCallStartedIndex).toBe(6)
        expect(fullEvents.findIndex(event => event.idempotencyKey === `task:${ids.waiterTaskId}:event:tool-started:${PHONE_SHAPED_WAIT_TOOL_CALL_ID}`))
          .toBeGreaterThan(noopCallStartedIndex)
        const anchorIds = new Set(handoffSource.sourceStepHandoff.events.map(event => event.id))
        expect(anchorIds.has(fullEvents[noopStartedIndex]!.id)).toBe(false)
        expect(anchorIds.has(fullEvents[noopCallStartedIndex]!.id)).toBe(false)
        await expect(historicalWaitBindingAccepts(checkClient, snapshot, handoffSource),
          "the exact recovered handoff with a prior noop must bind").resolves.toBe(true)

        const priorToolCounts = await checkClient.query<{ requestedCount: number; callCount: number; resultCount: number; itemCount: number }>(`SELECT
            (SELECT ("payload"->>'toolCallCount')::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
              AND "taskId" = $3 AND "idempotencyKey" = $5) AS "requestedCount",
            (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "stepId" = $4 AND "type" = 'tool_call') AS "callCount",
            (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "stepId" = $4 AND "type" = 'tool_result') AS "resultCount",
            (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "stepId" = $4) AS "itemCount"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, `task:${ids.waiterTaskId}:event:model-completed:${sourceStepId}`])
        expect(priorToolCounts.rows[0]).toEqual({ requestedCount: 2, callCount: 2, resultCount: 2, itemCount: 4 })

        await checkClient.query("SAVEPOINT recovered_source_orphan_noop_items")
        try {
          const removedNoopItems = await checkClient.query<{ id: string }>(`DELETE FROM "agent_items"
            WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "id" = ANY($5::text[])
            RETURNING "id"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, [noopCallItemId, noopResultItemId]])
          expect(removedNoopItems.rows.map(item => item.id).sort()).toEqual([noopCallItemId, noopResultItemId].sort())

          const orphanEventIds = noopEvents.rows.map(event => event.id)
          const orphanRows = await checkClient.query<{ id: string; type: string; itemId: string | null }>(`SELECT "id", "type", "itemId"
            FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "sequence" BETWEEN $4::bigint AND $5::bigint AND "id" = ANY($6::text[]) ORDER BY "sequence"`,
          [ids.sessionId, ids.turnId, ids.waiterTaskId, fullEvents[0]!.sequence, fullEvents.at(-1)!.sequence, orphanEventIds])
          expect(orphanRows.rows).toEqual(noopEvents.rows.map(event => ({ id: event.id, type: event.type, itemId: null })))
          const reducedCounts = await checkClient.query<{ requestedCount: number; callCount: number; resultCount: number; itemCount: number }>(`SELECT
              (SELECT ("payload"->>'toolCallCount')::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
                AND "taskId" = $3 AND "idempotencyKey" = $5) AS "requestedCount",
              (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                AND "stepId" = $4 AND "type" = 'tool_call') AS "callCount",
              (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                AND "stepId" = $4 AND "type" = 'tool_result') AS "resultCount",
              (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                AND "stepId" = $4) AS "itemCount"`,
          [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, `task:${ids.waiterTaskId}:event:model-completed:${sourceStepId}`])
          expect(reducedCounts.rows[0]).toEqual({ requestedCount: 2, callCount: 1, resultCount: 1, itemCount: 2 })

          const afterNoopItemRemoval = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
          expect(afterNoopItemRemoval.filter(projection => projection.sourceWait.waitId === sourceWaitId
            && projection.sourceWait.claimKeyDigest === null)).toHaveLength(0)

          const orphanedProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
          const orphanedHandoff = asObject(orphanedProjection.sourceStepHandoff)
          const orphanedPrefix = asObject(orphanedHandoff.sourceStepPrefix)
          const removedIds = new Set([noopCallItemId, noopResultItemId])
          const projectedItems = Array.isArray(orphanedPrefix.items) ? orphanedPrefix.items : []
          expect(projectedItems.filter(item => removedIds.has(String(asObject(item).id))).map(item => String(asObject(item).id)).sort())
            .toEqual([noopCallItemId, noopResultItemId].sort())
          const projectedEvents = Array.isArray(orphanedPrefix.events) ? orphanedPrefix.events : []
          const orphanedEventIds = new Set(orphanEventIds)
          const orphanedEvents = projectedEvents.map(event => {
            const value = asObject(event)
            return orphanedEventIds.has(String(value.id)) ? { ...value, itemId: null } : event
          })
          expect(orphanedEvents.filter(event => orphanedEventIds.has(String(asObject(event).id))
            && asObject(event).itemId === null)).toHaveLength(6)
          orphanedProjection.sourceStepHandoff = { ...orphanedHandoff, sourceStepPrefix: {
            ...orphanedPrefix, items: projectedItems.filter(item => !removedIds.has(String(asObject(item).id))), events: orphanedEvents,
          } }
          await expect(historicalWaitBindingAccepts(checkClient, snapshot, orphanedProjection),
            "the final binding must reject orphaned noop call events when their items are absent").resolves.toBe(false)
        } finally {
          await checkClient.query("ROLLBACK TO SAVEPOINT recovered_source_orphan_noop_items")
          await checkClient.query("RELEASE SAVEPOINT recovered_source_orphan_noop_items")
        }

        const restoredNoopItems = await checkClient.query<{ id: string }>(`SELECT "id" FROM "agent_items"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "id" = ANY($5::text[])
          ORDER BY "id"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, [noopCallItemId, noopResultItemId]])
        expect(restoredNoopItems.rows.map(item => item.id)).toEqual([noopCallItemId, noopResultItemId].sort())
        const restoredOrphanEventRows = await checkClient.query<{ id: string; type: string; itemId: string | null }>(`SELECT "id", "type", "itemId"
          FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])
          ORDER BY "sequence"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, noopEvents.rows.map(event => event.id)])
        expect(restoredOrphanEventRows.rows).toEqual(noopEvents.rows.map(event => ({ id: event.id, type: event.type, itemId: event.itemId })))
        const restoredProjections = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
        const restoredHandoff = restoredProjections.find(projection => projection.sourceWait.waitId === sourceWaitId
          && projection.sourceWait.claimKeyDigest === null)
        expect(restoredHandoff?.sourceStepHandoff?.sourceStepPrefix.items).toEqual(handoffSource.sourceStepHandoff.sourceStepPrefix.items)
        expect(restoredHandoff?.sourceStepHandoff?.sourceStepPrefix.events).toEqual(fullEvents)
        await expect(historicalWaitBindingAccepts(checkClient, snapshot, handoffSource),
          "the original handoff must bind again after rollback restores its items").resolves.toBe(true)

        const noopResultEvents = noopEvents.rows.filter(event => event.itemId === noopResultItemId)
        expect(noopResultEvents.map(event => event.type)).toEqual(["item.started", "item.completed"])
        await checkClient.query("SAVEPOINT recovered_source_orphan_noop_result")
        try {
          const removedNoopResult = await checkClient.query<{ id: string }>(`DELETE FROM "agent_items"
            WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "id" = $5
            RETURNING "id"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, noopResultItemId])
          expect(removedNoopResult.rows).toEqual([{ id: noopResultItemId }])
          const resultOnlyCounts = await checkClient.query<{ requestedCount: number; callCount: number; resultCount: number; itemCount: number }>(`SELECT
              (SELECT ("payload"->>'toolCallCount')::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
                AND "taskId" = $3 AND "idempotencyKey" = $5) AS "requestedCount",
              (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                AND "stepId" = $4 AND "type" = 'tool_call') AS "callCount",
              (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                AND "stepId" = $4 AND "type" = 'tool_result') AS "resultCount",
              (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                AND "stepId" = $4) AS "itemCount"`,
          [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, `task:${ids.waiterTaskId}:event:model-completed:${sourceStepId}`])
          expect(resultOnlyCounts.rows[0]).toEqual({ requestedCount: 2, callCount: 2, resultCount: 1, itemCount: 3 })
          const orphanResultEventIds = noopResultEvents.map(event => event.id)
          const orphanResultRows = await checkClient.query<{ id: string; type: string; itemId: string | null }>(`SELECT "id", "type", "itemId"
            FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])
            ORDER BY "sequence"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, orphanResultEventIds])
          expect(orphanResultRows.rows).toEqual(noopResultEvents.map(event => ({ id: event.id, type: event.type, itemId: null })))

          const afterResultItemRemoval = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
          expect(afterResultItemRemoval.filter(projection => projection.sourceWait.waitId === sourceWaitId
            && projection.sourceWait.claimKeyDigest === null)).toHaveLength(0)

          const orphanedResultProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
          const orphanedResultHandoff = asObject(orphanedResultProjection.sourceStepHandoff)
          const orphanedResultPrefix = asObject(orphanedResultHandoff.sourceStepPrefix)
          const resultOnlyItems = Array.isArray(orphanedResultPrefix.items) ? orphanedResultPrefix.items : []
          expect(resultOnlyItems.filter(item => asObject(item).id === noopResultItemId)).toHaveLength(1)
          const resultOnlyEvents = Array.isArray(orphanedResultPrefix.events) ? orphanedResultPrefix.events : []
          const orphanedResultEventIdSet = new Set(orphanResultEventIds)
          const nullItemResultEvents = resultOnlyEvents.map(event => {
            const value = asObject(event)
            return orphanedResultEventIdSet.has(String(value.id)) ? { ...value, itemId: null } : event
          })
          expect(nullItemResultEvents.filter(event => orphanedResultEventIdSet.has(String(asObject(event).id))
            && asObject(event).itemId === null)).toHaveLength(2)
          orphanedResultProjection.sourceStepHandoff = { ...orphanedResultHandoff, sourceStepPrefix: {
            ...orphanedResultPrefix,
            items: resultOnlyItems.filter(item => asObject(item).id !== noopResultItemId),
            events: nullItemResultEvents,
          } }
          await expect(historicalWaitBindingAccepts(checkClient, snapshot, orphanedResultProjection),
            "the final binding must reject orphaned noop result events while retaining its call item").resolves.toBe(false)
        } finally {
          await checkClient.query("ROLLBACK TO SAVEPOINT recovered_source_orphan_noop_result")
          await checkClient.query("RELEASE SAVEPOINT recovered_source_orphan_noop_result")
        }

        const restoredResultOnlyItems = await checkClient.query<{ id: string }>(`SELECT "id" FROM "agent_items"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "stepId" = $4 AND "id" = ANY($5::text[])
          ORDER BY "id"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, [noopCallItemId, noopResultItemId]])
        expect(restoredResultOnlyItems.rows.map(item => item.id)).toEqual([noopCallItemId, noopResultItemId].sort())
        const restoredResultOnlyEvents = await checkClient.query<{ id: string; type: string; itemId: string | null }>(`SELECT "id", "type", "itemId"
          FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "id" = ANY($4::text[])
          ORDER BY "sequence"`, [ids.sessionId, ids.turnId, ids.waiterTaskId, noopResultEvents.map(event => event.id)])
        expect(restoredResultOnlyEvents.rows).toEqual(noopResultEvents.map(event => ({ id: event.id, type: event.type, itemId: event.itemId })))
        const restoredResultOnlyProjections = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
        const restoredResultOnlyHandoff = restoredResultOnlyProjections.find(projection => projection.sourceWait.waitId === sourceWaitId
          && projection.sourceWait.claimKeyDigest === null)
        expect(restoredResultOnlyHandoff?.sourceStepHandoff?.sourceStepPrefix.items)
          .toEqual(handoffSource.sourceStepHandoff.sourceStepPrefix.items)
        expect(restoredResultOnlyHandoff?.sourceStepHandoff?.sourceStepPrefix.events).toEqual(fullEvents)
        await expect(historicalWaitBindingAccepts(checkClient, snapshot, handoffSource),
          "the original handoff must bind again after rollback restores the noop result").resolves.toBe(true)

        await checkClient.query("SAVEPOINT wrong_correlation_step_completed")
        try {
          const sequence = await checkClient.query<{ value: string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
            WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"::text AS "value"`, [ids.sessionId, ids.userId])
          expect(sequence.rows).toHaveLength(1)
          const completedKey = `task:${ids.waiterTaskId}:event:step-completed:${handoffSource.stepId}`
          const wrongCorrelation = `unrelated-correlation:${randomUUID()}`
          const inserted = await checkClient.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
              "correlationId", "causationId", "idempotencyKey", "payload")
            VALUES ($1, $2, $3, NULL, $4, $5::bigint, 'step.completed', 'subagent', $6, $7, $8, $9::jsonb) RETURNING "id"`,
          [`fixture-wrong-step-completed-correlation:${suffix}`, ids.sessionId, ids.turnId, ids.waiterTaskId, sequence.rows[0]!.value,
            wrongCorrelation, fullEvents.at(-1)!.id, completedKey, JSON.stringify({ stepId: handoffSource.stepId, status: "completed",
              toolCallCount: 2, taskId: ids.waiterTaskId })])
          expect(inserted.rowCount).toBe(1)
          const afterWrongCorrelation = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
          expect(afterWrongCorrelation.filter(projection => projection.sourceWait.waitId === sourceWaitId)).toHaveLength(0)
          await expect(historicalWaitBindingAccepts(checkClient, snapshot, handoffSource),
            "the final binding must reject a canonical step-completed key with a wrong correlation").resolves.toBe(false)
        } finally {
          await checkClient.query("ROLLBACK TO SAVEPOINT wrong_correlation_step_completed")
          await checkClient.query("RELEASE SAVEPOINT wrong_correlation_step_completed")
        }

        const reorderedProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
        const nestedHandoff = asObject(reorderedProjection.sourceStepHandoff)
        const nestedPrefix = asObject(nestedHandoff.sourceStepPrefix)
        const reorderedEvents = fullEvents.map((event, index) => index === noopStartedIndex ? fullEvents[noopCallStartedIndex]!
          : index === noopCallStartedIndex ? fullEvents[noopStartedIndex]! : event)
        reorderedProjection.sourceStepHandoff = { ...nestedHandoff, sourceStepPrefix: { ...nestedPrefix, events: reorderedEvents } }
        await expect(historicalWaitBindingAccepts(checkClient, snapshot, reorderedProjection),
          "the final binding must reject reordered non-anchor events in a real recovered multi-tool prefix").resolves.toBe(false)
        const afterSwap = await readChildWaitTerminalCallProjections(checkClient, snapshot as unknown as Record<string, unknown>)
        expect(afterSwap.find(projection => projection.sourceWait.waitId === sourceWaitId && projection.sourceWait.claimKeyDigest === null)
          ?.sourceStepHandoff?.sourceStepPrefix.events).toEqual(fullEvents)

        const noopRowsAfterRecovery = await checkClient.query<{ count: number; eventCount: number }>(`SELECT
            (SELECT COUNT(*)::int FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND "stepId" = $4 AND "type" = 'tool_call' AND "content"->>'toolName' = 'fixture_noop') AS "count",
            (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
              AND ("itemId" IN ($5, $6) OR "correlationId" = $7)) AS "eventCount"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, sourceStepId, noopCallItemId, noopResultItemId, noopCallId])
        expect(noopRowsAfterRecovery.rows).toEqual([{ count: 1, eventCount: 6 }])
        await checkClient.query("COMMIT")
      } catch (error) {
        await checkClient.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally { checkClient.release() }
    } finally {
      await stopWorker(workerA)
      await stopWorker(workerB)
      await stopWorker(workerC)
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
  }, 150_000)

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
        `WorkerA result was not waiting: ${await workerFailureDiagnostic(pool, workerA, ids)}`).toBe("waiting")
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
      await waitForBoundedLoopMarker(workerC, "WORKER_B_RECOVERED")
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
      await waitForBoundedLoopMarker(workerC, "WORKER_B_LOOP_ROUNDED_USAGE_LINEAGE_CUT")
      expectUsageLineageCutStages(workerC)
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
      const settlementClient = await pool.connect()
      try {
        await settlementClient.query("BEGIN")
        await settlementClient.query("SELECT set_config('app.user_id', $1, true)", [ids.userId])
        expect((await settlementClient.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`,
          [ids.sessionId, ids.userId])).rowCount).toBe(1)
        expect((await settlementClient.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
          [ids.turnId, ids.sessionId, ids.userId])).rowCount).toBe(1)
        const locked = await settlementClient.query<BlockingTaskRow>(`SELECT "id", "sessionId", "turnId", "rootTaskId", "leaseOwner", "attemptCount", "leaseExpiresAt"
          FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
        [ids.waiterTaskId, ids.sessionId, ids.turnId, ids.rootTaskId])
        expect(locked.rows).toHaveLength(1)
        const lockedTask = locked.rows[0]
        if (!lockedTask) throw new Error("historical_wait_settlement_task_missing")
        const snapshot: BlockingTaskSnapshot = { ...lockedTask, userId: ids.userId }
        const blocking = (value: BlockingTaskSnapshot = snapshot, ignoredEventId?: string) => hasBlockingExternalCall(
          settlementClient, value as unknown as Record<string, unknown>, ignoredEventId, continuationStepId)
        await expectHistoricalWaitUnblocked(settlementClient, snapshot, continuationStepId,
          PHONE_SHAPED_WAIT_TOOL_CALL_ID, orphanCallId,
          "exact source and claim evidence should settle after the next step starts")
        await expect(blocking({ ...snapshot, leaseOwner: `${snapshot.leaseOwner}:stale` }),
          "a stale owner must not borrow historical settlement proof").resolves.toBe(true)
        await expect(blocking({ ...snapshot, attemptCount: snapshot.attemptCount + 1 }),
          "a different current attempt must not borrow historical settlement proof").resolves.toBe(true)
        await expect(blocking({ ...snapshot, userId: `${snapshot.userId}:wrong` }),
          "a different user scope must not borrow historical settlement proof").resolves.toBe(true)

        const wait = await settlementClient.query<{ id: string; result: Record<string, unknown>; deadlineAt: Date; resolvedAt: Date;
          matchedTaskIds: string[]; sourceStartEventId: string; claimStartEventId: string }>(`SELECT wait."id", wait."result", wait."deadlineAt", wait."resolvedAt", wait."matchedTaskIds",
            sourceStart."id" AS "sourceStartEventId", claimStart."id" AS "claimStartEventId"
          FROM "agent_wait_conditions" AS wait
          JOIN "agent_items" AS sourceCall ON sourceCall."sessionId" = wait."sessionId" AND sourceCall."turnId" = wait."turnId"
            AND sourceCall."taskId" = wait."parentTaskId" AND sourceCall."stepId" = wait."stepId" AND sourceCall."type" = 'tool_call'
            AND sourceCall."content"->>'toolName' = 'wait_subagents'
          JOIN "agent_events" AS sourceStart ON sourceStart."sessionId" = sourceCall."sessionId" AND sourceStart."turnId" = sourceCall."turnId"
            AND sourceStart."taskId" = sourceCall."taskId" AND sourceStart."itemId" = sourceCall."id" AND sourceStart."type" = 'tool_call.started'
            AND sourceStart."correlationId" = sourceCall."content"->>'toolCallId'
          JOIN "agent_events" AS claimStart ON claimStart."sessionId" = wait."sessionId" AND claimStart."turnId" = wait."turnId"
            AND claimStart."taskId" = wait."parentTaskId" AND claimStart."type" = 'tool_call.started' AND claimStart."correlationId" = $5
          WHERE wait."sessionId" = $1 AND wait."turnId" = $2 AND wait."parentTaskId" = $3 AND wait."stepId" = $4`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, `task:${ids.waiterTaskId}:step:0:attempt:1`, orphanCallId])
        expect(wait.rows).toHaveLength(1)
        const sourceStartEventId = wait.rows[0]!.sourceStartEventId, claimStartEventId = wait.rows[0]!.claimStartEventId
        await expect(blocking(snapshot, claimStartEventId), "the source receipt settles independently of the continuation claim").resolves.toBe(false)
        await expect(blocking(snapshot, sourceStartEventId), "the continuation claim settles independently of the source receipt").resolves.toBe(false)

        const claimResultId = `task:${ids.waiterTaskId}:item:tool-result:${orphanCallId}:attempt:1`
        const claimResultEvents = await settlementClient.query<{ startedId: string; completedId: string; completedCauseId: string | null; completedSequence: string }>(`SELECT started."id" AS "startedId", completed."id" AS "completedId",
              completed."causationId" AS "completedCauseId", completed."sequence"::text AS "completedSequence"
          FROM "agent_events" AS started JOIN "agent_events" AS completed ON completed."sessionId" = started."sessionId"
            AND completed."turnId" = started."turnId" AND completed."taskId" = started."taskId"
            AND completed."idempotencyKey" = $5 AND completed."type" = 'item.completed'
          WHERE started."sessionId" = $1 AND started."turnId" = $2 AND started."taskId" = $3
            AND started."idempotencyKey" = $4 AND started."type" = 'item.started'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId,
          `task:${ids.waiterTaskId}:event:item-started:${claimResultId}`,
          `task:${ids.waiterTaskId}:event:tool-result-completed:${orphanCallId}:${claimResultId}:1`])
        expect(claimResultEvents.rows).toHaveLength(1)
        expect(claimResultEvents.rows[0]!.completedCauseId).toBe(claimResultEvents.rows[0]!.startedId)
        const allowedStepCompletion = await settlementClient.query<{ id: string; itemId: string | null; actor: string; correlationId: string;
          causationId: string; idempotencyKey: string; payload: Record<string, unknown>; sequence: string; modelPayload: Record<string, unknown>;
          modelSequence: string; claimSequence: string }>(`SELECT step."id", step."itemId", step."actor", step."correlationId", step."causationId",
              step."idempotencyKey", step."payload", step."sequence"::text AS "sequence", model."payload" AS "modelPayload", model."sequence"::text AS "modelSequence",
              claimStart."sequence"::text AS "claimSequence"
            FROM "agent_events" AS step JOIN "agent_events" AS model ON model."sessionId" = step."sessionId"
              AND model."turnId" = step."turnId" AND model."taskId" = step."taskId" AND model."type" = 'model.completed'
              AND model."actor" = 'subagent' AND model."itemId" IS NULL AND model."correlationId" = step."correlationId"
              AND model."idempotencyKey" = 'task:' || step."taskId" || ':event:model-completed:' || step."correlationId"
            JOIN "agent_events" AS claimStart ON claimStart."id" = $6
            WHERE step."sessionId" = $1 AND step."turnId" = $2 AND step."taskId" = $3 AND step."type" = 'step.completed'
              AND step."correlationId" = $4 AND step."idempotencyKey" = $5 AND step."causationId" = $7`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId, `task:${ids.waiterTaskId}:event:step-completed:${continuationStepId}`,
          wait.rows[0]!.claimStartEventId, claimResultEvents.rows[0]!.completedId])
        expect(allowedStepCompletion.rows).toHaveLength(1)
        expect(allowedStepCompletion.rows[0]).toMatchObject({ itemId: null, actor: "subagent", correlationId: continuationStepId,
          causationId: claimResultEvents.rows[0]!.completedId,
          idempotencyKey: `task:${ids.waiterTaskId}:event:step-completed:${continuationStepId}` })
        expect(allowedStepCompletion.rows[0]!.payload).toEqual({ stepId: continuationStepId, status: "completed",
          toolCallCount: asObject(allowedStepCompletion.rows[0]!.modelPayload).toolCallCount, taskId: ids.waiterTaskId })
        expect(BigInt(allowedStepCompletion.rows[0]!.modelSequence)).toBeLessThan(BigInt(allowedStepCompletion.rows[0]!.claimSequence))
        expect(BigInt(allowedStepCompletion.rows[0]!.sequence)).toBeGreaterThan(BigInt(claimResultEvents.rows[0]!.completedSequence))
        for (const causationId of [claimResultEvents.rows[0]!.startedId, claimResultEvents.rows[0]!.completedId]) {
          await settlementClient.query("SAVEPOINT claim_result_cause_only")
          try {
            const sequence = await settlementClient.query<{ eventSequence: string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
              WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"::text AS "eventSequence"`, [ids.sessionId, ids.userId])
            expect(sequence.rows).toHaveLength(1)
            await settlementClient.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
                "correlationId", "causationId", "idempotencyKey", "payload")
              VALUES ($1, $2, $3, NULL, $4, $5, 'item.delta', 'subagent', $6, $7, $8, '{"text":"fixture"}'::jsonb)`,
            [`fixture-claim-result-cause:${randomUUID()}`, ids.sessionId, ids.turnId, ids.waiterTaskId, sequence.rows[0]!.eventSequence,
              `unrelated-correlation:${randomUUID()}`, causationId, `unrelated-key:${randomUUID()}`])
            await expect(blocking(), "a cause-only event attached to either exact claim result event must keep the call blocking").resolves.toBe(true)
          } finally {
            await settlementClient.query("ROLLBACK TO SAVEPOINT claim_result_cause_only")
            await settlementClient.query("RELEASE SAVEPOINT claim_result_cause_only")
          }
        }

        const modelChainRows = await settlementClient.query<{ id: string; type: string; causationId: string | null; payload: Record<string, unknown> }>(`SELECT "id", "type", "causationId", "payload"
          FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "correlationId" = $4
            AND "type" IN ('model.started', 'model.completed', 'model.usage') ORDER BY "sequence"`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, continuationStepId])
        expect(modelChainRows.rows.map(row => row.type)).toEqual(["model.started", "model.completed", "model.usage"])
        const modelStartId = modelChainRows.rows[0]!.id, modelCompletedId = modelChainRows.rows[1]!.id
        expect(modelChainRows.rows[1]!.causationId).toBe(modelStartId)
        const waitResultSequence = BigInt(claimResultEvents.rows[0]!.completedSequence)
        expect(BigInt(allowedStepCompletion.rows[0]!.sequence)).toBe(waitResultSequence + 1n)
        const orderedCallId = `fixture-ordered-after-wait-${randomUUID()}`
        const orderedCallItemId = `task:${ids.waiterTaskId}:item:tool-call:${orderedCallId}:attempt:1`
        const orderedResultItemId = `task:${ids.waiterTaskId}:item:tool-result:${orderedCallId}:attempt:1`
        const orderedCallContent = { toolCallId: orderedCallId, toolName: "jobs.search", toolVersion: "1", status: "completed", errorCode: null, input: { query: "synthetic" } }
        const orderedResultContent = { toolCallId: orderedCallId, output: { found: true }, errorCode: null }
        const orderedCallEventIds = Array.from({ length: 6 }, () => `fixture-ordered-event-${randomUUID()}`)
        await settlementClient.query("SAVEPOINT ordered_multi_tool_step")
        try {
          await settlementClient.query(`UPDATE "agent_events" SET "sequence" = "sequence" + 1000000
            WHERE "sessionId" = $1 AND "sequence" > $2::bigint`, [ids.sessionId, waitResultSequence.toString()])
          await settlementClient.query(`UPDATE "agent_events" SET "sequence" = "sequence" - 999994
            WHERE "sessionId" = $1 AND "sequence" > $2::bigint + 1000000`, [ids.sessionId, waitResultSequence.toString()])
          await settlementClient.query(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 6 WHERE "id" = $1`, [ids.sessionId])
          await settlementClient.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "updatedAt")
            VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', NULL, 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
              ($7, $2, $3, $4, $5, 'tool_result', 'completed', NULL, 1, $8::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [orderedCallItemId, ids.sessionId, ids.turnId, continuationStepId, ids.waiterTaskId, JSON.stringify(orderedCallContent),
            orderedResultItemId, JSON.stringify(orderedResultContent)])
          const orderedEvents = [
            { type: "item.started", itemId: orderedCallItemId, correlationId: continuationStepId,
              causationId: claimResultEvents.rows[0]!.completedId, idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${orderedCallItemId}`,
              payload: { itemId: orderedCallItemId, type: "tool_call", phase: null } },
            { type: "tool_call.started", itemId: orderedCallItemId, correlationId: orderedCallId,
              causationId: orderedCallEventIds[0]!, idempotencyKey: `task:${ids.waiterTaskId}:event:tool-started:${orderedCallId}`,
              payload: { toolCallId: orderedCallId, toolName: "jobs.search", taskId: ids.waiterTaskId } },
            { type: "item.completed", itemId: orderedCallItemId, correlationId: orderedCallItemId,
              causationId: orderedCallEventIds[1]!, idempotencyKey: `task:${ids.waiterTaskId}:event:tool-call-completed:${orderedCallId}:${orderedCallItemId}:1`,
              payload: { itemId: orderedCallItemId, status: "completed", content: orderedCallContent } },
            { type: "tool_call.completed", itemId: orderedCallItemId, correlationId: orderedCallId,
              causationId: orderedCallEventIds[2]!, idempotencyKey: `task:${ids.waiterTaskId}:event:tool-finished:${orderedCallId}`,
              payload: { toolCallId: orderedCallId, toolName: "jobs.search", status: "completed", errorCode: null, taskId: ids.waiterTaskId } },
            { type: "item.started", itemId: orderedResultItemId, correlationId: continuationStepId,
              causationId: orderedCallEventIds[3]!, idempotencyKey: `task:${ids.waiterTaskId}:event:item-started:${orderedResultItemId}`,
              payload: { itemId: orderedResultItemId, type: "tool_result", phase: null } },
            { type: "item.completed", itemId: orderedResultItemId, correlationId: orderedResultItemId,
              causationId: orderedCallEventIds[4]!, idempotencyKey: `task:${ids.waiterTaskId}:event:tool-result-completed:${orderedCallId}:${orderedResultItemId}:1`,
              payload: { itemId: orderedResultItemId, status: "completed", content: orderedResultContent } },
          ]
          for (let index = 0; index < orderedEvents.length; index += 1) {
            const event = orderedEvents[index]!
            await settlementClient.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
                "correlationId", "causationId", "idempotencyKey", "payload")
              VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, 'subagent', $8, $9, $10, $11::jsonb)`,
            [orderedCallEventIds[index], ids.sessionId, ids.turnId, event.itemId, ids.waiterTaskId, (waitResultSequence + BigInt(index + 1)).toString(),
              event.type, event.correlationId, event.causationId, event.idempotencyKey, JSON.stringify(event.payload)])
          }
          await settlementClient.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{toolCallCount}', '2'::jsonb, false)
            WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
          [modelCompletedId, ids.sessionId, ids.turnId, ids.waiterTaskId])
          await settlementClient.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{toolCallCount}', '2'::jsonb, false), "causationId" = $2
            WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5`,
          [allowedStepCompletion.rows[0]!.id, orderedCallEventIds[5], ids.sessionId, ids.turnId, ids.waiterTaskId])
          await expect(blocking(), "a fully persisted later tool call in the same ordered model step must allow settlement").resolves.toBe(false)
          await settlementClient.query(`UPDATE "agent_events" SET "causationId" = $2
            WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5`,
          [modelCompletedId, `unrelated-model-start:${randomUUID()}`, ids.sessionId, ids.turnId, ids.waiterTaskId])
          await expect(blocking(), "a malformed model.completed cause must invalidate an otherwise complete multi-tool chain").resolves.toBe(true)
        } finally {
          await settlementClient.query("ROLLBACK TO SAVEPOINT ordered_multi_tool_step")
          await settlementClient.query("RELEASE SAVEPOINT ordered_multi_tool_step")
        }

        const sourceMarker = asObject(asObject(wait.rows[0]!.result).sourceLifecycleRecovery)
        expect(typeof sourceMarker.resultItemId).toBe("string")
        const sourceResultRows = await settlementClient.query<{ itemId: string; content: Record<string, unknown>; eventId: string; eventPayload: Record<string, unknown> }>(
          `SELECT result."id" AS "itemId", result."content", completed."id" AS "eventId", completed."payload" AS "eventPayload"
           FROM "agent_items" AS result JOIN "agent_events" AS completed ON completed."sessionId" = result."sessionId"
             AND completed."turnId" = result."turnId" AND completed."taskId" = result."taskId" AND completed."itemId" = result."id"
             AND completed."type" = 'item.completed' AND completed."idempotencyKey" = 'task:' || result."taskId" || ':event:tool-result-completed:'
               || $4 || ':' || result."id" || ':1'
           WHERE result."id" = $5 AND result."sessionId" = $1 AND result."turnId" = $2 AND result."taskId" = $3 AND result."type" = 'tool_result'`,
          [ids.sessionId, ids.turnId, ids.waiterTaskId, PHONE_SHAPED_WAIT_TOOL_CALL_ID, sourceMarker.resultItemId])
        expect(sourceResultRows.rows).toHaveLength(1)
        const sourceResult = sourceResultRows.rows[0]!
        const sourceWaitStep = await settlementClient.query<{ status: string; attempt: number; ordinal: number }>(
          `SELECT source."status", source."attempt", source."ordinal" FROM "agent_wait_conditions" AS wait
           JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId"
             AND source."turnId" = wait."turnId" AND source."taskId" = wait."parentTaskId"
           WHERE wait."id" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId])
        expect(sourceWaitStep.rows).toEqual([{ status: "waiting_for_tool", attempt: 1, ordinal: 0 }])
        const realSourceProjections = await readChildWaitTerminalCallProjections(settlementClient, snapshot as unknown as Record<string, unknown>)
        const handoffSource = realSourceProjections.find(projection => projection.sourceWait.waitId === wait.rows[0]!.id
          && projection.sourceWait.claimKeyDigest === null)
        expect(handoffSource, "a recovered waiting source must produce its exact terminal projection").toBeDefined()
        expect(Object.prototype.hasOwnProperty.call(handoffSource, "sourceStepPrefix")).toBe(false)
        expect(handoffSource?.sourceStepHandoff?.schemaVersion).toBe("recovered_wait_handoff.v1")
        expect(handoffSource?.sourceStepHandoff?.waitId === wait.rows[0]!.id).toBe(true)
        expect(handoffSource?.sourceStepHandoff?.stepId === handoffSource?.stepId).toBe(true)
        expect(handoffSource?.sourceStepHandoff?.attempt === handoffSource?.attempt).toBe(true)
        expect(handoffSource?.sourceStepHandoff?.sourceCallItemId === handoffSource?.callItemId).toBe(true)
        expect(handoffSource?.sourceStepHandoff?.sourceCallId === PHONE_SHAPED_WAIT_TOOL_CALL_ID).toBe(true)
        expect(handoffSource?.sourceStepHandoff?.sourceResultItemId === sourceResult.itemId).toBe(true)
        expect(handoffSource?.sourceStepHandoff?.events).toHaveLength(6)
        if (!handoffSource?.sourceStepHandoff) throw new Error("historical_wait_handoff_projection_missing")
        await expect(historicalWaitBindingAccepts(settlementClient, snapshot, handoffSource),
          "the final PostgreSQL binding must accept the exact producer handoff proof").resolves.toBe(true)

        const reorderedNestedProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
        const nestedHandoff = asObject(reorderedNestedProjection.sourceStepHandoff)
        const nestedSourcePrefix = asObject(nestedHandoff.sourceStepPrefix)
        const nestedEvents = Array.isArray(nestedSourcePrefix.events) ? nestedSourcePrefix.events : []
        const nestedHandoffEvents = Array.isArray(nestedHandoff.events) ? nestedHandoff.events : []
        expect(nestedEvents[6]).toMatchObject({ type: "tool_call.started" })
        expect(nestedEvents[7]).toMatchObject({ type: "item.completed" })
        expect(nestedHandoffEvents.map(event => asObject(event).id)).not.toContain(asObject(nestedEvents[6]).id)
        expect(nestedHandoffEvents.map(event => asObject(event).id)).not.toContain(asObject(nestedEvents[7]).id)
        const reorderedNestedPrefix = { ...nestedSourcePrefix, events: nestedEvents.map((event, index) =>
          index === 6 ? nestedEvents[7] : index === 7 ? nestedEvents[6] : event) }
        reorderedNestedProjection.sourceStepHandoff = { ...nestedHandoff, sourceStepPrefix: reorderedNestedPrefix }
        await expect(historicalWaitBindingAccepts(settlementClient, snapshot, reorderedNestedProjection),
          "the final PostgreSQL binding must reject reordered non-anchor events inside recovered handoff sourceStepPrefix").resolves.toBe(false)

        await expect(historicalWaitBindingAccepts(settlementClient, { ...snapshot, leaseOwner: `${snapshot.leaseOwner}:stale` }, handoffSource),
          "the same handoff proof must not transfer to a stale lease").resolves.toBe(false)
        await expect(historicalWaitBindingAccepts(settlementClient, { ...snapshot, leaseExpiresAt: new Date(snapshot.leaseExpiresAt!.getTime() + 1) }, handoffSource),
          "the same handoff proof must not transfer to a changed lease expiry").resolves.toBe(false)
        await expect(historicalWaitBindingAccepts(settlementClient, { ...snapshot, attemptCount: snapshot.attemptCount + 1 }, handoffSource),
          "the same handoff proof must not transfer to another attempt").resolves.toBe(false)
        await expect(historicalWaitBindingAccepts(settlementClient, { ...snapshot, userId: `${snapshot.userId}:wrong` }, handoffSource),
          "the same handoff proof must not transfer to another tenant").resolves.toBe(false)

        const forgedHandoffProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
        const forgedHandoff = asObject(forgedHandoffProjection.sourceStepHandoff)
        forgedHandoffProjection.sourceStepHandoff = { ...forgedHandoff, schemaVersion: "recovered_wait_handoff.forged" }
        await expect(historicalWaitBindingAccepts(settlementClient, snapshot, forgedHandoffProjection),
          "the final PostgreSQL binding must reject a forged in-memory handoff marker").resolves.toBe(false)
        const duplicateAnchorProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
        const duplicateAnchorHandoff = asObject(duplicateAnchorProjection.sourceStepHandoff)
        const proofEvents = Array.isArray(duplicateAnchorHandoff.events) ? duplicateAnchorHandoff.events : []
        expect(proofEvents).toHaveLength(6)
        duplicateAnchorProjection.sourceStepHandoff = { ...duplicateAnchorHandoff, events: [...proofEvents.slice(0, 5), proofEvents[0]] }
        await expect(historicalWaitBindingAccepts(settlementClient, snapshot, duplicateAnchorProjection),
          "the final PostgreSQL binding must reject duplicate handoff event anchors").resolves.toBe(false)
        const missingAnchorProjection = JSON.parse(JSON.stringify(handoffSource)) as Record<string, unknown>
        const missingAnchorHandoff = asObject(missingAnchorProjection.sourceStepHandoff)
        const missingProofEvents = Array.isArray(missingAnchorHandoff.events) ? missingAnchorHandoff.events : []
        missingAnchorProjection.sourceStepHandoff = { ...missingAnchorHandoff, events: missingProofEvents.slice(0, 5) }
        await expect(historicalWaitBindingAccepts(settlementClient, snapshot, missingAnchorProjection),
          "the final PostgreSQL binding must reject a handoff missing an event anchor").resolves.toBe(false)

        const expectHandoffProducerRejected = async (label: string, mutate: () => Promise<{ rowCount: number | null }>) => {
          await settlementClient.query("SAVEPOINT historical_wait_handoff_tamper")
          try {
            const changed = await mutate()
            expect(changed.rowCount, `${label} fixture mutation`).toBe(1)
            const afterTamper = await readChildWaitTerminalCallProjections(settlementClient, snapshot as unknown as Record<string, unknown>)
            expect(afterTamper.filter(projection => projection.sourceWait.waitId === wait.rows[0]!.id).length,
              `${label} must not produce a historical source or claim proof`).toBe(0)
            await expect(blocking(), `${label} must leave the source wait blocking`).resolves.toBe(true)
          } finally {
            await settlementClient.query("ROLLBACK TO SAVEPOINT historical_wait_handoff_tamper")
            await settlementClient.query("RELEASE SAVEPOINT historical_wait_handoff_tamper")
          }
        }

        await expectHandoffProducerRejected("forged persisted source lifecycle marker", () => settlementClient.query(
          `UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{sourceLifecycleRecovery,taskId}', to_jsonb($5::text), false)
            WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 RETURNING "id"`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, `forged-task-${randomUUID()}`]))

        const extraSourceToolId = `fixture-extra-source-tool:${randomUUID()}`
        await expectHandoffProducerRejected("additional source-step tool call", () => settlementClient.query(
          `INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', NULL, 0, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [`task:${ids.waiterTaskId}:item:tool-call:${extraSourceToolId}:attempt:1`, ids.sessionId, ids.turnId,
            handoffSource.stepId, ids.waiterTaskId, JSON.stringify({ toolCallId: extraSourceToolId,
              toolName: "jobs.search", toolVersion: "1", input: { query: "fixture" } })]))

        const missingHandoffAnchor = handoffSource.sourceStepHandoff.events.find(event => event.type === "model.usage")
        if (!missingHandoffAnchor) throw new Error("historical_wait_handoff_usage_anchor_missing")
        await expectHandoffProducerRejected("missing recovered-step event anchor", () => settlementClient.query(
          `UPDATE "agent_events" SET "idempotencyKey" = "idempotencyKey" || ':tampered'
            WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 RETURNING "id"`,
          [missingHandoffAnchor.id, ids.sessionId, ids.turnId, ids.waiterTaskId]))

        const duplicateAnchor = handoffSource.sourceStepHandoff.events.find(event => event.type === "item.started"
          && event.itemId === handoffSource.callItemId)
        if (!duplicateAnchor) throw new Error("historical_wait_handoff_item_anchor_missing")
        await expectHandoffProducerRejected("duplicate source item-started anchor", async () => {
          const original = await settlementClient.query<{ payload: Record<string, unknown>; causationId: string | null;
            correlationId: string; itemId: string | null }>(`SELECT "payload", "causationId", "correlationId", "itemId"
              FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`,
          [duplicateAnchor.id, ids.sessionId, ids.turnId, ids.waiterTaskId])
          expect(original.rowCount).toBe(1)
          const sequence = await settlementClient.query<{ eventSequence: string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
            WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"::text AS "eventSequence"`, [ids.sessionId, ids.userId])
          expect(sequence.rows).toHaveLength(1)
          return settlementClient.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor",
              "correlationId", "causationId", "idempotencyKey", "payload")
            VALUES ($1, $2, $3, $4, $5, $6::bigint, 'item.started', 'subagent', $7, $8, $9, $10::jsonb)`,
          [`fixture-duplicate-source-anchor:${randomUUID()}`, ids.sessionId, ids.turnId, original.rows[0]!.itemId, ids.waiterTaskId,
            sequence.rows[0]!.eventSequence, original.rows[0]!.correlationId, original.rows[0]!.causationId,
            `${duplicateAnchor.idempotencyKey}:duplicate:${randomUUID()}`, JSON.stringify(original.rows[0]!.payload)])
        })

        const wrongCauseAnchor = handoffSource.sourceStepHandoff.events.find(event => event.type === "model.completed")
        if (!wrongCauseAnchor) throw new Error("historical_wait_handoff_model_completion_anchor_missing")
        await expectHandoffProducerRejected("wrong recovered-step event causation", () => settlementClient.query(
          `UPDATE "agent_events" SET "causationId" = $5 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 RETURNING "id"`,
          [wrongCauseAnchor.id, ids.sessionId, ids.turnId, ids.waiterTaskId, `unrelated-cause:${randomUUID()}`]))

        await settlementClient.query("SAVEPOINT historical_handoff_marker_owner_toctou")
        try {
          const changedMarker = await settlementClient.query(`UPDATE "agent_wait_conditions"
            SET "result" = jsonb_set("result", '{sourceLifecycleRecovery,ownerId}', to_jsonb($5::text), false)
            WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 RETURNING "id"`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, `different-owner-${randomUUID()}`])
          expect(changedMarker.rowCount).toBe(1)
          await expect(historicalWaitBindingAccepts(settlementClient, snapshot, handoffSource),
            "the final PostgreSQL binding must reject a lifecycle owner marker changed after projection read").resolves.toBe(false)
          const postTamperProjections = await readChildWaitTerminalCallProjections(settlementClient, snapshot as unknown as Record<string, unknown>)
          expect(postTamperProjections.filter(projection => projection.sourceWait.waitId === wait.rows[0]!.id).length).toBe(0)
          await expect(blocking(), "a changed lifecycle owner marker must keep the wait blocking").resolves.toBe(true)
        } finally {
          await settlementClient.query("ROLLBACK TO SAVEPOINT historical_handoff_marker_owner_toctou")
          await settlementClient.query("RELEASE SAVEPOINT historical_handoff_marker_owner_toctou")
        }

        // The source projection above is the real recovered handoff for this same PG fixture;
        // these canonical outcome checks therefore exercise handoff settlement, not a prefix mock.
        const expectSelfConsistentOutcomeRejected = async (label: string, status: "ready" | "timed_out", matchedTaskIds: string[], outcome: Record<string, unknown>) => {
          await settlementClient.query("SAVEPOINT self_consistent_malformed_wait_outcome")
          try {
            const changedWait = await settlementClient.query(`UPDATE "agent_wait_conditions" SET "status" = $5, "matchedTaskIds" = $6::jsonb,
                "resolvedAt" = CASE WHEN $5 = 'timed_out' THEN "deadlineAt" - interval '1 millisecond' ELSE "resolvedAt" END,
                "result" = jsonb_set("result", '{outcome}', $7::jsonb, false)
              WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 RETURNING "id"`,
            [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, status, JSON.stringify(matchedTaskIds), JSON.stringify(outcome)])
            expect(changedWait.rowCount).toBe(1)
            const changedResult = await settlementClient.query(`UPDATE "agent_items" SET "content" = jsonb_set("content", '{output}', $2::jsonb, false)
              WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'tool_result' RETURNING "content"`,
            [sourceResult.itemId, JSON.stringify(outcome), ids.sessionId, ids.turnId, ids.waiterTaskId])
            expect(changedResult.rowCount).toBe(1)
            const updatedContent = changedResult.rows[0]!.content
            const changedEvent = await settlementClient.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{content}', $2::jsonb, false)
              WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'item.completed' RETURNING "id"`,
            [sourceResult.eventId, JSON.stringify(updatedContent), ids.sessionId, ids.turnId, ids.waiterTaskId])
            expect(changedEvent.rowCount).toBe(1)
            const aligned = await settlementClient.query<{ outcome: Record<string, unknown>; output: Record<string, unknown>; eventContent: Record<string, unknown>; resolvedAt: Date; deadlineAt: Date }>(
              `SELECT wait."result"->'outcome' AS "outcome", result."content"->'output' AS "output", event."payload"->'content' AS "eventContent",
                  wait."resolvedAt", wait."deadlineAt"
               FROM "agent_wait_conditions" AS wait JOIN "agent_items" AS result ON result."id" = $5 AND result."sessionId" = wait."sessionId"
                 AND result."turnId" = wait."turnId" AND result."taskId" = wait."parentTaskId"
               JOIN "agent_events" AS event ON event."id" = $6 AND event."sessionId" = wait."sessionId" AND event."turnId" = wait."turnId"
                 AND event."taskId" = wait."parentTaskId"
               WHERE wait."id" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4`,
              [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, sourceResult.itemId, sourceResult.eventId])
            expect(aligned.rows).toHaveLength(1)
            expect(aligned.rows[0]!.outcome).toEqual(aligned.rows[0]!.output)
            expect(aligned.rows[0]!.output).toEqual(asObject(aligned.rows[0]!.eventContent).output)
            if (label === "timeout before deadline") expect(aligned.rows[0]!.resolvedAt.getTime()).toBeLessThan(aligned.rows[0]!.deadlineAt.getTime())
            if (label === "missing deadline") expect(aligned.rows[0]!.outcome).not.toHaveProperty("deadlineAt")
            await expect(blocking(), `${label}: the source result and event agree but the canonical outcome must still block`).resolves.toBe(true)
          } finally {
            await settlementClient.query("ROLLBACK TO SAVEPOINT self_consistent_malformed_wait_outcome")
            await settlementClient.query("RELEASE SAVEPOINT self_consistent_malformed_wait_outcome")
          }
        }
        const originalOutcome = asObject(asObject(wait.rows[0]!.result).outcome)
        const missingDeadlineOutcome = { ...originalOutcome }
        delete missingDeadlineOutcome.deadlineAt
        await expectSelfConsistentOutcomeRejected("missing deadline", "ready", wait.rows[0]!.matchedTaskIds, missingDeadlineOutcome)
        const timedOutOutcome = { ...originalOutcome, status: "timed_out" }
        await expectSelfConsistentOutcomeRejected("timeout before deadline", "timed_out", wait.rows[0]!.matchedTaskIds, timedOutOutcome)
        const runningTasks = Array.isArray(originalOutcome.tasks) ? originalOutcome.tasks.map(task => ({ ...asObject(task), status: "running" })) : []
        const emptyMatchOutcome = { ...originalOutcome, matchedTaskIds: [], tasks: runningTasks }
        await expectSelfConsistentOutcomeRejected("empty matched snapshot", "ready", [], emptyMatchOutcome)

        const expectOutcomeRejected = async (update: string, values: (string | number)[], label: string) => {
          await settlementClient.query("SAVEPOINT malformed_wait_outcome")
          try {
            const changed = await settlementClient.query(update, values)
            expect(changed.rowCount, `${label} fixture mutation`).toBe(1)
            await expect(blocking(), `${label} must leave the unresolved call blocking`).resolves.toBe(true)
          } finally {
            await settlementClient.query("ROLLBACK TO SAVEPOINT malformed_wait_outcome")
            await settlementClient.query("RELEASE SAVEPOINT malformed_wait_outcome")
          }
        }
        const waitScope = `WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 RETURNING "id"`
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{outcome,tasks,0,status}', to_jsonb($5::text), false) ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, "unknown-status"], "invalid task status")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "matchedTaskIds" = '[]'::jsonb,
            "result" = jsonb_set(jsonb_set("result", '{outcome,matchedTaskIds}', '[]'::jsonb, false), '{outcome,tasks}',
              (SELECT jsonb_agg(jsonb_set(task.value, '{status}', '"running"'::jsonb, false))
                FROM jsonb_array_elements("result"->'outcome'->'tasks') AS task(value)), false) ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "empty matched IDs")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "matchedTaskIds" = to_jsonb(ARRAY[$5::text]),
            "result" = jsonb_set("result", '{outcome,matchedTaskIds}', to_jsonb(ARRAY[$5::text]), false) ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId, "misbound-target"], "misbound matched IDs")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "mode" = 'invalid' ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "invalid wait mode")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "status" = 'timed_out', "resolvedAt" = "deadlineAt" - interval '1 millisecond',
            "result" = jsonb_set("result", '{outcome,status}', to_jsonb('timed_out'::text), false) ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "timeout before deadline")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "resolvedAt" = "deadlineAt" + interval '1 millisecond' ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "ready after deadline")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{outcome,deadlineAt}',
            to_jsonb(to_char(("deadlineAt" + interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), false) ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "altered deadline")
        await expectOutcomeRejected(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{outcome,deadlineAt}',
            to_jsonb(to_char("deadlineAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+00:00'), false) ${waitScope}`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "noncanonical UTC deadline")

        await expectOutcomeRejected('UPDATE "agent_wait_conditions" SET "targetTaskIds" = \'{}\'::jsonb ' + waitScope,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "non-array target IDs")
        await expectOutcomeRejected('UPDATE "agent_wait_conditions" SET "matchedTaskIds" = \'{}\'::jsonb ' + waitScope,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId], "non-array matched IDs")
        await settlementClient.query("SAVEPOINT historical_wait_missing_deadline")
        try {
          const changed = await settlementClient.query(`UPDATE "agent_wait_conditions" SET "result" = jsonb_set("result", '{outcome}', ("result"->'outcome') - 'deadlineAt', false)
            WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 RETURNING "id"`,
          [wait.rows[0]!.id, ids.sessionId, ids.turnId, ids.waiterTaskId])
          expect(changed.rowCount).toBe(1)
          await expect(blocking(), "a missing canonical deadline must leave the source call blocking").resolves.toBe(true)
        } finally {
          await settlementClient.query("ROLLBACK TO SAVEPOINT historical_wait_missing_deadline")
          await settlementClient.query("RELEASE SAVEPOINT historical_wait_missing_deadline")
        }

        const claimItemId = `task:${ids.waiterTaskId}:item:tool-call:${orphanCallId}:attempt:1`
        const claimCompletionKey = `task:${ids.waiterTaskId}:event:tool-call-completed:${orphanCallId}:${claimItemId}:1`
        const claimCompletion = await settlementClient.query<{ id: string }>(`SELECT "id" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4 AND "type" = 'item.completed'`,
        [ids.sessionId, ids.turnId, ids.waiterTaskId, claimCompletionKey])
        expect(claimCompletion.rows).toHaveLength(1)
        await settlementClient.query("SAVEPOINT historical_claim_projection")
        try {
          const changed = await settlementClient.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{content,toolCallId}', to_jsonb($2::text), false)
            WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 RETURNING "id"`,
          [claimCompletion.rows[0]!.id, "tampered-projection", ids.sessionId, ids.turnId, ids.waiterTaskId])
          expect(changed.rowCount).toBe(1)
          await expect(blocking(), "the claim's canonical projected completion is required independently").resolves.toBe(true)
        } finally {
          await settlementClient.query("ROLLBACK TO SAVEPOINT historical_claim_projection")
          await settlementClient.query("RELEASE SAVEPOINT historical_claim_projection")
        }
      } finally {
        await settlementClient.query("ROLLBACK").catch(() => undefined)
        settlementClient.release()
      }
      console.info(`WORKER_D_BLOCKER_CLASSIFICATION ${JSON.stringify(await boundedExternalCallBlockerDiagnostic(pool, ids))}`)
      workerD = launchWorker("worker-b-loop-usage-lineage-reject", queueName, ids)
      await waitForBoundedLoopMarker(workerD, "WORKER_B_RECOVERED")
      const workerDRecovery = parseRecoveryMarker(workerD)
      expect(workerDRecovery.reclaimed).toBe(0)
      expect(workerDRecovery.terminal, boundedWorkerRecoveryDiagnostic(workerD, ids.waiterTaskId)).toBe(1)
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
