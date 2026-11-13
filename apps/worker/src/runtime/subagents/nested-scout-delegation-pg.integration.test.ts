import { randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool, type PoolClient, type QueryConfig, type QueryResult, type QueryResultRow } from "pg"
import { projectWaitCallCompletionPayload } from "../turns/turn-execution-wait-event-projection.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"
import { loadChildAttemptResume } from "./child-resume.js"
import type { SubagentLease } from "./types.js"

const DATABASE_NAME = "applymate_nested_delegation_ci"
const PROCESS_FIXTURE = fileURLToPath(new URL("./nested-scout-delegation-worker.fixture.mjs", import.meta.url))
const MAIN_PROGRESS_QUERY_TIMEOUT_MS = 2_000

type FixtureIds = Readonly<{ userId: string; sessionId: string; turnId: string; alphaJobId: string; betaJobId: string; foreignJobId: string }>
type FixtureProcess = { child: ChildProcess; waitForLine(marker: string, timeoutMs: number): Promise<void>; output: string[] }
const MAIN_PROGRESS_MARKERS = new Set([
  "P1143_ROOT_MODEL_STREAM_STARTED", "P1143_ROOT_MODEL_RUNTIME_FACTORY_ENTERED", "P1143_ROOT_MODEL_RUNTIME_FACTORY_CREATED",
  "P1143_ROOT_USAGE_AUTHORIZER_CALLED", "P1143_ROOT_PLAN_REQUESTED", "P1143_PARENT_ADAPTER_STARTED",
  "P1143_SUBAGENT_CLAIMS_PAUSED", "P1143_PARENT_DISCOVER_REQUESTED", "P1143_SOURCE_ESCALATION_REQUESTED",
  "P1143_SOURCE_ESCALATION_REJECTED", "P1143_CLOSED_STEP_REPLAY_REJECTED", "P1143_FOREIGN_CALL_STEP_REJECTED",
  "P1143_PARENT_WAITING", "P1143_CRASH_CHILD_BEFORE_MODEL_CALL", "P1143_CHILD_WORKER_CLAIMED_RUNNING",
  "P1143_RECOVERY_DEPTH2_QUEUED", "P1143_RECOVERY_DEPTH2_NOT_QUEUED", "P1143_RECOVERY_NO_DEPTH2_ROW",
  "P1143_CHILD_SCOUT_RECLAIMED",
  "P1143_TWO_CHILDREN_RUNNING_IN_PARALLEL", "P1143_CHILD_DISCOVERY_RESULT_RECEIVED",
  "P1143_CHILD_ROLE_RESULT_STREAMED", "P1143_PARENT_SCOUT_RESULTS_RECEIVED", "P1143_PARENT_ROLE_RESULT_STREAMED",
  "P1143_ROOT_GRAPH_COMPLETED", "P1143_PARENT_DELEGATE_RESULTS_BOTH", "P1143_PARENT_DELEGATE_RESULTS_ONE",
  "P1143_PARENT_DELEGATE_RESULTS_NONE", "P1143_PARENT_DELEGATE_TASK_IDS_BOTH", "P1143_PARENT_DELEGATE_TASK_IDS_ONE",
  "P1143_PARENT_DELEGATE_TASK_IDS_NONE", "P1143_PARENT_WAIT_RESULT_PRESENT", "P1143_PARENT_WAIT_RESULT_MISSING",
  "P1143_PARENT_WAIT_TERMINAL_MATCH", "P1143_PARENT_WAIT_TERMINAL_NO_MATCH", "P1143_PARENT_SCOUT_RESULTS_ISSUED",
  "P1143_PARENT_SCOUT_RESULTS_NOT_ISSUED",
  "P1143_PARENT_MODEL_STREAM_ENTERED", "P1143_PARENT_RESUME_MODEL_FIRST_ATTEMPT", "P1143_PARENT_RESUME_MODEL_RETRIED",
  "P1143_PARENT_RESUME_FINAL_CANDIDATE",
  "P1143_PARENT_RESUME_WAIT_INPUT_PRESENT", "P1143_PARENT_RESUME_WAIT_INPUT_MISSING",
  "P1143_PARENT_RESUME_WAIT_RESULT_PRESENT", "P1143_PARENT_RESUME_WAIT_RESULT_MISSING",
  "P1143_PARENT_RESUME_WAIT_CONTEXT_READY", "P1143_PARENT_RESUME_WAIT_CONTEXT_TIMED_OUT",
  "P1143_PARENT_RESUME_WAIT_CONTEXT_WAITING", "P1143_PARENT_RESUME_WAIT_CONTEXT_FAILED",
  "P1143_PARENT_RESUME_WAIT_CONTEXT_OTHER",
])
const SAFE_DIAGNOSTIC_ERROR_CODES = [
  "invalid_output", "model_execution_failed", "tool_execution_failed", "subagent_lease_lost", "nested_scout_final_wait_owner_unavailable",
  "nested_scout_final_wait_unavailable", "nested_scout_final_wait_children_invalid", "turn_execution_failed", "model_incomplete",
  "budget_exhausted", "step_limit", "no_progress", "evidence_missing", "evidence_conflict", "final_unverified", "persistence_conflict",
  "schema_error", "discovery_memory_overflow", "tool_result_replay_uncertain", "tool_recovery_aborted", "invalid_structured_result",
  "attempt_limit_exhausted", "deadline_exceeded", "task_graph_verification_unverified", "task_graph_verification_failed",
  "nested_scout_source_scope_unavailable", "task_graph_snapshot_invalid", "child_action_denied", "wait_conflict", "wait_scope_error",
  "wait_invalid", "provider_unavailable", "p1143_children_did_not_overlap_in_running_state", "p1143_delegate_tool_missing",
  "p1143_grandchild_coordination_leaked", "p1143_grandchild_discover_tool_missing", "p1143_grandchild_source_bound_job_missing",
  "p1143_grandchild_source_evidence_missing", "p1143_parent_current_reads_missing", "p1143_parent_discovery_tool_missing",
  "p1143_parent_lease_unavailable", "p1143_root_plan_tool_missing", "p1143_root_scout_task_missing", "p1143_root_scout_verification_missing",
  "p1143_scout_results_not_available_after_wait", "p1143_scout_results_tool_missing", "p1143_second_delegate_tool_missing",
  "p1143_source_escalation_was_not_rejected", "p1143_stale_step_created_child", "p1143_stale_step_was_accepted",
  "p1143_step_fence_fixture_missing_steps", "p1143_fixture_requires_disposable_ci_services", "p1143_parent_did_not_suspend_without_lease",
  "p1143_root_graph_completion_unverified", "p1143_root_turn_did_not_complete_after_child_join", "p1143_root_turn_failed",
  "p1143_subagent_queue_unavailable", "p1143_crash_child_did_not_claim",
  "child_resume_unavailable", "child_resume_evidence_unavailable", "child_resume_wait_step_lineage",
  "child_children_pending_continuation_unavailable", "child_mailbox_continuation_unavailable",
  "child_mailbox_continuation_checkpoint_unavailable", "child_mailbox_continuation_checkpoint_invalid",
  "child_mailbox_continuation_unsupported", "child_turn_missing", "selected_job_context_unavailable",
  "writer_dependency_unavailable", "selected_job_sources_unavailable", "selected_job_output_contract_unavailable",
  "subagent_role_unknown",
] as const
const SAFE_WAIT_RESUME_CODES = ["wait_invalid", "wait_scope_error", "wait_conflict", "other"] as const
const SAFE_RECOVERY_STAGES = ["manager_recover", "dispatch"] as const
const SAFE_RECOVERY_ERROR_CODES = [
  "subagent_dispatch_delivery_uncertain", "lost", "40001", "40P01", "55P03", "57014", "08000", "08003", "08006", "57P01",
  "ECONNRESET", "ETIMEDOUT", "error", "unknown", "other",
] as const
const SAFE_RECOVERY_DIAGNOSTIC_MARKERS = new Set(SAFE_RECOVERY_STAGES.flatMap(stage =>
  SAFE_RECOVERY_ERROR_CODES.map(code => `P1143_RECOVERY_ERROR:${stage}:${code}`)))
const SAFE_CHILD_RESUME_LOADER_CODES = [
  ...SAFE_RECOVERY_ERROR_CODES, "child_resume_owner_mismatch", "child_resume_lease_expired", "child_resume_wait_tool_call_conflict",
  "child_resume_wait_step_lineage", "child_resume_wait_lineage", "child_resume_invalid_wait_result", "child_resume_step_lineage",
  "child_resume_item_lineage", "child_resume_step_limit", "child_resume_item_limit", "child_resume_usage_overflow",
] as const
const SAFE_WAIT_RESUME_STAGES = [
  "required_value", "resume_scope", "source_step", "source_call_count", "source_call_input", "source_item_set", "wait_record_shape",
  "provenance_marker", "source_receipt_missing", "source_marker_without_result", "source_recovered_receipt_mismatch",
  "source_waiting_content", "source_waiting_output_shape", "source_waiting_identity", "source_waiting_targets",
  "source_waiting_matched_ids", "source_waiting_tasks", "source_waiting_task_ids", "source_waiting_deadline",
  "source_initial_call_shape", "source_call_completion_state", "source_result_completion_state", "source_call_completion_content",
  "source_result_completion_content", "source_waiting_output_missing", "source_event_chain", "reconciliation", "safe_result_shape",
  "source_start_event", "other",
] as const
const SAFE_RELATED_EVENT_TYPES = new Set([
  "item.started", "item.delta", "item.completed", "item.failed", "item.interrupted",
  "tool_call.started", "tool_call.completed", "tool_call.failed", "tool_call.interrupted",
  "model.started", "model.completed", "model.usage", "step.started", "step.completed", "step.failed", "step.interrupted",
  "cognitive.agenda", "task.created", "task.updated", "task.completed", "task.failed",
])
const SAFE_EVENT_ACTORS = new Set(["subagent", "tool", "orchestrator", "user", "system"])
const SAFE_WAIT_LIFECYCLE_TYPES = new Set(["item.started", "item.completed", "tool_call.started", "tool_call.completed"])

function isSafeFixtureFailure(value: string): boolean {
  const match = value.match(/^P1143_FIXTURE_FAILURE:(p1143_[a-z_]+|redacted)$/)
  return !!match && (match[1] === "redacted" || SAFE_DIAGNOSTIC_ERROR_CODES.includes(match[1] as typeof SAFE_DIAGNOSTIC_ERROR_CODES[number]))
}

function progressQuery<Row extends QueryResultRow>(text: string, values: unknown[] = []): Promise<QueryResult<Row>> {
  const config: QueryConfig<unknown[]> & { query_timeout: number } = { text, values, query_timeout: MAIN_PROGRESS_QUERY_TIMEOUT_MS }
  return pool.query<Row, unknown[]>(config)
}

