import { createHash, randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Queue, QueueEvents } from "bullmq"
import { Pool, type PoolClient } from "pg"
import { Redis } from "ioredis"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import {
  PLAN_LEDGER_SCHEMA_VERSION,
  parsePlanLedger,
  projectPlanLedger,
  projectTaskEvidencePreview,
  schemaVersion,
} from "@jobcopilot/agent-protocol"

import type { ProductionAgentFlags } from "../production-agent-flags.js"
import type { ProductionWorkerBootstrap, createProductionWorkerBootstrap } from "../../queue/production-bootstrap.js"
import { createAgentArtifactRepository, findCurrentDraftHeadWithClient, findReviewReceiptWithClient, type AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import { createArtifactToolStore } from "../tools/artifact-tools.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { consumeDurableWaitOutcomes } from "./durable-wait-consumer.js"
import { reconcileDurableWaits } from "./durable-wait-resolver.js"
import { childContextSnapshot, createChildContextBuilder } from "./child-context.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import { loadSelectedJobArtifactContext, readSelectedJobSourceDigestWithClient, resolveCoverLetterBase } from "./selected-job-artifact-context.js"
import { materializeTaskGraphDependencyContext } from "./task-graph-dependency-context.js"
import { selectedJobArtifactCompletionGate, selectedJobArtifactCompletionGateWithWitness } from "../selected-job-completion-gate.js"
import { selectedJobArtifactFinalizationGuard } from "../selected-job-finalization-guard.js"
import { commitTurnTerminal } from "../turns/turn-engine-terminal-commit.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { claimTurnLease, parseTurnJobPayload, releaseTurnLease, type TurnLease } from "../turns/lease.js"
import { turnJobId } from "../turns/recovery-scanner.js"
import { loadCanonicalTurnState } from "../canonical-turn-state.js"
import { loadTaskGraphCurrentObservation } from "../canonical-turn-task-graph-context.js"
import { createPgInputClaimStore } from "../context/input-claim-store.js"
import { createPgContextOwnerFence, StepContextBuilder } from "../context/step-context-builder.js"
import { checkTaskGraphTerminalVerification, TASK_GRAPH_VERIFICATION_BLOCKER } from "../turns/turn-execution-completion-gate.js"
import { executionOwnerFence } from "../execution-owner.js"
import { PgCoordinationStore } from "../mailbox/store.js"
import { NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, parseNativeVerificationControl } from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { createPgNativeVerificationPort } from "./pg-native-verification-port.js"
import { TASK_GRAPH_TEMPLATES, taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { ROLE_RESULT_SCHEMA, RoleResultValidationError, validateRoleResult, type StructuredRoleResult } from "./role-results.js"
import { createObservedEvidenceIndex, parseAndBindStructuredResult, recordReadToolOutput } from "./child-evidence.js"
import { parseTaskGraphVerificationReport, TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { projectValidatedRoleResult } from "./task-graph-result-projection.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { defaultSubagentPolicy, parseSubagentJobPayload, type SubagentLease, type SubagentTaskRecord } from "./types.js"
import { subagentDispatchJobId } from "./dispatch-identity.js"
import { drainTaskGraphStopOutbox, TASK_GRAPH_STOP_OUTBOX_TOPIC } from "./task-graph-stop-outbox.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING } from "./task-graph-final-summary-binding.js"
import { parseStoredTaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { rootRecoveryEligibility } from "./task-graph-pg-lifecycle.js"
import { RUNNABLE_SESSION } from "../session-gate.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const PLAN_CALL_ID = "p3-resume-plan"
const WAIT_CALL_ID = "p3-resume-wait"
const DISCOVERY_RESTART_WAIT_CALL_ID = "p3-process-restart-discovery-wait-call"
const DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID = "p3-process-restart-discovery-analyst-plan"
const DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID = "p3-process-restart-discovery-analyst-wait"
const ARCHIVED_WAIT_CALL_ID = "p3-process-archived-wait-call"
const ARCHIVED_WAIT_TAIL_CALL_ID = "p3-process-archived-wait-unexecuted-tail"
const ARCHIVED_WAIT_FRESH_LIST_CALL_ID = "p3-process-archived-wait-fresh-list"
const ARCHIVED_WAIT_IDEMPOTENCY_KEY = "p3-process-archived-wait"
const DISCOVERY_RESTART_DIAGNOSTIC_CALL_IDS = new Set([
  DISCOVERY_RESTART_WAIT_CALL_ID, DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID,
])
const FOLLOW_UP_PLAN_CALL_ID = "p3-resume-follow-up-plan"
const FOLLOW_UP_WAIT_CALL_ID = "p3-resume-follow-up-wait"
const RESTART_FOLLOW_UP_GOAL = "Verify the restored TaskGraph summary after restart"
const RESTART_FOLLOW_UP_KEY = "verification"
const RESULT_PREFIX = "p3-task-graph-child-result"
const FOLLOW_UP_GOAL = "Verify the completed summary with a follow-up check"
const LARGE_SOURCE_REPAIR_GOAL = "Repair the oversized source proof with bounded evidence"
const OVERSIZED_SOURCE_GOAL = "Complete with an oversized structured summary"
const FINAL_MARKER = "p3-task-graph-resumed-with-current-graph"
const FAILURE_PLAN_CALL_ID = "p3-failure-plan"
const FAILURE_WAIT_CALL_ID = "p3-failure-wait"
const FAILURE_GOAL = "Read a source and report a terminal failure"
const BLOCKED_GOAL = "Summarize only after the source succeeds"
const FAILURE_FINAL_MARKER = "p3-failed-prerequisite-cancelled-descendant"
const SOURCE_DEPENDENCY_PROJECTION_ITEM = {
  dependencyKey: "source", role: "scout", taskStatus: "completed",
  result: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
    candidates: [{ jobId: "fixture-job-1", source: "other", evidenceKinds: ["job"] }],
  },
} as const
const SUMMARY_DEPENDENCY_PROJECTION_ITEM = {
  dependencyKey: "summary", role: "analyst", taskStatus: "completed",
  result: {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
    role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
    findings: [{ jobId: "fixture-job-1", score: 8, evidenceKinds: ["job"] }],
  },
} as const
const SCOUT_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const
const ANALYST_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const DISCOVERY_ANALYST_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [
    { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    { id: "findings-from-scout", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } },
  ],
} as const

function expectVerifiedDependencyProjectionItems(
  actual: unknown,
  expected: typeof SOURCE_DEPENDENCY_PROJECTION_ITEM | typeof SUMMARY_DEPENDENCY_PROJECTION_ITEM,
  criterionId: "candidate-count" | "finding-count",
  sourceIntent?: Readonly<{ goal: string; successCriteria: readonly string[] }>,
): void {
  expect(Array.isArray(actual)).toBe(true)
  const items = Array.isArray(actual) ? actual : []
  expect(items).toHaveLength(1)
  const item = record(items[0])
  expect(item).not.toBeNull()
  expect(Object.keys(item ?? {}).sort()).toEqual([
    "dependencyKey", "result", "role", "taskStatus", "verification", ...(sourceIntent ? ["sourceIntent"] : []),
  ].sort())
  expect(item).toMatchObject({
    dependencyKey: expected.dependencyKey, role: expected.role, taskStatus: expected.taskStatus,
  })
  expect(item?.result).toEqual(expected.result)
  const verification = record(item?.verification)
  expect(verification).not.toBeNull()
  expect(Object.keys(verification ?? {}).sort()).toEqual([
    "criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion",
  ])
  expect(verification).toMatchObject({
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status: "passed",
    reasonCode: "criteria_met",
    criteria: [{ criterionId, status: "passed", reasonCode: "criteria_met" }],
  })
  expect(verification?.criteria).toEqual([{ criterionId, status: "passed", reasonCode: "criteria_met" }])
  expect(verification?.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
  expect(verification?.resultDigest).toMatch(/^[a-f0-9]{64}$/)
  if (sourceIntent) expectBoundedSourceIntent(item?.sourceIntent, sourceIntent)
}

function expectBoundedSourceIntent(value: unknown, expected: Readonly<{ goal: string; successCriteria: readonly string[] }>): void {
  const intent = record(value)
  expect(Object.keys(intent ?? {}).sort()).toEqual(["goal", "inputRelation", "successCriteria"])
  expect(intent).toMatchObject(expected)
  expect(["predates_current_inputs", "covers_current_inputs", "unknown"]).toContain(intent?.inputRelation)
  expect(typeof intent?.goal).toBe("string")
  expect((intent?.goal as string).length).toBeLessThanOrEqual(1200)
  expect(Array.isArray(intent?.successCriteria)).toBe(true)
  const criteria = intent?.successCriteria as unknown[]
  expect(criteria.length).toBeLessThanOrEqual(8)
  expect(criteria.every(item => typeof item === "string" && item.length <= 320)).toBe(true)
  expect(JSON.stringify(intent)).not.toMatch(/stepId|inputId|inputThroughSequence|consumedInputIds|cursor/)
}

function dependencyEvidenceWithoutSourceIntent(value: unknown): unknown {
  const context = record(value)
  const items = Array.isArray(context?.items) ? context.items : []
  return { ...context, items: items.map(item => {
    const row = record(item)
    return row ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== "sourceIntent")) : item
  }) }
}

const planLedgerTraceArtifactPath = process.env.AGENT_PLAN_LEDGER_TRACE_ARTIFACT_PATH
const interactiveDiscoveryTraceArtifactPath = process.env.AGENT_INTERACTIVE_DISCOVERY_TRACE_ARTIFACT_PATH
const SELECTED_JOB_DRAFT_CALL_ID = "ac6-selected-job-draft-receipt"
const SELECTED_JOB_REVIEW_READ_CALL_ID = "ac6-selected-job-review-read"
const SELECTED_JOB_REVIEW_CALL_ID = "ac6-selected-job-review-receipt"
const SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS = Object.freeze({
  commandReceived: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_COMMAND_RECEIVED",
  round1Entered: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_ROUND_1_ENTERED",
  artifactVersionReadYieldReached: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_ARTIFACT_VERSION_READ_YIELD_REACHED",
  round2Entered: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_ROUND_2_ENTERED",
  readyEmissionReached: "P3_SELECTED_JOB_STOP_REVIEW_PHASE_READY_EMISSION_REACHED",
})

function selectedJobDraftCallId(attemptCount: number): string {
  return `${SELECTED_JOB_DRAFT_CALL_ID}:attempt:${attemptCount}`
}

function dedicatedDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true"
    || url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("TaskGraph resume integration requires the dedicated disposable CI PostgreSQL service URL")
  return value
}

function dedicatedRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value) return null
  const url = new URL(value)
  if (
    process.env.CI !== "true"
    || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true"
    || url.protocol !== "redis:"
    || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    || url.port !== "6379"
    || url.pathname !== "/15"
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) throw new Error("TaskGraph resume integration accepts only the dedicated disposable CI Redis DB 15 URL")
  return value
}

const databaseUrl = dedicatedDatabaseUrl()
const redisUrl = dedicatedRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip

type Fixture = { userId: string; sessionId: string; turnId: string; ownerId: string; suffix: string }
type RecordValue = Record<string, unknown>
type TaskGraphItemRow = {
  id: string; sessionId: string; turnId: string; stepId: string | null; taskId: string | null
  type: string; status: string; phase: string | null; revision: number; content: RecordValue
  startedAt: Date | null; completedAt: Date | null; createdAt: Date; updatedAt: Date
}
type TurnQueueFactory = NonNullable<Parameters<typeof createProductionWorkerBootstrap>[0]["turnQueueFactory"]>

function recordTaskGraphFixtureLease(
  lease: Pick<SubagentTaskRecord, "sessionId" | "turnId" | "goal">,
  owner: Fixture,
  dispatchedGoals: string[],
): void {
  if (lease.sessionId !== owner.sessionId || lease.turnId !== owner.turnId) {
    throw new Error("Foreign subagent lease rejected by TaskGraph fixture")
  }
  dispatchedGoals.push(lease.goal)
}

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null
}

function deferredSignal<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

async function withinIntegrationDeadline<T>(promise: Promise<T>, message: string, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function sessionLockBarrierPool(pool: Pool) {
  const connected = deferredSignal<number>()
  const sessionLockReturned = deferredSignal<number>()
  const releaseQuery = deferredSignal<void>()
  let paused = false
  const barrierPool = {
    connect: async () => {
      const client = await pool.connect()
      let backendPid: number
      try {
        const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        backendPid = Number(result.rows[0]?.pid)
        if (!Number.isSafeInteger(backendPid)) throw new Error("Disposable PostgreSQL backend PID is unavailable")
        connected.resolve(backendPid)
      } catch (error) {
        client.release()
        throw error
      }

      const query = client.query.bind(client) as unknown as (...args: unknown[]) => Promise<unknown>
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return async (...args: unknown[]) => {
              const queryInput = args[0]
              const sql = typeof queryInput === "string" ? queryInput : String(record(queryInput)?.text ?? "")
              const result = await query(...args)
              if (!paused && sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
                paused = true
                sessionLockReturned.resolve(backendPid)
                await releaseQuery.promise
              }
              return result
            }
          }
          if (property === "release") return target.release.bind(target)
          return Reflect.get(target, property, receiver)
        },
      })
    },
  } as unknown as Pick<Pool, "connect">

  return {
    pool: barrierPool,
    connected: connected.promise,
    sessionLockReturned: sessionLockReturned.promise,
    release: () => releaseQuery.resolve(undefined),
  }
}

async function waitForSessionTupleBlock(pool: Pool, blockerPid: number, blockedPid: number): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const activity = await pool.query<{ waiting: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_stat_activity AS waiter
      WHERE waiter.pid = $2 AND waiter.state = 'active' AND waiter.wait_event_type = 'Lock'
        AND $1::int = ANY(pg_blocking_pids(waiter.pid))
        AND waiter.query LIKE '%FROM "agent_sessions"%' AND waiter.query LIKE '%FOR UPDATE%'
    ) AS "waiting"`, [blockerPid, blockedPid])
    if (activity.rows[0]?.waiting === true) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`Backend ${blockedPid} did not wait on the session row held by backend ${blockerPid}`)
}

function diagnosticValueType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function boundedDiagnostic(value: string, maxCharacters = 4_000): string {
  if (value.length <= maxCharacters) return value
  let suffix = `...[truncated ${value.length - maxCharacters} characters]`
  while (suffix.length < maxCharacters) {
    const retainedLength = maxCharacters - suffix.length
    const omittedCharacters = value.length - retainedLength
    const nextSuffix = `...[truncated ${omittedCharacters} characters]`
    if (nextSuffix.length === suffix.length) return `${value.slice(0, retainedLength)}${nextSuffix}`
    suffix = nextSuffix
  }
  return suffix.slice(0, maxCharacters)
}

function captureModelStreamFailure(model: ModelAdapter, onFailure: (error: unknown) => void): ModelAdapter {
  return {
    ...model,
    stream(request: HarnessModelRequest) {
      return (async function* () {
        try {
          for await (const event of model.stream(request)) yield event
        } catch (error: unknown) {
          onFailure(error)
          throw error
        }
      })()
    },
  }
}

function boundedErrorText(error: unknown, maxCharacters = 1_000): string {
  const value = error instanceof Error ? error.stack ?? `${error.name}: ${error.message}` : String(error)
  return boundedDiagnostic(value, maxCharacters)
}

function childFixtureErrorSummary(error: unknown): string {
  const fields = record(error)
  const candidateName = error instanceof Error ? error.name : typeof fields?.name === "string" ? fields.name : "UnknownError"
  const name = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(candidateName) ? candidateName : "UnknownError"
  const candidateMessage = error instanceof Error ? error.message : typeof fields?.message === "string" ? fields.message : String(error)
  const message = candidateMessage
    .replace(/(?:postgres(?:ql)?|redis):\/\/[^\s"'`]+/gi, "<connection-url>")
    .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, "<email>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp)\/)[^\s"'`]+/g, "<path>")
    .replace(/\b(password|secret|token|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=<redacted>")
  return boundedDiagnostic(`${name}: ${message}`, 300)
}

function safeFailurePreflightErrorClass(error: unknown): FailurePreflightErrorClass {
  const fields = record(error)
  const code = fields?.code
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return "database"
  if (error instanceof Error && error.name === "AssertionError") return "assertion"
  if (error instanceof Error && error.name === "CoordinationError") return "coordination"
  if (error instanceof Error && error.name === "Error") return "generic"
  return "other"
}

type FailureDiagnosticField = {
  label: string
  value: string
  safeValue?: string
}

type RootModelFailureStage =
  | "not_started"
  | "initial_plan_tool"
  | "initial_wait_plan_receipt"
  | "initial_wait_plan_uniqueness"
  | "initial_wait_graph_count"
  | "initial_wait_graph_uniqueness"
  | "initial_wait_plan_graph_set_mismatch"
  | "initial_wait_tool"
  | "unexpected_root_model_round"
  | "resumed_graph_kind"
  | "resumed_graph_keys"
  | "resumed_graph_statuses"
  | "resumed_graph_readiness"
  | "large_source_projection"
  | "wait_outcome_status"
  | "wait_task_statuses"
  | "source_wait_verification"
  | "summary_wait_verification"
  | "resumed_graph_revision"
  | "follow_up_plan_tool"
  | "follow_up_graph_keys"
  | "follow_up_graph_statuses"
  | "follow_up_graph_readiness"
  | "follow_up_plan_receipt_lookup"
  | "follow_up_graph_task_id"
  | "follow_up_wait_tool"
  | "completed_graph_kind"
  | "completed_graph_keys"
  | "completed_graph_statuses"
  | "completed_graph_readiness"
  | "completed_wait_outcome"
  | "completed_wait_status"
  | "completed_wait_summary"

type ChildFixtureFailureStage =
  | "parent_wait"
  | "source_dependency_schema"
  | "source_dependency_items"
  | "source_child_context_build"
  | "source_profile_trust"
  | "source_profile_schema"
  | "source_profile_items"
  | "source_profile_redaction"
  | "source_system_boundary"
  | "follow_up_dependency_schema"
  | "follow_up_dependency_items"
  | "follow_up_dependency_redaction"
  | "structured_result"
  | "oversized_result"
  | "unexpected_role"

type FailurePreflightStage =
  | "not_started"
  | "plan_receipt"
  | "root_task_lookup"
  | "first_target_lookup"
  | "second_target_lookup"
  | "first_target_lineage"
  | "second_target_lineage"
  | "wait_tool_availability"
  | "preflight_passed"

type FailurePreflightErrorClass = "none" | "assertion" | "coordination" | "database" | "generic" | "other"

type FailurePreflightTargetScopeEvidence = Readonly<{
  lookupCompleted: boolean
  rowFound: boolean | null
  sessionMatches: boolean | null
  userMatches: boolean | null
  turnMatches: boolean | null
  rootMatches: boolean | null
  parentMatches: boolean | null
}>

type FailurePreflightTargetObservation = null | { found: false; scope: FailurePreflightTargetScopeEvidence } | {
  found: true
  taskId: string
  turnId: string | null
  rootTaskId: string | null
  parentTaskId: string | null
}

const TURN_DIAGNOSTIC_STATUSES = new Set([
  "queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user",
  "completed", "failed", "interrupted", "cancelled",
])
const ITEM_DIAGNOSTIC_STATUSES = new Set(["started", "completed", "failed", "cancelled"])
const STEP_DIAGNOSTIC_STATUSES = new Set([
  "queued", "running", "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user",
])
const ROOT_FAILURE_EVENT_TYPES = new Set(["turn.failed", "step.completed", "final.rejected", "task.failed"])
const TOOL_ITEM_TYPES = new Set(["tool_call", "tool_result"])
const TOOL_RESULT_DIAGNOSTIC_STATUSES = new Set(["accepted", "duplicate", "waiting", "ready", "timed_out", "interrupted", "closed"])
const WAIT_DIAGNOSTIC_STATUSES = new Set(["waiting", "ready", "timed_out", "consumed", "failed", "cancelled", "interrupted", "closed"])
const TOOL_DIAGNOSTIC_NAMES = new Set(["agent.plan", "agent.wait", "jobs.search"])
const ERROR_DIAGNOSTIC_CODES = new Set([
  "final_unverified", "step_limit", "model_incomplete", "persistence_conflict", "invalid_output", "turn_execution_failed",
  "budget_exhausted", "no_progress", "evidence_missing", "evidence_conflict", "business_precondition_failed",
  "tool_execution_failed", "tool_not_found", "schema_error", "capability_denied", "policy_denied",
  "policy_version_unknown", "timeout", "cancelled", "tool_result_replay_uncertain", "tool_recovery_aborted",
  "durable_wait_receipt_invalid", "turn_execution_failed", "model_error",
  "task_graph_scope_unavailable", "task_graph_continuation_budget_required", "task_graph_proposal_too_large",
  "task_graph_sensitive_key_rejected", "task_graph_state_missing", "task_graph_receipt_invalid",
  "task_graph_schedule_failed", "task_graph_dispatch_conflict", "task_graph_dependency_blocked",
  "task_graph_dependency_task_missing", "task_graph_child_wait_state_failed", "revision_mismatch",
  "task_graph_revision_mismatch", "task_graph_verification_failed", "task_graph_verification_unverified",
  "revision_limit", "idempotency_conflict",
])
const CHILD_OUTCOME_STATUSES = new Set(["completed", "failed", "waiting", "waiting_for_user"])
const CHILD_OUTCOME_RETRY_DISPOSITIONS = new Set(["terminal", "retryable"])
const CHILD_OUTCOME_FAILURE_CODES = new Set([
  "final_unverified", "step_limit", "model_incomplete", "persistence_conflict", "invalid_output", "turn_execution_failed",
  "budget_exhausted", "no_progress", "evidence_missing", "evidence_conflict", "business_precondition_failed",
  "runtime_scope_error", "capability_denied", "idempotency_conflict", "timeout", "cancelled", "tool_execution_failed",
  "policy_denied", "policy_requires_approval", "policy_requires_user_input", "policy_version_unknown",
  "policy_rewrite_expands_permissions", "tool_not_found", "tool_version_mismatch", "duplicate_tool", "invalid_definition",
  "schema_error", "tool_result_replay_uncertain", "tool_recovery_aborted", "invalid_structured_result",
])
const ROOT_FAILURE_SQLSTATE_CODES = new Set(["40P01", "40001", "55P03", "57014", "23505", "23503", "23502", "23514", "22P02", "42P01", "42703", "42501"])
const FINAL_TERMINAL_REASONS = new Set([
  "goal_satisfied", "partial_result", "budget_exhausted", "no_progress", "unrecoverable_error", "final_unverified",
])
const DISCOVERY_DIAGNOSTIC_ROLES = new Set(["scout", "analyst"])
const TASK_GRAPH_VERIFICATION_STATUSES = new Set(["passed", "failed", "unverified"])
const TASK_GRAPH_VERIFICATION_REASONS = new Set([
  "criteria_met", "criterion_not_met", "reported_score_below_minimum", "contract_invalid", "projection_invalid",
  "role_mismatch", "canonical_evidence_missing", "canonical_evidence_invalid", "canonical_evidence_ambiguous",
  "result_invalid", "result_ambiguous", "result_evidence_unbound", "repair_target_unresolved",
])
const DISCOVERY_DIAGNOSTIC_CRITERIA = new Set(["candidate-count", "finding-count"])
const WAIT_HANDOFF_ERROR_CODES = new Set([
  "40P01", "40001", "55P03", "57014", "23505", "23503", "wait_handoff_unavailable",
  "wait_invalid", "wait_scope_error", "lease_lost",
])
const WAIT_HANDOFF_ERROR_NAMES = new Set([
  "Error", "error", "DurableWaitHandoffError", "TurnLeaseError", "WaitHandoffUnavailable",
])
const WAIT_HANDOFF_GATE_ERROR_NAMES = new Set([
  "Error", "error", "DurableWaitHandoffError", "TurnLeaseError", "WaitHandoffUnavailable",
])
const DISCOVERY_SCHEDULE_ERROR_NAMES = new Set([
  "Error", "error", "TaskGraphCommandError", "DatabaseError", "TypeError", "RangeError", "AggregateError",
])
const DISCOVERY_SCHEDULE_ERROR_CODES = new Set([
  "40P01", "40001", "55P03", "57014", "23505", "23503", "23502", "23514", "22P02", "42P01", "42703", "42501",
  "invalid_shape", "invalid_options", "invalid_state", "revision_mismatch", "empty_proposal", "duplicate_key",
  "unknown_template", "missing_dependency", "dependency_cycle", "node_limit", "depth_limit", "invalid_transition",
  "dependencies_incomplete", "blocked_dependency", "idempotency_conflict", "verification_required", "verification_invalid",
  "unsupported_verification_template", "repair_invalid", "task_graph_template_policy_rejected", "task_graph_proposal_too_large",
  "task_graph_proposal_fan_out_limit", "task_graph_dependency_unverified", "task_graph_dependency_blocked",
  "task_graph_child_wait_state_failed", "task_graph_repair_snapshot_invalid", "task_graph_repair_target_unresolved",
  "task_graph_repair_criteria_resolved", "task_graph_repair_target_scope_invalid", "task_graph_dispatch_conflict",
  "task_graph_state_missing", "task_graph_receipt_invalid", "task_graph_session_fenced", "task_graph_turn_fenced",
  "task_graph_parent_fenced", "task_graph_step_fenced", "task_graph_scope_invalid", "task_graph_revision_invalid",
  "task_graph_task_scope_invalid", "task_graph_scope_unavailable", "task_graph_verification_unverified", "revision_limit",
  "child_allowed_actions_exceed_parent_policy", "subagent_depth_limit", "subagent_fan_out_limit", "session_unavailable",
  "parent_task_unavailable", "parent_task_terminal", "subagent_task_disappeared", "subagent_task_insert_failed",
])
const WAIT_HANDOFF_GATE_LABELS = new Map([
  ["waitId is required", "wait_id_required"],
  ["leaseExpiresAt is invalid", "lease_expiry_invalid"],
  ["Session is unavailable", "session_unavailable"],
  ["Session is outside the wait scope", "session_scope_mismatch"],
  ["Turn is unavailable", "turn_unavailable"],
  ["Turn is outside the wait scope", "turn_scope_mismatch"],
  ["Wait condition is unavailable", "wait_unavailable"],
  ["Wait parent is outside the root Turn scope", "wait_root_scope_mismatch"],
  ["Wait step is outside the root Turn scope", "wait_step_scope_mismatch"],
  ["Wait step is not the current attempt", "wait_step_not_current"],
  ["Wait condition is already closed", "wait_already_closed"],
  ["Wait changed during handoff", "wait_changed_during_handoff"],
  ["Session was closed during wait dispatch", "session_closed_during_dispatch"],
  ["Turn lease was fenced before wait handoff", "lease_fenced_before_handoff"],
  ["Turn lease was fenced during wait handoff", "lease_fenced_during_handoff"],
  ["Turn lease was fenced during wait requeue", "lease_fenced_during_requeue"],
  ["Production waitHandoff callback was not provided.", "handoff_callback_missing"],
  ["wait_resume_event_conflict", "resume_event_conflict"],
  ["wait_resume_session_sequence_unavailable", "resume_session_sequence_unavailable"],
  ["wait_resume_outbox_conflict", "resume_outbox_conflict"],
])
const TASK_GRAPH_DIAGNOSTIC_NODE_KEYS = new Set([
  "source", "summary", "large-source", "rejected", "verification", "prerequisite", "dependent",
])
const COMPLETED_GRAPH_STATUS_EXPECTATIONS = [
  { key: "source", status: "completed" },
  { key: "summary", status: "completed" },
  { key: "large-source", status: "failed" },
  { key: "rejected", status: "cancelled" },
  { key: "large-source-repair", status: "completed" },
  { key: "verification", status: "completed" },
] as const
const TASK_GRAPH_READINESS = new Set([
  "ready", "waiting_for_dependencies", "blocked_dependency", "active", "terminal",
])
const FAILURE_PREFLIGHT_TARGET_KEYS = ["prerequisite", "dependent"] as const
const TASK_GRAPH_DIAGNOSTIC_PROPOSAL_NODE_KEYS = new Set(["source", "summary", "verification"])
const TASK_DIAGNOSTIC_STATUSES = new Set([
  "queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed",
])
const EVENT_DIAGNOSTIC_STATUSES = new Set([
  ...TURN_DIAGNOSTIC_STATUSES, ...ITEM_DIAGNOSTIC_STATUSES, ...WAIT_DIAGNOSTIC_STATUSES,
  ...TASK_DIAGNOSTIC_STATUSES, ...STEP_DIAGNOSTIC_STATUSES,
])
const PROCESS_FIXTURE_TURN_STATUSES = new Set([...TURN_DIAGNOSTIC_STATUSES, "none", "other"])
const PROCESS_FIXTURE_TASK_STATUSES = new Set([...TASK_DIAGNOSTIC_STATUSES, "none", "other"])
const PROCESS_FIXTURE_STEP_STATUSES = new Set([
  "completed", "failed", "interrupted", "waiting_for_tool", "waiting_for_approval", "waiting_for_user", "none", "other",
])
const PROCESS_FIXTURE_TOOL_STATUSES = new Set([...ITEM_DIAGNOSTIC_STATUSES, "interrupted", "none", "other"])
const PROCESS_FIXTURE_WAIT_OUTPUT_STATUSES = new Set(["waiting", "ready", "timed_out", "none", "other"])
const PROCESS_FIXTURE_FAILURE_CATEGORIES = new Set([
  "none", "other", "tool_result_missing", "database_deadlock", "database_serialization", "database_lock_wait",
  "coordination_invalid_input", "coordination_task_not_found", "coordination_scope_error",
  "coordination_wait_unavailable", "wait_handoff_state", "turn_lease_state", "generic_tool_execution_failed",
  "task_graph_failure", "plan_ledger_projection_invalid", "business_precondition_failed", "turn_output_invalid", "turn_budget_exhausted",
])
const ARCHIVED_WAIT_PROGRESS_PREFIX = "P3_ARCHIVED_WAIT_PROGRESS "
const ARCHIVED_WAIT_PROGRESS_PHASES = new Set([
  "model_stream_entered", "tools_validated", "root_identity_validated", "child_create_started", "child_create_failed",
  "child_created", "child_claim_started", "child_claim_failed", "child_claimed", "child_finish_started",
  "child_finish_failed", "child_finished", "child_pending", "wait_call_emitted", "model_stream_failed",
])
const ARCHIVED_WAIT_PROGRESS_ERROR_KINDS = new Set(["none", "error", "type_error", "range_error", "syntax_error", "non_error", "other"])
const LEASE_RECOVERY_ADAPTER_BRANCHES = new Set([
  "not_started", "initial_plan", "initial_wait", "repair_plan", "repair_wait", "final_proof", "unexpected",
])
const LEASE_RECOVERY_ADAPTER_STAGES = new Set([
  "not_started", "stream_entered", "branch_entered", "graph_checked", "outcome_checked",
  "database_checked", "tool_call_emitted", "completion_emitted", "final_output_emitted",
  "final_proof_graph_nodes", "final_proof_node_statuses", "final_proof_dependent_identity",
  "final_proof_dependent_report", "final_proof_repair_report", "final_proof_repair_receipt",
  "final_proof_wait_outcome", "final_proof_wait_task_statuses", "final_proof_repair_wait_report",
  "final_proof_dependent_wait_report",
])
const LEASE_RECOVERY_STARTUP_STAGES = new Set([
  "not_started", "state_loading", "state_loaded", "selected_job_loading", "selected_job_loaded",
  "root_ensure_entered", "root_ensure_returned", "root_ensure_failed", "model_factory",
])
const LEASE_RECOVERY_FAILURE_CLASSES = new Set(["none", "assertion", "coordination", "database", "generic", "other"])
const PROCESS_RESTART_ROOT_STAGES = new Set([
  "not_started", "worker_ready", "model_failed", "graph_restored", "resume_context_ready",
  "follow_up_dependency_context_ready", "follow_up_graph_ready", "follow_up_graph_completed",
])
const PROCESS_RESTART_CHILD_STAGES = new Set([
  "not_started", "lease_acquired", "source_wait_checked", "source_unlocked", "dependency_context_ready",
  "follow_up_dependency_context_ready",
])
const PROCESS_RESTART_TASK_ROLES = new Set(["orchestrator", "scout", "analyst"])
const PROCESS_RESTART_GUARD_MARKERS = new Set([
  "snapshot_not_restored", "source_node_not_restored", "summary_node_not_restored", "other_node_not_restored",
  "wait_result_missing", "source_verification_not_restored", "summary_verification_not_restored",
  "source_projection_missing", "other", "none",
])
const PROCESS_RESTART_PLAN_EVENT_TYPES = new Set([
  "tool_call.started", "tool_call.completed", "tool_call.failed", "tool_call.interrupted",
  "item.started", "item.completed", "item.failed", "item.interrupted",
])
const PROCESS_RESTART_PLAN_EVENT_STATUSES = new Set(["started", "completed", "failed", "interrupted"])
const PROCESS_RESTART_PLAN_OUTPUT_STATUSES = new Set(["accepted", "rejected", "failed", "completed", "other"])
const PROCESS_RESTART_DISCOVERY_ANALYST_PLAN_CALL_ID = "p3-discovery-plan-analyst"
const PROCESS_FIXTURE_DISCOVERY_ANALYST_PLAN_CALL_ID = "p3-process-restart-discovery-analyst-plan"
const PROCESS_FIXTURE_CAUSES = new Set([
  "turn_missing", "model_never_ran", "plan_not_called", "plan_failed_or_incomplete", "graph_shape_mismatch",
  "wait_call_missing", "wait_result_missing_or_unknown", "wait_target_ids_unreadable", "requested_ids_not_in_graph",
  "requested_graph_tasks_missing_child_rows", "wait_tool_failed_before_wait_persistence",
  "wait_row_missing_or_parent_mismatch", "turn_failed", "wait_row_not_suspended", "suspension_predicate_not_met",
])
const RESTORED_SOURCE_PROJECTION_CATEGORIES = new Set([
  "absent", "invalid", "wrong_schema", "unavailable", "wrong_role", "wrong_status", "wrong_count",
  "candidate_identity_mismatch", "valid", "missing", "other",
])
const RESTORED_SOURCE_PROJECTION_SCHEMAS = new Set(["expected", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_AVAILABILITIES = new Set(["available", "unavailable", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_ROLES = new Set(["scout", "analyst", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_STATUSES = new Set(["completed", "partial", "missing", "other"])
const RESTORED_SOURCE_PROJECTION_SHAPES = new Set(["not_object", "other"])
const RESTORED_SOURCE_PROJECTION_INVALID_FIELDS = new Set([
  "trust", "availability", "count_or_candidates", "candidate_shape", "other",
])
const RESTORED_SOURCE_PROJECTION_IDENTITIES = new Set(["unchecked", "match", "mismatch", "other"])
const RESTORED_SOURCE_PROJECTION_DIAGNOSTIC_COUNT_LIMIT = 99

function diagnosticText(value: unknown, maxCharacters = 64): string | null {
  return typeof value === "string" ? boundedDiagnostic(value, maxCharacters) : null
}

function diagnosticEnum(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null
}

type PrivateWaitReaderOrigin = "not_observed" | "same_execution" | "later_execution"
type PrivateWaitReaderStage = "not_observed" | "first_lookup" | "subsequent_lookup"
type PrivateWaitRowObservation =
  | "not_called" | "private_row_waiting" | "private_row_ready" | "private_row_timed_out"
  | "private_row_interrupted" | "empty" | "query_rejected"
type PrivateWaitReaderAttempt = {
  readonly invocationKey: string
  readonly origin: Exclude<PrivateWaitReaderOrigin, "not_observed">
  readonly stage: Exclude<PrivateWaitReaderStage, "not_observed">
  rowObservation: PrivateWaitRowObservation
}

function instrumentPrivateWaitReader(pool: Pool, currentExecution: () => number) {
  const attempts = new Map<string, { count: number; latest: PrivateWaitReaderAttempt | null }>()
  let latestInvocation: { key: string; execution: number } | null = null
  const beginSql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"

  const wrappedPool = new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect()
          const query = client.query.bind(client) as unknown as (...queryArgs: unknown[]) => Promise<unknown>
          let activeAttempt: PrivateWaitReaderAttempt | null = null
          const wrappedClient = new Proxy(client, {
            get(clientTarget, clientProperty) {
              if (clientProperty === "query") {
                return async (...queryArgs: unknown[]) => {
                  const queryInput = queryArgs[0]
                  const sql = typeof queryInput === "string" ? queryInput : String(record(queryInput)?.text ?? "")
                  const normalizedSql = sql.trim().toUpperCase()
                  if (normalizedSql === beginSql && latestInvocation) {
                    const entry = attempts.get(latestInvocation.key) ?? { count: 0, latest: null }
                    entry.count += 1
                    activeAttempt = {
                      invocationKey: latestInvocation.key,
                      origin: currentExecution() === latestInvocation.execution ? "same_execution" : "later_execution",
                      stage: entry.count === 1 ? "first_lookup" : "subsequent_lookup",
                      rowObservation: "empty",
                    }
                    entry.latest = activeAttempt
                    attempts.set(latestInvocation.key, entry)
                  }
                  if (!activeAttempt) return query(...queryArgs)
                  try {
                    const result = await query(...queryArgs)
                    if (activeAttempt && sql.includes('FROM "agent_wait_conditions" AS wait')) {
                      const queryValues = Array.isArray(queryArgs[1]) ? queryArgs[1] : record(queryInput)?.values
                      const rows = record(result)?.rows
                      const row = Array.isArray(rows) && rows.length === 1 ? record(rows[0]) : null
                      const readInvocationKey = Array.isArray(queryValues) ? queryValues[1] : undefined
                      if (row && readInvocationKey === activeAttempt.invocationKey
                        && row.idempotencyKey === activeAttempt.invocationKey) {
                        const status = row.status
                        if (status === "waiting") activeAttempt.rowObservation = "private_row_waiting"
                        else if (status === "ready") activeAttempt.rowObservation = "private_row_ready"
                        else if (status === "timed_out") activeAttempt.rowObservation = "private_row_timed_out"
                        else if (status === "interrupted") activeAttempt.rowObservation = "private_row_interrupted"
                      }
                    }
                    if (activeAttempt && (normalizedSql === "COMMIT" || normalizedSql === "ROLLBACK")) {
                      if (normalizedSql === "ROLLBACK") activeAttempt.rowObservation = "query_rejected"
                      activeAttempt = null
                    }
                    return result
                  } catch (error: unknown) {
                    if (activeAttempt) activeAttempt.rowObservation = "query_rejected"
                    throw error
                  }
                }
              }
              const value = Reflect.get(clientTarget, clientProperty, clientTarget)
              return typeof value === "function" ? value.bind(clientTarget) : value
            },
          }) as PoolClient
          return wrappedClient
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
  }) as Pool

  return {
    pool: wrappedPool,
    setLatestInvocation(invocationKey: string, execution: number): void {
      latestInvocation = { key: invocationKey, execution }
      if (!attempts.has(invocationKey)) attempts.set(invocationKey, { count: 0, latest: null })
    },
    latest(): { origin: PrivateWaitReaderOrigin; stage: PrivateWaitReaderStage; rowObservation: PrivateWaitRowObservation } {
      if (!latestInvocation) return { origin: "not_observed", stage: "not_observed", rowObservation: "not_called" }
      const latest = attempts.get(latestInvocation.key)?.latest
      return latest
        ? { origin: latest.origin, stage: latest.stage, rowObservation: latest.rowObservation }
        : { origin: "not_observed", stage: "not_observed", rowObservation: "not_called" }
    },
  }
}

function processFixtureFailureCategory(output: readonly string[], prefix: string): string {
  const marker = output.find(line => line.startsWith(prefix))
  return diagnosticEnum(marker?.slice(prefix.length), PROCESS_FIXTURE_FAILURE_CATEGORIES) ?? "none"
}

function latestProcessFixtureStage(
  output: readonly string[],
  markers: readonly (readonly [prefix: string, stage: string])[],
  allowed: ReadonlySet<string>,
): string {
  let stage = "not_started"
  for (const line of output) {
    const match = markers.find(([prefix]) => line.startsWith(prefix))
    if (match) stage = diagnosticEnum(match[1], allowed) ?? "other"
  }
  return stage
}

function processLineWaitFailureKind(error: unknown, prefix: string): string {
  const message = error instanceof Error ? error.message : ""
  if (message.startsWith(`Worker exited before ${prefix}`)) return "exited_before_marker"
  if (message.startsWith(`Timed out waiting for ${prefix}`)) return "timeout"
  return "other"
}

function processCleanupFailureCategory(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message.startsWith("Worker exited unsuccessfully during cleanup")) return "worker_exited"
  if (message.startsWith("Worker process did not exit")) return "worker_shutdown_timeout"
  if (message.startsWith("Worker required forced termination")) return "forced_termination"
  if (message.startsWith("Worker process kill was rejected")) return "kill_rejected"
  const code = record(error)?.code
  if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return "database_error"
  return "other"
}

function diagnosticErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null
  if (ERROR_DIAGNOSTIC_CODES.has(value)) return value
  return /^task_graph_[a-z0-9_]{1,80}$/.test(value) ? "task_graph_other" : "other"
}

function diagnosticErrorClass(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null
  if (/^[0-9A-Z]{5}$/.test(value)) return "database"
  const code = diagnosticErrorCode(value)
  if (!code) return null
  if (code === "invalid_output") return "invalid_output"
  if (code === "schema_error") return "tool_schema"
  if (code === "durable_wait_receipt_invalid") return "wait_receipt"
  if (code === "tool_result_replay_uncertain" || code === "tool_recovery_aborted") return "tool_replay"
  if (code === "business_precondition_failed") return "completion_gate"
  if (code.startsWith("task_graph_") || code === "revision_mismatch" || code === "task_graph_revision_mismatch") return "task_graph"
  if (code === "turn_execution_failed" || code === "model_error") return "execution"
  return "other"
}

function diagnosticFixtureCallId(value: unknown): string | null {
  return typeof value === "string" && DISCOVERY_RESTART_DIAGNOSTIC_CALL_IDS.has(value)
    ? boundedDiagnostic(value, 128)
    : null
}

function diagnosticRootFailureCode(value: unknown): string {
  const code = diagnosticErrorCode(value)
  return code && code !== "other" ? code : diagnosticEnum(value, ROOT_FAILURE_SQLSTATE_CODES) ?? "other"
}

async function rootFailureDiagnostic(pool: Pool, turnId: string): Promise<RecordValue> {
  try {
    const result = await pool.query<{ errorCode: string | null; final: unknown }>(
      `SELECT event."payload"->>'errorCode' AS "errorCode", event."payload"->'final' AS "final"
       FROM "agent_events" AS event JOIN "agent_turns" AS turn
         ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
       WHERE event."turnId" = $1 AND event."type" = 'turn.failed' AND event."taskId" = turn."rootTaskId"
       ORDER BY event."sequence" DESC LIMIT 1`,
      [turnId],
    )
    const row = result.rows[0]
    const final = record(row?.final)
    return {
      available: true,
      eventFound: Boolean(row),
      errorCode: typeof row?.errorCode === "string" ? diagnosticRootFailureCode(row.errorCode) : "missing",
      terminalReason: final
        ? diagnosticEnum(final.terminalReason, FINAL_TERMINAL_REASONS) ?? "other"
        : "missing",
      blockerPresent: typeof final?.blocker === "string",
      blockerCode: typeof final?.blocker === "string" ? diagnosticRootFailureCode(final.blocker) : "missing",
    }
  } catch {
    return { available: false }
  }
}

async function repairCycleVerificationDiagnostic(pool: Pool, turnId: string): Promise<RecordValue> {
  try {
    const result = await pool.query<{
      role: string; status: string; failureReason: string | null; result: unknown
    }>(`SELECT "role", "status", "failureReason", "result" FROM "sub_agent_tasks"
        WHERE "turnId" = $1 ORDER BY "createdAt" LIMIT 6`, [turnId])
    const tasks = diagnosticDiscoveryTasks(result.rows).map(task => {
      const report = record(task.taskGraphVerificationReport)
      const criteria = Array.isArray(report?.criteria)
        ? report.criteria.slice(0, 4).map(value => {
          const criterion = record(value)
          return {
            criterionId: diagnosticEnum(criterion?.criterionId, DISCOVERY_DIAGNOSTIC_CRITERIA) ?? "other",
            status: diagnosticEnum(criterion?.status, TASK_GRAPH_VERIFICATION_STATUSES) ?? "other",
            reasonCode: diagnosticEnum(criterion?.reasonCode, TASK_GRAPH_VERIFICATION_REASONS) ?? "other",
          }
        })
        : []
      const unresolvedCriterionIds = criteria
        .filter(criterion => criterion.status !== "passed")
        .map(criterion => criterion.criterionId)
        .filter((criterionId): criterionId is string => criterionId !== "other")
        .slice(0, 4)
      return {
        role: task.role,
        status: task.status,
        failureReasonCode: task.failureReasonCode,
        verificationStatus: report ? report.status : "missing",
        verificationReasonCode: report ? report.reasonCode : "missing",
        criteria,
        unresolvedCriterionIds,
      }
    })
    return { available: true, taskCount: diagnosticBoundedCount(result.rows.length), tasks }
  } catch {
    return { available: false }
  }
}

function discoveryScheduleFailureDiagnostic(error: unknown): { errorName: string; errorCode: string } {
  const row = record(error)
  const errorName = diagnosticEnum(error instanceof Error ? error.name : row?.name, DISCOVERY_SCHEDULE_ERROR_NAMES) ?? "other"
  const rawCode = typeof row?.code === "string" ? row.code : error instanceof Error ? error.message : null
  const taskGraphCode = typeof rawCode === "string" && /^task_graph_[a-z0-9_]{1,80}$/.test(rawCode) ? rawCode : null
  const code = rawCode === "Child allowed actions exceed parent policy" ? "child_allowed_actions_exceed_parent_policy"
    : rawCode === "Subagent depth limit reached" ? "subagent_depth_limit"
      : rawCode === "Subagent fan-out limit reached" ? "subagent_fan_out_limit"
        : rawCode === "Session is unavailable" ? "session_unavailable"
          : rawCode === "Parent task is unavailable" ? "parent_task_unavailable"
            : rawCode === "Parent task is terminal" ? "parent_task_terminal"
              : rawCode === "Subagent task disappeared" ? "subagent_task_disappeared"
                : rawCode === "Subagent task insert failed" ? "subagent_task_insert_failed" : rawCode
  return { errorName, errorCode: taskGraphCode ?? diagnosticEnum(code, DISCOVERY_SCHEDULE_ERROR_CODES) ?? "other" }
}

function diagnosticDiscoveryTasks(values: readonly unknown[]): RecordValue[] {
  return values.filter(value => {
    const task = record(value)
    return diagnosticEnum(task?.role, DISCOVERY_DIAGNOSTIC_ROLES) !== null
  }).slice(0, 4).map(value => {
    const task = record(value)
    const result = record(task?.result)
    const report = record(result?.taskGraphVerificationReport)
    const criteria = Array.isArray(report?.criteria) ? report.criteria.slice(0, 4).map(value => {
      const criterion = record(value)
      return {
        criterionId: diagnosticEnum(criterion?.criterionId, DISCOVERY_DIAGNOSTIC_CRITERIA) ?? "other",
        status: diagnosticEnum(criterion?.status, TASK_GRAPH_VERIFICATION_STATUSES) ?? "other",
        reasonCode: diagnosticEnum(criterion?.reasonCode, TASK_GRAPH_VERIFICATION_REASONS) ?? "other",
      }
    }) : []
    return {
      role: diagnosticEnum(task?.role, DISCOVERY_DIAGNOSTIC_ROLES) ?? "other",
      status: diagnosticEnum(task?.status, TASK_DIAGNOSTIC_STATUSES) ?? "other",
      failureReasonCode: diagnosticErrorCode(task?.failureReason),
      taskGraphVerificationReport: report ? {
        status: diagnosticEnum(report.status, TASK_GRAPH_VERIFICATION_STATUSES) ?? "other",
        reasonCode: diagnosticEnum(report.reasonCode, TASK_GRAPH_VERIFICATION_REASONS) ?? "other",
        criteria,
      } : null,
    }
  })
}

type DiscoveryVerifierTask = { id: string; role: string; status: string; attemptCount: number; rootTaskId: string | null; parentTaskId: string | null }
function diagnosticJsonRecord(value: unknown): RecordValue | null {
  if (typeof value === "string") { try { return record(JSON.parse(value) as unknown) } catch { return null } }
  return record(value)
}

const ROLE_RESULT_DIAGNOSTIC_CODES = new Set(["invalid_shape", "missing_id", "missing_evidence", "invalid_score"])
const VERIFICATION_DIAGNOSTIC_STATUSES = new Set(["passed", "failed", "unverified"])

async function collectCanonicalDiscoveryScoutResultDiagnostic(
  pool: Pool,
  owner: Fixture,
  expectedJobIds: readonly string[] = [],
): Promise<RecordValue> {
  const result = await pool.query<{ id: string; status: string; result: unknown }>(
    `SELECT task."id", task."status", task."result"
     FROM "sub_agent_tasks" AS task
     JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
     JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
     WHERE task."sessionId" = $1 AND task."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3
       AND task."rootTaskId" = turn."rootTaskId" AND task."parentTaskId" = turn."rootTaskId"
       AND task."role" = 'scout'
      ORDER BY task."createdAt" ASC LIMIT 8`,
    [owner.sessionId, owner.turnId, owner.userId],
  )
  const row = result.rows.length === 1 ? result.rows[0] : undefined
  const scoutRowDiagnostics = result.rows.slice(0, 8).map(task => {
    const taskEnvelope = diagnosticJsonRecord(task.result)
    const structured = record(taskEnvelope?.structuredResult)
    const candidateValues = Array.isArray(structured?.candidates) ? structured.candidates.map(record) : null
    const candidateIds = candidateValues?.flatMap(candidate => typeof candidate?.jobId === "string" ? [candidate.jobId] : []) ?? []
    const evidence = Array.isArray(structured?.evidence) ? structured.evidence.map(record) : []
    const hasRedactionMarker = (value: string) => /\[REDACTED(?:_(?:PHONE|EMAIL))?\]/i.test(value)
    return {
      status: diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES) ?? "other",
      targetJobMatch: expectedJobIds.length === 0 ? "not_checked"
        : candidateValues === null ? "unknown"
          : candidateIds.some(id => expectedJobIds.includes(id)) ? "present" : "absent",
      candidateIdRedactionMarker: candidateIds.some(hasRedactionMarker),
      evidenceIdRedactionMarker: evidence.some(item => [item?.id, item?.ref]
        .some(value => typeof value === "string" && hasRedactionMarker(value))),
    }
  })
  const searchResult = await pool.query<{
    callCount: number; resultCount: number; inlineResultCount: number; returnedJobCount: number;
    targetJobPresent: boolean | null; returnedJobIdRedactionMarker: boolean | null
  }>(
    `SELECT COUNT(DISTINCT call."id")::int AS "callCount",
       COUNT(DISTINCT result."id")::int AS "resultCount",
       COUNT(DISTINCT result."id") FILTER (WHERE result."status" = 'completed'
         AND result."content"->>'errorCode' IS NULL
         AND jsonb_typeof(result."content"->'output'->'jobs') = 'array')::int AS "inlineResultCount",
       COUNT(DISTINCT job.value->>'id') FILTER (WHERE jsonb_typeof(job.value->'id') = 'string')::int AS "returnedJobCount",
       CASE WHEN COUNT(DISTINCT result."id") FILTER (WHERE result."status" = 'completed'
         AND result."content"->>'errorCode' IS NULL
         AND jsonb_typeof(result."content"->'output'->'jobs') = 'array') > 0
         THEN COALESCE(bool_or(job.value->>'id' = ANY($4::text[])), false) ELSE NULL END AS "targetJobPresent",
       CASE WHEN COUNT(DISTINCT result."id") FILTER (WHERE result."status" = 'completed'
         AND result."content"->>'errorCode' IS NULL
         AND jsonb_typeof(result."content"->'output'->'jobs') = 'array') > 0
         THEN COALESCE(bool_or(position('[REDACTED]' in COALESCE(job.value->>'id', '')) > 0
           OR position('[REDACTED_PHONE]' in COALESCE(job.value->>'id', '')) > 0
           OR position('[REDACTED_EMAIL]' in COALESCE(job.value->>'id', '')) > 0), false) ELSE NULL END AS "returnedJobIdRedactionMarker"
     FROM "sub_agent_tasks" AS task
     JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
     JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
     LEFT JOIN "agent_items" AS call ON call."sessionId" = task."sessionId" AND call."turnId" = task."turnId"
       AND call."taskId" = task."id" AND call."type" = 'tool_call'
       AND call."content"->>'toolName' = 'jobs.search'
     LEFT JOIN "agent_items" AS result ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
       AND result."taskId" = call."taskId" AND result."type" = 'tool_result'
       AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
     LEFT JOIN LATERAL jsonb_array_elements(CASE
       WHEN result."status" = 'completed' AND result."content"->>'errorCode' IS NULL
         AND jsonb_typeof(result."content"->'output'->'jobs') = 'array'
       THEN result."content"->'output'->'jobs' ELSE '[]'::jsonb END) AS job(value) ON true
     WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
       AND session."userId" = $5 AND turn."userId" = $5 AND task."rootTaskId" = turn."rootTaskId"
       AND task."parentTaskId" = turn."rootTaskId" AND task."role" = 'scout'`,
    [result.rows.map(task => task.id), owner.sessionId, owner.turnId, [...expectedJobIds], owner.userId],
  )
  const search = searchResult.rows[0]
  const envelope = diagnosticJsonRecord(row?.result)
  const keys = envelope ? Object.keys(envelope).sort().join(",") : ""
  const baseKeys = "finalItemId,finalText,status,stepCount,structuredResult,toolCallCount"
  const typedKeys = [...baseKeys.split(","), "taskGraphVerificationReport"].sort().join(",")
  const envelopeShape = keys === typedKeys ? "typed_with_report" : keys === baseKeys ? "base_without_report" : envelope ? "other" : "missing"
  const envelopeStatus = diagnosticEnum(envelope?.status, new Set(["completed", "failed", "waiting"]))
    ?? (envelope && Object.hasOwn(envelope, "status") ? "other" : "missing")
  let validated: StructuredRoleResult | null = null
  let roleResultValidity = "not_checked"
  let roleResultValidationCode = "not_checked"
  if (envelope && Object.hasOwn(envelope, "structuredResult")) {
    roleResultValidity = "invalid"
    roleResultValidationCode = "other"
    try {
      validated = validateRoleResult(envelope.structuredResult, "scout")
      roleResultValidity = "valid"
      roleResultValidationCode = "none"
    } catch (error: unknown) {
      const code = error instanceof RoleResultValidationError ? error.code : "other"
      roleResultValidationCode = ROLE_RESULT_DIAGNOSTIC_CODES.has(code) ? code : "other"
    }
  }
  const report = parseTaskGraphVerificationReport(envelope?.taskGraphVerificationReport, ["candidate-count"])
  const rawReport = diagnosticJsonRecord(envelope?.taskGraphVerificationReport)
  let resultDigestMatch = "not_checked"
  if (validated && report) {
    try { resultDigestMatch = report.resultDigest === taskGraphResultDigest(validated) ? "match" : "mismatch" }
    catch { resultDigestMatch = "error" }
  }
  const projectionAvailability = validated
    ? projectValidatedRoleResult(validated).availability === "available" ? "available" : "unavailable"
    : "not_checked"
  const taskStatus = diagnosticEnum(row?.status, TASK_DIAGNOSTIC_STATUSES) ?? (row ? "other" : "missing")
  const reportStatus = diagnosticEnum(rawReport?.status, VERIFICATION_DIAGNOSTIC_STATUSES)
    ?? (rawReport && Object.hasOwn(rawReport, "status") ? "other" : "missing")
  return {
    scopedScoutRows: result.rows.length === 0 ? "none" : result.rows.length === 1 ? "one" : "multiple",
    scopedScoutRowCount: diagnosticBoundedCount(result.rows.length),
    scopedScoutRowDiagnostics: scoutRowDiagnostics,
    jobsSearchCallCount: diagnosticBoundedCount(search?.callCount),
    jobsSearchResultCount: diagnosticBoundedCount(search?.resultCount),
    jobsSearchInlineResultCount: diagnosticBoundedCount(search?.inlineResultCount),
    jobsSearchReturnedJobCount: diagnosticBoundedCount(search?.returnedJobCount),
    jobsSearchTargetJobPresent: search?.targetJobPresent ?? null,
    jobsSearchReturnedIdRedactionMarker: search?.returnedJobIdRedactionMarker ?? null,
    taskStatus,
    envelopeShape,
    envelopeStatus,
    envelopeCountersValid: Number.isSafeInteger(envelope?.stepCount) && Number(envelope?.stepCount) >= 0
      && Number.isSafeInteger(envelope?.toolCallCount) && Number(envelope?.toolCallCount) >= 0,
    envelopeFinalItemIdKind: envelope && Object.hasOwn(envelope, "finalItemId")
      ? envelope.finalItemId === null ? "null" : typeof envelope.finalItemId === "string" ? "string" : "other"
      : "missing",
    envelopeFinalTextKind: envelope && Object.hasOwn(envelope, "finalText")
      ? envelope.finalText === null ? "null" : typeof envelope.finalText === "string" ? "string" : "other"
      : "missing",
    roleResultValidity,
    roleResultValidationCode,
    verificationReportValid: Boolean(report),
    verificationReportStatus: reportStatus,
    resultDigestMatch,
    projectionAvailability,
  }
}

function diagnosticHasTruncation(value: unknown, depth = 0, seen = new Set<object>()): boolean {
  if (depth > 32 || value === "[TRUNCATED]" || typeof value === "string" && value.includes("...[TRUNCATED]")) return true
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return true
  seen.add(value)
  try {
    const row = record(value)
    if (row && row.truncated === true && typeof row.preview === "string" && Number.isSafeInteger(row.byteLength)) return true
    return (Array.isArray(value) ? value : Object.values(value)).some(child => diagnosticHasTruncation(child, depth + 1, seen))
  } finally { seen.delete(value) }
}
function diagnosticByteBand(value: unknown): string {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) return "unserializable"
    const bytes = Buffer.byteLength(encoded, "utf8")
    return bytes <= 8 * 1024 ? "le_8k" : bytes <= 512 * 1024 ? "le_512k" : bytes <= 2 * 1024 * 1024 ? "le_2m" : "over_2m"
  } catch { return "unserializable" }
}
function projectDiscoveryVerifierDiagnostics(
  tasks: readonly DiscoveryVerifierTask[], items: readonly RecordValue[], events: readonly RecordValue[], scope: Fixture,
): RecordValue[] {
  return tasks.filter(task => diagnosticEnum(task.role, DISCOVERY_DIAGNOSTIC_ROLES) !== null).slice(0, 4).map(task => {
    const taskItems = items.filter(item => item.taskId === task.id)
    const calls = taskItems.filter(item => item.type === "tool_call"), results = taskItems.filter(item => item.type === "tool_result")
    const callsById = new Map<string, RecordValue>(), resultsById = new Map<string, RecordValue>(), callItemIds = new Map<string, string>()
    let duplicateCallIds = 0, itemScopeValid = true, itemAttemptValid = true, itemShapeValid = true
    for (const item of taskItems) {
      const content = diagnosticJsonRecord(item.content), callId = typeof content?.toolCallId === "string" ? content.toolCallId : undefined
      const target = item.type === "tool_call" ? callsById : item.type === "tool_result" ? resultsById : undefined
      if (!content || !target || !callId) { itemShapeValid = false; continue }
      if (target.has(callId)) duplicateCallIds += 1
      target.set(callId, item)
      if (item.type === "tool_call") callItemIds.set(String(item.id), callId)
      itemScopeValid &&= item.sessionId === scope.sessionId && item.turnId === scope.turnId && item.userId === scope.userId
        && item.turnUserId === scope.userId && item.rootTaskId === task.rootTaskId && item.turnRootTaskId === task.rootTaskId
        && item.joinedStepId === item.stepId && typeof item.stepId === "string"
      itemAttemptValid &&= Number(item.attempt) === task.attemptCount
      itemShapeValid &&= item.status === "completed" && Number.isSafeInteger(Number(item.ordinal)) && Number(item.ordinal) >= 0
        && Number.isSafeInteger(Number(item.revision)) && Number(item.revision) >= 0
        && diagnosticEnum(item.stepStatus, STEP_DIAGNOSTIC_STATUSES) !== null
    }
    const paired = [...callsById.entries()].filter(([id]) => resultsById.has(id))
    const pairShapeValid = duplicateCallIds === 0 && calls.length === results.length && callsById.size === calls.length
      && resultsById.size === results.length && paired.length === calls.length && calls.length > 0
    let contentPairValid = pairShapeValid
    const searchOutputs: unknown[] = []
    for (const [id, call] of callsById) {
      const callContent = diagnosticJsonRecord(call.content), result = resultsById.get(id), resultContent = diagnosticJsonRecord(result?.content)
      contentPairValid &&= Boolean(result && result.stepId === call.stepId && Number(result.attempt) === Number(call.attempt)
        && Number(result.ordinal) === Number(call.ordinal) && typeof callContent?.toolName === "string" && callContent.toolName.trim() === callContent.toolName
        && typeof callContent.toolVersion === "string" && callContent.toolVersion.trim() === callContent.toolVersion
        && Object.hasOwn(callContent ?? {}, "input") && resultContent && Object.hasOwn(resultContent, "output") && result.status === "completed"
        && (callContent?.status === "completed" || callContent?.status === "failed")
        && callContent?.errorCode === resultContent?.errorCode
        && (callContent?.status === "completed" ? callContent?.errorCode === null : typeof callContent?.errorCode === "string" && callContent.errorCode.trim().length > 0))
      if (callContent?.toolName === "jobs.search" && resultContent && Object.hasOwn(resultContent, "output")) searchOutputs.push(resultContent.output)
    }
    const relevantEvents = events.filter(event => typeof event.itemId === "string" && callItemIds.has(event.itemId))
    const groups = new Map<string, RecordValue[]>()
    let eventIdentityValid = true, eventSequenceValid = true, unmatchedEvents = 0
    for (const event of relevantEvents) {
      const payload = diagnosticJsonRecord(event.payload)
      const callId = typeof event.itemId === "string" ? callItemIds.get(event.itemId) : undefined
      const call = callId ? callsById.get(callId) : undefined, content = diagnosticJsonRecord(call?.content)
      if (!callId || !call || !payload) { unmatchedEvents += 1; eventIdentityValid = false; continue }
      const matching = event.taskId === task.id && event.itemId === call.id && event.correlationId === callId
        && ["tool_call.started", "tool_call.completed", "tool_call.failed"].includes(String(event.type))
        && payload.taskId === task.id && payload.toolCallId === callId && payload.toolName === content?.toolName
        && Number.isSafeInteger(Number(event.sequence))
      eventIdentityValid &&= matching
      eventSequenceValid &&= Number.isSafeInteger(Number(event.sequence))
      const list = groups.get(callId) ?? []; list.push(event); groups.set(callId, list)
    }
    let eventPairsValid = eventIdentityValid && eventSequenceValid
    let startedCount = 0, terminalCount = 0
    for (const [id, call] of callsById) {
      const list = groups.get(id) ?? [], started = list.filter(event => event.type === "tool_call.started")
      const terminal = list.filter(event => event.type === "tool_call.completed" || event.type === "tool_call.failed")
      startedCount += started.length; terminalCount += terminal.length
      const content = diagnosticJsonRecord(call.content), payload = diagnosticJsonRecord(terminal[0]?.payload)
      const orderValid = Number(started[0]?.sequence) < Number(terminal[0]?.sequence)
      const outcomeValid = content?.status === "completed"
        ? terminal[0]?.type === "tool_call.completed" && payload?.status === "completed" && payload.errorCode === null
        : terminal[0]?.type === "tool_call.failed" && payload?.status === "failed" && typeof payload.errorCode === "string"
      eventPairsValid &&= started.length === 1 && terminal.length === 1 && orderValid && outcomeValid
        && payload?.errorCode === content?.errorCode
        && (payload?.toolVersion === undefined || payload.toolVersion === content?.toolVersion)
    }
    const outputs = searchOutputs.slice(0, 4).map(output => {
      const row = diagnosticJsonRecord(output), jobs = row?.jobs
      const list = Array.isArray(jobs) ? jobs : []
      const ids = list.map(value => diagnosticJsonRecord(value)?.id)
      const validIds = ids.every(id => typeof id === "string" && id.length > 0 && id.trim() === id)
      const sourcesValid = list.every(value => {
        const source = diagnosticJsonRecord(value)?.source
        return source === undefined || source === null || typeof source === "string" && source.length > 0 && source.length <= 256 && source.trim() === source
      })
      return {
        outputKind: row ? "object" : diagnosticValueType(output),
        jobsArray: Array.isArray(jobs), jobsCount: Array.isArray(jobs) ? diagnosticBoundedCount(jobs.length) : null,
        jobsCountWithinVerifierCap: Array.isArray(jobs) && jobs.length <= 50,
        jobsDense: Array.isArray(jobs) && Reflect.ownKeys(jobs).length === jobs.length + 1,
        jobIdsValid: validIds && new Set(ids).size === ids.length, sourcesValid,
        truncatedMarker: diagnosticHasTruncation(output), byteBand: diagnosticByteBand(output),
      }
    })
    return {
      role: diagnosticEnum(task.role, DISCOVERY_DIAGNOSTIC_ROLES) ?? "other",
      taskStatus: diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES) ?? "other",
      taskAttempt: diagnosticBoundedCount(task.attemptCount),
      taskRootMatchesParent: typeof task.rootTaskId === "string" && task.rootTaskId === task.parentTaskId,
      itemCount: diagnosticBoundedCount(taskItems.length), callCount: diagnosticBoundedCount(calls.length),
      resultCount: diagnosticBoundedCount(results.length), pairCount: diagnosticBoundedCount(paired.length), duplicateCallIds: diagnosticBoundedCount(duplicateCallIds),
      itemScopeValid, itemAttemptValid, itemShapeValid, pairShapeValid, contentPairValid,
      itemStatuses: diagnosticEnumList(taskItems.map(item => item.status), ITEM_DIAGNOSTIC_STATUSES),
      stepStatuses: diagnosticEnumList(taskItems.map(item => item.stepStatus), STEP_DIAGNOSTIC_STATUSES),
      eventCount: diagnosticBoundedCount(relevantEvents.length), startedEventCount: diagnosticBoundedCount(startedCount),
      terminalEventCount: diagnosticBoundedCount(terminalCount), unmatchedEvents: diagnosticBoundedCount(unmatchedEvents), eventIdentityValid, eventSequenceValid, eventPairsValid,
      jobsSearchOutputCount: diagnosticBoundedCount(searchOutputs.length), jobsSearchOutputs: outputs,
    }
  })
}
async function collectDiscoveryVerifierDiagnostics(pool: Pool, scope: Fixture, tasks: readonly DiscoveryVerifierTask[]): Promise<RecordValue[]> {
  const relevantTasks = tasks.filter(task => diagnosticEnum(task.role, DISCOVERY_DIAGNOSTIC_ROLES) !== null).slice(0, 4)
  if (relevantTasks.length === 0) return []
  try {
    const ids = relevantTasks.map(task => task.id)
    const [items, events] = await Promise.all([
      pool.query<RecordValue>(`SELECT item."id", item."sessionId", item."turnId", item."taskId", item."stepId", item."type", item."status", item."revision", item."content",
          step."id" AS "joinedStepId", step."status" AS "stepStatus", step."attempt", step."ordinal", task."rootTaskId", turn."rootTaskId" AS "turnRootTaskId",
          session."userId" AS "userId", turn."userId" AS "turnUserId"
        FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
        JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
        JOIN "agent_sessions" AS session ON session."id" = item."sessionId" JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
        WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = ANY($3::text[]) AND item."type" IN ('tool_call', 'tool_result')
        ORDER BY step."attempt", step."ordinal", item."createdAt", item."id" LIMIT 1025`, [scope.sessionId, scope.turnId, ids]),
      pool.query<RecordValue>(`SELECT event."taskId", event."itemId", event."correlationId", event."type", event."payload", event."sequence"
        FROM "agent_events" AS event
        JOIN "agent_items" AS item ON item."id" = event."itemId" AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
        WHERE event."sessionId" = $1 AND event."turnId" = $2 AND item."taskId" = ANY($3::text[]) AND item."type" = 'tool_call'
          AND event."type" IN ('tool_call.started', 'tool_call.completed', 'tool_call.failed') ORDER BY event."sequence" LIMIT 3073`,
      [scope.sessionId, scope.turnId, ids]),
    ])
    const projected = projectDiscoveryVerifierDiagnostics(relevantTasks, items.rows, events.rows, scope)
    return projected.map(entry => ({
      ...entry,
      itemQueryLimitExceeded: items.rows.length > 1024,
      eventQueryLimitExceeded: events.rows.length > 3072,
    }))
  } catch { return [{ diagnosticAvailable: false }] }
}

function diagnosticEnumList(value: unknown, allowed: ReadonlySet<string>, maxItems = 8): string[] {
  if (!Array.isArray(value)) return []
  const projected: string[] = []
  for (const item of value.slice(0, maxItems * 2)) {
    const safeValue = diagnosticEnum(item, allowed)
    if (safeValue && !projected.includes(safeValue)) projected.push(safeValue)
    if (projected.length >= maxItems) break
  }
  return projected
}

function diagnosticCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length
  if (typeof value !== "string") return null
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.length : null
  } catch {
    return null
  }
}

function diagnosticBoundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000 ? value : null
}

function diagnosticStatusCounts(value: unknown): RecordValue {
  const counts = record(value)
  if (!counts) return {}
  const projected: RecordValue = {}
  for (const [status, count] of Object.entries(counts).slice(0, 10)) {
    const safeStatus = diagnosticEnum(status, TASK_DIAGNOSTIC_STATUSES)
    const safeCount = diagnosticBoundedCount(count)
    if (safeStatus && safeCount !== null) projected[safeStatus] = safeCount
  }
  return projected
}

type DiagnosticIdList = { values: string[]; count: number | null; valid: boolean }

function diagnosticIdList(value: unknown, maxItems = 50): DiagnosticIdList {
  if (!Array.isArray(value)) return { values: [], count: null, valid: false }
  const valid = value.length <= maxItems && value.every(item => typeof item === "string" && item.trim().length > 0 && item.length <= 256)
    && new Set(value).size === value.length
  return { values: valid ? value as string[] : [], count: value.length, valid }
}

function diagnosticIdListsMatch(left: DiagnosticIdList, right: DiagnosticIdList): boolean | null {
  if (!left.valid || !right.valid) return null
  if (left.values.length !== right.values.length) return false
  const rightValues = new Set(right.values)
  return left.values.every(value => rightValues.has(value))
}

function diagnosticIdListContainsAll(requested: DiagnosticIdList, available: DiagnosticIdList): boolean | null {
  if (!requested.valid || !available.valid) return null
  if (requested.values.length === 0) return false
  const availableValues = new Set(available.values)
  return requested.values.every(value => availableValues.has(value))
}

type WaitProposalCandidate = {
  payload: RecordValue
  receipt: RecordValue
  rawNodes: unknown[]
  nodes: RecordValue[]
  taskIds: DiagnosticIdList
}

function proposalReceiptCandidates(payloads: readonly unknown[]): WaitProposalCandidate[] {
  const candidates: WaitProposalCandidate[] = []
  for (const rawPayload of payloads) {
    const payload = record(rawPayload)
    const receipt = record(payload?.receipt)
    if (payload?.kind !== "proposal" || !Array.isArray(receipt?.nodes)) continue
    const rawNodes = receipt.nodes
    const nodes = rawNodes.map(record).filter((node): node is RecordValue => node !== null)
    candidates.push({
      payload, receipt, rawNodes, nodes,
      taskIds: diagnosticIdList(rawNodes.map(node => record(node)?.taskId)),
    })
  }
  return candidates
}

function proposalReceiptForWait(requestedIds: DiagnosticIdList, payloads: readonly unknown[]): WaitProposalCandidate | null {
  const candidates = proposalReceiptCandidates(payloads)
  return candidates.find(candidate => diagnosticIdListsMatch(requestedIds, candidate.taskIds) === true)
    ?? null
}

function failedWaitReceiptProjection(requestedIds: DiagnosticIdList, payloads: readonly unknown[]): Readonly<{
  exactReceiptMatchExists: boolean | null
  proposalReceiptCandidateCount: number | null
  closestReceiptNodeCount: number | null
  closestReceiptNodeKeys: readonly string[]
  requestedIdsOutsideReceiptCount: number | null
}> {
  const candidates = proposalReceiptCandidates(payloads)
  const exact = candidates.find(candidate => diagnosticIdListsMatch(requestedIds, candidate.taskIds) === true) ?? null
  let closest: WaitProposalCandidate | null = null
  let closestOverlap = -1
  for (const candidate of candidates) {
    const candidateIds = new Set(candidate.taskIds.values)
    const overlap = requestedIds.valid && candidate.taskIds.valid
      ? requestedIds.values.filter(id => candidateIds.has(id)).length
      : -1
    // Proposal receipts arrive newest-first; preserve that order for ties.
    if (!closest || overlap > closestOverlap) {
      closest = candidate
      closestOverlap = overlap
    }
  }
  const selected = exact ?? closest
  const selectedIds = selected?.taskIds
  const outsideCount = selected && requestedIds.valid && selectedIds?.valid
    ? requestedIds.values.filter(id => !new Set(selectedIds.values).has(id)).length
    : null
  return {
    exactReceiptMatchExists: requestedIds.valid ? exact !== null : null,
    proposalReceiptCandidateCount: diagnosticBoundedCount(candidates.length),
    closestReceiptNodeCount: diagnosticBoundedCount(selected?.rawNodes.length ?? null),
    closestReceiptNodeKeys: selected
      ? diagnosticEnumList(selected.nodes.map(node => node.key), TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
      : [],
    requestedIdsOutsideReceiptCount: diagnosticBoundedCount(outsideCount),
  }
}

type DiagnosticTaskGraphNodes = Readonly<{
  count: number | null
  taskIdCount: number | null
  valid: boolean
  keys: readonly string[]
  byKey: ReadonlyMap<string, string>
}>

function diagnosticTaskGraphNodes(value: unknown): DiagnosticTaskGraphNodes {
  if (!Array.isArray(value)) return { count: null, taskIdCount: null, valid: false, keys: [], byKey: new Map() }
  const nodes = value.map(record)
  const entries = nodes.flatMap(node => typeof node?.key === "string" && typeof node.taskId === "string"
    ? [[node.key, node.taskId] as const]
    : [])
  const keys = entries.map(([key]) => key)
  const ids = entries.map(([, taskId]) => taskId)
  const byKey = new Map(entries)
  const valid = value.length <= 16 && nodes.every(node => node !== null
    && typeof node.key === "string" && node.key.trim().length > 0
    && typeof node.taskId === "string" && node.taskId.trim().length > 0 && node.taskId.length <= 256)
    && keys.length === nodes.length && byKey.size === nodes.length
    && new Set(ids).size === ids.length
  return {
    count: value.length,
    taskIdCount: nodes.filter(node => typeof node?.taskId === "string").length,
    valid,
    keys: [...new Set(keys.filter(key => TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(key)))].sort().slice(0, 8),
    byKey,
  }
}

function diagnosticTaskGraphNodeMapsMatch(left: DiagnosticTaskGraphNodes, right: DiagnosticTaskGraphNodes): boolean | null {
  if (!left.valid || !right.valid) return null
  if (left.byKey.size !== right.byKey.size) return false
  return [...left.byKey].every(([key, taskId]) => right.byKey.get(key) === taskId)
}

function diagnosticTaskGraphMismatchKeys(left: DiagnosticTaskGraphNodes, right: DiagnosticTaskGraphNodes): string[] {
  const keys = new Set([...left.byKey.keys(), ...right.byKey.keys()])
  return [...keys].filter(key => TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(key)
    && left.byKey.get(key) !== right.byKey.get(key)).sort().slice(0, 8)
}

function diagnosticTaskGraphRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_646
    ? value
    : null
}

function firstWaitPlanGraphMismatchProjection(input: {
  requestReceipt: unknown
  requestGraph: unknown
  persistedToolReceipt: unknown
  persistedToolResultItemRevision: unknown
  persistedToolResultItemStatus: unknown
  persistedReceipt: unknown
  persistedSnapshot: unknown
  persistedItemRevision: unknown
  persistedReceiptItem: unknown
}): RecordValue {
  const requestReceipt = record(input.requestReceipt)
  const requestGraph = record(input.requestGraph)
  const persistedToolReceipt = record(input.persistedToolReceipt)
  const persistedReceipt = record(input.persistedReceipt)
  const persistedSnapshot = record(input.persistedSnapshot)
  const persistedReceiptItem = record(input.persistedReceiptItem)
  const embeddedSnapshot = record(persistedReceiptItem?.content)
  const requestReceiptNodes = diagnosticTaskGraphNodes(requestReceipt?.nodes)
  const requestGraphNodes = diagnosticTaskGraphNodes(requestGraph?.nodes)
  const persistedToolReceiptNodes = diagnosticTaskGraphNodes(persistedToolReceipt?.nodes)
  const persistedReceiptNodes = diagnosticTaskGraphNodes(persistedReceipt?.nodes)
  const persistedSnapshotNodes = diagnosticTaskGraphNodes(persistedSnapshot?.nodes)
  const embeddedSnapshotNodes = diagnosticTaskGraphNodes(embeddedSnapshot?.nodes)
  const requestReceiptMatchesPersistedReceipt = diagnosticTaskGraphNodeMapsMatch(requestReceiptNodes, persistedReceiptNodes)
  const comparisons = {
    requestReceiptMatchesPersistedToolReceipt: diagnosticTaskGraphNodeMapsMatch(requestReceiptNodes, persistedToolReceiptNodes),
    persistedToolReceiptMatchesPersistedReceipt: diagnosticTaskGraphNodeMapsMatch(persistedToolReceiptNodes, persistedReceiptNodes),
    persistedToolReceiptMatchesSnapshot: diagnosticTaskGraphNodeMapsMatch(persistedToolReceiptNodes, persistedSnapshotNodes),
    requestReceiptMatchesRequestGraph: diagnosticTaskGraphNodeMapsMatch(requestReceiptNodes, requestGraphNodes),
    requestGraphMatchesPersistedSnapshot: diagnosticTaskGraphNodeMapsMatch(requestGraphNodes, persistedSnapshotNodes),
    persistedReceiptMatchesSnapshot: diagnosticTaskGraphNodeMapsMatch(persistedReceiptNodes, persistedSnapshotNodes),
    persistedReceiptMatchesEmbeddedSnapshot: diagnosticTaskGraphNodeMapsMatch(persistedReceiptNodes, embeddedSnapshotNodes),
    embeddedSnapshotMatchesCurrentSnapshot: diagnosticTaskGraphNodeMapsMatch(embeddedSnapshotNodes, persistedSnapshotNodes),
  }
  const diagnosis = comparisons.persistedReceiptMatchesSnapshot === false
    || comparisons.persistedReceiptMatchesEmbeddedSnapshot === false
    || comparisons.embeddedSnapshotMatchesCurrentSnapshot === false
    ? "persisted_receipt_snapshot_lineage_mismatch"
    : comparisons.persistedToolReceiptMatchesPersistedReceipt === false
      ? "persisted_tool_receipt_proposal_mismatch"
      : comparisons.persistedToolReceiptMatchesSnapshot === false
        ? "persisted_tool_receipt_snapshot_mismatch"
        : comparisons.requestReceiptMatchesPersistedToolReceipt === false
          ? "request_persisted_tool_receipt_mismatch"
          : comparisons.requestGraphMatchesPersistedSnapshot === false
            ? "stale_request_graph_context"
            : requestReceiptMatchesPersistedReceipt === false
              ? "stale_or_wrong_request_receipt"
              : comparisons.requestReceiptMatchesRequestGraph === false
                ? "request_receipt_graph_pairing_mismatch"
                : "request_graph_and_receipt_match_persisted_state"
  const safeKeys = (keys: string[]) => keys.filter(key => TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(key)).slice(0, 8)
  return {
    available: true,
    diagnosis,
    request: {
      receiptStatus: requestReceipt?.status === "accepted" || requestReceipt?.status === "duplicate" ? requestReceipt.status : "other",
      receiptRevision: diagnosticTaskGraphRevision(requestReceipt?.revision),
      graphRevision: diagnosticTaskGraphRevision(requestGraph?.revision),
      receiptNodeCount: diagnosticBoundedCount(requestReceiptNodes.count),
      graphNodeCount: diagnosticBoundedCount(requestGraphNodes.count),
      receiptTaskIdCount: diagnosticBoundedCount(requestReceiptNodes.taskIdCount),
      graphTaskIdCount: diagnosticBoundedCount(requestGraphNodes.taskIdCount),
    },
    persisted: {
      toolResultItemRevision: diagnosticTaskGraphRevision(input.persistedToolResultItemRevision),
      toolResultItemStatus: diagnosticEnum(input.persistedToolResultItemStatus, ITEM_DIAGNOSTIC_STATUSES),
      toolReceiptRevision: diagnosticTaskGraphRevision(persistedToolReceipt?.revision),
      toolReceiptNodeCount: diagnosticBoundedCount(persistedToolReceiptNodes.count),
      toolReceiptTaskIdCount: diagnosticBoundedCount(persistedToolReceiptNodes.taskIdCount),
      receiptRevision: diagnosticTaskGraphRevision(persistedReceipt?.revision),
      currentItemRevision: diagnosticTaskGraphRevision(input.persistedItemRevision),
      receiptNodeCount: diagnosticBoundedCount(persistedReceiptNodes.count),
      receiptTaskIdCount: diagnosticBoundedCount(persistedReceiptNodes.taskIdCount),
      snapshotNodeCount: diagnosticBoundedCount(persistedSnapshotNodes.count),
      snapshotTaskIdCount: diagnosticBoundedCount(persistedSnapshotNodes.taskIdCount),
    },
    comparisons,
    mismatchKeys: {
      requestReceiptPersistedToolReceipt: safeKeys(diagnosticTaskGraphMismatchKeys(requestReceiptNodes, persistedToolReceiptNodes)),
      persistedToolReceiptProposal: safeKeys(diagnosticTaskGraphMismatchKeys(persistedToolReceiptNodes, persistedReceiptNodes)),
      persistedToolReceiptSnapshot: safeKeys(diagnosticTaskGraphMismatchKeys(persistedToolReceiptNodes, persistedSnapshotNodes)),
      requestReceiptGraph: safeKeys(diagnosticTaskGraphMismatchKeys(requestReceiptNodes, requestGraphNodes)),
      requestGraphPersistedSnapshot: safeKeys(diagnosticTaskGraphMismatchKeys(requestGraphNodes, persistedSnapshotNodes)),
      persistedReceiptSnapshot: safeKeys(diagnosticTaskGraphMismatchKeys(persistedReceiptNodes, persistedSnapshotNodes)),
    },
  }
}

async function collectFirstWaitPlanGraphMismatchDiagnostics(
  pool: Pool,
  turnId: string,
  request: HarnessModelRequest,
  planCallId: string,
  graph: unknown,
): Promise<string> {
  try {
    const result = await pool.query<{
      itemRevision: unknown
      content: unknown
      proposalPayload: unknown
      toolResultItemRevision: unknown
      toolResultItemStatus: unknown
      toolResultContent: unknown
    }>(`SELECT item."revision" AS "itemRevision", item."content",
         (SELECT event."payload" FROM "agent_events" AS event
          WHERE event."sessionId" = turn."sessionId" AND event."turnId" = turn."id" AND event."itemId" = item."id"
            AND event."type" IN ('item.started', 'item.delta') AND event."payload"->>'kind' = 'proposal'
            AND event."payload"->'receipt'->>'revision' = toolResult."content"->'output'->>'revision'
          ORDER BY event."sequence" DESC LIMIT 1) AS "proposalPayload",
         toolResult."revision" AS "toolResultItemRevision",
         toolResult."status" AS "toolResultItemStatus",
         toolResult."content" AS "toolResultContent"
       FROM "agent_turns" AS turn JOIN "agent_items" AS item
         ON item."sessionId" = turn."sessionId" AND item."turnId" = turn."id"
          AND item."taskId" = turn."rootTaskId" AND item."type" = 'task_graph'
       LEFT JOIN LATERAL (
         SELECT resultItem."revision", resultItem."status", resultItem."content"
         FROM "agent_items" AS resultItem
         WHERE resultItem."sessionId" = turn."sessionId" AND resultItem."turnId" = turn."id"
           AND resultItem."taskId" = turn."rootTaskId" AND resultItem."type" = 'tool_result'
           AND resultItem."content"->>'toolCallId' = $2
         ORDER BY resultItem."revision" DESC, resultItem."updatedAt" DESC LIMIT 1
       ) AS toolResult ON TRUE
       WHERE turn."id" = $1 ORDER BY item."revision" DESC, item."updatedAt" DESC LIMIT 1`, [turnId, planCallId])
    const row = result.rows[0]
    const proposalPayload = record(row?.proposalPayload)
    const proposalItem = record(proposalPayload?.item)
    const toolResultContent = record(row?.toolResultContent)
    const projection = firstWaitPlanGraphMismatchProjection({
      requestReceipt: latestToolResult(request, planCallId),
      requestGraph: graph,
      persistedToolReceipt: toolResultContent?.output,
      persistedToolResultItemRevision: row?.toolResultItemRevision,
      persistedToolResultItemStatus: row?.toolResultItemStatus,
      persistedReceipt: record(proposalPayload?.receipt),
      persistedSnapshot: record(row?.content),
      persistedItemRevision: row?.itemRevision,
      persistedReceiptItem: proposalItem,
    })
    return boundedDiagnostic(JSON.stringify(projection), 1_200)
  } catch {
    return JSON.stringify({ available: false })
  }
}

function compactTurnProgressDiagnostics(progress: string, maxCharacters = 1_600): string {
  let parsed: RecordValue | null = null
  try { parsed = record(JSON.parse(progress) as unknown) } catch { return JSON.stringify({ available: false }) }
  if (!parsed) return JSON.stringify({ available: false })

  const turn = record(parsed.turn)
  const tool = record(parsed.waitToolResult)
  const rootFailure = record(parsed.rootFailure)
  const waitLineage = record(parsed.waitLineage)
  const targetRows = record(waitLineage?.targetRows)
  const targetMismatchCounts = record(targetRows?.mismatchCounts)
  const parentMismatchCounts = record(waitLineage?.parentMismatchCounts)
  const toolFailure = record(parsed.diagnosticToolFailure)
  const toolFailures = Array.isArray(parsed.diagnosticToolFailures)
    ? parsed.diagnosticToolFailures.map(record).filter((item): item is RecordValue => item !== null)
    : toolFailure ? [toolFailure] : []
  const executionFailures = Array.isArray(parsed.executionFailures)
    ? parsed.executionFailures.map(record).filter((item): item is RecordValue => item !== null)
    : []
  const fixtureNodeKeysMissingRows = waitLineage?.fixtureNodeKeysMissingRows
  const exactReceiptMatchExists = typeof waitLineage?.exactReceiptMatchExists === "boolean"
    ? waitLineage.exactReceiptMatchExists : null
  const proposalReceiptCandidateCount = diagnosticBoundedCount(waitLineage?.proposalReceiptCandidateCount)
  const closestReceiptNodeCount = diagnosticBoundedCount(waitLineage?.closestReceiptNodeCount)
  const closestReceiptNodeKeys = diagnosticEnumList(waitLineage?.closestReceiptNodeKeys, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.map(record).filter((item): item is RecordValue => item !== null) : []
  const waits = Array.isArray(parsed.waits) ? parsed.waits.map(record).filter((item): item is RecordValue => item !== null) : []
  const rootFailureEvents = Array.isArray(rootFailure?.events) ? rootFailure.events.map(record).filter((item): item is RecordValue => item !== null) : []
  const rootSteps = Array.isArray(parsed.rootSteps) ? parsed.rootSteps.map(record).filter((item): item is RecordValue => item !== null) : []
  const rootToolItems = Array.isArray(parsed.rootToolItems) ? parsed.rootToolItems.map(record).filter((item): item is RecordValue => item !== null) : []
  const snapshot = {
    turn: turn ? {
      status: diagnosticEnum(turn.status, TURN_DIAGNOSTIC_STATUSES),
      errorPresent: turn.error !== null && turn.error !== undefined,
      errorCode: diagnosticErrorCode(turn.error),
      revision: typeof turn.revision === "number" ? turn.revision : null,
      leaseVersion: typeof turn.leaseVersion === "number" ? turn.leaseVersion : null,
      leaseOwnerPresent: turn.leaseOwnerId !== null,
    } : null,
    waitToolResult: tool ? {
      status: diagnosticEnum(tool.status, ITEM_DIAGNOSTIC_STATUSES),
      errorCodePresent: typeof tool.errorCode === "string",
      outputStatus: diagnosticEnum(tool.outputStatus, WAIT_DIAGNOSTIC_STATUSES),
      waitIdPresent: typeof tool.waitId === "string",
      matchedTaskCount: typeof record(tool.matchedTaskIds)?.count === "number" ? record(tool.matchedTaskIds)?.count : null,
      truncatedTaskResultCount: typeof record(tool.truncated)?.truncatedTaskResultCount === "number"
        ? record(tool.truncated)?.truncatedTaskResultCount
        : null,
    } : null,
    rootFailure: rootFailure ? {
      taskFound: rootFailure.taskFound === true,
      reasonPresent: rootFailure.reasonPresent === true,
      reasonCode: diagnosticErrorCode(rootFailure.reasonCode),
      reasonClass: diagnosticErrorClass(rootFailure.reasonCode),
      events: rootFailureEvents.slice(0, 8).map(event => ({
        eventType: diagnosticEnum(event.eventType, ROOT_FAILURE_EVENT_TYPES),
        status: diagnosticEnum(event.status, new Set(["completed", "failed", "interrupted"])),
        errorCode: diagnosticErrorCode(event.errorCode),
        errorClass: diagnosticErrorClass(event.errorCode),
      })),
    } : null,
    rootSteps: rootSteps.slice(0, 16).map(step => ({
      ordinal: diagnosticBoundedCount(step.ordinal),
      status: diagnosticEnum(step.status, STEP_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticErrorCode(step.errorCode),
      errorClass: diagnosticErrorClass(step.errorCode),
    })),
    rootToolItems: rootToolItems.slice(0, 12).flatMap(item => {
      const callId = diagnosticFixtureCallId(item.callId)
      if (!callId) return []
      const input = record(item.input)
      const output = record(item.output)
      const has = (key: string) => Object.prototype.hasOwnProperty.call(item, key)
      return [{
        callId,
        type: diagnosticEnum(item.type, TOOL_ITEM_TYPES),
        status: diagnosticEnum(item.status, ITEM_DIAGNOSTIC_STATUSES),
        toolName: diagnosticEnum(item.toolName, TOOL_DIAGNOSTIC_NAMES),
        toolStatus: diagnosticEnum(item.toolStatus, ITEM_DIAGNOSTIC_STATUSES),
        errorCode: diagnosticErrorCode(item.errorCode),
        errorClass: diagnosticErrorClass(item.errorCode),
        inputTaskCount: has("inputTaskCount") ? diagnosticBoundedCount(item.inputTaskCount)
          : diagnosticBoundedCount(Array.isArray(input?.taskIds) ? input.taskIds.length : null),
        inputNodeCount: has("inputNodeCount") ? diagnosticBoundedCount(item.inputNodeCount)
          : diagnosticBoundedCount(Array.isArray(input?.nodes) ? input.nodes.length : null),
        outputStatus: has("outputStatus") ? diagnosticEnum(item.outputStatus, TOOL_RESULT_DIAGNOSTIC_STATUSES)
          : diagnosticEnum(output?.status, TOOL_RESULT_DIAGNOSTIC_STATUSES),
        outputWaitIdPresent: typeof item.outputWaitIdPresent === "boolean"
          ? item.outputWaitIdPresent : typeof output?.waitId === "string",
        outputTaskCount: has("outputTaskCount") ? diagnosticBoundedCount(item.outputTaskCount)
          : diagnosticBoundedCount(Array.isArray(output?.tasks) ? output.tasks.length : null),
        outputMatchedTaskCount: has("outputMatchedTaskCount") ? diagnosticBoundedCount(item.outputMatchedTaskCount)
          : diagnosticBoundedCount(Array.isArray(output?.matchedTaskIds) ? output.matchedTaskIds.length : null),
        outputNodeCount: has("outputNodeCount") ? diagnosticBoundedCount(item.outputNodeCount)
          : diagnosticBoundedCount(Array.isArray(output?.nodes) ? output.nodes.length : null),
        outputNodeTaskIdCount: has("outputNodeTaskIdCount") ? diagnosticBoundedCount(item.outputNodeTaskIdCount)
          : diagnosticBoundedCount(Array.isArray(output?.nodes)
            ? output.nodes.filter(node => typeof record(node)?.taskId === "string").length : null),
      }]
    }),
    executionFailures: executionFailures.slice(0, 4).map(failure => ({
      eventType: diagnosticEnum(failure.eventType, new Set(["step.completed", "turn.failed"])),
      status: diagnosticEnum(failure.status, new Set(["failed", "interrupted"])),
      errorCode: diagnosticErrorCode(failure.errorCode),
    })),
    toolFailures: toolFailures.slice(0, 4).map(failure => ({
      toolName: diagnosticEnum(failure.toolName, TOOL_DIAGNOSTIC_NAMES),
      status: diagnosticEnum(failure.status, ITEM_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticErrorCode(failure.errorCode),
    })),
    waitLineage: waitLineage ? {
      available: waitLineage.available !== false,
      taskIdsMatchCurrentGraph: typeof waitLineage.taskIdsMatchCurrentGraph === "boolean"
        ? waitLineage.taskIdsMatchCurrentGraph
        : null,
      requestedTaskIdsPresentInCurrentGraph: typeof waitLineage.requestedTaskIdsPresentInCurrentGraph === "boolean"
        ? waitLineage.requestedTaskIdsPresentInCurrentGraph
        : null,
      proposalReceiptFound: waitLineage.proposalReceiptFound === true,
      ...(exactReceiptMatchExists !== null ? { exactReceiptMatchExists } : {}),
      ...(proposalReceiptCandidateCount !== null ? { proposalReceiptCandidateCount } : {}),
      ...(closestReceiptNodeCount !== null ? { closestReceiptNodeCount } : {}),
      ...(closestReceiptNodeKeys.length > 0 ? { closestReceiptNodeKeys } : {}),
      ...(typeof waitLineage.proposalReceiptHistoryMayBeTruncated === "boolean"
        ? { proposalReceiptHistoryMayBeTruncated: waitLineage.proposalReceiptHistoryMayBeTruncated }
        : {}),
      proposalNodeCount: diagnosticBoundedCount(waitLineage.proposalNodeCount),
      requestMatchesReceipt: typeof waitLineage.requestMatchesReceipt === "boolean"
        ? waitLineage.requestMatchesReceipt
        : null,
      requestMatchesCurrentGraph: typeof waitLineage.requestMatchesCurrentGraph === "boolean"
        ? waitLineage.requestMatchesCurrentGraph
        : null,
      requestedIdsOutsideReceiptCount: diagnosticBoundedCount(waitLineage.requestedIdsOutsideReceiptCount),
      requestedTaskCount: typeof waitLineage.requestedTaskCount === "number" ? waitLineage.requestedTaskCount : null,
      graphNodeCount: typeof waitLineage.graphNodeCount === "number" ? waitLineage.graphNodeCount : null,
      fixtureNodeKeysMissingRows: diagnosticEnumList(fixtureNodeKeysMissingRows, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS),
      graphNodeKeysMissingRows: diagnosticEnumList(waitLineage.graphNodeKeysMissingRows, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS),
      waitItemFound: waitLineage.waitItemFound === true,
      waitItemMatchesRoot: waitLineage.waitItemMatchesRoot === true,
      parentTaskFound: waitLineage.parentTaskFound === true,
      parentIdIsTurnRoot: waitLineage.parentIdIsTurnRoot === true,
      parentSameSession: waitLineage.parentSameSession === true,
      parentSameTurn: waitLineage.parentSameTurn === true,
      parentRootIsTurnRoot: waitLineage.parentRootIsTurnRoot === true,
      parentHasNoParent: waitLineage.parentHasNoParent === true,
      parentMismatchCounts: parentMismatchCounts ? {
        id: typeof parentMismatchCounts.id === "number" ? parentMismatchCounts.id : null,
        session: typeof parentMismatchCounts.session === "number" ? parentMismatchCounts.session : null,
        turn: typeof parentMismatchCounts.turn === "number" ? parentMismatchCounts.turn : null,
        root: typeof parentMismatchCounts.root === "number" ? parentMismatchCounts.root : null,
        parent: typeof parentMismatchCounts.parent === "number" ? parentMismatchCounts.parent : null,
        user: typeof parentMismatchCounts.user === "number" ? parentMismatchCounts.user : null,
      } : null,
      parentTaskMatchesUser: waitLineage.parentTaskMatchesUser === true,
      parentUserMismatchCount: typeof waitLineage.parentUserMismatchCount === "number" ? waitLineage.parentUserMismatchCount : null,
      targetRows: targetRows ? {
        requestedCount: typeof targetRows.requestedCount === "number" ? targetRows.requestedCount : null,
        foundCount: typeof targetRows.foundCount === "number" ? targetRows.foundCount : null,
        allInExpectedScope: targetRows.allInExpectedScope === true,
        allSameUser: targetRows.allSameUser === true,
        allSameSession: targetRows.allSameSession === true,
        allSameTurn: targetRows.allSameTurn === true,
        allSameRoot: targetRows.allSameRoot === true,
        allSameParent: targetRows.allSameParent === true,
        mismatchCounts: targetMismatchCounts ? {
          missing: typeof targetMismatchCounts.missing === "number" ? targetMismatchCounts.missing : null,
          user: typeof targetMismatchCounts.user === "number" ? targetMismatchCounts.user : null,
          session: typeof targetMismatchCounts.session === "number" ? targetMismatchCounts.session : null,
          turn: typeof targetMismatchCounts.turn === "number" ? targetMismatchCounts.turn : null,
          root: typeof targetMismatchCounts.root === "number" ? targetMismatchCounts.root : null,
          parent: typeof targetMismatchCounts.parent === "number" ? targetMismatchCounts.parent : null,
        } : null,
      } : null,
    } : null,
    toolFailure: toolFailure ? {
      toolNameIsAgentWait: toolFailure.toolName === "agent.wait",
      status: diagnosticEnum(toolFailure.status, ITEM_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticErrorCode(toolFailure.errorCode),
      errorCodePresent: typeof toolFailure.errorCode === "string",
      failureDetailPresent: typeof toolFailure.failureDetail === "string",
    } : null,
    tasks: tasks.slice(0, 6).map(task => ({
      goalPresent: typeof task.goal === "string",
      status: diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES),
      attempts: typeof task.attemptCount === "number" ? task.attemptCount : null,
      failureReasonPresent: typeof task.failureReason === "string",
      failureReasonCode: diagnosticErrorCode(task.failureReason),
    })),
    waits: waits.slice(0, 6).map(wait => ({
      keyPresent: typeof wait.idempotencyKey === "string",
      status: diagnosticEnum(wait.status, WAIT_DIAGNOSTIC_STATUSES),
      targetCount: diagnosticCount(wait.targetTaskIds),
      matchedCount: diagnosticCount(wait.matchedTaskIds),
      suspended: wait.suspendedAt !== null,
      resolved: wait.resolvedAt !== null,
      consumed: wait.consumedAt !== null,
    })),
  }
  return boundedDiagnostic(JSON.stringify(snapshot), maxCharacters)
}

function combineFailureDiagnostics(fields: readonly FailureDiagnosticField[], progress: string, firstWaitPlanGraph?: string | null): string {
  const direct = boundedDiagnostic(fields.map(({ label, value, safeValue }) =>
    `${label}=${safeValue ?? (value.length > 0 && value !== "<not captured>" && value !== "<none>")}`).join("; "), 2_700)
  const planGraphLabel = firstWaitPlanGraph ? "; firstWaitPlanGraph=" : ""
  const planGraph = firstWaitPlanGraph ? boundedDiagnostic(firstWaitPlanGraph, 1_200) : ""
  const snapshotLabel = "; turnTaskWaitSnapshot="
  const snapshotBudget = Math.max(0, Math.min(1_050, 3_900 - direct.length - planGraphLabel.length - planGraph.length - snapshotLabel.length - 64))
  const snapshot = compactTurnProgressDiagnostics(progress, snapshotBudget)
  return boundedDiagnostic(`${direct}${planGraphLabel}${planGraph}${snapshotLabel}${snapshot}`, 3_900)
}

function waitTurnFailureSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const progressMarker = message.indexOf("; progress=")
  return boundedDiagnostic(progressMarker >= 0 ? message.slice(0, progressMarker) : message, 320)
}

function boundedErrorDetails(error: unknown): RecordValue {
  const fields = record(error)
  const errorName = error instanceof Error ? error.name : fields?.name
  const errorMessage = error instanceof Error
    ? error.message
    : typeof fields?.message === "string" ? fields.message : String(error)
  const errorCode = fields?.code
  return {
    name: boundedDiagnostic(typeof errorName === "string" ? errorName : "UnknownError", 120),
    code: typeof errorCode === "string" || typeof errorCode === "number"
      ? boundedDiagnostic(String(errorCode), 160)
      : null,
    message: boundedDiagnostic(errorMessage, 500),
  }
}

async function waitHandoffTurnState(pool: Pool, userId: string, turnId: string, waitId: string): Promise<RecordValue> {
  let client: PoolClient | undefined
  let transactionStarted = false
  try {
    client = await pool.connect()
    await client.query("BEGIN")
    transactionStarted = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId])
    const result = await client.query<{
      turnStatus: string
      leaseOwnerId: string | null
      leaseVersion: number
      waitId: string | null
      waitStatus: string | null
      suspendedAt: Date | null
      resolvedAt: Date | null
      consumedAt: Date | null
    }>(`SELECT turn."status" AS "turnStatus", turn."leaseOwnerId", turn."leaseVersion",
         wait."id" AS "waitId", wait."status" AS "waitStatus", wait."suspendedAt", wait."resolvedAt", wait."consumedAt"
       FROM "agent_turns" AS turn LEFT JOIN "agent_wait_conditions" AS wait
         ON wait."turnId" = turn."id" AND wait."id" = $2
       WHERE turn."id" = $1 AND turn."userId" = $3`, [turnId, waitId, userId])
    await client.query("COMMIT")
    transactionStarted = false
    const row = result.rows[0]
    return {
      snapshotReadSucceeded: true,
      turnFound: row !== undefined,
      waitFound: row?.waitId !== null && row?.waitId !== undefined,
      turn: row ? {
        status: row.turnStatus,
        leaseOwnerPresent: row.leaseOwnerId !== null,
        leaseVersion: row.leaseVersion,
      } : null,
      wait: row?.waitId ? {
        status: row.waitStatus,
        hasSuspendedAt: row.suspendedAt !== null,
        hasResolvedAt: row.resolvedAt !== null,
        hasConsumedAt: row.consumedAt !== null,
      } : null,
    }
  } catch (error: unknown) {
    if (client && transactionStarted) await client.query("ROLLBACK").catch(() => undefined)
    return { snapshotReadSucceeded: false, turnFound: false, waitFound: false, diagnosticError: boundedErrorDetails(error) }
  } finally {
    client?.release()
  }
}

function withWaitHandoffDiagnostics(
  pool: Pool,
  createQueue: TurnQueueFactory,
  onFailure: (diagnostic: string) => void,
): TurnQueueFactory {
  return options => createQueue({
    ...options,
    waitHandoff: async input => {
      if (!options.waitHandoff) {
        const before = await waitHandoffTurnState(pool, input.lease.userId, input.lease.turnId, input.waitId)
        const unavailable = new Error("Production waitHandoff callback was not provided.")
        unavailable.name = "WaitHandoffUnavailable"
        const unavailableWithCode = Object.assign(unavailable, { code: "wait_handoff_unavailable" })
        onFailure(boundedDiagnostic(JSON.stringify({
          waitId: input.waitId,
          error: boundedErrorDetails(unavailableWithCode),
          before,
          after: before,
        }), 1_800))
        throw unavailableWithCode
      }
      const before = await waitHandoffTurnState(pool, input.lease.userId, input.lease.turnId, input.waitId)
      try {
        await options.waitHandoff(input)
      } catch (error: unknown) {
        const after = await waitHandoffTurnState(pool, input.lease.userId, input.lease.turnId, input.waitId)
        onFailure(boundedDiagnostic(JSON.stringify({
          waitId: input.waitId,
          error: boundedErrorDetails(error),
          before,
          after,
        }), 1_800))
        throw error
      }
    },
  })
}

function waitHandoffFailureProjection(diagnostic: string | null): RecordValue {
  if (!diagnostic) return { captured: false }
  try {
    const value = record(JSON.parse(diagnostic))
    const error = record(value?.error)
    const state = (candidate: unknown): RecordValue | null => {
      const current = record(candidate)
      if (!current) return null
      const turn = record(current.turn)
      const wait = record(current.wait)
      return {
        snapshotReadSucceeded: current.snapshotReadSucceeded === true,
        turnFound: current.turnFound === true,
        waitFound: current.waitFound === true,
        turnStatus: diagnosticEnum(turn?.status, TURN_DIAGNOSTIC_STATUSES),
        turnLeaseOwnerPresent: turn?.leaseOwnerPresent === true,
        turnLeaseVersion: typeof turn?.leaseVersion === "number" && Number.isSafeInteger(turn.leaseVersion)
          ? turn.leaseVersion
          : null,
        waitStatus: diagnosticEnum(wait?.status, WAIT_DIAGNOSTIC_STATUSES),
        hasSuspendedAt: wait?.hasSuspendedAt === true,
        hasResolvedAt: wait?.hasResolvedAt === true,
        hasConsumedAt: wait?.hasConsumedAt === true,
      }
    }
    return {
      captured: true,
      errorName: diagnosticEnum(error?.name, WAIT_HANDOFF_ERROR_NAMES) ?? "other",
      errorCode: diagnosticEnum(error?.code, WAIT_HANDOFF_ERROR_CODES) ?? "other",
      handoffGate: typeof error?.name === "string" && WAIT_HANDOFF_GATE_ERROR_NAMES.has(error.name)
        && typeof error.message === "string"
        ? WAIT_HANDOFF_GATE_LABELS.get(error.message) ?? "other"
        : "other",
      before: state(value?.before),
      after: state(value?.after),
    }
  } catch {
    return { captured: true, available: false }
  }
}

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    suffix,
    userId: `p3-task-graph-resume-user-${suffix}`,
    sessionId: `p3-task-graph-resume-session-${suffix}`,
    turnId: `p3-task-graph-resume-turn-${suffix}`,
    ownerId: `p3-task-graph-resume-owner-${suffix}`,
  }
}

function fixtureJobId(suffix: string, slot = 0): string {
  const randomHexTail = suffix.replaceAll("-", "").slice(-12)
  if (!/^[a-f0-9]{12}$/i.test(randomHexTail)) throw new Error("TaskGraph fixture UUID suffix is invalid")
  const decimalTail = ((BigInt(`0x${randomHexTail}`) + BigInt(slot)) % 1_000_000_000_000n)
    .toString()
    .padStart(12, "0")
  // Keep the fixed numeric prefix phone-like for generic redaction while the
  // fixture UUID tail makes the Job primary key unique across test runs.
  return `48273164-2059-4873-8942-${decimalTail}`
}

type FixtureTurnLimits = { readonly maxSteps: number; readonly maxToolCalls: number }

const DEFAULT_FIXTURE_TURN_LIMITS: FixtureTurnLimits = { maxSteps: 8, maxToolCalls: 8 }
// The discovery fixtures execute root planning/replanning and child turns under the same root-scoped ceiling.
const DISCOVERY_FIXTURE_TURN_LIMITS: FixtureTurnLimits = { maxSteps: 16, maxToolCalls: 8 }
const VERIFICATION_REPAIR_MAX_WAIT_POLLS = TASK_GRAPH_LIMITS.maxNodes
const VERIFICATION_REPAIR_MAX_REFERENCE_READS = 8
const VERIFICATION_REPAIR_BASELINE_STEPS = 22
const VERIFICATION_REPAIR_BASELINE_TOOL_CALLS = 19
const VERIFICATION_REPAIR_WAIT_OUTPUT_BYTE_LIMIT = 18_432
// Eight bounded 4 KiB-envelope reads cover the capped seven-target output; each adds one finite model step and tool call.
const VERIFICATION_REPAIR_STEP_BUDGET = VERIFICATION_REPAIR_BASELINE_STEPS + VERIFICATION_REPAIR_MAX_WAIT_POLLS - 1 + VERIFICATION_REPAIR_MAX_REFERENCE_READS
const VERIFICATION_REPAIR_TOOL_BUDGET = VERIFICATION_REPAIR_BASELINE_TOOL_CALLS + VERIFICATION_REPAIR_MAX_WAIT_POLLS - 1 + VERIFICATION_REPAIR_MAX_REFERENCE_READS
// TaskGraph multi-round fixtures need 10-11 root and child model steps; retain bounded headroom.
const TASK_GRAPH_FIXTURE_TURN_LIMITS: FixtureTurnLimits = { maxSteps: 12, maxToolCalls: 12 }

async function seed(
  pool: Pool,
  value: Fixture,
  turnStatus: "queued" | "waiting_for_user" = "queued",
  limits: FixtureTurnLimits = DEFAULT_FIXTURE_TURN_LIMITS,
): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Resume after a TaskGraph dependency completes', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "updatedAt")
    VALUES ($1, $2, $3, $4, 'user', $5::jsonb, $6::jsonb, '{}'::jsonb, $7::jsonb, CURRENT_TIMESTAMP)`, [
    value.turnId,
    value.sessionId,
    value.userId,
    turnStatus,
    JSON.stringify({ goal: "Research and summarize the fixture source" }),
    JSON.stringify({ provider: "fixture", model: "fixture-model" }),
    JSON.stringify({ limits }),
  ])
}

async function activateFixtureTurn(pool: Pool, value: Fixture): Promise<void> {
  const activated = await pool.query(`UPDATE "agent_turns" SET "status" = 'queued', "completedAt" = NULL,
      "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'waiting_for_user'`, [
    value.turnId, value.sessionId, value.userId,
  ])
  if (activated.rowCount !== 1) throw new Error("TaskGraph fixture turn was not parked before activation")
}

async function seedRootFollowup(pool: Pick<Pool, "connect">, value: Fixture, lease: TurnLease): Promise<{ id: string; sequence: string }> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [value.userId])
    const session = await client.query(`SELECT session."id" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND session."userId" = $2 AND session."status" = 'running' FOR UPDATE`, [value.sessionId, value.userId])
    const turn = await client.query(`SELECT turn."id" FROM "agent_turns" AS turn
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."status" = 'in_progress'
        AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5 AND turn."leaseExpiresAt" > CURRENT_TIMESTAMP FOR UPDATE`,
    [value.turnId, value.sessionId, value.userId, lease.ownerId, lease.leaseVersion])
    if (!session.rows[0] || !turn.rows[0]) throw new Error("Original root input fixture lost its live Turn owner")
    const next = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [value.sessionId, value.userId])
    const sequence = next.rows[0]?.eventSequence
    if (sequence === undefined) throw new Error("Original root input fixture could not allocate an accepted sequence")
    const id = "p3-steer-wait-root-input-" + value.suffix
    await client.query(`INSERT INTO "agent_inputs"
      ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
      VALUES ($1, $2, $3, $4, $5, 'follow_up', 'accepted', $6::jsonb, $7::bigint)`,
    [id, value.sessionId, value.turnId, value.userId, "p3-steer-wait-root:" + value.suffix,
      JSON.stringify([{ type: "text", text: "Research and summarize the fixture source" }]), String(sequence)])
    await client.query("COMMIT")
    return { id, sequence: String(sequence) }
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}
async function prepareSuspendedSteerWait(pool: Pool, value: Fixture) {
  await seed(pool, value, "waiting_for_user")
  const tasks = new PgSubagentTaskStore(pool, 300_000)
  const root = await tasks.create({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    role: "supervisor", taskType: "task_graph", goal: "Research and summarize the fixture source",
    allowedActions: [], expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, policy: defaultSubagentPolicy() })
  const linked = await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2
    WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`,
  [value.turnId, root.id, value.sessionId, value.userId])
  if (linked.rowCount !== 1) throw new Error("Steer-wait fixture root could not be linked")
  await activateFixtureTurn(pool, value)
  const lease = await claimTurnLease(pool, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
  const rootLease = await tasks.claim({ taskId: root.id, sessionId: value.sessionId, ownerId: value.ownerId,
    policy: defaultSubagentPolicy(), now: new Date() })
  if (!rootLease?.leaseOwner) throw new Error("Steer-wait fixture root did not acquire a live lease")
  const child = await tasks.create({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    parentTaskId: root.id, role: "scout", taskType: "research", goal: "Remain live while the root is steered",
    allowedActions: [], expectedOutputSchema: {}, policy: defaultSubagentPolicy() })
  const stepId = `p3-steer-wait-step-${value.suffix}`
  const engine = createPgTurnEngineStore(pool), owner = executionOwnerFence({ kind: "turn", taskId: root.id, lease })
  await engine.startStep({ owner, stepId, ordinal: 0, attempt: 1, inputThroughSequence: 0n,
    consumedInputIds: [], modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, now: new Date() })
  const rootInput = await seedRootFollowup(pool, value, lease)
  const contextNow = new Date()
  const originalContext = await new StepContextBuilder(createPgInputClaimStore(pool, { userId: value.userId }), createPgContextOwnerFence(pool)).build({
    scope: { userId: value.userId }, sessionId: value.sessionId, turnId: value.turnId, stepId,
    snapshot: { system: [], profile: [], goal: { id: "turn-goal:" + value.turnId, content: "Research and summarize the fixture source" }, steerHistory: [], businessRefs: [], toolObservations: [] },
    rootInputId: rootInput.id, taskId: root.id,
    lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now: contextNow }, now: contextNow,
  })
  if (originalContext.inputThroughSequence !== BigInt(rootInput.sequence) || !originalContext.consumedInputIds.includes(rootInput.id)) {
    throw new Error("Steer-wait fixture did not durably checkpoint its original root input")
  }
  await engine.updateStep({ owner, stepId, status: "waiting_for_tool", finishReason: "tool_calls", errorCode: null,
    inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.01, now: new Date() })
  const waitStore = createPgDurableWaitPort(pool)
  const wait = await waitStore.wait({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    stepId, taskId: root.id, rootTaskId: root.id, targetTaskIds: [child.id], mode: "all", timeoutMs: 60_000,
    idempotencyKey: `p3-steer-wait:${value.suffix}` })
  await waitStore.suspendAndRelease({ lease, waitId: wait.waitId, now: new Date() })
  return { root, child, lease, rootInput, stepId, wait }
}

async function seedAcceptedSteer(pool: Pick<Pool, "connect">, value: Fixture, text: string): Promise<{ id: string; sequence: string }> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [value.userId])
    const session = await client.query(`SELECT session."id" FROM "agent_sessions" AS session
      WHERE session."id" = $1 AND session."userId" = $2 AND session."status" = 'running' FOR UPDATE`, [value.sessionId, value.userId])
    const turn = await client.query(`SELECT turn."id" FROM "agent_turns" AS turn
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
        AND turn."rootTaskId" IS NOT NULL AND turn."status" = 'waiting_for_dependency' AND turn."leaseOwnerId" IS NULL FOR UPDATE`,
    [value.turnId, value.sessionId, value.userId])
    if (!session.rows[0] || !turn.rows[0]) throw new Error("Steer input fixture no longer owns a suspended root Turn")
    // Seed only the canonical accepted AgentInput row here; this is not a Web-route integration test.
    const next = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
      WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [value.sessionId, value.userId])
    const sequence = next.rows[0]?.eventSequence
    if (sequence === undefined) throw new Error("Steer input fixture could not allocate an accepted sequence")
    const id = `p3-steer-wait-input-${value.suffix}`
    await client.query(`INSERT INTO "agent_inputs"
      ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
      VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', $6::jsonb, $7::bigint)`,
    [id, value.sessionId, value.turnId, value.userId, `p3-steer-wait:${value.suffix}`,
      JSON.stringify([{ type: "text", text }]), String(sequence)])
    await client.query("COMMIT")
    return { id, sequence: String(sequence) }
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

type SelectedJobFixtureSources = { readonly jobId: string; readonly otherJobId: string; readonly resumeId: string }

function selectedJobSourceCanaries(jobId: string, worker: 1 | 2): readonly string[] {
  const prefix = "p3-selected-job-"
  if (!jobId.startsWith(prefix) || jobId.length <= prefix.length) throw new Error("Selected-job source canaries are unavailable")
  const suffix = jobId.slice(prefix.length)
  return [
    `AC6_TRANSIENT_JOB_SOURCE_W${worker}_${suffix}`,
    `AC6_TRANSIENT_RESUME_SOURCE_W${worker}_${suffix}`,
    `AC6_TRANSIENT_PERSONA_SOURCE_W${worker}_${suffix}`,
  ]
}

function selectedJobFixtureSources(value: Fixture): SelectedJobFixtureSources {
  return {
    jobId: `p3-selected-job-${value.suffix}`,
    otherJobId: `p3-other-job-${value.suffix}`,
    resumeId: `p3-selected-job-resume-${value.suffix}`,
  }
}

async function seedSelectedJobSources(pool: Pool, value: Fixture): Promise<SelectedJobFixtureSources> {
  const ids = selectedJobFixtureSources(value)
  await pool.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
    VALUES ($1, $2, 'Fixture GmbH', 'Software Engineer', 'Berlin', 'saved', 'https://jobs.example.invalid/selected', $3, 'test', CURRENT_TIMESTAMP),
      ($4, $2, 'Other Fixture GmbH', 'Designer', 'Dublin', 'saved', 'https://jobs.example.invalid/other', 'Design clear products', 'test', CURRENT_TIMESTAMP)`, [
    ids.jobId, value.userId, `AC6_TRANSIENT_JOB_SOURCE_W1_${value.suffix}`, ids.otherJobId,
  ])
  await pool.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "updatedAt")
    VALUES ($1, $2, 'Selected-job integration base', $3::jsonb, 'base', 'manual', TRUE, CURRENT_TIMESTAMP)`, [
    ids.resumeId, value.userId, JSON.stringify({ text: `AC6_TRANSIENT_RESUME_SOURCE_W1_${value.suffix}` }),
  ])
  await pool.query(`INSERT INTO persona_facts
    ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
    VALUES ($1, $2, 'language', 'language', $3, 'english-c1', 'resume', $4, 0.98, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`, [
    `p3-selected-job-fact-${value.suffix}`, value.userId, `AC6_TRANSIENT_PERSONA_SOURCE_W1_${value.suffix}`, `resume:${ids.resumeId}:language`,
  ])
  return ids
}

type SelectedJobArtifactReference = {
  readonly artifactId: string
  readonly version: number
  readonly contentHash: string
  readonly sourceDigest: string
}

type SelectedJobArtifactRestartPlan = {
  readonly store: PgSubagentTaskStore
  readonly rootTaskId: string
  readonly writerTask: SubagentTaskRecord
  readonly queueName: string
  readonly jobId: string
  readonly otherJobId: string
  readonly body: string
  readonly originalPreparation: Awaited<ReturnType<typeof loadSelectedJobArtifactContext>>
}

type SelectedJobArtifactRestartTrace = SelectedJobArtifactRestartPlan & {
  readonly writerOwnerId: string
  readonly writerAttemptCount: number
  readonly writerDraftCallId: string
  readonly writerRequestHash: string
  readonly writerFence: AgentArtifactTaskFence
  readonly artifactRef: SelectedJobArtifactReference
}

type SelectedJobArtifactReviewTrace = SelectedJobArtifactRestartTrace & {
  readonly currentPreparation: Awaited<ReturnType<typeof loadSelectedJobArtifactContext>>
  readonly reviewerTask: SubagentTaskRecord
  readonly stopReviewerTask: SubagentTaskRecord
}

function selectedJobArtifactReference(value: unknown): SelectedJobArtifactReference {
  const row = record(value)
  const ref = record(row?.artifactRef) ?? record(record(row?.structuredResult)?.artifactRef) ?? row
  if (!ref || typeof ref.artifactId !== "string" || !Number.isSafeInteger(ref.version)
    || typeof ref.contentHash !== "string" || typeof ref.sourceDigest !== "string") {
    throw new Error("Selected-job Worker did not return a valid artifact reference")
  }
  return { artifactId: ref.artifactId, version: Number(ref.version), contentHash: ref.contentHash, sourceDigest: ref.sourceDigest }
}

function selectedJobTaskFence(task: SubagentTaskRecord, leaseOwner: string, attemptCount: number): AgentArtifactTaskFence {
  if (!task.turnId || !task.parentTaskId || !leaseOwner || !Number.isSafeInteger(attemptCount)) {
    throw new Error("Selected-job task is missing its durable lease fence identity")
  }
  return {
    taskId: task.id, userId: task.userId, sessionId: task.sessionId, turnId: task.turnId,
    rootTaskId: task.rootTaskId, parentTaskId: task.parentTaskId, leaseOwner, attemptCount,
  }
}

function selectedJobTaskReceiptRequestHash(
  op: string,
  scope: {
    readonly taskFence: AgentArtifactTaskFence
    readonly [key: string]: unknown
  },
  input: unknown,
): string {
  const { taskFence, ...stableScope } = scope
  return hashArtifactContent({
    op, ...stableScope,
    turnId: taskFence.turnId, rootTaskId: taskFence.rootTaskId, parentTaskId: taskFence.parentTaskId, input,
  })
}

function selectedJobDraftRequestHash(
  scope: { readonly taskFence: AgentArtifactTaskFence; readonly [key: string]: unknown },
  input: unknown,
): string {
  return selectedJobTaskReceiptRequestHash("cover_letter.draft", scope, input)
}

async function createSelectedJobTaskGraph(
  pool: Pool,
  value: Fixture,
  sources: SelectedJobFixtureSources,
  queueName: string,
): Promise<SelectedJobArtifactRestartPlan> {
  const store = new PgSubagentTaskStore(pool, 300_000)
  const root = await store.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    role: "supervisor", taskType: "task_graph", goal: "Coordinate a selected-job artifact fixture",
    allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"],
    expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 32, maxToolCalls: 16 } },
    policy: defaultSubagentPolicy(),
  })
  const linkedTurn = await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`, [
    value.turnId, root.id, value.sessionId, value.userId,
  ])
  if (linkedTurn.rowCount !== 1) throw new Error("Selected-job fixture turn was not available for its root task")
  const writerTask = await store.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: root.id,
    role: "writer", taskType: "cover_letter_draft", goal: "Draft a cover letter for the selected job",
    successCriteria: ["Persist one selected-job artifact version"],
    allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft"],
    context: { selectedJobPreparation: { jobId: sources.jobId } },
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" },
    toolPolicySnapshot: {}, policy: defaultSubagentPolicy(),
  })
  return {
    store, rootTaskId: root.id, writerTask, queueName,
    jobId: sources.jobId, otherJobId: sources.otherJobId,
    body: `AC6_PRIVATE_COVER_LETTER_${value.suffix}`,
    originalPreparation: await loadSelectedJobArtifactContext(pool, value.userId, sources.jobId),
  }
}

async function prepareSelectedJobTerminalCase(pool: Pool, value: Fixture) {
  await seed(pool, value, "waiting_for_user")
  const sources = await seedSelectedJobSources(pool, value)
  const preparation = await loadSelectedJobArtifactContext(pool, value.userId, sources.jobId)
  const tasks = new PgSubagentTaskStore(pool, 300_000)
  const root = await tasks.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, role: "orchestrator", taskType: "root",
    goal: "Complete the selected-job draft review before finalizing",
    allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"],
    expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 16, maxToolCalls: 16 } }, policy: defaultSubagentPolicy(),
  })
  const linked = await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $2, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`, [
    value.turnId, root.id, value.sessionId, value.userId,
  ])
  if (linked.rowCount !== 1) throw new Error("Finalization fixture root could not be linked")
  await activateFixtureTurn(pool, value)
  const lease = await claimTurnLease(pool, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
  const rootLease = await tasks.claim({ taskId: root.id, sessionId: value.sessionId, ownerId: value.ownerId, policy: defaultSubagentPolicy(), now: new Date() })
  if (!rootLease?.leaseOwner) throw new Error("Finalization fixture root did not acquire a live lease")
  const stepId = `p3-finalization-step-${value.suffix}`
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 0, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, value.sessionId, value.turnId, root.id])
  const commandPort = createPgTaskGraphCommandPort(pool)
  const graphScope = {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, rootTaskId: root.id, parentTaskId: root.id, stepId,
    turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion, parentLeaseOwner: value.ownerId, parentAttemptCount: rootLease.attemptCount,
  }
  const plan = await commandPort.appendAndSchedule({
    scope: graphScope,
    proposal: { expectedRevision: 0, nodes: [
      { key: "writer", templateId: "cover_letter_writer", goal: "Persist one selected-job draft", successCriteria: ["Save the draft"], dependsOn: [] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist a passed review"], dependsOn: ["writer"] },
    ] },
    templates: taskGraphTemplatesForSelectedJob(preparation.preparation),
  })
  const taskId = (key: string) => {
    const found = plan.nodes.find(node => node.key === key)?.taskId
    if (!found) throw new Error(`Finalization fixture graph is missing ${key}`)
    return found
  }
  const writerOwner = `p3-finalization-writer-${value.suffix}`
  const writer = await tasks.claim({ taskId: taskId("writer"), sessionId: value.sessionId, ownerId: writerOwner, policy: defaultSubagentPolicy(), now: new Date() })
  if (!writer?.leaseOwner) throw new Error("Finalization fixture Writer did not acquire a live lease")
  const artifacts = createArtifactToolStore(pool)
  const base = await resolveCoverLetterBase(artifacts, value.userId, sources.jobId)
  const draftInput = { baseArtifactId: base.artifactId, baseHash: base.baseHash, content: `AC6_PRIVATE_FINALIZATION_DRAFT_${value.suffix}`, constraints: { maxWords: 160 } }
  const writerScope = {
    ...preparation.preparation, userId: value.userId, sessionId: value.sessionId, taskId: writer.id,
    toolCallId: `p3-finalization-writer:${writer.attemptCount}`, taskFence: selectedJobTaskFence(writer, writerOwner, writer.attemptCount),
  }
  const draft = await artifacts.writeDraft(writerScope, { ...draftInput, requestHash: selectedJobDraftRequestHash(writerScope, draftInput) })
  const artifactRef = { artifactId: draft.artifactId, version: draft.version, contentHash: draft.contentHash, sourceDigest: draft.sourceDigest }
  await tasks.finish({ taskId: writer.id, sessionId: value.sessionId, ownerId: writerOwner, attemptCount: writer.attemptCount, status: "completed",
    result: { status: "completed", finalText: "Draft saved", finalItemId: null, stepCount: 1, toolCallCount: 1,
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef } }, now: new Date() })
  const reviewerOwner = `p3-finalization-reviewer-${value.suffix}`
  const reviewer = await tasks.claim({ taskId: taskId("reviewer"), sessionId: value.sessionId, ownerId: reviewerOwner, policy: defaultSubagentPolicy(), now: new Date() })
  if (!reviewer?.leaseOwner) throw new Error("Finalization fixture Reviewer did not acquire a live lease")
  const reviewInput = { artifactRef, decision: "passed", findings: [] }
  const reviewerScope = {
    ...preparation.preparation, userId: value.userId, sessionId: value.sessionId, taskId: reviewer.id,
    toolCallId: `p3-finalization-reviewer:${reviewer.attemptCount}`, taskFence: selectedJobTaskFence(reviewer, reviewerOwner, reviewer.attemptCount),
  }
  const reviewHash = hashArtifactContent({ artifactRef, currentSourceDigest: preparation.preparation.sourceDigest, status: "passed", findings: [], evidenceRefs: preparation.preparation.evidenceRefs })
  await artifacts.saveReview({
    userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId, artifactId: artifactRef.artifactId, version: artifactRef.version,
    contentHash: artifactRef.contentHash, sourceDigest: artifactRef.sourceDigest, currentSourceDigest: preparation.preparation.sourceDigest,
    status: "passed", findings: [], evidenceRefs: [...preparation.preparation.evidenceRefs], taskId: reviewer.id, toolCallId: reviewerScope.toolCallId,
    requestHash: selectedJobTaskReceiptRequestHash("artifact.review", reviewerScope, reviewInput), reviewHash, taskFence: reviewerScope.taskFence,
  })
  await tasks.finish({ taskId: reviewer.id, sessionId: value.sessionId, ownerId: reviewerOwner, attemptCount: reviewer.attemptCount, status: "completed",
    result: { status: "completed", finalText: "Review passed", finalItemId: null, stepCount: 1, toolCallCount: 1,
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash } }, now: new Date() })
  const artifactRepository = createAgentArtifactRepository(pool)
  const gate = await selectedJobArtifactCompletionGateWithWitness({
    commandPort, lease, root: { id: root.id, attemptCount: rootLease.attemptCount }, selectedJobId: sources.jobId,
    readCurrentDraftHead: scope => artifactRepository.findCurrentDraftHead(scope),
    readCurrentSourceDigest: async () => (await loadSelectedJobArtifactContext(pool, value.userId, sources.jobId)).preparation.sourceDigest,
    readCurrentReviewReceipt: scope => artifactRepository.findReviewReceipt(scope),
  })
  if (!gate.ok) throw new Error("Finalization fixture did not produce a successful selected-job gate")
  const ownerFence = executionOwnerFence({ kind: "turn", taskId: root.id, lease })
  if (ownerFence.kind !== "turn") throw new Error("Finalization fixture owner is not a Turn lease")
  const owner = ownerFence
  const engineStore = createPgTurnEngineStore(pool)
  await engineStore.appendEvent({
    owner, id: `p3-finalization-turn-started-event-${value.suffix}`, itemId: null, type: "turn.started",
    correlationId: value.turnId, causationId: null, idempotencyKey: `turn:${value.turnId}:event:turn-started`,
    payload: { taskId: owner.taskId, rootTaskId: owner.taskId },
  })
  await engineStore.updateStep({ owner, stepId, status: "completed", finishReason: "stop", errorCode: null, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now: new Date() })
  await engineStore.appendEvent({
    owner, id: `p3-finalization-step-event-${value.suffix}`, itemId: null, type: "step.completed", correlationId: stepId, causationId: null,
    idempotencyKey: `turn:${value.turnId}:event:step-completed:${stepId}`, payload: { taskId: owner.taskId, stepId, status: "completed" },
  })
  return {
    value, sources, preparation, tasks, root, rootLease, lease, commandPort, artifacts, artifactRef, graphScope,
    acceptedGraphWitness: gate.witness, stepId,
    terminalInput: {
      owner, response: "Selected-job draft review complete", now: new Date(), stepId,
      finalItemId: `p3-finalization-item-${value.suffix}`, finalContent: { parts: [{ type: "text", text: "Selected-job draft review complete" }] },
      stepCount: 1, toolCallCount: 0, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
    },
  }
}

function selectedJobFinalizationGuardForCase(prepared: Awaited<ReturnType<typeof prepareSelectedJobTerminalCase>>) {
  return (client: PoolClient) => selectedJobArtifactFinalizationGuard({
    client, commandPort: prepared.commandPort, lease: prepared.lease,
    root: { id: prepared.root.id, attemptCount: prepared.rootLease.attemptCount }, selectedJobId: prepared.sources.jobId,
    acceptedGraphWitness: prepared.acceptedGraphWitness,
    readCurrentDraftHead: findCurrentDraftHeadWithClient,
    readCurrentSourceDigest: (current, scope) => readSelectedJobSourceDigestWithClient(current, scope.userId, scope.jobId),
    readCurrentReviewReceipt: findReviewReceiptWithClient,
  })
}

async function expectNoTerminalRecords(pool: Pool, prepared: Awaited<ReturnType<typeof prepareSelectedJobTerminalCase>>): Promise<void> {
  const [turn, root, item, events, outboxes] = await Promise.all([
    pool.query<{ status: string; finalResponse: string | null }>(`SELECT "status", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [prepared.value.turnId]),
    pool.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [prepared.root.id]),
    pool.query(`SELECT "id" FROM "agent_items" WHERE "id" = $1`, [prepared.terminalInput.finalItemId]),
    pool.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3`, [prepared.value.sessionId, prepared.value.turnId, prepared.terminalInput.finalItemId]),
    pool.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "payload"->>'itemId' = $2`, [prepared.value.sessionId, prepared.terminalInput.finalItemId]),
  ])
  expect(turn.rows[0]).toEqual({ status: "in_progress", finalResponse: null })
  expect(root.rows[0]?.status).toBe("running")
  expect(item.rows).toHaveLength(0)
  expect(events.rows).toHaveLength(0)
  expect(outboxes.rows).toHaveLength(0)
}

function selectedJobSettlement(line: string, taskId: string): RecordValue {
  const prefix = `P3_SELECTED_JOB_CHILD_SETTLED ${taskId} `
  if (!line.startsWith(prefix)) throw new Error("Selected-job Worker settlement marker did not match its task")
  const value = record(JSON.parse(line.slice(prefix.length)) as unknown)
  if (!value) throw new Error("Selected-job Worker settlement marker was not an object")
  return value
}

async function traceSelectedJobWriterFromWorker(
  plan: SelectedJobArtifactRestartPlan,
  line: string,
): Promise<SelectedJobArtifactRestartTrace> {
  const settlement = selectedJobSettlement(line, plan.writerTask.id)
  expect(settlement).toMatchObject({
    role: "writer", taskId: plan.writerTask.id, managerStatus: "completed", childStatus: "completed",
    observations: { sourceCanariesReloaded: { job: true, resume: true, persona: true } },
  })
  if (typeof settlement.ownerId !== "string" || !Number.isSafeInteger(settlement.attemptCount)) {
    throw new Error("Selected-job Worker did not report a valid lease identity")
  }
  const writerAttemptCount = Number(settlement.attemptCount)
  const writerDraftCallId = selectedJobDraftCallId(writerAttemptCount)
  const draftInput = {
    baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: plan.writerTask.userId, jobId: plan.jobId }).slice(7)}`,
    baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: plan.jobId }),
    content: plan.body,
    constraints: { maxWords: 160 },
  }
  const writerFence = selectedJobTaskFence(plan.writerTask, settlement.ownerId, writerAttemptCount)
  const writerScope = {
    ...plan.originalPreparation.preparation,
    userId: plan.writerTask.userId,
    sessionId: plan.writerTask.sessionId,
    taskId: plan.writerTask.id,
    toolCallId: writerDraftCallId,
    taskFence: writerFence,
  }
  const writerRequestHash = selectedJobDraftRequestHash(writerScope, draftInput)
  const artifactRef = selectedJobArtifactReference(settlement.artifactRef)
  expect(artifactRef.version).toBe(1)
  expect(artifactRef.sourceDigest).toBe(plan.originalPreparation.preparation.sourceDigest)
  const version = await plan.store.get(plan.writerTask.id, plan.writerTask.sessionId)
  expect(version).toMatchObject({ status: "completed", role: "writer", attemptCount: writerAttemptCount })
  return {
    ...plan, writerOwnerId: settlement.ownerId, writerAttemptCount, writerDraftCallId,
    writerRequestHash, writerFence, artifactRef,
  }
}

async function enqueueSelectedJobTask(
  queueName: string,
  connection: Redis,
  task: SubagentTaskRecord,
  ownerId: string,
): Promise<void> {
  const { enqueueSubagentTask } = await import("../../queue/subagent-queue.js")
  const queue = new Queue(queueName, { connection, skipVersionCheck: true })
  try {
    await enqueueSubagentTask(queue, { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId }, 1)
  } finally {
    await queue.close()
  }
}

async function enqueueSelectedJobReviewTasksBeforeWorkerTwo(
  pool: Pool,
  connection: Redis,
  value: Fixture,
  trace: SelectedJobArtifactReviewTrace,
): Promise<void> {
  const { SUBAGENT_DISPATCH_TOPIC, subagentDispatchKey } = await import("../../queue/subagent-queue.js")
  const tasks = [
    { task: trace.reviewerTask, ownerId: `ac6-reviewer-worker-two-${value.suffix}` },
    { task: trace.stopReviewerTask, ownerId: `ac6-stop-reviewer-worker-two-${value.suffix}` },
  ]
  for (const { task, ownerId } of tasks) {
    const payload = { taskId: task.id, sessionId: task.sessionId, rootTaskId: task.rootTaskId, ownerId }
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT ("idempotencyKey") DO NOTHING
       RETURNING "id"`,
      [randomUUID(), SUBAGENT_DISPATCH_TOPIC, task.sessionId, subagentDispatchKey(task.id), JSON.stringify(payload)],
    )
    const dispatchId = inserted.rows[0]?.id
    if (inserted.rowCount !== 1 || !dispatchId) {
      throw new Error("Selected-job fixture dispatch marker already exists or could not be persisted")
    }
    await enqueueSelectedJobTask(trace.queueName, connection, task, ownerId)
    const published = await pool.query<{ id: string }>(
      `UPDATE "agent_outbox" SET "publishedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "topic" = $2 AND "aggregateId" = $3 AND "publishedAt" IS NULL
       RETURNING "id"`,
      [dispatchId, SUBAGENT_DISPATCH_TOPIC, task.sessionId],
    )
    if (published.rowCount !== 1 || published.rows[0]?.id !== dispatchId) {
      throw new Error("Selected-job fixture dispatch marker could not be marked published after enqueue")
    }
  }
}

async function prepareSelectedJobReviewAfterRestart(
  pool: Pool,
  value: Fixture,
  trace: SelectedJobArtifactRestartTrace,
): Promise<SelectedJobArtifactReviewTrace> {
  const artifactStore = createArtifactToolStore(pool)
  const durableVersion = await artifactStore.readVersion({ userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId }, trace.artifactRef)
  expect(durableVersion).toMatchObject({
    version: 1, content: trace.body, contentHash: trace.artifactRef.contentHash,
    userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId,
    sourceDigest: trace.originalPreparation.preparation.sourceDigest,
    provenanceRefs: trace.originalPreparation.preparation.evidenceRefs,
    evidenceRefs: trace.originalPreparation.preparation.evidenceRefs,
    taskId: trace.writerTask.id, toolCallId: trace.writerDraftCallId, requestHash: trace.writerRequestHash,
  })

  const completedWriter = await trace.store.get(trace.writerTask.id, value.sessionId)
  expect(completedWriter).toMatchObject({ status: "completed", role: "writer", rootTaskId: trace.rootTaskId, parentTaskId: trace.rootTaskId })
  if (!completedWriter) throw new Error("Completed selected-job Writer task disappeared")
  const completedWriterResult = record(completedWriter.result)
  const expectedWriterResult = {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: trace.artifactRef,
  }
  expect(completedWriterResult?.structuredResult).toEqual(expectedWriterResult)
  // The specialized dependency contract requires the public result envelope's
  // finalText. Rebuild its safe canonical JSON from the verified artifact ref
  // when this fixture row omits it; never synthesize verifier metadata.
  const writerDependencyResult = typeof completedWriterResult?.finalText === "string"
    ? completedWriter.result
    : { ...(completedWriterResult ?? {}), finalText: JSON.stringify(expectedWriterResult) }
  const workerTwoSources = selectedJobSourceCanaries(trace.jobId, 2)
  const updatedSources = await Promise.all([
    pool.query(`UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "userId" = $2`, [trace.jobId, value.userId, workerTwoSources[0]]),
    pool.query(`UPDATE "Resume" SET "content" = $3::jsonb, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "userId" = $2`, [
      selectedJobFixtureSources(value).resumeId, value.userId, JSON.stringify({ text: workerTwoSources[1] }),
    ]),
    pool.query(`UPDATE persona_facts SET "value" = $3, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "userId" = $2`, [`p3-selected-job-fact-${value.suffix}`, value.userId, workerTwoSources[2]]),
  ])
  if (updatedSources.some(result => result.rowCount !== 1)) throw new Error("Selected-job transient source fixture update failed")
  const currentPreparation = await loadSelectedJobArtifactContext(pool, value.userId, trace.jobId)
  expect(currentPreparation.preparation.sourceDigest).not.toBe(trace.artifactRef.sourceDigest)
  const dependencyScope = {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    rootTaskId: trace.rootTaskId, parentTaskId: trace.rootTaskId,
  }
  let reviewerContext: unknown
  try {
    reviewerContext = materializeTaskGraphDependencyContext(
      { selectedJobPreparation: { jobId: trace.jobId } }, dependencyScope, ["writer"], [{
        ...dependencyScope, key: "writer", taskId: completedWriter.id, status: completedWriter.status,
        role: completedWriter.role, expectedOutputSchema: completedWriter.expectedOutputSchema, result: writerDependencyResult,
        verificationDisposition: "specialized",
      }],
    )
  } catch {
    throw new Error(`selected_job_review_dependency_materialization_failed:${JSON.stringify(selectedWriterResultShape(completedWriter.result))}`)
  }
  const createReviewer = (goal: string) => trace.store.create({
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: trace.rootTaskId,
    role: "reviewer", taskType: "cover_letter_review", goal,
    successCriteria: ["Read the exact Writer artifact and persist its review result"],
    allowedActions: ["artifact.version.read", "artifact.review"], context: reviewerContext,
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer" },
    toolPolicySnapshot: {}, policy: defaultSubagentPolicy(),
  })
  const [reviewerTask, stopReviewerTask] = await Promise.all([
    createReviewer("Review the changed-source selected-job artifact"),
    createReviewer("Attempt selected-job review while Stop fences the write"),
  ])
  for (const child of [reviewerTask, stopReviewerTask]) {
    expect(child).toMatchObject({
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      rootTaskId: trace.rootTaskId, parentTaskId: trace.rootTaskId, role: "reviewer",
    })
    const dependency = record(record(child.context)?.taskGraphDependencyResults)
    const items = Array.isArray(dependency?.items) ? dependency.items.map(record).filter((item): item is RecordValue => item !== null) : []
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ dependencyKey: "writer", role: "writer", taskStatus: "completed" })
    expect(items[0]).not.toHaveProperty("taskId")
    expect(items[0]).toMatchObject({
      result: {
        schemaVersion: "agent-harness.v2.task-graph.result-projection",
        trust: "untrusted", availability: "available", role: "writer", status: "completed",
        artifactRef: trace.artifactRef,
      },
    })
  }
  return { ...trace, currentPreparation, reviewerTask, stopReviewerTask }
}

function selectedWriterResultShape(value: unknown): RecordValue {
  const result = record(typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value)
  const baseKeys = ["finalItemId", "finalText", "status", "stepCount", "structuredResult", "toolCallCount"]
  const keys = result ? Object.keys(result) : []
  const writer = record(result?.structuredResult)
  const artifactRef = record(writer?.artifactRef)
  const safeEnum = (value: unknown, values: readonly string[], missing: string, other: string): string =>
    typeof value !== "string" ? missing : values.includes(value) ? value : other
  const sizeBucket = (() => {
    try {
      const encoded = JSON.stringify(value)
      if (typeof encoded !== "string") return "unavailable"
      const bytes = Buffer.byteLength(encoded, "utf8")
      return bytes <= 4_096 ? "le_4k" : bytes <= 16_384 ? "4k_16k" : "gt_16k"
    } catch { return "unavailable" }
  })()
  return {
    envelopeExactBaseKeys: keys.sort().join(",") === [...baseKeys].sort().join(","),
    unknownTopLevelKeyCount: result ? keys.filter(key => !baseKeys.includes(key)).length : 0,
    status: safeEnum(result?.status, ["completed", "failed", "waiting"], "missing", "other"),
    stepCountSafeInteger: Number.isSafeInteger(result?.stepCount) && Number(result?.stepCount) >= 0,
    toolCallCountSafeInteger: Number.isSafeInteger(result?.toolCallCount) && Number(result?.toolCallCount) >= 0,
    finalItemIdKind: result && Object.hasOwn(result, "finalItemId")
      ? result.finalItemId === null ? "null" : typeof result.finalItemId === "string" ? "string" : "other"
      : "missing",
    finalTextIsString: typeof result?.finalText === "string",
    structuredResultIsObject: writer !== null,
    role: safeEnum(writer?.role, ["writer", "reviewer", "scout", "analyst"], "missing", "other"),
    schema: safeEnum(writer?.schemaVersion, [ROLE_RESULT_SCHEMA], "missing", "other"),
    writerKeysExact: Boolean(writer && Object.keys(writer).sort().join(",") === "artifactRef,role,schemaVersion,status"),
    artifactRefKeysExact: Boolean(artifactRef && Object.keys(artifactRef).sort().join(",") === "artifactId,contentHash,sourceDigest,version"),
    artifactVersionSafe: Number.isSafeInteger(artifactRef?.version) && Number(artifactRef?.version) >= 1,
    artifactHashFormatsSafe: typeof artifactRef?.contentHash === "string" && /^sha256:[a-f0-9]{64}$/.test(artifactRef.contentHash)
      && typeof artifactRef?.sourceDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(artifactRef.sourceDigest),
    verifierPresent: result !== null && Object.hasOwn(result, "taskGraphVerificationReport"),
    receiptPresent: result !== null && Object.hasOwn(result, "taskGraphRepairReceipt"),
    sourceSizeBucket: sizeBucket,
  }
}

async function reviewSelectedJobThroughRestartedWorker(
  pool: Pool,
  value: Fixture,
  trace: SelectedJobArtifactReviewTrace,
  firstWorker: ProcessFixtureChild,
  worker: ProcessFixtureChild,
): Promise<void> {
  const artifactStore = createArtifactToolStore(pool)
  const reviewLine = await waitForProcessLine(worker, `P3_SELECTED_JOB_CHILD_SETTLED ${trace.reviewerTask.id} `, 30_000)
  const reviewSettlement = selectedJobSettlement(reviewLine, trace.reviewerTask.id)
  expect(reviewSettlement).toMatchObject({
    role: "reviewer", taskId: trace.reviewerTask.id, managerStatus: "completed", childStatus: "completed",
    artifactRef: trace.artifactRef, reviewStatus: "stale",
    observations: {
      sawBody: true, privateBodyAbsentBeforeRead: true,
      sourceCanariesReloaded: { job: true, resume: true, persona: true },
      previousSourceCanariesAbsent: { job: true, resume: true, persona: true },
      preReadContextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      reviewStatus: "stale", writerReceiptReferenceRecovered: true,
    },
  })
  const reviewAttempt = Number(reviewSettlement.attemptCount)
  const readCallId = `${SELECTED_JOB_REVIEW_READ_CALL_ID}:attempt:${reviewAttempt}`
  const reviewCallId = `${SELECTED_JOB_REVIEW_CALL_ID}:attempt:${reviewAttempt}`
  if (typeof reviewSettlement.ownerId !== "string") throw new Error("Selected-job reviewer did not report its lease owner")
  const reviewInput = { artifactRef: trace.artifactRef, decision: "passed", findings: [] }
  const reviewScope = {
    ...trace.currentPreparation.preparation,
    userId: value.userId, sessionId: value.sessionId, taskId: trace.reviewerTask.id,
    toolCallId: reviewCallId,
    taskFence: selectedJobTaskFence(trace.reviewerTask, reviewSettlement.ownerId, reviewAttempt),
  }
  const expectedReviewRequestHash = selectedJobTaskReceiptRequestHash("artifact.review", reviewScope, reviewInput)
  const persistedReview = await pool.query<{
    userId: string; sessionId: string; jobId: string; artifactId: string; version: number; contentHash: string;
    sourceDigest: string; currentSourceDigest: string; status: string; findings: unknown; evidenceRefs: unknown;
    taskId: string; toolCallId: string; requestHash: string; reviewHash: string
  }>(`SELECT "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest", "currentSourceDigest",
      "status", "findings", "evidenceRefs", "taskId", "toolCallId", "requestHash", "reviewHash" FROM "agent_artifact_review"
      WHERE "taskId" = $1 AND "toolCallId" = $2`, [trace.reviewerTask.id, reviewCallId])
  expect(persistedReview.rows).toHaveLength(1)
  expect(persistedReview.rows[0]).toMatchObject({
    userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId,
    artifactId: trace.artifactRef.artifactId, version: trace.artifactRef.version,
    contentHash: trace.artifactRef.contentHash,
    status: "stale", sourceDigest: trace.artifactRef.sourceDigest,
    currentSourceDigest: trace.currentPreparation.preparation.sourceDigest,
    findings: [], evidenceRefs: [], taskId: trace.reviewerTask.id, toolCallId: reviewCallId,
    requestHash: expectedReviewRequestHash,
  })
  expect(persistedReview.rows[0]?.sourceDigest).not.toBe(persistedReview.rows[0]?.currentSourceDigest)
  expect(reviewSettlement.reviewHash).toBe(persistedReview.rows[0]?.reviewHash)

  const wrongUserRead = await artifactStore.readVersion({
    userId: `foreign-${value.suffix}`, sessionId: value.sessionId, jobId: trace.jobId,
  }, trace.artifactRef)
  const wrongJobRead = await artifactStore.readVersion({
    userId: value.userId, sessionId: value.sessionId, jobId: trace.otherJobId,
  }, trace.artifactRef)
  const wrongSessionRead = await artifactStore.readVersion({
    userId: value.userId, sessionId: `foreign-session-${value.suffix}`, jobId: trace.jobId,
  }, trace.artifactRef)
  expect(wrongUserRead).toBeNull()
  expect(wrongJobRead).toBeNull()
  expect(wrongSessionRead).toBeNull()
  const reviewRef = trace.artifactRef
  const scopedReview = await artifactStore.findReview({ userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId }, reviewRef)
  expect(scopedReview).toMatchObject({ status: "stale", taskId: trace.reviewerTask.id, toolCallId: reviewCallId })
  await expect(artifactStore.findReview({
    userId: `foreign-user-${value.suffix}`, sessionId: value.sessionId, jobId: trace.jobId,
  }, reviewRef)).resolves.toBeNull()
  await expect(artifactStore.findReview({
    userId: value.userId, sessionId: `foreign-session-${value.suffix}`, jobId: trace.jobId,
  }, reviewRef)).resolves.toBeNull()
  await expect(artifactStore.findReview({
    userId: value.userId, sessionId: value.sessionId, jobId: trace.otherJobId,
  }, reviewRef)).resolves.toBeNull()

  await waitForProcessLine(worker, `P3_SELECTED_JOB_STOP_REVIEW_QUEUED ${trace.stopReviewerTask.id}`, 30_000)
  const stopReviewPhaseStart = worker.output.length
  worker.stdin?.write(`start-selected-job-review:${trace.stopReviewerTask.id}\n`)
  try {
    await waitForProcessLine(worker, `P3_SELECTED_JOB_STOP_REVIEW_READY ${trace.stopReviewerTask.id}`, 30_000)
  } catch {
    const stopReviewPhaseLines = new Set(worker.output.slice(stopReviewPhaseStart))
    throw new Error("Selected-job stop-review READY was not reached; phases=" + JSON.stringify({
      commandReceived: stopReviewPhaseLines.has(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.commandReceived),
      round1Entered: stopReviewPhaseLines.has(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.round1Entered),
      artifactVersionReadYieldReached: stopReviewPhaseLines.has(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.artifactVersionReadYieldReached),
      round2Entered: stopReviewPhaseLines.has(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.round2Entered),
      readyEmissionReached: stopReviewPhaseLines.has(SELECTED_JOB_STOP_REVIEW_PHASE_MARKERS.readyEmissionReached),
    }))
  }
  const liveStopTask = await trace.store.get(trace.stopReviewerTask.id, value.sessionId)
  if (!liveStopTask?.leaseOwner || liveStopTask.status !== "running") throw new Error("Stop-review fixture did not hold a live Worker lease")
  const stopFence = selectedJobTaskFence(liveStopTask, liveStopTask.leaseOwner, liveStopTask.attemptCount)
  const interrupted = await trace.store.interruptSubtree({
    sessionId: value.sessionId, rootTaskId: trace.rootTaskId, targetPath: liveStopTask.path, now: new Date(),
  })
  expect(interrupted).toBe(1)
  const stoppedReviewInput = {
    userId: value.userId, sessionId: value.sessionId, jobId: trace.jobId,
    artifactId: trace.artifactRef.artifactId, version: trace.artifactRef.version,
    contentHash: trace.artifactRef.contentHash, sourceDigest: trace.artifactRef.sourceDigest,
    currentSourceDigest: trace.currentPreparation.preparation.sourceDigest, status: "stale" as const,
    findings: [], evidenceRefs: [], taskId: trace.stopReviewerTask.id,
    toolCallId: `ac6-stop-review-write:${trace.stopReviewerTask.id}`,
    requestHash: hashArtifactContent({ op: "artifact.review", call: trace.stopReviewerTask.id, artifactRef: trace.artifactRef }),
    reviewHash: hashArtifactContent({ status: "stale", artifactRef: trace.artifactRef }), taskFence: stopFence,
  }
  await expect(artifactStore.saveReview(stoppedReviewInput)).rejects.toMatchObject({ code: "task_fence_denied" })
  const countAfterStop = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS "count" FROM "agent_artifact_review" WHERE "taskId" = $1`, [trace.stopReviewerTask.id],
  )
  expect(countAfterStop.rows[0]?.count).toBe(0)

  worker.stdin?.write(`release-selected-job-review:${trace.stopReviewerTask.id}\n`)
  const stoppedLine = await waitForProcessLine(worker, `P3_SELECTED_JOB_CHILD_SETTLED ${trace.stopReviewerTask.id} `, 30_000)
  const stoppedSettlement = selectedJobSettlement(stoppedLine, trace.stopReviewerTask.id)
  expect(stoppedSettlement).toMatchObject({
    managerStatus: "interrupted",
    observations: {
      sawBody: true, privateBodyAbsentBeforeRead: true, writerReceiptReferenceRecovered: true,
      sourceCanariesReloaded: { job: true, resume: true, persona: true },
      previousSourceCanariesAbsent: { job: true, resume: true, persona: true },
      preReadContextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    },
  })
  const stoppedObservations = record(stoppedSettlement.observations)
  if (stoppedObservations?.reviewWriteError !== undefined && stoppedObservations.reviewWriteError !== null) {
    expect(stoppedObservations.reviewWriteError).toBe("private_artifact_review_failed")
  }
  const countAfterInterruptedSettlement = await pool.query<{ count: number }>(
    `SELECT COUNT(*)::int AS "count" FROM "agent_artifact_review" WHERE "taskId" = $1`, [trace.stopReviewerTask.id],
  )
  expect(countAfterInterruptedSettlement.rows[0]?.count).toBe(0)
  const [persistedItems, persistedEvents, persistedOutbox, persistedTasks] = await Promise.all([
    pool.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[])`, [
      value.sessionId, value.turnId, [trace.writerTask.id, trace.reviewerTask.id, trace.stopReviewerTask.id],
    ]),
    pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[])`, [
      value.sessionId, value.turnId, [trace.writerTask.id, trace.reviewerTask.id, trace.stopReviewerTask.id],
    ]),
    pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.events' AND "aggregateId" = $1`, [value.sessionId]),
    pool.query<{ context: unknown; result: unknown }>(`SELECT "context", "result" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND ("id" = $2 OR "rootTaskId" = $2)`, [value.sessionId, trace.rootTaskId]),
  ])
  expect(persistedItems.rows.length).toBeGreaterThan(0)
  expect(persistedEvents.rows.length).toBeGreaterThan(0)
  expect(persistedTasks.rows.length).toBeGreaterThanOrEqual(3)
  const publicPersistence = JSON.stringify({
    items: persistedItems.rows.map(row => row.content),
    events: persistedEvents.rows.map(row => row.payload),
    outbox: persistedOutbox.rows.map(row => row.payload),
    tasks: persistedTasks.rows,
  })
  expect(publicPersistence).not.toContain(trace.body)
  const sourceCanaries = [...selectedJobSourceCanaries(trace.jobId, 1), ...selectedJobSourceCanaries(trace.jobId, 2)]
  for (const canary of sourceCanaries) expect(publicPersistence).not.toContain(canary)
  const processLogs = [...firstWorker.output, ...firstWorker.errors, ...worker.output, ...worker.errors].join("\n")
  expect(processLogs).not.toContain(trace.body)
  for (const canary of sourceCanaries) expect(processLogs).not.toContain(canary)
  const draftReceipts = persistedItems.rows.flatMap(row => rowsForToolCall(row.content, trace.writerDraftCallId))
    .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
  expect(draftReceipts.length).toBeGreaterThan(0)
  const readReceipts = persistedItems.rows.flatMap(row => rowsForToolCall(row.content, readCallId))
    .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
  const reviewReceipts = persistedItems.rows.flatMap(row => rowsForToolCall(row.content, reviewCallId))
    .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
  expect(readReceipts.length).toBeGreaterThan(0)
  expect(reviewReceipts.length).toBeGreaterThan(0)
  for (const receipt of draftReceipts) {
    const output = record(receipt.output)
    expect(output).not.toBeNull()
    expect(Object.keys(output ?? {}).sort()).toEqual(["artifactRef"])
  }
}

function rowsForToolCall(value: unknown, callId: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(item => rowsForToolCall(item, callId))
  if (!value || typeof value !== "object") return []
  const row = value as Record<string, unknown>
  const matched = row.toolCallId === callId ? [row] : []
  return [...matched, ...Object.values(row).flatMap(child => rowsForToolCall(child, callId))]
}

function canonicalDiscoveryScoutResultDiagnostic(request: HarnessModelRequest, resultText: string, expectedJobId: string): RecordValue {
  const callId = "p3-discovery-read-scout"
  const rawSearchResult = latestToolResult(request, callId)
  let latestSearchResultObserved = false
  let latestSearchResultFailed = false
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0 && !latestSearchResultObserved; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type !== "tool_result" || part.toolUseId !== callId) continue
      latestSearchResultObserved = true
      latestSearchResultFailed = part.isError === true
      break
    }
  }
  const search = latestSearchResultFailed ? null : record(rawSearchResult)
  const jobs = Array.isArray(search?.jobs) ? search.jobs.map(record) : []
  const expectedJob = jobs.find(job => job?.id === expectedJobId)
  const searchCallIds = new Set<string>()
  for (const message of request.messages) for (const part of message.content) {
    if (part.type === "tool_use" && part.name === "jobs.search") searchCallIds.add(part.id)
  }
  const observedSearchOutputs: unknown[] = []
  let successfulSearchResultCount = 0
  for (const message of request.messages) for (const part of message.content) {
    if (part.type !== "tool_result" || !searchCallIds.has(part.toolUseId) || part.isError === true) continue
    successfulSearchResultCount += 1
    if (typeof part.content !== "string") continue
    try { observedSearchOutputs.push(JSON.parse(part.content) as unknown) } catch { /* malformed evidence is omitted */ }
  }
  const boundedSearchOutputs = observedSearchOutputs.slice(-8)
  const observedEvidence = createObservedEvidenceIndex()
  for (const output of boundedSearchOutputs) recordReadToolOutput(observedEvidence, "jobs.search", output)
  let resultShapeValid = false
  let resultValidationCode = "other"
  try {
    validateRoleResult(JSON.parse(resultText) as unknown, "scout")
    resultShapeValid = true
    resultValidationCode = "none"
  } catch (error: unknown) {
    resultValidationCode = error instanceof RoleResultValidationError ? error.code : "other"
  }
  let requestEvidenceBindValid = false
  try {
    requestEvidenceBindValid = parseAndBindStructuredResult(resultText, "scout", observedEvidence) !== undefined
  } catch {
    requestEvidenceBindValid = false
  }
  return {
    latestSearchResultObserved,
    latestSearchResultParsed: rawSearchResult !== null && !latestSearchResultFailed,
    latestSearchResultFailed,
    expectedJobPresent: expectedJob !== undefined,
    expectedJobSourceMatches: expectedJob?.source === "greenhouse",
    jobsSearchCallCount: Math.min(searchCallIds.size, 8),
    jobsSearchCallCountTruncated: searchCallIds.size > 8,
    returnedJobCount: Math.min(jobs.length, 20),
    returnedJobIdRedactionMarker: rawSearchResult === null || latestSearchResultFailed
      ? null
      : jobs.some(job => typeof job?.id === "string" && /\[REDACTED(?:_(?:PHONE|EMAIL))?\]/i.test(job.id)),
    observedSearchResultCount: Math.min(successfulSearchResultCount, 8),
    searchEvidenceTruncated: successfulSearchResultCount > 8,
    resultShapeValid,
    resultValidationCode,
    requestEvidenceBindValid,
  }
}

function latestToolResult(request: HarnessModelRequest, callId: string): unknown {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type !== "tool_result" || part.toolUseId !== callId) continue
      if (typeof part.content !== "string") return null
      try { return JSON.parse(part.content) as unknown } catch { return null }
    }
  }
  return null
}

function planTaskIds(request: HarnessModelRequest, callId = PLAN_CALL_ID, expectedCount = 2): string[] {
  const output = record(latestToolResult(request, callId))
  if (!output || (output.status !== "accepted" && output.status !== "duplicate") || !Array.isArray(output.nodes)) {
    throw new Error("TaskGraph plan receipt missing from the next root model request")
  }
  const ids = output.nodes.flatMap(value => {
    const node = record(value)
    return node && typeof node.taskId === "string" ? [node.taskId] : []
  })
  if (ids.length !== expectedCount) throw new Error(`Expected ${expectedCount} planned task ID(s); received ${ids.length}`)
  return ids
}

function completedGraphStatusFailureProjection(graph: unknown): RecordValue {
  const graphNodes = record(graph)?.nodes
  const nodes = Array.isArray(graphNodes) ? graphNodes.map(record) : []
  return {
    nodes: COMPLETED_GRAPH_STATUS_EXPECTATIONS.map(expected => {
      const matches = nodes.filter(node => node?.key === expected.key)
      const node = matches[0]
      const status = diagnosticEnum(node?.status, TASK_DIAGNOSTIC_STATUSES)
      const readiness = diagnosticEnum(node?.readiness, TASK_GRAPH_READINESS)
      return {
        key: expected.key,
        status,
        readiness,
        expectedMatch: matches.length === 1 && status === expected.status && readiness === "terminal",
      }
    }),
  }
}

function failurePreflightEvidenceProjection(input: {
  rootTaskLookupCompleted: boolean
  rootTaskId: string | null
  expectedTurnId: string
  expectedTaskIds: readonly string[]
  targets: readonly FailurePreflightTargetObservation[]
}): RecordValue {
  const rootTaskFound = input.rootTaskLookupCompleted ? Boolean(input.rootTaskId) : null
  return {
    rootTaskFound,
    targets: FAILURE_PREFLIGHT_TARGET_KEYS.map((key, index) => {
      const target = input.targets[index] ?? null
      if (!target) {
        return {
          key, found: null, targetMatchesReceipt: null,
          turnMatches: null, rootMatches: null, parentMatches: null,
        }
      }
      if (!target.found) {
        return {
          key, found: false, targetMatchesReceipt: null,
          turnMatches: null, rootMatches: null, parentMatches: null, scope: target.scope,
        }
      }
      return {
        key,
        found: true,
        targetMatchesReceipt: target.taskId === input.expectedTaskIds[index],
        turnMatches: target.turnId === input.expectedTurnId,
        rootMatches: rootTaskFound === true ? target.rootTaskId === input.rootTaskId : null,
        parentMatches: rootTaskFound === true ? target.parentTaskId === input.rootTaskId : null,
      }
    }),
  }
}

function missingTaskScopeEvidence(input: {
  lookupCompleted: boolean
  observed: null | {
    sessionId: string | null
    sessionUserId: string | null
    turnId: string | null
    rootTaskId: string | null
    parentTaskId: string | null
  }
  expected: { sessionId: string; userId: string; turnId: string; rootTaskId: string }
}): FailurePreflightTargetScopeEvidence {
  if (!input.lookupCompleted) {
    return { lookupCompleted: false, rowFound: null, sessionMatches: null, userMatches: null,
      turnMatches: null, rootMatches: null, parentMatches: null }
  }
  if (!input.observed) {
    return { lookupCompleted: true, rowFound: false, sessionMatches: null, userMatches: null,
      turnMatches: null, rootMatches: null, parentMatches: null }
  }
  return {
    lookupCompleted: true, rowFound: true,
    sessionMatches: input.observed.sessionId === input.expected.sessionId,
    userMatches: input.observed.sessionUserId === input.expected.userId,
    turnMatches: input.observed.turnId === input.expected.turnId,
    rootMatches: input.observed.rootTaskId === input.expected.rootTaskId,
    parentMatches: input.observed.parentTaskId === input.expected.rootTaskId,
  }
}

async function missingTaskScopeFailureDiagnostics(
  pool: Pool,
  taskId: string,
  expected: { sessionId: string; userId: string; turnId: string; rootTaskId: string },
): Promise<FailurePreflightTargetScopeEvidence> {
  try {
    const result = await pool.query<{
      sessionId: string | null
      sessionUserId: string | null
      turnId: string | null
      rootTaskId: string | null
      parentTaskId: string | null
    }>(
      `SELECT task."sessionId", session."userId" AS "sessionUserId", task."turnId", task."rootTaskId", task."parentTaskId"
       FROM "sub_agent_tasks" AS task
       LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       WHERE task."id" = $1 LIMIT 1`,
      [taskId],
    )
    return missingTaskScopeEvidence({ lookupCompleted: true, observed: result.rows[0] ?? null, expected })
  } catch {
    return missingTaskScopeEvidence({ lookupCompleted: false, observed: null, expected })
  }
}

function sameUniqueIds(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left), rightSet = new Set(right)
  return leftSet.size === left.length && rightSet.size === right.length && leftSet.size === rightSet.size
    && [...leftSet].every(value => rightSet.has(value))
}

function planReceiptEvidenceProjection(
  request: HarnessModelRequest,
  callId: string,
  graph: unknown,
): RecordValue {
  const parts = request.messages.flatMap(message => Array.isArray(message.content) ? message.content.map(record) : [])
  const matchingCalls = parts.filter(part => part?.type === "tool_use" && part.id === callId)
  const matchingResults = parts.filter(part => part?.type === "tool_result" && part.toolUseId === callId)
  const planCalls = parts.filter(part => part?.type === "tool_use" && part.name === "agent.plan")
  const planCallIds = new Set(planCalls.flatMap(part => typeof part?.id === "string" ? [part.id] : []))
  const planResults = parts.filter(part => part?.type === "tool_result"
    && (planCallIds.has(String(part.toolUseId)) || part.toolUseId === callId))
  const currentNodes = record(graph)?.nodes
  const graphTaskIds = Array.isArray(currentNodes)
    ? currentNodes.map(record).flatMap(node => typeof node?.taskId === "string" ? [node.taskId] : [])
    : []
  const parsedResults = matchingResults.map(part => {
    if (typeof part?.content !== "string") return null
    try { return record(JSON.parse(part.content) as unknown) } catch { return null }
  })
  const output = record(parsedResults.at(-1))
  const nodes = Array.isArray(output?.nodes) ? output.nodes.map(record).filter((node): node is RecordValue => node !== null) : []
  const taskIds = nodes.flatMap(node => typeof node.taskId === "string" && node.taskId.trim().length > 0 ? [node.taskId] : [])
  const planNames = [...new Set(planCalls.map(part => part?.name === "agent.plan" ? "agent.plan" : "other"))].slice(0, 2)
  const graphTaskIdSet = new Set(graphTaskIds)
  return {
    expectedCallMatched: matchingCalls.length > 0 && matchingResults.length > 0,
    matchingToolUseCount: matchingCalls.length,
    matchingToolNameIsAgentPlan: matchingCalls.some(part => part?.name === "agent.plan"),
    planToolUseCount: planCalls.length,
    planToolNames: planNames,
    matchingToolResultCount: matchingResults.length,
    matchingResultIsError: matchingResults.length === 0 ? null : matchingResults.at(-1)?.isError === true,
    planToolResultCount: planResults.length,
    resultCallIdMatchesPlanCall: matchingResults.length > 0 && planCallIds.has(callId),
    resultContentType: matchingResults.at(-1) ? diagnosticValueType(matchingResults.at(-1)?.content) : "missing",
    resultJsonParsed: parsedResults.at(-1) !== null && parsedResults.at(-1) !== undefined,
    receiptStatus: output?.status === "accepted" || output?.status === "duplicate" ? output.status : output ? "other" : "missing",
    resultErrorCodePresent: typeof output?.errorCode === "string",
    receiptRevision: typeof output?.revision === "number" && Number.isSafeInteger(output.revision) && output.revision >= 0
      ? output.revision
      : null,
    receiptNodeCount: Array.isArray(output?.nodes) ? output.nodes.length : null,
    receiptTaskIdCount: taskIds.length,
    graphTaskIdCount: graphTaskIds.length,
    receiptTaskIdsMatchingGraphCount: taskIds.filter(taskId => graphTaskIdSet.has(taskId)).length,
    receiptTaskIdsEqualGraphSet: graphTaskIds.length === 0 ? null : sameUniqueIds(taskIds, graphTaskIds),
  }
}

async function collectPlanReceiptFailureDiagnostics(
  pool: Pool,
  turnId: string,
  request: HarnessModelRequest,
  callId: string,
  graph: unknown,
): Promise<string> {
  try {
    const persisted = await pool.query<{ type: string; status: string; revision: number; content: unknown }>(
      `SELECT "type", "status", "revision", "content" FROM "agent_items"
       WHERE "turnId" = $1 AND "type" IN ('tool_call', 'tool_result')
       ORDER BY "createdAt" DESC LIMIT 40`,
      [turnId],
    )
    const persistedItems = [...persisted.rows].reverse()
    const callItems = persistedItems.filter(row => row.type === "tool_call" && record(row.content)?.toolName === "agent.plan")
    const expectedCallItems = callItems.filter(row => record(row.content)?.toolCallId === callId)
    const planCallIds = new Set(callItems.flatMap(row => {
      const id = record(row.content)?.toolCallId
      return typeof id === "string" ? [id] : []
    }))
    const resultItems = persistedItems.filter(row => row.type === "tool_result"
      && (planCallIds.has(String(record(row.content)?.toolCallId)) || record(row.content)?.toolCallId === callId))
    const expectedResultItems = resultItems.filter(row => record(row.content)?.toolCallId === callId)
    const expectedResult = record(expectedResultItems.at(-1)?.content)
    const output = record(expectedResult?.output)
    const nodes = Array.isArray(output?.nodes) ? output.nodes.map(record).filter((node): node is RecordValue => node !== null) : []
    const taskIds = nodes.flatMap(node => typeof node.taskId === "string" && node.taskId.trim().length > 0 ? [node.taskId] : [])
    const graphNodes = record(graph)?.nodes
    const graphTaskIds = Array.isArray(graphNodes)
      ? graphNodes.map(record).flatMap(node => typeof node?.taskId === "string" ? [node.taskId] : [])
      : []
    const graphTaskIdSet = new Set(graphTaskIds)
    const requestProjection = planReceiptEvidenceProjection(request, callId, graph)
    const persistedProjection = {
      expectedCallMatched: expectedCallItems.length > 0 && expectedResultItems.length > 0,
      matchingToolUseCount: expectedCallItems.length,
      matchingToolNameIsAgentPlan: expectedCallItems.some(row => record(row.content)?.toolName === "agent.plan"),
      callItemStatus: diagnosticEnum(expectedCallItems.at(-1)?.status, ITEM_DIAGNOSTIC_STATUSES),
      planToolUseCount: callItems.length,
      planToolNames: [...new Set(callItems.map(row => record(row.content)?.toolName === "agent.plan" ? "agent.plan" : "other"))].slice(0, 2),
      matchingToolResultCount: expectedResultItems.length,
      matchingResultIsError: expectedResultItems.length === 0 ? null : expectedResultItems.at(-1)?.status !== "completed",
      planToolResultCount: resultItems.length,
      resultItemStatus: diagnosticEnum(expectedResultItems.at(-1)?.status, ITEM_DIAGNOSTIC_STATUSES),
      resultItemRevision: diagnosticBoundedCount(expectedResultItems.at(-1)?.revision),
      resultCallIdMatchesPlanCall: typeof expectedResult?.toolCallId === "string" && planCallIds.has(expectedResult.toolCallId),
      resultErrorCodePresent: typeof expectedResult?.errorCode === "string",
      receiptStatus: output?.status === "accepted" || output?.status === "duplicate" ? output.status : output ? "other" : "missing",
      receiptRevision: diagnosticBoundedCount(output?.revision),
      receiptNodeCount: Array.isArray(output?.nodes) ? output.nodes.length : null,
      receiptTaskIdCount: taskIds.length,
      graphTaskIdCount: graphTaskIds.length,
      receiptTaskIdsMatchingGraphCount: taskIds.filter(taskId => graphTaskIdSet.has(taskId)).length,
      receiptTaskIdsEqualGraphSet: graphTaskIds.length === 0 ? null : sameUniqueIds(taskIds, graphTaskIds),
    }
    const requestResultMatchesPersisted = requestProjection.expectedCallMatched === persistedProjection.expectedCallMatched
      && requestProjection.matchingToolUseCount === persistedProjection.matchingToolUseCount
      && requestProjection.matchingToolNameIsAgentPlan === persistedProjection.matchingToolNameIsAgentPlan
      && requestProjection.planToolUseCount === persistedProjection.planToolUseCount
      && JSON.stringify(requestProjection.planToolNames) === JSON.stringify(persistedProjection.planToolNames)
      && requestProjection.matchingToolResultCount === persistedProjection.matchingToolResultCount
      && requestProjection.matchingResultIsError === persistedProjection.matchingResultIsError
      && requestProjection.planToolResultCount === persistedProjection.planToolResultCount
      && requestProjection.resultCallIdMatchesPlanCall === persistedProjection.resultCallIdMatchesPlanCall
      && requestProjection.receiptStatus === persistedProjection.receiptStatus
      && requestProjection.resultErrorCodePresent === persistedProjection.resultErrorCodePresent
      && requestProjection.receiptRevision === persistedProjection.receiptRevision
      && requestProjection.receiptNodeCount === persistedProjection.receiptNodeCount
      && requestProjection.receiptTaskIdCount === persistedProjection.receiptTaskIdCount
      && requestProjection.receiptTaskIdsMatchingGraphCount === persistedProjection.receiptTaskIdsMatchingGraphCount
      && requestProjection.receiptTaskIdsEqualGraphSet === persistedProjection.receiptTaskIdsEqualGraphSet
    return boundedDiagnostic(JSON.stringify({
      available: true,
      expectedCallMatched: requestProjection.expectedCallMatched === true && persistedProjection.expectedCallMatched === true,
      request: requestProjection,
      persisted: persistedProjection,
      requestResultMatchesPersisted,
    }), 1_200)
  } catch {
    return JSON.stringify({ available: false })
  }
}

function waitOutcomeFromRequest(request: HarnessModelRequest, taskCount: number, requiredRole?: "scout" | "analyst"): RecordValue & { tasks: unknown[] } {
  const outcomes = request.messages.flatMap(message => message.content.flatMap(part => {
    if (part.type !== "tool_result" || !part.toolUseId.startsWith("wait:") || typeof part.content !== "string") return []
    try {
      const outcome = record(JSON.parse(part.content) as unknown)
      return outcome && Array.isArray(outcome.tasks) && outcome.tasks.length === taskCount
        && (!requiredRole || outcome.tasks.some(task => record(task)?.role === requiredRole)) ? [outcome] : []
    } catch { return [] }
  }))
  const outcome = outcomes[0]
  if (!outcome) throw new Error(`Expected a hydrated wait result with ${taskCount} child task(s)`)
  if (Buffer.byteLength(JSON.stringify(outcome), "utf8") > 8 * 1024) throw new Error("Hydrated child wait result exceeded its byte limit")
  return outcome as RecordValue & { tasks: unknown[] }
}

function repairWaitOutcomeFromRequest(
  request: HarnessModelRequest,
  callId: string,
  expectedTaskIds: readonly string[],
  resolvedOriginal?: unknown,
): RecordValue {
  const waitCall = toolUseFromRequest(request, callId)
  const waitInput = record(waitCall?.input)
  if (waitCall?.name !== "agent.wait" || !waitInput
    || !sameUniqueIds(stringIds(waitInput.taskIds) ?? [], expectedTaskIds) || waitInput.mode !== "all") {
    throw new Error("Repair wait call did not match the accepted plan task IDs")
  }
  const original = record(resolvedOriginal === undefined ? latestToolResult(request, callId) : resolvedOriginal)
  const originalTaskIds = stringIds(original?.taskIds)
  if (!original || typeof original.waitId !== "string" || original.waitId.length === 0
    || !originalTaskIds || !sameUniqueIds(originalTaskIds, expectedTaskIds)) {
    throw new Error("Repair wait receipt did not match the accepted plan task IDs")
  }
  const waitId = original.waitId
  const outcome = original.status === "waiting"
    ? record(latestToolResult(request, `wait:${waitId}`))
    : original
  if (!outcome || outcome.waitId !== waitId
    || (outcome.status !== "ready" && outcome.status !== "timed_out")) {
    throw new Error("Repair wait did not expose its exact resolved wait outcome")
  }
  const targetIds = stringIds(outcome.targetTaskIds ?? outcome.taskIds)
  const matchedIds = stringIds(outcome.matchedTaskIds, true)
  const taskIds = Array.isArray(outcome.tasks)
    ? stringIds(outcome.tasks.map(task => record(task)?.taskId)) : null
  if (!targetIds || !sameUniqueIds(targetIds, expectedTaskIds)
    || !matchedIds || matchedIds.some(id => !expectedTaskIds.includes(id))
    || !taskIds || !sameUniqueIds(taskIds, expectedTaskIds)
    || (outcome.status === "ready" && !sameUniqueIds(matchedIds, expectedTaskIds))) {
    throw new Error("Resolved repair wait did not cover the exact accepted plan task IDs")
  }
  return outcome
}

type RepairWaitReference = { readonly id: string; readonly sizeBytes: number; readonly sha256: string }
type RepairWaitFailureClass =
  | "reference_invalid" | "read_limit" | "read_identity" | "chunk_invalid" | "cursor_invalid"
  | "digest_invalid" | "json_invalid" | "wait_call_mismatch" | "wait_receipt_mismatch"
  | "wait_outcome_missing" | "wait_target_mismatch" | "targets_missing" | "reader_not_visible"
  | "read_budget_exceeded" | "other"
type RepairWaitFailureStage = "output_resolution" | "outcome_validation"
type RepairWaitFailureErrorKind = "error" | "type_error" | "range_error" | "syntax_error" | "non_error"
type RepairWaitOutcomeDiagnosticStatus = "ready" | "timed_out" | "waiting" | "unavailable" | "other"

function boundedRepairWaitDiagnosticCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Math.min(8, Number(value)) : 0
}

function repairWaitOutcomeDiagnosticStatus(value: unknown): RepairWaitOutcomeDiagnosticStatus {
  const status = record(value)?.status
  if (status === "ready" || status === "timed_out" || status === "waiting") return status
  return typeof status === "string" ? "other" : "unavailable"
}

function repairWaitFailureErrorKind(error: unknown): RepairWaitFailureErrorKind {
  try {
    if (error instanceof TypeError) return "type_error"
    if (error instanceof RangeError) return "range_error"
    if (error instanceof SyntaxError) return "syntax_error"
    if (error instanceof Error) return "error"
  } catch {
    return "non_error"
  }
  return "non_error"
}

const REPAIR_WAIT_FAILURE_CLASSES: Readonly<Record<string, RepairWaitFailureClass>> = {
  repair_wait_reference_invalid: "reference_invalid",
  repair_wait_reference_read_limit: "read_limit",
  repair_wait_reference_read_identity: "read_identity",
  repair_wait_reference_chunk_invalid: "chunk_invalid",
  repair_wait_reference_cursor_invalid: "cursor_invalid",
  repair_wait_reference_digest_invalid: "digest_invalid",
  repair_wait_reference_json_invalid: "json_invalid",
  "Repair wait call did not match the accepted plan task IDs": "wait_call_mismatch",
  "Repair wait receipt did not match the accepted plan task IDs": "wait_receipt_mismatch",
  "Repair wait did not expose its exact resolved wait outcome": "wait_outcome_missing",
  "Resolved repair wait did not cover the exact accepted plan task IDs": "wait_target_mismatch",
  "repair fixture lost accepted wait targets": "targets_missing",
  "repair wait reference reader was not visible to the model": "reader_not_visible",
  "repair wait reference exceeded its bounded read budget": "read_budget_exceeded",
}

function repairWaitFailureClass(error: unknown): RepairWaitFailureClass {
  if (!(error instanceof Error) || !Object.prototype.hasOwnProperty.call(REPAIR_WAIT_FAILURE_CLASSES, error.message)) {
    return "other"
  }
  return REPAIR_WAIT_FAILURE_CLASSES[error.message]
}

function repairWaitReferenceSizeBytes(value: unknown): number | null {
  const size = record(value)?.sizeBytes
  return Number.isSafeInteger(size) && Number(size) >= 0 && Number(size) <= 1024 * 1024 ? Number(size) : null
}

type RepairWaitOutputResolution =
  | { readonly status: "inline"; readonly output: unknown }
  | { readonly status: "read"; readonly reference: RepairWaitReference; readonly cursor?: string }
  | { readonly status: "complete"; readonly reference: RepairWaitReference; readonly output: unknown; readonly readCount: number }

const TOOL_RESULT_REFERENCE_ID = /^tool-result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function toolUseFromRequest(request: HarnessModelRequest, callId: string): { name: string; input: unknown } | null {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type !== "tool_use" || part.id !== callId || typeof part.name !== "string") continue
      return { name: part.name, input: part.input }
    }
  }
  return null
}

function repairWaitReference(value: unknown): RepairWaitReference | null {
  const row = record(value)
  if (!row) return null
  if (!Object.hasOwn(row, "$ref")) {
    if (Object.hasOwn(row, "sizeBytes") || Object.hasOwn(row, "sha256")) throw new Error("repair_wait_reference_invalid")
    return null
  }
  if (Object.keys(row).sort().join(",") !== "$ref,sha256,sizeBytes"
    || typeof row.$ref !== "string" || !TOOL_RESULT_REFERENCE_ID.test(row.$ref)
    || !Number.isSafeInteger(row.sizeBytes) || Number(row.sizeBytes) <= 8 * 1024
    || Number(row.sizeBytes) > VERIFICATION_REPAIR_WAIT_OUTPUT_BYTE_LIMIT
    || typeof row.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.sha256)) {
    throw new Error("repair_wait_reference_invalid")
  }
  return { id: row.$ref, sizeBytes: Number(row.sizeBytes), sha256: row.sha256 }
}

function repairWaitOutputResolutionFromRequest(
  request: HarnessModelRequest,
  callId: string,
  readCallIds: readonly string[],
): RepairWaitOutputResolution {
  const original = latestToolResult(request, callId)
  const reference = repairWaitReference(original)
  if (!reference) return { status: "inline", output: original }
  if (readCallIds.length > VERIFICATION_REPAIR_MAX_REFERENCE_READS) throw new Error("repair_wait_reference_read_limit")

  let cursor: string | undefined
  let offset = 0
  const chunks: string[] = []
  for (let index = 0; index < readCallIds.length; index += 1) {
    const readCallId = readCallIds[index]!
    const call = toolUseFromRequest(request, readCallId)
    const input = record(call?.input)
    const expectedInputKeys = cursor === undefined ? "referenceId" : "cursor,referenceId"
    if (call?.name !== "tool_results.read" || !input
      || Object.keys(input).sort().join(",") !== expectedInputKeys
      || input.referenceId !== reference.id
      || (cursor === undefined ? input.cursor !== undefined : input.cursor !== cursor)) {
      throw new Error("repair_wait_reference_read_identity")
    }
    const chunk = record(latestToolResult(request, readCallId))
    if (!chunk || Object.keys(chunk).sort().join(",") !== "byteCount,chunk,nextCursor,ref,sha256"
      || chunk.ref !== reference.id || chunk.sha256 !== reference.sha256 || chunk.byteCount !== reference.sizeBytes
      || typeof chunk.chunk !== "string" || chunk.chunk.length === 0
      || Buffer.byteLength(chunk.chunk, "utf8") > 4_096
      || Buffer.from(chunk.chunk, "utf8").toString("utf8") !== chunk.chunk
      || Buffer.byteLength(JSON.stringify(chunk), "utf8") > 4_096) {
      throw new Error("repair_wait_reference_chunk_invalid")
    }
    const chunkBytes = Buffer.byteLength(chunk.chunk, "utf8")
    offset += chunkBytes
    if (offset > reference.sizeBytes) throw new Error("repair_wait_reference_cursor_invalid")
    chunks.push(chunk.chunk)
    if (chunk.nextCursor === null) {
      if (offset !== reference.sizeBytes || index !== readCallIds.length - 1) {
        throw new Error("repair_wait_reference_cursor_invalid")
      }
      const encoded = chunks.join("")
      if (Buffer.byteLength(encoded, "utf8") !== reference.sizeBytes
        || createHash("sha256").update(encoded, "utf8").digest("hex") !== reference.sha256) {
        throw new Error("repair_wait_reference_digest_invalid")
      }
      let output: unknown
      try { output = JSON.parse(encoded) as unknown } catch { throw new Error("repair_wait_reference_json_invalid") }
      return { status: "complete", reference, output, readCount: readCallIds.length }
    }
    if (typeof chunk.nextCursor !== "string" || !/^(0|[1-9][0-9]*)$/.test(chunk.nextCursor)
      || Number(chunk.nextCursor) !== offset || offset >= reference.sizeBytes) {
      throw new Error("repair_wait_reference_cursor_invalid")
    }
    cursor = chunk.nextCursor
  }
  if (readCallIds.length === 0) return { status: "read", reference }
  if (cursor === undefined) throw new Error("repair_wait_reference_cursor_invalid")
  return { status: "read", reference, cursor }
}

function stringIds(value: unknown, allowEmpty = false): string[] | null {
  if (!Array.isArray(value) || value.length > 8 || (!allowEmpty && value.length === 0)) return null
  const ids: string[] = []
  for (const id of value) {
    if (typeof id !== "string" || id.length === 0 || id.length > 256 || id.trim() !== id) return null
    ids.push(id)
  }
  return new Set(ids).size === ids.length ? ids : null
}

function currentGraphFromRequest(request: HarnessModelRequest): RecordValue | null {
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type !== "text" || !part.text.includes('"kind":"task_graph_current"')) continue
      const json = part.text.slice(part.text.indexOf("\n") + 1)
      try { return record(JSON.parse(json) as unknown) } catch { return null }
    }
  }
  return null
}

function expectPassedVerificationReport(value: unknown, ...criterionIds: string[]): void {
  const report = record(value)
  expect(report).toMatchObject({
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status: "passed",
    reasonCode: "criteria_met",
    criteria: criterionIds.map(criterionId => ({ criterionId, status: "passed", reasonCode: "criteria_met" })),
  })
  expect(typeof report?.evidenceDigest).toBe("string")
  expect(String(report?.evidenceDigest)).toMatch(/^[a-f0-9]{64}$/)
}

function expectUnverifiedVerificationReport(value: unknown, criterionId: string): void {
  const report = record(value)
  expect(report).toMatchObject({
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status: "unverified",
    reasonCode: "result_invalid",
    criteria: [{ criterionId, status: "unverified", reasonCode: "result_invalid" }],
    evidenceDigest: null,
    resultDigest: null,
  })
}

async function checkTerminalTaskGraph(pool: Pool, lease: TurnLease, rootTaskId: string) {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
    const verdict = await checkTaskGraphTerminalVerification(client, lease, rootTaskId)
    await client.query("ROLLBACK")
    return verdict
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

type FixtureProcessScope = Readonly<{ sessionId: string; turnId: string; selectedQueueName?: string }>
type FixtureQueueJobIdentity = Readonly<{
  queueName: string
  kind: "turn"
  jobId: string
  sessionId: string
  turnId: string
  ownerId: string
  generation: number
  currentGeneration: boolean
}> | Readonly<{
  queueName: string
  kind: "subagent"
  jobId: string
  sessionId: string
  turnId: string
  taskId: string
  rootTaskId: string
  ownerId: string
  generation: number
  currentGeneration: boolean
}>
type ProcessFixtureChild = ChildProcess & {
  output: string[]
  errors: string[]
  fixtureMode?: string
  fixtureScopes?: readonly FixtureProcessScope[]
  terminationSignal?: NodeJS.Signals | null
  staleBullJobKeys?: Set<string>
}
type FixtureCleanupJob = {
  id: string | undefined
  name: string
  data: unknown
  getState(): Promise<string>
  remove(): Promise<unknown>
}
type FixtureCleanupQueue = {
  name: string
  toKey(jobId: string): string
  getJob(jobId: string): Promise<FixtureCleanupJob | undefined>
}
type FixtureRedisConnection = { del(key: string): Promise<unknown> }
const fixtureProcessChildren = new Set<ProcessFixtureChild>()
const FIXTURE_DISPATCH_GENERATION_LIMIT = 32

function fixtureJobIdentityKey(queueName: string, jobId: string): string {
  return `${queueName}\u0000${jobId}`
}

function parseFixtureQueueJobIdentity(value: unknown): FixtureQueueJobIdentity | null {
  const source = record(value)
  if (!source) return null
  const kind = source.kind
  const keys = Object.keys(source).sort().join(",")
  const expected = kind === "turn"
    ? "currentGeneration,generation,jobId,kind,ownerId,queueName,sessionId,turnId"
    : kind === "subagent"
      ? "currentGeneration,generation,jobId,kind,ownerId,queueName,rootTaskId,sessionId,taskId,turnId"
      : ""
  if (!expected || keys !== expected || typeof source.queueName !== "string" || !source.queueName.trim()
    || typeof source.jobId !== "string" || !source.jobId.trim()
    || typeof source.sessionId !== "string" || !source.sessionId.trim()
    || typeof source.turnId !== "string" || !source.turnId.trim()
    || typeof source.ownerId !== "string" || !source.ownerId.trim()
    || !Number.isSafeInteger(source.generation) || Number(source.generation) < 0
    || typeof source.currentGeneration !== "boolean") return null
  if (kind === "turn") {
    const generation = Number(source.generation)
    if (source.jobId !== turnJobId(source.turnId, generation)) return null
    return { queueName: source.queueName, kind, jobId: source.jobId, sessionId: source.sessionId,
      turnId: source.turnId, ownerId: source.ownerId, generation,
      currentGeneration: source.currentGeneration }
  }
  if (kind !== "subagent") return null
  if (typeof source.taskId !== "string" || !source.taskId.trim()
    || typeof source.rootTaskId !== "string" || !source.rootTaskId.trim()) return null
  const generation = Number(source.generation)
  if (source.jobId !== subagentDispatchJobId(source.taskId, generation)) return null
  return { queueName: source.queueName, kind, jobId: source.jobId, sessionId: source.sessionId,
    turnId: source.turnId, taskId: source.taskId, rootTaskId: source.rootTaskId, ownerId: source.ownerId,
    generation, currentGeneration: source.currentGeneration }
}

function fixtureJobPayloadMatches(identity: FixtureQueueJobIdentity, value: unknown): boolean {
  // Historical IDs are already bounded by the owned outbox generation; bind their parsed owner only to that exact key.
  if (identity.kind === "turn") {
    const payload = parseTurnJobPayload(value)
    return payload?.turnId === identity.turnId && payload.sessionId === identity.sessionId
      && (!identity.currentGeneration || payload.ownerId === identity.ownerId)
  }
  const payload = parseSubagentJobPayload(value)
  return payload?.taskId === identity.taskId && payload.sessionId === identity.sessionId
    && payload.rootTaskId === identity.rootTaskId && (!identity.currentGeneration || payload.ownerId === identity.ownerId)
}

async function removeExactFixtureQueueJob(
  rawIdentity: unknown,
  queue: FixtureCleanupQueue,
  redisConnection: FixtureRedisConnection,
  proof: Readonly<{ allWorkersExited: boolean; exactSigkillOwner: boolean }>,
): Promise<"absent" | "removed"> {
  const identity = parseFixtureQueueJobIdentity(rawIdentity)
  if (!identity || queue.name !== identity.queueName) throw new Error("Fixture queue job identity is unrecognized")
  if (!proof.allWorkersExited) throw new Error("Fixture queue workers are not proven exited")
  const job = await queue.getJob(identity.jobId)
  if (!job) return "absent"
  const expectedName = identity.kind === "turn" ? "turn" : "subagent"
  if (job.id !== identity.jobId || job.name !== expectedName || !fixtureJobPayloadMatches(identity, job.data)) {
    throw new Error("Fixture queue job does not match its owner-fenced identity")
  }
  const state = await job.getState()
  const removableStates = new Set(["completed", "failed", "waiting", "delayed", "paused", "waiting-children", "active", "prioritized"])
  if (!removableStates.has(state)) throw new Error("Fixture queue job state is unrecognized")
  if (state === "active") {
    if (identity.kind !== "turn" || !proof.exactSigkillOwner) {
      throw new Error("Active fixture job has no exact exited SIGKILL owner proof")
    }
    await redisConnection.del(queue.toKey(identity.jobId) + ":lock")
  }
  await job.remove()
  return "removed"
}

function fixtureOwnerRowsMayBeDeleted(identitiesLoaded: boolean, failuresBeforeQueueCleanup: number, failuresAfterQueueCleanup: number): boolean {
  return identitiesLoaded && failuresBeforeQueueCleanup === failuresAfterQueueCleanup
}

function fixtureProcessScopes(value: Record<string, unknown>): FixtureProcessScope[] {
  const scopes: FixtureProcessScope[] = []
  if (typeof value.sessionId === "string" && value.sessionId.trim()
    && typeof value.turnId === "string" && value.turnId.trim()) {
    scopes.push({ sessionId: value.sessionId, turnId: value.turnId })
  }
  const selectedJob = record(value.selectedJob)
  if (typeof selectedJob?.sessionId === "string" && selectedJob.sessionId.trim()
    && typeof selectedJob.turnId === "string" && selectedJob.turnId.trim()
    && typeof selectedJob.queueName === "string" && selectedJob.queueName.trim()) {
    scopes.push({ sessionId: selectedJob.sessionId, turnId: selectedJob.turnId, selectedQueueName: selectedJob.queueName })
  }
  return scopes
}

function processFixtureProvesExactSigkill(
  child: ProcessFixtureChild,
  identity: FixtureQueueJobIdentity,
): boolean {
  if (!processFixtureExited(child) || child.terminationSignal !== "SIGKILL" || child.signalCode !== "SIGKILL"
    || !child.fixtureScopes?.some(scope => scope.sessionId === identity.sessionId && scope.turnId === identity.turnId)) return false
  if (identity.kind === "turn") return child.staleBullJobKeys?.has(fixtureJobIdentityKey(identity.queueName, identity.jobId)) ?? false
  // A started-task marker lacks the Bull dispatch generation, so it cannot authorize lock removal.
  return false
}

function noteFixtureSigkillTurnJob(child: ProcessFixtureChild, queueName: string, jobId: string): void {
  child.terminationSignal = "SIGKILL"
  child.staleBullJobKeys ??= new Set()
  child.staleBullJobKeys.add(fixtureJobIdentityKey(queueName, jobId))
}

function fixtureDispatchGenerations(attemptValue: unknown, publishedAt: Date | string | null): Array<{ generation: number; currentGeneration: boolean }> {
  const attempts = Number(attemptValue)
  if (!Number.isSafeInteger(attempts) || attempts < 0 || attempts > FIXTURE_DISPATCH_GENERATION_LIMIT
    || (publishedAt !== null && attempts === 0)) throw new Error("Fixture dispatch generation is outside its cleanup bound")
  const current = publishedAt === null ? attempts : attempts - 1
  const generationCount = attempts + (publishedAt === null ? 1 : 0)
  return Array.from({ length: generationCount }, (_, generation) => ({ generation, currentGeneration: generation === current }))
}

function fixtureTurnDispatchPayloadForOwner(
  value: unknown,
  owner: Pick<Fixture, "sessionId" | "turnId">,
): ReturnType<typeof parseTurnJobPayload> {
  const payload = parseTurnJobPayload(value)
  return payload?.turnId === owner.turnId && payload.sessionId === owner.sessionId ? payload : null
}

async function readExactFixtureQueueJobs(
  pool: Pool,
  owners: readonly Fixture[],
  turnQueueName: string,
  childQueueName: string,
  selectedJobQueueName: string | undefined,
  selectedJobSessionId: string,
): Promise<FixtureQueueJobIdentity[]> {
  const identities: FixtureQueueJobIdentity[] = []
  for (const owner of owners) {
    const turnDispatches = await pool.query<{ payload: unknown; attemptCount: unknown; publishedAt: Date | string | null }>(
      `SELECT dispatch."payload", dispatch."attemptCount", dispatch."publishedAt"
       FROM "agent_turns" AS turn
       JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
       JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = turn."sessionId"
         AND dispatch."topic" = 'agent.turn.dispatch' AND dispatch."idempotencyKey" = 'turn-dispatch:' || turn."id"
       WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    if (turnDispatches.rows.length > 1) throw new Error("Fixture Turn has ambiguous dispatch rows")
    const turnDispatch = turnDispatches.rows[0]
    if (turnDispatch) {
      const payload = fixtureTurnDispatchPayloadForOwner(turnDispatch.payload, owner)
      if (!payload) {
        throw new Error("Fixture Turn dispatch does not match its owner row")
      }
      for (const { generation, currentGeneration } of fixtureDispatchGenerations(turnDispatch.attemptCount, turnDispatch.publishedAt)) {
        identities.push({ queueName: turnQueueName, kind: "turn", jobId: turnJobId(owner.turnId, generation),
          sessionId: owner.sessionId, turnId: owner.turnId, ownerId: payload.ownerId, generation, currentGeneration })
      }
    }

    const taskDispatches = await pool.query<{
      taskId: string; rootTaskId: string | null; turnId: string | null; sessionId: string
      payload: unknown; attemptCount: unknown; publishedAt: Date | string | null
    }>(
      `SELECT task."id" AS "taskId", task."rootTaskId", task."turnId", task."sessionId",
              dispatch."payload", dispatch."attemptCount", dispatch."publishedAt"
       FROM "sub_agent_tasks" AS task
       JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
       JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
         AND turn."userId" = session."userId" AND turn."rootTaskId" = task."rootTaskId"
       JOIN "sub_agent_tasks" AS root ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
         AND root."turnId" = turn."id" AND root."rootTaskId" = root."id"
       JOIN "agent_outbox" AS dispatch ON dispatch."aggregateId" = task."sessionId"
         AND dispatch."topic" = 'agent.subagent.dispatch' AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id"
       WHERE session."id" = $1 AND session."userId" = $2 AND turn."id" = $3 AND task."sessionId" = $1 AND task."turnId" = $3`,
      [owner.sessionId, owner.userId, owner.turnId],
    )
    for (const row of taskDispatches.rows) {
      if (typeof row.rootTaskId !== "string" || !row.rootTaskId || row.turnId !== owner.turnId || row.sessionId !== owner.sessionId) {
        throw new Error("Fixture subagent dispatch has incomplete owner lineage")
      }
      const payload = parseSubagentJobPayload(row.payload)
      if (!payload || payload.taskId !== row.taskId || payload.sessionId !== owner.sessionId || payload.rootTaskId !== row.rootTaskId) {
        throw new Error("Fixture subagent dispatch does not match its owner row")
      }
      const queueName = owner.sessionId === selectedJobSessionId && selectedJobQueueName
        ? selectedJobQueueName : childQueueName
      for (const { generation, currentGeneration } of fixtureDispatchGenerations(row.attemptCount, row.publishedAt)) {
        identities.push({ queueName, kind: "subagent", jobId: subagentDispatchJobId(row.taskId, generation),
          sessionId: owner.sessionId, turnId: owner.turnId, taskId: row.taskId, rootTaskId: row.rootTaskId,
          ownerId: payload.ownerId, generation, currentGeneration })
      }
    }
  }
  const unique = new Map<string, FixtureQueueJobIdentity>()
  for (const identity of identities) {
    const key = fixtureJobIdentityKey(identity.queueName, identity.jobId)
    const prior = unique.get(key)
    if (prior && JSON.stringify(prior) !== JSON.stringify(identity)) throw new Error("Fixture queue job identity is ambiguous")
    unique.set(key, identity)
  }
  return [...unique.values()]
}

const processRestartFixturePath = fileURLToPath(new URL("./task-graph-resume-process-restart.fixture.mjs", import.meta.url))
const processRestartWorkerCwd = fileURLToPath(new URL("../../../", import.meta.url))
const DISCOVERY_TURN_WORKER_MARKER = "P3_DISCOVERY_TURN_WORKER "
const DISCOVERY_TURN_WORKER_NAMES = new Set(["worker2", "worker3"])
const DISCOVERY_TURN_WORKER_EVENTS = new Set(["observer_attached", "active", "completed", "failed", "error", "stalled"])
const DISCOVERY_TURN_WORKER_ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "AbortError", "TimeoutError", "ConnectionError", "MaxRetriesPerRequestError", "ReplyError", "other"])
const DISCOVERY_TURN_WORKER_ERROR_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN", "ECONNABORTED", "NR_CLOSED", "other"])
const DISCOVERY_TURN_WORKER_KEYS = new Set([
  "worker", "event", "isRunning", "isPaused", "stalledInterval", "lockDuration", "concurrency",
  "activeRegistryCount", "generation", "errorName", "errorCode",
])

function boundedWorkerDiagnosticNumber(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value : null
}

function processDiscoveryTurnWorkerDiagnostics(
  workerTwo: ProcessFixtureChild | null | undefined,
  workerThree: ProcessFixtureChild | null | undefined,
): RecordValue[] {
  const projected: RecordValue[] = []
  for (const [child, expectedWorker] of [[workerTwo, "worker2"], [workerThree, "worker3"]] as const) {
    if (!child) continue
    let childCount = 0
    for (const line of child.output) {
      if (!line.startsWith(DISCOVERY_TURN_WORKER_MARKER)) continue
      if (childCount >= 16 || projected.length >= 32) break
      try {
        const source = record(JSON.parse(line.slice(DISCOVERY_TURN_WORKER_MARKER.length)) as unknown)
        if (!source || Object.keys(source).length !== DISCOVERY_TURN_WORKER_KEYS.size
          || Object.keys(source).some(key => !DISCOVERY_TURN_WORKER_KEYS.has(key))) continue
        const worker = diagnosticEnum(source.worker, DISCOVERY_TURN_WORKER_NAMES)
        const event = diagnosticEnum(source.event, DISCOVERY_TURN_WORKER_EVENTS)
        if (worker !== expectedWorker || !event) continue
        const errorName = source.errorName === null ? null : diagnosticEnum(source.errorName, DISCOVERY_TURN_WORKER_ERROR_NAMES)
        const errorCode = source.errorCode === null ? null : diagnosticEnum(source.errorCode, DISCOVERY_TURN_WORKER_ERROR_CODES)
        if (event === "error" ? !errorName || !errorCode : errorName !== null || errorCode !== null) continue
        const nullableBoolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null
        projected.push({
          worker,
          event,
          isRunning: nullableBoolean(source.isRunning),
          isPaused: nullableBoolean(source.isPaused),
          stalledInterval: boundedWorkerDiagnosticNumber(source.stalledInterval, 1, 300_000),
          lockDuration: boundedWorkerDiagnosticNumber(source.lockDuration, 1, 300_000),
          concurrency: boundedWorkerDiagnosticNumber(source.concurrency, 1, 64),
          activeRegistryCount: boundedWorkerDiagnosticNumber(source.activeRegistryCount, 0, 64),
          generation: boundedWorkerDiagnosticNumber(source.generation, 0, 100_000),
          errorName,
          errorCode,
        })
        childCount += 1
      } catch {
        // Malformed fixture diagnostics are omitted and cannot affect the test flow.
      }
    }
  }
  return projected
}

function startTaskGraphRestartWorker(
  mode: "park-parent" | "resume-parent" | "park-discovery" | "resume-discovery" | "crash-archived-wait" | "resume-archived-wait" | "worker2-input-guard-self-test",
  value: Record<string, unknown>,
  envOverrides: Record<string, string> = {},
): ProcessFixtureChild {
  const child = spawn(process.execPath, ["--import", "tsx", processRestartFixturePath, mode, JSON.stringify(value)], {
    cwd: processRestartWorkerCwd,
    env: {
      ...process.env,
      ...(redisUrl ? { REDIS_URL: redisUrl } : {}),
      ...(databaseUrl ? { AGENT_RUNTIME_PG_TEST_URL: databaseUrl } : {}),
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ProcessFixtureChild
  child.output = []
  child.errors = []
  child.fixtureMode = mode
  child.fixtureScopes = fixtureProcessScopes(value)
  child.terminationSignal = null
  child.staleBullJobKeys = new Set()
  fixtureProcessChildren.add(child)
  let stdout = ""
  let stderr = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk
    const lines = stdout.split("\n")
    stdout = lines.pop() ?? ""
    child.output.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
    const lines = stderr.split("\n")
    stderr = lines.pop() ?? ""
    child.errors.push(...lines.map(line => line.trim()).filter(Boolean))
  })
  return child
}

function processFixtureDiagnosticProjection(value: unknown): RecordValue | null {
  const source = record(value)
  if (!source) return null

  const projected: RecordValue = {}
  const projectEnum = (key: string, allowed: ReadonlySet<string>) => {
    const safeValue = diagnosticEnum(source[key], allowed)
    if (safeValue !== null) projected[key] = safeValue
  }
  const projectCount = (key: string) => {
    const safeValue = diagnosticBoundedCount(source[key])
    if (safeValue !== null) projected[key] = safeValue
  }
  const projectCountRecord = (key: string, fields: readonly string[]) => {
    const input = record(source[key])
    if (!input) return
    const counts: RecordValue = {}
    for (const field of fields) {
      const safeValue = diagnosticBoundedCount(input[field])
      if (safeValue !== null) counts[field] = safeValue
    }
    if (Object.keys(counts).length > 0) projected[key] = counts
  }
  const projectNodeKeys = (key: string, fields: readonly string[]) => {
    const input = record(source[key])
    if (!input) return
    const nodeKeys: RecordValue = {}
    for (const field of fields) {
      const safeValues = diagnosticEnumList(input[field], TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
      if (safeValues.length > 0) nodeKeys[field] = safeValues
    }
    if (Object.keys(nodeKeys).length > 0) projected[key] = nodeKeys
  }

  projectEnum("turnStatus", PROCESS_FIXTURE_TURN_STATUSES)
  projectEnum("rootTaskStatus", PROCESS_FIXTURE_TASK_STATUSES)
  projectEnum("latestModelStepStatus", PROCESS_FIXTURE_STEP_STATUSES)
  projectEnum("latestModelStepErrorClass", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("planFailureCategory", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("turnErrorCategory", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("waitToolCallStatus", PROCESS_FIXTURE_TOOL_STATUSES)
  projectEnum("waitToolCallLifecycleStatus", PROCESS_FIXTURE_TOOL_STATUSES)
  if (typeof source.planAccepted === "boolean") projected.planAccepted = source.planAccepted
  projectEnum("waitToolResultLifecycleStatus", PROCESS_FIXTURE_TOOL_STATUSES)
  projectEnum("waitToolOutputStatus", PROCESS_FIXTURE_WAIT_OUTPUT_STATUSES)
  projectEnum("waitFailureCategory", PROCESS_FIXTURE_FAILURE_CATEGORIES)
  projectEnum("likelyCause", PROCESS_FIXTURE_CAUSES)

  projectCount("graphNodeCount")
  const initialWaitLineage = record(source.initialWaitLineage)
  if (initialWaitLineage) {
    const lineage: RecordValue = {}
    for (const key of [
      "proposalEventFound", "requestResultTaskIdentityMapMatchesEventReceipt",
      "eventReceiptTaskIdentityMapMatchesEmbeddedContent",
      "embeddedContentTaskIdentityMapMatchesCurrentPersistedItem",
      "embeddedContentTaskIdentityMapMatchesPayloadContent",
      "proposalEventRevisionMatchesReceipt", "proposalEventRevisionMatchesEmbeddedItem",
      "proposalEventRevisionMatchesCurrentPersistedItemRow",
    ]) {
      const value = initialWaitLineage[key]
      if (typeof value === "boolean" || value === null) lineage[key] = value
    }
    for (const key of [
      "eventReceiptEmbeddedTaskIdentityMapMismatchKeys", "embeddedCurrentPersistedTaskIdentityMapMismatchKeys",
      "embeddedPayloadTaskIdentityMapMismatchKeys",
    ]) {
      const safeValues = diagnosticEnumList(initialWaitLineage[key], TASK_GRAPH_DIAGNOSTIC_PROPOSAL_NODE_KEYS)
      if (safeValues.length > 0) lineage[key] = safeValues
    }
    for (const key of [
      "proposalReceiptFound", "requestMatchesReceipt", "requestMatchesCurrentGraph",
      "proposalMatchesGraph", "proposalRevisionMatchesGraph", "persistedItemReadSucceeded",
      "persistedItemFound", "persistedItemValid", "proposalMatchesPersistedItem", "persistedItemMatchesGraph",
      "planToolPairMatches", "planExpectedRevisionMatches",
    ]) {
      if (typeof initialWaitLineage[key] === "boolean") lineage[key] = initialWaitLineage[key]
    }
    const safeNodeKeys = diagnosticEnumList(initialWaitLineage.graphNodeKeysMissingReceipt, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
    if (safeNodeKeys.length > 0) lineage.graphNodeKeysMissingReceipt = safeNodeKeys
    for (const key of ["receiptPersistedMismatchKeys", "persistedGraphMismatchKeys"]) {
      const safeValues = diagnosticEnumList(initialWaitLineage[key], TASK_GRAPH_DIAGNOSTIC_NODE_KEYS)
      if (safeValues.length > 0) lineage[key] = safeValues
    }
    for (const key of [
      "proposalNodeCount", "graphNodeCount", "receiptRevision", "graphRevision",
      "persistedItemNodeCount", "persistedItemRevision",
      "requestedIdsOutsideReceiptCount", "requestedIdsOutsideGraphCount",
      "planToolUseCount", "planToolResultCount", "planExpectedRevision",
    ]) {
      const safeValue = diagnosticBoundedCount(initialWaitLineage[key])
      if (safeValue !== null) lineage[key] = safeValue
    }
    const proposalEventRevision = initialWaitLineage.proposalEventRevision
    if (proposalEventRevision === null) {
      lineage.proposalEventRevision = null
    } else {
      const safeRevision = diagnosticBoundedCount(proposalEventRevision)
      if (safeRevision !== null) lineage.proposalEventRevision = safeRevision
    }
    if (Object.keys(lineage).length > 0) projected.initialWaitLineage = lineage
  }
  projectCountRecord("waits", ["count", "rootCount", "suspendedRootCount"])
  projectCountRecord("targetCounts", ["requested", "graphMatches", "taskRows", "graphRows"])
  projectNodeKeys("missingKeys", ["requestedGraph", "graphTasks"])

  const childStatusCounts = diagnosticStatusCounts(source.childStatusCounts)
  if (Object.keys(childStatusCounts).length > 0) projected.childStatusCounts = childStatusCounts
  return projected
}

function archivedWaitProgressProjection(value: unknown): RecordValue | null {
  const source = record(value)
  if (!source) return null
  const progress = source.progress
  return {
    phase: diagnosticEnum(source.phase, ARCHIVED_WAIT_PROGRESS_PHASES) ?? "other",
    progress: typeof progress === "number" && Number.isSafeInteger(progress) && progress >= 0 && progress <= 7
      ? progress : null,
    errorKind: diagnosticEnum(source.errorKind, ARCHIVED_WAIT_PROGRESS_ERROR_KINDS) ?? "other",
  }
}

function processFixtureDiagnostics(child: ProcessFixtureChild): string {
  const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
  let archivedWaitProgress: RecordValue | null = null
  for (const line of child.output) {
    if (!line.startsWith(ARCHIVED_WAIT_PROGRESS_PREFIX)) continue
    try {
      archivedWaitProgress = archivedWaitProgressProjection(
        JSON.parse(line.slice(ARCHIVED_WAIT_PROGRESS_PREFIX.length)) as unknown,
      ) ?? archivedWaitProgress
    } catch {
      // Ignore malformed progress markers and keep the latest valid bounded marker.
    }
  }
  const processState = "pid=" + (Number.isSafeInteger(child.pid) ? child.pid : "unavailable")
    + " exitCode=" + (child.exitCode === null ? "null"
      : typeof child.exitCode === "number" && Number.isInteger(child.exitCode) ? child.exitCode : "unavailable")
    + " signal=" + (child.signalCode === null ? "none" : "received")
    + " stdoutLineCount=" + child.output.length + " stderrLineCount=" + child.errors.length
  let safeLine: string | null = null
  for (const line of child.output) {
    if (!line.startsWith(prefix)) continue
    try {
      const projected = processFixtureDiagnosticProjection(JSON.parse(line.slice(prefix.length)) as unknown)
      if (projected) {
        safeLine = prefix + JSON.stringify(projected)
        break
      }
    } catch {
      // Ignore malformed fixture diagnostics and keep looking for a valid line.
    }
  }
  const progressLine = archivedWaitProgress ? " archivedWaitProgress=" + JSON.stringify(archivedWaitProgress) : ""
  const diagnostic = processState + progressLine + (safeLine ? " " + safeLine : " fixtureDiagnostics=unavailable")
  return boundedDiagnostic(diagnostic, 1_600)
}

function jsonObjectEnd(source: string, start: number): number | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === "{") depth += 1
    else if (character === "}") {
      depth -= 1
      if (depth === 0) return index + 1
    }
  }
  return null
}

function safeRestoredSourceProjectionEnum(value: unknown, allowed: ReadonlySet<string>): string {
  if (value === null || value === undefined) return "missing"
  return typeof value === "string" && allowed.has(value) ? value : "other"
}

function safeRestoredSourceProjectionCount(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, RESTORED_SOURCE_PROJECTION_DIAGNOSTIC_COUNT_LIMIT)
    : null
}

function restoredSourceProjectionFailureSafeValue(parentModelFailure: string | null): string {
  const marker = "p3_restored_graph_source_projection_missing:"
  const markerIndex = parentModelFailure?.indexOf(marker) ?? -1
  if (markerIndex < 0 || !parentModelFailure) return "unavailable"
  const jsonStart = markerIndex + marker.length
  if (parentModelFailure[jsonStart] !== "{") return "unavailable"
  const jsonEnd = jsonObjectEnd(parentModelFailure, jsonStart)
  if (jsonEnd === null) return "unavailable"

  let parsed: unknown
  try { parsed = JSON.parse(parentModelFailure.slice(jsonStart, jsonEnd)) as unknown } catch { return "unavailable" }
  const source = record(parsed)
  if (!source) return "unavailable"

  const projection: RecordValue = {
    category: safeRestoredSourceProjectionEnum(source.category, RESTORED_SOURCE_PROJECTION_CATEGORIES),
  }
  const enumFields: ReadonlyArray<readonly [string, ReadonlySet<string>]> = [
    ["shape", RESTORED_SOURCE_PROJECTION_SHAPES],
    ["schema", RESTORED_SOURCE_PROJECTION_SCHEMAS],
    ["availability", RESTORED_SOURCE_PROJECTION_AVAILABILITIES],
    ["role", RESTORED_SOURCE_PROJECTION_ROLES],
    ["status", RESTORED_SOURCE_PROJECTION_STATUSES],
    ["invalidField", RESTORED_SOURCE_PROJECTION_INVALID_FIELDS],
    ["candidateIdentity", RESTORED_SOURCE_PROJECTION_IDENTITIES],
  ]
  for (const [field, allowed] of enumFields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      projection[field] = safeRestoredSourceProjectionEnum(source[field], allowed)
    }
  }
  for (const field of ["candidateCount", "evidenceCount", "candidateArrayCount"]) {
    if (Object.prototype.hasOwnProperty.call(source, field)) {
      projection[field] = safeRestoredSourceProjectionCount(source[field])
    }
  }
  return boundedDiagnostic(JSON.stringify(projection), 500)
}

function parentModelFailureDiagnosticFields(parentModelFailure: string | null, failureCategory = "none"): FailureDiagnosticField[] {
  const value = parentModelFailure ?? "<not captured>"
  return [
    { label: "parentModelFailure", value },
    {
      label: "parentModelFailureCategory",
      value: failureCategory,
      safeValue: diagnosticEnum(failureCategory, PROCESS_FIXTURE_FAILURE_CATEGORIES) ?? "other",
    },
    {
      label: "restoredSourceProjection",
      value,
      safeValue: restoredSourceProjectionFailureSafeValue(parentModelFailure),
    },
  ]
}

async function waitForProcessLine(child: ProcessFixtureChild, prefix: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = child.output.find(value => value.startsWith(prefix))
    if (line) return line
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Worker exited before " + prefix + "; " + processFixtureDiagnostics(child))
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("Timed out waiting for " + prefix + "; " + processFixtureDiagnostics(child))
}

function waitForProcessExit(child: ProcessFixtureChild, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined
    const cleanup = () => {
      if (timer) clearTimeout(timer)
      child.off("exit", onExit)
      child.off("error", onError)
    }
    const onExit = () => { cleanup(); resolve() }
    const onError = (error: Error) => { cleanup(); reject(error) }
    child.once("exit", onExit)
    child.once("error", onError)
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup()
      resolve()
      return
    }
    timer = setTimeout(() => {
      cleanup()
      reject(new Error("Worker process did not exit; " + processFixtureDiagnostics(child)))
    }, timeoutMs)
  })
}

function processFixtureExited(child: ProcessFixtureChild): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

async function killProcessFixture(child: ProcessFixtureChild, signal: NodeJS.Signals = "SIGKILL"): Promise<void> {
  if (processFixtureExited(child)) return
  child.terminationSignal = signal
  const exited = waitForProcessExit(child)
  if (!child.kill(signal)) throw new Error("Worker process kill was rejected; " + processFixtureDiagnostics(child))
  await exited
}

async function stopProcessFixture(child: ProcessFixtureChild): Promise<void> {
  if (processFixtureExited(child)) {
    if (child.exitCode !== 0 || child.signalCode !== null) {
      throw new Error("Worker exited unsuccessfully during cleanup; " + processFixtureDiagnostics(child))
    }
    return
  }
  const exited = waitForProcessExit(child, 5_000)
  child.stdin?.write("shutdown\n")
  try {
    await exited
  } catch (gracefulError) {
    try {
      await killProcessFixture(child)
    } catch (forcedError) {
      throw new Error("Worker cleanup failed; graceful=" + String(gracefulError) + "; forced=" + String(forcedError))
    }
    throw new Error("Worker required forced termination during cleanup; graceful=" + String(gracefulError)
      + "; " + processFixtureDiagnostics(child))
  }
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error("Worker exited unsuccessfully during cleanup; " + processFixtureDiagnostics(child))
  }
}

function structuredChildResult(role: "scout" | "analyst", summary: string): RecordValue {
  const jobId = "fixture-job-1"
  const evidence = [{ id: "fixture-job-evidence", kind: "job", ref: jobId, source: "fixture" }]
  const structuredResult = role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [{ jobId, source: "fixture", url: null, evidenceIds: ["fixture-job-evidence"] }], evidence, summary }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [{ jobId, score: 8, evidenceIds: ["fixture-job-evidence"] }], evidence, summary }
  return { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "fixture-final-item", finalText: summary, structuredResult }
}

async function persistTaskGraphChildReadEvidence(pool: Pool, lease: SubagentLease): Promise<void> {
  if (!lease.turnId || lease.parentTaskId !== lease.rootTaskId) {
    throw new Error("TaskGraph child evidence fixture is missing its parent/root scope")
  }
  const owner = executionOwnerFence({ kind: "task", lease })
  const store = createPgTurnEngineStore(pool)
  const now = new Date()
  const callId = `${RESULT_PREFIX}:${lease.id}:attempt:${lease.attemptCount}`
  const stepId = `${callId}:step`
  const toolCallItemId = `${callId}:tool-call`
  const toolResultItemId = `${callId}:tool-result`
  const input = { target: "fixture", location: "Dublin", limit: 1 }
  const output = { jobs: [{ id: "fixture-job-1", source: "fixture" }] }
  const step = await store.startStep({
    owner, stepId, ordinal: 0, attempt: lease.attemptCount, inputThroughSequence: 0n,
    consumedInputIds: [], modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, now,
  })
  const callItem = await store.createItem({
    owner, itemId: toolCallItemId, stepId: step.id, type: "tool_call", status: "started", phase: null,
    content: { toolCallId: callId, toolName: "jobs.search", toolVersion: "1", input }, now,
  })
  let causationId: string | null = null
  const appendEvent = async (type: string, correlationId: string, itemId: string, payload: RepositoryJsonValue, key: string) => {
    const event = await store.appendEvent({
      owner, id: randomUUID(), itemId, type, correlationId, causationId,
      idempotencyKey: `task:${lease.id}:event:${callId}:${key}`, payload,
    })
    causationId = event.id
  }
  await appendEvent("item.started", step.id, callItem.id, { itemId: callItem.id, type: "tool_call", phase: null }, "call-item-started")
  await appendEvent("tool_call.started", callId, callItem.id, { toolCallId: callId, toolName: "jobs.search", taskId: lease.id }, "tool-started")
  const completedCall = await store.updateItem({
    owner, itemId: callItem.id, expectedRevision: callItem.revision, status: "completed", phase: null,
    content: { toolCallId: callId, toolName: "jobs.search", toolVersion: "1", status: "completed", errorCode: null, input },
    startedAt: now, completedAt: now, now,
  })
  await appendEvent("item.completed", callItem.id, callItem.id, {
    itemId: callItem.id, status: "completed",
    content: { toolCallId: callId, toolName: "jobs.search", toolVersion: "1", status: "completed", errorCode: null, input },
  }, "call-item-completed")
  await appendEvent("tool_call.completed", callId, callItem.id, {
    toolCallId: callId, toolName: "jobs.search", status: "completed", errorCode: null, taskId: lease.id,
  }, "tool-completed")
  const resultItem = await store.createItem({
    owner, itemId: toolResultItemId, stepId: step.id, type: "tool_result", status: "started", phase: null,
    content: { toolCallId: callId, output, errorCode: null }, now,
  })
  await appendEvent("item.started", step.id, resultItem.id, { itemId: resultItem.id, type: "tool_result", phase: null }, "result-item-started")
  await store.updateItem({
    owner, itemId: resultItem.id, expectedRevision: resultItem.revision, status: "completed", phase: null,
    content: { toolCallId: callId, output, errorCode: null }, startedAt: now, completedAt: now, now,
  })
  await appendEvent("item.completed", resultItem.id, resultItem.id, {
    itemId: resultItem.id, status: "completed", content: { toolCallId: callId, output, errorCode: null },
  }, "result-item-completed")
  await store.updateStep({
    owner, stepId: step.id, status: "completed", finishReason: "tool_calls", errorCode: null,
    inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, now,
  })
  if (completedCall.revision !== callItem.revision + 1) throw new Error("TaskGraph evidence fixture call item did not advance")
}

async function waitForSuspendedParent(pool: Pool, turnId: string, minimumWaitCount = 1, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ turnStatus: string; waitStatus: string | null; suspendedAt: Date | null; waitCount: string }>(
      `SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", wait."suspendedAt",
         (SELECT COUNT(*)::text FROM "agent_wait_conditions" AS all_waits
          WHERE all_waits."turnId" = turn."id" AND all_waits."parentTaskId" = turn."rootTaskId") AS "waitCount"
       FROM "agent_turns" AS turn LEFT JOIN "agent_wait_conditions" AS wait
         ON wait."turnId" = turn."id" AND wait."parentTaskId" = turn."rootTaskId"
       WHERE turn."id" = $1 ORDER BY wait."createdAt" DESC LIMIT 1`,
      [turnId],
    )
    const row = result.rows[0]
    if (row?.turnStatus === "waiting_for_dependency" && row.waitStatus === "waiting" && row.suspendedAt
      && Number(row.waitCount) >= minimumWaitCount) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("TaskGraph parent wait was not durably suspended before child completion")
}

async function initialWaitLineageDiagnostics(
  pool: Pool,
  turn: { id: string; sessionId: string; userId: string; rootTaskId: string | null },
  toolCallId: string | undefined,
): Promise<RecordValue | null> {
  if (!toolCallId) return null
  try {
    const [toolItemResult, graphResult] = await Promise.all([
      pool.query<{ sessionId: string; turnId: string; taskId: string | null; content: unknown }>(`SELECT "sessionId", "turnId", "taskId", "content"
        FROM "agent_items" WHERE "type" = 'tool_call' AND "content"->>'toolCallId' = $1
          AND "content"->>'toolName' = 'agent.wait'
          AND ("sessionId" = $2 OR "turnId" = $3 OR "taskId" = $4)
        ORDER BY "createdAt" DESC LIMIT 1`, [toolCallId, turn.sessionId, turn.id, turn.rootTaskId]),
      turn.rootTaskId
        ? pool.query<{ id: string; content: unknown }>(`SELECT "id", "content" FROM "agent_items"
            WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'
            ORDER BY "revision" DESC, "updatedAt" DESC LIMIT 1`, [turn.sessionId, turn.id, turn.rootTaskId])
        : Promise.resolve(null),
    ])
    const toolItem = toolItemResult.rows[0]
    const toolContent = record(toolItem?.content)
    const waitInput = record(toolContent?.input)
    const requestedIds = diagnosticIdList(waitInput?.taskIds)
    const graphContent = record(graphResult?.rows[0]?.content)
    const graphNodes = Array.isArray(graphContent?.nodes) ? graphContent.nodes : null
    const graphIds = diagnosticIdList(graphNodes?.map(node => record(node)?.taskId))
    const taskIdsMatchCurrentGraph = diagnosticIdListsMatch(requestedIds, graphIds)
    const proposalResult = graphResult?.rows[0]?.id
      ? await pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3
            AND "type" IN ('item.started', 'item.delta') AND "payload"->>'kind' = 'proposal'
          ORDER BY "sequence" DESC LIMIT 40`, [turn.sessionId, turn.id, graphResult.rows[0].id])
      : null
    const proposalPayloads = proposalResult?.rows.map(row => row.payload) ?? []
    const proposalCandidate = proposalReceiptForWait(requestedIds, proposalPayloads)
    const failureReceipt = {
      ...failedWaitReceiptProjection(requestedIds, proposalPayloads),
      proposalReceiptHistoryMayBeTruncated: proposalPayloads.length === 40,
    }
    const rawProposalNodes = proposalCandidate?.rawNodes ?? []
    const proposalNodes = proposalCandidate?.nodes ?? []
    const proposalTaskIds = proposalCandidate?.taskIds ?? diagnosticIdList(null)
    const proposalReceiptFound = proposalCandidate !== null
    const requestMatchesReceipt = proposalReceiptFound
      ? diagnosticIdListsMatch(requestedIds, proposalTaskIds)
      : null
    const requestedTaskIdsPresentInCurrentGraph = diagnosticIdListContainsAll(requestedIds, graphIds)

    const expectedParentId = toolItem?.taskId ?? turn.rootTaskId
    const parentResult = typeof expectedParentId === "string"
      ? await pool.query<{
        id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
        userId: string | null
      }>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
          FROM "sub_agent_tasks" AS task LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = $1 LIMIT 1`, [expectedParentId])
      : null
    const parent = parentResult?.rows[0]
    const parentIdMismatchCount = parent ? Number(typeof turn.rootTaskId !== "string" || parent.id !== turn.rootTaskId) : null
    const parentSessionMismatchCount = parent ? Number(parent.sessionId !== turn.sessionId) : null
    const parentTurnMismatchCount = parent ? Number(parent.turnId !== turn.id) : null
    const parentRootMismatchCount = parent
      ? Number(typeof turn.rootTaskId !== "string" || parent.rootTaskId !== turn.rootTaskId)
      : null
    const parentLineageMismatchCount = parent ? Number(parent.parentTaskId !== null) : null
    const parentUserMismatchCount = parent ? Number(parent.userId !== turn.userId) : null
    const idsToCheck = [...new Set([
      ...(requestedIds.valid ? requestedIds.values : []),
      ...(graphIds.valid ? graphIds.values : []),
    ])]
    const targetResult = idsToCheck.length > 0
      ? await pool.query<{
        id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
        userId: string | null
      }>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", session."userId" AS "userId"
          FROM "sub_agent_tasks" AS task LEFT JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE task."id" = ANY($1::text[])`, [idsToCheck])
      : null
    const targets = targetResult?.rows ?? []
    const requestedIdSet = new Set(requestedIds.values)
    const foundTargetIdSet = new Set(targets.map(target => target.id))
    const fixtureNodeKeysMissingRows = requestedIds.valid
      ? [...new Set(proposalNodes.flatMap(node =>
        typeof node.key === "string" && TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(node.key)
          && typeof node.taskId === "string" && requestedIdSet.has(node.taskId) && !foundTargetIdSet.has(node.taskId)
          ? [node.key]
          : []
      ))].slice(0, 8)
      : []
    const graphNodeKeysMissingRows = graphIds.valid && Array.isArray(graphNodes)
      ? [...new Set(graphNodes.flatMap(value => {
        const node = record(value)
        return node && typeof node.key === "string" && TASK_GRAPH_DIAGNOSTIC_NODE_KEYS.has(node.key)
          && typeof node.taskId === "string" && !foundTargetIdSet.has(node.taskId)
          ? [node.key]
          : []
      }))].slice(0, 8)
      : []
    const requestedTargets = targets.filter(target => requestedIdSet.has(target.id))
    const requestedFoundCount = requestedIds.valid
      ? requestedIds.values.filter(id => foundTargetIdSet.has(id)).length
      : null
    const userMismatchCount = targetResult
      ? requestedTargets.filter(target => target.userId !== turn.userId).length
      : null
    const parentMismatchCount = targetResult
      ? requestedTargets.filter(target => typeof expectedParentId !== "string" || target.parentTaskId !== expectedParentId).length
      : null
    const sessionMismatchCount = targetResult
      ? requestedTargets.filter(target => target.sessionId !== turn.sessionId).length
      : null
    const turnMismatchCount = targetResult
      ? requestedTargets.filter(target => target.turnId !== turn.id).length
      : null
    const rootMismatchCount = targetResult
      ? requestedTargets.filter(target => typeof turn.rootTaskId !== "string" || target.rootTaskId !== turn.rootTaskId).length
      : null
    const missingCount = requestedFoundCount === null ? null : Math.max(0, requestedIds.values.length - requestedFoundCount)
    const allTargetsFound = requestedFoundCount !== null && requestedFoundCount === requestedIds.values.length
    const allTargetsInExpectedScope = requestedIds.values.length > 0 && allTargetsFound
      && userMismatchCount === 0 && sessionMismatchCount === 0 && turnMismatchCount === 0
      && rootMismatchCount === 0 && parentMismatchCount === 0

    return {
      available: true,
      taskIdsMatchCurrentGraph,
      requestedTaskIdsPresentInCurrentGraph,
      proposalReceiptFound,
      ...failureReceipt,
      proposalNodeCount: rawProposalNodes.length,
      requestMatchesReceipt,
      requestMatchesCurrentGraph: taskIdsMatchCurrentGraph,
      requestedTaskCount: requestedIds.count,
      graphNodeCount: graphIds.count,
      fixtureNodeKeysMissingRows,
      graphNodeKeysMissingRows,
      waitItemFound: Boolean(toolItem),
      waitItemMatchesRoot: Boolean(toolItem && turn.rootTaskId
        && toolItem.sessionId === turn.sessionId && toolItem.turnId === turn.id && toolItem.taskId === turn.rootTaskId),
      parentTaskFound: Boolean(parent),
      parentIdIsTurnRoot: Boolean(parent && turn.rootTaskId && parent.id === turn.rootTaskId),
      parentSameSession: Boolean(parent && parent.sessionId === turn.sessionId),
      parentSameTurn: Boolean(parent && parent.turnId === turn.id),
      parentRootIsTurnRoot: Boolean(parent && turn.rootTaskId && parent.rootTaskId === turn.rootTaskId),
      parentHasNoParent: Boolean(parent && parent.parentTaskId === null),
      parentMismatchCounts: {
        id: parentIdMismatchCount,
        session: parentSessionMismatchCount,
        turn: parentTurnMismatchCount,
        root: parentRootMismatchCount,
        parent: parentLineageMismatchCount,
        user: parentUserMismatchCount,
      },
      parentTaskMatchesUser: Boolean(parent && parent.userId === turn.userId),
      parentUserMismatchCount,
      targetRows: {
        requestedCount: requestedIds.count,
        foundCount: requestedFoundCount,
        allInExpectedScope: allTargetsInExpectedScope,
        allSameUser: Boolean(allTargetsFound && userMismatchCount === 0),
        allSameSession: Boolean(allTargetsFound && sessionMismatchCount === 0),
        allSameTurn: Boolean(allTargetsFound && turnMismatchCount === 0),
        allSameRoot: Boolean(allTargetsFound && rootMismatchCount === 0),
        allSameParent: Boolean(allTargetsFound && parentMismatchCount === 0),
        mismatchCounts: {
          missing: missingCount,
          user: userMismatchCount,
          session: sessionMismatchCount,
          turn: turnMismatchCount,
          root: rootMismatchCount,
          parent: parentMismatchCount,
        },
      },
    }
  } catch {
    return { available: false }
  }
}

async function turnProgressDiagnostics(
  pool: Pool,
  turnId: string,
  diagnosticToolCallId?: string,
  additionalDiagnosticToolCallIds: readonly string[] = [],
): Promise<string> {
  const diagnosticToolCallIds = [...new Set([
    ...(diagnosticToolCallId ? [diagnosticToolCallId] : []), ...additionalDiagnosticToolCallIds,
  ])].slice(0, 6)
  const turnResult = await pool.query<{
    id: string
    sessionId: string
    userId: string
    status: string
    error: string | null
    rootTaskId: string | null
    revision: number
    leaseOwnerId: string | null
    leaseVersion: number
    leaseExpiresAt: Date | null
  }>(`SELECT "id", "sessionId", "userId", "status", "error", "rootTaskId", "revision", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
    FROM "agent_turns" WHERE "id" = $1`, [turnId])
  const turn = turnResult.rows[0]
  if (!turn) return JSON.stringify({ turnId, missing: true })

  const [toolResultItem, tasks, waits, events, dispatches, lifecycleFailures, rootSteps, rootFailureEvents, rootToolItems] = await Promise.all([
    diagnosticToolCallId
      ? pool.query<{ status: string; content: unknown }>(`SELECT "status", "content" FROM "agent_items"
        WHERE "turnId" = $1 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2
        ORDER BY "createdAt" DESC LIMIT 1`, [turnId, diagnosticToolCallId])
      : Promise.resolve(null),
    pool.query<{
      id: string; goal: string; status: string; failureReason: string | null; attemptCount: number
      leaseOwner: string | null; leaseExpiresAt: Date | null
    }>(`SELECT "id", "goal", "status", "failureReason", "attemptCount", "leaseOwner", "leaseExpiresAt"
      FROM "sub_agent_tasks" WHERE "turnId" = $1 ORDER BY "createdAt"`, [turnId]),
    pool.query<{
      id: string; idempotencyKey: string; status: string; targetTaskIds: unknown; matchedTaskIds: unknown
      deadlineAt: Date; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
    }>(`SELECT "id", "idempotencyKey", "status", "targetTaskIds", "matchedTaskIds", "deadlineAt", "suspendedAt", "resolvedAt", "consumedAt"
      FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt"`, [turnId]),
    pool.query<{
      sequence: string; type: string; actor: string; taskId: string | null; idempotencyKey: string | null
      diagnosticStatus: string | null; diagnosticErrorCode: string | null
    }>(`SELECT "sequence"::text, "type", "actor", "taskId", "idempotencyKey",
        "payload"->>'status' AS "diagnosticStatus", "payload"->>'errorCode' AS "diagnosticErrorCode"
      FROM "agent_events" WHERE "turnId" = $1 ORDER BY "sequence" DESC LIMIT 20`, [turnId]),
    pool.query<{
      topic: string; idempotencyKey: string; publishedAt: Date | null; attemptCount: number; lastError: string | null
    }>(`SELECT "topic", "idempotencyKey", "publishedAt", "attemptCount", "lastError"
      FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "createdAt" DESC LIMIT 30`, [turn.sessionId]),
    diagnosticToolCallIds.length > 0
      ? pool.query<{ type: string; toolName: string | null; status: string | null; errorCode: string | null }>(`SELECT "type",
          "payload"->>'toolName' AS "toolName", "payload"->>'status' AS "status", "payload"->>'errorCode' AS "errorCode"
        FROM "agent_events" WHERE "turnId" = $1 AND "type" = 'tool_call.failed' AND "payload"->>'toolCallId' = ANY($2::text[])
        ORDER BY "sequence" DESC LIMIT 4`, [turnId, diagnosticToolCallIds])
      : Promise.resolve(null),
    turn.rootTaskId
      ? pool.query<{ ordinal: number; status: string; errorCode: string | null }>(`SELECT "ordinal", "status", "errorCode"
          FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          ORDER BY "ordinal" ASC, "attempt" ASC LIMIT 16`, [turn.sessionId, turnId, turn.rootTaskId])
      : Promise.resolve({ rows: [] }),
    turn.rootTaskId
      ? pool.query<{ type: string; status: string | null; errorCode: string | null }>(`SELECT "type",
          "payload"->>'status' AS "status", COALESCE("payload"->>'errorCode', "payload"->>'code') AS "errorCode"
        FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
          AND ("taskId" = $3 OR "taskId" IS NULL)
          AND ("type" IN ('turn.failed', 'final.rejected', 'task.failed')
            OR ("type" = 'step.completed' AND "payload"->>'status' IN ('failed', 'interrupted')))
        ORDER BY "sequence" DESC LIMIT 8`, [turn.sessionId, turnId, turn.rootTaskId])
      : Promise.resolve({ rows: [] }),
    turn.rootTaskId && diagnosticToolCallIds.length > 0
      ? pool.query<{ type: string; status: string; content: unknown }>(`SELECT "type", "status", "content"
          FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
            AND "type" IN ('tool_call', 'tool_result') AND "content"->>'toolCallId' = ANY($4::text[])
          ORDER BY "createdAt" ASC LIMIT 12`, [turn.sessionId, turnId, turn.rootTaskId, diagnosticToolCallIds])
      : Promise.resolve({ rows: [] }),
  ])
  const resultItem = toolResultItem?.rows[0]
  const resultContent = record(resultItem?.content)
  const resultOutput = record(resultContent?.output)
  const resultReference = resultOutput?.$ref ?? resultOutput?.ref
  const resultTruncated = resultOutput?.$truncated ?? resultOutput?.truncated
  const resultTasks = Array.isArray(resultOutput?.tasks) ? resultOutput.tasks : null
  const waitToolResult = resultItem
    ? {
      status: resultItem.status.slice(0, 32),
      errorCode: typeof resultContent?.errorCode === "string" ? resultContent.errorCode.slice(0, 128) : null,
      outputStatus: typeof resultOutput?.status === "string" ? resultOutput.status.slice(0, 32) : null,
      waitId: typeof resultOutput?.waitId === "string" ? resultOutput.waitId.slice(0, 128) : null,
      deadlineAt: {
        present: Object.prototype.hasOwnProperty.call(resultOutput ?? {}, "deadlineAt"),
        type: diagnosticValueType(resultOutput?.deadlineAt),
      },
      matchedTaskIds: {
        type: diagnosticValueType(resultOutput?.matchedTaskIds),
        count: Array.isArray(resultOutput?.matchedTaskIds) ? resultOutput.matchedTaskIds.length : null,
      },
      reference: {
        present: resultReference !== undefined,
        type: diagnosticValueType(resultReference),
        sizeBytesType: diagnosticValueType(resultOutput?.sizeBytes),
        sha256Present: typeof resultOutput?.sha256 === "string",
      },
      truncated: {
        present: resultTruncated !== undefined,
        type: diagnosticValueType(resultTruncated),
        value: typeof resultTruncated === "boolean" ? resultTruncated : null,
        taskResultCount: resultTasks?.length ?? null,
        truncatedTaskResultCount: resultTasks?.filter(task => {
          const result = record(record(task)?.result)
          return result?.truncated === true || result?.$truncated === true
        }).length ?? null,
      },
    }
    : null
  const diagnosticToolFailures = lifecycleFailures?.rows.map(event => ({
    eventType: event.type,
    toolName: event.toolName,
    status: event.status,
    errorCode: event.errorCode,
  })) ?? []
  const executionFailures = events.rows.flatMap(event => {
    if (event.type !== "step.completed" && event.type !== "turn.failed") return []
    if (event.diagnosticStatus !== "failed" && event.type !== "turn.failed") return []
    return [{ eventType: event.type, status: event.diagnosticStatus, errorCode: event.diagnosticErrorCode }]
  })
  const waitLineage = await initialWaitLineageDiagnostics(pool, turn, diagnosticToolCallId)
  const recentEvents = events.rows.map(({ diagnosticStatus: _status, diagnosticErrorCode: _errorCode, ...event }) => event)
  const rootTask = tasks.rows.find(task => task.id === turn.rootTaskId)
  const diagnosticRootToolItems = rootToolItems.rows.flatMap(item => {
    const content = record(item.content)
    const callId = diagnosticFixtureCallId(content?.toolCallId)
    if (!callId) return []
    const input = record(content?.input)
    const output = record(content?.output)
    return [{
      callId,
      type: diagnosticEnum(item.type, TOOL_ITEM_TYPES),
      status: diagnosticEnum(item.status, ITEM_DIAGNOSTIC_STATUSES),
      toolName: diagnosticEnum(content?.toolName, TOOL_DIAGNOSTIC_NAMES)
        ?? (callId === DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID ? "agent.plan" : "agent.wait"),
      toolStatus: diagnosticEnum(content?.status, ITEM_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticErrorCode(content?.errorCode),
      errorClass: diagnosticErrorClass(content?.errorCode),
      inputTaskCount: diagnosticBoundedCount(Array.isArray(input?.taskIds) ? input.taskIds.length : null),
      inputNodeCount: diagnosticBoundedCount(Array.isArray(input?.nodes) ? input.nodes.length : null),
      outputStatus: diagnosticEnum(output?.status, TOOL_RESULT_DIAGNOSTIC_STATUSES),
      outputWaitIdPresent: typeof output?.waitId === "string",
      outputTaskCount: diagnosticBoundedCount(Array.isArray(output?.tasks) ? output.tasks.length : null),
      outputMatchedTaskCount: diagnosticBoundedCount(Array.isArray(output?.matchedTaskIds) ? output.matchedTaskIds.length : null),
      outputNodeCount: diagnosticBoundedCount(Array.isArray(output?.nodes) ? output.nodes.length : null),
      outputNodeTaskIdCount: diagnosticBoundedCount(Array.isArray(output?.nodes)
        ? output.nodes.filter(node => typeof record(node)?.taskId === "string").length : null),
    }]
  })
  return JSON.stringify({
    turn, waitToolResult, waitLineage, tasks: tasks.rows, waits: waits.rows, recentEvents,
    diagnosticToolFailures, executionFailures, recentOutbox: dispatches.rows,
    rootFailure: {
      taskFound: Boolean(rootTask),
      reasonPresent: typeof rootTask?.failureReason === "string",
      reasonCode: diagnosticErrorCode(rootTask?.failureReason),
      reasonClass: diagnosticErrorClass(rootTask?.failureReason),
      events: rootFailureEvents.rows.map(event => ({
        eventType: diagnosticEnum(event.type, ROOT_FAILURE_EVENT_TYPES),
        status: diagnosticEnum(event.status, new Set(["completed", "failed", "interrupted"])),
        errorCode: diagnosticErrorCode(event.errorCode),
        errorClass: diagnosticErrorClass(event.errorCode),
      })),
    },
    rootSteps: rootSteps.rows.map(step => ({
      ordinal: diagnosticBoundedCount(step.ordinal),
      status: diagnosticEnum(step.status, STEP_DIAGNOSTIC_STATUSES),
      errorCode: diagnosticErrorCode(step.errorCode),
      errorClass: diagnosticErrorClass(step.errorCode),
    })),
    rootToolItems: diagnosticRootToolItems,
  })
}

async function waitToolResultDiagnostic(pool: Pool, turnId: string, toolCallId: string): Promise<RecordValue> {
  const result = await pool.query<{ status: string; content: unknown }>(
    `SELECT "status", "content" FROM "agent_items"
     WHERE "turnId" = $1 AND "type" = 'tool_result' AND "content"->>'toolCallId' = $2
     ORDER BY "createdAt" DESC LIMIT 1`, [turnId, toolCallId],
  )
  const row = result.rows[0]
  const content = record(row?.content)
  const output = record(content?.output)
  const errorCode = content?.errorCode
  const outputStatus = output?.status
  return {
    resultPresent: Boolean(row),
    resultStatus: row ? diagnosticEnum(row.status, ITEM_DIAGNOSTIC_STATUSES) ?? "other" : "missing",
    errorCodePresent: typeof errorCode === "string",
    errorCode: typeof errorCode === "string" ? diagnosticErrorCode(errorCode) ?? "other" : "none",
    outputStatus: output
      ? typeof outputStatus === "string" ? diagnosticEnum(outputStatus, PROCESS_FIXTURE_WAIT_OUTPUT_STATUSES) ?? "other" : "none"
      : "missing",
    matchedTaskCount: Array.isArray(output?.matchedTaskIds)
      ? diagnosticBoundedCount(output.matchedTaskIds.length)
      : null,
    truncatedTaskResultCount: Array.isArray(output?.tasks)
      ? diagnosticBoundedCount(output.tasks.filter(value => {
        const taskResult = record(record(value)?.result)
        return taskResult?.truncated === true || taskResult?.$truncated === true
      }).length)
      : null,
  }
}

async function scopedWaitToolResultDiagnostic(pool: Pool, owner: Fixture, toolCallId: string): Promise<RecordValue> {
  const result = await pool.query<{
    itemStatus: string; outputStatus: string | null; targetCount: number | null; matchedCount: number | null;
    targetIdsRedacted: boolean | null; taskIdsRedacted: boolean | null; outputReferencePresent: boolean | null
  }>(
    `SELECT item."status" AS "itemStatus", item."content"->'output'->>'status' AS "outputStatus",
       CASE WHEN jsonb_typeof(item."content"->'output') = 'object'
         AND (item."content"->'output') ? '$ref' THEN true ELSE false END AS "outputReferencePresent",
       CASE WHEN jsonb_typeof(item."content"->'output'->'taskIds') = 'array'
         THEN jsonb_array_length(item."content"->'output'->'taskIds') ELSE NULL END AS "targetCount",
       CASE WHEN jsonb_typeof(item."content"->'output'->'matchedTaskIds') = 'array'
         THEN jsonb_array_length(item."content"->'output'->'matchedTaskIds') ELSE NULL END AS "matchedCount",
       CASE WHEN jsonb_typeof(item."content"->'output'->'taskIds') = 'array' THEN COALESCE((
         SELECT bool_or(position('[REDACTED]' in COALESCE(target.value #>> '{}', '')) > 0
           OR position('[REDACTED_PHONE]' in COALESCE(target.value #>> '{}', '')) > 0
           OR position('[REDACTED_EMAIL]' in COALESCE(target.value #>> '{}', '')) > 0)
         FROM jsonb_array_elements(item."content"->'output'->'taskIds') AS target(value)
       ), false) ELSE NULL END AS "targetIdsRedacted",
       CASE WHEN jsonb_typeof(item."content"->'output'->'tasks') = 'array' THEN COALESCE((
         SELECT bool_or(position('[REDACTED]' in COALESCE(task.value->>'taskId', '')) > 0
           OR position('[REDACTED_PHONE]' in COALESCE(task.value->>'taskId', '')) > 0
           OR position('[REDACTED_EMAIL]' in COALESCE(task.value->>'taskId', '')) > 0)
         FROM jsonb_array_elements(item."content"->'output'->'tasks') AS task(value)
       ), false) ELSE NULL END AS "taskIdsRedacted"
     FROM "agent_items" AS item
     JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
     JOIN "agent_sessions" AS session ON session."id" = turn."sessionId" AND session."userId" = turn."userId"
     WHERE item."sessionId" = $1 AND item."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3
       AND turn."rootTaskId" IS NOT NULL AND item."taskId" = turn."rootTaskId"
       AND item."type" = 'tool_result' AND item."content"->>'toolCallId' = $4
     ORDER BY item."createdAt" DESC LIMIT 1`,
    [owner.sessionId, owner.turnId, owner.userId, toolCallId],
  )
  const row = result.rows[0]
  return {
    resultPresent: Boolean(row),
    resultStatus: row ? diagnosticEnum(row.itemStatus, ITEM_DIAGNOSTIC_STATUSES) ?? "other" : "missing",
    outputStatus: diagnosticEnum(row?.outputStatus, PROCESS_FIXTURE_WAIT_OUTPUT_STATUSES) ?? (row?.outputStatus == null ? "missing" : "other"),
    outputReferencePresent: row?.outputReferencePresent === true,
    targetTaskCount: diagnosticBoundedCount(row?.targetCount),
    matchedTaskCount: diagnosticBoundedCount(row?.matchedCount),
    targetIdsRedacted: row?.targetIdsRedacted ?? null,
    taskIdsRedacted: row?.taskIdsRedacted ?? null,
  }
}

async function processRestartTaskGraphDiagnostic(pool: Pool, turnId: string): Promise<RecordValue> {
  const [graphResult, taskResult] = await Promise.all([
    pool.query<{ taskId: string; revision: number; content: unknown }>(
      `SELECT "taskId", "revision", "content" FROM "agent_items"
       WHERE "turnId" = $1 AND "type" = 'task_graph'
       ORDER BY "revision" DESC, "updatedAt" DESC LIMIT 1`, [turnId],
    ),
    pool.query<{ id: string; role: string; status: string; failureReason: string | null; result: unknown }>(
      `SELECT "id", "role", "status", "failureReason", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 ORDER BY "createdAt" LIMIT 6`, [turnId],
    ),
  ])
  const graphRow = graphResult.rows[0]
  const graph = diagnosticJsonRecord(graphRow?.content)
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record).filter((node): node is RecordValue => node !== null) : []
  const tasksById = new Map(taskResult.rows.map(task => [task.id, task]))
  return {
    graphPresent: Boolean(graph),
    graphRevision: diagnosticBoundedCount(graphRow?.revision),
    graphNodeCount: diagnosticBoundedCount(nodes.length),
    nodes: nodes.slice(0, 4).map(node => {
      const key = diagnosticEnum(node.key, TASK_GRAPH_DIAGNOSTIC_NODE_KEYS) ?? "other"
      const taskId = typeof node.taskId === "string" ? node.taskId : null
      const task = taskId ? tasksById.get(taskId) : undefined
      const taskResult = diagnosticJsonRecord(task?.result)
      const report = record(taskResult?.taskGraphVerificationReport)
      const safeReport = diagnosticDiscoveryTasks(task ? [task] : [])[0]?.taskGraphVerificationReport
      return {
        nodeKey: key,
        nodeStatus: diagnosticEnum(node.status, TASK_DIAGNOSTIC_STATUSES) ?? "other",
        readiness: diagnosticEnum(node.readiness, TASK_GRAPH_READINESS) ?? "other",
        taskRole: task ? diagnosticEnum(task.role, PROCESS_RESTART_TASK_ROLES) ?? "other" : "missing",
        taskStatus: task ? diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES) ?? "other" : "missing",
        failureReasonCode: task?.failureReason
          ? diagnosticErrorCode(task.failureReason) ?? "other"
          : "none",
        verificationStatus: report
          ? diagnosticEnum(report.status, TASK_GRAPH_VERIFICATION_STATUSES) ?? "other"
          : "missing",
        verification: safeReport ?? null,
      }
    }),
    tasks: taskResult.rows.map(task => {
      const taskResult = diagnosticJsonRecord(task.result)
      const report = record(taskResult?.taskGraphVerificationReport)
      const safeReport = diagnosticDiscoveryTasks([task])[0]?.taskGraphVerificationReport
      return {
        role: diagnosticEnum(task.role, PROCESS_RESTART_TASK_ROLES) ?? "other",
        status: diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES) ?? "other",
        failureReasonCode: task.failureReason ? diagnosticErrorCode(task.failureReason) ?? "other" : "none",
        resultStatus: taskResult ? diagnosticEnum(taskResult.status, ITEM_DIAGNOSTIC_STATUSES) ?? "other" : "missing",
        verificationStatus: report
          ? diagnosticEnum(report.status, TASK_GRAPH_VERIFICATION_STATUSES) ?? "other"
          : "missing",
        verification: safeReport ?? null,
      }
    }),
  }
}

async function processRestartFailureDiagnostic(
  pool: Pool,
  turnId: string,
  workerOutput: readonly string[],
): Promise<RecordValue> {
  const [taskGraph, initialWait, followUpWait, runtimeState, analystPlan] = await Promise.all([
    processRestartTaskGraphDiagnostic(pool, turnId),
    waitToolResultDiagnostic(pool, turnId, "p3-process-restart-wait"),
    waitToolResultDiagnostic(pool, turnId, "p3-process-restart-follow-up-wait"),
    restartRuntimeStateDiagnostics(pool, turnId),
    agentPlanLifecycleDiagnostics(pool, turnId, "p3-process-restart-follow-up-plan"),
  ])
  const childOutcome = latestProcessFixtureJsonDiagnostic(workerOutput, "P3_CHILD_OUTCOME ", PROCESS_RESTART_CHILD_OUTCOME_DIAGNOSTIC_FIELDS)
  const childException = latestProcessFixtureJsonDiagnostic(workerOutput, "P3_CHILD_EXCEPTION ", PROCESS_RESTART_CHILD_EXCEPTION_DIAGNOSTIC_FIELDS)
  return {
    rootStage: latestProcessFixtureStage(workerOutput, [
      ["P3_SECOND_WORKER_READY ", "worker_ready"],
      ["P3_PARENT_MODEL_FAILURE_CLASS ", "model_failed"],
      ["P3_RESTORED_GRAPH_OK ", "graph_restored"],
      ["P3_PARENT_RESUME_CONTEXT_OK", "resume_context_ready"],
      ["P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK", "follow_up_dependency_context_ready"],
      ["P3_FOLLOW_UP_GRAPH_READY ", "follow_up_graph_ready"],
      ["P3_FOLLOW_UP_GRAPH_OK ", "follow_up_graph_completed"],
    ], PROCESS_RESTART_ROOT_STAGES),
    childStage: latestProcessFixtureStage(workerOutput, [
      ["P3_CHILD_LEASE ", "lease_acquired"],
      ["P3_DEPENDENT_WAITING_BEFORE_SOURCE_PROOF", "source_wait_checked"],
      ["P3_SOURCE_PROOF_UNLOCKED_DEPENDENT", "source_unlocked"],
      ["P3_DEPENDENCY_CONTEXT_OK", "dependency_context_ready"],
      ["P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK", "follow_up_dependency_context_ready"],
    ], PROCESS_RESTART_CHILD_STAGES),
    parentModelFailureCategory: processFixtureFailureCategory(workerOutput, "P3_PARENT_MODEL_FAILURE_CLASS "),
    parentModelFailureGuard: processRestartGuardMarker(workerOutput),
    childOutcome,
    childException,
    childRuntimeScope: processChildRuntimeScopeDiagnostics(workerOutput),
    restartVerifierEvidence: processRestartVerifierEvidenceDiagnostics(workerOutput),
    taskGraph,
    waitResults: { initial: initialWait, followUp: followUpWait },
    runtimeState,
    analystPlan,
  }
}

const PROCESS_RESTART_CHILD_OUTCOME_DIAGNOSTIC_FIELDS = {
  role: new Set(["scout", "analyst", "other"]), status: new Set(["completed", "failed", "other"]),
  failureCode: new Set(["invalid_structured_result", "model_incomplete", "invalid_output", "tool_execution_failed", "timeout", "cancelled", "step_limit", "budget_exhausted", "no_progress", "evidence_missing", "evidence_conflict", "final_unverified", "child_turn_missing", "child_resume_unavailable", "child_resume_evidence_unavailable", "selected_job_sources_unavailable", "selected_job_context_unavailable", "subagent_role_unknown", "none", "other"]),
  resultStatus: new Set(["completed", "failed", "missing", "other"]),
}
const PROCESS_RESTART_CHILD_EXCEPTION_DIAGNOSTIC_FIELDS = {
  role: new Set(["scout", "analyst", "other"]),
  stage: new Set(["dispatch_context", "source_wait_state", "source_dispatch_state", "source_lookup", "source_verification", "source_completion", "dependent_dispatch", "dependency_context", "follow_up_context", "execute_child", "other"]),
  errorName: new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "AbortError", "TimeoutError", "other"]),
  failureCode: new Set(["invalid_structured_result", "model_incomplete", "invalid_output", "tool_execution_failed", "timeout", "cancelled", "step_limit", "budget_exhausted", "no_progress", "evidence_missing", "evidence_conflict", "final_unverified", "child_turn_missing", "child_resume_unavailable", "child_resume_evidence_unavailable", "selected_job_sources_unavailable", "selected_job_context_unavailable", "subagent_role_unknown", "database_deadlock", "database_serialization", "fixture_error", "other"]),
}

const PROCESS_RESTART_VERIFIER_EVIDENCE_PREFIX = "P3_RESTART_VERIFIER_EVIDENCE_DIAGNOSTIC "
const PROCESS_RESTART_VERIFIER_EVIDENCE_ROLES = new Set(["scout", "analyst", "other"])
const PROCESS_RESTART_VERIFIER_EVIDENCE_STATUSES = new Set(["completed", "partial", "failed", "missing", "other"])
const PROCESS_RESTART_VERIFIER_EVIDENCE_ITEM_STATUSES = new Set(["started", "completed", "failed", "cancelled", "interrupted", "queued", "missing", "other"])
const PROCESS_RESTART_VERIFIER_EVIDENCE_CALL_STATUSES = new Set(["started", "completed", "failed", "interrupted", "cancelled", "missing", "other"])
const PROCESS_RESTART_VERIFIER_EVIDENCE_SOURCES = new Set(["greenhouse", "lever", "workday", "smartrecruiters", "personio", "jobs.read", "missing", "invalid", "other"])
const PROCESS_RESTART_VERIFIER_EVIDENCE_JOBS_TYPES = new Set(["array", "missing", "other"])
const PROCESS_RESTART_VERIFIER_EVIDENCE_MARKER_LIMIT = 4
const PROCESS_RESTART_VERIFIER_EVIDENCE_MAX_BYTES = 8_192
const PROCESS_RESTART_VERIFIER_EVIDENCE_ARRAY_LIMIT = 5
const PROCESS_RESTART_VERIFIER_EVIDENCE_COUNT_LIMIT = 99
const PROCESS_CHILD_RUNTIME_SCOPE_PREFIX = "P3_CHILD_RUNTIME_SCOPE "
const PROCESS_CHILD_RUNTIME_SCOPE_PHASES = new Set(["dispatch", "model", "search_result"])
const PROCESS_CHILD_RUNTIME_SCOPE_MARKER_LIMIT = 12
const PROCESS_CHILD_RUNTIME_SCOPE_MAX_BYTES = 2_048

function boundedRestartEvidenceCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, PROCESS_RESTART_VERIFIER_EVIDENCE_COUNT_LIMIT) : null
}

function safeRestartEvidenceEnum(value: unknown, allowed: ReadonlySet<string>): string {
  return diagnosticEnum(value, allowed) ?? (value === null || value === undefined ? "missing" : "other")
}

function safeRestartEvidenceBooleans(value: unknown): Array<boolean | null> {
  return Array.isArray(value)
    ? value.slice(0, PROCESS_RESTART_VERIFIER_EVIDENCE_ARRAY_LIMIT).map(item => typeof item === "boolean" ? item : null)
    : []
}

function safeRestartEvidenceSources(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.slice(0, PROCESS_RESTART_VERIFIER_EVIDENCE_ARRAY_LIMIT * 2)
    .map(item => safeRestartEvidenceEnum(item, PROCESS_RESTART_VERIFIER_EVIDENCE_SOURCES)))]
    .slice(0, PROCESS_RESTART_VERIFIER_EVIDENCE_ARRAY_LIMIT)
}

function projectRestartVerifierEvidenceRead(value: unknown): RecordValue {
  const row = record(value)
  if (!row) return { diagnosticUnavailable: true }
  return {
    itemStatus: safeRestartEvidenceEnum(row.itemStatus, PROCESS_RESTART_VERIFIER_EVIDENCE_ITEM_STATUSES),
    callStatus: safeRestartEvidenceEnum(row.callStatus, PROCESS_RESTART_VERIFIER_EVIDENCE_CALL_STATUSES),
    hasErrorCode: row.hasErrorCode === true,
    jobsType: safeRestartEvidenceEnum(row.jobsType, PROCESS_RESTART_VERIFIER_EVIDENCE_JOBS_TYPES),
    jobCount: boundedRestartEvidenceCount(row.jobCount),
    jobsValidShape: row.jobsValidShape === true,
    matchingJobCount: boundedRestartEvidenceCount(row.matchingJobCount),
    matchingJobSources: safeRestartEvidenceSources(row.matchingJobSources),
    evidenceSourceMatches: typeof row.evidenceSourceMatches === "boolean" ? row.evidenceSourceMatches : null,
  }
}

function projectRestartVerifierEvidenceMarker(line: string): RecordValue {
  if (line.length > PROCESS_RESTART_VERIFIER_EVIDENCE_MAX_BYTES) return { diagnosticUnavailable: true }
  const raw = diagnosticJsonRecord(line.slice(PROCESS_RESTART_VERIFIER_EVIDENCE_PREFIX.length))
  if (!raw) return { diagnosticUnavailable: true }
  const jobEvidence = Array.isArray(raw.jobEvidence) ? raw.jobEvidence.slice(0, PROCESS_RESTART_VERIFIER_EVIDENCE_ARRAY_LIMIT) : []
  const persistedReads = Array.isArray(raw.persistedReads) ? raw.persistedReads.slice(0, PROCESS_RESTART_VERIFIER_EVIDENCE_ARRAY_LIMIT) : []
  return {
    diagnosticUnavailable: raw.diagnosticUnavailable === true,
    role: safeRestartEvidenceEnum(raw.role, PROCESS_RESTART_VERIFIER_EVIDENCE_ROLES),
    attempt: boundedRestartEvidenceCount(raw.attempt),
    childStatus: safeRestartEvidenceEnum(raw.childStatus, PROCESS_RESTART_VERIFIER_EVIDENCE_STATUSES),
    resultStatus: safeRestartEvidenceEnum(raw.resultStatus, PROCESS_RESTART_VERIFIER_EVIDENCE_STATUSES),
    structuredResultStatus: safeRestartEvidenceEnum(raw.structuredResultStatus, PROCESS_RESTART_VERIFIER_EVIDENCE_STATUSES),
    claimCount: boundedRestartEvidenceCount(raw.claimCount),
    claimJobIdMatches: safeRestartEvidenceBooleans(raw.claimJobIdMatches),
    structuredEvidenceCount: boundedRestartEvidenceCount(raw.structuredEvidenceCount),
    jobEvidenceCount: boundedRestartEvidenceCount(raw.jobEvidenceCount),
    jobEvidence: jobEvidence.map(item => {
      const evidence = record(item)
      return {
        refMatchesRequestedJob: typeof evidence?.refMatchesRequestedJob === "boolean" ? evidence.refMatchesRequestedJob : null,
        source: safeRestartEvidenceEnum(evidence?.source, PROCESS_RESTART_VERIFIER_EVIDENCE_SOURCES),
      }
    }),
    persistedSearchOutputCount: boundedRestartEvidenceCount(raw.persistedSearchOutputCount),
    persistedSearchOutputLimitReached: raw.persistedSearchOutputLimitReached === true,
    persistedReads: persistedReads.map(projectRestartVerifierEvidenceRead),
  }
}

function processRestartVerifierEvidenceDiagnostics(output: readonly string[]): RecordValue {
  const latest: string[] = []
  for (let index = output.length - 1; index >= 0 && latest.length <= PROCESS_RESTART_VERIFIER_EVIDENCE_MARKER_LIMIT; index -= 1) {
    const line = output[index]
    if (line?.startsWith(PROCESS_RESTART_VERIFIER_EVIDENCE_PREFIX)) latest.push(line)
  }
  const markerLimitReached = latest.length > PROCESS_RESTART_VERIFIER_EVIDENCE_MARKER_LIMIT
  const markers = latest.slice(0, PROCESS_RESTART_VERIFIER_EVIDENCE_MARKER_LIMIT).reverse()
    .map(projectRestartVerifierEvidenceMarker)
  return { markerCount: markers.length, markerLimitReached, markers }
}

function projectChildRuntimeScopeMarker(line: string): RecordValue {
  if (line.length > PROCESS_CHILD_RUNTIME_SCOPE_MAX_BYTES) return { diagnosticUnavailable: true }
  const raw = diagnosticJsonRecord(line.slice(PROCESS_CHILD_RUNTIME_SCOPE_PREFIX.length))
  if (!raw) return { diagnosticUnavailable: true }
  const phase = diagnosticEnum(raw.phase, PROCESS_CHILD_RUNTIME_SCOPE_PHASES)
  if (!phase) return { diagnosticUnavailable: true }
  const nullableBoolean = (key: string): boolean | null => typeof raw[key] === "boolean" ? raw[key] as boolean : null
  const nullableCount = (key: string): number | null => raw[key] === null ? null : diagnosticBoundedCount(raw[key])
  return {
    phase,
    sessionMatchesFixture: nullableBoolean("sessionMatchesFixture"),
    turnMatchesFixture: nullableBoolean("turnMatchesFixture"),
    userMatchesFixture: nullableBoolean("userMatchesFixture"),
    taskUserMatchesFixture: nullableBoolean("taskUserMatchesFixture"),
    modelTaskMatchesLease: nullableBoolean("modelTaskMatchesLease"),
    matchingToolResultCount: nullableCount("matchingToolResultCount"),
    resultJsonParsed: nullableBoolean("resultJsonParsed"),
    expectedJobPresent: nullableBoolean("expectedJobPresent"),
    returnedJobCount: nullableCount("returnedJobCount"),
  }
}

function processChildRuntimeScopeDiagnostics(output: readonly string[]): RecordValue {
  const latest: string[] = []
  for (let index = output.length - 1; index >= 0 && latest.length <= PROCESS_CHILD_RUNTIME_SCOPE_MARKER_LIMIT; index -= 1) {
    const line = output[index]
    if (line?.startsWith(PROCESS_CHILD_RUNTIME_SCOPE_PREFIX)) latest.push(line)
  }
  const markerLimitReached = latest.length > PROCESS_CHILD_RUNTIME_SCOPE_MARKER_LIMIT
  const markers = latest.slice(0, PROCESS_CHILD_RUNTIME_SCOPE_MARKER_LIMIT).reverse().map(projectChildRuntimeScopeMarker)
  return { markerCount: markers.length, markerLimitReached, markers }
}

function latestProcessFixtureJsonDiagnostic(
  output: readonly string[], prefix: string, fields: Readonly<Record<string, ReadonlySet<string>>>,
): RecordValue | null {
  const line = [...output].reverse().find(value => value.startsWith(prefix))
  const raw = line ? diagnosticJsonRecord(line.slice(prefix.length)) : null
  if (!raw) return null
  const result: RecordValue = {}
  for (const [field, allowed] of Object.entries(fields)) result[field] = diagnosticEnum(raw[field], allowed) ?? "other"
  if (Object.hasOwn(raw, "hasResult")) result.hasResult = raw.hasResult === true
  if (Object.hasOwn(raw, "hasStructuredResult")) result.hasStructuredResult = raw.hasStructuredResult === true
  return result
}

function processRestartGuardMarker(workerOutput: readonly string[]): string {
  const line = workerOutput.find(value => value.startsWith("P3_PARENT_MODEL_FAILURE_GUARD "))
  return diagnosticEnum(line?.slice("P3_PARENT_MODEL_FAILURE_GUARD ".length), PROCESS_RESTART_GUARD_MARKERS) ?? "none"
}

async function restartRuntimeStateDiagnostics(pool: Pool, turnId: string): Promise<RecordValue> {
  try {
    const [turnResult, stepResult, waitResult] = await Promise.all([
      pool.query<{
        turnStatus: string | null; turnError: string | null; hasRootTask: boolean
        rootTaskStatus: string | null; rootTaskFailureReason: string | null
      }>(`SELECT turn."status" AS "turnStatus", turn."error" AS "turnError",
          turn."rootTaskId" IS NOT NULL AS "hasRootTask", root."status" AS "rootTaskStatus",
          root."failureReason" AS "rootTaskFailureReason"
        FROM "agent_turns" AS turn LEFT JOIN "sub_agent_tasks" AS root
          ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId" AND root."turnId" = turn."id"
        WHERE turn."id" = $1`, [turnId]),
      pool.query<{ ordinal: number; status: string; errorCode: string | null }>(
        `SELECT step."ordinal", step."status", step."errorCode" FROM "agent_steps" AS step
         JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
         WHERE turn."id" = $1 AND step."taskId" = turn."rootTaskId"
         ORDER BY step."ordinal" DESC LIMIT 1`, [turnId],
      ),
      pool.query<{
        status: string; mode: string; targetTaskIds: unknown; matchedTaskIds: unknown
        suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
      }>(`SELECT "status", "mode", "targetTaskIds", "matchedTaskIds", "suspendedAt", "resolvedAt", "consumedAt"
        FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt" DESC LIMIT 4`, [turnId]),
    ])
    const turn = turnResult.rows[0]
    const latestStep = stepResult.rows[0]
    return {
      available: Boolean(turn),
      turn: turn ? {
        status: diagnosticEnum(turn.turnStatus, TURN_DIAGNOSTIC_STATUSES) ?? "other",
        errorCode: turn.turnError ? diagnosticErrorCode(turn.turnError) ?? "other" : "none",
        rootTaskPresent: turn.hasRootTask,
      } : null,
      rootTask: turn?.hasRootTask ? {
        status: diagnosticEnum(turn.rootTaskStatus, TASK_DIAGNOSTIC_STATUSES) ?? "other",
        failureReasonCode: turn.rootTaskFailureReason
          ? diagnosticErrorCode(turn.rootTaskFailureReason) ?? "other" : "none",
      } : null,
      latestStep: latestStep ? {
        ordinal: diagnosticBoundedCount(latestStep.ordinal),
        status: diagnosticEnum(latestStep.status, STEP_DIAGNOSTIC_STATUSES) ?? "other",
        errorCode: latestStep.errorCode ? diagnosticErrorCode(latestStep.errorCode) ?? "other" : "none",
      } : null,
      waits: waitResult.rows.map(wait => {
        const targets = diagnosticIdList(wait.targetTaskIds)
        const matched = diagnosticIdList(wait.matchedTaskIds)
        const targetSet = new Set(targets.values)
        return {
          status: diagnosticEnum(wait.status, WAIT_DIAGNOSTIC_STATUSES) ?? "other",
          mode: diagnosticEnum(wait.mode, new Set(["all", "any"])) ?? "other",
          targetCount: diagnosticBoundedCount(targets.count),
          matchedCount: diagnosticBoundedCount(matched.count),
          matchedTargetCount: targets.valid && matched.valid
            ? diagnosticBoundedCount(matched.values.filter(taskId => targetSet.has(taskId)).length) : null,
          matchedTaskIdsMatchTargets: diagnosticIdListsMatch(targets, matched),
          suspended: wait.suspendedAt !== null,
          resolved: wait.resolvedAt !== null,
          consumed: wait.consumedAt !== null,
        }
      }),
    }
  } catch {
    return { available: false }
  }
}

async function agentPlanLifecycleDiagnostics(
  pool: Pool,
  turnId: string,
  toolCallId: string,
): Promise<RecordValue> {
  try {
    const [pairResult, eventResult] = await Promise.all([
      pool.query<{
        callStatus: string | null; callToolName: string | null; resultStatus: string | null; resultContent: unknown
      }>(`SELECT call."status" AS "callStatus", call."content"->>'toolName' AS "callToolName",
          result."status" AS "resultStatus", result."content" AS "resultContent"
        FROM "agent_turns" AS turn
        LEFT JOIN "agent_items" AS call ON call."sessionId" = turn."sessionId" AND call."turnId" = turn."id"
          AND call."taskId" = turn."rootTaskId" AND call."type" = 'tool_call'
          AND call."content"->>'toolCallId' = $2
        LEFT JOIN "agent_items" AS result ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
          AND result."taskId" = call."taskId" AND result."type" = 'tool_result'
          AND result."content"->>'toolCallId' = $2
        WHERE turn."id" = $1 ORDER BY call."createdAt" DESC NULLS LAST LIMIT 1`, [turnId, toolCallId]),
      pool.query<{ type: string; status: string | null; errorCode: string | null }>(
        `SELECT event."type", event."payload"->>'status' AS "status", event."payload"->>'errorCode' AS "errorCode"
         FROM "agent_turns" AS turn
         JOIN "agent_items" AS call ON call."sessionId" = turn."sessionId" AND call."turnId" = turn."id"
           AND call."taskId" = turn."rootTaskId" AND call."type" = 'tool_call'
           AND call."content"->>'toolCallId' = $2
         JOIN "agent_events" AS event ON event."sessionId" = call."sessionId" AND event."turnId" = call."turnId"
           AND event."itemId" = call."id" AND event."type" = ANY($3::text[])
         WHERE turn."id" = $1 ORDER BY event."sequence" DESC LIMIT 1`,
        [turnId, toolCallId, [...PROCESS_RESTART_PLAN_EVENT_TYPES]],
      ),
    ])
    const pair = pairResult.rows[0]
    const resultContent = record(pair?.resultContent)
    const resultOutput = record(resultContent?.output)
    const event = eventResult.rows[0]
    return {
      available: true,
      call: {
        present: Boolean(pair?.callStatus),
        toolName: diagnosticEnum(pair?.callToolName, TOOL_DIAGNOSTIC_NAMES) ?? "missing_or_other",
        status: pair?.callStatus
          ? diagnosticEnum(pair.callStatus, ITEM_DIAGNOSTIC_STATUSES) ?? "other" : "missing",
      },
      result: {
        present: Boolean(pair?.resultStatus),
        status: pair?.resultStatus
          ? diagnosticEnum(pair.resultStatus, ITEM_DIAGNOSTIC_STATUSES) ?? "other" : "missing",
        errorCode: resultContent?.errorCode
          ? diagnosticErrorCode(resultContent.errorCode) ?? "other" : "none",
        outputStatus: diagnosticEnum(resultOutput?.status, PROCESS_RESTART_PLAN_OUTPUT_STATUSES) ?? "missing_or_other",
        nodeCount: Array.isArray(resultOutput?.nodes) ? diagnosticBoundedCount(resultOutput.nodes.length) : null,
      },
      event: event ? {
        present: true,
        type: diagnosticEnum(event.type, PROCESS_RESTART_PLAN_EVENT_TYPES) ?? "other",
        status: diagnosticEnum(event.status, PROCESS_RESTART_PLAN_EVENT_STATUSES) ?? "other",
        errorCode: event.errorCode ? diagnosticErrorCode(event.errorCode) ?? "other" : "none",
      } : { present: false },
    }
  } catch {
    return { available: false }
  }
}

async function waitForTurnStatus(
  pool: Pool,
  turnId: string,
  wanted: string,
  timeoutMs = 50_000,
  diagnosticToolCallId?: string,
  additionalDiagnosticToolCallIds: readonly string[] = [],
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ status: string; error: string | null }>(
      `SELECT "status", "error" FROM "agent_turns" WHERE "id" = $1`, [turnId],
    )
    const status = result.rows[0]?.status
    if (status === wanted) return
    if (status && ["failed", "interrupted", "cancelled"].includes(status)) {
      const progress = await turnProgressDiagnostics(pool, turnId, diagnosticToolCallId, additionalDiagnosticToolCallIds)
      const turnError = boundedDiagnostic(result.rows[0]?.error ?? "<none>", 300)
      throw new Error(`TaskGraph root turn entered ${status}; error=${turnError}; progress=${compactTurnProgressDiagnostics(progress, 3_000)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const progress = await turnProgressDiagnostics(pool, turnId, diagnosticToolCallId, additionalDiagnosticToolCallIds)
  throw new Error(`TaskGraph root turn did not reach ${wanted}; progress=${compactTurnProgressDiagnostics(progress, 900)}`)
}

function waitForTurnStatusFailureDiagnostic(error: unknown): RecordValue {
  const fields = record(error)
  const message = error instanceof Error ? error.message : ""
  const terminal = /^TaskGraph root turn entered (failed|interrupted|cancelled); error=([^;]{0,128});/.exec(message)
  const errorName = diagnosticEnum(error instanceof Error ? error.name : fields?.name, new Set(["Error"])) ?? "other"
  const failureKind = terminal ? "terminal_turn"
    : message.startsWith("TaskGraph root turn did not reach ") ? "deadline" : "other"
  const stableErrorCode = terminal?.[2] ?? fields?.code
  return {
    errorName,
    failureKind,
    turnStatus: diagnosticEnum(terminal?.[1], TURN_DIAGNOSTIC_STATUSES) ?? "missing",
    errorCode: stableErrorCode ? diagnosticErrorCode(stableErrorCode) ?? "other" : "none",
  }
}

type LeaseRecoveryStartupStage =
  | "not_started" | "state_loading" | "state_loaded" | "selected_job_loading" | "selected_job_loaded"
  | "root_ensure_entered" | "root_ensure_returned" | "root_ensure_failed" | "model_factory"
type LeaseRecoveryAdapterBranch = "not_started" | "initial_plan" | "initial_wait" | "repair_plan" | "repair_wait" | "final_proof" | "unexpected"
type LeaseRecoveryAdapterStage =
  | "not_started" | "stream_entered" | "branch_entered" | "graph_checked" | "outcome_checked"
  | "database_checked" | "tool_call_emitted" | "completion_emitted" | "final_output_emitted"
  | "final_proof_graph_nodes" | "final_proof_node_statuses" | "final_proof_dependent_identity"
  | "final_proof_dependent_report" | "final_proof_repair_report" | "final_proof_repair_receipt"
  | "final_proof_wait_outcome" | "final_proof_wait_task_statuses" | "final_proof_repair_wait_report"
  | "final_proof_dependent_wait_report"
type LeaseRecoveryModelResult = {
  resultStatus: "completed" | "failed" | "missing" | "other"
  isError: boolean | null
  outputStatus: "accepted" | "duplicate" | "waiting" | "ready" | "timed_out" | "interrupted" | "closed" | "rejected" | "failed" | "completed" | "missing" | "other"
  errorCategory: "none" | "database" | "invalid_output" | "tool_schema" | "wait_receipt" | "tool_replay" | "completion_gate" | "task_graph" | "execution" | "other"
}
type LeaseRecoveryFixtureDiagnostics = {
  modelRuntimeFactoryInvocations: number
  adapterStreamInvocations: number
  runtimeExecuteInvocations: number
  runtimeExecuteFailureClass: FailurePreflightErrorClass
  startupStage: LeaseRecoveryStartupStage
  adapterExecutionOrdinal: number
  adapterRoundOrdinal: number
  adapterBranch: LeaseRecoveryAdapterBranch
  adapterStage: LeaseRecoveryAdapterStage
  repairPlanResult: LeaseRecoveryModelResult
  repairWaitResult: LeaseRecoveryModelResult
}

const LEASE_RECOVERY_MODEL_RESULT_STATUSES = new Set(["completed", "failed", "missing", "other"])
const LEASE_RECOVERY_MODEL_OUTPUT_STATUSES = new Set([
  "accepted", "duplicate", "waiting", "ready", "timed_out", "interrupted", "closed", "rejected", "failed", "completed", "missing", "other",
])
const LEASE_RECOVERY_MODEL_ERROR_CATEGORIES = new Set([
  "none", "database", "invalid_output", "tool_schema", "wait_receipt", "tool_replay", "completion_gate", "task_graph", "execution", "other",
])

function missingLeaseRecoveryModelResult(): LeaseRecoveryModelResult {
  return { resultStatus: "missing", isError: null, outputStatus: "missing", errorCategory: "none" }
}

function leaseRecoveryModelResultFromRequest(request: HarnessModelRequest, callId: string): LeaseRecoveryModelResult {
  let matched: { readonly isError?: boolean; readonly content: unknown } | null = null
  for (let messageIndex = request.messages.length - 1; messageIndex >= 0 && !matched; messageIndex -= 1) {
    const content = request.messages[messageIndex]!.content
    for (let partIndex = content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = content[partIndex]!
      if (part.type === "tool_result" && part.toolUseId === callId) {
        matched = part
        break
      }
    }
  }
  if (!matched) return missingLeaseRecoveryModelResult()

  let output: RecordValue | null = null
  if (typeof matched.content === "string") {
    try { output = record(JSON.parse(matched.content) as unknown) } catch { output = null }
  }
  const resultStatus = matched.isError === true ? "failed"
    : matched.isError === false || matched.isError === undefined ? "completed" : "other"
  const outputStatus = typeof output?.status === "string"
    && LEASE_RECOVERY_MODEL_OUTPUT_STATUSES.has(output.status)
    ? output.status as LeaseRecoveryModelResult["outputStatus"]
    : output?.status === undefined ? "missing" : "other"
  const errorCode = output?.errorCode
  const category = errorCode === null || errorCode === undefined ? "none" : diagnosticErrorClass(errorCode) ?? "other"
  const errorCategory = LEASE_RECOVERY_MODEL_ERROR_CATEGORIES.has(category)
    ? category as LeaseRecoveryModelResult["errorCategory"]
    : "other"
  return {
    resultStatus,
    isError: typeof matched.isError === "boolean" ? matched.isError : null,
    outputStatus,
    errorCategory,
  }
}

function leaseRecoveryModelResultProjection(value: unknown): LeaseRecoveryModelResult {
  const source = record(value)
  return {
    resultStatus: diagnosticEnum(source?.resultStatus, LEASE_RECOVERY_MODEL_RESULT_STATUSES) as LeaseRecoveryModelResult["resultStatus"] | null ?? "other",
    isError: typeof source?.isError === "boolean" ? source.isError : null,
    outputStatus: diagnosticEnum(source?.outputStatus, LEASE_RECOVERY_MODEL_OUTPUT_STATUSES) as LeaseRecoveryModelResult["outputStatus"] | null ?? "other",
    errorCategory: diagnosticEnum(source?.errorCategory, LEASE_RECOVERY_MODEL_ERROR_CATEGORIES) as LeaseRecoveryModelResult["errorCategory"] | null ?? "other",
  }
}

function leaseRecoveryFixtureDiagnosticProjection(value: unknown): RecordValue | null {
  const source = record(value)
  if (!source) return null
  const ordinal = (candidate: unknown) => typeof candidate === "number" && Number.isSafeInteger(candidate)
    && candidate >= 0 && candidate <= 7 ? candidate : null
  return {
    modelRuntimeFactoryInvocations: diagnosticBoundedCount(source.modelRuntimeFactoryInvocations),
    adapterStreamInvocations: diagnosticBoundedCount(source.adapterStreamInvocations),
    runtimeExecuteInvocations: diagnosticBoundedCount(source.runtimeExecuteInvocations),
    runtimeExecuteFailureClass: diagnosticEnum(source.runtimeExecuteFailureClass, LEASE_RECOVERY_FAILURE_CLASSES) ?? "other",
    startupStage: diagnosticEnum(source.startupStage, LEASE_RECOVERY_STARTUP_STAGES) ?? "other",
    adapterExecutionOrdinal: ordinal(source.adapterExecutionOrdinal),
    adapterRoundOrdinal: ordinal(source.adapterRoundOrdinal),
    adapterBranch: diagnosticEnum(source.adapterBranch, LEASE_RECOVERY_ADAPTER_BRANCHES) ?? "other",
    adapterStage: diagnosticEnum(source.adapterStage, LEASE_RECOVERY_ADAPTER_STAGES) ?? "other",
    ...(source.repairPlanResult === undefined ? {} : { repairPlanResult: leaseRecoveryModelResultProjection(source.repairPlanResult) }),
    ...(source.repairWaitResult === undefined ? {} : { repairWaitResult: leaseRecoveryModelResultProjection(source.repairWaitResult) }),
  }
}

async function waitForPersistedTaskWait(
  pool: Pool,
  turnId: string,
  idempotencyKey: string,
  timeoutMs = 20_000,
  diagnosticToolCallId?: string,
  diagnosticFixtureCounters?: LeaseRecoveryFixtureDiagnostics,
): Promise<{ id: string }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = await pool.query<{ id: string; status: string; suspendedAt: Date | null }>(
      `SELECT "id", "status", "suspendedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "idempotencyKey" = $2`,
      [turnId, idempotencyKey],
    )
    const row = result.rows[0]
    if (row?.status === "waiting" && row.suspendedAt instanceof Date) return { id: row.id }
    if (row?.status === "ready") throw new Error("Follow-up child completed before its durable parent wait suspended")
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const diagnostics = diagnosticToolCallId
    ? `; state=${await persistedWaitTimeoutDiagnostics(pool, turnId, idempotencyKey, diagnosticToolCallId, diagnosticFixtureCounters)}`
    : ""
  throw new Error(`Follow-up parent wait was not durably suspended${diagnostics}`)
}

async function persistedWaitTimeoutDiagnostics(
  pool: Pool,
  turnId: string,
  idempotencyKey: string,
  toolCallId: string,
  fixtureCounters?: LeaseRecoveryFixtureDiagnostics,
): Promise<string> {
  try {
    const [turn, wait, tools, toolEvents, recentTurnEvents, tasks, steps] = await Promise.all([
      pool.query<{ status: string; rootTaskId: string | null; revision: number; leaseOwnerId: string | null; error: string | null }>(
        `SELECT "status", "rootTaskId", "revision", "leaseOwnerId", "error" FROM "agent_turns" WHERE "id" = $1 LIMIT 1`, [turnId],
      ),
      pool.query<{ id: string; status: string; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown; matchedTaskIds: unknown }>(
        `SELECT "id", "status", "suspendedAt", "resolvedAt", "consumedAt", "targetTaskIds", "matchedTaskIds"
         FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "idempotencyKey" = $2 LIMIT 1`, [turnId, idempotencyKey],
      ),
      pool.query<{ id: string; type: string; status: string; errorCode: string | null }>(
        `SELECT "id", "type", "status", "content"->>'errorCode' AS "errorCode" FROM "agent_items"
         WHERE "turnId" = $1 AND "type" IN ('tool_call', 'tool_result') AND "content"->>'toolCallId' = $2
         ORDER BY "createdAt" DESC LIMIT 4`, [turnId, toolCallId],
      ),
      pool.query<{ type: string; status: string | null; errorCode: string | null }>(
        `SELECT "type", "payload"->>'status' AS "status", "payload"->>'errorCode' AS "errorCode"
         FROM "agent_events" WHERE "turnId" = $1 AND "payload"->>'toolCallId' = $2
         ORDER BY "sequence" DESC LIMIT 4`, [turnId, toolCallId],
      ),
      pool.query<{ type: string; status: string | null; errorCode: string | null }>(
        `SELECT "type", "payload"->>'status' AS "status", "payload"->>'errorCode' AS "errorCode"
         FROM "agent_events" WHERE "turnId" = $1 ORDER BY "sequence" DESC LIMIT 6`, [turnId],
      ),
      pool.query<{ id: string; status: string; attemptCount: number; failureReason: string | null }>(
        `SELECT "id", "status", "attemptCount", "failureReason" FROM "sub_agent_tasks"
         WHERE "turnId" = $1 ORDER BY "createdAt" DESC LIMIT 6`, [turnId],
      ),
      pool.query<{ id: string; taskId: string | null; ordinal: number; attempt: number; status: string; errorCode: string | null }>(
        `SELECT "id", "taskId", "ordinal", "attempt", "status", "errorCode" FROM "agent_steps"
         WHERE "turnId" = $1 ORDER BY "ordinal" DESC, "attempt" DESC LIMIT 4`, [turnId],
      ),
    ])
    const turnRow = turn.rows[0]
    const waitRow = wait.rows[0]
    return boundedDiagnostic(JSON.stringify({
      turn: turnRow ? {
        id: turnId.slice(-12), status: diagnosticEnum(turnRow.status, TURN_DIAGNOSTIC_STATUSES),
        rootTask: turnRow.rootTaskId?.slice(-12) ?? null, revision: turnRow.revision,
        leaseOwnerPresent: turnRow.leaseOwnerId !== null, errorCode: diagnosticErrorCode(turnRow.error),
      } : { id: turnId.slice(-12), missing: true },
      wait: waitRow ? {
        id: waitRow.id.slice(-12), status: diagnosticEnum(waitRow.status, WAIT_DIAGNOSTIC_STATUSES),
        suspended: waitRow.suspendedAt !== null, resolved: waitRow.resolvedAt !== null, consumed: waitRow.consumedAt !== null,
        targetCount: diagnosticCount(waitRow.targetTaskIds), matchedCount: diagnosticCount(waitRow.matchedTaskIds),
      } : { found: false },
      fixtureCounters: fixtureCounters ? leaseRecoveryFixtureDiagnosticProjection(fixtureCounters) : null,
      tools: tools.rows.map(item => ({
        id: item.id.slice(-12), type: item.type, status: diagnosticEnum(item.status, ITEM_DIAGNOSTIC_STATUSES),
        errorCode: diagnosticErrorCode(item.errorCode),
      })),
      toolEvents: toolEvents.rows.map(event => ({
        type: event.type, status: diagnosticEnum(event.status, ITEM_DIAGNOSTIC_STATUSES), errorCode: diagnosticErrorCode(event.errorCode),
      })),
      recentTurnEvents: recentTurnEvents.rows.map(event => ({
        type: diagnosticText(event.type, 80), status: diagnosticEnum(event.status, EVENT_DIAGNOSTIC_STATUSES),
        errorCode: diagnosticErrorCode(event.errorCode),
      })),
      tasks: tasks.rows.map(task => ({
        id: task.id.slice(-12), status: diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES),
        attempts: task.attemptCount, failureCode: diagnosticErrorCode(task.failureReason),
      })),
      steps: steps.rows.map(step => ({
        id: step.id.slice(-12), task: step.taskId?.slice(-12) ?? null, ordinal: step.ordinal, attempt: step.attempt,
        status: diagnosticEnum(step.status, STEP_DIAGNOSTIC_STATUSES), errorCode: diagnosticErrorCode(step.errorCode),
      })),
    }), 2_200)
  } catch {
    return JSON.stringify({ available: false })
  }
}

async function restartFollowUpWaitDiagnostics(
  pool: Pool,
  turnId: string,
  waitKey: string,
  toolCallId: string,
): Promise<RecordValue> {
  try {
    const [wait, turn, graph, toolCall, toolResult] = await Promise.all([
      pool.query<{ status: string; suspendedAt: Date | null; consumedAt: Date | null }>(
        `SELECT "status", "suspendedAt", "consumedAt" FROM "agent_wait_conditions"
         WHERE "turnId" = $1 AND "idempotencyKey" = $2 LIMIT 1`, [turnId, waitKey],
      ),
      pool.query<{ status: string; leaseOwnerId: string | null }>(
        `SELECT "status", "leaseOwnerId" FROM "agent_turns" WHERE "id" = $1 LIMIT 1`, [turnId],
      ),
      pool.query<{ revision: number; content: unknown }>(
        `SELECT "revision", "content" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'task_graph'
         ORDER BY "revision" DESC, "updatedAt" DESC LIMIT 1`, [turnId],
      ),
      pool.query<{ status: string }>(
        `SELECT "status" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'tool_call'
         AND "content"->>'toolCallId' = $2 AND "content"->>'toolName' = 'agent.wait'
         ORDER BY "createdAt" DESC LIMIT 1`, [turnId, toolCallId],
      ),
      pool.query<{ status: string }>(
        `SELECT "status" FROM "agent_items" WHERE "turnId" = $1 AND "type" = 'tool_result'
         AND "content"->>'toolCallId' = $2 ORDER BY "createdAt" DESC LIMIT 1`, [turnId, toolCallId],
      ),
    ])
    const waitRow = wait.rows[0]
    const turnRow = turn.rows[0]
    const graphRow = graph.rows[0]
    const graphContent = record(graphRow?.content)
    const graphNodes = Array.isArray(graphContent?.nodes) ? graphContent.nodes : null
    const waitStatus = waitRow
      ? waitRow.status === "waiting" ? "waiting" : waitRow.status === "ready" ? "ready" : "other"
      : "missing"
    return {
      waitStatus,
      hasSuspendedAt: waitRow?.suspendedAt instanceof Date,
      hasConsumedAt: waitRow?.consumedAt instanceof Date,
      turnStatus: diagnosticEnum(turnRow?.status, TURN_DIAGNOSTIC_STATUSES),
      turnLeaseOwnerPresent: typeof turnRow?.leaseOwnerId === "string",
      graphRevision: typeof graphRow?.revision === "number" && Number.isSafeInteger(graphRow.revision)
        ? graphRow.revision
        : null,
      graphNodeCount: graphNodes?.length ?? null,
      followUpWaitCallPresent: toolCall.rows.length > 0,
      followUpWaitCallStatus: diagnosticEnum(toolCall.rows[0]?.status, ITEM_DIAGNOSTIC_STATUSES),
      followUpWaitResultPresent: toolResult.rows.length > 0,
      followUpWaitResultStatus: diagnosticEnum(toolResult.rows[0]?.status, ITEM_DIAGNOSTIC_STATUSES),
    }
  } catch {
    return { available: false }
  }
}

describe("compact TaskGraph wait failure diagnostics", () => {
  it("projects restart child markers through the safe diagnostic allowlists", () => {
    const outcome = latestProcessFixtureJsonDiagnostic([
      `P3_CHILD_OUTCOME ${JSON.stringify({ role: "analyst", status: "failed", failureCode: "invalid_output", resultStatus: "missing", hasResult: false, hasStructuredResult: false, prompt: "private" })}`,
    ], "P3_CHILD_OUTCOME ", PROCESS_RESTART_CHILD_OUTCOME_DIAGNOSTIC_FIELDS)
    const exception = latestProcessFixtureJsonDiagnostic([
      `P3_CHILD_EXCEPTION ${JSON.stringify({ role: "analyst", stage: "execute_child", errorName: "TypeError", failureCode: "other", message: "private provider response" })}`,
    ], "P3_CHILD_EXCEPTION ", PROCESS_RESTART_CHILD_EXCEPTION_DIAGNOSTIC_FIELDS)
    const knownFailure = latestProcessFixtureJsonDiagnostic([
      `P3_CHILD_EXCEPTION ${JSON.stringify({ role: "analyst", stage: "execute_child", errorName: "Error", failureCode: "child_resume_unavailable" })}`,
    ], "P3_CHILD_EXCEPTION ", PROCESS_RESTART_CHILD_EXCEPTION_DIAGNOSTIC_FIELDS)

    expect(outcome).toEqual({
      role: "analyst", status: "failed", failureCode: "invalid_output", resultStatus: "missing",
      hasResult: false, hasStructuredResult: false,
    })
    expect(exception).toEqual({ role: "analyst", stage: "execute_child", errorName: "TypeError", failureCode: "other" })
    expect(knownFailure).toEqual({ role: "analyst", stage: "execute_child", errorName: "Error", failureCode: "child_resume_unavailable" })
    expect(JSON.stringify({ outcome, exception, knownFailure })).not.toContain("private")
  })

  it("projects child runtime scope markers to bounded booleans and counts", () => {
    const projected = processChildRuntimeScopeDiagnostics([
      `${PROCESS_CHILD_RUNTIME_SCOPE_PREFIX}${JSON.stringify({
        phase: "dispatch", sessionMatchesFixture: true, turnMatchesFixture: true, userMatchesFixture: true,
        taskUserMatchesFixture: null, modelTaskMatchesLease: null, matchingToolResultCount: null,
        resultJsonParsed: null, expectedJobPresent: null, returnedJobCount: null, rawTaskId: "private-task-id",
      })}`,
      `${PROCESS_CHILD_RUNTIME_SCOPE_PREFIX}${JSON.stringify({
        phase: "search_result", sessionMatchesFixture: true, turnMatchesFixture: true, userMatchesFixture: true,
        taskUserMatchesFixture: true, modelTaskMatchesLease: false, matchingToolResultCount: 1,
        resultJsonParsed: true, expectedJobPresent: false, returnedJobCount: 1, error: "private database error",
      })}`,
      `${PROCESS_CHILD_RUNTIME_SCOPE_PREFIX}${JSON.stringify({
        phase: "unknown-private-phase", matchingToolResultCount: 10_001, returnedJobCount: "private",
      })}`,
    ])

    expect(projected).toEqual({
      markerCount: 3, markerLimitReached: false, markers: [
        {
          phase: "dispatch", sessionMatchesFixture: true, turnMatchesFixture: true, userMatchesFixture: true,
          taskUserMatchesFixture: null, modelTaskMatchesLease: null, matchingToolResultCount: null,
          resultJsonParsed: null, expectedJobPresent: null, returnedJobCount: null,
        },
        {
          phase: "search_result", sessionMatchesFixture: true, turnMatchesFixture: true, userMatchesFixture: true,
          taskUserMatchesFixture: true, modelTaskMatchesLease: false, matchingToolResultCount: 1,
          resultJsonParsed: true, expectedJobPresent: false, returnedJobCount: 1,
        },
        { diagnosticUnavailable: true },
      ],
    })
    expect(JSON.stringify(projected)).not.toContain("private")
  })

  it("selects the latest TaskGraph observation from a multi-step model request", () => {
    const request = {
      messages: [
        { role: "user", content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":0,"nodes":[]}' }] },
        { role: "assistant", content: [{ type: "text", text: '[context]\n{"kind":"task_graph_current","revision":1,"nodes":[{"key":"source","taskId":"child-1"}]}' }] },
      ],
    } as unknown as HarnessModelRequest

    expect(currentGraphFromRequest(request)).toMatchObject({
      kind: "task_graph_current", revision: 1,
      nodes: [{ key: "source", taskId: "child-1" }],
    })
  })

  it("projects requested wait task containment separately from exact graph equality", () => {
    const projected = JSON.parse(compactTurnProgressDiagnostics(JSON.stringify({
      waitLineage: {
        taskIdsMatchCurrentGraph: false,
        requestedTaskIdsPresentInCurrentGraph: true,
      },
    }))) as RecordValue

    expect(projected).toMatchObject({
      waitLineage: { taskIdsMatchCurrentGraph: false, requestedTaskIdsPresentInCurrentGraph: true },
    })
  })

  it("projects root failure, steps, and exact restart tool items without leaking content", () => {
    const privateText = "private-root-prompt-or-task-id"
    const projected = JSON.parse(compactTurnProgressDiagnostics(JSON.stringify({
      rootFailure: {
        taskFound: true, reasonPresent: true, reasonCode: "invalid_output", privateFailureReason: privateText,
        events: [{ eventType: "turn.failed", status: null, errorCode: "invalid_output", message: privateText }],
      },
      rootSteps: [
        { ordinal: 4, status: "completed", errorCode: null, privatePrompt: privateText },
        { ordinal: 5, status: "failed", errorCode: "invalid_output", errorMessage: privateText },
      ],
      rootToolItems: [
        { callId: DISCOVERY_RESTART_WAIT_CALL_ID, type: "tool_result", status: "completed", toolName: "agent.wait", toolStatus: "completed", output: { status: "ready", waitId: privateText, matchedTaskIds: [privateText], tasks: [{ taskId: privateText }] } },
        { callId: DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, type: "tool_result", status: "completed", toolName: "agent.plan", toolStatus: "completed", output: { status: "accepted", nodes: [{ taskId: privateText }] } },
        { callId: DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID, type: "tool_call", status: "completed", toolName: "agent.wait", toolStatus: "completed", input: { taskIds: [privateText], goal: privateText } },
        { callId: "untrusted-private-call-id", type: "tool_result", status: "completed", toolName: "agent.wait", output: { status: "ready" } },
      ],
    }), 4_000)) as RecordValue

    expect(projected).toMatchObject({
      rootFailure: {
        taskFound: true, reasonPresent: true, reasonCode: "invalid_output", reasonClass: "invalid_output",
        events: [{ eventType: "turn.failed", errorCode: "invalid_output", errorClass: "invalid_output" }],
      },
      rootSteps: [
        { ordinal: 4, status: "completed", errorCode: null, errorClass: null },
        { ordinal: 5, status: "failed", errorCode: "invalid_output", errorClass: "invalid_output" },
      ],
      rootToolItems: [
        { callId: DISCOVERY_RESTART_WAIT_CALL_ID, type: "tool_result", status: "completed", toolName: "agent.wait", outputStatus: "ready", outputWaitIdPresent: true, outputMatchedTaskCount: 1, outputTaskCount: 1 },
        { callId: DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, type: "tool_result", status: "completed", toolName: "agent.plan", outputStatus: "accepted", outputNodeCount: 1, outputNodeTaskIdCount: 1 },
        { callId: DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID, type: "tool_call", status: "completed", toolName: "agent.wait", inputTaskCount: 1 },
      ],
    })
    expect(JSON.stringify(projected)).not.toContain(privateText)
    expect(JSON.stringify(projected)).not.toContain("untrusted-private-call-id")
  })

  it("retains allowlisted counts from preprojected root tool diagnostics", () => {
    const projected = JSON.parse(compactTurnProgressDiagnostics(JSON.stringify({ rootToolItems: [{
      callId: DISCOVERY_RESTART_WAIT_CALL_ID, type: "tool_result", status: "completed", toolName: "agent.wait",
      inputTaskCount: 1, inputNodeCount: null, outputStatus: "ready", outputWaitIdPresent: true,
      outputTaskCount: 1, outputMatchedTaskCount: 1, outputNodeCount: null, outputNodeTaskIdCount: null,
      input: { goal: "private goal" }, output: { tasks: [{ taskId: "private task" }] },
    }] }))) as RecordValue

    expect(projected.rootToolItems).toEqual([expect.objectContaining({
      callId: DISCOVERY_RESTART_WAIT_CALL_ID, inputTaskCount: 1, outputStatus: "ready",
      outputWaitIdPresent: true, outputTaskCount: 1, outputMatchedTaskCount: 1,
    })])
    expect(JSON.stringify(projected)).not.toContain("private")
  })

  it("selects the newest exact plan receipt when tool-use IDs repeat", () => {
    const request = {
      messages: [
        { role: "assistant", content: [{
          type: "tool_result", toolUseId: "reused-plan-call",
          content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "stale-task" }] }),
        }] },
        { role: "assistant", content: [{
          type: "tool_result", toolUseId: "another-call",
          content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "unrelated-task" }] }),
        }, {
          type: "tool_result", toolUseId: "reused-plan-call",
          content: JSON.stringify({ status: "accepted", nodes: [{ taskId: "latest-task" }] }),
        }] },
      ],
    } as unknown as HarnessModelRequest

    expect(planTaskIds(request, "reused-plan-call", 1)).toEqual(["latest-task"])

    const invalidLatestReceipt = {
      ...request,
      messages: [...request.messages, { role: "assistant", content: [{
        type: "tool_result", toolUseId: "reused-plan-call", content: "{invalid json",
      }] }],
    } as unknown as HarnessModelRequest
    expect(() => planTaskIds(invalidLatestReceipt, "reused-plan-call", 1)).toThrow("TaskGraph plan receipt missing")
  })

  it("accepts a replayed duplicate plan receipt while validating its task IDs", () => {
    const request = {
      messages: [{ role: "assistant", content: [{
        type: "tool_result", toolUseId: "replayed-plan-call",
        content: JSON.stringify({ status: "duplicate", nodes: [{ key: "verification", taskId: "replayed-task" }] }),
      }] }],
    } as unknown as HarnessModelRequest

    expect(planTaskIds(request, "replayed-plan-call", 1)).toEqual(["replayed-task"])

    const invalidStatus = {
      ...request,
      messages: [{ role: "assistant", content: [{
        type: "tool_result", toolUseId: "replayed-plan-call",
        content: JSON.stringify({ status: "failed", nodes: [{ key: "verification", taskId: "replayed-task" }] }),
      }] }],
    } as unknown as HarnessModelRequest
    expect(() => planTaskIds(invalidStatus, "replayed-plan-call", 1)).toThrow("TaskGraph plan receipt missing")

    const malformedDuplicate = {
      ...request,
      messages: [{ role: "assistant", content: [{
        type: "tool_result", toolUseId: "replayed-plan-call",
        content: JSON.stringify({ status: "duplicate", nodes: [{ key: "verification" }] }),
      }] }],
    } as unknown as HarnessModelRequest
    expect(() => planTaskIds(malformedDuplicate, "replayed-plan-call", 1)).toThrow("Expected 1 planned task ID(s); received 0")
  })

  it("projects plan receipt identifiers and revisions without exposing request payloads", () => {
    const privateTaskId = "private-task-verification"
    const privatePrompt = "private-plan-prompt"
    const request = {
      messages: [
        { role: "assistant", content: [{
          type: "tool_use", id: "follow-up-plan", name: "agent.plan", input: { goal: privatePrompt },
        }] },
        { role: "tool", content: [{
          type: "tool_result", toolUseId: "follow-up-plan",
          content: JSON.stringify({
            status: "accepted", revision: 12,
            nodes: [{ key: "verification", taskId: privateTaskId, goal: privatePrompt }],
          }),
        }] },
      ],
    } as unknown as HarnessModelRequest

    const evidence = planReceiptEvidenceProjection(request, "follow-up-plan", {
      nodes: [{ key: "verification", taskId: privateTaskId }],
    })

    expect(evidence).toMatchObject({
      expectedCallMatched: true, matchingToolUseCount: 1, matchingToolNameIsAgentPlan: true,
      planToolUseCount: 1, planToolNames: ["agent.plan"],
      matchingToolResultCount: 1, matchingResultIsError: false,
      planToolResultCount: 1, resultContentType: "string", resultJsonParsed: true,
      receiptStatus: "accepted", receiptRevision: 12, receiptNodeCount: 1, receiptTaskIdCount: 1,
      graphTaskIdCount: 1, receiptTaskIdsMatchingGraphCount: 1, receiptTaskIdsEqualGraphSet: true,
    })
    expect(JSON.stringify(evidence)).not.toContain(privateTaskId)
    expect(JSON.stringify(evidence)).not.toContain(privatePrompt)
    expect(JSON.stringify(evidence)).not.toContain("follow-up-plan")

    const duplicateIds = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "duplicate-plan", name: "agent.plan", input: {} }] },
        { role: "tool", content: [{
          type: "tool_result", toolUseId: "duplicate-plan",
          content: JSON.stringify({ status: "accepted", nodes: [
            { taskId: privateTaskId }, { taskId: privateTaskId },
          ] }),
        }] },
      ],
    } as unknown as HarnessModelRequest
    const duplicateEvidence = planReceiptEvidenceProjection(duplicateIds, "duplicate-plan", {
      nodes: [{ taskId: privateTaskId }, { taskId: "private-graph-other" }],
    })
    expect(duplicateEvidence).toMatchObject({
      receiptTaskIdCount: 2, graphTaskIdCount: 2, receiptTaskIdsMatchingGraphCount: 2,
      receiptTaskIdsEqualGraphSet: false,
    })
    expect(JSON.stringify(duplicateEvidence)).not.toContain(privateTaskId)
    expect(JSON.stringify(duplicateEvidence)).not.toContain("private-graph-other")
  })

  it("matches an initial four-task wait to its receipt after a later one-node proposal", () => {
    const initialTaskIds = ["private-source", "private-summary", "private-large", "private-rejected"]
    const nodeRows = (taskIds: readonly string[]) => taskIds.map((taskId, index) => ({
      key: ["source", "summary", "large-source", "rejected", "verification"][index], taskId,
    }))
    const latestFollowUpProposal = {
      kind: "proposal", receipt: { nodes: [{ key: "verification", taskId: "private-verification" }] },
    }
    const earlierInitialProposal = {
      kind: "proposal", receipt: { nodes: nodeRows(initialTaskIds) },
    }
    const requestedIds = diagnosticIdList(initialTaskIds)
    const selected = proposalReceiptForWait(requestedIds, [latestFollowUpProposal, earlierInitialProposal])
    const currentGraphIds = diagnosticIdList([...initialTaskIds, "private-verification"])
    const safeProjection = {
      proposalNodeCount: selected?.rawNodes.length ?? null,
      requestMatchesReceipt: selected ? diagnosticIdListsMatch(requestedIds, selected.taskIds) : null,
      requestedTaskIdsPresentInCurrentGraph: diagnosticIdListContainsAll(requestedIds, currentGraphIds),
    }

    expect(safeProjection).toEqual({
      proposalNodeCount: 4, requestMatchesReceipt: true, requestedTaskIdsPresentInCurrentGraph: true,
    })
    expect(JSON.stringify(safeProjection)).not.toContain("private-")
  })

  it("projects an unmatched wait without selecting an unrelated proposal receipt", () => {
    const requestedIds = diagnosticIdList(["private-source", "private-summary"])
    const proposals = [
      { kind: "proposal", receipt: { nodes: [{ key: "verification", taskId: "private-follow-up" }] } },
      { kind: "proposal", receipt: { nodes: [{ key: "source", taskId: "private-source" }] } },
    ]
    const selected = proposalReceiptForWait(requestedIds, proposals)
    const safeProjection = {
      proposalReceiptFound: selected !== null,
      proposalNodeCount: selected?.rawNodes.length ?? 0,
      requestMatchesReceipt: selected ? diagnosticIdListsMatch(requestedIds, selected.taskIds) : null,
      requestedIdsOutsideReceiptCount: selected && requestedIds.valid && selected.taskIds.valid
        ? requestedIds.values.filter(id => !new Set(selected.taskIds.values).has(id)).length
        : null,
    }

    expect(selected).toBeNull()
    expect(safeProjection).toEqual({
      proposalReceiptFound: false, proposalNodeCount: 0, requestMatchesReceipt: null, requestedIdsOutsideReceiptCount: null,
    })
    expect(JSON.stringify(safeProjection)).not.toContain("private-")
  })

  it("projects the closest prior receipt for four unmatched wait IDs without conflating matches", () => {
    const requestedIds = diagnosticIdList([
      "private-source", "private-summary", "private-large", "private-rejected",
    ])
    const proposals = [{
      kind: "proposal",
      receipt: { nodes: [{ key: "verification", taskId: "private-unrelated" }] },
    }]
    const projection = failedWaitReceiptProjection(requestedIds, proposals)
    const waitToolResult = { matchedTaskIds: [] as string[] }
    const compact = compactTurnProgressDiagnostics(JSON.stringify({
      waitToolResult: { matchedTaskIds: { count: waitToolResult.matchedTaskIds.length } },
      waitLineage: { proposalReceiptFound: projection.exactReceiptMatchExists, ...projection },
    }))

    expect(proposalReceiptForWait(requestedIds, proposals)).toBeNull()
    expect(JSON.parse(compact)).toMatchObject({
      waitToolResult: { matchedTaskCount: 0 },
      waitLineage: {
        proposalReceiptFound: false,
        exactReceiptMatchExists: false,
        proposalReceiptCandidateCount: 1,
        closestReceiptNodeCount: 1,
        closestReceiptNodeKeys: ["verification"],
        requestedIdsOutsideReceiptCount: 4,
      },
    })
    expect(Buffer.byteLength(JSON.stringify(projection), "utf8")).toBeLessThanOrEqual(1_200)
    expect(JSON.stringify(projection)).not.toContain("private-")
  })

  it("projects only the finite preflight stage and sanitized error class", () => {
    const marker = "private-task-and-exception-message"
    const output = combineFailureDiagnostics([
      { label: "failedPrerequisitePreflight", value: "captured" },
      { label: "failurePreflightStage", value: marker, safeValue: "first_target_lineage" },
      { label: "failurePreflightErrorClass", value: marker, safeValue: "assertion" },
    ], "{}")

    expect(output).toContain("failurePreflightStage=first_target_lineage")
    expect(output).toContain("failurePreflightErrorClass=assertion")
    expect(output).not.toContain(marker)
  })

  it("retains only bounded restart guard and wait failure codes", () => {
    const privateFailure = "private-task-id-and-exception-detail"
    const guard = processRestartGuardMarker([
      "P3_PARENT_MODEL_FAILURE_GUARD source_projection_missing",
      `P3_PARENT_MODEL_FAILURE_GUARD ${privateFailure}`,
    ])
    const invalidGuard = processRestartGuardMarker([`P3_PARENT_MODEL_FAILURE_GUARD ${privateFailure}`])
    const waitFailure = waitForTurnStatusFailureDiagnostic(new Error(
      `TaskGraph root turn entered failed; error=${privateFailure}; progress=${privateFailure}`,
    ))
    const projected = JSON.stringify({ guard, invalidGuard, waitFailure })

    expect(guard).toBe("source_projection_missing")
    expect(invalidGuard).toBe("none")
    expect(waitFailure).toEqual({
      errorName: "Error", failureKind: "terminal_turn", turnStatus: "failed", errorCode: "other",
    })
    expect(projected).not.toContain(privateFailure)
    expect(Buffer.byteLength(projected, "utf8")).toBeLessThanOrEqual(300)
  })

  it("surfaces the fixed Plan Ledger projection failure category without fixture error text", () => {
    const privateError = "p3_persisted_plan_ledger_projection_invalid:private-detail"
    const failureCategory = processFixtureFailureCategory(
      ["P3_PARENT_MODEL_FAILURE_CLASS plan_ledger_projection_invalid"], "P3_PARENT_MODEL_FAILURE_CLASS ",
    )
    const output = combineFailureDiagnostics([
      { label: "parentModelFailureClass", value: privateError, safeValue: diagnosticEnum(
        failureCategory, PROCESS_FIXTURE_FAILURE_CATEGORIES,
      ) ?? "other" },
    ], "{}")

    expect(output).toContain("parentModelFailureClass=plan_ledger_projection_invalid")
    expect(output).not.toContain(privateError)
  })

  it("surfaces only a valid restored source projection classification", () => {
    const parentFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + '"category":"wrong_role","schema":"expected","availability":"available","role":"other",'
      + '"status":"completed","candidateCount":1,"evidenceCount":1,"candidateArrayCount":1,'
      + '"candidateIdentity":"unchecked","extra":"private-projection-payload"} at private-fixture-path'
    const safeValue = restoredSourceProjectionFailureSafeValue(parentFailure)
    const output = combineFailureDiagnostics(parentModelFailureDiagnosticFields(parentFailure), "{}")

    expect(JSON.parse(safeValue)).toEqual({
      category: "wrong_role", schema: "expected", availability: "available", role: "other",
      status: "completed", candidateIdentity: "unchecked", candidateCount: 1,
      evidenceCount: 1, candidateArrayCount: 1,
    })
    expect(output).toContain('restoredSourceProjection={"category":"wrong_role"')
    expect(output).not.toContain("private-projection-payload")
    expect(output).not.toContain("private-fixture-path")
    expect(output).not.toContain("P3_PARENT_MODEL_FAILURE")
  })

  it("projects a missing source projection category to the whitelisted missing value", () => {
    const parentFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + '"role":"scout","candidateCount":1} at fixture'

    expect(JSON.parse(restoredSourceProjectionFailureSafeValue(parentFailure))).toEqual({
      category: "missing", role: "scout", candidateCount: 1,
    })
  })

  it("strips malformed and private restored projection diagnostic content", () => {
    const canary = "private-role-and-candidate-id"
    const privateFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + `"category":"wrong_role","role":"${canary}","candidateIdentity":"${canary}",`
      + `"candidateCount":"${canary}","extra":"${canary}"} at ${canary}`
    const safeValue = restoredSourceProjectionFailureSafeValue(privateFailure)
    const malformed = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{\"category\":"
    const output = combineFailureDiagnostics([
      { label: "restoredSourceProjection", value: privateFailure, safeValue },
      { label: "malformedSourceProjection", value: malformed, safeValue: restoredSourceProjectionFailureSafeValue(malformed) },
    ], "{}")

    expect(JSON.parse(safeValue)).toEqual({ category: "wrong_role", role: "other", candidateIdentity: "other", candidateCount: null })
    expect(output).toContain("malformedSourceProjection=unavailable")
    expect(output).not.toContain(canary)
    expect(output).not.toContain("P3_PARENT_MODEL_FAILURE")
  })

  it("reports an absent restored projection marker as unavailable", () => {
    expect(restoredSourceProjectionFailureSafeValue(null)).toBe("unavailable")
    expect(restoredSourceProjectionFailureSafeValue("P3_PARENT_MODEL_FAILURE Error: p3_other_failure")).toBe("unavailable")
  })

  it("caps restored source projection diagnostic counts", () => {
    const parentFailure = "P3_PARENT_MODEL_FAILURE Error: p3_restored_graph_source_projection_missing:{"
      + `"category":"wrong_count","candidateCount":${Number.MAX_SAFE_INTEGER},`
      + '"evidenceCount":1000,"candidateArrayCount":-1} at fixture'
    const safeValue = restoredSourceProjectionFailureSafeValue(parentFailure)

    expect(JSON.parse(safeValue)).toEqual({
      category: "wrong_count", candidateCount: 99, evidenceCount: 99, candidateArrayCount: null,
    })
    expect(safeValue.length).toBeLessThan(500)
  })

  it("projects completed graph statuses by fixed node keys without exposing node payloads", () => {
    const privateIds = [
      "task-0f1d8f13-1d45-4f3d-b719-f2059186a010",
      "turn-82a86a40-736d-4460-b7b4-d67a69e6c611",
    ]
    const projection = completedGraphStatusFailureProjection({
      kind: "task_graph_current",
      nodes: [
        { key: "source", taskId: privateIds[0], goal: "private source goal", status: "completed", readiness: "terminal" },
        { key: "summary", taskId: privateIds[1], goal: "private summary goal", status: "completed", readiness: "terminal" },
        { key: "large-source", taskId: "private-large", status: "failed", readiness: "terminal" },
        { key: "large-source-repair", taskId: "private-repair", goal: "private repair goal", status: "completed", readiness: "terminal" },
        { key: "rejected", taskId: "private-rejected", status: "failed", readiness: "terminal" },
        { key: "verification", taskId: "private-verification", status: "completed", readiness: "active" },
      ],
    })

    expect(projection).toEqual({ nodes: [
      { key: "source", status: "completed", readiness: "terminal", expectedMatch: true },
      { key: "summary", status: "completed", readiness: "terminal", expectedMatch: true },
      { key: "large-source", status: "failed", readiness: "terminal", expectedMatch: true },
      { key: "rejected", status: "failed", readiness: "terminal", expectedMatch: false },
      { key: "large-source-repair", status: "completed", readiness: "terminal", expectedMatch: true },
      { key: "verification", status: "completed", readiness: "active", expectedMatch: false },
    ] })
    const serialized = JSON.stringify(projection)
    expect(serialized.length).toBeLessThanOrEqual(1_200)
    for (const privateId of privateIds) expect(serialized).not.toContain(privateId)
    expect(serialized).not.toContain("private-")
    expect(serialized).not.toContain("private source goal")
  })

  it("projects failed-prerequisite root and target lineage as booleans only", () => {
    const privateIds = {
      root: "root-7034c44b-a4a4-445e-a71a-adb33e095901",
      turn: "turn-8ee6dc90-f10e-4bc9-a355-0cc9ea73d109",
      targetOne: "target-32ab89f6-090b-4337-945b-cfab5a85da3b",
      targetTwo: "target-2b578e50-bdbb-4fb8-85b3-5434651b2b8e",
      mismatchedParent: "parent-c6b882f7-2af1-4bb6-8f26-b9003c96c3fe",
    }
    const projection = failurePreflightEvidenceProjection({
      rootTaskLookupCompleted: true,
      rootTaskId: privateIds.root,
      expectedTurnId: privateIds.turn,
      expectedTaskIds: [privateIds.targetOne, privateIds.targetTwo],
      targets: [
        {
          found: true, taskId: privateIds.targetOne, turnId: privateIds.turn,
          rootTaskId: privateIds.root, parentTaskId: privateIds.root,
        },
        {
          found: true, taskId: privateIds.targetTwo, turnId: privateIds.turn,
          rootTaskId: privateIds.root, parentTaskId: privateIds.mismatchedParent,
        },
      ],
    })

    expect(projection).toEqual({ rootTaskFound: true, targets: [
      {
        key: "prerequisite", found: true, targetMatchesReceipt: true,
        turnMatches: true, rootMatches: true, parentMatches: true,
      },
      {
        key: "dependent", found: true, targetMatchesReceipt: true,
        turnMatches: true, rootMatches: true, parentMatches: false,
      },
    ] })
    const serialized = JSON.stringify(projection)
    expect(serialized.length).toBeLessThanOrEqual(1_200)
    for (const privateId of Object.values(privateIds)) expect(serialized).not.toContain(privateId)
  })

  it("projects missing-task database scope evidence as bounded booleans only", () => {
    const privateIds = {
      session: "private-session-id", user: "private-user-id", turn: "private-turn-id",
      root: "private-root-id", parent: "private-parent-id",
    }
    const expected = {
      sessionId: privateIds.session, userId: privateIds.user, turnId: privateIds.turn, rootTaskId: privateIds.root,
    }
    const mismatch = missingTaskScopeEvidence({
      lookupCompleted: true,
      observed: {
        sessionId: "other-session-id", sessionUserId: "other-user-id", turnId: privateIds.turn,
        rootTaskId: privateIds.root, parentTaskId: privateIds.parent,
      },
      expected,
    })
    const projection = failurePreflightEvidenceProjection({
      rootTaskLookupCompleted: true,
      rootTaskId: privateIds.root,
      expectedTurnId: privateIds.turn,
      expectedTaskIds: ["private-target-id"],
      targets: [{ found: false, scope: mismatch }, null],
    })

    expect(projection).toEqual({ rootTaskFound: true, targets: [
      {
        key: "prerequisite", found: false, targetMatchesReceipt: null,
        turnMatches: null, rootMatches: null, parentMatches: null,
        scope: {
          lookupCompleted: true, rowFound: true, sessionMatches: false, userMatches: false,
          turnMatches: true, rootMatches: true, parentMatches: false,
        },
      },
      {
        key: "dependent", found: null, targetMatchesReceipt: null,
        turnMatches: null, rootMatches: null, parentMatches: null,
      },
    ] })
    expect(missingTaskScopeEvidence({ lookupCompleted: true, observed: null, expected })).toMatchObject({
      lookupCompleted: true, rowFound: false,
    })
    expect(missingTaskScopeEvidence({ lookupCompleted: false, observed: null, expected })).toMatchObject({
      lookupCompleted: false, rowFound: null,
    })
    const serialized = JSON.stringify(projection)
    expect(serialized.length).toBeLessThanOrEqual(1_200)
    for (const privateId of Object.values(privateIds)) expect(serialized).not.toContain(privateId)
    expect(serialized).not.toContain("other-session-id")
    expect(serialized).not.toContain("other-user-id")
    expect(serialized).not.toContain("private-target-id")
  })

  it("distinguishes stale graph context from persisted receipt/snapshot lineage mismatch without exposing IDs", () => {
    const privateTaskIds = ["private-task-source", "private-task-summary"]
    const nodeRows = (ids: readonly string[]) => ids.map((taskId, index) => ({
      key: index === 0 ? "source" : "summary", taskId,
    }))
    const receipt = { status: "duplicate", revision: 1, nodes: nodeRows(privateTaskIds) }
    const storedSnapshot = { nodes: nodeRows(privateTaskIds) }
    const staleRequestGraph = { kind: "task_graph_current", revision: 1, nodes: nodeRows([privateTaskIds[0]!, "stale-task-summary"]) }
    const staleGraph = firstWaitPlanGraphMismatchProjection({
      requestReceipt: receipt, requestGraph: staleRequestGraph, persistedToolReceipt: receipt,
      persistedToolResultItemRevision: 1, persistedToolResultItemStatus: "completed", persistedReceipt: receipt,
      persistedSnapshot: storedSnapshot, persistedItemRevision: 1,
      persistedReceiptItem: { revision: 1, content: storedSnapshot },
    })
    expect(staleGraph).toMatchObject({
      diagnosis: "stale_request_graph_context",
      comparisons: {
        requestReceiptMatchesRequestGraph: false,
        requestGraphMatchesPersistedSnapshot: false,
        persistedReceiptMatchesSnapshot: true,
      },
      mismatchKeys: { requestReceiptGraph: ["summary"], requestGraphPersistedSnapshot: ["summary"] },
    })

    const divergentSnapshot = { nodes: nodeRows([privateTaskIds[0]!, "persisted-task-summary"]) }
    const persistedLineage = firstWaitPlanGraphMismatchProjection({
      requestReceipt: receipt,
      requestGraph: { kind: "task_graph_current", revision: 1, nodes: divergentSnapshot.nodes },
      persistedToolReceipt: receipt, persistedToolResultItemRevision: 1, persistedToolResultItemStatus: "completed",
      persistedReceipt: receipt, persistedSnapshot: divergentSnapshot, persistedItemRevision: 2,
      persistedReceiptItem: { revision: 1, content: storedSnapshot },
    })
    expect(persistedLineage).toMatchObject({
      diagnosis: "persisted_receipt_snapshot_lineage_mismatch",
      comparisons: {
        requestGraphMatchesPersistedSnapshot: true,
        persistedReceiptMatchesSnapshot: false,
        persistedReceiptMatchesEmbeddedSnapshot: true,
        embeddedSnapshotMatchesCurrentSnapshot: false,
      },
      mismatchKeys: { persistedReceiptSnapshot: ["summary"] },
    })
    expect(JSON.stringify([staleGraph, persistedLineage])).not.toContain("private-task")
    expect(JSON.stringify([staleGraph, persistedLineage])).not.toContain("stale-task-summary")
    expect(JSON.stringify([staleGraph, persistedLineage])).not.toContain("persisted-task-summary")
  })

  it("locates initial plan receipt divergence at the persisted tool result without exposing task IDs", () => {
    const keys = ["source", "summary", "large-source", "rejected"] as const
    const nodes = (prefix: string) => keys.map(key => ({ key, taskId: `${prefix}-${key}` }))
    const requestReceipt = { status: "accepted", revision: 1, nodes: nodes("request-task") }
    const durableNodes = nodes("durable-task").map(node => ({
      ...node, taskId: node.key === "source" || node.key === "summary"
        ? `request-task-${node.key}` : node.taskId,
    }))
    const durableReceipt = { status: "accepted", revision: 1, nodes: durableNodes }
    const persistedSnapshot = { nodes: durableNodes }
    const request = {
      messages: [{ role: "tool", content: [{
        type: "tool_result", toolUseId: "private-plan-call",
        content: JSON.stringify(requestReceipt),
      }] }],
    } as unknown as HarnessModelRequest

    const projection = firstWaitPlanGraphMismatchProjection({
      requestReceipt: latestToolResult(request, "private-plan-call"),
      requestGraph: { kind: "task_graph_current", revision: 3, nodes: durableNodes },
      persistedToolReceipt: requestReceipt,
      persistedToolResultItemRevision: 1,
      persistedToolResultItemStatus: "completed",
      persistedReceipt: durableReceipt,
      persistedSnapshot,
      persistedItemRevision: 3,
      persistedReceiptItem: { revision: 1, content: persistedSnapshot },
    })
    const serialized = JSON.stringify(projection)

    expect(projection).toMatchObject({
      diagnosis: "persisted_tool_receipt_proposal_mismatch",
      persisted: { toolResultItemRevision: 1, toolResultItemStatus: "completed", toolReceiptNodeCount: 4 },
      comparisons: {
        requestReceiptMatchesPersistedToolReceipt: true,
        persistedToolReceiptMatchesPersistedReceipt: false,
        persistedToolReceiptMatchesSnapshot: false,
        requestGraphMatchesPersistedSnapshot: true,
        persistedReceiptMatchesSnapshot: true,
      },
      mismatchKeys: {
        requestReceiptPersistedToolReceipt: [],
        persistedToolReceiptProposal: ["large-source", "rejected"],
        persistedToolReceiptSnapshot: ["large-source", "rejected"],
      },
    })
    for (const node of [...requestReceipt.nodes, ...durableReceipt.nodes]) expect(serialized).not.toContain(node.taskId)
    expect(serialized).not.toContain("private-plan-call")
    expect(serialized).not.toContain("request-task")
    expect(serialized).not.toContain("durable-task")
    expect(serialized.length).toBeLessThanOrEqual(1_200)
  })

  it("keeps the safe process diagnostics line without raw stdout or stderr", () => {
    const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
    const safeLine = prefix + JSON.stringify({
      graphNodeCount: 2, missingKeys: { graphTasks: ["summary"] },
      likelyCause: "wait_row_missing_or_parent_mismatch",
    })
    const child = {
      pid: 42, exitCode: null, signalCode: null,
      output: ["marker-arbitrary-stdout", safeLine], errors: ["marker-raw-stderr"],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)

    expect(output).toContain("pid=42 exitCode=null signal=none stdoutLineCount=2 stderrLineCount=1")
    expect(output.slice(output.indexOf(prefix) + prefix.length)).toBe(JSON.stringify({
      likelyCause: "wait_row_missing_or_parent_mismatch", graphNodeCount: 2,
      missingKeys: { graphTasks: ["summary"] },
    }))
    expect(output).not.toContain("marker-arbitrary-stdout")
    expect(output).not.toContain("marker-raw-stderr")
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("keeps safe statuses and counts while dropping markers from allowed-shaped and unknown fields", () => {
    const markers = ["marker-task-id", "marker-raw-error", "marker-nested-error", "marker-extra-id"]
    const safeLine = "P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify({
      turnStatus: "failed", rootTaskStatus: "running", latestModelStepStatus: "failed",
      latestModelStepErrorClass: markers[1], planFailureCategory: "task_graph_failure", turnErrorCategory: "database_deadlock",
      waitToolCallStatus: "completed", waitToolCallLifecycleStatus: "started",
      planAccepted: true,
      waitToolResultLifecycleStatus: "completed",
      waitToolOutputStatus: "ready", waitFailureCategory: "database_serialization",
      waits: { count: 3, rootCount: 1, suspendedRootCount: 1, markerExtra: markers[2] },
      graphNodeCount: 2,
      initialWaitLineage: {
        proposalReceiptFound: true, proposalNodeCount: 2, graphNodeCount: 2,
        receiptRevision: 3, graphRevision: 4, proposalRevisionMatchesGraph: false,
        requestMatchesReceipt: true, requestMatchesCurrentGraph: false, proposalMatchesGraph: false,
        persistedItemReadSucceeded: true, persistedItemFound: true, persistedItemValid: true,
        persistedItemNodeCount: 2, persistedItemRevision: 3,
        proposalMatchesPersistedItem: true, persistedItemMatchesGraph: false,
        requestedIdsOutsideReceiptCount: 0, requestedIdsOutsideGraphCount: 1,
        planToolUseCount: 1, planToolResultCount: 1, planExpectedRevision: 0,
        planToolPairMatches: true, planExpectedRevisionMatches: true, planCallId: markers[0],
        graphNodeKeysMissingReceipt: ["summary", markers[0], "not-allowed"],
        receiptPersistedMismatchKeys: ["source", markers[0]],
        persistedGraphMismatchKeys: ["summary", markers[0]],
        taskIds: [markers[0]], rawError: markers[1],
      },
      targetCounts: { requested: 2, graphMatches: 2, taskRows: 2, graphRows: 2, markerExtra: markers[3] },
      missingKeys: { requestedGraph: ["source", markers[0]], graphTasks: ["summary"] },
      childStatusCounts: { failed: 1, completed: 2, [markers[0]]: 9 },
      likelyCause: "wait_row_missing_or_parent_mismatch",
      unknownNested: { id: markers[3], error: markers[2], deep: { raw: markers[1] } },
    })
    const child = {
      pid: 42, exitCode: null, signalCode: null, output: [safeLine], errors: [],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)
    const projected = JSON.parse(output.slice(output.indexOf("P3_PARENT_SUSPENSION_DIAGNOSTICS ")
      + "P3_PARENT_SUSPENSION_DIAGNOSTICS ".length)) as RecordValue

    expect(projected).toMatchObject({
      turnStatus: "failed", rootTaskStatus: "running", latestModelStepStatus: "failed",
      planFailureCategory: "task_graph_failure", turnErrorCategory: "database_deadlock", waitToolCallStatus: "completed",
      planAccepted: true,
      waitToolCallLifecycleStatus: "started",
      waitToolResultLifecycleStatus: "completed", waitToolOutputStatus: "ready",
      waitFailureCategory: "database_serialization", waits: { count: 3, rootCount: 1, suspendedRootCount: 1 },
      graphNodeCount: 2, targetCounts: { requested: 2, graphMatches: 2, taskRows: 2, graphRows: 2 },
      initialWaitLineage: {
        proposalReceiptFound: true, proposalNodeCount: 2, graphNodeCount: 2,
        receiptRevision: 3, graphRevision: 4, proposalRevisionMatchesGraph: false,
        requestMatchesReceipt: true, requestMatchesCurrentGraph: false, proposalMatchesGraph: false,
        persistedItemReadSucceeded: true, persistedItemFound: true, persistedItemValid: true,
        persistedItemNodeCount: 2, persistedItemRevision: 3,
        proposalMatchesPersistedItem: true, persistedItemMatchesGraph: false,
        requestedIdsOutsideReceiptCount: 0, requestedIdsOutsideGraphCount: 1,
        planToolUseCount: 1, planToolResultCount: 1, planExpectedRevision: 0,
        planToolPairMatches: true, planExpectedRevisionMatches: true,
        graphNodeKeysMissingReceipt: ["summary"],
        receiptPersistedMismatchKeys: ["source"], persistedGraphMismatchKeys: ["summary"],
      },
      missingKeys: { requestedGraph: ["source"], graphTasks: ["summary"] },
      childStatusCounts: { failed: 1, completed: 2 },
      likelyCause: "wait_row_missing_or_parent_mismatch",
    })
    expect(projected).not.toHaveProperty("latestModelStepErrorClass")
    expect(projected).not.toHaveProperty("unknownNested")
    expect(markers.some(marker => output.includes(marker)), "diagnostic output must omit marker values").toBe(false)
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("projects archived-wait child progress to closed phases, bounded ordinals, and error kinds", () => {
    const secret = "private task or database detail"
    const child = {
      pid: 42, exitCode: null, signalCode: null, errors: [],
      output: [
        ARCHIVED_WAIT_PROGRESS_PREFIX + JSON.stringify({ phase: "child_created", progress: 4, errorKind: "none", taskId: secret }),
        ARCHIVED_WAIT_PROGRESS_PREFIX + JSON.stringify({ phase: "child_finish_failed", progress: 7, errorKind: "type_error", error: secret }),
      ],
    } as unknown as ProcessFixtureChild
    const output = processFixtureDiagnostics(child)
    expect(output).toContain('archivedWaitProgress={"phase":"child_finish_failed","progress":7,"errorKind":"type_error"}')
    expect(output).not.toContain(secret)
    expect(archivedWaitProgressProjection({ phase: secret, progress: 8, errorKind: secret, payload: secret })).toEqual({
      phase: "other", progress: null, errorKind: "other",
    })
  })

  it("projects repair-follow-up model diagnostics through closed branch and stage labels", () => {
    const secret = "private goal, ID, or provider detail"
    const projected = leaseRecoveryFixtureDiagnosticProjection({
      modelRuntimeFactoryInvocations: 3, adapterStreamInvocations: 4, runtimeExecuteInvocations: 2,
      runtimeExecuteFailureClass: "database", startupStage: "model_factory",
      adapterExecutionOrdinal: 3, adapterRoundOrdinal: 1, adapterBranch: "final_proof",
      adapterStage: "outcome_checked", privateId: secret, error: secret,
    })
    expect(projected).toEqual({
      modelRuntimeFactoryInvocations: 3, adapterStreamInvocations: 4, runtimeExecuteInvocations: 2,
      runtimeExecuteFailureClass: "database", startupStage: "model_factory",
      adapterExecutionOrdinal: 3, adapterRoundOrdinal: 1, adapterBranch: "final_proof",
      adapterStage: "outcome_checked",
    })
    const finalProofStage = leaseRecoveryFixtureDiagnosticProjection({
      adapterExecutionOrdinal: 3, adapterRoundOrdinal: 1, adapterBranch: "final_proof",
      adapterStage: "final_proof_repair_receipt",
    })
    expect(finalProofStage?.adapterStage).toBe("final_proof_repair_receipt")
    const invalid = leaseRecoveryFixtureDiagnosticProjection({
      adapterExecutionOrdinal: 8, adapterRoundOrdinal: -1, adapterBranch: secret, adapterStage: secret,
      startupStage: secret, runtimeExecuteFailureClass: secret, private: secret,
    })
    expect(invalid).toMatchObject({
      adapterExecutionOrdinal: null, adapterRoundOrdinal: null, adapterBranch: "other", adapterStage: "other",
      startupStage: "other", runtimeExecuteFailureClass: "other",
    })
    expect(JSON.stringify([projected, invalid])).not.toContain(secret)
  })

  it("projects only correlated repair plan and wait result status from captured model input", () => {
    const secret = "private goal, result body, or error text"
    const planCallId = "private-repair-plan-call"
    const waitCallId = "private-repair-wait-call"
    const request = {
      messages: [
        { role: "tool", content: [{ type: "tool_result", toolUseId: planCallId, isError: true,
          content: JSON.stringify({ status: "rejected", errorCode: "task_graph_state_missing", goal: secret, taskId: secret }) }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: waitCallId,
          content: JSON.stringify({ status: "waiting", errorCode: "unlisted_private_error", waitId: secret, tasks: [{ goal: secret }] }) }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "unrelated-private-call", isError: true,
          content: JSON.stringify({ status: "failed", errorCode: "persistence_conflict", goal: secret }) }] },
      ],
    } as unknown as HarnessModelRequest
    const planResult = leaseRecoveryModelResultFromRequest(request, planCallId)
    const waitResult = leaseRecoveryModelResultFromRequest(request, waitCallId)
    const missingResult = leaseRecoveryModelResultFromRequest(request, "not-present")
    const projected = leaseRecoveryFixtureDiagnosticProjection({ repairPlanResult: planResult, repairWaitResult: waitResult })
    const malformed = leaseRecoveryFixtureDiagnosticProjection({
      repairPlanResult: { resultStatus: secret, isError: secret, outputStatus: secret, errorCategory: secret, body: secret },
      repairWaitResult: secret,
    })

    expect(planResult).toEqual({ resultStatus: "failed", isError: true, outputStatus: "rejected", errorCategory: "task_graph" })
    expect(waitResult).toEqual({ resultStatus: "completed", isError: null, outputStatus: "waiting", errorCategory: "other" })
    expect(missingResult).toEqual(missingLeaseRecoveryModelResult())
    expect(projected).toMatchObject({ repairPlanResult: planResult, repairWaitResult: waitResult })
    expect(Object.keys(projected ?? {}).sort()).toEqual([
      "adapterBranch", "adapterExecutionOrdinal", "adapterRoundOrdinal", "adapterStage", "adapterStreamInvocations",
      "modelRuntimeFactoryInvocations", "repairPlanResult", "repairWaitResult", "runtimeExecuteFailureClass",
      "runtimeExecuteInvocations", "startupStage",
    ])
    expect(malformed).toMatchObject({
      repairPlanResult: { resultStatus: "other", isError: null, outputStatus: "other", errorCategory: "other" },
      repairWaitResult: { resultStatus: "other", isError: null, outputStatus: "other", errorCategory: "other" },
    })
    expect(JSON.stringify([projected, malformed, missingResult])).not.toContain(secret)
    expect(JSON.stringify([projected, malformed, missingResult])).not.toContain(planCallId)
    expect(JSON.stringify([projected, malformed, missingResult])).not.toContain(waitCallId)
    expect(JSON.stringify([projected, malformed, missingResult])).not.toContain("unrelated-private-call")
  })

  it("redacts proposal event lineage markers while retaining safe comparisons and mismatch keys", () => {
    const markers = [
      "marker-proposal-event-id", "marker-request-result-text", "marker-event-receipt-id", "marker-embedded-content",
    ]
    const projectLineage = (initialWaitLineage: RecordValue) => {
      const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
      const child = {
        pid: 42, exitCode: null, signalCode: null,
        output: [prefix + JSON.stringify({ initialWaitLineage })], errors: [],
      } as unknown as ProcessFixtureChild
      const output = processFixtureDiagnostics(child)
      const projected = JSON.parse(output.slice(output.indexOf(prefix) + prefix.length)) as RecordValue
      return { output, lineage: projected.initialWaitLineage }
    }

    const safe = projectLineage({
      proposalReceiptFound: true,
      proposalEventFound: true,
      requestResultTaskIdentityMapMatchesEventReceipt: false,
      eventReceiptTaskIdentityMapMatchesEmbeddedContent: null,
      embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: true,
      embeddedContentTaskIdentityMapMatchesPayloadContent: false,
      proposalEventRevisionMatchesReceipt: true,
      proposalEventRevisionMatchesEmbeddedItem: null,
      proposalEventRevisionMatchesCurrentPersistedItemRow: false,
      proposalEventRevision: 17,
      eventReceiptEmbeddedTaskIdentityMapMismatchKeys: ["source", markers[0], "verification", "not-allowed"],
      embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["summary", markers[1]],
      embeddedPayloadTaskIdentityMapMismatchKeys: ["source", "verification", markers[2]],
      privateIdentifier: markers[3],
    })
    expect(safe.lineage).toEqual({
      proposalEventFound: true,
      requestResultTaskIdentityMapMatchesEventReceipt: false,
      eventReceiptTaskIdentityMapMatchesEmbeddedContent: null,
      embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: true,
      embeddedContentTaskIdentityMapMatchesPayloadContent: false,
      proposalEventRevisionMatchesReceipt: true,
      proposalEventRevisionMatchesEmbeddedItem: null,
      proposalEventRevisionMatchesCurrentPersistedItemRow: false,
      eventReceiptEmbeddedTaskIdentityMapMismatchKeys: ["source", "verification"],
      embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["summary"],
      embeddedPayloadTaskIdentityMapMismatchKeys: ["source", "verification"],
      proposalReceiptFound: true,
      proposalEventRevision: 17,
    })
    expect(markers.some(marker => safe.output.includes(marker))).toBe(false)

    const nullRevision = projectLineage({ proposalEventRevision: null })
    expect(nullRevision.lineage).toEqual({ proposalEventRevision: null })

    const unsafe = projectLineage({
      proposalReceiptFound: true,
      proposalEventFound: markers[0],
      requestResultTaskIdentityMapMatchesEventReceipt: markers[1],
      eventReceiptTaskIdentityMapMatchesEmbeddedContent: markers[2],
      embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: "yes",
      embeddedContentTaskIdentityMapMatchesPayloadContent: markers[3],
      proposalEventRevisionMatchesReceipt: "true",
      proposalEventRevisionMatchesEmbeddedItem: markers[0],
      proposalEventRevisionMatchesCurrentPersistedItemRow: markers[1],
      proposalEventRevision: 10_001,
      eventReceiptEmbeddedTaskIdentityMapMismatchKeys: [markers[0], "private text"],
      embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["not-allowed"],
      embeddedPayloadTaskIdentityMapMismatchKeys: [{ key: "source" }],
      privateIdentifier: markers[2],
    })
    expect(unsafe.lineage).toEqual({ proposalReceiptFound: true })
    expect(markers.some(marker => unsafe.output.includes(marker))).toBe(false)
  })

  it("preserves first-divergence identity diagnostics within the bounded realistic process line", () => {
    const prefix = "P3_PARENT_SUSPENSION_DIAGNOSTICS "
    const child = {
      pid: 42, exitCode: null, signalCode: null, errors: [],
      output: [prefix + JSON.stringify({
        turnStatus: "failed", rootTaskStatus: "running", latestModelStepStatus: "failed",
        latestModelStepErrorClass: "database_deadlock", turnErrorCategory: "database_serialization",
        waitToolCallStatus: "completed", waitToolCallLifecycleStatus: "completed", planAccepted: true,
        waitToolResultLifecycleStatus: "completed", waitToolOutputStatus: "ready",
        waitFailureCategory: "database_serialization", likelyCause: "wait_row_missing_or_parent_mismatch",
        graphNodeCount: 3,
        initialWaitLineage: {
          proposalEventFound: true,
          requestResultTaskIdentityMapMatchesEventReceipt: true,
          eventReceiptTaskIdentityMapMatchesEmbeddedContent: false,
          embeddedContentTaskIdentityMapMatchesCurrentPersistedItem: false,
          embeddedContentTaskIdentityMapMatchesPayloadContent: true,
          proposalEventRevisionMatchesReceipt: true,
          proposalEventRevisionMatchesEmbeddedItem: true,
          proposalEventRevisionMatchesCurrentPersistedItemRow: false,
          eventReceiptEmbeddedTaskIdentityMapMismatchKeys: ["source", "summary", "verification"],
          embeddedCurrentPersistedTaskIdentityMapMismatchKeys: ["verification"],
          embeddedPayloadTaskIdentityMapMismatchKeys: ["source", "summary"],
          proposalReceiptFound: true, requestMatchesReceipt: true, requestMatchesCurrentGraph: true,
          proposalMatchesGraph: false, proposalRevisionMatchesGraph: true, persistedItemReadSucceeded: true,
          persistedItemFound: true, persistedItemValid: true, proposalMatchesPersistedItem: false,
          persistedItemMatchesGraph: true, planToolPairMatches: true, planExpectedRevisionMatches: true,
          proposalNodeCount: 3, graphNodeCount: 3, receiptRevision: 20, graphRevision: 20,
          persistedItemNodeCount: 3, persistedItemRevision: 20, requestedIdsOutsideReceiptCount: 0,
          requestedIdsOutsideGraphCount: 0, planToolUseCount: 1, planToolResultCount: 1,
          planExpectedRevision: 19, proposalEventRevision: 20,
          graphNodeKeysMissingReceipt: ["verification"],
          receiptPersistedMismatchKeys: ["source", "summary"], persistedGraphMismatchKeys: ["verification"],
        },
        waits: { count: 3, rootCount: 1, suspendedRootCount: 1 },
        targetCounts: { requested: 3, graphMatches: 3, taskRows: 3, graphRows: 3 },
        missingKeys: { requestedGraph: ["source"], graphTasks: ["summary"] },
        childStatusCounts: { failed: 1, completed: 2 },
      })],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)
    const truncationMarker = output.indexOf("...[truncated ")
    const boundedLine = output.slice(0, truncationMarker)

    expect(output.length).toBeLessThanOrEqual(1_600)
    expect(truncationMarker).toBeGreaterThan(0)
    expect(boundedLine).toContain('"requestResultTaskIdentityMapMatchesEventReceipt":true')
    expect(boundedLine).toContain('"eventReceiptTaskIdentityMapMatchesEmbeddedContent":false')
    expect(boundedLine).toContain('"embeddedContentTaskIdentityMapMatchesCurrentPersistedItem":false')
    expect(boundedLine).toContain('"embeddedContentTaskIdentityMapMatchesPayloadContent":true')
    expect(boundedLine).toContain('"proposalEventRevisionMatchesCurrentPersistedItemRow":false')
    expect(boundedLine).toContain('"eventReceiptEmbeddedTaskIdentityMapMismatchKeys":["source","summary","verification"]')
    expect(boundedLine).toContain('"embeddedCurrentPersistedTaskIdentityMapMismatchKeys":["verification"]')
    expect(boundedLine).toContain('"embeddedPayloadTaskIdentityMapMismatchKeys":["source","summary"]')
  })

  it("discards a long unknown JSON payload while keeping bounded safe diagnostics", () => {
    const longPayload = "marker-long-nested-payload-" + "x".repeat(1_700)
    const safeLine = "P3_PARENT_SUSPENSION_DIAGNOSTICS " + JSON.stringify({
      turnStatus: "failed", graphNodeCount: 2, likelyCause: "turn_failed",
      unknownNested: { payload: longPayload },
    })
    const child = {
      pid: 42, exitCode: null, signalCode: null,
      output: [safeLine, "marker-arbitrary-stdout"], errors: ["marker-raw-stderr"],
    } as unknown as ProcessFixtureChild

    const output = processFixtureDiagnostics(child)

    expect(output).toContain('"turnStatus":"failed"')
    expect(output).toContain('"graphNodeCount":2')
    expect(output).toContain('"likelyCause":"turn_failed"')
    expect(output).not.toContain(longPayload)
    expect(output).not.toContain("marker-arbitrary-stdout")
    expect(output).not.toContain("marker-raw-stderr")
    expect(output.length).toBeLessThanOrEqual(1_600)
  })

  it("redacts identifiers and arbitrary text while retaining safe status and counts", () => {
    const markers = [
      "marker-turn-id", "marker-session-id", "marker-task-id", "marker-wait-id", "marker-user-id",
      "marker-goal-text", "marker-idempotency-key", "marker-arbitrary-failure-message",
    ]
    const output = compactTurnProgressDiagnostics(JSON.stringify({
      turn: {
        id: markers[0], sessionId: markers[1], userId: markers[4], rootTaskId: markers[2],
        status: "failed", error: markers[7], revision: 7, leaseVersion: 3, leaseOwnerId: markers[5],
      },
      waitToolResult: {
        status: "failed", errorCode: markers[7], outputStatus: "waiting", waitId: markers[3],
        idempotencyKey: markers[6], matchedTaskIds: { count: 2 },
        truncated: { truncatedTaskResultCount: 1 },
      },
      waitLineage: {
        available: true, taskIdsMatchCurrentGraph: false, requestedTaskCount: 2, graphNodeCount: 2,
        proposalReceiptFound: true, proposalNodeCount: 4,
        requestMatchesReceipt: false, requestMatchesCurrentGraph: false,
        requestedIdsOutsideReceiptCount: 1,
        graphNodeKeysMissingRows: ["source", markers[2], "rejected"],
        fixtureNodeKeysMissingRows: ["source", markers[2], "summary", markers[5], "rejected"],
        waitItemFound: true, waitItemMatchesRoot: true, parentTaskFound: true,
        parentIdIsTurnRoot: true, parentSameSession: true, parentSameTurn: true,
        parentRootIsTurnRoot: true, parentHasNoParent: true, parentTaskMatchesUser: true,
        parentMismatchCounts: { id: 0, session: 0, turn: 0, root: 0, parent: 0, user: 0 },
        parentUserMismatchCount: 0,
        targetRows: {
          requestedCount: 2, foundCount: 2, allInExpectedScope: true, allSameUser: true,
          allSameSession: true, allSameTurn: true, allSameRoot: true, allSameParent: true,
          mismatchCounts: { missing: 0, user: 0, session: 0, turn: 0, root: 0, parent: 0 },
        },
      },
      diagnosticToolFailure: {
        toolName: "agent.wait", status: "failed", errorCode: markers[7], failureDetail: markers[7],
        idempotencyKey: markers[6],
      },
      diagnosticToolFailures: [
        { toolName: "agent.plan", status: "failed", errorCode: "task_graph_schedule_failed" },
        { toolName: "agent.wait", status: "failed", errorCode: markers[7] },
      ],
      executionFailures: [
        { eventType: "step.completed", status: "failed", errorCode: "business_precondition_failed" },
        { eventType: "turn.failed", errorCode: markers[7] },
      ],
      tasks: [{ id: markers[2], goal: markers[5], status: "failed", attemptCount: 2, failureReason: markers[7] }],
      waits: [{ id: markers[3], idempotencyKey: markers[6], status: "waiting", targetTaskIds: [markers[2]], matchedTaskIds: [] }],
      recentEvents: [{ taskId: markers[2], idempotencyKey: markers[6], error: markers[7] }],
      recentOutbox: [{ idempotencyKey: markers[6], lastError: markers[7] }],
    }), 3_000)

    expect(markers.some(marker => output.includes(marker)), "diagnostic output must omit marker values").toBe(false)
    expect(JSON.parse(output)).toMatchObject({
      turn: { status: "failed", errorCode: "other", revision: 7, leaseVersion: 3, errorPresent: true },
      waitToolResult: { status: "failed", outputStatus: "waiting", matchedTaskCount: 2, truncatedTaskResultCount: 1 },
      waitLineage: {
        taskIdsMatchCurrentGraph: false, requestedTaskCount: 2, graphNodeCount: 2,
        proposalReceiptFound: true, proposalNodeCount: 4,
        requestMatchesReceipt: false, requestMatchesCurrentGraph: false,
        requestedIdsOutsideReceiptCount: 1,
        graphNodeKeysMissingRows: ["source", "rejected"],
        fixtureNodeKeysMissingRows: ["source", "summary", "rejected"],
        targetRows: { requestedCount: 2, foundCount: 2, allInExpectedScope: true },
      },
      toolFailures: [
        { toolName: "agent.plan", status: "failed", errorCode: "task_graph_schedule_failed" },
        { toolName: "agent.wait", status: "failed", errorCode: "other" },
      ],
      executionFailures: [
        { eventType: "step.completed", status: "failed", errorCode: "business_precondition_failed" },
        { eventType: "turn.failed", status: null, errorCode: "other" },
      ],
      tasks: [{ goalPresent: true, status: "failed", attempts: 2, failureReasonPresent: true, failureReasonCode: "other" }],
      waits: [{ keyPresent: true, status: "waiting", targetCount: 1, matchedCount: 0 }],
    })
  })

  it.each(["wait_invalid", "wait_scope_error"])("projects DurableWaitHandoffError code %s and safe state flags", code => {
    const marker = "marker-sensitive-wait-handoff-value"
    const output = JSON.stringify(waitHandoffFailureProjection(JSON.stringify({
      waitId: marker,
      error: { name: "DurableWaitHandoffError", code, message: marker, sql: marker, details: { id: marker } },
      before: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turn: { status: "waiting_for_user", leaseOwnerPresent: true, leaseVersion: 4 },
        wait: { id: marker, status: "waiting", hasSuspendedAt: true, hasResolvedAt: false, hasConsumedAt: false },
      },
      after: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turn: { status: "failed", leaseOwnerPresent: false, leaseVersion: 5 },
        wait: { id: marker, status: "waiting", hasSuspendedAt: true, hasResolvedAt: false, hasConsumedAt: false },
      },
    })))

    expect(output).not.toContain(marker)
    expect(JSON.parse(output)).toMatchObject({
      captured: true,
      errorName: "DurableWaitHandoffError",
      errorCode: code,
      handoffGate: "other",
      before: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turnStatus: "waiting_for_user", turnLeaseOwnerPresent: true, waitStatus: "waiting", hasSuspendedAt: true,
      },
      after: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turnStatus: "failed", turnLeaseOwnerPresent: false, turnLeaseVersion: 5, waitStatus: "waiting",
      },
    })
  })

  it("projects the terminal closed wait status", () => {
    const projected = waitHandoffFailureProjection(JSON.stringify({
      error: { name: "DurableWaitHandoffError", code: "wait_scope_error", message: "private detail" },
      before: {
        snapshotReadSucceeded: true, turnFound: true, waitFound: true,
        turn: { status: "in_progress", leaseOwnerPresent: true, leaseVersion: 1 },
        wait: { status: "closed", hasSuspendedAt: true, hasResolvedAt: true, hasConsumedAt: true },
      },
    }))

    expect(projected).toMatchObject({ before: { waitStatus: "closed", hasResolvedAt: true } })
    expect(JSON.stringify(projected)).not.toContain("private detail")
  })

  it.each([
    { name: "Error", code: "40P01" }, { name: "Error", code: "40001" },
    { name: "Error", code: "55P03" }, { name: "Error", code: "57014" },
    { name: "Error", code: "23505" }, { name: "Error", code: "23503" },
    { name: "WaitHandoffUnavailable", code: "wait_handoff_unavailable" },
    { name: "DurableWaitHandoffError", code: "wait_invalid" },
    { name: "DurableWaitHandoffError", code: "wait_scope_error" },
    { name: "TurnLeaseError", code: "lease_lost" },
  ])("preserves known wait-handoff error identifiers $name/$code", ({ name, code }) => {
    const projected = waitHandoffFailureProjection(JSON.stringify({ error: { name, code, message: "unprojected" } }))
    expect(projected).toMatchObject({ errorName: name, errorCode: code })
  })

  it.each([
    ["DurableWaitHandoffError", "Session is unavailable", "session_unavailable"],
    ["DurableWaitHandoffError", "Wait parent is outside the root Turn scope", "wait_root_scope_mismatch"],
    ["DurableWaitHandoffError", "Wait step is not the current attempt", "wait_step_not_current"],
    ["DurableWaitHandoffError", "Wait condition is already closed", "wait_already_closed"],
    ["DurableWaitHandoffError", "Wait changed during handoff", "wait_changed_during_handoff"],
    ["TurnLeaseError", "Turn lease was fenced before wait handoff", "lease_fenced_before_handoff"],
    ["Error", "wait_resume_event_conflict", "resume_event_conflict"],
    ["Error", "wait_resume_session_sequence_unavailable", "resume_session_sequence_unavailable"],
    ["Error", "wait_resume_outbox_conflict", "resume_outbox_conflict"],
  ])("maps only known handoff gates to labels", (name, message, handoffGate) => {
    const projected = waitHandoffFailureProjection(JSON.stringify({
      error: { name, code: name === "TurnLeaseError" ? "lease_lost" : "wait_scope_error", message },
    }))
    expect(projected).toMatchObject({ handoffGate })
    expect(JSON.stringify(projected)).not.toContain(message)
  })

  it("distinguishes successful empty reads from failed snapshot reads", () => {
    const marker = "private-diagnostic-read-error"
    const projected = waitHandoffFailureProjection(JSON.stringify({
      error: { name: "DurableWaitHandoffError", code: "wait_scope_error", message: "unknown gate" },
      before: { snapshotReadSucceeded: true, turnFound: false, waitFound: false },
      after: {
        snapshotReadSucceeded: false, turnFound: false, waitFound: false,
        diagnosticError: { message: marker, query: marker },
      },
    }))
    const output = JSON.stringify(projected)

    expect(output).not.toContain(marker)
    expect(projected).toMatchObject({
      before: { snapshotReadSucceeded: true, turnFound: false, waitFound: false },
      after: { snapshotReadSucceeded: false, turnFound: false, waitFound: false },
    })
  })

  it("redacts unrecognized wait-handoff errors and arbitrary details", () => {
    const marker = "unapproved-wait-handoff-error-value"
    const output = JSON.stringify(waitHandoffFailureProjection(JSON.stringify({
      waitId: marker,
      error: { name: "UnrecognizedWaitHandoffError", code: marker, message: marker, sql: marker, details: { id: marker } },
      before: {
        snapshotReadSucceeded: false, turnFound: false, waitFound: false,
        diagnosticError: { message: marker, query: marker },
      },
    })))

    expect(output).not.toContain(marker)
    expect(JSON.parse(output)).toEqual({
      captured: true,
      errorName: "other",
      errorCode: "other",
      handoffGate: "other",
      before: {
        snapshotReadSucceeded: false,
        turnFound: false,
        waitFound: false,
        turnStatus: null,
        turnLeaseOwnerPresent: false,
        turnLeaseVersion: null,
        waitStatus: null,
        hasSuspendedAt: false,
        hasResolvedAt: false,
        hasConsumedAt: false,
      },
      after: null,
    })
  })
})

describe("canonical verifier receipt diagnostics", () => {
  it("projects only allowlisted shape metadata and never emits receipt identifiers or content", () => {
    const scope = { userId: "private-user-id", sessionId: "private-session-id", turnId: "private-turn-id", ownerId: "private-owner-id", suffix: "fixture" }
    const tasks: DiscoveryVerifierTask[] = [{
      id: "private-task-id", role: "scout", status: "failed", attemptCount: 1,
      rootTaskId: "private-root-id", parentTaskId: "private-root-id",
    }]
    const items: RecordValue[] = [
      { id: "private-call-item", sessionId: scope.sessionId, turnId: scope.turnId, userId: scope.userId, turnUserId: scope.userId,
        taskId: tasks[0]!.id, rootTaskId: tasks[0]!.rootTaskId, turnRootTaskId: tasks[0]!.rootTaskId,
        joinedStepId: "private-step-id", stepId: "private-step-id", type: "tool_call", status: "completed", revision: 1,
        stepStatus: "completed", attempt: 1, ordinal: 0,
        content: { toolCallId: "private-call-id", toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null } },
      { id: "private-result-item", sessionId: scope.sessionId, turnId: scope.turnId, userId: scope.userId, turnUserId: scope.userId,
        taskId: tasks[0]!.id, rootTaskId: tasks[0]!.rootTaskId, turnRootTaskId: tasks[0]!.rootTaskId,
        joinedStepId: "private-step-id", stepId: "private-step-id", type: "tool_result", status: "completed", revision: 1,
        stepStatus: "completed", attempt: 1, ordinal: 0,
        content: { toolCallId: "private-call-id", output: { jobs: [{ id: "private-job-id", source: "fixture" }], summary: "private-result-text" }, errorCode: null } },
    ]
    const events: RecordValue[] = [
      { taskId: tasks[0]!.id, itemId: "private-call-item", correlationId: "private-call-id", type: "tool_call.started", sequence: 1,
        payload: { taskId: tasks[0]!.id, toolCallId: "private-call-id", toolName: "jobs.search" } },
      { taskId: tasks[0]!.id, itemId: "private-call-item", correlationId: "private-call-id", type: "tool_call.completed", sequence: 2,
        payload: { taskId: tasks[0]!.id, toolCallId: "private-call-id", toolName: "jobs.search", status: "completed", errorCode: null } },
    ]
    const detached = events.map(event => ({ ...event, itemId: null }))
    const projected = projectDiscoveryVerifierDiagnostics(tasks, items, [...events, ...detached], scope)
    const badLinked = projectDiscoveryVerifierDiagnostics(tasks, items, [
      ...events,
      { ...events[1]!, taskId: "foreign-task-id", correlationId: "foreign-call-id" },
    ], scope)
    const encoded = JSON.stringify({ projected, badLinked })

    expect(projected).toMatchObject([{
      role: "scout", itemScopeValid: true, itemAttemptValid: true, itemShapeValid: true,
      pairShapeValid: true, contentPairValid: true, eventCount: 2, startedEventCount: 1, terminalEventCount: 1,
      unmatchedEvents: 0, eventIdentityValid: true, eventPairsValid: true,
      jobsSearchOutputs: [{ jobsArray: true, jobsCount: 1, jobsCountWithinVerifierCap: true, jobsDense: true, jobIdsValid: true, sourcesValid: true }],
    }])
    expect(badLinked).toMatchObject([{
      eventCount: 3, startedEventCount: 1, terminalEventCount: 2,
      eventIdentityValid: false, eventPairsValid: false,
    }])
    for (const secret of [scope.userId, scope.sessionId, scope.turnId, scope.ownerId, tasks[0]!.id, tasks[0]!.rootTaskId!, "private-step-id", "private-call-id", "private-job-id", "private-result-text"]) {
      expect(encoded).not.toContain(secret)
    }
  })
})

describe("process-restart verifier evidence diagnostics", () => {
  it("keeps only bounded enums, counts, booleans, and the latest markers", () => {
    const marker = (attempt: number, overrides: RecordValue = {}) =>
      `${PROCESS_RESTART_VERIFIER_EVIDENCE_PREFIX}${JSON.stringify({
        role: "analyst", attempt, childStatus: "completed", resultStatus: "completed",
        structuredResultStatus: "completed", claimCount: 1234, claimJobIdMatches: [true, false],
        structuredEvidenceCount: 1, jobEvidenceCount: 1,
        jobEvidence: [{ refMatchesRequestedJob: true, source: "greenhouse", id: "private-id", content: "private-job" }],
        persistedSearchOutputCount: 1, persistedSearchOutputLimitReached: false,
        persistedReads: [{ itemStatus: "completed", callStatus: "completed", hasErrorCode: false,
          jobsType: "array", jobCount: 500, jobsValidShape: true, matchingJobCount: 1,
          matchingJobSources: ["greenhouse", "private-source"], evidenceSourceMatches: true,
          rawSql: "private-sql" }], privateField: "private-value", ...overrides,
      })}`
    const output = [marker(1), marker(2), marker(3), marker(4), marker(5), marker(6)]
    const projected = processRestartVerifierEvidenceDiagnostics(output)
    const encoded = JSON.stringify(projected)

    expect(projected).toMatchObject({
      markerCount: 4, markerLimitReached: true,
      markers: [{ attempt: 3 }, { attempt: 4 }, { attempt: 5 }, {
        attempt: 6, role: "analyst", childStatus: "completed", claimCount: 99,
        claimJobIdMatches: [true, false], jobEvidence: [{ refMatchesRequestedJob: true, source: "greenhouse" }],
        persistedReads: [{ jobCount: 99, matchingJobSources: ["greenhouse", "other"], evidenceSourceMatches: true }],
      }],
    })
    for (const secret of ["private-id", "private-job", "private-source", "private-sql", "private-value"]) {
      expect(encoded).not.toContain(secret)
    }
  })

  it("rejects malformed or oversized marker lines", () => {
    const malformed = `${PROCESS_RESTART_VERIFIER_EVIDENCE_PREFIX}{not-json}`
    const oversized = `${PROCESS_RESTART_VERIFIER_EVIDENCE_PREFIX}${"x".repeat(PROCESS_RESTART_VERIFIER_EVIDENCE_MAX_BYTES)}`
    expect(processRestartVerifierEvidenceDiagnostics([malformed, oversized])).toEqual({
      markerCount: 2,
      markerLimitReached: false,
      markers: [{ diagnosticUnavailable: true }, { diagnosticUnavailable: true }],
    })
  })
})

describe("Worker 2 private artifact fixture boundary", () => {
  it("rejects private body and artifact references at any fixture input depth", async () => {
    const worker = startTaskGraphRestartWorker("worker2-input-guard-self-test", {})
    await waitForProcessExit(worker, 45_000)
    expect(worker.exitCode).toBe(0)
    expect(worker.output).toContain("P3_PRIVATE_FIXTURE_GUARD_OK")
    expect(worker.errors).toEqual([])
  }, 60_000)
})

describe("TaskGraph exact fixture queue cleanup", () => {
  const identity: FixtureQueueJobIdentity = {
    queueName: "fixture-turn-queue", kind: "turn", jobId: turnJobId("cleanup-turn", 2),
    sessionId: "cleanup-session", turnId: "cleanup-turn", ownerId: "cleanup-owner", generation: 2,
    currentGeneration: false,
  }
  const payload = { turnId: identity.turnId, sessionId: identity.sessionId, ownerId: identity.ownerId }

  function queueFixture(job: FixtureCleanupJob | undefined) {
    return {
      queue: {
        name: identity.queueName,
        toKey: (jobId: string) => `bull:${identity.queueName}:${jobId}`,
        getJob: vi.fn(async (jobId: string) => job?.id === jobId ? job : undefined),
      } satisfies FixtureCleanupQueue,
      redis: { del: vi.fn(async (_key: string) => 1) } satisfies FixtureRedisConnection,
    }
  }

  it("removes only an exact owned active job after its SIGKILL worker exited", async () => {
    const calls: string[] = []
    const job: FixtureCleanupJob = {
      id: identity.jobId, name: "turn", data: payload,
      getState: vi.fn(async () => "active"),
      remove: vi.fn(async () => { calls.push("remove") }),
    }
    const { queue, redis: redisConnection } = queueFixture(job)
    const killedWorker = {
      exitCode: null, signalCode: "SIGKILL", terminationSignal: "SIGKILL",
      fixtureScopes: [{ sessionId: identity.sessionId, turnId: identity.turnId }],
      staleBullJobKeys: new Set([fixtureJobIdentityKey(identity.queueName, identity.jobId)]),
    } as unknown as ProcessFixtureChild
    const exactSigkillOwner = processFixtureProvesExactSigkill(killedWorker, identity)
    redisConnection.del.mockImplementation(async key => { calls.push("del:" + key); return 1 })

    await expect(removeExactFixtureQueueJob(identity, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner,
    })).resolves.toBe("removed")
    expect(queue.getJob).toHaveBeenCalledWith(identity.jobId)
    expect(redisConnection.del).toHaveBeenCalledWith(`bull:${identity.queueName}:${identity.jobId}:lock`)
    expect(job.remove).toHaveBeenCalledTimes(1)
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain(":lock")
    expect(calls[1]).toBe("remove")
  })

  it("treats an exact already-absent fixture job as idempotent", async () => {
    const { queue, redis: redisConnection } = queueFixture(undefined)
    await expect(removeExactFixtureQueueJob(identity, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).resolves.toBe("absent")
    expect(queue.getJob).toHaveBeenCalledWith(identity.jobId)
    expect(redisConnection.del).not.toHaveBeenCalled()
  })

  it("refuses active cleanup while a fixture worker may still be alive", async () => {
    const job: FixtureCleanupJob = {
      id: identity.jobId, name: "turn", data: payload,
      getState: vi.fn(async () => "active"), remove: vi.fn(async () => undefined),
    }
    const { queue, redis: redisConnection } = queueFixture(job)
    await expect(removeExactFixtureQueueJob(identity, queue, redisConnection, {
      allWorkersExited: false, exactSigkillOwner: true,
    })).rejects.toThrow("Fixture queue workers are not proven exited")
    expect(queue.getJob).not.toHaveBeenCalled()
    expect(redisConnection.del).not.toHaveBeenCalled()
    expect(job.remove).not.toHaveBeenCalled()
  })

  it("does not treat a task-start marker as generation-specific subagent lock proof", async () => {
    const subagentIdentity: FixtureQueueJobIdentity = {
      queueName: "fixture-subagent-queue", kind: "subagent", jobId: subagentDispatchJobId("cleanup-task", 2),
      sessionId: identity.sessionId, turnId: identity.turnId, taskId: "cleanup-task", rootTaskId: "cleanup-root",
      ownerId: identity.ownerId, generation: 2, currentGeneration: false,
    }
    const child = {
      exitCode: 0, signalCode: "SIGKILL", terminationSignal: "SIGKILL",
      fixtureScopes: [{ sessionId: identity.sessionId, turnId: identity.turnId }],
      output: ["P3_DISCOVERY_CHILD_STARTED cleanup-task scout"],
    } as unknown as ProcessFixtureChild
    expect(processFixtureProvesExactSigkill(child, subagentIdentity)).toBe(false)

    const job: FixtureCleanupJob = {
      id: subagentIdentity.jobId, name: "subagent",
      data: { taskId: subagentIdentity.taskId, sessionId: subagentIdentity.sessionId,
        rootTaskId: subagentIdentity.rootTaskId, ownerId: subagentIdentity.ownerId },
      getState: vi.fn(async () => "active"), remove: vi.fn(async () => undefined),
    }
    const queue: FixtureCleanupQueue = {
      name: subagentIdentity.queueName,
      toKey: jobId => `bull:${subagentIdentity.queueName}:${jobId}`,
      getJob: vi.fn(async jobId => jobId === subagentIdentity.jobId ? job : undefined),
    }
    const redisConnection = { del: vi.fn(async () => 1) }
    await expect(removeExactFixtureQueueJob(subagentIdentity, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: true,
    })).rejects.toThrow("Active fixture job has no exact exited SIGKILL owner proof")
    expect(redisConnection.del).not.toHaveBeenCalled()
    expect(job.remove).not.toHaveBeenCalled()
  })

  it("preserves fixture owner rows if any queue identity cleanup fails", () => {
    const failuresBeforeQueueCleanup = 3
    const failuresAfterFailedRemoval = failuresBeforeQueueCleanup + 1
    expect(fixtureOwnerRowsMayBeDeleted(true, failuresBeforeQueueCleanup, failuresAfterFailedRemoval)).toBe(false)
    expect(fixtureOwnerRowsMayBeDeleted(false, failuresBeforeQueueCleanup, failuresBeforeQueueCleanup)).toBe(false)
    expect(fixtureOwnerRowsMayBeDeleted(true, failuresBeforeQueueCleanup, failuresBeforeQueueCleanup)).toBe(true)
  })

  it("refuses a foreign job payload and an unrecognized queue identity without mutation", async () => {
    const job: FixtureCleanupJob = {
      id: identity.jobId, name: "turn", data: { ...payload, sessionId: "foreign-session" },
      getState: vi.fn(async () => "active"), remove: vi.fn(async () => undefined),
    }
    const { queue, redis: redisConnection } = queueFixture(job)
    await expect(removeExactFixtureQueueJob(identity, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: true,
    })).rejects.toThrow("Fixture queue job does not match its owner-fenced identity")
    const foreignQueueIdentity = { ...identity, queueName: "foreign-queue" }
    await expect(removeExactFixtureQueueJob(foreignQueueIdentity, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: true,
    })).rejects.toThrow("Fixture queue job identity is unrecognized")
    expect(redisConnection.del).not.toHaveBeenCalled()
    expect(job.remove).not.toHaveBeenCalled()
  })

  it("cleans exact Turn jobs using the persisted resume or wakeup dispatch owner", async () => {
    const resumedPayload = fixtureTurnDispatchPayloadForOwner({ ...payload, ownerId: "resume:accepted-steer-event" }, identity)
    const wakeupPayload = fixtureTurnDispatchPayloadForOwner({ ...payload, ownerId: "wakeup:recovery-event" }, identity)
    expect(resumedPayload).toEqual({ ...payload, ownerId: "resume:accepted-steer-event" })
    expect(wakeupPayload).toEqual({ ...payload, ownerId: "wakeup:recovery-event" })

    const job: FixtureCleanupJob = {
      id: identity.jobId, name: "turn", data: resumedPayload,
      getState: vi.fn(async () => "waiting"), remove: vi.fn(async () => undefined),
    }
    const { queue, redis: redisConnection } = queueFixture(job)
    await expect(removeExactFixtureQueueJob({ ...identity, ownerId: resumedPayload!.ownerId }, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).resolves.toBe("removed")
    expect(queue.getJob).toHaveBeenCalledWith(identity.jobId)
    expect(job.remove).toHaveBeenCalledTimes(1)
    expect(redisConnection.del).not.toHaveBeenCalled()
  })

  it("binds prior owners only to already-derived historical Turn generations", async () => {
    const historical = { ...identity, ownerId: "current-resume-owner", currentGeneration: false }
    const priorOwnerJob: FixtureCleanupJob = {
      id: historical.jobId, name: "turn", data: { ...payload, ownerId: "initial-owner" },
      getState: vi.fn(async () => "waiting"), remove: vi.fn(async () => undefined),
    }
    const historicalFixture = queueFixture(priorOwnerJob)
    await expect(removeExactFixtureQueueJob(historical, historicalFixture.queue, historicalFixture.redis, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).resolves.toBe("removed")
    expect(priorOwnerJob.remove).toHaveBeenCalledTimes(1)
    expect(historicalFixture.redis.del).not.toHaveBeenCalled()

    const current = { ...historical, currentGeneration: true }
    const driftedCurrentJob: FixtureCleanupJob = {
      id: current.jobId, name: "turn", data: { ...payload, ownerId: "initial-owner" },
      getState: vi.fn(async () => "waiting"), remove: vi.fn(async () => undefined),
    }
    const currentFixture = queueFixture(driftedCurrentJob)
    await expect(removeExactFixtureQueueJob(current, currentFixture.queue, currentFixture.redis, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).rejects.toThrow("Fixture queue job does not match its owner-fenced identity")
    expect(driftedCurrentJob.remove).not.toHaveBeenCalled()
    expect(currentFixture.redis.del).not.toHaveBeenCalled()
  })

  it("does not infer active-lock permission from a historical Turn owner", async () => {
    const historical = { ...identity, ownerId: "current-resume-owner", currentGeneration: false }
    const job: FixtureCleanupJob = {
      id: historical.jobId, name: "turn", data: { ...payload, ownerId: "initial-owner" },
      getState: vi.fn(async () => "active"), remove: vi.fn(async () => undefined),
    }
    const { queue, redis: redisConnection } = queueFixture(job)
    await expect(removeExactFixtureQueueJob(historical, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).rejects.toThrow("Active fixture job has no exact exited SIGKILL owner proof")
    expect(redisConnection.del).not.toHaveBeenCalled()
    expect(job.remove).not.toHaveBeenCalled()
  })

  it("allows historical child owner drift only with exact task and root bindings", async () => {
    const historical: FixtureQueueJobIdentity = {
      queueName: "fixture-subagent-queue", kind: "subagent", jobId: subagentDispatchJobId("cleanup-task", 2),
      sessionId: identity.sessionId, turnId: identity.turnId, taskId: "cleanup-task", rootTaskId: "cleanup-root",
      ownerId: "current-child-owner", generation: 2, currentGeneration: false,
    }
    const job: FixtureCleanupJob = {
      id: historical.jobId, name: "subagent",
      data: { taskId: historical.taskId, sessionId: historical.sessionId, rootTaskId: historical.rootTaskId, ownerId: "prior-child-owner" },
      getState: vi.fn(async () => "waiting"), remove: vi.fn(async () => undefined),
    }
    const queue: FixtureCleanupQueue = {
      name: historical.queueName,
      toKey: jobId => `bull:${historical.queueName}:${jobId}`,
      getJob: vi.fn(async jobId => jobId === historical.jobId ? job : undefined),
    }
    const redisConnection = { del: vi.fn(async () => 1) }
    await expect(removeExactFixtureQueueJob(historical, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).resolves.toBe("removed")
    expect(job.remove).toHaveBeenCalledTimes(1)

    const foreignRootJob: FixtureCleanupJob = {
      ...job, data: { taskId: historical.taskId, sessionId: historical.sessionId, rootTaskId: "foreign-root", ownerId: "prior-child-owner" },
      remove: vi.fn(async () => undefined),
    }
    const foreignRootQueue: FixtureCleanupQueue = {
      ...queue, getJob: vi.fn(async jobId => jobId === historical.jobId ? foreignRootJob : undefined),
    }
    await expect(removeExactFixtureQueueJob(historical, foreignRootQueue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).rejects.toThrow("Fixture queue job does not match its owner-fenced identity")
    expect(foreignRootJob.remove).not.toHaveBeenCalled()
    expect(redisConnection.del).not.toHaveBeenCalled()
  })

  it("rejects malformed owner data on historical jobs instead of treating it as a match", async () => {
    const historical = { ...identity, currentGeneration: false }
    const job: FixtureCleanupJob = {
      id: historical.jobId, name: "turn", data: { ...payload, ownerId: " " },
      getState: vi.fn(async () => "waiting"), remove: vi.fn(async () => undefined),
    }
    const { queue, redis: redisConnection } = queueFixture(job)
    await expect(removeExactFixtureQueueJob(historical, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).rejects.toThrow("Fixture queue job does not match its owner-fenced identity")
    expect(job.remove).not.toHaveBeenCalled()
    expect(redisConnection.del).not.toHaveBeenCalled()
  })

  it("rejects malformed or cross-Turn dispatch payloads when deriving cleanup ownership", () => {
    expect(fixtureTurnDispatchPayloadForOwner({ ...payload, sessionId: "foreign-session" }, identity)).toBeNull()
    expect(fixtureTurnDispatchPayloadForOwner({ ...payload, turnId: "foreign-turn" }, identity)).toBeNull()
    expect(fixtureTurnDispatchPayloadForOwner({ ...payload, unexpected: true }, identity)).toBeNull()
  })

  it("refuses a job ID that does not encode the exact derived generation", async () => {
    const { queue, redis: redisConnection } = queueFixture(undefined)
    const mismatchedGeneration = { ...identity, generation: identity.generation + 1 }
    await expect(removeExactFixtureQueueJob(mismatchedGeneration, queue, redisConnection, {
      allWorkersExited: true, exactSigkillOwner: false,
    })).rejects.toThrow("Fixture queue job identity is unrecognized")
    expect(queue.getJob).not.toHaveBeenCalled()
    expect(redisConnection.del).not.toHaveBeenCalled()
  })

  it("enumerates only published generations and one current unpublished generation", () => {
    expect(fixtureDispatchGenerations(1, new Date("2026-01-01T00:00:00.000Z"))).toEqual([
      { generation: 0, currentGeneration: true },
    ])
    expect(fixtureDispatchGenerations(1, null)).toEqual([
      { generation: 0, currentGeneration: false },
      { generation: 1, currentGeneration: true },
    ])
    expect(fixtureDispatchGenerations(0, null)).toEqual([{ generation: 0, currentGeneration: true }])
    expect(() => fixtureDispatchGenerations(0, new Date("2026-01-01T00:00:00.000Z"))).toThrow(
      "Fixture dispatch generation is outside its cleanup bound",
    )
    expect(() => fixtureDispatchGenerations(FIXTURE_DISPATCH_GENERATION_LIMIT + 1, null)).toThrow(
      "Fixture dispatch generation is outside its cleanup bound",
    )
  })
})

describe("TaskGraph restart fixture service boundary", () => {
  it("rejects unsafe PostgreSQL or Redis endpoints before production startup", async () => {
    const unsafeEnvironmentCases = [
      {
        AGENT_RUNTIME_PG_TEST_URL: "not-a-postgres-url",
        AGENT_TURN_REDIS_TEST_URL: "http://127.0.0.1:6379/14",
        REDIS_URL: "http://127.0.0.1:6379/14",
      },
      {
        AGENT_RUNTIME_PG_TEST_URL: "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci",
        AGENT_TURN_REDIS_TEST_URL: "http://127.0.0.1:6379/14",
        REDIS_URL: "http://127.0.0.1:6379/14",
      },
    ]
    for (const envOverrides of unsafeEnvironmentCases) {
      const worker = startTaskGraphRestartWorker("park-parent", {}, {
        CI: "true",
        AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true",
        AGENT_TURN_REDIS_TEST_DISPOSABLE: "true",
        ...envOverrides,
      })
      await waitForProcessExit(worker, 45_000)
      expect(worker.exitCode).toBe(1)
      expect(worker.errors.join("\n")).toContain("p3_restart_fixture_rejects_non_disposable_service_urls")
      expect(worker.output).not.toContain("P3_FIRST_WORKER_START_RUNTIME_BEGIN")
    }
  }, 120_000)
})

describe("TaskGraph repair wait model-visible outcome fixture", () => {
  const taskIds = ["repair-task", "analyst-1", "analyst-2", "analyst-3", "analyst-4", "analyst-5", "analyst-6"]
  const requestWithResults = (results: readonly { toolUseId: string; value: unknown }[]) => ({
    messages: results.flatMap(result => [
      { role: "assistant", content: [{
        type: "tool_use", id: result.toolUseId, name: "agent.wait", input: { taskIds, mode: "all" },
      }] },
      { role: "tool", content: [{
        type: "tool_result", toolUseId: result.toolUseId, content: JSON.stringify(result.value),
      }] },
    ]),
  } as unknown as HarnessModelRequest)

  it("uses the exact hydrated wait channel instead of the immutable waiting receipt", () => {
    const original = { waitId: "wait-repair-1", status: "waiting", taskIds, matchedTaskIds: [] }
    const resolved = {
      waitId: "wait-repair-1", status: "ready", targetTaskIds: taskIds, matchedTaskIds: taskIds,
      tasks: taskIds.map(taskId => ({ taskId, status: "completed" })),
    }
    const request = requestWithResults([
      { toolUseId: "repair-wait-call", value: original },
      { toolUseId: "wait:wait-repair-1", value: resolved },
    ])

    expect(latestToolResult(request, "repair-wait-call")).toEqual(original)
    expect(repairWaitOutcomeFromRequest(request, "repair-wait-call", taskIds)).toEqual(resolved)
  })

  it("keeps immediate ready outcomes and rejects missing or mismatched resumed identity", () => {
    const directReady = {
      waitId: "wait-ready-1", status: "ready", taskIds, matchedTaskIds: taskIds,
      tasks: taskIds.map(taskId => ({ taskId, status: "completed" })),
    }
    expect(repairWaitOutcomeFromRequest(
      requestWithResults([{ toolUseId: "ready-call", value: directReady }]), "ready-call", taskIds,
    )).toEqual(directReady)

    const waiting = { waitId: "wait-repair-2", status: "waiting", taskIds, matchedTaskIds: [] }
    expect(() => repairWaitOutcomeFromRequest(
      requestWithResults([{ toolUseId: "waiting-call", value: waiting }]), "waiting-call", taskIds,
    )).toThrow("exact resolved wait outcome")
    expect(() => repairWaitOutcomeFromRequest(
      requestWithResults([
        { toolUseId: "waiting-call", value: waiting },
        { toolUseId: "wait:wait-repair-2", value: { ...directReady, waitId: "other-wait" } },
      ]), "waiting-call", taskIds,
    )).toThrow("exact resolved wait outcome")
  })

  it("projects only bounded wait-reference diagnostics", () => {
    expect(repairWaitReferenceSizeBytes({ $ref: "private-reference-id", sizeBytes: 18_433, sha256: "private-digest" })).toBe(18_433)
    expect(repairWaitReferenceSizeBytes({ sizeBytes: -1 })).toBeNull()
    expect(repairWaitReferenceSizeBytes({ sizeBytes: 1.5 })).toBeNull()
    expect(repairWaitReferenceSizeBytes({ sizeBytes: 1_048_576 })).toBe(1_048_576)
    expect(repairWaitReferenceSizeBytes({ sizeBytes: 1_048_577 })).toBeNull()
    expect(repairWaitReferenceSizeBytes({ sizeBytes: "private-value" })).toBeNull()
    expect(repairWaitFailureClass(new Error("repair_wait_reference_invalid"))).toBe("reference_invalid")
    expect(repairWaitFailureClass(new Error("__proto__"))).toBe("other")
    expect(repairWaitFailureClass(new Error("constructor"))).toBe("other")
    expect(repairWaitFailureClass(new Error("private provider or result text"))).toBe("other")
    expect(repairWaitFailureErrorKind(new Error("private message"))).toBe("error")
    expect(repairWaitFailureErrorKind(new TypeError("private type message"))).toBe("type_error")
    expect(repairWaitFailureErrorKind(new RangeError("private range message"))).toBe("range_error")
    expect(repairWaitFailureErrorKind(new SyntaxError("private syntax message"))).toBe("syntax_error")
    expect(repairWaitFailureErrorKind("private thrown value")).toBe("non_error")
    const messageGuardedError = new Error()
    Object.defineProperty(messageGuardedError, "message", { get: () => { throw new Error("private getter") } })
    expect(repairWaitFailureErrorKind(messageGuardedError)).toBe("error")
    const prototypeGuardedError = new Proxy(new Error("private proxy message"), {
      getPrototypeOf: () => { throw new Error("private proxy trap") },
    })
    expect(repairWaitFailureErrorKind(prototypeGuardedError)).toBe("non_error")
    expect(boundedRepairWaitDiagnosticCount(-1)).toBe(0)
    expect(boundedRepairWaitDiagnosticCount(1.5)).toBe(0)
    expect(boundedRepairWaitDiagnosticCount(0)).toBe(0)
    expect(boundedRepairWaitDiagnosticCount(8)).toBe(8)
    expect(boundedRepairWaitDiagnosticCount(9)).toBe(8)
    expect(boundedRepairWaitDiagnosticCount("private count")).toBe(0)
    expect(repairWaitOutcomeDiagnosticStatus({ status: "ready" })).toBe("ready")
    expect(repairWaitOutcomeDiagnosticStatus({ status: "timed_out" })).toBe("timed_out")
    expect(repairWaitOutcomeDiagnosticStatus({ status: "waiting" })).toBe("waiting")
    expect(repairWaitOutcomeDiagnosticStatus({ status: "private status and id" })).toBe("other")
    expect(repairWaitOutcomeDiagnosticStatus({ status: { private: "payload" } })).toBe("unavailable")
    expect(JSON.stringify([
      repairWaitOutcomeDiagnosticStatus({ status: "private status and id" }),
      boundedRepairWaitDiagnosticCount("private count"),
      repairWaitFailureErrorKind(new TypeError("private type message")),
      repairWaitFailureErrorKind("private thrown value"),
    ])).not.toContain("private")
  })

  it("reassembles the exact bounded wait JSON from model-visible reference reads", () => {
    const output = {
      waitId: "wait-ready-reference-1", status: "ready", taskIds,
      targetTaskIds: taskIds, matchedTaskIds: taskIds,
      tasks: taskIds.map((taskId, index) => ({
        taskId, status: "completed", role: index === 0 ? "scout" : "analyst",
        result: { truncated: true, summary: "Résumé evidence ".repeat(100) },
      })),
    }
    const encoded = JSON.stringify(output)
    const bytes = Buffer.from(encoded, "utf8")
    const ref = "tool-result-00000000-0000-4000-8000-000000000001"
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    expect(bytes.byteLength).toBeGreaterThan(8 * 1024)
    expect(bytes.byteLength).toBeLessThanOrEqual(VERIFICATION_REPAIR_WAIT_OUTPUT_BYTE_LIMIT)
    const reference = { $ref: ref, sizeBytes: bytes.byteLength, sha256 }
    const messages: unknown[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "repair-wait-call", name: "agent.wait", input: { taskIds, mode: "all" } }] },
      { role: "tool", content: [{ type: "tool_result", toolUseId: "repair-wait-call", content: JSON.stringify(reference) }] },
    ]
    const readCallIds: string[] = []
    let cursor = 0
    while (cursor < bytes.length) {
      let end = Math.min(bytes.length, cursor + 2_048)
      while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1
      const callId = `repair-wait-read-${readCallIds.length + 1}`
      const chunk = bytes.subarray(cursor, end).toString("utf8")
      const nextCursor = end < bytes.length ? String(end) : null
      readCallIds.push(callId)
      messages.push({ role: "assistant", content: [{
        type: "tool_use", id: callId, name: "tool_results.read",
        input: { referenceId: ref, ...(cursor === 0 ? {} : { cursor: String(cursor) }) },
      }] })
      messages.push({ role: "tool", content: [{ type: "tool_result", toolUseId: callId, content: JSON.stringify({
        ref, sha256, byteCount: bytes.byteLength, chunk, nextCursor,
      }) }] })
      cursor = end
    }
    expect(readCallIds.length).toBeLessThanOrEqual(VERIFICATION_REPAIR_MAX_REFERENCE_READS)
    const request = { messages } as unknown as HarnessModelRequest
    const resolution = repairWaitOutputResolutionFromRequest(request, "repair-wait-call", readCallIds)
    expect(resolution).toMatchObject({
      status: "complete", reference: { id: ref, sizeBytes: bytes.byteLength, sha256 }, readCount: readCallIds.length,
    })
    if (resolution.status !== "complete") throw new Error("synthetic wait reference was not completely read")
    expect(resolution.output).toEqual(output)
    expect(repairWaitOutcomeFromRequest(request, "repair-wait-call", taskIds, resolution.output)).toEqual(output)
  })

  it("rejects malformed references and foreign, replayed, or digest-mismatched reads", () => {
    const output = { waitId: "wait-ready-reference-2", status: "ready", taskIds, targetTaskIds: taskIds, matchedTaskIds: taskIds, tasks: taskIds.map(taskId => ({ taskId, status: "completed", result: { truncated: true, summary: "Archived fixture evidence ".repeat(75) } })) }
    const encoded = JSON.stringify(output)
    const bytes = Buffer.from(encoded, "utf8")
    const ref = "tool-result-00000000-0000-4000-8000-000000000002"
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const reference = { $ref: ref, sizeBytes: bytes.byteLength, sha256 }
    expect(bytes.byteLength).toBeGreaterThan(8 * 1024)
    expect(bytes.byteLength).toBeLessThanOrEqual(VERIFICATION_REPAIR_WAIT_OUTPUT_BYTE_LIMIT)
    const firstChunk = bytes.subarray(0, 32).toString("utf8")
    const firstResult = { ref, sha256, byteCount: bytes.byteLength, chunk: firstChunk, nextCursor: "32" }
    const requestFor = (readInput: RecordValue, readResult: unknown, referenceValue: unknown = reference) => ({
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "wait-call", name: "agent.wait", input: { taskIds, mode: "all" } }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "wait-call", content: JSON.stringify(referenceValue) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "read-call", name: "tool_results.read", input: readInput }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "read-call", content: JSON.stringify(readResult) }] },
      ],
    } as unknown as HarnessModelRequest)
    expect(() => repairWaitOutputResolutionFromRequest(requestFor(
      { referenceId: ref }, firstResult, { ...reference, sizeBytes: VERIFICATION_REPAIR_WAIT_OUTPUT_BYTE_LIMIT + 1 },
    ), "wait-call", ["read-call"])).toThrow("repair_wait_reference_invalid")
    expect(() => repairWaitOutputResolutionFromRequest(
      requestFor({ referenceId: "tool-result-00000000-0000-4000-8000-000000000099" }, firstResult), "wait-call", ["read-call"],
    )).toThrow("repair_wait_reference_read_identity")
    expect(() => repairWaitOutputResolutionFromRequest(
      requestFor({ referenceId: ref }, { ...firstResult, ref: "tool-result-00000000-0000-4000-8000-000000000099" }), "wait-call", ["read-call"],
    )).toThrow("repair_wait_reference_chunk_invalid")
    const replayedCursorRequest = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "wait-call", name: "agent.wait", input: { taskIds, mode: "all" } }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "wait-call", content: JSON.stringify(reference) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "read-1", name: "tool_results.read", input: { referenceId: ref } }] },
        { role: "tool", content: [{ type: "tool_result", toolUseId: "read-1", content: JSON.stringify(firstResult) }] },
        { role: "assistant", content: [{ type: "tool_use", id: "read-2", name: "tool_results.read", input: { referenceId: ref, cursor: "0" } }] },
      ],
    } as unknown as HarnessModelRequest
    expect(() => repairWaitOutputResolutionFromRequest(replayedCursorRequest, "wait-call", ["read-1", "read-2"]))
      .toThrow("repair_wait_reference_read_identity")
    const digestMismatch = requestFor({ referenceId: ref }, { ...firstResult, sha256: "0".repeat(64) })
    expect(() => repairWaitOutputResolutionFromRequest(digestMismatch, "wait-call", ["read-call"]))
      .toThrow("repair_wait_reference_chunk_invalid")
  })
})

describe("TaskGraph fixture lease guard unit", () => {
  it("rejects a mismatched lease identity before recording its goal", () => {
    const owner = fixture()
    const foreignLease = {
      sessionId: `foreign-${owner.sessionId}`,
      turnId: `foreign-${owner.turnId}`,
      goal: "Foreign lease fixture",
    }
    const dispatchedGoals: string[] = []
    expect(() => recordTaskGraphFixtureLease(foreignLease, owner, dispatchedGoals))
      .toThrow("Foreign subagent lease rejected by TaskGraph fixture")
    expect(dispatchedGoals).toEqual([])

    const unguardedGoals: string[] = []
    unguardedGoals.push(foreignLease.goal)
    expect(unguardedGoals).toEqual([foreignLease.goal])
  })
})

describeWithServices("production TaskGraph lifecycle and root resume (disposable PostgreSQL + Redis)", () => {
  const priorStalledIntervalMs = process.env.BULLMQ_STALLED_INTERVAL_MS
  const owner = fixture()
  const resumeFailureOwner = fixture()
  const failureOwner = fixture()
  const operationalFailureOwner = fixture()
  const stopOwner = fixture()
  const restartOwner = fixture()
  const artifactOwner = fixture()
  const cancelledOwner = fixture()
  const discoveryOwner = fixture()
  const discoveryFailureOwner = fixture()
  const discoveryRestartOwner = fixture()
  const verificationRepairOwner = fixture()
  const lateRepairOwner = fixture()
  const leaseRecoveryOwner = fixture()
  const coverageRepairOwner = fixture()
  const archivedWaitOwner = fixture()
  const rootRecoveryScanSeed = fixture()
  const rootRecoveryScanOwner = {
    ...rootRecoveryScanSeed,
    sessionId: `000-root-recovery-scan-session-${rootRecoveryScanSeed.suffix}`,
  }
  let artifactOwnerSources: SelectedJobFixtureSources | undefined
  let pool: Pool | undefined
  let redis: Redis | undefined
  let bootstrap: ProductionWorkerBootstrap | undefined
  let turnQueueName: string | undefined
  let childQueueName: string | undefined
  let selectedJobQueueName: string | undefined

  beforeAll(async () => {
    // Keep in-process fixture Workers aligned with restart subprocesses. A closed Worker can leave its queue-wide
    // stalled-check lock alive, so a 120-second parent interval can defer a 30-second subprocess recovery scan.
    process.env.BULLMQ_STALLED_INTERVAL_MS = "30000"
    pool = new Pool({ connectionString: databaseUrl!, max: 6 })
    redis = new Redis(redisUrl!, {
      maxRetriesPerRequest: null,
      connectTimeout: 2_000,
      retryStrategy: attempt => attempt > 3 ? null : 100,
    })
    await redis.ping()
    vi.doMock("../../redis.js", () => ({
      redisConnection: redis,
      redisCommandConnection: redis,
      closeSharedRedisConnections: async () => undefined,
    }))
    // Each production bootstrap runs database-wide turn recovery; keep inactive fixtures out of its queue scan.
    await seed(pool, owner)
    await seed(pool, resumeFailureOwner, "waiting_for_user", TASK_GRAPH_FIXTURE_TURN_LIMITS)
    await seed(pool, failureOwner, "waiting_for_user")
    await seed(pool, operationalFailureOwner, "waiting_for_user", TASK_GRAPH_FIXTURE_TURN_LIMITS)
    await seed(pool, stopOwner, "waiting_for_user")
    await seed(pool, restartOwner, "waiting_for_user", TASK_GRAPH_FIXTURE_TURN_LIMITS)
    await seed(pool, artifactOwner, "waiting_for_user")
    artifactOwnerSources = await seedSelectedJobSources(pool, artifactOwner)
    await seed(pool, cancelledOwner, "waiting_for_user")
    await seed(pool, discoveryOwner, "waiting_for_user", DISCOVERY_FIXTURE_TURN_LIMITS)
    await seed(pool, discoveryFailureOwner, "waiting_for_user", DISCOVERY_FIXTURE_TURN_LIMITS)
    await seed(pool, discoveryRestartOwner, "waiting_for_user", DISCOVERY_FIXTURE_TURN_LIMITS)
    // The existing one-poll witness uses 22 steps/19 tool calls; each additional bounded poll adds one of each.
    await seed(pool, verificationRepairOwner, "waiting_for_user", {
      ...DISCOVERY_FIXTURE_TURN_LIMITS,
      maxSteps: VERIFICATION_REPAIR_STEP_BUDGET,
      maxToolCalls: VERIFICATION_REPAIR_TOOL_BUDGET,
    })
    await seed(pool, lateRepairOwner, "waiting_for_user", { ...DISCOVERY_FIXTURE_TURN_LIMITS, maxToolCalls: 10 })
    await seed(pool, leaseRecoveryOwner, "waiting_for_user", DISCOVERY_FIXTURE_TURN_LIMITS)
    await seed(pool, coverageRepairOwner, "waiting_for_user", { ...TASK_GRAPH_FIXTURE_TURN_LIMITS, maxSteps: 13 })
    await seed(pool, archivedWaitOwner, "waiting_for_user", { maxSteps: 4, maxToolCalls: 3 })
    await seed(pool, rootRecoveryScanOwner, "waiting_for_user")
  }, 15_000)

  afterEach(async () => {
    if (bootstrap) await bootstrap.close()
    bootstrap = undefined
  })

  afterAll(async () => {
    const cleanupFailures: string[] = []
    const attempt = async (label: string, action: () => Promise<unknown>) => {
      try { await action() } catch (error: unknown) {
        cleanupFailures.push(label + ": " + (error instanceof Error ? error.stack ?? error.message : String(error)))
      }
    }
    let bootstrapClosed = bootstrap === undefined
    if (bootstrap) {
      try { await bootstrap.close(); bootstrap = undefined; bootstrapClosed = true }
      catch (error: unknown) {
        bootstrapClosed = false
        cleanupFailures.push("bootstrap close: " + (error instanceof Error ? error.stack ?? error.message : String(error)))
      }
    }
    const fixtureOwners = [owner, resumeFailureOwner, failureOwner, operationalFailureOwner, stopOwner, restartOwner, artifactOwner, cancelledOwner, discoveryOwner,
      discoveryFailureOwner, discoveryRestartOwner, verificationRepairOwner, lateRepairOwner, leaseRecoveryOwner,
      coverageRepairOwner, rootRecoveryScanOwner, archivedWaitOwner]
    const allFixtureWorkersExited = [...fixtureProcessChildren].every(processFixtureExited)
    if (!allFixtureWorkersExited) cleanupFailures.push("fixture process Workers are not proven exited; queue cleanup was refused")
    let ownerRowsMayBeDeleted = false
    const queues: Array<{ name: string; label: string; queue: Queue }> = []
    if (pool && redis && bootstrapClosed && allFixtureWorkersExited && turnQueueName && childQueueName) {
      const failuresBeforeQueueCleanup = cleanupFailures.length
      let identities: FixtureQueueJobIdentity[] | null = null
      try {
        identities = await readExactFixtureQueueJobs(pool, fixtureOwners, turnQueueName, childQueueName,
          selectedJobQueueName, artifactOwner.sessionId)
      } catch (error: unknown) {
        cleanupFailures.push("derive exact fixture queue identities: " + (error instanceof Error ? error.stack ?? error.message : String(error)))
      }
      const queueSpecs = [
        { name: turnQueueName, label: "turn queue" },
        { name: childQueueName, label: "subagent queue" },
        ...(selectedJobQueueName ? [{ name: selectedJobQueueName, label: "selected-job subagent queue" }] : []),
      ]
      for (const spec of queueSpecs) {
        await attempt("create " + spec.label, async () => {
          queues.push({ ...spec, queue: new Queue(spec.name, { connection: redis!, skipVersionCheck: true }) })
        })
      }
      const readyQueues = new Set<string>()
      for (const currentQueue of queues) {
        try {
          await currentQueue.queue.waitUntilReady()
          readyQueues.add(currentQueue.name)
        } catch (error: unknown) {
          cleanupFailures.push("wait for " + currentQueue.label + ": " + (error instanceof Error ? error.stack ?? error.message : String(error)))
        }
      }
      if (identities) for (const [index, identity] of identities.entries()) {
        await attempt("remove exact fixture queue job " + index, async () => {
          const queue = queues.find(candidate => candidate.name === identity.queueName)?.queue
          if (!queue || !readyQueues.has(identity.queueName)) throw new Error("Exact fixture queue is unavailable")
          const staleLockWorkerExited = [...fixtureProcessChildren].some(child =>
            processFixtureProvesExactSigkill(child, identity))
          await removeExactFixtureQueueJob(identity, {
            name: queue.name,
            toKey: jobId => queue.toKey(jobId),
            getJob: async jobId => await queue.getJob(jobId) as unknown as FixtureCleanupJob | undefined,
          }, redis!, { allWorkersExited: allFixtureWorkersExited, exactSigkillOwner: staleLockWorkerExited })
        })
      }
      const closedQueues = new Set<Queue>()
      for (const currentQueue of queues) {
        try { await currentQueue.queue.close(); closedQueues.add(currentQueue.queue) }
        catch (error: unknown) {
          cleanupFailures.push("close " + currentQueue.label + ": " + (error instanceof Error ? error.stack ?? error.message : String(error)))
        }
      }
      for (const currentQueue of queues) {
        if (closedQueues.has(currentQueue.queue)) continue
        await attempt("retry close " + currentQueue.label, () => currentQueue.queue.close())
      }
      ownerRowsMayBeDeleted = fixtureOwnerRowsMayBeDeleted(
        identities !== null, failuresBeforeQueueCleanup, cleanupFailures.length,
      )
    } else if (pool && redis) {
      cleanupFailures.push("fixture queues are unavailable while owner rows remain; queue cleanup was refused")
    }
    if (pool && ownerRowsMayBeDeleted) for (const current of fixtureOwners) {
      await attempt("delete outbox for fixture owner", () => pool!.query(
        "DELETE FROM \"agent_outbox\" WHERE \"aggregateId\" = $1", [current.sessionId],
      ))
      await attempt("delete fixture owner user", () => pool!.query(
        "DELETE FROM \"User\" WHERE \"id\" = $1", [current.userId],
      ))
    }
    await attempt("PostgreSQL pool close", async () => { await pool?.end() })
    if (redis && redis.status !== "end") await attempt("Redis connection close", async () => {
      try { await redis!.quit() } catch (error: unknown) { redis!.disconnect(); throw error }
    })
    if (priorStalledIntervalMs === undefined) delete process.env.BULLMQ_STALLED_INTERVAL_MS
    else process.env.BULLMQ_STALLED_INTERVAL_MS = priorStalledIntervalMs
    vi.doUnmock("../../redis.js")
    if (cleanupFailures.length > 0) throw new Error("TaskGraph integration cleanup failed:\n" + cleanupFailures.join("\n"))
  })

  it("persists exact typed resume failures through TaskGraph lifecycle and Root context projection", async () => {
    const value = resumeFailureOwner
    let cleanupRoot: (() => Promise<void>) | undefined
    try {
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const { createPgRootTaskStore } = await import("./root-task-store.js")
      const rootStore = createPgRootTaskStore(pool!)
      const root = await rootStore.ensure({
        lease, goal: "Recover the fixed Scout and Analyst child state",
        allowedActions: [...new Set([
          ...TASK_GRAPH_TEMPLATES.scout.allowedActions,
          ...TASK_GRAPH_TEMPLATES.analyst.allowedActions,
        ])],
      })
      cleanupRoot = async () => {
        await rootStore.finish({ lease, rootTaskId: root.id, result: {
          status: "failed", stepCount: 0, toolCallCount: 0, errorCode: "test_fixture_cleanup",
        } })
        await releaseTurnLease(pool!, lease, "failed")
      }
      const rootStepId = `p3-resume-classification-root-step-${value.suffix}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 0, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
      [rootStepId, value.sessionId, value.turnId, root.id])
      const command = createPgTaskGraphCommandPort(pool!)
      const graph = await command.appendAndSchedule({
        scope: {
          userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
          rootTaskId: root.id, parentTaskId: root.id, stepId: rootStepId,
          turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
          parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
        },
        proposal: { expectedRevision: 0, nodes: [
          { key: "resume-scout", templateId: "scout", goal: "Read current source state", successCriteria: ["Return source evidence"], dependsOn: [], verification: SCOUT_VERIFICATION },
          { key: "resume-analyst", templateId: "analyst", goal: "Read current analysis state", successCriteria: ["Return analysis evidence"], dependsOn: [], verification: ANALYST_VERIFICATION },
          { key: "generic-control", templateId: "scout", goal: "Exercise generic typed failure handling", successCriteria: ["Return source evidence"], dependsOn: [], verification: SCOUT_VERIFICATION },
        ] },
        templates: { ...TASK_GRAPH_TEMPLATES },
      })
      const taskIds = new Map(graph.nodes.map(node => [node.key, node.taskId] as const))
      const store = new PgSubagentTaskStore(pool!, 300_000)
      const cases = [
        { key: "resume-scout", role: "scout", taskType: "job_discovery", criterionId: "candidate-count", reason: "child_resume_unavailable" },
        { key: "resume-analyst", role: "analyst", taskType: "job_analysis", criterionId: "finding-count", reason: "child_resume_evidence_unavailable" },
        { key: "generic-control", role: "scout", taskType: "job_discovery", criterionId: "candidate-count", reason: "child_resume_wait_step_lineage" },
      ] as const
      for (const [index, item] of cases.entries()) {
        const taskId = taskIds.get(item.key)
        if (!taskId) throw new Error("Resume classification graph omitted a fixed child")
        const childOwner = `p3-resume-classification-child-${index}-${value.suffix}`
        const claimed = await store.claim({ taskId, sessionId: value.sessionId, ownerId: childOwner,
          policy: defaultSubagentPolicy(), now: new Date() })
        expect(claimed).toMatchObject({ id: taskId, status: "running", attemptCount: 1 })
        if (!claimed) throw new Error("Resume classification child did not acquire its lease")
        const finished = await store.finish({
          taskId, sessionId: value.sessionId, ownerId: childOwner, attemptCount: claimed.attemptCount,
          status: "failed", result: null, failureReason: item.reason, retryDisposition: "terminal", now: new Date(),
        })
        expect(finished).toBe("failed")

        const row = await pool!.query<{ role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null; result: unknown }>(
          `SELECT "role", "taskType", "status", "attemptCount", "failureReason", "result"
           FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4`,
          [taskId, value.sessionId, value.turnId, root.id],
        )
        expect(row.rows).toHaveLength(1)
        const expectedReason = item.reason === "child_resume_unavailable" || item.reason === "child_resume_evidence_unavailable"
          ? item.reason : "task_graph_verification_unverified"
        expect(row.rows[0]).toMatchObject({
          role: item.role, taskType: item.taskType, status: "failed", attemptCount: claimed.attemptCount,
          failureReason: expectedReason,
        })
        expectUnverifiedVerificationReport(record(row.rows[0]?.result)?.taskGraphVerificationReport, item.criterionId)
        expect(record(row.rows[0]?.result)?.structuredResult).toBeUndefined()

        const key = taskGraphLifecycleKey(root.id, item.key, claimed.attemptCount, "task.failed")
        const event = await pool!.query<{ id: string; type: string; actor: string; taskId: string; idempotencyKey: string; payload: unknown }>(
          `SELECT "id", "type", "actor", "taskId", "idempotencyKey", "payload" FROM "agent_events"
           WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "taskId" = $4 AND "idempotencyKey" = $5`,
          [value.sessionId, value.turnId, taskGraphItemId(root.id), taskId, key],
        )
        expect(event.rows).toHaveLength(1)
        const eventPayload = record(event.rows[0]?.payload)
        expect(event.rows[0]).toMatchObject({ type: "item.delta", actor: "system", taskId, idempotencyKey: key })
        expect(eventPayload).toMatchObject({ kind: "lifecycle", event: { type: "task.failed", nodeKey: item.key, failureReason: expectedReason } })
        const outbox = await pool!.query<{ topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }>(
          `SELECT "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"
           WHERE "topic" = 'agent.session.event' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
          [value.sessionId, `agent-event:${event.rows[0]!.id}`],
        )
        expect(outbox.rows).toHaveLength(1)
        expect(outbox.rows[0]).toMatchObject({ topic: "agent.session.event", aggregateId: value.sessionId,
          idempotencyKey: `agent-event:${event.rows[0]!.id}` })
        expect(record(outbox.rows[0]?.payload)).toMatchObject({
          eventId: event.rows[0]!.id, taskId, type: "item.delta", actor: "system", idempotencyKey: key,
        })
      }

      const projected = await loadTaskGraphCurrentObservation({
        system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [],
      }, command, lease, root)
      const observation = record(projected.toolObservations.at(-1)?.content)
      const projectedNodes = Array.isArray(observation?.nodes) ? observation.nodes.map(record) : []
      const scout = projectedNodes.find(node => node?.key === "resume-scout")
      const analyst = projectedNodes.find(node => node?.key === "resume-analyst")
      const generic = projectedNodes.find(node => node?.key === "generic-control")
      expect(projectedNodes).toHaveLength(3)
      expect(scout?.executionFailureCategory).toBe("resume_state_unavailable")
      expect(analyst?.executionFailureCategory).toBe("resume_state_unavailable")
      expect(generic).not.toBeNull()
      expect(generic).not.toHaveProperty("executionFailureCategory")
      expect([scout, analyst, generic].every(node => node?.failureReason === null)).toBe(true)
      const serialized = JSON.stringify(observation)
      expect(serialized).not.toContain("child_resume_unavailable")
      expect(serialized).not.toContain("child_resume_evidence_unavailable")
      expect(serialized).not.toContain("child_resume_wait_step_lineage")
    } finally {
      // Quiesce this exact fixture owner so a later database-wide bootstrap cannot reclaim its live Turn.
      if (cleanupRoot) await cleanupRoot()
    }
  }, 30_000)

  it("rejects a consumed wait archive whose target belongs to another session", async () => {
    const value = fixture(), foreign = fixture(), tasks = new PgSubagentTaskStore(pool!, 300_000)
    const createRoot = async (owner: Fixture, goal: string) => {
      const root = await tasks.create({ userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
        role: "supervisor", taskType: "task_graph", goal, allowedActions: [], expectedOutputSchema: {},
        toolPolicySnapshot: {}, budgetSnapshot: {}, policy: defaultSubagentPolicy() })
      const linked = await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $2
        WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user'`,
      [owner.turnId, root.id, owner.sessionId, owner.userId])
      if (linked.rowCount !== 1) throw new Error("Wait replay fixture root could not be linked")
      return root
    }
    try {
      await seed(pool!, value, "waiting_for_user")
      await seed(pool!, foreign, "waiting_for_user")
      const root = await createRoot(value, "Wait archive owner root")
      const foreignRoot = await createRoot(foreign, "Foreign wait archive root")
      const target = await tasks.create({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        parentTaskId: root.id, role: "scout", taskType: "research", goal: "Wait archive target",
        allowedActions: [], policy: defaultSubagentPolicy() })
      const foreignTarget = await tasks.create({ userId: foreign.userId, sessionId: foreign.sessionId, turnId: foreign.turnId,
        parentTaskId: foreignRoot.id, role: "scout", taskType: "research", goal: "Foreign wait archive target",
        allowedActions: [], policy: defaultSubagentPolicy() })
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const stepId = `p3-wait-archive-replay-step-${value.suffix}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 1, 1, 'waiting_for_tool', 0, '[]'::jsonb, '{}'::jsonb)`,
      [stepId, value.sessionId, value.turnId, root.id])
      const waitStore = createPgDurableWaitPort(pool!)
      const wait = await waitStore.wait({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        stepId, taskId: root.id, rootTaskId: root.id, targetTaskIds: [target.id], mode: "all", timeoutMs: 60_000,
        idempotencyKey: `p3-wait-archive-replay:${value.suffix}` })
      await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "result" = '{"safe":true}'::jsonb,
        "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "sessionId" = $2`, [target.id, value.sessionId])
      expect((await waitStore.resolve({ userId: value.userId, sessionId: value.sessionId, waitId: wait.waitId }))?.status).toBe("ready")
      await pool!.query(`UPDATE "agent_wait_conditions" SET "suspendedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [wait.waitId])
      const turn = (await pool!.query(`SELECT * FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [value.turnId, value.sessionId])).rows[0]
      const client = await pool!.connect()
      try {
        await expect(consumeDurableWaitOutcomes({ client, lease, turn, now: new Date() })).resolves.toHaveLength(1)
      } finally { client.release() }

      const foreignIds = JSON.stringify([foreignTarget.id])
      const foreignOutcome = JSON.stringify({ waitId: wait.waitId, status: "ready", targetTaskIds: [foreignTarget.id],
        matchedTaskIds: [foreignTarget.id], tasks: [{ taskId: foreignTarget.id, status: "completed", role: "scout", result: null, failureReason: null }] })
      await pool!.query(`UPDATE "agent_wait_conditions" SET "targetTaskIds" = $1::jsonb, "matchedTaskIds" = $1::jsonb,
        "result" = jsonb_set(COALESCE("result", '{}'::jsonb), '{outcome}', $2::jsonb, true)
        WHERE "id" = $3 AND "userId" = $4 AND "sessionId" = $5 AND "turnId" = $6`,
      [foreignIds, foreignOutcome, wait.waitId, value.userId, value.sessionId, value.turnId])
      const replayClient = await pool!.connect()
      try {
        await expect(consumeDurableWaitOutcomes({ client: replayClient, lease, turn, now: new Date() }))
          .rejects.toThrow("wait_consume_outcome_invalid")
      } finally { replayClient.release() }
    } finally {
      for (const current of [value, foreign]) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [current.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [current.userId])
      }
    }
  }, 30_000)

  it.each([
    ["selected Job source edit", "job"],
    ["new eligible Persona fact", "persona"],
    ["new selected-job draft head", "draft"],
    ["TaskGraph revision advance", "graph"],
    ["Turn lease expiry after the guard", "lease"],
    ["root Stop after the guard", "stop"],
  ] as const)("rolls back terminal writes after a gate-approved race: %s", async (_label, race) => {
    const value = fixture()
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      let guard = selectedJobFinalizationGuardForCase(prepared)
      if (race === "job") {
        await pool!.query(`UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`,
          [prepared.sources.jobId, value.userId, `AC6_CHANGED_JOB_SOURCE_${value.suffix}`])
      } else if (race === "persona") {
        await pool!.query(`INSERT INTO persona_facts
          ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
          VALUES ($1, $2, 'new-confirmed-fact', 'experience', $3, $4, 'manual', 'resume:new-fact', 0.95, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`,
          [`p3-finalization-persona-${value.suffix}`, value.userId, `AC6_NEW_PERSONA_FACT_${value.suffix}`, value.suffix])
      } else if (race === "draft") {
        const task = await prepared.tasks.create({
          userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: prepared.root.id,
          role: "writer", taskType: "cover_letter_draft", goal: "Commit an unprojected newer draft",
          allowedActions: ["cover_letter.draft"], context: { selectedJobPreparation: { jobId: prepared.sources.jobId } },
          expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" }, toolPolicySnapshot: {}, policy: defaultSubagentPolicy(),
        })
        const writerOwner = `p3-finalization-race-writer-${value.suffix}`
        const writer = await prepared.tasks.claim({ taskId: task.id, sessionId: value.sessionId, ownerId: writerOwner, policy: defaultSubagentPolicy(), now: new Date() })
        if (!writer?.leaseOwner) throw new Error("Newer-draft race Writer did not acquire a lease")
        const draftInput = {
          baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: value.userId, jobId: prepared.sources.jobId }).slice(7)}`,
          baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: prepared.sources.jobId }),
          content: `AC6_PRIVATE_NEWER_DRAFT_${value.suffix}`, constraints: { maxWords: 160 },
        }
        const scope = {
          ...prepared.preparation.preparation, userId: value.userId, sessionId: value.sessionId, taskId: writer.id,
          toolCallId: `p3-finalization-race-writer:${writer.attemptCount}`,
          taskFence: selectedJobTaskFence(writer, writerOwner, writer.attemptCount),
        }
        const newer = await prepared.artifacts.writeDraft(scope, { ...draftInput, requestHash: selectedJobDraftRequestHash(scope, draftInput) })
        expect(newer.version).toBe(prepared.artifactRef.version + 1)
      } else if (race === "graph") {
        const advanced = await pool!.query(`UPDATE "agent_items" SET "revision" = "revision" + 1 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 RETURNING "revision"`,
          [taskGraphItemId(prepared.root.id), value.sessionId, value.turnId])
        expect(advanced.rowCount).toBe(1)
      } else {
        const realGuard = guard
        guard = async client => {
          const decision = await realGuard(client)
          if (!decision.ok) return decision
          const update = race === "lease"
            ? `UPDATE "agent_turns" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second' WHERE "id" = $1 AND "sessionId" = $2`
            : `UPDATE "sub_agent_tasks" SET "interruptRequestedAt" = clock_timestamp() WHERE "id" = $1 AND "sessionId" = $2`
          const changed = await client.query(update, [race === "lease" ? value.turnId : prepared.root.id, value.sessionId])
          if (changed.rowCount !== 1) throw new Error(`Could not inject terminal ${race} race`)
          return decision
        }
      }

      await expect(commitTurnTerminal(pool!, prepared.terminalInput, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it.each(["durable wait", "TurnEngine updateStep"] as const)(
    "serializes DurableWait.wait and TurnEngine.updateStep when %s wins the session lock",
    async lockWinner => {
      const value = fixture()
      let waitBarrier: ReturnType<typeof sessionLockBarrierPool> | undefined
      let stepBarrier: ReturnType<typeof sessionLockBarrierPool> | undefined
      let waitOperation: Promise<unknown> | undefined
      let stepOperation: Promise<unknown> | undefined
      const pendingOperations = () => [waitOperation, stepOperation].filter((operation): operation is Promise<unknown> => operation !== undefined)
      try {
        const prepared = await prepareSelectedJobTerminalCase(pool!, value)
        const targetRows = await pool!.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 AND "status" = 'completed'
          ORDER BY "id" LIMIT 2`, [value.sessionId, value.turnId, prepared.root.id])
        const targetTaskIds = targetRows.rows.map(row => row.id)
        expect(targetTaskIds).toHaveLength(2)

        waitBarrier = sessionLockBarrierPool(pool!)
        stepBarrier = sessionLockBarrierPool(pool!)
        const waitStore = createPgDurableWaitPort(waitBarrier.pool)
        const turnEngine = createPgTurnEngineStore(stepBarrier.pool)
        const waitKey = `p3-session-first-wait-${value.suffix}`
        const waitInput = {
          userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, stepId: prepared.stepId,
          taskId: prepared.root.id, rootTaskId: prepared.root.id, targetTaskIds, mode: "all" as const,
          timeoutMs: 30_000, idempotencyKey: waitKey,
        }
        const updateStep = () => turnEngine.updateStep({
          owner: prepared.terminalInput.owner, stepId: prepared.stepId, status: "completed", finishReason: "stop",
          errorCode: null, inputTokens: 7, outputTokens: 11, estimatedCostUsd: 0.123, now: new Date(Date.now() + 1_000),
        })
        const createWait = () => waitStore.wait(waitInput)
        const winnerBarrier = lockWinner === "durable wait" ? waitBarrier : stepBarrier
        const loserBarrier = lockWinner === "durable wait" ? stepBarrier : waitBarrier

        try {
          if (lockWinner === "durable wait") {
            waitOperation = createWait()
            void waitOperation.catch(() => undefined)
          } else {
            stepOperation = updateStep()
            void stepOperation.catch(() => undefined)
          }
          const winnerPid = await withinIntegrationDeadline(winnerBarrier.connected, "Session-lock winner did not connect")
          expect(await withinIntegrationDeadline(winnerBarrier.sessionLockReturned, "Winner did not return from its session FOR UPDATE")).toBe(winnerPid)

          if (lockWinner === "durable wait") {
            stepOperation = updateStep()
            void stepOperation.catch(() => undefined)
          } else {
            waitOperation = createWait()
            void waitOperation.catch(() => undefined)
          }
          const loserPid = await withinIntegrationDeadline(loserBarrier.connected, "Session-lock competitor did not connect")
          expect(loserPid).not.toBe(winnerPid)
          await waitForSessionTupleBlock(pool!, winnerPid, loserPid)
        } finally {
          waitBarrier.release()
          stepBarrier.release()
        }

        if (!waitOperation || !stepOperation) throw new Error("Both session-lock operations must start")
        const settled = await withinIntegrationDeadline(
          Promise.allSettled([waitOperation, stepOperation]),
          "Durable wait and TurnEngine operations did not settle after releasing the session lock",
          10_000,
        )
        const deadlockCodes = settled.flatMap(outcome => outcome.status === "rejected"
          ? [record(outcome.reason)?.code]
          : [])
        expect(deadlockCodes).not.toContain("40P01")
        const [waitResult, stepResult] = settled
        expect(waitResult.status).toBe("fulfilled")
        expect(stepResult.status).toBe("fulfilled")
        if (waitResult.status === "rejected") throw waitResult.reason
        if (stepResult.status === "rejected") throw stepResult.reason
        expect(waitResult.value).toMatchObject({ status: "ready", matchedTaskIds: targetTaskIds })

        const persistedWait = await pool!.query<{ status: string; matchedTaskIds: string[] }>(
          `SELECT "status", "matchedTaskIds" FROM "agent_wait_conditions"
           WHERE "parentTaskId" = $1 AND "idempotencyKey" = $2`, [prepared.root.id, waitKey],
        )
        expect(persistedWait.rows).toHaveLength(1)
        expect(persistedWait.rows[0]?.status).toBe("ready")
        expect(new Set(persistedWait.rows[0]?.matchedTaskIds)).toEqual(new Set(targetTaskIds))
        const persistedStep = await pool!.query<{
          status: string; inputTokens: number; outputTokens: number; estimatedCostUsd: string | number
        }>(`SELECT "status", "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_steps"
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [prepared.stepId, value.sessionId, value.turnId])
        expect(persistedStep.rows).toHaveLength(1)
        expect(persistedStep.rows[0]).toMatchObject({ status: "completed", inputTokens: 7, outputTokens: 11 })
        expect(Number(persistedStep.rows[0]?.estimatedCostUsd)).toBeCloseTo(0.123)
      } finally {
        waitBarrier?.release()
        stepBarrier?.release()
        const operations = pendingOperations()
        if (operations.length > 0) {
          await withinIntegrationDeadline(Promise.allSettled(operations), "Session-lock operations did not settle during cleanup", 10_000)
            .catch(() => undefined)
        }
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    },
  )

  it("rolls back finalization while an eligible source insert holds the User foreign-key lock", async () => {
    const value = fixture()
    let inserter: PoolClient | undefined
    let insertActive = false
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)

      inserter = await pool!.connect()
      await inserter.query("BEGIN")
      insertActive = true
      await inserter.query(`INSERT INTO persona_facts
        ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
        VALUES ($1, $2, 'pending-fact', 'experience', $3, $4, 'manual', 'resume:pending-fact', 0.95, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`, [
        `p3-finalization-fk-lock-${value.suffix}`, value.userId, `AC6_PENDING_FK_FACT_${value.suffix}`, value.suffix,
      ])

      const guard = selectedJobFinalizationGuardForCase(prepared)
      await expect(commitTurnTerminal(pool!, prepared.terminalInput, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)

      await inserter.query("COMMIT")
      insertActive = false
      const after = await loadSelectedJobArtifactContext(pool!, value.userId, prepared.sources.jobId)
      expect(after.preparation.sourceDigest).not.toBe(prepared.preparation.preparation.sourceDigest)
      await expect(commitTurnTerminal(pool!, prepared.terminalInput, guard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
    } finally {
      if (insertActive) await inserter?.query("ROLLBACK").catch(() => undefined)
      inserter?.release()
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("waits for authority locks, then reads a newer committed Job source before finalizing", async () => {
    const value = fixture()
    let writer: PoolClient | undefined
    let writerActive = false
    let terminalOutcome: Promise<{ value: unknown } | { error: unknown }> | undefined
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      writer = await pool!.connect()
      await writer.query("BEGIN")
      writerActive = true
      const backend = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      const writerPid = Number(backend.rows[0]?.pid)
      if (!Number.isSafeInteger(writerPid)) throw new Error("Could not identify the disposable authority-lock writer")
      await writer.query("SELECT set_config($1, $2, true)", ["app.user_id", value.userId])
      const sessionLock = await writer.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 FOR UPDATE`, [value.sessionId, value.userId])
      const turnLock = await writer.query(`SELECT "id" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`, [value.turnId, value.sessionId, value.userId, prepared.root.id])
      const rootLock = await writer.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1 AND "status" = 'running' FOR UPDATE`, [prepared.root.id, value.sessionId, value.turnId])
      expect(sessionLock.rowCount).toBe(1)
      expect(turnLock.rowCount).toBe(1)
      expect(rootLock.rowCount).toBe(1)

      terminalOutcome = commitTurnTerminal(pool!, prepared.terminalInput, selectedJobFinalizationGuardForCase(prepared))
        .then(result => ({ value: result }), error => ({ error }))
      let waiting = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await pool!.query<{ waiting: boolean }>(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity AS waiter WHERE waiter.pid <> pg_backend_pid() AND waiter.state = 'active'
            AND waiter.wait_event_type = 'Lock' AND waiter.query LIKE '%FROM "agent_sessions"%' AND waiter.query LIKE '%FOR UPDATE%'
            AND $1::int = ANY(pg_blocking_pids(waiter.pid))
        ) AS "waiting"`, [writerPid])
        if (activity.rows[0]?.waiting === true) { waiting = true; break }
        await writer.query("SELECT pg_sleep(0.05)")
      }
      expect(waiting).toBe(true)
      await writer.query(`UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`,
        [prepared.sources.jobId, value.userId, `AC6_WAITED_SOURCE_COMMIT_${value.suffix}`])
      await writer.query("COMMIT")
      writerActive = false
      const outcome = await terminalOutcome
      expect("error" in outcome).toBe(true)
      if ("error" in outcome) expect(outcome.error).toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
    } finally {
      if (writerActive) await writer?.query("ROLLBACK").catch(() => undefined)
      writer?.release()
      if (terminalOutcome) await terminalOutcome
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("holds selected sources stable from the final digest read through terminal commit", async () => {
    const value = fixture()
    const writers: PoolClient[] = []
    const mutationOutcomes: Array<Promise<{ label: string; rowCount: number | null } | { label: string; error: unknown }>> = []
    let terminalOutcome: Promise<{ value: unknown } | { error: unknown }> | undefined
    let releaseGuard: () => void = () => {}
    let resolveGuardPassed: (pid: number) => void = () => undefined
    const guardPassed = new Promise<number>(resolve => { resolveGuardPassed = resolve })
    const guardBarrier = new Promise<void>(resolve => { releaseGuard = resolve })
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      const adaptedResumeId = `p3-finalization-adapted-resume-${value.suffix}`
      await pool!.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "updatedAt")
        VALUES ($1, $2, 'Unrelated adapted resume', '{"text":"before"}'::jsonb, 'adapted', 'ai-adapted', FALSE, CURRENT_TIMESTAMP)`, [adaptedResumeId, value.userId])
      const realGuard = selectedJobFinalizationGuardForCase(prepared)
      const guarded = async (client: PoolClient) => {
        const decision = await realGuard(client)
        if (!decision.ok) return decision
        const backend = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        const pid = Number(backend.rows[0]?.pid)
        if (!Number.isSafeInteger(pid)) throw new Error("Could not identify terminal finalization backend")
        resolveGuardPassed(pid)
        await guardBarrier
        return decision
      }
      terminalOutcome = commitTurnTerminal(pool!, prepared.terminalInput, guarded)
        .then(result => ({ value: result }), error => ({ error }))
      const terminalPid = await guardPassed
      let adaptedTimeout: NodeJS.Timeout | undefined
      try {
        const adaptedUpdate = await Promise.race([
          pool!.query(`UPDATE "Resume" SET "content" = '{"text":"after"}'::jsonb, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, [adaptedResumeId, value.userId]),
          new Promise<never>((_, reject) => { adaptedTimeout = setTimeout(() => reject(new Error("Unselected adapted Resume update was blocked by finalization")), 3_000) }),
        ])
        expect(adaptedUpdate.rowCount).toBe(1)
      } finally { if (adaptedTimeout) clearTimeout(adaptedTimeout) }
      const newFactId = `p3-finalization-post-guard-fact-${value.suffix}`
      const changes = [
        { label: "Job update", sql: `UPDATE "Job" SET "description" = $3, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, values: [prepared.sources.jobId, value.userId, `AC6_POST_GUARD_JOB_${value.suffix}`] },
        { label: "Resume update", sql: `UPDATE "Resume" SET "content" = jsonb_build_object('text', $3::text), "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, values: [prepared.sources.resumeId, value.userId, `AC6_POST_GUARD_RESUME_${value.suffix}`] },
        { label: "PersonaFact update", sql: `UPDATE persona_facts SET "value" = $3, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "userId" = $2`, values: [`p3-selected-job-fact-${value.suffix}`, value.userId, `AC6_POST_GUARD_PERSONA_${value.suffix}`] },
        { label: "PersonaFact insert", sql: `INSERT INTO persona_facts
          ("id", "userId", "key", "category", "value", "normalized_value", "source", "source_ref", "confidence", "status", "allowedUses", "updated_at")
          VALUES ($1, $2, 'post-guard-fact', 'experience', $3, $4, 'manual', 'resume:post-guard', 0.95, 'confirmed', ARRAY['cover_letter']::text[], CURRENT_TIMESTAMP)`,
        values: [newFactId, value.userId, `AC6_POST_GUARD_INSERT_${value.suffix}`, value.suffix] },
      ]
      const writerPids: number[] = []
      for (const change of changes) {
        const writer = await pool!.connect()
        writers.push(writer)
        const backend = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        writerPids.push(Number(backend.rows[0]?.pid))
        mutationOutcomes.push(writer.query(change.sql, change.values)
          .then(result => ({ label: change.label, rowCount: result.rowCount }), error => ({ label: change.label, error })))
      }

      let allBlocked = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const waiting = await pool!.query<{ pid: number }>(`SELECT waiter.pid::int AS pid FROM pg_stat_activity AS waiter
          WHERE waiter.pid = ANY($1::int[]) AND waiter.state = 'active' AND waiter.wait_event_type = 'Lock'
            AND $2::int = ANY(pg_blocking_pids(waiter.pid))`, [writerPids, terminalPid])
        if (new Set(waiting.rows.map(row => Number(row.pid))).size === changes.length) { allBlocked = true; break }
        await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(allBlocked).toBe(true)

      const observer = await pool!.connect()
      try {
        const [job, resume, fact, inserted] = await Promise.all([
          observer.query<{ description: string }>(`SELECT "description" FROM "Job" WHERE "id" = $1`, [prepared.sources.jobId]),
          observer.query<{ content: { text: string } }>(`SELECT "content" FROM "Resume" WHERE "id" = $1`, [prepared.sources.resumeId]),
          observer.query<{ value: string }>(`SELECT "value" FROM persona_facts WHERE "id" = $1`, [`p3-selected-job-fact-${value.suffix}`]),
          observer.query(`SELECT "id" FROM persona_facts WHERE "id" = $1`, [newFactId]),
        ])
        expect(job.rows[0]?.description).toBe(`AC6_TRANSIENT_JOB_SOURCE_W1_${value.suffix}`)
        expect(resume.rows[0]?.content.text).toBe(`AC6_TRANSIENT_RESUME_SOURCE_W1_${value.suffix}`)
        expect(fact.rows[0]?.value).toBe(`AC6_TRANSIENT_PERSONA_SOURCE_W1_${value.suffix}`)
        expect(inserted.rows).toHaveLength(0)
      } finally { observer.release() }

      releaseGuard()
      const terminal = await terminalOutcome
      expect(terminal && "value" in terminal).toBe(true)
      const applied = await Promise.all(mutationOutcomes)
      expect(applied.every(result => "rowCount" in result && result.rowCount === 1)).toBe(true)
      const after = await loadSelectedJobArtifactContext(pool!, value.userId, prepared.sources.jobId)
      expect(after.preparation.sourceDigest).not.toBe(prepared.preparation.preparation.sourceDigest)
    } finally {
      releaseGuard()
      if (terminalOutcome) await terminalOutcome
      await Promise.all(mutationOutcomes)
      for (const writer of writers) writer.release()
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("rechecks PersonaFact expiry using the wall clock after the terminal transaction starts", async () => {
    const value = fixture()
    try {
      const prepared = await prepareSelectedJobTerminalCase(pool!, value)
      const expires = await pool!.query<{ expiresAt: Date }>(`UPDATE persona_facts
        SET "expires_at" = clock_timestamp() + INTERVAL '3 seconds'
        WHERE "id" = $1 AND "userId" = $2 RETURNING "expires_at" AS "expiresAt"`, [
        `p3-selected-job-fact-${value.suffix}`, value.userId,
      ])
      const expiresAt = expires.rows[0]?.expiresAt
      if (!(expiresAt instanceof Date)) throw new Error("Could not set the PersonaFact expiry boundary")
      const realGuard = selectedJobFinalizationGuardForCase(prepared)
      const delayedGuard = async (client: PoolClient) => {
        const transaction = await client.query<{ startedAt: Date }>("SELECT transaction_timestamp() AS \"startedAt\"")
        const startedAt = transaction.rows[0]?.startedAt
        if (!(startedAt instanceof Date) || startedAt.getTime() >= expiresAt.getTime()) {
          throw new Error("Terminal transaction did not start before PersonaFact expiry")
        }
        const delay = await client.query<{ seconds: number }>(`SELECT GREATEST(0.05,
          EXTRACT(EPOCH FROM $1::timestamptz - clock_timestamp()) + 0.1)::float8 AS "seconds"`, [expiresAt])
        await client.query("SELECT pg_sleep($1::float8)", [Number(delay.rows[0]?.seconds)])
        const expired = await client.query<{ expired: boolean }>(`SELECT statement_timestamp() > $1::timestamptz AS "expired"`, [expiresAt])
        expect(expired.rows[0]?.expired).toBe(true)
        return realGuard(client)
      }

      await expect(commitTurnTerminal(pool!, prepared.terminalInput, delayedGuard)).rejects.toMatchObject({ name: "TurnEnginePersistenceConflict" })
      await expectNoTerminalRecords(pool!, prepared)
      const afterExpiry = await loadSelectedJobArtifactContext(pool!, value.userId, prepared.sources.jobId)
      expect(afterExpiry.preparation.sourceDigest).not.toBe(prepared.preparation.preparation.sourceDigest)
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("replays one selected-job draft receipt under a reclaimed lease without duplicating its version", async () => {
    const value = fixture()
    let userSeeded = false
    try {
      await seed(pool!, value, "waiting_for_user")
      userSeeded = true
      const sources = await seedSelectedJobSources(pool!, value)
      const plan = await createSelectedJobTaskGraph(pool!, value, sources, `agent-subagents-ac6-receipt-${value.suffix}`)
      const firstOwner = `ac6-receipt-owner-one-${value.suffix}`
      const secondOwner = `ac6-receipt-owner-two-${value.suffix}`
      const firstLease = await plan.store.claim({
        taskId: plan.writerTask.id, sessionId: value.sessionId, ownerId: firstOwner,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!firstLease?.leaseOwner) throw new Error("Selected-job receipt task did not acquire its first disposable lease")
      expect(firstLease).toMatchObject({ status: "running", leaseOwner: firstOwner, attemptCount: 1 })

      const toolCallId = SELECTED_JOB_DRAFT_CALL_ID
      const input = {
        baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: value.userId, jobId: sources.jobId }).slice(7)}`,
        baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: sources.jobId }),
        content: `AC6_PRIVATE_COVER_LETTER_${value.suffix}`,
        constraints: { maxWords: 160 },
      }
      const artifactStore = createArtifactToolStore(pool!)
      const base = await resolveCoverLetterBase(artifactStore, value.userId, sources.jobId)
      expect(base).toMatchObject({ artifactId: input.baseArtifactId, baseHash: input.baseHash })
      const originalScope = {
        ...plan.originalPreparation.preparation,
        userId: value.userId,
        sessionId: value.sessionId,
        taskId: firstLease.id,
        toolCallId,
        taskFence: selectedJobTaskFence(firstLease, firstOwner, firstLease.attemptCount),
      }
      const requestHash = selectedJobDraftRequestHash(originalScope, input)
      const committed = await artifactStore.writeDraft(originalScope, { ...input, requestHash })
      expect(committed).toMatchObject({
        version: 1, userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId,
        sourceDigest: plan.originalPreparation.preparation.sourceDigest,
        provenanceRefs: plan.originalPreparation.preparation.evidenceRefs,
        evidenceRefs: plan.originalPreparation.preparation.evidenceRefs,
        taskId: firstLease.id, toolCallId, requestHash,
      })

      const expired = await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
          AND "status" = 'running' AND "leaseOwner" = $5 AND "attemptCount" = $6`, [
        firstLease.id, value.sessionId, value.turnId, plan.rootTaskId, firstOwner, firstLease.attemptCount,
      ])
      expect(expired.rowCount).toBe(1)
      // Model the recovered task's new live lease on this fixture-owned row. The Worker restart trace separately exercises production recovery and claim.
      const reclaimed = await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "leaseOwner" = $5,
          "attemptCount" = "attemptCount" + 1, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute',
          "nextAttemptAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
          AND "status" = 'running' AND "leaseOwner" = $6 AND "attemptCount" = $7
          AND "leaseExpiresAt" <= CURRENT_TIMESTAMP`, [
        firstLease.id, value.sessionId, value.turnId, plan.rootTaskId, secondOwner, firstOwner, firstLease.attemptCount,
      ])
      expect(reclaimed.rowCount).toBe(1)
      const secondLease = await plan.store.get(firstLease.id, value.sessionId)
      if (!secondLease?.leaseOwner) throw new Error("Selected-job receipt task did not receive its modeled reclaimed lease")
      expect(secondLease).toMatchObject({ status: "running", leaseOwner: secondOwner, attemptCount: 2 })

      await expect(artifactStore.writeDraft(originalScope, { ...input, requestHash }))
        .rejects.toMatchObject({ code: "task_fence_denied" })
      const reclaimedScope = {
        ...originalScope,
        taskFence: selectedJobTaskFence(secondLease, secondOwner, secondLease.attemptCount),
      }
      const [firstReplay, secondReplay] = await Promise.all([
        artifactStore.writeDraft(reclaimedScope, { ...input, requestHash }),
        artifactStore.writeDraft(reclaimedScope, { ...input, requestHash }),
      ])
      expect(firstReplay).toEqual(committed)
      expect(secondReplay).toEqual(committed)

      const conflictingInput = { ...input, content: `${input.content}_conflict` }
      const conflictingHash = selectedJobDraftRequestHash(reclaimedScope, conflictingInput)
      await expect(artifactStore.writeDraft(reclaimedScope, { ...conflictingInput, requestHash: conflictingHash }))
        .rejects.toMatchObject({ code: "receipt_conflict" })
      const completed = await plan.store.finish({
        taskId: secondLease.id, sessionId: value.sessionId, ownerId: secondOwner,
        attemptCount: secondLease.attemptCount, status: "completed", result: { status: "completed" }, now: new Date(),
      })
      expect(completed).toBe("completed")
      await expect(artifactStore.writeDraft(reclaimedScope, { ...input, requestHash }))
        .rejects.toMatchObject({ code: "task_fence_denied" })
      const versions = await pool!.query<{ count: number }>(
        `SELECT COUNT(*)::int AS "count" FROM "agent_artifact_version" WHERE "taskId" = $1`, [firstLease.id],
      )
      expect(versions.rows[0]?.count).toBe(1)
    } finally {
      if (userSeeded) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    }
  }, 30_000)

  it("blocks completion when an unprojected failed Writer committed a newer draft head", async () => {
    const value = fixture()
    let userSeeded = false
    try {
      await seed(pool!, value, "waiting_for_user")
      userSeeded = true
      const sources = await seedSelectedJobSources(pool!, value)
      const preparation = await loadSelectedJobArtifactContext(pool!, value.userId, sources.jobId)
      const store = new PgSubagentTaskStore(pool!)
      const root = await store.create({
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        role: "supervisor", taskType: "task_graph", goal: "Complete the selected-job draft review",
        allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft", "artifact.version.read", "artifact.review"],
        expectedOutputSchema: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 8, maxToolCalls: 8 } },
        policy: defaultSubagentPolicy(),
      })
      const linkedTurn = await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $2, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4 AND "status" = 'waiting_for_user' AND "rootTaskId" IS NULL`, [
        value.turnId, root.id, value.sessionId, value.userId,
      ])
      expect(linkedTurn.rowCount).toBe(1)
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const rootLease = await store.claim({
        taskId: root.id, sessionId: value.sessionId, ownerId: value.ownerId,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!rootLease?.leaseOwner) throw new Error("Stale-head fixture root did not acquire a live lease")
      expect(rootLease).toMatchObject({ status: "running", leaseOwner: lease.ownerId, attemptCount: 1 })

      const stepId = `p3-stale-head-step-${value.suffix}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [
        stepId, value.sessionId, value.turnId, root.id,
      ])
      const commandPort = createPgTaskGraphCommandPort(pool!)
      const graphScope = {
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        rootTaskId: root.id, parentTaskId: root.id, stepId,
        turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
        parentLeaseOwner: lease.ownerId, parentAttemptCount: rootLease.attemptCount,
      }
      const graph = await commandPort.appendAndSchedule({
        scope: graphScope,
        proposal: {
          expectedRevision: 0,
          nodes: [
            { key: "writer-v1", templateId: "cover_letter_writer", goal: "Persist the original draft", successCriteria: ["Save draft v1"], dependsOn: [] },
            { key: "reviewer-v1", templateId: "cover_letter_reviewer", goal: "Review the original draft", successCriteria: ["Persist a passed review for v1"], dependsOn: ["writer-v1"] },
            { key: "writer-v2", templateId: "cover_letter_writer", goal: "Commit a newer draft then fail", successCriteria: ["Commit draft v2 before failure"], dependsOn: ["reviewer-v1"] },
          ],
        },
        templates: taskGraphTemplatesForSelectedJob(preparation.preparation),
      })
      const taskIds = new Map(graph.nodes.map(node => [node.key, node.taskId] as const))
      const claimGraphChild = async (key: string, ownerId: string): Promise<SubagentTaskRecord> => {
        const taskId = taskIds.get(key)
        if (!taskId) throw new Error(`Stale-head fixture is missing TaskGraph node ${key}`)
        const task = await store.claim({ taskId, sessionId: value.sessionId, ownerId, policy: defaultSubagentPolicy(), now: new Date() })
        if (!task?.leaseOwner) throw new Error(`Stale-head fixture child ${key} did not acquire a live lease`)
        return task
      }
      const finishCompletedGraphChild = async (task: SubagentTaskRecord, ownerId: string, structuredResult: RecordValue) => {
        await expect(store.finish({
          taskId: task.id, sessionId: value.sessionId, ownerId, attemptCount: task.attemptCount, status: "completed",
          result: { status: "completed", finalText: "fixture receipt", finalItemId: null, stepCount: 1, toolCallCount: 1, structuredResult },
          now: new Date(),
        })).resolves.toBe("completed")
      }
      const artifactStore = createArtifactToolStore(pool!)
      const base = await resolveCoverLetterBase(artifactStore, value.userId, sources.jobId)
      const draftInput = (content: string) => ({
        baseArtifactId: `cover-letter-base:${hashArtifactContent({ userId: value.userId, jobId: sources.jobId }).slice(7)}`,
        baseHash: hashArtifactContent({ kind: "cover_letter_base", jobId: sources.jobId }),
        content, constraints: { maxWords: 160 },
      })
      expect(base).toMatchObject({ artifactId: draftInput("unused").baseArtifactId, baseHash: draftInput("unused").baseHash })
      const artifactReference = (version: Awaited<ReturnType<typeof artifactStore.writeDraft>>) => ({
        artifactId: version.artifactId, version: version.version,
        contentHash: version.contentHash, sourceDigest: version.sourceDigest,
      })

      const writerV1Owner = `p3-stale-head-writer-v1-${value.suffix}`
      const writerV1 = await claimGraphChild("writer-v1", writerV1Owner)
      const writerV1Input = draftInput(`AC6_STALE_HEAD_DRAFT_V1_${value.suffix}`)
      const writerV1Scope = {
        ...preparation.preparation, userId: value.userId, sessionId: value.sessionId,
        taskId: writerV1.id, toolCallId: `ac6-stale-head-writer-v1:${writerV1.attemptCount}`,
        taskFence: selectedJobTaskFence(writerV1, writerV1Owner, writerV1.attemptCount),
      }
      const writerV1Version = await artifactStore.writeDraft(writerV1Scope, {
        ...writerV1Input, requestHash: selectedJobDraftRequestHash(writerV1Scope, writerV1Input),
      })
      const writerV1Ref = artifactReference(writerV1Version)
      await finishCompletedGraphChild(writerV1, writerV1Owner, {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: writerV1Ref,
      })

      const reviewerV1Owner = `p3-stale-head-reviewer-v1-${value.suffix}`
      const reviewerV1 = await claimGraphChild("reviewer-v1", reviewerV1Owner)
      const reviewerV1CallId = `ac6-stale-head-reviewer-v1:${reviewerV1.attemptCount}`
      const reviewInput = { artifactRef: writerV1Ref, decision: "passed", findings: [] }
      const reviewerV1Scope = {
        ...preparation.preparation, userId: value.userId, sessionId: value.sessionId,
        taskId: reviewerV1.id, toolCallId: reviewerV1CallId,
        taskFence: selectedJobTaskFence(reviewerV1, reviewerV1Owner, reviewerV1.attemptCount),
      }
      const reviewHash = hashArtifactContent({
        artifactRef: writerV1Ref, currentSourceDigest: preparation.preparation.sourceDigest,
        status: "passed", findings: [], evidenceRefs: preparation.preparation.evidenceRefs,
      })
      await artifactStore.saveReview({
        userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId,
        artifactId: writerV1Ref.artifactId, version: writerV1Ref.version,
        contentHash: writerV1Ref.contentHash, sourceDigest: writerV1Ref.sourceDigest,
        currentSourceDigest: preparation.preparation.sourceDigest, status: "passed", findings: [],
        evidenceRefs: [...preparation.preparation.evidenceRefs], taskId: reviewerV1.id, toolCallId: reviewerV1CallId,
        requestHash: selectedJobTaskReceiptRequestHash("artifact.review", reviewerV1Scope, reviewInput),
        reviewHash, taskFence: reviewerV1Scope.taskFence,
      })
      await finishCompletedGraphChild(reviewerV1, reviewerV1Owner, {
        schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed",
        artifactRef: writerV1Ref, reviewStatus: "passed", reviewHash,
      })

      const writerV2Owner = `p3-stale-head-writer-v2-${value.suffix}`
      const writerV2 = await claimGraphChild("writer-v2", writerV2Owner)
      const writerV2Input = draftInput(`AC6_STALE_HEAD_DRAFT_V2_${value.suffix}`)
      const writerV2Scope = {
        ...preparation.preparation, userId: value.userId, sessionId: value.sessionId,
        taskId: writerV2.id, toolCallId: `ac6-stale-head-writer-v2:${writerV2.attemptCount}`,
        taskFence: selectedJobTaskFence(writerV2, writerV2Owner, writerV2.attemptCount),
      }
      const writerV2Version = await artifactStore.writeDraft(writerV2Scope, {
        ...writerV2Input, requestHash: selectedJobDraftRequestHash(writerV2Scope, writerV2Input),
      })
      const writerV2Ref = artifactReference(writerV2Version)
      expect(writerV2Ref.version).toBe(2)
      expect(writerV2Ref.artifactId).toBe(writerV1Ref.artifactId)
      expect(writerV2Ref.contentHash).not.toBe(writerV1Ref.contentHash)
      await expect(store.finish({
        taskId: writerV2.id, sessionId: value.sessionId, ownerId: writerV2Owner,
        attemptCount: writerV2.attemptCount, status: "failed", retryDisposition: "terminal",
        failureReason: "fixture_writer_failed_after_draft_commit", now: new Date(),
      })).resolves.toBe("failed")
      await expect(store.get(writerV2.id, value.sessionId)).resolves.toMatchObject({
        status: "failed", result: null, failureReason: "fixture_writer_failed_after_draft_commit",
      })

      const artifactRepository = createAgentArtifactRepository(pool!)
      await expect(artifactRepository.findCurrentDraftHead({
        userId: value.userId, sessionId: value.sessionId, jobId: sources.jobId, artifactId: writerV1Ref.artifactId,
      })).resolves.toEqual(writerV2Ref)
      const committedVersions = await pool!.query<{ version: number }>(
        `SELECT "version" FROM "agent_artifact_version" WHERE "artifactId" = $1 ORDER BY "version" ASC`,
        [writerV1Ref.artifactId],
      )
      expect(committedVersions.rows.map(row => row.version)).toEqual([1, 2])
      const graphState = await commandPort.readCurrent({
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
        rootTaskId: root.id, parentTaskId: root.id,
        turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
        parentLeaseOwner: lease.ownerId, parentAttemptCount: rootLease.attemptCount,
      })
      expect(graphState.nodes.map(node => [node.key, node.status])).toEqual([
        ["writer-v1", "completed"], ["reviewer-v1", "completed"], ["writer-v2", "failed"],
      ])
      expect(graphState.nodes.find(node => node.key === "writer-v1")?.resultProjection).toMatchObject({
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted",
        availability: "available", role: "writer", status: "completed", artifactRef: writerV1Ref,
      })
      expect(graphState.nodes.find(node => node.key === "reviewer-v1")?.resultProjection).toMatchObject({
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted",
        availability: "available", role: "reviewer", status: "completed", reviewStatus: "passed", artifactRef: writerV1Ref,
      })
      expect(graphState.nodes.find(node => node.key === "writer-v2")?.resultProjection).toMatchObject({
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "unavailable",
      })

      await expect(selectedJobArtifactCompletionGate({
        commandPort, lease, root: { id: root.id, attemptCount: rootLease.attemptCount },
        selectedJobId: sources.jobId, readCurrentDraftHead: scope => artifactRepository.findCurrentDraftHead(scope),
        readCurrentReviewReceipt: scope => artifactRepository.findReviewReceipt(scope),
        readCurrentSourceDigest: async () => (await loadSelectedJobArtifactContext(pool!, value.userId, sources.jobId)).preparation.sourceDigest,
      })).resolves.toEqual({
        ok: false, blocker: "selected_job_draft_review_required",
        feedback: "Complete and review the selected job's latest cover-letter draft before finishing.",
      })
    } finally {
      if (userSeeded) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    }
  }, 30_000)

  it("plans, waits, promotes dependencies, resumes with bounded evidence, appends a follow-up plan, and resumes again", async () => {
    const budgetUpdate = await pool!.query(`UPDATE "agent_turns" SET "budgetSnapshot" = $2::jsonb
      WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      owner.turnId, JSON.stringify({ limits: TASK_GRAPH_FIXTURE_TURN_LIMITS }), owner.sessionId, owner.userId,
    ])
    if (budgetUpdate.rowCount !== 1) throw new Error("Main TaskGraph fixture could not apply its test-specific turn budget")

    const [
      { createProductionWorkerBootstrap },
      { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { taskGraphItemId, taskGraphProposalKey },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./task-graph-snapshot.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let resumedGraphReachedModel = false
    let followUpGraphReachedModel = false
    let followUpExpectedRevision: number | undefined
    const largeSourceRepairTarget: { current: { graphRootTaskId: string; taskId: string } | null } = { current: null }
    let oversizedStructuredInputBytes = 0
    let rootModelStreamFailure: string | null = null
    let firstWaitPlanGraphDiagnostics: string | null = null
    let followUpPlanReceiptFailureDiagnostics: string | null = null
    let completedGraphStateFailureDiagnostics: string | null = null
    let rootModelFailureStage: RootModelFailureStage = "not_started"
    let childFixtureFailureStage: ChildFixtureFailureStage | null = null
    let childFixtureFailureSummary: string | null = null
    let rootWaitHandoffFailure: string | null = null
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: owner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        ...TASK_GRAPH_TEMPLATES,
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 2) {
              rootModelFailureStage = "resumed_graph_kind"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(graph?.kind).toBe("task_graph_current")
              if (modelRounds === 1) {
                const sourceIntents = Array.isArray(graph?.sourceIntent) ? graph.sourceIntent.map(record) : []
                expect(sourceIntents.map(item => item?.nodeKey)).toEqual(["source", "summary", "large-source"])
                expect(sourceIntents.map(item => [item?.goal, item?.successCriteria])).toEqual([
                  ["Read the fixture source", ["Capture source evidence"]],
                  ["Summarize the fixture source", ["Write a source summary"]],
                  [OVERSIZED_SOURCE_GOAL, ["Return structured source evidence"]],
                ])
                for (const item of sourceIntents) {
                  expect(Object.keys(item ?? {}).sort()).toEqual(["goal", "inputRelation", "nodeKey", "successCriteria"])
                  expectBoundedSourceIntent(item && { goal: item.goal, successCriteria: item.successCriteria, inputRelation: item.inputRelation }, {
                    goal: String(item?.goal ?? ""), successCriteria: Array.isArray(item?.successCriteria) ? item.successCriteria as string[] : [],
                  })
                }
                expect(JSON.stringify(graph)).not.toMatch(/sourceStepId|inputThroughSequence|consumedInputIds|cursor/)
                rootModelFailureStage = "resumed_graph_keys"
                expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source"])
                rootModelFailureStage = "resumed_graph_statuses"
                expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "failed"])
                rootModelFailureStage = "resumed_graph_readiness"
                expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal"])
                rootModelFailureStage = "large_source_projection"
                const largeSourceProjection = nodes.find(node => node?.key === "large-source")?.resultProjection
                expect(largeSourceProjection).toMatchObject({
                  schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
                  trust: "untrusted", availability: "unavailable",
                })
                expect(JSON.stringify(largeSourceProjection)).not.toContain("x".repeat(100))
                resumedGraphReachedModel = true
                rootModelFailureStage = "wait_outcome_status"
                const waitOutcome = waitOutcomeFromRequest(request, 3)
                const waitTasks = waitOutcome.tasks.map(record)
                expect(waitOutcome.status).toBe("ready")
                const waitTaskForNode = (key: string) => {
                  const taskId = nodes.find(node => node?.key === key)?.taskId
                  return waitTasks.find(task => task?.taskId === taskId)
                }
                const sourceWaitTask = waitTaskForNode("source")
                const summaryWaitTask = waitTaskForNode("summary")
                const largeSourceWaitTask = waitTaskForNode("large-source")
                rootModelFailureStage = "wait_task_statuses"
                expect(sourceWaitTask).toMatchObject({ status: "completed" })
                expect(summaryWaitTask).toMatchObject({ status: "completed" })
                expect(largeSourceWaitTask).toMatchObject({ status: "failed" })
                rootModelFailureStage = "source_wait_verification"
                expect(sourceWaitTask?.result).toMatchObject({ truncated: true })
                expectPassedVerificationReport(sourceWaitTask?.verificationReport, "candidate-count")
                rootModelFailureStage = "summary_wait_verification"
                expect(summaryWaitTask?.result).toMatchObject({ truncated: true })
                expectPassedVerificationReport(summaryWaitTask?.verificationReport, "finding-count")
                const revision = graph?.revision
                rootModelFailureStage = "resumed_graph_revision"
                if (typeof revision !== "number" || !Number.isSafeInteger(revision)) throw new Error("Resumed current graph revision is invalid")
                followUpExpectedRevision = revision
                const turn = await pool!.query<{ rootTaskId: string | null }>(
                  `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                  [owner.turnId, owner.sessionId, owner.userId],
                )
                const graphRootTaskId = turn.rows[0]?.rootTaskId
                const largeSourceTaskId = nodes.find(node => node?.key === "large-source")?.taskId
                if (!graphRootTaskId || typeof largeSourceTaskId !== "string") {
                  throw new Error("Oversized source repair fixture lost its immutable target identity")
                }
                largeSourceRepairTarget.current = { graphRootTaskId, taskId: largeSourceTaskId }
                rootModelFailureStage = "follow_up_plan_tool"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
                yield {
                  type: "tool_call_completed", callId: FOLLOW_UP_PLAN_CALL_ID, name: "agent.plan",
                  arguments: {
                    expectedRevision: followUpExpectedRevision,
                    nodes: [
                      {
                        key: "large-source-repair", templateId: "scout", goal: LARGE_SOURCE_REPAIR_GOAL,
                        successCriteria: ["Return one evidence-bound candidate"], dependsOn: [],
                        verification: SCOUT_VERIFICATION,
                        repairOf: {
                          graphRootTaskId, nodeKey: "large-source", taskId: largeSourceTaskId,
                          criterionIds: ["candidate-count"],
                        },
                      },
                      {
                        key: "verification", templateId: "analyst", goal: FOLLOW_UP_GOAL,
                        successCriteria: ["Verify the completed summary evidence"], dependsOn: ["summary"],
                        verification: ANALYST_VERIFICATION,
                      },
                    ],
                  },
                }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              if (modelRounds === 2) {
                rootModelFailureStage = "follow_up_graph_keys"
                expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "large-source-repair", "verification"])
                rootModelFailureStage = "follow_up_graph_statuses"
                expect(nodes.slice(0, 3).map(node => node?.status)).toEqual(["completed", "completed", "failed"])
                rootModelFailureStage = "follow_up_graph_readiness"
                expect(nodes.slice(0, 3).map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal"])
                expect(nodes.find(node => node?.key === "large-source-repair")).toMatchObject({
                  status: expect.stringMatching(/^(queued|running)$/),
                  repairOf: {
                    graphRootTaskId: largeSourceRepairTarget.current?.graphRootTaskId,
                    nodeKey: "large-source", taskId: largeSourceRepairTarget.current?.taskId,
                    criterionIds: ["candidate-count"],
                  },
                })
                rootModelFailureStage = "follow_up_plan_receipt_lookup"
                let plannedTaskIds: string[]
                try {
                  plannedTaskIds = planTaskIds(request, FOLLOW_UP_PLAN_CALL_ID, 2)
                } catch (error: unknown) {
                  followUpPlanReceiptFailureDiagnostics = await collectPlanReceiptFailureDiagnostics(
                    pool!, owner.turnId, request, FOLLOW_UP_PLAN_CALL_ID, graph,
                  )
                  throw error
                }
                rootModelFailureStage = "follow_up_graph_task_id"
                try {
                  expect(nodes.find(node => node?.key === "large-source-repair")).toMatchObject({
                    key: "large-source-repair", taskId: plannedTaskIds[0],
                  })
                  expect(nodes.find(node => node?.key === "verification")).toMatchObject({
                    key: "verification", taskId: plannedTaskIds[1],
                  })
                } catch (error: unknown) {
                  followUpPlanReceiptFailureDiagnostics = await collectPlanReceiptFailureDiagnostics(
                    pool!, owner.turnId, request, FOLLOW_UP_PLAN_CALL_ID, graph,
                  )
                  throw error
                }
                rootModelFailureStage = "follow_up_wait_tool"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
                yield {
                  type: "tool_call_completed", callId: FOLLOW_UP_WAIT_CALL_ID, name: "agent.wait",
                  arguments: {
                    idempotencyKey: `p3-task-graph-follow-up-wait:${owner.turnId}`,
                    taskIds: plannedTaskIds, mode: "all", timeoutMs: 20_000,
                  },
                }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              throw new Error("Unexpected model round before the follow-up TaskGraph wait")
            }
            if (execution === 3) {
              rootModelFailureStage = "completed_graph_kind"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(graph?.kind).toBe("task_graph_current")
              rootModelFailureStage = "completed_graph_keys"
              expect(nodes.map(node => node?.key)).toEqual(["source", "summary", "large-source", "large-source-repair", "verification"])
              try {
                rootModelFailureStage = "completed_graph_statuses"
                expect(nodes.map(node => node?.status)).toEqual(["completed", "completed", "failed", "completed", "completed"])
                rootModelFailureStage = "completed_graph_readiness"
                expect(nodes.map(node => node?.readiness)).toEqual(["terminal", "terminal", "terminal", "terminal", "terminal"])
              } catch (error: unknown) {
                completedGraphStateFailureDiagnostics = boundedDiagnostic(
                  JSON.stringify(completedGraphStatusFailureProjection(graph)), 1_200,
                )
                throw error
              }
              const repairTarget = largeSourceRepairTarget.current
              if (!repairTarget) throw new Error("Completed graph lost the oversized source repair target identity")
              const repairedSource = nodes.find(node => node?.key === "large-source")
              const repairNode = nodes.find(node => node?.key === "large-source-repair")
              expect(repairedSource).toMatchObject({ taskId: repairTarget.taskId, status: "failed" })
              expect(repairNode).toMatchObject({
                key: "large-source-repair", status: "completed",
                repairOf: {
                  graphRootTaskId: repairTarget.graphRootTaskId,
                  nodeKey: "large-source", taskId: repairTarget.taskId,
                  criterionIds: ["candidate-count"],
                },
                repairReceipt: {
                  graphRootTaskId: repairTarget.graphRootTaskId,
                  targetNodeKey: "large-source", targetTaskId: repairTarget.taskId,
                  criterionIds: ["candidate-count"],
                  repairNodeKey: "large-source-repair", repairTaskId: expect.any(String),
                },
              })
              followUpGraphReachedModel = true
              rootModelFailureStage = "completed_wait_outcome"
              const waitOutcome = waitOutcomeFromRequest(request, 2)
              const waitTasks = waitOutcome.tasks.map(record)
              expect(waitOutcome.status).toBe("ready")
              rootModelFailureStage = "completed_wait_status"
              expect(waitTasks.map(task => task?.status)).toEqual(["completed", "completed"])
              rootModelFailureStage = "completed_wait_summary"
              const taskIdForNode = (key: string) => nodes.find(node => node?.key === key)?.taskId
              const completedTaskForNode = (key: string) => waitTasks.find(task => task?.taskId === taskIdForNode(key))
              const completedRepairTask = completedTaskForNode("large-source-repair")
              expect(completedRepairTask?.result).toMatchObject({ truncated: true })
              expectPassedVerificationReport(completedRepairTask?.verificationReport, "candidate-count")
              expect(completedRepairTask?.repairReceipt).toMatchObject({
                graphRootTaskId: repairTarget.graphRootTaskId,
                targetNodeKey: "large-source", targetTaskId: repairTarget.taskId,
                criterionIds: ["candidate-count"], repairNodeKey: "large-source-repair",
                repairTaskId: taskIdForNode("large-source-repair"),
              })
              const completedVerificationTask = completedTaskForNode("verification")
              expect(completedVerificationTask?.result).toMatchObject({ truncated: true })
              expectPassedVerificationReport(completedVerificationTask?.verificationReport, "finding-count")
              yield { type: "text_delta", text: FINAL_MARKER }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            if (execution === 1 && modelRounds === 1) {
              rootModelFailureStage = "initial_plan_tool"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield {
                type: "tool_call_completed", callId: PLAN_CALL_ID, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "source", templateId: "scout", goal: "Read the fixture source", successCriteria: ["Capture source evidence"], dependsOn: [], verification: SCOUT_VERIFICATION },
                    { key: "summary", templateId: "analyst", goal: "Summarize the fixture source", successCriteria: ["Write a source summary"], dependsOn: ["source"], verification: ANALYST_VERIFICATION },
                    { key: "large-source", templateId: "scout", goal: OVERSIZED_SOURCE_GOAL, successCriteria: ["Return structured source evidence"], dependsOn: [], verification: SCOUT_VERIFICATION },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              rootModelFailureStage = "initial_wait_tool"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              rootModelFailureStage = "initial_wait_plan_receipt"
              const plannedTaskIds = planTaskIds(request, PLAN_CALL_ID, 3)
              const graph = currentGraphFromRequest(request)
              const graphNodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const graphTaskIds = graphNodes.flatMap(node => typeof node?.taskId === "string" ? [node.taskId] : [])
              const plannedIdSet = new Set(plannedTaskIds)
              const graphIdSet = new Set(graphTaskIds)
              if (plannedIdSet.size !== 3) {
                rootModelFailureStage = "initial_wait_plan_uniqueness"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              if (graphTaskIds.length !== 3) {
                rootModelFailureStage = "initial_wait_graph_count"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              if (graphIdSet.size !== 3) {
                rootModelFailureStage = "initial_wait_graph_uniqueness"
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              if (plannedIdSet.size !== graphIdSet.size
                || [...plannedIdSet].some(taskId => !graphIdSet.has(taskId))) {
                rootModelFailureStage = "initial_wait_plan_graph_set_mismatch"
                firstWaitPlanGraphDiagnostics = await collectFirstWaitPlanGraphMismatchDiagnostics(
                  pool!, owner.turnId, request, PLAN_CALL_ID, graph,
                )
                throw new Error("p3_task_graph_wait_ids_mismatch")
              }
              rootModelFailureStage = "initial_wait_tool"
              yield {
                type: "tool_call_completed", callId: WAIT_CALL_ID, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-wait:${owner.turnId}`,
                  taskIds: plannedTaskIds, mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            rootModelFailureStage = "unexpected_root_model_round"
            throw new Error("Unexpected root model execution or round in the TaskGraph resume fixture")
          },
        }
        return {
          adapter: captureModelStreamFailure(model, error => { rootModelStreamFailure = boundedErrorText(error) }),
          registry: {} as never,
          candidates: [],
        }
      },
    })
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: owner.ownerId,
      turnQueueFactory: withWaitHandoffDiagnostics(pool!, createTurnQueue, diagnostic => {
        rootWaitHandoffFailure = diagnostic
      }),
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-wait-resolver-${owner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          let stage: ChildFixtureFailureStage = "parent_wait"
          try {
            const minimumWaitCount = lease.goal === FOLLOW_UP_GOAL || lease.goal === LARGE_SOURCE_REPAIR_GOAL ? 2 : 1
            await waitForSuspendedParent(pool!, owner.turnId, minimumWaitCount)
            if (lease.goal === "Summarize the fixture source") {
              const taskContext = record(lease.context)
              const dependencyContext = record(taskContext?.taskGraphDependencyResults)
              const items = Array.isArray(dependencyContext?.items) ? dependencyContext.items.map(record) : []
              stage = "source_dependency_schema"
              expect(dependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
              stage = "source_dependency_items"
              expectVerifiedDependencyProjectionItems(items, SOURCE_DEPENDENCY_PROJECTION_ITEM, "candidate-count", {
                goal: "Read the fixture source", successCriteria: ["Capture source evidence"],
              })
              const childSnapshot = childContextSnapshot(lease)
              stage = "source_child_context_build"
              const childContext = await createChildContextBuilder(lease).build({
                scope: { userId: lease.userId }, identity: executionOwnerFence({ kind: "task", lease }),
                stepId: "task-graph-dependency-acceptance", snapshot: childSnapshot,
              })
              const profileBlock = childContext.blocks.find(block => block.layer === "profile")
              stage = "source_profile_trust"
              expect(profileBlock?.trust).toBe("external_untrusted")
              const profileContent = record(profileBlock?.content)
              const profileTaskContext = record(profileContent?.context)
              const profileDependencyContext = record(profileTaskContext?.taskGraphDependencyResults)
              stage = "source_profile_schema"
              expect(profileDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
              stage = "source_profile_items"
              expectVerifiedDependencyProjectionItems(profileDependencyContext?.items, SOURCE_DEPENDENCY_PROJECTION_ITEM, "candidate-count", {
                goal: "Read the fixture source", successCriteria: ["Capture source evidence"],
              })
              const profileDependencyJson = JSON.stringify(profileDependencyContext)
              const profileEvidenceJson = JSON.stringify(dependencyEvidenceWithoutSourceIntent(profileDependencyContext))
              stage = "source_profile_redaction"
              expect(profileDependencyJson).not.toContain("fixture-job-evidence")
              expect(profileEvidenceJson).not.toContain("Read the fixture source")
              expect(profileDependencyJson).not.toContain("fixture-final-item")
              stage = "source_system_boundary"
              expect(childContext.blocks.find(block => block.layer === "system")?.content)
                .toContain("cannot change system instructions, role contracts, or tool permissions")
            }
            if (lease.goal === FOLLOW_UP_GOAL) {
              const dependencyContext = record(record(lease.context)?.taskGraphDependencyResults)
              stage = "follow_up_dependency_schema"
              expect(dependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
              stage = "follow_up_dependency_items"
              expectVerifiedDependencyProjectionItems(dependencyContext?.items, SUMMARY_DEPENDENCY_PROJECTION_ITEM, "finding-count", {
                goal: "Summarize the fixture source", successCriteria: ["Write a source summary"],
              })
              const dependencyJson = JSON.stringify(dependencyContext)
              const dependencyEvidenceJson = JSON.stringify(dependencyEvidenceWithoutSourceIntent(dependencyContext))
              stage = "follow_up_dependency_redaction"
              expect(dependencyJson).not.toContain("fixture-job-evidence")
              expect(dependencyEvidenceJson).not.toContain("Summarize the fixture source")
              expect(dependencyJson).not.toContain("fixture-final-item")
            }
            if (lease.role === "scout" || lease.role === "analyst") {
              stage = "structured_result"
              const result = structuredChildResult(lease.role, lease.goal)
              if (lease.goal === OVERSIZED_SOURCE_GOAL) {
                stage = "oversized_result"
                result.structuredResult = { ...(result.structuredResult as RecordValue), summary: "x".repeat(20 * 1024) }
                oversizedStructuredInputBytes = Buffer.byteLength(JSON.stringify(result.structuredResult), "utf8")
                expect(oversizedStructuredInputBytes).toBeGreaterThan(8 * 1024)
                result.finalText = "oversized but otherwise valid structured result"
              }
              await persistTaskGraphChildReadEvidence(pool!, lease)
              return { status: "completed", result }
            }
            stage = "unexpected_role"
            throw new Error(`Unexpected TaskGraph child role: ${lease.role}`)
          } catch (error: unknown) {
            if (childFixtureFailureStage === null) {
              childFixtureFailureStage = stage
              childFixtureFailureSummary = childFixtureErrorSummary(error)
            }
            throw error
          }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId,
    })
    try {
      await waitForTurnStatus(pool!, owner.turnId, "completed", 50_000, WAIT_CALL_ID)
    } catch (error: unknown) {
      const progress = await turnProgressDiagnostics(pool!, owner.turnId, WAIT_CALL_ID)
      const rootModelFailureDiagnostic: FailureDiagnosticField[] = rootModelStreamFailure
        ? [{ label: `rootModelFailureAt_${rootModelFailureStage}`, value: "captured" }]
        : []
      const followUpReceiptDiagnostic: FailureDiagnosticField[] = followUpPlanReceiptFailureDiagnostics
        ? [{ label: "followUpPlanReceiptEvidence", value: "captured", safeValue: followUpPlanReceiptFailureDiagnostics }]
        : []
      const completedGraphStateDiagnostic: FailureDiagnosticField[] = completedGraphStateFailureDiagnostics
        ? [{ label: "completedGraphStateEvidence", value: "captured", safeValue: completedGraphStateFailureDiagnostics }]
        : []
      const childFailureDiagnostic: FailureDiagnosticField[] = childFixtureFailureStage
        ? [
          { label: `childFixtureFailureAt_${childFixtureFailureStage}`, value: "captured" },
          { label: "childFixtureError", value: "captured", safeValue: childFixtureFailureSummary ?? "<not captured>" },
        ]
        : []
      const handoffSuffix = rootWaitHandoffFailure
        ? `; waitHandoffState=${JSON.stringify(waitHandoffFailureProjection(rootWaitHandoffFailure))}`
        : ""
      throw new Error(boundedDiagnostic(combineFailureDiagnostics([
        ...childFailureDiagnostic,
        { label: "rootModelStreamFailure", value: rootModelStreamFailure ?? "<not captured>" },
        ...rootModelFailureDiagnostic,
        ...followUpReceiptDiagnostic,
        ...completedGraphStateDiagnostic,
        { label: "waitHandoffFailure", value: rootWaitHandoffFailure ?? "<not captured>" },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress, firstWaitPlanGraphDiagnostics) + handoffSuffix, 4_500))
    }
    const parkedTurns = await pool!.query<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "agent_turns" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [[failureOwner.turnId, stopOwner.turnId, restartOwner.turnId]],
    )
    expect(new Map(parkedTurns.rows.map(({ id, status }) => [id, status]))).toEqual(new Map([
      failureOwner.turnId, stopOwner.turnId, restartOwner.turnId,
    ].map(id => [id, "waiting_for_user"])))

    const turn = await pool!.query<{ rootTaskId: string; leaseVersion: number; finalResponse: string | null }>(
      `SELECT "rootTaskId", "leaseVersion", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [owner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    expect(turn.rows[0]).toMatchObject({ leaseVersion: 3 })
    expect(rootRuntimeExecutions).toBe(3)
    expect(resumedGraphReachedModel).toBe(true)
    expect(followUpGraphReachedModel).toBe(true)
    expect(JSON.stringify(turn.rows[0]?.finalResponse)).toContain(FINAL_MARKER)

    const children = await pool!.query<{ id: string; goal: string; status: string; result: RecordValue | null; context: RecordValue; role: string; failureReason: string | null }>(
      `SELECT "id", "goal", "status", "result", "context", "role", "failureReason" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "goal"`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(5)
    const childByGoal = new Map(children.rows.map(child => [child.goal, child] as const))
    expect(childByGoal.get("Read the fixture source")).toMatchObject({ status: "completed", role: "scout" })
    expect(record(childByGoal.get("Read the fixture source")?.result?.structuredResult)?.candidates).toMatchObject([{ jobId: "fixture-job-1" }])
    expectPassedVerificationReport(record(childByGoal.get("Read the fixture source")?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(childByGoal.get("Summarize the fixture source")).toMatchObject({ status: "completed", role: "analyst" })
    expect(record(childByGoal.get("Summarize the fixture source")?.result?.structuredResult)?.findings).toMatchObject([{ jobId: "fixture-job-1", score: 8 }])
    expectPassedVerificationReport(record(childByGoal.get("Summarize the fixture source")?.result)?.taskGraphVerificationReport, "finding-count")
    expect(childByGoal.get(FOLLOW_UP_GOAL)).toMatchObject({ status: "completed", role: "analyst" })
    expectPassedVerificationReport(record(childByGoal.get(FOLLOW_UP_GOAL)?.result)?.taskGraphVerificationReport, "finding-count")
    expect(record(record(childByGoal.get(FOLLOW_UP_GOAL)?.result)?.structuredResult)).toMatchObject({
      summary: FOLLOW_UP_GOAL,
      evidence: [{ id: "read:job:fixture-job-1", kind: "job", ref: "fixture-job-1", source: "fixture" }],
    })
    expect(childByGoal.get(LARGE_SOURCE_REPAIR_GOAL)).toMatchObject({ status: "completed", role: "scout" })
    expectPassedVerificationReport(record(childByGoal.get(LARGE_SOURCE_REPAIR_GOAL)?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(record(record(childByGoal.get(LARGE_SOURCE_REPAIR_GOAL)?.result)?.structuredResult)).toMatchObject({
      summary: LARGE_SOURCE_REPAIR_GOAL,
      evidence: [{ id: "read:job:fixture-job-1", kind: "job", ref: "fixture-job-1", source: "fixture" }],
    })
    const repairTarget = largeSourceRepairTarget.current
    if (!repairTarget) throw new Error("Final assertions lost the oversized source repair target identity")
    expect(record(childByGoal.get(LARGE_SOURCE_REPAIR_GOAL)?.result)?.taskGraphRepairReceipt).toMatchObject({
      graphRootTaskId: repairTarget.graphRootTaskId,
      targetNodeKey: "large-source", targetTaskId: repairTarget.taskId,
      criterionIds: ["candidate-count"], repairNodeKey: "large-source-repair",
      repairTaskId: childByGoal.get(LARGE_SOURCE_REPAIR_GOAL)?.id,
    })
    expect(childByGoal.get(OVERSIZED_SOURCE_GOAL)).toMatchObject({ status: "failed", role: "scout", failureReason: "task_graph_verification_unverified" })
    expect(oversizedStructuredInputBytes).toBeGreaterThan(8 * 1024)
    const oversizedStoredResult = record(childByGoal.get(OVERSIZED_SOURCE_GOAL)?.result)
    expect(oversizedStoredResult?.structuredResult).toBeUndefined()
    expect(Buffer.byteLength(JSON.stringify(oversizedStoredResult ?? {}), "utf8")).toBeLessThan(8 * 1024)
    expectUnverifiedVerificationReport(oversizedStoredResult?.taskGraphVerificationReport, "candidate-count")
    const summarizeDependencyContext = record(childByGoal.get("Summarize the fixture source")?.context.taskGraphDependencyResults)
    expect(summarizeDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expectVerifiedDependencyProjectionItems(summarizeDependencyContext?.items, SOURCE_DEPENDENCY_PROJECTION_ITEM, "candidate-count", {
      goal: "Read the fixture source", successCriteria: ["Capture source evidence"],
    })
    const summarizeDependencyJson = JSON.stringify(summarizeDependencyContext)
    const summarizeEvidenceJson = JSON.stringify(dependencyEvidenceWithoutSourceIntent(summarizeDependencyContext))
    expect(summarizeDependencyJson).not.toContain("fixture-job-evidence")
    expect(summarizeEvidenceJson).not.toContain("Read the fixture source")
    expect(summarizeDependencyJson).not.toContain("fixture-final-item")

    const followUpDependencyContext = record(childByGoal.get(FOLLOW_UP_GOAL)?.context.taskGraphDependencyResults)
    expect(followUpDependencyContext?.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expectVerifiedDependencyProjectionItems(followUpDependencyContext?.items, SUMMARY_DEPENDENCY_PROJECTION_ITEM, "finding-count", {
      goal: "Summarize the fixture source", successCriteria: ["Write a source summary"],
    })
    const followUpDependencyJson = JSON.stringify(followUpDependencyContext)
    const followUpEvidenceJson = JSON.stringify(dependencyEvidenceWithoutSourceIntent(followUpDependencyContext))
    expect(followUpDependencyJson).not.toContain("fixture-job-evidence")
    expect(followUpEvidenceJson).not.toContain("Summarize the fixture source")
    expect(followUpDependencyJson).not.toContain("fixture-final-item")
    const childDispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null; payload: RecordValue }>(
      `SELECT "idempotencyKey", "publishedAt", "payload" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' ORDER BY "createdAt"`,
      [owner.sessionId],
    )
    expect(childDispatches.rows).toHaveLength(5)
    expect(childDispatches.rows.map(row => row.payload.taskId)).toEqual(expect.arrayContaining(
      children.rows.filter(child => child.status === "completed").map(child => child.id),
    ))
    expect(childDispatches.rows.every(row => row.publishedAt instanceof Date)).toBe(true)

    const item = await pool!.query<{ revision: number }>(
      `SELECT "revision" FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(item.rows[0]?.revision).toBeGreaterThanOrEqual(6)
    const graphEvents = await pool!.query<{ idempotencyKey: string; payload: RecordValue }>(
      `SELECT "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 ORDER BY "sequence"`,
      [owner.sessionId, owner.turnId, taskGraphItemId(rootTaskId!)],
    )
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphProposalKey(rootTaskId!, 0))).toBe(true)
    expect(followUpExpectedRevision).toEqual(expect.any(Number))
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphProposalKey(rootTaskId!, followUpExpectedRevision!))).toBe(true)
    const lifecycleTypes = graphEvents.rows.flatMap(event => {
      const payload = record(event.payload)
      const lifecycle = record(payload?.event)
      return payload?.kind === "lifecycle" && typeof lifecycle?.type === "string" ? [lifecycle.type] : []
    })
    expect(lifecycleTypes).toEqual(expect.arrayContaining(["task.started", "task.queued", "task.completed"]))

    const wait = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; matchedTaskIds: string[] }>(
      `SELECT "id", "status", "suspendedAt", "consumedAt", "matchedTaskIds" FROM "agent_wait_conditions" WHERE "turnId" = $1 ORDER BY "createdAt" ASC`,
      [owner.turnId],
    )
    expect(wait.rows).toHaveLength(2)
    expect(wait.rows.every(row => row.status === "ready" && row.suspendedAt instanceof Date && row.consumedAt instanceof Date)).toBe(true)
    // The first all-mode wait targets three tasks; each target must reach a terminal state.
    expect(wait.rows.map(row => row.matchedTaskIds.length)).toEqual([3, 2])
    for (const row of wait.rows) {
      const wakeEvents = await pool!.query<{ count: string }>(
        `SELECT COUNT(*)::text AS "count" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
        [owner.sessionId, `agent-wait:${row.id}:resumed`],
      )
      expect(wakeEvents.rows[0]?.count).toBe("1")
    }
    const wakeDispatch = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null; payload: RecordValue }>(
      `SELECT "idempotencyKey", "publishedAt", "payload" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.turn.dispatch' AND "idempotencyKey" = $2`,
      [owner.sessionId, `turn-dispatch:${owner.turnId}`],
    )
    expect(wakeDispatch.rows).toHaveLength(1)
    expect(wakeDispatch.rows[0]).toMatchObject({
      idempotencyKey: `turn-dispatch:${owner.turnId}`,
      publishedAt: expect.any(Date),
      payload: { turnId: owner.turnId, sessionId: owner.sessionId },
    })
  }, 90_000)

  it("restores the TaskGraph after a real Worker restart and completes a follow-up plan", async () => {
    if (planLedgerTraceArtifactPath) await rm(planLedgerTraceArtifactPath, { force: true })
    const [turnModule, subagentModule] = await Promise.all([
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
    ])
    turnQueueName = turnModule.TURN_QUEUE_NAME
    childQueueName = subagentModule.SUBAGENT_QUEUE_NAME
    let workerOne: ProcessFixtureChild | undefined
    let workerTwo: ProcessFixtureChild | undefined
    let artifactPlan: SelectedJobArtifactRestartPlan | undefined
    let artifactTrace: SelectedJobArtifactRestartTrace | undefined
    let artifactReviewTrace: SelectedJobArtifactReviewTrace | undefined
    let primaryBodyFailure: Error | null = null
    try {
      if (!artifactOwnerSources || !redis) throw new Error("Selected-job fixture sources or Redis were not initialized")
      const restartJobId = fixtureJobId(restartOwner.suffix, 0)
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
        VALUES ($1, $2, 'Restart Proof Fixture', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/restart-proof', 'Persisted evidence for restart verification', 'greenhouse', CURRENT_TIMESTAMP)`, [
        restartJobId, restartOwner.userId,
      ])
      selectedJobQueueName = `agent-subagents-ac6-${artifactOwner.suffix}`
      artifactPlan = await createSelectedJobTaskGraph(pool!, artifactOwner, artifactOwnerSources, selectedJobQueueName)
      const selectedJobForWorkerOne = {
        queueName: artifactPlan.queueName, userId: artifactOwner.userId, sessionId: artifactOwner.sessionId,
        turnId: artifactOwner.turnId, rootTaskId: artifactPlan.rootTaskId, jobId: artifactPlan.jobId,
        body: artifactPlan.body, writerTaskId: artifactPlan.writerTask.id,
      }
      workerOne = startTaskGraphRestartWorker("park-parent", { ...restartOwner, selectedJob: selectedJobForWorkerOne })
      const suspendedLine = await waitForProcessLine(workerOne, "P3_PARENT_SUSPENDED ", 45_000)
      if (workerOne.pid === undefined) throw new Error("P3 first Worker has no OS process ID")
      expect(suspendedLine).toContain("p3-process-restart-worker-" + workerOne.pid)
      await waitForProcessLine(workerOne, `P3_SELECTED_JOB_QUEUE_READY ${selectedJobQueueName}`)

      const beforeTurn = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number; rootTaskId: string | null }>(
        "SELECT \"status\", \"leaseOwnerId\", \"leaseVersion\", \"rootTaskId\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(beforeTurn.rows[0]).toMatchObject({
        status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1,
      })
      const rootTaskId = beforeTurn.rows[0]?.rootTaskId
      expect(rootTaskId).toBeTruthy()

      const graphBefore = await pool!.query<TaskGraphItemRow>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"revision\", \"content\", \"startedAt\", \"completedAt\", \"createdAt\", \"updatedAt\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphBefore.rows).toHaveLength(1)
      const graphSnapshot = record(graphBefore.rows[0]?.content)
      const graphNodes = Array.isArray(graphSnapshot?.nodes) ? graphSnapshot.nodes.map(record) : []
      expect(graphSnapshot?.schemaVersion).toBe("agent-harness.v2.task-graph")
      expect(graphNodes.map(node => node?.key)).toEqual(["source", "summary"])
      expect(graphBefore.rows[0]?.revision).toBeGreaterThan(0)

      const waitsBefore = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"suspendedAt\", \"consumedAt\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1",
        [restartOwner.turnId],
      )
      expect(waitsBefore.rows).toHaveLength(1)
      expect(waitsBefore.rows[0]).toMatchObject({ status: "waiting", consumedAt: null })
      expect(waitsBefore.rows[0]?.suspendedAt).toBeInstanceOf(Date)
      const targetTaskIds = Array.isArray(waitsBefore.rows[0]?.targetTaskIds)
        ? waitsBefore.rows[0]?.targetTaskIds as string[]
        : JSON.parse(String(waitsBefore.rows[0]?.targetTaskIds)) as string[]
      expect(targetTaskIds).toHaveLength(2)
      const pendingTasks = await pool!.query<{ goal: string; status: string }>(
        "SELECT \"goal\", \"status\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2 ORDER BY \"goal\"",
        [restartOwner.turnId, rootTaskId],
      )
      expect(pendingTasks.rows).toEqual([
        { goal: "Read the durable TaskGraph source", status: "queued" },
        { goal: "Summarize the restored TaskGraph source", status: "waiting" },
      ])

      await enqueueSelectedJobTask(
        artifactPlan.queueName, redis!, artifactPlan.writerTask, `ac6-writer-worker-one-${artifactOwner.suffix}`,
      )
      const writerLine = await waitForProcessLine(
        workerOne, `P3_SELECTED_JOB_CHILD_SETTLED ${artifactPlan.writerTask.id} `, 30_000,
      )
      artifactTrace = await traceSelectedJobWriterFromWorker(artifactPlan, writerLine)
      const writerVersion = await pool!.query<{
        version: number; contentHash: string; sourceDigest: string; content: unknown; userId: string; sessionId: string;
        jobId: string; provenanceRefs: string[]; evidenceRefs: string[]; taskId: string; toolCallId: string; requestHash: string;
      }>(
        `SELECT "version", "contentHash", "sourceDigest", "content", "userId", "sessionId", "jobId",
          "provenanceRefs", "evidenceRefs", "taskId", "toolCallId", "requestHash" FROM "agent_artifact_version"
          WHERE "taskId" = $1 AND "toolCallId" = $2`, [artifactTrace.writerTask.id, artifactTrace.writerDraftCallId],
      )
      expect(writerVersion.rows).toHaveLength(1)
      expect(writerVersion.rows[0]).toMatchObject({
        userId: artifactOwner.userId,
        sessionId: artifactOwner.sessionId,
        jobId: artifactPlan.jobId,
        version: 1, contentHash: artifactTrace.artifactRef.contentHash,
        sourceDigest: artifactTrace.artifactRef.sourceDigest, content: artifactTrace.body,
        provenanceRefs: artifactPlan.originalPreparation.preparation.evidenceRefs,
        evidenceRefs: artifactPlan.originalPreparation.preparation.evidenceRefs,
        taskId: artifactPlan.writerTask.id,
        toolCallId: artifactTrace.writerDraftCallId,
        requestHash: artifactTrace.writerRequestHash,
      })

      const firstWorkerPid = workerOne.pid
      const firstExit = waitForProcessExit(workerOne)
      noteFixtureSigkillTurnJob(workerOne, turnQueueName!, turnJobId(restartOwner.turnId, 0))
      const killAccepted = workerOne.kill("SIGKILL")
      await firstExit
      expect(killAccepted).toBe(true)
      expect(workerOne.signalCode).toBe("SIGKILL")
      expect(workerOne.exitCode).toBeNull()

      const afterKillTurn = await pool!.query<{ status: string; leaseOwnerId: string | null; leaseVersion: number }>(
        "SELECT \"status\", \"leaseOwnerId\", \"leaseVersion\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(afterKillTurn.rows[0]).toEqual({ status: "waiting_for_dependency", leaseOwnerId: null, leaseVersion: 1 })
      const graphAfterKill = await pool!.query<TaskGraphItemRow>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"revision\", \"content\", \"startedAt\", \"completedAt\", \"createdAt\", \"updatedAt\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphAfterKill.rows).toEqual(graphBefore.rows)
      const waitAfterKill = await pool!.query<{ id: string; status: string; suspendedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"suspendedAt\", \"consumedAt\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1",
        [restartOwner.turnId],
      )
      expect(waitAfterKill.rows).toEqual(waitsBefore.rows)

      if (!artifactTrace) throw new Error("Selected-job Writer did not settle in Worker 1")
      artifactReviewTrace = await prepareSelectedJobReviewAfterRestart(pool!, artifactOwner, artifactTrace)
      // Worker 2 also starts database-wide default-queue recovery. Publish and
      // enqueue these direct-store fixture tasks on their dedicated queue first
      // so recovery does not misroute them to the generic subagent executor.
      await enqueueSelectedJobReviewTasksBeforeWorkerTwo(pool!, redis, artifactOwner, artifactReviewTrace)

      workerTwo = startTaskGraphRestartWorker("resume-parent", {
        ...restartOwner,
        jobId: restartJobId,
        expectedRevision: graphBefore.rows[0]!.revision,
        expectedSnapshot: graphSnapshot,
        selectedJob: {
          queueName: artifactReviewTrace.queueName, userId: artifactOwner.userId, sessionId: artifactOwner.sessionId,
          turnId: artifactOwner.turnId, rootTaskId: artifactReviewTrace.rootTaskId, jobId: artifactReviewTrace.jobId,
          expectedBodyHash: hashArtifactContent(artifactReviewTrace.body), writerTaskId: artifactReviewTrace.writerTask.id,
          reviewerTaskId: artifactReviewTrace.reviewerTask.id,
          stopReviewerTaskId: artifactReviewTrace.stopReviewerTask.id,
        },
      })
      expect(workerTwo.pid).not.toBe(firstWorkerPid)
      const readyLine = await waitForProcessLine(workerTwo, "P3_SECOND_WORKER_READY ")
      expect(readyLine).toContain("p3-process-restart-worker-" + workerTwo.pid)
      await waitForProcessLine(workerTwo, `P3_SELECTED_JOB_QUEUE_READY ${selectedJobQueueName}`)
      try {
        await waitForProcessLine(workerTwo, "P3_DEPENDENT_WAITING_BEFORE_SOURCE_PROOF")
        await waitForProcessLine(workerTwo, "P3_SOURCE_PROOF_UNLOCKED_DEPENDENT")
        await waitForProcessLine(workerTwo, "P3_DEPENDENCY_CONTEXT_OK")
      } catch (error) {
        const progress = await turnProgressDiagnostics(pool!, restartOwner.turnId, "p3-process-restart-wait")
        const parentModelFailure = workerTwo.output.find(line => line.startsWith("P3_PARENT_MODEL_FAILURE_GUARD ")) ?? null
        const restartEvidence = await processRestartFailureDiagnostic(pool!, restartOwner.turnId, workerTwo.output)
        const processErrorText = error instanceof Error ? error.message : String(error)
        const processError = parentModelFailure
          ? processErrorText.replace(parentModelFailure, "<parent model failure captured separately>")
          : processErrorText
        throw new Error(combineFailureDiagnostics([
          ...parentModelFailureDiagnosticFields(
            parentModelFailure,
            processFixtureFailureCategory(workerTwo.output, "P3_PARENT_MODEL_FAILURE_CLASS "),
          ),
          { label: "processError", value: processError },
          { label: "restartEvidence", value: "", safeValue: JSON.stringify(restartEvidence) },
        ], progress))
      }
      try {
        await waitForProcessLine(workerTwo, "P3_RESTORED_GRAPH_OK")
      } catch (error: unknown) {
        const progress = await turnProgressDiagnostics(pool!, restartOwner.turnId, "p3-process-restart-wait")
        const parentModelFailure = workerTwo.output.find(line => line.startsWith("P3_PARENT_MODEL_FAILURE_GUARD ")) ?? null
        const restartEvidence = await processRestartFailureDiagnostic(pool!, restartOwner.turnId, workerTwo.output)
        const processErrorText = error instanceof Error ? error.message : String(error)
        const processError = parentModelFailure
          ? processErrorText.replace(parentModelFailure, "<parent model failure captured separately>")
          : processErrorText
        throw new Error(combineFailureDiagnostics([
          ...parentModelFailureDiagnosticFields(
            parentModelFailure,
            processFixtureFailureCategory(workerTwo.output, "P3_PARENT_MODEL_FAILURE_CLASS "),
          ),
          { label: "processError", value: processError },
          { label: "restartEvidence", value: "", safeValue: JSON.stringify(restartEvidence) },
        ], progress))
      }
      await waitForProcessLine(workerTwo, "P3_PARENT_RESUME_CONTEXT_OK")
      await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK")
      let persistedFollowUpWait: { id: string }
      try {
        persistedFollowUpWait = await waitForPersistedTaskWait(
          pool!, restartOwner.turnId, "p3-process-restart-follow-up-wait:" + restartOwner.turnId,
        )
      } catch {
        const persistence = await restartFollowUpWaitDiagnostics(
          pool!, restartOwner.turnId,
          "p3-process-restart-follow-up-wait:" + restartOwner.turnId,
          "p3-process-restart-follow-up-wait",
        )
        const workerMarkers = {
          ready: workerTwo.output.some(line => line.startsWith("P3_SECOND_WORKER_READY ")),
          dependentWaitingBeforeProof: workerTwo.output.some(line => line === "P3_DEPENDENT_WAITING_BEFORE_SOURCE_PROOF"),
          sourceProofUnlockedDependent: workerTwo.output.some(line => line === "P3_SOURCE_PROOF_UNLOCKED_DEPENDENT"),
          dependencyContext: workerTwo.output.some(line => line === "P3_DEPENDENCY_CONTEXT_OK"),
          parentResumeContext: workerTwo.output.some(line => line === "P3_PARENT_RESUME_CONTEXT_OK"),
          followUpDependencyContext: workerTwo.output.some(line => line === "P3_FOLLOW_UP_DEPENDENCY_CONTEXT_OK"),
          parentModelFailureGuardMarkerPresent: workerTwo.output.some(line => line.startsWith("P3_PARENT_MODEL_FAILURE_GUARD ")),
        }
        throw new Error(boundedDiagnostic(JSON.stringify({
          secondWorkerOutputPresent: workerTwo.output.length > 0,
          secondWorkerErrorPresent: workerTwo.errors.length > 0,
          workerMarkers,
          persistence,
        }), 1_500))
      }
      expect(persistedFollowUpWait.id).toBeTruthy()
      workerTwo.stdin?.write("complete-follow-up-child\n")
      let followUpReadyLine: string
      try {
        followUpReadyLine = await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_GRAPH_READY ")
      } catch (error: unknown) {
        let progress = JSON.stringify({ available: false })
        const parentModelFailureClass = processFixtureFailureCategory(
          workerTwo.output, "P3_PARENT_MODEL_FAILURE_CLASS ",
        )
        const parentModelFailureGuard = processRestartGuardMarker(workerTwo.output)
        try {
          progress = await turnProgressDiagnostics(pool!, restartOwner.turnId, "p3-process-restart-follow-up-wait")
        } catch {
          // Keep the marker-wait failure primary if database diagnostics are unavailable.
        }
        throw new Error(combineFailureDiagnostics([
          { label: "followUpGraphReadyMarker", value: "missing" },
          { label: "followUpMarkerWaitFailure", value: processLineWaitFailureKind(error, "P3_FOLLOW_UP_GRAPH_READY ") },
          { label: "workerProcessState", value: workerTwo.signalCode !== null ? "signaled" : workerTwo.exitCode !== null ? "exited" : "running" },
          { label: "parentModelFailureClass", value: "", safeValue: diagnosticEnum(
            parentModelFailureClass, PROCESS_FIXTURE_FAILURE_CATEGORIES,
          ) ?? "other" },
          { label: "parentModelFailureGuard", value: "", safeValue: diagnosticEnum(
            parentModelFailureGuard, PROCESS_RESTART_GUARD_MARKERS,
          ) ?? "other" },
        ], progress))
      }

      const preFinalGraph = await pool!.query<{ id: string; revision: number; content: RecordValue }>(
        "SELECT \"id\", \"revision\", \"content\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(preFinalGraph.rows).toHaveLength(1)
      const preFinalSnapshot = record(preFinalGraph.rows[0]?.content)
      const preFinalNodes = Array.isArray(preFinalSnapshot?.nodes) ? preFinalSnapshot.nodes.map(record) : []
      expect(preFinalNodes.map(node => node?.key)).toEqual(["source", "summary", RESTART_FOLLOW_UP_KEY])
      const preFinalFollowUpId = preFinalNodes[2]?.taskId
      expect(typeof preFinalFollowUpId).toBe("string")
      expect(followUpReadyLine).toContain(String(preFinalFollowUpId))

      if (!artifactReviewTrace || !redis) throw new Error("Selected-job review fixture was not prepared for Worker 2")
      await reviewSelectedJobThroughRestartedWorker(pool!, artifactOwner, artifactReviewTrace, workerOne!, workerTwo!)

      const preFinalChildResult = await pool!.query<{ status: string; role: string; goal: string; result: RecordValue | null; context: RecordValue | null }>(
        "SELECT \"status\", \"role\", \"goal\", \"result\", \"context\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"rootTaskId\" = $4 AND \"parentTaskId\" = $4",
        [preFinalFollowUpId, restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(preFinalChildResult.rows[0]).toMatchObject({ status: "completed", role: "analyst", goal: RESTART_FOLLOW_UP_GOAL })
      const preFinalContext = record(record(preFinalChildResult.rows[0]?.context)?.taskGraphDependencyResults)
      const preFinalDependencies = Array.isArray(preFinalContext?.items) ? preFinalContext.items.map(record) : []
      expect(preFinalDependencies[0]).toMatchObject({ dependencyKey: "summary", role: "analyst", taskStatus: "completed" })
      expect(record(preFinalDependencies[0]?.result)).toMatchObject({ availability: "available", role: "analyst" })

      const preFinalEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
        "SELECT \"taskId\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"itemId\" = $3 ORDER BY \"sequence\"",
        [restartOwner.sessionId, restartOwner.turnId, preFinalGraph.rows[0]!.id],
      )
      const preFinalProposal = preFinalEvents.rows.find(event => {
        const payload = record(event.payload)
        const receipt = record(payload?.receipt)
        const receiptNodes = Array.isArray(receipt?.nodes) ? receipt.nodes.map(record) : []
        return payload?.kind === "proposal" && receiptNodes.some(node => node?.key === RESTART_FOLLOW_UP_KEY && node.taskId === preFinalFollowUpId)
      })
      expect(record(record(preFinalProposal?.payload)?.receipt)).toMatchObject({
        status: "accepted", nodes: [{ key: RESTART_FOLLOW_UP_KEY, taskId: preFinalFollowUpId, status: "queued" }],
      })
      expect(preFinalEvents.rows.some(event => event.taskId === preFinalFollowUpId
        && record(event.payload)?.kind === "lifecycle"
        && record(record(event.payload)?.event)?.type === "task.completed")).toBe(true)
      const assertTypedWaitTaskProjection = (result: unknown, taskId: string, criterionId: string) => {
        const outcome = record(record(result)?.outcome)
        const targetTaskIds = Array.isArray(outcome?.targetTaskIds) ? outcome.targetTaskIds : []
        const tasks = Array.isArray(outcome?.tasks) ? outcome.tasks.map(record) : []
        const task = tasks.find(candidate => candidate?.taskId === taskId)
        expect(targetTaskIds).toContain(taskId)
        expect(task).toMatchObject({ taskId, status: "completed", result: { truncated: true } })
        expectPassedVerificationReport(task?.verificationReport, criterionId)
      }
      const assertFollowUpWaitProjection = (result: unknown, taskId: string) => {
        assertTypedWaitTaskProjection(result, taskId, "finding-count")
        const outcome = record(record(result)?.outcome)
        expect(JSON.stringify(outcome)).not.toContain(RESTART_FOLLOW_UP_GOAL)
      }

      const preFinalWaits = await pool!.query<{ status: string; consumedAt: Date | null; targetTaskIds: unknown; result: unknown }>(
        "SELECT \"status\", \"consumedAt\", \"targetTaskIds\", \"result\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2",
        [restartOwner.turnId, rootTaskId],
      )
      const preFinalFollowUpWait = preFinalWaits.rows.find(row => {
        const ids = Array.isArray(row.targetTaskIds) ? row.targetTaskIds : JSON.parse(String(row.targetTaskIds)) as unknown[]
        return ids.includes(preFinalFollowUpId)
      })
      expect(preFinalFollowUpWait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      assertFollowUpWaitProjection(preFinalFollowUpWait?.result, String(preFinalFollowUpId))

      workerTwo.stdin?.write("finalize-parent\n")
      await waitForProcessLine(workerTwo, "P3_FOLLOW_UP_GRAPH_OK ")
      await waitForTurnStatus(pool!, restartOwner.turnId, "completed", 60_000)

      const resumedTurn = await pool!.query<{ status: string; leaseVersion: number; rootTaskId: string | null; finalResponse: string | null }>(
        "SELECT \"status\", \"leaseVersion\", \"rootTaskId\", \"finalResponse\" FROM \"agent_turns\" WHERE \"id\" = $1",
        [restartOwner.turnId],
      )
      expect(resumedTurn.rows[0]).toMatchObject({ status: "completed", leaseVersion: 3, rootTaskId })
      expect(resumedTurn.rows[0]?.finalResponse).toContain("p3-process-restart-parent-resumed-after-follow-up")

      const graphAfterResume = await pool!.query<TaskGraphItemRow>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"stepId\", \"taskId\", \"type\", \"status\", \"phase\", \"revision\", \"content\", \"startedAt\", \"completedAt\", \"createdAt\", \"updatedAt\" FROM \"agent_items\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"type\" = 'task_graph'",
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(graphAfterResume.rows).toHaveLength(1)
      expect(graphAfterResume.rows[0]?.id).toBe(graphBefore.rows[0]?.id)
      const graphAfterSnapshot = record(graphAfterResume.rows[0]?.content)
      const graphAfterNodes = Array.isArray(graphAfterSnapshot?.nodes) ? graphAfterSnapshot.nodes.map(record) : []
      expect(graphAfterSnapshot?.schemaVersion).toBe("agent-harness.v2.task-graph")
      expect(graphAfterNodes.map(node => node?.key)).toEqual(["source", "summary", RESTART_FOLLOW_UP_KEY])
      expect(graphAfterNodes.slice(0, 2)).toEqual(graphNodes)
      expect(graphAfterNodes[2]).toMatchObject({
        key: RESTART_FOLLOW_UP_KEY,
        templateId: "analyst",
        goal: RESTART_FOLLOW_UP_GOAL,
        successCriteria: ["Verify the restored summary evidence"],
        dependsOn: ["summary"],
        depth: 3,
      })
      expect(graphAfterResume.rows[0]?.revision).toBeGreaterThan(graphBefore.rows[0]!.revision)
      const resumedWaits = await pool!.query<{ id: string; status: string; consumedAt: Date | null; result: unknown; targetTaskIds: unknown }>(
        "SELECT \"id\", \"status\", \"consumedAt\", \"result\", \"targetTaskIds\" FROM \"agent_wait_conditions\" WHERE \"turnId\" = $1 ORDER BY \"createdAt\" ASC",
        [restartOwner.turnId],
      )
      expect(resumedWaits.rows).toHaveLength(2)
      const originalWaitAfterResume = resumedWaits.rows.find(row => row.id === waitsBefore.rows[0]?.id)
      expect(originalWaitAfterResume).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      const originalSourceTaskId = graphAfterNodes.find(node => node?.key === "source")?.taskId
      const originalSummaryTaskId = graphAfterNodes.find(node => node?.key === "summary")?.taskId
      if (typeof originalSourceTaskId !== "string" || typeof originalSummaryTaskId !== "string") {
        throw new Error("Restarted original wait lost its source or summary task identity")
      }
      assertTypedWaitTaskProjection(originalWaitAfterResume?.result, originalSourceTaskId, "candidate-count")
      assertTypedWaitTaskProjection(originalWaitAfterResume?.result, originalSummaryTaskId, "finding-count")
      const originalWaitOutcome = record(record(originalWaitAfterResume?.result)?.outcome)
      expect(JSON.stringify(originalWaitOutcome)).not.toContain("p3-process-restart-source-result")
      const followUpTaskId = graphAfterNodes[2]?.taskId
      expect(typeof followUpTaskId).toBe("string")
      const targetIds = (value: unknown): string[] => {
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string")
        try {
          const parsed = JSON.parse(String(value)) as unknown
          return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
        } catch { return [] }
      }
      const followUpWait = resumedWaits.rows.find(row => targetIds(row.targetTaskIds).includes(String(followUpTaskId)))
      expect(followUpWait).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
      expect(followUpWait?.id).not.toBe(originalWaitAfterResume?.id)
      assertFollowUpWaitProjection(followUpWait?.result, String(followUpTaskId))
      const childrenAfterResume = await pool!.query<{ id: string; goal: string; status: string; result: RecordValue | null; context: RecordValue | null; role: string }>(
        "SELECT \"id\", \"goal\", \"status\", \"result\", \"context\", \"role\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"parentTaskId\" = $2 ORDER BY \"goal\"",
        [restartOwner.turnId, rootTaskId],
      )
      expect(childrenAfterResume.rows.map(row => [row.goal, row.status])).toEqual([
        ["Read the durable TaskGraph source", "completed"],
        ["Summarize the restored TaskGraph source", "completed"],
        [RESTART_FOLLOW_UP_GOAL, "completed"],
      ])
      expectPassedVerificationReport(record(childrenAfterResume.rows.find(row => row.goal === "Read the durable TaskGraph source")?.result)?.taskGraphVerificationReport, "candidate-count")
      expectPassedVerificationReport(record(childrenAfterResume.rows.find(row => row.goal === "Summarize the restored TaskGraph source")?.result)?.taskGraphVerificationReport, "finding-count")
      // Match Worker 2's projection query, including its root row and public goal.
      const persistedPlanLedgerTasks = await pool!.query<{
        id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
        path: string; role: string; taskType: string; status: string; goal: string; confidence: number | null
        failureReason: string | null; result: RecordValue | null; createdAt: Date; updatedAt: Date
      }>(
        `SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "role", "taskType", "status", "goal", "confidence", "failureReason", "result", "createdAt", "updatedAt" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)
         ORDER BY "createdAt" ASC, "id" ASC`,
        [restartOwner.sessionId, restartOwner.turnId, rootTaskId],
      )
      expect(persistedPlanLedgerTasks.rows.map(row => row.id)).toContain(rootTaskId)
      const fixtureLedgerLine = await waitForProcessLine(workerTwo, "P3_PLAN_LEDGER_PROJECTION ")
      const fixtureLedger = parsePlanLedger(fixtureLedgerLine.slice("P3_PLAN_LEDGER_PROJECTION ".length))
      const persistedLedger = projectPlanLedger({
        sessionId: restartOwner.sessionId,
        revision: graphAfterResume.rows[0]!.revision,
        rootTaskId,
        graph: graphAfterResume.rows[0]!.content,
        tasks: persistedPlanLedgerTasks.rows,
      })
      expect(fixtureLedger).not.toBeNull()
      expect(persistedLedger).toEqual(fixtureLedger)
      expect(persistedLedger).toMatchObject({
        schemaVersion: PLAN_LEDGER_SCHEMA_VERSION,
        sessionId: restartOwner.sessionId,
        revision: graphAfterResume.rows[0]!.revision,
        nodes: [
          { key: "source", status: "completed", readiness: "terminal", evidencePreview: { role: "scout", itemCount: 1 } },
          { key: "summary", status: "completed", readiness: "terminal", evidencePreview: { role: "analyst", itemCount: 1 } },
          { key: RESTART_FOLLOW_UP_KEY, status: "completed", readiness: "terminal", evidencePreview: { role: "analyst", itemCount: 1 } },
        ],
      })
      const publicLedgerJson = JSON.stringify(persistedLedger)
      for (const secret of [restartJobId, "p3-process-restart-source-result", "p3-process-restart-final", "jobId", "score", "url", "task-graph.result-projection"]) {
        expect(publicLedgerJson).not.toContain(secret)
      }
      expect(parsePlanLedger(publicLedgerJson)).toEqual(persistedLedger)
      const followUpChild = childrenAfterResume.rows.find(row => row.id === followUpTaskId)
      expect(followUpChild).toMatchObject({ goal: RESTART_FOLLOW_UP_GOAL, status: "completed", role: "analyst" })
      const followUpDependency = record(record(followUpChild?.context)?.taskGraphDependencyResults)
      const followUpDependencyItems = Array.isArray(followUpDependency?.items) ? followUpDependency.items.map(record) : []
      expect(followUpDependencyItems[0]).toMatchObject({
        dependencyKey: "summary",
        role: "analyst",
        taskStatus: "completed",
        result: {
          schemaVersion: "agent-harness.v2.task-graph.result-projection",
          trust: "untrusted",
          availability: "available",
          role: "analyst",
          findings: [{ jobId: restartJobId, score: 8, evidenceKinds: ["job"] }],
        },
      })
      const graphEvents = await pool!.query<{
        id: string; sessionId: string; turnId: string; itemId: string | null; taskId: string | null
        sequence: string | bigint; type: string; actor: string; correlationId: string
        causationId: string | null; idempotencyKey: string | null; payload: RecordValue
      }>(
        "SELECT \"id\", \"sessionId\", \"turnId\", \"itemId\", \"taskId\", \"sequence\", \"type\", \"actor\", \"correlationId\", \"causationId\", \"idempotencyKey\", \"payload\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"itemId\" = $3 ORDER BY \"sequence\"",
        [restartOwner.sessionId, restartOwner.turnId, graphAfterResume.rows[0]!.id],
      )
      const proposalEvents = graphEvents.rows.filter(event => record(event.payload)?.kind === "proposal")
      expect(proposalEvents).toHaveLength(2)
      const followUpReceiptEvent = proposalEvents[1]!
      const followUpReceiptPayload = record(followUpReceiptEvent.payload)
      const followUpReceipt = record(followUpReceiptPayload?.receipt)
      expect(followUpReceipt).toMatchObject({
        status: "accepted",
        nodes: [{ key: RESTART_FOLLOW_UP_KEY, taskId: followUpTaskId, status: "queued" }],
        readyTaskIds: [followUpTaskId],
      })
      const proposalKeyPrefix = graphAfterResume.rows[0]!.id + ":proposal:"
      const followUpIdempotencyKey = followUpReceiptEvent.idempotencyKey
      if (!followUpIdempotencyKey) throw new Error("Persisted follow-up proposal event has no idempotency key.")
      expect(followUpIdempotencyKey.startsWith(proposalKeyPrefix)).toBe(true)
      const expectedRevision = Number(followUpIdempotencyKey.slice(proposalKeyPrefix.length))
      expect(Number.isSafeInteger(expectedRevision)).toBe(true)
      expect(followUpReceiptPayload?.revision).toBe(expectedRevision + 1)
      expect(expectedRevision).toBeGreaterThan(graphBefore.rows[0]!.revision)
      const followUpLifecycle = graphEvents.rows.flatMap(event => {
        if (event.taskId !== followUpTaskId) return []
        const payload = record(event.payload)
        const lifecycle = record(payload?.event)
        return payload?.kind === "lifecycle" && lifecycle?.nodeKey === RESTART_FOLLOW_UP_KEY
          && typeof lifecycle.type === "string" ? [lifecycle.type] : []
      })
      expect(followUpLifecycle).toEqual(expect.arrayContaining(["task.started", "task.completed"]))
      const initialGraphRevision = graphBefore.rows[0]!.revision
      const persistedGraphDeltas = graphEvents.rows.filter(event => {
        const payload = record(event.payload)
        const item = record(payload?.item)
        return event.type === "item.delta"
          && typeof item?.revision === "number" && Number.isSafeInteger(item.revision)
          && item.revision > initialGraphRevision
      })
      const persistedGraphRevisions = persistedGraphDeltas.map(event => Number(record(record(event.payload)?.item)?.revision))
      expect(persistedGraphRevisions).toEqual(Array.from(
        { length: graphAfterResume.rows[0]!.revision - initialGraphRevision },
        (_, index) => initialGraphRevision + index + 1,
      ))
      expect(persistedGraphDeltas.every(event => {
        const payload = record(event.payload)
        return payload !== null && payload.revision === record(payload.item)?.revision
      })).toBe(true)
      expect(persistedGraphDeltas.length).toBeGreaterThan(0)
      const finalGraphDelta = persistedGraphDeltas[persistedGraphDeltas.length - 1]!
      const finalGraphDeltaPayload = record(finalGraphDelta.payload)
      const finalGraphDeltaItem = record(finalGraphDeltaPayload?.item)
      if (typeof rootTaskId !== "string") throw new Error("Restarted TaskGraph has no root task ID.")
      let expectedFinalGraphEventTaskId: string
      if (finalGraphDeltaPayload?.kind === "proposal") {
        expectedFinalGraphEventTaskId = rootTaskId
      } else if (finalGraphDeltaPayload?.kind === "lifecycle") {
        const lifecycle = record(finalGraphDeltaPayload.event)
        const lifecycleNode = graphAfterNodes.find(node => node?.key === lifecycle?.nodeKey)
        if (typeof lifecycleNode?.taskId !== "string") throw new Error("Final TaskGraph lifecycle event has no matching node task.")
        expectedFinalGraphEventTaskId = lifecycleNode.taskId
      } else {
        throw new Error("Final TaskGraph delta has an unknown event kind.")
      }
      expect(finalGraphDelta).toMatchObject({
        type: "item.delta",
        sessionId: restartOwner.sessionId,
        turnId: restartOwner.turnId,
        itemId: graphAfterResume.rows[0]!.id,
        taskId: expectedFinalGraphEventTaskId,
      })
      expect(finalGraphDeltaPayload?.revision).toBe(graphAfterResume.rows[0]!.revision)
      expect(finalGraphDeltaItem).toMatchObject({
        id: graphAfterResume.rows[0]!.id,
        sessionId: restartOwner.sessionId,
        turnId: restartOwner.turnId,
        taskId: rootTaskId,
        revision: graphAfterResume.rows[0]!.revision,
        content: graphAfterResume.rows[0]!.content,
      })
      const graphDeltaSequences = persistedGraphDeltas.map(event => event.sequence.toString())
      expect(graphDeltaSequences.every(sequence => /^(0|[1-9]\d*)$/.test(sequence))).toBe(true)
      for (let index = 1; index < graphDeltaSequences.length; index += 1) {
        expect(BigInt(graphDeltaSequences[index]!)).toBeGreaterThan(BigInt(graphDeltaSequences[index - 1]!))
      }
      const resumedEvents = await pool!.query<{ count: string }>(
        "SELECT COUNT(*)::text AS \"count\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"idempotencyKey\" = $2",
        [restartOwner.sessionId, "agent-wait:" + waitsBefore.rows[0]!.id + ":resumed"],
      )
      expect(resumedEvents.rows[0]?.count).toBe("1")
      const followUpResumedEvents = await pool!.query<{ count: string }>(
        "SELECT COUNT(*)::text AS \"count\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"idempotencyKey\" = $2",
        [restartOwner.sessionId, "agent-wait:" + followUpWait?.id + ":resumed"],
      )
      expect(followUpResumedEvents.rows[0]?.count).toBe("1")
      if (planLedgerTraceArtifactPath) {
        if (!persistedLedger) throw new Error("Cannot export a missing persisted PlanLedger.")
        expect(Buffer.byteLength(publicLedgerJson, "utf8")).toBeLessThanOrEqual(16_000)
        const graphItem = graphAfterResume.rows[0]!
        const graphSnapshot = record(graphItem.content)
        const graphNodes = Array.isArray(graphSnapshot?.nodes) ? graphSnapshot.nodes.map(record) : []
        const taskRouteRows = persistedPlanLedgerTasks.rows.map(row => {
          const evidencePreview = projectTaskEvidencePreview(row)
          return {
            schemaVersion,
            id: row.id,
            sessionId: row.sessionId,
            turnId: row.turnId,
            rootTaskId: row.rootTaskId,
            parentTaskId: row.parentTaskId,
            path: row.path,
            role: row.role,
            taskType: row.taskType,
            status: row.status === "completed" ? "passed" : row.status,
            goal: row.goal,
            confidence: row.confidence,
            failureReason: row.failureReason,
            hasResult: row.result !== null,
            ...(evidencePreview ? { structuredEvidencePreview: evidencePreview } : {}),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
          }
        })
        expect(graphItem.sessionId).toBe(restartOwner.sessionId)
        expect(graphItem.turnId).toBe(restartOwner.turnId)
        expect(graphItem.taskId).toBe(rootTaskId)
        expect(graphItem.revision).toBe(persistedLedger.revision)
        expect(taskRouteRows.map(row => row.id).sort()).toEqual([
          rootTaskId,
          ...graphNodes.map(node => String(node?.taskId)),
        ].sort())
        expect(taskRouteRows.every(row => row.sessionId === restartOwner.sessionId
          && row.turnId === restartOwner.turnId && row.rootTaskId === rootTaskId)).toBe(true)
        expect(taskRouteRows.find(row => row.id === rootTaskId)?.parentTaskId).toBeNull()
        expect(taskRouteRows.every(row => !("result" in row))).toBe(true)
        const toGraphItemDto = (row: TaskGraphItemRow) => ({
          schemaVersion,
          id: row.id,
          sessionId: row.sessionId,
          turnId: row.turnId,
          stepId: row.stepId,
          taskId: row.taskId,
          type: row.type,
          status: row.status,
          phase: row.phase,
          revision: row.revision,
          content: row.content,
          startedAt: row.startedAt?.toISOString() ?? null,
          completedAt: row.completedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })
        const traceEnvelope = {
          schemaVersion: "agent-harness.v2.plan-ledger-trace",
          planLedger: persistedLedger,
          rootTaskId,
          graphItem: toGraphItemDto(graphItem),
          initialGraphItem: toGraphItemDto(graphBefore.rows[0]!),
          graphEvents: persistedGraphDeltas.map(durableGraphEvent => ({
            schemaVersion,
            id: durableGraphEvent.id,
            sessionId: durableGraphEvent.sessionId,
            turnId: durableGraphEvent.turnId,
            itemId: durableGraphEvent.itemId,
            taskId: durableGraphEvent.taskId,
            type: durableGraphEvent.type,
            actor: durableGraphEvent.actor,
            correlationId: durableGraphEvent.correlationId,
            causationId: durableGraphEvent.causationId,
            idempotencyKey: durableGraphEvent.idempotencyKey,
            sequence: durableGraphEvent.sequence.toString(),
            payload: durableGraphEvent.payload,
          })),
          tasks: taskRouteRows,
        }
        const traceEnvelopeJson = JSON.stringify(traceEnvelope)
        expect(Buffer.byteLength(traceEnvelopeJson, "utf8")).toBeLessThanOrEqual(64_000)
        await writeFile(planLedgerTraceArtifactPath, traceEnvelopeJson, "utf8")
      }
    } catch (error: unknown) {
      primaryBodyFailure = error instanceof Error
        ? error
        : new Error("TaskGraph restart fixture threw a non-Error value")
      throw primaryBodyFailure
    } finally {
      const teardownFailureCategories: string[] = []
      if (workerOne && !processFixtureExited(workerOne)) {
        try { await killProcessFixture(workerOne) } catch (error) {
          teardownFailureCategories.push("worker1_" + processCleanupFailureCategory(error))
        }
      }
      if (workerTwo) {
        try { await stopProcessFixture(workerTwo) } catch (error) {
          teardownFailureCategories.push("worker2_" + processCleanupFailureCategory(error))
        }
      }
      // artifactOwner is suite-scoped; retire its task rows and unlinked outbox before the next fixture runs.
      try {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [artifactOwner.sessionId])
      } catch (error: unknown) {
        teardownFailureCategories.push("selected_job_outbox_" + processCleanupFailureCategory(error))
      }
      try {
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [artifactOwner.userId])
      } catch (error: unknown) {
        teardownFailureCategories.push("selected_job_user_" + processCleanupFailureCategory(error))
      }
      if (teardownFailureCategories.length > 0) {
        const visibleCleanupCategories = teardownFailureCategories.slice(0, 4).join(",")
        const omittedCleanupCategoryCount = teardownFailureCategories.length - 4
        const cleanupCategorySuffix = "cleanupFailureCategories=" + visibleCleanupCategories
          + (omittedCleanupCategoryCount > 0 ? ",omitted_" + omittedCleanupCategoryCount : "")
        if (primaryBodyFailure) {
          primaryBodyFailure.message = boundedDiagnostic(
            primaryBodyFailure.message + "; " + cleanupCategorySuffix, 3_900,
          )
        } else {
          throw new Error("P3 Worker process teardown failed; " + cleanupCategorySuffix)
        }
      }
    }
  }, 240_000)

  it("rejects a claimed foreign runnable lease before recording its goal", async () => {
    const foreignOwner = fixture()
    const expectedOwner = fixture()
    const foreignGoal = `AC4_FOREIGN_RUNNABLE_${foreignOwner.suffix}`
    const dispatchedGoals: string[] = []
    let cleanupFixture = false
    try {
      cleanupFixture = true
      await seed(pool!, foreignOwner, "waiting_for_user")
      const store = new PgSubagentTaskStore(pool!, 300_000)
      const policy = { ...defaultSubagentPolicy(), maxAttempts: 1 }
      const task = await store.create({
        userId: foreignOwner.userId,
        sessionId: foreignOwner.sessionId,
        turnId: foreignOwner.turnId,
        role: "supervisor",
        taskType: "task_graph",
        goal: foreignGoal,
        allowedActions: [],
        expectedOutputSchema: {},
        toolPolicySnapshot: {},
        budgetSnapshot: { limits: { maxSteps: 1, maxToolCalls: 1 } },
        policy,
      })
      // This creates a real PostgreSQL lease without claiming that a Worker dispatched it.
      const lease = await store.claim({
        taskId: task.id,
        sessionId: task.sessionId,
        ownerId: foreignOwner.ownerId,
        policy,
        now: new Date(),
      })
      if (!lease) throw new Error("Foreign runnable task did not acquire a disposable lease")
      expect(lease).toMatchObject({
        sessionId: foreignOwner.sessionId,
        turnId: foreignOwner.turnId,
        goal: foreignGoal,
        status: "running",
        leaseOwner: foreignOwner.ownerId,
      })

      expect(() => recordTaskGraphFixtureLease(lease, expectedOwner, dispatchedGoals))
        .toThrow("Foreign subagent lease rejected by TaskGraph fixture")
      expect(dispatchedGoals).toEqual([])

      const unguardedGoals: string[] = []
      unguardedGoals.push(lease.goal)
      expect(unguardedGoals).toEqual([foreignGoal])
    } finally {
      if (cleanupFixture) {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [foreignOwner.sessionId])
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [foreignOwner.userId])
      }
    }
  })

  it("holds the dependent through a live hard failure and cancels it on canonical root failure", async () => {
    const [
      { createProductionWorkerBootstrap },
      { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { taskGraphItemId },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./task-graph-snapshot.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    let rootRuntimeExecutions = 0
    let descendantExecuted = false
    let resumedAfterFailure = false
    let failedResumeRootStage: "not_started" | "initial_plan" | "initial_wait" | "resumed_root" | "graph_status" | "hydrated_wait" | "resumed" = "not_started"
    let failedResumeGraphStatusReached = false
    let failedResumeGraphStatuses: Array<{ key: "prerequisite" | "dependent"; status: string }> = []
    let failedResumeWaitStatus: string | null = null
    let failedResumeWaitTaskCount: number | null = null
    const failedResumeDiagnostic = () => JSON.stringify({
      rootStage: failedResumeRootStage,
      graphStatusReached: failedResumeGraphStatusReached,
      graphStatuses: failedResumeGraphStatuses,
      hydratedWaitStatus: failedResumeWaitStatus,
      hydratedWaitTaskCount: failedResumeWaitTaskCount,
    })
    let failurePreflightStage: FailurePreflightStage = "not_started"
    let failurePreflightErrorClass: FailurePreflightErrorClass = "none"
    let failurePlanReceiptFailureDiagnostics: string | null = null
    let failurePreflightEvidenceDiagnostics: string | null = null
    let failurePreflightRootTaskLookupCompleted = false
    let failurePreflightRootTaskId: string | null = null
    let failurePreflightTargetIds: string[] = []
    const failurePreflightTargetObservations: FailurePreflightTargetObservation[] = [null, null]
    let failureWaitHandoffFailure: string | null = null
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: failureOwner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        analyst: { role: "analyst", taskType: "research", allowedActions: ["jobs.search"] },
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-failure-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 1 && modelRounds === 1) {
              failedResumeRootStage = "initial_plan"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield {
                type: "tool_call_completed", callId: FAILURE_PLAN_CALL_ID, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "prerequisite", templateId: "analyst", goal: FAILURE_GOAL, successCriteria: ["Record a terminal failure"], dependsOn: [], verification: ANALYST_VERIFICATION },
                    { key: "dependent", templateId: "analyst", goal: BLOCKED_GOAL, successCriteria: ["Do not execute after source failure"], dependsOn: ["prerequisite"], verification: ANALYST_VERIFICATION },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              failedResumeRootStage = "initial_wait"
              try {
                failurePreflightStage = "plan_receipt"
                failurePreflightErrorClass = "none"
                const receiptTaskIds = planTaskIds(request, FAILURE_PLAN_CALL_ID)
                failurePreflightTargetIds = receiptTaskIds
                failurePreflightStage = "root_task_lookup"
                const fixtureTurn = await pool!.query<{ rootTaskId: string | null }>(
                  `SELECT "rootTaskId" FROM "agent_turns"
                   WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                  [failureOwner.turnId, failureOwner.sessionId, failureOwner.userId],
                )
                const fixtureRootTaskId = fixtureTurn.rows[0]?.rootTaskId
                failurePreflightRootTaskLookupCompleted = true
                failurePreflightRootTaskId = fixtureRootTaskId ?? null
                if (!fixtureRootTaskId) {
                  throw new Error("Failed-prerequisite fixture assertion: current root task is missing from agent_turns")
                }
                const coordinationStore = new PgCoordinationStore(pool!)
                for (const [index, taskId] of receiptTaskIds.entries()) {
                  failurePreflightStage = index === 0 ? "first_target_lookup" : "second_target_lookup"
                  const target = await coordinationStore.getTask({
                    userId: failureOwner.userId, sessionId: failureOwner.sessionId, taskId,
                  })
                  if (!target) {
                    failurePreflightTargetObservations[index] = {
                      found: false,
                      scope: await missingTaskScopeFailureDiagnostics(pool!, taskId, {
                        sessionId: failureOwner.sessionId, userId: failureOwner.userId,
                        turnId: failureOwner.turnId, rootTaskId: fixtureRootTaskId,
                      }),
                    }
                    throw new Error("Failed-prerequisite fixture assertion: plan receipt target is missing from PgCoordinationStore.getTask")
                  }
                  failurePreflightTargetObservations[index] = {
                    found: true,
                    taskId: target.id,
                    turnId: target.turnId,
                    rootTaskId: target.rootTaskId,
                    parentTaskId: target.parentTaskId,
                  }
                  failurePreflightStage = index === 0 ? "first_target_lineage" : "second_target_lineage"
                  const targetLineage = failurePreflightEvidenceProjection({
                    rootTaskLookupCompleted: failurePreflightRootTaskLookupCompleted,
                    rootTaskId: failurePreflightRootTaskId,
                    expectedTurnId: failureOwner.turnId,
                    expectedTaskIds: failurePreflightTargetIds,
                    targets: failurePreflightTargetObservations,
                  }).targets as Array<RecordValue>
                  const observedLineage = targetLineage[index]
                  expect({
                    targetMatchesReceipt: observedLineage?.targetMatchesReceipt,
                    turnMatches: observedLineage?.turnMatches,
                    rootMatches: observedLineage?.rootMatches,
                    parentMatches: observedLineage?.parentMatches,
                  }, "Failed-prerequisite fixture assertion: target lineage does not match expected scope").toEqual({
                    targetMatchesReceipt: true, turnMatches: true, rootMatches: true, parentMatches: true,
                  })
                }
                failurePreflightStage = "wait_tool_availability"
                expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
                failurePreflightStage = "preflight_passed"
              } catch (error: unknown) {
                failurePreflightErrorClass = safeFailurePreflightErrorClass(error)
                failurePreflightEvidenceDiagnostics = boundedDiagnostic(JSON.stringify(failurePreflightEvidenceProjection({
                  rootTaskLookupCompleted: failurePreflightRootTaskLookupCompleted,
                  rootTaskId: failurePreflightRootTaskId,
                  expectedTurnId: failureOwner.turnId,
                  expectedTaskIds: failurePreflightTargetIds,
                  targets: failurePreflightTargetObservations,
                })), 1_200)
                failurePlanReceiptFailureDiagnostics = await collectPlanReceiptFailureDiagnostics(
                  pool!, failureOwner.turnId, request, FAILURE_PLAN_CALL_ID, currentGraphFromRequest(request),
                )
                throw error
              }
              yield {
                type: "tool_call_completed", callId: FAILURE_WAIT_CALL_ID, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-failure-wait:${failureOwner.turnId}`,
                  taskIds: [planTaskIds(request, FAILURE_PLAN_CALL_ID, 2)[0]!], mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && modelRounds === 1) {
              failedResumeRootStage = "resumed_root"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              failedResumeGraphStatusReached = graph?.kind === "task_graph_current" && nodes.length > 0
              failedResumeGraphStatuses = nodes.flatMap(node => {
                const key = node?.key
                const status = diagnosticEnum(node?.status, TASK_DIAGNOSTIC_STATUSES)
                return (key === "prerequisite" || key === "dependent") && status ? [{ key, status }] : []
              })
              failedResumeRootStage = "graph_status"
              expect(nodes.map(node => [node?.key, node?.status]), failedResumeDiagnostic()).toEqual([
                ["prerequisite", "failed"], ["dependent", "waiting"],
              ])
              const outcome = waitOutcomeFromRequest(request, 1)
              failedResumeRootStage = "hydrated_wait"
              failedResumeWaitStatus = diagnosticEnum(outcome.status, WAIT_DIAGNOSTIC_STATUSES)
              failedResumeWaitTaskCount = diagnosticBoundedCount(outcome.tasks.length)
              expect(outcome.status, failedResumeDiagnostic()).toBe("ready")
              expect(outcome.tasks.map(task => record(task)?.status), failedResumeDiagnostic()).toEqual(["failed"])
              const waitedPrerequisite = outcome.tasks.map(record).find(task => task?.role === "analyst")
              expect(waitedPrerequisite?.status).toBe("failed")
              expectUnverifiedVerificationReport(waitedPrerequisite?.verificationReport, "finding-count")
              const livePrerequisite = await pool!.query<{ status: string; failureReason: string | null; result: unknown }>(
                "SELECT \"status\", \"failureReason\", \"result\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3 AND \"rootTaskId\" = $4 AND \"parentTaskId\" = $4",
                [failurePreflightTargetIds[0], failureOwner.sessionId, failureOwner.turnId, failurePreflightRootTaskId],
              )
              expect(livePrerequisite.rows[0]).toMatchObject({ status: "failed", failureReason: "task_graph_verification_unverified" })
              expectUnverifiedVerificationReport(record(livePrerequisite.rows[0]?.result)?.taskGraphVerificationReport, "finding-count")
              const liveDependent = await pool!.query<{ id: string; status: string; turnStatus: string }>(
                "SELECT task.\"id\", task.\"status\", turn.\"status\" AS \"turnStatus\" FROM \"sub_agent_tasks\" AS task JOIN \"agent_turns\" AS turn ON turn.\"id\" = task.\"turnId\" AND turn.\"sessionId\" = task.\"sessionId\" WHERE task.\"sessionId\" = $1 AND task.\"turnId\" = $2 AND task.\"rootTaskId\" = $3 AND task.\"parentTaskId\" = $3 AND task.\"goal\" = $4",
                [failureOwner.sessionId, failureOwner.turnId, failurePreflightRootTaskId, BLOCKED_GOAL],
              )
              expect(liveDependent.rows).toHaveLength(1)
              expect(liveDependent.rows[0]).toMatchObject({
                id: failurePreflightTargetIds[1], status: "waiting", turnStatus: "in_progress",
              })
              const prematureDispatch = await pool!.query(
                "SELECT \"id\" FROM \"agent_outbox\" WHERE \"aggregateId\" = $1 AND \"topic\" = $2 AND \"idempotencyKey\" = $3",
                [failureOwner.sessionId, "agent.subagent.dispatch", "subagent-dispatch:" + liveDependent.rows[0]!.id],
              )
              expect(prematureDispatch.rowCount).toBe(0)
              const prematureCancellation = await pool!.query(
                "SELECT \"id\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"payload\"->>'kind' = $4 AND \"payload\"->'event'->>'type' = $5",
                [failureOwner.sessionId, failureOwner.turnId, liveDependent.rows[0]!.id, "lifecycle", "task.cancelled"],
              )
              expect(prematureCancellation.rowCount).toBe(0)
              resumedAfterFailure = true
              failedResumeRootStage = "resumed"
              yield { type: "text_delta", text: FAILURE_FINAL_MARKER }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error("Unexpected model execution or round in the failed-prerequisite fixture")
          },
        }
        return { adapter: model, registry: {} as never, candidates: [] }
      },
    })
    await activateFixtureTurn(pool!, failureOwner)
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: failureOwner.ownerId,
      turnQueueFactory: withWaitHandoffDiagnostics(pool!, createTurnQueue, diagnostic => {
        failureWaitHandoffFailure = diagnostic
      }),
      // The resume intent is durably queued by the wait resolver and delivered
      // by turn recovery; poll promptly so this acceptance does not outwait it.
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-failure-wait-resolver-${failureOwner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          await waitForSuspendedParent(pool!, failureOwner.turnId)
          if (lease.goal === FAILURE_GOAL) {
            return { status: "failed", failureReason: "Fixture prerequisite failed permanently.", retryDisposition: "terminal" }
          }
          if (lease.goal === BLOCKED_GOAL) descendantExecuted = true
          return { status: "completed", result: { proof: `unexpected execution: ${lease.goal}` } }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: failureOwner.turnId, sessionId: failureOwner.sessionId, ownerId: failureOwner.ownerId,
    })
    try {
      await waitForTurnStatus(pool!, failureOwner.turnId, "failed", 50_000, FAILURE_WAIT_CALL_ID)
    } catch (error: unknown) {
      const progress = await turnProgressDiagnostics(pool!, failureOwner.turnId, FAILURE_WAIT_CALL_ID)
      const failureReceiptDiagnostic: FailureDiagnosticField[] = failurePlanReceiptFailureDiagnostics
        ? [{ label: "failurePlanReceiptEvidence", value: "captured", safeValue: failurePlanReceiptFailureDiagnostics }]
        : []
      const failurePreflightEvidence: FailureDiagnosticField[] = failurePreflightEvidenceDiagnostics
        ? [{ label: "failurePreflightEvidence", value: "captured", safeValue: failurePreflightEvidenceDiagnostics }]
        : []
      const waitHandoffFailureState = JSON.stringify(waitHandoffFailureProjection(failureWaitHandoffFailure))
      throw new Error(combineFailureDiagnostics([
        { label: "failedPrerequisiteResume", value: failedResumeDiagnostic(), safeValue: failedResumeDiagnostic() },
        { label: "failedPrerequisitePreflight", value: failurePreflightErrorClass === "none" ? "" : "captured" },
        { label: "failurePreflightStage", value: failurePreflightStage, safeValue: failurePreflightStage },
        { label: "failurePreflightErrorClass", value: failurePreflightErrorClass, safeValue: failurePreflightErrorClass },
        ...failurePreflightEvidence,
        ...failureReceiptDiagnostic,
        { label: "waitHandoffFailure", value: failureWaitHandoffFailure ?? "<not captured>" },
        { label: "waitHandoffState", value: waitHandoffFailureState, safeValue: waitHandoffFailureState },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress))
    }

    const turn = await pool!.query<{ status: string; rootTaskId: string; finalResponse: string | null }>(
      `SELECT "status", "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [failureOwner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    expect(rootRuntimeExecutions).toBe(2)
    expect(resumedAfterFailure, failedResumeDiagnostic()).toBe(true)
    expect(descendantExecuted).toBe(false)
    expect(turn.rows[0]?.status).toBe("failed")
    expect(turn.rows[0]?.finalResponse ?? "").not.toContain(FAILURE_FINAL_MARKER)
    const finalRejection = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'final.rejected'
       AND "payload"->>'blocker' = 'task_graph_verification_unverified' ORDER BY "sequence" DESC LIMIT 1`,
      [failureOwner.turnId, failureOwner.sessionId],
    )
    expect(record(finalRejection.rows[0]?.payload)).toMatchObject({ blocker: "task_graph_verification_unverified" })

    const children = await pool!.query<{ id: string; goal: string; status: string }>(
      `SELECT "id", "goal", "status" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "id"`,
      [failureOwner.sessionId, failureOwner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(2)
    const prerequisite = children.rows.find(child => child.goal === FAILURE_GOAL)
    const dependent = children.rows.find(child => child.goal === BLOCKED_GOAL)
    expect(prerequisite?.status).toBe("failed")
    expect(dependent?.status).toBe("cancelled")
    expect(dependent?.id).toBe(failurePreflightTargetIds[1])

    const graphItemId = taskGraphItemId(rootTaskId!)
    const cancellationEvidence = await pool!.query<{ itemId: string; taskId: string; payload: RecordValue }>(
      `SELECT "itemId", "taskId", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "taskId" = $4`,
      [failureOwner.sessionId, failureOwner.turnId, graphItemId, dependent?.id],
    )
    expect(cancellationEvidence.rows).toHaveLength(1)
    expect(cancellationEvidence.rows[0]).toMatchObject({
      itemId: graphItemId,
      taskId: dependent?.id,
      payload: { kind: "lifecycle", event: { type: "task.cancelled", nodeKey: "dependent" } },
    })
    const descendantDispatch = await pool!.query(
      `SELECT 1 FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
       AND "idempotencyKey" = $2`,
      [failureOwner.sessionId, `subagent-dispatch:${dependent?.id}`],
    )
    expect(descendantDispatch.rowCount).toBe(0)
  }, 90_000)

  it("replans an operational Scout failure after its all-target Root wait consumes the automatic descendant cancellation", async () => {
    const [{ createProductionWorkerBootstrap }, { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue, { createCanonicalTurnRuntime }, { createPgTaskGraphCommandPort }] = await Promise.all([
      import("../../queue/production-bootstrap.js"), import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"), import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
    ])
    const value = operationalFailureOwner
    const sourceGoal = `Recover Scout after its persisted execution state is unavailable ${value.suffix}`
    const dependentGoal = `Keep the Analyst behind the failed Scout ${value.suffix}`
    const replacementScoutGoal = `Read the source again with a fresh Scout ${value.suffix}`
    const replacementAnalystGoal = `Analyze the fresh Scout result ${value.suffix}`
    const planCallId = `p3-operational-failure-plan:${value.turnId}`
    const initialWaitCallId = `p3-operational-failure-wait:${value.turnId}`
    const inlineWaitCallId = `p3-operational-failure-inline-ready-wait:${value.turnId}`
    const replacementPlanCallId = `p3-operational-failure-replan:${value.turnId}`
    const replacementWaitCallId = `p3-operational-failure-replacement-wait:${value.turnId}`
    const initialWaitKey = `p3-operational-failure-wait:${value.turnId}`
    const inlineWaitKey = `p3-operational-failure-inline-ready-wait:${value.turnId}`
    const replacementWaitKey = `p3-operational-failure-replacement-wait:${value.turnId}`
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    let rootExecutions = 0
    let rootTaskId = ""
    let originalOperationalFailureResult: unknown
    let originalFailureEnvelopeObserved = false
    let initialTaskIds: string[] = []
    let replacementTaskIds: string[] = []
    let consumedFailureWaitObserved = false
    let inlineFailureWaitObserved = false
    let consumedFailureWaitSnapshot: string | null = null
    let replacementPlanAccepted = false
    let replacementPlanResultDiagnostic = "not_observed"
    let replacementPlanCommandDiagnostic = "not_called"
    let canonicalExecutionDiagnostic = "not_observed"
    let finalGraphVerified = false
    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    const commandPort = createPgTaskGraphCommandPort(pool!)
    const appendWithReconciliation = commandPort.appendAndScheduleWithReconciliation
    if (typeof appendWithReconciliation !== "function") throw new Error("Operational failure fixture requires reconciliation planning")
    const safeLabel = (value: unknown): string => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unknown"
    const safeOperationalStackSites = (stack: unknown): string => {
      if (typeof stack !== "string") return "none"
      const allowed = new Set([
        "canonical-turn-runtime.ts",
        "canonical-turn-runtime-turn-setup.ts",
        "canonical-turn-scheduled-pipeline.ts",
        "scheduled-pipeline-candidate-store.ts",
        "task-graph-pg-state.ts",
        "turn-engine.ts",
        "turn-engine-store.ts",
        "turn-queue.ts",
        "task-graph-pg-operational-failure-replacement.ts",
        "task-graph-pg-operational-failure-evidence.ts",
        "task-graph-pg-operational-failure-cancellations.ts",
        "task-graph-pg-operational-failure-root-waits.ts",
        "task-graph-pg-operational-failure-observation.ts",
        "steering-reconciliation-operational-failed-branch-history.ts",
        "task-graph-pg-operational-failed-branch-relation.ts",
        "steering-reconciliation-history.ts",
        "steering-reconciliation-ledger.ts",
        "canonical-turn-state.ts",
        "durable-wait-consumer.ts",
        "durable-wait-historical-failure-proof.ts",
      ])
      const sites: string[] = []
      for (const line of stack.split(/\r?\n/)) {
        const match = /([A-Za-z0-9._-]+\.ts):(\d+):(\d+)/.exec(line)
        const basename = match?.[1]
        if (!match || !basename || (!allowed.has(basename) && !/^steering-reconciliation-[a-z0-9-]+\.ts$/.test(basename))) continue
        sites.push(`${basename}:${match[2]}:${match[3]}`)
        if (sites.length === 3) break
      }
      return sites.length ? sites.join(",") : "none"
    }
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: value.ownerId, productionFlags: flags,
      taskGraphCommandPort: {
        ...commandPort,
        async appendAndScheduleWithReconciliation(input, operation) {
          const operational = input.replaceOperationalFailure !== undefined || operation.replaceOperationalFailure !== undefined
          try {
            const receipt = await appendWithReconciliation.call(commandPort, input, operation)
            if (operational) replacementPlanCommandDiagnostic = `returned_${safeLabel(receipt.status)}`
            return receipt
          } catch (error) {
            if (operational) {
              const code = error && typeof error === "object" && "code" in error ? error.code : undefined
              const label = safeLabel(typeof code === "string" ? code : error instanceof Error ? error.name : "unknown")
              const stackSites = safeOperationalStackSites(error instanceof Error ? error.stack : undefined)
              replacementPlanCommandDiagnostic = `threw_${label}@${stackSites}`
            }
            throw error
          }
        },
      },
      taskGraphTemplates: { ...TASK_GRAPH_TEMPLATES },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecutions
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-operational-failure-replan-root-fixture", profile,
          async *stream(request) {
            round += 1
            if (execution === 1 && round === 1) {
              yield { type: "tool_call_completed", callId: planCallId, name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [
                  { key: "scout", templateId: "scout", goal: sourceGoal, successCriteria: ["Return one source candidate"], dependsOn: [], verification: SCOUT_VERIFICATION },
                  { key: "analyst", templateId: "analyst", goal: dependentGoal, successCriteria: ["Return one analysis finding"], dependsOn: ["scout"], verification: ANALYST_VERIFICATION },
                ],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              initialTaskIds = planTaskIds(request, planCallId, 2)
              const root = await pool!.query<{ rootTaskId: string | null }>(
                `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                [value.turnId, value.sessionId, value.userId],
              )
              rootTaskId = root.rows[0]?.rootTaskId ?? ""
              if (!rootTaskId) throw new Error("Operational failure fixture lost the current Root identity")
              yield { type: "tool_call_completed", callId: initialWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: initialWaitKey, taskIds: initialTaskIds, mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([["scout", "failed"], ["analyst", "cancelled"]])
              expect(nodes.find(node => node?.key === "scout")?.executionFailureCategory).toBe("resume_state_unavailable")
              const planTool = request.tools.map(record).find(tool => tool?.name === "agent.plan")
              const planProperties = record(record(planTool?.inputSchema)?.properties)
              expect(planProperties).toHaveProperty("replaceOperationalFailure")
              const outcome = repairWaitOutcomeFromRequest(request, initialWaitCallId, initialTaskIds)
              expect(outcome.status).toBe("ready")
              const waitTasks = new Map<string, unknown>()
              for (const value of Array.isArray(outcome.tasks) ? outcome.tasks : []) {
                const task = record(value)
                if (typeof task?.taskId === "string") waitTasks.set(task.taskId, task.status)
              }
              expect(waitTasks.get(initialTaskIds[0]!)).toBe("failed")
              expect(waitTasks.get(initialTaskIds[1]!)).toBe("cancelled")
              const source = await pool!.query<{ status: string; failureReason: string | null; result: unknown }>(
                `SELECT "status", "failureReason", "result" FROM "sub_agent_tasks"
                 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4`,
                [initialTaskIds[0], value.sessionId, value.turnId, rootTaskId],
              )
              expect(source.rows[0]).toMatchObject({ status: "failed", failureReason: "child_resume_unavailable" })
              const sourceResult = record(source.rows[0]?.result)
              expect(Object.keys(sourceResult ?? {}).sort()).toEqual(["taskGraphVerificationReport"])
              expect(Object.hasOwn(sourceResult ?? {}, "workerResult")).toBe(false)
              expectUnverifiedVerificationReport(sourceResult?.taskGraphVerificationReport, "candidate-count")
              originalOperationalFailureResult = source.rows[0]?.result
              originalFailureEnvelopeObserved = true
              const descendant = await pool!.query<{ status: string; failureReason: string | null; result: unknown }>(
                `SELECT "status", "failureReason", "result" FROM "sub_agent_tasks"
                 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4`,
                [initialTaskIds[1], value.sessionId, value.turnId, rootTaskId],
              )
              expect(descendant.rows[0]).toMatchObject({ status: "cancelled", failureReason: "A prerequisite task did not complete." })
              const waitRow = await pool!.query<{ id: string; status: string; targetTaskIds: string[]; matchedTaskIds: string[];
                suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null; result: unknown }>(
                `SELECT "id", "status", "targetTaskIds", "matchedTaskIds", "suspendedAt", "resolvedAt", "consumedAt", "result"
                 FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3
                   AND "parentTaskId" = $4 AND "idempotencyKey" = $5 AND "mode" = 'all'`,
                [value.userId, value.sessionId, value.turnId, rootTaskId, initialWaitKey],
              )
              expect(waitRow.rows).toHaveLength(1)
              const sortedInitialTaskIds = [...initialTaskIds].sort()
              expect(waitRow.rows[0]).toMatchObject({ status: "ready", targetTaskIds: sortedInitialTaskIds,
                matchedTaskIds: sortedInitialTaskIds, suspendedAt: expect.any(Date), consumedAt: expect.any(Date) })
              const persistedResult = record(waitRow.rows[0]?.result)
              expect(persistedResult?.request).toMatchObject({ targetTaskIds: sortedInitialTaskIds, mode: "all", timeoutMs: 30_000 })
              const persistedOutcome = record(persistedResult?.outcome)
              expect(persistedOutcome).toMatchObject({ waitId: waitRow.rows[0]?.id, status: "ready",
                targetTaskIds: sortedInitialTaskIds, matchedTaskIds: sortedInitialTaskIds })
              const persistedTaskStatuses = new Map<string, unknown>()
              for (const value of Array.isArray(persistedOutcome?.tasks) ? persistedOutcome.tasks : []) {
                const task = record(value)
                if (typeof task?.taskId === "string") persistedTaskStatuses.set(task.taskId, task.status)
              }
              expect(persistedTaskStatuses.get(initialTaskIds[0]!)).toBe("failed")
              expect(persistedTaskStatuses.get(initialTaskIds[1]!)).toBe("cancelled")
              consumedFailureWaitObserved = true
              consumedFailureWaitSnapshot = JSON.stringify({
                id: waitRow.rows[0]?.id,
                status: waitRow.rows[0]?.status,
                targetTaskIds: waitRow.rows[0]?.targetTaskIds,
                matchedTaskIds: waitRow.rows[0]?.matchedTaskIds,
                result: waitRow.rows[0]?.result,
                suspendedAt: waitRow.rows[0]?.suspendedAt?.toISOString() ?? null,
                resolvedAt: waitRow.rows[0]?.resolvedAt?.toISOString() ?? null,
                consumedAt: waitRow.rows[0]?.consumedAt?.toISOString() ?? null,
              })
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              yield { type: "tool_call_completed", callId: inlineWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: inlineWaitKey, taskIds: initialTaskIds, mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 2) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([["scout", "failed"], ["analyst", "cancelled"]])
              expect(nodes.find(node => node?.key === "scout")?.executionFailureCategory).toBe("resume_state_unavailable")
              const inlineOutcome = repairWaitOutcomeFromRequest(request, inlineWaitCallId, initialTaskIds)
              expect(inlineOutcome.status).toBe("ready")
              const inlineTaskStatuses = new Map<string, unknown>()
              for (const value of Array.isArray(inlineOutcome.tasks) ? inlineOutcome.tasks : []) {
                const task = record(value)
                if (typeof task?.taskId === "string") inlineTaskStatuses.set(task.taskId, task.status)
              }
              expect(inlineTaskStatuses.get(initialTaskIds[0]!)).toBe("failed")
              expect(inlineTaskStatuses.get(initialTaskIds[1]!)).toBe("cancelled")
              const inlineSource = (Array.isArray(inlineOutcome.tasks) ? inlineOutcome.tasks : []).map(record).find(task => task?.taskId === initialTaskIds[0])
              expectUnverifiedVerificationReport(record(inlineSource?.result)?.taskGraphVerificationReport, "candidate-count")

              const inlineWaitRow = await pool!.query<{ id: string; status: string; targetTaskIds: string[]; matchedTaskIds: string[];
                suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null; result: unknown }>(
                `SELECT "id", "status", "targetTaskIds", "matchedTaskIds", "suspendedAt", "resolvedAt", "consumedAt", "result"
                 FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3
                   AND "parentTaskId" = $4 AND "idempotencyKey" = $5 AND "mode" = 'all'`,
                [value.userId, value.sessionId, value.turnId, rootTaskId, inlineWaitKey],
              )
              expect(inlineWaitRow.rows).toHaveLength(1)
              const sortedInitialTaskIds = [...initialTaskIds].sort()
              expect(inlineWaitRow.rows[0]).toMatchObject({ status: "ready", targetTaskIds: sortedInitialTaskIds,
                matchedTaskIds: sortedInitialTaskIds, suspendedAt: null, resolvedAt: null, consumedAt: null })
              expect(inlineWaitRow.rows[0]?.result).toEqual({
                request: { targetTaskIds: sortedInitialTaskIds, mode: "all", timeoutMs: 30_000 },
              })

              const originalWait = await pool!.query<{ id: string; status: string; targetTaskIds: string[]; matchedTaskIds: string[];
                suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null; result: unknown }>(
                `SELECT "id", "status", "targetTaskIds", "matchedTaskIds", "suspendedAt", "resolvedAt", "consumedAt", "result"
                 FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3
                   AND "parentTaskId" = $4 AND "idempotencyKey" = $5 AND "mode" = 'all'`,
                [value.userId, value.sessionId, value.turnId, rootTaskId, initialWaitKey],
              )
              expect(originalWait.rows).toHaveLength(1)
              expect(JSON.stringify({
                id: originalWait.rows[0]?.id,
                status: originalWait.rows[0]?.status,
                targetTaskIds: originalWait.rows[0]?.targetTaskIds,
                matchedTaskIds: originalWait.rows[0]?.matchedTaskIds,
                result: originalWait.rows[0]?.result,
                suspendedAt: originalWait.rows[0]?.suspendedAt?.toISOString() ?? null,
                resolvedAt: originalWait.rows[0]?.resolvedAt?.toISOString() ?? null,
                consumedAt: originalWait.rows[0]?.consumedAt?.toISOString() ?? null,
              })).toBe(consumedFailureWaitSnapshot)
              inlineFailureWaitObserved = true
              if (!graph || typeof graph.revision !== "number") throw new Error("Operational failure fixture lost the current graph revision")
              yield { type: "tool_call_completed", callId: replacementPlanCallId, name: "agent.plan", arguments: {
                expectedRevision: graph.revision,
                replaceOperationalFailure: {
                  root: { nodeKey: "scout", taskId: initialTaskIds[0] },
                  sources: [
                    { nodeKey: "scout", taskId: initialTaskIds[0], replacementKey: "scout-replacement" },
                    { nodeKey: "analyst", taskId: initialTaskIds[1], replacementKey: "analyst-replacement" },
                  ],
                },
                nodes: [
                  { key: "scout-replacement", templateId: "scout", goal: replacementScoutGoal, successCriteria: ["Return one source candidate"], dependsOn: [], verification: SCOUT_VERIFICATION },
                  { key: "analyst-replacement", templateId: "analyst", goal: replacementAnalystGoal, successCriteria: ["Return one analysis finding"], dependsOn: ["scout-replacement"], verification: ANALYST_VERIFICATION },
                ],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 3) {
              const planResult = record(latestToolResult(request, replacementPlanCallId))
              replacementPlanResultDiagnostic = `${safeLabel(planResult?.status)}/${safeLabel(planResult?.errorCode ?? planResult?.code)}`
              replacementTaskIds = planTaskIds(request, replacementPlanCallId, 2)
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => node?.key)).toEqual(["scout-replacement", "analyst-replacement"])
              expect(nodes.map(node => node?.taskId)).toEqual(replacementTaskIds)
              expect(["queued", "running"]).toContain(nodes[0]?.status)
              expect(nodes[1]?.status).toBe("waiting")
              expect(nodes[1]?.dependsOn).toEqual(["scout-replacement"])
              replacementPlanAccepted = true
              yield { type: "tool_call_completed", callId: replacementWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: replacementWaitKey, taskIds: replacementTaskIds, mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 3 && round === 1) {
              const outcome = repairWaitOutcomeFromRequest(request, replacementWaitCallId, replacementTaskIds)
              expect(outcome.status).toBe("ready")
              const waitTaskStatuses = new Map<string, unknown>()
              for (const value of Array.isArray(outcome.tasks) ? outcome.tasks : []) {
                const task = record(value)
                if (typeof task?.taskId === "string") waitTaskStatuses.set(task.taskId, task.status)
              }
              expect(waitTaskStatuses.get(replacementTaskIds[0]!)).toBe("completed")
              expect(waitTaskStatuses.get(replacementTaskIds[1]!)).toBe("completed")
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([
                ["scout-replacement", "completed"], ["analyst-replacement", "completed"],
              ])
              expectPassedVerificationReport(nodes[0]?.verificationReport, "candidate-count")
              expectPassedVerificationReport(nodes[1]?.verificationReport, "finding-count")
              finalGraphVerified = true
              yield { type: "text_delta", text: "The operational failure was replaced and verified with fresh Scout and Analyst tasks." }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected operational failure Root execution ${execution}/${round}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const canonicalRuntimeExecute = runtime.execute
    runtime.execute = async input => {
      try {
        const result = await canonicalRuntimeExecute.call(runtime, input)
        const row = record(result)
        canonicalExecutionDiagnostic = "returned_" + safeLabel(row?.status) + "/" + safeLabel(row?.summary ?? row?.errorCode)
        return result
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined
        const label = safeLabel(typeof code === "string" ? code : error instanceof Error ? error.name : "unknown")
        canonicalExecutionDiagnostic = "threw_" + label + "@" + safeOperationalStackSites(error instanceof Error ? error.stack : undefined)
        throw error
      }
    }
    await activateFixtureTurn(pool!, value)
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!, runtime, ownerId: value.ownerId, turnQueueFactory: createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-operational-failure-resolver-${value.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          await waitForSuspendedParent(pool!, value.turnId, lease.goal === sourceGoal ? 1 : 2)
          if (lease.goal === sourceGoal) {
            expect(lease.role).toBe("scout")
            return { status: "failed", failureReason: "child_resume_unavailable", retryDisposition: "terminal" }
          }
          if (lease.goal === dependentGoal) throw new Error("The waiting Analyst descendant was dispatched before source failure")
          if (lease.goal === replacementScoutGoal || lease.goal === replacementAnalystGoal) {
            if (lease.role !== "scout" && lease.role !== "analyst") throw new Error("Replacement child role changed unexpectedly")
            await persistTaskGraphChildReadEvidence(pool!, lease)
            return { status: "completed", result: structuredChildResult(lease.role, lease.goal) }
          }
          throw new Error(`Unexpected operational failure child goal: ${lease.goal}`)
        },
      },
    })
    await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
    try {
      await waitForTurnStatus(pool!, value.turnId, "completed", 90_000, replacementWaitCallId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Turn status wait failed"
      throw new Error(reason + "; replacementPlanCommand=" + replacementPlanCommandDiagnostic + "; replacementPlanResult=" + replacementPlanResultDiagnostic + "; canonicalExecution=" + canonicalExecutionDiagnostic + "; rootExecutions=" + rootExecutions)
    }
    const turn = await pool!.query<{ rootTaskId: string | null; finalResponse: string | null; status: string }>(
      `SELECT "rootTaskId", "finalResponse", "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`,
      [value.turnId, value.sessionId],
    )
    expect(turn.rows[0]?.rootTaskId).toBe(rootTaskId)
    expect(turn.rows[0]?.status).toBe("completed")
    expect(turn.rows[0]?.finalResponse).toContain("operational failure was replaced and verified")
    expect(rootExecutions).toBe(3)
    expect(initialTaskIds).toHaveLength(2)
    expect(replacementTaskIds).toHaveLength(2)
    expect(new Set([...initialTaskIds, ...replacementTaskIds]).size).toBe(4)
    expect(consumedFailureWaitObserved).toBe(true)
    expect(inlineFailureWaitObserved).toBe(true)
    expect(replacementPlanAccepted).toBe(true)
    expect(finalGraphVerified).toBe(true)
    const tasks = await pool!.query<{ id: string; goal: string; status: string; failureReason: string | null; result: unknown }>(
      `SELECT "id", "goal", "status", "failureReason", "result" FROM "sub_agent_tasks"
       WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4`,
      [value.userId, value.sessionId, value.turnId, rootTaskId],
    )
    expect(tasks.rows).toHaveLength(4)
    const byGoal = new Map(tasks.rows.map(task => [task.goal, task] as const))
    const failedSource = byGoal.get(sourceGoal)
    expect(failedSource).toMatchObject({ id: initialTaskIds[0], status: "failed", failureReason: "child_resume_unavailable" })
    expect(originalFailureEnvelopeObserved).toBe(true)
    expect(failedSource?.result).toEqual(originalOperationalFailureResult)
    expectUnverifiedVerificationReport(record(failedSource?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(byGoal.get(dependentGoal)).toMatchObject({ id: initialTaskIds[1], status: "cancelled", failureReason: "A prerequisite task did not complete." })
    expect(byGoal.get(replacementScoutGoal)).toMatchObject({ id: replacementTaskIds[0], status: "completed", failureReason: null })
    expectPassedVerificationReport(record(byGoal.get(replacementScoutGoal)?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(byGoal.get(replacementAnalystGoal)).toMatchObject({ id: replacementTaskIds[1], status: "completed", failureReason: null })
    expectPassedVerificationReport(record(byGoal.get(replacementAnalystGoal)?.result)?.taskGraphVerificationReport, "finding-count")
    const waits = await pool!.query<{ id: string; idempotencyKey: string; status: string; targetTaskIds: string[]; matchedTaskIds: string[];
      suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null; result: unknown }>(
      `SELECT "id", "idempotencyKey", "status", "targetTaskIds", "matchedTaskIds", "suspendedAt", "resolvedAt", "consumedAt", "result"
       FROM "agent_wait_conditions" WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 ORDER BY "createdAt"`,
      [value.userId, value.sessionId, value.turnId, rootTaskId],
    )
    expect(waits.rows).toHaveLength(3)
    expect(waits.rows.map(wait => wait.idempotencyKey)).toEqual(expect.arrayContaining([initialWaitKey, inlineWaitKey, replacementWaitKey]))
    const initialWait = waits.rows.find(wait => wait.idempotencyKey === initialWaitKey)
    const inlineWait = waits.rows.find(wait => wait.idempotencyKey === inlineWaitKey)
    const replacementWait = waits.rows.find(wait => wait.idempotencyKey === replacementWaitKey)
    expect(initialWait).toMatchObject({ status: "ready", targetTaskIds: [...initialTaskIds].sort(),
      matchedTaskIds: [...initialTaskIds].sort() })
    expect(initialWait?.suspendedAt).toBeInstanceOf(Date)
    expect(initialWait?.resolvedAt).toBeInstanceOf(Date)
    expect(initialWait?.consumedAt).toBeInstanceOf(Date)
    expect(JSON.stringify({
      id: initialWait?.id,
      status: initialWait?.status,
      targetTaskIds: initialWait?.targetTaskIds,
      matchedTaskIds: initialWait?.matchedTaskIds,
      result: initialWait?.result,
      suspendedAt: initialWait?.suspendedAt?.toISOString() ?? null,
      resolvedAt: initialWait?.resolvedAt?.toISOString() ?? null,
      consumedAt: initialWait?.consumedAt?.toISOString() ?? null,
    })).toBe(consumedFailureWaitSnapshot)
    expect(inlineWait).toMatchObject({ status: "ready", targetTaskIds: [...initialTaskIds].sort(),
      matchedTaskIds: [...initialTaskIds].sort(), suspendedAt: null, resolvedAt: null, consumedAt: null })
    expect(inlineWait?.result).toEqual({ request: { targetTaskIds: [...initialTaskIds].sort(), mode: "all", timeoutMs: 30_000 } })
    expect(replacementWait).toMatchObject({ status: "ready", targetTaskIds: [...replacementTaskIds].sort(),
      matchedTaskIds: [...replacementTaskIds].sort() })
    expect(replacementWait?.suspendedAt).toBeInstanceOf(Date)
    expect(replacementWait?.resolvedAt).toBeInstanceOf(Date)
    expect(replacementWait?.consumedAt).toBeInstanceOf(Date)
    const graphEvents = await pool!.query<{ payload: unknown; idempotencyKey: string }>(
      `SELECT "payload", "idempotencyKey" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 ORDER BY "sequence"`,
      [value.sessionId, value.turnId, taskGraphItemId(rootTaskId!)],
    )
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphLifecycleKey(rootTaskId!, "scout", 1, "task.failed")
      && record(record(event.payload)?.event)?.failureReason === "child_resume_unavailable")).toBe(true)
    expect(graphEvents.rows.some(event => event.idempotencyKey === taskGraphLifecycleKey(rootTaskId!, "analyst", 0, "task.cancelled"))).toBe(true)
  }, 120_000)

  it("cancels dependent descendants when a running source task is closed", async () => {
    const [
      { createProductionWorkerBootstrap },
      { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME },
      subagentQueue,
      { createCanonicalTurnRuntime },
      { createPgTaskGraphCommandPort },
      { AgentTreeManager },
    ] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../turns/turn-queue.js"),
      import("../../queue/subagent-queue.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("./manager.js"),
    ])
    const owner = cancelledOwner
    const taskCloser = new AgentTreeManager(new PgSubagentTaskStore(pool!))
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true,
      childExecutionEnabled: true,
      coordinationEnabled: true,
      consumeWaitOutcomes: true,
      canonicalAutomationEnabled: false,
      turnBoundaryCompactionEnabled: false,
    }
    const closePlanCallId = "p3-closed-source-plan"
    const closeWaitCallId = "p3-closed-source-wait"
    const sourceGoal = "Run and close the source task through its manager"
    const dependentGoal = "Must not run after its source is closed"
    const transitiveGoal = "Must not run after its ancestor is closed"
    const finalMarker = "p3-closed-source-descendants-cancelled"
    let rootRuntimeExecutions = 0
    let sourceCloseAccepted = false
    const dispatchedGoals: string[] = []
    const runtime = await createCanonicalTurnRuntime(pool!, {
      workerId: owner.ownerId,
      productionFlags: flags,
      taskGraphCommandPort: createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: {
        analyst: { role: "analyst", taskType: "research", allowedActions: ["jobs.search"] },
      },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootRuntimeExecutions
        let modelRounds = 0
        const model: ModelAdapter = {
          id: "p3-task-graph-closed-source-fixture-model",
          profile: {
            provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
            continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
            supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
            supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low",
          },
          async *stream(request) {
            modelRounds += 1
            if (execution === 1 && modelRounds === 1) {
              yield {
                type: "tool_call_completed", callId: closePlanCallId, name: "agent.plan",
                arguments: {
                  expectedRevision: 0,
                  nodes: [
                    { key: "source", templateId: "analyst", goal: sourceGoal, successCriteria: ["Close through the manager"], dependsOn: [], verification: ANALYST_VERIFICATION },
                    { key: "dependent", templateId: "analyst", goal: dependentGoal, successCriteria: ["Remain undispatched"], dependsOn: ["source"], verification: ANALYST_VERIFICATION },
                    { key: "transitive", templateId: "analyst", goal: transitiveGoal, successCriteria: ["Remain undispatched"], dependsOn: ["dependent"], verification: ANALYST_VERIFICATION },
                  ],
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && modelRounds === 2) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.wait")
              yield {
                type: "tool_call_completed", callId: closeWaitCallId, name: "agent.wait",
                arguments: {
                  idempotencyKey: `p3-task-graph-closed-source-wait:${owner.turnId}`,
                  taskIds: planTaskIds(request, closePlanCallId, 3), mode: "all", timeoutMs: 20_000,
                },
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && modelRounds === 1) {
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => [node?.key, node?.status])).toEqual([
                ["source", "closed"], ["dependent", "cancelled"], ["transitive", "cancelled"],
              ])
              const outcome = waitOutcomeFromRequest(request, 3)
              expect(outcome.status).toBe("ready")
              expect(outcome.tasks.map(task => record(task)?.status).sort()).toEqual(["cancelled", "cancelled", "closed"])
              yield { type: "text_delta", text: finalMarker }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error("Unexpected model execution or round in the closed-source fixture")
          },
        }
        return { adapter: model, registry: {} as never, candidates: [] }
      },
    })
    await activateFixtureTurn(pool!, owner)
    bootstrap = await createProductionWorkerBootstrap({
      pool: pool!,
      runtime,
      ownerId: owner.ownerId,
      turnQueueFactory: createTurnQueue,
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-closed-source-wait-resolver-${owner.suffix}` },
      subagents: {
        intervalMs: 10,
        async execute({ lease }) {
          await waitForSuspendedParent(pool!, owner.turnId)
          recordTaskGraphFixtureLease(lease, owner, dispatchedGoals)
          if (lease.goal === sourceGoal) {
            const running = await pool!.query<{ status: string }>(
              `SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
              [lease.id, owner.sessionId],
            )
            expect(running.rows[0]?.status).toBe("running")
            sourceCloseAccepted = await taskCloser.close(lease.id, owner.sessionId)
            expect(sourceCloseAccepted).toBe(true)
            return { status: "completed", result: { proof: "The manager close path closed this task." } }
          }
          return { status: "completed", result: { proof: `unexpected execution: ${lease.goal}` } }
        },
      },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, {
      turnId: owner.turnId, sessionId: owner.sessionId, ownerId: owner.ownerId,
    })
    try {
      await waitForTurnStatus(pool!, owner.turnId, "failed", 50_000, closeWaitCallId)
    } catch (error: unknown) {
      const progress = await turnProgressDiagnostics(pool!, owner.turnId, closeWaitCallId)
      throw new Error(combineFailureDiagnostics([
        { label: "closedSourceFixture", value: "failed" },
        { label: "turnFailure", value: waitTurnFailureSummary(error) },
      ], progress))
    }

    expect(rootRuntimeExecutions).toBe(2)
    expect(sourceCloseAccepted).toBe(true)
    expect(dispatchedGoals).toEqual([sourceGoal])
    const turn = await pool!.query<{ status: string; rootTaskId: string; finalResponse: string | null }>(
      `SELECT "status", "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [owner.turnId],
    )
    const rootTaskId = turn.rows[0]?.rootTaskId
    if (!rootTaskId) throw new Error("Closed-source fixture did not establish a root TaskGraph task")
    expect(turn.rows[0]?.status).toBe("failed")
    expect(turn.rows[0]?.finalResponse ?? "").not.toContain(finalMarker)
    const finalRejection = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'final.rejected'
       AND "payload"->>'blocker' = 'task_graph_verification_unverified' ORDER BY "sequence" DESC LIMIT 1`,
      [owner.turnId, owner.sessionId],
    )
    expect(record(finalRejection.rows[0]?.payload)).toMatchObject({ blocker: "task_graph_verification_unverified" })

    const children = await pool!.query<{ id: string; goal: string; status: string }>(
      `SELECT "id", "goal", "status" FROM "sub_agent_tasks"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "parentTaskId" = $3 ORDER BY "goal"`,
      [owner.sessionId, owner.turnId, rootTaskId],
    )
    expect(children.rows).toHaveLength(3)
    expect(Object.fromEntries(children.rows.map(child => [child.goal, child.status]))).toEqual({
      [dependentGoal]: "cancelled",
      [sourceGoal]: "closed",
      [transitiveGoal]: "cancelled",
    })

    const source = children.rows.find(child => child.goal === sourceGoal)
    const dependent = children.rows.find(child => child.goal === dependentGoal)
    const transitive = children.rows.find(child => child.goal === transitiveGoal)
    if (!source || !dependent || !transitive) throw new Error("Closed-source fixture did not persist every TaskGraph child")

    const terminalReceipts = await pool!.query<{ taskId: string; idempotencyKey: string; payload: RecordValue }>(
      `SELECT "taskId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3
         AND "taskId" = ANY($4::text[]) AND "payload"->>'kind' = 'lifecycle'
       ORDER BY "sequence" ASC`,
      [owner.sessionId, owner.turnId, taskGraphItemId(rootTaskId), [source.id, dependent.id, transitive.id]],
    )
    const expectedTerminalReceipts = terminalReceipts.rows.flatMap(row => {
      const event = record(record(row.payload)?.event)
      if (event?.type !== "task.closed" && event?.type !== "task.cancelled") return []
      return [{
        taskId: row.taskId,
        idempotencyKey: row.idempotencyKey,
        type: event.type,
        nodeKey: event.nodeKey,
      }]
    })
    expect(expectedTerminalReceipts).toHaveLength(3)
    expect(expectedTerminalReceipts).toEqual([
      {
        taskId: source.id,
        idempotencyKey: taskGraphLifecycleKey(rootTaskId, "source", 1, "task.closed"),
        type: "task.closed",
        nodeKey: "source",
      },
      {
        taskId: dependent.id,
        idempotencyKey: taskGraphLifecycleKey(rootTaskId, "dependent", 0, "task.cancelled"),
        type: "task.cancelled",
        nodeKey: "dependent",
      },
      {
        taskId: transitive.id,
        idempotencyKey: taskGraphLifecycleKey(rootTaskId, "transitive", 0, "task.cancelled"),
        type: "task.cancelled",
        nodeKey: "transitive",
      },
    ])

    const blockedDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
        AND "idempotencyKey" = ANY($2::text[])`,
      [owner.sessionId, [dependent.id, transitive.id].map(taskId => `subagent-dispatch:${taskId}`)],
    )
    expect(blockedDispatches.rowCount).toBe(0)
  }, 90_000)

  it("restores interactive discovery across a real Worker restart and replays its child dispatch once", async () => {
    const restartCaseStartedAt = Date.now()
    if (interactiveDiscoveryTraceArtifactPath) await rm(interactiveDiscoveryTraceArtifactPath, { force: true })
    const [{ TURN_QUEUE_NAME }, subagentQueue, turnDispatch] = await Promise.all([
      import("../turns/turn-queue.js"), import("../../queue/subagent-queue.js"), import("../turns/recovery-scanner.js"),
    ])
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const value = discoveryRestartOwner
    const jobId = fixtureJobId(value.suffix)
    // BullMQ marks current active jobs as stalled candidates; a later eligible pass reclaims those whose locks expired. Pin the supported minimum interval so natural recovery fits the unchanged deadline.
    const restartWorkerEnv = { BULLMQ_STALLED_INTERVAL_MS: "30000" }
    const queueStates = ["active", "waiting", "delayed", "paused", "waiting-children", "prioritized", "failed", "completed"] as const
    const stalledQueueEvents: RecordValue[] = []
    const restartQueueSnapshots: RecordValue[] = []
    const orphanGenerationJobIds = new Set<string>()
    const observedWorkerByJobId = new Map<string, string>()
    let stalledQueueEventsTruncated = false
    let checkpointQueue: Queue | undefined
    let queueEvents: QueueEvents | undefined
    let stalledMidpointDueAt: number | null = null
    let stalledMidpointSnapshot: RecordValue | null = null
    const workerOwnerId = (pid: number) => `p3-process-restart-discovery-worker-${pid}`
    const resolverOwnerId = (pid: number) => `p3-process-restart-discovery-wait-resolver-${pid}`
    // turnJobId appends "-<generation>"; removing the helper-generated zero keeps every generation for this Turn.
    const turnJobPrefix = turnDispatch.turnJobId(value.turnId, 0).slice(0, -1)
    const queueGeneration = (id: string): number | null => {
      const suffix = /-(0|[1-9][0-9]*)$/.exec(id)?.[1]
      if (suffix === undefined) return null
      const generation = Number(suffix)
      return Number.isSafeInteger(generation) && generation >= 0 && generation <= 100_000 ? generation : null
    }
    const queueRecoveryFailureDiagnostics = () => ({
      snapshots: restartQueueSnapshots.slice(0, 2),
      stalledEvents: stalledQueueEvents.slice(0, 16).map(event => ({
        at: event.at,
        generation: event.generation,
      })),
      stalledEventsTruncated: stalledQueueEventsTruncated,
      stalledMidpoint: stalledMidpointSnapshot,
    })
    const captureRestartQueueSnapshot = async (
      checkpoint: "after_worker2_sigkill" | "after_worker3_ready",
      ownerLabels: ReadonlyMap<string, string>,
    ): Promise<RecordValue> => {
      const observedAt = new Date().toISOString()
      try {
        if (!checkpointQueue) return { checkpoint, observedAt, unavailable: true }
        const outboxAttempt = await pool!.query<{ attemptCount: number; publishedAt: Date | null }>(
          `SELECT "attemptCount", "publishedAt" FROM "agent_outbox"
           WHERE "aggregateId" = $1 AND "topic" = $2 AND "idempotencyKey" = $3 LIMIT 1`,
          [value.sessionId, turnDispatch.TURN_DISPATCH_TOPIC, turnDispatch.turnDispatchKey(value.turnId)],
        )
        const candidateJobIds = new Set<string>()
        let candidatesTruncated = false
        const addCandidate = (jobId: string) => {
          if (!jobId.startsWith(turnJobPrefix) || candidateJobIds.has(jobId)) return
          if (candidateJobIds.size >= 16) {
            candidatesTruncated = true
            return
          }
          candidateJobIds.add(jobId)
        }
        for (const generation of [0, 2, 4, 6]) addCandidate(turnDispatch.turnJobId(value.turnId, generation))
        const attemptCount = boundedWorkerDiagnosticNumber(outboxAttempt.rows[0]?.attemptCount, 0, 100_000)
        if (attemptCount !== null) {
          for (const generation of [attemptCount - 1, attemptCount, attemptCount + 1]) {
            if (generation >= 0 && generation <= 100_000) addCandidate(turnDispatch.turnJobId(value.turnId, generation))
          }
        }
        for (const jobId of orphanGenerationJobIds) addCandidate(jobId)
        for (const jobId of observedWorkerByJobId.keys()) addCandidate(jobId)
        for (const event of stalledQueueEvents) {
          if (typeof event.jobId === "string") addCandidate(event.jobId)
        }
        for (const generation of [1, 3, 5]) addCandidate(turnDispatch.turnJobId(value.turnId, generation))
        const rows: RecordValue[] = []
        for (const jobId of candidateJobIds) {
          let lockPttlMs: number | null = null
          try {
            const pttl = await redis!.pttl(checkpointQueue.toKey(jobId) + ":lock")
            if (pttl === -2 || pttl === -1 || Number.isSafeInteger(pttl) && pttl >= 0 && pttl <= 30_000) lockPttlMs = pttl
          } catch {
            // Preserve the queue lookup when Redis cannot provide a bounded lock TTL.
          }
          const job = await checkpointQueue.getJob(jobId)
          if (!job) {
            rows.push({ generation: queueGeneration(jobId), worker: "no_queue_job", state: "missing", lockPttlMs, attemptsMade: null })
            continue
          }
          const payload = record(job.data)
          const ownerId = payload?.ownerId
          if (checkpoint === "after_worker2_sigkill" && observedWorkerByJobId.get(jobId) === "worker2_active_observed"
            && payload?.turnId === value.turnId && payload.sessionId === value.sessionId) {
            orphanGenerationJobIds.add(jobId)
          }
          const state = diagnosticEnum(await job.getState(), new Set<string>(queueStates)) ?? "other"
          rows.push({
            generation: queueGeneration(jobId),
            worker: observedWorkerByJobId.get(jobId)
              ?? (typeof ownerId === "string" ? ownerLabels.get(ownerId) ?? "unmapped_owner" : "missing_owner"),
            state,
            lockPttlMs,
            attemptsMade: diagnosticBoundedCount(job.attemptsMade),
          })
        }
        return {
          checkpoint,
          observedAt,
          dispatchOutboxPresent: outboxAttempt.rows.length === 1,
          dispatchAttemptCount: attemptCount,
          dispatchPublishedAt: outboxAttempt.rows[0]?.publishedAt instanceof Date
            ? outboxAttempt.rows[0].publishedAt.toISOString() : null,
          candidateCount: candidateJobIds.size,
          candidatesTruncated,
          rows,
        }
      } catch {
        return { checkpoint, observedAt, unavailable: true }
      }
    }
    let workerOne: ProcessFixtureChild | undefined
    let workerTwo: ProcessFixtureChild | undefined
    let workerThree: ProcessFixtureChild | undefined
    try {
      checkpointQueue = new Queue(TURN_QUEUE_NAME, { connection: redis!, skipVersionCheck: true })
      queueEvents = new QueueEvents(TURN_QUEUE_NAME, { connection: redis!.duplicate(), skipVersionCheck: true })
      queueEvents.on("stalled", ({ jobId: stalledJobId }) => {
        if (typeof stalledJobId !== "string" || !stalledJobId.startsWith(turnJobPrefix)) return
        if (stalledQueueEvents.length >= 16) {
          stalledQueueEventsTruncated = true
          return
        }
        stalledQueueEvents.push({
          at: new Date().toISOString(),
          jobId: stalledJobId,
          generation: queueGeneration(stalledJobId),
        })
      })
      await Promise.all([checkpointQueue.waitUntilReady(), queueEvents.waitUntilReady()])
      await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
        value.turnId,
        JSON.stringify({ goal: "Find and rank a software engineering role in Dublin", intent: { kind: "interactive_discovery_shortlist", version: 1 } }),
        value.sessionId, value.userId,
      ])
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
        VALUES ($1, $2, 'Restart Fixture Labs', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/restart-discovery', 'Build durable systems', 'greenhouse', CURRENT_TIMESTAMP)`, [
        jobId, value.userId,
      ])

      workerOne = startTaskGraphRestartWorker("park-discovery", { ...value, jobId }, restartWorkerEnv)
      await waitForProcessLine(workerOne, "P3_DISCOVERY_PARENT_SUSPENDED ", 45_000)
      const waitingTurn = await pool!.query<{ status: string; leaseVersion: number; rootTaskId: string | null }>(
        `SELECT "status", "leaseVersion", "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [value.turnId, value.sessionId, value.userId],
      )
      expect(waitingTurn.rows[0]).toMatchObject({ status: "waiting_for_dependency", leaseVersion: 1 })
      const rootTaskId = waitingTurn.rows[0]?.rootTaskId
      expect(rootTaskId).toBeTruthy()
      const source = await pool!.query<{ id: string; status: string }>(
        `SELECT "id", "status" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 AND "role" = 'scout'`,
        [value.turnId, value.sessionId, rootTaskId],
      )
      expect(source.rows).toHaveLength(1)
      expect(source.rows[0]?.status).toBe("queued")
      const initialDispatch = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [value.sessionId, `subagent-dispatch:${source.rows[0]!.id}`],
      )
      expect(initialDispatch.rows).toHaveLength(1)
      expect(initialDispatch.rows[0]?.publishedAt).toBeInstanceOf(Date)

      const foreignTask = await new PgCoordinationStore(pool!).getTask({
        userId: `p3-foreign-user-${value.suffix}`, sessionId: value.sessionId, taskId: source.rows[0]!.id,
      })
      expect(foreignTask).toBeNull()
      const { requireCurrentOwnerJobs } = await import("../interactive-discovery-persistence.js")
      const foreignShortlist = await requireCurrentOwnerJobs(pool!, `p3-foreign-user-${value.suffix}`, {
        schemaVersion: 1, status: "completed", items: [{ jobId, score: 8.5, evidenceIds: [`read:job:${jobId}`] }], failures: [],
      })
      expect(foreignShortlist).toMatchObject({ status: "failed", items: [], failures: ["evidence_unverified"] })

      const firstExit = waitForProcessExit(workerOne)
      noteFixtureSigkillTurnJob(workerOne, turnQueueName!, turnJobId(value.turnId, 0))
      expect(workerOne.kill("SIGKILL")).toBe(true)
      await firstExit
      expect(workerOne.signalCode).toBe("SIGKILL")
      // Replay a published outbox row to model a crash between queue acceptance and publish acknowledgement.
      const resetDispatch = await pool!.query(
        `UPDATE "agent_outbox" SET "publishedAt" = NULL WHERE "id" = $1 AND "publishedAt" IS NOT NULL RETURNING "id"`,
        [initialDispatch.rows[0]!.id],
      )
      expect(resetDispatch.rowCount).toBe(1)

      workerTwo = startTaskGraphRestartWorker("resume-discovery", { ...value, jobId, checkpointAfterWaitConsume: true }, restartWorkerEnv)
      await waitForProcessLine(workerTwo, "P3_DISCOVERY_SECOND_WORKER_READY ", 45_000)
      await waitForProcessLine(workerTwo, "P3_DISCOVERY_WAIT_OUTCOME_COMMITTED", 90_000)
      const checkpointOwnerId = `p3-process-restart-discovery-wait-resolver-${workerTwo.pid}`
      const checkpointTurn = await pool!.query<{
        status: string; rootTaskId: string | null; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null
      }>(`SELECT "status", "rootTaskId", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
        FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [value.turnId, value.sessionId, value.userId])
      expect(checkpointTurn.rows).toHaveLength(1)
      expect(checkpointTurn.rows[0]).toMatchObject({
        status: "in_progress", rootTaskId, leaseOwnerId: checkpointOwnerId,
        leaseVersion: expect.any(Number), leaseExpiresAt: expect.any(Date),
      })
      expect(checkpointTurn.rows[0]!.leaseVersion).toBeGreaterThan(waitingTurn.rows[0]!.leaseVersion)
      expect(checkpointTurn.rows[0]!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
      const checkpointWaitResult = await pool!.query<{
        id: string; parentTaskId: string; stepId: string; mode: string; status: string; targetTaskIds: unknown
        matchedTaskIds: unknown; result: unknown; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
      }>(`SELECT "id", "parentTaskId", "stepId", "mode", "status", "targetTaskIds", "matchedTaskIds", "result",
          "suspendedAt", "resolvedAt", "consumedAt" FROM "agent_wait_conditions"
        WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4
          AND "idempotencyKey" = $5`, [value.userId, value.sessionId, value.turnId, rootTaskId,
        `p3-process-restart-discovery-wait:${value.turnId}`])
      expect(checkpointWaitResult.rows).toHaveLength(1)
      const checkpointWait = checkpointWaitResult.rows[0]!
      expect(checkpointWait).toMatchObject({
        parentTaskId: rootTaskId, mode: "all", status: "ready",
        suspendedAt: expect.any(Date), resolvedAt: expect.any(Date), consumedAt: expect.any(Date),
      })
      expect(checkpointWait.targetTaskIds).toEqual([source.rows[0]!.id])
      expect(checkpointWait.matchedTaskIds).toEqual([source.rows[0]!.id])
      const checkpointOutcome = record(record(checkpointWait.result)?.outcome)
      const checkpointOutcomeTasks = Array.isArray(checkpointOutcome?.tasks) ? checkpointOutcome.tasks.map(record) : []
      expect(checkpointOutcome).toMatchObject({
        waitId: checkpointWait.id, status: "ready", targetTaskIds: [source.rows[0]!.id],
        matchedTaskIds: [source.rows[0]!.id],
      })
      expect(checkpointOutcomeTasks).toHaveLength(1)
      expect(checkpointOutcomeTasks[0]).toMatchObject({ taskId: source.rows[0]!.id, role: "scout", status: "completed" })
      expectPassedVerificationReport(checkpointOutcomeTasks[0]?.verificationReport, "candidate-count")
      const checkpointStep = await pool!.query<{ id: string; taskId: string; attempt: number; status: string }>(
        `SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
         WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3 AND "taskId" = $4`,
        [checkpointWait.stepId, value.turnId, value.sessionId, rootTaskId],
      )
      expect(checkpointStep.rows).toEqual([{
        id: checkpointWait.stepId, taskId: rootTaskId, attempt: 1, status: "waiting_for_tool",
      }])
      const checkpointChildren = await pool!.query<{ id: string; role: string; status: string }>(
        `SELECT "id", "role", "status" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "rootTaskId" = $3 AND "parentTaskId" = $3 ORDER BY "createdAt"`,
        [value.sessionId, value.turnId, rootTaskId],
      )
      expect(checkpointChildren.rows).toEqual([{ id: source.rows[0]!.id, role: "scout", status: "completed" }])
      const checkpointGraphItems = await pool!.query<{ id: string; revision: number; content: unknown }>(
        `SELECT item."id", item."revision", item."content" FROM "agent_items" AS item
         JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
         JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
         WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
           AND item."type" = 'task_graph' AND turn."rootTaskId" = $4
           AND turn."userId" = $5 AND session."userId" = $5
         ORDER BY item."revision" DESC, item."updatedAt" DESC LIMIT 1`,
        [taskGraphItemId(rootTaskId!), value.sessionId, value.turnId, rootTaskId, value.userId],
      )
      expect(checkpointGraphItems.rows).toHaveLength(1)
      const checkpointGraphItem = checkpointGraphItems.rows[0]!
      expect(checkpointGraphItem.id).toBe(taskGraphItemId(rootTaskId!))
      expect(Number.isSafeInteger(checkpointGraphItem.revision)).toBe(true)
      expect(checkpointGraphItem.revision).toBeGreaterThan(0)
      const checkpointGraph = parseTaskGraphSnapshot(checkpointGraphItem.content)
      expect(checkpointGraph.nodes.map(node => ({ key: node.key, taskId: node.taskId, dependsOn: node.dependsOn }))).toEqual([
        { key: "scout", taskId: source.rows[0]!.id, dependsOn: [] },
      ])
      const checkpointGraphRevision = checkpointGraphItem.revision
      expect(workerTwo.output.filter(line => line.startsWith(`P3_DISCOVERY_CHILD_SETTLED ${source.rows[0]!.id} scout completed`))).toHaveLength(1)
      expect(workerTwo.output.some(line => line.startsWith("P3_DISCOVERY_RESTORED_FINAL_GRAPH "))).toBe(false)
      const checkpointWaitItems = await pool!.query<{ type: string; content: unknown; count: number }>(
        `SELECT "type", MIN("content"::text)::jsonb AS "content", COUNT(*)::int AS "count" FROM "agent_items"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND "content"->>'toolCallId' = $4 GROUP BY "type" ORDER BY "type"`,
        [value.sessionId, value.turnId, rootTaskId, DISCOVERY_RESTART_WAIT_CALL_ID],
      )
      expect(checkpointWaitItems.rows.map(({ type, count }) => ({ type, count }))).toEqual([
        { type: "tool_call", count: 1 }, { type: "tool_result", count: 1 },
      ])
      const checkpointWaitReceipt = record(checkpointWaitItems.rows.find(item => item.type === "tool_result")?.content)
      expect(record(checkpointWaitReceipt?.output)).toMatchObject({
        status: "waiting", waitId: checkpointWait.id, taskIds: [source.rows[0]!.id], matchedTaskIds: [],
      })

      const secondExit = waitForProcessExit(workerTwo)
      workerTwo.terminationSignal = "SIGKILL"
      for (const event of processDiscoveryTurnWorkerDiagnostics(workerTwo, undefined)) {
        if (event.event === "active" && typeof event.generation === "number") {
          noteFixtureSigkillTurnJob(workerTwo, turnQueueName!, turnDispatch.turnJobId(value.turnId, event.generation))
        }
      }
      expect(workerTwo.kill("SIGKILL")).toBe(true)
      await secondExit
      expect(workerTwo.signalCode).toBe("SIGKILL")
      const killedWorkerTwoOwnerId = workerOwnerId(workerTwo.pid!)
      const killedWorkerTwoResolverOwnerId = resolverOwnerId(workerTwo.pid!)
      const afterWorkerTwoOwnerLabels = new Map([
        [workerOwnerId(workerOne.pid!), "worker1_dispatcher"],
        [resolverOwnerId(workerOne.pid!), "worker1_wait_resolver"],
        [killedWorkerTwoOwnerId, "worker2_dispatcher"],
        [killedWorkerTwoResolverOwnerId, "worker2_wait_resolver"],
      ])
      for (const event of processDiscoveryTurnWorkerDiagnostics(workerTwo, undefined)) {
        if (event.event !== "active" || typeof event.generation !== "number") continue
        const observedJobId = turnDispatch.turnJobId(value.turnId, event.generation)
        observedWorkerByJobId.set(observedJobId, "worker2_active_observed")
      }
      restartQueueSnapshots.push(await captureRestartQueueSnapshot(
        "after_worker2_sigkill",
        afterWorkerTwoOwnerLabels,
      ))
      const expiredCheckpointLease = await pool!.query(
        `UPDATE "agent_turns" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second', "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'in_progress'
           AND "leaseOwnerId" = $4 AND "leaseVersion" = $5 AND "leaseExpiresAt" > clock_timestamp()
         RETURNING "id"`,
        [value.turnId, value.sessionId, value.userId, checkpointOwnerId, checkpointTurn.rows[0]!.leaseVersion],
      )
      expect(expiredCheckpointLease.rowCount).toBe(1)

      workerThree = startTaskGraphRestartWorker("resume-discovery", { ...value, jobId }, restartWorkerEnv)
      await waitForProcessLine(workerThree, "P3_DISCOVERY_SECOND_WORKER_READY ", 45_000)
      const workerThreeOwnerId = workerOwnerId(workerThree.pid!)
      const workerThreeResolverOwnerId = resolverOwnerId(workerThree.pid!)
      for (const event of processDiscoveryTurnWorkerDiagnostics(workerTwo, workerThree)) {
        if (event.event !== "active" || typeof event.generation !== "number") continue
        observedWorkerByJobId.set(turnDispatch.turnJobId(value.turnId, event.generation), `${event.worker}_active_observed`)
      }
      const afterWorkerThreeReadySnapshot = await captureRestartQueueSnapshot(
        "after_worker3_ready",
        new Map([
          [workerOwnerId(workerOne.pid!), "worker1_dispatcher"],
          [resolverOwnerId(workerOne.pid!), "worker1_wait_resolver"],
          [killedWorkerTwoOwnerId, "worker2_dispatcher"],
          [killedWorkerTwoResolverOwnerId, "worker2_wait_resolver"],
          [workerThreeOwnerId, "worker3_dispatcher"],
          [workerThreeResolverOwnerId, "worker3_wait_resolver"],
        ]),
      )
      restartQueueSnapshots.push(afterWorkerThreeReadySnapshot)
      const workerThreeOptions = processDiscoveryTurnWorkerDiagnostics(workerTwo, workerThree)
        .find(event => event.worker === "worker3" && event.event === "observer_attached")
      const afterWorkerThreeRows = Array.isArray(afterWorkerThreeReadySnapshot.rows)
        ? afterWorkerThreeReadySnapshot.rows.map(record).filter((row): row is RecordValue => row !== null)
        : []
      const generationTwoReadyRow = afterWorkerThreeRows.find(row => row.generation === 2)
      const generationTwoReadyLockPttl = generationTwoReadyRow?.lockPttlMs
      const workerLockDurationMs = boundedWorkerDiagnosticNumber(workerThreeOptions?.lockDuration, 1, 300_000) ?? 30_000
      const workerStalledIntervalMs = boundedWorkerDiagnosticNumber(workerThreeOptions?.stalledInterval, 1, 300_000) ?? 30_000
      const generationTwoRemainingLockMs = typeof generationTwoReadyLockPttl === "number" && generationTwoReadyLockPttl >= 0
        ? generationTwoReadyLockPttl
        : generationTwoReadyLockPttl === -2 ? 0 : workerLockDurationMs
      // Observe after the sampled lock expires and one complete stalled-check interval can pass.
      stalledMidpointDueAt = Date.now() + generationTwoRemainingLockMs + workerStalledIntervalMs + 1_000
      const collectRestartDiscoveryDiagnostics = async () => {
        const processOutputs = [...(workerTwo?.output ?? []), ...(workerThree?.output ?? [])]
        const tasks = await pool!.query<DiscoveryVerifierTask & { failureReason: string | null; result: unknown }>(
          `SELECT "id", "role", "status", "attemptCount", "rootTaskId", "parentTaskId", "failureReason", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2`,
          [value.turnId, value.sessionId],
        )
        const toolReceipts = await pool!.query<{ callCount: number; resultCount: number }>(
          `SELECT COUNT(DISTINCT call."id") FILTER (WHERE call."type" = 'tool_call')::int AS "callCount",
                  COUNT(DISTINCT result."id") FILTER (WHERE result."type" = 'tool_result')::int AS "resultCount"
           FROM "agent_items" AS call
           LEFT JOIN "agent_items" AS result
             ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
            AND result."taskId" = call."taskId" AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
           WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = ANY($3::text[])
             AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'jobs.search'`,
          [value.sessionId, value.turnId, tasks.rows.map(task => task.id)],
        )
        const waits = await pool!.query<{ status: string; targetCount: number }>(
          `SELECT "status", jsonb_array_length("targetTaskIds"::jsonb)::int AS "targetCount"
           FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "sessionId" = $2`,
          [value.turnId, value.sessionId],
        )
        const taskStatusCounts: RecordValue = {}
        for (const task of tasks.rows) {
          const status = diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES)
          if (status) taskStatusCounts[status] = (typeof taskStatusCounts[status] === "number" ? taskStatusCounts[status] as number : 0) + 1
        }
        const waitStatuses = waits.rows.map(wait => diagnosticEnum(wait.status, WAIT_DIAGNOSTIC_STATUSES) ?? "other")
        const callCount = diagnosticBoundedCount(toolReceipts.rows[0]?.callCount) ?? 0
        const resultCount = diagnosticBoundedCount(toolReceipts.rows[0]?.resultCount) ?? 0
        const missingSearchMarker = [workerTwo, workerThree].some(worker => worker?.errors.some(line => line.includes("p3_discovery_child_search_tool_missing")))
        const verifierEvidence = await collectDiscoveryVerifierDiagnostics(pool!, value, tasks.rows)
        const [runtimeState, analystPlan] = await Promise.all([
          restartRuntimeStateDiagnostics(pool!, value.turnId),
          agentPlanLifecycleDiagnostics(pool!, value.turnId, PROCESS_FIXTURE_DISCOVERY_ANALYST_PLAN_CALL_ID),
        ])
        const searchObservation = callCount > 0 ? "yes" : missingSearchMarker ? "no" : "unknown"
        const processStage = processOutputs.some(line => line.startsWith("P3_DISCOVERY_RESTORED_FINAL_GRAPH "))
          ? "restored_final_graph"
          : processOutputs.some(line => line.startsWith("P3_DISCOVERY_WAIT_OUTCOME_COMMITTED"))
            ? "wait_outcome_committed" : processOutputs.some(line => line.startsWith("P3_DISCOVERY_SECOND_WORKER_READY "))
              ? "second_worker_ready" : "second_worker_pending"
        return {
          processStage,
          parentModelFailureClass: processFixtureFailureCategory(
            processOutputs, "P3_DISCOVERY_PARENT_MODEL_FAILURE ",
          ),
          jobsSearchAppeared: searchObservation,
          jobsSearchCallEmitted: searchObservation,
          jobsSearchResultPersisted: resultCount > 0,
          jobsSearchCallCount: callCount,
          jobsSearchResultCount: resultCount,
          taskStatusCounts: diagnosticStatusCounts(taskStatusCounts),
          childTasks: diagnosticDiscoveryTasks(tasks.rows),
          verifierEvidence,
          restartVerifierEvidence: processRestartVerifierEvidenceDiagnostics(processOutputs),
          childRuntimeScope: processChildRuntimeScopeDiagnostics(processOutputs),
          turnWorkerEvents: processDiscoveryTurnWorkerDiagnostics(workerTwo, workerThree),
          waitStatuses,
          waitTargetCounts: waits.rows.map(wait => diagnosticBoundedCount(wait.targetCount)),
          runtimeState,
          analystPlan,
          queueRecovery: queueRecoveryFailureDiagnostics(),
        }
      }
      try {
        await waitForTurnStatus(pool!, value.turnId, "completed", 90_000, DISCOVERY_RESTART_WAIT_CALL_ID, [
          DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID,
        ])
      } catch (error) {
        throw new Error(`Interactive discovery restart diagnostics=${JSON.stringify({
          ...(await collectRestartDiscoveryDiagnostics()),
          waitForTurnStatusFailure: waitForTurnStatusFailureDiagnostic(error),
        })}`)
      }

      const root = await pool!.query<{ id: string; status: string; result: unknown }>(
        `SELECT "id", "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'orchestrator'`,
        [value.turnId, value.sessionId],
      )
      expect(root.rows).toHaveLength(1)
      expect(root.rows[0]?.status).toBe("completed")
      const persistedShortlist = record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist
      const children = await pool!.query<{ id: string; role: string; status: string; result: unknown }>(
        `SELECT "id", "role", "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 AND "role" = ANY($4::text[]) ORDER BY "role"`,
        [value.turnId, value.sessionId, root.rows[0]!.id, ["analyst", "scout"]],
      )
      expect(children.rows.map(child => [child.role, child.status])).toEqual([["analyst", "completed"], ["scout", "completed"]])
      expect(workerTwo.output.filter(line => line.startsWith(`P3_DISCOVERY_CHILD_SETTLED ${source.rows[0]!.id} scout completed`))).toHaveLength(1)
      expect(workerThree.output.filter(line => line.startsWith(`P3_DISCOVERY_CHILD_STARTED ${source.rows[0]!.id} scout`))).toHaveLength(0)
      const persistedSearchReceipts = await pool!.query<{ taskId: string; toolName: string }>(
        `SELECT tool_result."taskId", tool_call."content"->>'toolName' AS "toolName"
         FROM "agent_items" AS tool_result
         JOIN "agent_items" AS tool_call
           ON tool_call."sessionId" = tool_result."sessionId" AND tool_call."turnId" = tool_result."turnId"
          AND tool_call."taskId" = tool_result."taskId" AND tool_call."type" = 'tool_call'
          AND tool_call."content"->>'toolCallId' = tool_result."content"->>'toolCallId'
         WHERE tool_result."sessionId" = $1 AND tool_result."turnId" = $2
           AND tool_result."taskId" = ANY($3::text[]) AND tool_result."type" = 'tool_result'
           AND tool_call."content"->>'toolName' = 'jobs.search'
         ORDER BY tool_result."taskId"`,
        [value.sessionId, value.turnId, children.rows.map(child => child.id)],
      )
      expect(persistedSearchReceipts.rows).toHaveLength(2)
      expect(persistedSearchReceipts.rows.map(receipt => receipt.taskId).sort()).toEqual(children.rows.map(child => child.id).sort())
      const dispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null }>(
        `SELECT "idempotencyKey", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = ANY($2::text[]) ORDER BY "idempotencyKey"`,
        [value.sessionId, children.rows.map(child => `subagent-dispatch:${child.id}`)],
      )
      expect(dispatches.rows).toHaveLength(2)
      expect(dispatches.rows.every(dispatch => dispatch.publishedAt instanceof Date)).toBe(true)
      expect(new Set(dispatches.rows.map(dispatch => dispatch.idempotencyKey)).size).toBe(2)
      const waits = await pool!.query<{
        id: string; idempotencyKey: string; status: string; targetTaskIds: unknown; matchedTaskIds: unknown
        result: unknown; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
      }>(`SELECT "id", "idempotencyKey", "status", "targetTaskIds", "matchedTaskIds", "result",
          "suspendedAt", "resolvedAt", "consumedAt" FROM "agent_wait_conditions"
        WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 ORDER BY "createdAt", "id"`,
      [value.userId, value.sessionId, value.turnId, rootTaskId])
      expect(waits.rows).toHaveLength(2)
      expect(waits.rows.every(wait => wait.status === "ready" && wait.suspendedAt instanceof Date
        && wait.resolvedAt instanceof Date && wait.consumedAt instanceof Date)).toBe(true)
      const firstWait = waits.rows.find(wait => wait.idempotencyKey === `p3-process-restart-discovery-wait:${value.turnId}`)
      const analystWait = waits.rows.find(wait => wait.idempotencyKey === `p3-process-restart-discovery-analyst-wait:${value.turnId}`)
      expect(firstWait).toBeDefined()
      expect(analystWait).toBeDefined()
      const analyst = children.rows.find(child => child.role === "analyst")
      expect(firstWait!.targetTaskIds).toEqual([source.rows[0]!.id])
      expect(firstWait!.matchedTaskIds).toEqual([source.rows[0]!.id])
      expect(firstWait!.consumedAt).toEqual(checkpointWait.consumedAt)
      expect(firstWait!.result).toEqual(checkpointWait.result)
      expect(analystWait!.targetTaskIds).toEqual([analyst!.id])
      expect(analystWait!.matchedTaskIds).toEqual([analyst!.id])
      expect(record(record(firstWait!.result)?.outcome)).toMatchObject({
        waitId: checkpointWait.id, status: "ready", targetTaskIds: [source.rows[0]!.id], matchedTaskIds: [source.rows[0]!.id],
      })
      const analystOutcome = record(record(analystWait!.result)?.outcome)
      expect(analystOutcome).toMatchObject({
        waitId: analystWait!.id, status: "ready", targetTaskIds: [analyst!.id], matchedTaskIds: [analyst!.id],
      })
      const analystOutcomeTasks = Array.isArray(analystOutcome?.tasks) ? analystOutcome.tasks.map(record) : []
      expect(analystOutcomeTasks).toHaveLength(1)
      expect(analystOutcomeTasks[0]).toMatchObject({ taskId: analyst!.id, role: "analyst", status: "completed" })
      expectPassedVerificationReport(
        analystOutcomeTasks[0]?.verificationReport,
        "finding-count",
      )
      const turn = await pool!.query<{ status: string; finalResponse: string | null; leaseVersion: number }>(
        `SELECT "status", "finalResponse", "leaseVersion" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [value.turnId, value.sessionId, value.userId],
      )
      expect(turn.rows[0]?.leaseVersion).toBeGreaterThan(checkpointTurn.rows[0]!.leaseVersion)
      expect(persistedShortlist).toEqual({
        schemaVersion: 1, status: "completed", items: [{ jobId, score: 8.5, evidenceIds: [`read:job:${jobId}`] }], failures: [],
      })
      expect(workerTwo.output.some(line => line.startsWith("P3_DISCOVERY_RESTORED_FINAL_GRAPH "))).toBe(false)
      expect(workerThree.output.some(line => line.startsWith("P3_DISCOVERY_RESTORED_FINAL_GRAPH "))).toBe(true)
      expect(workerThree.output.filter(line => line.startsWith(`P3_DISCOVERY_CHILD_SETTLED ${analyst!.id} analyst completed`))).toHaveLength(1)
      const rootToolItems = await pool!.query<{ type: string; toolCallId: string; content: unknown; count: number }>(
        `SELECT "type", "content"->>'toolCallId' AS "toolCallId", MIN("content"::text)::jsonb AS "content", COUNT(*)::int AS "count"
         FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND "type" IN ('tool_call', 'tool_result') AND "content"->>'toolCallId' = ANY($4::text[])
         GROUP BY "type", "content"->>'toolCallId' ORDER BY "toolCallId", "type"`,
        [value.sessionId, value.turnId, rootTaskId, [
          DISCOVERY_RESTART_WAIT_CALL_ID, DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID,
          "p3-process-restart-discovery-plan",
        ]],
      )
      expect(rootToolItems.rows).toHaveLength(8)
      expect(rootToolItems.rows.every(item => item.count === 1)).toBe(true)
      const rootToolItem = (callId: string, type: string) => rootToolItems.rows.find(item => item.toolCallId === callId && item.type === type)
      const initialWaitCall = record(rootToolItem(DISCOVERY_RESTART_WAIT_CALL_ID, "tool_call")?.content)
      expect(record(initialWaitCall?.input)?.taskIds).toEqual([source.rows[0]!.id])
      const analystPlanCall = record(rootToolItem(DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, "tool_call")?.content)
      const analystPlanInput = record(analystPlanCall?.input)
      expect(analystPlanInput?.expectedRevision).toBe(checkpointGraphRevision)
      expect(analystPlanInput?.nodes).toEqual([expect.objectContaining({ key: "analyst", dependsOn: ["scout"] })])
      const analystPlanResult = record(rootToolItem(DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID, "tool_result")?.content)
      const analystPlanReceipt = record(analystPlanResult?.output)
      expect(analystPlanReceipt).toMatchObject({ status: "accepted", revision: checkpointGraphRevision + 1 })
      const analystWaitCall = record(rootToolItem(DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID, "tool_call")?.content)
      expect(record(analystWaitCall?.input)?.taskIds).toEqual([analyst!.id])
      expect(record(record(rootToolItem(DISCOVERY_RESTART_WAIT_CALL_ID, "tool_result")?.content)?.output)).toMatchObject({
        status: "waiting", waitId: checkpointWait.id, taskIds: [source.rows[0]!.id], matchedTaskIds: [],
      })
      expect(record(record(rootToolItem(DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID, "tool_result")?.content)?.output)).toMatchObject({
        status: "waiting", waitId: analystWait!.id, taskIds: [analyst!.id], matchedTaskIds: [],
      })
      const terminalEvents = await pool!.query<{ type: string; count: number }>(
        `SELECT "type", COUNT(*)::int AS "count" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" IN ('turn.completed', 'turn.failed') GROUP BY "type"`,
        [value.sessionId, value.turnId],
      )
      expect(terminalEvents.rows).toEqual([{ type: "turn.completed", count: 1 }])
      const childCompletionEvents = await pool!.query<{ taskId: string; count: number }>(
        `SELECT "taskId", COUNT(*)::int AS "count" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[])
           AND "payload"->>'kind' = 'lifecycle' AND "payload"->'event'->>'type' = 'task.completed'
         GROUP BY "taskId" ORDER BY "taskId"`,
        [value.sessionId, value.turnId, children.rows.map(child => child.id)],
      )
      expect(childCompletionEvents.rows).toEqual(children.rows.map(child => ({ taskId: child.id, count: 1 })).sort((a, b) => a.taskId.localeCompare(b.taskId)))

      const queueOwnerPids = [workerOne.pid, workerTwo.pid, workerThree.pid]
        .filter((pid): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0)
      if (queueOwnerPids.length !== 3) throw new Error("Restart fixture process identity unavailable for queue convergence")
      const expectedQueueOwners = new Set(queueOwnerPids.flatMap(pid => [
        "p3-process-restart-discovery-worker-" + pid,
        "p3-process-restart-discovery-wait-resolver-" + pid,
      ]))
      const queueProducerByOwner = new Map<string, string>()
      queueOwnerPids.forEach((pid, index) => {
        const workerNumber = index + 1
        queueProducerByOwner.set("p3-process-restart-discovery-worker-" + pid, `worker${workerNumber}_dispatcher`)
        queueProducerByOwner.set("p3-process-restart-discovery-wait-resolver-" + pid, `worker${workerNumber}_wait_resolver`)
      })
      const turnQueue = new Queue(TURN_QUEUE_NAME, { connection: redis!, skipVersionCheck: true })
      try {
        await turnQueue.waitUntilReady()
        const states = ["active", "waiting", "delayed", "paused", "waiting-children", "prioritized", "failed", "completed"] as const
        const liveStates = new Set<string>(["active", "waiting", "delayed", "paused", "waiting-children", "prioritized"])
        const convergenceDeadline = Math.min(Date.now() + 150_000, restartCaseStartedAt + 230_000)
        const queueTimeoutDiagnostics = async () => {
          try {
            const jobs = await turnQueue.getJobs([...states], 0, -1, false)
            const rows: RecordValue[] = []
            let matchingCount = 0
            for (const job of jobs) {
              const payload = record(job.data)
              if (payload?.turnId !== value.turnId || payload.sessionId !== value.sessionId
                || typeof payload.ownerId !== "string" || !expectedQueueOwners.has(payload.ownerId)) continue
              matchingCount += 1
              if (rows.length >= 3) continue
              const state = diagnosticEnum(await job.getState(), new Set(states)) ?? "other"
              const suffix = typeof job.id === "string" ? /-(0|[1-9][0-9]*)$/.exec(job.id)?.[1] : undefined
              const parsedGeneration = suffix === undefined ? null : Number(suffix)
              const generation = parsedGeneration !== null && Number.isSafeInteger(parsedGeneration)
                && parsedGeneration >= 0 && parsedGeneration <= 100_000 ? parsedGeneration : null
              let lockPttlMs: number | null = null
              if (typeof job.id === "string") {
                try {
                  const pttl = await redis!.pttl(turnQueue.toKey(job.id) + ":lock")
                  if (pttl === -2 || pttl === -1 || Number.isSafeInteger(pttl) && pttl >= 0 && pttl <= 30_000) lockPttlMs = pttl
                } catch {
                  // Keep the state row if Redis cannot provide a bounded lock TTL.
                }
              }
              rows.push({
                state,
                generation,
                dispatchProducer: queueProducerByOwner.get(payload.ownerId) ?? "other",
                lockPttlMs,
              })
            }
            return { matchingCount: Math.min(matchingCount, 100), matchingCountTruncated: matchingCount > 100,
              rows, rowsTruncated: matchingCount > rows.length }
          } catch {
            return { unavailable: true }
          }
        }
        const captureStalledMidpointSnapshot = async (): Promise<RecordValue> => {
          const observedAt = new Date().toISOString()
          try {
            const generationTwoJobId = turnDispatch.turnJobId(value.turnId, 2)
            const stalledKey = turnQueue.toKey("stalled")
            const stalledCheckKey = turnQueue.toKey("stalled-check")
            const [candidateSetSize, generationTwoCandidate, stalledCheckExists, stalledCheckPttl, jobs,
              generationTwoJob, generationTwoLockPttl] = await Promise.all([
              redis!.scard(stalledKey),
              redis!.sismember(stalledKey, generationTwoJobId),
              redis!.exists(stalledCheckKey),
              redis!.pttl(stalledCheckKey),
              turnQueue.getJobs([...states], 0, -1, false),
              turnQueue.getJob(generationTwoJobId),
              redis!.pttl(turnQueue.toKey(generationTwoJobId) + ":lock"),
            ])
            const stateCounts = new Map<string, number>()
            let matchingCount = 0
            for (const job of jobs) {
              const payload = record(job.data)
              if (payload?.turnId !== value.turnId || payload.sessionId !== value.sessionId
                || typeof payload.ownerId !== "string" || !expectedQueueOwners.has(payload.ownerId)) continue
              matchingCount += 1
              const state = diagnosticEnum(await job.getState(), new Set<string>(states)) ?? "other"
              stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1)
            }
            const generationTwoState = generationTwoJob
              ? diagnosticEnum(await generationTwoJob.getState(), new Set<string>(states)) ?? "other"
              : "missing"
            const boundedPttl = (pttl: number) => pttl === -2 || pttl === -1
              || Number.isSafeInteger(pttl) && pttl >= 0 && pttl <= 300_000 ? pttl : null
            return {
              checkpoint: "after_generation2_lock_expiry_and_stalled_interval",
              observedAt,
              matchingCount: Math.min(matchingCount, 100),
              matchingCountTruncated: matchingCount > 100,
              matchingStateCounts: [...stateCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
              generationTwoState,
              generationTwoLockPttlMs: boundedPttl(generationTwoLockPttl),
              stalledCandidateSetSize: Number.isSafeInteger(candidateSetSize) && candidateSetSize >= 0
                ? Math.min(candidateSetSize, 10_000) : null,
              stalledCandidateSetTruncated: Number.isSafeInteger(candidateSetSize) && candidateSetSize > 10_000,
              generationTwoInStalledCandidateSet: generationTwoCandidate === 1,
              stalledCheckKeyPresent: stalledCheckExists === 1,
              stalledCheckKeyPttlMs: boundedPttl(stalledCheckPttl),
            }
          } catch {
            return { checkpoint: "after_generation2_lock_expiry_and_stalled_interval", observedAt, unavailable: true }
          }
        }
        while (true) {
          const matchingStateCounts = new Map<string, number>()
          let liveDeliveryCount = 0
          const jobs = await turnQueue.getJobs([...states], 0, -1, false)
          for (const job of jobs) {
            const payload = record(job.data)
            if (payload?.turnId !== value.turnId) continue
            if (payload.sessionId !== value.sessionId || typeof payload.ownerId !== "string"
              || !expectedQueueOwners.has(payload.ownerId)) {
              throw new Error("Turn queue delivery does not match the fixture session and dispatcher owners")
            }
            const state = await job.getState()
            matchingStateCounts.set(state, (matchingStateCounts.get(state) ?? 0) + 1)
            if (state === "failed") throw new Error("Turn queue contains a failed delivery for the completed fixture Turn")
            if (liveStates.has(state)) liveDeliveryCount += 1
          }
          if (liveDeliveryCount > 0 && stalledMidpointSnapshot === null && stalledMidpointDueAt !== null
            && Date.now() >= stalledMidpointDueAt) {
            stalledMidpointSnapshot = await captureStalledMidpointSnapshot()
          }
          if (liveDeliveryCount === 0) break
          if (Date.now() >= convergenceDeadline) {
            const [queueRows, turnWorkerEvents] = await Promise.all([
              queueTimeoutDiagnostics(),
              Promise.resolve(processDiscoveryTurnWorkerDiagnostics(workerTwo, workerThree)),
            ])
            throw new Error("Turn queue did not converge before the lock and stalled-job deadline: " + JSON.stringify({
              liveDeliveryCount,
              matchingStateCounts: [...matchingStateCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
              queueRows,
              turnWorkerEvents,
              queueRecovery: queueRecoveryFailureDiagnostics(),
            }))
          }
          await new Promise(resolve => setTimeout(resolve, 1_000))
        }
      } finally {
        await turnQueue.close().catch(() => undefined)
      }

      const convergedTerminalEvents = await pool!.query<{ type: string; count: number }>(
        `SELECT "type", COUNT(*)::int AS "count" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" IN ('turn.completed', 'turn.failed') GROUP BY "type"`,
        [value.sessionId, value.turnId],
      )
      expect(convergedTerminalEvents.rows).toEqual([{ type: "turn.completed", count: 1 }])
      const convergedRootToolItems = await pool!.query<{ type: string; toolCallId: string; count: number }>(
        `SELECT "type", "content"->>'toolCallId' AS "toolCallId", COUNT(*)::int AS "count"
         FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
           AND "type" IN ('tool_call', 'tool_result')
         GROUP BY "type", "content"->>'toolCallId' ORDER BY "toolCallId", "type"`,
        [value.sessionId, value.turnId, rootTaskId],
      )
      expect(convergedRootToolItems.rows).toHaveLength(8)
      expect(convergedRootToolItems.rows.every(item => item.count === 1)).toBe(true)
      const expectedConvergedRootItems = [
        DISCOVERY_RESTART_WAIT_CALL_ID, DISCOVERY_RESTART_ANALYST_PLAN_CALL_ID,
        DISCOVERY_RESTART_ANALYST_WAIT_CALL_ID, "p3-process-restart-discovery-plan",
      ].flatMap(toolCallId => ["tool_call", "tool_result"].map(type => ({ toolCallId, type })))
        .sort((left, right) => left.toolCallId.localeCompare(right.toolCallId) || left.type.localeCompare(right.type))
      expect(convergedRootToolItems.rows.map(({ toolCallId, type }) => ({ toolCallId, type }))).toEqual(expectedConvergedRootItems)
      const convergedChildren = await pool!.query<{ id: string; role: string; status: string }>(
        `SELECT "id", "role", "status" FROM "sub_agent_tasks"
         WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 ORDER BY "role", "id"`,
        [value.turnId, value.sessionId, rootTaskId],
      )
      expect(convergedChildren.rows).toEqual([
        { id: analyst!.id, role: "analyst", status: "completed" },
        { id: source.rows[0]!.id, role: "scout", status: "completed" },
      ])
      const convergedDispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null }>(
        `SELECT "idempotencyKey", "publishedAt" FROM "agent_outbox"
         WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = ANY($2::text[])
         ORDER BY "idempotencyKey"`,
        [value.sessionId, convergedChildren.rows.map(child => "subagent-dispatch:" + child.id)],
      )
      expect(convergedDispatches.rows).toHaveLength(2)
      expect(convergedDispatches.rows.every(dispatch => dispatch.publishedAt instanceof Date)).toBe(true)

      const convergedSearchPairs = await pool!.query<{ taskId: string; callCount: number; resultCount: number }>(
        `SELECT call."taskId", COUNT(DISTINCT call."id")::int AS "callCount",
                COUNT(DISTINCT result."id")::int AS "resultCount"
         FROM "agent_items" AS call
         LEFT JOIN "agent_items" AS result
           ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
          AND result."taskId" = call."taskId" AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
          AND result."type" = 'tool_result'
         WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = ANY($3::text[])
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'jobs.search'
         GROUP BY call."taskId" ORDER BY call."taskId"`,
        [value.sessionId, value.turnId, convergedChildren.rows.map(child => child.id)],
      )
      expect(convergedSearchPairs.rows.map(row => row.taskId)).toEqual(convergedChildren.rows.map(child => child.id).sort())
      expect(convergedSearchPairs.rows.every(row => row.callCount === 1 && row.resultCount === 1)).toBe(true)
      const convergedChildCompletions = await pool!.query<{ taskId: string; count: number }>(
        `SELECT "taskId", COUNT(*)::int AS "count" FROM "agent_events"
         WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[])
           AND "payload"->>'kind' = 'lifecycle' AND "payload"->'event'->>'type' = 'task.completed'
         GROUP BY "taskId" ORDER BY "taskId"`,
        [value.sessionId, value.turnId, convergedChildren.rows.map(child => child.id)],
      )
      expect(convergedChildCompletions.rows).toEqual(
        convergedChildren.rows.map(child => ({ taskId: child.id, count: 1 })).sort((a, b) => a.taskId.localeCompare(b.taskId)),
      )
      expect(workerTwo.output.filter(line => line.startsWith("P3_DISCOVERY_CHILD_SETTLED " + source.rows[0]!.id + " scout completed"))).toHaveLength(1)
      expect(workerThree.output.filter(line => line.startsWith("P3_DISCOVERY_CHILD_STARTED " + source.rows[0]!.id + " scout"))).toHaveLength(0)
      expect(workerThree.output.filter(line => line.startsWith("P3_DISCOVERY_CHILD_STARTED " + analyst!.id + " analyst"))).toHaveLength(1)
      expect(workerThree.output.filter(line => line.startsWith("P3_DISCOVERY_CHILD_SETTLED " + analyst!.id + " analyst completed"))).toHaveLength(1)
      expect(workerThree.output.filter(line => line.startsWith("P3_DISCOVERY_RESTORED_FINAL_GRAPH "))).toHaveLength(1)

      if (interactiveDiscoveryTraceArtifactPath) {
        const graphRows = await pool!.query<TaskGraphItemRow>(
          `SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "revision", "content", "startedAt", "completedAt", "createdAt", "updatedAt"
           FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "type" = 'task_graph'`,
          [value.sessionId, value.turnId, root.rows[0]!.id],
        )
        expect(graphRows.rows).toHaveLength(1)
        const graph = graphRows.rows[0]!
        const ledgerTasks = await pool!.query<{
          id: string; sessionId: string; turnId: string | null; rootTaskId: string | null; parentTaskId: string | null
          path: string; role: string; taskType: string; status: string; goal: string; confidence: number | null
          failureReason: string | null; result: RecordValue | null; createdAt: Date; updatedAt: Date
        }>(
          `SELECT "id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "role", "taskType", "status", "goal", "confidence", "failureReason", "result", "createdAt", "updatedAt"
           FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "turnId" = $2 AND ("id" = $3 OR "parentTaskId" = $3)
           ORDER BY "createdAt" ASC, "id" ASC`,
          [value.sessionId, value.turnId, root.rows[0]!.id],
        )
        const safeTasks = ledgerTasks.rows.map(row => {
          const evidencePreview = projectTaskEvidencePreview(row)
          return {
            id: row.id, sessionId: row.sessionId, turnId: row.turnId, rootTaskId: row.rootTaskId,
            parentTaskId: row.parentTaskId, path: row.path, role: row.role, taskType: row.taskType,
            status: row.status, goal: row.goal, confidence: row.confidence, failureReason: row.failureReason,
            hasResult: row.result !== null,
            ...(evidencePreview ? { structuredEvidencePreview: evidencePreview } : {}),
          }
        })
        const planLedger = projectPlanLedger({
          sessionId: value.sessionId, revision: graph.revision, rootTaskId: root.rows[0]!.id,
          graph: graph.content, tasks: safeTasks,
        })
        if (!planLedger) throw new Error("Interactive discovery restart did not project its persisted Plan Ledger")
        const shortlistValue = record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist
        const shortlist = record(shortlistValue)
        const rawItems = Array.isArray(shortlist?.items) ? shortlist.items.map(record) : []
        const safeShortlist = {
          schemaVersion: 1,
          status: shortlist?.status === "completed" || shortlist?.status === "partial" || shortlist?.status === "failed" ? shortlist.status : "failed",
          items: rawItems.flatMap(item => {
            if (typeof item?.jobId !== "string" || typeof item.score !== "number" || !Number.isFinite(item.score)) return []
            const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.filter((id): id is string => typeof id === "string") : []
            return [{ jobId: item.jobId, score: item.score, evidenceIds }]
          }).slice(0, 3),
          failures: Array.isArray(shortlist?.failures) ? shortlist.failures.filter((failure): failure is string => typeof failure === "string").slice(0, 12) : [],
        }
        const finalResponse = JSON.parse(turn.rows[0]?.finalResponse ?? "null") as RecordValue | null
        const finalCandidateText = typeof finalResponse?.response === "string" ? finalResponse.response : ""
        if (turn.rows[0]?.status !== "completed" || finalCandidateText !== JSON.stringify({
          schemaVersion: "agent-harness.v2.final", response: "p3-process-restart-discovery-shortlist-ready",
        })) {
          throw new Error("Interactive discovery trace final outcome does not preserve its verified model candidate")
        }
        await writeFile(interactiveDiscoveryTraceArtifactPath, JSON.stringify({
          schemaVersion: "agent-harness.v2.interactive-discovery-trace",
          sessionId: value.sessionId,
          turnId: value.turnId,
          rootTaskId: root.rows[0]!.id,
          graphItemId: graph.id,
          graphRevision: graph.revision,
          graph: graph.content,
          tasks: safeTasks,
          planLedger,
          interactiveDiscoveryShortlist: safeShortlist,
          finalOutcome: { turnStatus: turn.rows[0].status, response: finalCandidateText },
        }), "utf8")
      }
    } finally {
      if (queueEvents) await queueEvents.close().catch(() => undefined)
      if (checkpointQueue) await checkpointQueue.close().catch(() => undefined)
      if (workerOne && !processFixtureExited(workerOne)) await killProcessFixture(workerOne)
      if (workerTwo && !processFixtureExited(workerTwo)) await killProcessFixture(workerTwo)
      if (workerThree) await stopProcessFixture(workerThree)
    }
  }, 240_000)

  it("replans a canonical discovery Turn from durable child evidence and persists the owner-scoped shortlist", async () => {
    const [workerQueue, canonical, commandPortModule, subagentQueue] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("../../queue/subagent-queue.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME } = await import("../turns/turn-queue.js")
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    await activateFixtureTurn(pool!, discoveryOwner)

    const jobId = fixtureJobId(discoveryOwner.suffix)
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      discoveryOwner.turnId,
      JSON.stringify({ goal: "Find a strong software engineering role in Dublin", intent: { kind: "interactive_discovery_shortlist", version: 1 } }),
      discoveryOwner.sessionId, discoveryOwner.userId,
    ])
    await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, 'Fixture Labs', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/discovery', 'Build reliable services', 'greenhouse', CURRENT_TIMESTAMP)`, [
      jobId, discoveryOwner.userId,
    ])

    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    let rootExecution = 0
    let discoveryRootModelFailure: string | null = null
    let discoveryScoutGraphRevision = -1
    let discoveryRootStage: "not_started" | "initial_plan" | "scout_wait" | "replan" | "analyst_plan_receipt" | "analyst_wait" | "final" = "not_started"
    let discoveryChildStage: "not_started" | "search_visibility" | "search_call_emitted" | "parent_wait" | "result_emitted" = "not_started"
    let discoveryJobsSearchAppeared = false
    let discoveryJobsSearchCallEmitted = false
    let discoveryAnalystScheduleFailure: ReturnType<typeof discoveryScheduleFailureDiagnostic> | null = null
    const discoveryChildOutcomeProjections: RecordValue[] = []
    const discoveryScoutResultProjections: RecordValue[] = []
    const discoveryCommandPort = commandPortModule.createPgTaskGraphCommandPort(pool!)
    const diagnosticDiscoveryCommandPort = {
      ...discoveryCommandPort,
      appendAndSchedule: async (input: Parameters<typeof discoveryCommandPort.appendAndSchedule>[0]) => {
        try {
          return await discoveryCommandPort.appendAndSchedule(input)
        } catch (error: unknown) {
          if (discoveryRootStage === "replan") discoveryAnalystScheduleFailure = discoveryScheduleFailureDiagnostic(error)
          throw error
        }
      },
    }
    const rootRuntime = await canonical.createCanonicalTurnRuntime(pool!, {
      workerId: discoveryOwner.ownerId, productionFlags: flags,
      taskGraphCommandPort: diagnosticDiscoveryCommandPort,
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecution
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-interactive-discovery-root-fixture", profile,
          async *stream(request) {
            round += 1
            if (execution === 1 && round === 1) {
              discoveryRootStage = "initial_plan"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("agent.plan")
              yield { type: "tool_call_completed", callId: "p3-discovery-plan-scout", name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [{ key: "scout", templateId: "scout", goal: "Find matching fixture roles", successCriteria: ["Read one owner job"], dependsOn: [], verification: SCOUT_VERIFICATION }],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              discoveryRootStage = "scout_wait"
              const taskIds = planTaskIds(request, "p3-discovery-plan-scout", 1)
              yield { type: "tool_call_completed", callId: "p3-discovery-wait-scout", name: "agent.wait", arguments: {
                idempotencyKey: `p3-discovery-wait-scout:${discoveryOwner.turnId}`, taskIds, mode: "all", timeoutMs: 20_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 1) {
              discoveryRootStage = "replan"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => node?.key)).toEqual(["scout"])
              expect(nodes[0]?.status).toBe("completed")
              expectPassedVerificationReport(nodes[0]?.verificationReport, "candidate-count")
              const revision = graph?.revision
              if (typeof revision !== "number") throw new Error("Discovery replan did not receive the durable graph revision")
              discoveryScoutGraphRevision = revision
              yield { type: "tool_call_completed", callId: "p3-discovery-plan-analyst", name: "agent.plan", arguments: {
                expectedRevision: revision,
                nodes: [{ key: "analyst", templateId: "analyst", goal: "Score the discovered role", successCriteria: ["Return an evidence-bound score"], dependsOn: ["scout"], verification: DISCOVERY_ANALYST_VERIFICATION }],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 2) {
              discoveryRootStage = "analyst_plan_receipt"
              const taskIds = planTaskIds(request, "p3-discovery-plan-analyst", 1)
              discoveryRootStage = "analyst_wait"
              yield { type: "tool_call_completed", callId: "p3-discovery-wait-analyst", name: "agent.wait", arguments: {
                idempotencyKey: `p3-discovery-wait-analyst:${discoveryOwner.turnId}`, taskIds, mode: "all", timeoutMs: 20_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 3 && round === 1) {
              discoveryRootStage = "final"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              expect(nodes.map(node => node?.key)).toEqual(["scout", "analyst"])
              expect(nodes.map(node => node?.status)).toEqual(["completed", "completed"])
              expectPassedVerificationReport(nodes[0]?.verificationReport, "candidate-count")
              expectPassedVerificationReport(nodes[1]?.verificationReport, "finding-count", "findings-from-scout")
              expect(typeof graph?.revision).toBe("number")
              expect(graph?.revision).toBeGreaterThan(discoveryScoutGraphRevision)
              const publicReportKeys = ["criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion"]
              const publicGraphReport = record(nodes[1]?.verificationReport)
              expect(Object.keys(publicGraphReport ?? {}).sort()).toEqual(publicReportKeys)
              expect(JSON.stringify(publicGraphReport)).not.toContain("dependencyBindings")
              const wait = waitOutcomeFromRequest(request, 1, "analyst")
              expect(wait.status).toBe("ready")
              const waitedAnalyst = record(wait.tasks[0])
              const publicWaitReport = record(waitedAnalyst?.verificationReport)
              expect(waitedAnalyst?.role).toBe("analyst")
              expectPassedVerificationReport(publicWaitReport, "finding-count", "findings-from-scout")
              expect(Object.keys(publicWaitReport ?? {}).sort()).toEqual(publicReportKeys)
              expect(JSON.stringify(publicWaitReport)).not.toContain("dependencyBindings")

              const ownerRows = await pool!.query<{
                rootTaskId: string; turnLeaseOwner: string; turnLeaseVersion: number
                turnLeaseStartedAt: Date; turnLeaseExpiresAt: Date; stepId: string
                parentLeaseOwner: string; parentAttemptCount: number
              }>(`SELECT turn."rootTaskId", turn."leaseOwnerId" AS "turnLeaseOwner", turn."leaseVersion" AS "turnLeaseVersion",
                    turn."leaseStartedAt" AS "turnLeaseStartedAt", turn."leaseExpiresAt" AS "turnLeaseExpiresAt",
                    (SELECT step."id" FROM "agent_steps" AS step WHERE step."sessionId" = turn."sessionId"
                      AND step."turnId" = turn."id" AND step."taskId" = root."id" AND step."status" = 'streaming'
                      ORDER BY step."ordinal" DESC LIMIT 1) AS "stepId",
                    root."leaseOwner" AS "parentLeaseOwner", root."attemptCount" AS "parentAttemptCount"
                 FROM "agent_turns" AS turn JOIN "sub_agent_tasks" AS root
                   ON root."id" = turn."rootTaskId" AND root."sessionId" = turn."sessionId"
                 WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND root."status" = 'running'`,
              [discoveryOwner.turnId, discoveryOwner.sessionId, discoveryOwner.userId])
              const currentOwner = ownerRows.rows[0]
              if (!currentOwner?.stepId) throw new Error("Discovery root lease or streaming step was unavailable for current graph readback")
              const terminalGateLease: TurnLease = {
                turnId: discoveryOwner.turnId, sessionId: discoveryOwner.sessionId, ownerId: currentOwner.turnLeaseOwner,
                userId: discoveryOwner.userId, leaseVersion: currentOwner.turnLeaseVersion,
                leaseStartedAt: currentOwner.turnLeaseStartedAt, leaseExpiresAt: currentOwner.turnLeaseExpiresAt,
              }
              const readScope = {
                userId: discoveryOwner.userId, sessionId: discoveryOwner.sessionId, turnId: discoveryOwner.turnId,
                rootTaskId: currentOwner.rootTaskId, parentTaskId: currentOwner.rootTaskId,
                turnLeaseOwner: currentOwner.turnLeaseOwner, turnLeaseVersion: currentOwner.turnLeaseVersion,
                parentLeaseOwner: currentOwner.parentLeaseOwner, parentAttemptCount: currentOwner.parentAttemptCount,
              }
              const nativeVerificationScope = { ...readScope, stepId: currentOwner.stepId }
              const nativeVerificationPort = createPgNativeVerificationPort(pool!)
              const currentGraphState = await discoveryCommandPort.readCurrent(readScope)
              expect(currentGraphState.revision).toBeGreaterThan(discoveryScoutGraphRevision)
              const currentScout = currentGraphState.nodes.find(node => node.key === "scout")
              const currentAnalyst = currentGraphState.nodes.find(node => node.key === "analyst")
              expectPassedVerificationReport(currentScout?.verificationReport, "candidate-count")
              expectPassedVerificationReport(currentAnalyst?.verificationReport, "finding-count", "findings-from-scout")
              await expect(checkTerminalTaskGraph(pool!, terminalGateLease, currentOwner.rootTaskId))
                .resolves.toMatchObject({ ok: true })
              const nativeCandidateText = "The verified shortlist remains current."
              const acceptedNativeRoot = await nativeVerificationPort.ensureRootGoal({
                scope: nativeVerificationScope, candidateText: nativeCandidateText,
              })
              expect(["pending", "passed"]).toContain(acceptedNativeRoot.status)
              expect(acceptedNativeRoot.controlTaskIds).toHaveLength(1)
              const acceptedNativeRootControlId = acceptedNativeRoot.controlTaskIds[0]
              expect(acceptedNativeRootControlId).toBeTruthy()
              if (acceptedNativeRoot.status === "pending") {
                expect(acceptedNativeRoot.pendingControlTaskIds).toContain(acceptedNativeRootControlId)
                expect(acceptedNativeRoot.pendingTaskIds).toContain(acceptedNativeRootControlId)
              } else {
                expect(acceptedNativeRoot.rootGoalWitness?.controlTaskId).toBe(acceptedNativeRootControlId)
                expect(acceptedNativeRoot.rootGoalWitness?.candidateDigest).toMatch(/^[a-f0-9]{64}$/)
              }
              const nativeRootControl = await pool!.query<{
                role: string; taskType: string; rootTaskId: string; parentTaskId: string; status: string; expectedOutputSchema: unknown
              }>(`SELECT "role", "taskType", "rootTaskId", "parentTaskId", "status", "expectedOutputSchema"
                  FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
              [acceptedNativeRootControlId, discoveryOwner.sessionId, discoveryOwner.turnId])
              expect(nativeRootControl.rows).toHaveLength(1)
              expect(nativeRootControl.rows[0]).toMatchObject({
                role: "auditor", taskType: "native_verification", rootTaskId: currentOwner.rootTaskId,
                parentTaskId: currentOwner.rootTaskId,
              })
              expect(parseNativeVerificationControl(nativeRootControl.rows[0]?.expectedOutputSchema)?.target.kind).toBe("root_goal")
              const recoveredNativeRoot = await nativeVerificationPort.readRecoverableGoal(readScope)
              expect(recoveredNativeRoot).toMatchObject({ controlTaskId: acceptedNativeRootControlId, candidateText: nativeCandidateText })
              expect(["pending", "passed"]).toContain(recoveredNativeRoot?.status)
              if (recoveredNativeRoot?.status === "passed") {
                expect(recoveredNativeRoot.witness?.controlTaskId).toBe(acceptedNativeRootControlId)
              }
              const nativeControlDeadline = Date.now() + 30_000
              let completedNativeRootControl: { status: string; attemptCount: number; failureReason: string | null } | undefined
              while (Date.now() < nativeControlDeadline) {
                const controlState = await pool!.query<{
                  status: string; attemptCount: number; failureReason: string | null
                }>(`SELECT "status", "attemptCount", "failureReason" FROM "sub_agent_tasks"
                    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
                [acceptedNativeRootControlId, discoveryOwner.sessionId, discoveryOwner.turnId])
                const currentControl = controlState.rows[0]
                if (currentControl?.status === "completed") {
                  completedNativeRootControl = currentControl
                  break
                }
                if (currentControl && ["failed", "interrupted", "cancelled", "closed"].includes(currentControl.status)) {
                  throw new Error(`Discovery native root control terminated as ${currentControl.status}`)
                }
                await new Promise(resolve => setTimeout(resolve, 25))
              }
              expect(completedNativeRootControl).toMatchObject({ status: "completed", failureReason: null })
              expect(completedNativeRootControl?.attemptCount).toBeGreaterThan(0)
              const passedNativeRoot = await nativeVerificationPort.readRecoverableGoal(readScope)
              expect(passedNativeRoot).toMatchObject({ controlTaskId: acceptedNativeRootControlId,
                candidateText: nativeCandidateText, status: "passed" })
              expect(passedNativeRoot?.status === "passed" ? passedNativeRoot.witness?.controlTaskId : undefined)
                .toBe(acceptedNativeRootControlId)

              const childRows = await pool!.query<{ id: string; role: string; result: unknown }>(
                `SELECT "id", "role", "result" FROM "sub_agent_tasks"
                 WHERE "sessionId" = $1 AND "turnId" = $2 AND "rootTaskId" = $3 AND "parentTaskId" = $3
                   AND "role" = ANY($4::text[])`,
                [discoveryOwner.sessionId, discoveryOwner.turnId, currentOwner.rootTaskId, ["analyst", "scout"]],
              )
              const scoutTask = childRows.rows.find(task => task.role === "scout")
              const analystTask = childRows.rows.find(task => task.role === "analyst")
              const scoutResult = record(scoutTask?.result)
              const scoutStructured = record(scoutResult?.structuredResult)
              const sourceCandidates = Array.isArray(scoutStructured?.candidates)
                ? scoutStructured.candidates.map(record).filter((candidate): candidate is RecordValue => candidate !== null) : []
              const analystResult = record(analystTask?.result)
              const storedReport = record(analystResult?.taskGraphVerificationReport)
              if (!scoutTask || !analystTask || !scoutResult || !scoutStructured || !sourceCandidates.length || !analystResult || !storedReport) {
                throw new Error("Discovery source or Analyst verification result was missing")
              }
              expect(Object.keys(storedReport).sort()).toEqual([
                "criteria", "dependencyBindings", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion",
              ])
              const parsedStoredReport = parseStoredTaskGraphVerificationReport(
                storedReport, ["finding-count", "findings-from-scout"], ["scout"],
              )
              expect(parsedStoredReport?.status).toBe("passed")
              const bindings = Array.isArray(parsedStoredReport?.dependencyBindings)
                ? parsedStoredReport.dependencyBindings.map(record) : []
              expect(bindings).toHaveLength(1)
              const sourceBinding = bindings[0]
              if (!sourceBinding) throw new Error("Discovery Analyst private dependency binding was invalid")
              expect(Object.keys(sourceBinding ?? {}).sort()).toEqual([
                "attemptCount", "evidenceDigest", "nodeDigest", "nodeKey", "reportDigest", "resultDigest", "taskId",
              ])
              expect(sourceBinding).toMatchObject({ nodeKey: "scout", taskId: scoutTask.id, attemptCount: 1 })
              for (const key of ["nodeDigest", "resultDigest", "evidenceDigest", "reportDigest"] as const) {
                expect(sourceBinding?.[key]).toMatch(/^[a-f0-9]{64}$/)
              }
              expect(JSON.stringify(sourceBinding)).not.toContain(jobId)

              const expectReadbackRejectsMutation = async (taskId: string, original: RecordValue, changed: RecordValue) => {
                const update = async (value: RecordValue) => pool!.query(
                  `UPDATE "sub_agent_tasks" SET "result" = $1::jsonb WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4`,
                  [JSON.stringify(value), taskId, discoveryOwner.sessionId, discoveryOwner.turnId],
                )
                expect((await update(changed)).rowCount).toBe(1)
                try {
                  await expect(discoveryCommandPort.readCurrent(readScope)).rejects.toThrow("task_graph_verification_report_invalid")
                  await expect(checkTerminalTaskGraph(pool!, terminalGateLease, currentOwner.rootTaskId))
                    .resolves.toMatchObject({ ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER })
                  await expect(nativeVerificationPort.ensureRootGoal({
                    scope: nativeVerificationScope, candidateText: "The verified shortlist remains current.",
                  })).resolves.toMatchObject({ status: "unavailable" })
                  await expect(nativeVerificationPort.readRecoverableGoal(readScope)).resolves.toBeNull()
                } finally {
                  expect((await update(original)).rowCount).toBe(1)
                }
              }
              const changedCandidates = sourceCandidates.map(candidate => ({ ...candidate, jobId: `${jobId}-changed` }))
              await expectReadbackRejectsMutation(scoutTask.id, scoutResult, {
                ...scoutResult, structuredResult: { ...scoutStructured, candidates: changedCandidates },
              })
              const missingBindingReport = { ...storedReport }
              delete missingBindingReport.dependencyBindings
              await expectReadbackRejectsMutation(analystTask.id, analystResult, {
                ...analystResult, taskGraphVerificationReport: missingBindingReport,
              })
              await expectReadbackRejectsMutation(analystTask.id, analystResult, {
                ...analystResult, taskGraphVerificationReport: {
                  ...storedReport, dependencyBindings: [{ ...sourceBinding, taskId: `replaced-${scoutTask.id}` }],
                },
              })
              const scoutReport = record(scoutResult.taskGraphVerificationReport)
              if (!scoutReport) throw new Error("Discovery Scout report was unavailable for the private report mutation")
              await expectReadbackRejectsMutation(scoutTask.id, scoutResult, {
                ...scoutResult, taskGraphVerificationReport: { ...scoutReport, resultDigest: "0".repeat(64) },
              })

              const graphSnapshotRows = await pool!.query<{ revision: number; content: unknown }>(
                `SELECT "revision", "content" FROM "agent_items"
                 WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'task_graph'`,
                [taskGraphItemId(currentOwner.rootTaskId), discoveryOwner.sessionId, discoveryOwner.turnId, currentOwner.rootTaskId],
              )
              const graphSnapshotRevision = graphSnapshotRows.rows[0]?.revision
              const graphSnapshot = record(graphSnapshotRows.rows[0]?.content)
              const graphReceiptRows = await pool!.query<{ id: string; type: string; taskId: string | null; payload: unknown }>(
                `SELECT "id", "type", "taskId", "payload" FROM "agent_events"
                 WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3
                   AND "type" IN ('task_graph.lifecycle', 'item.started', 'item.delta')
                   AND "payload"->>'kind' IN ('proposal', 'lifecycle')
                   AND "payload"->>'revision' = $4::text`,
                [discoveryOwner.sessionId, discoveryOwner.turnId, taskGraphItemId(currentOwner.rootTaskId), graphSnapshotRevision],
              )
              const graphReceiptRow = graphReceiptRows.rows[0]
              const graphReceiptPayload = record(graphReceiptRow?.payload)
              const graphReceiptItem = record(graphReceiptPayload?.item)
              expect(graphSnapshotRows.rows, "Discovery TaskGraph snapshot row was missing").toHaveLength(1)
              expect(Number.isSafeInteger(graphSnapshotRevision), "Discovery TaskGraph snapshot revision was invalid").toBe(true)
              expect(graphReceiptRows.rows, "Discovery current-revision TaskGraph receipt was missing or ambiguous").toHaveLength(1)
              if (!graphSnapshot || !graphReceiptRow || !graphReceiptPayload || !graphReceiptItem) {
                throw new Error("Discovery current-revision TaskGraph receipt payload was invalid")
              }
              const graphNodes: unknown[] = Array.isArray(graphSnapshot.nodes) ? graphSnapshot.nodes : []
              const graphTaskIds = new Set(graphNodes.map(value => record(value)?.taskId)
                .filter((taskId): taskId is string => typeof taskId === "string"))
              expect(graphReceiptPayload.revision, "Discovery receipt revision did not match the graph snapshot").toBe(graphSnapshotRevision)
              expect(graphReceiptItem.revision, "Discovery receipt item revision did not match the graph snapshot").toBe(graphSnapshotRevision)
              expect(graphReceiptItem.content, "Discovery receipt item content did not match the graph snapshot").toEqual(graphSnapshot)
              if (graphReceiptPayload.kind === "proposal") {
                expect(["item.started", "item.delta"]).toContain(graphReceiptRow.type)
                expect(graphReceiptRow.taskId, "Discovery proposal receipt did not belong to the graph owner").toBe(currentOwner.rootTaskId)
                if (Object.hasOwn(graphReceiptPayload, "content")) {
                  expect(graphReceiptPayload.content, "Discovery proposal content did not match the graph snapshot").toEqual(graphSnapshot)
                }
                if (graphReceiptRow.type === "item.delta") expect(Object.hasOwn(graphReceiptPayload, "content")).toBe(true)
              } else if (graphReceiptPayload.kind === "lifecycle") {
                expect(["item.delta", "task_graph.lifecycle"]).toContain(graphReceiptRow.type)
                expect(typeof graphReceiptRow.taskId, "Discovery lifecycle receipt task was missing").toBe("string")
                expect(graphTaskIds, "Discovery lifecycle receipt task was outside the current graph").toContain(graphReceiptRow.taskId)
              } else {
                throw new Error("Discovery current-revision TaskGraph receipt kind was unsupported")
              }
              const scoutNode = graphNodes.map(record).find(node => node?.key === "scout")
              const scoutVerification = record(scoutNode?.verification)
              const scoutCriteria: RecordValue[] = Array.isArray(scoutVerification?.criteria)
                ? scoutVerification.criteria.map(record).filter((criterion): criterion is RecordValue => criterion !== null) : []
              const candidateCriterion = scoutCriteria.find(criterion => criterion.id === "candidate-count")
              const candidateCheck = record(candidateCriterion?.check)
              if (!scoutNode || !scoutVerification) {
                throw new Error("Discovery Scout verification contract was unavailable for the persisted mutation")
              }
              if (candidateCheck?.kind !== "candidate_count_gte" || candidateCheck.minimum !== 1) {
                throw new Error("Discovery Scout snapshot contract was unavailable for the persisted mutation")
              }
              const changedGraphSnapshot: RecordValue = {
                ...graphSnapshot,
                nodes: graphNodes.map(value => {
                  const node = record(value)
                  return node?.key === "scout" ? {
                    ...node,
                    verification: {
                      ...scoutVerification,
                      criteria: scoutCriteria.map(criterion => criterion.id === "candidate-count"
                        ? { ...criterion, check: { kind: "all_candidates_have_evidence", minimumItems: 1 } }
                        : criterion),
                    },
                  } : value
                }),
              }
              const changedGraphReceiptPayload: RecordValue = {
                ...graphReceiptPayload,
                ...(Object.hasOwn(graphReceiptPayload, "content") ? { content: changedGraphSnapshot } : {}),
                item: { ...graphReceiptItem, content: changedGraphSnapshot },
              }
              const updateGraphSnapshot = async (content: RecordValue) => pool!.query(
                `UPDATE "agent_items" SET "content" = $1::jsonb
                 WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "taskId" = $5 AND "type" = 'task_graph' AND "revision" = $6`,
                [JSON.stringify(content), taskGraphItemId(currentOwner.rootTaskId), discoveryOwner.sessionId, discoveryOwner.turnId, currentOwner.rootTaskId, graphSnapshotRevision],
              )
              const updateGraphReceipt = async (payload: RecordValue) => pool!.query(
                `UPDATE "agent_events" SET "payload" = $1::jsonb
                 WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "itemId" = $5 AND "taskId" = $6
                   AND "type" = $7 AND "payload"->>'kind' = $8 AND "payload"->>'revision' = $9::text`,
                [JSON.stringify(payload), graphReceiptRow.id, discoveryOwner.sessionId, discoveryOwner.turnId,
                  taskGraphItemId(currentOwner.rootTaskId), graphReceiptRow.taskId, graphReceiptRow.type,
                  graphReceiptPayload.kind, graphSnapshotRevision],
              )
              try {
                expect((await updateGraphReceipt(changedGraphReceiptPayload)).rowCount).toBe(1)
                expect((await updateGraphSnapshot(changedGraphSnapshot)).rowCount).toBe(1)
                await expect(discoveryCommandPort.readCurrent(readScope)).rejects.toThrow("task_graph_verification_report_invalid")
              } finally {
                try {
                  expect((await updateGraphReceipt(graphReceiptPayload)).rowCount).toBe(1)
                } finally {
                  expect((await updateGraphSnapshot(graphSnapshot)).rowCount).toBe(1)
                }
              }

              const sourceReceiptRows = await pool!.query<{ id: string; content: unknown }>(
                `SELECT result."id", result."content" FROM "agent_items" AS call
                 JOIN "agent_items" AS result ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
                   AND result."taskId" = call."taskId" AND result."type" = 'tool_result'
                   AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
                 WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = $3
                   AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'jobs.search'`,
                [discoveryOwner.sessionId, discoveryOwner.turnId, scoutTask.id],
              )
              const sourceReceipt = sourceReceiptRows.rows[0]
              const sourceReceiptContent = record(sourceReceipt?.content)
              const sourceReceiptOutput = record(sourceReceiptContent?.output)
              const sourceReceiptJobs = Array.isArray(sourceReceiptOutput?.jobs)
                ? sourceReceiptOutput.jobs.map(record).filter((job): job is RecordValue => job !== null) : []
              if (sourceReceiptRows.rows.length !== 1 || !sourceReceipt || !sourceReceiptContent || !sourceReceiptOutput || !sourceReceiptJobs.length) {
                throw new Error("Discovery Scout read receipt was unavailable for the persisted receipt mutation")
              }
              const receiptUpdate = async (content: RecordValue) => pool!.query(
                `UPDATE "agent_items" SET "content" = $1::jsonb WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4`,
                [JSON.stringify(content), sourceReceipt.id, discoveryOwner.sessionId, discoveryOwner.turnId],
              )
              const changedReceipt: RecordValue = {
                ...sourceReceiptContent,
                output: { ...sourceReceiptOutput, jobs: sourceReceiptJobs.map((job, index) => ({
                  ...job, ...(index === 0 ? { id: `${String(job.id)}-receipt-changed` } : {}),
                })) },
              }
              expect((await receiptUpdate(changedReceipt)).rowCount).toBe(1)
              try {
                await expect(discoveryCommandPort.readCurrent(readScope)).rejects.toThrow("task_graph_verification_report_invalid")
                await expect(checkTerminalTaskGraph(pool!, terminalGateLease, currentOwner.rootTaskId))
                  .resolves.toMatchObject({ ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER })
                await expect(nativeVerificationPort.ensureRootGoal({
                  scope: nativeVerificationScope, candidateText: "The verified shortlist remains current.",
                })).resolves.toMatchObject({ status: "unavailable" })
                await expect(nativeVerificationPort.readRecoverableGoal(readScope)).resolves.toBeNull()
              } finally {
                expect((await receiptUpdate(sourceReceiptContent)).rowCount).toBe(1)
              }
              const restoredGraphState = await discoveryCommandPort.readCurrent(readScope)
              expect(restoredGraphState.revision).toBeGreaterThan(discoveryScoutGraphRevision)
              expectPassedVerificationReport(restoredGraphState.nodes.find(node => node.key === "scout")?.verificationReport, "candidate-count")
              expectPassedVerificationReport(restoredGraphState.nodes.find(node => node.key === "analyst")?.verificationReport,
                "finding-count", "findings-from-scout")
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "Shortlist ready" }) }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected discovery root model turn ${execution}/${round}`)
          },
        }
        return {
          adapter: captureModelStreamFailure(adapter, error => {
            discoveryRootModelFailure = childFixtureErrorSummary(error)
          }),
          registry: {} as never,
          candidates: [],
        }
      },
    })
    const productionChildExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        if (task.role === "auditor" && task.taskType === "native_verification") {
          const control = parseNativeVerificationControl(task.expectedOutputSchema)
          const packet = control ? parseNativeVerificationPacket(task.context, control) : null
          if (!control || !packet) throw new Error("p3_discovery_native_control_unreadable")
          const report = {
            schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
            criteria: packet.criteria.map(item => ({
              criterionId: item.criterionId,
              disposition: "passed" as const,
              reasonCode: "meets_criterion" as const,
              evidenceReferenceIds: item.requirement.includes("self-attestation")
                ? packet.evidence.filter(evidence => evidence.kind === "user_self_attestation").map(evidence => evidence.referenceId)
                : [packet.target.referenceId, ...packet.evidence.filter(evidence => evidence.kind === "tool_result").map(evidence => evidence.referenceId)],
            })),
          }
          return {
            id: "p3-interactive-discovery-native-verifier-fixture", profile,
            async *stream() {
              yield { type: "text_delta", text: JSON.stringify(report) }
              yield { type: "completed", finishReason: "stop" }
            },
          } satisfies ModelAdapter
        }
        let round = 0
        const adapter: ModelAdapter = {
          id: `p3-interactive-discovery-${task.role}-fixture`, profile,
          async *stream(request) {
            round += 1
            if (round === 1) {
              discoveryChildStage = "search_visibility"
              discoveryJobsSearchAppeared = request.tools.some(tool => record(tool)?.name === "jobs.search")
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.search")
              discoveryChildStage = "search_call_emitted"
              discoveryJobsSearchCallEmitted = true
              yield { type: "tool_call_completed", callId: `p3-discovery-read-${task.role}`, name: "jobs.search", arguments: { target: "Software Engineer", location: "Dublin", limit: 10 } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const waitKey = task.role === "scout"
              ? `p3-discovery-wait-scout:${discoveryOwner.turnId}`
              : `p3-discovery-wait-analyst:${discoveryOwner.turnId}`
            discoveryChildStage = "parent_wait"
            await waitForPersistedTaskWait(pool!, discoveryOwner.turnId, waitKey)
            const evidence = { id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }
            const result = task.role === "scout"
              ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId, source: evidence.source, url: null, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Found the fixture role" }
              : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId, score: 8.5, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Strong match" }
            const resultText = JSON.stringify(result)
            if (task.role === "scout" && discoveryScoutResultProjections.length < 4) {
              discoveryScoutResultProjections.push(canonicalDiscoveryScoutResultDiagnostic(request, resultText, jobId))
            }
            discoveryChildStage = "result_emitted"
            yield { type: "text_delta", text: resultText }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    const childExecutor: typeof productionChildExecutor = async input => {
      const outcome = await productionChildExecutor(input)
      const result = record(outcome.result)
      const failureReasonCode = typeof outcome.failureReason !== "string"
        ? "none"
        : CHILD_OUTCOME_FAILURE_CODES.has(outcome.failureReason) ? outcome.failureReason : "other"
      if (discoveryChildOutcomeProjections.length < 4) discoveryChildOutcomeProjections.push({
        role: diagnosticEnum(input.lease.role, DISCOVERY_DIAGNOSTIC_ROLES) ?? "other",
        status: diagnosticEnum(outcome.status, CHILD_OUTCOME_STATUSES) ?? "other",
        retryDisposition: diagnosticEnum(outcome.retryDisposition, CHILD_OUTCOME_RETRY_DISPOSITIONS) ?? "none",
        failureReasonCode,
        resultPresent: outcome.result !== undefined && outcome.result !== null,
        finalTextString: typeof result?.finalText === "string",
        structuredResultPresent: result !== null && Object.hasOwn(result, "structuredResult"),
        finalItemIdString: typeof result?.finalItemId === "string",
      })
      return outcome
    }
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime: rootRuntime, ownerId: discoveryOwner.ownerId,
      turnQueueFactory: createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-discovery-wait-resolver-${discoveryOwner.suffix}` },
      subagents: { execute: childExecutor, intervalMs: 10 },
    })

    const collectRootToolCallProjection = async (callId: string) => {
      const result = await pool!.query<{
        itemType: string; itemStatus: string; itemContent: unknown; eventType: string | null; eventPayload: unknown
      }>(
        `SELECT item."type" AS "itemType", item."status" AS "itemStatus", item."content" AS "itemContent",
                event."type" AS "eventType", event."payload" AS "eventPayload"
         FROM "agent_items" AS item
         LEFT JOIN "agent_events" AS event
           ON event."sessionId" = item."sessionId" AND event."turnId" = item."turnId" AND event."itemId" = item."id"
         WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."type" IN ('tool_call', 'tool_result')
           AND item."content"->>'toolCallId' = $3
         ORDER BY item."type", event."sequence"`,
        [discoveryOwner.sessionId, discoveryOwner.turnId, callId],
      )
      const call = result.rows.find(row => row.itemType === "tool_call")
      const toolResult = result.rows.find(row => row.itemType === "tool_result")
      const callContent = record(call?.itemContent)
      const resultContent = record(toolResult?.itemContent)
      const output = record(resultContent?.output)
      const planNodes = Array.isArray(output?.nodes) ? output.nodes.map(record) : []
      const eventTypes = new Set([
        "tool_call.started", "tool_call.completed", "tool_call.failed", "item.started", "item.completed", "item.failed",
      ])
      return {
        callPresent: Boolean(call),
        callStatus: diagnosticEnum(callContent?.status, ITEM_DIAGNOSTIC_STATUSES) ?? "none",
        resultPresent: Boolean(toolResult),
        resultItemStatus: diagnosticEnum(toolResult?.itemStatus, ITEM_DIAGNOSTIC_STATUSES) ?? "none",
        outputStatus: diagnosticEnum(output?.status, new Set(["accepted", "duplicate", "rejected", "ready", "waiting", "timed_out", "failed"])) ?? "none",
        errorCode: diagnosticErrorCode(resultContent?.errorCode),
        nodeCount: diagnosticBoundedCount(Array.isArray(output?.nodes) ? output.nodes.length : null),
        taskIdCount: diagnosticBoundedCount(planNodes.filter(node => typeof node?.taskId === "string").length),
        events: result.rows.filter(row => row.eventType).slice(0, 6).map(row => {
          const payload = record(row.eventPayload)
          return {
            type: diagnosticEnum(row.eventType, eventTypes) ?? "other",
            status: diagnosticEnum(payload?.status, EVENT_DIAGNOSTIC_STATUSES) ?? "none",
            errorCode: diagnosticErrorCode(payload?.errorCode),
          }
        }),
      }
    }

    const collectCanonicalDiscoveryDiagnostics = async () => {
      const [analystPlan, analystWait] = await Promise.all([
        collectRootToolCallProjection(PROCESS_RESTART_DISCOVERY_ANALYST_PLAN_CALL_ID),
        collectRootToolCallProjection("p3-discovery-wait-analyst"),
      ])
      const tasks = await pool!.query<DiscoveryVerifierTask & { failureReason: string | null; result: unknown }>(
        `SELECT "id", "role", "status", "attemptCount", "rootTaskId", "parentTaskId", "failureReason", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2`,
        [discoveryOwner.turnId, discoveryOwner.sessionId],
      )
      const toolReceipts = await pool!.query<{ callCount: number; resultCount: number }>(
        `SELECT COUNT(DISTINCT call."id") FILTER (WHERE call."type" = 'tool_call')::int AS "callCount",
                COUNT(DISTINCT result."id") FILTER (WHERE result."type" = 'tool_result')::int AS "resultCount"
         FROM "agent_items" AS call
         LEFT JOIN "agent_items" AS result
           ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId"
          AND result."taskId" = call."taskId" AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
         WHERE call."sessionId" = $1 AND call."turnId" = $2 AND call."taskId" = ANY($3::text[])
           AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'jobs.search'`,
        [discoveryOwner.sessionId, discoveryOwner.turnId, tasks.rows.map(task => task.id)],
      )
      const taskStatusCounts: RecordValue = {}
      for (const task of tasks.rows) {
        const status = diagnosticEnum(task.status, TASK_DIAGNOSTIC_STATUSES)
        if (status) taskStatusCounts[status] = (typeof taskStatusCounts[status] === "number" ? taskStatusCounts[status] as number : 0) + 1
      }
      const searchCalls = diagnosticBoundedCount(toolReceipts.rows[0]?.callCount) ?? 0
      const searchResults = diagnosticBoundedCount(toolReceipts.rows[0]?.resultCount) ?? 0
      const verifierEvidence = await collectDiscoveryVerifierDiagnostics(pool!, discoveryOwner, tasks.rows)
      const runtimeState = await restartRuntimeStateDiagnostics(pool!, discoveryOwner.turnId)
      return {
        rootStage: discoveryRootStage,
        rootModelFailure: discoveryRootModelFailure ?? "not_captured",
        analystScheduleFailure: discoveryAnalystScheduleFailure ?? { errorName: "none", errorCode: "none" },
        scoutResultValidation: await collectCanonicalDiscoveryScoutResultDiagnostic(pool!, discoveryOwner, [jobId]),
        scoutReadResultProbes: { count: discoveryScoutResultProjections.length, items: discoveryScoutResultProjections.slice(0, 4) },
        analystPlan,
        analystWait,
        childStage: discoveryChildStage,
        childExecutionOutcomes: {
          count: discoveryChildOutcomeProjections.length,
          items: discoveryChildOutcomeProjections.slice(0, 4),
        },
        jobsSearchAppeared: discoveryJobsSearchAppeared || searchCalls > 0,
        jobsSearchCallEmitted: discoveryJobsSearchCallEmitted || searchCalls > 0,
        jobsSearchResultPersisted: searchResults > 0,
        jobsSearchCallCount: searchCalls,
        jobsSearchResultCount: searchResults,
        taskStatusCounts: diagnosticStatusCounts(taskStatusCounts),
        childTasks: diagnosticDiscoveryTasks(tasks.rows),
        verifierEvidence,
        runtimeState,
      }
    }
    await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: discoveryOwner.turnId, sessionId: discoveryOwner.sessionId, ownerId: discoveryOwner.ownerId })
    try {
      await waitForTurnStatus(pool!, discoveryOwner.turnId, "completed", 50_000, "p3-discovery-wait-analyst", [
        "p3-discovery-plan-scout", "p3-discovery-wait-scout", "p3-discovery-plan-analyst",
      ])
    } catch (error) {
      throw new Error(`Canonical interactive discovery diagnostics=${JSON.stringify({
        ...(await collectCanonicalDiscoveryDiagnostics()),
        waitForTurnStatusFailure: waitForTurnStatusFailureDiagnostic(error),
      })}`)
    }

    const root = await pool!.query<{ status: string; result: unknown }>(
      `SELECT "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'orchestrator'`,
      [discoveryOwner.turnId, discoveryOwner.sessionId],
    )
    expect(root.rows).toHaveLength(1)
    expect(root.rows[0]?.status).toBe("completed")
    expect(record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist).toEqual({
      schemaVersion: 1, status: "completed", items: [{ jobId, score: 8.5, evidenceIds: [`read:job:${jobId}`] }], failures: [],
    })
    const children = await pool!.query<{ id: string; role: string; status: string; result: unknown }>(
      `SELECT "id", "role", "status", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = ANY($3::text[]) ORDER BY "role"`,
      [discoveryOwner.turnId, discoveryOwner.sessionId, ["analyst", "scout"]],
    )
    expect(discoveryScoutResultProjections).not.toHaveLength(0)
    expect(discoveryScoutResultProjections).toContainEqual(expect.objectContaining({
      latestSearchResultObserved: true, latestSearchResultParsed: true, latestSearchResultFailed: false,
      expectedJobPresent: true, expectedJobSourceMatches: true,
      resultShapeValid: true, resultValidationCode: "none", requestEvidenceBindValid: true,
    }))
    expect(children.rows.map(child => [child.role, child.status])).toEqual([["analyst", "completed"], ["scout", "completed"]])
    expect(children.rows.map(child => record(record(child.result)?.structuredResult)?.role)).toEqual(["analyst", "scout"])
    expectPassedVerificationReport(record(children.rows.find(child => child.role === "scout")?.result)?.taskGraphVerificationReport, "candidate-count")
    expectPassedVerificationReport(record(children.rows.find(child => child.role === "analyst")?.result)?.taskGraphVerificationReport, "finding-count", "findings-from-scout")
    const dispatches = await pool!.query<{ idempotencyKey: string; publishedAt: Date | null }>(
      `SELECT "idempotencyKey", "publishedAt" FROM "agent_outbox"
       WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = ANY($2::text[]) ORDER BY "idempotencyKey"`,
      [discoveryOwner.sessionId, children.rows.map(child => `subagent-dispatch:${child.id}`)],
    )
    expect(dispatches.rows).toHaveLength(2)
    expect(dispatches.rows.every(dispatch => dispatch.publishedAt instanceof Date)).toBe(true)
    const waits = await pool!.query<{ id: string; consumedAt: Date | null }>(
      `SELECT "id", "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "sessionId" = $2 ORDER BY "createdAt"`,
      [discoveryOwner.turnId, discoveryOwner.sessionId],
    )
    expect(waits.rows).toHaveLength(2)
    expect(waits.rows.every(wait => wait.consumedAt instanceof Date)).toBe(true)
    const final = await pool!.query<{ finalResponse: string | null }>(`SELECT "finalResponse" FROM "agent_turns" WHERE "id" = $1`, [discoveryOwner.turnId])
    const finalResponse = JSON.parse(final.rows[0]?.finalResponse ?? "null") as RecordValue
    expect(finalResponse.response).toBe(JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "Shortlist ready" }))
    expect(finalResponse.summary).toContain("discovered jobs: 1 (complete)")
  }, 90_000)

  it("fails an interactive shortlist when its Scout prerequisite fails and cancels dependent work", async () => {
    const [workerQueue, canonical, commandPortModule, subagentQueue] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("../../queue/subagent-queue.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME } = await import("../turns/turn-queue.js")
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    const INTERACTIVE_FAILURE_MAX_STEPS = 10
    const value = discoveryFailureOwner
    await activateFixtureTurn(pool!, value)
    await pool!.query(`UPDATE "agent_turns" SET "budgetSnapshot" = $2::jsonb
      WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      value.turnId, JSON.stringify({ limits: { maxSteps: INTERACTIVE_FAILURE_MAX_STEPS, maxToolCalls: 8 } }), value.sessionId, value.userId,
    ])
    const jobId = fixtureJobId(value.suffix)
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      value.turnId,
      JSON.stringify({ goal: "Find and rank an engineering role in Dublin", intent: { kind: "interactive_discovery_shortlist", version: 1 } }),
      value.sessionId, value.userId,
    ])
    await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, 'Failure Fixture Labs', 'Software Engineer', 'Dublin', 'saved', 'https://jobs.example.invalid/discovery-failure', 'Build durable services', 'greenhouse', CURRENT_TIMESTAMP)`, [
      jobId, value.userId,
    ])

    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    let rootExecution = 0
    let optimisticFinalAttempts = 0
    let dependentWasWaitingBeforeProof = false
    let interactiveFailureIntentRestored = false
    let interactiveFailureRootPlanStage: "not_started" | "initial_plan" | "initial_wait" | "resumed_root" | "graph_status" | "hydrated_wait" | "optimistic_final" = "not_started"
    let interactiveFailureGraphStatusReached = false
    let interactiveFailureGraphStatuses: Array<{ key: "scout" | "analyst"; status: string }> = []
    let interactiveFailureHydratedWaitStatus: string | null = null
    let interactiveFailureHydratedWaitCount: number | null = null
    let interactiveFailureChildExecutorCalls = 0
    let interactiveFailureForeignChildDeliveryCount = 0
    let interactiveFailureChildModelFactoryCalls = 0
    let interactiveFailureChildModelTaskMatchesLease: boolean | null = null
    let interactiveFailureChildLeaseUserMatchesFixture: boolean | null = null
    let interactiveFailureChildLeaseSessionMatchesFixture: boolean | null = null
    let interactiveFailureChildLeaseTurnMatchesFixture: boolean | null = null
    let interactiveFailureChildRoleIsScout: boolean | null = null
    let interactiveFailureChildStatusIsRunning: boolean | null = null
    let interactiveFailureChildGoalMatchesFixture: boolean | null = null
    let interactiveFailureChildStreamRounds = 0
    let interactiveFailureChildStage: "not_called" | "executor_entered" | "model_factory" | "search_call" | "search_result" | "parent_wait" | "parent_wait_persisted" | "dependent_read" | "dependent_waiting" | "dependent_dispatch_checked" | "proof_held" = "not_called"
    let interactiveFailureSearchResultObject: boolean | null = null
    let interactiveFailureReturnedJobCount: number | null = null
    let interactiveFailureExpectedJobReturned: boolean | null = null
    let interactiveFailureReturnedJobIdHasRedactionMarker: boolean | null = null
    let interactiveFailureDependentRows: number | null = null
    let interactiveFailureDependentStatus: string | null = null
    let interactiveFailureDependentDispatchCount: number | null = null
    const childLeaseByTaskId = new Map<string, SubagentLease>()
    const interactiveFailureDiagnostic = () => JSON.stringify({
      intentRestored: interactiveFailureIntentRestored,
      rootPlanStage: interactiveFailureRootPlanStage,
      optimisticFinalAttempts,
      graphStatusReached: interactiveFailureGraphStatusReached,
      graphStatuses: interactiveFailureGraphStatuses,
      hydratedWaitStatus: interactiveFailureHydratedWaitStatus,
      hydratedWaitCount: interactiveFailureHydratedWaitCount,
      childExecutorCalls: diagnosticBoundedCount(interactiveFailureChildExecutorCalls),
      foreignChildDeliveryCount: diagnosticBoundedCount(interactiveFailureForeignChildDeliveryCount),
      childModelFactoryCalls: diagnosticBoundedCount(interactiveFailureChildModelFactoryCalls),
      childModelTaskMatchesLease: interactiveFailureChildModelTaskMatchesLease,
      childLeaseUserMatchesFixture: interactiveFailureChildLeaseUserMatchesFixture,
      childLeaseSessionMatchesFixture: interactiveFailureChildLeaseSessionMatchesFixture,
      childLeaseTurnMatchesFixture: interactiveFailureChildLeaseTurnMatchesFixture,
      childRoleIsScout: interactiveFailureChildRoleIsScout,
      childStatusIsRunning: interactiveFailureChildStatusIsRunning,
      childGoalMatchesFixture: interactiveFailureChildGoalMatchesFixture,
      childStreamRounds: diagnosticBoundedCount(interactiveFailureChildStreamRounds),
      childStage: interactiveFailureChildStage,
      searchResultObject: interactiveFailureSearchResultObject,
      returnedJobCount: interactiveFailureReturnedJobCount,
      expectedJobReturned: interactiveFailureExpectedJobReturned,
      returnedJobIdHasRedactionMarker: interactiveFailureReturnedJobIdHasRedactionMarker,
      dependentRows: interactiveFailureDependentRows,
      dependentStatus: interactiveFailureDependentStatus,
      dependentDispatchCount: interactiveFailureDependentDispatchCount,
    })
    const rootRuntime = await canonical.createCanonicalTurnRuntime(pool!, {
      workerId: value.ownerId, productionFlags: flags,
      taskGraphCommandPort: commandPortModule.createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: { ...TASK_GRAPH_TEMPLATES },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecution
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-interactive-discovery-dependency-failure-root-fixture", profile,
          async *stream(request) {
            round += 1
            if (execution === 1 && round === 1) {
              interactiveFailureRootPlanStage = "initial_plan"
              yield { type: "tool_call_completed", callId: "p3-discovery-failure-plan", name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [
                  { key: "scout", templateId: "scout", goal: "Find matching fixture roles", successCriteria: ["Read one owner job"], dependsOn: [], verification: SCOUT_VERIFICATION },
                  { key: "analyst", templateId: "analyst", goal: "Score the discovered fixture role", successCriteria: ["Return an evidence-bound score"], dependsOn: ["scout"], verification: ANALYST_VERIFICATION },
                ],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              interactiveFailureRootPlanStage = "initial_wait"
              const taskIds = planTaskIds(request, "p3-discovery-failure-plan", 2)
              yield { type: "tool_call_completed", callId: "p3-discovery-failure-wait", name: "agent.wait", arguments: {
                idempotencyKey: `p3-discovery-failure-wait:${value.turnId}`, taskIds: [taskIds[0]!], mode: "all", timeoutMs: 20_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const firstResumedRound = (execution === 2 && round === 1) || (execution === 1 && round === 3)
            const recoveryRound = (execution === 2 && round > 1) || (execution === 1 && round > 3)
            if (firstResumedRound || recoveryRound) {
              if (firstResumedRound) {
                interactiveFailureRootPlanStage = "resumed_root"
                const rootToolNames = request.tools.map(tool => record(tool)?.name)
                interactiveFailureIntentRestored = rootToolNames.includes("agent.plan") && !rootToolNames.includes("jobs.search")
                const graph = currentGraphFromRequest(request)
                const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
                interactiveFailureGraphStatusReached = graph?.kind === "task_graph_current" && nodes.length > 0
                interactiveFailureGraphStatuses = nodes.flatMap(node => {
                  const key = node?.key
                  const status = diagnosticEnum(node?.status, TASK_DIAGNOSTIC_STATUSES)
                  return (key === "scout" || key === "analyst") && status ? [{ key, status }] : []
                })
                interactiveFailureRootPlanStage = "graph_status"
                const graphStates = nodes.map(node => `${String(node?.key)}:${String(node?.status)}`).sort()
                expect(graphStates, interactiveFailureDiagnostic()).toEqual(["analyst:waiting", "scout:failed"])
                const outcome = waitOutcomeFromRequest(request, 1)
                interactiveFailureRootPlanStage = "hydrated_wait"
                interactiveFailureHydratedWaitStatus = diagnosticEnum(outcome.status, WAIT_DIAGNOSTIC_STATUSES)
                interactiveFailureHydratedWaitCount = diagnosticBoundedCount(outcome.tasks.length)
                expect(outcome.status, interactiveFailureDiagnostic()).toBe("ready")
                const tasks = outcome.tasks.map(record)
                const taskStates = tasks.map(task => `${String(task?.role)}:${String(task?.status)}`).sort()
                expect(taskStates).toEqual(["scout:failed"])
                const failedScout = tasks.find(task => task?.role === "scout")
                expect(typeof failedScout?.failureReason).toBe("string")
                expect(String(failedScout?.failureReason).length).toBeGreaterThan(0)
                expectUnverifiedVerificationReport(failedScout?.verificationReport, "candidate-count")
                expectUnverifiedVerificationReport(nodes.find(node => node?.key === "scout")?.verificationReport, "candidate-count")
              }
              optimisticFinalAttempts += 1
              interactiveFailureRootPlanStage = "optimistic_final"
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: `Shortlist ready: ${jobId}` }) }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected discovery failure root model turn ${execution}/${round}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const childExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        const lease = childLeaseByTaskId.get(task.id)
        if (lease) {
          interactiveFailureChildModelFactoryCalls = Math.min(12, interactiveFailureChildModelFactoryCalls + 1)
          interactiveFailureChildStage = "model_factory"
          interactiveFailureChildModelTaskMatchesLease = lease.id === task.id
          interactiveFailureChildRoleIsScout = task.role === "scout"
          interactiveFailureChildStatusIsRunning = task.status === "running"
          interactiveFailureChildGoalMatchesFixture = task.goal === "Find matching fixture roles"
        }
        if (task.role !== "scout") throw new Error(`Dependent discovery role executed unexpectedly: ${task.role}`)
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-interactive-discovery-invalid-scout-fixture", profile,
          async *stream(request) {
            round += 1
            if (lease) interactiveFailureChildStreamRounds = Math.min(12, interactiveFailureChildStreamRounds + 1)
            if (round === 1) {
              if (lease) interactiveFailureChildStage = "search_call"
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.search")
              yield { type: "tool_call_completed", callId: "p3-discovery-failure-read", name: "jobs.search", arguments: { target: "Software Engineer", location: "Dublin", limit: 10 } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const rawSearchResult = latestToolResult(request, "p3-discovery-failure-read")
            const searchResult = record(rawSearchResult)
            if (lease) {
              interactiveFailureChildStage = "search_result"
              interactiveFailureSearchResultObject = searchResult !== null
            }
            const observedJobIds = Array.isArray(searchResult?.jobs)
              ? searchResult.jobs.map(record).flatMap(job => typeof job?.id === "string" ? [job.id] : [])
              : []
            if (lease) {
              interactiveFailureReturnedJobCount = diagnosticBoundedCount(observedJobIds.length)
              interactiveFailureExpectedJobReturned = observedJobIds.includes(jobId)
              interactiveFailureReturnedJobIdHasRedactionMarker = observedJobIds.some(id => /\[REDACTED(?:_(?:PHONE|EMAIL))?\]/i.test(id))
            }
            expect(observedJobIds).toContain(jobId)
            if (lease) interactiveFailureChildStage = "parent_wait"
            await waitForPersistedTaskWait(pool!, value.turnId, `p3-discovery-failure-wait:${value.turnId}`)
            if (lease) interactiveFailureChildStage = "parent_wait_persisted"
            if (lease) interactiveFailureChildStage = "dependent_read"
            const dependent = await pool!.query<{ id: string; status: string }>(
              `SELECT "id", "status" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'analyst'`,
              [value.turnId, value.sessionId],
            )
            if (lease) {
              interactiveFailureDependentRows = diagnosticBoundedCount(dependent.rows.length)
              interactiveFailureDependentStatus = diagnosticEnum(dependent.rows[0]?.status, TASK_DIAGNOSTIC_STATUSES)
            }
            expect(dependent.rows).toHaveLength(1)
            expect(dependent.rows[0]?.status).toBe("waiting")
            if (lease) interactiveFailureChildStage = "dependent_waiting"
            const dependentDispatch = await pool!.query(
              `SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
              [value.sessionId, `subagent-dispatch:${dependent.rows[0]!.id}`],
            )
            if (lease) interactiveFailureDependentDispatchCount = diagnosticBoundedCount(dependentDispatch.rowCount ?? 0)
            expect(dependentDispatch.rowCount).toBe(0)
            if (lease) interactiveFailureChildStage = "dependent_dispatch_checked"
            if (lease) {
              dependentWasWaitingBeforeProof = true
              interactiveFailureChildStage = "proof_held"
            }
            // This schema-valid result cites a job/evidence pair absent from canonical tool receipts.
            const forgedId = "read:job:unobserved-fabricated-job"
            yield { type: "text_delta", text: JSON.stringify({
              schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
              candidates: [{ jobId: "unobserved-fabricated-job", source: "fixture", url: null, evidenceIds: [forgedId] }],
              evidence: [{ id: forgedId, kind: "job", ref: "unobserved-fabricated-job", source: "greenhouse" }],
              summary: "Fabricated evidence must not pass",
            }) }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    const executeChildWithDiagnostics: typeof childExecutor = async input => {
      const isFixtureLease = input.lease.userId === value.userId
        && input.lease.sessionId === value.sessionId
        && input.lease.turnId === value.turnId
      if (isFixtureLease) {
        interactiveFailureChildExecutorCalls = Math.min(12, interactiveFailureChildExecutorCalls + 1)
        interactiveFailureChildStage = "executor_entered"
        interactiveFailureChildLeaseUserMatchesFixture = true
        interactiveFailureChildLeaseSessionMatchesFixture = true
        interactiveFailureChildLeaseTurnMatchesFixture = true
        childLeaseByTaskId.set(input.lease.id, input.lease)
      } else {
        interactiveFailureForeignChildDeliveryCount = Math.min(12, interactiveFailureForeignChildDeliveryCount + 1)
      }
      try {
        return await childExecutor(input)
      } finally {
        if (isFixtureLease) childLeaseByTaskId.delete(input.lease.id)
      }
    }
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime: rootRuntime, ownerId: value.ownerId,
      turnQueueFactory: createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-discovery-failure-wait-resolver-${value.suffix}` },
      subagents: { execute: executeChildWithDiagnostics, intervalMs: 10 },
    })

    await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
    try {
      await waitForTurnStatus(pool!, value.turnId, "failed", 50_000, "p3-discovery-failure-wait", [
        "p3-discovery-failure-plan",
      ])
    } catch {
      throw new Error(`Interactive shortlist failure diagnostics=${interactiveFailureDiagnostic()}`)
    }

    const turn = await pool!.query<{ status: string }>(
      `SELECT "status" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [value.turnId, value.sessionId, value.userId],
    )
    expect(turn.rows[0]?.status, interactiveFailureDiagnostic()).toBe("failed")
    expect(optimisticFinalAttempts, interactiveFailureDiagnostic()).toBeGreaterThan(1)
    expect(dependentWasWaitingBeforeProof, interactiveFailureDiagnostic()).toBe(true)
    const turnFailure = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'turn.failed' ORDER BY "sequence" DESC LIMIT 1`,
      [value.turnId, value.sessionId],
    )
    expect(turnFailure.rows).toHaveLength(1)
    const turnFailurePayload = record(turnFailure.rows[0]?.payload) ?? {}
    const turnFinal = record(turnFailurePayload.final) ?? {}
    expect(turnFinal).toMatchObject({ completed: false, terminalReason: "budget_exhausted" })
    expect(JSON.stringify(turnFinal)).not.toContain(jobId)

    const root = await pool!.query<{ id: string; status: string; failureReason: string | null; result: unknown }>(
      `SELECT "id", "status", "failureReason", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "role" = 'orchestrator'`, [value.turnId, value.sessionId],
    )
    expect(root.rows).toHaveLength(1)
    expect(root.rows[0]).toMatchObject({ status: "failed", failureReason: "budget_exhausted" })
    expect(record(root.rows[0]?.result)?.status).toBe("failed")
    expect(record(record(root.rows[0]?.result)?.structuredResult)?.interactiveDiscoveryShortlist).toEqual({
      schemaVersion: 1, status: "failed", items: [], failures: ["discovery_runtime_failed"],
    })
    const rejections = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'final.rejected'
       ORDER BY "sequence" ASC`, [value.turnId, value.sessionId],
    )
    expect(rejections.rows).toHaveLength(optimisticFinalAttempts)
    for (const rejection of rejections.rows) expect(record(rejection.payload)).toMatchObject({ blocker: "task_graph_verification_unverified" })
    const budgetExhausted = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'turn.budget_exhausted'`,
      [value.turnId, value.sessionId],
    )
    expect(budgetExhausted.rows).toHaveLength(1)
    expect(record(budgetExhausted.rows[0]?.payload)).toMatchObject({ reasonCode: "budget_exhausted", metric: "steps", limit: INTERACTIVE_FAILURE_MAX_STEPS })
    const children = await pool!.query<{ id: string; role: string; status: string; failureReason: string | null; result: unknown }>(
      `SELECT "id", "role", "status", "failureReason", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 ORDER BY "role"`,
      [value.turnId, value.sessionId, root.rows[0]!.id],
    )
    expect(children.rows.map(child => [child.role, child.status])).toEqual([["analyst", "cancelled"], ["scout", "failed"]])
    expect(children.rows.find(child => child.role === "scout")?.failureReason).toBe("task_graph_verification_unverified")
    expectUnverifiedVerificationReport(record(children.rows.find(child => child.role === "scout")?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(children.rows.find(child => child.role === "analyst")?.failureReason).toBe("Root task failed.")
    const dependentDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch'
       AND "idempotencyKey" = $2`, [value.sessionId, `subagent-dispatch:${children.rows.find(child => child.role === "analyst")?.id}`],
    )
    expect(dependentDispatches.rowCount).toBe(0)
    const dependentCancellation = await pool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
       AND "payload"->>'kind' = 'lifecycle' AND "payload"->'event'->>'type' = 'task.cancelled'`,
      [value.sessionId, value.turnId, children.rows.find(child => child.role === "analyst")?.id],
    )
    expect(dependentCancellation.rows).toHaveLength(1)
    expect(record(dependentCancellation.rows[0]?.payload)).toMatchObject({
      kind: "lifecycle", event: { type: "task.cancelled", nodeKey: "analyst" },
    })
    const wait = await pool!.query<{ status: string; consumedAt: Date | null }>(
      `SELECT "status", "consumedAt" FROM "agent_wait_conditions" WHERE "turnId" = $1 AND "sessionId" = $2`,
      [value.turnId, value.sessionId],
    )
    expect(wait.rows).toHaveLength(1)
    expect(wait.rows[0]).toMatchObject({ status: "ready", consumedAt: expect.any(Date) })
  }, 90_000)

  it.each([
    ["evidence-bound criterion failure", verificationRepairOwner, false],
    ["null-digest hard executor failure", lateRepairOwner, true],
  ] as const)("denies root completion until a real same-turn repair receipt unlocks its dependent after %s", async (_scenario, value, hardExecutorFailure) => {
    const [workerQueue, canonical, commandPortModule, subagentQueue] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("../../queue/subagent-queue.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const { createTurnQueue, enqueueTurn, TURN_QUEUE_NAME } = await import("../turns/turn-queue.js")
    turnQueueName = TURN_QUEUE_NAME
    childQueueName = subagentQueue.SUBAGENT_QUEUE_NAME
    await activateFixtureTurn(pool!, value)
    const firstJobId = fixtureJobId(value.suffix)
    const secondJobId = fixtureJobId(value.suffix, 1)
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      value.turnId, JSON.stringify({ goal: "Find and verify engineering roles" }), value.sessionId, value.userId,
    ])
    const insertJob = async (jobId: string) => pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, $3, 'Software Engineer', 'Dublin', 'saved', $4, 'Persisted verification fixture', 'greenhouse', CURRENT_TIMESTAMP)
      ON CONFLICT ("id") DO NOTHING`, [jobId, value.userId, `Verifier Fixture ${jobId}`, `https://jobs.example.invalid/${jobId}`])
    await insertJob(firstJobId)

    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    const scoutVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
      role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }],
    } as const
    const initialPlanCallId = `p3-verifier-repair-initial-plan:${value.turnId}`
    const initialWaitCallId = `p3-verifier-repair-initial-wait:${value.turnId}`
    const repairPlanCallId = `p3-verifier-repair-plan:${value.turnId}`
    const repairWaitCallId = `p3-verifier-repair-wait:${value.turnId}`
    let initialPlanSent = false
    let initialWaitSent = false
    let optimisticFinalAttempted = false
    let repairPlanSent = false
    let repairWaitSent = false
    const repairWaitCallIds: string[] = []
    const repairWaitStatuses: string[] = []
    const repairWaitReadCallIds: string[] = []
    const repairWaitReadCallIdsByWaitCall = new Map<string, string[]>()
    let repairWaitReferenceObserved = false
    let repairWaitReferenceSize: number | null = null
    let repairWaitFailure: RepairWaitFailureClass | null = null
    let repairWaitFailureStage: RepairWaitFailureStage | null = null
    let repairWaitFailureOrdinal: number | null = null
    let repairWaitFailureReadCount: number | null = null
    let repairWaitFailureOutcomeStatus: RepairWaitOutcomeDiagnosticStatus = "unavailable"
    let repairWaitErrorKind: RepairWaitFailureErrorKind | null = null
    let repairWaitReaderVisible: boolean | null = null
    let repairWaitResolutionReturned = false
    let repairWaitResolvedOutcomeObserved = false
    let secondJobSeeded = false
    let initialPlanTaskIds: string[] | undefined
    let terminalGateLease: TurnLease | undefined
    let failedReportBeforeRepair: unknown
    let rootExecution = 0
    const privateWaitDiagnostics = instrumentPrivateWaitReader(pool!, () => rootExecution)
    const rootRuntime = await canonical.createCanonicalTurnRuntime(privateWaitDiagnostics.pool, {
      workerId: value.ownerId, productionFlags: flags,
      taskGraphCommandPort: commandPortModule.createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: { ...TASK_GRAPH_TEMPLATES },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecution
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-taskgraph-repair-root-fixture", profile,
          async *stream(request) {
            round += 1
            const graph = currentGraphFromRequest(request)
            const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
            const scout = nodes.find(node => node?.key === "scout")
            const repair = nodes.find(node => node?.key === "scout-repair")
            const dependent = nodes.find(node => node?.key === "analyst")
            if (!initialPlanSent) {
              initialPlanSent = true
              const supplementalAnalysts = hardExecutorFailure ? [] : Array.from({ length: 5 }, (_, index) => ({
                key: `analyst-capacity-${index + 1}`,
                templateId: "analyst",
                goal: `Score supplemental typed task ${index + 1} after Scout proof`,
                successCriteria: ["Return an evidence-bound finding"],
                dependsOn: ["scout"],
                verification: ANALYST_VERIFICATION,
              }))
              yield { type: "tool_call_completed", callId: initialPlanCallId, name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [
                  { key: "scout", templateId: "scout", goal: "Find at least two owner jobs", successCriteria: ["Return two evidence-bound candidates"], dependsOn: [], verification: scoutVerification },
                  { key: "analyst", templateId: "analyst", goal: "Score only after Scout proof", successCriteria: ["Return an evidence-bound finding"], dependsOn: ["scout"], verification: ANALYST_VERIFICATION },
                  ...supplementalAnalysts,
                ],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (initialPlanSent && !initialWaitSent) {
              initialWaitSent = true
              initialPlanTaskIds = planTaskIds(request, initialPlanCallId, hardExecutorFailure ? 2 : 7)
              yield { type: "tool_call_completed", callId: initialWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: `p3-verifier-repair-initial-wait:${value.turnId}`, taskIds: [initialPlanTaskIds[0]!], mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const previousRepairWaitCallId = repairWaitCallIds.at(-1)
            let previousRepairWait: RecordValue | null = null
            if (previousRepairWaitCallId && !hardExecutorFailure) {
              const repairTaskIds = planTaskIds(request, repairPlanCallId, 1)
              const dependentTaskIds = initialPlanTaskIds?.slice(1) ?? []
              const expectedDependentCount = hardExecutorFailure ? 1 : 6
              if (repairTaskIds.length !== 1 || dependentTaskIds.length !== expectedDependentCount || dependentTaskIds.some(id => !id)) {
                throw new Error("repair fixture lost accepted wait targets")
              }
              const readCallIds = repairWaitReadCallIdsByWaitCall.get(previousRepairWaitCallId) ?? []
              const waitOrdinal = boundedRepairWaitDiagnosticCount(repairWaitCallIds.indexOf(previousRepairWaitCallId) + 1)
              const currentReadCount = boundedRepairWaitDiagnosticCount(readCallIds.length)
              repairWaitReferenceSize = repairWaitReferenceSizeBytes(latestToolResult(request, previousRepairWaitCallId))
              let resolution: RepairWaitOutputResolution
              try { resolution = repairWaitOutputResolutionFromRequest(request, previousRepairWaitCallId, readCallIds) }
              catch (error: unknown) {
                repairWaitFailureStage = "output_resolution"
                repairWaitFailureOrdinal = waitOrdinal
                repairWaitFailureReadCount = currentReadCount
                repairWaitFailureOutcomeStatus = "unavailable"
                repairWaitErrorKind = repairWaitFailureErrorKind(error)
                repairWaitFailure = repairWaitFailureClass(error)
                throw error
              }
              repairWaitResolutionReturned = true
              if (resolution.status === "read") {
                repairWaitReferenceObserved = true
                repairWaitReaderVisible = Array.isArray(request.tools) && request.tools.some(tool => record(tool)?.name === "tool_results.read")
                if (!repairWaitReaderVisible) {
                  repairWaitFailure = "reader_not_visible"
                  throw new Error("repair wait reference reader was not visible to the model")
                }
                if (repairWaitReadCallIds.length >= VERIFICATION_REPAIR_MAX_REFERENCE_READS) {
                  repairWaitFailure = "read_budget_exceeded"
                  throw new Error("repair wait reference exceeded its bounded read budget")
                }
                const readCallId = `${previousRepairWaitCallId}:read:${readCallIds.length + 1}`
                readCallIds.push(readCallId)
                repairWaitReadCallIdsByWaitCall.set(previousRepairWaitCallId, readCallIds)
                repairWaitReadCallIds.push(readCallId)
                yield { type: "tool_call_completed", callId: readCallId, name: "tool_results.read", arguments: {
                  referenceId: resolution.reference.id,
                  ...(resolution.cursor === undefined ? {} : { cursor: resolution.cursor }),
                } }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
              if (resolution.status === "complete") repairWaitReferenceObserved = true
              try {
                previousRepairWait = repairWaitOutcomeFromRequest(
                  request, previousRepairWaitCallId, [...repairTaskIds, ...dependentTaskIds], resolution.output,
                )
              } catch (error: unknown) {
                repairWaitFailureStage = "outcome_validation"
                repairWaitFailureOrdinal = waitOrdinal
                repairWaitFailureReadCount = currentReadCount
                repairWaitFailureOutcomeStatus = repairWaitOutcomeDiagnosticStatus(resolution.output)
                repairWaitErrorKind = repairWaitFailureErrorKind(error)
                repairWaitFailure = repairWaitFailureClass(error)
                throw error
              }
              repairWaitResolvedOutcomeObserved = true
              repairWaitStatuses.push(String(previousRepairWait.status))
            }
            const repairWaitNeedsPoll = !previousRepairWaitCallId
              || (!hardExecutorFailure && previousRepairWait?.status === "timed_out")
            if (repairPlanSent && repairWaitNeedsPoll) {
              if (repairWaitCallIds.length >= VERIFICATION_REPAIR_MAX_WAIT_POLLS) {
                throw new Error("repair fixture exhausted its bounded wait polls")
              }
              repairWaitSent = true
              const repairTaskIds = planTaskIds(request, repairPlanCallId, 1)
              const dependentTaskIds = initialPlanTaskIds?.slice(1) ?? []
              const expectedDependentCount = hardExecutorFailure ? 1 : 6
              if (repairTaskIds.length !== 1 || dependentTaskIds.length !== expectedDependentCount || dependentTaskIds.some(id => !id)) {
                throw new Error("repair fixture lost accepted wait targets")
              }
              if (!hardExecutorFailure) {
                const repairedGraph = currentGraphFromRequest(request)
                expect(repairedGraph?.nodes).toHaveLength(TASK_GRAPH_LIMITS.maxNodes)
                expect(repairedGraph?.nodeCapacity).toEqual({
                  nodeCount: 8, maxNodes: TASK_GRAPH_LIMITS.maxNodes, remaining: 0,
                  ordinaryRemaining: 0, reserveActive: false, repairRecorded: true,
                })
                expect((Array.isArray(repairedGraph?.nodes) ? repairedGraph.nodes.map(record) : [])
                  .map(node => node?.key)).toContain("scout-repair")
              }
              const taskIds = [...repairTaskIds, ...dependentTaskIds]
              const pollIndex = repairWaitCallIds.length
              const pollSuffix = pollIndex === 0 ? "" : `:poll:${pollIndex + 1}`
              const callId = `${repairWaitCallId}${pollSuffix}`
              repairWaitCallIds.push(callId)
              privateWaitDiagnostics.setLatestInvocation(callId, execution)
              yield { type: "tool_call_completed", callId, name: "agent.wait", arguments: {
                idempotencyKey: `${repairWaitCallId}${pollSuffix}`, taskIds, mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (scout?.status === "failed" && !repair) {
              if (!hardExecutorFailure) {
                expect(nodes).toHaveLength(7)
                expect(graph?.nodeCapacity).toEqual({
                  nodeCount: 7, maxNodes: TASK_GRAPH_LIMITS.maxNodes, remaining: 1,
                  ordinaryRemaining: 0, reserveActive: true, repairRecorded: false,
                })
                const serverTurn = await pool!.query<{ rootTaskId: string | null }>(
                  `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                  [value.turnId, value.sessionId, value.userId],
                )
                const hiddenRootTaskId = serverTurn.rows[0]?.rootTaskId
                if (!hiddenRootTaskId) throw new Error("repair fixture could not read the server-owned root identity")
                expect(JSON.stringify(graph)).not.toContain(hiddenRootTaskId)
              }
              const dependentBeforeRepair = await pool!.query<{ id: string; status: string }>(`SELECT "id", "status" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "goal" = $3`, [value.turnId, value.sessionId, "Score only after Scout proof"])
              expect(dependentBeforeRepair.rows).toHaveLength(1)
              expect(dependentBeforeRepair.rows[0]?.status).toBe("waiting")
              const earlyDispatch = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`, [value.sessionId, `subagent-dispatch:${dependentBeforeRepair.rows[0]!.id}`])
              expect(earlyDispatch.rowCount).toBe(0)
              if (!optimisticFinalAttempted) {
                const initialWait = waitOutcomeFromRequest(request, 1)
                expect(initialWait.status).toBe("ready")
                const waitedScout = record(initialWait.tasks[0])
                expect(waitedScout).toMatchObject({ taskId: scout?.taskId, role: "scout", status: "failed" })
                if (hardExecutorFailure) expectUnverifiedVerificationReport(waitedScout?.verificationReport, "candidate-count")
                else expect(record(waitedScout?.verificationReport)).toMatchObject({ status: "failed", reasonCode: "criterion_not_met" })
                expect(record(scout.verificationReport)).toEqual(waitedScout?.verificationReport)
                const turn = await pool!.query<{ rootTaskId: string | null; leaseOwnerId: string | null; leaseVersion: number; leaseStartedAt: Date | null; leaseExpiresAt: Date | null }>(
                  `SELECT "rootTaskId", "leaseOwnerId", "leaseVersion", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                  [value.turnId, value.sessionId, value.userId],
                )
                const leaseRow = turn.rows[0]
                if (!leaseRow?.rootTaskId || !leaseRow.leaseOwnerId || !leaseRow.leaseStartedAt || !leaseRow.leaseExpiresAt) throw new Error("repair fixture could not capture the live terminal-gate lease")
                terminalGateLease = {
                  turnId: value.turnId, sessionId: value.sessionId, userId: value.userId, ownerId: leaseRow.leaseOwnerId,
                  leaseVersion: Number(leaseRow.leaseVersion), leaseStartedAt: leaseRow.leaseStartedAt, leaseExpiresAt: leaseRow.leaseExpiresAt,
                }
                expect(await checkTerminalTaskGraph(pool!, terminalGateLease, leaseRow.rootTaskId)).toMatchObject({ ok: false, blocker: TASK_GRAPH_VERIFICATION_BLOCKER })
                optimisticFinalAttempted = true
                yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "The shortlist is ready" }) }
                yield { type: "completed", finishReason: "stop" }
                return
              }
              if (!repairPlanSent) {
                if (!secondJobSeeded) { await insertJob(secondJobId); secondJobSeeded = true }
                if (!scout?.taskId || typeof graph?.revision !== "number") throw new Error("repair fixture lost its current target identity")
                const target = await pool!.query<{ result: unknown; status: string; failureReason: string | null }>(`SELECT "result", "status", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [scout.taskId, value.sessionId, value.turnId])
                const taskResult = record(target.rows[0]?.result)
                failedReportBeforeRepair = taskResult?.taskGraphVerificationReport
                expect(target.rows[0]).toMatchObject({
                  status: "failed",
                  failureReason: hardExecutorFailure ? "task_graph_verification_unverified" : "task_graph_verification_failed",
                })
                if (hardExecutorFailure) {
                  expectUnverifiedVerificationReport(failedReportBeforeRepair, "candidate-count")
                } else {
                  expect(record(failedReportBeforeRepair)).toMatchObject({ status: "failed", reasonCode: "criterion_not_met", criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }] })
                  expect(String(record(failedReportBeforeRepair)?.evidenceDigest)).toMatch(/^[a-f0-9]{64}$/)
                }
                repairPlanSent = true
                const repairOf = { nodeKey: "scout", taskId: scout.taskId, criterionIds: ["candidate-count"] }
                expect(repairOf).not.toHaveProperty("graphRootTaskId")
                yield { type: "tool_call_completed", callId: repairPlanCallId, name: "agent.plan", arguments: {
                  expectedRevision: graph.revision,
                  nodes: [{ key: "scout-repair", templateId: "scout", goal: "Recheck after new owner evidence is available", successCriteria: ["Return two evidence-bound candidates"], dependsOn: [], verification: scoutVerification,
                    repairOf }],
                } }
                yield { type: "completed", finishReason: "tool_calls" }
                return
              }
            }
            if (repair?.status === "completed" && dependent?.status === "completed") {
              if (!hardExecutorFailure) expect(repairWaitStatuses.at(-1)).toBe("ready")
              expectPassedVerificationReport(repair.verificationReport, "candidate-count")
              expect(record(repair.repairReceipt)).toMatchObject({
                graphRootTaskId: expect.any(String), targetNodeKey: "scout", targetTaskId: scout?.taskId,
                criterionIds: ["candidate-count"], repairNodeKey: "scout-repair", repairTaskId: repair.taskId,
              })
              expectPassedVerificationReport(dependent.verificationReport, "finding-count")
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "The verified shortlist is ready" }) }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected repair root model turn ${execution}/${round}: ${nodes.map(node => `${node?.key}:${node?.status}`).join(",")}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const initialScoutReadDiagnostic = {
      expectedLookupCount: 0,
      resolvedLookupCount: 0,
      structuredResultEmitted: false,
      sessionMatchesFixture: null as boolean | null,
      turnMatchesFixture: null as boolean | null,
      userMatchesFixture: null as boolean | null,
      taskUserMatchesFixture: null as boolean | null,
      modelTaskMatchesLease: null as boolean | null,
      matchingToolResultCount: null as number | null,
      resultJsonParsed: null as boolean | null,
      expectedJobPresent: null as boolean | null,
      returnedJobCount: null as number | null,
    }
    const childLeaseByTaskId = new Map<string, SubagentLease>()
    const childExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        let round = 0
        const leasedTask = childLeaseByTaskId.get(task.id)
        if (task.goal === "Find at least two owner jobs") {
          initialScoutReadDiagnostic.taskUserMatchesFixture = task.userId === value.userId
        }
        const jobIds = task.goal === "Find at least two owner jobs"
          ? [firstJobId]
          : [firstJobId, secondJobId]
        const callIds = jobIds.map((_, index) =>
          "p3-verifier-repair-read:" + value.sessionId + ":" + value.turnId + ":" + task.id + ":" + task.attemptCount + ":" + index)
        if (task.goal === "Find at least two owner jobs") initialScoutReadDiagnostic.expectedLookupCount = jobIds.length
        const adapter: ModelAdapter = {
          id: "p3-verifier-repair-" + task.role + "-child-fixture", profile,
          async *stream(request) {
            round += 1
            if (task.goal === "Find at least two owner jobs") {
              initialScoutReadDiagnostic.modelTaskMatchesLease = leasedTask && typeof request.metadata.taskId === "string"
                ? request.metadata.taskId === leasedTask.id
                : null
            }
            if (round === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.get")
              for (const [index, callId] of callIds.entries()) {
                yield {
                  type: "tool_call_completed", callId, name: "jobs.get",
                  arguments: { jobId: jobIds[index] },
                }
              }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const waitKey = task.goal === "Find at least two owner jobs"
              ? `p3-verifier-repair-initial-wait:${value.turnId}`
              : `p3-verifier-repair-wait:${value.turnId}`
            await waitForPersistedTaskWait(pool!, value.turnId, waitKey)
            const matchingToolResults = request.messages.flatMap(message => message.content)
              .filter(part => part.type === "tool_result" && callIds.includes(part.toolUseId))
            const parsedResults = callIds.map(callId => record(latestToolResult(request, callId)))
            if (task.goal === "Find at least two owner jobs") {
              initialScoutReadDiagnostic.matchingToolResultCount = matchingToolResults.length
              initialScoutReadDiagnostic.resultJsonParsed = parsedResults.every(result => result !== null)
              initialScoutReadDiagnostic.returnedJobCount = parsedResults.filter(result => record(result?.job) !== null).length
            }
            const selected = jobIds.map((expectedJobId, index) => {
              const job = record(parsedResults[index]?.job)
              return job?.id === expectedJobId ? job : null
            }).filter((job): job is RecordValue => job !== null)
            if (task.goal === "Find at least two owner jobs") {
              initialScoutReadDiagnostic.resolvedLookupCount = selected.length
              initialScoutReadDiagnostic.expectedJobPresent = selected.length === jobIds.length
            }
            if (selected.length !== jobIds.length || task.role !== "scout" && task.role !== "analyst") {
              throw new Error("repair fixture could not resolve its exact owner-scoped job reads")
            }
            const evidence = selected.map(job => {
              const jobId = String(job.id)
              return {
                id: "read:job:" + jobId,
                kind: "job",
                ref: jobId,
                source: typeof job.source === "string" ? job.source : "greenhouse",
              }
            })
            const structuredResult = task.role === "scout"
              ? {
                schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
                candidates: selected.map((job, index) => ({
                  jobId: String(job.id), source: evidence[index]!.source, url: null, evidenceIds: [evidence[index]!.id],
                })),
                evidence, summary: "Returned canonical owner-job evidence",
              }
              : {
                schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
                findings: selected.map((job, index) => ({
                  jobId: String(job.id), score: 8 + index / 10, evidenceIds: [evidence[index]!.id],
                })),
                evidence, summary: "Scored canonical owner-job evidence",
              }
            if (task.goal === "Find at least two owner jobs") initialScoutReadDiagnostic.structuredResultEmitted = true
            yield { type: "text_delta", text: JSON.stringify(structuredResult) }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime: rootRuntime, ownerId: value.ownerId,
      turnQueueFactory: createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-verifier-repair-wait-resolver-${value.suffix}` },
      subagents: { execute: async ({ lease }) => {
        const isInitialScout = lease.goal === "Find at least two owner jobs"
        if (isInitialScout) {
          initialScoutReadDiagnostic.sessionMatchesFixture = lease.sessionId === value.sessionId
          initialScoutReadDiagnostic.turnMatchesFixture = lease.turnId === value.turnId
          initialScoutReadDiagnostic.userMatchesFixture = lease.userId === value.userId
          childLeaseByTaskId.set(lease.id, lease)
        }
        try {
          if (lease.goal === "Recheck after new owner evidence is available") {
            const dependent = await pool!.query<{ id: string; status: string }>(`SELECT "id", "status" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "goal" = $3`, [value.turnId, value.sessionId, "Score only after Scout proof"])
            expect(dependent.rows).toHaveLength(1)
            expect(dependent.rows[0]?.status).toBe("waiting")
            const dispatch = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`, [value.sessionId, `subagent-dispatch:${dependent.rows[0]!.id}`])
            expect(dispatch.rowCount).toBe(0)
          }
          if (lease.goal === "Score only after Scout proof") {
            const repair = await pool!.query<{ id: string; status: string; result: unknown }>(`SELECT "id", "status", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "goal" = $3`, [value.turnId, value.sessionId, "Recheck after new owner evidence is available"])
            const repairResult = record(repair.rows[0]?.result)
            expect(repair.rows[0]?.status).toBe("completed")
            expectPassedVerificationReport(repairResult?.taskGraphVerificationReport, "candidate-count")
            expect(record(repairResult?.taskGraphRepairReceipt)).toMatchObject({ targetNodeKey: "scout", criterionIds: ["candidate-count"], repairNodeKey: "scout-repair", repairTaskId: repair.rows[0]?.id })
            const dispatch = await pool!.query<{ id: string }>(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`, [value.sessionId, `subagent-dispatch:${lease.id}`])
            expect(dispatch.rows).toHaveLength(1)
          }
          if (hardExecutorFailure && lease.goal === "Find at least two owner jobs") {
            await waitForSuspendedParent(pool!, value.turnId)
            return { status: "failed", failureReason: "Fixture hard child failure", retryDisposition: "terminal" }
          }
          return await childExecutor({ lease })
        } finally {
          if (isInitialScout) childLeaseByTaskId.delete(lease.id)
        }
      }, intervalMs: 10 },
    })
    await enqueueTurn(pool!, bootstrap.turns.queue, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
    try {
      await waitForTurnStatus(
        pool!, value.turnId, "completed", 90_000, initialWaitCallId, repairWaitCallIds,
      )
    } catch (error) {
      let progress = JSON.stringify({ available: false })
      let waitResults: RecordValue = { available: false }
      let rootFailure: RecordValue = { available: false }
      let verification: RecordValue = { available: false }
      let scoutResultDiagnostic: RecordValue = { available: false }
      try {
        const [initialWait, repairWait] = await Promise.all([
          scopedWaitToolResultDiagnostic(pool!, value, initialWaitCallId),
          scopedWaitToolResultDiagnostic(pool!, value, repairWaitCallIds.at(-1) ?? repairWaitCallId),
        ])
        waitResults = { initial: initialWait, repair: repairWait }
        const [failure, verdict] = await Promise.all([
          rootFailureDiagnostic(pool!, value.turnId),
          repairCycleVerificationDiagnostic(pool!, value.turnId),
        ])
        rootFailure = failure
        try { scoutResultDiagnostic = await collectCanonicalDiscoveryScoutResultDiagnostic(pool!, value, [firstJobId, secondJobId]) } catch { /* keep the fixed unavailable projection */ }
        verification = verdict
        progress = await turnProgressDiagnostics(
          pool!, value.turnId, initialWaitCallId, repairWaitCallIds,
        )
      } catch {
        // Keep only the fixed failure class if durable wait diagnostics are unavailable.
      }
      const failureMessage = error instanceof Error ? error.message : ""
      const failureKind = failureMessage.startsWith("TaskGraph root turn entered failed")
        ? "turn_failed"
        : failureMessage.startsWith("TaskGraph root turn did not reach") ? "turn_timeout" : "other"
      const repairStage = repairWaitSent ? "repair_wait_sent"
        : repairPlanSent ? "repair_plan_sent"
          : optimisticFinalAttempted ? "optimistic_final_attempted"
            : terminalGateLease ? "terminal_gate_preflight" : initialWaitSent ? "initial_wait_sent" : "initial_plan_sent"
      const privateWaitRead = privateWaitDiagnostics.latest()
      throw new Error(combineFailureDiagnostics([
        { label: "repairStage", value: repairStage, safeValue: repairStage },
        { label: "terminalGateLeaseCaptured", value: "", safeValue: String(Boolean(terminalGateLease)) },
        { label: "optimisticFinalAttempted", value: "", safeValue: String(optimisticFinalAttempted) },
        { label: "waitFailureKind", value: failureKind, safeValue: failureKind },
        { label: "privateWaitReaderOrigin", value: "", safeValue: privateWaitRead.origin },
        { label: "privateWaitReaderStage", value: "", safeValue: privateWaitRead.stage },
        { label: "privateWaitRowObservation", value: "", safeValue: privateWaitRead.rowObservation },
        { label: "repairWaitReferenceSizeBytes", value: "", safeValue: repairWaitReferenceSize === null ? "unknown" : String(repairWaitReferenceSize) },
        { label: "repairWaitFailureClass", value: "", safeValue: repairWaitFailure ?? "not_observed" },
        { label: "repairWaitFailureStage", value: "", safeValue: repairWaitFailureStage ?? "not_observed" },
        { label: "repairWaitFailureWaitOrdinal", value: "", safeValue: repairWaitFailureOrdinal === null ? "unavailable" : String(repairWaitFailureOrdinal) },
        { label: "repairWaitFailureReadCount", value: "", safeValue: repairWaitFailureReadCount === null ? "unavailable" : String(repairWaitFailureReadCount) },
        { label: "repairWaitFailureOutcomeStatus", value: "", safeValue: repairWaitFailureOutcomeStatus },
        { label: "repairWaitFailureErrorKind", value: "", safeValue: repairWaitErrorKind ?? "not_observed" },
        { label: "repairWaitReaderVisible", value: "", safeValue: repairWaitReaderVisible === null ? "not_checked" : String(repairWaitReaderVisible) },
        { label: "repairWaitReadCallCount", value: "", safeValue: String(Math.min(VERIFICATION_REPAIR_MAX_REFERENCE_READS, repairWaitReadCallIds.length)) },
        { label: "repairWaitResolutionReturned", value: "", safeValue: String(repairWaitResolutionReturned) },
        { label: "repairWaitResolvedOutcomeObserved", value: "", safeValue: String(repairWaitResolvedOutcomeObserved) },
        { label: "repairWaitReferenceObserved", value: "", safeValue: String(repairWaitReferenceObserved) },
        { label: "waitToolResults", value: "", safeValue: JSON.stringify(waitResults) },
        { label: "rootFailureEvidence", value: "", safeValue: JSON.stringify(rootFailure) },
        { label: "taskGraphVerdictEvidence", value: "", safeValue: JSON.stringify(verification) },
        { label: "scoutResultProjection", value: "", safeValue: JSON.stringify(scoutResultDiagnostic) },
        { label: "fixtureScoutRead", value: "", safeValue: JSON.stringify(initialScoutReadDiagnostic) },
      ], progress))
    }

    expect(optimisticFinalAttempted).toBe(true)
    expect(repairPlanSent).toBe(true)
    expect(repairWaitSent).toBe(true)
    if (!hardExecutorFailure) {
      expect(repairWaitCallIds.length).toBeLessThanOrEqual(VERIFICATION_REPAIR_MAX_WAIT_POLLS)
      expect(repairWaitStatuses).toHaveLength(repairWaitCallIds.length)
      expect(repairWaitStatuses.at(-1)).toBe("ready")
      expect(repairWaitStatuses.every(status => status === "ready" || status === "timed_out")).toBe(true)
      expect(repairWaitCallIds.length).toBe(repairWaitStatuses.filter(status => status === "timed_out").length + 1)
      expect(repairWaitReadCallIds.length).toBeLessThanOrEqual(VERIFICATION_REPAIR_MAX_REFERENCE_READS)
      expect(repairWaitReferenceObserved).toBe(repairWaitReadCallIds.length > 0)
    }
    expect(secondJobSeeded).toBe(true)
    const turn = await pool!.query<{ status: string; finalResponse: string | null; rootTaskId: string | null }>(`SELECT "status", "finalResponse", "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [value.turnId, value.sessionId])
    expect(turn.rows[0]?.status).toBe("completed")
    const finalResponse = JSON.parse(turn.rows[0]?.finalResponse ?? "null") as RecordValue
    expect(finalResponse.response).toBe(JSON.stringify({
      schemaVersion: "agent-harness.v2.final", response: "The verified shortlist is ready",
    }))
    const rootTaskId = turn.rows[0]?.rootTaskId
    expect(rootTaskId).toBeTruthy()
    const rejection = await pool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events" WHERE "turnId" = $1 AND "sessionId" = $2 AND "type" = 'final.rejected' AND "payload"->>'blocker' = 'task_graph_verification_unverified'`, [value.turnId, value.sessionId])
    expect(rejection.rowCount).toBeGreaterThan(0)
    const tasks = await pool!.query<{ id: string; goal: string; status: string; failureReason: string | null; result: unknown }>(`SELECT "id", "goal", "status", "failureReason", "result" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3`, [value.turnId, value.sessionId, rootTaskId])
    const original = tasks.rows.find(task => task.goal === "Find at least two owner jobs")
    const repaired = tasks.rows.find(task => task.goal === "Recheck after new owner evidence is available")
    const analyst = tasks.rows.find(task => task.goal === "Score only after Scout proof")
    const supplementalAnalysts = tasks.rows.filter(task => task.goal.startsWith("Score supplemental typed task "))
    expect(original).toMatchObject({
      status: "failed",
      failureReason: hardExecutorFailure ? "task_graph_verification_unverified" : "task_graph_verification_failed",
    })
    expect(record(record(original?.result)?.taskGraphVerificationReport)).toEqual(failedReportBeforeRepair)
    if (hardExecutorFailure) expectUnverifiedVerificationReport(failedReportBeforeRepair, "candidate-count")
    else expect(record(failedReportBeforeRepair)).toMatchObject({ status: "failed", reasonCode: "criterion_not_met" })
    expect(repaired).toMatchObject({ status: "completed", failureReason: null })
    expectPassedVerificationReport(record(repaired?.result)?.taskGraphVerificationReport, "candidate-count")
    const repairReceipt = record(record(repaired?.result)?.taskGraphRepairReceipt)
    expect(repairReceipt).toMatchObject({
      schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: rootTaskId,
      targetNodeKey: "scout", targetTaskId: original?.id, criterionIds: ["candidate-count"],
      repairNodeKey: "scout-repair", repairTaskId: repaired?.id, verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    })
    expect(String(repairReceipt?.evidenceDigest)).toMatch(/^[a-f0-9]{64}$/)
    expect(analyst).toMatchObject({ status: "completed", failureReason: null })
    expectPassedVerificationReport(record(analyst?.result)?.taskGraphVerificationReport, "finding-count")
    expect(supplementalAnalysts).toHaveLength(hardExecutorFailure ? 0 : 5)
    for (const supplemental of supplementalAnalysts) {
      expect(supplemental).toMatchObject({ status: "completed", failureReason: null })
      expectPassedVerificationReport(record(supplemental.result)?.taskGraphVerificationReport, "finding-count")
    }
    if (!terminalGateLease || !rootTaskId) throw new Error("repair fixture lost its terminal-gate identity")
    const persistedGraph = await pool!.query<{ revision: number }>(`SELECT "revision" FROM "agent_items"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
    [taskGraphItemId(rootTaskId), value.sessionId, value.turnId])
    const persistedRevision = Number(persistedGraph.rows[0]?.revision ?? 0)
    const terminalDecision = await checkTerminalTaskGraph(pool!, terminalGateLease, rootTaskId)
    expect(terminalDecision.ok).toBe(true)
    if (!terminalDecision.ok) throw new Error("repaired current TaskGraph did not pass its terminal gate")
    const binding = terminalDecision[TASK_GRAPH_FINAL_SUMMARY_BINDING]
    expect(binding).toBeDefined()
    expect(persistedRevision).toBeGreaterThan(0)
    expect(binding?.graphRevision).toBe(persistedRevision)
    expect(binding?.summary.graphRevision).toBe(persistedRevision)
    expect(JSON.stringify(terminalDecision)).toBe('{"ok":true}')
  }, 120_000)

  it("repairs an explicit 75-percent Analyst cohort after two of four findings, then completes its dependent", async () => {
    const [workerQueue, canonical, commandPortModule, turnQueueModule] = await Promise.all([
      import("../../queue/production-bootstrap.js"), import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"), import("../turns/turn-queue.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const value = coverageRepairOwner
    const ids = Array.from({ length: 4 }, (_, index) => fixtureJobId(value.suffix, index))
    turnQueueName = turnQueueModule.TURN_QUEUE_NAME
    childQueueName = (await import("../../queue/subagent-queue.js")).SUBAGENT_QUEUE_NAME
    await activateFixtureTurn(pool!, value)
    await pool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb
      WHERE "id" = $1 AND "sessionId" = $3 AND "userId" = $4`, [
      value.turnId, JSON.stringify({ goal: "Analyze at least 75 percent of the four jobs found by the Scout" }), value.sessionId, value.userId,
    ])
    for (let index = 0; index < ids.length; index++) {
      await pool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
        VALUES ($1, $2, $3, 'Software Engineer', 'Dublin', 'saved', $4, 'Coverage fixture source', 'greenhouse', CURRENT_TIMESTAMP)
        ON CONFLICT ("id") DO NOTHING`, [ids[index], value.userId, `Coverage Fixture ${index + 1}`, `https://jobs.example.invalid/${ids[index]}`])
    }

    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    const coverageVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "cohort-coverage", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout", minimumPercent: 75 } }],
    } as const
    const scoutVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 4 } }],
    } as const
    const finalVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
    } as const
    const planCallId = `p3-cohort-coverage-plan:${value.turnId}`
    const initialWaitCallId = `p3-cohort-coverage-initial-wait:${value.turnId}`
    const repairPlanCallId = `p3-cohort-coverage-repair-plan:${value.turnId}`
    const repairWaitCallId = `p3-cohort-coverage-repair-wait:${value.turnId}`
    const initialWaitKey = `p3-cohort-coverage-initial-wait:${value.turnId}`
    const repairWaitKey = `p3-cohort-coverage-repair-wait:${value.turnId}`
    let rootExecution = 0
    let initialTaskIds: string[] = []
    let targetTaskId = "", downstreamTaskId = "", repairTaskId = ""
    let failedCoverageObserved = false, repairAccepted = false, repairPassed = false, downstreamCompleted = false
    const runtime = await canonical.createCanonicalTurnRuntime(pool!, {
      workerId: value.ownerId, productionFlags: flags,
      taskGraphCommandPort: commandPortModule.createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: { ...TASK_GRAPH_TEMPLATES }, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => {
        const execution = ++rootExecution
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-explicit-cohort-coverage-root-fixture", profile,
          async *stream(request) {
            round += 1
            const graph = currentGraphFromRequest(request), nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
            const scout = nodes.find(node => node?.key === "scout")
            const analysis = nodes.find(node => node?.key === "analysis")
            const downstream = nodes.find(node => node?.key === "downstream")
            const repair = nodes.find(node => node?.key === "analysis-repair")
            if (execution === 1 && round === 1) {
              yield { type: "tool_call_completed", callId: planCallId, name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [
                  { key: "scout", templateId: "scout", goal: "Find four current engineering roles", successCriteria: ["Return four evidence-bound candidates"], dependsOn: [], verification: scoutVerification },
                  { key: "analysis", templateId: "analyst", goal: "Analyze findings covering at least 75 percent of the Scout cohort", successCriteria: ["Return findings for at least three of four candidates"], dependsOn: ["scout"], verification: coverageVerification },
                  { key: "downstream", templateId: "analyst", goal: "Continue only after the coverage target is repaired", successCriteria: ["Return one evidence-bound finding"], dependsOn: ["analysis"], verification: finalVerification },
                ],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              initialTaskIds = planTaskIds(request, planCallId, 3)
              targetTaskId = initialTaskIds[1]!
              downstreamTaskId = initialTaskIds[2]!
              yield { type: "tool_call_completed", callId: initialWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: initialWaitKey, taskIds: [targetTaskId], mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 1) {
              const outcome = waitOutcomeFromRequest(request, 1)
              expect(outcome.status).toBe("ready")
              const failedTask = record(outcome.tasks[0])
              expect(failedTask).toMatchObject({ taskId: targetTaskId, status: "failed", role: "analyst" })
              expect(record(failedTask?.verificationReport)).toMatchObject({ status: "failed", criteria: [{
                criterionId: "cohort-coverage", status: "failed", reasonCode: "criterion_not_met",
              }] })
              expect(scout).toMatchObject({ status: "completed" })
              expect(analysis).toMatchObject({ taskId: targetTaskId, status: "failed" })
              expect(downstream).toMatchObject({ taskId: downstreamTaskId, status: "waiting" })
              failedCoverageObserved = true
              if (!analysis?.taskId || typeof graph?.revision !== "number") throw new Error("Coverage fixture lost its current target identity")
              yield { type: "tool_call_completed", callId: repairPlanCallId, name: "agent.plan", arguments: {
                expectedRevision: graph.revision,
                nodes: [{ key: "analysis-repair", templateId: "analyst", goal: "Add the third evidence-bound cohort finding", successCriteria: ["Return findings for at least three of four candidates"], dependsOn: ["scout"], verification: coverageVerification,
                  repairOf: { nodeKey: "analysis", taskId: analysis.taskId, criterionIds: ["cohort-coverage"] } }],
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 2) {
              const repairIds = planTaskIds(request, repairPlanCallId, 1)
              repairTaskId = repairIds[0]!
              expect(repair).toMatchObject({ taskId: repairTaskId, status: "queued", repairOf: { nodeKey: "analysis", criterionIds: ["cohort-coverage"] } })
              expect(analysis).toMatchObject({ taskId: targetTaskId, status: "failed" })
              expect(downstream).toMatchObject({ taskId: downstreamTaskId, status: "waiting" })
              repairAccepted = true
              yield { type: "tool_call_completed", callId: repairWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: repairWaitKey, taskIds: [repairTaskId, downstreamTaskId], mode: "all", timeoutMs: 30_000,
              } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 3 && round === 1) {
              const outcome = waitOutcomeFromRequest(request, 2)
              expect(outcome.status).toBe("ready")
              expect(outcome.tasks.map(task => record(task)?.status)).toEqual(["completed", "completed"])
              expect(repair).toMatchObject({ taskId: repairTaskId, status: "completed" })
              expectPassedVerificationReport(repair?.verificationReport, "cohort-coverage")
              expect(record(repair?.repairReceipt)).toMatchObject({ targetNodeKey: "analysis", targetTaskId, criterionIds: ["cohort-coverage"] })
              expect(downstream).toMatchObject({ taskId: downstreamTaskId, status: "completed" })
              expectPassedVerificationReport(downstream?.verificationReport, "finding-count")
              repairPassed = true
              downstreamCompleted = true
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "The declared cohort coverage was verified after repair" }) }
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected cohort coverage root round ${execution}/${round}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const childExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        let round = 0
        const callId = `p3-cohort-coverage-search:${task.id}:${task.attemptCount}`
        const adapter: ModelAdapter = {
          id: `p3-cohort-coverage-${task.role}-child`, profile,
          async *stream(request) {
            round += 1
            if (round === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.search")
              yield { type: "tool_call_completed", callId, name: "jobs.search", arguments: { target: "Software Engineer", location: "Dublin", limit: 10 } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            const search = record(latestToolResult(request, callId))
            const jobs = Array.isArray(search?.jobs) ? search.jobs.map(record).filter((job): job is RecordValue => job !== null) : []
            const cohort = ids.map(id => jobs.find(job => job.id === id)).filter((job): job is RecordValue => job !== undefined)
            if (cohort.length !== 4) throw new Error("Coverage child did not observe the full four-job Scout cohort")
            const count = task.id === targetTaskId ? 2 : task.id === repairTaskId ? 3 : task.id === downstreamTaskId ? 1 : cohort.length
            const selected = cohort.slice(0, count)
            const evidence = selected.map(job => ({ id: `read:job:${job.id}`, kind: "job", ref: job.id, source: "greenhouse" }))
            const structuredResult = task.role === "scout"
              ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
                candidates: selected.map((job, index) => ({ jobId: job.id as string, source: evidence[index]!.source, url: null, evidenceIds: [evidence[index]!.id] })),
                evidence, summary: "Four current Scout candidates" }
              : task.role === "analyst"
                ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
                  findings: selected.map((job, index) => ({ jobId: job.id as string, score: 8, evidenceIds: [evidence[index]!.id] })),
                  evidence, summary: "Evidence-bound cohort findings" }
                : null
            if (!structuredResult) throw new Error("Coverage fixture received an unsupported task role")
            yield { type: "text_delta", text: JSON.stringify(structuredResult) }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime, ownerId: value.ownerId, turnQueueFactory: turnQueueModule.createTurnQueue,
      turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-cohort-coverage-resolver-${value.suffix}` },
      subagents: {
        execute: async () => { throw new Error("Coverage fixture manually executes only its scoped children") }, intervalMs: 10,
        queueFactory: () => {
          const queue = { add: async () => undefined, close: async () => undefined }, worker = { pause: async () => undefined, close: async () => undefined }
          return { queue, worker, close: async () => { await worker.close(); await queue.close() } } as never
        },
        recoveryFactory: () => ({ close: async () => undefined }) as never,
      },
    })
    await turnQueueModule.enqueueTurn(pool!, bootstrap.turns.queue, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
    await waitForPersistedTaskWait(pool!, value.turnId, initialWaitKey)
    expect(initialTaskIds).toHaveLength(3)
    const taskStore = new PgSubagentTaskStore(pool!)
    const executeChild = async (taskId: string, ownerId: string, expectedStatus: "completed" | "failed" = "completed") => {
      const claimed = await taskStore.claim({ taskId, sessionId: value.sessionId, ownerId, policy: defaultSubagentPolicy(), now: new Date() })
      if (!claimed) throw new Error("Coverage fixture child did not acquire its scoped task")
      const leaseExpiresAt = claimed.leaseExpiresAt
      if (!(leaseExpiresAt instanceof Date) || !Number.isFinite(leaseExpiresAt.getTime())) throw new Error("Coverage fixture child lease expired before execution")
      const lease: SubagentLease = { ...claimed, ownerId, leaseExpiresAt, signal: new AbortController().signal }
      const result = await childExecutor({ lease })
      const finished = await taskStore.finish({ taskId, sessionId: value.sessionId, ownerId, attemptCount: claimed.attemptCount,
        status: result.status, result: result.result, failureReason: result.failureReason, retryDisposition: result.retryDisposition,
        mailboxMessageIds: result.mailboxMessageIds, now: new Date() })
      expect(finished).toBe(expectedStatus)
    }
    await executeChild(initialTaskIds[0]!, `p3-cohort-scout-${value.suffix}`)
    await executeChild(targetTaskId, `p3-cohort-analyst-${value.suffix}`, "failed")
    await waitForPersistedTaskWait(pool!, value.turnId, repairWaitKey)
    expect(failedCoverageObserved).toBe(true)
    expect(repairAccepted).toBe(true)
    const repairPlan = await pool!.query<{ result: unknown; status: string }>(
      `SELECT task."result", task."status" FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3`,
      [repairTaskId, value.sessionId, value.turnId],
    )
    expect(repairPlan.rows[0]?.status).toBe("queued")
    await executeChild(repairTaskId, `p3-cohort-coverage-repair-${value.suffix}`)
    await executeChild(downstreamTaskId, `p3-cohort-downstream-${value.suffix}`)
    await waitForTurnStatus(pool!, value.turnId, "completed", 45_000, repairWaitKey)
    expect(repairPassed).toBe(true)
    expect(downstreamCompleted).toBe(true)
    const turn = await pool!.query<{ status: string; rootTaskId: string | null; finalResponse: string | null }>(
      `SELECT "status", "rootTaskId", "finalResponse" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [value.turnId, value.sessionId, value.userId],
    )
    expect(turn.rows[0]).toMatchObject({ status: "completed", finalResponse: expect.stringContaining("cohort coverage was verified") })
    const tasks = await pool!.query<{ id: string; goal: string; status: string; failureReason: string | null; result: unknown }>(
      `SELECT "id", "goal", "status", "failureReason", "result" FROM "sub_agent_tasks"
       WHERE "turnId" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3`, [value.turnId, value.sessionId, turn.rows[0]?.rootTaskId],
    )
    expect(tasks.rows).toHaveLength(4)
    const original = tasks.rows.find(task => task.id === targetTaskId), repaired = tasks.rows.find(task => task.id === repairTaskId)
    const downstream = tasks.rows.find(task => task.id === downstreamTaskId)
    expect(original).toMatchObject({ status: "failed", failureReason: "task_graph_verification_failed" })
    expect(record(record(original?.result)?.structuredResult)?.findings).toHaveLength(2)
    expect(record(original?.result)?.taskGraphVerificationReport).toMatchObject({ status: "failed", criteria: [{ criterionId: "cohort-coverage", status: "failed" }] })
    expect(repaired).toMatchObject({ status: "completed", failureReason: null })
    expect(record(record(repaired?.result)?.structuredResult)?.findings).toHaveLength(3)
    expectPassedVerificationReport(record(repaired?.result)?.taskGraphVerificationReport, "cohort-coverage")
    expect(record(record(repaired?.result)?.taskGraphRepairReceipt)).toMatchObject({
      targetNodeKey: "analysis", targetTaskId, criterionIds: ["cohort-coverage"], repairNodeKey: "analysis-repair", repairTaskId,
    })
    expect(downstream).toMatchObject({ status: "completed", failureReason: null })
    expectPassedVerificationReport(record(downstream?.result)?.taskGraphVerificationReport, "finding-count")
  }, 120_000)

  it("drains a fenced running TaskGraph child after root failure without changing root or Turn", async () => {
    const seedValue = fixture()
    const value = { ...seedValue, sessionId: `000-0-root-running-drain-${seedValue.suffix}` }
    try {
      await seed(pool!, value, "waiting_for_user", TASK_GRAPH_FIXTURE_TURN_LIMITS)
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const { createPgRootTaskStore } = await import("./root-task-store.js")
      const rootTasks = createPgRootTaskStore(pool!)
      const root = await rootTasks.ensure({
        lease, goal: "Drain a running child after root failure",
        allowedActions: TASK_GRAPH_TEMPLATES.analyst.allowedActions,
      })
      const stepId = `p3-running-drain-step-${value.suffix}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 0, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
      [stepId, value.sessionId, value.turnId, root.id])
      const graph = await createPgTaskGraphCommandPort(pool!).appendAndSchedule({
        scope: {
          userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
          rootTaskId: root.id, parentTaskId: root.id, stepId,
          turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
          parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
        },
        proposal: { expectedRevision: 0, nodes: [{
          key: "running", templateId: "analyst", goal: "Finish only while the root is active",
          successCriteria: ["Do not commit a result after root failure"], dependsOn: [], verification: ANALYST_VERIFICATION,
        }] },
        templates: { ...TASK_GRAPH_TEMPLATES },
      })
      const childId = graph.nodes.find(node => node.key === "running")?.taskId
      if (!childId) throw new Error("Running-drain TaskGraph fixture omitted its child")
      const store = new PgSubagentTaskStore(pool!, 300_000)
      const childOwner = `p3-running-drain-child-${value.suffix}`
      const running = await store.claim({
        taskId: childId, sessionId: value.sessionId, ownerId: childOwner,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!running?.leaseOwner || !running.leaseExpiresAt) throw new Error("Running-drain graph child did not acquire its lease")

      const failedAt = new Date()
      await rootTasks.finish({
        lease, rootTaskId: root.id,
        result: { status: "failed", stepCount: 1, toolCallCount: 0, errorCode: "fixture_root_failed" },
        now: failedAt,
      })
      const fencedChild = await store.get(childId, value.sessionId)
      expect(fencedChild).toMatchObject({
        status: "running", leaseOwner: childOwner, leaseExpiresAt: running.leaseExpiresAt,
        attemptCount: running.attemptCount, result: null, interruptRequestedAt: expect.any(Date),
      })
      const liveTurn = await pool!.query<{ status: string; rootTaskId: string | null; leaseOwnerId: string | null; leaseVersion: number }>(
        `SELECT "status", "rootTaskId", "leaseOwnerId", "leaseVersion" FROM "agent_turns"
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
        [value.turnId, value.sessionId, value.userId],
      )
      expect(liveTurn.rows).toEqual([{
        status: "in_progress", rootTaskId: root.id, leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion,
      }])
      await expect(store.finish({
        taskId: childId, sessionId: value.sessionId, ownerId: childOwner, attemptCount: running.attemptCount,
        status: "completed",
        result: { status: "completed", finalText: "late result", finalItemId: null, stepCount: 1, toolCallCount: 1 },
        now: new Date(),
      })).resolves.toBeNull()
      await expect(releaseTurnLease(pool!, lease, "failed", failedAt)).resolves.toBe(true)

      const expired = await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4
          AND "status" = 'running' AND "leaseOwner" = $5 AND "attemptCount" = $6 AND "interruptRequestedAt" IS NOT NULL
        RETURNING "id"`, [childId, value.sessionId, value.turnId, root.id, childOwner, running.attemptCount])
      expect(expired.rows).toEqual([{ id: childId }])
      const candidateHead = await pool!.query<{ fixtureOwnsHead: boolean }>(`SELECT
          (task."sessionId" = $1 AND task."id" = $2) AS "fixtureOwnsHead"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
          AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= clock_timestamp())
          AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
          AND (${rootRecoveryEligibility})
        ORDER BY task."sessionId", task."rootTaskId", task."id" LIMIT 1`, [value.sessionId, childId])
      expect(candidateHead.rows).toEqual([{ fixtureOwnsHead: true }])
      const rootAndTurn = () => pool!.query<{ root: RecordValue; turn: RecordValue }>(`SELECT to_jsonb(root) AS "root", to_jsonb(turn) AS "turn"
        FROM "sub_agent_tasks" AS root JOIN "agent_turns" AS turn
          ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
        WHERE root."id" = $1 AND root."sessionId" = $2 AND root."turnId" = $3
          AND root."rootTaskId" = root."id" AND turn."userId" = $4`,
      [root.id, value.sessionId, value.turnId, value.userId])
      const beforeRecovery = await rootAndTurn()
      expect(beforeRecovery.rows).toHaveLength(1)
      expect(beforeRecovery.rows[0]?.root).toMatchObject({ status: "failed", leaseOwner: null })
      expect(beforeRecovery.rows[0]?.turn).toMatchObject({ status: "failed", rootTaskId: root.id, leaseOwnerId: null })

      const recovered = await store.recoverExpired({ now: new Date(), limit: 1 })
      expect(recovered.map(task => task.id)).toEqual([childId])
      expect(recovered[0]).toMatchObject({ status: "interrupted", leaseOwner: null, leaseExpiresAt: null })
      const drained = await store.get(childId, value.sessionId)
      expect(drained).toMatchObject({ status: "interrupted", leaseOwner: null, leaseExpiresAt: null, result: null, interruptRequestedAt: expect.any(Date) })
      const receiptKey = taskGraphLifecycleKey(root.id, "running", running.attemptCount, "task.interrupted")
      const receipt = await pool!.query<{ type: string; payload: RecordValue }>(`SELECT "type", "payload" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "taskId" = $4 AND "idempotencyKey" = $5`,
      [value.sessionId, value.turnId, taskGraphItemId(root.id), childId, receiptKey])
      expect(receipt.rows).toHaveLength(1)
      expect(receipt.rows[0]).toMatchObject({ type: "item.delta", payload: { kind: "lifecycle", event: { type: "task.interrupted", nodeKey: "running" } } })
      const dispatch = await pool!.query(`SELECT 1 FROM "agent_outbox"
        WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
      [value.sessionId, `subagent-dispatch:${childId}`])
      expect(dispatch.rowCount).toBe(0)
      expect((await rootAndTurn()).rows).toEqual(beforeRecovery.rows)
    } finally {
      try {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      } finally {
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    }
  }, 30_000)

  it("skips an expired copied root lease before the recovery limit while its Turn remains owned", async () => {
    const value = rootRecoveryScanOwner
    try {
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const { createPgRootTaskStore } = await import("./root-task-store.js")
      const root = await createPgRootTaskStore(pool!).ensure({ lease, goal: "Keep the live Turn resumable" })
      expect(root.id).toBe(`root-${value.turnId}`)

      const store = new PgSubagentTaskStore(pool!)
      const child = await store.create({
        userId: value.userId,
        sessionId: value.sessionId,
        turnId: value.turnId,
        parentTaskId: root.id,
        role: "analyst",
        taskType: "analysis",
        goal: "Recover the expired ordinary child lease",
        policy: defaultSubagentPolicy(),
      })
      const childOwner = `p3-root-recovery-scan-child-${value.suffix}`
      const claimedChild = await store.claim({
        taskId: child.id, sessionId: value.sessionId, ownerId: childOwner,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      expect(claimedChild).toMatchObject({ id: child.id, status: "running", attemptCount: 1 })

      const [expiredRoot, expiredChild] = await Promise.all([
        pool!.query<{ id: string; leaseExpiresAt: Date }>(`UPDATE "sub_agent_tasks"
          SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '2 seconds', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1 AND "status" = 'running'
          RETURNING "id", "leaseExpiresAt"`, [root.id, value.sessionId, value.turnId]),
        pool!.query<{ id: string; attemptCount: number; maxAttempts: number }>(`UPDATE "sub_agent_tasks"
          SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second', "updatedAt" = CURRENT_TIMESTAMP
          WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "status" = 'running'
            AND "attemptCount" < "maxAttempts"
          RETURNING "id", "attemptCount", "maxAttempts"`, [child.id, value.sessionId, value.turnId, root.id]),
      ])
      expect(expiredRoot.rows).toHaveLength(1)
      expect(expiredChild.rows).toHaveLength(1)
      expect(expiredChild.rows[0]?.attemptCount).toBeLessThan(expiredChild.rows[0]!.maxAttempts)

      // Assert the live root owns the head of the global pre-filter candidate order; expose no other session or task IDs.
      const candidateHead = await pool!.query<{ fixtureOwnsHead: boolean }>(`SELECT
          (task."sessionId" = $1 AND task."id" = $2) AS "fixtureOwnsHead"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."status" = 'running'
          AND (session."status" IN ('aborted', 'archived') OR session."status" NOT IN ('aborted', 'archived'))
          AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= clock_timestamp())
          AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
        ORDER BY task."sessionId", task."rootTaskId", task."id" LIMIT 1`, [value.sessionId, root.id])
      expect(candidateHead.rows).toEqual([{ fixtureOwnsHead: true }])

      const recovered = await store.recoverExpired({ now: new Date(), limit: 1 })
      expect(recovered.map(task => task.id)).toEqual([child.id])
      expect(recovered[0]).toMatchObject({ id: child.id, status: "queued", leaseOwner: null, leaseExpiresAt: null })

      const rootAfter = await pool!.query<{ status: string; leaseOwner: string | null; leaseExpiresAt: Date | null; failureReason: string | null }>(
        `SELECT "status", "leaseOwner", "leaseExpiresAt", "failureReason" FROM "sub_agent_tasks"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1`,
        [root.id, value.sessionId, value.turnId],
      )
      expect(rootAfter.rows).toHaveLength(1)
      expect(rootAfter.rows[0]).toMatchObject({ status: "running", leaseOwner: value.ownerId, failureReason: null })
      expect(rootAfter.rows[0]!.leaseExpiresAt!.getTime()).toBeLessThan(Date.now())

      const turnAfter = await pool!.query<{ status: string; rootTaskId: string | null; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null }>(
        `SELECT "status", "rootTaskId", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns"
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [value.turnId, value.sessionId, value.userId],
      )
      expect(turnAfter.rows).toHaveLength(1)
      expect(turnAfter.rows[0]).toMatchObject({
        status: "in_progress", rootTaskId: root.id, leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion,
      })
      expect(turnAfter.rows[0]!.leaseExpiresAt!.getTime()).toBe(lease.leaseExpiresAt.getTime())
      expect(turnAfter.rows[0]!.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now())
    } finally {
      try {
        await pool!.query("DELETE FROM \"agent_outbox\" WHERE \"aggregateId\" = $1", [value.sessionId])
      } finally {
        await pool!.query("DELETE FROM \"User\" WHERE \"id\" = $1", [value.userId])
      }
    }
  }, 30_000)

  it("cleans only persisted graph members when recovery finds the exact failed root Turn", async () => {
    const seedValue = fixture()
    const value = { ...seedValue, sessionId: `000-!root-failed-cleanup-${seedValue.suffix}` }
    try {
      await seed(pool!, value, "waiting_for_user", TASK_GRAPH_FIXTURE_TURN_LIMITS)
      await activateFixtureTurn(pool!, value)
      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
      const { createPgRootTaskStore } = await import("./root-task-store.js")
      const rootTasks = createPgRootTaskStore(pool!)
      const root = await rootTasks.ensure({
        lease, goal: "Cancel queued graph work after its Turn fails",
        allowedActions: TASK_GRAPH_TEMPLATES.analyst.allowedActions,
      })
      const stepId = `p3-root-failed-cleanup-step-${value.suffix}`
      await pool!.query(`INSERT INTO "agent_steps"
        ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, 0, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
      [stepId, value.sessionId, value.turnId, root.id])
      const graph = await createPgTaskGraphCommandPort(pool!).appendAndSchedule({
        scope: {
          userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
          rootTaskId: root.id, parentTaskId: root.id, stepId,
          turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
          parentLeaseOwner: lease.ownerId, parentAttemptCount: root.attemptCount,
        },
        proposal: { expectedRevision: 0, nodes: [
          { key: "queued", templateId: "analyst", goal: "Cancel queued member", successCriteria: ["Wait for verified evidence"], dependsOn: [], verification: ANALYST_VERIFICATION },
          { key: "waiting", templateId: "analyst", goal: "Cancel waiting member", successCriteria: ["Wait for its prerequisite"], dependsOn: ["queued"], verification: ANALYST_VERIFICATION },
          { key: "running", templateId: "analyst", goal: "Fence running member", successCriteria: ["Do not commit after root failure"], dependsOn: [], verification: ANALYST_VERIFICATION },
        ] },
        templates: { ...TASK_GRAPH_TEMPLATES },
      })
      const taskIdFor = (key: string): string => {
        const taskId = graph.nodes.find(node => node.key === key)?.taskId
        if (!taskId) throw new Error(`Root-failed cleanup graph omitted ${key}`)
        return taskId
      }
      const queuedId = taskIdFor("queued")
      const waitingId = taskIdFor("waiting")
      const runningId = taskIdFor("running")
      const store = new PgSubagentTaskStore(pool!, 300_000)
      const runningOwner = `p3-root-failed-cleanup-child-${value.suffix}`
      const running = await store.claim({
        taskId: runningId, sessionId: value.sessionId, ownerId: runningOwner,
        policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!running?.leaseOwner) throw new Error("Root-failed cleanup graph child did not acquire its lease")

      const nonmember = await store.create({
        userId: value.userId, sessionId: value.sessionId, turnId: value.turnId, parentTaskId: root.id,
        role: "analyst", taskType: "analysis", goal: "Keep a nonmember child outside graph cleanup",
        policy: defaultSubagentPolicy(),
      })
      const nonmemberDispatchKey = `subagent-dispatch:${nonmember.id}`
      await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb)`,
      [randomUUID(), value.sessionId, nonmemberDispatchKey, JSON.stringify({
        taskId: nonmember.id, sessionId: value.sessionId, rootTaskId: root.id, ownerId: value.ownerId,
      })])

      const graphIds = [queuedId, waitingId, runningId]
      const graphBefore = await pool!.query<{ id: string; status: string; attemptCount: number }>(
        `SELECT "id", "status", "attemptCount" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "id" = ANY($2::text[])`,
        [value.sessionId, graphIds],
      )
      const graphBeforeById = new Map(graphBefore.rows.map(row => [row.id, row] as const))
      expect(graphBeforeById.get(queuedId)?.status).toBe("queued")
      expect(graphBeforeById.get(waitingId)?.status).toBe("waiting")
      expect(graphBeforeById.get(runningId)?.status).toBe("running")
      const queuedDispatchKey = `subagent-dispatch:${queuedId}`
      const queuedDispatch = await pool!.query(`SELECT 1 FROM "agent_outbox"
        WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
      [value.sessionId, queuedDispatchKey])
      expect(queuedDispatch.rowCount).toBe(1)
      const waitingDispatchKey = `subagent-dispatch:${waitingId}`
      await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt")
        VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb, CURRENT_TIMESTAMP)`,
      [randomUUID(), value.sessionId, waitingDispatchKey, JSON.stringify({
        taskId: waitingId, sessionId: value.sessionId, rootTaskId: root.id, ownerId: value.ownerId,
      })])
      const waitingPublishedDispatchBefore = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [value.sessionId, waitingDispatchKey],
      )
      expect(waitingPublishedDispatchBefore.rows).toHaveLength(1)
      expect(waitingPublishedDispatchBefore.rows[0]?.publishedAt).toEqual(expect.any(Date))
      const runningDispatchKey = `subagent-dispatch:${runningId}`
      const runningDispatchBefore = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [value.sessionId, runningDispatchKey],
      )
      expect(runningDispatchBefore.rows).toHaveLength(1)
      expect(runningDispatchBefore.rows[0]?.publishedAt).toBeNull()
      const nonmemberBefore = await pool!.query<{ task: RecordValue }>(
        `SELECT to_jsonb(task) AS "task" FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2`,
        [nonmember.id, value.sessionId],
      )
      expect(nonmemberBefore.rows).toHaveLength(1)

      const failedAt = new Date()
      await expect(releaseTurnLease(pool!, lease, "failed", failedAt)).resolves.toBe(true)
      const liveRootBeforeRecovery = await pool!.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1`,
      [root.id, value.sessionId, value.turnId])
      expect(liveRootBeforeRecovery.rows).toEqual([{ status: "running" }])
      const failedTurnBeforeRecovery = await pool!.query<{ turn: RecordValue }>(`SELECT to_jsonb(turn) AS "turn" FROM "agent_turns" AS turn
        WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4`,
      [value.turnId, value.sessionId, value.userId, root.id])
      expect(failedTurnBeforeRecovery.rows[0]?.turn).toMatchObject({ status: "failed", rootTaskId: root.id })

      const expiredRoot = await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1 AND "status" = 'running'
        RETURNING "id"`, [root.id, value.sessionId, value.turnId])
      expect(expiredRoot.rows).toEqual([{ id: root.id }])
      const candidateHead = await pool!.query<{ fixtureOwnsHead: boolean }>(`SELECT
          (task."sessionId" = $1 AND task."id" = $2) AS "fixtureOwnsHead"
        FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
        WHERE task."status" = 'running' AND (session."status" IN ('aborted', 'archived') OR ${RUNNABLE_SESSION})
          AND (task."leaseExpiresAt" IS NULL OR task."leaseExpiresAt" <= clock_timestamp())
          AND (task."nextAttemptAt" IS NULL OR task."nextAttemptAt" <= clock_timestamp())
          AND (${rootRecoveryEligibility})
        ORDER BY task."sessionId", task."rootTaskId", task."id" LIMIT 1`, [value.sessionId, root.id])
      expect(candidateHead.rows).toEqual([{ fixtureOwnsHead: true }])

      const recovered = await store.recoverExpired({ now: new Date(), limit: 1 })
      expect(recovered.map(task => ({ id: task.id, status: task.status }))).toEqual([{ id: root.id, status: "failed" }])
      expect(recovered[0]?.failureReason).toBe("Linked Turn failed before root lease recovery.")
      const graphAfter = await pool!.query<{ id: string; status: string; interruptRequestedAt: Date | null; leaseOwner: string | null }>(
        `SELECT "id", "status", "interruptRequestedAt", "leaseOwner" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "id" = ANY($2::text[])`,
        [value.sessionId, graphIds],
      )
      const graphAfterById = new Map(graphAfter.rows.map(row => [row.id, row] as const))
      expect(graphAfterById.get(queuedId)).toMatchObject({ status: "cancelled" })
      expect(graphAfterById.get(waitingId)).toMatchObject({ status: "cancelled" })
      expect(graphAfterById.get(runningId)).toMatchObject({ status: "running", leaseOwner: runningOwner, interruptRequestedAt: expect.any(Date) })

      for (const [key, taskId] of [["queued", queuedId], ["waiting", waitingId]] as const) {
        const attemptCount = graphBeforeById.get(taskId)?.attemptCount
        if (attemptCount === undefined) throw new Error(`Root-failed cleanup lost ${key} attempt count`)
        const receipt = await pool!.query<{ type: string; payload: RecordValue }>(`SELECT "type", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "taskId" = $4 AND "idempotencyKey" = $5`,
        [value.sessionId, value.turnId, taskGraphItemId(root.id), taskId, taskGraphLifecycleKey(root.id, key, attemptCount, "task.cancelled")])
        expect(receipt.rows).toHaveLength(1)
        expect(receipt.rows[0]).toMatchObject({ type: "item.delta", payload: { kind: "lifecycle", event: { type: "task.cancelled", nodeKey: key } } })
      }
      const graphDispatches = await pool!.query<{ idempotencyKey: string }>(`SELECT "idempotencyKey" FROM "agent_outbox"
        WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "publishedAt" IS NULL
          AND "idempotencyKey" = ANY($2::text[])`,
      [value.sessionId, [queuedId, waitingId].map(id => `subagent-dispatch:${id}`)])
      expect(graphDispatches.rowCount).toBe(0)
      const runningDispatchAfter = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [value.sessionId, runningDispatchKey],
      )
      expect(runningDispatchAfter.rows).toEqual(runningDispatchBefore.rows)
      const waitingPublishedDispatchAfter = await pool!.query<{ id: string; publishedAt: Date | null }>(
        `SELECT "id", "publishedAt" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2`,
        [value.sessionId, waitingDispatchKey],
      )
      expect(waitingPublishedDispatchAfter.rows).toEqual(waitingPublishedDispatchBefore.rows)
      const nonmemberAfter = await pool!.query<{ task: RecordValue }>(
        `SELECT to_jsonb(task) AS "task" FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2`,
        [nonmember.id, value.sessionId],
      )
      expect(nonmemberAfter.rows).toEqual(nonmemberBefore.rows)
      const nonmemberDispatch = await pool!.query(`SELECT 1 FROM "agent_outbox"
        WHERE "aggregateId" = $1 AND "topic" = 'agent.subagent.dispatch' AND "idempotencyKey" = $2 AND "publishedAt" IS NULL`,
      [value.sessionId, nonmemberDispatchKey])
      expect(nonmemberDispatch.rowCount).toBe(1)
      const runningInterruptionReceipt = await pool!.query(`SELECT 1 FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
          AND "payload"->'event'->>'type' = 'task.interrupted'`, [value.sessionId, value.turnId, runningId])
      expect(runningInterruptionReceipt.rowCount).toBe(0)
      const failedTurnAfterRecovery = await pool!.query<{ turn: RecordValue }>(`SELECT to_jsonb(turn) AS "turn" FROM "agent_turns" AS turn
        WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4`,
      [value.turnId, value.sessionId, value.userId, root.id])
      expect(failedTurnAfterRecovery.rows).toEqual(failedTurnBeforeRecovery.rows)
    } finally {
      try {
        await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      } finally {
        await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
      }
    }
  }, 30_000)

  it("recovers an exhausted typed TaskGraph lease into a wait-consumable report and admits its exact repair", async () => {
    const [workerQueue, canonical, commandPortModule, turnQueue, turnState, selectedJobPreparation, rootTaskStoreModule] = await Promise.all([
      import("../../queue/production-bootstrap.js"),
      import("../canonical-turn-runtime.js"),
      import("./pg-task-graph-command-port.js"),
      import("../turns/turn-queue.js"),
      import("../canonical-turn-state.js"),
      import("../selected-job-preparation.js"),
      import("./root-task-store.js"),
    ])
    const { createProductionChildExecutor } = await import("./production-child-runtime.js")
    const value = leaseRecoveryOwner
    const sourceGoal = "Read the fixture source before lease recovery"
    const dependentGoal = "Analyze only after the exact late repair receipt"
    const repairGoal = "Repair the exact unverified candidate count"
    const jobId = fixtureJobId(value.suffix)
    turnQueueName = turnQueue.TURN_QUEUE_NAME
    await activateFixtureTurn(pool!, value)
    await pool!.query(
      "INSERT INTO \"Job\" (\"id\", \"userId\", \"company\", \"role\", \"location\", \"status\", \"url\", \"description\", \"source\", \"updatedAt\") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP) ON CONFLICT (\"id\") DO NOTHING",
      [jobId, value.userId, "Lease Recovery Fixture", "Software Engineer", "Dublin", "saved", "https://jobs.example.invalid/lease-recovery", "Persisted lease recovery evidence", "greenhouse"],
    )
    const flags: ProductionAgentFlags = {
      taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true,
      consumeWaitOutcomes: true, canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false,
    }
    const profile = {
      provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
      continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
      supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
      supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
    }
    const planCallId = `p3-lease-recovery-plan:${value.turnId}`
    const initialWaitKey = `p3-lease-recovery-wait:${value.turnId}`
    const repairPlanCallId = `p3-lease-recovery-repair-plan:${value.turnId}`
    const repairWaitKey = `p3-lease-recovery-repair-wait:${value.turnId}`
    const repairWaitCallId = `p3-lease-recovery-repair-wait:${value.turnId}`
    const fixtureInvocationCounters: LeaseRecoveryFixtureDiagnostics = {
      modelRuntimeFactoryInvocations: 0, adapterStreamInvocations: 0,
      runtimeExecuteInvocations: 0, runtimeExecuteFailureClass: "none", startupStage: "not_started",
      adapterExecutionOrdinal: 0, adapterRoundOrdinal: 0, adapterBranch: "not_started", adapterStage: "not_started",
      repairPlanResult: missingLeaseRecoveryModelResult(), repairWaitResult: missingLeaseRecoveryModelResult(),
    }
    let initialWaitReportSeen = false
    let originalDependentTaskId = ""
    let repairTaskId = ""
    let repairReceiptReleasedOriginalDependent = false
    let rootCompletedAfterRepair = false
    let repairPlanAccepted = false
    const productionRootTaskStore = rootTaskStoreModule.createPgRootTaskStore(pool!)
    const runtimeResult = await canonical.createCanonicalTurnRuntime(pool!, {
      workerId: value.ownerId, productionFlags: flags,
      taskGraphCommandPort: commandPortModule.createPgTaskGraphCommandPort(pool!),
      taskGraphTemplates: { ...TASK_GRAPH_TEMPLATES },
      authorizeUsage: async () => ({ settle: async () => undefined }),
      stateLoader: async (statePool, lease, now, loaderOptions) => {
        fixtureInvocationCounters.startupStage = "state_loading"
        const state = await turnState.loadCanonicalTurnState(statePool, lease, now, loaderOptions)
        fixtureInvocationCounters.startupStage = "state_loaded"
        return state
      },
      selectedJobPreparationLoader: async (statePool, lease, now) => {
        fixtureInvocationCounters.startupStage = "selected_job_loading"
        const preparation = await selectedJobPreparation.loadSelectedJobPreparation(statePool, lease, now)
        fixtureInvocationCounters.startupStage = "selected_job_loaded"
        return preparation
      },
      rootTaskStore: {
        ...productionRootTaskStore,
        async ensure(input) {
          fixtureInvocationCounters.startupStage = "root_ensure_entered"
          try {
            const root = await productionRootTaskStore.ensure(input)
            fixtureInvocationCounters.startupStage = "root_ensure_returned"
            return root
          } catch (error: unknown) {
            fixtureInvocationCounters.startupStage = "root_ensure_failed"
            throw error
          }
        },
      },
      modelRuntimeFactory: () => {
        fixtureInvocationCounters.startupStage = "model_factory"
        const execution = ++fixtureInvocationCounters.modelRuntimeFactoryInvocations
        fixtureInvocationCounters.adapterExecutionOrdinal = Math.min(execution, 7)
        fixtureInvocationCounters.adapterRoundOrdinal = 0
        fixtureInvocationCounters.adapterBranch = "not_started"
        fixtureInvocationCounters.adapterStage = "not_started"
        let round = 0
        const adapter: ModelAdapter = {
          id: "p3-taskgraph-lease-recovery-root-fixture", profile,
          async *stream(request) {
            fixtureInvocationCounters.adapterStreamInvocations += 1
            fixtureInvocationCounters.repairPlanResult = leaseRecoveryModelResultFromRequest(request, repairPlanCallId)
            fixtureInvocationCounters.repairWaitResult = leaseRecoveryModelResultFromRequest(request, repairWaitCallId)
            round += 1
            fixtureInvocationCounters.adapterRoundOrdinal = Math.min(round, 7)
            fixtureInvocationCounters.adapterBranch = "unexpected"
            fixtureInvocationCounters.adapterStage = "stream_entered"
            if (execution === 1 && round === 1) {
              fixtureInvocationCounters.adapterBranch = "initial_plan"
              fixtureInvocationCounters.adapterStage = "branch_entered"
              fixtureInvocationCounters.adapterStage = "tool_call_emitted"
              yield { type: "tool_call_completed", callId: planCallId, name: "agent.plan", arguments: {
                expectedRevision: 0,
                nodes: [
                  { key: "scout", templateId: "scout", goal: sourceGoal, successCriteria: ["Return one evidence-bound candidate"], dependsOn: [], verification: SCOUT_VERIFICATION },
                  { key: "dependent", templateId: "analyst", goal: dependentGoal, successCriteria: ["Wait for the exact repair receipt"], dependsOn: ["scout"], verification: ANALYST_VERIFICATION },
                ],
              } }
              fixtureInvocationCounters.adapterStage = "completion_emitted"
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 1 && round === 2) {
              fixtureInvocationCounters.adapterBranch = "initial_wait"
              fixtureInvocationCounters.adapterStage = "branch_entered"
              const taskIds = planTaskIds(request, planCallId, 2)
              if (taskIds.length !== 2) throw new Error("Lease recovery fixture plan did not persist its dependent task")
              originalDependentTaskId = taskIds[1]!
              fixtureInvocationCounters.adapterStage = "graph_checked"
              fixtureInvocationCounters.adapterStage = "tool_call_emitted"
              yield { type: "tool_call_completed", callId: `p3-lease-recovery-initial-wait:${value.turnId}`, name: "agent.wait", arguments: {
                idempotencyKey: initialWaitKey, taskIds: [taskIds[0]!], mode: "all", timeoutMs: 30_000,
              } }
              fixtureInvocationCounters.adapterStage = "completion_emitted"
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 1) {
              fixtureInvocationCounters.adapterBranch = "repair_plan"
              fixtureInvocationCounters.adapterStage = "branch_entered"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const scout = nodes.find(node => node?.key === "scout")
              const dependent = nodes.find(node => node?.key === "dependent")
              expect(nodes.map(node => node?.key)).toEqual(["scout", "dependent"])
              expect(scout?.status).toBe("failed")
              expectUnverifiedVerificationReport(scout?.verificationReport, "candidate-count")
              expect(dependent).toMatchObject({ taskId: originalDependentTaskId, status: "waiting" })
              fixtureInvocationCounters.adapterStage = "graph_checked"
              const outcome = waitOutcomeFromRequest(request, 1)
              expect(outcome.status).toBe("ready")
              const waitedScout = outcome.tasks.map(record).find(task => task?.role === "scout")
              expect(waitedScout?.status).toBe("failed")
              expect(waitedScout?.taskId).toBe(scout?.taskId)
              expectUnverifiedVerificationReport(waitedScout?.verificationReport, "candidate-count")
              fixtureInvocationCounters.adapterStage = "outcome_checked"
              const liveDependent = await pool!.query<{ id: string; status: string; turnStatus: string }>(
                "SELECT task.\"id\", task.\"status\", turn.\"status\" AS \"turnStatus\" FROM \"sub_agent_tasks\" AS task JOIN \"agent_turns\" AS turn ON turn.\"id\" = task.\"turnId\" AND turn.\"sessionId\" = task.\"sessionId\" WHERE task.\"sessionId\" = $1 AND task.\"turnId\" = $2 AND task.\"goal\" = $3",
                [value.sessionId, value.turnId, dependentGoal],
              )
              expect(liveDependent.rows).toHaveLength(1)
              expect(liveDependent.rows[0]).toMatchObject({ id: originalDependentTaskId, status: "waiting" })
              expect(["queued", "in_progress", "waiting"]).toContain(liveDependent.rows[0]?.turnStatus)
              const noDependentDispatch = await pool!.query(
                "SELECT \"id\" FROM \"agent_outbox\" WHERE \"aggregateId\" = $1 AND \"topic\" = $2 AND \"idempotencyKey\" = $3",
                [value.sessionId, "agent.subagent.dispatch", "subagent-dispatch:" + originalDependentTaskId],
              )
              expect(noDependentDispatch.rowCount).toBe(0)
              const noPrematureCancellation = await pool!.query(
                "SELECT \"id\" FROM \"agent_events\" WHERE \"sessionId\" = $1 AND \"turnId\" = $2 AND \"taskId\" = $3 AND \"payload\"->>'kind' = $4 AND \"payload\"->'event'->>'type' = $5",
                [value.sessionId, value.turnId, originalDependentTaskId, "lifecycle", "task.cancelled"],
              )
              expect(noPrematureCancellation.rowCount).toBe(0)
              fixtureInvocationCounters.adapterStage = "database_checked"
              initialWaitReportSeen = true
              const root = await pool!.query<{ rootTaskId: string | null }>(
                `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
                [value.turnId, value.sessionId, value.userId],
              )
              const graphRootTaskId = root.rows[0]?.rootTaskId
              if (!graphRootTaskId || !scout?.taskId || typeof graph?.revision !== "number") throw new Error("Lease recovery fixture lost its graph identity")
              fixtureInvocationCounters.adapterStage = "tool_call_emitted"
              yield { type: "tool_call_completed", callId: repairPlanCallId, name: "agent.plan", arguments: {
                expectedRevision: graph.revision,
                nodes: [{ key: "scout-repair", templateId: "scout", goal: repairGoal, successCriteria: ["Return one evidence-bound candidate"], dependsOn: [], verification: SCOUT_VERIFICATION,
                  repairOf: { graphRootTaskId, nodeKey: "scout", taskId: scout.taskId, criterionIds: ["candidate-count"] } }],
              } }
              fixtureInvocationCounters.adapterStage = "completion_emitted"
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 2 && round === 2) {
              fixtureInvocationCounters.adapterBranch = "repair_wait"
              fixtureInvocationCounters.adapterStage = "branch_entered"
              const repairTaskIds = planTaskIds(request, repairPlanCallId, 1)
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              const repair = nodes.find(node => node?.key === "scout-repair")
              const dependent = nodes.find(node => node?.key === "dependent")
              expect(repairTaskIds).toHaveLength(1)
              repairTaskId = repairTaskIds[0]!
              expect(repair).toMatchObject({ status: "queued", repairOf: { nodeKey: "scout", criterionIds: ["candidate-count"] } })
              expect(dependent).toMatchObject({ taskId: originalDependentTaskId, status: "waiting" })
              fixtureInvocationCounters.adapterStage = "graph_checked"
              repairPlanAccepted = true
              fixtureInvocationCounters.adapterStage = "tool_call_emitted"
              yield { type: "tool_call_completed", callId: repairWaitCallId, name: "agent.wait", arguments: {
                idempotencyKey: repairWaitKey, taskIds: [repairTaskIds[0]!, originalDependentTaskId], mode: "all", timeoutMs: 30_000,
              } }
              fixtureInvocationCounters.adapterStage = "completion_emitted"
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            if (execution === 3 && round === 1) {
              fixtureInvocationCounters.adapterBranch = "final_proof"
              fixtureInvocationCounters.adapterStage = "branch_entered"
              const graph = currentGraphFromRequest(request)
              const nodes = Array.isArray(graph?.nodes) ? graph.nodes.map(record) : []
              fixtureInvocationCounters.adapterStage = "final_proof_graph_nodes"
              expect(nodes.map(node => node?.key)).toEqual(["scout", "dependent", "scout-repair"])
              const scout = nodes.find(node => node?.key === "scout")
              const dependent = nodes.find(node => node?.key === "dependent")
              const repair = nodes.find(node => node?.key === "scout-repair")
              fixtureInvocationCounters.adapterStage = "final_proof_node_statuses"
              expect(nodes.map(node => node?.status)).toEqual(["failed", "completed", "completed"])
              fixtureInvocationCounters.adapterStage = "final_proof_dependent_identity"
              expect(dependent?.taskId).toBe(originalDependentTaskId)
              fixtureInvocationCounters.adapterStage = "final_proof_dependent_report"
              expectPassedVerificationReport(dependent?.verificationReport, "finding-count")
              fixtureInvocationCounters.adapterStage = "final_proof_repair_report"
              expectPassedVerificationReport(repair?.verificationReport, "candidate-count")
              fixtureInvocationCounters.adapterStage = "graph_checked"
              fixtureInvocationCounters.adapterStage = "final_proof_repair_receipt"
              expect(record(repair?.repairReceipt)).toMatchObject({
                targetNodeKey: "scout", targetTaskId: scout?.taskId, criterionIds: ["candidate-count"],
                repairNodeKey: "scout-repair", repairTaskId: repair?.taskId,
              })
              fixtureInvocationCounters.adapterStage = "final_proof_wait_outcome"
              const outcome = waitOutcomeFromRequest(request, 2)
              expect(outcome.status).toBe("ready")
              const waitTasks = outcome.tasks.map(record)
              fixtureInvocationCounters.adapterStage = "final_proof_wait_task_statuses"
              expect(waitTasks.map(task => task?.status)).toEqual(["completed", "completed"])
              const repairWaitTask = waitTasks.find(task => task?.taskId === repair?.taskId)
              const dependentWaitTask = waitTasks.find(task => task?.taskId === originalDependentTaskId)
              fixtureInvocationCounters.adapterStage = "final_proof_repair_wait_report"
              expectPassedVerificationReport(repairWaitTask?.verificationReport, "candidate-count")
              fixtureInvocationCounters.adapterStage = "final_proof_dependent_wait_report"
              expectPassedVerificationReport(dependentWaitTask?.verificationReport, "finding-count")
              fixtureInvocationCounters.adapterStage = "outcome_checked"
              rootCompletedAfterRepair = true
              fixtureInvocationCounters.adapterStage = "final_output_emitted"
              yield { type: "text_delta", text: JSON.stringify({ schemaVersion: "agent-harness.v2.final", response: "Lease recovery repair unlocked the original dependent" }) }
              fixtureInvocationCounters.adapterStage = "completion_emitted"
              yield { type: "completed", finishReason: "stop" }
              return
            }
            throw new Error(`Unexpected lease recovery root turn ${execution}/${round}`)
          },
        }
        return { adapter, registry: {} as never, candidates: [] }
      },
    })
    const childExecutor = createProductionChildExecutor({
      pool: pool!, authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: ({ task }) => {
        let round = 0
        const callId = "p3-lease-recovery-search:" + task.id + ":" + task.attemptCount
        const adapter: ModelAdapter = {
          id: "p3-lease-recovery-" + task.role + "-child-fixture", profile,
          async *stream(request) {
            round += 1
            if (round === 1) {
              expect(request.tools.map(tool => record(tool)?.name)).toContain("jobs.search")
              yield { type: "tool_call_completed", callId, name: "jobs.search", arguments: { target: "Software Engineer", location: "Dublin", limit: 10 } }
              yield { type: "completed", finishReason: "tool_calls" }
              return
            }
            await waitForPersistedTaskWait(pool!, value.turnId, repairWaitKey)
            const search = record(latestToolResult(request, callId))
            const jobs = Array.isArray(search?.jobs)
              ? search.jobs.map(record).filter((job): job is RecordValue => job !== null)
              : []
            if (!jobs.some(job => job.id === jobId)) throw new Error("Lease recovery child could not observe its persisted fixture job")
            const evidence = { id: "read:job:" + jobId, kind: "job", ref: jobId, source: "greenhouse" }
            const structuredResult = task.role === "scout"
              ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId, source: evidence.source, url: null, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Returned the persisted lease recovery candidate" }
              : task.role === "analyst"
                ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId, score: 8.5, evidenceIds: [evidence.id] }], evidence: [evidence], summary: "Scored the persisted lease recovery candidate" }
                : null
            if (!structuredResult) throw new Error("Lease recovery fixture received an unsupported child role")
            yield { type: "text_delta", text: JSON.stringify(structuredResult) }
            yield { type: "completed", finishReason: "stop" }
          },
        }
        return adapter
      },
    })
    const runtime = {
      ...runtimeResult,
      execute: async (input: Parameters<typeof runtimeResult.execute>[0]) => {
        fixtureInvocationCounters.runtimeExecuteInvocations += 1
        try {
          return await runtimeResult.execute(input)
        } catch (error: unknown) {
          fixtureInvocationCounters.runtimeExecuteFailureClass = safeFailurePreflightErrorClass(error)
          throw error
        }
      },
    }
    bootstrap = await workerQueue.createProductionWorkerBootstrap({
      pool: pool!, runtime, ownerId: value.ownerId,
      turnQueueFactory: turnQueue.createTurnQueue, turnRecoveryIntervalMs: 100,
      waitResolver: { intervalMs: 10, batchSize: 10, ownerId: `p3-lease-recovery-wait-resolver-${value.suffix}` },
      // This test claims and expires the child lease itself. Keep the canonical
      // child-execution wiring present without starting a worker that could race it.
      subagents: {
        execute: async () => { throw new Error("Lease recovery fixture must not auto-execute child tasks") },
        intervalMs: 10,
        queueFactory: () => {
          const queue = { add: async () => undefined, close: async () => undefined }
          const worker = { pause: async () => undefined, close: async () => undefined }
          return {
            queue,
            worker,
            close: async () => { await worker.close(); await queue.close() },
          } as never
        },
        recoveryFactory: () => ({ close: async () => undefined }) as never,
      },
    })
    await turnQueue.enqueueTurn(pool!, bootstrap.turns.queue, { turnId: value.turnId, sessionId: value.sessionId, ownerId: value.ownerId })
    const persistedWait = await waitForPersistedTaskWait(
      pool!, value.turnId, initialWaitKey, 20_000, `p3-lease-recovery-initial-wait:${value.turnId}`,
      fixtureInvocationCounters,
    )
    const root = await pool!.query<{ rootTaskId: string | null }>(
      `SELECT "rootTaskId" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [value.turnId, value.sessionId, value.userId],
    )
    const rootTaskId = root.rows[0]?.rootTaskId
    if (!rootTaskId) throw new Error("Lease recovery fixture root task was not persisted")
    const target = await pool!.query<{ id: string; maxAttempts: number }>(
      `SELECT "id", "maxAttempts" FROM "sub_agent_tasks" WHERE "turnId" = $1 AND "sessionId" = $2 AND "rootTaskId" = $3 AND "goal" = $4`,
      [value.turnId, value.sessionId, rootTaskId, "Read the fixture source before lease recovery"],
    )
    expect(target.rows).toHaveLength(1)
    const targetTaskId = target.rows[0]!.id
    const store = new PgSubagentTaskStore(pool!)
    const claimed = await store.claim({ taskId: targetTaskId, sessionId: value.sessionId, ownerId: `p3-lease-recovery-child-${value.suffix}`, policy: defaultSubagentPolicy(), now: new Date() })
    expect(claimed).toMatchObject({ id: targetTaskId, status: "running" })
    const expired = await pool!.query<{ attemptCount: number; maxAttempts: number }>(
      `UPDATE "sub_agent_tasks" SET "attemptCount" = "maxAttempts", "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second'
       WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running' RETURNING "attemptCount", "maxAttempts"`,
      [targetTaskId, value.sessionId],
    )
    expect(expired.rows[0]?.attemptCount).toBe(expired.rows[0]?.maxAttempts)
    expect(expired.rows[0]?.maxAttempts).toBe(target.rows[0]!.maxAttempts)
    const recovered = await store.recoverExpired({ now: new Date(), limit: 10 })
    const recoveredTarget = recovered.find(task => task.id === targetTaskId)
    expect(recoveredTarget).toMatchObject({ status: "failed", failureReason: "task_graph_verification_unverified" })
    expectUnverifiedVerificationReport(record(recoveredTarget?.result)?.taskGraphVerificationReport, "candidate-count")

    await waitForPersistedTaskWait(
      pool!, value.turnId, repairWaitKey, 45_000, repairWaitCallId, fixtureInvocationCounters,
    )
    expect(initialWaitReportSeen).toBe(true)
    expect(repairPlanAccepted).toBe(true)
    expect(repairTaskId).not.toBe("")
    const waitingBeforeReceipt = await pool!.query<{ id: string; status: string }>(
      "SELECT \"id\", \"status\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3",
      [originalDependentTaskId, value.sessionId, value.turnId],
    )
    expect(waitingBeforeReceipt.rows).toEqual([{ id: originalDependentTaskId, status: "waiting" }])
    const repairBeforeReceipt = await pool!.query<{ status: string }>(
      "SELECT \"status\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3",
      [repairTaskId, value.sessionId, value.turnId],
    )
    expect(repairBeforeReceipt.rows).toEqual([{ status: "queued" }])
    const dependentDispatchBeforeReceipt = await pool!.query(
      "SELECT \"id\" FROM \"agent_outbox\" WHERE \"aggregateId\" = $1 AND \"topic\" = 'agent.subagent.dispatch' AND \"idempotencyKey\" = $2",
      [value.sessionId, "subagent-dispatch:" + originalDependentTaskId],
    )
    expect(dependentDispatchBeforeReceipt.rowCount).toBe(0)

    const executeAndFinishChild = async (taskId: string, ownerId: string) => {
      const claimedChild = await store.claim({
        taskId, sessionId: value.sessionId, ownerId, policy: defaultSubagentPolicy(), now: new Date(),
      })
      if (!claimedChild?.leaseExpiresAt) throw new Error("Lease recovery fixture could not claim child " + taskId)
      const lease: SubagentLease = {
        ...claimedChild, ownerId, leaseExpiresAt: claimedChild.leaseExpiresAt, signal: new AbortController().signal,
      }
      const result = await childExecutor({ lease })
      const finished = await store.finish({
        taskId, sessionId: value.sessionId, ownerId, attemptCount: claimedChild.attemptCount,
        status: result.status, result: result.result, failureReason: result.failureReason,
        retryDisposition: result.retryDisposition, mailboxMessageIds: result.mailboxMessageIds, now: new Date(),
      })
      if (finished !== "completed") {
        let itemCounts: RecordValue | null = null
        let toolErrorCodes: string[] = []
        try {
          const [counts, toolErrors] = await Promise.all([
            pool!.query<{ toolCallCount: number; toolResultCount: number; itemCount: number }>(
              `SELECT COUNT(*) FILTER (WHERE "type" = 'tool_call')::int AS "toolCallCount",
                      COUNT(*) FILTER (WHERE "type" = 'tool_result')::int AS "toolResultCount",
                      COUNT(*)::int AS "itemCount" FROM "agent_items"
               WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                 AND "type" IN ('tool_call', 'tool_result')`,
              [value.sessionId, value.turnId, taskId],
            ),
            pool!.query<{ errorCode: string }>(
              `SELECT DISTINCT "content"->>'errorCode' AS "errorCode" FROM "agent_items"
               WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
                 AND "type" = 'tool_result' AND "content"->>'errorCode' IS NOT NULL LIMIT 8`,
              [value.sessionId, value.turnId, taskId],
            ),
          ])
          itemCounts = {
            toolCalls: diagnosticBoundedCount(counts.rows[0]?.toolCallCount),
            toolResults: diagnosticBoundedCount(counts.rows[0]?.toolResultCount),
            total: diagnosticBoundedCount(counts.rows[0]?.itemCount),
          }
          toolErrorCodes = [...new Set(toolErrors.rows.map(row =>
            diagnosticEnum(row.errorCode, CHILD_OUTCOME_FAILURE_CODES) ?? "other"))].slice(0, 8)
        } catch {
          itemCounts = { unavailable: true }
          toolErrorCodes = []
        }
        const childResult = record(result) ?? {}
        const failureReasonClass = typeof childResult.failureReason === "string"
          ? diagnosticEnum(childResult.failureReason, CHILD_OUTCOME_FAILURE_CODES) ?? "other" : null
        const attemptBudgetExhausted = Number.isSafeInteger(claimedChild.attemptCount)
          && Number.isSafeInteger(claimedChild.maxAttempts)
          ? claimedChild.attemptCount >= claimedChild.maxAttempts : null
        const failureDiagnostic = {
          finished: diagnosticEnum(finished, new Set(["retrying", "failed", "waiting", "waiting_for_user", "interrupted"])) ?? "other",
          childStatus: diagnosticEnum(childResult.status, CHILD_OUTCOME_STATUSES) ?? "other",
          retryDisposition: diagnosticEnum(childResult.retryDisposition, CHILD_OUTCOME_RETRY_DISPOSITIONS),
          failureReasonClass,
          toolErrorCodes,
          attemptBudgetExhausted,
          itemCounts,
        }
        expect(finished, "Lease recovery child finish diagnostics=" + boundedDiagnostic(JSON.stringify(failureDiagnostic), 1_200))
          .toBe("completed")
      } else {
        expect(finished).toBe("completed")
      }
    }

    await executeAndFinishChild(repairTaskId, "p3-lease-recovery-repair-child-" + value.suffix)
    const completedRepair = await pool!.query<{ id: string; status: string; result: unknown }>(
      "SELECT \"id\", \"status\", \"result\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3",
      [repairTaskId, value.sessionId, value.turnId],
    )
    expect(completedRepair.rows).toHaveLength(1)
    expect(completedRepair.rows[0]).toMatchObject({ id: repairTaskId, status: "completed" })
    const repairResult = record(completedRepair.rows[0]?.result)
    expectPassedVerificationReport(repairResult?.taskGraphVerificationReport, "candidate-count")
    expect(record(repairResult?.taskGraphRepairReceipt)).toMatchObject({
      graphRootTaskId: rootTaskId, targetNodeKey: "scout", targetTaskId,
      criterionIds: ["candidate-count"], repairNodeKey: "scout-repair", repairTaskId,
    })
    expect(String(record(repairResult?.taskGraphRepairReceipt)?.evidenceDigest)).toMatch(/^[a-f0-9]{64}$/)

    const releasedDependent = await pool!.query<{ id: string; status: string }>(
      "SELECT \"id\", \"status\" FROM \"sub_agent_tasks\" WHERE \"id\" = $1 AND \"sessionId\" = $2 AND \"turnId\" = $3",
      [originalDependentTaskId, value.sessionId, value.turnId],
    )
    expect(releasedDependent.rows).toEqual([{ id: originalDependentTaskId, status: "queued" }])
    const dependentDispatchAfterReceipt = await pool!.query<{ id: string }>(
      "SELECT \"id\" FROM \"agent_outbox\" WHERE \"aggregateId\" = $1 AND \"topic\" = 'agent.subagent.dispatch' AND \"idempotencyKey\" = $2",
      [value.sessionId, "subagent-dispatch:" + originalDependentTaskId],
    )
    expect(dependentDispatchAfterReceipt.rows).toHaveLength(1)
    repairReceiptReleasedOriginalDependent = true

    await executeAndFinishChild(originalDependentTaskId, "p3-lease-recovery-dependent-child-" + value.suffix)
    await waitForTurnStatus(pool!, value.turnId, "completed", 45_000, "p3-lease-recovery-repair-wait")
    expect(rootCompletedAfterRepair).toBe(true)
    const consumedWait = await pool!.query<{ consumedAt: Date | null; result: unknown }>(
      `SELECT "consumedAt", "result" FROM "agent_wait_conditions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4`,
      [persistedWait.id, value.userId, value.sessionId, value.turnId],
    )
    expect(consumedWait.rows[0]?.consumedAt).toEqual(expect.any(Date))
    expect(repairReceiptReleasedOriginalDependent).toBe(true)
    const consumedOutcome = record(record(consumedWait.rows[0]?.result)?.outcome)
    const consumedScout = Array.isArray(consumedOutcome?.tasks) ? consumedOutcome.tasks.map(record).find(task => task?.role === "scout") : null
    expectUnverifiedVerificationReport(consumedScout?.verificationReport, "candidate-count")
    const finalTurn = await pool!.query<{ status: string; rootTaskId: string | null; finalResponse: string | null }>(
      "SELECT \"status\", \"rootTaskId\", \"finalResponse\" FROM \"agent_turns\" WHERE \"id\" = $1 AND \"sessionId\" = $2",
      [value.turnId, value.sessionId],
    )
    expect(finalTurn.rows[0]?.status).toBe("completed")
    expect(finalTurn.rows[0]?.finalResponse).toContain("Lease recovery repair unlocked the original dependent")
    expect(finalTurn.rows[0]?.rootTaskId).toBe(rootTaskId)
    const completedTasks = await pool!.query<{ id: string; goal: string; status: string; failureReason: string | null; result: unknown }>(
      "SELECT \"id\", \"goal\", \"status\", \"failureReason\", \"result\" FROM \"sub_agent_tasks\" WHERE \"turnId\" = $1 AND \"sessionId\" = $2 AND \"parentTaskId\" = $3",
      [value.turnId, value.sessionId, rootTaskId],
    )
    expect(completedTasks.rows).toHaveLength(3)
    const sourceTask = completedTasks.rows.find(task => task.goal === sourceGoal)
    const dependentTask = completedTasks.rows.find(task => task.goal === dependentGoal)
    const repairTask = completedTasks.rows.find(task => task.goal === repairGoal)
    expect(sourceTask).toMatchObject({ id: targetTaskId, status: "failed", failureReason: "task_graph_verification_unverified" })
    expectUnverifiedVerificationReport(record(sourceTask?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(dependentTask).toMatchObject({ id: originalDependentTaskId, status: "completed", failureReason: null })
    expectPassedVerificationReport(record(dependentTask?.result)?.taskGraphVerificationReport, "finding-count")
    expect(repairTask).toMatchObject({ id: repairTaskId, status: "completed", failureReason: null })
    expectPassedVerificationReport(record(repairTask?.result)?.taskGraphVerificationReport, "candidate-count")
    expect(record(record(repairTask?.result)?.taskGraphRepairReceipt)).toMatchObject({
      graphRootTaskId: rootTaskId, targetNodeKey: "scout", targetTaskId,
      criterionIds: ["candidate-count"], repairNodeKey: "scout-repair", repairTaskId,
    })
    expect(rootCompletedAfterRepair).toBe(true)
  }, 90_000)

  it("stops an exact TaskGraph Turn, projects interrupted receipts, and removes every unpublished graph dispatch", async () => {
    const { taskGraphItemId } = await import("./task-graph-snapshot.js")
    const rootTaskId = "p3-task-graph-stop-root-" + stopOwner.suffix
    const stepId = "p3-task-graph-stop-step-" + stopOwner.suffix
    const runningOwnerId = "p3-task-graph-stop-child-owner-" + stopOwner.suffix
    const now = new Date()
    const unrelatedTurnBefore = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    expect(unrelatedTurnBefore.rowCount).toBe(1)
    await activateFixtureTurn(pool!, stopOwner)

    await pool!.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
       "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
       "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Stop acceptance root',
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
        1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
    [rootTaskId, stopOwner.sessionId, stopOwner.turnId, stopOwner.ownerId])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [rootTaskId])
    const activeTurn = await pool!.query<{ revision: number }>(
      `UPDATE "agent_turns" SET "status" = 'in_progress', "rootTaskId" = $4, "leaseOwnerId" = $5,
        "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes', "leaseStartedAt" = CURRENT_TIMESTAMP,
        "leaseVersion" = 1, "updatedAt" = CURRENT_TIMESTAMP
       WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'queued'
       RETURNING "revision"`,
      [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId, rootTaskId, stopOwner.ownerId],
    )
    expect(activeTurn.rowCount).toBe(1)
    await pool!.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [stepId, stopOwner.sessionId, stopOwner.turnId, rootTaskId])

    const commandPort = createPgTaskGraphCommandPort(pool!)
    const receipt = await commandPort.appendAndSchedule({
      scope: {
        userId: stopOwner.userId, sessionId: stopOwner.sessionId, turnId: stopOwner.turnId,
        rootTaskId, parentTaskId: rootTaskId, stepId,
        turnLeaseOwner: stopOwner.ownerId, turnLeaseVersion: 1,
        parentLeaseOwner: stopOwner.ownerId, parentAttemptCount: 1,
      },
      proposal: {
        expectedRevision: 0,
        nodes: [
          { key: "running", templateId: "analyst", goal: "Run until the Turn is stopped", successCriteria: ["Observe the Stop marker"], dependsOn: [], verification: ANALYST_VERIFICATION },
          { key: "pending-root", templateId: "analyst", goal: "Start a pending dependency chain", successCriteria: ["Remain queued"], dependsOn: [], verification: ANALYST_VERIFICATION },
          { key: "pending-child", templateId: "analyst", goal: "Wait for the chain root", successCriteria: ["Remain waiting"], dependsOn: ["pending-root"], verification: ANALYST_VERIFICATION },
          { key: "pending-grandchild", templateId: "analyst", goal: "Wait for the chain child", successCriteria: ["Remain waiting"], dependsOn: ["pending-child"], verification: ANALYST_VERIFICATION },
        ],
      },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    })
    expect(receipt.status).toBe("accepted")
    expect(receipt.nodes.map(node => [node.key, node.status])).toEqual([
      ["running", "queued"], ["pending-root", "queued"], ["pending-child", "waiting"], ["pending-grandchild", "waiting"],
    ])
    const graphTaskIds = receipt.nodes.map(node => node.taskId)
    const taskIdByKey = new Map(receipt.nodes.map(node => [node.key, node.taskId] as const))

    const subagents = new PgSubagentTaskStore(pool!)
    const runningTask = await subagents.claim({
      taskId: taskIdByKey.get("running")!, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now,
    })
    expect(runningTask).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: runningOwnerId })

    const unrelatedOutboxIds = [
      "p3-stop-unrelated-same-session-" + stopOwner.suffix,
      "p3-stop-unrelated-other-session-" + stopOwner.suffix,
    ]
    await pool!.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
      VALUES ($1, 'agent.subagent.dispatch', $2, $3, $4::jsonb), ($5, 'agent.subagent.dispatch', $6, $7, $8::jsonb)`,
    [
      unrelatedOutboxIds[0], stopOwner.sessionId, "subagent-dispatch:unrelated-" + stopOwner.suffix,
      JSON.stringify({ taskId: "unrelated-" + stopOwner.suffix, sessionId: stopOwner.sessionId, rootTaskId, ownerId: "fixture-owner" }),
      unrelatedOutboxIds[1], owner.sessionId, "subagent-dispatch:unrelated-other-" + stopOwner.suffix,
      JSON.stringify({ taskId: "unrelated-other-" + stopOwner.suffix, sessionId: owner.sessionId, rootTaskId: "other-root", ownerId: "fixture-owner" }),
    ])

    const client = await pool!.connect()
    const requestedAt = new Date()
    let priorTurnRevision = 0
    try {
      await client.query("BEGIN")
      await client.query("SELECT set_config('app.user_id', $1, true)", [stopOwner.userId])
      const current = await client.query<{ revision: number }>(
        `SELECT "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR UPDATE`,
        [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId],
      )
      expect(current.rowCount).toBe(1)
      priorTurnRevision = Number(current.rows[0]?.revision)
      const interruptedTurn = await client.query(
        `UPDATE "agent_turns" SET "status" = 'interrupted', "revision" = "revision" + 1,
          "completedAt" = $5, "updatedAt" = $5
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3
           AND "status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
           AND "revision" = $4`,
        [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId, priorTurnRevision, requestedAt],
      )
      expect(interruptedTurn.rowCount).toBe(1)
      const markedTasks = await client.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(
        `UPDATE "sub_agent_tasks" AS task
         SET "interruptRequestedAt" = COALESCE(task."interruptRequestedAt", $4),
             "status" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN 'interrupted' ELSE task."status" END,
             "nextAttemptAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN NULL ELSE task."nextAttemptAt" END,
             "completedAt" = CASE WHEN task."status" IN ('queued', 'retrying', 'waiting', 'waiting_for_user') THEN $4 ELSE task."completedAt" END,
             "updatedAt" = $4
         WHERE task."sessionId" = $1 AND task."turnId" = $2
           AND task."status" IN ('queued', 'running', 'retrying', 'waiting', 'waiting_for_user')
           AND EXISTS (SELECT 1 FROM "agent_sessions" AS session
             WHERE session."id" = task."sessionId" AND session."userId" = $3)
           AND EXISTS (SELECT 1 FROM "agent_turns" AS turn
             WHERE turn."id" = task."turnId" AND turn."sessionId" = task."sessionId" AND turn."userId" = $3)
         RETURNING task."id", task."status", task."interruptRequestedAt"`,
        [stopOwner.sessionId, stopOwner.turnId, stopOwner.userId, requestedAt],
      )
      expect(markedTasks.rows).toHaveLength(graphTaskIds.length + 1)
      const stopIntent = await client.query<{ id: string; topic: string; aggregateId: string; idempotencyKey: string; payload: RecordValue }>(
        `INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
         VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING
         RETURNING "id", "topic", "aggregateId", "idempotencyKey", "payload"`,
        [
          "task-graph-stop-" + stopOwner.turnId, TASK_GRAPH_STOP_OUTBOX_TOPIC, stopOwner.sessionId,
          "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
          JSON.stringify({ sessionId: stopOwner.sessionId, turnId: stopOwner.turnId }),
        ],
      )
      expect(stopIntent.rows).toEqual([{
        id: "task-graph-stop-" + stopOwner.turnId,
        topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
        aggregateId: stopOwner.sessionId,
        idempotencyKey: "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
        payload: { sessionId: stopOwner.sessionId, turnId: stopOwner.turnId },
      }])
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally {
      client.release()
    }

    expect(await drainTaskGraphStopOutbox(pool!, 10)).toBe(1)
    const stopIntentState = await pool!.query<{ topic: string; aggregateId: string; idempotencyKey: string; payload: RecordValue; publishedAt: Date | null }>(
      `SELECT "topic", "aggregateId", "idempotencyKey", "payload", "publishedAt" FROM "agent_outbox"
       WHERE "id" = $1`,
      ["task-graph-stop-" + stopOwner.turnId],
    )
    expect(stopIntentState.rows[0]).toMatchObject({
      topic: TASK_GRAPH_STOP_OUTBOX_TOPIC,
      aggregateId: stopOwner.sessionId,
      idempotencyKey: "agent-task-graph-stop:" + stopOwner.sessionId + ":" + stopOwner.turnId,
      payload: { sessionId: stopOwner.sessionId, turnId: stopOwner.turnId },
      publishedAt: expect.any(Date),
    })

    expect(runningTask).not.toBeNull()
    await expect(subagents.heartbeat({
      taskId: runningTask!.id, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      attemptCount: runningTask!.attemptCount, now: new Date(),
    })).resolves.toBe("interrupted")
    await expect(subagents.finish({
      taskId: runningTask!.id, sessionId: stopOwner.sessionId, ownerId: runningOwnerId,
      attemptCount: runningTask!.attemptCount, status: "completed", result: { proof: "stop marker observed" }, now: new Date(),
    })).resolves.toBe("interrupted")

    const turn = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [stopOwner.turnId, stopOwner.sessionId, stopOwner.userId],
    )
    expect(turn.rows[0]).toEqual({ status: "interrupted", revision: priorTurnRevision + 1 })
    const stoppedTasks = await pool!.query<{ id: string; status: string; interruptRequestedAt: Date | null }>(
      `SELECT "id", "status", "interruptRequestedAt" FROM "sub_agent_tasks"
       WHERE "id" = ANY($1::text[]) AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
       ORDER BY "id"`,
      [graphTaskIds, stopOwner.sessionId, stopOwner.turnId, rootTaskId],
    )
    expect(stoppedTasks.rows).toHaveLength(graphTaskIds.length)
    expect(stoppedTasks.rows.every(task => task.status === "interrupted" && task.interruptRequestedAt instanceof Date)).toBe(true)
    const rootMarker = await pool!.query<{ status: string; interruptRequestedAt: Date | null }>(
      `SELECT "status", "interruptRequestedAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
      [rootTaskId, stopOwner.sessionId, stopOwner.turnId],
    )
    expect(rootMarker.rows[0]?.status).toBe("running")
    expect(rootMarker.rows[0]?.interruptRequestedAt).toBeInstanceOf(Date)
    const unrelatedTurnAfter = await pool!.query<{ status: string; revision: number }>(
      `SELECT "status", "revision" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [owner.turnId, owner.sessionId, owner.userId],
    )
    expect(unrelatedTurnAfter.rows).toEqual(unrelatedTurnBefore.rows)

    const graphItemId = taskGraphItemId(rootTaskId)
    const graphItem = await pool!.query<{ revision: number }>(
      `SELECT "revision" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'task_graph'`,
      [graphItemId, stopOwner.sessionId, stopOwner.turnId, rootTaskId],
    )
    expect(graphItem.rows[0]?.revision).toBe(receipt.revision + 1 + graphTaskIds.length)
    const graphEvents = await pool!.query<{ taskId: string | null; idempotencyKey: string; payload: RecordValue }>(
      `SELECT "taskId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "type" = 'item.delta'
       ORDER BY "sequence" ASC`,
      [stopOwner.sessionId, stopOwner.turnId, graphItemId],
    )
    const interruptedReceipts = graphEvents.rows.flatMap(row => {
      const payload = record(row.payload)
      const event = record(payload?.event)
      return payload?.kind === "lifecycle" && event?.type === "task.interrupted"
        ? [{ taskId: row.taskId, idempotencyKey: row.idempotencyKey, revision: payload.revision, expectedRevision: event.expectedRevision, nodeKey: event.nodeKey }]
        : []
    })
    expect(interruptedReceipts).toHaveLength(graphTaskIds.length)
    expect(interruptedReceipts.map(receipt => receipt.nodeKey)).toEqual(["pending-root", "pending-child", "pending-grandchild", "running"])
    expect(interruptedReceipts.map(receipt => receipt.expectedRevision)).toEqual([
      receipt.revision + 1, receipt.revision + 2, receipt.revision + 3, receipt.revision + 4,
    ])
    expect(interruptedReceipts.map(receipt => receipt.revision)).toEqual([
      receipt.revision + 2, receipt.revision + 3, receipt.revision + 4, receipt.revision + 5,
    ])
    expect(interruptedReceipts.map(receipt => receipt.idempotencyKey)).toEqual([
      taskGraphLifecycleKey(rootTaskId, "pending-root", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "pending-child", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "pending-grandchild", 0, "task.interrupted"),
      taskGraphLifecycleKey(rootTaskId, "running", 1, "task.interrupted"),
    ])

    const graphDispatches = await pool!.query(
      `SELECT "id" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
       AND "aggregateId" = $1 AND "idempotencyKey" = ANY($2::text[]) AND "publishedAt" IS NULL`,
      [stopOwner.sessionId, graphTaskIds.map(taskId => "subagent-dispatch:" + taskId)],
    )
    expect(graphDispatches.rowCount).toBe(0)
    const unrelatedOutbox = await pool!.query<{ id: string; aggregateId: string; publishedAt: Date | null }>(
      `SELECT "id", "aggregateId", "publishedAt" FROM "agent_outbox" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [unrelatedOutboxIds],
    )
    expect(unrelatedOutbox.rows).toHaveLength(unrelatedOutboxIds.length)
    expect(unrelatedOutbox.rows.map(row => row.id)).toEqual([...unrelatedOutboxIds].sort())
    expect(unrelatedOutbox.rows.every(row => row.publishedAt === null)).toBe(true)
    const unrelatedAggregateById = new Map(unrelatedOutbox.rows.map(row => [row.id, row.aggregateId] as const))
    expect(unrelatedAggregateById.get(unrelatedOutboxIds[0]!)).toBe(stopOwner.sessionId)
    expect(unrelatedAggregateById.get(unrelatedOutboxIds[1]!)).toBe(owner.sessionId)
  }, 30_000)

  it("wakes the same root on accepted steering, then consumes it on the next ordinary step", async () => {
    const value = fixture(), steerText = `Use the latest EU market evidence ${value.suffix}`
    try {
      const prepared = await prepareSuspendedSteerWait(pool!, value)
      const accepted = await seedAcceptedSteer(pool!, value, steerText)
      expect(BigInt(accepted.sequence)).toBeGreaterThan(0n)
      const firstScan = await reconcileDurableWaits(pool!, { ownerId: `p3-steer-resolver-${value.suffix}` })
      expect(firstScan.scanned).toBeGreaterThan(0)
      const resumed = await pool!.query<{ status: string; rootTaskId: string | null }>(
        `SELECT turn."status", turn."rootTaskId" FROM "agent_turns" AS turn
         WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3`,
        [value.turnId, value.sessionId, value.userId],
      )
      expect(resumed.rows[0]).toEqual({ status: "queued", rootTaskId: prepared.root.id })
      const waitState = await pool!.query<{ status: string; matchedTaskIds: string[] }>(
        `SELECT "status", "matchedTaskIds" FROM "agent_wait_conditions"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [prepared.wait.waitId, value.sessionId, value.turnId],
      )
      expect(waitState.rows[0]).toMatchObject({ status: "interrupted", matchedTaskIds: [] })
      const childState = await pool!.query<{ status: string }>(
        `SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
        [prepared.child.id, value.sessionId, value.turnId],
      )
      expect(childState.rows[0]?.status).toBe("queued")
      const resumedEvents = await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "type" = 'turn.resumed' AND "idempotencyKey" = $3`,
      [value.sessionId, value.turnId, `agent-wait:${prepared.wait.waitId}:resumed`])
      const dispatches = await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.turn.dispatch'
        AND "idempotencyKey" = $2`, [value.sessionId, `turn-dispatch:${value.turnId}`])
      expect(resumedEvents.rowCount).toBe(1)
      expect(dispatches.rowCount).toBe(1)
      await reconcileDurableWaits(pool!, { ownerId: `p3-steer-resolver-replay-${value.suffix}` })
      expect((await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "type" = 'turn.resumed' AND "idempotencyKey" = $3`,
      [value.sessionId, value.turnId, `agent-wait:${prepared.wait.waitId}:resumed`])).rowCount).toBe(1)

      const lease = await claimTurnLease(pool!, { turnId: value.turnId, sessionId: value.sessionId, ownerId: `${value.ownerId}-resumed` })
      const state = await loadCanonicalTurnState(pool!, lease, new Date(), { consumeWaitOutcomes: true })
      const observationId = `wait-result:${prepared.wait.waitId}`
      const observation = state.snapshot.toolObservations.find(item => item.id === observationId)
      expect(observation?.content).toMatchObject({
        toolCallId: `wait:${prepared.wait.waitId}`, toolName: "agent.wait", status: "completed",
        output: { status: "interrupted", matchedTaskIds: [], tasks: [{ taskId: prepared.child.id, status: "queued" }] },
      })
      expect(JSON.stringify(observation?.content)).not.toContain(steerText)
      expect(state.goal).toBe("Research and summarize the fixture source")
      expect(state.rootInputId).toBe(prepared.rootInput.id)
      expect(state.resume?.inputThroughSequence).toBe(BigInt(prepared.rootInput.sequence))
      expect(BigInt(accepted.sequence)).toBeGreaterThan(BigInt(prepared.rootInput.sequence))
      expect(state.resume?.consumedInputIds).toContain(prepared.rootInput.id)
      expect(state.resume?.usage).toMatchObject({ inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.01 })
      const originalStep = await pool!.query<{ status: string; inputThroughSequence: string; consumedInputIds: unknown; inputTokens: number; outputTokens: number }>(
        `SELECT "status", "inputThroughSequence", "consumedInputIds", "inputTokens", "outputTokens" FROM "agent_steps"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [prepared.stepId, value.sessionId, value.turnId],
      )
      expect(originalStep.rows[0]).toMatchObject({ status: "waiting_for_tool", inputThroughSequence: prepared.rootInput.sequence, consumedInputIds: [prepared.rootInput.id], inputTokens: 17, outputTokens: 5 })
      const firstConsumption = await pool!.query<{ consumedAt: Date | null; result: unknown }>("SELECT \"consumedAt\", \"result\" FROM \"agent_wait_conditions\" WHERE \"id\" = $1", [prepared.wait.waitId])
      const firstConsumedAt = firstConsumption.rows[0]?.consumedAt
      const firstWaitResult = firstConsumption.rows[0]?.result
      expect(firstConsumption.rows[0]?.consumedAt).toBeInstanceOf(Date)
      const replay = await loadCanonicalTurnState(pool!, lease, new Date(), { consumeWaitOutcomes: true })
      expect(replay.snapshot.toolObservations.find(item => item.id === observationId)?.content).toEqual(observation?.content)
      const replayedWait = await pool!.query<{ consumedAt: Date | null; result: unknown }>(`SELECT "consumedAt", "result" FROM "agent_wait_conditions" WHERE "id" = $1`, [prepared.wait.waitId])
      expect(replayedWait.rows[0]?.consumedAt).toEqual(firstConsumedAt)
      expect(replayedWait.rows[0]?.result).toEqual(firstWaitResult)

      const nextStepId = `p3-steer-wait-resume-step-${value.suffix}`, now = new Date()
      const owner = executionOwnerFence({ kind: "turn", taskId: prepared.root.id, lease })
      await createPgTurnEngineStore(pool!).startStep({ owner, stepId: nextStepId, ordinal: state.resume?.nextOrdinal ?? 1,
        attempt: 1, inputThroughSequence: state.resume?.inputThroughSequence ?? 0n,
        consumedInputIds: state.resume?.consumedInputIds ?? [], modelProfileSnapshot: state.modelProfileSnapshot, now })
      const context = await new StepContextBuilder(createPgInputClaimStore(pool!, state.scope), createPgContextOwnerFence(pool!)).build({
        scope: state.scope, sessionId: value.sessionId, turnId: value.turnId, stepId: nextStepId, snapshot: state.snapshot,
        rootInputId: state.rootInputId, taskId: prepared.root.id,
        lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now }, now,
      })
      expect(context.blocks).toContainEqual(expect.objectContaining({
        layer: "pending_input", trust: "external_untrusted", source: "user_input",
        content: { inputId: accepted.id, partIndex: 0, text: steerText },
      }))
      const inputState = await pool!.query<{ status: string; consumedByStepId: string | null; acceptedSequence: string }>(
        `SELECT "status", "consumedByStepId", "acceptedSequence" FROM "agent_inputs" WHERE "id" = $1 AND "sessionId" = $2 AND "targetTurnId" = $3 AND "userId" = $4`,
        [accepted.id, value.sessionId, value.turnId, value.userId],
      )
      expect(inputState.rows[0]).toMatchObject({ status: "consumed", consumedByStepId: nextStepId, acceptedSequence: accepted.sequence })
      const immutable = await pool!.query<{ input: RecordValue; goal: string; allowedActions: string[] }>(
        `SELECT turn."input", task."goal", task."allowedActions" FROM "agent_turns" AS turn
         JOIN "sub_agent_tasks" AS task ON task."id" = turn."rootTaskId" AND task."sessionId" = turn."sessionId"
         WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3`, [value.turnId, value.sessionId, value.userId],
      )
      expect(immutable.rows[0]).toMatchObject({ input: { goal: "Research and summarize the fixture source" }, goal: "Research and summarize the fixture source", allowedActions: [] })
      expect((await pool!.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [prepared.child.id])).rows[0]?.status).toBe("queued")
    } finally {
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("serializes accepted steering after the resolver session lock and wakes on the next scan", async () => {
    const value = fixture(), barrier = sessionLockBarrierPool(pool!), inputBarrier = sessionLockBarrierPool(pool!)
    let scan: Promise<unknown> | undefined, acceptance: Promise<unknown> | undefined
    try {
      const prepared = await prepareSuspendedSteerWait(pool!, value)
      scan = reconcileDurableWaits(barrier.pool, { ownerId: `p3-steer-race-resolver-${value.suffix}` })
      void scan.catch(() => undefined)
      const resolverPid = await withinIntegrationDeadline(barrier.connected, "Resolver did not connect for the steering race")
      expect(await withinIntegrationDeadline(barrier.sessionLockReturned, "Resolver did not lock the Session before the Turn")).toBe(resolverPid)
      acceptance = seedAcceptedSteer(inputBarrier.pool, value, `A later ordinary step should consume ${value.suffix}`)
      void acceptance.catch(() => undefined)
      const inputPid = await withinIntegrationDeadline(inputBarrier.connected, "Steer acceptor did not connect")
      expect(inputPid).not.toBe(resolverPid)
      await waitForSessionTupleBlock(pool!, resolverPid, inputPid)
      barrier.release()
      await expect(withinIntegrationDeadline(scan, "Resolver did not settle after the input waited on its Session lock", 10_000))
        .resolves.toMatchObject({ scanned: expect.any(Number), woken: expect.any(Number) })
      await withinIntegrationDeadline(inputBarrier.sessionLockReturned, "Steer acceptor did not acquire the Session after resolver commit")
      inputBarrier.release()
      await acceptance
      const beforeRetry = await pool!.query<{ turnStatus: string; waitStatus: string; childStatus: string }>(
        `SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", child."status" AS "childStatus"
         FROM "agent_turns" AS turn JOIN "agent_wait_conditions" AS wait ON wait."turnId" = turn."id" AND wait."sessionId" = turn."sessionId"
         JOIN "sub_agent_tasks" AS child ON EXISTS (SELECT 1 FROM jsonb_array_elements_text(wait."targetTaskIds") AS target(task_id) WHERE target.task_id = child."id") AND child."turnId" = turn."id" AND child."sessionId" = turn."sessionId"
         WHERE turn."id" = $1 AND wait."id" = $2`, [value.turnId, prepared.wait.waitId],
      )
      expect(beforeRetry.rows[0]).toEqual({ turnStatus: "waiting_for_dependency", waitStatus: "waiting", childStatus: "queued" })
      await reconcileDurableWaits(pool!, { ownerId: `p3-steer-race-retry-${value.suffix}` })
      const afterRetry = await pool!.query<{ turnStatus: string; waitStatus: string; childStatus: string }>(
        `SELECT turn."status" AS "turnStatus", wait."status" AS "waitStatus", child."status" AS "childStatus"
         FROM "agent_turns" AS turn JOIN "agent_wait_conditions" AS wait ON wait."turnId" = turn."id" AND wait."sessionId" = turn."sessionId"
         JOIN "sub_agent_tasks" AS child ON EXISTS (SELECT 1 FROM jsonb_array_elements_text(wait."targetTaskIds") AS target(task_id) WHERE target.task_id = child."id") AND child."turnId" = turn."id" AND child."sessionId" = turn."sessionId"
         WHERE turn."id" = $1 AND wait."id" = $2`, [value.turnId, prepared.wait.waitId],
      )
      expect(afterRetry.rows[0]).toEqual({ turnStatus: "queued", waitStatus: "interrupted", childStatus: "queued" })
    } finally {
      barrier.release(); inputBarrier.release()
      if (scan) await Promise.allSettled([scan])
      if (acceptance) await Promise.allSettled([acceptance])
      await pool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [value.sessionId])
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [value.userId])
    }
  }, 45_000)

  it("recovers a real oversized archived wait from a streaming process cut without replay or extra usage", async () => {
    let workerOne: ProcessFixtureChild | undefined
    let workerTwo: ProcessFixtureChild | undefined
    const value = archivedWaitOwner
    const waitKey = `${ARCHIVED_WAIT_IDEMPOTENCY_KEY}:${value.turnId}`
    let rootTaskId: string | undefined
    let taskIds: string[] = []
    let waitId: string | undefined
    let originalStepId: string | undefined
    let originalLeaseVersion: number | undefined
    try {
      const [turnQueue, childQueue] = await Promise.all([
        import("../turns/turn-queue.js"), import("../../queue/subagent-queue.js"),
      ])
      turnQueueName = turnQueue.TURN_QUEUE_NAME
      childQueueName = childQueue.SUBAGENT_QUEUE_NAME
      workerOne = startTaskGraphRestartWorker("crash-archived-wait", { ...value })
      const firstReady = await waitForProcessLine(workerOne, "P3_ARCHIVED_WAIT_FIRST_WORKER_READY ", 45_000)
      if (workerOne.pid === undefined) throw new Error("Archived-wait first Worker has no process ID")
      expect(firstReady).toContain(`p3-archived-wait-worker-${workerOne.pid}`)
      const created = await waitForProcessLine(workerOne, "P3_ARCHIVED_WAIT_TASKS_CREATED ", 45_000)
      const createdValue = record(JSON.parse(created.slice("P3_ARCHIVED_WAIT_TASKS_CREATED ".length)))
      rootTaskId = typeof createdValue?.rootTaskId === "string" ? createdValue.rootTaskId : undefined
      taskIds = Array.isArray(createdValue?.taskIds)
        ? createdValue.taskIds.filter((taskId): taskId is string => typeof taskId === "string") : []
      expect(rootTaskId).toBeTruthy()
      expect(taskIds).toHaveLength(7)
      expect(new Set(taskIds).size).toBe(7)
      const orderedTaskIds = [...taskIds].sort()
      const orderedInitiallyMatchedTaskIds = taskIds.slice(0, 6).sort()
      await waitForProcessLine(workerOne, "P3_ARCHIVED_WAIT_STEP_CLOSE_BARRIER", 45_000)

      const workerOwner = `p3-archived-wait-worker-${workerOne.pid}`
      const activeTurn = await pool!.query<{
        status: string; rootTaskId: string | null; leaseOwnerId: string | null; leaseVersion: number; leaseExpiresAt: Date | null
      }>(`SELECT "status", "rootTaskId", "leaseOwnerId", "leaseVersion", "leaseExpiresAt"
          FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [value.turnId, value.sessionId, value.userId])
      expect(activeTurn.rows).toHaveLength(1)
      expect(activeTurn.rows[0]).toMatchObject({
        status: "in_progress", rootTaskId, leaseOwnerId: workerOwner, leaseVersion: expect.any(Number),
        leaseExpiresAt: expect.any(Date),
      })
      originalLeaseVersion = activeTurn.rows[0]!.leaseVersion

      const steps = await pool!.query<{
        id: string; taskId: string | null; status: string; inputTokens: number; outputTokens: number; estimatedCostUsd: string | number
      }>(`SELECT step."id", step."taskId", step."status", step."inputTokens", step."outputTokens", step."estimatedCostUsd"
          FROM "agent_steps" AS step JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
          WHERE session."userId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4 ORDER BY step."ordinal"`,
      [value.userId, value.sessionId, value.turnId, rootTaskId])
      expect(steps.rows).toHaveLength(1)
      const cutStep = steps.rows[0]!
      originalStepId = cutStep.id
      expect(cutStep).toMatchObject({ taskId: rootTaskId, status: "streaming", inputTokens: 0, outputTokens: 0 })
      expect(Number(cutStep.estimatedCostUsd)).toBe(0)

      const modelEvents = await pool!.query<{
        id: string; type: string; sequence: string | bigint; userId: string; sessionId: string; turnId: string
        actor: string; taskId: string | null; itemId: string | null
        correlationId: string; causationId: string | null; idempotencyKey: string; payload: unknown
      }>(`SELECT event."id", event."type", event."sequence", session."userId" AS "userId", event."sessionId", event."turnId",
                 event."actor", event."taskId", event."itemId", event."correlationId", event."causationId", event."idempotencyKey", event."payload"
          FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
          WHERE session."userId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3 AND event."correlationId" = $4
            AND event."type" = ANY($5::text[]) ORDER BY event."sequence"`,
      [value.userId, value.sessionId, value.turnId, originalStepId, ["model.started", "model.completed", "model.usage"]])
      expect(modelEvents.rows.map(event => event.type)).toEqual(["model.started", "model.completed", "model.usage"])
      const [started, completed, usage] = modelEvents.rows
      for (const event of modelEvents.rows) expect(event).toMatchObject({
        userId: value.userId,
        sessionId: value.sessionId, turnId: value.turnId, taskId: rootTaskId, actor: "orchestrator", itemId: null,
        correlationId: originalStepId,
      })
      expect(started?.idempotencyKey).toBe(`turn:${value.turnId}:event:model-started:${originalStepId}`)
      expect(completed?.idempotencyKey).toBe(`turn:${value.turnId}:event:model-completed:${originalStepId}`)
      expect(usage?.idempotencyKey).toBe(`turn:${value.turnId}:event:model-usage:${originalStepId}`)
      expect(completed?.causationId).toBe(started?.id)
      expect(usage?.causationId).toBe(completed?.id)
      expect(BigInt(started!.sequence)).toBeLessThan(BigInt(completed!.sequence))
      expect(BigInt(completed!.sequence)).toBeLessThan(BigInt(usage!.sequence))
      expect(record(started?.payload)).toMatchObject({ taskId: rootTaskId, provider: "fixture", model: "fixture-model" })
      expect(record(completed?.payload)).toMatchObject({ taskId: rootTaskId, provider: "fixture", model: "fixture-model", toolCallCount: 2 })
      expect(record(usage?.payload)).toMatchObject({ taskId: rootTaskId, provider: "fixture", model: "fixture-model",
        usage: { inputTokens: 23, outputTokens: 11, estimatedCostUsd: 0.004 } })

      const callItems = await pool!.query<{ id: string; type: string; status: string; content: unknown }>(
        `SELECT item."id", item."type", item."status", item."content" FROM "agent_items" AS item
         JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
         WHERE session."userId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4 AND item."stepId" = $5
           AND item."type" IN ('tool_call', 'tool_result') AND item."content"->>'toolCallId' = ANY($6::text[])
         ORDER BY item."type"`,
        [value.userId, value.sessionId, value.turnId, rootTaskId, originalStepId, [ARCHIVED_WAIT_CALL_ID, ARCHIVED_WAIT_TAIL_CALL_ID]],
      )
      expect(callItems.rows.map(item => [item.type, record(item.content)?.toolCallId])).toEqual([
        ["tool_call", ARCHIVED_WAIT_CALL_ID], ["tool_result", ARCHIVED_WAIT_CALL_ID],
      ])
      expect(callItems.rows.every(item => item.status === "completed")).toBe(true)
      const callContent = record(callItems.rows.find(item => item.type === "tool_call")?.content)
      expect(callContent).toMatchObject({ toolCallId: ARCHIVED_WAIT_CALL_ID, toolName: "agent.wait", status: "completed",
        input: { idempotencyKey: waitKey, taskIds, mode: "all", timeoutMs: 30_000 } })
      const resultContent = record(callItems.rows.find(item => item.type === "tool_result")?.content)
      const outputReference = record(resultContent?.output)
      expect(Object.keys(outputReference ?? {}).sort()).toEqual(["$ref", "sha256", "sizeBytes"])
      expect(outputReference).toMatchObject({ $ref: expect.any(String), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
      expect(outputReference?.sizeBytes).toEqual(expect.any(Number))
      expect(Number(outputReference?.sizeBytes)).toBeGreaterThan(8_192)
      expect(Number(outputReference?.sizeBytes)).toBeLessThanOrEqual(VERIFICATION_REPAIR_WAIT_OUTPUT_BYTE_LIMIT)
      const waitRows = await pool!.query<{
        id: string; parentTaskId: string; stepId: string; idempotencyKey: string; mode: string; status: string
        targetTaskIds: unknown; matchedTaskIds: unknown; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null
      }>(`SELECT "id", "parentTaskId", "stepId", "idempotencyKey", "mode", "status", "targetTaskIds", "matchedTaskIds",
                 "suspendedAt", "resolvedAt", "consumedAt" FROM "agent_wait_conditions"
          WHERE "userId" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "parentTaskId" = $4 AND "idempotencyKey" = $5`,
      [value.userId, value.sessionId, value.turnId, rootTaskId, waitKey])
      expect(waitRows.rows).toHaveLength(1)
      const pendingWait = waitRows.rows[0]!
      waitId = pendingWait.id
      expect(pendingWait).toMatchObject({ parentTaskId: rootTaskId, stepId: originalStepId, idempotencyKey: waitKey,
        mode: "all", status: "waiting", suspendedAt: null, resolvedAt: null, consumedAt: null })
      expect(pendingWait.targetTaskIds).toEqual(orderedTaskIds)
      expect(pendingWait.matchedTaskIds).toEqual(orderedInitiallyMatchedTaskIds)
      const childRows = await pool!.query<{ id: string; status: string; rootTaskId: string; parentTaskId: string; turnId: string; sessionId: string }>(
        `SELECT task."id", task."status", task."rootTaskId", task."parentTaskId", task."turnId", task."sessionId"
           FROM "sub_agent_tasks" AS task
           JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
          WHERE session."userId" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
            AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND task."id" = ANY($5::text[])
          ORDER BY array_position($5::text[], task."id")`,
        [value.userId, value.sessionId, value.turnId, rootTaskId, taskIds],
      )
      expect(childRows.rows.map(row => row.id)).toEqual(taskIds)
      expect(childRows.rows.map(row => row.status)).toEqual(["completed", "completed", "completed", "completed", "completed", "completed", "queued"])
      expect(childRows.rows.every(row => row.rootTaskId === rootTaskId && row.parentTaskId === rootTaskId
        && row.turnId === value.turnId && row.sessionId === value.sessionId)).toBe(true)
      expect((await pool!.query(`SELECT event."id" FROM "agent_events" AS event
        JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
        WHERE session."userId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3
          AND event."taskId" = $4 AND event."type" = 'step.completed' AND event."correlationId" = $5`,
      [value.userId, value.sessionId, value.turnId, rootTaskId, originalStepId])).rowCount).toBe(0)

      const firstExit = waitForProcessExit(workerOne)
      noteFixtureSigkillTurnJob(workerOne, turnQueueName!, turnJobId(value.turnId, 0))
      expect(workerOne.kill("SIGKILL")).toBe(true)
      await firstExit
      expect(workerOne.signalCode).toBe("SIGKILL")
      const expiredLease = await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = clock_timestamp() - INTERVAL '1 second',
          "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'in_progress'
            AND "leaseOwnerId" = $4 AND "leaseVersion" = $5 AND "leaseExpiresAt" > clock_timestamp() RETURNING "id"`,
      [value.turnId, value.sessionId, value.userId, workerOwner, originalLeaseVersion])
      expect(expiredLease.rowCount).toBe(1)

      workerTwo = startTaskGraphRestartWorker("resume-archived-wait", { ...value, rootTaskId, taskIds, waitId })
      await waitForProcessLine(workerTwo, "P3_ARCHIVED_WAIT_RESUME_WORKER_READY ", 45_000)
      await waitForPersistedTaskWait(pool!, value.turnId, waitKey, 45_000, ARCHIVED_WAIT_CALL_ID)
      const suspended = await pool!.query<{
        status: string; suspendedAt: Date | null; resolvedAt: Date | null; consumedAt: Date | null; targetTaskIds: unknown; matchedTaskIds: unknown
      }>(`SELECT "status", "suspendedAt", "resolvedAt", "consumedAt", "targetTaskIds", "matchedTaskIds"
          FROM "agent_wait_conditions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4
            AND "parentTaskId" = $5 AND "idempotencyKey" = $6`,
      [waitId, value.userId, value.sessionId, value.turnId, rootTaskId, waitKey])
      expect(suspended.rows).toHaveLength(1)
      expect(suspended.rows[0]).toMatchObject({ status: "waiting", suspendedAt: expect.any(Date), resolvedAt: null, consumedAt: null })
      expect(suspended.rows[0]?.targetTaskIds).toEqual(orderedTaskIds)
      expect(suspended.rows[0]?.matchedTaskIds).toEqual(orderedInitiallyMatchedTaskIds)
      const recoveredTurn = await pool!.query<{ status: string; rootTaskId: string; leaseOwnerId: string | null; leaseVersion: number }>(
        `SELECT "status", "rootTaskId", "leaseOwnerId", "leaseVersion" FROM "agent_turns"
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [value.turnId, value.sessionId, value.userId],
      )
      expect(recoveredTurn.rows).toHaveLength(1)
      expect(recoveredTurn.rows[0]).toMatchObject({ status: "waiting_for_dependency", rootTaskId, leaseOwnerId: null })
      expect(recoveredTurn.rows[0]!.leaseVersion).toBeGreaterThan(originalLeaseVersion!)
      const closedStep = await pool!.query<{ id: string; status: string; inputTokens: number; outputTokens: number; estimatedCostUsd: string | number }>(
        `SELECT step."id", step."status", step."inputTokens", step."outputTokens", step."estimatedCostUsd" FROM "agent_steps" AS step
         JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
         WHERE session."userId" = $1 AND step."id" = $2 AND step."sessionId" = $3 AND step."turnId" = $4 AND step."taskId" = $5`,
        [value.userId, originalStepId, value.sessionId, value.turnId, rootTaskId],
      )
      expect(closedStep.rows).toHaveLength(1)
      expect(closedStep.rows[0]).toMatchObject({ id: originalStepId, status: "waiting_for_tool", inputTokens: 23, outputTokens: 11 })
      expect(Number(closedStep.rows[0]!.estimatedCostUsd)).toBeCloseTo(0.004, 8)
      const completion = await pool!.query<{ id: string; type: string; actor: string; taskId: string; payload: unknown }>(
        `SELECT event."id", event."type", event."actor", event."taskId", event."payload"
         FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
         WHERE session."userId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3 AND event."taskId" = $4
           AND event."type" = 'step.completed' AND event."correlationId" = $5`,
        [value.userId, value.sessionId, value.turnId, rootTaskId, originalStepId],
      )
      expect(completion.rows).toHaveLength(1)
      expect(completion.rows[0]).toMatchObject({ type: "step.completed", actor: "orchestrator", taskId: rootTaskId,
        payload: { stepId: originalStepId, status: "waiting_for_dependency", taskId: rootTaskId, toolCallCount: 2 } })
      const beforeReadyItems = await pool!.query<{ type: string; content: unknown }>(
        `SELECT item."type", item."content" FROM "agent_items" AS item
         JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
         WHERE session."userId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3
           AND item."taskId" = $4 AND item."stepId" = $5 AND item."type" IN ('tool_call', 'tool_result') ORDER BY item."type"`,
        [value.userId, value.sessionId, value.turnId, rootTaskId, originalStepId],
      )
      expect(beforeReadyItems.rows).toHaveLength(2)
      expect(beforeReadyItems.rows.map(item => [item.type, record(item.content)?.toolCallId])).toEqual([
        ["tool_call", ARCHIVED_WAIT_CALL_ID], ["tool_result", ARCHIVED_WAIT_CALL_ID],
      ])
      expect((await pool!.query(`SELECT event."id" FROM "agent_events" AS event
        JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
        WHERE session."userId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3
          AND event."taskId" = $4 AND event."type" = 'model.usage' AND event."correlationId" = $5`,
      [value.userId, value.sessionId, value.turnId, rootTaskId, originalStepId])).rowCount).toBe(1)

      const childStore = new PgSubagentTaskStore(pool!, 300_000)
      const queuedChild = await childStore.get(taskIds[6]!, value.sessionId)
      expect(queuedChild).toMatchObject({ id: taskIds[6], status: "queued", rootTaskId, parentTaskId: rootTaskId, turnId: value.turnId })
      const childOwner = `p3-archived-wait-final-child-${value.suffix}`
      const childLease = await childStore.claim({ taskId: taskIds[6]!, sessionId: value.sessionId, ownerId: childOwner,
        policy: defaultSubagentPolicy(), now: new Date() })
      if (!childLease) throw new Error("Archived-wait final target could not be claimed through the normal task store")
      await expect(childStore.finish({ taskId: taskIds[6]!, sessionId: value.sessionId, ownerId: childOwner,
        attemptCount: childLease.attemptCount, status: "completed",
        result: { summary: "Final bounded archived-wait target completed through the task store" }, now: new Date() })).resolves.toBe("completed")

      const readyLine = await waitForProcessLine(workerTwo, "P3_ARCHIVED_WAIT_READY_OUTCOME_SEEN ", 45_000)
      expect(readyLine).toMatch(/"status":"ready".*"targetCount":7.*"matchedCount":7/)
      await waitForProcessLine(workerTwo, "P3_ARCHIVED_WAIT_TURN_COMPLETED", 45_000)
      const completedTurn = await pool!.query<{
        status: string; rootTaskId: string; finalResponse: string | null
        inputTokens: number; outputTokens: number; estimatedCostUsd: string | number
      }>(
        `SELECT "status", "rootTaskId", "finalResponse", "inputTokens", "outputTokens", "estimatedCostUsd" FROM "agent_turns"
         WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [value.turnId, value.sessionId, value.userId],
      )
      expect(completedTurn.rows).toHaveLength(1)
      expect(completedTurn.rows[0]).toMatchObject({
        status: "completed", rootTaskId, inputTokens: 37, outputTokens: 17,
      })
      const persistedFinal = record(JSON.parse(completedTurn.rows[0]!.finalResponse ?? "null"))
      expect(Object.keys(persistedFinal ?? {}).sort()).toEqual([
        "blocker", "completed", "completedTasks", "evidenceRefs", "goal", "next", "notCompleted", "response",
        "schemaVersion", "stepCount", "summary", "terminalReason", "toolCallCount", "usage",
      ])
      expect(persistedFinal).toMatchObject({
        schemaVersion: "agent-harness.v2.final", completed: true, terminalReason: "goal_satisfied",
        response: "p3-process-archived-wait-resumed",
      })
      expect(Number(completedTurn.rows[0]!.estimatedCostUsd)).toBeCloseTo(0.0052, 8)
      const completedRoot = await pool!.query<{ status: string; result: unknown }>(
        `SELECT task."status", task."result" FROM "sub_agent_tasks" AS task
         JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
         WHERE task."id" = $1 AND session."userId" = $2 AND task."sessionId" = $3
           AND task."turnId" = $4 AND task."rootTaskId" = $1`,
        [rootTaskId, value.userId, value.sessionId, value.turnId],
      )
      expect(completedRoot.rows).toHaveLength(1)
      expect(completedRoot.rows[0]?.status).toBe("completed")
      expect(record(completedRoot.rows[0]?.result)).toMatchObject({
        status: "completed", stepCount: 3, toolCallCount: 3,
      })
      const resolved = await pool!.query<{ status: string; targetTaskIds: unknown; matchedTaskIds: unknown; result: unknown; suspendedAt: Date | null; consumedAt: Date | null }>(
        `SELECT "status", "targetTaskIds", "matchedTaskIds", "result", "suspendedAt", "consumedAt"
         FROM "agent_wait_conditions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4`,
        [waitId, value.userId, value.sessionId, value.turnId],
      )
      expect(resolved.rows).toHaveLength(1)
      expect(resolved.rows[0]).toMatchObject({ status: "ready", targetTaskIds: orderedTaskIds, matchedTaskIds: orderedTaskIds,
        suspendedAt: expect.any(Date), consumedAt: expect.any(Date) })
      const outcome = record(record(resolved.rows[0]?.result)?.outcome)
      expect(outcome).toMatchObject({ waitId, status: "ready", targetTaskIds: orderedTaskIds, matchedTaskIds: orderedTaskIds })
      expect(Array.isArray(outcome?.tasks) ? outcome.tasks : []).toHaveLength(7)
      const allSteps = await pool!.query<{ id: string; status: string }>(
        `SELECT step."id", step."status" FROM "agent_steps" AS step
         JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
         WHERE session."userId" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4 ORDER BY step."ordinal"`,
        [value.userId, value.sessionId, value.turnId, rootTaskId],
      )
      expect(allSteps.rows.filter(step => step.id === originalStepId)).toEqual([{ id: originalStepId, status: "waiting_for_tool" }])
      expect(allSteps.rows).toHaveLength(3)
      expect(allSteps.rows.map(step => step.status)).toEqual(["waiting_for_tool", "completed", "completed"])
      const rootCalls = await pool!.query<{ toolCallId: string; toolName: string; itemType: string }>(
        `SELECT item."type" AS "itemType", item."content"->>'toolCallId' AS "toolCallId", item."content"->>'toolName' AS "toolName"
         FROM "agent_items" AS item JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
         WHERE session."userId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4 AND item."type" = 'tool_call'`,
        [value.userId, value.sessionId, value.turnId, rootTaskId],
      )
      expect(rootCalls.rows.map(row => row.toolCallId).sort()).toEqual([ARCHIVED_WAIT_CALL_ID, ARCHIVED_WAIT_FRESH_LIST_CALL_ID].sort())
      expect(rootCalls.rows.some(row => row.toolCallId === ARCHIVED_WAIT_TAIL_CALL_ID)).toBe(false)
      expect(rootCalls.rows.filter(row => row.toolCallId === ARCHIVED_WAIT_FRESH_LIST_CALL_ID)).toHaveLength(1)
      expect(rootCalls.rows.find(row => row.toolCallId === ARCHIVED_WAIT_FRESH_LIST_CALL_ID)?.toolName).toBe("agent.list")
      const freshListItems = await pool!.query<{ type: string; status: string; content: unknown }>(
        `SELECT item."type", item."status", item."content" FROM "agent_items" AS item
         JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
         WHERE session."userId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
           AND item."type" IN ('tool_call', 'tool_result') AND item."content"->>'toolCallId' = $5 ORDER BY item."type"`,
        [value.userId, value.sessionId, value.turnId, rootTaskId, ARCHIVED_WAIT_FRESH_LIST_CALL_ID],
      )
      expect(freshListItems.rows.map(item => item.type)).toEqual(["tool_call", "tool_result"])
      expect(freshListItems.rows.every(item => item.status === "completed")).toBe(true)
      expect(record(freshListItems.rows.find(item => item.type === "tool_call")?.content)).toMatchObject({
        toolCallId: ARCHIVED_WAIT_FRESH_LIST_CALL_ID, toolName: "agent.list", input: {},
      })
      expect(record(record(freshListItems.rows.find(item => item.type === "tool_result")?.content)?.output)).toEqual({ tasks: [] })
      const modelRoundReceipts = await pool!.query<{ type: string; correlationId: string; payload: unknown }>(
        `SELECT event."type", event."correlationId", event."payload" FROM "agent_events" AS event
         JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
         WHERE session."userId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3 AND event."taskId" = $4
           AND event."type" IN ('model.completed', 'model.usage') ORDER BY event."sequence"`,
        [value.userId, value.sessionId, value.turnId, rootTaskId],
      )
      const completedReceipts = modelRoundReceipts.rows.filter(event => event.type === "model.completed")
      const usageReceipts = modelRoundReceipts.rows.filter(event => event.type === "model.usage")
      expect(completedReceipts.map(event => record(event.payload)?.toolCallCount)).toEqual([2, 1, 0])
      expect(new Set(completedReceipts.map(event => event.correlationId)).size).toBe(3)
      expect(usageReceipts).toHaveLength(3)
      expect(new Set(usageReceipts.map(event => event.correlationId))).toEqual(new Set(completedReceipts.map(event => event.correlationId)))
      expect((await pool!.query(`SELECT event."id" FROM "agent_events" AS event
        JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
        WHERE session."userId" = $1 AND event."sessionId" = $2 AND event."turnId" = $3
          AND event."taskId" = $4 AND event."type" = 'model.usage' AND event."correlationId" = $5`,
      [value.userId, value.sessionId, value.turnId, rootTaskId, originalStepId])).rowCount).toBe(1)
      if (!workerTwo) throw new Error("Archived-wait resume worker disappeared before graceful cleanup")
      await stopProcessFixture(workerTwo)
      workerTwo = undefined
    } finally {
      if (workerOne && !processFixtureExited(workerOne)) await killProcessFixture(workerOne)
      if (workerTwo && !processFixtureExited(workerTwo)) await killProcessFixture(workerTwo)
    }
  }, 150_000)
})