function isSafeRootSetupDiagnostic(value: string): boolean {
  const match = value.match(/^P1143_ROOT_(MODEL_RUNTIME_FACTORY|USAGE_AUTHORIZER)_ERROR:([A-Za-z0-9_]+)$/)
  return !!match && SAFE_RECOVERY_ERROR_CODES.includes(match[2] as typeof SAFE_RECOVERY_ERROR_CODES[number])
}

function isSafeChildResumeLoaderDiagnostic(value: string): boolean {
  const match = value.match(/^P1143_CHILD_RESUME_LOADER_DIAGNOSTIC:([A-Za-z0-9_]+)$/)
  return !!match && SAFE_CHILD_RESUME_LOADER_CODES.includes(match[1] as typeof SAFE_CHILD_RESUME_LOADER_CODES[number])
}

function seenMainProgress(output: string[]) {
  return [...new Set(output.filter(value => MAIN_PROGRESS_MARKERS.has(value)
    || SAFE_RECOVERY_DIAGNOSTIC_MARKERS.has(value) || isSafeChildResumeLoaderDiagnostic(value)
    || isSafeRootSetupDiagnostic(value)))]
}

async function readMainProgressDiagnostic(ids: FixtureIds, output: string[]) {
  const observedPhases = seenMainProgress(output)
  const fixtureFailure = output.find(isSafeFixtureFailure) ?? null
  const waitResumeCommitFailures = output.flatMap(value => {
    const match = value.match(/^P1143_WAIT_RESUME_COMMIT_DIAGNOSTIC:([a-z_]+):([a-z_]+)$/)
    return match && SAFE_WAIT_RESUME_CODES.includes(match[1] as typeof SAFE_WAIT_RESUME_CODES[number])
      && SAFE_WAIT_RESUME_STAGES.includes(match[2] as typeof SAFE_WAIT_RESUME_STAGES[number])
      ? [{ code: match[1], stage: match[2] }] : []
  })
  try {
    const [turn, graph, steps, tasks, parentSteps, waits, tools] = await Promise.all([
      progressQuery<{ status: string }>(`SELECT CASE WHEN "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval',
          'waiting_for_user', 'completed', 'failed', 'interrupted') THEN "status" ELSE 'other' END AS "status"
        FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`,
        [ids.turnId, ids.sessionId]),
      progressQuery<{ nodeCount: number }>(`SELECT CASE WHEN jsonb_typeof("content"->'nodes') = 'array'
          THEN jsonb_array_length("content"->'nodes') ELSE 0 END AS "nodeCount"
        FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = 'task_graph'
        ORDER BY "revision" DESC LIMIT 1`, [ids.sessionId, ids.turnId]),
      progressQuery<{ status: string; errorCode: string | null; count: number }>(`SELECT CASE WHEN "status" IN ('started', 'streaming', 'completed', 'failed',
          'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user') THEN "status" ELSE 'other' END AS "status",
          CASE WHEN "errorCode" IS NULL THEN NULL WHEN "errorCode" = ANY($3::text[])
            THEN "errorCode" ELSE 'other' END AS "errorCode",
          count(*)::int AS "count" FROM "agent_steps"
        WHERE "sessionId" = $1 AND "turnId" = $2 GROUP BY 1, 2 ORDER BY 1, 2`, [ids.sessionId, ids.turnId, SAFE_DIAGNOSTIC_ERROR_CODES]),
      progressQuery<{ depth: number; role: string; status: string; failureCode: string | null; structuredFailureCategory: string | null;
        executorResultStatus: string; attemptCountMax: number; nextAttemptAtPresent: boolean; count: number }>(`SELECT "depth",
          CASE WHEN "role" = 'scout' THEN "role" ELSE 'other' END AS "role",
          CASE WHEN "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed')
            THEN "status" ELSE 'other' END AS "status",
          CASE WHEN "failureReason" IS NULL THEN NULL WHEN "failureReason" = ANY($3::text[])
            THEN "failureReason" ELSE 'other' END AS "failureCode",
          CASE WHEN "result"->>'structuredOutputFailureCategory' IN
            ('missing_final_output', 'result_too_large', 'result_shape_invalid', 'evidence_binding_invalid')
            THEN "result"->>'structuredOutputFailureCategory' ELSE NULL END AS "structuredFailureCategory",
          CASE WHEN "result"->>'status' IN ('completed', 'failed') THEN "result"->>'status' ELSE 'other' END AS "executorResultStatus",
          max("attemptCount")::int AS "attemptCountMax", bool_or("nextAttemptAt" IS NOT NULL) AS "nextAttemptAtPresent",
          count(*)::int AS "count"
        FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2
        GROUP BY "depth", "role", "status", 4, 5, 6 ORDER BY "depth", "role", "status", 4, 5, 6`, [ids.sessionId, ids.turnId, SAFE_DIAGNOSTIC_ERROR_CODES]),
      progressQuery<{ status: string; errorCode: string | null; count: number }>(`SELECT CASE WHEN latest."status" IN
            ('started', 'streaming', 'completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user')
            THEN latest."status" ELSE 'other' END AS "status",
          CASE WHEN latest."errorCode" IS NULL THEN NULL WHEN latest."errorCode" = ANY($3::text[])
            THEN latest."errorCode" ELSE 'other' END AS "errorCode", count(*)::int AS "count"
        FROM (SELECT DISTINCT ON (task."id") step."status", step."errorCode" FROM "sub_agent_tasks" task
          JOIN "agent_steps" step ON step."taskId" = task."id" AND step."sessionId" = task."sessionId" AND step."turnId" = task."turnId"
          WHERE task."sessionId" = $1 AND task."turnId" = $2 AND task."depth" = 1 AND task."role" = 'scout'
          ORDER BY task."id", step."ordinal" DESC) latest GROUP BY 1, 2 ORDER BY 1, 2`, [ids.sessionId, ids.turnId, SAFE_DIAGNOSTIC_ERROR_CODES]),
      progressQuery<{ status: string; targetCount: string; suspended: boolean; consumed: boolean; count: number }>(`SELECT
          CASE WHEN "status" IN ('waiting', 'ready', 'timed_out', 'interrupted', 'closed') THEN "status" ELSE 'other' END AS "status",
          CASE WHEN jsonb_typeof("targetTaskIds") <> 'array' THEN 'invalid'
            WHEN jsonb_array_length("targetTaskIds") = 0 THEN 'zero' WHEN jsonb_array_length("targetTaskIds") = 1 THEN 'one'
            WHEN jsonb_array_length("targetTaskIds") = 2 THEN 'two' ELSE 'other' END AS "targetCount",
          ("suspendedAt" IS NOT NULL) AS "suspended", ("consumedAt" IS NOT NULL) AS "consumed", count(*)::int AS "count"
        FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2
        GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4`, [ids.sessionId, ids.turnId]),
      progressQuery<{ toolName: string; itemType: string; itemStatus: string; outcomeStatus: string | null; errorCode: string | null; count: number }>(`SELECT
          CASE WHEN COALESCE(call."content"->>'toolName', item."content"->>'toolName') IN
            ('agent.plan', 'agent.wait', 'jobs.discover', 'scout.delegate', 'scout.results', 'jobs.get', 'wait_subagents')
            THEN COALESCE(call."content"->>'toolName', item."content"->>'toolName') ELSE 'other' END AS "toolName",
          item."type" AS "itemType",
          CASE WHEN item."status" IN ('started', 'streaming', 'completed', 'failed', 'interrupted') THEN item."status" ELSE 'other' END AS "itemStatus",
          CASE WHEN COALESCE(CASE WHEN item."type" = 'tool_call' THEN item."content"->>'status'
            WHEN item."type" = 'tool_result' THEN item."content"->'output'->>'status' END, '')
              IN ('completed', 'failed', 'cancelled', 'waiting', 'ready', 'timed_out', 'interrupted', 'closed')
            THEN CASE WHEN item."type" = 'tool_call' THEN item."content"->>'status'
              WHEN item."type" = 'tool_result' THEN item."content"->'output'->>'status' END ELSE NULL END AS "outcomeStatus",
          CASE WHEN item."content"->>'errorCode' IS NULL THEN NULL WHEN item."content"->>'errorCode' = ANY($3::text[])
            THEN item."content"->>'errorCode' ELSE 'other' END AS "errorCode",
          count(*)::int AS "count"
        FROM "agent_items" AS item
        LEFT JOIN "agent_items" AS call ON item."type" = 'tool_result' AND call."sessionId" = item."sessionId"
          AND call."turnId" = item."turnId" AND call."taskId" = item."taskId" AND call."type" = 'tool_call'
          AND call."content"->>'toolCallId' = item."content"->>'toolCallId'
        WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."type" IN ('tool_call', 'tool_result')
        GROUP BY 1, 2, 3, 4, 5 ORDER BY 1, 2, 3, 4, 5`, [ids.sessionId, ids.turnId, SAFE_DIAGNOSTIC_ERROR_CODES]),
    ])
    const safeTaskGroups = tasks.rows.filter(row => row.role === "scout").map(({ depth, status, failureCode, structuredFailureCategory,
      executorResultStatus, attemptCountMax, nextAttemptAtPresent, count }) => ({
      tier: depth === 1 ? "parent_scout" : depth === 2 ? "depth_two_scout" : "other_scout", status, failureCode,
      structuredFailureCategory, executorResultStatus, attemptCountMax, nextAttemptAtPresent, count,
    }))
    const [acknowledgement, sourceEventChain, parentResumeProgress] = await Promise.all([
      readWaitAcknowledgementDiagnostic(ids), readSourceEventChainDiagnostic(ids), readParentResumeProgressDiagnostic(ids),
    ])
    return {
      observedPhases, fixtureFailure, waitResumeCommitFailures,
      turnStatus: turn.rows[0]?.status ?? "missing",
      graphRecordCount: graph.rows.length,
      graphNodeCount: graph.rows[0]?.nodeCount ?? 0,
      stepsByStatusAndErrorCode: steps.rows,
      latestParentStepByStatusAndErrorCode: parentSteps.rows,
      parentAndChildScoutStatuses: safeTaskGroups,
      waitsByStatusAndSuspended: waits.rows,
      toolOutcomes: tools.rows,
      waitAcknowledgement: acknowledgement,
      sourceEventChain,
      parentResumeProgress,
    }
  } catch {
    return { observedPhases, fixtureFailure, waitResumeCommitFailures, databaseDiagnosticAvailable: false }
  }
}

async function readParentResumeProgressDiagnostic(ids: FixtureIds) {
  type ProgressRow = {
    parentCount: number; parentStatus: string; parentAttemptClass: string; parentLeasePresent: boolean;
    parentFailureCode: string | null; parentResultStatus: string; parentRetryDisposition: string | null;
    structuredFailureCategory: string | null; waitCount: number; waitStatus: string;
    waitConsumed: boolean; waitSuspended: boolean; sourceStepPresent: boolean;
    sourceStepStatus: string; sourceStepScopeMatches: boolean; continuationStepCount: number;
    latestContinuationStatus: string; latestParentStepStatus: string; latestParentStepErrorCode: string | null;
    resumeStage: string;
  }
  try {
    const result = await progressQuery<ProgressRow>(`WITH parent_rows AS (
        SELECT task."id", task."status", task."attemptCount", task."leaseOwner", task."failureReason", task."result",
          task."sessionId", task."turnId"
        FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $1
        WHERE task."sessionId" = $2 AND task."turnId" = $3 AND task."depth" = 1 AND task."role" = 'scout'
      ), parent AS (
        SELECT * FROM parent_rows ORDER BY "id" LIMIT 1
      ), latest_wait AS (
        SELECT wait.* FROM parent JOIN "agent_wait_conditions" AS wait
          ON wait."parentTaskId" = parent."id" AND wait."sessionId" = parent."sessionId" AND wait."turnId" = parent."turnId"
        ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 1
      ), source_step AS (
        SELECT step."id", step."taskId", step."sessionId", step."turnId", step."attempt", step."ordinal", step."status"
        FROM latest_wait AS wait JOIN "agent_steps" AS step ON step."id" = wait."stepId"
      ), continuations AS (
        SELECT step."id", step."ordinal", step."status" FROM parent JOIN latest_wait AS wait ON true
        JOIN source_step AS source ON true
        JOIN "agent_steps" AS step ON step."taskId" = parent."id" AND step."sessionId" = parent."sessionId"
          AND step."turnId" = parent."turnId" AND step."attempt" = parent."attemptCount"
          AND step."ordinal" > source."ordinal"
        WHERE source."taskId" = parent."id" AND source."sessionId" = parent."sessionId" AND source."turnId" = parent."turnId"
      ), latest_parent_step AS (
        SELECT step."status", step."errorCode" FROM parent JOIN "agent_steps" AS step
          ON step."taskId" = parent."id" AND step."sessionId" = parent."sessionId" AND step."turnId" = parent."turnId"
          AND step."attempt" = parent."attemptCount"
        ORDER BY step."ordinal" DESC, step."id" DESC LIMIT 1
      )
      SELECT (SELECT count(*)::int FROM parent_rows) AS "parentCount",
        COALESCE((SELECT CASE WHEN "status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user', 'completed', 'failed', 'interrupted', 'cancelled', 'closed')
          THEN "status" ELSE 'other' END FROM parent), 'missing') AS "parentStatus",
        COALESCE((SELECT CASE WHEN "attemptCount" > 1 THEN 'retried' ELSE 'first' END FROM parent), 'missing') AS "parentAttemptClass",
        COALESCE((SELECT "leaseOwner" IS NOT NULL FROM parent), false) AS "parentLeasePresent",
        (SELECT CASE WHEN "failureReason" IS NULL THEN NULL WHEN "failureReason" = ANY($4::text[])
          THEN "failureReason" ELSE 'other' END FROM parent) AS "parentFailureCode",
        COALESCE((SELECT CASE WHEN "result"->>'status' IN ('completed', 'failed') THEN "result"->>'status' ELSE 'other' END FROM parent), 'missing') AS "parentResultStatus",
        (SELECT CASE WHEN "result"->>'retryDisposition' IN ('retryable', 'terminal') THEN "result"->>'retryDisposition' ELSE NULL END FROM parent) AS "parentRetryDisposition",
        (SELECT CASE WHEN "result"->>'structuredOutputFailureCategory' IN
            ('missing_final_output', 'result_too_large', 'result_shape_invalid', 'evidence_binding_invalid')
          THEN "result"->>'structuredOutputFailureCategory' ELSE NULL END FROM parent) AS "structuredFailureCategory",
        (SELECT count(*)::int FROM latest_wait) AS "waitCount",
        COALESCE((SELECT CASE WHEN "status" IN ('waiting', 'ready', 'timed_out', 'interrupted', 'closed') THEN "status" ELSE 'other' END FROM latest_wait), 'missing') AS "waitStatus",
        COALESCE((SELECT "consumedAt" IS NOT NULL FROM latest_wait), false) AS "waitConsumed",
        COALESCE((SELECT "suspendedAt" IS NOT NULL FROM latest_wait), false) AS "waitSuspended",
        EXISTS (SELECT 1 FROM source_step) AS "sourceStepPresent",
        COALESCE((SELECT CASE WHEN "status" IN ('started', 'streaming', 'completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user')
          THEN "status" ELSE 'other' END FROM source_step), 'missing') AS "sourceStepStatus",
        COALESCE((SELECT source."taskId" = parent."id" AND source."sessionId" = parent."sessionId" AND source."turnId" = parent."turnId"
          FROM source_step AS source JOIN parent ON true), false) AS "sourceStepScopeMatches",
        (SELECT count(*)::int FROM continuations) AS "continuationStepCount",
        COALESCE((SELECT CASE WHEN "status" IN ('started', 'streaming', 'completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user')
          THEN "status" ELSE 'other' END FROM continuations ORDER BY "ordinal" DESC, "id" DESC LIMIT 1), 'missing') AS "latestContinuationStatus",
        COALESCE((SELECT CASE WHEN "status" IN ('started', 'streaming', 'completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user')
          THEN "status" ELSE 'other' END FROM latest_parent_step), 'missing') AS "latestParentStepStatus",
        (SELECT CASE WHEN "errorCode" IS NULL THEN NULL WHEN "errorCode" = ANY($4::text[]) THEN "errorCode" ELSE 'other' END FROM latest_parent_step) AS "latestParentStepErrorCode",
        COALESCE((SELECT CASE
          WHEN parent."status" = 'failed' AND wait."consumedAt" IS NOT NULL THEN 'parent_failed_after_consumption'
          WHEN parent."status" = 'failed' AND wait."status" IN ('ready', 'timed_out') THEN 'parent_failed_before_consumption'
          WHEN parent."status" = 'failed' AND wait."suspendedAt" IS NOT NULL THEN 'parent_failed_while_suspended'
          WHEN wait."status" = 'waiting' AND wait."suspendedAt" IS NOT NULL THEN 'wait_suspended'
          WHEN wait."status" IN ('ready', 'timed_out') AND wait."consumedAt" IS NULL THEN 'wait_ready_unconsumed'
          WHEN wait."consumedAt" IS NOT NULL AND EXISTS (SELECT 1 FROM continuations) THEN 'continuation_started'
          WHEN wait."consumedAt" IS NOT NULL THEN 'wait_consumed_no_continuation'
          WHEN wait."status" IN ('interrupted', 'closed') THEN 'wait_terminal_without_consumption'
          ELSE 'other' END FROM parent JOIN latest_wait AS wait ON true),
          CASE WHEN EXISTS (SELECT 1 FROM parent) THEN 'wait_missing' ELSE 'parent_missing' END) AS "resumeStage"`,
    [ids.userId, ids.sessionId, ids.turnId, SAFE_DIAGNOSTIC_ERROR_CODES])
    return result.rows[0] ?? { available: false }
  } catch {
    return { available: false }
  }
}

async function readWaitAcknowledgementDiagnostic(ids: FixtureIds) {
  type AckRow = {
    parentCount: number; resolvedWaitCount: number; resumeCandidateCount: number; waitStatus: string;
    waitScopeOk: boolean; waitResultShapeOk: boolean;
    sourceStepCount: number; sourceStepStatus: string; sourceStepScopeOk: boolean; sourceAttemptOk: boolean;
    targetExpectedCount: number; targetBoundCount: number; targetLineageCount: number; targetTerminalCount: number;
    callCount: number; callInputMatches: boolean; resultCount: number; waitingResultShapeOk: boolean;
    continuationCount: number; firstContinuationAfterSourceReady: boolean;
    sourceEventKeyCount: number; sourceEventHeadersMatch: boolean; sourceEventSequenceOrdered: boolean;
  }
  try {
    const result = await progressQuery<AckRow>(`WITH parent AS (
        SELECT task."id", task."rootTaskId", task."attemptCount", task."sessionId", task."turnId"
        FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $1
        WHERE task."sessionId" = $2 AND task."turnId" = $3 AND task."depth" = 1 AND task."role" = 'scout'
      ), resolved_waits AS (
        SELECT wait.*, parent."rootTaskId" AS "parentRootTaskId", parent."attemptCount" AS "parentAttempt"
        FROM parent JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = parent."id"
          AND wait."sessionId" = parent."sessionId" AND wait."turnId" = parent."turnId"
        WHERE wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
      ), selected_wait AS (
        SELECT * FROM resolved_waits ORDER BY "createdAt" DESC, "id" DESC LIMIT 1
      ), source_step AS (
        SELECT wait.*, step."id" AS "sourceStepId", step."taskId" AS "sourceTaskId", step."sessionId" AS "sourceSessionId",
          step."turnId" AS "sourceTurnId", step."attempt" AS "sourceAttempt", step."ordinal" AS "sourceOrdinal",
          step."status" AS "sourceStepStatus"
        FROM selected_wait AS wait LEFT JOIN "agent_steps" AS step ON step."id" = wait."stepId"
      ), target_ids AS (
        SELECT wait."id" AS "waitId", wait."parentTaskId", wait."parentRootTaskId", wait."sessionId", wait."turnId", item."targetId"
        FROM selected_wait AS wait CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(wait."targetTaskIds") = 'array' THEN wait."targetTaskIds" ELSE '[]'::jsonb END
        ) AS item("targetId")
      ), target_rows AS (
        SELECT expected."targetId", task."id" AS "actualId", task."parentTaskId", task."rootTaskId", task."sessionId", task."turnId",
          task."status", session."userId" AS "actualUserId"
        FROM target_ids AS expected LEFT JOIN "sub_agent_tasks" AS task ON task."id" = expected."targetId"
        LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      ), calls AS (
        SELECT item."id", item."revision", item."phase", item."status", item."content", item."sessionId", item."turnId", item."taskId", item."stepId"
        FROM source_step AS source JOIN "agent_items" AS item ON item."sessionId" = source."sessionId"
          AND item."turnId" = source."turnId" AND item."taskId" = source."parentTaskId" AND item."stepId" = source."stepId"
          AND item."type" = 'tool_call' AND item."content"->>'toolName' = 'wait_subagents'
      ), first_call AS (
        SELECT * FROM calls ORDER BY "id" LIMIT 1
      ), results AS (
        SELECT item."id", item."revision", item."phase", item."status", item."content", item."sessionId", item."turnId", item."taskId", item."stepId"
        FROM first_call AS tool_call JOIN "agent_items" AS item ON item."sessionId" = tool_call."sessionId" AND item."turnId" = tool_call."turnId"
          AND item."taskId" = tool_call."taskId" AND item."stepId" = tool_call."stepId" AND item."type" = 'tool_result'
          AND item."content"->>'toolCallId' = tool_call."content"->>'toolCallId'
      ), first_result AS (
        SELECT * FROM results ORDER BY "id" LIMIT 1
      ), continuations AS (
        SELECT step."id", step."ordinal", step."status"
        FROM source_step AS source JOIN parent ON parent."id" = source."parentTaskId"
        JOIN "agent_steps" AS step ON step."sessionId" = source."sessionId" AND step."turnId" = source."turnId"
          AND step."taskId" = source."parentTaskId" AND step."attempt" = parent."attemptCount"
          AND step."ordinal" > source."sourceOrdinal"
        ORDER BY step."ordinal", step."id" LIMIT 2
      ), expected_events AS (
        SELECT parent."id" AS "parentId", source."sourceStepId", tool_call."id" AS "callItemId", tool_call."content"->>'toolCallId' AS "callId",
          outcome."id" AS "resultItemId", expected."rank", expected."key", expected."type", expected."itemId", expected."correlationId"
        FROM source_step AS source JOIN parent ON parent."id" = source."parentTaskId"
        JOIN first_call AS tool_call ON true LEFT JOIN first_result AS outcome ON true
        CROSS JOIN LATERAL (VALUES
          (1, 'task:' || parent."id" || ':event:item-started:' || tool_call."id", 'item.started', tool_call."id", source."sourceStepId"),
          (2, 'task:' || parent."id" || ':event:tool-started:' || (tool_call."content"->>'toolCallId'), 'tool_call.started', tool_call."id", tool_call."content"->>'toolCallId'),
          (3, 'task:' || parent."id" || ':event:tool-call-completed:' || (tool_call."content"->>'toolCallId') || ':' || tool_call."id" || ':1', 'item.completed', tool_call."id", tool_call."id"),
          (4, 'task:' || parent."id" || ':event:tool-finished:' || (tool_call."content"->>'toolCallId'), 'tool_call.completed', tool_call."id", tool_call."content"->>'toolCallId'),
          (5, 'task:' || parent."id" || ':event:item-started:' || outcome."id", 'item.started', outcome."id", source."sourceStepId"),
          (6, 'task:' || parent."id" || ':event:tool-result-completed:' || (tool_call."content"->>'toolCallId') || ':' || outcome."id" || ':1', 'item.completed', outcome."id", outcome."id")
        ) AS expected("rank", "key", "type", "itemId", "correlationId")
        WHERE tool_call."id" IS NOT NULL
      ), event_rows AS (
        SELECT expected."rank", expected."type" AS "expectedType", expected."itemId" AS "expectedItemId", expected."correlationId" AS "expectedCorrelationId",
          event."id", event."type", event."itemId", event."actor", event."correlationId", event."sequence"
        FROM expected_events AS expected LEFT JOIN "agent_events" AS event ON event."sessionId" = $2 AND event."turnId" = $3
          AND event."taskId" = expected."parentId" AND event."idempotencyKey" = expected."key"
      ), event_order AS (
        SELECT "rank", "id", "sequence", LAG("sequence") OVER (ORDER BY "rank") AS "previousSequence" FROM event_rows
      )
      SELECT
        (SELECT count(*)::int FROM parent) AS "parentCount",
        (SELECT count(*)::int FROM resolved_waits) AS "resolvedWaitCount",
        (SELECT count(*)::int FROM resolved_waits AS wait JOIN "agent_steps" AS step ON step."id" = wait."stepId"
          WHERE step."sessionId" = wait."sessionId" AND step."turnId" = wait."turnId" AND step."taskId" = wait."parentTaskId"
            AND step."attempt" = wait."parentAttempt" AND step."status" IN ('waiting_for_tool', 'completed'))::int AS "resumeCandidateCount",
        COALESCE((SELECT CASE WHEN "status" IN ('ready', 'timed_out') THEN "status" ELSE 'other' END FROM selected_wait), 'missing') AS "waitStatus",
        COALESCE((SELECT selected_wait."userId" = $1 AND selected_wait."sessionId" = $2 AND selected_wait."turnId" = $3
            AND selected_wait."parentTaskId" = parent."id" AND selected_wait."stepId" IS NOT NULL
            AND selected_wait."mode" IN ('any', 'all') AND selected_wait."suspendedAt" IS NOT NULL AND selected_wait."consumedAt" IS NULL
          FROM selected_wait JOIN parent ON parent."id" = selected_wait."parentTaskId"), false) AS "waitScopeOk",
        COALESCE((SELECT CASE WHEN jsonb_typeof("result") = 'object' THEN (SELECT count(*) = 2 FROM jsonb_object_keys("result"))
            AND "result" ? 'request' AND "result" ? 'outcome'
            AND CASE WHEN jsonb_typeof("result"->'request') = 'object' THEN (SELECT count(*) = 3 FROM jsonb_object_keys("result"->'request')) ELSE false END
            AND CASE WHEN jsonb_typeof("result"->'outcome') = 'object' THEN (SELECT count(*) = 6 FROM jsonb_object_keys("result"->'outcome')) ELSE false END
            ELSE false END FROM selected_wait), false) AS "waitResultShapeOk",
        (SELECT count("sourceStepId")::int FROM source_step) AS "sourceStepCount",
        COALESCE((SELECT CASE WHEN "sourceStepStatus" IN ('waiting_for_tool', 'completed', 'streaming', 'failed')
            THEN "sourceStepStatus" ELSE 'other' END FROM source_step), 'missing') AS "sourceStepStatus",
        COALESCE((SELECT "sourceStepId" = "stepId" AND "sourceTaskId" = "parentTaskId"
            AND "sourceSessionId" = "sessionId" AND "sourceTurnId" = "turnId"
          FROM source_step), false) AS "sourceStepScopeOk",
        COALESCE((SELECT "sourceAttempt" BETWEEN 1 AND "parentAttempt" AND "sourceOrdinal" >= 0 FROM source_step), false) AS "sourceAttemptOk",
        (SELECT count(*)::int FROM target_ids) AS "targetExpectedCount",
        (SELECT count("actualId")::int FROM target_rows) AS "targetBoundCount",
        (SELECT count(*)::int FROM target_rows WHERE "actualId" IS NOT NULL AND "parentTaskId" = (SELECT "parentTaskId" FROM selected_wait)
          AND "rootTaskId" = (SELECT "parentRootTaskId" FROM selected_wait) AND "sessionId" = $2 AND "turnId" = $3 AND "actualUserId" = $1) AS "targetLineageCount",
        (SELECT count(*)::int FROM target_rows WHERE "actualId" IS NOT NULL AND "status" IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')) AS "targetTerminalCount",
        (SELECT count(*)::int FROM calls) AS "callCount",
        COALESCE((SELECT CASE WHEN jsonb_typeof("content") = 'object' THEN (SELECT count(*) = 6 FROM jsonb_object_keys("content"))
            AND "status" = 'completed' AND "revision" = 1 AND "phase" IS NULL
            AND "content"->>'status' = 'completed' AND "content"->>'errorCode' IS NULL
            AND CASE WHEN jsonb_typeof("content"->'input') = 'object' THEN (SELECT count(*) = 4 FROM jsonb_object_keys("content"->'input')) ELSE false END
            AND "content"->'input'->>'idempotencyKey' = (SELECT "idempotencyKey" FROM selected_wait)
            AND "content"->'input'->>'mode' = (SELECT "mode" FROM selected_wait)
            AND "content"->'input'->>'timeoutMs' = (SELECT "result"->'request'->>'timeoutMs' FROM selected_wait)
            AND ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof("content"->'input'->'taskIds') = 'array'
              THEN "content"->'input'->'taskIds' ELSE '[]'::jsonb END) ORDER BY 1)
              = ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof((SELECT "targetTaskIds" FROM selected_wait)) = 'array'
                THEN (SELECT "targetTaskIds" FROM selected_wait) ELSE '[]'::jsonb END) ORDER BY 1)
          ELSE false END FROM first_call), false) AS "callInputMatches",
        (SELECT count(*)::int FROM results) AS "resultCount",
        COALESCE((SELECT CASE WHEN jsonb_typeof("content") = 'object' THEN (SELECT count(*) = 3 FROM jsonb_object_keys("content"))
            AND "status" = 'completed' AND "revision" = 1 AND "phase" IS NULL
            AND "content"->>'errorCode' IS NULL AND "content"->>'toolCallId' = (SELECT "content"->>'toolCallId' FROM first_call)
            AND CASE WHEN jsonb_typeof("content"->'output') = 'object' THEN (SELECT count(*) = 6 FROM jsonb_object_keys("content"->'output')) ELSE false END
            AND "content"->'output'->>'waitId' = (SELECT "id" FROM selected_wait)
            AND "content"->'output'->>'status' = 'waiting'
            AND jsonb_typeof("content"->'output'->'matchedTaskIds') = 'array'
            AND jsonb_array_length("content"->'output'->'matchedTaskIds') = 0
            AND ARRAY(SELECT item->>'taskId' FROM jsonb_array_elements(CASE WHEN jsonb_typeof("content"->'output'->'tasks') = 'array'
              THEN "content"->'output'->'tasks' ELSE '[]'::jsonb END) AS task(item) ORDER BY 1)
              = ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof((SELECT "targetTaskIds" FROM selected_wait)) = 'array'
                THEN (SELECT "targetTaskIds" FROM selected_wait) ELSE '[]'::jsonb END) ORDER BY 1)
            AND ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof("content"->'output'->'taskIds') = 'array'
              THEN "content"->'output'->'taskIds' ELSE '[]'::jsonb END) ORDER BY 1)
              = ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof((SELECT "targetTaskIds" FROM selected_wait)) = 'array'
                THEN (SELECT "targetTaskIds" FROM selected_wait) ELSE '[]'::jsonb END) ORDER BY 1)
          ELSE false END FROM first_result), false) AS "waitingResultShapeOk",
        (SELECT count(*)::int FROM continuations) AS "continuationCount",
        COALESCE((SELECT "status" = 'streaming' AND "ordinal" > (SELECT "sourceOrdinal" FROM source_step)
          FROM continuations ORDER BY "ordinal", "id" LIMIT 1), false) AS "firstContinuationAfterSourceReady",
        (SELECT count("id")::int FROM event_rows) AS "sourceEventKeyCount",
        COALESCE((SELECT count("id") = 6 AND bool_and("actor" = 'subagent' AND "type" = "expectedType"
            AND "itemId" = "expectedItemId" AND "correlationId" = "expectedCorrelationId") FROM event_rows), false) AS "sourceEventHeadersMatch",
        COALESCE((SELECT count("id") = 6 AND bool_and("sequence" IS NOT NULL)
            AND bool_and("previousSequence" IS NULL OR "sequence" > "previousSequence") FROM event_order), false) AS "sourceEventSequenceOrdered"`,
      [ids.userId, ids.sessionId, ids.turnId])
    const row = result.rows[0]
    if (!row) return { available: false }
    return { available: true, ...row }
  } catch {
    return { available: false }
  }
}

async function readSourceEventChainDiagnostic(ids: FixtureIds) {
  type ContextRow = {
    parentTaskId: string; sourceStepId: string; callItemId: string; callId: string; callContent: unknown;
    resultItemId: string | null; resultContent: unknown;
  }
  type EventRow = {
    id: string; itemId: string | null; type: string; actor: string; correlationId: string; causationId: string | null;
    sequence: string | number; idempotencyKey: string | null; payload: unknown;
  }
  const unavailable = { available: false }
  try {
    const contextResult = await progressQuery<ContextRow>(`WITH parent AS (
        SELECT task."id", task."sessionId", task."turnId" FROM "sub_agent_tasks" AS task
        JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $1
        WHERE task."sessionId" = $2 AND task."turnId" = $3 AND task."depth" = 1 AND task."role" = 'scout'
      ), selected_wait AS (
        SELECT wait."id", wait."parentTaskId", wait."sessionId", wait."turnId", wait."stepId"
        FROM parent JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = parent."id"
          AND wait."sessionId" = parent."sessionId" AND wait."turnId" = parent."turnId"
        WHERE wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NULL
        ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 1
      ), source_call AS (
        SELECT item."id", item."content", item."sessionId", item."turnId", item."taskId", item."stepId"
        FROM selected_wait AS wait JOIN "agent_items" AS item ON item."sessionId" = wait."sessionId"
          AND item."turnId" = wait."turnId" AND item."taskId" = wait."parentTaskId" AND item."stepId" = wait."stepId"
          AND item."type" = 'tool_call' AND item."content"->>'toolName' = 'wait_subagents'
        ORDER BY item."createdAt" DESC, item."id" DESC LIMIT 1
      ), source_result AS (
        SELECT item."id", item."content" FROM source_call AS call JOIN "agent_items" AS item
          ON item."sessionId" = call."sessionId" AND item."turnId" = call."turnId" AND item."taskId" = call."taskId"
          AND item."stepId" = call."stepId" AND item."type" = 'tool_result'
          AND item."content"->>'toolCallId' = call."content"->>'toolCallId'
        ORDER BY item."createdAt" DESC, item."id" DESC LIMIT 1
      )
      SELECT wait."parentTaskId" AS "parentTaskId", wait."stepId" AS "sourceStepId", call."id" AS "callItemId",
        call."content"->>'toolCallId' AS "callId", call."content" AS "callContent",
        outcome."id" AS "resultItemId", outcome."content" AS "resultContent"
      FROM selected_wait AS wait CROSS JOIN source_call AS call LEFT JOIN source_result AS outcome ON true`,
      [ids.userId, ids.sessionId, ids.turnId])
    const context = contextResult.rows[0]
    if (!context || !context.parentTaskId || !context.sourceStepId || !context.callItemId || !context.callId) {
      return { available: true, contextFound: false }
    }

    const keys = [
      `task:${context.parentTaskId}:event:item-started:${context.callItemId}`,
      `task:${context.parentTaskId}:event:tool-started:${context.callId}`,
      `task:${context.parentTaskId}:event:tool-call-completed:${context.callId}:${context.callItemId}:1`,
      `task:${context.parentTaskId}:event:tool-finished:${context.callId}`,
      `task:${context.parentTaskId}:event:item-started:${context.resultItemId}`,
      `task:${context.parentTaskId}:event:tool-result-completed:${context.callId}:${context.resultItemId}:1`,
    ]
    const relatedResult = await progressQuery<EventRow>(`SELECT "id", "itemId", "type", "actor", "correlationId", "causationId",
        "sequence", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
        AND ("itemId" = $4 OR "correlationId" = $5 OR "itemId" = $6 OR "correlationId" = $6 OR "idempotencyKey" = ANY($7::text[]))
      ORDER BY "sequence"`, [ids.sessionId, ids.turnId, context.parentTaskId, context.callItemId, context.callId, context.resultItemId, keys])
    const related = relatedResult.rows
    const byRank = keys.map(key => related.filter(row => row.idempotencyKey === key))
    const events = byRank.map(rows => rows.length === 1 ? rows[0] : undefined)
    const [itemStart, callStart, callComplete, toolComplete, resultStart, resultComplete] = events
    const callContent = context.callContent
    const resultContent = context.resultContent
    const rawCallCompletion = { itemId: context.callItemId, status: "completed", content: callContent }
    const projectedCallCompletion = projectWaitCallCompletionPayload(rawCallCompletion, context.callItemId)
    const expectedPayloads = [
      { itemId: context.callItemId, type: "tool_call", phase: null },
      { toolCallId: context.callId, toolName: "wait_subagents", taskId: context.parentTaskId },
      null,
      { toolCallId: context.callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: context.parentTaskId },
      { itemId: context.resultItemId, type: "tool_result", phase: null },
      { itemId: context.resultItemId, status: "completed", content: resultContent },
    ]
    const expectedHeaders = [
      { type: "item.started", itemId: context.callItemId, correlationId: context.sourceStepId },
      { type: "tool_call.started", itemId: context.callItemId, correlationId: context.callId },
      { type: "item.completed", itemId: context.callItemId, correlationId: context.callItemId },
      { type: "tool_call.completed", itemId: context.callItemId, correlationId: context.callId },
      { type: "item.started", itemId: context.resultItemId, correlationId: context.sourceStepId },
      { type: "item.completed", itemId: context.resultItemId, correlationId: context.resultItemId },
    ]
    const eventHeaderMatches = (event: EventRow | undefined, index: number) => !!event && event.actor === "subagent"
      && event.idempotencyKey === keys[index] && event.type === expectedHeaders[index]!.type
      && event.itemId === expectedHeaders[index]!.itemId && event.correlationId === expectedHeaders[index]!.correlationId
    const eventPayloadMatches = (event: EventRow | undefined, index: number) => !!event && (index === 2
      ? isDeepStrictEqual(event.payload, rawCallCompletion) || isDeepStrictEqual(event.payload, projectedCallCompletion)
      : isDeepStrictEqual(event.payload, expectedPayloads[index]))
    const callCompletionRawMatches = !!callComplete && isDeepStrictEqual(callComplete.payload, rawCallCompletion)
    const callCompletionProjectedMatches = !!callComplete && isDeepStrictEqual(callComplete.payload, projectedCallCompletion)
    const eventCountsByRank = {
      callItemStarted: byRank[0]!.length, waitCallStarted: byRank[1]!.length, waitCallCompleted: byRank[2]!.length,
      waitToolCompleted: byRank[3]!.length, resultItemStarted: byRank[4]!.length, resultItemCompleted: byRank[5]!.length,
    }
    const expectedEventIds = events.flatMap(event => event ? [event.id] : [])
    const firstEvent = itemStart
    const predecessorDiagnostic = firstEvent ? await progressQuery<{ predecessorExists: boolean; predecessorBeforeItemStart: boolean }>(`SELECT
        EXISTS (SELECT 1 FROM "agent_events" AS previous WHERE previous."sessionId" = $1 AND previous."turnId" = $2
          AND previous."taskId" = $3 AND previous."id" = $4 AND previous."actor" = 'subagent'
          AND (previous."correlationId" = $5 OR EXISTS (SELECT 1 FROM "agent_items" AS source
            WHERE source."id" = previous."itemId" AND source."sessionId" = $1 AND source."turnId" = $2
              AND source."taskId" = $3 AND source."stepId" = $5))) AS "predecessorExists",
        EXISTS (SELECT 1 FROM "agent_events" AS previous WHERE previous."sessionId" = $1 AND previous."turnId" = $2
          AND previous."taskId" = $3 AND previous."id" = $4 AND previous."actor" = 'subagent'
          AND (previous."correlationId" = $5 OR EXISTS (SELECT 1 FROM "agent_items" AS source
            WHERE source."id" = previous."itemId" AND source."sessionId" = $1 AND source."turnId" = $2
              AND source."taskId" = $3 AND source."stepId" = $5))
          AND previous."sequence" < (SELECT start_event."sequence" FROM "agent_events" AS start_event
            WHERE start_event."sessionId" = $1 AND start_event."turnId" = $2 AND start_event."taskId" = $3
              AND start_event."idempotencyKey" = $6)) AS "predecessorBeforeItemStart"`,
        [ids.sessionId, ids.turnId, context.parentTaskId, firstEvent.causationId, context.sourceStepId, keys[0]])
      : { rows: [], rowCount: 0 }
    const predecessor = predecessorDiagnostic.rows[0]
    const causationSourceEventIds = events.slice(0, 5).flatMap(event => event ? [event.id] : [])
    const extraCausalResult = await progressQuery<{ extraCausalEventCount: number }>(`SELECT count(*)::int AS "extraCausalEventCount"
      FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
        AND "causationId" = ANY($4::text[]) AND "id" <> ALL($5::text[])`,
      [ids.sessionId, ids.turnId, context.parentTaskId, causationSourceEventIds, expectedEventIds])
    const expectedEventIdSet = new Set(expectedEventIds)
    const extraRelatedRows = related.filter(row => !expectedEventIdSet.has(row.id))
    const extraRelatedGroups = new Map<string, {
      eventType: string; actor: string; matchesCallItem: boolean; matchesCallIdCorrelation: boolean;
      matchesResultItem: boolean; matchesResultCorrelation: boolean; expectedLifecycleKey: boolean;
      causedByExpectedLifecycleEvent: boolean; waitLifecycleType: boolean; count: number;
    }>()
    for (const row of extraRelatedRows) {
      const eventType = SAFE_RELATED_EVENT_TYPES.has(row.type) ? row.type : "other"
      const actor = SAFE_EVENT_ACTORS.has(row.actor) ? row.actor : "other"
      const matchesCallItem = row.itemId === context.callItemId
      const matchesCallIdCorrelation = row.correlationId === context.callId
      const matchesResultItem = row.itemId === context.resultItemId
      const matchesResultCorrelation = row.correlationId === context.resultItemId
      const expectedLifecycleKey = typeof row.idempotencyKey === "string" && keys.includes(row.idempotencyKey)
      const causedByExpectedLifecycleEvent = causationSourceEventIds.includes(row.causationId ?? "")
      const waitLifecycleType = SAFE_WAIT_LIFECYCLE_TYPES.has(eventType)
      const groupKey = JSON.stringify([eventType, actor, matchesCallItem, matchesCallIdCorrelation, matchesResultItem,
        matchesResultCorrelation, expectedLifecycleKey, causedByExpectedLifecycleEvent, waitLifecycleType])
      const group = extraRelatedGroups.get(groupKey)
      if (group) group.count += 1
      else extraRelatedGroups.set(groupKey, { eventType, actor, matchesCallItem, matchesCallIdCorrelation, matchesResultItem,
        matchesResultCorrelation, expectedLifecycleKey, causedByExpectedLifecycleEvent, waitLifecycleType, count: 1 })
    }
    const extraRelatedEventCount = extraRelatedRows.length
    return {
      available: true,
      contextFound: true,
      expectedEventCount: events.filter(Boolean).length,
      eventIdempotencyKeyCounts: eventCountsByRank,
      eventHeadersMatch: {
        callItemStarted: eventHeaderMatches(itemStart, 0), waitCallStarted: eventHeaderMatches(callStart, 1),
        waitCallCompleted: eventHeaderMatches(callComplete, 2), waitToolCompleted: eventHeaderMatches(toolComplete, 3),
        resultItemStarted: eventHeaderMatches(resultStart, 4), resultItemCompleted: eventHeaderMatches(resultComplete, 5),
      },
      eventCausationMatches: {
        callItemStartedHasScopedPriorEvent: !!predecessor?.predecessorExists && !!predecessor?.predecessorBeforeItemStart,
        waitCallStartedFollowsCallItemStarted: !!itemStart && !!callStart && callStart.causationId === itemStart.id,
        waitCallCompletedFollowsWaitCallStarted: !!callStart && !!callComplete && callComplete.causationId === callStart.id,
        waitToolCompletedFollowsWaitCallCompleted: !!callComplete && !!toolComplete && toolComplete.causationId === callComplete.id,
        resultItemStartedFollowsWaitToolCompleted: !!toolComplete && !!resultStart && resultStart.causationId === toolComplete.id,
        resultItemCompletedFollowsResultItemStarted: !!resultStart && !!resultComplete && resultComplete.causationId === resultStart.id,
      },
      predecessorExists: !!predecessor?.predecessorExists,
      predecessorBeforeItemStart: !!predecessor?.predecessorBeforeItemStart,
      eventSequenceOrdered: events.length === 6 && events.every(Boolean) && events.slice(1).every((event, index) =>
        BigInt(String(event!.sequence)) > BigInt(String(events[index]!.sequence))),
      eventPayloadsMatch: {
        callItemStarted: eventPayloadMatches(itemStart, 0), waitCallStarted: eventPayloadMatches(callStart, 1),
        waitCallCompleted: eventPayloadMatches(callComplete, 2), waitToolCompleted: eventPayloadMatches(toolComplete, 3),
        resultItemStarted: eventPayloadMatches(resultStart, 4), resultItemCompleted: eventPayloadMatches(resultComplete, 5),
      },
      callCompletionRawMatches,
      callCompletionProjectedMatches,
      extraRelatedEventCount,
      extraRelatedEventGroups: [...extraRelatedGroups.values()],
      extraCausalEventCount: extraCausalResult.rows[0]?.extraCausalEventCount ?? 0,
    }
  } catch {
    return unavailable
  }
}

async function waitForMainMarker(ids: FixtureIds, worker: FixtureProcess, marker: string, timeoutMs: number): Promise<void> {
  try {
    await worker.waitForLine(marker, timeoutMs)
  } catch (error) {
    const diagnostic = await readMainProgressDiagnostic(ids, worker.output)
    console.info(`P1143_MAIN_PROGRESS_DIAGNOSTIC:${JSON.stringify({ waitingFor: marker, ...diagnostic })}`)
    throw error
  }
}

function disposableUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) {
    if (process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true") throw new Error("Required disposable PostgreSQL URL is missing")
    return null
  }
  const url = new URL(value)
  if (process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true" || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.username !== "nested_fixture"
    || url.password !== "nested_fixture_only" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Nested Scout delegation requires the dedicated disposable PostgreSQL service")
  }
  const redis = new URL(process.env.AGENT_TURN_REDIS_TEST_URL ?? "")
  if (process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true" || redis.protocol !== "redis:"
    || redis.hostname !== "127.0.0.1" || redis.port !== "6379" || redis.pathname !== "/15"
    || redis.username || redis.password || redis.search || redis.hash || process.env.REDIS_URL !== redis.href) {
    throw new Error("Nested Scout delegation requires the dedicated disposable Redis service")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
let pool: Pool

function launch(mode: "park" | "crash-child" | "resume", ids: FixtureIds): FixtureProcess {
  const child = spawn(process.execPath, ["--import", "tsx", PROCESS_FIXTURE, mode, JSON.stringify(ids)], {
    cwd: process.cwd(), env: { ...process.env, BULLMQ_STALLED_INTERVAL_MS: "30000" }, stdio: ["pipe", "pipe", "pipe"],
  })
  const output: string[] = []
  let buffer = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""
    output.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  child.stderr?.on("data", (chunk: string) => {
    const text = String(chunk)
    const failure = text.match(/P1143_FIXTURE_FAILURE:(p1143_[a-z_]+|redacted)/)
    if (failure) output.push(`P1143_FIXTURE_FAILURE:${failure[1] === "redacted" || SAFE_DIAGNOSTIC_ERROR_CODES.includes(failure[1] as typeof SAFE_DIAGNOSTIC_ERROR_CODES[number]) ? failure[1] : "redacted"}`)
  })
  return {
    child, output,
    async waitForLine(marker, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (output.includes(marker)) return
        const fixtureFailure = output.find(isSafeFixtureFailure)
        if (fixtureFailure) throw new Error(`Worker fixture failed before ${marker}: ${fixtureFailure}`)
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker fixture exited before ${marker}`)
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      throw new Error(`Worker fixture did not reach ${marker}`)
    },
  }
}

async function waitForExpiredCrashLease(ids: FixtureIds, parentTaskId: string, childTaskId: string, ownerId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await progressQuery<{ status: string; leaseOwner: string | null; attemptCount: number; expired: boolean;
      parentStatus: string; suspendedWaitPresent: boolean }>(`SELECT child."status", child."leaseOwner", child."attemptCount",
        child."leaseExpiresAt" <= clock_timestamp() AS "expired", parent."status" AS "parentStatus",
        EXISTS (SELECT 1 FROM "agent_wait_conditions" AS wait WHERE wait."parentTaskId" = parent."id"
          AND wait."sessionId" = child."sessionId" AND wait."turnId" = child."turnId"
          AND wait."status" IN ('waiting', 'timed_out') AND wait."suspendedAt" IS NOT NULL) AS "suspendedWaitPresent"
      FROM "sub_agent_tasks" AS child JOIN "sub_agent_tasks" AS parent ON parent."id" = child."parentTaskId"
        AND parent."sessionId" = child."sessionId" AND parent."turnId" = child."turnId"
      WHERE child."id" = $1 AND child."sessionId" = $2 AND parent."id" = $3 AND child."depth" = 2
        AND child."role" = 'scout' AND child."taskType" = 'job_discovery'`, [childTaskId, ids.sessionId, parentTaskId])
    const row = result.rows[0]
    if (row?.status === "running" && row.leaseOwner === ownerId && row.attemptCount === 1
      && row.expired && ["waiting", "queued"].includes(row.parentStatus) && row.suspendedWaitPresent) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("Nested Scout child lease did not expire while its durable wait remained suspended")
}

async function expireSuspendedWait(ids: FixtureIds, parentTaskId: string): Promise<void> {
  const expired = await progressQuery<{ id: string }>(`UPDATE "agent_wait_conditions" SET "deadlineAt" = clock_timestamp() - interval '1 millisecond',
      "updatedAt" = clock_timestamp()
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "status" = 'waiting'
      AND "suspendedAt" IS NOT NULL AND "consumedAt" IS NULL RETURNING "id"`, [ids.sessionId, ids.turnId, parentTaskId])
  if (expired.rowCount === 1) return
  const existing = await progressQuery<{ status: string; consumedAt: Date | null }>(`SELECT "status", "consumedAt" FROM "agent_wait_conditions"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "suspendedAt" IS NOT NULL
    ORDER BY "createdAt" DESC LIMIT 1`, [ids.sessionId, ids.turnId, parentTaskId])
  if (existing.rows[0]?.status !== "timed_out" || existing.rows[0]?.consumedAt !== null) throw new Error("Expected one suspended wait to expire")
}

async function waitForTimedOutParentWait(ids: FixtureIds, parentTaskId: string, waitId: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await progressQuery<{ status: string; parentStatus: string }>(`SELECT wait."status", parent."status" AS "parentStatus"
      FROM "agent_wait_conditions" wait JOIN "sub_agent_tasks" parent ON parent."id" = wait."parentTaskId"
        AND parent."sessionId" = wait."sessionId" AND parent."turnId" = wait."turnId"
      WHERE wait."id" = $1 AND wait."sessionId" = $2 AND wait."turnId" = $3 AND wait."parentTaskId" = $4
        AND wait."suspendedAt" IS NOT NULL`, [waitId, ids.sessionId, ids.turnId, parentTaskId])
    if (result.rows[0]?.status === "timed_out" && result.rows[0]?.parentStatus === "queued") return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("Suspended child wait did not time out and queue its parent")
}

async function waitForFinalWaitAfterTimeout(ids: FixtureIds, parentTaskId: string, initialWaitId: string, timeoutMs: number, worker: FixtureProcess) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await progressQuery<{ id: string; status: string; stepId: string; idempotencyKey: string; targetTaskIds: unknown;
      suspendedAt: Date | null; consumedAt: Date | null }>(`SELECT "id", "status", "stepId", "idempotencyKey", "targetTaskIds", "suspendedAt", "consumedAt"
      FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3
      ORDER BY "createdAt", "id"`, [ids.sessionId, ids.turnId, parentTaskId])
    const oldWait = result.rows.find(row => row.id === initialWaitId)
    const nextWait = result.rows.find(row => row.id !== initialWaitId)
    if (result.rows.length >= 2 && oldWait?.status === "timed_out" && oldWait.consumedAt instanceof Date
      && nextWait?.suspendedAt instanceof Date && ["waiting", "ready"].includes(nextWait.status)) return result.rows
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const diagnostic = await readMainProgressDiagnostic(ids, worker.output)
  console.info(`P1143_FINAL_WAIT_PROGRESS_DIAGNOSTIC:${JSON.stringify({ waitingFor: "second_suspended_final_wait", ...diagnostic })}`)
  throw new Error("Resumed parent did not register a second suspended final wait")
}

async function waitForReclaimedCrashChild(ids: FixtureIds, childTaskId: string, previousOwnerId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await progressQuery<{ status: string; attemptCount: number; leaseOwner: string | null; dispatchOwner: string;
      dispatchAttemptCount: number; dispatchPublished: boolean }>(`SELECT task."status", task."attemptCount", task."leaseOwner",
        dispatch."payload"->>'ownerId' AS "dispatchOwner", dispatch."attemptCount" AS "dispatchAttemptCount",
        dispatch."publishedAt" IS NOT NULL AS "dispatchPublished"
      FROM "sub_agent_tasks" AS task JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
        AND dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."depth" = 2
        AND task."role" = 'scout' AND task."taskType" = 'job_discovery'`, [childTaskId, ids.sessionId])
    const row = result.rows[0]
    if (row?.attemptCount === 2 && (row.status === "running" || row.status === "completed")
      && row.leaseOwner !== previousOwnerId && row.dispatchOwner !== previousOwnerId
      && row.dispatchAttemptCount > 1 && row.dispatchPublished
      && (row.status === "completed" ? row.leaseOwner === null : row.leaseOwner === row.dispatchOwner)) return row.dispatchOwner
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error("Nested Scout child was not safely reclaimed under a new owner")
}

function waitForClose(child: ChildProcess, timeoutMs = 15_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Worker fixture did not close")), timeoutMs)
    child.once("close", () => { clearTimeout(timer); resolve() })
  })
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = waitForClose(child)
  child.kill("SIGKILL")
  await closed
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = waitForClose(child)
  child.stdin?.write("shutdown\n")
  try { await closed } catch { await killAndWait(child) }
}

async function seed(ids: FixtureIds): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [ids.userId, `${ids.userId}@example.invalid`])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Read matching Dublin engineering roles', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
  await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input",
    "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, 'queued', 'user', $4::jsonb, $5::jsonb, '{}'::jsonb, $6::jsonb, CURRENT_TIMESTAMP)`, [
    ids.turnId, ids.sessionId, ids.userId,
    JSON.stringify({ goal: "Find matching Dublin engineering roles" }),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }), JSON.stringify({ limits: { maxSteps: 32, maxToolCalls: 40 } }),
  ])
  for (const [jobId, company, source] of [
    [ids.alphaJobId, "Fixture Alpha", "greenhouse"], [ids.betaJobId, "Fixture Beta", "greenhouse"], [ids.foreignJobId, "Fixture Other Source", "lever"],
  ] as const) {
    await pool.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, $3, 'Software Engineer', 'Dublin', 'saved', $4, 'Build reliable software', $5, CURRENT_TIMESTAMP)`,
    [jobId, ids.userId, company, `https://jobs.example.invalid/${jobId}`, source])
  }
}

async function seedResumeLockRows(ids: FixtureIds, rootId: string, childId: string, ownerId: string): Promise<void> {
  await seed(ids)
  await pool.query(`UPDATE "agent_turns" SET "status" = 'in_progress' WHERE "id" = $1 AND "sessionId" = $2`, [ids.turnId, ids.sessionId])
  const columns = `("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")`
  await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES
    ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'root', '{}'::jsonb, '[]'::jsonb, '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 0, 3, CURRENT_TIMESTAMP)`,
  [rootId, ids.sessionId, ids.turnId])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1 AND "sessionId" = $2`, [rootId, ids.sessionId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2 AND "sessionId" = $3`, [rootId, ids.turnId, ids.sessionId])
  await pool.query(`INSERT INTO "sub_agent_tasks" ${columns} VALUES
    ($1, $2, $3, $4, $4, $5, 1, 'scout', 'research', 'running', 'resume lock fixture', '[]'::jsonb, '[]'::jsonb, '["jobs.search"]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP)`,
  [childId, ids.sessionId, ids.turnId, rootId, `/${rootId}/${childId}`])
  await pool.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $1, "leaseExpiresAt" = clock_timestamp() + interval '2 minutes'
    WHERE "id" = $2 AND "sessionId" = $3`, [ownerId, childId, ids.sessionId])
}

async function waitForLockWait(applicationName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await progressQuery<{ waiting: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
      WHERE "application_name" = $1 AND "state" = 'active' AND "wait_event_type" = 'Lock' AND "query" LIKE '%FOR SHARE%') AS "waiting"`, [applicationName])
    if (result.rows[0]?.waiting) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Child resume did not block on the Session lock barrier")
}
async function assertChildResumeLockOrder(): Promise<void> {
  const suffix = randomUUID()
  const ids: FixtureIds = { userId: `resume-lock-user-${suffix}`, sessionId: `resume-lock-session-${suffix}`,
    turnId: `resume-lock-turn-${suffix}`, alphaJobId: randomUUID(), betaJobId: randomUUID(), foreignJobId: randomUUID() }
  const rootId = `resume-lock-root-${suffix}`, childId = `resume-lock-child-${suffix}`, ownerId = `resume-lock-owner-${suffix}`
  const applicationName = `child-resume-lock-${suffix}`
  let writer: PoolClient | undefined
  let resumePool: Pool | undefined
  let resumeOutcome: Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> | undefined
  try {
    await seedResumeLockRows(ids, rootId, childId, ownerId)
    writer = await pool.connect()
    await writer.query("BEGIN")
    await writer.query("SET LOCAL lock_timeout = '3s'")
    const sessionLock = await writer.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [ids.sessionId, ids.userId])
    expect(sessionLock.rows).toHaveLength(1)
    const resumeUrl = new URL(databaseUrl!)
    resumeUrl.searchParams.set("application_name", applicationName)
    resumePool = new Pool({ connectionString: resumeUrl.toString(), max: 1 })
    const lease: SubagentLease = {
      id: childId, userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, rootTaskId: rootId, parentTaskId: rootId,
      path: `/${rootId}/${childId}`, depth: 1, role: "scout", taskType: "research", status: "running", goal: "Resume lock fixture",
      constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {},
      modelProfileSnapshot: {}, result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: ownerId,
      leaseExpiresAt: new Date(Date.now() + 120_000), interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {},
      ownerId, signal: new AbortController().signal,
    }
    resumeOutcome = loadChildAttemptResume(resumePool, lease).then(
      value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
    await waitForLockWait(applicationName, 5_000)
    const turnLock = await writer.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
      [ids.turnId, ids.sessionId, ids.userId])
    const rootLock = await writer.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
      [rootId, ids.sessionId, ids.turnId])
    const childLock = await writer.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
      [childId, ids.sessionId, ids.turnId, rootId])
    expect(turnLock.rows).toHaveLength(1)
    expect(rootLock.rows).toHaveLength(1)
    expect(childLock.rows).toHaveLength(1)
    await writer.query("COMMIT")
    writer.release()
    writer = undefined
    const resumed = await resumeOutcome
    if (!resumed.ok) throw new Error("Child resume loader failed under ordered lock barrier")
    expect(resumed.value).toBeUndefined()
  } finally {
    if (writer) { await writer.query("ROLLBACK").catch(() => undefined); writer.release() }
    if (resumeOutcome) await resumeOutcome
    if (resumePool) await resumePool.end()
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId])
  }
}

describePg("nested Scout delegation: disposable Worker and PostgreSQL", () => {
  beforeAll(() => { pool = new Pool({ connectionString: databaseUrl!, max: 8 }) })
  afterAll(async () => { await pool.end() })


  it("reclaims a claimed Scout child after a pre-model Worker crash and joins source-bound children across Worker restart", async () => {
    const suffix = randomUUID()
    const ids: FixtureIds = {
      userId: `nested-scout-user-${suffix}`, sessionId: `nested-scout-session-${suffix}`,
      turnId: `nested-scout-turn-${suffix}`, alphaJobId: randomUUID(),
      betaJobId: randomUUID(), foreignJobId: randomUUID(),
    }
    let first: FixtureProcess | undefined, crashing: FixtureProcess | undefined, restarted: FixtureProcess | undefined
    try {
      await assertChildResumeLockOrder()
      await seed(ids)
      first = launch("park", ids)
      await waitForMainMarker(ids, first, "P1143_SOURCE_ESCALATION_REJECTED", 45_000)
      await waitForMainMarker(ids, first, "P1143_CLOSED_STEP_REPLAY_REJECTED", 45_000)
      await waitForMainMarker(ids, first, "P1143_FOREIGN_CALL_STEP_REJECTED", 45_000)
      await waitForMainMarker(ids, first, "P1143_PARENT_WAITING", 45_000)

      const parent = await pool.query<{ id: string; rootTaskId: string; status: string; leaseOwner: string | null }>(
        `SELECT "id", "rootTaskId", "status", "leaseOwner" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "parentTaskId" = "rootTaskId" AND "depth" = 1 AND "role" = 'scout'`, [ids.sessionId])
      expect(parent.rows).toHaveLength(1)
      expect(parent.rows[0]).toMatchObject({ status: "waiting", leaseOwner: null })
      const deniedSource = await pool.query<{ status: string; outcomeStatus: string; errorCode: string | null; input: unknown;
        resultCount: number; resultItemStatus: string | null; resultErrorCode: string | null; failedEventCount: number }>(
        `SELECT call."status", call."content"->>'status' AS "outcomeStatus", call."content"->>'errorCode' AS "errorCode",
            call."content"->'input' AS input,
            (SELECT count(*)::int FROM "agent_items" result WHERE result."sessionId" = call."sessionId"
              AND result."turnId" = call."turnId" AND result."taskId" = call."taskId" AND result."type" = 'tool_result'
              AND result."content"->>'toolCallId' = $2) AS "resultCount",
            (SELECT result."status" FROM "agent_items" result WHERE result."sessionId" = call."sessionId"
              AND result."turnId" = call."turnId" AND result."taskId" = call."taskId" AND result."type" = 'tool_result'
              AND result."content"->>'toolCallId' = $2 LIMIT 1) AS "resultItemStatus",
            (SELECT result."content"->>'errorCode' FROM "agent_items" result WHERE result."sessionId" = call."sessionId"
              AND result."turnId" = call."turnId" AND result."taskId" = call."taskId" AND result."type" = 'tool_result'
              AND result."content"->>'toolCallId' = $2 LIMIT 1) AS "resultErrorCode",
            (SELECT count(*)::int FROM "agent_events" event WHERE event."sessionId" = call."sessionId"
              AND event."turnId" = call."turnId" AND event."taskId" = call."taskId" AND event."type" = 'tool_call.failed'
              AND event."correlationId" = $2 AND event."itemId" = call."id"
              AND event."payload"->>'errorCode' = $3) AS "failedEventCount"
          FROM "agent_items" call WHERE call."taskId" = $1 AND call."type" = 'tool_call'
            AND call."content"->>'toolCallId' = $2`,
        [parent.rows[0]!.id, `p1143-delegate-lever:${parent.rows[0]!.id}`, "nested_scout_source_scope_unavailable"])
      expect(deniedSource.rows).toHaveLength(1)
      expect(deniedSource.rows[0]).toMatchObject({ status: "completed", outcomeStatus: "failed",
        errorCode: "nested_scout_source_scope_unavailable", resultCount: 1, resultItemStatus: "completed",
        resultErrorCode: "nested_scout_source_scope_unavailable", failedEventCount: 1 })
      const deniedInput = deniedSource.rows[0]!.input as Record<string, unknown>
      expect(deniedInput.sourceSlice).toEqual(["lever"])
      const nested = await pool.query<{ id: string; status: string; depth: number; goal: string; attemptCount: number }>(
        `SELECT "id", "status", "depth", "goal", "attemptCount" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`,
        [ids.sessionId, parent.rows[0]!.id])
      expect(nested.rows).toHaveLength(2)
      expect(nested.rows.map(row => row.depth)).toEqual([2, 2])
      expect(nested.rows.every(row => row.status === "queued" && row.attemptCount === 0)).toBe(true)
      const expectedJobByChild = new Map(nested.rows.map(row => [row.id, row.goal.includes("Alpha") ? ids.alphaJobId : ids.betaJobId] as const))
      const initialAttempts = new Map(nested.rows.map(row => [row.id, row.attemptCount] as const))
      const wait = await pool.query<{ id: string; status: string; stepId: string; idempotencyKey: string; suspendedAt: Date | null; targetTaskIds: unknown }>(
        `SELECT "id", "status", "stepId", "idempotencyKey", "suspendedAt", "targetTaskIds" FROM "agent_wait_conditions"
         WHERE "turnId" = $1 AND "parentTaskId" = $2 ORDER BY "createdAt" DESC LIMIT 1`, [ids.turnId, parent.rows[0]!.id])
      expect(wait.rows).toHaveLength(1)
      expect(wait.rows[0]?.status).toBe("waiting")
      expect(wait.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const targets = Array.isArray(wait.rows[0]?.targetTaskIds) ? wait.rows[0]!.targetTaskIds as string[] : []
      expect([...targets].sort()).toEqual(nested.rows.map(row => row.id).sort())
      const initialWaitId = wait.rows[0]!.id
      const premature = await pool.query(`SELECT 1 FROM "agent_events" WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task.completed'`,
        [ids.sessionId, parent.rows[0]!.id])
      expect(premature.rowCount).toBe(0)

      await killAndWait(first.child)
      first = undefined
      crashing = launch("crash-child", ids)
      await waitForMainMarker(ids, crashing, "P1143_CRASH_CHILD_BEFORE_MODEL_CALL", 30_000)
      await waitForMainMarker(ids, crashing, "P1143_CHILD_WORKER_CLAIMED_RUNNING", 30_000)
      const claimedChildren = await pool.query<{ id: string; status: string; leaseOwner: string | null; leaseLive: boolean; attemptCount: number }>(
        `SELECT child."id", child."status", child."leaseOwner", child."leaseExpiresAt" > clock_timestamp() AS "leaseLive", child."attemptCount"
         FROM "sub_agent_tasks" AS child WHERE child."sessionId" = $1 AND child."parentTaskId" = $2 AND child."depth" = 2
         ORDER BY child."id"`, [ids.sessionId, parent.rows[0]!.id])
      expect(claimedChildren.rows).toHaveLength(2)
      expect(claimedChildren.rows.filter(row => row.status === "running")).toHaveLength(1)
      expect(claimedChildren.rows.filter(row => row.status === "queued")).toHaveLength(1)
      const crashedChild = claimedChildren.rows.find(row => row.status === "running")!
      expect(crashedChild).toMatchObject({ leaseLive: true, attemptCount: 1 })
      expect(crashedChild.leaseOwner).toEqual(expect.any(String))
      const callsBeforeCrash = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM "agent_items"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'`,
      [ids.sessionId, ids.turnId, crashedChild.id])
      expect(callsBeforeCrash.rows[0]?.count).toBe(0)
      // This crash cut is after the durable claim but before model invocation; it does not prove replay after an unknown provider outcome.
      const modelStartsBeforeCrash = await pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'model.started'`,
      [ids.sessionId, ids.turnId, crashedChild.id])
      expect(modelStartsBeforeCrash.rows[0]?.count).toBe(0)
      await expireSuspendedWait(ids, parent.rows[0]!.id)
      await waitForTimedOutParentWait(ids, parent.rows[0]!.id, initialWaitId, 30_000)
      await killAndWait(crashing.child)
      crashing = undefined
      await waitForExpiredCrashLease(ids, parent.rows[0]!.id, crashedChild.id, crashedChild.leaseOwner!, 30_000)
      restarted = launch("resume", ids)
      await waitForMainMarker(ids, restarted, "P1143_RECOVERY_DEPTH2_QUEUED", 30_000)
      await waitForMainMarker(ids, restarted, "P1143_CHILD_SCOUT_RECLAIMED", 30_000)
      const reclaimedOwner = await waitForReclaimedCrashChild(ids, crashedChild.id, crashedChild.leaseOwner!, 30_000)
      const resumedWaits = await waitForFinalWaitAfterTimeout(ids, parent.rows[0]!.id, initialWaitId, 60_000, restarted)
      await waitForMainMarker(ids, restarted, "P1143_TWO_CHILDREN_RUNNING_IN_PARALLEL", 240_000)
      await waitForMainMarker(ids, restarted, "P1143_ROOT_GRAPH_COMPLETED", 240_000)

      const turn = await pool.query<{ status: string }>(`SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [ids.turnId, ids.sessionId])
      expect(turn.rows[0]?.status).toBe("completed")
      const finalParent = await pool.query<{ id: string; status: string; result: unknown }>(
        `SELECT "id", "status", "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [parent.rows[0]!.id])
      expect(finalParent.rows[0]?.status).toBe("completed")
      const finalChildren = await pool.query<{ id: string; status: string; result: unknown; attemptCount: number }>(
        `SELECT "id", "status", "result", "attemptCount" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`,
        [ids.sessionId, parent.rows[0]!.id])
      expect(finalChildren.rows).toHaveLength(2)
      expect(finalChildren.rows.every(row => row.status === "completed")).toBe(true)
      expect(finalChildren.rows.every(row => row.attemptCount > initialAttempts.get(row.id)!)).toBe(true)
      expect(finalChildren.rows.find(row => row.id === crashedChild.id)?.attemptCount).toBe(2)
      const waitHistory = await pool.query<{ id: string; status: string; stepId: string; idempotencyKey: string;
        targetTaskIds: unknown; suspendedAt: Date | null; consumedAt: Date | null }>(`SELECT "id", "status", "stepId", "idempotencyKey", "targetTaskIds", "suspendedAt", "consumedAt"
        FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "createdAt", "id"`,
      [ids.sessionId, ids.turnId, parent.rows[0]!.id])
      expect(resumedWaits).toHaveLength(2)
      expect(waitHistory.rows).toHaveLength(2)
      expect(waitHistory.rows.map(row => row.status)).toEqual(["timed_out", "ready"])
      expect(waitHistory.rows.every(row => row.suspendedAt instanceof Date && row.consumedAt instanceof Date)).toBe(true)
      expect(new Set(waitHistory.rows.map(row => row.stepId)).size).toBe(2)
      expect(new Set(waitHistory.rows.map(row => row.idempotencyKey)).size).toBe(2)
      expect(waitHistory.rows.map(row => row.targetTaskIds).map(value => Array.isArray(value) ? [...value].sort() : []))
        .toEqual([targets.sort(), targets.sort()])
      const reclaimedDispatch = await pool.query<{ ownerId: string | null; attemptCount: number; publishedAt: Date | null }>(
        `SELECT "payload"->>'ownerId' AS "ownerId", "attemptCount", "publishedAt" FROM "agent_outbox"
         WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [ids.sessionId, `subagent-dispatch:${crashedChild.id}`])
      expect(reclaimedDispatch.rows).toHaveLength(1)
      expect(reclaimedDispatch.rows[0]?.ownerId).toBe(reclaimedOwner)
      expect(reclaimedDispatch.rows[0]?.ownerId).not.toBe(crashedChild.leaseOwner)
      expect(reclaimedDispatch.rows[0]?.attemptCount).toBeGreaterThan(1)
      expect(reclaimedDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)
      const reclaimedCalls = await pool.query<{ calls: number; results: number }>(`SELECT
          count(*) FILTER (WHERE "type" = 'tool_call')::int AS calls,
          count(*) FILTER (WHERE "type" = 'tool_result')::int AS results
        FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "content"->>'toolCallId' = $4`, [ids.sessionId, ids.turnId, crashedChild.id, `p1143-child-discover:${crashedChild.id}`])
      expect(reclaimedCalls.rows[0]).toEqual({ calls: 1, results: 1 })
      for (const child of finalChildren.rows) {
        const result = child.result as Record<string, unknown>
        const structured = result.structuredResult as Record<string, unknown>
        expect(structured).toMatchObject({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed" })
        const candidates = structured.candidates as Array<Record<string, unknown>>
        expect(candidates).toHaveLength(1)
        expect(candidates[0]?.jobId).toBe(expectedJobByChild.get(child.id))
        expect(candidates[0]?.source).toBe("greenhouse")
        expect(candidates[0]?.jobId).not.toBe(ids.foreignJobId)
        expect(JSON.stringify(structured.evidence)).toContain(String(candidates[0]?.jobId))
      }
      const root = await pool.query<{ rootTaskId: string }>(
        `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [ids.turnId, ids.sessionId, ids.userId])
      expect(root.rows).toHaveLength(1)
      const rootTaskId = root.rows[0]!.rootTaskId
      const loadedGraph = await loadTaskGraph(pool, {
        userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId,
        rootTaskId, parentTaskId: rootTaskId,
      }, false)
      const nodes = currentTaskGraph(loadedGraph).nodes
      expect(nodes).toHaveLength(1)
      expect(nodes[0]).toMatchObject({ templateId: "scout", status: "completed", readiness: "terminal" })
      expect(nodes[0]?.verificationReport?.status).toBe("passed")
      expect(nodes[0]?.resultProjection).toBeDefined()
      const parentReads = await pool.query<{ toolCallId: string; input: unknown; status: string }>(
        `SELECT content->>'toolCallId' AS "toolCallId", content->'input' AS input, status FROM "agent_items"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'tool_call'
           AND content->>'toolName' = 'jobs.get' ORDER BY "createdAt"`, [ids.sessionId, ids.turnId, parent.rows[0]!.id])
      const readIds = parentReads.rows.map(row => (row.input as Record<string, unknown>)?.jobId)
      expect(parentReads.rows).toHaveLength(2)
      expect(parentReads.rows.every(row => row.status === "completed")).toBe(true)
      expect(new Set(readIds)).toEqual(new Set([ids.alphaJobId, ids.betaJobId]))
      for (const child of finalChildren.rows) {
        const counts = await pool.query<{ spawnCount: string; dispatchCount: string }>(
          `SELECT count(*) FILTER (WHERE "topic" = 'agent.subagent.spawn') AS "spawnCount",
                  count(*) FILTER (WHERE "topic" = 'agent.subagent.dispatch') AS "dispatchCount"
           FROM "agent_outbox" WHERE "aggregateId" = $1 AND payload->>'taskId' = $2`, [ids.sessionId, child.id])
        expect(counts.rows[0]).toMatchObject({ spawnCount: "1", dispatchCount: "1" })
      }
    } finally {
      if (first) await killAndWait(first.child)
      if (crashing) await killAndWait(crashing.child)
      if (restarted) await stop(restarted.child)
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.userId])
    }
  }, 300_000)
})
